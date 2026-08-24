import type { ExperimentRecord, TrialMode, TrialRecord } from "./types.js";

function seconds(ns: string): number {
  return Number(BigInt(ns)) / 1_000_000_000;
}

function modeTotals(trials: readonly TrialRecord[], mode: TrialMode): { duration: number; commands: number; complete: boolean } {
  const selected = trials.filter((trial) => trial.mode === mode);
  return {
    duration: selected.reduce((sum, trial) => sum + seconds(trial.durationNs), 0),
    commands: selected.reduce((sum, trial) => sum + trial.commandCount, 0),
    complete: selected.length > 0 && selected.every((trial) => trial.status === "success"),
  };
}

export function renderMarkdown(record: ExperimentRecord): string {
  const lines = [
    "# TFS Ripast Benchmark",
    "",
    `- Schema: ${record.schemaVersion}`,
    `- Seed: \`${record.seed}\``,
    `- Model/config: \`${record.model}\``,
    `- Platform: \`${record.platform}\`, Node \`${record.nodeVersion}\``,
    "",
    "| Mode | Status | Wall time (s) | Commands |",
    "|---|---:|---:|---:|",
  ];
  for (const mode of ["normal", "ripast"] as const) {
    const totals = modeTotals(record.trials, mode);
    lines.push(`| ${mode} | ${totals.complete ? "success" : "failed"} | ${totals.duration.toFixed(3)} | ${totals.commands} |`);
  }
  lines.push("", "## Trials", "", "| Order | Workload | Fixture | Mode | Status | Wall time (s) | Commands |", "|---:|---|---|---|---|---:|---:|");
  for (const trial of [...record.trials].sort((a, b) => a.order - b.order)) {
    lines.push(`| ${trial.order} | ${trial.workload} | ${trial.fixture} | ${trial.mode} | ${trial.status} | ${seconds(trial.durationNs).toFixed(3)} | ${trial.commandCount} |`);
  }
  const normal = modeTotals(record.trials, "normal");
  const ripast = modeTotals(record.trials, "ripast");
  lines.push("", "## Result", "");
  if (normal.complete && ripast.complete) {
    const durationSaved = normal.duration - ripast.duration;
    const commandSaved = normal.commands - ripast.commands;
    const durationPercent = normal.duration === 0 ? 0 : durationSaved / normal.duration * 100;
    const commandPercent = normal.commands === 0 ? 0 : commandSaved / normal.commands * 100;
    const verb = durationSaved >= 0 && commandSaved >= 0 ? "saved" : "difference was";
    lines.push(`Ripast ${verb} ${Math.abs(durationSaved).toFixed(3)} s (${Math.abs(durationPercent).toFixed(1)}%) and ${Math.abs(commandSaved)} commands (${Math.abs(commandPercent).toFixed(1)}%).`);
  } else {
    lines.push("No comparative winner is reported because at least one trial failed the correctness gate.");
  }
  lines.push("");
  return lines.join("\n");
}
