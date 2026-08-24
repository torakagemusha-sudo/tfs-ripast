export type TrialMode = "normal" | "ripast";

export interface CommandEvent {
  sequence: number;
  tool: string;
  status: "ok" | "failed";
  startedNs: string;
  endedNs: string;
  arguments?: unknown;
}

export interface ProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Readonly<Record<string, string>>;
}

export interface ProcessResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputOverflow: boolean;
  startedNs: string;
  endedNs: string;
  durationNs: string;
  stdout: string;
  stderr: string;
  commandEvents: CommandEvent[];
}

export interface WorkloadPair {
  workload: string;
  a: string;
  b: string;
}

export interface TrialSpec {
  id: string;
  workload: string;
  fixture: string;
  mode: TrialMode;
  repetition: number;
  order: number;
}

export interface ExperimentManifest {
  schemaVersion: 1;
  seed: string;
  repetitions: number;
  model: string;
  fixtureRoot: string;
  pairs: WorkloadPair[];
  timeoutMs: number;
}

export interface TrialRecord extends TrialSpec {
  status: "success" | "failed" | "timed-out";
  correct: boolean;
  durationNs: string;
  commandCount: number;
  commandEvents: CommandEvent[];
  processExitCode: number;
  acceptanceExitCode: number;
  violations: string[];
  baselineTreeHash: string;
  resultTreeHash: string;
  ripastArtifactHash: string | null;
  trialDirectory: string;
}

export interface ExperimentRecord {
  schemaVersion: 1;
  seed: string;
  model: string;
  platform: string;
  nodeVersion: string;
  createdAt: string;
  trials: TrialRecord[];
}
