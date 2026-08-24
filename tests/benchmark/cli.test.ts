import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runBenchmarkCli } from "../../src/benchmark/cli.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

it("self-test writes versioned auditable JSON and Markdown", async () => {
  const output = await mkdtemp(join(tmpdir(), "ripast-cli-test-"));
  roots.push(output);
  const result = await runBenchmarkCli(["--self-test", "--output", output]);
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(await readFile(join(output, "results.json"), "utf8")) as { schemaVersion: number; trials: unknown[] };
  expect(json.schemaVersion).toBe(1);
  expect(json.trials).toHaveLength(4);
  expect(await readFile(join(output, "report.md"), "utf8")).toContain("# TFS Ripast Benchmark");
});

it("rejects an incomplete CLI invocation", async () => {
  const result = await runBenchmarkCli(["--allow-unsandboxed-agent", "--trust-agent-telemetry"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("--manifest and --agent-command are required");
});

it("requires explicit acknowledgement of real-agent authority and telemetry trust", async () => {
  const result = await runBenchmarkCli(["--manifest", "experiment.json", "--agent-command", "agent"]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("--allow-unsandboxed-agent");
  expect(result.stderr).toContain("--trust-agent-telemetry");
});
