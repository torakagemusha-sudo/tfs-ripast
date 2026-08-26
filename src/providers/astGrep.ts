import type { AstGrepLanguage, CaptureMap, MatchEvidence } from "../types.js";
import { detectLanguage } from "../languages.js";
import {
  evidenceId,
  isWithinOperationPaths,
  matchesOperationGlobs,
  type MatchProvider,
  type OperationScope,
  prepareOperationScope,
  type ProviderDiagnostic,
  ProviderExecutionError,
  type ProviderOptions,
  type ProviderRequest,
  type ProviderResult,
  sha256,
  sortEvidence,
  validateCandidateIdentity,
} from "./provider.js";
import { runArgumentVector, type ProcessResult } from "./process.js";

interface AstGrepCapture {
  text: string;
  range: { byteOffset: { start: number; end: number } };
}

interface AstGrepMatch {
  text: string;
  file: string;
  range: {
    byteOffset: { start: number; end: number };
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  metaVariables?: {
    single?: Record<string, AstGrepCapture>;
    multi?: Record<string, AstGrepCapture[]>;
    transformed?: Record<string, unknown>;
  };
}

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 8 * 1024 * 1024;
const exactAstGrepVersion = /^ast-grep\s+0\.45\.1$/u;

interface FailureContext {
  operationId: string;
  paths: readonly string[];
  language?: AstGrepLanguage;
}

function outputFailure(
  provider: string,
  result: ProcessResult,
  context: FailureContext,
  codePrefix = "ast-grep",
): ProviderExecutionError {
  const details = {
    operationId: context.operationId,
    paths: context.paths,
    ...(context.language === undefined ? {} : { language: context.language }),
  };
  if (result.timedOut) {
    return new ProviderExecutionError(`${provider} timed out.`, {
      code: `${codePrefix}-timeout`,
      ...details,
    });
  }
  if (result.truncated) {
    return new ProviderExecutionError(`${provider} exceeded its output limit.`, {
      code: `${codePrefix}-output-limit`,
      ...details,
    });
  }
  if (result.invalidUtf8) {
    return new ProviderExecutionError(`${provider} returned invalid UTF-8 output.`, {
      code: `${codePrefix}-invalid-utf8`,
      ...details,
    });
  }
  const detail = result.stderr.trim();
  return new ProviderExecutionError(
    `${provider} failed with exit code ${String(result.exitCode)}${detail ? `: ${detail}` : "."}`,
    { code: `${codePrefix}-exit`, ...details },
  );
}

function isPosition(value: unknown): value is { line: number; column: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { line?: unknown }).line) &&
    Number.isSafeInteger((value as { column?: unknown }).column)
  );
}

function isByteOffset(value: unknown): value is { start: number; end: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { start?: unknown }).start) &&
    Number.isSafeInteger((value as { end?: unknown }).end)
  );
}

function isAstGrepMatch(value: unknown): value is AstGrepMatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const match = value as Partial<AstGrepMatch>;
  return (
    typeof match.text === "string" &&
    typeof match.file === "string" &&
    typeof match.range === "object" &&
    match.range !== null &&
    isByteOffset(match.range.byteOffset) &&
    isPosition(match.range.start) &&
    isPosition(match.range.end)
  );
}

function captureMapUnchecked(match: AstGrepMatch, context: FailureContext): CaptureMap | undefined {
  const captures: CaptureMap = {};
  for (const [name, capture] of Object.entries(match.metaVariables?.single ?? {})) {
    if (typeof capture?.text === "string") {
      captures[name] = capture.text;
    }
  }
  const matchedBytes = Buffer.from(match.text, "utf8");
  for (const [name, values] of Object.entries(match.metaVariables?.multi ?? {})) {
    if (!Array.isArray(values) || values.length === 0) {
      captures[name] = "";
      continue;
    }
    const first = values[0];
    const last = values.at(-1);
    if (first === undefined || last === undefined) {
      captures[name] = "";
      continue;
    }
    const start = first.range.byteOffset.start - match.range.byteOffset.start;
    const end = last.range.byteOffset.end - match.range.byteOffset.start;
    if (start < 0 || end < start || end > matchedBytes.byteLength) {
      throw new ProviderExecutionError("ast-grep emitted an invalid capture byte range.", {
        code: "ast-grep-invalid-capture-range",
        ...context,
      });
    }
    captures[name] = matchedBytes.subarray(start, end).toString("utf8");
  }
  return Object.keys(captures).length === 0 ? undefined : captures;
}

