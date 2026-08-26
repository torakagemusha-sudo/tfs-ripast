# Command reference

All commands are available through `rpst` and `tfs-ripast`.

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
rpst plan rewrite-plan.json --plan-out .tfs-ripast/plans/migration.json
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
