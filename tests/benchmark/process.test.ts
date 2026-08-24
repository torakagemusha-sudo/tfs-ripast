import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMeasuredProcess } from "../../src/benchmark/process.js";

const roots: string[] = [];

async function script(source: string): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "ripast-benchmark-process-"));
  roots.push(cwd);
  const path = join(cwd, "agent.mjs");
  await writeFile(path, source, "utf8");
  return { cwd, path };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runMeasuredProcess", () => {
  it("records monotonic time and parses sequenced command events", async () => {
    const fixture = await script(`
      console.log('TFS_BENCH_EVENT {"sequence":1,"tool":"shell","status":"ok","startedNs":"1","endedNs":"2"}');
      console.log('ordinary agent output');
      console.log('TFS_BENCH_EVENT {"sequence":2,"tool":"edit","status":"ok","startedNs":"3","endedNs":"4"}');
    `);

    const result = await runMeasuredProcess({
      command: process.execPath,
      args: [fixture.path],
      cwd: fixture.cwd,
      timeoutMs: 2_000,
      maxOutputBytes: 16_384,
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationNs).toMatch(/^\d+$/);
    expect(BigInt(result.durationNs)).toBeGreaterThanOrEqual(0n);
    expect(result.commandEvents.map(({ sequence, tool }) => ({ sequence, tool }))).toEqual([
      { sequence: 1, tool: "shell" },
      { sequence: 2, tool: "edit" },
    ]);
    expect(result.stdout).toContain("ordinary agent output");
  });

  it("terminates a timed-out process", async () => {
    const fixture = await script("setInterval(() => {}, 1_000);");
    const result = await runMeasuredProcess({
      command: process.execPath,
      args: [fixture.path],
      cwd: fixture.cwd,
      timeoutMs: 50,
      maxOutputBytes: 16_384,
      env: {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("marks output overflow as a failed bounded run", async () => {
    const fixture = await script("console.log('x'.repeat(10_000));");
    const result = await runMeasuredProcess({
      command: process.execPath,
      args: [fixture.path],
      cwd: fixture.cwd,
      timeoutMs: 2_000,
      maxOutputBytes: 100,
      env: {},
    });

    expect(result.outputOverflow).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(100);
    expect(result.exitCode).not.toBe(0);
  });
});
