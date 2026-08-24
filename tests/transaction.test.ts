import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTargets } from "../src/filesystem.js";
import {
  commitTransaction,
  finalizeTransactionValidations,
  nodeTransactionFileSystem,
  prepareTransaction,
  undoTransaction,
  verifyTransaction,
  type TransactionFileSystem,
} from "../src/transaction.js";
import type { FileSnapshot } from "../src/planner.js";
import type { Diagnostic, Edit, EditPlan, MatchEvidence, RewriteOperation } from "../src/types.js";

const temporaryRoots: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfs-ripast-transaction-"));
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
    id: "edit-plan:transaction-test",
    rewritePlan: {
      version: 1,
      name: "transaction test",
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

async function absent(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return false;
  } catch {
    return true;
  }
}

function injectingFileSystem(
  rename: TransactionFileSystem["rename"],
  write?: TransactionFileSystem["writeFile"],
): TransactionFileSystem {
  return {
    ...nodeTransactionFileSystem,
    rename,
    ...(write === undefined ? {} : { writeFile: write }),
  };
}

function retargetPlan(plan: EditPlan, path: string): void {
  const operation = plan.rewritePlan.operations[0];
  const input = plan.inputFiles[0];
  const evidence = plan.evidence[0];
  const edit = plan.edits[0];
  if (operation === undefined || input === undefined || evidence === undefined || edit === undefined) {
    throw new Error("transaction fixture is incomplete");
  }
  operation.paths = [path];
  input.path = path;
  evidence.file = path;
  edit.file = path;
}

describe("transaction gates", () => {
  it("refuses conflicts and invariant-failure diagnostics during preparation without creating state", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const inputs = await snapshots(root, ["input.txt"]);
    const conflictPlan = editPlan(root, inputs, { "input.txt": "new" });
    conflictPlan.conflicts.push({
      id: "conflict:blocked",
      editIds: [conflictPlan.edits[0]?.id ?? "edit:missing", "edit:other"],
      reason: "partial-overlap",
    });
    const invariantPlan = editPlan(root, inputs, { "input.txt": "new" }, [{
      code: "expected-count-min",
      message: "expected at least two edits",
      operationId: "rename",
      paths: ["input.txt"],
    }]);

    await expect(prepareTransaction(conflictPlan)).rejects.toThrow(/conflict/i);
    await expect(prepareTransaction(invariantPlan)).rejects.toThrow(/invariant|expected-count/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(await absent(join(root, ".tfs-ripast"))).toBe(true);
  });

  it.each(["invariant", "conflict"] as const)(
    "re-runs the %s plan gate at commit even when preparation originally succeeded",
    async (blockedBy) => {
      const root = await temporaryRepository();
      await writeFile(join(root, "input.txt"), "old\n");
      const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
      const prepared = await prepareTransaction(plan);
      if (blockedBy === "invariant") {
        plan.diagnostics.push({
          code: "expected-count-exact",
          message: "late invariant failure",
          operationId: "rename",
          paths: ["input.txt"],
        });
      } else {
        plan.conflicts.push({
          id: "conflict:late",
          editIds: [plan.edits[0]?.id ?? "edit:missing", "edit:other"],
          reason: "partial-overlap",
        });
      }

      await expect(commitTransaction(prepared)).rejects.toThrow(
        blockedBy === "invariant" ? /invariant|expected-count/i : /conflict/i,
      );
      expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
      expect(await absent(join(root, ".tfs-ripast"))).toBe(true);
    },
  );
});

