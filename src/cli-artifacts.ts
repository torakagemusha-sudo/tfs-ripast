import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { correlateEvidence, normalizeRepositoryPath, type CorrelationResult } from "./evidence.js";
import { snapshotTargets } from "./filesystem.js";
import type { FileSnapshot } from "./planner.js";
import { stableHash, stableJson } from "./output.js";
import { compareStrings } from "./order.js";
import { isReservedProviderPath, type ProviderResult } from "./providers/provider.js";
import { parseEditPlan, parseTransactionRecord } from "./schema.js";
import { maximumProtocolBytes, stdinText, type CliIo } from "./cli-parse.js";
import type { TransactionFileSystem } from "./transaction.js";
import type { Edit, EditPlan, TransactionRecord } from "./types.js";

export const hashPattern = /^sha256:[a-f0-9]{64}$/u;

export const editPlanIdPattern = /^edit-plan:[a-f0-9]{64}$/u;

export const transactionIdPattern = /^transaction-[0-9a-f-]+$/u;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectedEvidenceId(editPlan: EditPlan, index: number): string {
  const evidence = editPlan.evidence[index];
  if (evidence === undefined) {
    throw new Error("Missing edit-plan evidence while validating hashes.");
  }
  return `evidence:${sha256Hex(JSON.stringify([
    evidence.provider,
    evidence.operationId,
    evidence.file,
    evidence.byteRange[0],
    evidence.byteRange[1],
    evidence.matchedTextHash,
  ]))}`;
}

function expectedEditId(edit: Edit): string {
  return `edit:${sha256Hex(stableJson([
    edit.operationIds,
    edit.file,
    edit.byteRange[0],
    edit.byteRange[1],
    edit.replacement,
  ]))}`;
}

export function assertEditPlanHashes(editPlan: EditPlan): void {
  if (editPlan.rewritePlanHash !== stableHash(editPlan.rewritePlan)) {
    throw new Error("Saved edit plan rewrite-plan hash does not match its content.");
  }
  for (let index = 0; index < editPlan.evidence.length; index += 1) {
    if (editPlan.evidence[index]?.id !== expectedEvidenceId(editPlan, index)) {
      throw new Error("Saved edit plan evidence hash does not match its content.");
    }
  }
  for (const edit of editPlan.edits) {
    if (edit.id !== expectedEditId(edit)) {
      throw new Error("Saved edit plan edit hash does not match its content.");
    }
  }
  for (const conflict of editPlan.conflicts) {
    const expected = `conflict:${sha256Hex(stableJson([
      conflict.reason,
      ...[...conflict.editIds].sort(),
    ]))}`;
    if (conflict.id !== expected) {
      throw new Error("Saved edit plan conflict hash does not match its content.");
    }
  }
  const expectedPlanId = `edit-plan:${sha256Hex(stableJson({
    rewritePlanHash: editPlan.rewritePlanHash,
    gitScope: editPlan.gitScope,
    inputFiles: editPlan.inputFiles,
    evidenceIds: editPlan.evidence.map((evidence) => evidence.id),
    edits: editPlan.edits.map((edit) => edit.id),
    conflicts: editPlan.conflicts.map((conflict) => conflict.id),
    diagnostics: editPlan.diagnostics,
  }))}`;
  if (!editPlanIdPattern.test(editPlan.id) || editPlan.id !== expectedPlanId) {
    throw new Error("Saved edit-plan hash does not match its content.");
  }
  for (const input of editPlan.inputFiles) {
    if (!hashPattern.test(input.hash)) {
      throw new Error(`Saved input hash is invalid: ${input.path}`);
    }
  }
}

function canonicalDerivedEditPlan(editPlan: EditPlan): string {
  const { createdAt: _createdAt, ...derived } = editPlan;
  return stableJson(derived);
}

export function assertSavedPlanMatchesDerivation(saved: EditPlan, derived: EditPlan): void {
  if (canonicalDerivedEditPlan(saved) !== canonicalDerivedEditPlan(derived)) {
    throw new Error(
      "Saved edit plan is stale or incomplete: it does not canonically equal the current provider/correlation/planner derivation.",
    );
  }
}

