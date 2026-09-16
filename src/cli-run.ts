import { applySnapshotEdits, renderPreview } from "./diff.js";
import { type CorrelationResult, type MatchClassification } from "./evidence.js";
import { recheckGitScopeClean } from "./git.js";
import {
  diagnosticLines,
  editPlanResult,
  stableJsonLine,
  type CliOutcome,
  type CliResult,
  type PlanningResult,
  type RewritePolicyResult,
} from "./output.js";
import type { FileSnapshot } from "./planner.js";
import {
  appendPreparedTransactionValidations,
  commitTransaction,
  nodeTransactionFileSystem,
  preparedTransactionOutputs,
  preparedTransactionMaximumRecordBytes,
  preparedTransactionPreview,
  updatePreparedTransactionOutputs,
  prepareTransaction,
  verifyTransaction,
} from "./transaction.js";
import {
  resolveValidationInvocations,
  runPreparedValidations,
  runValidations,
  validationsPassed,
  type ValidationInvocation,
} from "./validation.js";
import { assertProtocolSerializationFits, saveEditPlan } from "./cli-artifacts.js";
import { maximumProtocolBytes, type CliIo, type CliRuntime, type CommonOptions } from "./cli-parse.js";
import type {
  AstGrepLanguage,
  Diagnostic,
  EditPlan,
  TransactionRecord,
  TrustedValidationCommand,
  ValidationSpec,
} from "./types.js";

const blockingDiagnosticCodes = new Set([
  "unresolved-conflicts",
  "expected-count-exact",
  "expected-count-min",
  "expected-count-max",
  "adjacent-match-unresolved",
  "missing-replacement-capture",
  "unparseable-match",
]);

function changedBytes(editPlan: EditPlan, snapshots: readonly FileSnapshot[]): number {
  if (editPlan.conflicts.length > 0) {
    const newlineByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.newline]));
    return editPlan.edits.reduce((total, edit) => {
      const replacement = newlineByPath.get(edit.file) === "crlf"
        ? edit.replacement.replace(/\r?\n/gu, "\r\n")
        : edit.replacement;
      return total + Math.max(edit.byteRange[1] - edit.byteRange[0], Buffer.byteLength(replacement));
    }, 0);
  }
  const editsByPath = new Map<string, EditPlan["edits"]>();
  for (const edit of editPlan.edits) {
    const grouped = editsByPath.get(edit.file) ?? [];
    grouped.push(edit);
    editsByPath.set(edit.file, grouped);
  }
  return snapshots.reduce((total, snapshot) => {
    const edits = editsByPath.get(snapshot.path);
    if (edits === undefined || edits.length === 0) {
      return total;
    }
    return total + disjointChangedBytes(snapshot.content, applySnapshotEdits(snapshot, edits));
  }, 0);
}

function classifications(correlation: CorrelationResult): Record<MatchClassification, number> {
  const result: Record<MatchClassification, number> = {
    confirmed: 0,
    "ast-only": 0,
    "text-only": 0,
    adjacent: 0,
    conflicting: 0,
    unparseable: 0,
  };
  for (const match of correlation.matches) {
    result[match.classification] += 1;
  }
  return result;
}

function policyResult(
  editPlan: EditPlan,
  correlation: CorrelationResult,
  snapshots: readonly FileSnapshot[],
  repositoryFiles: number,
): RewritePolicyResult {
  const files = new Set(editPlan.edits.map((edit) => edit.file)).size;
  const actualChangedBytes = changedBytes(editPlan, snapshots);
  const repositoryPercent = repositoryFiles === 0
    ? files === 0 ? 0 : 100
    : (files / repositoryFiles) * 100;
  const actual = {
    files,
    matches: correlation.matches.length,
    changedBytes: actualChangedBytes,
    repositoryFiles,
    repositoryPercent,
  };
  const policy = editPlan.rewritePlan.policy;
  const limits = {
    ...(policy.maxFiles === undefined ? {} : { files: policy.maxFiles }),
    ...(policy.maxMatches === undefined ? {} : { matches: policy.maxMatches }),
    ...(policy.maxChangedBytes === undefined ? {} : { changedBytes: policy.maxChangedBytes }),
    ...(policy.maxRepositoryPercent === undefined ? {} : { repositoryPercent: policy.maxRepositoryPercent }),
  };
  const violations: RewritePolicyResult["violations"] = [];
  if (limits.files !== undefined && actual.files > limits.files) {
    violations.push("files");
  }
  if (limits.matches !== undefined && actual.matches > limits.matches) {
    violations.push("matches");
  }
  if (limits.changedBytes !== undefined && actual.changedBytes > limits.changedBytes) {
    violations.push("changedBytes");
  }
  if (limits.repositoryPercent !== undefined && actual.repositoryPercent > limits.repositoryPercent) {
    violations.push("repositoryPercent");
  }
  return { actual, limits, violations };
}

