import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { normalizeRepositoryPath } from "./evidence.js";
import { sha256 } from "./filesystem.js";
import { parseTransactionRecord } from "./schema.js";
import { validateTransactionRecordSemantics } from "./semantic.js";
import {
  nodeTransactionFileSystem,
  persistTransactionRecord,
  withRepositoryLock,
  type TransactionFileSystem,
} from "./transaction.js";
import type { TransactionRecord } from "./types.js";

export interface MaintenanceOptions {
  root?: string;
  fileSystem?: TransactionFileSystem;
}

export interface RepairFileResult {
  path: string;
  action: "restored" | "already-before" | "blocked";
  reason?: string;
}

export interface RepairReport {
  ok: boolean;
  write: boolean;
  transactionId: string;
  files: RepairFileResult[];
  record?: TransactionRecord;
  diagnostics: string[];
}

export interface GcOptions extends MaintenanceOptions {
  /** Apply the pruning plan. Default is a dry-run report. */
  write?: boolean;
  /** Also prune retained before-images of committed (still undoable) transactions. */
  includeUndoable?: boolean;
  /** Minimum age in milliseconds before an undoable transaction is pruned. */
  olderThanMs?: number;
  /** Also remove transaction JSON records whose before-images were pruned. */
  removeRecords?: boolean;
}

export interface GcEntry {
  id: string;
  state: TransactionRecord["state"];
  prunable: boolean;
  wouldPrune: string[];
  pruned: string[];
  recordRemoved: boolean;
  reason?: string;
}

export interface GcReport {
  write: boolean;
  entries: GcEntry[];
  diagnostics: string[];
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readCurrent(
  root: string,
  path: string,
  fs: TransactionFileSystem,
): Promise<{ content: Buffer; mode: number }> {
  const normalized = normalizeRepositoryPath(path);
  const lexical = join(root, ...normalized.split("/"));
  const realParent = await fs.realpath(dirname(lexical));
  const fromRoot = relative(root, realParent);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Repair target escapes repository containment: ${path}`);
  }
  const info = await fs.lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Repair target is not a regular file: ${path}`);
  }
  const canonical = await fs.realpath(lexical);
  const canonicalRelative = relative(root, canonical).split(sep).join("/");
  if (canonicalRelative !== normalized) {
    throw new Error(`Repair target is not canonical within the repository: ${path}`);
  }
  return { content: await fs.readFile(lexical), mode: info.mode & 0o7777 };
}

