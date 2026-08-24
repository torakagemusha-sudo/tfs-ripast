import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { applySnapshotEdits, renderUnifiedDiff } from "./diff.js";
import { normalizeRepositoryPath } from "./evidence.js";
import { sha256 } from "./filesystem.js";
import { compareStrings } from "./order.js";
import type { FileSnapshot } from "./planner.js";
import { transactionRecordSchema } from "./schema.js";
import { validateEditPlanSemantics, validateTransactionRecordSemantics } from "./semantic.js";
import type { Edit, EditPlan, FileInput, TransactionRecord, ValidationResult } from "./types.js";
import type { ValidationInvocation } from "./validation.js";

export interface TransactionFileSystem {
  readFile(path: string): Promise<Buffer>;
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { flag?: string; mode?: number },
  ): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  link(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
}

export const nodeTransactionFileSystem: TransactionFileSystem = {
  readFile: async (path) => readFile(path),
  writeFile: async (path, data, options) => writeFile(path, data, options),
  rename: async (source, destination) => rename(source, destination),
  link: async (source, destination) => link(source, destination),
  unlink: async (path) => unlink(path),
  chmod: async (path, mode) => chmod(path, mode),
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  stat: async (path) => stat(path),
  lstat: async (path) => lstat(path),
  realpath: async (path) => realpath(path),
};

export interface TransactionOptions {
  fileSystem?: TransactionFileSystem;
  validationPolicy?: TransactionRecord["validationPolicy"];
}

export interface CommitTransactionOptions {
  beforeFirstSourceWrite?: () => Promise<void>;
  runPostcommitValidations?: () => Promise<ValidationResult[]>;
}

interface PreparedInput {
  input: FileInput;
  device: number;
  inode: number;
}

interface PreparedFile {
  path: string;
  before: Buffer;
  after: Buffer;
  beforeHash: string;
  afterHash: string;
  beforeMode: number;
  afterMode: number;
}

declare const preparedTransactionBrand: unique symbol;

/** Opaque capability returned only by prepareTransaction. */
export interface PreparedTransaction {
  readonly [preparedTransactionBrand]: true;
}

interface PreparedTransactionState {
  id: string;
  root: string;
  editPlan: EditPlan;
  editPlanHash: string;
  startedAt: string;
  files: PreparedFile[];
  inputs: PreparedInput[];
  validations: ValidationResult[];
  validationPolicy: TransactionRecord["validationPolicy"];
  fileSystem: TransactionFileSystem;
}

export interface PreparedTransactionOutput {
  path: string;
  before: Uint8Array;
  after: Uint8Array;
  beforeMode: number;
  afterMode: number;
}

export interface VerificationFile {
  path: string;
  expectedHash: string;
  actualHash?: string;
  expectedMode: number;
  actualMode?: number;
  matches: boolean;
}

export interface VerificationReport {
  ok: boolean;
  state: TransactionRecord["state"];
  files: VerificationFile[];
  diagnostics: string[];
}

export interface UndoPreview {
  patch: string;
  storedInversePatchMatches: boolean;
  files: Array<{
    path: string;
    currentHash: string;
    beforeHash: string;
    currentMode: number;
    beforeMode: number;
  }>;
}

export interface TransactionLookupOptions extends TransactionOptions {
  root?: string;
}

interface RecordContext {
  root: string;
  fileSystem: TransactionFileSystem;
}

interface SiblingFiles {
  file: PreparedFile;
  absolutePath: string;
  beforePath: string;
  afterPath: string;
}

const recordContexts = new WeakMap<TransactionRecord, RecordContext>();
const preparedTransactions = new WeakMap<PreparedTransaction, PreparedTransactionState>();
const reservedTopLevelPaths = new Set([".git", ".tfs-ripast"]);
const blockingDiagnosticCodes = new Set([
  "unresolved-conflicts",
  "expected-count-exact",
  "expected-count-min",
  "expected-count-max",
  "adjacent-match-unresolved",
  "missing-replacement-capture",
  "unparseable-match",
]);
const maximumProtocolBytes = 8 * 1024 * 1024;
const maximumInternalAuditBytes = 4 * 1024;

