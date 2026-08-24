import type { AstGrepLanguage, LanguageDecision, MatchEvidence } from "../types.js";
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

type RipgrepData = { text: string } | { bytes: string };

interface RipgrepMatch {
  type: "match";
  data: {
    path: RipgrepData;
    lines: RipgrepData;
    line_number: number;
    absolute_offset: number;
    submatches: Array<{
      match: RipgrepData;
      start: number;
      end: number;
    }>;
  };
}

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 8 * 1024 * 1024;

interface FailureContext {
  operationId: string;
  paths: readonly string[];
  language?: AstGrepLanguage;
}

function outputFailure(
  provider: string,
  result: ProcessResult,
  context: FailureContext,
  codePrefix = "ripgrep",
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

function isRipgrepMatch(value: unknown): value is RipgrepMatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Partial<RipgrepMatch>;
  if (event.type !== "match" || typeof event.data !== "object" || event.data === null) {
    return false;
  }
  const data = event.data;
  return (
    isRipgrepData(data.path) &&
    isRipgrepData(data.lines) &&
    Number.isSafeInteger(data.line_number) &&
    Number.isSafeInteger(data.absolute_offset) &&
    Array.isArray(data.submatches) &&
    data.submatches.every(
      (match) =>
        isRipgrepData(match?.match) &&
        Number.isSafeInteger(match.start) &&
        Number.isSafeInteger(match.end),
    )
  );
}

function isRipgrepData(value: unknown): value is RipgrepData {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const data = value as { text?: unknown; bytes?: unknown };
  return (
    (typeof data.text === "string" && data.bytes === undefined) ||
    (typeof data.bytes === "string" && data.text === undefined)
  );
}

function decodeBase64(value: string, context: FailureContext): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ProviderExecutionError("ripgrep emitted malformed base64 JSON data.", {
      code: "ripgrep-malformed-base64",
      ...context,
    });
  }
  return Buffer.from(value, "base64");
}

function dataBytes(data: RipgrepData, context: FailureContext): Buffer {
  return "text" in data ? Buffer.from(data.text, "utf8") : decodeBase64(data.bytes, context);
}

function utf8Text(data: RipgrepData, context: FailureContext): string | undefined {
  if ("text" in data) {
    return data.text;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(data.bytes, context));
  } catch (error) {
    if (error instanceof ProviderExecutionError) {
      throw error;
    }
    return undefined;
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) {
      count += 1;
    }
  }
  return count;
}

