import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { detectLanguage } from "./languages.js";
import { compareStrings } from "./order.js";
import { maximumProcessArgumentBytes, maximumProcessPathBytes, runArgumentVector } from "./providers/process.js";
import { inspectPreparedSyntax } from "./syntaxInspect.js";
import type {
  AstGrepLanguage,
  TrustedValidationCommand,
  ValidationAdapter,
  ValidationResult,
  ValidationSpec,
} from "./types.js";

export type ValidationStage = "precommit" | "postcommit";

export interface ValidationContext {
  root: string;
  stage: ValidationStage;
  changedPaths: readonly string[];
  executables?: Partial<Record<ValidationSpec["type"], string>>;
  env?: NodeJS.ProcessEnv;
  keepOnCheckFailure?: boolean;
}

interface InvocationAudit {
  executable: string;
  argv: string[];
  cwd: string;
  executionCwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  stage: ValidationStage;
  rollbackPolicy: "not-applicable" | "rollback-on-failure" | "keep-on-failure";
  targetPath?: string;
  configResolution?: string;
}

export type ValidationInvocation =
  | (InvocationAudit & {
      source: "named-adapter";
      adapter: ValidationAdapter;
    })
  | (InvocationAudit & {
      source: "explicit-command";
    });

const defaultTimeoutMs = 120_000;
const defaultMaxOutputBytes = 1024 * 1024;
export const maximumValidationExecutableBytes = maximumProcessPathBytes;
export const maximumValidationArgumentBytes = 16 * 1024;
export const maximumValidationArgumentCount = 256;
export const maximumValidationOutputBytes = defaultMaxOutputBytes;
export const maximumValidationConfigBytes = 16 * 1024;
const shellExecutables = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
const commandStringArguments = new Set(["-c", "/c", "-command", "--command"]);
const combinedCommandFlag = /^-[a-z]*c[a-z]*$/iu;
const wrapperLaunchers = new Set([
  "env",
  "env.exe",
  "nohup",
  "nice",
  "setsid",
  "start",
  "start.exe",
]);

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function normalizeRepositoryPath(path: string, allowRoot = true): string {
  assertTextBytes(path, maximumProcessPathBytes, "Validation path");
  if (
    path.trim().length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f]/u.test(path) ||
    path.split("/").includes("..")
  ) {
    throw new Error(`Validation path must be a contained repository-relative POSIX path: ${path}`);
  }
  const normalized = path.replace(/^\.\//u, "").replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || ".";
  if (!allowRoot && normalized === ".") {
    throw new Error("Validation file path cannot name the repository root.");
  }
  const top = normalized.split("/", 1)[0];
  if (top === ".git" || top === ".tfs-ripast") {
    throw new Error(`Validation path uses reserved repository state: ${normalized}`);
  }
  return normalized;
}

function assertTextBytes(value: string, maximum: number, label: string): void {
  const bytes = Buffer.byteLength(value);
  if (bytes > maximum) {
    throw new Error(`${label} requires ${String(bytes)} bytes, exceeding the ${String(maximum)} bytes limit.`);
  }
}

function boundedText(value: unknown, maximum: number): { value: string; truncated: boolean } {
  const source = value instanceof Error ? value.message : String(value);
  const bytes = Buffer.from(source, "utf8");
  if (bytes.byteLength <= maximum) {
    return { value: source, truncated: false };
  }
  let end = maximum;
  while (end > 0) {
    const prefix = bytes.subarray(0, end);
    const decoded = prefix.toString("utf8");
    if (Buffer.from(decoded, "utf8").equals(prefix)) {
      return { value: decoded, truncated: true };
    }
    end -= 1;
  }
  return { value: "", truncated: true };
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return selected;
}