function invariantResults(editPlan: EditPlan): PlanningResult["invariants"] {
  return editPlan.rewritePlan.operations.flatMap((operation) => {
    const constraint = operation.expectedCount;
    if (constraint === undefined) {
      return [];
    }
    const actual = editPlan.edits.filter((edit) => edit.operationIds.includes(operation.id)).length;
    const passed =
      (constraint.exact === undefined || actual === constraint.exact) &&
      (constraint.min === undefined || actual >= constraint.min) &&
      (constraint.max === undefined || actual <= constraint.max);
    return [{
      operationId: operation.id,
      constraint,
      actual,
      status: passed ? "passed" as const : "failed" as const,
    }];
  });
}

export function planningResult(
  editPlan: EditPlan,
  snapshots: readonly FileSnapshot[],
  correlation: CorrelationResult,
  repositoryFiles: number,
): PlanningResult {
  const preview = editPlan.conflicts.length === 0 ? renderPreview(editPlan, { snapshots }) : "";
  const skippedOrUnparseable: PlanningResult["skippedOrUnparseable"] = [
    ...correlation.matches
      .filter((match) => match.classification === "unparseable" ||
        match.classification === "adjacent" || match.classification === "conflicting")
      .map((match) => ({
        kind: "match" as const,
        operationId: match.operationId,
        file: match.file,
        classification: match.classification,
      })),
    ...editPlan.diagnostics
      .filter((diagnostic) => /(?:skip|unparseable|unsupported|pattern-error)/u.test(diagnostic.code))
      .map((diagnostic) => ({
        kind: "diagnostic" as const,
        code: diagnostic.code,
        ...(diagnostic.operationId === undefined ? {} : { operationId: diagnostic.operationId }),
        paths: diagnostic.paths,
      })),
  ];
  return {
    editPlan,
    correlation,
    classifications: classifications(correlation),
    conflicts: editPlan.conflicts,
    diagnostics: editPlan.diagnostics,
    skippedOrUnparseable,
    changedBytes: changedBytes(editPlan, snapshots),
    invariants: invariantResults(editPlan),
    policy: policyResult(editPlan, correlation, snapshots, repositoryFiles),
    validations: editPlan.rewritePlan.validations,
    validationInvocations: [],
    preview,
  };
}

