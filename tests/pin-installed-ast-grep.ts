import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const pinDirectory = join(tmpdir(), `tfs-ripast-pin-ast-grep-${String(process.pid)}`);

function prependPinnedAstGrep(executable: string): void {
  mkdirSync(pinDirectory, { recursive: true });
  const link = join(pinDirectory, "ast-grep");
  try {
    unlinkSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  symlinkSync(executable, link);
  const path = process.env.PATH ?? "";
  if (!path.split(delimiter).includes(pinDirectory)) {
    process.env.PATH = `${pinDirectory}${delimiter}${path}`;
  }
}

export const pinInstalledAstGrep = (): void => {
  // Vitest prepends ancestor node_modules/.bin, which can shadow @ast-grep/cli with npm ast-grep@0.1.0.
  if (process.env.AST_GREP_BIN !== undefined && process.env.AST_GREP_BIN !== "") {
    prependPinnedAstGrep(process.env.AST_GREP_BIN);
    return;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0 || directory === pinDirectory) {
      continue;
    }
    const candidate = join(directory, "ast-grep");
    try {
      accessSync(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    try {
      const version = execFileSync(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        env: process.env,
      }).trim().split(/\r?\n/u)[0] ?? "";
      if (version.startsWith("ast-grep ")) {
        process.env.AST_GREP_BIN = candidate;
        prependPinnedAstGrep(candidate);
        return;
      }
    } catch {
      continue;
    }
  }
};

pinInstalledAstGrep();
export const realAstGrep = process.env.AST_GREP_BIN ?? "ast-grep";
