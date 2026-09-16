import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTargets } from "../src/filesystem.js";
import { gcTransactions, repairTransaction } from "../src/maintenance.js";
import { parseTransactionRecord } from "../src/schema.js";
import {
  commitTransaction,
  nodeTransactionFileSystem,
  prepareTransaction,
  undoTransaction,
  verifyTransaction,
  type TransactionFileSystem,
} from "../src/transaction.js";
import type { FileSnapshot } from "../src/planner.js";
import type { Diagnostic, Edit, EditPlan, MatchEvidence, RewriteOperation, TransactionRecord } from "../src/types.js";

const temporaryRoots: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfs-ripast-maintenance-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function hash(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function inputOf(snapshot: FileSnapshot) {
  return {
    path: snapshot.path,
    hash: snapshot.hash,
    byteLength: snapshot.byteLength,
    mode: snapshot.mode,
    newline: snapshot.newline,
    encoding: snapshot.encoding,
  };
}

function editPlan(
  root: string,
  snapshots: FileSnapshot[],
  replacements: Record<string, string>,
  diagnostics: Diagnostic[] = [],
): EditPlan {
  const operation: RewriteOperation = {
    id: "rename",
    paths: snapshots.map((snapshot) => snapshot.path),
    search: "old",
    replace: "new",
    lexical: { type: "literal" },
  };
  const evidence: MatchEvidence[] = [];
  const edits: Edit[] = [];
  for (const snapshot of snapshots) {
    const replacement = replacements[snapshot.path];
    if (replacement === undefined) {
      continue;
    }
    const content = Buffer.from(snapshot.content);
    const start = content.indexOf("old");
    if (start < 0) {
      throw new Error(`fixture has no old token: ${snapshot.path}`);
    }
    const evidenceId = `evidence:${snapshot.path}`;
    evidence.push({
      id: evidenceId,
      operationId: "rename",
      provider: "ripgrep",
      file: snapshot.path,
      byteRange: [start, start + 3],
      lineRange: [1, 1],
      matchedTextHash: hash("old"),
      languageSource: "unsupported",
      confidence: "lexical",
    });
    edits.push({
      id: `edit:${snapshot.path}`,
      operationIds: ["rename"],
      file: snapshot.path,
      byteRange: [start, start + 3],
      replacement,
      evidenceIds: [evidenceId],
    });
  }
  return {
    version: 1,
    id: "edit-plan:maintenance-test",
    rewritePlan: {
      version: 1,
      name: "maintenance test",
      root,
      operations: [operation],
      policy: {},
      validations: [],
    },
    rewritePlanHash: "sha256:rewrite-plan",
    gitScope: {
      repository: false,
      root,
      dirty: false,
      mode: "all",
      requireClean: false,
      inputs: [],
    },
    inputFiles: snapshots.map(inputOf),
    evidence,
    edits,
    conflicts: [],
    diagnostics,
    providerVersions: { ripgrep: "15.2.0" },
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

async function snapshots(root: string, paths: string[]): Promise<FileSnapshot[]> {
  return snapshotTargets(root, paths);
}

function injectingFileSystem(
  rename: TransactionFileSystem["rename"],
): TransactionFileSystem {
  return {
    ...nodeTransactionFileSystem,
    rename,
  };
}

async function absent(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return false;
  } catch {
    return true;
  }
}

/** Commits a two-file transaction whose rollback fails on the first file: a stays committed, b rolls back. */
async function partialCommitFixture(root: string): Promise<TransactionRecord> {
  await writeFile(join(root, "a.txt"), "old a\n");
  await writeFile(join(root, "b.txt"), "old b\n");
  const plan = editPlan(root, await snapshots(root, ["a.txt", "b.txt"]), {
    "a.txt": "new",
    "b.txt": "new",
  });
  const fs = injectingFileSystem(async (source, destination) => {
    if (destination === join(root, "b.txt") && source.includes("-after")) {
      throw new Error("injected commit failure");
    }
    if (destination === join(root, "a.txt") && source.includes("-before")) {
      throw new Error("injected rollback failure");
    }
    await nodeTransactionFileSystem.rename(source, destination);
  });
  const record = await commitTransaction(await prepareTransaction(plan, { fileSystem: fs }));
  expect(record.state).toBe("partial-commit");
  return JSON.parse(await readFile(
    join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
    "utf8",
  )) as TransactionRecord;
}

describe("repairTransaction", () => {
  it("restores committed files from retained before images and marks the record rolled-back", async () => {
    const root = await temporaryRepository();
    const record = await partialCommitFixture(root);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("new a\n");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("old b\n");

    const preview = await repairTransaction(record, { root });
    expect(preview.ok).toBe(true);
    expect(preview.write).toBe(false);
    expect(preview.files).toEqual([
      { path: "a.txt", action: "restored" },
      { path: "b.txt", action: "already-before" },
    ]);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("new a\n");

    const report = await repairTransaction(record, { root, write: true });
    expect(report.ok).toBe(true);
    expect(report.record?.state).toBe("rolled-back");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("old a\n");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("old b\n");

    const persisted = parseTransactionRecord(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    )) as unknown);
    expect(persisted.state).toBe("rolled-back");
    await expect(verifyTransaction(persisted, { root })).resolves.toMatchObject({
      ok: true,
      state: "rolled-back",
    });
  });

  it("refuses to repair when a file has later foreign content", async () => {
    const root = await temporaryRepository();
    const record = await partialCommitFixture(root);
    await writeFile(join(root, "a.txt"), "foreign user edit\n");

    const report = await repairTransaction(record, { root, write: true });
    expect(report.ok).toBe(false);
    expect(report.files.find((file) => file.path === "a.txt")?.action).toBe("blocked");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("foreign user edit\n");
    const persisted = JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    )) as { state: string };
    expect(persisted.state).toBe("partial-commit");
  });

  it("refuses to repair when the retained before image is gone", async () => {
    const root = await temporaryRepository();
    const record = await partialCommitFixture(root);
    await rm(join(root, ".tfs-ripast", "transactions", record.id, "before"), { recursive: true, force: true });

    const report = await repairTransaction(record, { root, write: true });
    expect(report.ok).toBe(false);
    expect(report.files.find((file) => file.path === "a.txt")?.action).toBe("blocked");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("new a\n");
  });

  it("rejects records that are not partial-commit", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const record = await commitTransaction(await prepareTransaction(
      editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" }),
    ));

    const report = await repairTransaction(record, { root, write: true });
    expect(report.ok).toBe(false);
    expect(report.diagnostics[0]).toMatch(/partial-commit/);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
  });

  it("preserves file modes when restoring", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "a.txt"), "old a\n");
    await writeFile(join(root, "b.txt"), "old b\n");
    await chmod(join(root, "a.txt"), 0o751);
    const plan = editPlan(root, await snapshots(root, ["a.txt", "b.txt"]), {
      "a.txt": "new",
      "b.txt": "new",
    });
    const fs = injectingFileSystem(async (source, destination) => {
      if (destination === join(root, "b.txt") && source.includes("-after")) {
        throw new Error("injected commit failure");
      }
      if (destination === join(root, "a.txt") && source.includes("-before")) {
        throw new Error("injected rollback failure");
      }
      await nodeTransactionFileSystem.rename(source, destination);
    });
    const committed = await commitTransaction(await prepareTransaction(plan, { fileSystem: fs }));
    expect(committed.state).toBe("partial-commit");
    const record = JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${committed.id}.json`),
      "utf8",
    )) as TransactionRecord;

    const report = await repairTransaction(record, { root, write: true });
    expect(report.ok).toBe(true);
    expect((await readFile(join(root, "a.txt"))).toString()).toBe("old a\n");
    expect((await stat(join(root, "a.txt"))).mode & 0o7777).toBe(0o751);
  });
});

describe("gcTransactions", () => {
  async function committedFixture(root: string): Promise<TransactionRecord> {
    await writeFile(join(root, "input.txt"), "old\n");
    return await commitTransaction(await prepareTransaction(
      editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" }),
    ));
  }

  async function rolledBackFixture(root: string): Promise<TransactionRecord> {
    await writeFile(join(root, "input.txt"), "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    let injected = false;
    const fs = injectingFileSystem(async (source, destination) => {
      if (!injected && /\/transactions\/transaction-[^/]+\.json$/u.test(destination)) {
        injected = true;
        throw new Error("injected record rename failure");
      }
      await nodeTransactionFileSystem.rename(source, destination);
    });
    const record = await commitTransaction(await prepareTransaction(plan, { fileSystem: fs }));
    expect(record.state).toBe("rolled-back");
    return JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    )) as TransactionRecord;
  }

  it("dry-run reports prunable storage without deleting anything", async () => {
    const root = await temporaryRepository();
    const rolledBack = await rolledBackFixture(root);
    const committed = await committedFixture(root);

    const report = await gcTransactions({ root });
    expect(report.write).toBe(false);
    const rolledBackEntry = report.entries.find((entry) => entry.id === rolledBack.id);
    const committedEntry = report.entries.find((entry) => entry.id === committed.id);
    expect(rolledBackEntry?.prunable).toBe(true);
    expect(committedEntry?.prunable).toBe(false);
    expect(await absent(join(root, ".tfs-ripast", "transactions", rolledBack.id, "before"))).toBe(false);
  });

  it("prunes never-undoable before images and keeps undoable ones", async () => {
    const root = await temporaryRepository();
    const rolledBack = await rolledBackFixture(root);
    const committed = await committedFixture(root);

    const report = await gcTransactions({ root, write: true });
    const pruned = report.entries.filter((entry) => entry.pruned.length > 0).map((entry) => entry.id);
    expect(pruned).toEqual([rolledBack.id]);
    expect(await absent(join(root, ".tfs-ripast", "transactions", rolledBack.id, "before"))).toBe(true);
    expect(await absent(join(root, ".tfs-ripast", "transactions", committed.id, "before"))).toBe(false);
    expect(await absent(join(root, ".tfs-ripast", "transactions", `${rolledBack.id}.json`))).toBe(false);
  });

  it("prunes undoable before images only with include-undoable, after which undo refuses", async () => {
    const root = await temporaryRepository();
    const committed = await committedFixture(root);

    expect((await gcTransactions({ root, write: true, includeUndoable: true }))
      .entries.find((entry) => entry.id === committed.id)?.prunable).toBe(true);
    expect(await absent(join(root, ".tfs-ripast", "transactions", committed.id, "before"))).toBe(true);
    await expect(undoTransaction(committed, { root })).rejects.toThrow(/before.image|ENOENT|regular file/i);
  });

  it("never prunes partial-commit records", async () => {
    const root = await temporaryRepository();
    const partial = await partialCommitFixture(root);

    const report = await gcTransactions({ root, write: true, includeUndoable: true, removeRecords: true });
    const entry = report.entries.find((item) => item.id === partial.id);
    expect(entry?.prunable).toBe(false);
    expect(entry?.reason).toMatch(/repair/);
    expect(await absent(join(root, ".tfs-ripast", "transactions", partial.id, "before"))).toBe(false);
    expect(await absent(join(root, ".tfs-ripast", "transactions", `${partial.id}.json`))).toBe(false);
  });

  it("removes transaction records only when removeRecords is set", async () => {
    const root = await temporaryRepository();
    const rolledBack = await rolledBackFixture(root);

    await gcTransactions({ root, write: true, removeRecords: true });
    expect(await absent(join(root, ".tfs-ripast", "transactions", `${rolledBack.id}.json`))).toBe(true);
  });

  it("is a no-op on a repository with no transactions", async () => {
    const root = await temporaryRepository();
    const report = await gcTransactions({ root, write: true });
    expect(report.entries).toEqual([]);
    expect(report.diagnostics[0]).toMatch(/nothing to prune/);
  });
});