export function humanPreview(planning: PlanningResult): string {
  const editPlan = planning.editPlan;
  const files = new Set(editPlan.edits.map((edit) => edit.file));
  const summary = `Plan ${editPlan.id}: ${String(editPlan.edits.length)} edit(s) in ${String(files.size)} file(s), ${String(editPlan.conflicts.length)} conflict(s).`;
  const classificationText = (Object.entries(planning.classifications) as Array<[string, number]>)
    .map(([name, count]) => `${name}=${String(count)}`)
    .join(", ");
  const conflicts = planning.conflicts.length === 0
    ? "Conflicts: none"
    : `Conflicts:\n${planning.conflicts.map((conflict) =>
      `- ${conflict.id}: ${conflict.reason} (${conflict.editIds.join(", ")})`).join("\n")}`;
  const skipped = planning.skippedOrUnparseable.length === 0
    ? "Skipped/unparseable: none"
    : `Skipped/unparseable: ${planning.skippedOrUnparseable.map((item) =>
      item.kind === "match" ? `${item.classification}:${item.file}` : `${item.code}:${item.paths.join(",")}`).join("; ")}`;
  const limits = planning.policy.limits;
  const limit = (value: number | undefined): string => value === undefined ? "unlimited" : String(value);
  const policy = [
    `files=${String(planning.policy.actual.files)}/${limit(limits.files)}`,
    `matches=${String(planning.policy.actual.matches)}/${limit(limits.matches)}`,
    `changedBytes=${String(planning.policy.actual.changedBytes)}/${limit(limits.changedBytes)}`,
    `repositoryPercent=${String(planning.policy.actual.repositoryPercent)}/${limit(limits.repositoryPercent)}`,
    `repositoryFiles=${String(planning.policy.actual.repositoryFiles)}`,
    `violations=${planning.policy.violations.length === 0 ? "none" : planning.policy.violations.join(",")}`,
  ].join(", ");
  const invariants = planning.invariants.length === 0
    ? "Expected counts: none"
    : `Expected counts:\n${planning.invariants.map((invariant) => {
      const constraint = [
        invariant.constraint.exact === undefined ? undefined : `exact=${String(invariant.constraint.exact)}`,
        invariant.constraint.min === undefined ? undefined : `min=${String(invariant.constraint.min)}`,
        invariant.constraint.max === undefined ? undefined : `max=${String(invariant.constraint.max)}`,
      ].filter((item): item is string => item !== undefined).join(", ");
      return `- ${invariant.operationId}: ${constraint}, actual=${String(invariant.actual)} ${invariant.status === "passed" ? "PASS" : "FAIL"}`;
    }).join("\n")}`;
  const validations = planning.validations.length === 0
    ? "Validations: none"
    : `Validations:\n${planning.validations.map((validation) => {
      const parameters = [
        validation.type === "prettier" && validation.paths !== undefined
          ? `paths=${validation.paths.join(",")}`
          : undefined,
        validation.cwd === undefined ? undefined : `cwd=${validation.cwd}`,
        validation.timeoutMs === undefined ? undefined : `timeoutMs=${String(validation.timeoutMs)}`,
        validation.maxOutputBytes === undefined ? undefined : `maxOutputBytes=${String(validation.maxOutputBytes)}`,
      ].filter((item): item is string => item !== undefined);
      return `- ${validation.type}${parameters.length === 0 ? "" : `(${parameters.join("; ")})`}`;
    }).join("\n")}`;
  const validationInvocations = planning.validationInvocations.length === 0
    ? "Validation invocations: none"
    : `Validation invocations:\n${planning.validationInvocations.map((invocation) => {
      const source = invocation.source === "named-adapter" ? invocation.adapter : "explicit-command";
      return `- ${source}: executable=${invocation.executable}; argv=${JSON.stringify(invocation.argv)}; cwd=${invocation.cwd}; actualCwd=${invocation.executionCwd}; timeoutMs=${String(invocation.timeoutMs)}; maxOutputBytes=${String(invocation.maxOutputBytes)}; stage=${invocation.stage}; rollback=${invocation.rollbackPolicy}${invocation.configResolution === undefined ? "" : `; config=${invocation.configResolution}`}`;
    }).join("\n")}`;
  const gitScope = planning.editPlan.gitScope;
  const gitScopeAudit = [
    `repository=${String(gitScope.repository)}`,
    `root=${gitScope.root}`,
    gitScope.repositoryRoot === undefined ? undefined : `repositoryRoot=${gitScope.repositoryRoot}`,
    gitScope.head === undefined ? undefined : `head=${gitScope.head}`,
    gitScope.sinceCommit === undefined ? undefined : `sinceCommit=${gitScope.sinceCommit}`,
    `dirty=${String(gitScope.dirty)}`,
    `mode=${gitScope.mode}`,
    `requireClean=${String(gitScope.requireClean)}`,
    `inputs=${gitScope.inputs.map((input) =>
      `${input.path}:worktree=${input.worktreeBlob}${input.indexBlob === undefined ? "" : `:index=${input.indexBlob}`}`).join(",") || "none"}`,
  ].filter((item): item is string => item !== undefined).join("; ");
  const validationPolicy = planning.validationPolicy === undefined
    ? "Validation policy: not resolved"
    : `Validation policy: keepOnCheckFailure=${String(planning.validationPolicy.keepOnCheckFailure)}; rollback=${planning.validationPolicy.rollbackPolicy}; authority=${planning.validationPolicy.authority}`;
  const sections = [
    summary,
    `Classifications: ${classificationText}`,
    conflicts,
    skipped,
    `Changed bytes: ${String(planning.changedBytes)}`,
    `Policy: ${policy}`,
    invariants,
    validations,
    validationInvocations,
    `Git scope audit: ${gitScopeAudit}`,
    validationPolicy,
  ];
  if (planning.preview.length > 0) {
    sections.push(planning.preview);
  }
  return `${sections.join("\n")}\n`;
}