export class RipgrepProvider implements MatchProvider {
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: ProviderOptions = {}) {
    this.#executable = options.executable ?? "rg";
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
    for (const operand of scope.fileOperands) {
      const paths = operand.identityPath === operand.path
        ? [operand.path]
        : [operand.path, operand.identityPath];
      if (!matchesOperationGlobs(operand.path, request.operation.globs ?? [])) {
        throw new ProviderExecutionError(`Operation file is outside operation globs: ${operand.path}`, {
          code: "ripgrep-operation-file-outside-globs",
          operationId: request.operation.id,
          paths,
        });
      }
      if (!matchesOperationGlobs(operand.identityPath, request.operation.globs ?? [])) {
        throw new ProviderExecutionError(
          `Operation file target is outside operation globs: ${operand.path}`,
          {
            code: "ripgrep-operation-identity-outside-globs",
            operationId: request.operation.id,
            paths,
          },
        );
      }
      const decision = request.languageDecisions[operand.path] ??
        detectLanguage(operand.path, request.operation.languageOverrides ?? []);
      if (
        request.operation.languages !== undefined &&
        (decision.language === undefined || !request.operation.languages.includes(decision.language))
      ) {
        throw new ProviderExecutionError(`Operation file is outside operation languages: ${operand.path}`, {
          code: "ripgrep-operation-file-outside-languages",
          operationId: request.operation.id,
          ...(decision.language === undefined ? {} : { language: decision.language }),
          paths,
        });
      }
      const identityDecision = request.languageDecisions[operand.identityPath] ??
        detectLanguage(operand.identityPath, request.operation.languageOverrides ?? []);
      if (
        request.operation.languages !== undefined &&
        (identityDecision.language === undefined ||
          !request.operation.languages.includes(identityDecision.language))
      ) {
        throw new ProviderExecutionError(
          `Operation file target is outside operation languages: ${operand.path}`,
          {
            code: "ripgrep-operation-identity-outside-languages",
            operationId: request.operation.id,
            ...(identityDecision.language === undefined ? {} : { language: identityDecision.language }),
            paths,
          },
        );
      }
    }
    const version = await this.#version(scope.root, request.operation.id, scope.operationPaths);
    const scanPaths = request.candidatePaths ?? scope.operationPaths;
    if (scanPaths.length === 0) {
      return {
        provider: "ripgrep",
        operationId: request.operation.id,
        version,
        evidence: [],
        diagnostics: [],
        elapsedMs: performance.now() - startedAt,
      };
    }
    const args = this.#arguments(request, scanPaths);
    const result = await this.#run(args, scope.root, {
      operationId: request.operation.id,
      paths: scanPaths,
    });

    if (result.timedOut || result.truncated || result.invalidUtf8 || (result.exitCode !== 0 && result.exitCode !== 1)) {
      throw outputFailure("ripgrep", result, {
        operationId: request.operation.id,
        paths: scanPaths,
      });
    }
    if (result.exitCode === 1) {
      return {
        provider: "ripgrep",
        operationId: request.operation.id,
        version,
        evidence: [],
        diagnostics: [],
        elapsedMs: performance.now() - startedAt,
      };
    }

    const evidence: MatchEvidence[] = [];
    const diagnostics: ProviderDiagnostic[] = [];
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (line.length === 0) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new ProviderExecutionError(
          `ripgrep emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
          {
            code: "ripgrep-malformed-json",
            operationId: request.operation.id,
            paths: scanPaths,
            cause: error,
          },
        );
      }
      if (typeof event !== "object" || event === null || !("type" in event)) {
        throw new ProviderExecutionError("ripgrep emitted malformed JSON: event type is missing.", {
          code: "ripgrep-malformed-json",
          operationId: request.operation.id,
          paths: scanPaths,
        });
      }
      if ((event as { type?: unknown }).type !== "match") {
        continue;
      }
      if (!isRipgrepMatch(event)) {
        throw new ProviderExecutionError("ripgrep emitted malformed JSON match data.", {
          code: "ripgrep-malformed-json",
          operationId: request.operation.id,
          paths: scanPaths,
        });
      }
      const parsed = await this.#evidenceForMatch(scope, event);
      evidence.push(...parsed.evidence);
      diagnostics.push(...parsed.diagnostics);
    }

    return {
      provider: "ripgrep",
      operationId: request.operation.id,
      version,
      evidence: sortEvidence(evidence),
      diagnostics,
      elapsedMs: performance.now() - startedAt,
    };
  }

  #arguments(request: ProviderRequest, operationPaths: readonly string[]): string[] {
    const args = [
      "--json",
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
    for (const path of request.excludedPaths ?? []) {
      const escaped = [...path]
        .map((character) => "*?[]{}\\".includes(character) ? `\\${character}` : character)
        .join("");
      args.push("--glob", `!/${escaped}`);
    }
    args.push("--text", "--no-ignore-vcs");
    if (request.operation.lexical.type === "literal") {
      args.push("--fixed-strings");
    } else {
      const flags = request.operation.lexical.flags ?? "";
      if (flags.includes("i")) {
        args.push("--ignore-case");
      }
      if (flags.includes("s")) {
        args.push("--multiline-dotall");
      }
    }
    args.push("-e", request.operation.search, "--", ...operationPaths);
    return args;
  }

  async #evidenceForMatch(
    scope: OperationScope,
    event: RipgrepMatch,
  ): Promise<{ evidence: MatchEvidence[]; diagnostics: ProviderDiagnostic[] }> {
    const request = scope.request;
    const initialContext: FailureContext = {
      operationId: request.operation.id,
      paths: scope.operationPaths,
    };
    const reportedPath = utf8Text(event.data.path, initialContext);
    if (reportedPath === undefined) {
      return {
        evidence: [],
        diagnostics: [{
          code: "ripgrep-unrepresentable-path",
          message: "ripgrep reported a path that is not valid UTF-8.",
          operationId: request.operation.id,
          paths: [],
        }],
      };
    }
    const candidate = await validateCandidateIdentity(scope, reportedPath);
    const file = candidate.path;
    const identityPath = candidate.identityPath;
    const decision: LanguageDecision =
      request.languageDecisions[file] ??
      detectLanguage(file, request.operation.languageOverrides ?? []);
    const identityDecision: LanguageDecision =
      request.languageDecisions[identityPath] ??
      detectLanguage(identityPath, request.operation.languageOverrides ?? []);
    const candidatePaths = identityPath === file ? [file] : [file, identityPath];
    const matchContext: FailureContext = {
      operationId: request.operation.id,
      ...(decision.language === undefined ? {} : { language: decision.language }),
      paths: candidatePaths,
    };
    const diagnostic = (
      code: string,
      message: string,
      paths: string[] = [file],
      language = decision.language,
    ): { evidence: MatchEvidence[]; diagnostics: ProviderDiagnostic[] } => ({
      evidence: [],
      diagnostics: [{
        code,
        message,
        operationId: request.operation.id,
        ...(language === undefined ? {} : { language }),
        paths,
      }],
    });
    if (candidate.reserved) {
      return diagnostic(
        "ripgrep-reserved-path",
        `ripgrep reported reserved provider path ${file}.`,
      );
    }
    if (candidate.reservedIdentity) {
      return diagnostic(
        "ripgrep-reserved-identity",
        `ripgrep reported ${file}, whose target is reserved.`,
        candidatePaths,
      );
    }
    if (!isWithinOperationPaths(scope, file)) {
      return diagnostic(
        "ripgrep-path-outside-operation",
        `ripgrep reported ${file} outside operation ${request.operation.id} paths.`,
      );
    }
    if (!isWithinOperationPaths(scope, identityPath)) {
      return diagnostic(
        "ripgrep-identity-outside-operation",
        `ripgrep reported ${file}, whose target is outside operation ${request.operation.id} paths.`,
        candidatePaths,
      );
    }
    if (!matchesOperationGlobs(file, request.operation.globs ?? [])) {
      return diagnostic(
        "ripgrep-path-outside-globs",
        `ripgrep reported ${file} outside operation ${request.operation.id} globs.`,
      );
    }
    if (!matchesOperationGlobs(identityPath, request.operation.globs ?? [])) {
      return diagnostic(
        "ripgrep-identity-outside-globs",
        `ripgrep reported ${file}, whose target is outside operation ${request.operation.id} globs.`,
        candidatePaths,
      );
    }
    if (candidate.ignored) {
      return diagnostic(
        "ripgrep-git-ignored-path",
        `ripgrep reported Git-ignored path ${file}.`,
      );
    }
    if (candidate.ignoredIdentity) {
      return diagnostic(
        "ripgrep-git-ignored-identity",
        `ripgrep reported ${file}, whose target is Git-ignored.`,
        candidatePaths,
      );
    }
    if (
      request.operation.languages !== undefined &&
      (decision.language === undefined || !request.operation.languages.includes(decision.language))
    ) {
      return diagnostic(
        "ripgrep-language-outside-operation",
        `ripgrep reported ${file} outside operation ${request.operation.id} languages.`,
      );
    }
    if (
      request.operation.languages !== undefined &&
      (identityDecision.language === undefined ||
        !request.operation.languages.includes(identityDecision.language))
    ) {
      return diagnostic(
        "ripgrep-identity-language-outside-operation",
        `ripgrep reported ${file}, whose target is outside operation ${request.operation.id} languages.`,
        candidatePaths,
        identityDecision.language ?? decision.language,
      );
    }
    const lineBytes = dataBytes(event.data.lines, matchContext);
    const evidence: MatchEvidence[] = [];
    const diagnostics: ProviderDiagnostic[] = [];
    if ("bytes" in event.data.lines) {
      diagnostics.push({
        code: "ripgrep-non-utf8-content",
        message: `ripgrep searched non-UTF8 content in ${file}; it is not writable in version one.`,
        operationId: request.operation.id,
        ...(decision.language === undefined ? {} : { language: decision.language }),
        paths: [file],
      });
    }
    for (const submatch of event.data.submatches) {
      if (
        submatch.start < 0 ||
        submatch.end < submatch.start ||
        submatch.end > lineBytes.byteLength
      ) {
        throw new ProviderExecutionError("ripgrep emitted an invalid submatch byte range.", {
          code: "ripgrep-invalid-submatch-range",
          ...matchContext,
        });
      }
      const reportedMatch = dataBytes(submatch.match, matchContext);
      const matchedBytes = lineBytes.subarray(submatch.start, submatch.end);
      if (!reportedMatch.equals(matchedBytes)) {
        throw new ProviderExecutionError("ripgrep emitted inconsistent submatch bytes.", {
          code: "ripgrep-inconsistent-submatch-bytes",
          ...matchContext,
        });
      }
      const byteRange: [number, number] = [
        event.data.absolute_offset + submatch.start,
        event.data.absolute_offset + submatch.end,
      ];
      const lineRange: [number, number] = [
        event.data.line_number + countNewlines(lineBytes.subarray(0, submatch.start)),
        event.data.line_number + countNewlines(lineBytes.subarray(0, submatch.end)),
      ];
      const matchedTextHash = sha256(matchedBytes);
      const base: MatchEvidence = {
        id: evidenceId("ripgrep", request.operation.id, file, byteRange, matchedTextHash),
        operationId: request.operation.id,
        provider: "ripgrep",
        file,
        byteRange,
        lineRange,
        matchedTextHash,
        languageSource: decision.source,
        confidence: "lexical",
      };
      evidence.push(
        decision.language === undefined ? base : { ...base, language: decision.language },
      );
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
      throw new ProviderExecutionError("Could not execute ripgrep.", {
        code: "ripgrep-spawn",
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
      throw outputFailure("ripgrep --version", result, context, "ripgrep-version");
    }
    const version = result.stdout.trim().split(/\r?\n/u)[0] ?? "";
    if (version === "") {
      throw new ProviderExecutionError("ripgrep --version returned no version.", {
        code: "ripgrep-version-empty",
        operationId,
        paths,
      });
    }
    return version;
  }
}
