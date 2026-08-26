#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectLanguage } from "./languages.js";
import { applySnapshotEdits, renderPreview } from "./diff.js";
import {
  correlateEvidence,
  normalizeRepositoryPath,
  type CorrelationResult,
  type MatchClassification,
} from "./evidence.js";
import { snapshotTargets } from "./filesystem.js";
import { auditGitScope, GitScopeError, recheckGitScopeClean, resolveGitScope, type GitScopeOptions } from "./git.js";
import {
  diagnosticLines,
  editPlanResult,
  stableHash,
  stableJson,
  stableJsonLine,
  type CliOutcome,
  type CliResult,
  type PlanningResult,
  type RewritePolicyResult,
} from "./output.js";
import { buildEditPlan, type FileSnapshot } from "./planner.js";
import { compareStrings } from "./order.js";
import { AstGrepProvider } from "./providers/astGrep.js";
import {
  isReservedProviderPath,
  ProviderExecutionError,
  type ProviderDiagnostic,
  type ProviderResult,
} from "./providers/provider.js";
import { RipgrepProvider } from "./providers/ripgrep.js";
import { ProcessSpawnError, runArgumentVector } from "./providers/process.js";
import { parseEditPlan, parseRewritePlan, parseTransactionRecord } from "./schema.js";
import {
  appendPreparedTransactionValidations,
  commitTransaction,
  nodeTransactionFileSystem,
  preparedTransactionOutputs,
  preparedTransactionMaximumRecordBytes,
  preparedTransactionPreview,
  previewUndoTransaction,
  type TransactionFileSystem,
  prepareTransaction,
  updatePreparedTransactionOutputs,
  undoTransaction,
  verifyTransaction,
} from "./transaction.js";
import {
  resolveValidationInvocations,
  runPreparedValidations,
  runValidations,
  validationsPassed,
  type ValidationInvocation,
} from "./validation.js";
import type {
  AstGrepLanguage,
  Diagnostic,
  Edit,
  EditPlan,
  GitScopeAudit,
  RewritePlan,
  TrustedValidationCommand,
  TransactionRecord,
  ValidationSpec,
} from "./types.js";

const maximumProtocolBytes = 8 * 1024 * 1024;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const editPlanIdPattern = /^edit-plan:[a-f0-9]{64}$/u;
const transactionIdPattern = /^transaction-[0-9a-f-]+$/u;
const blockingDiagnosticCodes = new Set([
  "unresolved-conflicts",
  "expected-count-exact",
  "expected-count-min",
  "expected-count-max",
  "adjacent-match-unresolved",
  "missing-replacement-capture",
  "unparseable-match",
]);

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
  isTTY: boolean;
  confirm(): Promise<boolean>;
  cwd?: string;
  stdin?(): Promise<string>;
}

export interface CliRuntime {
  fileSystem?: TransactionFileSystem;
  ripgrepExecutable?: string;
  astGrepExecutable?: string;
  gitExecutable?: string;
  validationExecutables?: Partial<Record<ValidationSpec["type"], string>>;
  validationEnv?: NodeJS.ProcessEnv;
}

async function terminalConfirmation(): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  });
  try {
    const answer = await terminal.question("");
    return answer.trim().toLowerCase() === "y";
  } catch {
    return false;
  } finally {
    terminal.close();
  }
}

async function stdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value) > maximumProtocolBytes) {
      throw new Error(`JSON protocol document exceeds ${String(maximumProtocolBytes)} bytes.`);
    }
  }
  return value;
}

const defaultIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: terminalConfirmation,
  cwd: process.cwd(),
  stdin: stdinText,
};

interface CommonOptions {
  dryRun: boolean;
  write: boolean;
  json: boolean;
  planOut?: string;
  trackedOnly: boolean;
  changedOnly: boolean;
  staged: boolean;
  since?: string;
  requireClean: boolean;
  checks: ValidationSpec["type"][];
  explicitValidations: TrustedValidationCommand[];
  keepOnCheckFailure: boolean;
}

interface RewriteCommand extends CommonOptions {
  kind: "rewrite";
  search: string;
  replace: string;
  regex: boolean;
  languages: AstGrepLanguage[];
  globs: string[];
  paths: string[];
}

interface PlanCommand extends CommonOptions {
  kind: "plan";
  source: string;
}

interface InspectCommand {
  kind: "inspect";
  source: string;
  json: boolean;
}

interface ApplyCommand extends CommonOptions {
  kind: "apply";
  source: string;
}

interface VerifyCommand {
  kind: "verify";
  source: string;
  json: boolean;
}

interface UndoCommand extends CommonOptions {
  kind: "undo";
  source: string;
}

type ParsedCommand = RewriteCommand | PlanCommand | InspectCommand | ApplyCommand | VerifyCommand | UndoCommand;

export const VERSION = "0.1.1";

const HELP = `Usage: tfs-ripast [COMMAND] [OPTIONS]

Safe repository-scale search, rewrite planning, validation, and rollback.

Commands:
  tfs-ripast --search TEXT --replace TEXT [-- PATH ...]  Plan an ad-hoc rewrite
  tfs-ripast plan PLAN.json                       Resolve a rewrite plan
  tfs-ripast inspect EDIT-PLAN.json               Inspect a saved edit plan
  tfs-ripast apply EDIT-PLAN.json                 Revalidate and apply a saved plan
  tfs-ripast verify TRANSACTION.json              Verify committed file hashes
  tfs-ripast undo TRANSACTION.json                Preview or apply a safe rollback

Core options:
  --regex                    Interpret --search as a regular expression
  --lang LANGUAGE            Add an ast-grep language candidate
  --glob GLOB                Restrict candidate paths (repeatable)
  --tracked-only             Consider tracked files only
  --changed-only             Consider changed and visible untracked files
  --staged                   Consider staged files only
  --since COMMIT             Consider files changed since a commit
  --require-clean            Require a clean Git worktree
  --check ADAPTER            Run prettier, npm-test, or typescript-typecheck
  --plan-out PATH            Save the resolved edit plan
  --json                     Emit one machine-readable JSON document
  --dry-run                  Never write source files
  --write                    Apply after validation without an interactive prompt
  -- PATH ...                End options and supply ad-hoc rewrite paths
  -h, --help                 Show this help
  -V, --version              Show the version

Dry-run is the default for non-interactive execution. For ad-hoc rewrites, place
write, plan-output, and validation authority before --search/--replace, and put a
caller-supplied -- before path operands.
`;

function commandName(argv: readonly string[]): ParsedCommand["kind"] {
  const first = argv[0];
  return first === "plan" || first === "inspect" || first === "apply" || first === "verify" || first === "undo"
    ? first
    : "rewrite";
}

interface ArgumentParseState {
  json: boolean;
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "--") {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function commonOptions(): CommonOptions {
  return {
    dryRun: false,
    write: false,
    json: false,
    trackedOnly: false,
    changedOnly: false,
    staged: false,
    requireClean: false,
    checks: [],
    explicitValidations: [],
    keepOnCheckFailure: false,
  };
}

function validationAdapter(value: string): ValidationSpec["type"] {
  if (value === "prettier" || value === "npm-test" || value === "typescript-typecheck") {
    return value;
  }
  throw new Error(`Unknown validation adapter: ${value}.`);
}

function explicitValidation(value: string): TrustedValidationCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--validation-command must be a JSON argv array: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error("--validation-command requires a JSON string array containing an executable and at least one argument.");
  }
  const [executable, ...args] = parsed;
  if (executable === undefined) {
    throw new Error("--validation-command is missing its executable.");
  }
  return {
    executable,
    args,
    cwd: ".",
    timeoutMs: 120_000,
    maxOutputBytes: 1024 * 1024,
  };
}

function parseCommonOption(
  argv: readonly string[],
  index: number,
  options: CommonOptions,
  state: ArgumentParseState,
): number | undefined {
  const argument = argv[index];
  if (argument === "--dry-run") {
    options.dryRun = true;
    return index;
  }
  if (argument === "--write") {
    options.write = true;
    return index;
  }
  if (argument === "--json") {
    options.json = true;
    state.json = true;
    return index;
  }
  if (argument === "--plan-out") {
    options.planOut = requiredValue(argv, index, argument);
    return index + 1;
  }
  if (argument === "--tracked" || argument === "--tracked-only") {
    options.trackedOnly = true;
    return index;
  }
  if (argument === "--changed-only") {
    options.changedOnly = true;
    return index;
  }
  if (argument === "--staged") {
    options.staged = true;
    return index;
  }
  if (argument === "--since") {
    options.since = requiredValue(argv, index, argument);
    return index + 1;
  }
  if (argument === "--require-clean") {
    options.requireClean = true;
    return index;
  }
  if (argument === "--check") {
    options.checks.push(validationAdapter(requiredValue(argv, index, argument)));
    return index + 1;
  }
  if (argument === "--validation-command") {
    options.explicitValidations.push(explicitValidation(requiredValue(argv, index, argument)));
    return index + 1;
  }
  if (argument === "--keep-on-check-failure") {
    options.keepOnCheckFailure = true;
    return index;
  }
  return undefined;
}

function isAdHocAuthorityOption(argument: string): boolean {
  return argument === "--write" || argument === "--plan-out" ||
    argument === "--check" || argument === "--validation-command" ||
    argument === "--keep-on-check-failure";
}

function assertWriteMode(options: CommonOptions): void {
  if (options.dryRun && options.write) {
    throw new Error("--dry-run and --write are mutually exclusive.");
  }
  const scopes = Number(options.trackedOnly) + Number(options.changedOnly) + Number(options.staged) + Number(options.since !== undefined);
  if (scopes > 1) {
    throw new Error("--tracked-only, --changed-only, --staged, and --since are mutually exclusive.");
  }
}

