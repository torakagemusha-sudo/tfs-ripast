import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExperiment } from "../../src/benchmark/runner.js";
import { buildCrossoverSchedule } from "../../src/benchmark/schedule.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("crossover schedule", () => {
  it("contains each fixture-mode cell once and shuffles reproducibly", () => {
    const pairs = [{ workload: "textual", a: "textual-a", b: "textual-b" }];
    const first = buildCrossoverSchedule("fixed-seed", pairs, 1);
    expect(first).toEqual(buildCrossoverSchedule("fixed-seed", pairs, 1));
    expect(first.map(({ fixture, mode }) => `${fixture}:${mode}`).sort()).toEqual([
      "textual-a:normal", "textual-a:ripast", "textual-b:normal", "textual-b:ripast",
    ]);
  });
});

describe("runExperiment", () => {
  it("blocks both project aliases in normal mode with a portable launcher", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ripast-runner-denied-alias-"));
    roots.push(tempRoot);
    const artifact = join(tempRoot, "artifact.js");
    const agent = join(tempRoot, "probe-agent.mjs");
    await writeFile(artifact, "// artifact\n", "utf8");
    await writeFile(agent, [
      "import { execFileSync } from 'node:child_process';",
      "import { readFile, writeFile } from 'node:fs/promises';",
      "const target = (await readFile('prompt.md', 'utf8')).includes('legacyMode') ? 'src/config.ts' : 'src/settings.ts';",
      "const source = await readFile(target, 'utf8');",
      "const changed = target.endsWith('config.ts') ? source.replaceAll('legacyMode:', 'safeMode:').replaceAll('.legacyMode', '.safeMode') : source.replaceAll('unsafeDefault:', 'verifiedDefault:').replaceAll('.unsafeDefault', '.verifiedDefault');",
      "await writeFile(target, changed, 'utf8');",
      "const event = (tool) => console.log(`TFS_BENCH_EVENT ${JSON.stringify({ sequence: 1, tool, status: 'ok', startedNs: process.hrtime.bigint().toString(), endedNs: process.hrtime.bigint().toString() })}`);",
      "if (process.env.TFS_RIPAST_MODE === 'normal') for (const name of ['tfs-ripast', 'rpst']) {",
      "  try { execFileSync(name, ['--version'], { stdio: 'pipe' }); process.exit(2); }",
      "  catch (error) { if (error?.status !== 126) process.exit(3); }",
      "}",
      "event('alias-probe');",
    ].join("\n"), "utf8");
    const record = await runExperiment({
      schemaVersion: 1, seed: "portable-denied-alias", repetitions: 1, model: "local-probe",
      fixtureRoot: join(process.cwd(), "benchmarks", "fixtures"),
      pairs: [{ workload: "textual", a: "textual-a", b: "textual-b" }], timeoutMs: 5_000,
    }, {
      agentCommand: [process.execPath, agent],
      ripastArtifact: artifact,
      tempRoot,
    });
    expect(record.trials.every((trial) => trial.status === "success" && trial.commandCount === 1)).toBe(true);
  });

  it("rejects fixture selectors that escape the fixture root", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ripast-runner-traversal-"));
    roots.push(tempRoot);
    const artifact = join(tempRoot, "artifact.js");
    await writeFile(artifact, "// artifact\n");
    await expect(runExperiment({
      schemaVersion: 1, seed: "traversal", repetitions: 1, model: "attacker",
      fixtureRoot: join(process.cwd(), "benchmarks", "fixtures"),
      pairs: [{ workload: "textual", a: "../..", b: "textual-b" }], timeoutMs: 5_000,
    }, {
      agentCommand: [process.execPath, join(process.cwd(), "benchmarks", "helpers", "fake-agent.mjs")],
      ripastArtifact: artifact,
      tempRoot,
    })).rejects.toThrow(/fixture identifier/);
  });

  it("runs four isolated successful cells and records the Ripast artifact only in Ripast mode", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ripast-runner-test-"));
    roots.push(tempRoot);
    const artifact = join(tempRoot, "ripast-artifact.js");
    await writeFile(artifact, "// pinned artifact\n", "utf8");
    const record = await runExperiment({
      schemaVersion: 1,
      seed: "fixed-seed",
      repetitions: 1,
      model: "local-fake-agent",
      fixtureRoot: join(process.cwd(), "benchmarks", "fixtures"),
      pairs: [{ workload: "textual", a: "textual-a", b: "textual-b" }],
      timeoutMs: 5_000,
    }, {
      agentCommand: [process.execPath, join(process.cwd(), "benchmarks", "helpers", "fake-agent.mjs")],
      ripastArtifact: artifact,
      tempRoot,
    });
    expect(record.trials).toHaveLength(4);
    expect(record.trials.every((trial) => trial.status === "success" && trial.commandCount === 3)).toBe(true);
    expect(new Set(record.trials.map((trial) => trial.trialDirectory)).size).toBe(4);
    expect(record.trials.filter((trial) => trial.mode === "normal").every((trial) => trial.ripastArtifactHash === null)).toBe(true);
    expect(record.trials.filter((trial) => trial.mode === "ripast").every((trial) => typeof trial.ripastArtifactHash === "string")).toBe(true);
  });

  it("keeps failed rewrites visible and ineligible", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "ripast-runner-fail-"));
    roots.push(tempRoot);
    const artifact = join(tempRoot, "ripast-artifact.js");
    await writeFile(artifact, "// pinned artifact\n", "utf8");
    const record = await runExperiment({
      schemaVersion: 1,
      seed: "failure",
      repetitions: 1,
      model: "local-fake-agent",
      fixtureRoot: join(process.cwd(), "benchmarks", "fixtures"),
      pairs: [{ workload: "textual", a: "textual-a", b: "textual-b" }],
      timeoutMs: 5_000,
    }, {
      agentCommand: [process.execPath, join(process.cwd(), "benchmarks", "helpers", "fake-agent.mjs")],
      ripastArtifact: artifact,
      tempRoot,
      extraEnv: { TFS_BENCH_FAIL: "1" },
    });
    expect(record.trials.every((trial) => trial.status === "failed" && trial.correct === false)).toBe(true);
  });
});
