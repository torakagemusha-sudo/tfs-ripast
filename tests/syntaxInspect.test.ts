import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { inspectPreparedSyntax } from "../src/syntaxInspect.js";

interface NapiNodeForTest {
  children(): NapiNodeForTest[];
  range(): { start: { index: number }; end: { index: number } };
  text(): string;
}

interface NapiForTest {
  parse(language: string, source: string): { root(): NapiNodeForTest };
}

const require = createRequire(import.meta.url);

describe("inspectPreparedSyntax", () => {
  it("accepts valid typescript", () => {
    const r = inspectPreparedSyntax("typescript", Buffer.from("export const x = 1;\n"));
    expect(r).toMatchObject({
      hasError: false,
      hasMissingDescendant: false,
      hasJsFamilyDiagnostic: false,
      jsFamilyDiagnosticCount: 0,
    });
  });

  it("rejects incomplete typescript", () => {
    const r = inspectPreparedSyntax("typescript", Buffer.from("function f() {"));
    expect(r.hasError || r.hasMissingDescendant).toBe(true);
  });

  it("flags reserved-word typescript binding const new without treating it as ERROR", () => {
    const r = inspectPreparedSyntax("typescript", Buffer.from("const new = 1;\n"));
    expect(r.hasError).toBe(false);
    expect(r.errorNodeCount).toBe(0);
    expect(r.hasJsFamilyDiagnostic).toBe(true);
    expect(r.jsFamilyDiagnosticCount).toBeGreaterThan(0);
    expect(r.hasMissingDescendant).toBe(false);
  });

  it.each([
    ["parameter", "function f(new: number) {}\n"],
    ["class", "class new {}\n"],
    ["catch", "try {} catch (new) {}\n"],
    ["loop", "for (const new of []) {}\n"],
    ["destructuring", "const { value: new } = { value: 1 };\n"],
  ])("flags a reserved-word typescript %s binding", (_context, source) => {
    const r = inspectPreparedSyntax("typescript", Buffer.from(source));

    expect(r.hasJsFamilyDiagnostic).toBe(true);
    expect(r.jsFamilyDiagnosticCount).toBeGreaterThan(0);
  });

  it("accepts contextually valid public and interface bindings in non-strict javascript", () => {
    const r = inspectPreparedSyntax(
      "javascript",
      Buffer.from("var public = 1; var interface = 2;\n"),
    );

    expect(r.hasError).toBe(false);
    expect(r.hasMissingDescendant).toBe(false);
    expect(r.hasJsFamilyDiagnostic).toBe(false);
    expect(r.jsFamilyDiagnosticCount).toBe(0);
  });

  it("does not treat whitespace-only javascript root as missing", () => {
    const r = inspectPreparedSyntax("javascript", Buffer.from("\n"));
    expect(r.hasMissingDescendant).toBe(false);
    expect(r.hasError).toBe(false);
    expect(r.hasJsFamilyDiagnostic).toBe(false);
  });

  it("does not materialize text for non-zero-width syntax nodes", () => {
    const napi = require("@ast-grep/napi") as NapiForTest;
    const root = napi.parse("TypeScript", "export const x = 1;\n").root();
    const prototype = Object.getPrototypeOf(root) as NapiNodeForTest;
    const originalText = prototype.text;
    let nonZeroWidthTextReads = 0;
    prototype.text = function (this: NapiNodeForTest): string {
      const range = this.range();
      if (range.start.index !== range.end.index) {
        nonZeroWidthTextReads += 1;
      }
      return originalText.call(this);
    };

    try {
      inspectPreparedSyntax("typescript", Buffer.from("export const x = 1;\n"));
    } finally {
      prototype.text = originalText;
    }

    expect(nonZeroWidthTextReads).toBe(0);
  });

  it("rejects prepared syntax larger than the byte budget before parsing", () => {
    const oversized = Buffer.alloc((16 * 1024 * 1024) + 1, 0x20);
    expect(() => inspectPreparedSyntax("json", oversized)).toThrow(/16,777,216-byte limit/u);
  });

  it("rejects prepared syntax whose tree exceeds the node budget", () => {
    const tooManyNodes = Buffer.from(`[${"0,".repeat(250_000)}0]`);
    expect(() => inspectPreparedSyntax("json", tooManyNodes)).toThrow(/500,000-node limit/u);
  });

  it("inspects an 80 KiB valid typescript buffer without throwing", () => {
    const body = `${"export const n = 1;\n".repeat(4000)}`;
    expect(() => inspectPreparedSyntax("typescript", Buffer.from(body))).not.toThrow();
    expect(inspectPreparedSyntax("typescript", Buffer.from(body)).hasError).toBe(false);
  });
});
