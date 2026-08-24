# TFS Ripast

**Safety-first command-line engine for repository-scale search and rewrites.**

Ripast combines literal and regular-expression discovery (ripgrep) with structural evidence (ast-grep), produces reviewable edit plans, enforces scope and validation gates, and records reversible transactions.

The short command `rpst` is the recommended entry point; `tfs-ripast` invokes the same CLI.

```sh
rpst --search oldName --replace newName src          # preview only
rpst apply plan.json --write                         # explicit mutation
rpst undo .tfs-ripast/transactions/TRANSACTION.json --write
```

---

## Designed for coding agents

Most coding agents treat the filesystem as a mutable bag of files. They generate a transform, run it, and hope. When the change is large or the tree is dirty the failure modes are partial writes, lost context, and no clean rollback.

Ripast gives agents a proper transaction boundary:

| Property | Behaviour |
|----------|-----------|
| **Default is non-mutating** | Non-interactive runs never write unless `--write` is present. |
| **Plans are not authority** | A serialized plan recommends validations and limits; it does not grant write or validation power. |
| **Explicit write gate** | `--write` is required to mutate source. Interactive terminals still preview and confirm. |
| **Containment** | Paths are canonicalized and confined to the repository. Symlink escapes and out-of-scope evidence are rejected. |
| **Immutable snapshots** | Input files are hashed (content + mode + newline style). Stale inputs fail before any source write. |
| **Atomic commit** | Prepare materializes exact before/after buffers. Commit uses sibling files, an advisory lock, and verified renames. |
| **Verified undo** | Undo re-checks that current hashes still match the committed after-state, then restores retained before-images. |
| **Bounded external processes** | Time, output size, and argument-vector limits; process groups are terminated on timeout. |

Agents can therefore treat a rewrite as a governed state transition rather than an irreversible side-effect.

---

## Status

**Version 0.1.0 — public preview.**

Dry-run behaviour, explicit write authority, transaction verification, and rollback are covered by the automated test suite. Review generated plans and keep a version-control checkpoint before applying large rewrites.

This is infrastructure, not a general-purpose pattern language. Pattern power comes from the underlying engines (`rg` and `ast-grep`). Ripast’s contribution is the safety and governance layer around them.

---

## Requirements

| Dependency | Purpose |
|------------|---------|
| **Node.js ≥ 24** | Runtime |
| **`rg` (ripgrep)** on `PATH` | Lexical discovery |
| **`ast-grep`** on `PATH` | Structural evidence (optional for pure lexical work) |
| **Git** | Git-aware scopes (`--changed-only`, `--staged`, `--since`, `--require-clean`) |
| **Python ≥ 3.11** | Only when compiling sandboxed Jinja plan templates |

---

## Install

```sh
git clone https://github.com/torakagemusha-sudo/tfs-ripast.git
cd tfs-ripast
npm ci
npm run build
npm link
```

Verify:

```sh
rpst --version
rpst --help
```

Optional Python companion (Jinja plan templates):

```sh
python -m pip install ./python
python -m tfs_ripast --version
```

---

## Quick start

### Ad-hoc rewrite (preview)

```sh
# Literal replacement, preview only
rpst --search oldName --replace newName src

# Regex, changed files only, machine-readable output
rpst --search 'old(\w+)' --replace 'new$1' src --regex --changed-only --json
```

### Plan → inspect → apply

```sh
# Resolve a rewrite plan and save the edit plan
rpst plan rewrite-plan.json --plan-out .tfs-ripast/plans/migration.json

# Inspect without writing
rpst inspect .tfs-ripast/plans/migration.json

# Apply with explicit write authority
rpst apply .tfs-ripast/plans/migration.json --write
```

### Verify and undo

```sh
rpst verify .tfs-ripast/transactions/TRANSACTION.json
rpst undo   .tfs-ripast/transactions/TRANSACTION.json          # preview
rpst undo   .tfs-ripast/transactions/TRANSACTION.json --write  # restore
```

`--dry-run` and `--write` are mutually exclusive. Non-interactive execution never mutates without `--write`.

---

## Core concepts

### 1. RewritePlan

A strict, versioned JSON document that declares:

- one or more operations (paths, search/replace, lexical mode, language policy, match expectations)
- global policy (max files / matches / changed bytes / repository percent, Git cleanliness, keep-on-failure)
- recommended validations (prettier, npm-test, typescript-typecheck)

Plans are data. They do not execute validations or grant write authority.

See [`schemas/rewrite-plan.schema.json`](schemas/rewrite-plan.schema.json).

### 2. Evidence and correlation

Ripast runs two providers:

- **ripgrep** — fast lexical / regex matches
- **ast-grep** — structural (AST) matches with captures and language awareness

Evidence is correlated into confirmed, lexical-only, structural-only, adjacent, conflicting, or unparseable classifications. Conflicts and invariant failures block transaction preparation.

### 3. EditPlan

The resolved, hash-addressed artifact produced from a RewritePlan + current tree:

- immutable input file snapshots (hash, mode, newline style, encoding)
- Git scope audit (worktree/index blob identities, cleanliness)
- correlated evidence and proposed edits
- diagnostics and conflicts

An EditPlan can be inspected, re-validated against a later tree, and only then committed.

### 4. Transaction

The mutation lifecycle:

1. **Prepare** — materialize exact before/after buffers under an opaque capability; no source files are touched.
2. **Commit** — acquire repository lock, write sibling before/after files, atomic rename, post-commit validation, persist transaction record.
3. **Verify** — check that current hashes still match the recorded after-state (or before-state after undo).
4. **Undo** — refuse if current content has diverged; restore retained before-images; record new state.

