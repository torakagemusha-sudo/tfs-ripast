# Safety and recovery

Ripast separates discovery, planning, validation, approval, and transaction
writing. The normal path is read-only until `--write` is present.

## Containment

Repository-relative paths are canonicalized and checked against the selected
root. Symlink targets and provider evidence outside authorized paths are
rejected. `.git` and `.tfs-ripast` are reserved from rewrite scopes.

## Validation

Named adapters from a serialized plan do not execute automatically. Authorize
each one with `--check ADAPTER`. Explicit `--validation-command` values are
executable authority and should only be used with trusted plans. External
processes have bounded time and output limits and are terminated as process
groups.

## Transactions

Writes use an advisory lock, before/after hashes, bounded transaction records,
post-commit integrity checks, and rollback on failed authoritative checks.
Transaction state is kept under `.tfs-ripast/`, which is reserved and ignored by
default.

## Verify and undo

After a write, verify the transaction:

```sh
rpst verify .tfs-ripast/transactions/TRANSACTION.json
```

Undo first previews the inverse. Applying the inverse requires `--write` and
fails closed if a current file hash differs from the transaction record.

## Trust boundary

Ripast is not an operating-system sandbox for a hostile process concurrently
modifying the same repository. Use an isolated workspace, container, or VM for
untrusted repositories and agents. See [`SECURITY.md`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/SECURITY.md)
for vulnerability reporting.
