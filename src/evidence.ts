import { isAbsolute, posix, win32 } from "node:path";
import { compareStrings } from "./order.js";
import type {
  ProviderDiagnostic,
  ProviderResult,
} from "./providers/provider.js";
import type { MatchEvidence } from "./types.js";

export type MatchClassification =
  | "confirmed"
  | "ast-only"
  | "text-only"
  | "adjacent"
  | "conflicting"
  | "unparseable";

export interface CorrelatedMatch {
  operationId: string;
  file: string;
  byteRange: [number, number];
  classification: MatchClassification;
  evidence: MatchEvidence[];
  diagnostics: CorrelatedDiagnostic[];
}

export interface CorrelatedDiagnostic extends ProviderDiagnostic {
  provider: string;
}

export interface CorrelationResult {
  matches: CorrelatedMatch[];
  diagnostics: CorrelatedDiagnostic[];
  providerVersions: Record<string, string>;
}

const structuralUnavailableCodes = new Set([
  "ast-grep-pattern-error",
  "ast-grep-unsupported-language",
]);

export function normalizeRepositoryPath(path: string, allowRoot = false): string {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    /[\u0000-\u001f]/u.test(path) ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path)
  ) {
    throw new Error(`Path escapes or is outside the requested root: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    (!allowRoot && normalized === ".")
  ) {
    throw new Error(`Path escapes or is outside the requested root: ${path}`);
  }
  return normalized;
}

function compareEvidence(left: MatchEvidence, right: MatchEvidence): number {
  const confidenceOrder = (value: MatchEvidence): number => value.confidence === "lexical" ? 1 : 0;
  return (
    confidenceOrder(left) - confidenceOrder(right) ||
    compareStrings(left.provider, right.provider) ||
    compareStrings(left.id, right.id)
  );
}

function isStructural(item: MatchEvidence): boolean {
  return item.confidence === "structural" || item.confidence === "semantic";
}

function spansTouch(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] <= right[1] && right[0] <= left[1];
}

function diagnosticApplies(
  diagnostic: CorrelatedDiagnostic,
  match: Pick<CorrelatedMatch, "operationId" | "file" | "evidence">,
): boolean {
  if (diagnostic.operationId !== match.operationId) {
    return false;
  }
  if (
    diagnostic.language !== undefined &&
    !match.evidence.some((item) => item.language === diagnostic.language)
  ) {
    return false;
  }
  return diagnostic.paths.length === 0 || diagnostic.paths.some((path) => {
    const canonical = normalizeRepositoryPath(path, true);
    return canonical === "." || match.file === canonical || match.file.startsWith(`${canonical}/`);
  });
}

export function compareDiagnostics(
  left: CorrelatedDiagnostic,
  right: CorrelatedDiagnostic,
): number {
  return (
    compareStrings(left.code, right.code) ||
    compareStrings(left.provider, right.provider) ||
    compareStrings(left.operationId, right.operationId) ||
    compareStrings(left.language ?? "", right.language ?? "") ||
    compareStrings(left.message, right.message) ||
    compareStrings(left.paths.join("\u0000"), right.paths.join("\u0000"))
  );
}

function compareMatches(left: CorrelatedMatch, right: CorrelatedMatch): number {
  return (
    compareStrings(left.operationId, right.operationId) ||
    compareStrings(left.file, right.file) ||
    left.byteRange[0] - right.byteRange[0] ||
    left.byteRange[1] - right.byteRange[1] ||
    compareStrings(left.classification, right.classification) ||
    compareStrings(
      left.evidence.map((item) => item.id).join("\u0000"),
      right.evidence.map((item) => item.id).join("\u0000"),
    )
  );
}

function exactMatch(group: MatchEvidence[]): CorrelatedMatch {
  group.sort(compareEvidence);
  const first = group[0];
  if (first === undefined) {
    throw new Error("Evidence group unexpectedly empty");
  }
  const hasStructural = group.some(isStructural);
  const hasLexical = group.some((item) => !isStructural(item));
  const hashes = new Set(group.map((item) => item.matchedTextHash));
  const classification: MatchClassification = hasStructural && hasLexical
    ? hashes.size === 1 ? "confirmed" : "conflicting"
    : hasStructural ? "ast-only" : "text-only";
  return {
    operationId: first.operationId,
    file: first.file,
    byteRange: [...first.byteRange],
    classification,
    evidence: group,
    diagnostics: [],
  };
}

function adjacencyKey(left: CorrelatedMatch, right: CorrelatedMatch): string {
  return JSON.stringify([
    left.operationId,
    left.file,
    Math.min(left.byteRange[0], right.byteRange[0]),
    Math.max(left.byteRange[1], right.byteRange[1]),
    left.evidence.map((item) => item.id).join("\u0000"),
    right.evidence.map((item) => item.id).join("\u0000"),
  ]);
}

export function correlateEvidence(results: ProviderResult[]): CorrelationResult {
  const seenEvidenceIds = new Set<string>();
  const normalizedEvidence: MatchEvidence[] = [];
  const diagnostics: CorrelatedDiagnostic[] = [];
  const versions = new Map<string, string>();

  for (const result of results) {
    const previousVersion = versions.get(result.provider);
    if (previousVersion !== undefined && previousVersion !== result.version) {
      throw new Error(
        `Provider ${result.provider} reported conflicting versions: ${previousVersion} and ${result.version}`,
      );
    }
    versions.set(result.provider, result.version);
    for (const item of result.evidence) {
      if (item.operationId !== result.operationId) {
        throw new Error(`Evidence ${item.id} does not belong to result operation ${result.operationId}`);
      }
      if (item.provider !== result.provider) {
        throw new Error(`Evidence ${item.id} does not belong to result provider ${result.provider}`);
      }
      if (seenEvidenceIds.has(item.id)) {
        throw new Error(`Duplicate evidence ID: ${item.id}`);
      }
      seenEvidenceIds.add(item.id);
      normalizedEvidence.push({ ...item, file: normalizeRepositoryPath(item.file) });
    }
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.operationId !== result.operationId) {
        throw new Error(`Diagnostic ${diagnostic.code} does not belong to result operation ${result.operationId}`);
      }
      diagnostics.push({
        code: diagnostic.code,
        message: diagnostic.message,
        operationId: diagnostic.operationId,
        ...(diagnostic.language === undefined ? {} : { language: diagnostic.language }),
        paths: [...new Set(diagnostic.paths.map((path) => normalizeRepositoryPath(path, true)))]
          .sort(compareStrings),
        provider: result.provider,
      });
    }
  }
  diagnostics.sort(compareDiagnostics);

  const exactGroups = new Map<string, MatchEvidence[]>();
  for (const item of normalizedEvidence) {
    const key = JSON.stringify([item.operationId, item.file, item.byteRange[0], item.byteRange[1]]);
    const group = exactGroups.get(key);
    if (group === undefined) {
      exactGroups.set(key, [item]);
    } else {
      group.push(item);
    }
  }

  const exactMatches = [...exactGroups.values()].map(exactMatch).sort(compareMatches);
  const finalized = exactMatches.filter((match) => {
    const structural = match.evidence.some(isStructural);
    const lexical = match.evidence.some((item) => !isStructural(item));
    return structural && lexical;
  });
  const unmatched = exactMatches.filter((match) => !finalized.includes(match));
  const adjacencyCandidates: Array<{ left: number; right: number; key: string }> = [];
  for (let left = 0; left < unmatched.length; left += 1) {
    const leftMatch = unmatched[left];
    if (leftMatch === undefined) {
      continue;
    }
    for (let right = left + 1; right < unmatched.length; right += 1) {
      const rightMatch = unmatched[right];
      if (
        rightMatch === undefined ||
        leftMatch.operationId !== rightMatch.operationId ||
        leftMatch.file !== rightMatch.file ||
        !spansTouch(leftMatch.byteRange, rightMatch.byteRange) ||
        leftMatch.evidence.some(isStructural) === rightMatch.evidence.some(isStructural)
      ) {
        continue;
      }
      adjacencyCandidates.push({ left, right, key: adjacencyKey(leftMatch, rightMatch) });
    }
  }
  adjacencyCandidates.sort((left, right) => compareStrings(left.key, right.key));
  const paired = new Set<number>();
  const correlated = [...finalized];
  for (const candidate of adjacencyCandidates) {
    if (paired.has(candidate.left) || paired.has(candidate.right)) {
      continue;
    }
    const left = unmatched[candidate.left];
    const right = unmatched[candidate.right];
    if (left === undefined || right === undefined) {
      continue;
    }
    paired.add(candidate.left);
    paired.add(candidate.right);
    correlated.push({
      operationId: left.operationId,
      file: left.file,
      byteRange: [
        Math.min(left.byteRange[0], right.byteRange[0]),
        Math.max(left.byteRange[1], right.byteRange[1]),
      ],
      classification: "adjacent",
      evidence: [...left.evidence, ...right.evidence].sort(compareEvidence),
      diagnostics: [],
    });
  }
  correlated.push(...unmatched.filter((_match, index) => !paired.has(index)));

  for (const match of correlated) {
    const applicable = diagnostics.filter((diagnostic) => diagnosticApplies(diagnostic, match));
    match.diagnostics = applicable;
    if (
      match.classification === "text-only" &&
      diagnostics.some((diagnostic) =>
        diagnostic.provider === "ast-grep" &&
        structuralUnavailableCodes.has(diagnostic.code) &&
        diagnosticApplies(diagnostic, match))
    ) {
      match.classification = "unparseable";
      match.diagnostics = applicable.filter((diagnostic) => structuralUnavailableCodes.has(diagnostic.code));
    }
  }

  return {
    matches: correlated.sort(compareMatches),
    diagnostics,
    providerVersions: Object.fromEntries(
      [...versions].sort(([left], [right]) => compareStrings(left, right)),
    ),
  };
}
