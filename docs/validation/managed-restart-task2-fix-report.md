# Managed restart Task2 — Gate scoped fix round1

Date: 2026-10-17. Result: **DONE_WITH_CONCERNS** — T2-R1/R2/R3 implemented and verified; operational migration boundaries below remain explicit. Gate edits are finished; no further implementation is running in this worker.

## Scope

Only staged `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate` and this report were edited. No Git, child agents, installs, real Docker/Gate/Pi operations, production credentials, main harness changes, Hub changes, or runtime/shebang changes. Tests used temporary state, fake engines, local test sockets and isolated Python subprocesses. The coordinator's real smoke/browser results were not rerun or claimed as this worker's verification.

Changed files relative to the round1 checkpoint, under staged Gate:

- `gate/lifecycle_contract.py`: closed interpreter-environment acceptance.
- `gate/store.py`: durable singleton upgrade reservation and transactional deployment admission checks.
- `gate/service.py`: atomic reserve/release, private admin routes, admission/dispatch fences, startup recovery fence.
- `gate/admin.py`: private reservation transport commands.
- `gatectl`: reserve before replacement, verify replacement before finish, explicit status/finish/abort, legacy fail-closed behavior.
- `gate/lifecycle.py`: reservation fences and injected-clock, non-extending execution/phase/transport deadlines.
- `tests/test_lifecycle_round1.py`: 22 new regressions.
- `tests/test_lifecycle.py`: existing expired-recovery fixture changed from 156 seconds old to 211 seconds old, preserving its intent under the binding timing ruling. No original tests discarded.
- `README.md`: reservation/release/bootstrap/legacy migration guidance, exact host usage, interpreter policy and 210-second envelope.

## T2-R1 — interpreter/import provenance

Reject every `LD_*` setting and every `PYTHON*` / `_PYTHON*` setting except these exact name/value pairs:

```text
PYTHON=/usr/bin/python3
PYTHONUNBUFFERED=1
PYTHONDONTWRITEBYTECODE=1
PYTHONNOUSERSITE=1
PYTHONSAFEPATH=1
```

This is a closed acceptance rule, including rejection of unknown future Python settings, not another partial denylist. `PYTHONPYCACHEPREFIX`, user-base, alternate library directory, startup, warnings/import hooks and interpreter overrides are rejected before any fixed-control invocation. Existing exact target/configuration reinspection also covers this environment.

The regression constructs valid unchecked-hash bytecode for the real interpreter's `json` cache path inside a temporary alternate cache. Its positive control actually executes the substitute marker despite safe-path/no-user-site overrides; the Gate path rejects that same inspected environment and makes zero control calls. Fixed `/usr/local/bin/pi-session-control --request JSON`, UID/GID1000, no shell/stdin/TTY and the existing env-python3 shebang are unchanged. No out-of-scope shebang change is required for this correction.

## T2-R2 — durable upgrade exclusion

`gatectl up` retains its preliminary status/image checks, then obtains the new private reservation **before Compose replacement**. The authoritative check occurs under the shared Store admission lock and SQLite write transaction. It reconciles deployment results and refuses pending/queued deployment jobs, active deployment/recovery, live workers and unresolved lifecycle work (including failed/unknown outcomes). It records a random reservation ID, exact immutable replacement image ID, owner process instance ID and creation time.

While reserved, deployment and lifecycle admission, manual approval, rollback, worker dispatch and startup recovery are fenced. Checks are repeated after blocking validation/inspection. Ordinary status/health and administrative inspection remain available. Non-executing service-intent proposals are not deployment authorization.

The reservation survives reopen, replacement failure, client disconnect and startup. It never expires or clears automatically. Successful `up` inspects the actual running Gate image against the reserved image, then asks the new Gate instance to finish; the server requires a different process instance, exact reservation ID and no unresolved work before atomically auditing and releasing. A direct same-instance finish is refused.

If replacement succeeded but the private endpoint is not ready, `up` fails conservatively and retains the reservation. After inspection, retry `upgrade-finish`. Explicit abort requires the host acknowledgment `inspected_no_replacement`; the operator must first confirm the original replacement process is stopped/exited and no replacement remains pending. Abort does not cancel Compose. Both release paths refuse unresolved work and preserve all job history.

Tests cover the original idle-snapshot → intervening lifecycle unknown-outcome race; reservation arriving during lifecycle/rollback inspection; persistence/reopen; admission/dispatch denial; successful fake replacement/new-instance release; failed replacement retention; exact-ID/same-instance guards; unresolved release refusal; real temporary private-socket admin transport and public-route denial.

### Bootstrap and old-Gate migration

With no existing Gate container, the normal sealed-image first-start path remains available. Existing reservation state in a reused volume is not cleared by that path or by startup.

A running older image without the reservation API **cannot** be upgraded using an unsafe snapshot fallback. New `gatectl up` fails closed before replacement. A stopped existing Gate also remains refused.

The README documents the separate, explicit host-admin maintenance boundary: isolate all submitters/request access and concurrent admin updates, prevent queued dispatch, inspect/resolve outstanding work, retain a private state backup and old-image identity, replace using the reviewed immutable-image/seal process while isolation remains in effect, then verify the new instance/state/health before reopening access. Merely changing policy to disabled does not cancel already queued work and is not proof of quiescence. This worker did not perform that migration and added no bypass switch.

