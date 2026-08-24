import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseEditPlan,
  parseRewritePlan,
  parseTransactionRecord,
} from "../src/schema.js";

const validOperation = () => ({
  id: "rename-old-api",
  paths: ["src"],
  search: "oldApi($ARGS)",
  replace: "newApi(${ARGS})",
  lexical: { type: "literal" },
});

const validPlan = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name: "Rename old API",
  root: ".",
  operations: [validOperation()],
  policy: {},
  validations: [],
  ...overrides,
});

const loadSchema = (name: string): object =>
  JSON.parse(readFileSync(join(process.cwd(), "schemas", name), "utf8")) as object;

const loadFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(process.cwd(), "schemas", name), "utf8")) as T;

const rewriteSchema = loadSchema("rewrite-plan.schema.json");
const editSchema = loadSchema("edit-plan.schema.json");
const transactionSchema = loadSchema("transaction.schema.json");
const semanticFixtures = loadFixture<{
  paths: { safe: string[]; unsafe: string[] };
}>("semantic-validation-fixtures.json");

const validator = () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  ajv.addKeyword({ keyword: "x-tfs-ripast-semantic-validation", schemaType: "string" });
  ajv.addSchema(rewriteSchema);
  ajv.addSchema(editSchema);
  ajv.addSchema(transactionSchema);
  return ajv;
};

const validEvidence = () => ({
  id: "evidence-1",
  operationId: "rename-old-api",
  provider: "ast-grep",
  file: "src/app.ts",
  byteRange: [5, 18],
  lineRange: [1, 1],
  matchedTextHash: "sha256:evidence",
  language: "typescript",
  languageSource: "extension",
  confidence: "structural",
});

const validEditPlan = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  id: "edit-plan-1",
  rewritePlan: validPlan(),
  rewritePlanHash: "sha256:rewrite-plan",
  gitScope: {
    repository: true,
    root: "/repo",
    repositoryRoot: "/repo",
    head: "0123456789abcdef0123456789abcdef01234567",
    dirty: false,
    mode: "all",
    requireClean: false,
    inputs: [{
      path: "src/app.ts",
      worktreeBlob: "0123456789abcdef0123456789abcdef01234567",
      indexBlob: "0123456789abcdef0123456789abcdef01234567",
    }],
  },
  inputFiles: [
    {
      path: "src/app.ts",
      hash: "sha256:before",
      byteLength: 42,
      mode: 33188,
      newline: "lf",
      encoding: "utf-8",
    },
  ],
  evidence: [validEvidence()],
  edits: [
    {
      id: "edit-1",
      operationIds: ["rename-old-api"],
      file: "src/app.ts",
      byteRange: [5, 18],
      replacement: "newApi()",
      evidenceIds: ["evidence-1"],
    },
  ],
  conflicts: [],
  diagnostics: [],
  providerVersions: { "ast-grep": "0.40.0" },
  createdAt: "2026-08-21T00:00:00.000Z",
  ...overrides,
});

const validTransaction = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  id: "transaction-1",
  editPlanHash: "sha256:edit-plan",
  gitScope: validEditPlan().gitScope,
  validationPolicy: {
    keepOnCheckFailure: false,
    rollbackPolicy: "rollback-on-failure",
    authority: "default",
  },
  changedPaths: ["src/app.ts"],
  files: [{
    path: "src/app.ts",
    beforeHash: "sha256:before",
    afterHash: "sha256:after",
    beforeMode: 0o644,
    afterMode: 0o755,
  }],
  validations: [
    {
      source: "named-adapter",
      adapter: "typescript-typecheck",
      executable: "/usr/bin/node",
      argv: ["node", "node_modules/typescript/bin/tsc", "--noEmit"],
      cwd: ".",
      actualCwd: "/repo",
      timeoutMs: 30_000,
      stage: "postcommit",
      rollbackPolicy: "rollback-on-failure",
      timedOut: false,
      truncated: false,
      status: "passed",
      exitCode: 0,
      output: "",
    },
  ],
  inversePatch: "",
  startedAt: "2026-08-21T00:00:00.000Z",
  state: "committed",
  ...overrides,
});

