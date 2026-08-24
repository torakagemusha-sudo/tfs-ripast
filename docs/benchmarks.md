# Benchmarks

The benchmark harness compares end-to-end rewrite trials with and without
Ripast. It uses disposable fixture copies, crossover scheduling, monotonic
timing, bounded process trees, declarative acceptance assertions, and raw JSON
records suitable for recomputation.

## Self-test

```sh
npm run benchmark:self-test
```

The self-test uses a deterministic checked-in agent and makes no network calls.

## Real-agent runs

```sh
npm run build
npm run benchmark -- \
  --manifest benchmarks/experiment.json \
  --agent-command '["local-agent","--non-interactive"]' \
  --allow-unsandboxed-agent \
  --trust-agent-telemetry \
  --ripast-artifact dist/cli.js \
  --output benchmark-results/run-001
```

These acknowledgement flags are required because the harness bounds runtime
but is not an OS sandbox. The configured agent retains the invoking user's
filesystem and network authority. Use a VM or container without credentials for
untrusted agents.

The full protocol and interpretation rules are in
[`benchmarks/README.md`](https://github.com/torakagemusha-sudo/tfs-ripast/blob/main/benchmarks/README.md).
Do not publish comparative claims until all crossover cells of a pinned
workload pass correctness gates.
