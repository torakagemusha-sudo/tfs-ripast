# Plans and schemas

Rewrite plans are versioned JSON documents. Their operations declare:

- repository-relative target paths and optional globs;
- literal, regular-expression, or structural search policy;
- replacement and capture behavior;
- match-count and changed-byte limits;
- Git scope requirements; and
- validation recommendations.

The JSON schemas are checked into the repository's `schemas/` directory:

- [`rewrite-plan.schema.json`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/schemas/rewrite-plan.schema.json)
- [`edit-plan.schema.json`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/schemas/edit-plan.schema.json)
- [`transaction.schema.json`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/schemas/transaction.schema.json)

JSON Schema validation is supplemented by semantic validation. Read
Read [`SEMANTIC_VALIDATION.md`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/schemas/SEMANTIC_VALIDATION.md)
before generating plans in another tool.

## Relative-path rule

Paths crossing the plan, edit-plan, and fixture boundaries are relative to the
selected repository or fixture root. Absolute paths, `..` segments, backslashes
where a portable plan path is expected, symlink escapes, Git metadata, and
`.tfs-ripast` state paths are rejected.

The implementation may use canonical absolute paths internally. Those values
are process-local safety state, not portable plan input.
