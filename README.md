# TFS Ripast

TFS Ripast is a safety-first command-line engine for repository-scale search and rewrites. It combines literal and regular-expression discovery with ast-grep structural evidence, produces reviewable edit plans, enforces scope and validation gates, and records reversible transactions.

The short command `rpst` is the recommended entry point; `tfs-ripast` invokes the same CLI.

## Status

Version `0.1.0` is a public preview. Dry-run behavior, explicit write authority, transaction verification, and rollback are covered by the automated test suite. Review generated plans and use version control before applying large rewrites.

## Requirements

- Node.js 24 or newer
- `rg` (ripgrep) on `PATH`
- `ast-grep` on `PATH` for structural operations
- Git for Git-aware scopes
- Python 3.11 or newer only when using Jinja plan templates

## Install from source

```sh
git clone https://github.com/torakagemusha-sudo/tfs-ripast.git
cd tfs-ripast
npm ci
npm run build
npm link
```

Verify the install:

```sh
rpst --version
rpst --help
```

For Python plan templates, install the companion package:

```sh
python -m pip install ./python
python -m tfs_ripast --version
```

## Quick start

Preview a literal rewrite without modifying files:

```sh
rpst --search oldName --replace newName src
```

Restrict discovery to changed files and emit machine-readable output:

```sh
rpst --search oldName --replace newName src --changed-only --json
```

Save a resolved plan, inspect it, and explicitly apply it:

```sh
rpst plan rewrite-plan.json --plan-out .tfs-ripast/plans/migration.json
rpst inspect .tfs-ripast/plans/migration.json
rpst apply .tfs-ripast/plans/migration.json --write
```

Verify or undo a committed transaction:

```sh
rpst verify .tfs-ripast/transactions/TRANSACTION.json
rpst undo .tfs-ripast/transactions/TRANSACTION.json
rpst undo .tfs-ripast/transactions/TRANSACTION.json --write
```

Non-interactive execution does not write unless `--write` is present. Interactive terminals preview first and ask for confirmation. `--dry-run` and `--write` are mutually exclusive.

## Rewrite plans

Plans are strict versioned JSON documents. Operations declare paths, search/replace behavior, lexical and structural policy, match expectations, global limits, and validation commands. See:

Validation entries in a serialized plan are recommendations, not execution
authority. Authorize each named adapter separately with `--check ADAPTER` when
running `plan` or `apply`. Explicit `--validation-command` values execute a
command and should only be used with trusted input.

- [`schemas/rewrite-plan.schema.json`](schemas/rewrite-plan.schema.json)
- [`schemas/edit-plan.schema.json`](schemas/edit-plan.schema.json)
- [`schemas/transaction.schema.json`](schemas/transaction.schema.json)

Python users can compile sandboxed Jinja templates into concrete plans. See [`python/TEMPLATING.md`](python/TEMPLATING.md).

For the complete command reference, safety model, Python contract, benchmarks,
and contributor workflow, build or read the [Sphinx documentation](docs/index.md).

## Safety model

- Repository-relative paths are canonicalized and contained.
- Symlink escapes and provider evidence outside authorized paths are rejected.
- Git scopes record worktree and index identities and can require a clean tree.
- Conflicting edits and stale inputs fail before source mutation.
- Writes use bounded transaction records, advisory locking, validation, and rollback.
- Undo verifies current hashes and previews the authoritative inverse before writing.
- External processes have explicit time and output bounds and are terminated as process groups.

Security reports should follow [`SECURITY.md`](SECURITY.md).

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Python validation:

```sh
python -m pip install './python[test]'
python -m pytest python/tests
```

The deterministic benchmark self-test is available with `npm run benchmark:self-test`. The benchmark protocol and real-agent requirements are documented in [`benchmarks/README.md`](benchmarks/README.md).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). By participating, you agree to follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

MIT. See [`LICENSE`](LICENSE).
