import { describe, expect, it } from "vitest";
import { inspectPreparedSyntax } from "../src/syntaxInspect.js";

describe("inspectPreparedSyntax", () => {
  it("accepts valid typescript", () => {
    const r = inspectPreparedSyntax("typescript", Buffer.from("export const x = 1;\n"));
    expect(r).toMatchObject({ hasError: false, hasMissingDescendant: false, hasReservedBinding: false });
  });

  it("rejects incomplete typescript", () => {
    const r = inspectPreparedSyntax("typescript", Buffer.from("function f() {"));
    expect(r.hasError || r.hasMissingDescendant).toBe(true);
  });

  it("flags reserved-word typescript binding const new without treating it as ERROR", () => {
    const r = inspectPreparedSyntax("typescript", Buffer.from("const new = 1;\n"));
    expect(r.hasError).toBe(false);
    expect(r.errorNodeCount).toBe(0);
    expect(r.hasReservedBinding).toBe(true);
    expect(r.hasMissingDescendant).toBe(false);
  });

  it("does not treat whitespace-only javascript root as missing", () => {
    const r = inspectPreparedSyntax("javascript", Buffer.from("\n"));
    expect(r.hasMissingDescendant).toBe(false);
    expect(r.hasError).toBe(false);
    expect(r.hasReservedBinding).toBe(false);
  });

  it("inspects an 80 KiB valid typescript buffer without throwing", () => {
    const body = `${"export const n = 1;\n".repeat(4000)}`;
    expect(() => inspectPreparedSyntax("typescript", Buffer.from(body))).not.toThrow();
    expect(inspectPreparedSyntax("typescript", Buffer.from(body)).hasError).toBe(false);
  });
});