const explicitCommandValidationResult = () => ({
  source: "explicit-command",
  executable: "/usr/bin/node",
  argv: ["node", "scripts/project-check.mjs"],
  cwd: ".",
  actualCwd: "/repo",
  timeoutMs: 30_000,
  stage: "postcommit",
  rollbackPolicy: "rollback-on-failure",
  timedOut: false,
  truncated: false,
  status: "passed",
  exitCode: 0,
  output: "",
});

describe("RewritePlan schema", () => {
  it("rejects unknown versions and unknown operation fields", () => {
    expect(() =>
      parseRewritePlan({
        version: 2,
        name: "x",
        root: ".",
        operations: [],
        policy: {},
        validations: [],
      }),
    ).toThrow();
    expect(() =>
      parseRewritePlan(
        validPlan({
          operations: [{ ...validOperation(), shell: "rm -rf ." }],
        }),
      ),
    ).toThrow();
  });

  it("accepts only deterministic capture replacement syntax", () => {
    expect(
      parseRewritePlan(
        validPlan({
          operations: [
            { ...validOperation(), replace: "next(${ARGS}) and $5" },
          ],
        }),
      ),
    ).toBeTruthy();
    expect(() =>
      parseRewritePlan(
        validPlan({
          operations: [{ ...validOperation(), replace: "next(${})" }],
        }),
      ),
    ).toThrow();
  });

  it("rejects unsafe operation paths and duplicate operation IDs", () => {
    expect(() =>
      parseRewritePlan(
        validPlan({
          operations: [{ ...validOperation(), paths: ["../outside"] }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseRewritePlan(
        validPlan({
          operations: [validOperation(), { ...validOperation(), search: "other" }],
        }),
      ),
    ).toThrow();
  });

  it("rejects blank IDs and negative policy limits", () => {
    expect(() =>
      parseRewritePlan(
        validPlan({ operations: [{ ...validOperation(), id: "  " }] }),
      ),
    ).toThrow();
    expect(() => parseRewritePlan(validPlan({ policy: { maxFiles: -1 } }))).toThrow();
  });

  it("requires explicit lexical and validation variants", () => {
    expect(() =>
      parseRewritePlan(
        validPlan({
          operations: [{ ...validOperation(), lexical: { type: "literal", flags: "i" } }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseRewritePlan(
        validPlan({
          validations: [{ type: "command", executable: "npm", args: ["test"] }],
        }),
      ),
    ).toThrow();
  });

  it("requires nonempty count invariants with ordered bounds", () => {
    expect(() =>
      parseRewritePlan(
        validPlan({ operations: [{ ...validOperation(), expectedCount: {} }] }),
      ),
    ).toThrow();
    expect(() =>
      parseRewritePlan(
        validPlan({
          operations: [{ ...validOperation(), expectedCount: { min: 3, max: 2 } }],
        }),
      ),
    ).toThrow();
  });

  it("accepts the explicit unparseable error policy in both schema runtimes", () => {
    const plan = validPlan({
      operations: [{ ...validOperation(), matchPolicy: { onUnparseable: "error" } }],
    });
    const ajv = validator();
    const validateRewrite = ajv.getSchema("https://torafirma.dev/schemas/tfs-ripast/rewrite-plan/v1");

    expect(() => parseRewritePlan(plan)).not.toThrow();
    expect(validateRewrite?.(plan)).toBe(true);
  });

  it("enforces semantic identity, operation mapping, references, and ordered ranges", () => {
    expect(parseEditPlan(validEditPlan())).toBeTruthy();
    expect(() =>
      parseEditPlan(
        validEditPlan({ edits: [{ ...validEditPlan().edits[0], id: "edit-1" }, { ...validEditPlan().edits[0], id: "edit-1" }] }),
      ),
    ).toThrow();
    expect(() =>
      parseEditPlan(
        validEditPlan({ evidence: [{ ...validEvidence(), operationId: "unknown-operation" }] }),
      ),
    ).toThrow();
    expect(() =>
      parseEditPlan(
        validEditPlan({
          evidence: [validEvidence(), { ...validEvidence(), provider: "ripgrep" }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEditPlan(
        validEditPlan({ edits: [{ ...validEditPlan().edits[0], evidenceIds: ["unknown-evidence"] }] }),
      ),
    ).toThrow();
    expect(() =>
      parseEditPlan(
        validEditPlan({ edits: [{ ...validEditPlan().edits[0], byteRange: [18, 5] }] }),
      ),
    ).toThrow();
    expect(() =>
      parseEditPlan(
        validEditPlan({
          conflicts: [{ id: "conflict-1", editIds: ["edit-1", "unknown-edit"], reason: "partial-overlap" }],
        }),
      ),
    ).toThrow();
  });

  it("requires sorted unique nonempty edit operation provenance", () => {
    const twoOperationPlan = validPlan({
      operations: [validOperation(), { ...validOperation(), id: "rename-second" }],
    });
    const valid = validEditPlan({
      rewritePlan: twoOperationPlan,
      evidence: [validEvidence(), { ...validEvidence(), id: "evidence-2", operationId: "rename-second" }],
      edits: [{
        ...validEditPlan().edits[0],
        operationIds: ["rename-old-api", "rename-second"],
        evidenceIds: ["evidence-1", "evidence-2"],
      }],
    });
    expect(parseEditPlan(valid)).toBeTruthy();
    expect(() => parseEditPlan(validEditPlan({
      edits: [{ ...validEditPlan().edits[0], operationIds: [] }],
    }))).toThrow();
    expect(() => parseEditPlan(validEditPlan({
      edits: [{ ...validEditPlan().edits[0], operationIds: ["rename-old-api", "rename-old-api"] }],
    }))).toThrow();
    expect(() => parseEditPlan({
      ...valid,
      edits: [{ ...valid.edits[0], operationIds: ["rename-second", "rename-old-api"] }],
    })).toThrow();
    expect(() => parseEditPlan(validEditPlan({
      edits: [{ ...validEditPlan().edits[0], operationIds: ["unknown-operation"] }],
    }))).toThrow();
    expect(() => parseEditPlan(validEditPlan({
      edits: [{ ...validEditPlan().edits[0], operationIds: ["rename-old-api"], evidenceIds: ["evidence-1"] }],
      evidence: [{ ...validEvidence(), operationId: "unknown-operation" }],
    }))).toThrow();
  });

  it("keeps JSON Schema structural validation aligned with Zod and resolves canonical references", () => {
    const ajv = validator();
    const validateRewrite = ajv.getSchema("https://torafirma.dev/schemas/tfs-ripast/rewrite-plan/v1");
    const validateEdit = ajv.getSchema("https://torafirma.dev/schemas/tfs-ripast/edit-plan/v1");
    const validateTransaction = ajv.getSchema("https://torafirma.dev/schemas/tfs-ripast/transaction/v1");
    expect(validateRewrite).toBeDefined();
    expect(validateEdit).toBeDefined();
    expect(validateTransaction).toBeDefined();
    expect(validateEdit?.(validEditPlan())).toBe(true);
    expect(validateTransaction?.(validTransaction())).toBe(true);
    expect(() => parseTransactionRecord(validTransaction())).not.toThrow();

    for (const path of semanticFixtures.paths.safe) {
      expect(validateRewrite?.(validPlan({ operations: [{ ...validOperation(), paths: [path] }] }))).toBe(true);
      expect(() => parseRewritePlan(validPlan({ operations: [{ ...validOperation(), paths: [path] }]}))).not.toThrow();
    }
    for (const path of semanticFixtures.paths.unsafe) {
      expect(validateRewrite?.(validPlan({ operations: [{ ...validOperation(), paths: [path] }] }))).toBe(false);
      expect(() => parseRewritePlan(validPlan({ operations: [{ ...validOperation(), paths: [path] }]}))).toThrow();
    }

    expect(validateEdit?.(validEditPlan({ edits: [{ ...validEditPlan().edits[0], byteRange: [5] }] }))).toBe(false);
    expect(validateEdit?.(validEditPlan({ edits: [{ ...validEditPlan().edits[0], byteRange: [5, 18, 22] }] }))).toBe(false);
    expect(validateEdit?.(validEditPlan({ edits: [{ ...validEditPlan().edits[0], operationIds: [] }] }))).toBe(false);
    expect(validateEdit?.(validEditPlan({ edits: [{ ...validEditPlan().edits[0], operationIds: ["rename-old-api", "rename-old-api"] }] }))).toBe(false);
    expect(validateRewrite?.(validPlan({ validations: [{ type: "command", executable: "npm", args: ["test"] }] }))).toBe(false);
    expect(validateRewrite?.(validPlan({ operations: [{ ...validOperation(), expectedCount: {} }] }))).toBe(false);
  });

  it("records trusted explicit-command audits without allowing them in RewritePlan", () => {
    const ajv = validator();
    const validateTransaction = ajv.getSchema("https://torafirma.dev/schemas/tfs-ripast/transaction/v1");
    const explicitTransaction = validTransaction({
      validations: [explicitCommandValidationResult()],
    });
    expect(() => parseTransactionRecord(explicitTransaction)).not.toThrow();
    expect(validateTransaction?.(explicitTransaction)).toBe(true);
    expect(() =>
      parseTransactionRecord(
        validTransaction({
          validations: [{ ...explicitCommandValidationResult(), adapter: "npm-test" }],
        }),
      ),
    ).toThrow();
    expect(
      validateTransaction?.(
        validTransaction({
          validations: [{ ...explicitCommandValidationResult(), adapter: "npm-test" }],
        }),
      ),
    ).toBe(false);
    expect(() =>
      parseRewritePlan(
        validPlan({
          validations: [{ type: "command", executable: "node", args: ["check.mjs"] }],
        }),
      ),
    ).toThrow();
  });

  it("bounds persisted validation executable, argv, cwd, config, and output fields in both schema runtimes", () => {
    const validateTransaction = validator().getSchema("https://torafirma.dev/schemas/tfs-ripast/transaction/v1");
    const base = explicitCommandValidationResult();
    const invalid = [
      { ...base, executable: `/${"x".repeat(4_096)}` },
      { ...base, argv: ["x".repeat((16 * 1024) + 1)] },
      { ...base, argv: Array.from({ length: 257 }, () => "x") },
      { ...base, cwd: "x".repeat(4_097) },
      { ...base, actualCwd: `/${"x".repeat(4_096)}` },
      { ...base, configResolution: "x".repeat((16 * 1024) + 1) },
      { ...base, output: "x".repeat((1024 * 1024) + 1) },
    ];
    for (const validation of invalid) {
      const record = validTransaction({ validations: [validation] });
      expect(() => parseTransactionRecord(record)).toThrow();
      expect(validateTransaction?.(record)).toBe(false);
    }
  });

  it("requires before and after mode bits in both transaction schema runtimes", () => {
    const ajv = validator();
    const validateTransaction = ajv.getSchema("https://torafirma.dev/schemas/tfs-ripast/transaction/v1");
    const withoutBeforeMode = validTransaction({
      files: [{ path: "src/app.ts", beforeHash: "sha256:before", afterHash: "sha256:after", afterMode: 0o755 }],
    });
    const withoutAfterMode = validTransaction({
      files: [{ path: "src/app.ts", beforeHash: "sha256:before", afterHash: "sha256:after", beforeMode: 0o644 }],
    });
    const negativeMode = validTransaction({
      files: [{
        path: "src/app.ts",
        beforeHash: "sha256:before",
        afterHash: "sha256:after",
        beforeMode: -1,
        afterMode: 0o755,
      }],
    });

    expect(validateTransaction?.(validTransaction())).toBe(true);
    expect(() => parseTransactionRecord(validTransaction())).not.toThrow();
    for (const invalid of [withoutBeforeMode, withoutAfterMode, negativeMode]) {
      expect(validateTransaction?.(invalid)).toBe(false);
      expect(() => parseTransactionRecord(invalid)).toThrow();
    }
  });
});
