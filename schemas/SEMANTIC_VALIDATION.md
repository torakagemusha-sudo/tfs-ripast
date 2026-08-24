# TFS Ripast semantic validation v1

Schema validation establishes the version-one JSON shape. Every consumer must
then run the named contract
`https://torafirma.dev/schemas/tfs-ripast/semantic-validation/v1` before it
uses a parsed protocol document. TypeScript exposes it through
`validateRewritePlanSemantics`, `validateEditPlanSemantics`, and
`validateTransactionRecordSemantics` in `src/semantic.ts`; non-TypeScript
consumers must faithfully mirror those checks.

The contract checks operation, evidence, edit, conflict, input-file, changed
path, and transaction-file uniqueness; operation/evidence/edit/conflict
reference resolution; operation alignment between evidence and edits; ordered
byte and line ranges; nonempty expected-count invariants with ordered bounds;
and transaction changed-path membership.

`semantic-validation-fixtures.json` is the shared fixture source for safe and
unsafe path cases and the cross-object failures that JSON Schema cannot express
portably. Schemas advertise the contract through their
`x-tfs-ripast-semantic-validation` field. JSON Schema does not suffice alone.
