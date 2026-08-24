import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { compareStrings } from "./order.js";
import { ProcessSpawnError, runArgumentVector, type ProcessResult } from "./providers/process.js";
import type { GitInputIdentity, GitScopeAudit } from "./types.js";

export interface GitScopeOptions {
  root: string;
  trackedOnly?: boolean;
  changedOnly?: boolean;
  staged?: boolean;
  since?: string;
  requireClean?: boolean;
  includeIgnored?: boolean;
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GitScope {
  repository: boolean;
  root: string;
  repositoryRoot?: string;
  head?: string;
  sinceCommit?: string;
  dirty: boolean;
  trackedFiles: string[];
  files: string[];
  mode: "all" | "tracked" | "changed" | "staged" | "since";
}

export class GitScopeError extends Error {
  readonly dependencyFailure: boolean;

  constructor(message: string, options: { cause?: unknown; dependencyFailure?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitScopeError";
    this.dependencyFailure = options.dependencyFailure ?? false;
  }
}

interface GitRuntime {
  root: string;
  executable: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

const commitPattern = /^[0-9a-f]{40,64}$/u;

function requestedMode(options: GitScopeOptions): GitScope["mode"] {
  const requested = [
    options.trackedOnly ? "tracked" as const : undefined,
    options.changedOnly ? "changed" as const : undefined,
    options.staged ? "staged" as const : undefined,
    options.since === undefined ? undefined : "since" as const,
  ].filter((mode): mode is Exclude<GitScope["mode"], "all"> => mode !== undefined);
  if (requested.length > 1) {
    throw new GitScopeError("Git scope options tracked-only, changed-only, staged, and since are mutually exclusive.");
  }
  return requested[0] ?? "all";
}

function requiresRepository(options: GitScopeOptions): boolean {
  return Boolean(
    options.trackedOnly ||
    options.changedOnly ||
    options.staged ||
    options.since !== undefined ||
    options.requireClean,
  );
}

function boundedFailure(label: string, result: ProcessResult): GitScopeError | undefined {
  if (result.timedOut) {
    return new GitScopeError(`${label} timed out.`);
  }
  if (result.truncated) {
    return new GitScopeError(`${label} exceeded its output limit.`);
  }
  if (result.invalidUtf8) {
    return new GitScopeError(`${label} returned invalid UTF-8 output.`);
  }
  return undefined;
}

async function git(runtime: GitRuntime, args: readonly string[], maximum = runtime.maxOutputBytes): Promise<ProcessResult> {
  try {
    return await runArgumentVector(runtime.executable, args, {
      cwd: runtime.root,
      timeoutMs: runtime.timeoutMs,
      maxOutputBytes: maximum,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
    });
  } catch (error) {
    throw new GitScopeError("Could not execute Git while resolving repository scope.", {
      cause: error,
      dependencyFailure: error instanceof ProcessSpawnError,
    });
  }
}

function normalizePath(path: string): string | undefined {
  if (path.length === 0) {
    return undefined;
  }
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    /[\u0000-\u001f]/u.test(path) ||
    path.split("/").includes("..")
  ) {
    throw new GitScopeError(`Git reported an unsafe repository path: ${JSON.stringify(path)}.`);
  }
  const normalized = path.replace(/^\.\//u, "").replace(/\/{2,}/gu, "/").replace(/\/$/u, "");
  const top = normalized.split("/", 1)[0];
  return normalized.length === 0 || top === ".git" || top === ".tfs-ripast" ? undefined : normalized;
}

function nullPaths(stdout: string): string[] {
  const paths = new Set<string>();
  for (const item of stdout.split("\0")) {
    const normalized = normalizePath(item);
    if (normalized !== undefined) {
      paths.add(normalized);
    }
  }
  return [...paths].sort(compareStrings);
}

function unionPaths(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())].sort(compareStrings);
}

async function requiredPathList(runtime: GitRuntime, label: string, args: readonly string[]): Promise<string[]> {
  const result = await git(runtime, args);
  const bounds = boundedFailure(label, result);
  if (bounds !== undefined) {
    throw bounds;
  }
  if (result.exitCode !== 0) {
    throw new GitScopeError(
      `${label} failed with exit code ${String(result.exitCode)}${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`,
    );
  }
  return nullPaths(result.stdout);
}

function auditRuntime(scope: GitScope, options: Pick<GitScopeOptions, "executable" | "timeoutMs" | "maxOutputBytes">): GitRuntime {
  return {
    root: scope.root,
    executable: options.executable ?? "git",
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 32 * 1024 * 1024,
  };
}

async function requiredSingleLine(runtime: GitRuntime, label: string, args: readonly string[]): Promise<string> {
  const result = await git(runtime, args, 64 * 1024);
  const bounds = boundedFailure(label, result);
  if (bounds !== undefined) {
    throw bounds;
  }
  const value = result.stdout.trim();
  if (result.exitCode !== 0 || !commitPattern.test(value)) {
    throw new GitScopeError(`${label} failed to produce a Git object identity.`);
  }
  return value;
}

async function resolveCommit(runtime: GitRuntime, revision: string, label: string): Promise<string> {
  if (revision.trim().length === 0 || revision.startsWith("-") || /[\u0000\r\n]/u.test(revision)) {
    throw new GitScopeError(`${label} revision is unsafe or blank.`);
  }
  const result = await git(runtime, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], 64 * 1024);
  const bounds = boundedFailure(`${label} revision resolution`, result);
  if (bounds !== undefined) {
    throw bounds;
  }
  const commit = result.stdout.trim();
  if (result.exitCode !== 0 || !commitPattern.test(commit)) {
    throw new GitScopeError(
      `${label} revision could not be resolved to a commit${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`,
    );
  }
  return commit;
}

