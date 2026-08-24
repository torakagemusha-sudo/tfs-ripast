import { createHash } from "node:crypto";
import type { TrialSpec, WorkloadPair } from "./types.js";

function randomFactory(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function buildCrossoverSchedule(seed: string, pairs: readonly WorkloadPair[], repetitions: number): TrialSpec[] {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("repetitions must be a positive integer");
  const trials: Omit<TrialSpec, "order">[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const pair of pairs) {
      for (const [fixture, mode] of [[pair.a, "normal"], [pair.b, "ripast"], [pair.b, "normal"], [pair.a, "ripast"]] as const) {
        trials.push({ id: `${pair.workload}-${repetition}-${fixture}-${mode}`, workload: pair.workload, fixture, mode, repetition });
      }
    }
  }
  const random = randomFactory(seed);
  for (let index = trials.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [trials[index], trials[other]] = [trials[other]!, trials[index]!];
  }
  return trials.map((trial, order) => ({ ...trial, order: order + 1 }));
}
