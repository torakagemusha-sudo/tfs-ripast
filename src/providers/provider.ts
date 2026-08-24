import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import type {
  AstGrepLanguage,
  LanguageDecision,
  MatchEvidence,
  ProviderName,
  RewriteOperation,
} from "../types.js";
import { runArgumentVector } from "./process.js";

export interface ProviderRequest {
  root: string;
  operation: RewriteOperation;
  languageDecisions: Readonly<Record<string, LanguageDecision>>;
  respectGitIgnore?: boolean;
  /** Runtime-only exact repository paths that must not enter provider discovery. */
  excludedPaths?: readonly string[];
  /** Runtime-only immutable candidates used to contain a broader operation scan. */
  candidatePaths?: readonly string[];
}

export interface ProviderResult {
  provider: ProviderName;
  operationId: string;
  version: string;
  evidence: MatchEvidence[];
  diagnostics: ProviderDiagnostic[];
  elapsedMs: number;
}

export interface ProviderDiagnostic {
  code: string;
  message: string;
  operationId: string;
  language?: AstGrepLanguage;
  paths: string[];
}

export interface MatchProvider {
  scan(request: ProviderRequest): Promise<ProviderResult>;
}

export interface ProviderOptions {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderRuntimeOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  env: NodeJS.ProcessEnv;
}

export interface OperationScope {
  request: ProviderRequest;
  root: string;
  realRoot: string;
  operationPaths: string[];
  fileOperands: ReadonlyArray<{ path: string; identityPath: string }>;
  gitRepository: boolean;
  runtime: ProviderRuntimeOptions;
}

export class ProviderExecutionError extends Error {
  readonly code: string;
  readonly operationId: string;
  readonly language?: AstGrepLanguage;
  readonly paths: string[];