export function emitDiagnostics(io: CliIo, diagnostics: readonly Diagnostic[]): void {
  const rendered = diagnosticLines(diagnostics);
  if (rendered.length > 0) {
    io.stderr(rendered);
  }
}

export function emitResult(io: CliIo, json: boolean, result: CliResult, human?: string): void {
  if (json) {
    io.stdout(stableJsonLine(result));
  } else if (human !== undefined && human.length > 0) {
    io.stdout(human.endsWith("\n") ? human : `${human}\n`);
  }
}

function blockingPlanError(planning: PlanningResult): Error | undefined {
  const editPlan = planning.editPlan;
  if (planning.policy.violations.length > 0) {
    return new Error(
      `Edit plan ${editPlan.id} exceeds rewrite policy limits: ${planning.policy.violations.join(", ")}.`,
    );
  }
  if (editPlan.conflicts.length > 0) {
    return new Error(`Edit plan ${editPlan.id} has unresolved conflicts.`);
  }
  const diagnostic = editPlan.diagnostics.find((item) => blockingDiagnosticCodes.has(item.code));
  return diagnostic === undefined
    ? undefined
    : new Error(`Edit plan ${editPlan.id} has a blocking diagnostic (${diagnostic.code}).`);
}

function validationRequests(
  editPlan: EditPlan,
  options: CommonOptions | { json: boolean },
): Array<ValidationSpec | TrustedValidationCommand> {
  if (!("checks" in options)) {
    return [];
  }
  const authorizedAdapters = new Set(options.checks);
  const authorizedPlanned = editPlan.rewritePlan.validations.filter((validation) => authorizedAdapters.has(validation.type));
  const plannedAdapters = new Set(authorizedPlanned.map((validation) => validation.type));
  const cliChecks: ValidationSpec[] = [...new Set(options.checks)]
    .filter((type) => !plannedAdapters.has(type))
    .map((type) => ({ type }));
  return [...authorizedPlanned, ...cliChecks, ...options.explicitValidations];
}