function assertTrustedCommand(command: TrustedValidationCommand): void {
  assertTextBytes(command.executable, maximumValidationExecutableBytes, "Explicit validation executable");
  if (command.executable.trim().length === 0 || /[\u0000\r\n]/u.test(command.executable)) {
    throw new Error("Explicit validation executable is blank or contains control characters.");
  }
  if (!isAbsolute(command.executable)) {
    throw new Error("Explicit validation authority requires an absolute executable path; PATH names and relative paths are rejected.");
  }
  const executableName = basename(command.executable).toLowerCase();
  if (shellExecutables.has(executableName)) {
    throw new Error(`Explicit validation authority rejects shell executable ${executableName}.`);
  }
  if (command.args.length === 0) {
    throw new Error("Explicit validation authority requires a non-empty argument vector.");
  }
  if (command.args.length > maximumValidationArgumentCount) {
    throw new Error(`Explicit validation argument count exceeds the ${String(maximumValidationArgumentCount)} item limit.`);
  }
  let argumentVectorBytes = Buffer.byteLength(command.executable) + 1;
  for (const argument of command.args) {
    assertTextBytes(argument, maximumValidationArgumentBytes, "Explicit validation argument");
    argumentVectorBytes += Buffer.byteLength(argument) + 1;
    if (argument.includes("\0")) {
      throw new Error("Explicit validation arguments cannot contain NUL bytes.");
    }
    if (commandStringArguments.has(argument.toLowerCase()) || combinedCommandFlag.test(argument)) {
      throw new Error(`Explicit validation authority rejects command-string expansion argument ${argument}.`);
    }
  }
  if (argumentVectorBytes > maximumProcessArgumentBytes) {
    throw new Error(`Explicit validation argument vector requires ${String(argumentVectorBytes)} bytes, exceeding the ${String(maximumProcessArgumentBytes)} bytes limit.`);
  }
}