function boundedAuditMessage(value: unknown): string {
  const source = value instanceof Error ? value.message : String(value);
  const bytes = Buffer.from(source, "utf8");
  return bytes.byteLength <= maximumInternalAuditBytes
    ? source
    : bytes.subarray(0, maximumInternalAuditBytes).toString("utf8");
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

function editPlanHash(editPlan: EditPlan): string {
  return sha256(JSON.stringify(stableValue(editPlan)));
}

function assertTransactable(editPlan: EditPlan): void {
  if (editPlan.conflicts.length > 0) {
    throw new Error(`Edit plan ${editPlan.id} has unresolved conflicts and cannot be transacted`);
  }
  const blocking = editPlan.diagnostics.find((diagnostic) => blockingDiagnosticCodes.has(diagnostic.code));
  if (blocking !== undefined) {
    const kind = blocking.code.startsWith("expected-count-") ? "invariant failure" : "blocking diagnostic";
    throw new Error(`Edit plan ${editPlan.id} has an ${kind} (${blocking.code}) and cannot be transacted`);
  }
}

function assertNonReservedRepositoryPath(path: string, allowRoot = false): string {
  const normalized = normalizeRepositoryPath(path, allowRoot);
  const [topLevel] = normalized.split("/");
  if (topLevel !== undefined && reservedTopLevelPaths.has(topLevel)) {
    throw new Error(`Transaction target uses reserved repository path: ${normalized}`);
  }
  return normalized;
}

function assertEditPlanTargetsAllowed(editPlan: EditPlan): void {
  for (const operation of editPlan.rewritePlan.operations) {
    for (const path of operation.paths) {
      assertNonReservedRepositoryPath(path, true);
    }
  }
  for (const input of editPlan.inputFiles) {
    assertNonReservedRepositoryPath(input.path);
  }
  for (const evidence of editPlan.evidence) {
    assertNonReservedRepositoryPath(evidence.file);
  }
  for (const edit of editPlan.edits) {
    assertNonReservedRepositoryPath(edit.file);
  }
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isExisting(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function resolveContainedFile(
  root: string,
  path: string,
  fs: TransactionFileSystem,
): Promise<string> {
  const normalized = assertNonReservedRepositoryPath(path);
  const lexical = resolve(root, normalized);
  const realParent = await fs.realpath(dirname(lexical));
  if (!isContained(root, realParent)) {
    throw new Error(`Target real parent escapes repository containment: ${path}`);
  }
  const candidate = join(realParent, basename(lexical));
  const candidateInfo = await fs.lstat(candidate);
  if (candidateInfo.isSymbolicLink()) {
    throw new Error(`Transaction targets cannot be symlinks: ${path}`);
  }
  const canonical = await fs.realpath(candidate);
  if (!isContained(root, canonical)) {
    throw new Error(`Target escapes repository containment: ${path}`);
  }
  const canonicalRelative = relative(root, canonical).split(sep).join("/");
  assertNonReservedRepositoryPath(canonicalRelative);
  if (canonicalRelative !== normalized) {
    throw new Error(`Target path is not canonical within the repository: ${path}`);
  }
  if (!candidateInfo.isFile()) {
    throw new Error(`Transaction target is not a regular file: ${path}`);
  }
  return canonical;
}

async function readStableFile(
  root: string,
  path: string,
  fs: TransactionFileSystem,
): Promise<{ absolutePath: string; content: Buffer; info: Stats }> {
  const absolutePath = await resolveContainedFile(root, path, fs);
  const before = await fs.stat(absolutePath);
  const content = await fs.readFile(absolutePath);
  const after = await fs.stat(absolutePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error(`Transaction input changed while being read: ${path}`);
  }
  return { absolutePath, content, info: after };
}

function actualNewline(content: Buffer): FileInput["newline"] {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0d) {
      if (content[index + 1] === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (content[index] === 0x0a) {
      lf += 1;
    }
  }
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0);
  if (kinds === 0) {
    return "none";
  }
  if (kinds > 1 || cr > 0) {
    return "mixed";
  }
  return crlf > 0 ? "crlf" : "lf";
}

function isUtf8(content: Buffer): boolean {
  if (content.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function editsByPath(editPlan: EditPlan): Map<string, Edit[]> {
  const grouped = new Map<string, Edit[]>();
  for (const edit of editPlan.edits) {
    const path = assertNonReservedRepositoryPath(edit.file);
    const edits = grouped.get(path) ?? [];
    edits.push(edit);
    grouped.set(path, edits);
  }
  return grouped;
}

/** Computes all outputs and validates snapshot identities without writing any file. */
export async function prepareTransaction(
  editPlan: EditPlan,
  options: TransactionOptions = {},
): Promise<PreparedTransaction> {
  assertTransactable(editPlan);
  assertEditPlanTargetsAllowed(editPlan);
  validateEditPlanSemantics(editPlan);
  const fs = options.fileSystem ?? nodeTransactionFileSystem;
  const root = await fs.realpath(resolve(editPlan.rewritePlan.root));
  if (!(await fs.stat(root)).isDirectory()) {
    throw new Error(`Transaction root is not a directory: ${editPlan.rewritePlan.root}`);
  }
  const groupedEdits = editsByPath(editPlan);
  const knownInputs = new Set(editPlan.inputFiles.map((input) => input.path));
  for (const path of groupedEdits.keys()) {
    if (!knownInputs.has(path)) {
      throw new Error(`Edited file has no immutable input snapshot: ${path}`);
    }
  }

  const inputs: PreparedInput[] = [];
  const files: PreparedFile[] = [];
  for (const input of [...editPlan.inputFiles].sort((left, right) => compareStrings(left.path, right.path))) {
    const current = await readStableFile(root, input.path, fs);
    const currentMode = current.info.mode & 0o7777;
    if (
      sha256(current.content) !== input.hash ||
      current.content.byteLength !== input.byteLength ||
      currentMode !== input.mode ||
      actualNewline(current.content) !== input.newline
    ) {
      throw new Error(`Stale transaction input hash, mode, or newline metadata: ${input.path}`);
    }
    inputs.push({
      input: Object.freeze({ ...input }),
      device: current.info.dev,
      inode: current.info.ino,
    });
    const fileEdits = groupedEdits.get(input.path);
    if (fileEdits === undefined || fileEdits.length === 0) {
      continue;
    }
    if (input.encoding !== "utf-8" || !isUtf8(current.content)) {
      throw new Error(`Edited file is not writable UTF-8: ${input.path}`);
    }
    const snapshot: FileSnapshot = {
      ...input,
      content: Uint8Array.from(current.content),
    };
    const after = applySnapshotEdits(snapshot, fileEdits);
    files.push({
      path: input.path,
      before: Buffer.from(current.content),
      after,
      beforeHash: input.hash,
      afterHash: sha256(after),
      beforeMode: input.mode,
      afterMode: input.mode,
    });
  }

  const handle = Object.freeze({}) as PreparedTransaction;
  preparedTransactions.set(handle, {
    id: `transaction-${randomUUID()}`,
    root,
    editPlan,
    editPlanHash: editPlanHash(editPlan),
    startedAt: new Date().toISOString(),
    files,
    inputs,
    validations: [],
    validationPolicy: options.validationPolicy ?? {
      keepOnCheckFailure: editPlan.rewritePlan.policy.keepOnCheckFailure === true,
      rollbackPolicy: editPlan.rewritePlan.policy.keepOnCheckFailure === true
        ? "keep-on-failure"
        : "rollback-on-failure",
      authority: editPlan.rewritePlan.policy.keepOnCheckFailure === true ? "plan" : "default",
    },
    fileSystem: fs,
  });
  return handle;
}

function preparedState(prepared: PreparedTransaction): PreparedTransactionState {
  const authoritative = preparedTransactions.get(prepared);
  if (authoritative === undefined) {
    throw new Error("Prepared transaction handle is invalid or was not created by prepareTransaction");
  }
  return authoritative;
}

/** Returns detached prepared bytes for precommit formatters and exact preview rendering. */
export function preparedTransactionOutputs(prepared: PreparedTransaction): PreparedTransactionOutput[] {
  return preparedState(prepared).files.map((file) => ({
    path: file.path,
    before: Uint8Array.from(file.before),
    after: Uint8Array.from(file.after),
    beforeMode: file.beforeMode,
    afterMode: file.afterMode,
  }));
}

/** Replaces only known prepared outputs and refreshes their authoritative hashes. */
export function updatePreparedTransactionOutputs(
  prepared: PreparedTransaction,
  updates: Readonly<Record<string, Uint8Array>>,
): void {
  const authoritative = preparedState(prepared);
  const known = new Set(authoritative.files.map((file) => file.path));
  for (const path of Object.keys(updates)) {
    if (!known.has(path)) {
      throw new Error(`Prepared formatter returned an unknown transaction path: ${path}`);
    }
  }
  for (const file of authoritative.files) {
    const update = updates[file.path];
    if (update === undefined) {
      continue;
    }
    const content = Buffer.from(update);
    if (!isUtf8(content)) {
      throw new Error(`Prepared formatter returned non-UTF-8 bytes: ${file.path}`);
    }
    file.after = content;
    file.afterHash = sha256(content);
  }
}

/** Attaches already-completed precommit audits to the opaque authoritative state. */
export function appendPreparedTransactionValidations(
  prepared: PreparedTransaction,
  validations: readonly ValidationResult[],
): void {
  const authoritative = preparedState(prepared);
  authoritative.validations.push(...validations.map((validation) => ({ ...validation, argv: [...validation.argv] })));
}

/** Renders the exact prepared bytes, including precommit formatter changes. */
export function preparedTransactionPreview(prepared: PreparedTransaction): string {
  return preparedState(prepared).files
    .map((file) => renderUnifiedDiff(file.path, file.before, file.after))
    .filter((section) => section.length > 0)
    .join("\n");
}

async function acquireLock(root: string, id: string, fs: TransactionFileSystem): Promise<string> {
  const stateDirectory = join(root, ".tfs-ripast");
  await ensureContainedDirectory(root, stateDirectory, fs);
  const lockPath = join(stateDirectory, "lock");
  try {
    await fs.writeFile(lockPath, `${JSON.stringify({ id, pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (isExisting(error)) {
      throw new Error(`Repository transaction lock is held; another transaction may be in progress`);
    }
    throw error;
  }
  return lockPath;
}

async function ensureContainedDirectory(
  root: string,
  directory: string,
  fs: TransactionFileSystem,
): Promise<void> {
  const fromRoot = relative(root, directory);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Transaction state directory escapes repository containment: ${directory}`);
  }
  let current = root;
  for (const component of fromRoot.split(sep).filter((item) => item.length > 0)) {
    current = join(current, component);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isExisting(error)) {
        throw error;
      }
    }
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Transaction state path contains a symlink or non-directory: ${current}`);
    }
    const canonical = await fs.realpath(current);
    if (!isContained(root, canonical) || canonical !== current) {
      throw new Error(`Transaction state directory is not canonically contained: ${current}`);
    }
  }
}

async function safeUnlink(path: string, fs: TransactionFileSystem): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function releaseLock(path: string, fs: TransactionFileSystem): Promise<void> {
  await safeUnlink(path, fs);
}

async function writeExclusive(
  path: string,
  content: string | Uint8Array,
  mode: number,
  fs: TransactionFileSystem,
): Promise<void> {
  await fs.writeFile(path, content, { flag: "wx", mode });
  try {
    await fs.chmod(path, mode);
  } catch (error) {
    await safeUnlink(path, fs);
    throw error;
  }
}

async function recheckPreparedInput(
  root: string,
  prepared: PreparedInput,
  fs: TransactionFileSystem,
  expectedHash = prepared.input.hash,
): Promise<string> {
  const current = await readStableFile(root, prepared.input.path, fs);
  const mode = current.info.mode & 0o7777;
  if (
    current.info.dev !== prepared.device ||
    current.info.ino !== prepared.inode ||
    sha256(current.content) !== expectedHash ||
    current.content.byteLength !== prepared.input.byteLength ||
    mode !== prepared.input.mode
  ) {
    throw new Error(`Stale transaction input hash or identity before commit: ${prepared.input.path}`);
  }
  return current.absolutePath;
}

async function writeBeforeArtifact(
  prepared: PreparedTransactionState,
  file: PreparedFile,
): Promise<void> {
  const artifactPath = join(
    prepared.root,
    ".tfs-ripast",
    "transactions",
    prepared.id,
    "before",
    ...file.path.split("/"),
  );
  await ensureContainedDirectory(prepared.root, dirname(artifactPath), prepared.fileSystem);
  await writeExclusive(artifactPath, file.before, file.beforeMode, prepared.fileSystem);
}

function inversePatch(files: readonly PreparedFile[]): string {
  return files
    .map((file) => renderUnifiedDiff(file.path, file.after, file.before, { contextLines: Number.MAX_SAFE_INTEGER }))
    .filter((section) => section.length > 0)
    .join("\n");
}

function transactionRecord(
  prepared: PreparedTransactionState,
  state: TransactionRecord["state"],
): TransactionRecord {
  const record: TransactionRecord = {
    version: 1,
    id: prepared.id,
    editPlanHash: prepared.editPlanHash,
    gitScope: prepared.editPlan.gitScope,
    validationPolicy: prepared.validationPolicy,
    changedPaths: prepared.files.map((file) => file.path),
    files: prepared.files.map((file) => ({
      path: file.path,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
      beforeMode: file.beforeMode,
      afterMode: file.afterMode,
    })),
    validations: [...prepared.validations],
    inversePatch: inversePatch(prepared.files),
    startedAt: prepared.startedAt,
    completedAt: new Date().toISOString(),
    state,
  };
  validateTransactionRecordSemantics(record);
  transactionRecordSchema.parse(record);
  return record;
}

/** Returns the largest persisted JSON record this opaque preparation can produce. */
export function preparedTransactionRecordBytes(prepared: PreparedTransaction): number {
  const authoritative = preparedTransactions.get(prepared);
  if (authoritative === undefined) {
    throw new Error("Prepared transaction handle is invalid or was not created by prepareTransaction");
  }
  const states: TransactionRecord["state"][] = [
    "committed",
    "rolled-back",
    "partial-commit",
    "failed",
  ];
  const record = transactionRecord(authoritative, "committed");
  return Math.max(...states.map((state) =>
    Buffer.byteLength(`${JSON.stringify({ ...record, state }, null, 2)}\n`)));
}

/**
 * Proven upper bound for the pretty-printed terminal record. The same bounded
 * ValidationResult representation enforced by the runtime and public schema is
 * serialized here. JSON can expand one captured output byte to at most six
 * ASCII bytes (`\\u00XX`); argv, cwd, config, stage, and policy are exact.
 */
export function preparedTransactionMaximumRecordBytes(
  prepared: PreparedTransaction,
  pending: readonly ValidationInvocation[],
): number {
  const authoritative = preparedState(prepared);
  const internal: ValidationInvocation[] = ["run-postcommit-validations", "verify-prepared-output"].map((action) => ({
    source: "named-adapter",
    adapter: "transaction-integrity",
    executable: "tfs-ripast",
    argv: [action],
    cwd: ".",
    executionCwd: authoritative.root,
    timeoutMs: 0,
    maxOutputBytes: maximumInternalAuditBytes,
    stage: "postcommit",
    rollbackPolicy: authoritative.validationPolicy.rollbackPolicy,
    configResolution: "internal transaction coordination audit",
  }));
  const possible = [...pending, ...internal];
  const synthetic: ValidationResult[] = possible.map((invocation) => {
    const common = {
      executable: invocation.executable,
      argv: [...invocation.argv],
      cwd: invocation.cwd,
      actualCwd: invocation.executionCwd,
      timeoutMs: invocation.timeoutMs,
      stage: invocation.stage,
      rollbackPolicy: invocation.rollbackPolicy,
      ...(invocation.configResolution === undefined ? {} : { configResolution: invocation.configResolution }),
      timedOut: false,
      truncated: false,
      status: "spawn-error" as const,
      exitCode: -2_147_483_648,
      output: "",
    };
    return invocation.source === "named-adapter"
      ? { source: "named-adapter", adapter: invocation.adapter, ...common }
      : { source: "explicit-command", ...common };
  });
  const original = authoritative.validations;
  authoritative.validations = [...original, ...synthetic];
  try {
    const structuralBytes = preparedTransactionRecordBytes(prepared);
    const escapedOutputBytes = possible.reduce((total, invocation) => {
      const expansion = invocation.maxOutputBytes * 6;
      if (!Number.isSafeInteger(expansion) || total > Number.MAX_SAFE_INTEGER - expansion) {
        return Number.MAX_SAFE_INTEGER;
      }
      return total + expansion;
    }, 0);
    return Math.min(Number.MAX_SAFE_INTEGER, structuralBytes + escapedOutputBytes);
  } finally {
    authoritative.validations = original;
  }
}

async function persistRecord(
  root: string,
  record: TransactionRecord,
  fs: TransactionFileSystem,
): Promise<void> {
  transactionRecordSchema.parse(record);
  const recordsDirectory = join(root, ".tfs-ripast", "transactions");
  await ensureContainedDirectory(root, recordsDirectory, fs);
  const destination = join(recordsDirectory, `${record.id}.json`);
  const temporary = join(recordsDirectory, `.${record.id}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maximumProtocolBytes) {
    throw new Error(
      `Final transaction record serialization requires ${String(bytes)} bytes, exceeding the loader limit of ${String(maximumProtocolBytes)} bytes.`,
    );
  }
  await writeExclusive(temporary, serialized, 0o600, fs);
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    await safeUnlink(temporary, fs);
    throw error;
  }
}

async function cleanupSiblings(
  siblings: readonly SiblingFiles[],
  fs: TransactionFileSystem,
): Promise<void> {
  for (const sibling of siblings) {
    await safeUnlink(sibling.afterPath, fs);
    await safeUnlink(sibling.beforePath, fs);
  }
}

async function verifyPreparedOutputs(prepared: PreparedTransactionState): Promise<void> {
  for (const file of prepared.files) {
    const current = await readStableFile(prepared.root, file.path, prepared.fileSystem);
    if (sha256(current.content) !== file.afterHash || (current.info.mode & 0o7777) !== file.afterMode) {
      throw new Error(`Final transaction hash or mode verification failed: ${file.path}`);
    }
  }
}

/** Acquires the repository lock, prepares sibling files, rechecks every input, and atomically renames. */
export async function commitTransaction(
  prepared: PreparedTransaction,
  options: CommitTransactionOptions = {},
): Promise<TransactionRecord> {
  const authoritative = preparedTransactions.get(prepared);
  if (authoritative === undefined) {
    throw new Error(`Prepared transaction handle is invalid or was not created by prepareTransaction`);
  }
  assertTransactable(authoritative.editPlan);
  assertEditPlanTargetsAllowed(authoritative.editPlan);
  validateEditPlanSemantics(authoritative.editPlan);
  if (editPlanHash(authoritative.editPlan) !== authoritative.editPlanHash) {
    throw new Error(`Edit plan changed after transaction preparation`);
  }
  for (const file of authoritative.files) {
    if (sha256(file.before) !== file.beforeHash || sha256(file.after) !== file.afterHash) {
      throw new Error(`Prepared transaction bytes changed after hashing: ${file.path}`);
    }
  }

  const fs = authoritative.fileSystem;
  // Refuse stale or redirected authoritative inputs before the first transaction write.
  for (const input of authoritative.inputs) {
    await recheckPreparedInput(authoritative.root, input, fs);
  }
  const lockPath = await acquireLock(authoritative.root, authoritative.id, fs);
  const siblings: SiblingFiles[] = [];
  try {
    // Resolve and stale-check every authoritative input before preparing any sibling.
    const absolutePaths = new Map<string, string>();
    for (const input of authoritative.inputs) {
      absolutePaths.set(input.input.path, await recheckPreparedInput(authoritative.root, input, fs));
    }
    await options.beforeFirstSourceWrite?.();

    for (const file of authoritative.files) {
      const absolutePath = absolutePaths.get(file.path);
      if (absolutePath === undefined) {
        throw new Error(`Prepared file has no authoritative input: ${file.path}`);
      }
      const token = randomUUID();
      const beforePath = join(dirname(absolutePath), `.${basename(absolutePath)}.tfs-ripast-${token}-before`);
      const afterPath = join(dirname(absolutePath), `.${basename(absolutePath)}.tfs-ripast-${token}-after`);
      siblings.push({ file, absolutePath, beforePath, afterPath });
      await writeExclusive(beforePath, file.before, file.beforeMode, fs);
      await writeExclusive(afterPath, file.after, file.afterMode, fs);
      await writeBeforeArtifact(authoritative, file);
    }

    // Repeat the all-file stale gate after sibling preparation and before the first target rename.
    for (const input of authoritative.inputs) {
      const absolutePath = await recheckPreparedInput(authoritative.root, input, fs);
      if (absolutePath !== absolutePaths.get(input.input.path)) {
        throw new Error(`Transaction target identity changed during sibling preparation: ${input.input.path}`);
      }
    }

    const renamed: SiblingFiles[] = [];
    try {
      for (const sibling of siblings) {
        await fs.rename(sibling.afterPath, sibling.absolutePath);
        renamed.push(sibling);
      }
      await verifyPreparedOutputs(authoritative);
      if (options.runPostcommitValidations !== undefined) {
        try {
          authoritative.validations.push(...await options.runPostcommitValidations());
        } catch (error) {
          authoritative.validations.push({
            source: "named-adapter",
            adapter: "transaction-integrity",
            executable: "tfs-ripast",
            argv: ["run-postcommit-validations"],
            cwd: ".",
            actualCwd: authoritative.root,
            timeoutMs: 0,
            stage: "postcommit",
            rollbackPolicy: authoritative.validationPolicy.rollbackPolicy,
            configResolution: "postcommit validation orchestration under the transaction lock",
            timedOut: false,
            truncated: false,
            status: "failed",
            exitCode: null,
            output: boundedAuditMessage(error),
          });
        }
      }
      try {
        await verifyPreparedOutputs(authoritative);
      } catch (error) {
        authoritative.validations.push({
          source: "named-adapter",
          adapter: "transaction-integrity",
          executable: "tfs-ripast",
          argv: ["verify-prepared-output"],
          cwd: ".",
          actualCwd: authoritative.root,
          timeoutMs: 0,
          stage: "postcommit",
          rollbackPolicy: authoritative.validationPolicy.rollbackPolicy,
          configResolution: "authoritative prepared after-hash and mode verification under the transaction lock",
          timedOut: false,
          truncated: false,
          status: "failed",
          exitCode: null,
          output: boundedAuditMessage(error),
        });
      }
      const validationFailed = authoritative.validations.some((validation) =>
        validation.status !== "passed" && validation.status !== "unsupported");
      const audited = transactionRecord(authoritative, "committed");
      // The audit is durable before an automatic rollback begins.
      await persistRecord(authoritative.root, audited, fs);
      recordContexts.set(audited, { root: authoritative.root, fileSystem: fs });
      if (validationFailed && !authoritative.validationPolicy.keepOnCheckFailure) {
        let rollbackComplete = true;
        for (const sibling of [...renamed].reverse()) {
          try {
            await fs.rename(sibling.beforePath, sibling.absolutePath);
          } catch {
            rollbackComplete = false;
          }
        }
        if (rollbackComplete) {
          for (const file of authoritative.files) {
            try {
              const current = await readStableFile(authoritative.root, file.path, fs);
              if (sha256(current.content) !== file.beforeHash || (current.info.mode & 0o7777) !== file.beforeMode) {
                rollbackComplete = false;
              }
            } catch {
              rollbackComplete = false;
            }
          }
        }
        const rolledBack = transactionRecord(authoritative, rollbackComplete ? "rolled-back" : "partial-commit");
        await persistRecord(authoritative.root, rolledBack, fs);
        recordContexts.set(rolledBack, { root: authoritative.root, fileSystem: fs });
        await cleanupSiblings(siblings, fs);
        return rolledBack;
      }
      await cleanupSiblings(siblings, fs);
      return audited;
    } catch {
      let rollbackComplete = true;
      for (const sibling of [...renamed].reverse()) {
        try {
          await fs.rename(sibling.beforePath, sibling.absolutePath);
        } catch {
          rollbackComplete = false;
        }
      }
      const state: TransactionRecord["state"] = renamed.length === 0
        ? "failed"
        : rollbackComplete ? "rolled-back" : "partial-commit";
      const record = transactionRecord(authoritative, state);
      await persistRecord(authoritative.root, record, fs);
      recordContexts.set(record, { root: authoritative.root, fileSystem: fs });
      await cleanupSiblings(siblings, fs);
      return record;
    }
  } catch (error) {
    await cleanupSiblings(siblings, fs);
    throw error;
  } finally {
    await releaseLock(lockPath, fs);
  }
}

function recordContext(record: TransactionRecord, options: TransactionLookupOptions): RecordContext {
  const retained = recordContexts.get(record);
  return {
    root: resolve(options.root ?? retained?.root ?? process.cwd()),
    fileSystem: options.fileSystem ?? retained?.fileSystem ?? nodeTransactionFileSystem,
  };
}

/** Verifies committed or undone hashes without modifying the repository. */
export async function verifyTransaction(
  record: TransactionRecord,
  options: TransactionLookupOptions = {},
): Promise<VerificationReport> {
  validateTransactionRecordSemantics(record);
  const context = recordContext(record, options);
  const root = await context.fileSystem.realpath(context.root);
  const expectBefore = record.state === "undone" || record.state === "rolled-back";
  const files: VerificationFile[] = [];
  const diagnostics: string[] = [];
  for (const file of record.files) {
    const expectedHash = expectBefore ? file.beforeHash : file.afterHash;
    const expectedMode = expectBefore ? file.beforeMode : file.afterMode;
    try {
      const current = await readStableFile(root, file.path, context.fileSystem);
      const actualHash = sha256(current.content);
      const actualMode = current.info.mode & 0o7777;
      const matches = actualHash === expectedHash && actualMode === expectedMode;
      files.push({ path: file.path, expectedHash, actualHash, expectedMode, actualMode, matches });
      if (!matches) {
        diagnostics.push(`Hash or mode mismatch for ${file.path}`);
      }
    } catch (error) {
      files.push({ path: file.path, expectedHash, expectedMode, matches: false });
      diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  const verifiableState = record.state === "committed" || record.state === "undone" || record.state === "rolled-back";
  return {
    ok: verifiableState && files.every((file) => file.matches),
    state: record.state,
    files,
    diagnostics,
  };
}

async function readBeforeArtifact(
  root: string,
  record: TransactionRecord,
  path: string,
  fs: TransactionFileSystem,
): Promise<{ content: Buffer; mode: number }> {
  const artifact = join(root, ".tfs-ripast", "transactions", record.id, "before", ...path.split("/"));
  const realParent = await fs.realpath(dirname(artifact));
  const artifactRoot = join(root, ".tfs-ripast", "transactions", record.id, "before");
  if (!isContained(artifactRoot, realParent)) {
    throw new Error(`Before-image artifact escapes transaction storage: ${path}`);
  }
  const contained = join(realParent, basename(artifact));
  const info = await fs.lstat(contained);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Before-image artifact is not a regular file: ${path}`);
  }
  const canonical = await fs.realpath(contained);
  if (!isContained(artifactRoot, canonical)) {
    throw new Error(`Before-image artifact escapes transaction storage: ${path}`);
  }
  return { content: await fs.readFile(canonical), mode: info.mode & 0o7777 };
}

/** Reconstructs the exact undo patch from validated current bytes and retained before images. */
export async function previewUndoTransaction(
  record: TransactionRecord,
  options: TransactionLookupOptions = {},
): Promise<UndoPreview> {
  validateTransactionRecordSemantics(record);
  if (record.state !== "committed") {
    throw new Error(`Only a committed transaction can be undone; current state is ${record.state}`);
  }
  const context = recordContext(record, options);
  const fs = context.fileSystem;
  const root = await fs.realpath(context.root);
  const patches: string[] = [];
  const files: UndoPreview["files"] = [];
  for (const file of record.files) {
    const current = await readStableFile(root, file.path, fs);
    const currentHash = sha256(current.content);
    const currentMode = current.info.mode & 0o7777;
    if (currentHash !== file.afterHash || currentMode !== file.afterMode) {
      throw new Error(`Undo refused because ${file.path} has later content or mode edits`);
    }
    const before = await readBeforeArtifact(root, record, file.path, fs);
    if (sha256(before.content) !== file.beforeHash) {
      throw new Error(`Retained before image has a stale hash: ${file.path}`);
    }
    const patch = renderUnifiedDiff(file.path, current.content, before.content, {
      contextLines: Number.MAX_SAFE_INTEGER,
    });
    if (patch.length > 0) {
      patches.push(patch);
    }
    files.push({
      path: file.path,
      currentHash,
      beforeHash: file.beforeHash,
      currentMode,
      beforeMode: file.beforeMode,
    });
  }
  const patch = patches.join("\n");
  return { patch, storedInversePatchMatches: record.inversePatch === patch, files };
}

/** Restores retained before images only when every current file still has its committed after-hash. */
export async function undoTransaction(
  record: TransactionRecord,
  options: TransactionLookupOptions = {},
): Promise<TransactionRecord> {
  validateTransactionRecordSemantics(record);
  if (record.state !== "committed") {
    throw new Error(`Only a committed transaction can be undone; current state is ${record.state}`);
  }
  const context = recordContext(record, options);
  const fs = context.fileSystem;
  const root = await fs.realpath(context.root);
  const lockPath = await acquireLock(root, `${record.id}:undo`, fs);
  const restoreFiles: Array<{
    path: string;
    absolutePath: string;
    before: Buffer;
    after: Buffer;
    beforeHash: string;
    afterHash: string;
    beforeMode: number;
    afterMode: number;
    device: number;
    inode: number;
    beforePath: string;
    afterPath: string;
  }> = [];
  try {
    for (const file of record.files) {
      const current = await readStableFile(root, file.path, fs);
      if (sha256(current.content) !== file.afterHash || (current.info.mode & 0o7777) !== file.afterMode) {
        throw new Error(`Undo refused because ${file.path} has later content or mode edits`);
      }
      const beforeArtifact = await readBeforeArtifact(root, record, file.path, fs);
      if (sha256(beforeArtifact.content) !== file.beforeHash) {
        throw new Error(`Retained before image has a stale hash: ${file.path}`);
      }
      const token = randomUUID();
      restoreFiles.push({
        path: file.path,
        absolutePath: current.absolutePath,
        before: beforeArtifact.content,
        after: current.content,
        beforeHash: file.beforeHash,
        afterHash: file.afterHash,
        beforeMode: file.beforeMode,
        afterMode: file.afterMode,
        device: current.info.dev,
        inode: current.info.ino,
        beforePath: join(dirname(current.absolutePath), `.${basename(current.absolutePath)}.tfs-ripast-${token}-undo-before`),
        afterPath: join(dirname(current.absolutePath), `.${basename(current.absolutePath)}.tfs-ripast-${token}-undo-after`),
      });
    }
    for (const file of restoreFiles) {
      await writeExclusive(file.beforePath, file.before, file.beforeMode, fs);
      await writeExclusive(file.afterPath, file.after, file.afterMode, fs);
    }

    // As with commit, all current hashes and identities are checked before the first restore rename.
    for (const file of restoreFiles) {
      const current = await readStableFile(root, file.path, fs);
      if (
        current.absolutePath !== file.absolutePath ||
        current.info.dev !== file.device ||
        current.info.ino !== file.inode ||
        sha256(current.content) !== file.afterHash ||
        (current.info.mode & 0o7777) !== file.afterMode
      ) {
        throw new Error(`Undo refused because ${file.path} changed before restore`);
      }
    }

    const restored: typeof restoreFiles = [];
    try {
      for (const file of restoreFiles) {
        await fs.rename(file.beforePath, file.absolutePath);
        restored.push(file);
      }
      for (const file of restoreFiles) {
        const current = await readStableFile(root, file.path, fs);
        if (sha256(current.content) !== file.beforeHash || (current.info.mode & 0o7777) !== file.beforeMode) {
          throw new Error(`Undo final hash or mode verification failed: ${file.path}`);
        }
      }
      const undone: TransactionRecord = { ...record, completedAt: new Date().toISOString(), state: "undone" };
      await persistRecord(root, undone, fs);
      recordContexts.set(undone, { root, fileSystem: fs });
      return undone;
    } catch (error) {
      let rollbackComplete = true;
      for (const file of [...restored].reverse()) {
        try {
          await fs.rename(file.afterPath, file.absolutePath);
        } catch {
          rollbackComplete = false;
        }
      }
      if (!rollbackComplete) {
        const partial: TransactionRecord = { ...record, completedAt: new Date().toISOString(), state: "partial-commit" };
        await persistRecord(root, partial, fs);
        recordContexts.set(partial, { root, fileSystem: fs });
        return partial;
      }
      throw error;
    }
  } finally {
    for (const file of restoreFiles) {
      await safeUnlink(file.beforePath, fs);
      await safeUnlink(file.afterPath, fs);
    }
    await releaseLock(lockPath, fs);
  }
}

export interface FinalizeValidationOptions extends TransactionLookupOptions {
  policyOverride?: {
    keepOnFailure: boolean;
    authority: "runtime-override";
  };
}

/** Persists audit results and restores committed files after a failed check unless explicitly kept. */
export async function finalizeTransactionValidations(
  record: TransactionRecord,
  validations: readonly ValidationResult[],
  options: FinalizeValidationOptions = {},
): Promise<TransactionRecord> {
  validateTransactionRecordSemantics(record);
  if (record.state !== "committed") {
    throw new Error(`Validation results can finalize only a committed transaction; current state is ${record.state}`);
  }
  const context = recordContext(record, options);
  const validationPolicy: TransactionRecord["validationPolicy"] = options.policyOverride === undefined
    ? record.validationPolicy
    : {
      keepOnCheckFailure: options.policyOverride.keepOnFailure,
      rollbackPolicy: options.policyOverride.keepOnFailure ? "keep-on-failure" : "rollback-on-failure",
      authority: options.policyOverride.authority,
    };
  const auditedValidations = validations.map((validation) => validation.stage === "postcommit"
    ? { ...validation, rollbackPolicy: validationPolicy.rollbackPolicy }
    : validation);
  const audited: TransactionRecord = {
    ...record,
    validationPolicy,
    validations: auditedValidations,
    completedAt: new Date().toISOString(),
  };
  validateTransactionRecordSemantics(audited);
  const failed = validations.some((validation) =>
    validation.status !== "passed" && validation.status !== "unsupported");
  if (!failed || validationPolicy.keepOnCheckFailure) {
    await persistRecord(context.root, audited, context.fileSystem);
    recordContexts.set(audited, context);
    return audited;
  }

  recordContexts.set(audited, context);
  const restored = await undoTransaction(audited, context);
  const rolledBack: TransactionRecord = {
    ...restored,
    validationPolicy,
    validations: auditedValidations,
    completedAt: new Date().toISOString(),
    state: restored.state === "undone" ? "rolled-back" : restored.state,
  };
  validateTransactionRecordSemantics(rolledBack);
  await persistRecord(context.root, rolledBack, context.fileSystem);
  recordContexts.set(rolledBack, context);
  return rolledBack;
}