function disjointChangedBytes(before: Uint8Array, after: Uint8Array): number {
  type Step = "delete" | "insert" | "equal";
  const steps: Step[] = [];
  const append = (step: Step, count: number): void => {
    for (let index = 0; index < count; index += 1) {
      steps.push(step);
    }
  };
  const bisect = (left: Uint8Array, right: Uint8Array): [number, number] | undefined => {
    const leftLength = left.byteLength;
    const rightLength = right.byteLength;
    const maximumDistance = Math.ceil((leftLength + rightLength) / 2);
    const offset = maximumDistance;
    const size = (maximumDistance * 2) + 1;
    const forward = new Int32Array(size);
    const reverse = new Int32Array(size);
    forward.fill(-1);
    reverse.fill(-1);
    forward[offset + 1] = 0;
    reverse[offset + 1] = 0;
    const delta = leftLength - rightLength;
    const oddDelta = delta % 2 !== 0;
    let forwardStart = 0;
    let forwardEnd = 0;
    let reverseStart = 0;
    let reverseEnd = 0;
    for (let distance = 0; distance < maximumDistance; distance += 1) {
      for (let diagonal = -distance + forwardStart; diagonal <= distance - forwardEnd; diagonal += 2) {
        const index = offset + diagonal;
        let x = diagonal === -distance || (diagonal !== distance && forward[index - 1]! < forward[index + 1]!)
          ? forward[index + 1]!
          : forward[index - 1]! + 1;
        let y = x - diagonal;
        while (x < leftLength && y < rightLength && left[x] === right[y]) {
          x += 1;
          y += 1;
        }
        forward[index] = x;
        if (x > leftLength) {
          forwardEnd += 2;
        } else if (y > rightLength) {
          forwardStart += 2;
        } else if (oddDelta) {
          const reverseIndex = offset + delta - diagonal;
          if (reverseIndex >= 0 && reverseIndex < size && reverse[reverseIndex]! !== -1) {
            const reverseX = leftLength - reverse[reverseIndex]!;
            if (x >= reverseX) {
              return [x, y];
            }
          }
        }
      }
      for (let diagonal = -distance + reverseStart; diagonal <= distance - reverseEnd; diagonal += 2) {
        const index = offset + diagonal;
        let x = diagonal === -distance || (diagonal !== distance && reverse[index - 1]! < reverse[index + 1]!)
          ? reverse[index + 1]!
          : reverse[index - 1]! + 1;
        let y = x - diagonal;
        while (x < leftLength && y < rightLength && left[leftLength - x - 1] === right[rightLength - y - 1]) {
          x += 1;
          y += 1;
        }
        reverse[index] = x;
        if (x > leftLength) {
          reverseEnd += 2;
        } else if (y > rightLength) {
          reverseStart += 2;
        } else if (!oddDelta) {
          const forwardIndex = offset + delta - diagonal;
          if (forwardIndex >= 0 && forwardIndex < size && forward[forwardIndex]! !== -1) {
            const forwardX = forward[forwardIndex]!;
            const forwardY = forwardX - (delta - diagonal);
            const reverseX = leftLength - x;
            if (forwardX >= reverseX) {
              return [forwardX, forwardY];
            }
          }
        }
      }
    }
    return undefined;
  };
  const diff = (left: Uint8Array, right: Uint8Array): void => {
    let prefix = 0;
    while (prefix < left.byteLength && prefix < right.byteLength && left[prefix] === right[prefix]) {
      prefix += 1;
    }
    if (prefix > 0) {
      append("equal", prefix);
      left = left.subarray(prefix);
      right = right.subarray(prefix);
    }
    let suffix = 0;
    while (suffix < left.byteLength && suffix < right.byteLength && left[left.byteLength - suffix - 1] === right[right.byteLength - suffix - 1]) {
      suffix += 1;
    }
    const leftMiddle = suffix === 0 ? left : left.subarray(0, left.byteLength - suffix);
    const rightMiddle = suffix === 0 ? right : right.subarray(0, right.byteLength - suffix);
    if (leftMiddle.byteLength === 0) {
      append("insert", rightMiddle.byteLength);
    } else if (rightMiddle.byteLength === 0) {
      append("delete", leftMiddle.byteLength);
    } else {
      const split = bisect(leftMiddle, rightMiddle);
      if (split === undefined || (split[0] === 0 && split[1] === 0) ||
        (split[0] === leftMiddle.byteLength && split[1] === rightMiddle.byteLength)) {
        append("delete", leftMiddle.byteLength);
        append("insert", rightMiddle.byteLength);
      } else {
        diff(leftMiddle.subarray(0, split[0]), rightMiddle.subarray(0, split[1]));
        diff(leftMiddle.subarray(split[0]), rightMiddle.subarray(split[1]));
      }
    }
    append("equal", suffix);
  };
  diff(before, after);
  let changed = 0;
  let deleted = 0;
  let inserted = 0;
  const flush = (): void => {
    changed += Math.max(deleted, inserted);
    deleted = 0;
    inserted = 0;
  };
  for (const step of steps) {
    if (step === "equal") {
      flush();
    } else if (step === "delete") {
      deleted += 1;
    } else {
      inserted += 1;
    }
  }
  flush();
  return changed;
}

function changedPreparedBytes(outputs: ReturnType<typeof preparedTransactionOutputs>): number {
  return outputs.reduce((total, output) => total + disjointChangedBytes(output.before, output.after), 0);
}