describe("prepareTransaction", () => {
  it("is dry, computes complete output, and rejects a stale snapshot before creating state", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });

    const prepared = await prepareTransaction(plan);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(await absent(join(root, ".tfs-ripast"))).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.keys(prepared)).toEqual([]);

    await writeFile(join(root, "input.txt"), "later\n");
    await expect(prepareTransaction(plan)).rejects.toThrow(/stale|hash/i);
    expect(await absent(join(root, ".tfs-ripast"))).toBe(true);
  });

  it("refuses edits to binary or invalid UTF-8 input", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "invalid.txt"), Buffer.from([0x6f, 0x6c, 0x64, 0xc3, 0x28]));
    const [snapshot] = await snapshots(root, ["invalid.txt"]);
    if (snapshot === undefined) {
      throw new Error("missing invalid UTF-8 snapshot");
    }

    await expect(prepareTransaction(editPlan(root, [snapshot], { "invalid.txt": "new" })))
      .rejects.toThrow(/UTF-8|encoding|writable/i);
  });

  it.each([".git/config", ".tfs-ripast/payload"])(
    "rejects a constructed edit plan targeting reserved path %s",
    async (reservedPath) => {
      const root = await temporaryRepository();
      await writeFile(join(root, "input.txt"), "old\n");
      await mkdir(dirname(join(root, reservedPath)), { recursive: true });
      await writeFile(join(root, reservedPath), "old\n");
      const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
      retargetPlan(plan, reservedPath);

      await expect(prepareTransaction(plan)).rejects.toThrow(/reserved|\.git|\.tfs-ripast/i);
      expect(await readFile(join(root, reservedPath), "utf8")).toBe("old\n");
    },
  );

  it("rejects a symlink alias whose resolved identity is under .git", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "old\n");
    await symlink(join(root, ".git"), join(root, "alias"));
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    retargetPlan(plan, "alias/config");

    await expect(prepareTransaction(plan)).rejects.toThrow(/reserved|\.git/i);
    expect(await readFile(join(root, ".git", "config"), "utf8")).toBe("old\n");
  });
});

