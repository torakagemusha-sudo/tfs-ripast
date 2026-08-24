/** Language identifiers accepted by ast-grep in version one. */
export type AstGrepLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "swift"
  | "kotlin"
  | "scala"
  | "html"
  | "css"
  | "json"
  | "yaml";

export interface LanguageOverride {
  glob: string;
  language: AstGrepLanguage;
}

export interface LanguageDecision {
  language: AstGrepLanguage | undefined;
  source: "extension" | "override" | "ambiguous" | "unsupported";
}

export type LexicalMode =
  | { type: "literal" }
  | { type: "regex"; flags?: string };

export interface ExpectedCount {
  exact?: number;
  min?: number;
  max?: number;
}

export interface MatchPolicy {
  require?: "eligible" | "confirmed" | "structural" | "lexical";
  onUnparseable?: "allow" | "skip" | "error";
}

export interface ConflictPolicy {
  onConflict?: "reject";
}

export interface RewriteOperation {
  id: string;
  paths: string[];
  search: string;
  replace: string;
  lexical: LexicalMode;
  languages?: AstGrepLanguage[];
  languageOverrides?: LanguageOverride[];
  globs?: string[];
  matchPolicy?: MatchPolicy;
  expectedCount?: ExpectedCount;
  conflictPolicy?: ConflictPolicy;
}

export interface RewritePolicy {
  maxFiles?: number;
  maxMatches?: number;
  maxChangedBytes?: number;
  maxRepositoryPercent?: number;
  respectGitIgnore?: boolean;
  requireClean?: boolean;
  keepOnCheckFailure?: boolean;
}

export type ValidationSpec =
  | {
      type: "prettier";
      paths?: string[];
      cwd?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    }
  | {
      type: "npm-test";
      cwd?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    }
  | {
      type: "typescript-typecheck";
      cwd?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
    };

/** A trusted runtime-only argv request. It is deliberately not serializable in RewritePlan. */
export interface TrustedValidationCommand {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RewritePlan {
  version: 1;
  name: string;
  root: string;
  operations: RewriteOperation[];
  policy: RewritePolicy;
  validations: ValidationSpec[];
}

export type ProviderName = "ripgrep" | "ast-grep" | (string & {});
export type CaptureMap = Record<string, string>;

export interface MatchEvidence {
  id: string;
  operationId: string;
  provider: ProviderName;
  file: string;
  byteRange: [number, number];
  lineRange: [number, number];
  matchedTextHash: string;
  language?: AstGrepLanguage;
  languageSource: LanguageDecision["source"];
  captures?: CaptureMap;
  confidence: "lexical" | "structural" | "semantic";
}

export interface Edit {
  id: string;
  operationIds: string[];
  file: string;
  byteRange: [number, number];
  replacement: string;
  evidenceIds: string[];
}

export interface FileInput {
  path: string;
  hash: string;
  byteLength: number;
  mode: number;
  newline: "lf" | "crlf" | "mixed" | "none";
  encoding: "utf-8" | "binary" | "other";
}

export interface GitInputIdentity {
  path: string;
  worktreeBlob: string;
  indexBlob?: string;
}

/** Immutable audit of the Git authority used to derive an EditPlan. */
export interface GitScopeAudit {
  repository: boolean;
  root: string;
  repositoryRoot?: string;
  head?: string;
  sinceCommit?: string;
  dirty: boolean;
  mode: "all" | "tracked" | "changed" | "staged" | "since";
  requireClean: boolean;
  inputs: GitInputIdentity[];
}

export interface Conflict {
  id: string;
  editIds: string[];
  reason: "same-range" | "partial-overlap" | "nested-overlap";
}

export interface Diagnostic {
  code: string;
  message: string;
  provider?: ProviderName;
  operationId?: string;
  language?: AstGrepLanguage;
  paths: string[];
}

export interface EditPlan {
  version: 1;
  id: string;
  rewritePlan: RewritePlan;
  rewritePlanHash: string;
  gitScope: GitScopeAudit;
  inputFiles: FileInput[];
  evidence: MatchEvidence[];
  edits: Edit[];
  conflicts: Conflict[];
  diagnostics: Diagnostic[];
  providerVersions: Record<string, string>;
  createdAt: string;
}

export type ValidationAdapter = ValidationSpec["type"] | "ast-grep-syntax" | "transaction-integrity";

interface ValidationAuditBase {
  executable: string;
  argv: string[];
  cwd: string;
  actualCwd: string;
  timeoutMs: number;
  stage: "precommit" | "postcommit";
  rollbackPolicy: "not-applicable" | "rollback-on-failure" | "keep-on-failure";
  configResolution?: string;
  timedOut: boolean;
  truncated: boolean;
  status: "passed" | "failed" | "timed-out" | "spawn-error" | "unsupported";
  exitCode: number | null;
  output: string;
}

/** An inert record of a validation invocation; it never grants plan execution authority. */
export type ValidationResult =
  | (ValidationAuditBase & {
      source: "named-adapter";
      adapter: ValidationAdapter;
    })
  | (ValidationAuditBase & {
      source: "explicit-command";
    });

export interface TransactionFile {
  path: string;
  beforeHash: string;
  afterHash: string;
  beforeMode: number;
  afterMode: number;
}

export interface TransactionRecord {
  version: 1;
  id: string;
  editPlanHash: string;
  gitScope: GitScopeAudit;
  validationPolicy: {
    keepOnCheckFailure: boolean;
    rollbackPolicy: "rollback-on-failure" | "keep-on-failure";
    authority: "default" | "plan" | "cli-override" | "runtime-override";
  };
  changedPaths: string[];
  files: TransactionFile[];
  validations: ValidationResult[];
  inversePatch: string;
  startedAt: string;
  completedAt?: string;
  state: "prepared" | "committed" | "rolled-back" | "partial-commit" | "undone" | "failed";
}
