# Security policy

## Supported versions

TFS Ripast is currently a public preview. Security fixes are applied to the latest release and the default branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation.

Avoid including credentials, private repository contents, or unrelated personal data. You should receive an acknowledgement within seven days. Please allow time for investigation and a coordinated fix before public disclosure.

## Trust boundaries

Ripast validates repository-relative paths and protects transaction data, but
it is not a sandbox for a repository being modified concurrently by a hostile
local process. Use an OS sandbox or exclusive workspace for untrusted
repositories, and do not let another process replace directories during a
transaction.

Serialized plans may recommend validations, but named adapters run only when
the operator separately authorizes the matching `--check` value. Explicit
command checks are executable authority and should only be used with trusted
plans.

The optional benchmark runner executes its configured agent with the invoking
user's privileges. Real-agent mode requires explicit acknowledgement; see
`benchmarks/README.md` for isolation and telemetry-trust requirements.