describe("commitTransaction", () => {
  it("keeps inputs authoritative when a caller tries to clear the prepared handle", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "a.txt"), "old a\n");
    await writeFile(join(root, "b.txt"), "unchanged input\n");
    let transactionWrites = 0;
    const fs = injectingFileSystem(
      nodeTransactionFileSystem.rename,
      async (path, data, options) => {
        transactionWrites += 1;
        await nodeTransactionFileSystem.writeFile(path, data, options);
      },
    );
    const prepared = await prepareTransaction(editPlan(
      root,
      await snapshots(root, ["a.txt", "b.txt"]),
      { "a.txt": "new" },
    ), { fileSystem: fs });
    Reflect.set(prepared as unknown as object, "inputs", []);
    Reflect.set(prepared as unknown as object, "files", []);
    await writeFile(join(root, "b.txt"), "later user edit\n");

    await expect(commitTransaction(prepared)).rejects.toThrow(/stale|hash|identity/i);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("old a\n");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("later user edit\n");
    expect(transactionWrites).toBe(0);
    expect(await absent(join(root, ".tfs-ripast"))).toBe(true);
  });

  it("remains bound to its original root when a caller tries to redirect handle paths", async () => {
    const root = await temporaryRepository();
    const outside = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    await writeFile(join(outside, "input.txt"), "old\n");
    const prepared = await prepareTransaction(editPlan(
      root,
      await snapshots(root, ["input.txt"]),
      { "input.txt": "new" },
    ));
    const outsideInfo = await stat(join(outside, "input.txt"));
    const exposed = prepared as unknown as {
      root?: string;
      files?: Array<{ absolutePath?: string; after?: Buffer }>;
      inputs?: Array<{ absolutePath?: string; device?: number; inode?: number }>;
    };
    Reflect.set(exposed, "root", outside);
    if (exposed.files?.[0] !== undefined) {
      exposed.files[0].absolutePath = join(outside, "input.txt");
      exposed.files[0].after = Buffer.from("attacker\n");
    }
    if (exposed.inputs?.[0] !== undefined) {
      exposed.inputs[0].absolutePath = join(outside, "input.txt");
      exposed.inputs[0].device = outsideInfo.dev;
      exposed.inputs[0].inode = outsideInfo.ino;
    }

    const record = await commitTransaction(prepared);

    expect(record.state).toBe("committed");
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(outside, "input.txt"), "utf8")).toBe("old\n");
  });

  it("rejects a reserved plan mutation again at the commit boundary", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    const prepared = await prepareTransaction(plan);
    retargetPlan(plan, ".git/config");

    await expect(commitTransaction(prepared)).rejects.toThrow(/reserved|\.git/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(await readFile(join(root, ".git", "config"), "utf8")).toBe("old\n");
    expect(await absent(join(root, ".tfs-ripast"))).toBe(true);
  });

  it("rechecks a target redirected to reserved identity before creating any sibling", async () => {
    const root = await temporaryRepository();
    const target = join(root, "input.txt");
    await writeFile(target, "old\n");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "old\n");
    let siblingWrites = 0;
    const fs = injectingFileSystem(
      nodeTransactionFileSystem.rename,
      async (path, data, options) => {
        if (path.includes("tfs-ripast-") && (path.endsWith("-before") || path.endsWith("-after"))) {
          siblingWrites += 1;
        }
        await nodeTransactionFileSystem.writeFile(path, data, options);
      },
    );
    const prepared = await prepareTransaction(
      editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" }),
      { fileSystem: fs },
    );
    await rm(target);
    await symlink(join(root, ".git", "config"), target);

    await expect(commitTransaction(prepared)).rejects.toThrow(/reserved|symlink|\.git/i);
    expect(siblingWrites).toBe(0);
    expect(await readFile(join(root, ".git", "config"), "utf8")).toBe("old\n");
  });

  it("uses exclusive temporary siblings and preserves mode and CRLF replacements", async () => {
    const root = await temporaryRepository();
    const target = join(root, "script.txt");
    await writeFile(target, "old\r\nsecond\r\n");
    await chmod(target, 0o751);
    const plan = editPlan(root, await snapshots(root, ["script.txt"]), { "script.txt": "new\ncontinued" });
    const observedTargetRenames: Array<[string, string]> = [];
    const exclusiveSiblingWrites: string[] = [];
    const fs = injectingFileSystem(
      async (source, destination) => {
        if (destination === target) {
          observedTargetRenames.push([source, destination]);
          expect(dirname(source)).toBe(dirname(destination));
          expect((await stat(source)).mode & 0o7777).toBe(0o751);
        }
        await nodeTransactionFileSystem.rename(source, destination);
      },
      async (path, data, options) => {
        if (dirname(path) === root && basename(path).includes("tfs-ripast")) {
          expect(options?.flag).toBe("wx");
          exclusiveSiblingWrites.push(path);
        }
        await nodeTransactionFileSystem.writeFile(path, data, options);
      },
    );

    const record = await commitTransaction(await prepareTransaction(plan, { fileSystem: fs }));

    expect(record.state).toBe("committed");
    expect(await readFile(target, "utf8")).toBe("new\r\ncontinued\r\nsecond\r\n");
    expect((await stat(target)).mode & 0o7777).toBe(0o751);
    expect(observedTargetRenames).toHaveLength(1);
    expect(exclusiveSiblingWrites.length).toBeGreaterThanOrEqual(2);
    expect(record.inversePatch).toContain("-new");
    expect(record.inversePatch).toContain("+old");

    const persisted = JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    )) as { state: string; inversePatch: string };
    expect(persisted).toMatchObject({ state: "committed", inversePatch: record.inversePatch });
    expect(await readFile(
      join(root, ".tfs-ripast", "transactions", record.id, "before", "script.txt"),
      "utf8",
    )).toBe("old\r\nsecond\r\n");
  });

  it("locks the repository with exclusive creation", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    await mkdir(join(root, ".tfs-ripast"));
    await writeFile(join(root, ".tfs-ripast", "lock"), "held", { flag: "wx" });

    await expect(commitTransaction(await prepareTransaction(plan))).rejects.toThrow(/lock|transaction.*progress/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });

  it("rejects a state-directory symlink instead of writing the lock outside the repository", async () => {
    const root = await temporaryRepository();
    const outside = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    await symlink(outside, join(root, ".tfs-ripast"));

    await expect(commitTransaction(await prepareTransaction(plan))).rejects.toThrow(/state|symlink|contain/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(await absent(join(outside, "lock"))).toBe(true);
    expect(await absent(join(outside, "transactions"))).toBe(true);
  });

  it("rechecks every input hash before the first rename", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "a.txt"), "old a\n");
    await writeFile(join(root, "b.txt"), "unchanged input\n");
    const plan = editPlan(root, await snapshots(root, ["a.txt", "b.txt"]), { "a.txt": "new" });
    const prepared = await prepareTransaction(plan);
    await writeFile(join(root, "b.txt"), "later user edit\n");

    await expect(commitTransaction(prepared)).rejects.toThrow(/stale|hash|identity/i);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("old a\n");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("later user edit\n");
  });

  it("cleans an exclusive before sibling and releases the lock when after-sibling creation fails", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    const fs = injectingFileSystem(
      nodeTransactionFileSystem.rename,
      async (path, data, options) => {
        if (path.includes("-after")) {
          throw new Error("injected sibling write failure");
        }
        await nodeTransactionFileSystem.writeFile(path, data, options);
      },
    );

    await expect(commitTransaction(await prepareTransaction(plan, { fileSystem: fs })))
      .rejects.toThrow(/sibling write failure/i);

    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect((await readdir(root)).filter((path) => path.includes("tfs-ripast"))).toEqual([".tfs-ripast"]);
    expect(await absent(join(root, ".tfs-ripast", "lock"))).toBe(true);
  });

  it("fully rolls back earlier renames after an injected later rename failure", async () => {
    const root = await temporaryRepository();
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    await writeFile(a, "old a\n");
    await writeFile(b, "old b\n");
    const plan = editPlan(root, await snapshots(root, ["a.txt", "b.txt"]), {
      "a.txt": "new",
      "b.txt": "new",
    });
    const fs = injectingFileSystem(async (source, destination) => {
      if (destination === b && source.includes("-after")) {
        throw new Error("injected second rename failure");
      }
      await nodeTransactionFileSystem.rename(source, destination);
    });

    const record = await commitTransaction(await prepareTransaction(plan, { fileSystem: fs }));

    expect(record.state).toBe("rolled-back");
    expect(await readFile(a, "utf8")).toBe("old a\n");
    expect(await readFile(b, "utf8")).toBe("old b\n");
    expect(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    ))).toMatchObject({ state: "rolled-back" });
  });

  it("reports partial-commit when an injected rollback rename also fails", async () => {
    const root = await temporaryRepository();
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    await writeFile(a, "old a\n");
    await writeFile(b, "old b\n");
    const plan = editPlan(root, await snapshots(root, ["a.txt", "b.txt"]), {
      "a.txt": "new",
      "b.txt": "new",
    });
    const fs = injectingFileSystem(async (source, destination) => {
      if (destination === b && source.includes("-after")) {
        throw new Error("injected commit failure");
      }
      if (destination === a && source.includes("-before")) {
        throw new Error("injected rollback failure");
      }
      await nodeTransactionFileSystem.rename(source, destination);
    });

    const record = await commitTransaction(await prepareTransaction(plan, { fileSystem: fs }));

    expect(record.state).toBe("partial-commit");
    expect(await readFile(a, "utf8")).toBe("new a\n");
    expect(await readFile(b, "utf8")).toBe("old b\n");
  });

  it("rolls source files back when atomic transaction-record persistence fails once", async () => {
    const root = await temporaryRepository();
    const target = join(root, "input.txt");
    await writeFile(target, "old\n");
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

    expect(injected).toBe(true);
    expect(record.state).toBe("rolled-back");
    expect(await readFile(target, "utf8")).toBe("old\n");
    expect(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    ))).toMatchObject({ state: "rolled-back" });
  });
});

