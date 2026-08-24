import { describe, expect, it } from "vitest";
import { correlateEvidence, type CorrelatedMatch } from "../src/evidence.js";
import type { ProviderDiagnostic, ProviderResult } from "../src/providers/provider.js";
import type { MatchEvidence } from "../src/types.js";

function evidence(
  id: string,
  provider: string,
  byteRange: [number, number],
  overrides: Partial<MatchEvidence> = {},
): MatchEvidence {
  return {
    id,
    operationId: "rename",
    provider,
    file: "src/app.ts",
    byteRange,
    lineRange: [1, 1],
    matchedTextHash: "sha256:match",
    language: "typescript",
    languageSource: "extension",
    confidence: provider === "ast-grep" ? "structural" : "lexical",
    ...overrides,
  };
}

function result(
  provider: string,
  matches: MatchEvidence[],
  diagnostics: ProviderDiagnostic[] = [],
  overrides: Partial<ProviderResult> = {},
): ProviderResult {
  return {
    provider,
    operationId: "rename",
    version: "1.0.0",
    evidence: matches,
    diagnostics,
    elapsedMs: 1,
    ...overrides,
  };
}

function summary(match: CorrelatedMatch): object {
  return {
    operationId: match.operationId,
    file: match.file,
    byteRange: match.byteRange,
    classification: match.classification,
    evidenceIds: match.evidence.map((item) => item.id),
  };
}

