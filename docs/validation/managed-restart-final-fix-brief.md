# Whole-branch final findings — one scoped fix dispatch

Read `managed-restart-final-review.md` fully. Address its F1/F2 and directly
induced regressions, not a new architecture or unrelated cleanup. Sole worker
may edit staged Pi runtime plus feature Hub/tests/operating text as below.

## F1 — monotonic external shutdown

SIGHUP/SIGTERM must cancel new restart admission and in-flight work. Check after
blocking checking/prepare, old-child wait, sync and before spawning/publishing.
Coordinate shutdown against creation/publication so a child created concurrently
receives the graceful signal; no success after shutdown wins, no successor retry,
no force-kill. Preserve foreground SIGINT semantics and ordinary exit.

Add deterministic RED/GREEN tests for both signals during checking/prepared,
old-child wait, after exit/before spawn and during publication. Assert supervisor
termination/no replay/no success, and no new child or graceful termination of a
concurrently created one. Use real subprocess/PTY scenario where proportionate
in addition to bounded race doubles. Do not change the guard or Gate contract.

Allowed staged changes: pi-docker/runtime/pi_supervisor.py and existing test file
or a focused new shutdown test. Tell controller exact new paths for baseline and
install-manifest regeneration. No edits to production docker_files or main-owned
image/browser integration harnesses.

## F2 — historical result versus current link

An authorized query must retain a validated in-budget persisted completion as
historically succeeded after normal leaf progress, session switch/quit, Hub
reopen or generation rotation. Independently omit/mark unavailable an unsafe
actionable path; do not bind old handoff capabilities to a different generation.
No grant-revocation bypass, forged completion, unverified success, renewed lease
or arbitrary latest route. Keep initial exact successor proof mandatory.

Update relevant operating wording. Add RED/GREEN cases for progress, switch/exit,
reopen/rotation and deadline passage; retain rejection of mismatched/forged
identity/receipt, revoked grant and stale handoff. Prefer minimal API/UI behavior:
keep historical succeeded but omit path when no exact live permitted match;
explain current link unavailability without presenting a failed restart.

## Boundaries and report

Use TDD and fresh focused verification. No subagents, Git, installs, build/dist,
live service calls, credentials/policy changes, production or remote operations.
Main rebuilds image/dist and reruns full suites/browser acceptance afterwards.
Write `managed-restart-final-fix-report.md` with exact changes, RED/GREEN evidence,
tests and any concerns; stop all edits after report. Existing reviewed source
installation patch/manifest is invalidated and MUST NOT be applied before main
regenerates it against corrected source and obtains focused final re-review.