function hasRewriteExecutionOptions(options: CommonOptions): boolean {
  return options.trackedOnly || options.changedOnly || options.staged || options.since !== undefined ||
    options.requireClean || options.checks.length > 0 || options.explicitValidations.length > 0 ||
    options.keepOnCheckFailure;
}

function parseSavedCommand(
  kind: PlanCommand["kind"] | InspectCommand["kind"] | ApplyCommand["kind"] | VerifyCommand["kind"] | UndoCommand["kind"],
  argv: readonly string[],
  state: ArgumentParseState,
): ParsedCommand {
  const common = commonOptions();
  const positional: string[] = [];
  let positionalOnly = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly) {
      const consumed = parseCommonOption(argv, index, common, state);
      if (consumed !== undefined) {
        index = consumed;
        continue;
      }
      if (argument.startsWith("-") && argument !== "-") {
        throw new Error(`Unknown option for ${kind}: ${argument}`);
      }
    }
    positional.push(argument);
  }
  if (positional.length !== 1) {
    throw new Error(`${kind} requires exactly one JSON document path.`);
  }
  const source = positional[0];
  if (source === undefined) {
    throw new Error(`${kind} requires a JSON document path.`);
  }
  if (kind === "inspect" || kind === "verify") {
    if (common.dryRun || common.write || common.planOut !== undefined || hasRewriteExecutionOptions(common)) {
      throw new Error(`${kind} does not accept write-mode or plan-output options.`);
    }
    return { kind, source, json: common.json };
  }
  if ((kind === "apply" || kind === "undo") && common.planOut !== undefined) {
    throw new Error(`${kind} does not accept plan-output options.`);
  }
  if (kind === "undo" && hasRewriteExecutionOptions(common)) {
    throw new Error("undo does not accept rewrite scoping or validation options.");
  }
  assertWriteMode(common);
  return { kind, source, ...common };
}

function parseArguments(argv: readonly string[], state: ArgumentParseState): ParsedCommand {
  const kind = commandName(argv);
  if (kind !== "rewrite") {
    return parseSavedCommand(kind, argv, state);
  }

  const common = commonOptions();
  let search: string | undefined;
  let replace: string | undefined;
  let regex = false;
  const languages: AstGrepLanguage[] = [];
  const globs: string[] = [];
  const positional: string[] = [];
  let positionalOnly = false;
  let rewriteDefinitionStarted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly) {
      if (rewriteDefinitionStarted && isAdHocAuthorityOption(argument)) {
        throw new Error(
          "Ad-hoc write, plan-output, and validation authority options must precede --search/--replace; callers must place their own literal -- before path operands.",
        );
      }
      const consumed = parseCommonOption(argv, index, common, state);
      if (consumed !== undefined) {
        index = consumed;
        continue;
      }
      if (argument === "--search") {
        rewriteDefinitionStarted = true;
        search = requiredValue(argv, index, argument);
        index += 1;
        continue;
      }
      if (argument === "--replace") {
        rewriteDefinitionStarted = true;
        replace = requiredValue(argv, index, argument);
        index += 1;
        continue;
      }
      if (argument === "--regex") {
        regex = true;
        continue;
      }
      if (argument === "--lang") {
        languages.push(requiredValue(argv, index, argument) as AstGrepLanguage);
        index += 1;
        continue;
      }
      if (argument === "--glob") {
        globs.push(requiredValue(argv, index, argument));
        index += 1;
        continue;
      }
      if (argument.startsWith("-")) {
        throw new Error(`Unknown option: ${argument}`);
      }
      throw new Error("Ad-hoc PATH operands require a literal -- operand separator.");
    }
    positional.push(argument);
  }
  if (search === undefined) {
    throw new Error("Missing required --search argument.");
  }
  if (replace === undefined) {
    throw new Error("Missing required --replace argument.");
  }
  assertWriteMode(common);
  const hasAdHocAuthority = common.write || common.planOut !== undefined ||
    common.checks.length > 0 || common.explicitValidations.length > 0 ||
    common.keepOnCheckFailure;
  if (hasAdHocAuthority && !positionalOnly) {
    throw new Error("Ad-hoc write, plan-output, and validation options require a literal -- operand separator (use a trailing -- for the default path).");
  }
  return {
    kind: "rewrite",
    search,
    replace,
    regex,
    languages,
    globs,
    paths: positional.length === 0 ? ["."] : positional,
    ...common,
  };
}

