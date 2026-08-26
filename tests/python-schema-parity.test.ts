import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRewritePlan } from "../src/schema.js";

function pythonExecutable(): string {
  const override = process.env.TFS_RIPAST_PYTHON;
  if (override !== undefined && override !== "") {
    return override;
  }
  const venvPython = join(homedir(), ".local/share/tfs-ripast-python/bin/python");
  try {
    accessSync(venvPython, fsConstants.X_OK);
    return venvPython;
  } catch {
    return "python3";
  }
}

function basePlan(): Record<string, unknown> {
  return { version: 1, name: "parity", root: ".", operations: [], policy: {}, validations: [] };
}

function pythonAccepts(value: unknown): boolean {
  const result = spawnSync(pythonExecutable(), ["-c", [
    "import json, sys",
    "from tfs_ripast.schema import validate_rewrite_plan",
    "try:",
    " validate_rewrite_plan(json.load(sys.stdin))",
    "except Exception:",
    " raise SystemExit(1)",
  ].join("\n")], {
    cwd: resolve("."),
    env: { ...process.env, PYTHONPATH: resolve("python") },
    input: JSON.stringify(value),
    encoding: "utf8",
  });
  return result.status === 0;
}

describe("Python RewritePlan schema parity", () => {
  it.each([
    ["valid", basePlan()],
    ["unknown field", { ...basePlan(), shell: "sh" }],
    ["duplicate operation IDs", { ...basePlan(), operations: [
      { id: "same", paths: ["a.ts"], search: "a", replace: "b", lexical: { type: "literal" } },
      { id: "same", paths: ["b.ts"], search: "a", replace: "b", lexical: { type: "literal" } },
    ] }],
    ["reversed expected range", { ...basePlan(), operations: [
      { id: "range", paths: ["a.ts"], search: "a", replace: "b", lexical: { type: "literal" }, expectedCount: { min: 2, max: 1 } },
    ] }],
    ["empty expected range", { ...basePlan(), operations: [
      { id: "empty", paths: ["a.ts"], search: "a", replace: "b", lexical: { type: "literal" }, expectedCount: {} },
    ] }],
  ])("agrees for %s", (_name, value) => {
    let typescriptAccepted = true;
    try {
      parseRewritePlan(value);
    } catch {
      typescriptAccepted = false;
    }
    expect(pythonAccepts(value)).toBe(typescriptAccepted);
  });
});