async function assertExecutableIdentity(executable: string): Promise<string> {
  let identity: string;
  try {
    await access(executable, constants.X_OK);
    identity = await realpath(executable);
  } catch {
    throw new Error(`Explicit validation executable identity is unavailable or not executable: ${executable}.`);
  }
  assertTextBytes(identity, maximumValidationExecutableBytes, "Explicit validation executable identity");
  const identityName = basename(identity).toLowerCase();
  if (shellExecutables.has(identityName)) {
    throw new Error(`Explicit validation authority rejects shell executable identity ${identityName}.`);
  }
  if (wrapperLaunchers.has(identityName)) {
    throw new Error(`Explicit validation authority rejects wrapper launcher ${identityName}.`);
  }
  try {
    const handle = await open(identity, "r");
    const bytes = Buffer.alloc(4_096);
    let prefix: string;
    try {
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
      prefix = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    if (prefix.startsWith("#!")) {
      throw new Error(`Explicit validation authority rejects shebang wrapper launcher ${identity}.`);
    }
  } catch (error) {
    if (error instanceof Error && /authority rejects/u.test(error.message)) {
      throw error;
    }
    throw new Error(`Explicit validation executable identity cannot be inspected: ${identity}.`);
  }
  return identity;
}

async function assertTrustedExecutableIdentity(
  command: TrustedValidationCommand,
): Promise<string> {
  return assertExecutableIdentity(command.executable);
}

function stageFor(spec: ValidationSpec | TrustedValidationCommand): ValidationStage {
  return "type" in spec && spec.type === "prettier" ? "precommit" : "postcommit";
}

async function containedCwd(root: string, path: string): Promise<{ logical: string; absolute: string }> {
  const logical = normalizeRepositoryPath(path);
  const candidate = resolve(root, logical);
  const canonical = await realpath(candidate);
  assertTextBytes(canonical, maximumProcessPathBytes, "Validation actual cwd");
  if (!isContained(root, canonical) || canonical !== candidate) {
    throw new Error(`Validation cwd escapes repository containment or uses a symlink: ${path}`);
  }
  return { logical, absolute: canonical };
}

function namedExecutable(
  type: ValidationSpec["type"],
  overrides: ValidationContext["executables"],
): string {
  const overridden = overrides?.[type];
  const executable = overridden ?? (type === "prettier" ? "prettier" : "npm");
  assertTextBytes(executable, maximumValidationExecutableBytes, "Named validation executable");
  return executable;
}

function validationOutputBound(value: number | undefined): number {
  const selected = positiveBound(value, defaultMaxOutputBytes, "validation maxOutputBytes");
  if (selected > maximumValidationOutputBytes) {
    throw new Error(`validation maxOutputBytes exceeds the ${String(maximumValidationOutputBytes)} bytes limit.`);
  }
  return selected;
}

function rollbackPolicy(context: ValidationContext): ValidationInvocation["rollbackPolicy"] {
  if (context.stage === "precommit") {
    return "not-applicable";
  }
  return context.keepOnCheckFailure ? "keep-on-failure" : "rollback-on-failure";
}

async function namedInvocation(
  spec: ValidationSpec,
  context: ValidationContext,
  root: string,
): Promise<ValidationInvocation[]> {
  if (stageFor(spec) !== context.stage) {
    return [];
  }
  const cwd = await containedCwd(root, spec.cwd ?? ".");
  let argv: string[];
  if (spec.type === "prettier") {
    const requested = spec.paths ?? [...context.changedPaths];
    const paths = [...new Set(requested.map((path) => normalizeRepositoryPath(path, false)))]
      .sort(compareStrings);
    if (paths.length === 0) {
      return [];
    }
    const relativePaths = paths.map((path) => {
      const absolute = resolve(root, path);
      if (!isContained(root, absolute)) {
        throw new Error(`Prettier path escapes repository containment: ${path}`);
      }
      const fromCwd = relative(cwd.absolute, absolute);
      if (fromCwd === "" || isAbsolute(fromCwd) || fromCwd === ".." || fromCwd.startsWith(`..${sep}`)) {
        throw new Error(`Prettier path ${path} is outside validation cwd ${cwd.logical}.`);
      }
      return fromCwd.split(sep).join("/");
    });
    return relativePaths.map((path, index) => ({
      source: "named-adapter" as const,
      adapter: spec.type,
      executable: namedExecutable(spec.type, context.executables),
      argv: ["--stdin-filepath", resolve(root, paths[index]!)],
      cwd: cwd.logical,
      executionCwd: cwd.absolute,
      timeoutMs: positiveBound(spec.timeoutMs, defaultTimeoutMs, "validation timeoutMs"),
      maxOutputBytes: validationOutputBound(spec.maxOutputBytes),
      stage: context.stage,
      rollbackPolicy: rollbackPolicy(context),
      targetPath: paths[index]!,
      configResolution: `repository policy/plugins resolved from original cwd ${cwd.absolute} using original --stdin-filepath ${resolve(root, paths[index]!)}`,
    }));
  } else if (spec.type === "npm-test") {
    argv = ["test"];
  } else {
    argv = ["run", "typecheck", "--"];
  }
  return [{
    source: "named-adapter",
    adapter: spec.type,
    executable: namedExecutable(spec.type, context.executables),
    argv,
    cwd: cwd.logical,
    executionCwd: cwd.absolute,
    timeoutMs: positiveBound(spec.timeoutMs, defaultTimeoutMs, "validation timeoutMs"),
    maxOutputBytes: validationOutputBound(spec.maxOutputBytes),
    stage: context.stage,
    rollbackPolicy: rollbackPolicy(context),
  }];
}

async function explicitInvocation(
  command: TrustedValidationCommand,
  context: ValidationContext,
  root: string,
): Promise<ValidationInvocation[]> {
  if (stageFor(command) !== context.stage) {
    return [];
  }
  const cwd = await containedCwd(root, command.cwd);
  assertTrustedCommand(command);
  const executable = await assertTrustedExecutableIdentity(command);
  return [{
    source: "explicit-command",
    executable,
    argv: [...command.args],
    cwd: cwd.logical,
    executionCwd: cwd.absolute,
    timeoutMs: positiveBound(command.timeoutMs, defaultTimeoutMs, "validation timeoutMs"),
    maxOutputBytes: validationOutputBound(command.maxOutputBytes),
    stage: context.stage,
    rollbackPolicy: rollbackPolicy(context),
  }];
}

/** Resolves exact executable/argv/cwd policy without starting a subprocess. */
export async function resolveValidationInvocations(
  specs: readonly (ValidationSpec | TrustedValidationCommand)[],
  context: ValidationContext,
): Promise<ValidationInvocation[]> {
  const root = await realpath(resolve(context.root));
  const invocations: ValidationInvocation[] = [];
  for (const spec of specs) {
    const resolved = "type" in spec
      ? await namedInvocation(spec, context, root)
      : await explicitInvocation(spec, context, root);
    invocations.push(...resolved);
  }
  return invocations;
}

function resultFor(
  invocation: ValidationInvocation,
  result: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    truncated: boolean;
    stdinError?: boolean;
    invalidUtf8?: boolean;
  },
): ValidationResult {
  const output = boundedText(
    `${result.invalidUtf8 ? "Process output was invalid UTF-8.\n" : ""}${result.stdout}${result.stderr}`,
    invocation.maxOutputBytes,
  );
  const status: ValidationResult["status"] = result.timedOut
    ? "timed-out"
    : result.exitCode === 0 && !result.truncated && !result.stdinError && !result.invalidUtf8 ? "passed" : "failed";
  const common = {
    executable: invocation.executable,
    argv: invocation.argv,
    cwd: invocation.cwd,
    actualCwd: invocation.executionCwd,
    timeoutMs: invocation.timeoutMs,
    stage: invocation.stage,
    rollbackPolicy: invocation.rollbackPolicy,
    ...(invocation.configResolution === undefined ? {} : { configResolution: invocation.configResolution }),
    timedOut: result.timedOut,
    truncated: result.truncated || output.truncated,
    status,
    exitCode: result.exitCode,
    output: output.value,
  };
  return invocation.source === "named-adapter"
    ? { source: "named-adapter", adapter: invocation.adapter, ...common }
    : { source: "explicit-command", ...common };
}