## T2-R3 — binding 210-second clock

The immutable positive safe-integer millisecond `started_at` remains persisted only on the initial queued/pending → running transition, before restart. Manual waiting is excluded; job ID/idempotency key/supervisor operation ID equality and status-only recovery remain unchanged. Async checking acknowledgments still do not require `expected_version`.

The fixed outer deadline uses both persisted `started_at + 210000` wall time and a monotonic cap. The same outer object is retained through execution, acknowledgment and polling, so a backward wall jump during execution cannot replenish the budget. Reopened Gate reconstructs only the remaining persisted execution budget, not a fresh 210 seconds. A forward wall jump or late result is rejected.

Preflight is capped at4 seconds, acknowledgment at3 seconds, each bounded by the outer remainder. Each list/inspect/volume/status transport gets at most3 seconds and no more than remaining phase/outer time, with a post-return deadline check. Preflight is checked again before durable intent/restart. Outcomes past the control/outer deadline become `recovery_required`; pre-intent precondition failure becomes stale. No second restart or stop is sent.

The documented envelope is exactly4 +3 +15 +30 +10 +120 +15 +13 =210 seconds. Gate does not change supervisor stop30/readiness120 or implement other workers' phases. Tests include in-envelope success at160 seconds (2 preflight +10 checking +29 stop +119 readiness), expiry at210, recovery with only1 second remaining, decreasing per-step timeouts, late-success rejection, preflight/ack overruns, individual transport overruns, and live forward/backward wall-clock movement. Existing HTTP responsiveness tests remain green.

## Verification

Commands run from `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`:

```bash
/usr/bin/python3 -m unittest discover -s tests -p test_lifecycle_round1.py -v
/usr/bin/python3 -m unittest discover -s tests -v
```

RED/GREEN checkpoints (same focused command as above):

| Checkpoint | Result |
| --- | --- |
| R1 RED | 2 tests; 10 failing assertions/subtests; 0 errors; 0.077s |
| R1 GREEN | 2 tests passed; 0.080s |
| R2 RED | 9 cumulative tests; 7 failures; 0 errors; 0.424s |
| R2 GREEN | 9 tests passed; 0.478s |
| R3 RED | 15 cumulative tests; 6 failures; 0 errors; 0.768s |
| Initial R3 GREEN | 15 tests passed; 1.097s |
| Additional per-transport RED | 22 cumulative tests; 2 failing subtests; 0 errors; 2.708s |
| Final focused GREEN | **22 tests passed; 2.759s** |
| Full fake Gate suite | **255 tests passed; 81.607s; exit0** |

The full run preserves the233-test baseline plus22 new tests. One intermediate sandboxed HTTP run failed because local sockets were forbidden; it also briefly rediscovered imported HTTP tests. The import was corrected, and the clean RED/GREEN and full runs above used approved temporary local-socket access. That environment/setup run is not counted as product RED evidence. An earlier interrupted test-edit run is likewise excluded.

The TDD skill guided executable regression-first changes; verification-before-completion required the fresh complete suite before this result. No child review or production checks were substituted for those tests.

## Exact host usage

Offline help was exercised successfully for all six commands below (exit0, no Docker/token access):

```bash
./gatectl upgrade-status --help
./gatectl upgrade-finish --help
./gatectl upgrade-abort --help
./gatectl lifecycle-policy --help
./gatectl lifecycle-export --help
./gatectl lifecycle-approve --help
```

Administrator usage, documented only, not performed on live services (replace placeholders with reviewed exact values):

```bash
./gatectl lifecycle-policy manual --image sha256:<64-hex-image-id>
./gatectl lifecycle-policy auto --image sha256:<64-hex-image-id>
./gatectl lifecycle-policy disabled
./gatectl lifecycle <32-hex-job-id>
./gatectl lifecycle-approve <32-hex-job-id>
./gatectl lifecycle-export /absolute/private/directory/pi-lifecycle.json
./gatectl upgrade-status
./gatectl upgrade-finish <32-hex-reservation-id>
./gatectl upgrade-abort <32-hex-reservation-id> --acknowledge inspected_no_replacement
```

`--image` is repeatable and replaces the complete independent allowlist. Export creates a new0600 file, refuses overwrite/symlink destinations and does not print the token. Reservation creation is internal to `up`, not a new public request capability. Existing lifecycle policy/approve/export private-transport and offline-host tests passed in the full suite.

## Remaining concerns / handoff

1. Deployment is intentionally not performed. Old live images need the explicit isolated host-admin migration described above; absence of the API is not permission to downgrade exclusion.
2. An interrupted upgrade can deliberately leave admission blocked until exact-ID finish or inspected abort. Operators must not delete state or abort while a replacement command may still execute. The private admin endpoint/host Docker authority remains a trusted administrator boundary.
3. Trusted launcher/host bind-source provenance remains the original documented boundary; no new host-filesystem proof is claimed. Inherited unreviewed Python settings now conservatively make a target unmanaged, which can require a trusted launcher configuration correction before use.
4. Hub re-review/browser progress issues and supervisor phase implementation remain other workers' scope. No main-owned real integration harness was run. These changes do not promise recovery success after an uninterruptible OS/scheduler stall outside the envelope.

No further Gate edits are planned for this dispatch. The coordinator can dispatch the separate Hub worker after this handoff.