async function readBeforeArtifact(
  root: string,
  record: TransactionRecord,
  path: string,
  fs: TransactionFileSystem,
): Promise<Buffer> {
  const artifact = join(root, ".tfs-ripast", "transactions", record.id, "before", ...path.split("/"));
  const info = await fs.lstat(artifact);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Retained before-image artifact is not a regular file: ${path}`);
  }
  return fs.readFile(artifact);
}

/**
 * Assisted recovery for a transaction that ended in partial-commit.
 *
 * A partial-commit record means the automatic rollback itself failed halfway:
 * some files hold committed after-content, others already hold before-content.
 * Repair walks the record, verifies every file against one of those two known
 * states, restores the committed files from their retained before-images, and
 * persists the record as rolled-back. A file in any third state (a later user
 * edit) blocks the repair entirely; nothing is written.
 *
 * Defaults to a dry-run report; pass `write: true` to apply.
 */
export async function repairTransaction(
  record: TransactionRecord,
  options: MaintenanceOptions & { write?: boolean } = {},
): Promise<RepairReport> {
  validateTransactionRecordSemantics(record);
  const fs = options.fileSystem ?? nodeTransactionFileSystem;
  const write = options.write === true;
  const report: RepairReport = {
    ok: false,
    write,
    transactionId: record.id,
    files: [],
    diagnostics: [],
  };
  if (record.state !== "partial-commit") {
    report.diagnostics.push(
      `Only a partial-commit transaction can be repaired; current state is ${record.state}`,
    );
    return report;
  }

  // Phase 1: classify every file without writing anything.
  const toRestore: string[] = [];
  for (const file of record.files) {
    let current: { content: Buffer; mode: number };
    try {
      current = await readCurrent(options.root ?? process.cwd(), file.path, fs);
    } catch (error) {
      report.files.push({
        path: file.path,
        action: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const hash = sha256(current.content);
    if (hash === file.beforeHash && current.mode === file.beforeMode) {
      report.files.push({ path: file.path, action: "already-before" });
      continue;
    }
    if (hash === file.afterHash && current.mode === file.afterMode) {
      try {
        const before = await readBeforeArtifact(options.root ?? process.cwd(), record, file.path, fs);
        if (sha256(before) !== file.beforeHash) {
          report.files.push({
            path: file.path,
            action: "blocked",
            reason: "Retained before image has a stale hash",
          });
          continue;
        }
      } catch (error) {
        report.files.push({
          path: file.path,
          action: "blocked",
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      report.files.push({ path: file.path, action: "restored" });
      toRestore.push(file.path);
      continue;
    }
    report.files.push({
      path: file.path,
      action: "blocked",
      reason: "Current content matches neither the committed after-state nor the before-state",
    });
  }
  if (report.files.some((file) => file.action === "blocked")) {
    report.diagnostics.push(
      "Repair blocked: resolve the blocked files above before retrying; no files were changed.",
    );
    return report;
  }
  if (!write) {
    report.ok = true;
    report.diagnostics.push(
      toRestore.length === 0
        ? "Dry-run: every file already holds its before-state; nothing to repair."
        : `Dry-run: ${String(toRestore.length)} file(s) would be restored to their before-state.`,
    );
    return report;
  }

  // Phase 2: restore under the repository lock, with siblings and renames.
  const root = await fs.realpath(options.root ?? process.cwd());
  const repaired = await withRepositoryLock(root, `${record.id}:repair`, fs, async () => {
    const restored: string[] = [];
    for (const file of record.files) {
      if (!toRestore.includes(file.path)) {
        continue;
      }
      const before = await readBeforeArtifact(root, record, file.path, fs);
      if (sha256(before) !== file.beforeHash) {
        throw new Error(`Retained before image has a stale hash: ${file.path}`);
      }
      const current = await readCurrent(root, file.path, fs);
      if (sha256(current.content) !== file.afterHash || current.mode !== file.afterMode) {
        throw new Error(`Repair refused because ${file.path} changed during classification`);
      }
      const target = join(root, ...normalizeRepositoryPath(file.path).split("/"));
      const sibling = join(
        dirname(target),
        `.${basename(target)}.tfs-ripast-${randomUUID()}-repair-before`,
      );
      await fs.writeFile(sibling, before, { flag: "wx", mode: file.beforeMode });
      try {
        await fs.chmod(sibling, file.beforeMode);
        await fs.syncFile(sibling);
        await fs.rename(sibling, target);
        await fs.syncDirectory(dirname(target));
      } catch (error) {
        try {
          await fs.unlink(sibling);
        } catch {
          // Best effort; the sibling name is published in the error path below.
        }
        throw error;
      }
      const after = await readCurrent(root, file.path, fs);
      if (sha256(after.content) !== file.beforeHash || after.mode !== file.beforeMode) {
        throw new Error(`Repair verification failed for ${file.path}`);
      }
      restored.push(file.path);
    }
    const rolledBack: TransactionRecord = {
      ...record,
      completedAt: new Date().toISOString(),
      state: "rolled-back",
    };
    validateTransactionRecordSemantics(rolledBack);
    await persistTransactionRecord(root, rolledBack, fs);
    return { rolledBack, restored };
  });
  report.record = repaired.rolledBack;
  report.ok = true;
  report.diagnostics.push(
    repaired.restored.length === 0
      ? "Every file already held its before-state; record marked rolled-back."
      : `Restored ${String(repaired.restored.length)} file(s) and marked the transaction rolled-back.`,
  );
  return report;
}

const prunableStates = new Set<TransactionRecord["state"]>(["undone", "rolled-back", "failed"]);

/**
 * Plans (and, with `write`, applies) bounded retention of transaction storage.
 *
 * Before-images of transactions that can never be undone again (undone,
 * rolled-back, failed) are dead weight and are pruned first. Undoable
 * (committed) transactions are only pruned with `includeUndoable`, optionally
 * gated by `olderThanMs`. partial-commit records are never pruned: they are a
 * decision the operator must make explicitly via `repair`. Transaction JSON
 * records are audit artifacts and are kept unless `removeRecords` is set.
 */
export async function gcTransactions(options: GcOptions = {}): Promise<GcReport> {
  const fs = options.fileSystem ?? nodeTransactionFileSystem;
  const write = options.write === true;
  const root = await fs.realpath(options.root ?? process.cwd());
  const report: GcReport = { write, entries: [], diagnostics: [] };
  const recordsDirectory = join(root, ".tfs-ripast", "transactions");
  let names: string[] = [];
  try {
    names = (await readdir(recordsDirectory)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    report.diagnostics.push("No transaction records found; nothing to prune.");
    return report;
  }

  for (const name of names) {
    const recordPath = join(recordsDirectory, name);
    let record: TransactionRecord;
    try {
      record = parseTransactionRecord(JSON.parse(await readFile(recordPath, "utf8")) as unknown);
      validateTransactionRecordSemantics(record);
    } catch (error) {
      report.entries.push({
        id: basename(name, ".json"),
        state: "failed",
        prunable: false,
        wouldPrune: [],
        pruned: [],
        recordRemoved: false,
        reason: `Unreadable or invalid transaction record: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const beforeDirectory = join(recordsDirectory, record.id, "before");
    let hasBeforeImages = true;
    try {
      await fs.lstat(beforeDirectory);
    } catch (error) {
      if (isMissing(error)) {
        hasBeforeImages = false;
      } else {
        throw error;
      }
    }
    const neverUndoable = prunableStates.has(record.state);
    const ageMs = Date.now() - Date.parse(record.completedAt ?? record.startedAt);
    const ageGate = options.olderThanMs === undefined || ageMs >= options.olderThanMs;
    const undoablePrunable = record.state === "committed" && options.includeUndoable === true && ageGate;
    const prunable = hasBeforeImages && (neverUndoable || undoablePrunable);
    const entry: GcEntry = {
      id: record.id,
      state: record.state,
      prunable,
      wouldPrune: prunable && !write ? [beforeDirectory] : [],
      pruned: [],
      recordRemoved: false,
    };
    if (prunable && !neverUndoable && !undoablePrunable) {
      entry.reason = "Retention policy does not cover this transaction.";
    }
    if (record.state === "partial-commit") {
      entry.reason = "partial-commit records are never pruned; run repair first.";
    }
    report.entries.push(entry);
  }
  if (write && report.entries.some((entry) => entry.prunable)) {
    // Apply deletions under the repository lock so gc cannot race a concurrent
    // commit, undo, or repair writing retained artifacts.
    await withRepositoryLock(root, "gc", fs, async () => {
      for (const entry of report.entries) {
        if (!entry.prunable) {
          continue;
        }
        const beforeDirectory = join(recordsDirectory, entry.id, "before");
        await rm(beforeDirectory, { recursive: true, force: true });
        entry.pruned.push(beforeDirectory);
        if (options.removeRecords === true) {
          await rm(join(recordsDirectory, `${entry.id}.json`), { force: true });
          entry.recordRemoved = true;
        }
      }
    });
  }
  const prunedCount = report.entries.filter((entry) => entry.pruned.length > 0).length;
  report.diagnostics.push(
    write
      ? `Pruned before-images for ${String(prunedCount)} transaction(s).`
      : `Dry-run: ${String(report.entries.filter((entry) => entry.prunable).length)} transaction(s) prunable; re-run with write authority to apply.`,
  );
  return report;
}
