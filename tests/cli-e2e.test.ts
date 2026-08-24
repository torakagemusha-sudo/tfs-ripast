import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RewritePlan } from "../src/types.js";

const temporaryRoots: string[] = [];
let aliasInstallRoot = "";
let aliases: { tfsRipast: string; rpst: string };

beforeAll(async () => {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || npmCli.length === 0) {
    throw new Error("npm_execpath is required to exercise package-generated CLI aliases");
  }
  execFileSync(process.execPath, [
    join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(process.cwd(), "tsconfig.json"),
  ]);
  aliasInstallRoot = await mkdtemp(join(tmpdir(), "tfs-ripast-npm-link-"));
  await mkdir(join(aliasInstallRoot, "lib"), { recursive: true });
  await mkdir(join(aliasInstallRoot, "bin"), { recursive: true });
  execFileSync(process.execPath, [
    npmCli,
    "link",
    "--prefix",
    aliasInstallRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    process.cwd(),
  ], { stdio: "pipe" });
  aliases = {
    tfsRipast: join(aliasInstallRoot, "bin", "tfs-ripast"),
    rpst: join(aliasInstallRoot, "bin", "rpst"),
  };
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  if (aliasInstallRoot.length > 0) {
    await rm(aliasInstallRoot, { recursive: true, force: true });
  }
});

