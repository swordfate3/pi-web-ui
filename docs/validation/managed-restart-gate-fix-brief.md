# Managed restart Task2 — scoped fix round1

Read `managed-restart-task2-review.md` first. Address T2-R1, T2-R2 and T2-R3,
and only regressions introduced by their correction. Original Task2 brief and
report remain applicable; timing is superseded by `managed-restart-timing-ruling.md`.

Scope: sibling staged `pi-runtime-restart-work/gate` only, plus your report
`managed-restart-task2-fix-report.md`. Do not edit Hub, Pi runtime, build/dist,
main-owned integration harnesses, Git, real credentials or `docker_files`.
No child agents. Preserve existing edits. Wait for explicit dispatch; no parallel
implementation worker is allowed. Use apply_patch and RED/GREEN regressions.

- R1: make the fixed control client's Python startup/import provenance independent
  of accepted inherited interpreter settings. Keep fixed allowlisted control argv
  and UID1000. Reproduce writable substitute bytecode-cache behavior in an
  isolated regression; safe-path-only assertions are insufficient. Coordinate
  with main if a shebang change outside Gate is necessary; do not silently edit
  the staged Pi source.
- R2: acquire a durable, atomic host-admin upgrade reservation under shared
  admission lock after checking unresolved lifecycle and deployment jobs. Hold
  exclusion through replacement or explicit abort. All admission/dispatch paths
  must honor it; another status snapshot is not sufficient. Test an attempted
  lifecycle admission after initial status and unresolved outcomes. Startup and
  failure handling must not silently clear an unresolved reservation. Consider
  initial migration from a running older Gate that lacks the reservation API:
  fail closed and document the host-admin migration boundary rather than
  downgrading to unsafe status-only replacement.
- R3: Gate total becomes210s from immutable execution `started_at`. Honor
  remaining time in transport steps, never reset during reconciliation, and keep
  status/health responsive. Inject time for beyond155s in-envelope success and
 210s expiry. Preserve30s stop/120s startup. Manual waiting is excluded. Hub and
  supervisor changes are other workers' ownership.

Run focused and full staged Gate suites; do not rerun or deploy production.
Write exact commands, RED/GREEN counts, files, reservation/bootstrap semantics
and residual concerns. Return concise DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED.