async function optionalHead(runtime: GitRuntime): Promise<string | undefined> {
  const result = await git(runtime, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], 64 * 1024);
  const bounds = boundedFailure("Git HEAD resolution", result);
  if (bounds !== undefined) {
    throw bounds;
  }
  const head = result.stdout.trim();
  if (result.exitCode !== 0) {
    return undefined;
  }
  if (!commitPattern.test(head)) {
    throw new GitScopeError("Git HEAD resolution returned an invalid commit identity.");
  }
  return head;
}

async function repositoryStatus(runtime: GitRuntime): Promise<ProcessResult> {
  return git(runtime, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=all",
    "--",
    ":(top)**",
    ":(top,exclude).tfs-ripast",
    ":(top,exclude).tfs-ripast/**",
  ]);
}

/** Resolves an index-aware, bounded Git file scope without invoking a shell. */
export async function resolveGitScope(options: GitScopeOptions): Promise<GitScope> {
  const mode = requestedMode(options);
  const root = await realpath(resolve(options.root));
  const runtime: GitRuntime = {
    root,
    executable: options.executable ?? "git",
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 32 * 1024 * 1024,
  };
  let detection: ProcessResult;
  try {
    detection = await git(runtime, ["rev-parse", "--show-toplevel"], 64 * 1024);
  } catch (error) {
    if (!requiresRepository(options) && error instanceof GitScopeError && error.dependencyFailure) {
      return { repository: false, root, dirty: false, trackedFiles: [], files: [], mode };
    }
    throw error;
  }
  const detectionBounds = boundedFailure("Git repository detection", detection);
  if (detectionBounds !== undefined) {
    throw detectionBounds;
  }
  if (detection.exitCode !== 0) {
    if (requiresRepository(options)) {
      throw new GitScopeError("The requested Git scope or clean-worktree policy requires a Git repository.");
    }
    return { repository: false, root, dirty: false, trackedFiles: [], files: [], mode };
  }
  const repositoryRoot = await realpath(detection.stdout.trim());
  const relation = relative(repositoryRoot, root);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new GitScopeError("Git reported a repository boundary that does not contain the requested root.");
  }

  const status = await repositoryStatus({ ...runtime, root: repositoryRoot });
  const statusBounds = boundedFailure("Git dirty-state inspection", status);
  if (statusBounds !== undefined) {
    throw statusBounds;
  }
  if (status.exitCode !== 0) {
    throw new GitScopeError(`Git dirty-state inspection failed with exit code ${String(status.exitCode)}.`);
  }
  const dirty = status.stdout.length > 0;
  if (options.requireClean && dirty) {
    throw new GitScopeError("Git worktree is dirty, but a clean worktree is required.");
  }

  const trackedFiles = await requiredPathList(runtime, "Git tracked-file enumeration", [
    "ls-files", "--cached", "-z", "--", ".",
  ]);
  let files: string[];
  let sinceCommit: string | undefined;
  if (mode === "tracked") {
    files = trackedFiles;
  } else if (mode === "staged") {
    files = await requiredPathList(runtime, "Git staged-file enumeration", [
      "diff", "--relative", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "-z", "--",
      ".",
    ]);
  } else if (mode === "changed") {
    const [unstaged, staged, untracked] = await Promise.all([
      requiredPathList(runtime, "Git unstaged-file enumeration", [
        "diff", "--relative", "--name-only", "--diff-filter=ACMRTUXB", "-z", "--", ".",
      ]),
      requiredPathList(runtime, "Git staged-file enumeration", [
        "diff", "--relative", "--cached", "--name-only", "--diff-filter=ACMRTUXB", "-z", "--", ".",
      ]),
      requiredPathList(runtime, "Git untracked-file enumeration", [
        "ls-files", "--others", ...(options.includeIgnored ? [] : ["--exclude-standard"]), "-z", "--", ".",
      ]),
    ]);
    files = unionPaths(unstaged, staged, untracked);
  } else if (mode === "since") {
    sinceCommit = await resolveCommit(runtime, options.since!, "Since");
    files = await requiredPathList(runtime, "Git since-ref file enumeration", [
      "diff", "--relative", "--name-only", "--diff-filter=ACMRTUXB", "-z", sinceCommit, "--", ".",
    ]);
  } else {
    files = await requiredPathList(runtime, "Git repository-file enumeration", [
      "ls-files", "--cached", "--others", ...(options.includeIgnored ? [] : ["--exclude-standard"]), "-z", "--", ".",
    ]);
  }
  const head = await optionalHead(runtime);
  return {
    repository: true,
    root,
    repositoryRoot,
    ...(head === undefined ? {} : { head }),
    ...(sinceCommit === undefined ? {} : { sinceCommit }),
    dirty,
    trackedFiles,
    files,
    mode,
  };
}

