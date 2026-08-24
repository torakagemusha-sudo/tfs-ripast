import { z } from "zod";
import {
  validateEditPlanSemantics,
  validateRewritePlanSemantics,
  validateTransactionRecordSemantics,
} from "./semantic.js";
import type { EditPlan, RewritePlan, TransactionRecord } from "./types.js";

const nonblank = z.string().refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});
const boundedNonblank = (maximum: number) => z.string().max(maximum).refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});
const nonnegativeInteger = z.number().int().nonnegative();
const gitObjectId = z.string().regex(/^[0-9a-f]{40,64}$/u);
const repositoryRelativePath = z.string().max(4 * 1024).refine((value) => value.trim().length > 0, {
  message: "must not be blank",
}).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.split("/").includes("..") &&
    !/[\\\u0000-\u001f]/.test(value),
  { message: "must be a repository-relative POSIX path" },
);
const astGrepLanguage = z.enum([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "swift",
  "kotlin",
  "scala",
  "html",
  "css",
  "json",
  "yaml",
]);

const replacementTemplate = z.string().superRefine((value, context) => {
  for (let offset = value.indexOf("${"); offset !== -1; ) {
    const remaining = value.slice(offset);
    const match = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(remaining);
    if (match === null) {
      context.addIssue({
        code: "custom",
        message: "capture references must use ${NAME} syntax",
      });
      return;
    }
    offset = value.indexOf("${", offset + match[0].length);
  }
});

export const lexicalModeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("literal") }).strict(),
  z.object({ type: z.literal("regex"), flags: z.string().optional() }).strict(),
]);

export const languageOverrideSchema = z
  .object({ glob: nonblank, language: astGrepLanguage })
  .strict();

const expectedCountSchema = z
  .object({
    exact: nonnegativeInteger.optional(),
    min: nonnegativeInteger.optional(),
    max: nonnegativeInteger.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "expectedCount must not be empty" });
    }
    if (value.exact !== undefined && (value.min !== undefined || value.max !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "exact cannot be combined with min or max",
      });
    }
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      context.addIssue({ code: "custom", message: "min cannot exceed max" });
    }
  });

const rewriteOperationSchema = z
  .object({
    id: nonblank,
    paths: z.array(repositoryRelativePath).min(1),
    search: nonblank,
    replace: replacementTemplate,
    lexical: lexicalModeSchema,
    languages: z.array(astGrepLanguage).min(1).optional(),
    languageOverrides: z.array(languageOverrideSchema).optional(),
    globs: z.array(nonblank).optional(),
    matchPolicy: z
      .object({
        require: z.enum(["eligible", "confirmed", "structural", "lexical"]).optional(),
        onUnparseable: z.enum(["allow", "skip", "error"]).optional(),
      })
      .strict()
      .optional(),
    expectedCount: expectedCountSchema.optional(),
    conflictPolicy: z.object({ onConflict: z.literal("reject").optional() }).strict().optional(),
  })
  .strict();

const rewritePolicySchema = z
  .object({
    maxFiles: nonnegativeInteger.optional(),
    maxMatches: nonnegativeInteger.optional(),
    maxChangedBytes: nonnegativeInteger.optional(),
    maxRepositoryPercent: z.number().min(0).max(100).optional(),
    respectGitIgnore: z.boolean().optional(),
    requireClean: z.boolean().optional(),
    keepOnCheckFailure: z.boolean().optional(),
  })
  .strict();

const validationCommon = {
  cwd: repositoryRelativePath.optional(),
  timeoutMs: nonnegativeInteger.optional(),
  maxOutputBytes: nonnegativeInteger.max(1024 * 1024).optional(),
};

export const validationSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prettier"), paths: z.array(repositoryRelativePath).min(1).optional(), ...validationCommon }).strict(),
  z.object({ type: z.literal("npm-test"), ...validationCommon }).strict(),
  z.object({ type: z.literal("typescript-typecheck"), ...validationCommon }).strict(),
]);

export const rewritePlanSchema = z
  .object({
    version: z.literal(1),
    name: nonblank,
    root: nonblank,
    operations: z.array(rewriteOperationSchema),
    policy: rewritePolicySchema,
    validations: z.array(validationSpecSchema),
  })
  .strict()
  .superRefine((plan, context) => {
    try {
      validateRewritePlanSemantics(plan as RewritePlan);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid rewrite plan semantics",
      });
    }
  });

const nonnegativeRangeSchema = z
  .tuple([nonnegativeInteger, nonnegativeInteger])
  .superRefine((range, context) => {
    if (range[0] > range[1]) {
      context.addIssue({ code: "custom", message: "range start must not exceed end" });
    }
  });

const matchEvidenceSchema = z
  .object({
    id: nonblank,
    operationId: nonblank,
    provider: nonblank,
    file: repositoryRelativePath,
    byteRange: nonnegativeRangeSchema,
    lineRange: nonnegativeRangeSchema,
    matchedTextHash: nonblank,
    language: astGrepLanguage.optional(),
    languageSource: z.enum(["extension", "override", "ambiguous", "unsupported"]),
    captures: z.record(z.string(), z.string()).optional(),
    confidence: z.enum(["lexical", "structural", "semantic"]),
  })
  .strict();

const editSchema = z
  .object({
    id: nonblank,
    operationIds: z.array(nonblank).min(1),
    file: repositoryRelativePath,
    byteRange: nonnegativeRangeSchema,
    replacement: z.string(),
    evidenceIds: z.array(nonblank),
  })
  .strict();

