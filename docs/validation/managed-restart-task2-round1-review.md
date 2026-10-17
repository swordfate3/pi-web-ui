# Gate Task 2 round-1 scoped rereview

Date: 2026-10-17. Reviewed stable staged Gate at `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`.

## Verdicts

- **Spec compliance: NOT APPROVED for the complete fix round.** T2-R1, the original T2-R2 admission race, and Gate's portion of T2-R3 are addressed. One induced `gatectl up` compatibility/availability regression remains under T2-R2.
- **Quality/security: CHANGES REQUIRED.** One P2 finding below. It fails closed rather than granting unauthorized execution, but a routine successful no-op leaves deployment and lifecycle management blocked indefinitely until host intervention.

Scope was T2-R1/R2/R3 plus induced regressions only. Inputs were the fix report, original Task 2 review, Gate fix brief, binding 210-second timing ruling, and current Gate implementation/tests/documentation. No Hub implementation or supervisor implementation was rereviewed. This is not end-to-end or production approval.

## Remaining finding

### T2-R2.1 — P2: unchanged `up` leaves a durable reservation that cannot finish

Primary location: [gatectl:381](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gatectl:381), Compose invocation and unconditional finish at lines 381–384. Related guard: [gate/service.py:112](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/service.py:112), same-instance finish rejection at lines 112–113.

After an initial successful installation/upgrade, run `gatectl up` again with the same sealed image and unchanged Compose configuration. The command obtains a durable reservation, then calls ordinary `docker compose up -d` without requiring recreation. An already-converged service can remain running unchanged and Compose can return success. `finish_upgrade()` accepts the running image, but `release_upgrade(..., 'finish')` rejects because the owner process instance is still the current instance.

The command consequently fails after an otherwise successful no-op and leaves its reservation persisted. Both deployment and lifecycle submissions now fail with `host upgrade reservation active`; dispatch is also fenced. Retrying `up` cannot obtain another reservation, and retrying `upgrade-finish` cannot satisfy the changed-instance condition. The operator must inspect and explicitly abort, despite there having been no failed or uncertain replacement. This regresses the existing startup/update command's normal repeat-use behavior and the original Task 2 requirement to retain CLI compatibility.

The same-instance guard is appropriate for an unproved replacement. **Do not remove it globally or auto-clear reservations on errors.** Handle a verified no-replacement/no-op outcome explicitly under the reservation, with exact identity and unresolved-work checks, or make the command's replacement semantics explicit and guarantee a replacement while holding exclusion. Preserve durable blocking for lost replies, actual replacement failures, unknown outcomes, and legacy Gate migration.

**Fresh evidence:** one isolated probe used the real staged `Gate`, SQLite reservation, `gatectl.main`, and finish logic, with a temporary private state directory. Docker inspection, image verification, private command transport, and a successful unchanged Compose invocation were simulated; no Docker process or network service was used. It confirmed same-instance rejection and rejection of both deployment and lifecycle admission afterward. The supplied success regression at [tests/test_lifecycle_round1.py:224](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_lifecycle_round1.py:224) always simulates replacement by closing/reopening Gate, so it does not cover this no-op path. Add a regression retaining the same Gate instance after a successful Compose result.

## Disposition of original findings

### T2-R1 — closed in reviewed source

[gate/lifecycle_contract.py:18](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle_contract.py:18) defines exact safe interpreter environment values; [gate/lifecycle_contract.py:127](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle_contract.py:127) rejects all other `PYTHON*`/`_PYTHON*` settings and every `LD_*` setting. The reported writable-cache prefix therefore cannot reach control execution. Unknown future names fail closed. Fixed control argv, UID1000, safe PATH, no stdin/TTY, and existing reinspection remain intact.

The regression at [tests/test_lifecycle_round1.py:24](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_lifecycle_round1.py:24) includes a real unchecked-hash bytecode positive control and asserts that the same environment is rejected with zero control calls. This is executable mechanism coverage, not a source-string assertion. I inspected it but did not rerun it. Existing trusted-host mount provenance remains the documented boundary; this closure does not claim hostile Docker administrators are contained.

### T2-R2 — original running-Gate race closed; induced R2.1 remains open

[gate/service.py:87](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/service.py:87) acquires the reservation under the shared lock and a SQLite write transaction, rejecting workers and unresolved lifecycle/deployment work. The singleton is persisted in [gate/store.py:86](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/store.py:86). `gatectl up` obtains it after image verification and before Compose, so an intervening admitted job now vetoes replacement instead of being missed by the preliminary status snapshot.

Inspection covered lifecycle and deployment submission, post-inspection admission checks, approval, rollback, dispatch, and startup recovery fences. The reservation persists across failure/reopen and is not time-expired. Private release checks exact reservation ID and unresolved work; finish requires a new instance, with the host command additionally checking the reserved image. Abort requires explicit host acknowledgment at the private route. The host administrator remains trusted to establish that no replacement command is still pending before aborting.

The old-Gate/no-reservation-API path fails closed rather than falling back to a snapshot. The explicit isolated host-maintenance migration boundary is documented at [README.md:201](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/README.md:201); it was not executed. These protections resolve the original race but do not handle R2.1's successful no-op.

### T2-R3 — Gate portion closed under the binding 210-second ruling

[gate/lifecycle.py:35](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle.py:35) derives the deadline from immutable `started_at + 210000`, capped by remaining monotonic time. The same outer deadline is passed from execution through acknowledgment into polling ([gate/lifecycle.py:269](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle.py:269)); recovery reconstructs remaining persisted time rather than starting another full window.

The code retains preflight4s, acknowledgment3s, per-transport caps and post-return checks, status-only reconciliation, durable intent before restart, and unchanged execution-start timestamp semantics. Manual/queue waiting remains excluded. Late observations fail closed. The injected-clock tests cover success at160s, expiry at210s, reopen with only1s remaining, decreasing transport budgets, phase overruns, and live forward/backward wall-clock movement. The old expiry fixture now uses211s, preserving its purpose. Documentation carries the explicit `4 + 3 + 15 + 30 + 10 + 120 + 15 + 13 = 210` envelope.

This closes the Gate defect, not the separately owned supervisor/Hub phase implementation or browser behavior. No claim is made that this review verified those workers or successful recovery after an OS/scheduler stall outside the supported envelope.

## Evidence and constraints

- **Supplied, not rerun:** fix worker reports22 focused round-1 tests and255 full Gate tests passing, including the233-test baseline. Regression source was inspected.
- **Fresh:** exactly one new isolated no-op-up probe, exit0, with real Gate state logic and simulated external operations. Output:

```text
Same-image/config Compose no-op: gatectl up rejects finish (same instance)
deployment admission: blocked by retained reservation
lifecycle admission: blocked by retained reservation
Probe confirmed using real Gate ledger/release and simulated Docker/Compose; no external calls
Temporary probe state removed
```

- No test suite reruns, Git, subagents, production requests, credentials, product edits, or Docker operations. Bytecode writes were disabled for the probe; temporary state was removed. Only this review report was persistently written.
- The Docker security skill guided interpreter/execution and reservation-boundary inspection. Verification-before-completion was applied by separating static conclusions, supplied test results, and the fresh probe, and by reading back this artifact before handoff.
