import { lstatSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { realAstGrep } from "./pin-installed-ast-grep.js";

describe("installed ast-grep test pin", () => {
  it("uses a fresh private temporary directory for the PATH shim", () => {
    const pinDirectory = (process.env.PATH ?? "").split(delimiter)[0];
    expect(pinDirectory).toBeDefined();
    expect(pinDirectory).not.toBe(join(tmpdir(), `tfs-ripast-pin-ast-grep-${String(process.pid)}`));
    expect(basename(pinDirectory!)).toMatch(/^tfs-ripast-pin-ast-grep-.{6}$/u);
    expect(statSync(pinDirectory!).mode & 0o777).toBe(0o700);

    const pinnedExecutable = join(pinDirectory!, "ast-grep");
    expect(lstatSync(pinnedExecutable).isSymbolicLink()).toBe(true);
    expect(realpathSync(pinnedExecutable)).toBe(realpathSync(realAstGrep));
  });
});
