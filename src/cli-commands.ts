import { GitScopeError } from "./git.js";
import { gcTransactions, repairTransaction } from "./maintenance.js";
import { type CliOutcome, type CliResult } from "./output.js";
import { ProviderExecutionError } from "./providers/provider.js";
import { ProcessSpawnError } from "./providers/process.js";
import { previewUndoTransaction, undoTransaction, verifyTransaction } from "./transaction.js";
import { assertProtocolSerializationFits, loadTransaction } from "./cli-artifacts.js";
import {
  type CliIo,
  type CliRuntime,
  type GcCommand,
  type RepairCommand,
  type UndoCommand,
  type VerifyCommand,
} from "./cli-parse.js";
import { emitResult } from "./cli-run.js";

export async function runVerify(command: VerifyCommand, io: CliIo, cwd: string, runtime: CliRuntime): Promise<number> {
  const record = await loadTransaction(command.source, io, cwd);
  const verification = await verifyTransaction(record, {
    root: cwd,
    ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
  });
  const result: CliResult = {
    version: 1,
    command: "verify",
    outcome: verification.ok ? "verified" : "verification-failed",
    exitCode: verification.ok ? 0 : 1,
    transactionId: record.id,
    state: record.state,
    verification,
  };
  for (const diagnostic of verification.diagnostics) {
    io.stderr(`${diagnostic}\n`);
  }
  emitResult(
    io,
    command.json,
    result,
    verification.ok ? `Transaction ${record.id} verified.\n` : `Transaction ${record.id} did not verify.\n`,
  );
  return result.exitCode;
}

export async function runUndo(command: UndoCommand, io: CliIo, cwd: string, runtime: CliRuntime): Promise<number> {
  const record = await loadTransaction(command.source, io, cwd);
  const transactionOptions = {
    root: cwd,
    ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
  };
  const verification = await verifyTransaction(record, transactionOptions);
  if (!verification.ok) {
    for (const diagnostic of verification.diagnostics) {
      io.stderr(`${diagnostic}\n`);
    }
    const result: CliResult = {
      version: 1,
      command: "undo",
      outcome: "verification-failed",
      exitCode: 1,
      transactionId: record.id,
      state: record.state,
      verification,
    };
    emitResult(io, command.json, result, `Transaction ${record.id} cannot be undone safely.\n`);
    return 1;
  }
  const undoPreview = await previewUndoTransaction(record, transactionOptions);
  if (!undoPreview.storedInversePatchMatches) {
    io.stderr("Stored inverse patch differs from validated retained/current bytes; using the authoritative recomputed undo preview.\n");
  }
  for (const state of ["undone", "partial-commit"] as const) {
    assertProtocolSerializationFits(
      { ...record, completedAt: new Date().toISOString(), state },
      `Persisted ${state} transaction record`,
    );
  }
  const undoModes = undoPreview.files.map((file) =>
    `Undo ${file.path}: mode ${file.currentMode.toString(8).padStart(4, "0")} -> ${file.beforeMode.toString(8).padStart(4, "0")}`,
  ).join("\n");
  const undoHumanPreview = `${undoModes}\n${undoPreview.patch}${undoPreview.patch.endsWith("\n") ? "" : "\n"}`;
  if (!command.json) {
    io.stdout(undoHumanPreview);
  }
  const shouldPrompt = !command.write && !command.dryRun && io.isTTY;
  if (!command.write && !shouldPrompt) {
    const result: CliResult = {
      version: 1,
      command: "undo",
      outcome: "previewed",
      exitCode: 0,
      transactionId: record.id,
      state: record.state,
      verification,
      undoPreview,
    };
    emitResult(io, command.json, result);
    return 0;
  }
  if (shouldPrompt) {
    const prompt = "Undo all changes? [y/N] ";
    if (command.json) {
      io.stderr(undoHumanPreview);
      io.stderr(prompt);
    } else {
      io.stdout(prompt);
    }
    let confirmed = false;
    try {
      confirmed = await io.confirm();
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      const result: CliResult = {
        version: 1,
        command: "undo",
        outcome: "declined",
        exitCode: 0,
        transactionId: record.id,
        state: record.state,
        undoPreview,
      };
      emitResult(io, command.json, result, "Declined; no files changed.\n");
      return 0;
    }
  }

  const undone = await undoTransaction(record, transactionOptions);
  const exitCode = undone.state === "undone" ? 0 : undone.state === "partial-commit" ? 3 : 1;
  const result: CliResult = {
    version: 1,
    command: "undo",
    outcome: undone.state === "undone" ? "undone" : undone.state === "partial-commit" ? "partial-commit" : "failed",
    exitCode,
    transactionId: undone.id,
    state: undone.state,
    undoPreview,
  };
  emitResult(io, command.json, result, undone.state === "undone" ? `Transaction ${undone.id} undone.\n` : undefined);
  return exitCode;
}

export async function runRepair(command: RepairCommand, io: CliIo, cwd: string, runtime: CliRuntime): Promise<number> {
  const record = await loadTransaction(command.source, io, cwd);
  const report = await repairTransaction(record, {
    root: cwd,
    write: command.write,
    ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
  });
  for (const diagnostic of report.diagnostics) {
    io.stderr(`${diagnostic}\n`);
  }
  const result: CliResult = {
    version: 1,
    command: "repair",
    outcome: report.ok ? (report.write ? "repaired" : "previewed") : "failed",
    exitCode: report.ok ? 0 : 1,
    transactionId: record.id,
    state: report.record?.state ?? record.state,
    repair: report,
  };
  const human = report.files.length === 0
    ? undefined
    : `${report.files.map((file) =>
      `- ${file.path}: ${file.action}${file.reason === undefined ? "" : ` (${file.reason})`}`).join("\n")}\n`;
  emitResult(
    io,
    command.json,
    result,
    report.ok
      ? report.record === undefined
        ? human
        : `${human ?? ""}Transaction ${report.record.id} marked ${report.record.state}.\n`
      : human,
  );
  return result.exitCode;
}

export async function runGc(command: GcCommand, io: CliIo, cwd: string, runtime: CliRuntime): Promise<number> {
  const report = await gcTransactions({
    root: cwd,
    write: command.write,
    includeUndoable: command.includeUndoable,
    ...(command.olderThanDays === undefined ? {} : { olderThanMs: command.olderThanDays * 24 * 60 * 60 * 1000 }),
    removeRecords: command.removeRecords,
    ...(runtime.fileSystem === undefined ? {} : { fileSystem: runtime.fileSystem }),
  });
  for (const diagnostic of report.diagnostics) {
    io.stderr(`${diagnostic}\n`);
  }
  const result: CliResult = {
    version: 1,
    command: "gc",
    outcome: report.write ? "pruned" : "previewed",
    exitCode: 0,
    gc: report,
  };
  const human = report.entries.length === 0
    ? undefined
    : `${report.entries.map((entry) =>
      `- ${entry.id} (${entry.state}): ${entry.prunable ? (command.write ? "pruned" : "prunable") : "kept"}` +
      `${entry.reason === undefined ? "" : ` — ${entry.reason}`}`).join("\n")}\n`;
  emitResult(io, command.json, result, human);
  return 0;
}

export function failureDetails(error: unknown): { exitCode: number; outcome: CliOutcome; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderExecutionError || error instanceof ProcessSpawnError) {
    return { exitCode: 2, outcome: "provider-failure", message };
  }
  if (error instanceof GitScopeError && error.dependencyFailure) {
    return { exitCode: 2, outcome: "provider-failure", message };
  }
  return { exitCode: 1, outcome: "invalid", message };
}
