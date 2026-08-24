# Troubleshooting

## `rg` or `ast-grep` is missing

Install the required tool and ensure its executable directory is on `PATH`:

```sh
rg --version
ast-grep --version
```

Lexical operations require ripgrep. Structural operations and syntax checks
require ast-grep.

## The command previews instead of writing

This is expected. Add `--write` after reviewing the preview. Do not combine
`--write` with `--dry-run`.

## A validation did not run

Plan recommendations are inert until explicitly authorized:

```sh
rpst plan rewrite-plan.json --check prettier
```

For a custom executable, use an explicit trusted `--validation-command`.

## A transaction refuses to undo

Run `rpst verify` and inspect the current hashes. Ripast refuses to overwrite
files changed after the original transaction. Restore or review the intervening
change before retrying.

## A path is rejected

Use a repository-relative path without `..`, a leading `/`, a drive prefix, or
a symlink escape. Do not target `.git` or `.tfs-ripast`.
