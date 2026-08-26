/** Synthetic slice modeled on tfs-ripast src/benchmark/types.ts (Apache-2.0). */
export interface ExperimentManifest {
  schemaVersion: 1;
  seed: string;
  repetitions: number;
  model: string;
  fixtureRoot: string;
  timeoutMs: number;
}

export function describeManifest(manifest: ExperimentManifest): ExperimentManifest {
  return manifest;
}

export const label = "ExperimentManifest";
