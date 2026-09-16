#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRewritePlan } from "./schema.js";
import {
  assertSavedPlanMatchesDerivation,
  correlationForSavedPlan,
  loadEditPlan,
  savedArtifactExclusions,
  snapshotsForSavedPlan,
  protocolJson,
} from "./cli-artifacts.js";
import {
  failureDetails,
  runGc,
  runRepair,
  runUndo,
  runVerify,
} from "./cli-commands.js";
import { enumerateRepositoryFiles, resolveEditPlan } from "./cli-discovery.js";
import {
  adHocPlan,
  applyCliPlanOptions,
  HELP,
  commandName,
  parseArguments,
  stdinText,
  type ArgumentParseState,
  type CliIo,
  type CliRuntime,
} from "./cli-parse.js";
import { emitResult, planningResult, runEditPlan } from "./cli-run.js";

export type { CliIo, CliRuntime } from "./cli-parse.js";

export async function terminalConfirmation(): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  });
  try {
    const answer = await terminal.question("");
    return answer.trim().toLowerCase() === "y";
  } catch {
    return false;
  } finally {
    terminal.close();
  }
}

export const defaultIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: terminalConfirmation,
  cwd: process.cwd(),
  stdin: stdinText,
};

export const VERSION = "0.1.1";

export async function main(
  argv: readonly string[],
  io: CliIo = defaultIo,
  runtime: CliRuntime = {},
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    io.stdout(HELP);
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    io.stdout(`tfs-ripast ${VERSION}\n`);
    return 0;
  }
  const kind = commandName(argv);
  const parseState: ArgumentParseState = { json: false };
  const cwd = resolve(io.cwd ?? process.cwd());
  try {
    const command = parseArguments(argv, parseState);
    if (command.kind === "verify") {
      return await runVerify(command, io, cwd, runtime);
    }
    if (command.kind === "undo") {
      return await runUndo(command, io, cwd, runtime);
    }
    if (command.kind === "repair") {
      return await runRepair(command, io, cwd, runtime);
    }
    if (command.kind === "gc") {
      return await runGc(command, io, cwd, runtime);
    }
    if (command.kind === "rewrite") {
      const resolved = await resolveEditPlan(adHocPlan(command, cwd), cwd, runtime, command);
      return await runEditPlan(
        "rewrite",
        planningResult(resolved.editPlan, resolved.snapshots, resolved.correlation, resolved.repositoryFiles),
        command,
        io,
        runtime,
      );
    }
    if (command.kind === "plan") {
      const loaded = applyCliPlanOptions(
        parseRewritePlan(await protocolJson(command.source, io, cwd)),
        command,
      );
      const resolved = await resolveEditPlan(loaded, cwd, runtime, command);
      return await runEditPlan(
        "plan",
        planningResult(resolved.editPlan, resolved.snapshots, resolved.correlation, resolved.repositoryFiles),
        command,
        io,
        runtime,
      );
    }
    const editPlan = await loadEditPlan(command.source, io, cwd);
    const artifactExclusions = await savedArtifactExclusions(
      command.source,
      cwd,
      editPlan.rewritePlan.root,
    );
    if (command.kind === "apply") {
      const derived = await resolveEditPlan(
        editPlan.rewritePlan,
        cwd,
        runtime,
        command,
        artifactExclusions,
        editPlan.gitScope,
      );
      assertSavedPlanMatchesDerivation(editPlan, derived.editPlan);
      return await runEditPlan(
        command.kind,
        planningResult(derived.editPlan, derived.snapshots, derived.correlation, derived.repositoryFiles),
        command,
        io,
        runtime,
      );
    }
    const snapshots = await snapshotsForSavedPlan(editPlan);
    const repositoryFiles = await enumerateRepositoryFiles(
      editPlan.rewritePlan,
      runtime,
      editPlan.evidence.map((evidence) => evidence.file),
      artifactExclusions,
    );
    const planning = planningResult(
      editPlan,
      snapshots,
      correlationForSavedPlan(editPlan),
      repositoryFiles.length,
    );
    return await runEditPlan(command.kind, planning, command, io, runtime);
  } catch (error) {
    const failure = failureDetails(error);
    io.stderr(`${failure.message}\n`);
    if (parseState.json) {
      emitResult(io, true, {
        version: 1,
        command: kind,
        outcome: failure.outcome,
        exitCode: failure.exitCode,
      });
    }
    return failure.exitCode;
  }
}

function isDirectExecution(argvPath: string | undefined): boolean {
  if (argvPath === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectExecution(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
