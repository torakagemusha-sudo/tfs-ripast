import { createHash } from "node:crypto";
import type { CorrelationResult, MatchClassification } from "./evidence.js";
import { compareStrings } from "./order.js";
import type { Diagnostic, EditPlan, ExpectedCount, TransactionRecord, ValidationSpec } from "./types.js";
import type { UndoPreview, VerificationReport } from "./transaction.js";
import type { ValidationInvocation } from "./validation.js";

export type CliOutcome =
  | "previewed"
  | "written"
  | "no-op"
  | "declined"
  | "inspected"
  | "verified"
  | "verification-failed"
  | "undone"
  | "conflict"
  | "invalid"
  | "provider-failure"
  | "failed"
  | "partial-commit";

export interface CliResult {
  version: 1;
  command: string;
  outcome: CliOutcome;
  exitCode: number;
  editPlanId?: string;
  transactionId?: string;
  files?: string[];
  edits?: number;
  conflicts?: number;
  diagnostics?: string[];
  state?: TransactionRecord["state"];
  verification?: VerificationReport;
  planning?: PlanningOutput;
  undoPreview?: UndoPreview;
}

export interface RewritePolicyResult {
  actual: {
    files: number;
    matches: number;
    changedBytes: number;
    repositoryFiles: number;
    repositoryPercent: number;
  };
  limits: {
    files?: number;
    matches?: number;
    changedBytes?: number;
    repositoryPercent?: number;
  };
  violations: Array<"files" | "matches" | "changedBytes" | "repositoryPercent">;
}

export interface PlanningResult {
  editPlan: EditPlan;
  correlation: CorrelationResult;
  classifications: Record<MatchClassification, number>;
  conflicts: EditPlan["conflicts"];
  diagnostics: Diagnostic[];
  skippedOrUnparseable: Array<
    | { kind: "match"; operationId: string; file: string; classification: MatchClassification }
    | { kind: "diagnostic"; code: string; operationId?: string; paths: string[] }
  >;
  changedBytes: number;
  invariants: Array<{
    operationId: string;
    constraint: ExpectedCount;
    actual: number;
    status: "passed" | "failed";
  }>;
  policy: RewritePolicyResult;
  validations: ValidationSpec[];
  validationInvocations: ValidationInvocation[];
  validationPolicy?: TransactionRecord["validationPolicy"];
  preview: string;
}

/** Stable protocol view: volatile construction time is intentionally excluded. */
export type PlanningOutput = Omit<PlanningResult, "editPlan"> & {
  editPlan: Omit<EditPlan, "createdAt">;
};

export function stableValue(value: unknown): unknown {
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

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function stableJsonLine(value: unknown): string {
  return `${stableJson(value)}\n`;
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function editPlanResult(
  command: string,
  outcome: CliOutcome,
  exitCode: number,
  planning: PlanningResult,
  transaction?: TransactionRecord,
): CliResult {
  const editPlan = planning.editPlan;
  const { createdAt: _createdAt, ...stableEditPlan } = editPlan;
  const stablePlanning: PlanningOutput = { ...planning, editPlan: stableEditPlan };
  const files = [...new Set(editPlan.edits.map((edit) => edit.file))].sort(compareStrings);
  return {
    version: 1,
    command,
    outcome,
    exitCode,
    editPlanId: editPlan.id,
    files,
    edits: editPlan.edits.length,
    conflicts: editPlan.conflicts.length,
    diagnostics: editPlan.diagnostics.map((diagnostic) => diagnostic.code),
    planning: stablePlanning,
    ...(transaction === undefined ? {} : {
      transactionId: transaction.id,
      state: transaction.state,
    }),
  };
}

export function diagnosticLines(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const scope = [
        diagnostic.provider,
        diagnostic.operationId,
        diagnostic.language,
        ...diagnostic.paths,
      ].filter((item): item is string => item !== undefined && item.length > 0);
      return `${diagnostic.code}${scope.length === 0 ? "" : ` [${scope.join(", ")}]`}: ${diagnostic.message}\n`;
    })
    .join("");
}