function captureMap(match: AstGrepMatch, context: FailureContext): CaptureMap | undefined {
  try {
    return captureMapUnchecked(match, context);
  } catch (error) {
    if (error instanceof ProviderExecutionError) {
      throw error;
    }
    throw new ProviderExecutionError("ast-grep emitted malformed capture metadata.", {
      code: "ast-grep-malformed-capture",
      ...context,
      cause: error,
    });
  }
}

export class AstGrepProvider implements MatchProvider {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: ProviderOptions = {}) {
    this.#executable = options.executable ?? "ast-grep";
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    this.#env = options.env ?? process.env;
  }

  async scan(request: ProviderRequest): Promise<ProviderResult> {
    const startedAt = performance.now();
    const runtime = {
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxOutputBytes,
      env: this.#env,
    };
    const scope = await prepareOperationScope(request, runtime);
    const diagnostics: ProviderDiagnostic[] = [];
    const groups = new Map<AstGrepLanguage, string[]>();

    for (const [reportedPath, decision] of Object.entries(request.languageDecisions)) {
      const candidate = await validateCandidateIdentity(scope, reportedPath);
      const path = candidate.path;
      const identityPath = candidate.identityPath;
      const identityDecision = request.languageDecisions[identityPath] ??
        detectLanguage(identityPath, request.operation.languageOverrides ?? []);
      const candidatePaths = identityPath === path ? [path] : [path, identityPath];
      const diagnostic = (
        code: string,
        message: string,
        paths: string[] = [path],
        language = decision.language,
      ): void => {
        diagnostics.push({
          code,
          message,
          operationId: request.operation.id,
          ...(language === undefined ? {} : { language }),
          paths,
        });
      };
      if (candidate.reserved) {
        diagnostic("ast-grep-reserved-path", `ast-grep target ${path} is reserved.`);
        continue;
      }
      if (candidate.reservedIdentity) {
        diagnostic(
          "ast-grep-reserved-identity",
          `ast-grep target ${path} resolves to reserved path ${identityPath}.`,
          candidatePaths,
        );
        continue;
      }
      if (candidate.ignored) {
        diagnostic("ast-grep-git-ignored-path", `ast-grep target ${path} is Git-ignored.`);
        continue;
      }
      if (candidate.ignoredIdentity) {
        diagnostic(
          "ast-grep-git-ignored-identity",
          `ast-grep target ${path} resolves to Git-ignored path ${identityPath}.`,
          candidatePaths,
        );
        continue;
      }
      if (!isWithinOperationPaths(scope, path)) {
        diagnostic(
          "ast-grep-path-outside-operation",
          `ast-grep target ${path} is outside operation ${request.operation.id} paths.`,
        );
        continue;
      }
      if (!isWithinOperationPaths(scope, identityPath)) {
        diagnostic(
          "ast-grep-identity-outside-operation",
          `ast-grep target ${path} resolves outside operation ${request.operation.id} paths.`,
          candidatePaths,
        );
        continue;
      }
      if (!matchesOperationGlobs(path, request.operation.globs ?? [])) {
        diagnostic(
          "ast-grep-path-outside-globs",
          `ast-grep target ${path} is outside operation ${request.operation.id} globs.`,
        );
        continue;
      }
      if (!matchesOperationGlobs(identityPath, request.operation.globs ?? [])) {
        diagnostic(
          "ast-grep-identity-outside-globs",
          `ast-grep target ${path} resolves outside operation ${request.operation.id} globs.`,
          candidatePaths,
        );
        continue;
      }
      if (decision.language === undefined) {
        diagnostics.push({
          code: "ast-grep-unsupported-language",
          message: `No ast-grep language is available for ${path}.`,
          operationId: request.operation.id,
          paths: [path],
        });
        continue;
      }
      if (
        request.operation.languages !== undefined &&
        !request.operation.languages.includes(decision.language)
      ) {
        diagnostic(
          "ast-grep-language-outside-operation",
          `ast-grep target ${path} is outside operation ${request.operation.id} languages.`,
        );
        continue;
      }
      if (
        request.operation.languages !== undefined &&
        (identityDecision.language === undefined ||
          !request.operation.languages.includes(identityDecision.language))
      ) {
        diagnostic(
          "ast-grep-identity-language-outside-operation",
          `ast-grep target ${path} resolves outside operation ${request.operation.id} languages.`,
          candidatePaths,
          identityDecision.language ?? decision.language,
        );
        continue;
      }
      const paths = groups.get(decision.language) ?? [];
      paths.push(path);
      groups.set(decision.language, paths);
    }

    const version = await this.#version(scope.root, request.operation.id, scope.operationPaths);
    const evidence: MatchEvidence[] = [];
    const languages = [...groups.keys()].sort();
    for (const language of languages) {
      const paths = [...new Set(groups.get(language) ?? [])].sort();
      const context = { operationId: request.operation.id, language, paths };
      const result = await this.#run(
        this.#arguments(request, language, paths),
        scope.root,
        context,
      );
      if (result.timedOut || result.truncated || result.invalidUtf8) {
        throw outputFailure(`ast-grep (${language})`, result, context);
      }
      if (result.exitCode === 1) {
        continue;
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim();
        if (/\b(?:pattern|parse|parsed|parsing|syntax)\b/iu.test(detail)) {
          diagnostics.push({
            code: "ast-grep-pattern-error",
            message: `ast-grep could not scan ${language}: ${detail || `exit code ${String(result.exitCode)}`}`,
            operationId: request.operation.id,
            language,
            paths,
          });
          continue;
        }
        throw outputFailure(`ast-grep (${language})`, result, context);
      }
      const parsed = await this.#parseMatches(scope, language, new Set(paths), result.stdout);
      evidence.push(...parsed.evidence);
      diagnostics.push(...parsed.diagnostics);
    }

    return {
      provider: "ast-grep",
      operationId: request.operation.id,
      version,
      evidence: sortEvidence(evidence),
      diagnostics,
      elapsedMs: performance.now() - startedAt,
    };
  }

  #arguments(
    request: ProviderRequest,
    language: AstGrepLanguage,
    paths: readonly string[],
  ): string[] {
    const args = [
      "run",
      "--json=stream",
      "--pattern",
      request.operation.search,
      "--lang",
      language,
      "--globs",
      "!.git",
      "--globs",
      "!.git/**",
      "--globs",
      "!.tfs-ripast",
      "--globs",
      "!.tfs-ripast/**",
    ];
    if (request.respectGitIgnore === false) {
      args.push("--no-ignore", "vcs");
    }
    args.push("--", ...paths);
    return args;
  }

  async #parseMatches(
    scope: OperationScope,
    invocationLanguage: AstGrepLanguage,
    invokedPaths: ReadonlySet<string>,
    stdout: string,
  ): Promise<{ evidence: MatchEvidence[]; diagnostics: ProviderDiagnostic[] }> {
    const request = scope.request;
    const invocationContext: FailureContext = {
      operationId: request.operation.id,
      language: invocationLanguage,
      paths: [...invokedPaths],
    };
    const evidence: MatchEvidence[] = [];
    const diagnostics: ProviderDiagnostic[] = [];
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new ProviderExecutionError(
          `ast-grep emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
          {
            code: "ast-grep-malformed-json",
            ...invocationContext,
            cause: error,
          },
        );
      }
      if (!isAstGrepMatch(parsed)) {
        throw new ProviderExecutionError("ast-grep emitted malformed JSON match data.", {
          code: "ast-grep-malformed-json",
          ...invocationContext,
        });
      }
      const byteRange: [number, number] = [
        parsed.range.byteOffset.start,
        parsed.range.byteOffset.end,
      ];
      if (byteRange[0] < 0 || byteRange[1] < byteRange[0]) {
        throw new ProviderExecutionError("ast-grep emitted an invalid match byte range.", {
          code: "ast-grep-invalid-match-range",
          ...invocationContext,
        });
      }
      const candidate = await validateCandidateIdentity(scope, parsed.file);
      const file = candidate.path;
      const identityPath = candidate.identityPath;
      const detected =
        request.languageDecisions[file] ??
        detectLanguage(file, request.operation.languageOverrides ?? []);
      const identityDetected = request.languageDecisions[identityPath] ??
        detectLanguage(identityPath, request.operation.languageOverrides ?? []);
      const language = detected.language ?? invocationLanguage;
      const languageSource =
        detected.language === undefined ? ("override" as const) : detected.source;
      const candidatePaths = identityPath === file ? [file] : [file, identityPath];
      const matchContext: FailureContext = {
        operationId: request.operation.id,
        language,
        paths: candidatePaths,
      };
      const reject = (code: string, message: string, paths: string[] = [file]): void => {
        diagnostics.push({
          code,
          message,
          operationId: request.operation.id,
          language,
          paths,
        });
      };
      if (candidate.reserved) {
        reject("ast-grep-reserved-evidence-path", `ast-grep reported reserved path ${file}.`);
        continue;
      }
      if (candidate.reservedIdentity) {
        reject(
          "ast-grep-reserved-evidence-identity",
          `ast-grep reported ${file}, whose target is reserved.`,
          candidatePaths,
        );
        continue;
      }
      if (candidate.ignored) {
        reject("ast-grep-git-ignored-evidence", `ast-grep reported Git-ignored path ${file}.`);
        continue;
      }
      if (candidate.ignoredIdentity) {
        reject(
          "ast-grep-git-ignored-evidence-identity",
          `ast-grep reported ${file}, whose target is Git-ignored.`,
          candidatePaths,
        );
        continue;
      }
      if (!isWithinOperationPaths(scope, file)) {
        reject(
          "ast-grep-path-outside-operation",
          `ast-grep reported ${file} outside operation ${request.operation.id} paths.`,
        );
        continue;
      }
      if (!isWithinOperationPaths(scope, identityPath)) {
        reject(
          "ast-grep-identity-outside-operation",
          `ast-grep reported ${file}, whose target is outside operation ${request.operation.id} paths.`,
          candidatePaths,
        );
        continue;
      }
      if (!matchesOperationGlobs(file, request.operation.globs ?? [])) {
        reject(
          "ast-grep-path-outside-globs",
          `ast-grep reported ${file} outside operation ${request.operation.id} globs.`,
        );
        continue;
      }
      if (!matchesOperationGlobs(identityPath, request.operation.globs ?? [])) {
        reject(
          "ast-grep-identity-outside-globs",
          `ast-grep reported ${file}, whose target is outside operation ${request.operation.id} globs.`,
          candidatePaths,
        );
        continue;
      }
      if (
        request.operation.languages !== undefined &&
        !request.operation.languages.includes(language)
      ) {
        reject(
          "ast-grep-language-outside-operation",
          `ast-grep reported ${file} outside operation ${request.operation.id} languages.`,
        );
        continue;
      }
      if (
        request.operation.languages !== undefined &&
        (identityDetected.language === undefined ||
          !request.operation.languages.includes(identityDetected.language))
      ) {
        reject(
          "ast-grep-identity-language-outside-operation",
          `ast-grep reported ${file}, whose target is outside operation ${request.operation.id} languages.`,
          candidatePaths,
        );
        continue;
      }
      if (!invokedPaths.has(file)) {
        reject(
          "ast-grep-unexpected-evidence-path",
          `ast-grep reported ${file}, which was not in its ${invocationLanguage} target group.`,
        );
        continue;
      }
      const matchedTextHash = sha256(parsed.text);
      const captures = captureMap(parsed, matchContext);
      const base: MatchEvidence = {
        id: evidenceId("ast-grep", request.operation.id, file, byteRange, matchedTextHash),
        operationId: request.operation.id,
        provider: "ast-grep",
        file,
        byteRange,
        lineRange: [parsed.range.start.line + 1, parsed.range.end.line + 1],
        matchedTextHash,
        language,
        languageSource,
        confidence: "structural",
      };
      evidence.push(captures === undefined ? base : { ...base, captures });
    }
    return { evidence, diagnostics };
  }

  async #run(
    args: readonly string[],
    cwd: string,
    context: FailureContext,
  ): Promise<ProcessResult> {
    try {
      return await runArgumentVector(this.#executable, args, {
        cwd,
        timeoutMs: this.#timeoutMs,
        maxOutputBytes: this.#maxOutputBytes,
        env: this.#env,
      });
    } catch (error) {
      throw new ProviderExecutionError("Could not execute ast-grep.", {
        code: "ast-grep-spawn",
        operationId: context.operationId,
        ...(context.language === undefined ? {} : { language: context.language }),
        paths: context.paths,
        cause: error,
      });
    }
  }

  async #version(cwd: string, operationId: string, paths: readonly string[]): Promise<string> {
    const context = { operationId, paths };
    const result = await this.#run(["--version"], cwd, context);
    if (result.timedOut || result.truncated || result.invalidUtf8 || result.exitCode !== 0) {
      throw outputFailure("ast-grep --version", result, context, "ast-grep-version");
    }
    const version = result.stdout.trim().split(/\r?\n/u)[0] ?? "";
    if (version === "") {
      throw new ProviderExecutionError("ast-grep --version returned no version.", {
        code: "ast-grep-version-empty",
        operationId,
        paths,
      });
    }
    if (!exactAstGrepVersion.test(version)) {
      throw new ProviderExecutionError(`ast-grep must be exactly version 0.45.1 (got: ${version}).`, {
        code: "ast-grep-version-unsupported",
        operationId,
        paths,
      });
    }
    return version;
  }
}
