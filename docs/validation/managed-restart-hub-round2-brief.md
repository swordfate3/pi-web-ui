# Hub scoped fixes — round2

Read the accepted spec, security/timing rulings, and
`managed-restart-hub-round1-review.md`. Fix only its R1/R2 and induced regressions.
Do not reopen the accepted separate-management-origin or conservative guard design.
Do not start before explicit controller release (Gate is currently implementing).

## R1 — all Web command dispatch paths

Taint before every accepted unaudited extension command path, regardless of the
optional `executePiCommand` request flag. Reject unsupported paths rather than
assuming synchronous completion. Include omitted and false flag regressions with
an asynchronous registered command held in progress, verify taint precedes actual
dispatch, and prepare remains refused after the Web ACK. Keep audited/tracked
operations working. Prefer a real Pi TUI/WS regression in addition to focused
dispatcher coverage. Do not replace the pre-SDK guard with a late extension shim.

## R2 — preserve ordinary recovery after unsuccessful operations

Remove managed authority without deleting a healthy original connection's
ordinary recovery capability. Preserve/reissue an ordinary correctly fenced
handoff if the original generation is still valid, notify the connected client
that managed recovery has ended, and never follow an arbitrary successor. Add
rejected and pre-stop-failed job regressions followed by transient network
disconnect with the original Pi alive. Preserve the ordinary15second window and
the bounded nonextending210/120second managed contracts.

## Boundaries and report

Own only the Hub/extension/frontend source and focused tests required by R1/R2.
Do not touch Gate or staged runtime source; tell controller if a runtime change
is genuinely required. Canonical guard packaging and image parity are already
fixed by controller; keep them. No Git operations, package installs, production
service calls, credentials or remote deployment. Keep docs/managed-pi-restart.md
accurate only if these fixes change its contract.

Write `docs/validation/managed-restart-hub-round2-fix-report.md` with exact files,
RED/GREEN evidence, fresh test commands/results and remaining concerns. Leave
final build/dist and full-chain repeated stable-source browser checks to controller.