describe("correlateEvidence", () => {
  it("classifies exact lexical and structural agreement without provider-order priority", () => {
    const lexical = evidence("lexical", "ripgrep", [4, 12]);
    const structural = evidence("structural", "ast-grep", [4, 12], {
      captures: { ARGS: "value" },
    });

    const forward = correlateEvidence([
      result("ripgrep", [lexical]),
      result("ast-grep", [structural]),
    ]);
    const reverse = correlateEvidence([
      result("ast-grep", [structural]),
      result("ripgrep", [lexical]),
    ]);

    expect(forward.matches.map(summary)).toEqual([
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [4, 12],
        classification: "confirmed",
        evidenceIds: ["structural", "lexical"],
      },
    ]);
    expect(reverse).toEqual(forward);
    expect(forward.providerVersions).toEqual({ "ast-grep": "1.0.0", ripgrep: "1.0.0" });
  });

  it("keeps AST-only and text-only matches visible", () => {
    const { matches } = correlateEvidence([
      result("ast-grep", [evidence("ast", "ast-grep", [0, 3])]),
      result("ripgrep", [evidence("text", "ripgrep", [20, 24])]),
    ]);

    expect(matches.map(summary)).toEqual([
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [0, 3],
        classification: "ast-only",
        evidenceIds: ["ast"],
      },
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [20, 24],
        classification: "text-only",
        evidenceIds: ["text"],
      },
    ]);
  });

  it("classifies touching cross-provider spans as adjacent rather than agreement", () => {
    const { matches } = correlateEvidence([
      result("ripgrep", [evidence("text", "ripgrep", [4, 8])]),
      result("ast-grep", [evidence("ast", "ast-grep", [8, 15])]),
    ]);

    expect(matches.map(summary)).toEqual([
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [4, 15],
        classification: "adjacent",
        evidenceIds: ["ast", "text"],
      },
    ]);
  });

  it("finalizes exact confirmed spans before pairing unmatched adjacent spans", () => {
    const inputs = [
      result("ripgrep", [evidence("confirmed-text", "ripgrep", [4, 8])]),
      result("ast-grep", [
        evidence("confirmed-ast", "ast-grep", [4, 8]),
        evidence("unmatched-ast", "ast-grep", [8, 12]),
      ]),
    ];

    expect(correlateEvidence(inputs).matches.map(summary)).toEqual([
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [4, 8],
        classification: "confirmed",
        evidenceIds: ["confirmed-ast", "confirmed-text"],
      },
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [8, 12],
        classification: "ast-only",
        evidenceIds: ["unmatched-ast"],
      },
    ]);
    expect(correlateEvidence([...inputs].reverse()).matches.map(summary)).toEqual(
      correlateEvidence(inputs).matches.map(summary),
    );
  });

  it("pairs unmatched adjacency one-to-one without transitive absorption", () => {
    const { matches } = correlateEvidence([
      result("ripgrep", [
        evidence("left-text", "ripgrep", [0, 4]),
        evidence("right-text", "ripgrep", [8, 12]),
      ]),
      result("ast-grep", [evidence("middle-ast", "ast-grep", [4, 8])]),
    ]);

    expect(matches.map(summary)).toEqual([
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [0, 8],
        classification: "adjacent",
        evidenceIds: ["middle-ast", "left-text"],
      },
      {
        operationId: "rename",
        file: "src/app.ts",
        byteRange: [8, 12],
        classification: "text-only",
        evidenceIds: ["right-text"],
      },
    ]);
  });

  it("uses structured operation, language, and path fields for parse failures", () => {
    const parseFailure: ProviderDiagnostic = {
      code: "ast-grep-pattern-error",
      message: "arbitrary localized text",
      operationId: "rename",
      language: "typescript",
      paths: ["src"],
    };
    const deceptiveMessage: ProviderDiagnostic = {
      code: "ast-grep-note",
      message: "pattern could not be parsed",
      operationId: "rename",
      language: "typescript",
      paths: ["src/app.ts"],
    };
    const correlation = correlateEvidence([
      result("ripgrep", [evidence("text", "ripgrep", [4, 8])]),
      result("ast-grep", [], [deceptiveMessage, parseFailure]),
    ]);

    expect(correlation.matches[0]).toMatchObject({
      classification: "unparseable",
      diagnostics: [{ ...parseFailure, provider: "ast-grep" }],
    });
    expect(correlation.diagnostics).toEqual([
      { ...deceptiveMessage, provider: "ast-grep" },
      { ...parseFailure, provider: "ast-grep" },
    ]);
  });

  it("normalizes canonical repository paths before correlating", () => {
    const { matches } = correlateEvidence([
      result("ripgrep", [
        evidence("text", "ripgrep", [4, 8], { file: "src/feature/../app.ts" }),
      ]),
      result("ast-grep", [
        evidence("ast", "ast-grep", [4, 8], { file: "src/./app.ts" }),
      ]),
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ file: "src/app.ts", classification: "confirmed" });
    expect(matches[0]?.evidence.map((item) => item.file)).toEqual([
      "src/app.ts",
      "src/app.ts",
    ]);
  });

  it("preserves diagnostic-only groups and real provider versions", () => {
    const diagnostic: ProviderDiagnostic = {
      code: "ast-grep-unsupported-language",
      message: "No parser is available.",
      operationId: "rename",
      paths: ["README.md"],
    };

    expect(correlateEvidence([
      result("ast-grep", [], [diagnostic], { version: "0.45.1" }),
      result("ripgrep", [], [], { version: "15.2.0" }),
    ])).toEqual({
      matches: [],
      diagnostics: [{ ...diagnostic, provider: "ast-grep" }],
      providerVersions: { "ast-grep": "0.45.1", ripgrep: "15.2.0" },
    });
  });

  it("totally orders diagnostics across provider-result permutations", () => {
    const ast = result("ast-grep", [], [{
      code: "same-code",
      message: "z message",
      operationId: "rename",
      language: "typescript",
      paths: ["src/z.ts", "src/./a.ts"],
    }], { version: "0.45.1" });
    const ripgrep = result("ripgrep", [], [{
      code: "same-code",
      message: "a message",
      operationId: "rename",
      paths: ["src/b.ts"],
    }], { version: "15.2.0" });

    const forward = correlateEvidence([ast, ripgrep]);
    const reverse = correlateEvidence([ripgrep, ast]);
    expect(reverse).toEqual(forward);
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    expect(forward.diagnostics.map((diagnostic) => diagnostic.provider)).toEqual([
      "ast-grep",
      "ripgrep",
    ]);
    expect(forward.diagnostics[0]?.paths).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("rejects evidence and diagnostic paths that escape the requested root", () => {
    expect(() =>
      correlateEvidence([
        result("ripgrep", [evidence("escape", "ripgrep", [0, 1], { file: "../outside" })]),
      ]),
    ).toThrow(/outside.*root|escape/i);

    expect(() =>
      correlateEvidence([
        result("ripgrep", [evidence("drive", "ripgrep", [0, 1], { file: "C:/outside" })]),
      ]),
    ).toThrow(/outside.*root|escape/i);

    expect(() =>
      correlateEvidence([
        result("ast-grep", [], [{
          code: "ast-grep-pattern-error",
          message: "bad",
          operationId: "rename",
          paths: ["/outside"],
        }]),
      ]),
    ).toThrow(/outside.*root|escape/i);
  });
});
