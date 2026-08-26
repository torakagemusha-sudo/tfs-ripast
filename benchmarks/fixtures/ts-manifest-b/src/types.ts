/** Synthetic slice modeled on tfs-ripast src/benchmark/types.ts (Apache-2.0). */
export interface ExperimentRecord {
  schemaVersion: 1;
  seed: string;
  model: string;
  platform: string;
  nodeVersion: string;
  createdAt: string;
}

export function describeRecord(record: ExperimentRecord): ExperimentRecord {
  return record;
}

export const label = "ExperimentRecord";
