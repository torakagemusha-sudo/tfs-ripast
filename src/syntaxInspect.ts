import { createRequire } from "node:module";
import { napiLanguageId } from "./languages.js";
import type { AstGrepLanguage } from "./types.js";

export interface SyntaxInspection {
  language: AstGrepLanguage;
  /** True iff the walk found tree-sitter `ERROR` nodes. Not a JS/TS linter. */
  hasError: boolean;
  hasMissingDescendant: boolean;
  /** Count of tree-sitter `ERROR` nodes only. */
  errorNodeCount: number;
  /** True iff TypeScript's JS-family parser reported a syntax diagnostic. */
  hasJsFamilyDiagnostic: boolean;
  /** Count of error diagnostics from TypeScript's JS-family parser. */
  jsFamilyDiagnosticCount: number;
}

interface SyntaxNode {
  kind(): string;
  text(): string;
  range(): { start: { index: number }; end: { index: number } };
  child(index: number): SyntaxNode | null;
  isMissing?: () => boolean;
}

interface LanguageRegistration {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  metaVarChar?: string;
  expandoChar?: string;
}

interface AstGrepNapi {
  parse: (lang: string, src: string) => { root(): SyntaxNode };
  registerDynamicLanguage: (langs: Record<string, LanguageRegistration>) => void;
}

const require = createRequire(import.meta.url);

/**
 * Grammar skew: `@ast-grep/napi` 0.45.1 builtins are only Html, JavaScript,
 * Tsx, Css, TypeScript. Remaining CLI `AstGrepLanguage` ids load
 * `@ast-grep/lang-*` extras via `registerDynamicLanguage`. Extra grammars can
 * diverge from the CLI binary; napi is pinned to exact 0.45.1.
 */
const dynamicLanguagePackages: Readonly<Record<string, string>> = {
  python: "@ast-grep/lang-python",
  rust: "@ast-grep/lang-rust",
  go: "@ast-grep/lang-go",
  java: "@ast-grep/lang-java",
  c: "@ast-grep/lang-c",
  cpp: "@ast-grep/lang-cpp",
  csharp: "@ast-grep/lang-csharp",
  ruby: "@ast-grep/lang-ruby",
  swift: "@ast-grep/lang-swift",
  kotlin: "@ast-grep/lang-kotlin",
  scala: "@ast-grep/lang-scala",
  json: "@ast-grep/lang-json",
  yaml: "@ast-grep/lang-yaml",
};

const jsFamilyLanguages = new Set<AstGrepLanguage>(["javascript", "jsx", "typescript", "tsx"]);
const jsFamilyFileNames: Readonly<Partial<Record<AstGrepLanguage, string>>> = {
  javascript: "prepared.js",
  jsx: "prepared.jsx",
  typescript: "prepared.ts",
  tsx: "prepared.tsx",
};
const maximumPreparedSyntaxBytes = 16 * 1024 * 1024;
const maximumPreparedSyntaxNodes = 500_000;

let napiModule: AstGrepNapi | undefined;
let dynamicLanguagesRegistered = false;
let typescriptModule: typeof import("typescript") | undefined;

function loadAstGrepNapi(): AstGrepNapi {
  if (napiModule !== undefined) {
    return napiModule;
  }
  try {
    napiModule = require("@ast-grep/napi") as AstGrepNapi;
    return napiModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`@ast-grep/napi could not be loaded for prepared syntax inspection: ${detail}`);
  }
}

function ensureDynamicLanguages(napi: AstGrepNapi): void {
  if (dynamicLanguagesRegistered) {
    return;
  }
  const langs: Record<string, LanguageRegistration> = {};
  for (const [language, packageName] of Object.entries(dynamicLanguagePackages)) {
    langs[language] = require(packageName) as LanguageRegistration;
  }
  napi.registerDynamicLanguage(langs);
  dynamicLanguagesRegistered = true;
}

