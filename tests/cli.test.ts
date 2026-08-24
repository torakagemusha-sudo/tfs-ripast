import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, link as linkFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli.js";
import {
  nodeTransactionFileSystem,
  type TransactionFileSystem,
} from "../src/transaction.js";
import type { EditPlan, RewritePlan, TransactionRecord } from "../src/types.js";

const temporaryRoots: string[] = [];

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tfs-ripast-cli-"));
  temporaryRoots.push(root);
  return root;
}

async function writeRewritePlan(root: string, plan: RewritePlan, name = "rewrite-plan.json"): Promise<string> {
  const state = join(root, ".tfs-ripast");
  await mkdir(state, { recursive: true });
  const path = join(state, name);
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(value: string | Uint8Array): string {
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
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function rewritePlanHash(plan: RewritePlan): string {
  return hash(JSON.stringify(stableValue(plan)));
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

async function savedEditPlan(root: string, options: { conflict?: boolean } = {}): Promise<string> {
  await writeFile(join(root, "input.txt"), "old\n", "utf8");
  const rewritePlan: RewritePlan = {
    version: 1,
    name: "saved CLI plan",
    root,
    operations: [
      {
        id: "rename",
        paths: ["input.txt"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      },
      ...(options.conflict ? [{
        id: "other-rename",
        paths: ["input.txt"],
        search: "old",
        replace: "other",
        lexical: { type: "literal" as const },
        matchPolicy: { onUnparseable: "allow" as const },
      }] : []),
    ],
    policy: {},
    validations: [],
  };
  if (!options.conflict) {
    return generatedEditPlan(root, rewritePlan, "edit-plan.json");
  }
  const source = await writeRewritePlan(root, rewritePlan, "conflict-rewrite-plan.json");
  const capture = captureIo({ cwd: root });
  const code = await main(["plan", source, "--json"], capture.io);
  if (code !== 1) {
    throw new Error(`Could not generate conflicting saved plan: ${capture.stderr.join("")}`);
  }
  const publicPlan = (JSON.parse(capture.stdout.join("")) as {
    planning: { editPlan: Omit<EditPlan, "createdAt"> };
  }).planning.editPlan;
  const plan: EditPlan = { ...publicPlan, createdAt: "2026-08-21T00:00:00.000Z" };
  const path = join(root, "edit-plan.json");
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return path;
}

async function savedTwoFilePlan(root: string): Promise<string> {
  await writeFile(join(root, "a.txt"), "old a\n", "utf8");
  await writeFile(join(root, "b.txt"), "old b\n", "utf8");
  const rewritePlan: RewritePlan = {
    version: 1,
    name: "partial CLI plan",
    root,
    operations: [{
      id: "rename",
      paths: ["a.txt", "b.txt"],
      search: "old",
      replace: "new",
      lexical: { type: "literal" },
      matchPolicy: { onUnparseable: "allow" },
    }],
    policy: {},
    validations: [],
  };
  return generatedEditPlan(root, rewritePlan, "two-file-plan.json");
}

function captureIo(options: {
  cwd?: string;
  isTTY?: boolean;
  confirm?: () => Promise<boolean>;
} = {}): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      isTTY: options.isTTY ?? false,
      confirm: options.confirm ?? (async () => false),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    },
  };
}

describe("CLI discovery", () => {
  it("prints stable help without inspecting a repository", async () => {
    const capture = captureIo();
    expect(await main(["--help"], capture.io)).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join("")).toContain("Usage: tfs-ripast");
    expect(capture.stdout.join("")).toContain("tfs-ripast plan PLAN.json");
    expect(capture.stdout.join("")).toContain("Dry-run is the default");
  });

  it("prints the package version", async () => {
    const capture = captureIo();
    expect(await main(["--version"], capture.io)).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(capture.stdout.join("")).toBe("tfs-ripast 0.1.0\n");
  });
});

async function generatedEditPlan(
  root: string,
  rewritePlan?: RewritePlan,
  destination = "derived-edit-plan.json",
): Promise<string> {
  const plan = rewritePlan ?? {
    version: 1 as const,
    name: "derived saved plan",
    root: ".",
    operations: [{
      id: "rename",
      paths: ["input.txt"],
      search: "old",
      replace: "new",
      lexical: { type: "literal" as const },
      matchPolicy: { onUnparseable: "allow" as const },
    }],
    policy: {},
    validations: [],
  };
  const source = await writeRewritePlan(root, plan, `source-${destination}`);
  const capture = captureIo({ cwd: root });
  const code = await main(["plan", source, "--plan-out", destination, "--json"], capture.io);
  if (code !== 0) {
    throw new Error(`Could not generate saved plan: ${capture.stderr.join("")}`);
  }
  return join(root, destination);
}

function rehashEditPlan(plan: EditPlan): void {
  plan.rewritePlanHash = rewritePlanHash(plan.rewritePlan);
  plan.id = stableId("edit-plan", {
    rewritePlanHash: plan.rewritePlanHash,
    gitScope: plan.gitScope,
    inputFiles: plan.inputFiles,
    evidenceIds: plan.evidence.map((evidence) => evidence.id),
    edits: plan.edits.map((edit) => edit.id),
    conflicts: plan.conflicts.map((conflict) => conflict.id),
    diagnostics: plan.diagnostics,
  });
}

