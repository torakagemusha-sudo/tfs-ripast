import type { EditPlan, RewritePlan, TransactionRecord } from "./types.js";

/**
 * Cross-object protocol rules that JSON Schema cannot express. Every consumer
 * must run or faithfully mirror this named version-one contract after JSON
 * Schema structural validation.
 */
export const SEMANTIC_VALIDATION_CONTRACT =
  "https://torafirma.dev/schemas/tfs-ripast/semantic-validation/v1";

export class ProtocolSemanticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolSemanticError";
  }
}

function requireUnique(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ProtocolSemanticError(`${label} must be unique: ${id}`);
    }
    seen.add(id);
  }
}

function requireOrderedRange(range: readonly [number, number], label: string): void {
  if (range[0] > range[1]) {
    throw new ProtocolSemanticError(`${label} start must not exceed end`);
  }
}

export function validateRewritePlanSemantics(plan: RewritePlan): void {
  requireUnique(plan.operations.map((operation) => operation.id), "operation IDs");
  for (const operation of plan.operations) {
    const expected = operation.expectedCount;
    if (expected === undefined) {
      continue;
    }
    if (Object.keys(expected).length === 0) {
      throw new ProtocolSemanticError("expectedCount must not be empty");
    }
    if (expected.min !== undefined && expected.max !== undefined && expected.min > expected.max) {
      throw new ProtocolSemanticError("expectedCount min must not exceed max");
    }
  }
}

export function validateEditPlanSemantics(editPlan: EditPlan): void {
  validateRewritePlanSemantics(editPlan.rewritePlan);
  requireUnique(editPlan.inputFiles.map((file) => file.path), "input file paths");
  requireUnique(editPlan.gitScope.inputs.map((file) => file.path), "Git scope input paths");
  requireUnique(editPlan.evidence.map((evidence) => evidence.id), "evidence IDs");
  requireUnique(editPlan.edits.map((edit) => edit.id), "edit IDs");
  requireUnique(editPlan.conflicts.map((conflict) => conflict.id), "conflict IDs");

  const operationIds = new Set(editPlan.rewritePlan.operations.map((operation) => operation.id));
  const inputPaths = new Set(editPlan.inputFiles.map((file) => file.path));
  const gitInputPaths = new Set(editPlan.gitScope.inputs.map((file) => file.path));
  for (const identity of editPlan.gitScope.inputs) {
    if (!inputPaths.has(identity.path)) {
      throw new ProtocolSemanticError(`Git scope identity references unknown input: ${identity.path}`);
    }
  }
  if (editPlan.gitScope.repository && editPlan.gitScope.repositoryRoot === undefined) {
    throw new ProtocolSemanticError("repository Git scope requires canonical repositoryRoot");
  }
  if (!editPlan.gitScope.repository && editPlan.gitScope.inputs.length > 0) {
    throw new ProtocolSemanticError("non-repository Git scope cannot contain blob identities");
  }
  if (editPlan.gitScope.repository && (gitInputPaths.size !== inputPaths.size || [...inputPaths].some((path) => !gitInputPaths.has(path)))) {
    throw new ProtocolSemanticError("repository Git scope must contain a blob identity for every input file");
  }
  if ((editPlan.gitScope.mode === "since") !== (editPlan.gitScope.sinceCommit !== undefined)) {
    throw new ProtocolSemanticError("since Git scope must carry exactly one resolved since commit");
  }
  const evidenceById = new Map(editPlan.evidence.map((evidence) => [evidence.id, evidence]));
  const editIds = new Set(editPlan.edits.map((edit) => edit.id));

  for (const evidence of editPlan.evidence) {
    if (!operationIds.has(evidence.operationId)) {
      throw new ProtocolSemanticError(`evidence references unknown operation: ${evidence.operationId}`);
    }
    requireOrderedRange(evidence.byteRange, `evidence ${evidence.id} byte range`);
    requireOrderedRange(evidence.lineRange, `evidence ${evidence.id} line range`);
  }
  for (const edit of editPlan.edits) {
    requireUnique(edit.operationIds, `operation references for edit ${edit.id}`);
    if (edit.operationIds.length === 0) {
      throw new ProtocolSemanticError(`edit must reference at least one operation: ${edit.id}`);
    }
    if ([...edit.operationIds].sort().some((operationId, index) => operationId !== edit.operationIds[index])) {
      throw new ProtocolSemanticError(`edit operation references must be sorted: ${edit.id}`);
    }
    for (const operationId of edit.operationIds) {
      if (!operationIds.has(operationId)) {
        throw new ProtocolSemanticError(`edit references unknown operation: ${operationId}`);
      }
    }
    requireOrderedRange(edit.byteRange, `edit ${edit.id} byte range`);
    requireUnique(edit.evidenceIds, `evidence references for edit ${edit.id}`);
    const evidencedOperations = new Set<string>();
    for (const evidenceId of edit.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence === undefined) {
        throw new ProtocolSemanticError(`edit references unknown evidence: ${evidenceId}`);
      }
      if (!edit.operationIds.includes(evidence.operationId)) {
        throw new ProtocolSemanticError(`edit evidence operation does not match: ${evidenceId}`);
      }
      evidencedOperations.add(evidence.operationId);
    }
    for (const operationId of edit.operationIds) {
      if (!evidencedOperations.has(operationId)) {
        throw new ProtocolSemanticError(`edit operation has no evidence: ${operationId}`);
      }
    }
  }
  for (const conflict of editPlan.conflicts) {
    requireUnique(conflict.editIds, `edit references for conflict ${conflict.id}`);
    for (const editId of conflict.editIds) {
      if (!editIds.has(editId)) {
        throw new ProtocolSemanticError(`conflict references unknown edit: ${editId}`);
      }
    }
  }
}

export function validateTransactionRecordSemantics(record: TransactionRecord): void {
  requireUnique(record.changedPaths, "changed paths");
  requireUnique(record.files.map((file) => file.path), "transaction file paths");
  const changedPaths = new Set(record.changedPaths);
  for (const file of record.files) {
    if (!changedPaths.has(file.path)) {
      throw new ProtocolSemanticError(`transaction file is not a changed path: ${file.path}`);
    }
  }
}
