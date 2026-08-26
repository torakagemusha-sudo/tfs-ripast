# TFS Ripast

TFS Ripast is a safety-first repository-scale search and rewrite engine. The
recommended command is `rpst`; `tfs-ripast` is an equivalent long-form alias.

```{toctree}
:maxdepth: 2
:caption: User guide

getting-started
commands
plans-and-schemas
safety-and-recovery
python-templates
benchmarks
troubleshooting
contributing
```

## Release status

Version 0.1.1 is a public preview. Non-interactive execution previews changes
and does not write unless `--write` is supplied. Review the plan and keep a
version-control checkpoint before applying repository-scale changes.

## Requirements

- Linux, macOS, or WSL (native Windows is unsupported)
- Node.js 24 or newer
- `rg` (ripgrep) on `PATH`
- `ast-grep` on `PATH` for structural operations
- Git for Git-aware scopes
- Python 3.11 or newer for the template compiler
