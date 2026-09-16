# Command reference

Use `rpst` as the command voice. `tfs-ripast` is the same binary under a longer alias.

## Common options

| Option | Purpose |
| --- | --- |
| `--search TEXT` | Literal search text for an ad-hoc rewrite |
| `--replace TEXT` | Replacement text for an ad-hoc rewrite |
| `--regex` | Interpret `--search` as a regular expression |
| `--lang LANGUAGE` | Add an ast-grep language candidate |
| `--glob GLOB` | Restrict candidate paths; repeatable |
| `--tracked-only` | Consider tracked files only |
| `--changed-only` | Consider changed and visible untracked files |
| `--staged` | Consider staged files only |
| `--since COMMIT` | Consider files changed since a commit |
| `--require-clean` | Require a clean Git worktree |
| `--check ADAPTER` | Explicitly authorize a named validation adapter |
| `--plan-out PATH` | Save a resolved edit plan |
| `--json` | Emit one machine-readable JSON document |
| `--dry-run` | Never write source files |
| `--write` | Apply after validation without an interactive prompt |
| `-- PATH ...` | End option parsing and supply one or more ad-hoc paths |

`--dry-run` and `--write` are mutually exclusive. Dry-run behavior is the
default for non-interactive execution. Ad-hoc path operands must follow the
literal `--` separator. Ad-hoc write, plan-output, and validation options also
must precede `--search`/`--replace` and require that separator, including a
trailing `--` when the default `.` path is intended. Programs that forward path
input must add the separator themselves; a separator received as path input is
not an authority boundary.

## `plan`

Resolve a strict rewrite plan into an edit plan:

```sh
rpst plan examples/rewrite-plan.example.json --plan-out .tfs-ripast/plans/migration.json
```

Validation entries serialized in a plan are recommendations. A named adapter
is executable only when the operator supplies its matching `--check` option.

## `inspect`

Read a saved edit plan without changing source files:

```sh
rpst inspect .tfs-ripast/plans/migration.json
```

## `apply`

Revalidate a saved edit plan. Add `--write` to commit its transaction:

```sh
rpst apply .tfs-ripast/plans/migration.json --write
```

## `verify`

Check the hashes recorded by a committed transaction:

```sh
rpst verify .tfs-ripast/transactions/TRANSACTION.json
```

## `undo`

Preview a safe inverse, then explicitly apply it:

```sh
rpst undo .tfs-ripast/transactions/TRANSACTION.json
rpst undo .tfs-ripast/transactions/TRANSACTION.json --write
```

Undo refuses to overwrite files whose current hashes no longer match the
transaction record.

## `repair`

Recover a partial-commit transaction from the retained before-images. Preview
the assisted rollback, then explicitly apply it:

```sh
rpst repair .tfs-ripast/transactions/TRANSACTION.json
rpst repair .tfs-ripast/transactions/TRANSACTION.json --write
```

Each file left mid-commit is classified as already matching its before-image,
already matching its after-image, or blocked because it matches neither. A
single blocked file prevents any restoration. With `--write`, the transaction
record is updated to `rolled-back` once every restored file verifies. Add
`--json` for the full classification report.

## `gc`

Prune retained before-images that can no longer serve an undo:

```sh
rpst gc
rpst gc --write
rpst gc --write --include-undoable --older-than 30
rpst gc --write --remove-records
```

Before-images of transactions that can never be undone (`rolled-back`,
`undone`, `failed`) are prunable by default. Before-images of `committed`
transactions are still undoable and require `--include-undoable`, optionally
limited with `--older-than DAYS`. A `partial-commit` transaction is never
pruned; repair it first. Transaction JSON records are kept unless
`--remove-records` is passed. Add `--json` for the full per-transaction
report.
