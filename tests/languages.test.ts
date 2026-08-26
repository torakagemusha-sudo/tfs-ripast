import { describe, expect, it } from "vitest";
import { detectLanguage, napiLanguageId } from "../src/languages.js";

describe("language detection", () => {
  it("maps CLI language ids to @ast-grep/napi Lang string enums", () => {
    expect(napiLanguageId("typescript")).toBe("TypeScript");
    expect(napiLanguageId("javascript")).toBe("JavaScript");
    expect(napiLanguageId("jsx")).toBe("JavaScript");
    expect(napiLanguageId("tsx")).toBe("Tsx");
    expect(napiLanguageId("html")).toBe("Html");
    expect(napiLanguageId("css")).toBe("Css");
    expect(napiLanguageId("python")).toBe("python");
  });

  it("maps unambiguous ast-grep extensions", () => {
    expect(detectLanguage("src/app.ts", [])).toEqual({
      language: "typescript",
      source: "extension",
    });
    expect(detectLanguage("web/view.tsx", [])).toEqual({
      language: "tsx",
      source: "extension",
    });
    expect(detectLanguage("api/service.py", [])).toEqual({
      language: "python",
      source: "extension",
    });
    expect(detectLanguage("native/main.cpp", [])).toEqual({
      language: "cpp",
      source: "extension",
    });
    expect(detectLanguage("config/app.yaml", [])).toEqual({
      language: "yaml",
      source: "extension",
    });
  });

  it("reports shared and unsupported extensions without guessing", () => {
    expect(detectLanguage("script.h", [])).toEqual({
      language: undefined,
      source: "ambiguous",
    });
    expect(detectLanguage("README", [])).toEqual({
      language: undefined,
      source: "unsupported",
    });
  });

  it("gives matching language overrides precedence over extensions", () => {
    expect(
      detectLanguage("script.h", [{ glob: "**/*.h", language: "cpp" }]),
    ).toEqual({ language: "cpp", source: "override" });
    expect(
      detectLanguage("src/app.ts", [{ glob: "src/**/*.ts", language: "javascript" }]),
    ).toEqual({ language: "javascript", source: "override" });
  });

  it("uses the last matching override so recipes can narrow a broad rule", () => {
    expect(
      detectLanguage("generated/vendor.ts", [
        { glob: "**/*.ts", language: "typescript" },
        { glob: "generated/**/*.ts", language: "javascript" },
      ]),
    ).toEqual({ language: "javascript", source: "override" });
  });

  it("uses the same Node 24 glob dialect as operation include globs", () => {
    expect(detectLanguage("src/component.tsx", [{
      glob: "**/*.{ts,tsx}",
      language: "tsx",
    }])).toEqual({ language: "tsx", source: "override" });
    expect(detectLanguage("src/app.js", [{
      glob: "*.[jt]s",
      language: "javascript",
    }])).toEqual({ language: "javascript", source: "override" });
  });
});
