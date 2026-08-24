# Getting started

## Install from source

Run these commands from the repository root:

```sh
git clone https://github.com/torakagemusha-sudo/tfs-ripast.git
cd tfs-ripast
npm ci
npm run build
npm link
rpst --version
```

`npm link` installs both `rpst` and `tfs-ripast` aliases. Use `rpst` in normal
workflows.

## Preview a rewrite

```sh
rpst --search oldName --replace newName src
```

The default is a preview. Add `--json` for automation or `--changed-only` to
limit discovery to changed and visible untracked files:

```sh
rpst --search oldName --replace newName src --changed-only --json
```

## Save, inspect, and apply a plan

```sh
rpst plan rewrite-plan.json --plan-out .tfs-ripast/plans/migration.json
rpst inspect .tfs-ripast/plans/migration.json
rpst apply .tfs-ripast/plans/migration.json --write
```

All paths in plans are repository-relative. Ripast resolves them internally to
canonical paths before discovery and writing so that containment and symlink
checks remain enforceable.

## Python templates

Install the companion package after the Node CLI:

```sh
python -m pip install './python'
python -m tfs_ripast --version
```

See [Python templates](python-templates.md) for the supported Jinja subset and
resource limits.
