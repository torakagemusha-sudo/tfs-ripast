# Contributing

Use Node.js 24 or newer and Python 3.11 or newer:

```sh
npm ci
npm test
npm run typecheck
npm run build
python -m pip install './python[test,docs]'
python -m pytest python/tests
python -m sphinx -W --keep-going -b html docs docs/_build/html
```

Keep source paths and plan examples repository-relative. Preserve dry-run and
explicit write authority. Add a regression test for behavior changes and keep
TypeScript/Python schema copies synchronized.

Before opening a pull request, run the complete checks above plus
`npm run benchmark:self-test` and `npm pack --dry-run`.

See [`CONTRIBUTING.md`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/CONTRIBUTING.md)
for project policy and [`CODE_OF_CONDUCT.md`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/CODE_OF_CONDUCT.md)
for community expectations.