describe("verifyTransaction and undoTransaction", () => {
  it("requires an explicit auditable runtime policy override when retaining failed validation output", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const committed = await commitTransaction(await prepareTransaction(
      editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" }),
    ));

    const retained = await finalizeTransactionValidations(committed, [{
      source: "explicit-command",
      executable: process.execPath,
      argv: ["check.mjs"],
      cwd: ".",
      actualCwd: root,
      timeoutMs: 1_000,
      stage: "postcommit",
      rollbackPolicy: "rollback-on-failure",
      timedOut: false,
      truncated: false,
      status: "failed",
      exitCode: 1,
      output: "failed",
    }], {
      policyOverride: { keepOnFailure: true, authority: "runtime-override" },
    });

    expect(retained.state).toBe("committed");
    expect(retained.validationPolicy).toEqual({
      keepOnCheckFailure: true,
      rollbackPolicy: "keep-on-failure",
      authority: "runtime-override",
    });
    expect(retained.validations[0]).toMatchObject({ rollbackPolicy: "keep-on-failure" });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
  });

  it("verifies a commit and atomically restores its retained before image", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    const record = await commitTransaction(await prepareTransaction(plan));

    await expect(verifyTransaction(record)).resolves.toMatchObject({ ok: true, state: "committed" });
    const undone = await undoTransaction(record);

    expect(undone.state).toBe("undone");
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    await expect(verifyTransaction(undone)).resolves.toMatchObject({ ok: true, state: "undone" });
    expect(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    ))).toMatchObject({ state: "undone" });
  });

  it("records modes and reports chmod-only verification drift", async () => {
    const root = await temporaryRepository();
    const target = join(root, "input.txt");
    await writeFile(target, "old\n");
    await chmod(target, 0o751);
    const record = await commitTransaction(await prepareTransaction(
      editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" }),
    ));

    expect(record.files[0]).toMatchObject({ beforeMode: 0o751, afterMode: 0o751 });
    await chmod(target, 0o640);
    const report = await verifyTransaction(record);

    expect(report).toMatchObject({
      ok: false,
      files: [{ expectedMode: 0o751, actualMode: 0o640, matches: false }],
    });
  });

  it("refuses undo after a mode-only user edit", async () => {
    const root = await temporaryRepository();
    const target = join(root, "input.txt");
    await writeFile(target, "old\n");
    await chmod(target, 0o751);
    const record = await commitTransaction(await prepareTransaction(
      editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" }),
    ));
    await chmod(target, 0o640);

    await expect(undoTransaction(record)).rejects.toThrow(/mode|later|diverg/i);
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect((await stat(target)).mode & 0o7777).toBe(0o640);
  });

  it("restores the recorded before mode instead of the current after mode", async () => {
    const root = await temporaryRepository();
    const target = join(root, "input.txt");
    await writeFile(target, "old\n");
    await chmod(target, 0o751);
    const record = await commitTransaction(await prepareTransaction(
      editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" }),
    ));
    const recordedModes = {
      ...record,
      files: record.files.map((file) => ({ ...file, beforeMode: 0o701, afterMode: 0o640 })),
    } as typeof record;
    await chmod(target, 0o640);

    const undone = await undoTransaction(recordedModes, { root });

    expect(undone.state).toBe("undone");
    expect(await readFile(target, "utf8")).toBe("old\n");
    expect((await stat(target)).mode & 0o7777).toBe(0o701);
  });

  it("refuses undo after a later user edit and leaves that edit untouched", async () => {
    const root = await temporaryRepository();
    const target = join(root, "input.txt");
    await writeFile(target, "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    const record = await commitTransaction(await prepareTransaction(plan));
    await writeFile(target, "later user edit\n");

    await expect(verifyTransaction(record)).resolves.toMatchObject({ ok: false });
    await expect(undoTransaction(record)).rejects.toThrow(/later|stale|after.hash|refus/i);
    expect(await readFile(target, "utf8")).toBe("later user edit\n");
  });

  it("rolls the undo rename back when durable record update fails", async () => {
    const root = await temporaryRepository();
    const target = join(root, "input.txt");
    await writeFile(target, "old\n");
    const plan = editPlan(root, await snapshots(root, ["input.txt"]), { "input.txt": "new" });
    const record = await commitTransaction(await prepareTransaction(plan));
    let injected = false;
    const fs = injectingFileSystem(async (source, destination) => {
      if (!injected && destination.endsWith(`${record.id}.json`)) {
        injected = true;
        throw new Error("injected undo record failure");
      }
      await nodeTransactionFileSystem.rename(source, destination);
    });

    await expect(undoTransaction(record, { fileSystem: fs })).rejects.toThrow(/record failure/i);

    expect(injected).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(JSON.parse(await readFile(
      join(root, ".tfs-ripast", "transactions", `${record.id}.json`),
      "utf8",
    ))).toMatchObject({ state: "committed" });
  });
});
