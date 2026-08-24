import { spawn } from "node:child_process";

export const maximumProcessArgumentBytes = 128 * 1024;
export const maximumProcessInputBytes = 16 * 1024 * 1024;
export const maximumProcessPathBytes = 4 * 1024;

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxArgumentBytes?: number;
  maxInputBytes?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  stdinError: boolean;
  invalidUtf8: boolean;
}

export class ProcessSpawnError extends Error {
  constructor(executable: string, cause: unknown) {
    super(
      `Could not spawn ${executable}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "ProcessSpawnError";
  }
}

/** Every subprocess requires a real descendant boundary; Windows therefore fails closed. */
export function assertProcessContainmentSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    throw new Error("Process-group descendant containment is unavailable on Windows; subprocess execution is refused before spawn.");
  }
}

function decodeBoundedUtf8(chunks: readonly Buffer[]): { text: string; invalid: boolean } {
  const bytes = Buffer.concat(chunks);
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      invalid: false,
    };
  } catch {
    return { text: "", invalid: true };
  }
}

export function runArgumentVector(
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  try {
    assertProcessContainmentSupported();
  } catch (error) {
    return Promise.reject(error);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new RangeError("timeoutMs must be a positive safe integer"));
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    return Promise.reject(new RangeError("maxOutputBytes must be a positive safe integer"));
  }
  const maxArgumentBytes = options.maxArgumentBytes ?? maximumProcessArgumentBytes;
  if (!Number.isSafeInteger(maxArgumentBytes) || maxArgumentBytes <= 0 || maxArgumentBytes > maximumProcessArgumentBytes) {
    return Promise.reject(new RangeError(`maxArgumentBytes must be a positive safe integer no larger than ${String(maximumProcessArgumentBytes)}`));
  }
  if (Buffer.byteLength(options.cwd) > maximumProcessPathBytes) {
    return Promise.reject(new RangeError(`cwd exceeds the ${String(maximumProcessPathBytes)} bytes limit.`));
  }
  const argumentBytes = [executable, ...args].reduce(
    (total, value) => total + Buffer.byteLength(value) + 1,
    0,
  );
  if (argumentBytes > maxArgumentBytes) {
    return Promise.reject(
      new RangeError(
        `Argument vector requires ${String(argumentBytes)} bytes, exceeding the ${String(maxArgumentBytes)} bytes limit.`,
      ),
    );
  }
  const maxInputBytes = options.maxInputBytes ?? maximumProcessInputBytes;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0 || maxInputBytes > maximumProcessInputBytes) {
    return Promise.reject(new RangeError(`maxInputBytes must be a positive safe integer no larger than ${String(maximumProcessInputBytes)}`));
  }
  const inputBytes = options.input === undefined ? 0 : Buffer.byteLength(options.input);
  if (inputBytes > maxInputBytes) {
    return Promise.reject(
      new RangeError(`Process input requires ${String(inputBytes)} bytes, exceeding the ${String(maxInputBytes)} bytes limit.`),
    );
  }
  const killGraceMs = options.killGraceMs ?? 100;
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs <= 0) {
    return Promise.reject(new RangeError("killGraceMs must be a positive safe integer"));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      shell: false,
      detached: true,
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let truncated = false;
    let stdinError = false;
    let settled = false;
    let terminating = false;
    let observedExitCode: number | null = null;
    let observedSignal: NodeJS.Signals | null = null;
    let observedExit = false;
    let observedClose = false;
    let closeExitCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let stdinSettled = options.input === undefined;
    let issuedSignal: NodeJS.Signals | null = null;
    let escalationTimer: NodeJS.Timeout | undefined;
    let forcedSettleTimer: NodeJS.Timeout | undefined;
    const groupPid = child.pid;

    const signalTree = (signal: NodeJS.Signals): boolean => {
      if (groupPid !== undefined) {
        try {
          process.kill(-groupPid, signal);
          return true;
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
            return false;
          }
          throw error;
        }
      }
      return child.kill(signal);
    };
    const killGroupOnParentExit = (): void => {
      try {
        signalTree("SIGKILL");
      } catch {
        // The process is exiting; there is no safer asynchronous recovery path.
      }
    };
    process.once("exit", killGroupOnParentExit);

    const clearTimers = (): void => {
      clearTimeout(timer);
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
      }
      if (forcedSettleTimer !== undefined) {
        clearTimeout(forcedSettleTimer);
      }
      process.removeListener("exit", killGroupOnParentExit);
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      if (groupPid !== undefined) {
        try {
          process.kill(-groupPid, "SIGKILL");
        } catch (error) {
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) {
            throw error;
          }
        }
      }
      const decodedStdout = decodeBoundedUtf8(stdout);
      const decodedStderr = decodeBoundedUtf8(stderr);
      resolvePromise({
        exitCode,
        signal,
        stdout: decodedStdout.text,
        stderr: decodedStderr.text,
        timedOut,
        truncated,
        stdinError,
        invalidUtf8: decodedStdout.invalid || decodedStderr.invalid,
      });
    };

    const finishAfterIo = (): void => {
      if (observedClose && stdinSettled) {
        finish(closeExitCode, closeSignal);
      }
    };

    const terminate = (): void => {
      if (terminating || settled) {
        return;
      }
      terminating = true;
      if (signalTree("SIGTERM")) {
        issuedSignal = "SIGTERM";
      }
      escalationTimer = setTimeout(() => {
        if (!observedExit) {
          if (signalTree("SIGKILL")) {
            issuedSignal = "SIGKILL";
          }
        }
        forcedSettleTimer = setTimeout(() => {
          stdinSettled = true;
          child.stdin?.destroy();
          child.stdout!.destroy();
          child.stderr!.destroy();
          child.unref();
          finish(observedExitCode, observedSignal ?? issuedSignal);
        }, killGraceMs);
      }, killGraceMs);
    };

    const capture = (destination: Buffer[], chunk: Buffer): void => {
      const remaining = options.maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        destination.push(retained);
        capturedBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) {
        truncated = true;
        terminate();
      }
    };

    child.stdout!.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => capture(stderr, chunk));

    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        stdinError = true;
        stdinSettled = true;
        capture(stderr, Buffer.from(`stdin write failed: ${error.code ?? error.name}\n`, "utf8"));
        finishAfterIo();
      });
      child.stdin.once("close", () => {
        stdinSettled = true;
        finishAfterIo();
      });
      child.stdin.end(options.input);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();

    child.once("exit", (exitCode, signal) => {
      observedExit = true;
      observedExitCode = exitCode;
      observedSignal = signal;
    });

    child.once("error", (error) => {
      clearTimers();
      if (!settled) {
        settled = true;
        rejectPromise(new ProcessSpawnError(executable, error));
      }
    });

    child.once("close", (exitCode, signal) => {
      observedClose = true;
      closeExitCode = exitCode;
      closeSignal = signal;
      finishAfterIo();
    });
  });
}
