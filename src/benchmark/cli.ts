#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderMarkdown } from "./report.js";
import { runExperiment } from "./runner.js";
import type { ExperimentManifest } from "./types.js";

export interface BenchmarkCliResult { exitCode: number; stdout: string; stderr: string }

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseCommand(value: string): [string, ...string[]] {
  if (value.startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === "string")) throw new Error("--agent-command JSON must be a non-empty string array");
    return parsed as [string, ...string[]];
  }
  return [value];
}

export async function runBenchmarkCli(argv: readonly string[]): Promise<BenchmarkCliResult> {
  try {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const output = resolve(valueAfter(argv, "--output") ?? join(process.cwd(), "benchmark-results"));
    await mkdir(output, { recursive: true });
    let manifest: ExperimentManifest;
    let agentCommand: [string, ...string[]];
    let ripastArtifact: string;
    if (argv.includes("--self-test")) {
      manifest = {
        schemaVersion: 1, seed: "self-test-v1", repetitions: 1, model: "checked-in-fake-agent",
        fixtureRoot: join(repoRoot, "benchmarks", "fixtures"),
        pairs: [
          { workload: "textual-configuration-migration", a: "textual-a", b: "textual-b" },
          { workload: "kamailio-fuzz-uri-rename", a: "kamailio-fuzz-a", b: "kamailio-fuzz-b" },
          { workload: "ts-manifest-type-rename", a: "ts-manifest-a", b: "ts-manifest-b" },
        ], timeoutMs: 5_000,
      };
      agentCommand = [process.execPath, join(repoRoot, "benchmarks", "helpers", "fake-agent.mjs")];
      ripastArtifact = join(repoRoot, "src", "cli.ts");
    } else {
      if (!argv.includes("--allow-unsandboxed-agent") || !argv.includes("--trust-agent-telemetry")) {
        return { exitCode: 2, stdout: "", stderr: "real runs require --allow-unsandboxed-agent and --trust-agent-telemetry; see benchmarks/README.md\n" };
      }
      const manifestValue = valueAfter(argv, "--manifest");
      const commandValue = valueAfter(argv, "--agent-command");
      if (manifestValue === undefined || commandValue === undefined) return { exitCode: 2, stdout: "", stderr: "--manifest and --agent-command are required\n" };
      const manifestPath = resolve(manifestValue);
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExperimentManifest;
      if (!isAbsolute(manifest.fixtureRoot)) manifest.fixtureRoot = resolve(dirname(manifestPath), manifest.fixtureRoot);
      agentCommand = parseCommand(commandValue);
      ripastArtifact = resolve(valueAfter(argv, "--ripast-artifact") ?? join(repoRoot, "dist", "cli.js"));
    }
    const trialRoot = await mkdtemp(join(tmpdir(), "tfs-ripast-benchmark-"));
    const record = await runExperiment(manifest, { agentCommand, ripastArtifact, tempRoot: trialRoot });
    await writeFile(join(output, "results.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await writeFile(join(output, "report.md"), renderMarkdown(record), "utf8");
    return { exitCode: record.trials.every((trial) => trial.status === "success") ? 0 : 1, stdout: `${output}\n`, stderr: "" };
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const result = await runBenchmarkCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