describe("CLI safety policy", () => {
  it("rejects --dry-run with --write before scanning", async () => {
    const capture = captureIo();
    const code = await main(["--search", "old", "--replace", "new", "--dry-run", "--write"], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/mutually exclusive/i);
  });

  it("defaults non-TTY execution to a no-write preview without prompting", async () => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root);
    let confirmations = 0;
    const capture = captureIo({
      cwd: root,
      isTTY: false,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });

    const code = await main(["apply", planPath], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(confirmations).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(capture.stdout.join("")).toContain("-old");
    expect(capture.stdout.join("")).toContain("+new");
  });

  it("prompts only after a conflict-free preview and writes on interactive y", async () => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let previewAtPrompt = "";
    const io: CliIo = {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      isTTY: true,
      cwd: root,
      confirm: async () => {
        previewAtPrompt = stdout.join("");
        return true;
      },
    };

    const code = await main(["apply", planPath], io);

    expect(code, stderr.join("")).toBe(0);
    expect(previewAtPrompt).toContain("-old");
    expect(previewAtPrompt).toContain("Apply all changes? [y/N]");
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
  });

  it.each([
    ["no", async () => false],
    ["EOF", async () => { throw new Error("EOF"); }],
  ])("declines on interactive %s without mutating", async (_label, confirm) => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root);
    const capture = captureIo({ cwd: root, isTTY: true, confirm });

    const code = await main(["apply", planPath], capture.io);

    expect(code).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });

  it("does not prompt or write when a saved plan has conflicts", async () => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root, { conflict: true });
    let confirmations = 0;
    const capture = captureIo({
      cwd: root,
      isTTY: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });

    const code = await main(["apply", planPath], capture.io);

    expect(code).toBe(1);
    expect(confirmations).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(capture.stderr.join("")).toMatch(/conflict/i);
    expect(capture.stdout.join("")).toMatch(/1 conflict/i);
  });

  it("detects stale saved inputs before prompting or creating transaction state", async () => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root);
    await writeFile(join(root, "input.txt"), "later\n", "utf8");
    let confirmations = 0;
    const capture = captureIo({
      cwd: root,
      isTTY: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });

    const code = await main(["apply", planPath], capture.io);

    expect(code).toBe(1);
    expect(confirmations).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("later\n");
    expect(capture.stderr.join("")).toMatch(/stale|hash/i);
    await expect(readdir(join(root, ".tfs-ripast", "transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["maxFiles", { maxFiles: 0 }, "files"],
    ["maxMatches", { maxMatches: 0 }, "matches"],
    ["maxChangedBytes", { maxChangedBytes: 0 }, "changedBytes"],
    ["maxRepositoryPercent", { maxRepositoryPercent: 0 }, "repositoryPercent"],
  ] as const)("enforces a zero %s limit before preview preparation or prompting", async (_name, policy, metric) => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const source = await writeRewritePlan(root, {
      version: 1,
      name: "bounded rewrite",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["input.txt"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      }],
      policy,
      validations: [],
    });
    let confirmations = 0;
    const capture = captureIo({
      cwd: root,
      isTTY: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });

    const code = await main(["plan", source, "--write", "--json"], capture.io);

    expect(code).toBe(1);
    expect(confirmations).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    const result = JSON.parse(capture.stdout.join("")) as {
      planning: { policy: { actual: Record<string, number>; limits: Record<string, number>; violations: string[] } };
    };
    expect(result.planning.policy.actual[metric]).toBeGreaterThan(0);
    expect(result.planning.policy.limits[metric]).toBe(0);
    expect(result.planning.policy.violations).toContain(metric);
    expect(capture.stderr.join("")).toMatch(/policy/i);
  });

  it("reports deterministic policy actuals and the immutable repository-file denominator", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await writeFile(join(root, "unchanged.txt"), "still here\n", "utf8");
    const source = await writeRewritePlan(root, {
      version: 1,
      name: "policy metrics",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["input.txt"],
        search: "old",
        replace: "longer",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      }],
      policy: {
        maxFiles: 2,
        maxMatches: 2,
        maxChangedBytes: 6,
        maxRepositoryPercent: 50,
      },
      validations: [],
    });
    const capture = captureIo({ cwd: root });

    expect(await main(["plan", source, "--json"], capture.io)).toBe(0);

    const result = JSON.parse(capture.stdout.join("")) as {
      planning: { policy: { actual: Record<string, number>; limits: Record<string, number>; violations: string[] } };
    };
    expect(result.planning.policy).toEqual({
      actual: {
        changedBytes: 5,
        files: 1,
        matches: 1,
        repositoryFiles: 2,
        repositoryPercent: 50,
      },
      limits: {
        changedBytes: 6,
        files: 2,
        matches: 2,
        repositoryPercent: 50,
      },
      violations: [],
    });
  });

  it("keeps one index-aware repository denominator across plan, inspect, and saved apply", async () => {
    const root = await temporaryRepository();
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "old\n", "utf8");
    await writeFile(join(root, "tracked-extra.txt"), "still tracked\n", "utf8");
    await writeFile(join(root, "tracked-deleted.txt"), "deleted from worktree\n", "utf8");
    execFileSync("git", ["add", "tracked.txt", "tracked-extra.txt", "tracked-deleted.txt"], { cwd: root });
    await rm(join(root, "tracked-deleted.txt"));
    await writeFile(join(root, ".gitignore"), "tracked.txt\nignored.txt\n", "utf8");
    await writeFile(join(root, "visible.txt"), "visible\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "ignored\n", "utf8");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "non-utf8.dat"), Buffer.from([0xff]));
    const source = await writeRewritePlan(root, {
      version: 1,
      name: "index-aware denominator",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["tracked.txt"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      }],
      policy: { maxRepositoryPercent: 25 },
      validations: [],
    });
    const planned = captureIo({ cwd: root });

    expect(await main(["plan", source, "--plan-out", "saved.json", "--json"], planned.io)).toBe(0);
    const inspected = captureIo({ cwd: root });
    expect(await main(["inspect", "saved.json", "--json"], inspected.io)).toBe(0);
    const applied = captureIo({ cwd: root });
    expect(await main(["apply", "saved.json", "--json"], applied.io)).toBe(0);

    const actuals = [planned, inspected, applied].map((capture) =>
      (JSON.parse(capture.stdout.join("")) as {
        planning: { policy: { actual: Record<string, number> } };
      }).planning.policy.actual,
    );
    expect(actuals).toEqual([
      { changedBytes: 3, files: 1, matches: 1, repositoryFiles: 4, repositoryPercent: 25 },
      { changedBytes: 3, files: 1, matches: 1, repositoryFiles: 4, repositoryPercent: 25 },
      { changedBytes: 3, files: 1, matches: 1, repositoryFiles: 4, repositoryPercent: 25 },
    ]);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("old\n");
  });
});