async function validationPreviews(
  requests: readonly (ValidationSpec | TrustedValidationCommand)[],
  editPlan: EditPlan,
  runtime: CliRuntime,
  keepOnCheckFailure: boolean,
): Promise<ValidationInvocation[]> {
  const context = {
    root: editPlan.rewritePlan.root,
    changedPaths: [...new Set(editPlan.edits.map((edit) => edit.file))],
    ...(runtime.validationExecutables === undefined ? {} : { executables: runtime.validationExecutables }),
    ...(runtime.validationEnv === undefined ? {} : { env: runtime.validationEnv }),
    ...(keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
  };
  const [precommit, postcommit] = await Promise.all([
    resolveValidationInvocations(requests, { ...context, stage: "precommit" }),
    resolveValidationInvocations(requests, { ...context, stage: "postcommit" }),
  ]);
  return [...precommit, ...postcommit];
}

export async function runEditPlan(
  command: "rewrite" | "plan" | "inspect" | "apply",
  planning: PlanningResult,
  options: CommonOptions | { json: boolean },
  io: CliIo,
  runtime: CliRuntime,
): Promise<number> {
  const editPlan = planning.editPlan;
  const requests = validationRequests(editPlan, options);
  const keepOnCheckFailure = editPlan.rewritePlan.policy.keepOnCheckFailure === true ||
    ("keepOnCheckFailure" in options && options.keepOnCheckFailure);
  const validationPolicy: TransactionRecord["validationPolicy"] = {
    keepOnCheckFailure,
    rollbackPolicy: keepOnCheckFailure ? "keep-on-failure" : "rollback-on-failure",
    authority: "keepOnCheckFailure" in options && options.keepOnCheckFailure
      ? "cli-override"
      : editPlan.rewritePlan.policy.keepOnCheckFailure === true ? "plan" : "default",
  };
  planning.validationPolicy = validationPolicy;
  const authorizedNamed = requests.filter((request): request is ValidationSpec => "type" in request);
  planning.validations = [
    ...editPlan.rewritePlan.validations,
    ...authorizedNamed.filter((request) => !editPlan.rewritePlan.validations.some((planned) => planned.type === request.type)),
  ];
  planning.validationInvocations = await validationPreviews(requests, editPlan, runtime, keepOnCheckFailure);
  emitDiagnostics(io, editPlan.diagnostics);
  const blocked = blockingPlanError(planning);
  if (blocked !== undefined) {
    if (editPlan.diagnostics.length === 0 || planning.policy.violations.length > 0) {
      io.stderr(`${blocked.message}\n`);
    }
    const outcome: CliOutcome = editPlan.conflicts.length > 0 ? "conflict" : "invalid";
    emitResult(io, options.json, editPlanResult(command, outcome, 1, planning), humanPreview(planning));
    return 1;
  }
  if ("planOut" in options && options.planOut !== undefined) {
    const publicationWarning = await saveEditPlan(
      editPlan,
      options.planOut,
      runtime.fileSystem ?? nodeTransactionFileSystem,
    );
    if (publicationWarning !== undefined) {
      io.stderr(`${publicationWarning}\n`);
    }
  }
  if (editPlan.edits.length === 0) {
    emitResult(io, options.json, editPlanResult(command, "no-op", 0, planning), humanPreview(planning));
    return 0;
  }

  // This is deliberately before preview/prompt: it is a no-write stale/encoding/containment gate.
  const prepared = await prepareTransaction(
    editPlan,
    {
      ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
      validationPolicy,
    },
  );
  if (command === "inspect") {
    emitResult(io, options.json, editPlanResult(command, "inspected", 0, planning), humanPreview(planning));
    return 0;
  }
  const preparedOutputs = preparedTransactionOutputs(prepared);
  const preparedLanguageByPath = new Map<string, AstGrepLanguage>();
  for (const evidence of editPlan.evidence) {
    if (evidence.language !== undefined && !preparedLanguageByPath.has(evidence.file)) {
      preparedLanguageByPath.set(evidence.file, evidence.language);
    }
  }
  const namedRequests = requests.filter((request): request is ValidationSpec => "type" in request);
  const preparedValidation = await runPreparedValidations(
    namedRequests,
    preparedOutputs.map((output) => ({
      path: output.path,
      content: output.after,
      mode: output.afterMode,
      ...(preparedLanguageByPath.get(output.path) === undefined
        ? {}
        : { language: preparedLanguageByPath.get(output.path)! }),
    })),
    {
      root: editPlan.rewritePlan.root,
      ...(runtime.validationExecutables === undefined ? {} : { executables: runtime.validationExecutables }),
      ...(runtime.validationEnv === undefined ? {} : { env: runtime.validationEnv }),
      ...(runtime.astGrepExecutable === undefined ? {} : { astGrepExecutable: runtime.astGrepExecutable }),
      ...(keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
    },
  );
  planning.validationInvocations = [
    ...preparedValidation.invocations,
    ...planning.validationInvocations.filter((invocation) => invocation.stage === "postcommit"),
  ];
  if (!validationsPassed(preparedValidation.results)) {
    for (const validation of preparedValidation.results) {
      if (validation.output.length > 0) {
        io.stderr(`${validation.output}${validation.output.endsWith("\n") ? "" : "\n"}`);
      }
    }
    emitResult(io, options.json, editPlanResult(command, "failed", 1, planning), humanPreview(planning));
    return 1;
  }
  updatePreparedTransactionOutputs(prepared, preparedValidation.outputs);
  appendPreparedTransactionValidations(prepared, preparedValidation.results);
  if (preparedValidation.results.length > 0) {
    planning.preview = preparedTransactionPreview(prepared);
    planning.changedBytes = changedPreparedBytes(preparedTransactionOutputs(prepared));
    planning.policy.actual.changedBytes = planning.changedBytes;
    const changedBytesLimit = planning.policy.limits.changedBytes;
    const violation = changedBytesLimit !== undefined && planning.changedBytes > changedBytesLimit;
    planning.policy.violations = planning.policy.violations.filter((item) => item !== "changedBytes");
    if (violation) {
      planning.policy.violations.push("changedBytes");
      io.stderr("Prepared formatter output exceeds the rewrite changed-bytes policy.\n");
      emitResult(io, options.json, editPlanResult(command, "invalid", 1, planning), humanPreview(planning));
      return 1;
    }
  }
  const maximumRecordBytes = preparedTransactionMaximumRecordBytes(
    prepared,
    planning.validationInvocations.filter((invocation) => invocation.stage === "postcommit"),
  );
  if (maximumRecordBytes > maximumProtocolBytes) {
    throw new Error(
      `Worst-case transaction record JSON serialization can require ${String(maximumRecordBytes)} bytes, exceeding the loader limit of ${String(maximumProtocolBytes)} bytes.`,
    );
  }
  const preview = humanPreview(planning);
  const writeOptions = options as CommonOptions;
  if (writeOptions.json && writeOptions.write && planning.validationInvocations.length > 0) {
    io.stderr(preview);
  }
  if (!writeOptions.json) {
    io.stdout(preview);
  }
  const shouldPrompt = !writeOptions.write && !writeOptions.dryRun && io.isTTY;
  if (!writeOptions.write && !shouldPrompt) {
    emitResult(io, writeOptions.json, editPlanResult(command, "previewed", 0, planning));
    return 0;
  }
  if (shouldPrompt) {
    const prompt = "Apply all changes? [y/N] ";
    if (writeOptions.json) {
      io.stderr(preview);
      io.stderr(prompt);
    } else {
      io.stdout(prompt);
    }
    let confirmed = false;
    try {
      confirmed = await io.confirm();
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      emitResult(io, writeOptions.json, editPlanResult(command, "declined", 0, planning), "Declined; no files changed.\n");
      return 0;
    }
  }

  const record = await commitTransaction(prepared, {
    beforeFirstSourceWrite: async () => recheckGitScopeClean(editPlan.gitScope, {
      ...(runtime.gitExecutable === undefined ? {} : { executable: runtime.gitExecutable }),
    }),
    runPostcommitValidations: async () => runValidations(requests, {
      root: editPlan.rewritePlan.root,
      stage: "postcommit",
      changedPaths: preparedOutputs.map((output) => output.path),
      ...(runtime.validationExecutables === undefined ? {} : { executables: runtime.validationExecutables }),
      ...(runtime.validationEnv === undefined ? {} : { env: runtime.validationEnv }),
      ...(keepOnCheckFailure ? { keepOnCheckFailure: true } : {}),
    }),
  });
  const validationResults = record.validations;
  const postcommitResults = record.validations.slice(preparedValidation.results.length);
  let finalHashesVerified = true;
  if (record.state === "committed" || record.state === "rolled-back") {
    const verification = await verifyTransaction(record, {
      root: editPlan.rewritePlan.root,
      ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
    });
    finalHashesVerified = verification.ok;
    if (!verification.ok) {
      for (const diagnostic of verification.diagnostics) {
        io.stderr(`${diagnostic}\n`);
      }
    }
  }
  const checksPassed = validationsPassed(validationResults) && finalHashesVerified;
  for (const validation of postcommitResults) {
    if (validation.status !== "passed" && validation.output.length > 0) {
      io.stderr(`${validation.output}${validation.output.endsWith("\n") ? "" : "\n"}`);
    }
  }
  const outcome: CliOutcome = record.state === "partial-commit"
    ? "partial-commit"
    : record.state === "committed" && checksPassed ? "written" : "failed";
  const exitCode = record.state === "partial-commit" ? 3 : record.state === "committed" && checksPassed ? 0 : 1;
  emitResult(
    io,
    writeOptions.json,
    editPlanResult(command, outcome, exitCode, planning, record),
    record.state === "committed"
      ? `Committed transaction ${record.id}.\n`
      : `Transaction ${record.id} ended in state ${record.state}.\n`,
  );
  return exitCode;
}