/** Runs only the validations assigned to the requested lifecycle stage. */
export async function runValidations(
  specs: readonly (ValidationSpec | TrustedValidationCommand)[],
  context: ValidationContext,
): Promise<ValidationResult[]> {
  const invocations = await resolveValidationInvocations(specs, context);
  const results: ValidationResult[] = [];
  for (const invocation of invocations) {
    try {
      const result = await runArgumentVector(invocation.executable, invocation.argv, {
        cwd: invocation.executionCwd,
        timeoutMs: invocation.timeoutMs,
        maxOutputBytes: invocation.maxOutputBytes,
        env: context.env ?? process.env,
      });
      results.push(resultFor(invocation, result));
    } catch (error) {
      const output = boundedText(error, invocation.maxOutputBytes);
      const common = {
        executable: invocation.executable,
        argv: invocation.argv,
        cwd: invocation.cwd,
        actualCwd: invocation.executionCwd,
        timeoutMs: invocation.timeoutMs,
        stage: invocation.stage,
        rollbackPolicy: invocation.rollbackPolicy,
        ...(invocation.configResolution === undefined ? {} : { configResolution: invocation.configResolution }),
        timedOut: false,
        truncated: output.truncated,
        status: "spawn-error" as const,
        exitCode: null,
        output: output.value,
      };
      results.push(invocation.source === "named-adapter"
        ? { source: "named-adapter", adapter: invocation.adapter, ...common }
        : { source: "explicit-command", ...common });
    }
  }
  return results;
}

export function validationsPassed(results: readonly ValidationResult[]): boolean {
  return results.every((result) => result.status === "passed" || result.status === "unsupported");
}

export interface PreparedValidationInput {
  path: string;
  content: Uint8Array;
  mode: number;
  language?: AstGrepLanguage;
}

export interface PreparedValidationOutcome {
  results: ValidationResult[];
  outputs: Record<string, Uint8Array>;
  invocations: ValidationInvocation[];
}

