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
  /**
   * Isolated JS/TS extra check; never folded into hasError / errorNodeCount.
   * tree-sitter-typescript 0.45.1 lexes reserved words such as `new` as
   * `identifier` (no ERROR node); tsc reports TS1389. Brief still requires
   * `const new =` to block writes.
   */
  hasReservedBinding: boolean;
}

interface SyntaxNode {
  kind(): string;
  text(): string;
  range(): { start: { index: number }; end: { index: number } };
  children(): SyntaxNode[];
  field?: (name: string) => SyntaxNode | null;
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

/** JS/TS reserved binding names (hasReservedBinding only; tree-sitter still parses them). */
const jsReservedBindings = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
  "package", "private", "protected", "public", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
]);

let napiModule: AstGrepNapi | undefined;
let dynamicLanguagesRegistered = false;

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

function nodeIsMissing(node: SyntaxNode): boolean {
  if (typeof node.isMissing === "function" && node.isMissing()) {
    return true;
  }
  const range = node.range();
  return node.text() === "" && range.start.index === range.end.index;
}

function reservedBindingName(node: SyntaxNode): string | undefined {
  if (node.kind() !== "variable_declarator") {
    return undefined;
  }
  const name = typeof node.field === "function" ? node.field("name") : undefined;
  if (name !== undefined && name !== null && name.kind() === "identifier") {
    return name.text();
  }
  const first = node.children()[0];
  return first?.kind() === "identifier" ? first.text() : undefined;
}

function inspectTree(
  language: AstGrepLanguage,
  root: SyntaxNode,
): Pick<SyntaxInspection, "hasError" | "hasMissingDescendant" | "errorNodeCount" | "hasReservedBinding"> {
  let hasError = false;
  let hasMissingDescendant = false;
  let hasReservedBinding = false;
  let errorNodeCount = 0;
  const stack: Array<{ node: SyntaxNode; isRoot: boolean }> = [{ node: root, isRoot: true }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    const { node, isRoot } = current;
    if (node.kind() === "ERROR") {
      hasError = true;
      errorNodeCount += 1;
    } else if (jsFamilyLanguages.has(language)) {
      const binding = reservedBindingName(node);
      if (binding !== undefined && jsReservedBindings.has(binding)) {
        hasReservedBinding = true;
      }
    }
    if (!isRoot && nodeIsMissing(node)) {
      hasMissingDescendant = true;
    }
    const children = node.children();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) {
        stack.push({ node: child, isRoot: false });
      }
    }
  }
  return { hasError, hasMissingDescendant, errorNodeCount, hasReservedBinding };
}

export function inspectPreparedSyntax(
  language: AstGrepLanguage,
  sourceUtf8: Uint8Array,
): SyntaxInspection {
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
  return { language, ...inspectTree(language, root) };
}