export function assertTransactionHashes(record: TransactionRecord): void {
  if (!transactionIdPattern.test(record.id)) {
    throw new Error("Saved transaction ID is not a safe opaque identifier.");
  }
  if (!hashPattern.test(record.editPlanHash)) {
    throw new Error("Saved transaction edit-plan hash is invalid.");
  }
  for (const file of record.files) {
    if (!hashPattern.test(file.beforeHash) || !hashPattern.test(file.afterHash)) {
      throw new Error(`Saved transaction contains an invalid file hash: ${file.path}`);
    }
  }
}

export async function protocolText(source: string, io: CliIo, cwd: string): Promise<string> {
  const value = source === "-"
    ? await (io.stdin ?? stdinText)()
    : await readFile(resolve(cwd, source), "utf8");
  if (Buffer.byteLength(value) > maximumProtocolBytes) {
    throw new Error(`JSON protocol document exceeds ${String(maximumProtocolBytes)} bytes.`);
  }
  return value;
}

export async function protocolJson(source: string, io: CliIo, cwd: string): Promise<unknown> {
  const text = await protocolText(source, io, cwd);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON protocol document: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadEditPlan(source: string, io: CliIo, cwd: string): Promise<EditPlan> {
  const editPlan = parseEditPlan(await protocolJson(source, io, cwd));
  assertEditPlanHashes(editPlan);
  await assertPlanRootContained(editPlan.rewritePlan.root, cwd);
  return editPlan;
}

export async function loadTransaction(source: string, io: CliIo, cwd: string): Promise<TransactionRecord> {
  const record = parseTransactionRecord(await protocolJson(source, io, cwd));
  assertTransactionHashes(record);
  return record;
}

export function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function isExisting(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function ensureSafeDirectory(
  root: string,
  directory: string,
  fileSystem: TransactionFileSystem,
): Promise<void> {
  const relation = relative(root, directory);
  if (!isContained(root, directory)) {
    throw new Error("Plan output path escapes the rewrite root.");
  }
  let current = root;
  for (const component of relation.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      await fileSystem.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isExisting(error)) {
        throw error;
      }
    }
    const info = await fileSystem.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() || await fileSystem.realpath(current) !== current) {
      throw new Error(`Plan output directory is not a canonical contained directory: ${current}`);
    }
  }
}

async function assertSafePlanOutputParent(
  root: string,
  directory: string,
  fileSystem: TransactionFileSystem,
): Promise<void> {
  const info = await fileSystem.lstat(directory);
  const canonical = await fileSystem.realpath(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    canonical !== directory ||
    !isContained(root, canonical)
  ) {
    throw new Error(`Plan output parent is not a canonical contained directory: ${directory}`);
  }
}

async function assertMissingPlanOutput(path: string, fileSystem: TransactionFileSystem): Promise<void> {
  try {
    await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  throw new Error(`Plan output already exists: ${path}`);
}

async function cleanupPlanSibling(
  path: string,
  fileSystem: TransactionFileSystem,
  attempts = 2,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fileSystem.unlink(path);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return true;
      }
    }
  }
  return false;
}

function planSiblingWarning(root: string, sibling: string): string {
  const prefix = "Plan output was published, but temporary sibling cleanup failed; remove: ";
  const repositoryPath = relative(root, sibling).split(sep).join("/");
  const warning = `${prefix}${repositoryPath}`;
  const maximumWarningBytes = 8 * 1024;
  if (Buffer.byteLength(warning) <= maximumWarningBytes) {
    return warning;
  }
  return `${prefix}${basename(sibling)} (in the plan output parent)`;
}

