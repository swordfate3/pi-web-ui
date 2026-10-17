# Managed Pi restart Task 1 round 2 scoped re-review

Date: 2026-10-17

## Scope and evidence

This review is limited to R1 and R2 from `managed-restart-task1-round1-review.md`, the current implementations of `status()` and `restart_prefix()` in staged `runtime/pi_supervisor.py`, and their associated new tests in `tests/test_pi_supervisor.py`. Future guard changes, Hub/Gate work, packaging outside the unchanged round-1 package, and all unrelated Task 1 behavior are outside this review.

The appended round-2 evidence in `managed-restart-task1-report.md` reports **65 tests run, 62 passed, 3 pre-existing opt-in skips, 0 failures**. That evidence was inspected but not rerun. No Git command, production call, source edit, child agent, image/container operation, or test execution was performed. This review report is the only file written.

## Verdict

- **R1 — ADDRESSED.** Terminal operations no longer permanently pin status to `last_snapshot`; live identity/readiness is refreshed while the retained final operation remains attached unchanged.
- **R2 — ADDRESSED.** Positional and `@file` inputs are discarded without ending pre-delimiter scanning, so later reviewed options are preserved, replaced selectors remain replaced, and unknown options still fail before prepare or stop.
- **Fix-induced regressions in the scoped changes: NONE FOUND.**
- **Scoped specification compliance: PASS.**
- **Scoped code quality/security: PASS.**
- **Disposition: APPROVED for the R1/R2 round-2 scope.**

## R1 verification — ADDRESSED

Evidence:

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:271-286`
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py:377-405`

`status()` now uses the cached snapshot only while the retained operation has `status == "running"`. For terminal `succeeded`, `failed`, and `recovery_required` operations, it calls `safe_snapshot()` and then attaches the copied terminal operation to the current public snapshot. This preserves responsive polling during slow checking/transitions without freezing status after completion.

The new tests exercise both required directions:

- after `failed/checking_rejected` from a busy snapshot, the fake extension changes to idle and status reports the refreshed `idle: true`, `busy: false` values while preserving the exact final operation;
- after a successful restart, the fake extension changes session and leaf identity and status reports the new values while preserving the exact final operation.

Temporary extension unavailability remains fail-safe because `safe_snapshot()` falls back to the last validated snapshot. No stale-terminal-status path remains in the reviewed function.

## R2 verification — ADDRESSED

Evidence:

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:117-150`
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py:512-563`

Before the `--` delimiter, `restart_prefix()` now advances past each positional message or `@file` token instead of terminating its scan. It therefore preserves later allowlisted boolean/value options with exact arity. Replaced provider/model/thinking/session/fork/name/continue/resume selectors continue to be consumed and replaced by the prepared snapshot in the final successor argv.

The safety boundaries are unchanged:

- `--` still ends scanning, so every following message/file token is discarded;
- equals-form and unknown option tokens still raise `ProtocolError` wherever they occur before the delimiter;
- no positional message or `@file` token is copied into the successor argv;
- rejection occurs during checking, before extension prepare, SIGTERM, model synchronization, or successor spawn.

The new tests cover safe boolean/value options and replaced selectors after both a positional prompt and an `@file`, plus unknown options after each input shape. They assert exact successor argv on success and one child/no stop signal on rejection. No option-loss or replay regression remains in the reviewed parser.

## Final disposition

R1 and R2 are both **ADDRESSED**. The supplied 65-test result is consistent with the inspected implementation and focused regressions. Task 1 is approved for this round-2 R1/R2 scope; any future guard work should be reviewed separately as requested.