/** Runs formatter adapters against disposable prepared bytes, never against source files. */
export async function runPreparedValidations(
  specs: readonly ValidationSpec[],
  inputs: readonly PreparedValidationInput[],
  context: Omit<ValidationContext, "stage" | "changedPaths"> & { astGrepExecutable?: string },
): Promise<PreparedValidationOutcome> {
  if (inputs.length === 0) {
    return { results: [], outputs: {}, invocations: [] };
  }
  const root = await realpath(resolve(context.root));
  const current = new Map(inputs.map((input) => [
    normalizeRepositoryPath(input.path, false),
    Uint8Array.from(input.content),
  ]));
  const formatterInvocations = await resolveValidationInvocations(specs, {
    ...context,
    root,
    stage: "precommit",
    changedPaths: inputs.map((input) => input.path),
  });
  const results: ValidationResult[] = [];
  const invocations: ValidationInvocation[] = [...formatterInvocations];
  for (const invocation of formatterInvocations) {
    const targetPath = invocation.targetPath;
    const content = targetPath === undefined ? undefined : current.get(targetPath);
    if (content === undefined) {
      throw new Error(`Prepared formatter invocation has no authoritative input: ${targetPath ?? "unknown"}.`);
    }
    const authoritativePath = targetPath!;
    try {
      const processResult = await runArgumentVector(invocation.executable, invocation.argv, {
        cwd: invocation.executionCwd,
        timeoutMs: invocation.timeoutMs,
        maxOutputBytes: invocation.maxOutputBytes,
        env: context.env ?? process.env,
        input: content,
      });
      const audit = resultFor(invocation, { ...processResult, stdout: "", stderr: processResult.stderr });
      results.push(audit);
      if (audit.status === "passed") {
        current.set(authoritativePath, Uint8Array.from(Buffer.from(processResult.stdout, "utf8")));
      }
    } catch (error) {
      const output = boundedText(error, invocation.maxOutputBytes);
      results.push({
        source: "named-adapter",
        adapter: invocation.source === "named-adapter" ? invocation.adapter : "prettier",
        executable: invocation.executable,
        argv: invocation.argv,
        cwd: invocation.cwd,
        actualCwd: invocation.executionCwd,
        timeoutMs: invocation.timeoutMs,
        stage: "precommit",
        rollbackPolicy: "not-applicable",
        ...(invocation.configResolution === undefined ? {} : { configResolution: invocation.configResolution }),
        timedOut: false,
        truncated: output.truncated,
        status: "spawn-error",
        exitCode: null,
        output: output.value,
      });
    }
  }

  for (const input of inputs) {
    const path = normalizeRepositoryPath(input.path, false);
    const language = input.language ?? detectLanguage(path, []).language;
    const executable = "@ast-grep/napi@0.45.1";
    if (language === undefined) {
      const unsupported: ValidationInvocation = {
        source: "named-adapter",
        adapter: "ast-grep-syntax",
        executable,
        argv: [],
        cwd: ".",
        executionCwd: root,
        timeoutMs: defaultTimeoutMs,
        maxOutputBytes: defaultMaxOutputBytes,
        stage: "precommit",
        rollbackPolicy: "not-applicable",
        targetPath: path,
        configResolution: "language detection from the original repository path",
      };
      invocations.push(unsupported);
      results.push({
        source: "named-adapter",
        adapter: "ast-grep-syntax",
        executable,
        argv: [],
        cwd: ".",
        actualCwd: root,
        timeoutMs: defaultTimeoutMs,
        stage: "precommit",
        rollbackPolicy: "not-applicable",
        configResolution: "language detection from the original repository path",
        timedOut: false,
        truncated: false,
        status: "unsupported",
        exitCode: null,
        output: `Unsupported syntax-validation language for ${path}; no structural parser is registered.`,
      });
      continue;
    }
    const syntaxInvocation: ValidationInvocation = {
      source: "named-adapter",
      adapter: "ast-grep-syntax",
      executable,
      argv: ["parse", "--lang", language],
      cwd: ".",
      executionCwd: root,
      timeoutMs: defaultTimeoutMs,
      maxOutputBytes: defaultMaxOutputBytes,
      stage: "precommit",
      rollbackPolicy: "not-applicable",
      targetPath: path,
      configResolution: `@ast-grep/napi 0.45.1 ${language} parser inspection over prepared bytes for ${path}`,
    };
    invocations.push(syntaxInvocation);
    try {
      const inspection = inspectPreparedSyntax(language, current.get(path)!);
      const failures = [
        inspection.hasError ? `found ${String(inspection.errorNodeCount)} ERROR node(s)` : undefined,
        inspection.hasMissingDescendant ? "found a missing descendant node" : undefined,
        inspection.hasJsFamilyDiagnostic
          ? `found ${String(inspection.jsFamilyDiagnosticCount)} JavaScript/TypeScript parser diagnostic(s)`
          : undefined,
      ].filter((reason): reason is string => reason !== undefined);
      const output = failures.length === 0 ? "" : `Prepared syntax validation failed for ${path}: ${failures.join("; ")}.`;
      results.push({
        source: "named-adapter",
        adapter: "ast-grep-syntax",
        executable,
        argv: syntaxInvocation.argv,
        cwd: ".",
        actualCwd: root,
        timeoutMs: syntaxInvocation.timeoutMs,
        stage: "precommit",
        rollbackPolicy: "not-applicable",
        configResolution: syntaxInvocation.configResolution!,
        timedOut: false,
        truncated: false,
        status: failures.length === 0 ? "passed" : "failed",
        exitCode: failures.length === 0 ? 0 : 1,
        output,
      });
    } catch (error) {
      const detail = boundedText(error, syntaxInvocation.maxOutputBytes);
      const output = boundedText(
        `Prepared syntax validation could not inspect ${path}: ${detail.value}`,
        syntaxInvocation.maxOutputBytes,
      );
      results.push({
        source: "named-adapter",
        adapter: "ast-grep-syntax",
        executable,
        argv: syntaxInvocation.argv,
        cwd: ".",
        actualCwd: root,
        timeoutMs: syntaxInvocation.timeoutMs,
        stage: "precommit",
        rollbackPolicy: "not-applicable",
        configResolution: syntaxInvocation.configResolution!,
        timedOut: false,
        truncated: detail.truncated || output.truncated,
        status: "failed",
        exitCode: null,
        output: output.value,
      });
    }
  }
  const outputs = Object.fromEntries([...current].map(([path, content]) => [path, Uint8Array.from(content)]));
  return { results, outputs, invocations };
}
