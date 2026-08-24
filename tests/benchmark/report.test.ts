import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/benchmark/report.js";
import type { ExperimentRecord, TrialRecord } from "../../src/benchmark/types.js";

function trial(mode: "normal" | "ripast", status: "success" | "failed", durationNs: string, commandCount: number): TrialRecord {
  return {
    id: `${mode}-trial`, workload: "textual", fixture: mode === "normal" ? "a" : "b", mode,
    repetition: 1, order: mode === "normal" ? 1 : 2, status, correct: status === "success",
    durationNs, commandCount, commandEvents: [], processExitCode: status === "success" ? 0 : 2,
    acceptanceExitCode: status === "success" ? 0 : 1, violations: status === "success" ? [] : ["acceptance failed"],
    baselineTreeHash: "baseline", resultTreeHash: "result", ripastArtifactHash: mode === "ripast" ? "artifact" : null,
    trialDirectory: `/tmp/${mode}`,
  };
}
function record(trials: TrialRecord[]): ExperimentRecord {
  return { schemaVersion: 1, seed: "seed", model: "model", platform: "test", nodeVersion: "v24", createdAt: "2026-08-24T00:00:00.000Z", trials };
}

describe("renderMarkdown", () => {
  it("computes successful-mode differences from raw trials", () => {
    const markdown = renderMarkdown(record([trial("normal", "success", "2000000000", 8), trial("ripast", "success", "1000000000", 5)]));
    expect(markdown).toContain("Ripast saved 1.000 s (50.0%) and 3 commands (37.5%)");
  });

  it("shows failures without declaring a winner", () => {
    const markdown = renderMarkdown(record([trial("normal", "failed", "2000000000", 8), trial("ripast", "success", "1000000000", 5)]));
    expect(markdown).toContain("| normal | failed |");
    expect(markdown).not.toContain("Ripast saved");
  });
});