  constructor(
    message: string,
    details: {
      code: string;
      operationId: string;
      language?: AstGrepLanguage;
      paths: readonly string[];
      cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ProviderExecutionError";
    this.code = details.code;
    this.operationId = details.operationId;
    if (details.language !== undefined) {
      this.language = details.language;
    }
    this.paths = [...details.paths];
  }
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function evidenceId(
  provider: ProviderName,
  operationId: string,
  file: string,
  byteRange: readonly [number, number],
  matchedTextHash: string,
): string {
  const identity = JSON.stringify([
    provider,
    operationId,
    file,
    byteRange[0],
    byteRange[1],
    matchedTextHash,
  ]);
  return `evidence:${createHash("sha256").update(identity).digest("hex")}`;
}

export function repositoryRelativePath(
  root: string,
  reportedPath: string,
  operationId = "unknown",
): string {
  const absoluteRoot = resolve(root);
  const absolutePath = isAbsolute(reportedPath)
    ? resolve(reportedPath)
    : resolve(absoluteRoot, reportedPath);
  const repositoryPath = relative(absoluteRoot, absolutePath);
  if (
    repositoryPath === "" ||
    repositoryPath === ".." ||
    repositoryPath.startsWith(`..${sep}`) ||
    isAbsolute(repositoryPath)
  ) {
    throw new ProviderExecutionError(`Provider reported a path outside the repository: ${reportedPath}`, {
      code: "provider-path-outside-repository",
      operationId,
      paths: [reportedPath],
    });
  }
  return repositoryPath.split(sep).join("/");
}

function operationRelativePath(root: string, reportedPath: string, operationId: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = isAbsolute(reportedPath)
    ? resolve(reportedPath)
    : resolve(absoluteRoot, reportedPath);
  const repositoryPath = relative(absoluteRoot, absolutePath);
  if (
    repositoryPath === ".." ||
    repositoryPath.startsWith(`..${sep}`) ||
    isAbsolute(repositoryPath)
  ) {
    throw new ProviderExecutionError(`Operation path is outside the repository: ${reportedPath}`, {
      code: "provider-operation-path-outside-repository",
      operationId,
      paths: [reportedPath],
    });
  }
  return repositoryPath === "" ? "." : repositoryPath.split(sep).join("/");
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function realIdentity(path: string): Promise<string> {
  const suffix: string[] = [];
  let candidate = path;
  for (;;) {
    try {
      return resolve(await realpath(candidate), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

async function assertIdentityContained(
  root: string,
  realRoot: string,
  repositoryPath: string,
  operationId: string,
): Promise<string> {
  try {
    const absolutePath = resolve(root, repositoryPath);
    const identity = await realIdentity(absolutePath);
    if (!isContained(realRoot, identity)) {
      throw new ProviderExecutionError(`Path resolves outside the repository: ${repositoryPath}`, {
        code: "provider-path-identity-outside-repository",
        operationId,
        paths: [repositoryPath],
      });
    }
    const identityPath = relative(realRoot, identity);
    return identityPath === "" ? "." : identityPath.split(sep).join("/");
  } catch (error) {
    if (error instanceof ProviderExecutionError) {
      throw error;
    }
    throw new ProviderExecutionError(`Could not resolve path identity: ${repositoryPath}`, {
      code: "provider-path-identity-failure",
      operationId,
      paths: [repositoryPath],
      cause: error,
    });
  }
}

export function isReservedProviderPath(path: string): boolean {
  const first = path === "." ? "" : path.split("/", 1)[0];
  return first === ".git" || first === ".tfs-ripast";
}

async function gitCommand(
  scope: Pick<OperationScope, "root" | "runtime">,
  args: readonly string[],
): Promise<ReturnType<typeof runArgumentVector> extends Promise<infer Result> ? Result : never> {
  return runArgumentVector("git", ["-C", scope.root, ...args], {
    cwd: scope.root,
    timeoutMs: scope.runtime.timeoutMs,
    maxOutputBytes: Math.min(scope.runtime.maxOutputBytes, 64 * 1024),
    env: scope.runtime.env,
  });
}

async function isGitRepository(
  root: string,
  runtime: ProviderRuntimeOptions,
  operationId: string,
): Promise<boolean> {
  let result;
  try {
    result = await gitCommand(
      { root, runtime },
      ["rev-parse", "--is-inside-work-tree"],
    );
  } catch (error) {
    throw new ProviderExecutionError("Could not inspect Git repository state.", {
      code: "provider-git-detection-failure",
      operationId,
      paths: ["."],
      cause: error,
    });
  }
  if (result.invalidUtf8) {
    throw new ProviderExecutionError("Git repository detection returned invalid UTF-8.", {
      code: "provider-git-detection-invalid-utf8",
      operationId,
      paths: ["."],
    });
  }
  if (result.timedOut || result.truncated) {
    throw new ProviderExecutionError("Git repository detection exceeded its execution bounds.", {
      code: "provider-git-detection-bounds",
      operationId,
      paths: ["."],
    });
  }
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function isGitIgnored(scope: OperationScope, path: string): Promise<boolean> {
  if (scope.request.respectGitIgnore === false || !scope.gitRepository || path === ".") {
    return false;
  }
  let result;
  try {
    result = await gitCommand(scope, ["check-ignore", "-q", "--", path]);
  } catch (error) {
    throw new ProviderExecutionError(`Could not check Git ignore status: ${path}`, {
      code: "provider-git-ignore-failure",
      operationId: scope.request.operation.id,
      paths: [path],
      cause: error,
    });
  }
  if (result.invalidUtf8) {
    throw new ProviderExecutionError(`Git ignore check returned invalid UTF-8: ${path}`, {
      code: "provider-git-ignore-invalid-utf8",
      operationId: scope.request.operation.id,
      paths: [path],
    });
  }
  if (result.timedOut || result.truncated) {
    throw new ProviderExecutionError(`Git ignore check exceeded its execution bounds: ${path}`, {
      code: "provider-git-ignore-bounds",
      operationId: scope.request.operation.id,
      paths: [path],
    });
  }
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  throw new ProviderExecutionError(
    `Git ignore check failed for ${path} with exit code ${String(result.exitCode)}${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`,
    {
      code: "provider-git-ignore-exit",
      operationId: scope.request.operation.id,
      paths: [path],
    },
  );
}

export async function prepareOperationScope(
  request: ProviderRequest,
  runtime: ProviderRuntimeOptions,
): Promise<OperationScope> {
  const root = resolve(request.root);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    throw new ProviderExecutionError("Could not resolve the repository root identity.", {
      code: "provider-root-identity-failure",
      operationId: request.operation.id,
      paths: ["."],
      cause: error,
    });
  }
  const operationPaths: string[] = [];
  const operationIdentities: Array<{ path: string; identityPath: string }> = [];
  const fileOperands: Array<{ path: string; identityPath: string }> = [];
  const partialScope: OperationScope = {
    request,
    root,
    realRoot,
    operationPaths,
    fileOperands,
    gitRepository: await isGitRepository(root, runtime, request.operation.id),
    runtime,
  };

  for (const reportedPath of request.operation.paths) {
    const path = operationRelativePath(root, reportedPath, request.operation.id);
    if (isReservedProviderPath(path)) {
      throw new ProviderExecutionError(`Operation path uses a reserved provider path: ${path}`, {
        code: "provider-reserved-operation-path",
        operationId: request.operation.id,
        paths: [path],
      });
    }
    const identityPath = await assertIdentityContained(root, realRoot, path, request.operation.id);
    if (isReservedProviderPath(identityPath)) {
      throw new ProviderExecutionError(`Operation path resolves into a reserved provider path: ${path}`, {
        code: "provider-reserved-operation-identity",
        operationId: request.operation.id,
        paths: [path, identityPath],
      });
    }
    if (await isGitIgnored(partialScope, path)) {
      throw new ProviderExecutionError(`Operation path is Git-ignored: ${path}`, {
        code: "provider-git-ignored-operation-path",
        operationId: request.operation.id,
        paths: [path],
      });
    }
    if (identityPath !== path && await isGitIgnored(partialScope, identityPath)) {
      throw new ProviderExecutionError(`Operation path target is Git-ignored: ${path}`, {
        code: "provider-git-ignored-operation-identity",
        operationId: request.operation.id,
        paths: [path, identityPath],
      });
    }
    operationPaths.push(path);
    operationIdentities.push({ path, identityPath });
    try {
      if ((await stat(resolve(root, path))).isFile()) {
        fileOperands.push({ path, identityPath });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProviderExecutionError(`Could not inspect operation path: ${path}`, {
          code: "provider-operation-stat-failure",
          operationId: request.operation.id,
          paths: [path, identityPath],
          cause: error,
        });
      }
    }
  }
  for (const operand of operationIdentities) {
    if (
      operand.identityPath !== operand.path &&
      !operationPaths.some(
        (path) =>
          path === "." ||
          operand.identityPath === path ||
          operand.identityPath.startsWith(`${path}/`),
      )
    ) {
      throw new ProviderExecutionError(
        `Operation path target is outside operation paths: ${operand.path}`,
        {
          code: "provider-operation-identity-outside-paths",
          operationId: request.operation.id,
          paths: [operand.path, operand.identityPath],
        },
      );
    }
  }
  return partialScope;
}

export function isWithinOperationPaths(scope: OperationScope, path: string): boolean {
  return scope.operationPaths.some(
    (operand) => operand === "." || path === operand || path.startsWith(`${operand}/`),
  );
}

export async function validateCandidateIdentity(
  scope: OperationScope,
  reportedPath: string,
): Promise<{
  path: string;
  identityPath: string;
  reserved: boolean;
  reservedIdentity: boolean;
  ignored: boolean;
  ignoredIdentity: boolean;
}> {
  const operationId = scope.request.operation.id;
  const path = repositoryRelativePath(scope.root, reportedPath, operationId);
  const identityPath = await assertIdentityContained(scope.root, scope.realRoot, path, operationId);
  return {
    path,
    identityPath,
    reserved: isReservedProviderPath(path),
    reservedIdentity: isReservedProviderPath(identityPath),
    ignored: await isGitIgnored(scope, path),
    ignoredIdentity: identityPath === path ? false : await isGitIgnored(scope, identityPath),
  };
}

export function sortEvidence(evidence: MatchEvidence[]): MatchEvidence[] {
  return evidence.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.byteRange[0] - right.byteRange[0] ||
      left.byteRange[1] - right.byteRange[1] ||
      left.id.localeCompare(right.id),
  );
}

/** Applies the documented Node 24 path.matchesGlob dialect with ordered include/exclude rules. */
export function matchesOperationGlobs(path: string, globs: readonly string[]): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  let included = !globs.some((glob) => !glob.startsWith("!"));
  for (const glob of globs) {
    const excluded = glob.startsWith("!");
    const pattern = excluded ? glob.slice(1) : glob;
    if (pattern === "") {
      continue;
    }
    const matches =
      matchesGlob(normalizedPath, pattern) ||
      (!pattern.includes("/") && matchesGlob(basename(normalizedPath), pattern));
    if (matches) {
      included = !excluded;
    }
  }
  return included;
}
