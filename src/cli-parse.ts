import { resolve } from "node:path";
import { normalizeRepositoryPath } from "./evidence.js";
import { parseRewritePlan } from "./schema.js";
import type { TransactionFileSystem } from "./transaction.js";
import type {
  AstGrepLanguage,
  RewritePlan,
  TrustedValidationCommand,
  ValidationSpec,
} from "./types.js";

export const maximumProtocolBytes = 8 * 1024 * 1024;

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

export async function stdinText(): Promise<string> {
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

export interface CommonOptions {
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

export interface RewriteCommand extends CommonOptions {
  kind: "rewrite";
  search: string;
  replace: string;
  regex: boolean;
  languages: AstGrepLanguage[];
  globs: string[];
  paths: string[];
}

export interface PlanCommand extends CommonOptions {
  kind: "plan";
  source: string;
}

export interface InspectCommand {
  kind: "inspect";
  source: string;
  json: boolean;
}

export interface ApplyCommand extends CommonOptions {
  kind: "apply";
  source: string;
}

export interface VerifyCommand {
  kind: "verify";
  source: string;
  json: boolean;
}

export interface UndoCommand extends CommonOptions {
  kind: "undo";
  source: string;
}

export interface RepairCommand extends CommonOptions {
  kind: "repair";
  source: string;
}

export interface GcCommand {
  kind: "gc";
  json: boolean;
  dryRun: boolean;
  write: boolean;
  includeUndoable: boolean;
  removeRecords: boolean;
  olderThanDays?: number;
}

export type ParsedCommand =
  | RewriteCommand
  | PlanCommand
  | InspectCommand
  | ApplyCommand
  | VerifyCommand
  | UndoCommand
  | RepairCommand
  | GcCommand;

export const HELP = `Usage: tfs-ripast [COMMAND] [OPTIONS]

Safe repository-scale search, rewrite planning, validation, and rollback.

Commands:
  tfs-ripast --search TEXT --replace TEXT [-- PATH ...]  Plan an ad-hoc rewrite
  tfs-ripast plan PLAN.json                       Resolve a rewrite plan
  tfs-ripast inspect EDIT-PLAN.json               Inspect a saved edit plan
  tfs-ripast apply EDIT-PLAN.json                 Revalidate and apply a saved plan
  tfs-ripast verify TRANSACTION.json              Verify committed file hashes
  tfs-ripast undo TRANSACTION.json                Preview or apply a safe rollback
  tfs-ripast repair TRANSACTION.json              Recover a partial-commit transaction
  tfs-ripast gc [--write]                         Prune dead transaction storage

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

export function commandName(argv: readonly string[]): ParsedCommand["kind"] {
  const first = argv[0];
  return first === "plan" || first === "inspect" || first === "apply" || first === "verify" ||
    first === "undo" || first === "repair" || first === "gc"
    ? first
    : "rewrite";
}

export interface ArgumentParseState {
  json: boolean;
}

export function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value === "--") {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

export function commonOptions(): CommonOptions {
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

export function validationAdapter(value: string): ValidationSpec["type"] {
  if (value === "prettier" || value === "npm-test" || value === "typescript-typecheck") {
    return value;
  }
  throw new Error(`Unknown validation adapter: ${value}.`);
}

export function explicitValidation(value: string): TrustedValidationCommand {
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

export function parseCommonOption(
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

export function isAdHocAuthorityOption(argument: string): boolean {
  return argument === "--write" || argument === "--plan-out" ||
    argument === "--check" || argument === "--validation-command" ||
    argument === "--keep-on-check-failure";
}

export function assertWriteMode(options: CommonOptions): void {
  if (options.dryRun && options.write) {
    throw new Error("--dry-run and --write are mutually exclusive.");
  }
  const scopes = Number(options.trackedOnly) + Number(options.changedOnly) + Number(options.staged) + Number(options.since !== undefined);
  if (scopes > 1) {
    throw new Error("--tracked-only, --changed-only, --staged, and --since are mutually exclusive.");
  }
}

export function hasRewriteExecutionOptions(options: CommonOptions): boolean {
  return options.trackedOnly || options.changedOnly || options.staged || options.since !== undefined ||
    options.requireClean || options.checks.length > 0 || options.explicitValidations.length > 0 ||
    options.keepOnCheckFailure;
}

export function parseSavedCommand(
  kind: PlanCommand["kind"] | InspectCommand["kind"] | ApplyCommand["kind"] | VerifyCommand["kind"] |
    UndoCommand["kind"] | RepairCommand["kind"],
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
  if ((kind === "apply" || kind === "undo" || kind === "repair") && common.planOut !== undefined) {
    throw new Error(`${kind} does not accept plan-output options.`);
  }
  if ((kind === "undo" || kind === "repair") && hasRewriteExecutionOptions(common)) {
    throw new Error(`${kind} does not accept rewrite scoping or validation options.`);
  }
  assertWriteMode(common);
  return { kind, source, ...common };
}

export function parseGcCommand(argv: readonly string[], state: ArgumentParseState): GcCommand {
  const command: GcCommand = {
    kind: "gc",
    json: false,
    dryRun: false,
    write: false,
    includeUndoable: false,
    removeRecords: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--json") {
      command.json = true;
      state.json = true;
      continue;
    }
    if (argument === "--dry-run") {
      command.dryRun = true;
      continue;
    }
    if (argument === "--write") {
      command.write = true;
      continue;
    }
    if (argument === "--include-undoable") {
      command.includeUndoable = true;
      continue;
    }
    if (argument === "--remove-records") {
      command.removeRecords = true;
      continue;
    }
    if (argument === "--older-than") {
      const value = requiredValue(argv, index, argument);
      const days = Number(value);
      if (!Number.isFinite(days) || days < 0) {
        throw new Error("--older-than requires a non-negative number of days.");
      }
      command.olderThanDays = days;
      index += 1;
      continue;
    }
    if (argument === "--") {
      throw new Error("gc does not accept positional arguments.");
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option for gc: ${argument}`);
    }
    throw new Error(`Unknown argument for gc: ${argument}`);
  }
  if (command.dryRun && command.write) {
    throw new Error("--dry-run and --write are mutually exclusive.");
  }
  return command;
}

export function parseArguments(argv: readonly string[], state: ArgumentParseState): ParsedCommand {
  const kind = commandName(argv);
  if (kind === "gc") {
    return parseGcCommand(argv, state);
  }
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

export function adHocPlan(command: RewriteCommand, cwd: string): RewritePlan {
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

export function canonicalRewritePlan(rewritePlan: RewritePlan, cwd: string): RewritePlan {
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

export function applyCliPlanOptions(rewritePlan: RewritePlan, options: CommonOptions): RewritePlan {
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
