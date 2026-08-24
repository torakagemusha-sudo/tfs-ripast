import { spawn } from "node:child_process";
import type { CommandEvent, ProcessOptions, ProcessResult } from "./types.js";

const EVENT_PREFIX = "TFS_BENCH_EVENT ";

function parseEvents(stdout: string): CommandEvent[] {
  const events: CommandEvent[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith(EVENT_PREFIX)) continue;
    const value: unknown = JSON.parse(line.slice(EVENT_PREFIX.length));
    if (typeof value !== "object" || value === null) throw new Error("invalid benchmark command event");
    const event = value as Partial<CommandEvent>;
    if (!Number.isSafeInteger(event.sequence) || typeof event.tool !== "string"
      || (event.status !== "ok" && event.status !== "failed")
      || typeof event.startedNs !== "string" || typeof event.endedNs !== "string") {
      throw new Error("invalid benchmark command event");
    }
    if (event.sequence !== events.length + 1) throw new Error("benchmark command events must be contiguous");
    events.push(event as CommandEvent);
  }
  return events;
}

export async function runMeasuredProcess(options: ProcessOptions): Promise<ProcessResult> {
  if (options.timeoutMs <= 0 || options.maxOutputBytes <= 0) throw new Error("process bounds must be positive");
  const started = process.hrtime.bigint();
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  let outputOverflow = false;
  let terminated = false;

  const terminate = (): void => {
    if (terminated || child.pid === undefined) return;
    terminated = true;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
    const current = target === "stdout" ? stdout : stderr;
    const remaining = Math.max(0, options.maxOutputBytes - stdout.length - stderr.length);
    const next = Buffer.concat([current, chunk.subarray(0, remaining)]);
    if (target === "stdout") stdout = next;
    else stderr = next;
    if (chunk.length > remaining) {
      outputOverflow = true;
      terminate();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);

  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const ended = process.hrtime.bigint();
  const stdoutText = stdout.toString("utf8");
  return {
    exitCode: timedOut ? 124 : outputOverflow ? 125 : (closed.code ?? 1),
    signal: closed.signal,
    timedOut,
    outputOverflow,
    startedNs: started.toString(),
    endedNs: ended.toString(),
    durationNs: (ended - started).toString(),
    stdout: stdoutText,
    stderr: stderr.toString("utf8"),
    commandEvents: parseEvents(stdoutText),
  };
}
