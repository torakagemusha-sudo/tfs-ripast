# TFS Ripast Python companion

The Python package compiles sandboxed Jinja templates into strict TFS Ripast rewrite plans and launches the canonical TypeScript CLI. Install the Node CLI first, then install this package.

```sh
python -m pip install .
tfs-ripast-py --version
```

`tfs-ripast-py` compiles templates and delegates to the installed Node CLI.
The `rpst` and `tfs-ripast` command names remain reserved for that Node CLI.

See [`TEMPLATING.md`](TEMPLATING.md) for the template contract and the repository root README for the complete CLI workflow.