function loadTypeScript(): typeof import("typescript") {
  if (typescriptModule !== undefined) {
    return typescriptModule;
  }
  try {
    typescriptModule = require("typescript") as typeof import("typescript");
    return typescriptModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TypeScript could not be loaded for JavaScript-family syntax inspection: ${detail}`);
  }
}

function nodeIsMissing(node: SyntaxNode): boolean {
  if (typeof node.isMissing === "function" && node.isMissing()) {
    return true;
  }
  const range = node.range();
  if (range.start.index !== range.end.index) {
    return false;
  }
  return node.text() === "";
}

function inspectTree(
  root: SyntaxNode,
): Pick<SyntaxInspection, "hasError" | "hasMissingDescendant" | "errorNodeCount"> {
  let hasError = false;
  let hasMissingDescendant = false;
  let errorNodeCount = 0;
  const stack: Array<{ node: SyntaxNode; isRoot: boolean }> = [{ node: root, isRoot: true }];
  let discoveredNodes = 1;
  const pushNode = (candidate: SyntaxNode | null): void => {
    if (candidate === null) {
      return;
    }
    if (discoveredNodes >= maximumPreparedSyntaxNodes) {
      throw new Error(
        `Prepared syntax tree exceeds the ${maximumPreparedSyntaxNodes.toLocaleString("en-US")}-node limit.`,
      );
    }
    discoveredNodes += 1;
    stack.push({ node: candidate, isRoot: false });
  };
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const { node, isRoot } = current;
    if (node.kind() === "ERROR") {
      hasError = true;
      errorNodeCount += 1;
    }
    if (!isRoot && nodeIsMissing(node)) {
      hasMissingDescendant = true;
    }
    for (let childIndex = 0; ; childIndex += 1) {
      const child = node.child(childIndex);
      if (child === null) {
        break;
      }
      pushNode(child);
    }
  }
  return { hasError, hasMissingDescendant, errorNodeCount };
}

function inspectJsFamily(
  language: AstGrepLanguage,
  source: string,
): Pick<SyntaxInspection, "hasJsFamilyDiagnostic" | "jsFamilyDiagnosticCount"> {
  if (!jsFamilyLanguages.has(language)) {
    return { hasJsFamilyDiagnostic: false, jsFamilyDiagnosticCount: 0 };
  }
  const fileName = jsFamilyFileNames[language];
  if (fileName === undefined) {
    throw new Error(`No TypeScript parser filename is registered for JavaScript-family language ${language}.`);
  }
  const typescript = loadTypeScript();
  const diagnostics = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.Latest,
      ...((language === "jsx" || language === "tsx") ? { jsx: typescript.JsxEmit.Preserve } : {}),
    },
    fileName,
    reportDiagnostics: true,
  }).diagnostics ?? [];
  const jsFamilyDiagnosticCount = diagnostics.filter(
    (diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error,
  ).length;
  return {
    hasJsFamilyDiagnostic: jsFamilyDiagnosticCount > 0,
    jsFamilyDiagnosticCount,
  };
}

export function inspectPreparedSyntax(
  language: AstGrepLanguage,
  sourceUtf8: Uint8Array,
): SyntaxInspection {
  if (sourceUtf8.byteLength > maximumPreparedSyntaxBytes) {
    throw new Error(
      `Prepared syntax exceeds the ${maximumPreparedSyntaxBytes.toLocaleString("en-US")}-byte limit.`,
    );
  }
  const napi = loadAstGrepNapi();
  if (Object.hasOwn(dynamicLanguagePackages, language)) {
    try {
      ensureDynamicLanguages(napi);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`@ast-grep/napi dynamic language ${language} could not be registered: ${detail}`);
    }
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(sourceUtf8);
  } catch {
    throw new Error("Prepared syntax is not valid UTF-8.");
  }
  const root = napi.parse(napiLanguageId(language), source).root();
  return { language, ...inspectTree(root), ...inspectJsFamily(language, source) };
}