function protocolSerialization(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertProtocolSerializationFits(value: unknown, label: string): string {
  const serialized = protocolSerialization(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumProtocolBytes) {
    throw new Error(
      `${label} cannot be reloaded: ${String(bytes)} serialized bytes exceeds the ${String(maximumProtocolBytes)}-byte protocol limit.`,
    );
  }
  return serialized;
}

export async function saveEditPlan(
  editPlan: EditPlan,
  destination: string,
  fileSystem: TransactionFileSystem,
): Promise<string | undefined> {
  assertEditPlanHashes(editPlan);
  const serialized = assertProtocolSerializationFits(editPlan, "Generated edit plan");
  const reloaded = parseEditPlan(JSON.parse(serialized) as unknown);
  assertEditPlanHashes(reloaded);
  const root = await fileSystem.realpath(resolve(editPlan.rewritePlan.root));
  const path = resolve(root, destination);
  if (!isContained(root, path)) {
    throw new Error("Plan output path escapes the rewrite root.");
  }
  const parent = dirname(path);
  await ensureSafeDirectory(root, parent, fileSystem);
  // Repeat containment before creating the sibling, closing changes made while directories were prepared.
  await assertSafePlanOutputParent(root, parent, fileSystem);
  await assertMissingPlanOutput(path, fileSystem);
  const sibling = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let siblingState: "unattempted" | "write-attempted" | "owned" | "published" | "cleaned" = "unattempted";
  try {
    siblingState = "write-attempted";
    await fileSystem.writeFile(sibling, serialized, { flag: "wx", mode: 0o600 });
    siblingState = "owned";
    await fileSystem.chmod(sibling, 0o600);
    // Node has no directory-handle-relative link API; repeat the identity gate immediately before publication.
    await assertSafePlanOutputParent(root, parent, fileSystem);
    await assertMissingPlanOutput(path, fileSystem);
    // A same-directory hard link is atomic and, unlike rename, can never replace an existing destination.
    await fileSystem.link(sibling, path);
    siblingState = "published";
  } catch (error) {
    if (siblingState === "owned" || (siblingState === "write-attempted" && !isExisting(error))) {
      if (await cleanupPlanSibling(sibling, fileSystem)) {
        siblingState = "cleaned";
      }
    }
    throw error;
  }
  if (await cleanupPlanSibling(sibling, fileSystem)) {
    siblingState = "cleaned";
    return undefined;
  }
  if (siblingState !== "published") {
    throw new Error("Plan publication did not reach a valid terminal state.");
  }
  return planSiblingWarning(root, sibling);
}

export function canonicalCandidatePath(path: string): string | undefined {
  try {
    const normalized = normalizeRepositoryPath(path, true);
    return normalized === "." || isReservedProviderPath(normalized) ? undefined : normalized;
  } catch {
    return undefined;
  }
}

export async function savedArtifactExclusions(
  source: string,
  cwd: string,
  rewriteRoot: string,
): Promise<ReadonlySet<string>> {
  if (source === "-") {
    return new Set();
  }
  const root = await realpath(resolve(rewriteRoot));
  const artifact = await realpath(resolve(cwd, source));
  if (!isContained(root, artifact) || artifact === root) {
    return new Set();
  }
  const path = canonicalCandidatePath(relative(root, artifact).split(sep).join("/"));
  return path === undefined ? new Set() : new Set([path]);
}

export async function snapshotsForSavedPlan(editPlan: EditPlan): Promise<FileSnapshot[]> {
  return snapshotTargets(editPlan.rewritePlan.root, editPlan.inputFiles.map((input) => input.path));
}

export function correlationForSavedPlan(editPlan: EditPlan): CorrelationResult {
  const grouped = new Map<string, ProviderResult>();
  for (const operation of editPlan.rewritePlan.operations) {
    for (const [provider, version] of Object.entries(editPlan.providerVersions)) {
      grouped.set(stableJson([provider, operation.id]), {
        provider,
        operationId: operation.id,
        version,
        evidence: [],
        diagnostics: [],
        elapsedMs: 0,
      });
    }
  }
  for (const evidence of editPlan.evidence) {
    const key = stableJson([evidence.provider, evidence.operationId]);
    const result = grouped.get(key);
    if (result === undefined) {
      throw new Error(`Saved evidence names an undeclared provider version: ${evidence.provider}.`);
    }
    result.evidence.push(evidence);
  }
  for (const diagnostic of editPlan.diagnostics) {
    if (diagnostic.provider === undefined || diagnostic.operationId === undefined) {
      continue;
    }
    const result = grouped.get(stableJson([diagnostic.provider, diagnostic.operationId]));
    if (result !== undefined) {
      result.diagnostics.push({
        code: diagnostic.code,
        message: diagnostic.message,
        operationId: diagnostic.operationId,
        ...(diagnostic.language === undefined ? {} : { language: diagnostic.language }),
        paths: diagnostic.paths,
      });
    }
  }
  return correlateEvidence([...grouped.values()]);
}

export async function assertPlanRootContained(planRoot: string, cwd: string): Promise<void> {
  const invocationRoot = await realpath(cwd);
  const rewriteRoot = await realpath(resolve(cwd, planRoot));
  if (!isContained(invocationRoot, rewriteRoot)) {
    throw new Error("Saved or supplied plan root is outside the invocation root containment boundary.");
  }
}