const fileInputSchema = z
  .object({
    path: repositoryRelativePath,
    hash: nonblank,
    byteLength: nonnegativeInteger,
    mode: nonnegativeInteger,
    newline: z.enum(["lf", "crlf", "mixed", "none"]),
    encoding: z.enum(["utf-8", "binary", "other"]),
  })
  .strict();

const conflictSchema = z
  .object({
    id: nonblank,
    editIds: z.array(nonblank).min(2),
    reason: z.enum(["same-range", "partial-overlap", "nested-overlap"]),
  })
  .strict();

const diagnosticSchema = z
  .object({
    code: nonblank,
    message: nonblank,
    provider: nonblank.optional(),
    operationId: nonblank.optional(),
    language: astGrepLanguage.optional(),
    paths: z.array(repositoryRelativePath),
  })
  .strict();

const gitScopeAuditSchema = z.object({
  repository: z.boolean(),
  root: nonblank,
  repositoryRoot: nonblank.optional(),
  head: gitObjectId.optional(),
  sinceCommit: gitObjectId.optional(),
  dirty: z.boolean(),
  mode: z.enum(["all", "tracked", "changed", "staged", "since"]),
  requireClean: z.boolean(),
  inputs: z.array(z.object({
    path: repositoryRelativePath,
    worktreeBlob: gitObjectId,
    indexBlob: gitObjectId.optional(),
  }).strict()),
}).strict().superRefine((scope, context) => {
  if (scope.repository && scope.repositoryRoot === undefined) {
    context.addIssue({ code: "custom", message: "repository Git scope requires repositoryRoot" });
  }
  if (!scope.repository && (scope.repositoryRoot !== undefined || scope.head !== undefined || scope.sinceCommit !== undefined || scope.inputs.length > 0 || scope.requireClean)) {
    context.addIssue({ code: "custom", message: "non-repository Git scope cannot contain repository provenance" });
  }
  if ((scope.mode === "since") !== (scope.sinceCommit !== undefined)) {
    context.addIssue({ code: "custom", message: "since Git scope requires exactly one resolved sinceCommit" });
  }
});

export const editPlanSchema = z
  .object({
    version: z.literal(1),
    id: nonblank,
    rewritePlan: rewritePlanSchema,
    rewritePlanHash: nonblank,
    gitScope: gitScopeAuditSchema,
    inputFiles: z.array(fileInputSchema),
    evidence: z.array(matchEvidenceSchema),
    edits: z.array(editSchema),
    conflicts: z.array(conflictSchema),
    diagnostics: z.array(diagnosticSchema),
    providerVersions: z.record(z.string(), z.string()),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((editPlan, context) => {
    try {
      validateEditPlanSemantics(editPlan as EditPlan);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid edit plan semantics",
      });
    }
  });

const validationAuditCommon = {
  executable: boundedNonblank(4 * 1024),
  argv: z.array(z.string().max(16 * 1024)).max(256),
  cwd: repositoryRelativePath,
  actualCwd: boundedNonblank(4 * 1024),
  timeoutMs: nonnegativeInteger,
  stage: z.enum(["precommit", "postcommit"]),
  rollbackPolicy: z.enum(["not-applicable", "rollback-on-failure", "keep-on-failure"]),
  configResolution: z.string().max(16 * 1024).optional(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  status: z.enum(["passed", "failed", "timed-out", "spawn-error", "unsupported"]),
  exitCode: z.number().int().nullable(),
  output: z.string().max(1024 * 1024),
};

const validationResultSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("named-adapter"),
      adapter: z.enum(["prettier", "npm-test", "typescript-typecheck", "ast-grep-syntax", "transaction-integrity"]),
      ...validationAuditCommon,
    })
    .strict(),
  z.object({ source: z.literal("explicit-command"), ...validationAuditCommon }).strict(),
]);

export const transactionRecordSchema = z
  .object({
    version: z.literal(1),
    id: nonblank,
    editPlanHash: nonblank,
    gitScope: gitScopeAuditSchema,
    validationPolicy: z.object({
      keepOnCheckFailure: z.boolean(),
      rollbackPolicy: z.enum(["rollback-on-failure", "keep-on-failure"]),
      authority: z.enum(["default", "plan", "cli-override", "runtime-override"]),
    }).strict(),
    changedPaths: z.array(repositoryRelativePath),
    files: z
      .array(
        z
          .object({
            path: repositoryRelativePath,
            beforeHash: nonblank,
            afterHash: nonblank,
            beforeMode: nonnegativeInteger.max(0o7777),
            afterMode: nonnegativeInteger.max(0o7777),
          })
          .strict(),
      ),
    validations: z.array(validationResultSchema),
    inversePatch: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    state: z.enum(["prepared", "committed", "rolled-back", "partial-commit", "undone", "failed"]),
  })
  .strict()
  .superRefine((record, context) => {
    try {
      validateTransactionRecordSemantics(record as TransactionRecord);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid transaction semantics",
      });
    }
  });

/** Parses only the strict, version-one public rewrite-plan protocol. */
export function parseRewritePlan(value: unknown): RewritePlan {
  return rewritePlanSchema.parse(value) as RewritePlan;
}

/** Parses a strict persisted edit plan and runs the named semantic contract. */
export function parseEditPlan(value: unknown): EditPlan {
  return editPlanSchema.parse(value) as EditPlan;
}

/** Parses a strict persisted transaction record and runs the named semantic contract. */
export function parseTransactionRecord(value: unknown): TransactionRecord {
  return transactionRecordSchema.parse(value) as TransactionRecord;
}
