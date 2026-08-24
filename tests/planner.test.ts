import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildEditPlan,
  expandReplacement,
  type FileSnapshot,
} from "../src/planner.js";
import { correlateEvidence, type CorrelationResult } from "../src/evidence.js";
import type { ProviderDiagnostic, ProviderResult } from "../src/providers/provider.js";
import type { MatchEvidence, RewriteOperation, RewritePlan } from "../src/types.js";

function hash(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function operation(overrides: Partial<RewriteOperation> = {}): RewriteOperation {
  return {
    id: "rename",
    paths: ["src"],
    search: "old",
    replace: "new",
    lexical: { type: "literal" },
    ...overrides,
  };
}

function rewritePlan(operations: RewriteOperation[]): RewritePlan {
  return {
    version: 1,
    name: "planner test",
    root: ".",
    operations,
    policy: {},
    validations: [],
  };
}

function snapshot(text = "old xx old"): FileSnapshot {
  const content = Buffer.from(text);
  return {
    path: "src/app.ts",
    hash: hash(content),
    byteLength: content.byteLength,
    mode: 0o644,
    newline: "none",
    encoding: "utf-8",
    content,
  };
}

function evidence(
  id: string,
  operationId: string,
  byteRange: [number, number],
  text: string,
  overrides: Partial<MatchEvidence> = {},
): MatchEvidence {
  return {
    id,
    operationId,
    provider: "ripgrep",
    file: "src/app.ts",
    byteRange,
    lineRange: [1, 1],
    matchedTextHash: hash(text),
    language: "typescript",
    languageSource: "extension",
    confidence: "lexical",
    ...overrides,
  };
}

function correlation(
  matches: MatchEvidence[],
  diagnostics: Array<{ provider: string; diagnostic: ProviderDiagnostic }> = [],
  versions: Record<string, string> = { ripgrep: "15.2.0", "ast-grep": "0.45.1" },
): CorrelationResult {
  const grouped = new Map<string, ProviderResult>();
  const ensure = (provider: string, operationId: string): ProviderResult => {
    const key = JSON.stringify([provider, operationId]);
    const existing = grouped.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: ProviderResult = {
      provider,
      operationId,
      version: versions[provider] ?? "unknown",
      evidence: [],
      diagnostics: [],
      elapsedMs: 1,
    };
    grouped.set(key, created);
    return created;
  };
  for (const item of matches) {
    ensure(item.provider, item.operationId).evidence.push(item);
  }
  for (const item of diagnostics) {
    ensure(item.provider, item.diagnostic.operationId).diagnostics.push(item.diagnostic);
  }
  for (const [provider] of Object.entries(versions)) {
    ensure(provider, "rename");
  }
  return correlateEvidence([...grouped.values()]);
}

function build(
  plan: RewritePlan,
  snapshots: FileSnapshot[],
  matches: MatchEvidence[],
  diagnostics: Array<{ provider: string; diagnostic: ProviderDiagnostic }> = [],
) {
  return buildEditPlan(plan, snapshots, correlation(matches, diagnostics));
}

describe("expandReplacement", () => {
  it("substitutes named structural captures", () => {
    expect(expandReplacement("new(${ARGS})", { ARGS: "a, b" })).toBe("new(a, b)");
  });

  it("rejects missing named captures", () => {
    expect(() => expandReplacement("new(${MISSING})", {})).toThrow(/MISSING/);
  });

  it("leaves ordinary dollar text unchanged", () => {
    expect(expandReplacement("price: $5", {})).toBe("price: $5");
  });
});

describe("buildEditPlan", () => {
  it("deduplicates identical provider edits and retains all evidence provenance", () => {
    const input = snapshot("old");
    const plan = build(rewritePlan([operation()]), [input], [
      evidence("text", "rename", [0, 3], "old"),
      evidence("ast", "rename", [0, 3], "old", {
        provider: "ast-grep",
        confidence: "structural",
      }),
    ]);

    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({
      operationIds: ["rename"],
      file: "src/app.ts",
      byteRange: [0, 3],
      replacement: "new",
      evidenceIds: ["ast", "text"],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.providerVersions).toEqual({ "ast-grep": "0.45.1", ripgrep: "15.2.0" });
    expect(plan.inputFiles).toEqual([{
      path: "src/app.ts",
      hash: input.hash,
      byteLength: 3,
      mode: 0o644,
      newline: "none",
      encoding: "utf-8",
    }]);
  });

  it("expands captures from structural evidence without sending replacements to providers", () => {
    const plan = build(
      rewritePlan([operation({ replace: "new(${ARGS})" })]),
      [snapshot("old")],
      [evidence("ast", "rename", [0, 3], "old", {
        provider: "ast-grep",
        confidence: "structural",
        captures: { ARGS: "a, b" },
      })],
    );

    expect(plan.edits[0]?.replacement).toBe("new(a, b)");
  });

  it("sorts conflict-free disjoint edits by descending byte start", () => {
    const plan = build(rewritePlan([operation()]), [snapshot()], [
      evidence("first", "rename", [0, 3], "old"),
      evidence("second", "rename", [7, 10], "old"),
    ]);

    expect(plan.conflicts).toEqual([]);
    expect(plan.edits.map((edit) => edit.byteRange)).toEqual([[7, 10], [0, 3]]);
  });

  it.each([
    {
      name: "same-span disagreement",
      ranges: [[0, 3], [0, 3]] as [[number, number], [number, number]],
      reason: "same-range",
    },
    {
      name: "partial overlap",
      ranges: [[0, 6], [4, 8]] as [[number, number], [number, number]],
      reason: "partial-overlap",
    },
    {
      name: "nested overlap",
      ranges: [[0, 8], [2, 6]] as [[number, number], [number, number]],
      reason: "nested-overlap",
    },
  ])("records $name without choosing a provider winner", ({ ranges, reason }) => {
    const text = "old old!";
    const [left, right] = ranges;
    const leftText = Buffer.from(text).subarray(left[0], left[1]).toString();
    const rightText = Buffer.from(text).subarray(right[0], right[1]).toString();
    const plan = build(
      rewritePlan([
        operation({ id: "alpha", replace: "A" }),
        operation({ id: "beta", replace: "B" }),
      ]),
      [snapshot(text)],
      [
        evidence("left", "alpha", left, leftText, { provider: "ast-grep", confidence: "structural" }),
        evidence("right", "beta", right, rightText),
      ],
    );

    expect(plan.edits).toHaveLength(2);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ reason, editIds: expect.arrayContaining([
      plan.edits[0]?.id,
      plan.edits[1]?.id,
    ]) });
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({
      code: "unresolved-conflicts",
      paths: ["src/app.ts"],
    }));
  });

  it("does not conflict on half-open ranges that only touch", () => {
    const plan = build(
      rewritePlan([
        operation({ id: "alpha", replace: "A" }),
        operation({ id: "beta", replace: "B" }),
      ]),
      [snapshot("oldold")],
      [
        evidence("left", "alpha", [0, 3], "old"),
        evidence("right", "beta", [3, 6], "old"),
      ],
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.edits.map((edit) => edit.byteRange)).toEqual([[3, 6], [0, 3]]);
  });

  it("reports expected-count failures after exact provider agreement is deduplicated", () => {
    const exact = build(
      rewritePlan([operation({ expectedCount: { exact: 1 } })]),
      [snapshot("old")],
      [
        evidence("text", "rename", [0, 3], "old"),
        evidence("ast", "rename", [0, 3], "old", {
          provider: "ast-grep",
          confidence: "structural",
        }),
      ],
    );
    const outsideBounds = build(
      rewritePlan([operation({ expectedCount: { min: 2, max: 3 } })]),
      [snapshot("old")],
      [evidence("text", "rename", [0, 3], "old")],
    );

    expect(exact.diagnostics).toEqual([]);
    expect(outsideBounds.diagnostics).toEqual([
      expect.objectContaining({ code: "expected-count-min", paths: ["src/app.ts"] }),
    ]);
  });

  it("physically deduplicates identical edits across operations with complete provenance", () => {
    const plan = build(
      rewritePlan([
        operation({ id: "alpha", expectedCount: { exact: 1 } }),
        operation({ id: "beta", expectedCount: { exact: 1 } }),
      ]),
      [snapshot("old")],
      [
        evidence("alpha-evidence", "alpha", [0, 3], "old"),
        evidence("beta-evidence", "beta", [0, 3], "old"),
      ],
    );

    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({
      operationIds: ["alpha", "beta"],
      evidenceIds: ["alpha-evidence", "beta-evidence"],
      byteRange: [0, 3],
      replacement: "new",
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });

  it.each([
    { policy: "skip" as const, edits: 0, plannerDiagnostic: false },
    { policy: "error" as const, edits: 0, plannerDiagnostic: true },
    { policy: "allow" as const, edits: 1, plannerDiagnostic: false },
  ])("applies the exact onUnparseable=$policy policy", ({ policy, edits, plannerDiagnostic }) => {
    const providerDiagnostic: ProviderDiagnostic = {
      code: "ast-grep-pattern-error",
      message: "localized parse failure",
      operationId: "rename",
      language: "typescript",
      paths: ["src/app.ts"],
    };
    const plan = build(
      rewritePlan([operation({ matchPolicy: { onUnparseable: policy } })]),
      [snapshot("old")],
      [evidence("text", "rename", [0, 3], "old")],
      [{ provider: "ast-grep", diagnostic: providerDiagnostic }],
    );

    expect(plan.edits).toHaveLength(edits);
    expect(plan.diagnostics).toContainEqual({
      ...providerDiagnostic,
      provider: "ast-grep",
    });
    expect(plan.diagnostics.some((diagnostic) => diagnostic.code === "unparseable-match")).toBe(
      plannerDiagnostic,
    );
  });

  it("preserves diagnostic-only correlation output in the final edit plan", () => {
    const diagnostic: ProviderDiagnostic = {
      code: "ast-grep-unsupported-language",
      message: "No parser.",
      operationId: "rename",
      paths: ["README.md"],
    };
    const plan = build(
      rewritePlan([operation()]),
      [snapshot("old")],
      [],
      [{ provider: "ast-grep", diagnostic }],
    );

    expect(plan.evidence).toEqual([]);
    expect(plan.diagnostics).toContainEqual({ ...diagnostic, provider: "ast-grep" });
    expect(plan.providerVersions).toEqual({ "ast-grep": "0.45.1", ripgrep: "15.2.0" });
  });

  it("orders Unicode diagnostics by raw UTF-16 code units for byte-stable plan IDs", () => {
    const composed: ProviderDiagnostic = {
      code: "ast-grep-note",
      message: "é",
      operationId: "rename",
      language: "typescript",
      paths: ["src/app.ts"],
    };
    const decomposed: ProviderDiagnostic = {
      ...composed,
      message: "e\u0301",
    };
    const astResult = (diagnostics: ProviderDiagnostic[]): ProviderResult => ({
      provider: "ast-grep",
      operationId: "rename",
      version: "0.45.1",
      evidence: [],
      diagnostics,
      elapsedMs: 1,
    });
    const ripgrepResult: ProviderResult = {
      provider: "ripgrep",
      operationId: "rename",
      version: "15.2.0",
      evidence: [],
      diagnostics: [],
      elapsedMs: 1,
    };

    const forward = buildEditPlan(
      rewritePlan([operation()]),
      [snapshot("old")],
      correlateEvidence([astResult([composed, decomposed]), ripgrepResult]),
    );
    const reverse = buildEditPlan(
      rewritePlan([operation()]),
      [snapshot("old")],
      correlateEvidence([ripgrepResult, astResult([decomposed, composed])]),
    );

    expect(forward.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "e\u0301",
      "é",
    ]);
    expect(JSON.stringify(reverse.diagnostics)).toBe(JSON.stringify(forward.diagnostics));
    expect(reverse.id).toBe(forward.id);
  });

  it("validates byte ranges and matched hashes against the immutable snapshot", () => {
    expect(() =>
      build(rewritePlan([operation()]), [snapshot("old")], [
        evidence("stale", "rename", [0, 3], "new"),
      ]),
    ).toThrow(/snapshot|hash/i);

    expect(() =>
      build(rewritePlan([operation()]), [snapshot("old")], [
        evidence("outside", "rename", [0, 4], "old!"),
      ]),
    ).toThrow(/byte range|snapshot/i);
  });
});
