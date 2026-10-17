# Gate Task 2 round-2 scoped review

Date: 2026-10-17. Source: `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`.

## Verdicts

- **Spec compliance: APPROVED within this scope.** T2-R2.1 is closed by making repeat `gatectl up` explicitly recreate Gate while retaining upgrade exclusion and replacement proof.
- **Quality/security: APPROVED within this scope.** No new actionable finding was identified in the repeat-up correction or its directly induced behavior. Unknown outcomes still fail closed; same-instance success is not accepted as replacement proof.
- **Overall managed-restart acceptance: still blocked separately.** Main reports intermittent full-browser `Gatecontrolunknown` after supervisor success and is diagnosing it with boundary traces. This repeat-up fix does not address that issue, and this review neither investigates nor clears it.

This is a narrow source/test review, not a full lifecycle rereview, real Docker validation, deployment approval, or end-to-end acceptance.

## T2-R2.1 closure evidence

The round-1 review allowed either a safely verified no-op path or explicit replacement while holding the reservation. The implementation chooses the latter:

1. [gatectl:367](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gatectl:367) retains sealed-image verification and the private durable reservation before replacing an existing Gate. The legacy API-unavailable path still rejects rather than falling back to status-only authorization.
2. [gatectl:385](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gatectl:385) now invokes the fixed Compose command with `--force-recreate`, `--no-build`, `--pull never`, and only the `gate` service. Its temporary override still contains the exact sealed image. The reviewed Compose definition contains only Gate, and preserves the named `pi-deploy-gate-state` volume; no Hub/Pi replacement or volume deletion is requested.
3. Finish is attempted only after the checked Compose call returns successfully. [gatectl:70](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gatectl:70) verifies the exact reservation and running image; [gate/service.py:102](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/service.py:102) still checks exact reservation ID, no unresolved work, and a different process instance before audited release. No same-instance exception or automatic abort was added.
4. The changed behavior is explicit in [gatectl:185](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gatectl:185) and [README.md:189](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/README.md:189): repeating `up` intentionally recreates Gate and briefly interrupts its management interface. `status` remains the read-only inspection command. This is the disclosed replacement alternative requested by the prior finding, not a claim that repeat-up is now side-effect-free.

The directly induced operational consequence is the documented Gate-interface interruption. An unavailable new admin endpoint can still leave a reservation pending explicit inspected completion; that is existing conservative failure handling, not an unguarded admission window. A returned exit code alone never clears the reservation.

## Regression review and evidence limits

Inspected [tests/test_lifecycle_round2.py:58](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_lifecycle_round2.py:58): the fake Compose operation models unchanged convergence by retaining the same real Gate instance unless recreation is requested. With recreation, it reopens Gate against the same temporary SQLite state. The tests use real reservation/release logic, not only source-string assertions.

Coverage inspected:

- Two consecutive same-image/config `up` calls change process identity and release the reservation after Compose returns. Deployment/lifecycle admission and dispatch remain blocked during replacement, including after reopen, and admission works after verified completion.
- A successful Compose result that deliberately retains the old instance still fails finish and preserves the reservation.
- Wrong running image, lost/nonzero Compose reply after recreation, and unavailable new admin endpoint all retain exclusion rather than automatically finishing or aborting.
- [tests/test_clients.py:75](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_clients.py:75) exercises offline help and checks explicit recreation/new-instance/reservation semantics without Docker access.

**Supplied results, not rerun:** the fix report records 5 round-2 regressions passing, 13 CLI tests passing, and 69 combined lifecycle/upgrade tests passing, plus successful offline help. These overlap and are not additive independent-suite totals. The previous 255-test full-suite result is historical; this review makes no fresh full-suite or 261-test claim.

No new probe was necessary. Fresh reviewer evidence is static inspection of the current command, reservation proof path, Compose definition, documentation, and regression source. No tests, Git, Docker, production requests, credentials, subagents, or product edits were performed. Only this review artifact was written.

The Docker security skill guided exact-image, service/volume scope, and reservation-boundary checks. Verification-before-completion guided evidence labeling and report readback; it did not override the instruction not to rerun suites. The independent full-browser control-unknown failure remains an explicit acceptance blocker outside this closure.
