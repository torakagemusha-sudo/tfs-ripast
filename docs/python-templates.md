# Python templates

The Python package compiles a bounded Jinja template into one concrete JSON
rewrite plan. It never reads or writes target source files; the TypeScript CLI
retains rewrite, validation, approval, and transaction authority.

Install and invoke it with repository-relative inputs:

```sh
python -m pip install './python'
python -m tfs_ripast plan migration.json.j2 --data migration-data.json --json --dry-run
```

The package also exposes `rpst` and `tfs-ripast` console entry points for
delegation to the TypeScript CLI.

## Supported subset

Templates may use JSON literals, direct data values, `if`, non-recursive
`for`, loop metadata, boolean truthiness, conditional expressions, and the
bounded filters `tojson`, `lower`, `upper`, `replace`, `join`, `length`,
`sort`, and `dictsort`.

Function/macro calls, imports/includes, unrestricted attribute access,
assignments, comparisons, membership, slicing, concatenation, arithmetic, and
recursive loops are rejected.

## Resource limits

Defaults are 256 KiB template UTF-8, 1 MiB JSON data, 1 MiB rendered JSON,
4,096 template AST nodes, and 100,000 execution units. Public overrides remain
below hard ceilings of 1 MiB template, 8 MiB data/rendered JSON, and 1,000,000
execution units.

The full contract is maintained in [`python/TEMPLATING.md`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/python/TEMPLATING.md).
