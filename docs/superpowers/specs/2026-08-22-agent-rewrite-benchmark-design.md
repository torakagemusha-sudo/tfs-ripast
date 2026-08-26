# Agent Rewrite Benchmark Design

Date: 2026-08-22
Status: approved design, pending implementation plan

## Purpose

Measure whether `tfs-ripast` helps the same Codex agent complete major
repository rewrites faster and with fewer issued commands than its normal
toolset. The benchmark compares end-to-end coding workflows, not isolated
search-command throughput.

## Compared modes

Each trial runs in one of two modes:

- **Normal:** the agent may use every normally available tool except
  `tfs-ripast` and its `rpst` alias.
- **Ripast:** the same agent has the same tools, plus `tfs-ripast`.

Both modes use the same model and reasoning configuration, system and developer
instructions, task prompt, repository snapshot, resource limits, and acceptance
criteria. A trial runs in a fresh session and isolated worktree. It receives no
transcript, patch, cache, generated plan, or hidden result from another trial.

## Workloads

Version one contains paired, equivalent major-rewrite fixtures in three
classes:

1. a repository-wide textual rename or configuration migration;
2. a structural API migration spanning multiple files and languages; and
3. a context-sensitive rewrite where identical text requires different edits
   according to syntax.

Each fixture has an immutable starting snapshot, task prompt, allowed scope,
and executable acceptance suite. Synthetic repositories provide exact ground
truth and deliberately seeded edge cases. Pinned real open-source repository
snapshots provide representative layouts and noise. Licences and immutable
source revisions are recorded with each real fixture.

Fixtures A and B in a pair must be equivalent in size and difficulty without
being byte-identical. Equivalence is documented using file count, source bytes,
language mix, required edit count, structural variation, and acceptance-test
shape.

## Crossover protocol

The minimum complete experiment is four fresh trials per paired workload:

| Trial | Fixture | Mode |
|---|---|---|
| 1 | A | Normal |
| 2 | B | Ripast |
| 3 | B | Normal |
| 4 | A | Ripast |

Execution order is deterministically shuffled from a recorded seed. The
crossover controls for fixture difficulty and ordering without allowing a
session to learn from its paired run. More repetitions may be added in complete
four-trial blocks.

## Measurements

The two primary measurements are:

- **wall time:** monotonic elapsed time from the agent's first repository/tool
  inspection after receiving the task until its final acceptance command
  succeeds; and
- **commands issued:** the number of top-level tool invocations initiated by
  the agent during that interval.

A tool call containing one shell command counts as one issued command. If a
single tool call intentionally launches multiple independent shell commands,
each command counts separately. Internal subprocesses launched by `rg`,
`ast-grep`, `tfs-ripast`, a compiler, or a test runner do not inflate the
primary count; they are recorded separately when observable. Failed commands,
retries, inspections, edits, and verification calls all count. Pure assistant
messages and framework-internal waiting do not.

The harness also records mode, model/configuration identity, fixture and source
revision, randomized order and seed, start/end monotonic timestamps, command
transcript, exit status, acceptance-test results, resulting tree hash, and
optional peak CPU/memory observations. Token counts are not a primary metric.

## Correctness gate

Speed cannot compensate for an incorrect rewrite. A trial is successful only
when:

- all fixture acceptance tests pass;
- the resulting files remain within the authorized scope;
- required edits are complete and forbidden edits are absent;
- no benchmark or expected-output artifact was modified; and
- the repository contains no unexplained generated or temporary files.

A failed, timed-out, or incomplete trial is reported as such and excluded from
speedup claims. Its elapsed time and command count remain visible.

## Instrumentation and auditability

The harness owns timing and transcript capture outside the agent session. It
must not rely on the agent to self-report commands. Every top-level invocation
is assigned a sequence number and records its tool kind, bounded/redacted
arguments, start/end timestamps, and result status. Secrets and unrelated
environment values are never captured.

The normal-mode boundary is enforced by removing project launchers from PATH,
rejecting direct invocation of known `tfs-ripast` entry points, and auditing the
transcript. The ripast mode records the exact built artifact and version hash.
Fixture setup, dependency warm-up, and harness teardown occur outside the timed
interval and are identical between modes.

Each experiment emits versioned JSON plus a concise Markdown report. Raw
per-trial records are retained so command counts and timing can be independently
recomputed.

## Analysis

Results are reported per trial and per workload pair. For each mode the report
shows successful-trial wall time and command count, then paired absolute and
percentage differences. With repeated blocks it reports medians and the full
range; it does not claim statistical significance from a single crossover.

The headline answers are:

1. Did both modes produce correct results?
2. How much wall time did Ripast add or save?
3. How many agent-issued commands did Ripast add or save?
4. Which rewrite classes benefited, regressed, or showed no material change?

## Safety and reproducibility

Trials run only in disposable worktrees or temporary copies. They receive no
credentials or network authority unless a future fixture explicitly requires
and documents it. Timeouts terminate the complete spawned process tree. The
harness records platform and dependency versions and can recreate every fixture
from its pinned source plus checked-in transformation metadata.

The benchmark is not part of the production rewrite authority path. It may call
the public CLI, but it cannot weaken dry-run defaults, approval, validation,
transaction, or rollback behavior.

## Version-one exclusions

Version one does not compare different models, humans, AI-assisted competing
products, token cost, or subjective code quality. It does not reuse a session
between modes and does not treat internal subprocess count as equivalent to an
agent-issued command. These can be separate later studies.

## Acceptance criteria

- A dry harness self-test proves monotonic timing and command counting.
- A deliberately failing rewrite is retained but cannot be declared a winner.
- Normal mode demonstrably cannot invoke either project alias.
- Crossover fixtures start from byte-identical snapshots for each repeated
  fixture and cannot observe another trial's artifacts.
- JSON records contain enough data to recompute every displayed primary metric.
- At least one synthetic and one pinned-real workload complete in all four
  crossover cells before publishing a comparative conclusion.