function adHocPlan(command: RewriteCommand, cwd: string): RewritePlan {
  return parseRewritePlan({
    version: 1,
    name: "ad-hoc rewrite",
    root: resolve(cwd),
    operations: [{
      id: "ad-hoc",
      paths: command.paths,
      search: command.search,
      replace: command.replace,
      lexical: command.regex ? { type: "regex" } : { type: "literal" },
      ...(command.languages.length === 0 ? {} : { languages: command.languages }),
      ...(command.globs.length === 0 ? {} : { globs: command.globs }),
      matchPolicy: { onUnparseable: "allow" },
      conflictPolicy: { onConflict: "reject" },
    }],
    policy: {
      respectGitIgnore: true,
      ...(command.requireClean ? { requireClean: true } : {}),
      ...(command.keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
    },
    validations: command.checks.map((type) => ({ type })),
  });
}

function canonicalRewritePlan(rewritePlan: RewritePlan, cwd: string): RewritePlan {
  return parseRewritePlan({
    ...rewritePlan,
    root: resolve(cwd, rewritePlan.root),
    operations: rewritePlan.operations.map((operation) => ({
      ...operation,
      paths: [...new Set(operation.paths.map((path) => {
        const normalized = normalizeRepositoryPath(path, true);
        return normalized === "." ? normalized : normalized.replace(/\/+$/u, "");
      }))],
    })),
  });
}

function applyCliPlanOptions(rewritePlan: RewritePlan, options: CommonOptions): RewritePlan {
  const adapters = new Set(rewritePlan.validations.map((validation) => validation.type));
  return parseRewritePlan({
    ...rewritePlan,
    policy: {
      ...rewritePlan.policy,
      ...(options.requireClean ? { requireClean: true } : {}),
      ...(options.keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
    },
    validations: [
      ...rewritePlan.validations,
      ...[...new Set(options.checks)]
        .filter((type) => !adapters.has(type))
        .map((type) => ({ type })),
    ],
  });
}

function isWithinOperation(path: string, operationPaths: readonly string[]): boolean {
  return operationPaths.some((operand) => operand === "." || path === operand || path.startsWith(`${operand}/`));
}

function omittedSnapshotDiagnostic(result: ProviderResult, path: string): ProviderDiagnostic {
  return {
    code: `${result.provider}-target-not-snapshotted`,
    message: `${result.provider} reported ${path}, but it was binary, reserved, or unavailable to the immutable snapshot.`,
    operationId: result.operationId,
    paths: [path],
  };
}

async function discoverSnapshotPaths(
  plan: RewritePlan,
  targetPaths: readonly string[],
  runtime: CliRuntime,
): Promise<string[]> {
  const args = [
    "--files",
    "--null",
    "--hidden",
    "--glob",
    "!.git",
    "--glob",
    "!.git/**",
    "--glob",
    "!.tfs-ripast",
    "--glob",
    "!.tfs-ripast/**",
  ];
  if (plan.policy.respectGitIgnore === false) {
    args.push("--no-ignore-vcs");
  }
  args.push("--", ...targetPaths);
  const executable = runtime.ripgrepExecutable ?? "rg";
  let result;
  try {
    result = await runArgumentVector(executable, args, {
      cwd: plan.root,
      timeoutMs: 30_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw new ProviderExecutionError("Could not execute ripgrep file discovery.", {
      code: "ripgrep-files-spawn",
      operationId: "discovery",
      paths: targetPaths,
      cause: error,
    });
  }
  if (result.timedOut || result.truncated || result.invalidUtf8 || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new ProviderExecutionError(
      result.timedOut
        ? "ripgrep file discovery timed out."
        : result.truncated
          ? "ripgrep file discovery exceeded its output limit."
          : result.invalidUtf8
            ? "ripgrep file discovery returned invalid UTF-8 output."
          : `ripgrep file discovery failed with exit code ${String(result.exitCode)}${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`,
      {
        code: result.timedOut
          ? "ripgrep-files-timeout"
          : result.truncated
            ? "ripgrep-files-output-limit"
            : result.invalidUtf8 ? "ripgrep-files-invalid-utf8" : "ripgrep-files-exit",
        operationId: "discovery",
        paths: targetPaths,
      },
    );
  }
  if (result.exitCode === 1) {
    return [];
  }
  return [...new Set(result.stdout.split("\0").filter((path) => path.length > 0))];
}

function canonicalCandidatePath(path: string): string | undefined {
  try {
    const normalized = normalizeRepositoryPath(path, true);
    return normalized === "." || isReservedProviderPath(normalized) ? undefined : normalized;
  } catch {
    return undefined;
  }
}

/** The sole repository-percentage denominator authority for every CLI lifecycle stage. */
async function enumerateRepositoryFiles(
  plan: RewritePlan,
  runtime: CliRuntime,
  providerCandidates: readonly string[] = [],
  excludedPaths: ReadonlySet<string> = new Set(),
): Promise<FileSnapshot[]> {
  const gitScope = await resolveGitScope({
    root: plan.root,
    ...(plan.policy.respectGitIgnore === false ? { includeIgnored: true } : {}),
    ...(runtime.gitExecutable === undefined ? {} : { executable: runtime.gitExecutable }),
  });
  const discovered = gitScope.repository
    ? gitScope.files
    : await discoverSnapshotPaths(plan, ["."], runtime);
  const paths = new Set<string>();
  // Provider results are authoritative candidates even when discovery already named the same path.
  for (const reported of [...discovered, ...providerCandidates]) {
    const path = canonicalCandidatePath(reported);
    if (path !== undefined && !excludedPaths.has(path)) {
      paths.add(path);
    }
  }
  const candidateSnapshots = await Promise.all([...paths].sort(compareStrings).map(async (path) => {
    try {
      const entry = await lstat(resolve(plan.root, path));
      const identity = entry.isSymbolicLink() ? await stat(resolve(plan.root, path)) : entry;
      if (!identity.isFile()) {
        return [];
      }
      return await snapshotTargets(plan.root, [path]);
    } catch {
      // Deleted, unreadable, redirected, or otherwise non-writable candidates are not denominator files.
      return [];
    }
  }));
  const snapshots = new Map<string, FileSnapshot>();
  for (const snapshot of candidateSnapshots.flat()) {
    if (snapshot.encoding === "utf-8" && !excludedPaths.has(snapshot.path)) {
      snapshots.set(snapshot.path, snapshot);
    }
  }
  return [...snapshots.values()].sort((left, right) => compareStrings(left.path, right.path));
}

function gitScopeOptions(
  plan: RewritePlan,
  options: CommonOptions,
  runtime: CliRuntime,
  stored?: GitScopeAudit,
): GitScopeOptions {
  const mode = stored?.mode;
  return {
    root: plan.root,
    ...((mode === "tracked" || (stored === undefined && options.trackedOnly)) ? { trackedOnly: true } : {}),
    ...((mode === "changed" || (stored === undefined && options.changedOnly)) ? { changedOnly: true } : {}),
    ...((mode === "staged" || (stored === undefined && options.staged)) ? { staged: true } : {}),
    ...(mode === "since" && stored?.sinceCommit !== undefined
      ? { since: stored.sinceCommit }
      : stored === undefined && options.since !== undefined ? { since: options.since } : {}),
    ...((stored?.requireClean || options.requireClean || plan.policy.requireClean) ? { requireClean: true } : {}),
    ...(plan.policy.respectGitIgnore === false ? { includeIgnored: true } : {}),
    ...(runtime.gitExecutable === undefined ? {} : { executable: runtime.gitExecutable }),
  };
}

async function assertPlanRootContained(planRoot: string, cwd: string): Promise<void> {
  const invocationRoot = await realpath(cwd);
  const rewriteRoot = await realpath(resolve(cwd, planRoot));
  if (!isContained(invocationRoot, rewriteRoot)) {
    throw new Error("Saved or supplied plan root is outside the invocation root containment boundary.");
  }
}

async function resolveEditPlan(
  rewritePlan: RewritePlan,
  cwd: string,
  runtime: CliRuntime,
  options: CommonOptions,
  excludedPaths: ReadonlySet<string> = new Set(),
  storedGitScope?: GitScopeAudit,
): Promise<{ editPlan: EditPlan; snapshots: FileSnapshot[]; correlation: CorrelationResult; repositoryFiles: number }> {
  const plan = canonicalRewritePlan(rewritePlan, cwd);
  await assertPlanRootContained(plan.root, cwd);
  const targetPaths = [...new Set(plan.operations.flatMap((operation) => operation.paths))];
  const [snapshotPaths, scope, initialRepositorySnapshots] = await Promise.all([
    discoverSnapshotPaths(plan, targetPaths, runtime),
    resolveGitScope(gitScopeOptions(plan, options, runtime, storedGitScope)),
    enumerateRepositoryFiles(plan, runtime, [], excludedPaths),
  ]);
  const scopedRepositorySnapshots = scope.repository
    ? await Promise.all(scope.files.map(async (path) => {
      try {
        if (excludedPaths.has(path)) {
          return [];
        }
        const entry = await lstat(resolve(plan.root, path));
        const identity = entry.isSymbolicLink() ? await stat(resolve(plan.root, path)) : entry;
        if (!identity.isFile()) {
          return [];
        }
        return await snapshotTargets(plan.root, [path]);
      } catch {
        return [];
      }
    })).then((groups) => groups.flat())
    : initialRepositorySnapshots;
  // The index-aware Git list is authoritative even for the default scope: it excludes
  // submodule contents while retaining tracked files hidden by later ignore rules.
  const scopeIsFiltered = scope.repository;
  const allowedByScope = new Set(scopedRepositorySnapshots.map((snapshot) => snapshot.path));
  const targetSnapshotPaths = new Set(snapshotPaths
    .map(canonicalCandidatePath)
    .filter((path): path is string =>
      path !== undefined && !excludedPaths.has(path) && (!scopeIsFiltered || allowedByScope.has(path))));
  for (const snapshot of scopedRepositorySnapshots) {
    if (plan.operations.some((operation) => isWithinOperation(snapshot.path, operation.paths))) {
      targetSnapshotPaths.add(snapshot.path);
    }
  }
  const snapshots = await snapshotTargets(plan.root, [...targetSnapshotPaths]);
  const snapshotted = new Set(snapshots.map((snapshot) => snapshot.path));
  const results: ProviderResult[] = [];

  for (const operation of plan.operations) {
    let operationSnapshots = snapshots.filter((snapshot) => isWithinOperation(snapshot.path, operation.paths));
    const languageDecision = (path: string) => operation.languages?.[0] === undefined
      ? detectLanguage(path, operation.languageOverrides ?? [])
      : { language: operation.languages[0], source: "override" as const };
    let languageDecisions = Object.fromEntries(operationSnapshots.map((snapshot) => [
      snapshot.path,
      languageDecision(snapshot.path),
    ]));
    const requestBase = {
      root: plan.root,
      operation,
      candidatePaths: operationSnapshots.map((snapshot) => snapshot.path),
      respectGitIgnore: plan.policy.respectGitIgnore ?? true,
      excludedPaths: [...excludedPaths],
    };
    const ripgrep = await new RipgrepProvider(
      runtime.ripgrepExecutable === undefined ? {} : { executable: runtime.ripgrepExecutable },
    ).scan({ ...requestBase, languageDecisions });
    const discoveredByProvider = [...new Set(
      ripgrep.evidence
        .map((evidence) => evidence.file)
        .filter((path) =>
          !excludedPaths.has(path) && !snapshotted.has(path) && (!scopeIsFiltered || allowedByScope.has(path))),
    )];
    if (discoveredByProvider.length > 0) {
      for (const snapshot of await snapshotTargets(plan.root, discoveredByProvider)) {
        if (!snapshotted.has(snapshot.path)) {
          snapshots.push(snapshot);
          snapshotted.add(snapshot.path);
        }
      }
      operationSnapshots = snapshots.filter((snapshot) => isWithinOperation(snapshot.path, operation.paths));
      languageDecisions = Object.fromEntries(operationSnapshots.map((snapshot) => [
        snapshot.path,
        languageDecision(snapshot.path),
      ]));
    }
    const astProvider = new AstGrepProvider(
      runtime.astGrepExecutable === undefined ? {} : { executable: runtime.astGrepExecutable },
    );
    const astCandidates = operation.languages;
    let astGrep: ProviderResult;
    if (astCandidates === undefined || astCandidates.length === 0) {
      astGrep = await astProvider.scan({ ...requestBase, languageDecisions });
    } else {
      const candidateResults: ProviderResult[] = [];
      for (const language of astCandidates) {
        const forcedDecisions = Object.fromEntries(operationSnapshots.map((snapshot) => [
          snapshot.path,
          { language, source: "override" as const },
        ]));
        candidateResults.push(await astProvider.scan({
          ...requestBase,
          operation: { ...operation, languages: [language] },
          languageDecisions: forcedDecisions,
        }));
      }
      astGrep = mergeProviderResults(candidateResults, "ast-grep", operation.id);
    }
    const scanned = [ripgrep, astGrep];
    for (const result of scanned) {
      const unavailable = result.evidence.filter((evidence) => !snapshotted.has(evidence.file));
      results.push({
        ...result,
        evidence: result.evidence.filter((evidence) => snapshotted.has(evidence.file)),
        diagnostics: [
          ...result.diagnostics,
          ...unavailable.map((evidence) => omittedSnapshotDiagnostic(result, evidence.file)),
        ],
      });
    }
  }

  const correlation = correlateEvidence(results);
  const repositorySnapshots = await enumerateRepositoryFiles(
    plan,
    runtime,
    results.flatMap((result) => result.evidence.map((evidence) => evidence.file)),
    excludedPaths,
  );
  const currentGitAudit = await auditGitScope(
    scope,
    snapshots.map((snapshot) => snapshot.path),
    gitScopeOptions(plan, options, runtime, storedGitScope),
  );
  if (storedGitScope !== undefined) {
    const stableCurrent = {
      repository: currentGitAudit.repository,
      root: currentGitAudit.root,
      repositoryRoot: currentGitAudit.repositoryRoot,
      head: currentGitAudit.head,
      sinceCommit: currentGitAudit.sinceCommit,
      mode: currentGitAudit.mode,
      requireClean: currentGitAudit.requireClean,
      inputs: currentGitAudit.inputs,
    };
    const stableStored = {
      repository: storedGitScope.repository,
      root: storedGitScope.root,
      repositoryRoot: storedGitScope.repositoryRoot,
      head: storedGitScope.head,
      sinceCommit: storedGitScope.sinceCommit,
      mode: storedGitScope.mode,
      requireClean: storedGitScope.requireClean,
      inputs: storedGitScope.inputs,
    };
    if (stableJson(stableCurrent) !== stableJson(stableStored)) {
      throw new Error("Saved edit plan Git scope or blob/index identities no longer match the repository.");
    }
  }
  return {
    editPlan: buildEditPlan(plan, snapshots, correlation, storedGitScope ?? currentGitAudit),
    snapshots,
    correlation,
    repositoryFiles: repositorySnapshots.length,
  };
}

function mergeProviderResults(
  results: readonly ProviderResult[],
  provider: ProviderResult["provider"],
  operationId: string,
): ProviderResult {
  const first = results[0];
  if (first === undefined) {
    throw new Error(`No ${provider} candidate-language results were produced for ${operationId}.`);
  }
  const evidence = new Map<string, ProviderResult["evidence"][number]>();
  const diagnostics = new Map<string, ProviderDiagnostic>();
  const selectedFiles = new Set<string>();
  for (const result of results) {
    if (result.provider !== provider || result.operationId !== operationId || result.version !== first.version) {
      throw new Error(`Candidate-language provider results disagree for ${operationId}.`);
    }
    const resultFiles = new Set(result.evidence.map((item) => item.file));
    for (const file of resultFiles) {
      if (selectedFiles.has(file)) {
        continue;
      }
      selectedFiles.add(file);
      for (const item of result.evidence.filter((candidate) => candidate.file === file)) {
        evidence.set(item.id, item);
      }
    }
    for (const diagnostic of result.diagnostics) {
      diagnostics.set(stableJson(diagnostic), diagnostic);
    }
  }
  return {
    provider,
    operationId,
    version: first.version,
    evidence: [...evidence.values()],
    diagnostics: [...diagnostics.values()],
    elapsedMs: results.reduce((total, result) => total + result.elapsedMs, 0),
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedEvidenceId(editPlan: EditPlan, index: number): string {
  const evidence = editPlan.evidence[index];
  if (evidence === undefined) {
    throw new Error("Missing edit-plan evidence while validating hashes.");
  }
  return `evidence:${sha256Hex(JSON.stringify([
    evidence.provider,
    evidence.operationId,
    evidence.file,
    evidence.byteRange[0],
    evidence.byteRange[1],
    evidence.matchedTextHash,
  ]))}`;
}

function expectedEditId(edit: Edit): string {
  return `edit:${sha256Hex(stableJson([
    edit.operationIds,
    edit.file,
    edit.byteRange[0],
    edit.byteRange[1],
    edit.replacement,
  ]))}`;
}

function assertEditPlanHashes(editPlan: EditPlan): void {
  if (editPlan.rewritePlanHash !== stableHash(editPlan.rewritePlan)) {
    throw new Error("Saved edit plan rewrite-plan hash does not match its content.");
  }
  for (let index = 0; index < editPlan.evidence.length; index += 1) {
    if (editPlan.evidence[index]?.id !== expectedEvidenceId(editPlan, index)) {
      throw new Error("Saved edit plan evidence hash does not match its content.");
    }
  }
  for (const edit of editPlan.edits) {
    if (edit.id !== expectedEditId(edit)) {
      throw new Error("Saved edit plan edit hash does not match its content.");
    }
  }
  for (const conflict of editPlan.conflicts) {
    const expected = `conflict:${sha256Hex(stableJson([
      conflict.reason,
      ...[...conflict.editIds].sort(),
    ]))}`;
    if (conflict.id !== expected) {
      throw new Error("Saved edit plan conflict hash does not match its content.");
    }
  }
  const expectedPlanId = `edit-plan:${sha256Hex(stableJson({
    rewritePlanHash: editPlan.rewritePlanHash,
    gitScope: editPlan.gitScope,
    inputFiles: editPlan.inputFiles,
    evidenceIds: editPlan.evidence.map((evidence) => evidence.id),
    edits: editPlan.edits.map((edit) => edit.id),
    conflicts: editPlan.conflicts.map((conflict) => conflict.id),
    diagnostics: editPlan.diagnostics,
  }))}`;
  if (!editPlanIdPattern.test(editPlan.id) || editPlan.id !== expectedPlanId) {
    throw new Error("Saved edit-plan hash does not match its content.");
  }
  for (const input of editPlan.inputFiles) {
    if (!hashPattern.test(input.hash)) {
      throw new Error(`Saved input hash is invalid: ${input.path}`);
    }
  }
}

function canonicalDerivedEditPlan(editPlan: EditPlan): string {
  const { createdAt: _createdAt, ...derived } = editPlan;
  return stableJson(derived);
}

function assertSavedPlanMatchesDerivation(saved: EditPlan, derived: EditPlan): void {
  if (canonicalDerivedEditPlan(saved) !== canonicalDerivedEditPlan(derived)) {
    throw new Error(
      "Saved edit plan is stale or incomplete: it does not canonically equal the current provider/correlation/planner derivation.",
    );
  }
}

function assertTransactionHashes(record: TransactionRecord): void {
  if (!transactionIdPattern.test(record.id)) {
    throw new Error("Saved transaction ID is not a safe opaque identifier.");
  }
  if (!hashPattern.test(record.editPlanHash)) {
    throw new Error("Saved transaction edit-plan hash is invalid.");
  }
  for (const file of record.files) {
    if (!hashPattern.test(file.beforeHash) || !hashPattern.test(file.afterHash)) {
      throw new Error(`Saved transaction contains an invalid file hash: ${file.path}`);
    }
  }
}

async function protocolText(source: string, io: CliIo, cwd: string): Promise<string> {
  const value = source === "-"
    ? await (io.stdin ?? defaultIo.stdin!)()
    : await readFile(resolve(cwd, source), "utf8");
  if (Buffer.byteLength(value) > maximumProtocolBytes) {
    throw new Error(`JSON protocol document exceeds ${String(maximumProtocolBytes)} bytes.`);
  }
  return value;
}

async function protocolJson(source: string, io: CliIo, cwd: string): Promise<unknown> {
  const text = await protocolText(source, io, cwd);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON protocol document: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadEditPlan(source: string, io: CliIo, cwd: string): Promise<EditPlan> {
  const editPlan = parseEditPlan(await protocolJson(source, io, cwd));
  assertEditPlanHashes(editPlan);
  await assertPlanRootContained(editPlan.rewritePlan.root, cwd);
  return editPlan;
}

async function loadTransaction(source: string, io: CliIo, cwd: string): Promise<TransactionRecord> {
  const record = parseTransactionRecord(await protocolJson(source, io, cwd));
  assertTransactionHashes(record);
  return record;
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function ensureSafeDirectory(
  root: string,
  directory: string,
  fileSystem: TransactionFileSystem,
): Promise<void> {
  const relation = relative(root, directory);
  if (!isContained(root, directory)) {
    throw new Error("Plan output path escapes the rewrite root.");
  }
  let current = root;
  for (const component of relation.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      await fileSystem.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isExisting(error)) {
        throw error;
      }
    }
    const info = await fileSystem.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() || await fileSystem.realpath(current) !== current) {
      throw new Error(`Plan output directory is not a canonical contained directory: ${current}`);
    }
  }
}

async function assertSafePlanOutputParent(
  root: string,
  directory: string,
  fileSystem: TransactionFileSystem,
): Promise<void> {
  const info = await fileSystem.lstat(directory);
  const canonical = await fileSystem.realpath(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    canonical !== directory ||
    !isContained(root, canonical)
  ) {
    throw new Error(`Plan output parent is not a canonical contained directory: ${directory}`);
  }
}

async function assertMissingPlanOutput(path: string, fileSystem: TransactionFileSystem): Promise<void> {
  try {
    await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  throw new Error(`Plan output already exists: ${path}`);
}

async function cleanupPlanSibling(
  path: string,
  fileSystem: TransactionFileSystem,
  attempts = 2,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fileSystem.unlink(path);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return true;
      }
    }
  }
  return false;
}

function planSiblingWarning(root: string, sibling: string): string {
  const prefix = "Plan output was published, but temporary sibling cleanup failed; remove: ";
  const repositoryPath = relative(root, sibling).split(sep).join("/");
  const warning = `${prefix}${repositoryPath}`;
  const maximumWarningBytes = 8 * 1024;
  if (Buffer.byteLength(warning) <= maximumWarningBytes) {
    return warning;
  }
  return `${prefix}${basename(sibling)} (in the plan output parent)`;
}

function protocolSerialization(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertProtocolSerializationFits(value: unknown, label: string): string {
  const serialized = protocolSerialization(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumProtocolBytes) {
    throw new Error(
      `${label} cannot be reloaded: ${String(bytes)} serialized bytes exceeds the ${String(maximumProtocolBytes)}-byte protocol limit.`,
    );
  }
  return serialized;
}

async function saveEditPlan(
  editPlan: EditPlan,
  destination: string,
  fileSystem: TransactionFileSystem,
): Promise<string | undefined> {
  assertEditPlanHashes(editPlan);
  const serialized = assertProtocolSerializationFits(editPlan, "Generated edit plan");
  const reloaded = parseEditPlan(JSON.parse(serialized) as unknown);
  assertEditPlanHashes(reloaded);
  const root = await fileSystem.realpath(resolve(editPlan.rewritePlan.root));
  const path = resolve(root, destination);
  if (!isContained(root, path)) {
    throw new Error("Plan output path escapes the rewrite root.");
  }
  const parent = dirname(path);
  await ensureSafeDirectory(root, parent, fileSystem);
  // Repeat containment before creating the sibling, closing changes made while directories were prepared.
  await assertSafePlanOutputParent(root, parent, fileSystem);
  await assertMissingPlanOutput(path, fileSystem);
  const sibling = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let siblingState: "unattempted" | "write-attempted" | "owned" | "published" | "cleaned" = "unattempted";
  try {
    siblingState = "write-attempted";
    await fileSystem.writeFile(sibling, serialized, { flag: "wx", mode: 0o600 });
    siblingState = "owned";
    await fileSystem.chmod(sibling, 0o600);
    // Node has no directory-handle-relative link API; repeat the identity gate immediately before publication.
    await assertSafePlanOutputParent(root, parent, fileSystem);
    await assertMissingPlanOutput(path, fileSystem);
    // A same-directory hard link is atomic and, unlike rename, can never replace an existing destination.
    await fileSystem.link(sibling, path);
    siblingState = "published";
  } catch (error) {
    if (siblingState === "owned" || (siblingState === "write-attempted" && !isExisting(error))) {
      if (await cleanupPlanSibling(sibling, fileSystem)) {
        siblingState = "cleaned";
      }
    }
    throw error;
  }
  if (await cleanupPlanSibling(sibling, fileSystem)) {
    siblingState = "cleaned";
    return undefined;
  }
  if (siblingState !== "published") {
    throw new Error("Plan publication did not reach a valid terminal state.");
  }
  return planSiblingWarning(root, sibling);
}

function changedBytes(editPlan: EditPlan, snapshots: readonly FileSnapshot[]): number {
  if (editPlan.conflicts.length > 0) {
    const newlineByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.newline]));
    return editPlan.edits.reduce((total, edit) => {
      const replacement = newlineByPath.get(edit.file) === "crlf"
        ? edit.replacement.replace(/\r?\n/gu, "\r\n")
        : edit.replacement;
      return total + Math.max(edit.byteRange[1] - edit.byteRange[0], Buffer.byteLength(replacement));
    }, 0);
  }
  const editsByPath = new Map<string, EditPlan["edits"]>();
  for (const edit of editPlan.edits) {
    const grouped = editsByPath.get(edit.file) ?? [];
    grouped.push(edit);
    editsByPath.set(edit.file, grouped);
  }
  return snapshots.reduce((total, snapshot) => {
    const edits = editsByPath.get(snapshot.path);
    if (edits === undefined || edits.length === 0) {
      return total;
    }
    return total + disjointChangedBytes(snapshot.content, applySnapshotEdits(snapshot, edits));
  }, 0);
}

function classifications(correlation: CorrelationResult): Record<MatchClassification, number> {
  const result: Record<MatchClassification, number> = {
    confirmed: 0,
    "ast-only": 0,
    "text-only": 0,
    adjacent: 0,
    conflicting: 0,
    unparseable: 0,
  };
  for (const match of correlation.matches) {
    result[match.classification] += 1;
  }
  return result;
}

function policyResult(
  editPlan: EditPlan,
  correlation: CorrelationResult,
  snapshots: readonly FileSnapshot[],
  repositoryFiles: number,
): RewritePolicyResult {
  const files = new Set(editPlan.edits.map((edit) => edit.file)).size;
  const actualChangedBytes = changedBytes(editPlan, snapshots);
  const repositoryPercent = repositoryFiles === 0
    ? files === 0 ? 0 : 100
    : (files / repositoryFiles) * 100;
  const actual = {
    files,
    matches: correlation.matches.length,
    changedBytes: actualChangedBytes,
    repositoryFiles,
    repositoryPercent,
  };
  const policy = editPlan.rewritePlan.policy;
  const limits = {
    ...(policy.maxFiles === undefined ? {} : { files: policy.maxFiles }),
    ...(policy.maxMatches === undefined ? {} : { matches: policy.maxMatches }),
    ...(policy.maxChangedBytes === undefined ? {} : { changedBytes: policy.maxChangedBytes }),
    ...(policy.maxRepositoryPercent === undefined ? {} : { repositoryPercent: policy.maxRepositoryPercent }),
  };
  const violations: RewritePolicyResult["violations"] = [];
  if (limits.files !== undefined && actual.files > limits.files) {
    violations.push("files");
  }
  if (limits.matches !== undefined && actual.matches > limits.matches) {
    violations.push("matches");
  }
  if (limits.changedBytes !== undefined && actual.changedBytes > limits.changedBytes) {
    violations.push("changedBytes");
  }
  if (limits.repositoryPercent !== undefined && actual.repositoryPercent > limits.repositoryPercent) {
    violations.push("repositoryPercent");
  }
  return { actual, limits, violations };
}

function invariantResults(editPlan: EditPlan): PlanningResult["invariants"] {
  return editPlan.rewritePlan.operations.flatMap((operation) => {
    const constraint = operation.expectedCount;
    if (constraint === undefined) {
      return [];
    }
    const actual = editPlan.edits.filter((edit) => edit.operationIds.includes(operation.id)).length;
    const passed =
      (constraint.exact === undefined || actual === constraint.exact) &&
      (constraint.min === undefined || actual >= constraint.min) &&
      (constraint.max === undefined || actual <= constraint.max);
    return [{
      operationId: operation.id,
      constraint,
      actual,
      status: passed ? "passed" as const : "failed" as const,
    }];
  });
}

function planningResult(
  editPlan: EditPlan,
  snapshots: readonly FileSnapshot[],
  correlation: CorrelationResult,
  repositoryFiles: number,
): PlanningResult {
  const preview = editPlan.conflicts.length === 0 ? renderPreview(editPlan, { snapshots }) : "";
  const skippedOrUnparseable: PlanningResult["skippedOrUnparseable"] = [
    ...correlation.matches
      .filter((match) => match.classification === "unparseable" ||
        match.classification === "adjacent" || match.classification === "conflicting")
      .map((match) => ({
        kind: "match" as const,
        operationId: match.operationId,
        file: match.file,
        classification: match.classification,
      })),
    ...editPlan.diagnostics
      .filter((diagnostic) => /(?:skip|unparseable|unsupported|pattern-error)/u.test(diagnostic.code))
      .map((diagnostic) => ({
        kind: "diagnostic" as const,
        code: diagnostic.code,
        ...(diagnostic.operationId === undefined ? {} : { operationId: diagnostic.operationId }),
        paths: diagnostic.paths,
      })),
  ];
  return {
    editPlan,
    correlation,
    classifications: classifications(correlation),
    conflicts: editPlan.conflicts,
    diagnostics: editPlan.diagnostics,
    skippedOrUnparseable,
    changedBytes: changedBytes(editPlan, snapshots),
    invariants: invariantResults(editPlan),
    policy: policyResult(editPlan, correlation, snapshots, repositoryFiles),
    validations: editPlan.rewritePlan.validations,
    validationInvocations: [],
    preview,
  };
}

function humanPreview(planning: PlanningResult): string {
  const editPlan = planning.editPlan;
  const files = new Set(editPlan.edits.map((edit) => edit.file));
  const summary = `Plan ${editPlan.id}: ${String(editPlan.edits.length)} edit(s) in ${String(files.size)} file(s), ${String(editPlan.conflicts.length)} conflict(s).`;
  const classificationText = (Object.entries(planning.classifications) as Array<[string, number]>)
    .map(([name, count]) => `${name}=${String(count)}`)
    .join(", ");
  const conflicts = planning.conflicts.length === 0
    ? "Conflicts: none"
    : `Conflicts:\n${planning.conflicts.map((conflict) =>
      `- ${conflict.id}: ${conflict.reason} (${conflict.editIds.join(", ")})`).join("\n")}`;
  const skipped = planning.skippedOrUnparseable.length === 0
    ? "Skipped/unparseable: none"
    : `Skipped/unparseable: ${planning.skippedOrUnparseable.map((item) =>
      item.kind === "match" ? `${item.classification}:${item.file}` : `${item.code}:${item.paths.join(",")}`).join("; ")}`;
  const limits = planning.policy.limits;
  const limit = (value: number | undefined): string => value === undefined ? "unlimited" : String(value);
  const policy = [
    `files=${String(planning.policy.actual.files)}/${limit(limits.files)}`,
    `matches=${String(planning.policy.actual.matches)}/${limit(limits.matches)}`,
    `changedBytes=${String(planning.policy.actual.changedBytes)}/${limit(limits.changedBytes)}`,
    `repositoryPercent=${String(planning.policy.actual.repositoryPercent)}/${limit(limits.repositoryPercent)}`,
    `repositoryFiles=${String(planning.policy.actual.repositoryFiles)}`,
    `violations=${planning.policy.violations.length === 0 ? "none" : planning.policy.violations.join(",")}`,
  ].join(", ");
  const invariants = planning.invariants.length === 0
    ? "Expected counts: none"
    : `Expected counts:\n${planning.invariants.map((invariant) => {
      const constraint = [
        invariant.constraint.exact === undefined ? undefined : `exact=${String(invariant.constraint.exact)}`,
        invariant.constraint.min === undefined ? undefined : `min=${String(invariant.constraint.min)}`,
        invariant.constraint.max === undefined ? undefined : `max=${String(invariant.constraint.max)}`,
      ].filter((item): item is string => item !== undefined).join(", ");
      return `- ${invariant.operationId}: ${constraint}, actual=${String(invariant.actual)} ${invariant.status === "passed" ? "PASS" : "FAIL"}`;
    }).join("\n")}`;
  const validations = planning.validations.length === 0
    ? "Validations: none"
    : `Validations:\n${planning.validations.map((validation) => {
      const parameters = [
        validation.type === "prettier" && validation.paths !== undefined
          ? `paths=${validation.paths.join(",")}`
          : undefined,
        validation.cwd === undefined ? undefined : `cwd=${validation.cwd}`,
        validation.timeoutMs === undefined ? undefined : `timeoutMs=${String(validation.timeoutMs)}`,
        validation.maxOutputBytes === undefined ? undefined : `maxOutputBytes=${String(validation.maxOutputBytes)}`,
      ].filter((item): item is string => item !== undefined);
      return `- ${validation.type}${parameters.length === 0 ? "" : `(${parameters.join("; ")})`}`;
    }).join("\n")}`;
  const validationInvocations = planning.validationInvocations.length === 0
    ? "Validation invocations: none"
    : `Validation invocations:\n${planning.validationInvocations.map((invocation) => {
      const source = invocation.source === "named-adapter" ? invocation.adapter : "explicit-command";
      return `- ${source}: executable=${invocation.executable}; argv=${JSON.stringify(invocation.argv)}; cwd=${invocation.cwd}; actualCwd=${invocation.executionCwd}; timeoutMs=${String(invocation.timeoutMs)}; maxOutputBytes=${String(invocation.maxOutputBytes)}; stage=${invocation.stage}; rollback=${invocation.rollbackPolicy}${invocation.configResolution === undefined ? "" : `; config=${invocation.configResolution}`}`;
    }).join("\n")}`;
  const gitScope = planning.editPlan.gitScope;
  const gitScopeAudit = [
    `repository=${String(gitScope.repository)}`,
    `root=${gitScope.root}`,
    gitScope.repositoryRoot === undefined ? undefined : `repositoryRoot=${gitScope.repositoryRoot}`,
    gitScope.head === undefined ? undefined : `head=${gitScope.head}`,
    gitScope.sinceCommit === undefined ? undefined : `sinceCommit=${gitScope.sinceCommit}`,
    `dirty=${String(gitScope.dirty)}`,
    `mode=${gitScope.mode}`,
    `requireClean=${String(gitScope.requireClean)}`,
    `inputs=${gitScope.inputs.map((input) =>
      `${input.path}:worktree=${input.worktreeBlob}${input.indexBlob === undefined ? "" : `:index=${input.indexBlob}`}`).join(",") || "none"}`,
  ].filter((item): item is string => item !== undefined).join("; ");
  const validationPolicy = planning.validationPolicy === undefined
    ? "Validation policy: not resolved"
    : `Validation policy: keepOnCheckFailure=${String(planning.validationPolicy.keepOnCheckFailure)}; rollback=${planning.validationPolicy.rollbackPolicy}; authority=${planning.validationPolicy.authority}`;
  const sections = [
    summary,
    `Classifications: ${classificationText}`,
    conflicts,
    skipped,
    `Changed bytes: ${String(planning.changedBytes)}`,
    `Policy: ${policy}`,
    invariants,
    validations,
    validationInvocations,
    `Git scope audit: ${gitScopeAudit}`,
    validationPolicy,
  ];
  if (planning.preview.length > 0) {
    sections.push(planning.preview);
  }
  return `${sections.join("\n")}\n`;
}

function emitDiagnostics(io: CliIo, diagnostics: readonly Diagnostic[]): void {
  const rendered = diagnosticLines(diagnostics);
  if (rendered.length > 0) {
    io.stderr(rendered);
  }
}

function emitResult(io: CliIo, json: boolean, result: CliResult, human?: string): void {
  if (json) {
    io.stdout(stableJsonLine(result));
  } else if (human !== undefined && human.length > 0) {
    io.stdout(human.endsWith("\n") ? human : `${human}\n`);
  }
}

function blockingPlanError(planning: PlanningResult): Error | undefined {
  const editPlan = planning.editPlan;
  if (planning.policy.violations.length > 0) {
    return new Error(
      `Edit plan ${editPlan.id} exceeds rewrite policy limits: ${planning.policy.violations.join(", ")}.`,
    );
  }
  if (editPlan.conflicts.length > 0) {
    return new Error(`Edit plan ${editPlan.id} has unresolved conflicts.`);
  }
  const diagnostic = editPlan.diagnostics.find((item) => blockingDiagnosticCodes.has(item.code));
  return diagnostic === undefined
    ? undefined
    : new Error(`Edit plan ${editPlan.id} has a blocking diagnostic (${diagnostic.code}).`);
}

function validationRequests(
  editPlan: EditPlan,
  options: CommonOptions | { json: boolean },
): Array<ValidationSpec | TrustedValidationCommand> {
  if (!("checks" in options)) {
    return [];
  }
  const authorizedAdapters = new Set(options.checks);
  const authorizedPlanned = editPlan.rewritePlan.validations.filter((validation) => authorizedAdapters.has(validation.type));
  const plannedAdapters = new Set(authorizedPlanned.map((validation) => validation.type));
  const cliChecks: ValidationSpec[] = [...new Set(options.checks)]
    .filter((type) => !plannedAdapters.has(type))
    .map((type) => ({ type }));
  return [...authorizedPlanned, ...cliChecks, ...options.explicitValidations];
}

function disjointChangedBytes(before: Uint8Array, after: Uint8Array): number {
  type Step = "delete" | "insert" | "equal";
  const steps: Step[] = [];
  const append = (step: Step, count: number): void => {
    for (let index = 0; index < count; index += 1) {
      steps.push(step);
    }
  };
  const bisect = (left: Uint8Array, right: Uint8Array): [number, number] | undefined => {
    const leftLength = left.byteLength;
    const rightLength = right.byteLength;
    const maximumDistance = Math.ceil((leftLength + rightLength) / 2);
    const offset = maximumDistance;
    const size = (maximumDistance * 2) + 1;
    const forward = new Int32Array(size);
    const reverse = new Int32Array(size);
    forward.fill(-1);
    reverse.fill(-1);
    forward[offset + 1] = 0;
    reverse[offset + 1] = 0;
    const delta = leftLength - rightLength;
    const oddDelta = delta % 2 !== 0;
    let forwardStart = 0;
    let forwardEnd = 0;
    let reverseStart = 0;
    let reverseEnd = 0;
    for (let distance = 0; distance < maximumDistance; distance += 1) {
      for (let diagonal = -distance + forwardStart; diagonal <= distance - forwardEnd; diagonal += 2) {
        const index = offset + diagonal;
        let x = diagonal === -distance || (diagonal !== distance && forward[index - 1]! < forward[index + 1]!)
          ? forward[index + 1]!
          : forward[index - 1]! + 1;
        let y = x - diagonal;
        while (x < leftLength && y < rightLength && left[x] === right[y]) {
          x += 1;
          y += 1;
        }
        forward[index] = x;
        if (x > leftLength) {
          forwardEnd += 2;
        } else if (y > rightLength) {
          forwardStart += 2;
        } else if (oddDelta) {
          const reverseIndex = offset + delta - diagonal;
          if (reverseIndex >= 0 && reverseIndex < size && reverse[reverseIndex]! !== -1) {
            const reverseX = leftLength - reverse[reverseIndex]!;
            if (x >= reverseX) {
              return [x, y];
            }
          }
        }
      }
      for (let diagonal = -distance + reverseStart; diagonal <= distance - reverseEnd; diagonal += 2) {
        const index = offset + diagonal;
        let x = diagonal === -distance || (diagonal !== distance && reverse[index - 1]! < reverse[index + 1]!)
          ? reverse[index + 1]!
          : reverse[index - 1]! + 1;
        let y = x - diagonal;
        while (x < leftLength && y < rightLength && left[leftLength - x - 1] === right[rightLength - y - 1]) {
          x += 1;
          y += 1;
        }
        reverse[index] = x;
        if (x > leftLength) {
          reverseEnd += 2;
        } else if (y > rightLength) {
          reverseStart += 2;
        } else if (!oddDelta) {
          const forwardIndex = offset + delta - diagonal;
          if (forwardIndex >= 0 && forwardIndex < size && forward[forwardIndex]! !== -1) {
            const forwardX = forward[forwardIndex]!;
            const forwardY = forwardX - (delta - diagonal);
            const reverseX = leftLength - x;
            if (forwardX >= reverseX) {
              return [forwardX, forwardY];
            }
          }
        }
      }
    }
    return undefined;
  };
  const diff = (left: Uint8Array, right: Uint8Array): void => {
    let prefix = 0;
    while (prefix < left.byteLength && prefix < right.byteLength && left[prefix] === right[prefix]) {
      prefix += 1;
    }
    if (prefix > 0) {
      append("equal", prefix);
      left = left.subarray(prefix);
      right = right.subarray(prefix);
    }
    let suffix = 0;
    while (suffix < left.byteLength && suffix < right.byteLength && left[left.byteLength - suffix - 1] === right[right.byteLength - suffix - 1]) {
      suffix += 1;
    }
    const leftMiddle = suffix === 0 ? left : left.subarray(0, left.byteLength - suffix);
    const rightMiddle = suffix === 0 ? right : right.subarray(0, right.byteLength - suffix);
    if (leftMiddle.byteLength === 0) {
      append("insert", rightMiddle.byteLength);
    } else if (rightMiddle.byteLength === 0) {
      append("delete", leftMiddle.byteLength);
    } else {
      const split = bisect(leftMiddle, rightMiddle);
      if (split === undefined || (split[0] === 0 && split[1] === 0) ||
        (split[0] === leftMiddle.byteLength && split[1] === rightMiddle.byteLength)) {
        append("delete", leftMiddle.byteLength);
        append("insert", rightMiddle.byteLength);
      } else {
        diff(leftMiddle.subarray(0, split[0]), rightMiddle.subarray(0, split[1]));
        diff(leftMiddle.subarray(split[0]), rightMiddle.subarray(split[1]));
      }
    }
    append("equal", suffix);
  };
  diff(before, after);
  let changed = 0;
  let deleted = 0;
  let inserted = 0;
  const flush = (): void => {
    changed += Math.max(deleted, inserted);
    deleted = 0;
    inserted = 0;
  };
  for (const step of steps) {
    if (step === "equal") {
      flush();
    } else if (step === "delete") {
      deleted += 1;
    } else {
      inserted += 1;
    }
  }
  flush();
  return changed;
}

function changedPreparedBytes(outputs: ReturnType<typeof preparedTransactionOutputs>): number {
  return outputs.reduce((total, output) => total + disjointChangedBytes(output.before, output.after), 0);
}

async function validationPreviews(
  requests: readonly (ValidationSpec | TrustedValidationCommand)[],
  editPlan: EditPlan,
  runtime: CliRuntime,
  keepOnCheckFailure: boolean,
): Promise<ValidationInvocation[]> {
  const context = {
    root: editPlan.rewritePlan.root,
    changedPaths: [...new Set(editPlan.edits.map((edit) => edit.file))],
    ...(runtime.validationExecutables === undefined ? {} : { executables: runtime.validationExecutables }),
    ...(runtime.validationEnv === undefined ? {} : { env: runtime.validationEnv }),
    ...(keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
  };
  const [precommit, postcommit] = await Promise.all([
    resolveValidationInvocations(requests, { ...context, stage: "precommit" }),
    resolveValidationInvocations(requests, { ...context, stage: "postcommit" }),
  ]);
  return [...precommit, ...postcommit];
}

async function runEditPlan(
  command: "rewrite" | "plan" | "inspect" | "apply",
  planning: PlanningResult,
  options: CommonOptions | { json: boolean },
  io: CliIo,
  runtime: CliRuntime,
): Promise<number> {
  const editPlan = planning.editPlan;
  const requests = validationRequests(editPlan, options);
  const keepOnCheckFailure = editPlan.rewritePlan.policy.keepOnCheckFailure === true ||
    ("keepOnCheckFailure" in options && options.keepOnCheckFailure);
  const validationPolicy: TransactionRecord["validationPolicy"] = {
    keepOnCheckFailure,
    rollbackPolicy: keepOnCheckFailure ? "keep-on-failure" : "rollback-on-failure",
    authority: "keepOnCheckFailure" in options && options.keepOnCheckFailure
      ? "cli-override"
      : editPlan.rewritePlan.policy.keepOnCheckFailure === true ? "plan" : "default",
  };
  planning.validationPolicy = validationPolicy;
  const authorizedNamed = requests.filter((request): request is ValidationSpec => "type" in request);
  planning.validations = [
    ...editPlan.rewritePlan.validations,
    ...authorizedNamed.filter((request) => !editPlan.rewritePlan.validations.some((planned) => planned.type === request.type)),
  ];
  planning.validationInvocations = await validationPreviews(requests, editPlan, runtime, keepOnCheckFailure);
  emitDiagnostics(io, editPlan.diagnostics);
  const blocked = blockingPlanError(planning);
  if (blocked !== undefined) {
    if (editPlan.diagnostics.length === 0 || planning.policy.violations.length > 0) {
      io.stderr(`${blocked.message}\n`);
    }
    const outcome: CliOutcome = editPlan.conflicts.length > 0 ? "conflict" : "invalid";
    emitResult(io, options.json, editPlanResult(command, outcome, 1, planning), humanPreview(planning));
    return 1;
  }
  if ("planOut" in options && options.planOut !== undefined) {
    const publicationWarning = await saveEditPlan(
      editPlan,
      options.planOut,
      runtime.fileSystem ?? nodeTransactionFileSystem,
    );
    if (publicationWarning !== undefined) {
      io.stderr(`${publicationWarning}\n`);
    }
  }
  if (editPlan.edits.length === 0) {
    emitResult(io, options.json, editPlanResult(command, "no-op", 0, planning), humanPreview(planning));
    return 0;
  }

  // This is deliberately before preview/prompt: it is a no-write stale/encoding/containment gate.
  const prepared = await prepareTransaction(
    editPlan,
    {
      ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
      validationPolicy,
    },
  );
  if (command === "inspect") {
    emitResult(io, options.json, editPlanResult(command, "inspected", 0, planning), humanPreview(planning));
    return 0;
  }
  const preparedOutputs = preparedTransactionOutputs(prepared);
  const preparedLanguageByPath = new Map<string, AstGrepLanguage>();
  for (const evidence of editPlan.evidence) {
    if (evidence.language !== undefined && !preparedLanguageByPath.has(evidence.file)) {
      preparedLanguageByPath.set(evidence.file, evidence.language);
    }
  }
  const namedRequests = requests.filter((request): request is ValidationSpec => "type" in request);
  const preparedValidation = await runPreparedValidations(
    namedRequests,
    preparedOutputs.map((output) => ({
      path: output.path,
      content: output.after,
      mode: output.afterMode,
      ...(preparedLanguageByPath.get(output.path) === undefined
        ? {}
        : { language: preparedLanguageByPath.get(output.path)! }),
    })),
    {
      root: editPlan.rewritePlan.root,
      ...(runtime.validationExecutables === undefined ? {} : { executables: runtime.validationExecutables }),
      ...(runtime.validationEnv === undefined ? {} : { env: runtime.validationEnv }),
      ...(runtime.astGrepExecutable === undefined ? {} : { astGrepExecutable: runtime.astGrepExecutable }),
      ...(keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
    },
  );
  planning.validationInvocations = [
    ...preparedValidation.invocations,
    ...planning.validationInvocations.filter((invocation) => invocation.stage === "postcommit"),
  ];
  if (!validationsPassed(preparedValidation.results)) {
    for (const validation of preparedValidation.results) {
      if (validation.output.length > 0) {
        io.stderr(`${validation.output}${validation.output.endsWith("\n") ? "" : "\n"}`);
      }
    }
    emitResult(io, options.json, editPlanResult(command, "failed", 1, planning), humanPreview(planning));
    return 1;
  }
  updatePreparedTransactionOutputs(prepared, preparedValidation.outputs);
  appendPreparedTransactionValidations(prepared, preparedValidation.results);
  if (preparedValidation.results.length > 0) {
    planning.preview = preparedTransactionPreview(prepared);
    planning.changedBytes = changedPreparedBytes(preparedTransactionOutputs(prepared));
    planning.policy.actual.changedBytes = planning.changedBytes;
    const changedBytesLimit = planning.policy.limits.changedBytes;
    const violation = changedBytesLimit !== undefined && planning.changedBytes > changedBytesLimit;
    planning.policy.violations = planning.policy.violations.filter((item) => item !== "changedBytes");
    if (violation) {
      planning.policy.violations.push("changedBytes");
      io.stderr("Prepared formatter output exceeds the rewrite changed-bytes policy.\n");
      emitResult(io, options.json, editPlanResult(command, "invalid", 1, planning), humanPreview(planning));
      return 1;
    }
  }
  const maximumRecordBytes = preparedTransactionMaximumRecordBytes(
    prepared,
    planning.validationInvocations.filter((invocation) => invocation.stage === "postcommit"),
  );
  if (maximumRecordBytes > maximumProtocolBytes) {
    throw new Error(
      `Worst-case transaction record JSON serialization can require ${String(maximumRecordBytes)} bytes, exceeding the loader limit of ${String(maximumProtocolBytes)} bytes.`,
    );
  }
  const preview = humanPreview(planning);
  const writeOptions = options as CommonOptions;
  if (writeOptions.json && writeOptions.write && planning.validationInvocations.length > 0) {
    io.stderr(preview);
  }
  if (!writeOptions.json) {
    io.stdout(preview);
  }
  const shouldPrompt = !writeOptions.write && !writeOptions.dryRun && io.isTTY;
  if (!writeOptions.write && !shouldPrompt) {
    emitResult(io, writeOptions.json, editPlanResult(command, "previewed", 0, planning));
    return 0;
  }
  if (shouldPrompt) {
    const prompt = "Apply all changes? [y/N] ";
    if (writeOptions.json) {
      io.stderr(preview);
      io.stderr(prompt);
    } else {
      io.stdout(prompt);
    }
    let confirmed = false;
    try {
      confirmed = await io.confirm();
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      emitResult(io, writeOptions.json, editPlanResult(command, "declined", 0, planning), "Declined; no files changed.\n");
      return 0;
    }
  }

  const record = await commitTransaction(prepared, {
    beforeFirstSourceWrite: async () => recheckGitScopeClean(editPlan.gitScope, {
      ...(runtime.gitExecutable === undefined ? {} : { executable: runtime.gitExecutable }),
    }),
    runPostcommitValidations: async () => runValidations(requests, {
      root: editPlan.rewritePlan.root,
      stage: "postcommit",
      changedPaths: preparedOutputs.map((output) => output.path),
      ...(runtime.validationExecutables === undefined ? {} : { executables: runtime.validationExecutables }),
      ...(runtime.validationEnv === undefined ? {} : { env: runtime.validationEnv }),
      ...(keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
    }),
  });
  const validationResults = record.validations;
  const postcommitResults = record.validations.slice(preparedValidation.results.length);
  let finalHashesVerified = true;
  if (record.state === "committed" || record.state === "rolled-back") {
    const verification = await verifyTransaction(record, {
      root: editPlan.rewritePlan.root,
      ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
    });
    finalHashesVerified = verification.ok;
    if (!verification.ok) {
      for (const diagnostic of verification.diagnostics) {
        io.stderr(`${diagnostic}\n`);
      }
    }
  }
  const checksPassed = validationsPassed(validationResults) && finalHashesVerified;
  for (const validation of postcommitResults) {
    if (validation.status !== "passed" && validation.output.length > 0) {
      io.stderr(`${validation.output}${validation.output.endsWith("\n") ? "" : "\n"}`);
    }
  }
  const outcome: CliOutcome = record.state === "partial-commit"
    ? "partial-commit"
    : record.state === "committed" && checksPassed ? "written" : "failed";
  const exitCode = record.state === "partial-commit" ? 3 : record.state === "committed" && checksPassed ? 0 : 1;
  emitResult(
    io,
    writeOptions.json,
    editPlanResult(command, outcome, exitCode, planning, record),
    record.state === "committed"
      ? `Committed transaction ${record.id}.\n`
      : `Transaction ${record.id} ended in state ${record.state}.\n`,
  );
  return exitCode;
}

async function snapshotsForSavedPlan(editPlan: EditPlan): Promise<FileSnapshot[]> {
  return snapshotTargets(editPlan.rewritePlan.root, editPlan.inputFiles.map((input) => input.path));
}

async function savedArtifactExclusions(
  source: string,
  cwd: string,
  rewriteRoot: string,
): Promise<ReadonlySet<string>> {
  if (source === "-") {
    return new Set();
  }
  const root = await realpath(resolve(rewriteRoot));
  const artifact = await realpath(resolve(cwd, source));
  if (!isContained(root, artifact) || artifact === root) {
    return new Set();
  }
  const path = canonicalCandidatePath(relative(root, artifact).split(sep).join("/"));
  return path === undefined ? new Set() : new Set([path]);
}

function correlationForSavedPlan(editPlan: EditPlan): CorrelationResult {
  const grouped = new Map<string, ProviderResult>();
  for (const operation of editPlan.rewritePlan.operations) {
    for (const [provider, version] of Object.entries(editPlan.providerVersions)) {
      grouped.set(stableJson([provider, operation.id]), {
        provider,
        operationId: operation.id,
        version,
        evidence: [],
        diagnostics: [],
        elapsedMs: 0,
      });
    }
  }
  for (const evidence of editPlan.evidence) {
    const key = stableJson([evidence.provider, evidence.operationId]);
    const result = grouped.get(key);
    if (result === undefined) {
      throw new Error(`Saved evidence names an undeclared provider version: ${evidence.provider}.`);
    }
    result.evidence.push(evidence);
  }
  for (const diagnostic of editPlan.diagnostics) {
    if (diagnostic.provider === undefined || diagnostic.operationId === undefined) {
      continue;
    }
    const result = grouped.get(stableJson([diagnostic.provider, diagnostic.operationId]));
    if (result !== undefined) {
      result.diagnostics.push({
        code: diagnostic.code,
        message: diagnostic.message,
        operationId: diagnostic.operationId,
        ...(diagnostic.language === undefined ? {} : { language: diagnostic.language }),
        paths: diagnostic.paths,
      });
    }
  }
  return correlateEvidence([...grouped.values()]);
}

async function runVerify(command: VerifyCommand, io: CliIo, cwd: string, runtime: CliRuntime): Promise<number> {
  const record = await loadTransaction(command.source, io, cwd);
  const verification = await verifyTransaction(record, {
    root: cwd,
    ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
  });
  const result: CliResult = {
    version: 1,
    command: "verify",
    outcome: verification.ok ? "verified" : "verification-failed",
    exitCode: verification.ok ? 0 : 1,
    transactionId: record.id,
    state: record.state,
    verification,
  };
  for (const diagnostic of verification.diagnostics) {
    io.stderr(`${diagnostic}\n`);
  }
  emitResult(
    io,
    command.json,
    result,
    verification.ok ? `Transaction ${record.id} verified.\n` : `Transaction ${record.id} did not verify.\n`,
  );
  return result.exitCode;
}

async function runUndo(command: UndoCommand, io: CliIo, cwd: string, runtime: CliRuntime): Promise<number> {
  const record = await loadTransaction(command.source, io, cwd);
  const transactionOptions = {
    root: cwd,
    ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
  };
  const verification = await verifyTransaction(record, transactionOptions);
  if (!verification.ok) {
    for (const diagnostic of verification.diagnostics) {
      io.stderr(`${diagnostic}\n`);
    }
    const result: CliResult = {
      version: 1,
      command: "undo",
      outcome: "verification-failed",
      exitCode: 1,
      transactionId: record.id,
      state: record.state,
      verification,
    };
    emitResult(io, command.json, result, `Transaction ${record.id} cannot be undone safely.\n`);
    return 1;
  }
  const undoPreview = await previewUndoTransaction(record, transactionOptions);
  if (!undoPreview.storedInversePatchMatches) {
    io.stderr("Stored inverse patch differs from validated retained/current bytes; using the authoritative recomputed undo preview.\n");
  }
  for (const state of ["undone", "partial-commit"] as const) {
    assertProtocolSerializationFits(
      { ...record, completedAt: new Date().toISOString(), state },
      `Persisted ${state} transaction record`,
    );
  }
  const undoModes = undoPreview.files.map((file) =>
    `Undo ${file.path}: mode ${file.currentMode.toString(8).padStart(4, "0")} -> ${file.beforeMode.toString(8).padStart(4, "0")}`,
  ).join("\n");
  const undoHumanPreview = `${undoModes}\n${undoPreview.patch}${undoPreview.patch.endsWith("\n") ? "" : "\n"}`;
  if (!command.json) {
    io.stdout(undoHumanPreview);
  }
  const shouldPrompt = !command.write && !command.dryRun && io.isTTY;
  if (!command.write && !shouldPrompt) {
    const result: CliResult = {
      version: 1,
      command: "undo",
      outcome: "previewed",
      exitCode: 0,
      transactionId: record.id,
      state: record.state,
      verification,
      undoPreview,
    };
    emitResult(io, command.json, result);
    return 0;
  }
  if (shouldPrompt) {
    const prompt = "Undo all changes? [y/N] ";
    if (command.json) {
      io.stderr(undoHumanPreview);
      io.stderr(prompt);
    } else {
      io.stdout(prompt);
    }
    let confirmed = false;
    try {
      confirmed = await io.confirm();
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      const result: CliResult = {
        version: 1,
        command: "undo",
        outcome: "declined",
        exitCode: 0,
        transactionId: record.id,
        state: record.state,
        undoPreview,
      };
      emitResult(io, command.json, result, "Declined; no files changed.\n");
      return 0;
    }
  }

  const undone = await undoTransaction(record, transactionOptions);
  const exitCode = undone.state === "undone" ? 0 : undone.state === "partial-commit" ? 3 : 1;
  const result: CliResult = {
    version: 1,
    command: "undo",
    outcome: undone.state === "undone" ? "undone" : undone.state === "partial-commit" ? "partial-commit" : "failed",
    exitCode,
    transactionId: undone.id,
    state: undone.state,
    undoPreview,
  };
  emitResult(io, command.json, result, undone.state === "undone" ? `Transaction ${undone.id} undone.\n` : undefined);
  return exitCode;
}

function failureDetails(error: unknown): { exitCode: number; outcome: CliOutcome; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderExecutionError || error instanceof ProcessSpawnError) {
    return { exitCode: 2, outcome: "provider-failure", message };
  }
  if (error instanceof GitScopeError && error.dependencyFailure) {
    return { exitCode: 2, outcome: "provider-failure", message };
  }
  return { exitCode: 1, outcome: "invalid", message };
}

export async function main(
  argv: readonly string[],
  io: CliIo = defaultIo,
  runtime: CliRuntime = {},
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout(HELP);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    io.stdout(`tfs-ripast ${VERSION}\n`);
    return 0;
  }
  const kind = commandName(argv);
  const parseState: ArgumentParseState = { json: false };
  const cwd = resolve(io.cwd ?? process.cwd());
  try {
    const command = parseArguments(argv, parseState);
    if (command.kind === "verify") {
      return await runVerify(command, io, cwd, runtime);
    }
    if (command.kind === "undo") {
      return await runUndo(command, io, cwd, runtime);
    }
    if (command.kind === "rewrite") {
      const resolved = await resolveEditPlan(adHocPlan(command, cwd), cwd, runtime, command);
      return await runEditPlan(
        "rewrite",
        planningResult(resolved.editPlan, resolved.snapshots, resolved.correlation, resolved.repositoryFiles),
        command,
        io,
        runtime,
      );
    }
    if (command.kind === "plan") {
      const loaded = applyCliPlanOptions(
        parseRewritePlan(await protocolJson(command.source, io, cwd)),
        command,
      );
      const resolved = await resolveEditPlan(loaded, cwd, runtime, command);
      return await runEditPlan(
        "plan",
        planningResult(resolved.editPlan, resolved.snapshots, resolved.correlation, resolved.repositoryFiles),
        command,
        io,
        runtime,
      );
    }
    const editPlan = await loadEditPlan(command.source, io, cwd);
    const artifactExclusions = await savedArtifactExclusions(
      command.source,
      cwd,
      editPlan.rewritePlan.root,
    );
    if (command.kind === "apply") {
      const derived = await resolveEditPlan(
        editPlan.rewritePlan,
        cwd,
        runtime,
        command,
        artifactExclusions,
        editPlan.gitScope,
      );
      assertSavedPlanMatchesDerivation(editPlan, derived.editPlan);
      return await runEditPlan(
        command.kind,
        planningResult(derived.editPlan, derived.snapshots, derived.correlation, derived.repositoryFiles),
        command,
        io,
        runtime,
      );
    }
    const snapshots = await snapshotsForSavedPlan(editPlan);
    const repositoryFiles = await enumerateRepositoryFiles(
      editPlan.rewritePlan,
      runtime,
      editPlan.evidence.map((evidence) => evidence.file),
      artifactExclusions,
    );
    const planning = planningResult(
      editPlan,
      snapshots,
      correlationForSavedPlan(editPlan),
      repositoryFiles.length,
    );
    return await runEditPlan(command.kind, planning, command, io, runtime);
  } catch (error) {
    const failure = failureDetails(error);
    io.stderr(`${failure.message}\n`);
    if (parseState.json) {
      emitResult(io, true, {
        version: 1,
        command: kind,
        outcome: failure.outcome,
        exitCode: failure.exitCode,
      });
    }
    return failure.exitCode;
  }
}

function isDirectExecution(argvPath: string | undefined): boolean {
  if (argvPath === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectExecution(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
