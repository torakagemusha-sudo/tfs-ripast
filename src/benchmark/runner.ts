import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { checkFixture, prepareFixture } from "./fixture.js";
import { runMeasuredProcess } from "./process.js";
import { buildCrossoverSchedule } from "./schedule.js";
import type { ExperimentManifest, ExperimentRecord, TrialRecord } from "./types.js";

export interface ExperimentOptions {
  agentCommand: readonly [string, ...string[]];
  ripastArtifact: string;
  tempRoot: string;
  extraEnv?: Readonly<Record<string, string>>;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createDeniedAliasBin(root: string): Promise<string> {
  const bin = join(root, "normal-mode-bin");
  await mkdir(bin, { recursive: true });
  const deniedScript = join(bin, "deny.mjs");
  await writeFile(
    deniedScript,
    "process.stderr.write('Ripast is disabled in normal benchmark mode\\n'); process.exitCode = 126;\n",
    "utf8",
  );
  for (const name of ["tfs-ripast", "rpst"]) {
    if (process.platform === "win32") {
      await writeFile(join(bin, `${name}.cmd`), `@echo off\r\nnode "%~dp0deny.mjs" %*\r\n`, "utf8");
    } else {
      const path = join(bin, name);
      await writeFile(path, `#!/usr/bin/env node\nawait import(${JSON.stringify(deniedScript)});\n`, "utf8");
      await chmod(path, 0o755);
    }
  }
  return bin;
}

function validateManifest(manifest: ExperimentManifest): void {
  if (manifest.schemaVersion !== 1 || manifest.seed.length === 0 || manifest.model.length === 0
    || manifest.timeoutMs <= 0 || manifest.timeoutMs > 86_400_000
    || !Number.isSafeInteger(manifest.repetitions) || manifest.repetitions < 1 || manifest.repetitions > 25
    || manifest.pairs.length === 0 || manifest.pairs.length > 25) throw new Error("invalid experiment manifest");
  for (const pair of manifest.pairs) {
    if (![pair.workload, pair.a, pair.b].every((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))) {
      throw new Error("workload and fixture identifiers must be bounded single path components");
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

export async function runExperiment(manifest: ExperimentManifest, options: ExperimentOptions): Promise<ExperimentRecord> {
  validateManifest(manifest);
  await mkdir(options.tempRoot, { recursive: true });
  const fixtureRoot = await realpath(manifest.fixtureRoot);
  const deniedBin = await createDeniedAliasBin(options.tempRoot);
  const artifactHash = await sha256(options.ripastArtifact);
  const trials: TrialRecord[] = [];
  for (const spec of buildCrossoverSchedule(manifest.seed, manifest.pairs, manifest.repetitions)) {
    const trialDirectory = join(options.tempRoot, `trial-${String(spec.order).padStart(3, "0")}`);
    const fixtureSource = await realpath(join(fixtureRoot, spec.fixture));
    if (!contained(fixtureRoot, fixtureSource)) throw new Error(`fixture identifier escapes fixture root: ${spec.fixture}`);
    const baseline = await prepareFixture(fixtureSource, trialDirectory);
    const [command, ...args] = options.agentCommand;
    const hostPath = process.env.PATH ?? "";
    const env: Record<string, string> = {
      ...options.extraEnv,
      PATH: spec.mode === "normal"
        ? (hostPath.length > 0 ? `${deniedBin}${delimiter}${hostPath}` : deniedBin)
        : hostPath,
      TFS_RIPAST_MODE: spec.mode,
      TFS_BENCH_PROMPT: join(trialDirectory, "prompt.md"),
    };
    if (spec.mode === "ripast") env.TFS_RIPAST_BIN = options.ripastArtifact;
    else delete env.TFS_RIPAST_BIN;
    const processResult = await runMeasuredProcess({
      command,
      args,
      cwd: trialDirectory,
      timeoutMs: manifest.timeoutMs,
      maxOutputBytes: 1_048_576,
      env,
    });
    const correctness = await checkFixture({ trialDir: trialDirectory, baseline });
    const correct = processResult.exitCode === 0 && correctness.success;
    trials.push({
      ...spec,
      status: processResult.timedOut ? "timed-out" : correct ? "success" : "failed",
      correct,
      durationNs: processResult.durationNs,
      commandCount: processResult.commandEvents.length,
      commandEvents: processResult.commandEvents,
      processExitCode: processResult.exitCode,
      acceptanceExitCode: correctness.acceptanceExitCode,
      violations: correctness.violations,
      baselineTreeHash: baseline.treeHash,
      resultTreeHash: correctness.resultTreeHash,
      ripastArtifactHash: spec.mode === "ripast" ? artifactHash : null,
      trialDirectory,
    });
  }
  return {
    schemaVersion: 1,
    seed: manifest.seed,
    model: manifest.model,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    createdAt: new Date().toISOString(),
    trials,
  };
}
