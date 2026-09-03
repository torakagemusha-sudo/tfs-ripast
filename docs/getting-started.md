# Getting started

The recommended command is `rpst`. `tfs-ripast` is the same CLI under a longer alias.

## Install from source (recommended)

Run these commands from the repository root:

```sh
git clone https://github.com/torakagemusha-sudo/tfs-ripast.git
cd tfs-ripast
npm ci
scripts/install-local.sh --prefix "$HOME/.local"
rpst --version
```

The installer writes both `rpst` and `tfs-ripast` under `$HOME/.local/bin`. Use
`rpst` in normal workflows. Ensure that directory is on `PATH`.

### Alternative: `npm link`

If you prefer a Node-global link instead of the prefix installer:

```sh
npm ci
npm run build
npm link
rpst --version
```

Keep one recipe. Do not mix `npm link` and `install-local.sh` in the same shell
without understanding which binary `PATH` will resolve first.

## Preview a rewrite

```sh
rpst --search oldName --replace newName -- src
```

The default is a preview. Add `--json` for automation or `--changed-only` to
limit discovery to changed and visible untracked files:

```sh
rpst --search oldName --replace newName --changed-only --json -- src
```

## Save, inspect, and apply a plan

A complete, schema-valid RewritePlan lives at
[`examples/rewrite-plan.example.json`](../examples/rewrite-plan.example.json).
Copy it, edit the search and paths, then:

```sh
rpst plan examples/rewrite-plan.example.json --plan-out .tfs-ripast/plans/migration.json
rpst inspect .tfs-ripast/plans/migration.json
rpst apply .tfs-ripast/plans/migration.json --write
```

All paths in plans are repository-relative. Ripast resolves them internally to
canonical paths before discovery and writing so that containment and symlink
checks remain enforceable.

Validation entries inside the plan are recommendations only. Authorize a named
adapter with `--check` at plan or apply time if you want it to run.

## Python templates

Install the companion package after the Node CLI:

```sh
python -m pip install './python'
python -m tfs_ripast --version
```

See [Python templates](python-templates.md) for the supported Jinja subset and
resource limits.