Transaction records live under `.tfs-ripast/transactions/` and contain before/after hashes, inverse patches, validation audits, and Git scope identity.

---

## Safety model

| Guarantee | Mechanism |
|-----------|-----------|
| Path containment | Repository-relative paths only; realpath + containment checks; reserved top-level names (`.git`, `.tfs-ripast`) rejected |
| Symlink rejection | Transaction targets and validation cwds may not be symlinks |
| Stale input detection | Content hash + mode + newline style + device/inode re-checked before every mutation stage |
| Conflict rejection | Overlapping or nested edits fail before preparation |
| Authority separation | Named validation adapters run only when the operator supplies `--check`; explicit commands require absolute, non-shell, non-shebang executables |
| Atomicity | Sibling files + exclusive create + rename; advisory lock serializes concurrent transactions |
| Rollback | Automatic on post-commit validation failure (unless `keepOnCheckFailure`); verified undo for committed transactions |
| Process bounds | Explicit timeout, max output bytes, argument-vector size; process-group termination |

Security reports should follow [`SECURITY.md`](SECURITY.md). Ripast is not an OS sandbox against a concurrent hostile local process; use exclusive workspaces or containers for untrusted repositories.

---

## Commands

| Command | Purpose |
|---------|---------|
| `rpst --search … --replace … [PATH]` | Ad-hoc rewrite (preview by default) |
| `rpst plan PLAN.json` | Resolve a RewritePlan into an EditPlan |
| `rpst inspect EDIT-PLAN.json` | Inspect a saved EditPlan |
| `rpst apply EDIT-PLAN.json` | Re-validate and (with `--write`) commit |
| `rpst verify TRANSACTION.json` | Verify current hashes against a transaction record |
| `rpst undo TRANSACTION.json` | Preview or (with `--write`) restore before-images |

Common options:

- `--json` — machine-readable single document on stdout
- `--plan-out PATH` — write the resolved EditPlan
- `--changed-only` / `--staged` / `--since COMMIT` / `--tracked-only` — Git scopes
- `--require-clean` — refuse dirty worktrees
- `--check prettier\|npm-test\|typescript-typecheck` — authorize named adapters
- `--validation-command '["/abs/path", "arg", …]'` — trusted absolute command (use only with trusted input)
- `--write` — explicit mutation authority
- `--dry-run` — force non-mutating (mutually exclusive with `--write`)

Full reference: build or read the [Sphinx documentation](docs/index.md).

---

## Rewrite plans and schemas

Three public schemas define the protocol:

- [`schemas/rewrite-plan.schema.json`](schemas/rewrite-plan.schema.json) — operator intent
- [`schemas/edit-plan.schema.json`](schemas/edit-plan.schema.json) — resolved, hash-addressed plan
- [`schemas/transaction.schema.json`](schemas/transaction.schema.json) — committed mutation record

Semantic invariants that JSON Schema cannot express (uniqueness, cross-references, ordered ranges, Git-scope consistency) are enforced by a named contract in `src/semantic.ts`.

Validation entries inside a plan are **recommendations only**. Authorize each named adapter with `--check` at plan or apply time. Explicit `--validation-command` values are executable authority and must be absolute paths to non-shell binaries.

---

## Python plan templates

The companion package compiles sandboxed Jinja templates into concrete RewritePlans.

- Restricted AST subset (no arbitrary calls, no arithmetic, no slicing, no recursive loops)
- Hard budgets on template size, data size, rendered size, and iteration count
- Only explicitly registered filters (`tojson`, `lower`, `upper`, `length`, `sort`, `dictsort`, `replace`, `join`)
- Final output is re-validated against the RewritePlan schema

```sh
python -m tfs_ripast compile template.j2 data.json > plan.json
```

See [`python/TEMPLATING.md`](python/TEMPLATING.md) for the full contract.

---

## Benchmarks

A deterministic self-test harness is included:

```sh
npm run benchmark:self-test
```

It uses a checked-in fake agent and synthetic fixtures. No network calls, no cloud models. Results land under `benchmark-results/`.

Real-agent runs require explicit acknowledgement flags (`--allow-unsandboxed-agent`, `--trust-agent-telemetry`) because the harness is not an OS sandbox. See [`benchmarks/README.md`](benchmarks/README.md) for the protocol and interpretation rules.

---

## Development

```sh
npm ci
npm test                # Vitest suite (CLI, transaction, providers, schema, …)
npm run typecheck
npm run build
npm run benchmark:self-test
```

Python:

```sh
python -m pip install './python[test]'
python -m pytest python/tests
```

Documentation:

```sh
npm run docs:check
npm run docs:build      # Sphinx HTML under docs/_build/html
```

CI (GitHub Actions) installs real `rg` and `ast-grep`, runs the full TypeScript + Python matrix, package inspection, and Sphinx build on every push and pull request.

---

## What Ripast is not

- **Not a replacement for ast-grep or jscodeshift.** Pattern expressiveness still comes from those engines.
- **Not a multi-repo orchestration platform.** Single-repository focus by design.
- **Not an OS sandbox.** Concurrent hostile processes that replace directories mid-transaction are outside the threat model; use exclusive workspaces or containers for untrusted trees.
- **Not an AI agent.** It is a tool that agents (or humans) can drive safely.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). By participating you agree to follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

---

## License

Apache-2.0. See [`LICENSE`](LICENSE).

---

*TFS Ripast is part of the Torafirma Systems work on governed machine mutation — persistent identity, bounded authority, and reversible state change.*
