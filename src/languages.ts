import { basename, matchesGlob } from "node:path";
import type { AstGrepLanguage, LanguageDecision, LanguageOverride } from "./types.js";

const extensionLanguages: Readonly<Record<string, AstGrepLanguage>> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  pyw: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cc: "cpp",
  cp: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  cxxm: "cpp",
  cs: "csharp",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
};

const ambiguousExtensions = new Set(["h", "hh", "hpp", "hxx"]);

function matchesOverrideGlob(path: string, glob: string): boolean {
  return matchesGlob(path, glob) || (!glob.includes("/") && matchesGlob(basename(path), glob));
}

function extensionOf(path: string): string | undefined {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) {
    return undefined;
  }
  return basename.slice(dot + 1).toLowerCase();
}

/**
 * Determines an ast-grep language without guessing shared extensions. Later
 * overrides intentionally take precedence, allowing a narrow recipe rule to
 * replace an earlier broad one.
 */
export function detectLanguage(
  path: string,
  overrides: readonly LanguageOverride[],
): LanguageDecision {
  const normalizedPath = path.replaceAll("\\", "/");
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const override = overrides[index];
    if (override !== undefined && matchesOverrideGlob(normalizedPath, override.glob)) {
      return { language: override.language, source: "override" };
    }
  }

  const extension = extensionOf(normalizedPath);
  if (extension === undefined) {
    return { language: undefined, source: "unsupported" };
  }
  if (ambiguousExtensions.has(extension)) {
    return { language: undefined, source: "ambiguous" };
  }
  const language = extensionLanguages[extension];
  return language === undefined
    ? { language: undefined, source: "unsupported" }
    : { language, source: "extension" };
}