describe("CLI plan protocols and output", () => {
  it("excludes only the exact saved plan artifact when re-deriving a broad-root apply", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    await writeFile(join(root, "ordinary.json"), '{"message":"old"}\n', "utf8");
    const source = await writeRewritePlan(root, {
      version: 1,
      name: "broad saved lifecycle",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["."],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      }],
      policy: {},
      validations: [],
    });
    const planned = captureIo({ cwd: root });
    expect(await main(["plan", source, "--plan-out", "saved-plan.json", "--json"], planned.io)).toBe(0);
    const savedBefore = await readFile(join(root, "saved-plan.json"), "utf8");
    expect(savedBefore).toContain("old");
    const applied = captureIo({ cwd: root });

    expect(await main(["apply", "saved-plan.json", "--write", "--json"], applied.io)).toBe(0);

    expect(JSON.parse(applied.stdout.join(""))).toMatchObject({ outcome: "written", edits: 2 });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(root, "ordinary.json"), "utf8")).toBe('{"message":"new"}\n');
    expect(await readFile(join(root, "saved-plan.json"), "utf8")).toBe(savedBefore);
  });

  it("reports a no-op without prompting and preserves repeated languages and globs in plan-out", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.ts"), "const value = 1;\n", "utf8");
    let confirmations = 0;
    const capture = captureIo({
      cwd: root,
      isTTY: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
    });

    const code = await main([
      "--search", "absentCall()",
      "--replace", "nextCall()",
      "--lang", "typescript",
      "--lang", "javascript",
      "--glob", "*.ts",
      "--glob", "!vendor/**",
      "--plan-out", "saved-plan.json",
      "input.ts",
    ], capture.io);

    expect(code).toBe(0);
    expect(confirmations).toBe(0);
    const saved = JSON.parse(await readFile(join(root, "saved-plan.json"), "utf8")) as EditPlan;
    expect(saved.rewritePlan.operations[0]?.languages).toEqual(["typescript", "javascript"]);
    expect(saved.rewritePlan.operations[0]?.globs).toEqual(["*.ts", "!vendor/**"]);
  });

  it("uses every repeated --lang as an AST candidate override for ambiguous headers", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "ambiguous.h"), "int f(int value) { old(value); return 0; }\n", "utf8");
    const capture = captureIo({ cwd: root });

    const code = await main([
      "--search", "old($ARG);",
      "--replace", "new(${ARG});",
      "--lang", "c",
      "--lang", "cpp",
      "--write",
      "--json",
      "ambiguous.h",
    ], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(
      await readFile(join(root, "ambiguous.h"), "utf8"),
      `${capture.stderr.join("")}\n${capture.stdout.join("")}`,
    ).toContain("new(value)");
    const result = JSON.parse(capture.stdout.join("")) as {
      planning: { classifications: Record<string, number> };
    };
    expect(result.planning.classifications["ast-only"]).toBe(1);
    expect(capture.stderr.join("")).not.toMatch(/unsupported language|provider.*fail/i);
  });

  it("canonicalizes operation paths before lexical and structural scope checks", async () => {
    const root = await temporaryRepository();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "input.ts"), "old(value);\n", "utf8");
    const source = await writeRewritePlan(root, {
      version: 1,
      name: "canonical path",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["./src/"],
        search: "old($ARG)",
        replace: "new(${ARG})",
        lexical: { type: "literal" },
      }],
      policy: {},
      validations: [],
    });
    const capture = captureIo({ cwd: root });

    const code = await main(["plan", source, "--write", "--json"], capture.io);

    expect(code, capture.stderr.join("")).toBe(0);
    expect(
      await readFile(join(root, "src", "input.ts"), "utf8"),
      `${capture.stderr.join("")}\n${capture.stdout.join("")}`,
    ).toBe("new(value);\n");
    const result = JSON.parse(capture.stdout.join("")) as { planning: { editPlan: EditPlan } };
    expect(result.planning.editPlan.rewritePlan.operations[0]?.paths).toEqual(["src"]);
    expect(result.planning.editPlan.edits[0]?.file).toBe("src/input.ts");
  });

  it("renders complete bounded human and JSON planning previews", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const source = await writeRewritePlan(root, {
      version: 1,
      name: "complete preview",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["input.txt"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
        expectedCount: { exact: 1 },
      }],
      policy: { maxFiles: 2 },
      validations: [{
        type: "prettier",
        paths: ["input.txt"],
        cwd: ".",
        timeoutMs: 1_234,
        maxOutputBytes: 5_678,
      }],
    });
    const human = captureIo({ cwd: root });
    const json = captureIo({ cwd: root });
    const prettier = join(root, "fake-prettier");
    await writeFile(prettier, [
      "#!/usr/bin/env node",
      "for await (const chunk of process.stdin) process.stdout.write(chunk);",
      "",
    ].join("\n"), "utf8");
    await chmod(prettier, 0o755);

    expect(await main(["plan", source], human.io, { validationExecutables: { prettier } })).toBe(0);
    expect(await main(["plan", source, "--json"], json.io, { validationExecutables: { prettier } })).toBe(0);

    expect(human.stdout.join("")).toMatch(/Classifications:.*unparseable=1/i);
    expect(human.stdout.join("")).toMatch(/Conflicts: none/i);
    expect(human.stdout.join("")).toMatch(/Skipped\/unparseable:/i);
    expect(human.stdout.join("")).toMatch(/Changed bytes: 3/i);
    expect(human.stdout.join("")).toMatch(/Policy:.*files=1\/2/i);
    expect(human.stdout.join("")).toContain("Expected counts:\n- rename: exact=1, actual=1 PASS\n");
    expect(human.stdout.join("")).toContain(
      "Validations:\n- prettier(paths=input.txt; cwd=.; timeoutMs=1234; maxOutputBytes=5678)\n",
    );
    const result = JSON.parse(json.stdout.join("")) as {
      planning: {
        classifications: Record<string, number>;
        conflicts: unknown[];
        diagnostics: unknown[];
        editPlan: EditPlan;
        invariants: unknown[];
        policy: unknown;
        preview: string;
        skippedOrUnparseable: unknown[];
        validations: unknown[];
      };
    };
    expect(result.planning.editPlan.edits).toHaveLength(1);
    expect(result.planning.classifications.unparseable).toBe(1);
    expect(result.planning.conflicts).toEqual([]);
    expect(result.planning.diagnostics.length).toBeGreaterThan(0);
    expect(result.planning.preview).toContain("-old");
    expect(result.planning.skippedOrUnparseable.length).toBeGreaterThan(0);
    expect(result.planning.invariants).toEqual([{
      operationId: "rename",
      constraint: { exact: 1 },
      actual: 1,
      status: "passed",
    }]);
    expect(result.planning.validations).toEqual([{
      type: "prettier",
      paths: ["input.txt"],
      cwd: ".",
      timeoutMs: 1_234,
      maxOutputBytes: 5_678,
    }]);
  });

  it("does not snapshot or follow files inside Git-ignored dependency directories", async () => {
    const root = await temporaryRepository();
    const outside = await temporaryRepository();
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(outside, "secret.ts"), "old\n", "utf8");
    await symlink(outside, join(root, "node_modules", "escaped"));
    await writeFile(join(root, "input.ts"), "const value = 1;\n", "utf8");
    const capture = captureIo({ cwd: root });

    const code = await main(["--search", "absent", "--replace", "new", "."], capture.io);

    expect(code).toBe(0);
    expect(capture.stderr.join("")).not.toMatch(/escape|node_modules/i);
    expect(await readFile(join(outside, "secret.ts"), "utf8")).toBe("old\n");
  });

  it("keeps tracked files eligible when a later Git-ignore rule matches them", async () => {
    const root = await temporaryRepository();
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "old\n", "utf8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(join(root, ".gitignore"), "tracked.txt\n", "utf8");
    const capture = captureIo({ cwd: root });

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--write",
      ".",
    ], capture.io);

    expect(code).toBe(0);
    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("new\n");
  });

  it("rejects a saved edit plan whose embedded rewrite-plan hash was changed", async () => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root);
    const plan = JSON.parse(await readFile(planPath, "utf8")) as EditPlan;
    plan.rewritePlan.operations[0]!.replace = "attacker";
    await writeFile(planPath, JSON.stringify(plan), "utf8");
    const capture = captureIo({ cwd: root, isTTY: true, confirm: async () => true });

    const code = await main(["inspect", planPath], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/hash/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });

  it("accepts a strict concrete RewritePlan over stdin for the plan command", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.ts"), "const value = 1;\n", "utf8");
    const rewritePlan: RewritePlan = {
      version: 1,
      name: "stdin plan",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["input.ts"],
        search: "absent",
        replace: "new",
        lexical: { type: "literal" },
      }],
      policy: {},
      validations: [],
    };
    const capture = captureIo({ cwd: root });
    capture.io.stdin = async () => JSON.stringify(rewritePlan);

    const code = await main(["plan", "-", "--json"], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      command: "plan",
      outcome: "no-op",
    });
  });

  it("inspects a valid saved plan without mutating its targets", async () => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root);
    const capture = captureIo({ cwd: root });

    const code = await main(["inspect", planPath, "--json"], capture.io);

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      command: "inspect",
      outcome: "inspected",
      edits: 1,
    });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });

  it("emits one stable JSON document on stdout and diagnostics only on stderr", async () => {
    const first = captureIo();
    const second = captureIo();
    const argv = ["--json", "--search", "old", "--replace", "new", "--dry-run", "--write"];

    expect(await main(argv, first.io)).toBe(1);
    expect(await main(argv, second.io)).toBe(1);

    expect(first.stdout).toHaveLength(1);
    expect(first.stdout[0]).toBe(second.stdout[0]);
    expect(first.stdout[0]).toBe(
      '{"command":"rewrite","exitCode":1,"outcome":"invalid","version":1}\n',
    );
    expect(first.stderr.join("")).toMatch(/mutually exclusive/i);
    expect(() => JSON.parse(first.stdout[0] ?? "")).not.toThrow();
  });

  it("applies, verifies, and safely undoes a schema-validated transaction record", async () => {
    const root = await temporaryRepository();
    const planPath = await savedEditPlan(root);
    const writeCapture = captureIo({ cwd: root });

    expect(await main(["apply", planPath, "--write", "--json"], writeCapture.io)).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
    const writeResult = JSON.parse(writeCapture.stdout.join("")) as { transactionId: string };
    const recordPath = join(root, ".tfs-ripast", "transactions", `${writeResult.transactionId}.json`);

    const verifyCapture = captureIo({ cwd: root });
    expect(await main(["verify", recordPath, "--json"], verifyCapture.io)).toBe(0);
    expect(JSON.parse(verifyCapture.stdout.join(""))).toMatchObject({ outcome: "verified" });

    const undoPreview = captureIo({ cwd: root });
    expect(await main(["undo", recordPath, "--json"], undoPreview.io)).toBe(0);
    expect(JSON.parse(undoPreview.stdout.join(""))).toMatchObject({ outcome: "previewed" });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");

    const undoCapture = captureIo({ cwd: root });
    expect(await main(["undo", recordPath, "--write", "--json"], undoCapture.io)).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    expect(JSON.parse(undoCapture.stdout.join(""))).toMatchObject({ outcome: "undone" });
  });

  it("derives undo preview from validated current and retained bytes instead of mutable record text", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const planPath = await generatedEditPlan(root);
    const writeCapture = captureIo({ cwd: root });
    expect(await main(["apply", planPath, "--write", "--json"], writeCapture.io)).toBe(0);
    const writeResult = JSON.parse(writeCapture.stdout.join("")) as { transactionId: string };
    const recordPath = join(root, ".tfs-ripast", "transactions", `${writeResult.transactionId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as TransactionRecord;
    record.inversePatch = "ATTACKER-CONTROLLED INVERSE PATCH\n";
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    let approvedPreview = "";
    const capture = captureIo({
      cwd: root,
      isTTY: true,
      confirm: async () => {
        approvedPreview = capture.stdout.join("");
        return true;
      },
    });

    const code = await main(["undo", recordPath], capture.io);

    expect(code).toBe(0);
    expect(approvedPreview).toContain("-new");
    expect(approvedPreview).toContain("+old");
    expect(approvedPreview).not.toContain("ATTACKER-CONTROLLED");
    expect(capture.stderr.join("")).toMatch(/stored inverse patch.*differ/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });

  it("includes the authoritative recomputed undo patch in JSON preview", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const planPath = await generatedEditPlan(root);
    const writeCapture = captureIo({ cwd: root });
    expect(await main(["apply", planPath, "--write", "--json"], writeCapture.io)).toBe(0);
    const writeResult = JSON.parse(writeCapture.stdout.join("")) as { transactionId: string };
    const recordPath = join(root, ".tfs-ripast", "transactions", `${writeResult.transactionId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as TransactionRecord;
    record.inversePatch = "forged";
    await writeFile(recordPath, JSON.stringify(record), "utf8");
    const capture = captureIo({ cwd: root });

    expect(await main(["undo", recordPath, "--json"], capture.io)).toBe(0);

    const result = JSON.parse(capture.stdout.join("")) as {
      undoPreview: { patch: string; storedInversePatchMatches: boolean };
    };
    expect(result.undoPreview.patch).toContain("-new");
    expect(result.undoPreview.patch).toContain("+old");
    expect(result.undoPreview.patch).not.toContain("forged");
    expect(result.undoPreview.storedInversePatchMatches).toBe(false);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
  });

  it.each(["expected-count", "conflict", "match-policy"] as const)(
    "rejects a self-rehashed saved plan with an omitted %s derivation result",
    async (omission) => {
      const root = await temporaryRepository();
      await writeFile(join(root, "input.txt"), "old\n", "utf8");
      let plan: EditPlan;
      if (omission === "conflict") {
        const rewritePlan: RewritePlan = {
          version: 1,
          name: "conflicting derivation",
          root: ".",
          operations: [
            {
              id: "first",
              paths: ["input.txt"],
              search: "old",
              replace: "new",
              lexical: { type: "literal" },
              matchPolicy: { onUnparseable: "allow" },
            },
            {
              id: "second",
              paths: ["input.txt"],
              search: "old",
              replace: "other",
              lexical: { type: "literal" },
              matchPolicy: { onUnparseable: "allow" },
            },
          ],
          policy: {},
          validations: [],
        };
        const source = await writeRewritePlan(root, rewritePlan, "conflict-source.json");
        const planned = captureIo({ cwd: root });
        expect(await main(["plan", source, "--json"], planned.io)).toBe(1);
        const publicPlan = (JSON.parse(planned.stdout.join("")) as {
          planning: { editPlan: Omit<EditPlan, "createdAt"> };
        }).planning.editPlan;
        plan = { ...publicPlan, createdAt: "2026-08-21T00:00:00.000Z" };
        plan.edits = plan.edits.slice(0, 1);
        plan.conflicts = [];
        plan.diagnostics = plan.diagnostics.filter((item) => item.code !== "unresolved-conflicts");
      } else {
        const path = await generatedEditPlan(root);
        plan = JSON.parse(await readFile(path, "utf8")) as EditPlan;
        if (omission === "expected-count") {
          plan.rewritePlan.operations[0]!.expectedCount = { exact: 0 };
        } else {
          plan.rewritePlan.operations[0]!.matchPolicy = {
            ...plan.rewritePlan.operations[0]!.matchPolicy,
            require: "confirmed",
          };
        }
      }
      rehashEditPlan(plan);
      const maliciousPath = join(root, `omitted-${omission}.json`);
      await writeFile(maliciousPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      const capture = captureIo({ cwd: root, isTTY: true, confirm: async () => true });

      const code = await main(["apply", maliciousPath, "--write", "--json"], capture.io);

      expect(code).toBe(1);
      expect(capture.stderr.join("")).toMatch(/deriv|canonical|saved plan/i);
      expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    },
  );

  it("refuses --plan-out when its generated artifact exceeds the bounded loader", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const capture = captureIo({ cwd: root });
    const oversizedReplacement = "x".repeat(8 * 1024 * 1024);

    const code = await main([
      "--search", "absent",
      "--replace", oversizedReplacement,
      "--plan-out", "oversized-plan.json",
      "input.txt",
    ], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/reload|protocol|bytes|size/i);
    await expect(readFile(join(root, "oversized-plan.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  }, 30_000);

  it("proves the transaction record fits the loader cap before any source mutation", async () => {
    const root = await temporaryRepository();
    const original = `${"a".repeat(4_300_000)}old\n`;
    await writeFile(join(root, "large.txt"), original, "utf8");
    const source = await writeRewritePlan(root, {
      version: 1,
      name: "large inverse patch",
      root: ".",
      operations: [{
        id: "rename",
        paths: ["large.txt"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
      }],
      policy: {},
      validations: [],
    });
    const capture = captureIo({ cwd: root });

    const code = await main(["plan", source, "--write", "--json"], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/transaction record.*(?:bytes|size|loader|limit)/i);
    expect(await readFile(join(root, "large.txt"), "utf8")).toBe(original);
    await expect(readdir(join(root, ".tfs-ripast", "transactions"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects a loader-sized minified undo record whose required persisted form would exceed the cap", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const planPath = await generatedEditPlan(root);
    const applied = captureIo({ cwd: root });
    expect(await main(["apply", planPath, "--write", "--json"], applied.io)).toBe(0);
    const { transactionId } = JSON.parse(applied.stdout.join("")) as { transactionId: string };
    const recordPath = join(root, ".tfs-ripast", "transactions", `${transactionId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as TransactionRecord;
    record.inversePatch = "";
    const emptyBytes = Buffer.byteLength(JSON.stringify(record));
    record.inversePatch = "x".repeat((8 * 1024 * 1024) - emptyBytes - 1);
    const minified = JSON.stringify(record);
    expect(Buffer.byteLength(minified)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`)).toBeGreaterThan(8 * 1024 * 1024);
    await writeFile(recordPath, minified, "utf8");
    const capture = captureIo({ cwd: root });

    const code = await main(["undo", recordPath, "--write", "--json"], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/persisted.*record.*(?:bytes|protocol|limit|reload)/i);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
  }, 30_000);

  it("cleans up and fails closed when a plan-output parent is replaced at the final pre-rename gate", async () => {
    const root = await temporaryRepository();
    const outside = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "unchanged\n", "utf8");
    await mkdir(join(root, "out"));
    const parent = join(root, "out");
    const movedParent = join(root, "out-before-swap");
    let parentRealpaths = 0;
    let swapped = false;
    const injected: TransactionFileSystem = {
      ...nodeTransactionFileSystem,
      realpath: async (path) => {
        if (path === parent) {
          parentRealpaths += 1;
          if (parentRealpaths === 3) {
            await rename(parent, movedParent);
            await symlink(outside, parent);
            swapped = true;
          }
        }
        return nodeTransactionFileSystem.realpath(path);
      },
      unlink: async (path) => {
        if (swapped && path.includes(".plan.json.") && path.endsWith(".tmp")) {
          await nodeTransactionFileSystem.unlink(parent);
          await rename(movedParent, parent);
          swapped = false;
        }
        await nodeTransactionFileSystem.unlink(path);
      },
    };
    const capture = captureIo({ cwd: root });

    const code = await main([
      "--search", "absent",
      "--replace", "new",
      "--plan-out", "out/plan.json",
      "input.txt",
    ], capture.io, { fileSystem: injected });

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/canonical|symlink|contain|changed/i);
    await expect(readFile(join(outside, "plan.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(parent)).toEqual([]);
  });

  it("does not clobber a destination created at the plan publication boundary", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "unchanged\n", "utf8");
    const destination = join(root, "saved-plan.json");
    let claimed = false;
    const claimDestination = async (): Promise<void> => {
      if (!claimed) {
        claimed = true;
        await writeFile(destination, "concurrent creator\n", { flag: "wx" });
      }
    };
    const injected = {
      ...nodeTransactionFileSystem,
      rename: async (source: string, target: string) => {
        await claimDestination();
        await nodeTransactionFileSystem.rename(source, target);
      },
      link: async (source: string, target: string) => {
        await claimDestination();
        await linkFile(source, target);
      },
    };
    const capture = captureIo({ cwd: root });

    const code = await main([
      "--search", "absent",
      "--replace", "new",
      "--plan-out", "saved-plan.json",
      "input.txt",
    ], capture.io, { fileSystem: injected });

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/exist|publish|destination|plan output/i);
    expect(await readFile(destination, "utf8")).toBe("concurrent creator\n");
    expect((await readdir(root)).filter((name) => name.startsWith(".saved-plan.json.") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans a sibling created by an exclusive write that then rejects", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "unchanged\n", "utf8");
    const destination = join(root, "saved-plan.json");
    let partialSibling: string | undefined;
    const injected: TransactionFileSystem = {
      ...nodeTransactionFileSystem,
      writeFile: async (path, data, options) => {
        if (path.includes(".saved-plan.json.") && path.endsWith(".tmp")) {
          partialSibling = path;
          const partial = typeof data === "string" ? data.slice(0, 32) : data.subarray(0, 32);
          await nodeTransactionFileSystem.writeFile(path, partial, options);
          throw Object.assign(new Error("injected partial plan write failure"), { code: "ENOSPC" });
        }
        await nodeTransactionFileSystem.writeFile(path, data, options);
      },
    };
    const capture = captureIo({ cwd: root });

    const code = await main([
      "--search", "absent",
      "--replace", "new",
      "--plan-out", "saved-plan.json",
      "input.txt",
    ], capture.io, { fileSystem: injected });

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toContain("injected partial plan write failure");
    expect(partialSibling).toBeDefined();
    await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(partialSibling!)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.startsWith(".saved-plan.json.") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("reports truthful publication success when post-link sibling cleanup fails", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.txt"), "unchanged\n", "utf8");
    const destination = join(root, "saved-plan.json");
    let publishedSibling: string | undefined;
    let cleanupAttempts = 0;
    const injected: TransactionFileSystem = {
      ...nodeTransactionFileSystem,
      link: async (source, target) => {
        publishedSibling = source;
        await nodeTransactionFileSystem.link(source, target);
      },
      unlink: async (path) => {
        if (path === publishedSibling) {
          cleanupAttempts += 1;
          throw Object.assign(new Error("injected post-link cleanup failure"), { code: "EIO" });
        }
        await nodeTransactionFileSystem.unlink(path);
      },
    };
    const capture = captureIo({ cwd: root });

    const code = await main([
      "--search", "absent",
      "--replace", "new",
      "--plan-out", "saved-plan.json",
      "--json",
      "input.txt",
    ], capture.io, { fileSystem: injected });

    expect(code).toBe(0);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({ outcome: "no-op", exitCode: 0 });
    expect(cleanupAttempts).toBeGreaterThanOrEqual(2);
    expect(publishedSibling).toBeDefined();
    expect(capture.stderr.join("")).toContain("Plan output was published");
    expect(capture.stderr.join("")).toContain(publishedSibling!.slice(root.length + 1));
    expect(Buffer.byteLength(capture.stderr.join(""))).toBeLessThan(1_024);
    expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({ version: 1 });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("unchanged\n");
    expect(await readFile(publishedSibling!, "utf8")).toEqual(await readFile(destination, "utf8"));

    await nodeTransactionFileSystem.unlink(publishedSibling!);
    await expect(readFile(publishedSibling!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses parsed option tokens, not values, as JSON output authority", async () => {
    const capture = captureIo();

    const code = await main(["--search", "--json", "--replace", "new", "missing-path"], capture.io);

    expect(code).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toMatch(/path|provider|discovery|ripgrep/i);
  });

  it("only grants JSON error output authority to a flag parsed before an argument error", async () => {
    const before = captureIo();
    const after = captureIo();

    expect(await main(["--unknown", "--json"], before.io)).toBe(1);
    expect(await main(["--json", "--unknown"], after.io)).toBe(1);

    expect(before.stdout).toEqual([]);
    expect(after.stdout).toHaveLength(1);
    expect(JSON.parse(after.stdout.join(""))).toMatchObject({ outcome: "invalid" });
  });

  it.each(["apply", "undo"] as const)("rejects --plan-out for the %s command before loading input", async (command) => {
    const capture = captureIo();

    const code = await main([command, "missing.json", "--plan-out", "out.json"], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(new RegExp(`${command}.*plan-output|plan-output.*${command}`, "i"));
  });

  it("rejects untrusted traversal paths in saved transaction records", async () => {
    const root = await temporaryRepository();
    const record: TransactionRecord = {
      version: 1,
      id: "transaction-malicious",
      editPlanHash: hash("plan"),
      changedPaths: ["../outside.txt"],
      files: [{
        path: "../outside.txt",
        beforeHash: hash("old"),
        afterHash: hash("new"),
        beforeMode: 0o644,
        afterMode: 0o644,
      }],
      validations: [],
      inversePatch: "",
      startedAt: "2026-08-21T00:00:00.000Z",
      completedAt: "2026-08-21T00:00:01.000Z",
      state: "committed",
    };
    const recordPath = join(root, "malicious.json");
    await writeFile(recordPath, JSON.stringify(record), "utf8");
    const capture = captureIo({ cwd: root });

    const code = await main(["verify", recordPath], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/path|relative|invalid/i);
  });

  it("does not trust a saved edit plan to redirect its root outside the invocation root", async () => {
    const invocationRoot = await temporaryRepository();
    const outside = await temporaryRepository();
    const planPath = await savedEditPlan(outside);
    const capture = captureIo({ cwd: invocationRoot });

    const code = await main(["apply", planPath, "--write"], capture.io);

    expect(code).toBe(1);
    expect(capture.stderr.join("")).toMatch(/root|contain/i);
    expect(await readFile(join(outside, "input.txt"), "utf8")).toBe("old\n");
  });

  it("uses exit code 2 and a provider-failure JSON outcome for discovery execution failures", async () => {
    const root = await temporaryRepository();
    const capture = captureIo({ cwd: root });

    const code = await main([
      "--search", "old",
      "--replace", "new",
      "--json",
      "missing-path",
    ], capture.io);

    expect(code).toBe(2);
    expect(JSON.parse(capture.stdout.join(""))).toEqual({
      command: "rewrite",
      exitCode: 2,
      outcome: "provider-failure",
      version: 1,
    });
  });

  it("uses exit code 2 when the ripgrep dependency cannot be spawned", async () => {
    const root = await temporaryRepository();
    await writeFile(join(root, "input.ts"), "old\n", "utf8");
    const capture = captureIo({ cwd: root });
    const runWithRuntime = main as unknown as (
      argv: readonly string[],
      io: CliIo,
      runtime: { ripgrepExecutable: string },
    ) => Promise<number>;

    const code = await runWithRuntime([
      "--search", "old",
      "--replace", "new",
      "--json",
      "input.ts",
    ], capture.io, { ripgrepExecutable: join(root, "missing-rg") });

    expect(code).toBe(2);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      exitCode: 2,
      outcome: "provider-failure",
    });
  });

  it("uses exit code 3 when a commit cannot completely roll back", async () => {
    const root = await temporaryRepository();
    const planPath = await savedTwoFilePlan(root);
    const injected: TransactionFileSystem = {
      ...nodeTransactionFileSystem,
      rename: async (source, destination) => {
        if (source.includes("tfs-ripast-") && source.endsWith("-after") && destination.endsWith("b.txt")) {
          throw new Error("injected second target failure");
        }
        if (source.includes("tfs-ripast-") && source.endsWith("-before") && destination.endsWith("a.txt")) {
          throw new Error("injected rollback failure");
        }
        await nodeTransactionFileSystem.rename(source, destination);
      },
    };
    const capture = captureIo({ cwd: root });
    const runWithRuntime = main as unknown as (
      argv: readonly string[],
      io: CliIo,
      runtime: { fileSystem: TransactionFileSystem },
    ) => Promise<number>;

    const code = await runWithRuntime(["apply", planPath, "--write", "--json"], capture.io, {
      fileSystem: injected,
    });

    expect(code).toBe(3);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      exitCode: 3,
      outcome: "partial-commit",
      state: "partial-commit",
    });
  });
});
