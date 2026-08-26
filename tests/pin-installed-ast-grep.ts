import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants as fsConstants, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";

const pinDirectoryPrefix = join(tmpdir(), "tfs-ripast-pin-ast-grep-");
const exactVersion = /^ast-grep\s+0\.45\.1$/u;

interface PinnedAstGrep {
  directory: string;
  executable: string;
  cleanup(): void;
}

function prependPinnedAstGrep(executable: string): PinnedAstGrep {
  const pinDirectory = mkdtempSync(pinDirectoryPrefix);
  const link = join(pinDirectory, "ast-grep");
  const previousPath = process.env.PATH;
  try {
    chmodSync(pinDirectory, 0o700);
    symlinkSync(executable, link);
  } catch (error) {
    rmSync(pinDirectory, { recursive: true, force: true });
    throw error;
  }
  const pinnedPath = `${pinDirectory}${delimiter}${previousPath ?? ""}`;
  process.env.PATH = pinnedPath;
  let cleaned = false;
  return {
    directory: pinDirectory,
    executable,
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      const currentPath = process.env.PATH;
      if (currentPath === pinnedPath) {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
      } else if (currentPath !== undefined) {
        process.env.PATH = currentPath
          .split(delimiter)
          .filter((entry) => entry !== pinDirectory)
          .join(delimiter);
      }
      rmSync(pinDirectory, { recursive: true, force: true });
    },
  };
}

export const pinInstalledAstGrep = (): PinnedAstGrep => {
  // Vitest prepends ancestor node_modules/.bin, which can shadow @ast-grep/cli with npm ast-grep@0.1.0.
  const candidateIdentity = (candidate: string): string | undefined => {
    try {
      const identity = realpathSync(candidate);
      accessSync(identity, fsConstants.X_OK);
      const version = execFileSync(identity, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        env: process.env,
      }).trim().split(/\r?\n/u)[0] ?? "";
      return exactVersion.test(version) ? identity : undefined;
    } catch {
      return undefined;
    }
  };
  if (process.env.AST_GREP_BIN !== undefined && process.env.AST_GREP_BIN !== "") {
    const identity = candidateIdentity(process.env.AST_GREP_BIN);
    if (identity === undefined) {
      throw new Error(`AST_GREP_BIN must resolve to ast-grep 0.45.1: ${process.env.AST_GREP_BIN}`);
    }
    process.env.AST_GREP_BIN = identity;
    return prependPinnedAstGrep(identity);
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, "ast-grep");
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    const identity = candidateIdentity(candidate);
    if (identity !== undefined) {
      process.env.AST_GREP_BIN = identity;
      return prependPinnedAstGrep(identity);
    }
  }
  throw new Error("ast-grep 0.45.1 is required for provider tests; set AST_GREP_BIN to its executable.");
};

const pinnedAstGrep = pinInstalledAstGrep();
process.once("exit", pinnedAstGrep.cleanup);
afterAll(() => {
  process.removeListener("exit", pinnedAstGrep.cleanup);
  pinnedAstGrep.cleanup();
});
export const realAstGrep = pinnedAstGrep.executable;
