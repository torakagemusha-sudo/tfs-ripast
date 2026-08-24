import { createHash } from "node:crypto";
import {
  normalizeRepositoryPath,
  type CorrelationResult,
  type CorrelatedMatch,
} from "./evidence.js";
import { compareStrings } from "./order.js";
import type {
  CaptureMap,
  Conflict,
  Diagnostic,
  Edit,
  EditPlan,
  FileInput,
  GitScopeAudit,
  RewriteOperation,
  RewritePlan,
} from "./types.js";

export interface FileSnapshot extends FileInput {
  content: Uint8Array;
}

interface DraftEdit {
  operationIds: Set<string>;
  file: string;
  byteRange: [number, number];
  replacement: string;
  evidenceIds: Set<string>;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function expandReplacement(template: string, captures: CaptureMap): string {
  return template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_placeholder, name: string) => {
    const replacement = captures[name];
    if (replacement === undefined) {
      throw new Error(`Replacement capture is missing: ${name}`);
    }
    return replacement;
  });
}

function matchesPolicy(operation: RewriteOperation, match: CorrelatedMatch): boolean {
  const requirement = operation.matchPolicy?.require ?? "eligible";
  if (requirement === "confirmed") {
    return match.classification === "confirmed";
  }
  if (requirement === "structural") {
    return match.evidence.some((item) => item.confidence !== "lexical");
  }
  if (requirement === "lexical") {
    return match.evidence.some((item) => item.confidence === "lexical");
  }
  return match.classification === "confirmed" ||
    match.classification === "ast-only" ||
    match.classification === "text-only" ||
    match.classification === "unparseable";
}

function compareEditsAscending(left: Edit, right: Edit): number {
  return (
    compareStrings(left.file, right.file) ||
    left.byteRange[0] - right.byteRange[0] ||
    left.byteRange[1] - right.byteRange[1] ||
    compareStrings(left.operationIds.join("\u0000"), right.operationIds.join("\u0000")) ||
    compareStrings(left.replacement, right.replacement) ||
    compareStrings(left.id, right.id)
  );
}

function compareEditsDescending(left: Edit, right: Edit): number {
  return (
    compareStrings(left.file, right.file) ||
    right.byteRange[0] - left.byteRange[0] ||
    right.byteRange[1] - left.byteRange[1] ||
    compareStrings(left.operationIds.join("\u0000"), right.operationIds.join("\u0000")) ||
    compareStrings(left.id, right.id)
  );
}

function overlapReason(left: Edit, right: Edit): Conflict["reason"] | undefined {
  const [leftStart, leftEnd] = left.byteRange;
  const [rightStart, rightEnd] = right.byteRange;
  if (leftStart === rightStart && leftEnd === rightEnd) {
    return left.replacement === right.replacement ? undefined : "same-range";
  }
  if (leftEnd <= rightStart || rightEnd <= leftStart) {
    return undefined;
  }
  if (
    (leftStart <= rightStart && rightEnd <= leftEnd) ||
    (rightStart <= leftStart && leftEnd <= rightEnd)
  ) {
    return "nested-overlap";
  }
  return "partial-overlap";
}

function comparePlanDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    compareStrings(left.code, right.code) ||
    compareStrings(left.provider ?? "", right.provider ?? "") ||
    compareStrings(left.operationId ?? "", right.operationId ?? "") ||
    compareStrings(left.language ?? "", right.language ?? "") ||
    compareStrings(left.message, right.message) ||
    compareStrings(left.paths.join("\u0000"), right.paths.join("\u0000"))
  );
}

function expectedCountDiagnostics(
  operations: RewriteOperation[],
  edits: Edit[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const operation of operations) {
    const expected = operation.expectedCount;
    if (expected === undefined) {
      continue;
    }
    const operationEdits = edits.filter((edit) => edit.operationIds.includes(operation.id));
    const count = operationEdits.length;
    const paths = [...new Set(operationEdits.map((edit) => edit.file))].sort(compareStrings);
    const add = (code: string, expectation: string): void => {
      diagnostics.push({
        code,
        message: `Operation ${operation.id} expected ${expectation}, but planned ${count}.`,
        operationId: operation.id,
        paths,
      });
    };
    if (expected.exact !== undefined && count !== expected.exact) {
      add("expected-count-exact", `exactly ${expected.exact} edits`);
    } else if (expected.min !== undefined && count < expected.min) {
      add("expected-count-min", `at least ${expected.min} edits`);
    } else if (expected.max !== undefined && count > expected.max) {
      add("expected-count-max", `at most ${expected.max} edits`);
    }
  }
  return diagnostics;
}

