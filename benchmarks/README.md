# Agent rewrite benchmarks

This harness compares end-to-end rewrite trials with and without Ripast. It runs every trial in a disposable fixture copy, measures the agent process with a monotonic clock, records harness-owned command events, runs fixture acceptance checks, and writes raw JSON plus a Markdown summary.

## Local self-test

```sh
npm run benchmark:self-test
```

The self-test uses a checked-in deterministic fake agent and the paired synthetic textual-migration fixtures. It makes no network requests and does not invoke a cloud model. Results are written beneath `benchmark-results/self-test/`.

## Real agent runs

Build Ripast, then pass the experiment manifest and an agent command encoded as a JSON string array:

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

The agent command starts in the disposable fixture root. It receives:

- `TFS_BENCH_PROMPT`: absolute path to the task prompt.
- `TFS_RIPAST_MODE`: `normal` or `ripast`.
- `TFS_RIPAST_BIN`: the pinned Ripast artifact path in Ripast mode only.

Normal mode prepends rejecting `tfs-ripast` and `rpst` launchers to `PATH` and does not expose `TFS_RIPAST_BIN`.

The acknowledgement flags are deliberate: the harness bounds runtime and
captures output, but it is not an OS sandbox. The configured agent runs with
the current user's filesystem and network authority. Run untrusted agents in a
VM or container with an isolated home, no credentials, and restricted network.

## Command-event contract

The agent adapter writes one line to stdout for every top-level tool invocation:

```text
TFS_BENCH_EVENT {"sequence":1,"tool":"shell","status":"ok","startedNs":"123","endedNs":"456"}
```

Events must be contiguous starting at one. `startedNs` and `endedNs` are decimal monotonic timestamps supplied by the adapter. Optional bounded/redacted arguments may be included as `arguments`. Internal subprocesses do not emit events. The harness validates the format but cannot independently prove adapter-reported counts or timestamps, so use a trusted, version-pinned adapter and retain its raw output for audit.

## Correctness and interpretation

A trial succeeds only if the agent exits successfully, the declarative file assertions pass, all changes stay within `allowedPaths`, protected fixture artifacts remain unchanged, and no unexplained files appear. Failed and timed-out trials remain in `results.json` and `report.md`, but the report does not declare a winner unless every compared trial succeeds.

The checked-in fixture is a harness self-test, not evidence that Ripast improves a real agent. Do not publish a comparative claim until at least one synthetic and one license-recorded, revision-pinned real workload complete all four crossover cells with identical model configuration and clean correctness gates.