/** Captures per-input worktree/index blob identities for a resolved Git scope. */
export async function auditGitScope(
  scope: GitScope,
  paths: readonly string[],
  options: Pick<GitScopeOptions, "requireClean" | "executable" | "timeoutMs" | "maxOutputBytes"> = {},
): Promise<GitScopeAudit> {
  const inputs: GitInputIdentity[] = [];
  if (scope.repository) {
    const runtime = auditRuntime(scope, options);
    for (const path of [...new Set(paths)].sort(compareStrings)) {
      const normalized = normalizePath(path);
      if (normalized === undefined) {
        throw new GitScopeError(`Cannot audit reserved or empty Git input path: ${path}.`);
      }
      const worktreeBlob = await requiredSingleLine(runtime, `Git worktree blob identity for ${normalized}`, [
        "hash-object", "--no-filters", "--", normalized,
      ]);
      const index = await git(runtime, ["ls-files", "--stage", "-z", "--", normalized], 64 * 1024);
      const bounds = boundedFailure(`Git index identity for ${normalized}`, index);
      if (bounds !== undefined) {
        throw bounds;
      }
      if (index.exitCode !== 0) {
        throw new GitScopeError(`Git index identity lookup failed for ${normalized}.`);
      }
      const stageZero = index.stdout.split("\0")
        .map((line) => /^(?:[0-7]{6}) ([0-9a-f]{40,64}) 0\t/u.exec(line))
        .find((match) => match !== null);
      inputs.push({
        path: normalized,
        worktreeBlob,
        ...(stageZero?.[1] === undefined ? {} : { indexBlob: stageZero[1] }),
      });
    }
  }
  return {
    repository: scope.repository,
    root: scope.root,
    ...(scope.repositoryRoot === undefined ? {} : { repositoryRoot: scope.repositoryRoot }),
    ...(scope.head === undefined ? {} : { head: scope.head }),
    ...(scope.sinceCommit === undefined ? {} : { sinceCommit: scope.sinceCommit }),
    dirty: scope.dirty,
    mode: scope.mode,
    requireClean: options.requireClean === true,
    inputs,
  };
}

/** Re-runs the repository-wide clean gate immediately before transaction source writes. */
export async function recheckGitScopeClean(
  audit: GitScopeAudit,
  options: Pick<GitScopeOptions, "executable" | "timeoutMs" | "maxOutputBytes"> = {},
): Promise<void> {
  if (!audit.requireClean) {
    return;
  }
  if (!audit.repository || audit.repositoryRoot === undefined) {
    throw new GitScopeError("The persisted clean-worktree policy requires a Git repository.");
  }
  const runtime: GitRuntime = {
    root: audit.repositoryRoot,
    executable: options.executable ?? "git",
    timeoutMs: options.timeoutMs ?? 30_000,
    maxOutputBytes: options.maxOutputBytes ?? 32 * 1024 * 1024,
  };
  const status = await repositoryStatus(runtime);
  const bounds = boundedFailure("Git clean-worktree recheck", status);
  if (bounds !== undefined) {
    throw bounds;
  }
  if (status.exitCode !== 0 || status.stdout.length > 0) {
    throw new GitScopeError("Git worktree changed after planning; a clean worktree is required before writing.");
  }
}