export function buildEditPlan(
  plan: RewritePlan,
  snapshots: FileSnapshot[],
  correlation: CorrelationResult,
  gitScope: GitScopeAudit = {
    repository: false,
    root: plan.root,
    dirty: false,
    mode: "all",
    requireClean: false,
    inputs: [],
  },
): EditPlan {
  const snapshotByPath = new Map<string, Buffer>();
  const inputFiles: FileInput[] = [];
  for (const snapshot of snapshots) {
    const path = normalizeRepositoryPath(snapshot.path);
    if (snapshotByPath.has(path)) {
      throw new Error(`Duplicate snapshot path: ${path}`);
    }
    const content = Buffer.from(snapshot.content);
    if (snapshot.byteLength !== content.byteLength) {
      throw new Error(`Snapshot byte length does not match content: ${path}`);
    }
    if (snapshot.hash !== sha256(content)) {
      throw new Error(`Snapshot hash does not match content: ${path}`);
    }
    snapshotByPath.set(path, content);
    inputFiles.push({
      path,
      hash: snapshot.hash,
      byteLength: snapshot.byteLength,
      mode: snapshot.mode,
      newline: snapshot.newline,
      encoding: snapshot.encoding,
    });
  }
  inputFiles.sort((left, right) => compareStrings(left.path, right.path));

  const operations = new Map(plan.operations.map((item) => [item.id, item]));
  for (const diagnostic of correlation.diagnostics) {
    if (!operations.has(diagnostic.operationId)) {
      throw new Error(`Diagnostic references unknown operation: ${diagnostic.operationId}`);
    }
  }
  const correlated = correlation.matches;
  const normalizedEvidence = correlated
    .flatMap((match) => match.evidence)
    .sort((left, right) => compareStrings(left.id, right.id));
  if (new Set(normalizedEvidence.map((item) => item.id)).size !== normalizedEvidence.length) {
    throw new Error("Correlation result contains duplicate evidence");
  }
  for (const item of normalizedEvidence) {
    if (!operations.has(item.operationId)) {
      throw new Error(`Evidence references unknown operation: ${item.operationId}`);
    }
    const stored = snapshotByPath.get(item.file);
    if (stored === undefined) {
      throw new Error(`Evidence has no immutable snapshot: ${item.file}`);
    }
    const [start, end] = item.byteRange;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > stored.byteLength
    ) {
      throw new Error(`Evidence byte range is outside snapshot: ${item.id}`);
    }
    if (sha256(stored.subarray(start, end)) !== item.matchedTextHash) {
      throw new Error(`Evidence hash does not match immutable snapshot: ${item.id}`);
    }
  }

  const candidates = new Map<string, DraftEdit>();
  const diagnostics: Diagnostic[] = correlation.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  for (const match of correlated) {
    const operation = operations.get(match.operationId);
    if (operation === undefined) {
      throw new Error(`Evidence references unknown operation: ${match.operationId}`);
    }
    if (match.classification === "adjacent") {
      diagnostics.push({
        code: "adjacent-match-unresolved",
        message: `Operation ${operation.id} has adjacent provider spans without a normalization rule.`,
        operationId: operation.id,
        paths: [match.file],
      });
      continue;
    }
    if (match.classification === "unparseable") {
      const policy = operation.matchPolicy?.onUnparseable ?? "skip";
      if (policy === "skip") {
        continue;
      }
      if (policy === "error") {
        diagnostics.push({
          code: "unparseable-match",
          message: `Operation ${operation.id} requires structural interpretation for this match.`,
          operationId: operation.id,
          paths: [match.file],
        });
        continue;
      }
    }
    if (!matchesPolicy(operation, match)) {
      diagnostics.push({
        code: "match-policy-skip",
        message: `Operation ${operation.id} match does not satisfy ${operation.matchPolicy?.require ?? "eligible"}.`,
        operationId: operation.id,
        paths: [match.file],
      });
      continue;
    }

    const replacements = new Map<string, string[]>();
    const missingCaptures: string[] = [];
    for (const item of match.evidence) {
      try {
        const replacement = expandReplacement(operation.replace, item.captures ?? {});
        const ids = replacements.get(replacement);
        if (ids === undefined) {
          replacements.set(replacement, [item.id]);
        } else {
          ids.push(item.id);
        }
      } catch (error) {
        missingCaptures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (replacements.size === 0) {
      diagnostics.push({
        code: "missing-replacement-capture",
        message: missingCaptures[0] ?? `Operation ${operation.id} is missing a replacement capture.`,
        operationId: operation.id,
        paths: [match.file],
      });
      continue;
    }
    for (const [replacement, evidenceIds] of replacements) {
      const successfulIds = replacements.size === 1
        ? match.evidence.map((item) => item.id).sort(compareStrings)
        : evidenceIds.sort(compareStrings);
      const key = stableJson([
        match.file,
        match.byteRange[0],
        match.byteRange[1],
        replacement,
      ]);
      const existing = candidates.get(key);
      if (existing !== undefined) {
        existing.operationIds.add(operation.id);
        for (const evidenceId of successfulIds) {
          existing.evidenceIds.add(evidenceId);
        }
        continue;
      }
      candidates.set(key, {
        operationIds: new Set([operation.id]),
        file: match.file,
        byteRange: [...match.byteRange],
        replacement,
        evidenceIds: new Set(successfulIds),
      });
    }
  }

  let edits: Edit[] = [...candidates.values()].map((candidate) => {
    const operationIds = [...candidate.operationIds].sort(compareStrings);
    const evidenceIds = [...candidate.evidenceIds].sort(compareStrings);
    return {
      id: stableId("edit", [
        operationIds,
        candidate.file,
        candidate.byteRange[0],
        candidate.byteRange[1],
        candidate.replacement,
      ]),
      operationIds,
      file: candidate.file,
      byteRange: candidate.byteRange,
      replacement: candidate.replacement,
      evidenceIds,
    };
  }).sort(compareEditsAscending);
  const conflicts: Conflict[] = [];
  for (let leftIndex = 0; leftIndex < edits.length; leftIndex += 1) {
    const left = edits[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < edits.length; rightIndex += 1) {
      const right = edits[rightIndex];
      if (right === undefined || right.file !== left.file) {
        continue;
      }
      const reason = overlapReason(left, right);
      if (reason === undefined) {
        continue;
      }
      const editIds = [left.id, right.id].sort(compareStrings);
      conflicts.push({
        id: stableId("conflict", [reason, ...editIds]),
        editIds,
        reason,
      });
    }
  }
  conflicts.sort((left, right) => compareStrings(left.id, right.id));
  if (conflicts.length === 0) {
    edits = edits.sort(compareEditsDescending);
  } else {
    for (const path of [...new Set(conflicts.flatMap((conflict) =>
      conflict.editIds.map((id) => edits.find((edit) => edit.id === id)?.file).filter((path): path is string => path !== undefined)))].sort(compareStrings)) {
      diagnostics.push({
        code: "unresolved-conflicts",
        message: "The edit plan contains unresolved conflicts and cannot be transacted.",
        paths: [path],
      });
    }
  }
  diagnostics.push(...expectedCountDiagnostics(plan.operations, edits));
  diagnostics.sort(comparePlanDiagnostics);

  const rewritePlanHash = sha256(stableJson(plan));
  const planIdentity = {
    rewritePlanHash,
    gitScope,
    inputFiles,
    evidenceIds: normalizedEvidence.map((item) => item.id),
    edits: edits.map((edit) => edit.id),
    conflicts: conflicts.map((conflict) => conflict.id),
    diagnostics,
  };
  return {
    version: 1,
    id: stableId("edit-plan", planIdentity),
    rewritePlan: plan,
    rewritePlanHash,
    gitScope,
    inputFiles,
    evidence: normalizedEvidence,
    edits,
    conflicts,
    diagnostics,
    providerVersions: { ...correlation.providerVersions },
    createdAt: new Date().toISOString(),
  };
}