function runCli(root: string, argv: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [aliases.tfsRipast, ...argv], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runCliInPty(root: string, argv: readonly string[], input: string): SpawnSyncReturns<string> {
  const runner = join(process.cwd(), "tests", "fixtures", "pty-cli-runner.mjs");
  return spawnSync("script", [
    "-q",
    "-e",
    "-c",
    `${shellWord(process.execPath)} ${shellWord(runner)}`,
    "/dev/null",
  ], {
    cwd: root,
    encoding: "utf8",
    input,
    timeout: 30_000,
    env: {
      ...process.env,
      TFS_RIPAST_PTY_CLI: aliases.tfsRipast,
      TFS_RIPAST_PTY_ARGV: JSON.stringify(argv),
    },
  });
}

async function writePlan(root: string, plan: RewritePlan, name: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return path;
}

function literalPlan(
  root: string,
  options: { expectedCount?: number; conflicting?: boolean } = {},
): RewritePlan {
  return {
    version: 1,
    name: "compiled CLI plan",
    root,
    operations: [
      {
        id: "rename",
        paths: ["input.txt"],
        search: "old",
        replace: "new",
        lexical: { type: "literal" },
        matchPolicy: { onUnparseable: "allow" },
        ...(options.expectedCount === undefined ? {} : { expectedCount: { exact: options.expectedCount } }),
      },
      ...(options.conflicting ? [{
        id: "other",
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
}

describe("compiled CLI end to end", () => {
  it("keeps package-generated npm bin aliases byte-identical", async () => {
    const root = await temporaryDirectory("tfs-ripast-e2e-");
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const argv = ["--search", "old", "--replace", "new", "--json", "input.txt"];

    const canonical = spawnSync(process.execPath, [aliases.tfsRipast, ...argv], { cwd: root, encoding: "utf8" });
    const short = spawnSync(process.execPath, [aliases.rpst, ...argv], { cwd: root, encoding: "utf8" });

    expect(short.status).toBe(canonical.status);
    expect(short.stdout).toBe(canonical.stdout);
    expect(short.stderr).toBe(canonical.stderr);
    expect(canonical.status).toBe(0);
    expect(JSON.parse(canonical.stdout)).toMatchObject({ outcome: "previewed" });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });

  it("never mutates on non-TTY default execution and mutates only with --write", async () => {
    const root = await temporaryDirectory("tfs-ripast-e2e-write-");
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const common = ["--search", "old", "--replace", "new", "--json", "input.txt"];

    const preview = runCli(root, common);
    expect(preview.status).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");

    const write = runCli(root, [...common, "--write"]);
    expect(write.status).toBe(0);
    expect(JSON.parse(write.stdout)).toMatchObject({ outcome: "written" });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
  });

  it.each([
    ["yes", "y\n", "new\n"],
    ["no", "n\n", "old\n"],
    ["EOF", "\u0004", "old\n"],
  ])("honors a real TTY %s response", async (_label, input, expected) => {
    const root = await temporaryDirectory("tfs-ripast-e2e-pty-");
    await writeFile(join(root, "input.txt"), "old\n", "utf8");

    const result = runCliInPty(root, ["--search", "old", "--replace", "new", "input.txt"], input);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Apply all changes? [y/N]");
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe(expected);
  });

  it("executes real structural and regex provider flows", async () => {
    const root = await temporaryDirectory("tfs-ripast-e2e-providers-");
    await writeFile(join(root, "structural.ts"), "const result = old(value);\n", "utf8");
    await writeFile(join(root, "regex.txt"), "old12 old34\n", "utf8");

    const structural = runCli(root, [
      "--search", "old($ARG)",
      "--replace", "new(${ARG})",
      "--lang", "typescript",
      "--write",
      "--json",
      "structural.ts",
    ]);
    const regex = runCli(root, [
      "--search", "old[0-9]+",
      "--replace", "new",
      "--regex",
      "--write",
      "--json",
      "regex.txt",
    ]);

    expect(structural.status, structural.stderr).toBe(0);
    expect(regex.status, regex.stderr).toBe(0);
    expect(JSON.parse(structural.stdout).planning.classifications["ast-only"]).toBe(1);
    expect(JSON.parse(regex.stdout).planning.policy.actual.matches).toBe(2);
    expect(await readFile(join(root, "structural.ts"), "utf8")).toContain("new(value)");
    expect(await readFile(join(root, "regex.txt"), "utf8")).toBe("new new\n");
  });

  it("rejects real conflict, invariant, and stale-plan failures without mutation", async () => {
    const conflictRoot = await temporaryDirectory("tfs-ripast-e2e-conflict-");
    await writeFile(join(conflictRoot, "input.txt"), "old\n", "utf8");
    const conflictSource = await writePlan(conflictRoot, literalPlan(conflictRoot, { conflicting: true }), "conflict.json");
    const conflict = runCli(conflictRoot, ["plan", conflictSource, "--write", "--json"]);
    expect(conflict.status).toBe(1);
    expect(JSON.parse(conflict.stdout)).toMatchObject({ outcome: "conflict" });
    expect(await readFile(join(conflictRoot, "input.txt"), "utf8")).toBe("old\n");

    const invariantRoot = await temporaryDirectory("tfs-ripast-e2e-invariant-");
    await writeFile(join(invariantRoot, "input.txt"), "old\n", "utf8");
    const invariantSource = await writePlan(invariantRoot, literalPlan(invariantRoot, { expectedCount: 2 }), "invariant.json");
    const invariant = runCli(invariantRoot, ["plan", invariantSource, "--write", "--json"]);
    expect(invariant.status).toBe(1);
    expect(invariant.stderr).toMatch(/expected-count-exact/i);
    expect(await readFile(join(invariantRoot, "input.txt"), "utf8")).toBe("old\n");

    const staleRoot = await temporaryDirectory("tfs-ripast-e2e-stale-");
    await writeFile(join(staleRoot, "input.txt"), "old\n", "utf8");
    const staleSource = await writePlan(staleRoot, literalPlan(staleRoot), "source.json");
    const planned = runCli(staleRoot, ["plan", staleSource, "--plan-out", "saved.json", "--json"]);
    expect(planned.status).toBe(0);
    await writeFile(join(staleRoot, "input.txt"), "later\n", "utf8");
    const stale = runCli(staleRoot, ["apply", "saved.json", "--write", "--json"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/stale|derivation/i);
    expect(await readFile(join(staleRoot, "input.txt"), "utf8")).toBe("later\n");
  });

  it("runs saved plan inspect, apply, verify, preview-undo, and undo through the compiled command", async () => {
    const root = await temporaryDirectory("tfs-ripast-e2e-lifecycle-");
    await writeFile(join(root, "input.txt"), "old\n", "utf8");
    const source = await writePlan(root, literalPlan(root), "source.json");

    const planned = runCli(root, ["plan", source, "--plan-out", "saved.json", "--json"]);
    expect(planned.status, planned.stderr).toBe(0);
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
    const inspected = runCli(root, ["inspect", "saved.json", "--json"]);
    expect(inspected.status, inspected.stderr).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ outcome: "inspected" });

    const applied = runCli(root, ["apply", "saved.json", "--write", "--json"]);
    expect(applied.status, applied.stderr).toBe(0);
    const applyResult = JSON.parse(applied.stdout) as { transactionId: string };
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");
    const record = join(".tfs-ripast", "transactions", `${applyResult.transactionId}.json`);

    const verified = runCli(root, ["verify", record, "--json"]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ outcome: "verified" });
    const previewUndo = runCli(root, ["undo", record, "--json"]);
    expect(previewUndo.status, previewUndo.stderr).toBe(0);
    expect(JSON.parse(previewUndo.stdout).undoPreview.patch).toContain("+old");
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("new\n");

    const undone = runCli(root, ["undo", record, "--write", "--json"]);
    expect(undone.status, undone.stderr).toBe(0);
    expect(JSON.parse(undone.stdout)).toMatchObject({ outcome: "undone" });
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("old\n");
  });
});
