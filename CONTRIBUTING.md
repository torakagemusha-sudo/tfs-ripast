# Contributing

Thank you for helping improve TFS Ripast.

## Development setup

Use Node.js 24 or newer, then run:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

For Python changes:

```sh
python -m pip install './python[test]'
python -m pytest python/tests
```

## Changes

- Keep edits focused and preserve the dry-run and explicit-authority defaults.
- Add tests for new behavior and regressions.
- Do not weaken path containment, bounded-process, validation, transaction, or rollback checks.
- Update schemas and both TypeScript/Python copies together when protocol formats change.
- Run the complete validation suite before submitting a pull request.

Use clear commit messages and explain user-visible behavior, safety impact, and validation evidence in pull requests.

Security vulnerabilities must be reported privately as described in [`SECURITY.md`](SECURITY.md), not in public issues.

