import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { detectLanguage } from "./languages.js";
import { correlateEvidence, type CorrelationResult } from "./evidence.js";
import { snapshotTargets } from "./filesystem.js";
import { auditGitScope, resolveGitScope, type GitScopeOptions } from "./git.js";
import { stableJson } from "./output.js";
import { buildEditPlan, type FileSnapshot } from "./planner.js";
import { compareStrings } from "./order.js";
import { AstGrepProvider } from "./providers/astGrep.js";
import {
  ProviderExecutionError,
  type ProviderDiagnostic,
  type ProviderResult,
} from "./providers/provider.js";
import { RipgrepProvider } from "./providers/ripgrep.js";
import { runArgumentVector } from "./providers/process.js";
import { assertPlanRootContained, canonicalCandidatePath, isContained } from "./cli-artifacts.js";
import { canonicalRewritePlan, type CommonOptions, type CliRuntime } from "./cli-parse.js";
import type { EditPlan, GitScopeAudit, RewritePlan } from "./types.js";

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

/** The sole repository-percentage denominator authority for every CLI lifecycle stage. */
export async function enumerateRepositoryFiles(
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

export async function resolveEditPlan(
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
