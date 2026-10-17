# Gate Task2 round2 fix — T2-R2.1

Date: 2026-10-17. Status: **DONE** for the scoped implementation and requested focused/CLI verification. All worker edits are finished. Controller full-suite verification remains separate, as instructed.

## Scope and change

Read `managed-restart-task2-round1-review.md` and addressed only T2-R2.1 and directly related regression coverage. Writes were confined to staged `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate` and this report. No Git, child agents, real Docker/Gate/Pi operations, production credentials, installs, Hub/runtime changes or main harness changes.

Files changed under staged Gate:

- `gatectl`: add `--force-recreate` to the existing fixed Compose invocation; update top-level/up help to describe explicit repeat-up recreation and its brief Gate-interface interruption.
- `README.md`: describe repeat-up replacement semantics, retained state volume, admission exclusion through settlement/proof, and conservative handling of unknown outcomes.
- `tests/test_lifecycle_round2.py`: five fake-external-operation regressions using real Gate, SQLite reservation, host command and finish logic.
- `tests/test_clients.py`: one executable offline-help regression.

No Gate API, reservation schema, release logic, timing, interpreter policy, or control-client argv changed. No original tests were removed.

## Resolution and guarantees

`gatectl up` now explicitly starts/recreates Gate even when its sealed image and Compose configuration are unchanged. It is not a read-only convergence/status command; use `gatectl status` for inspection. The existing command still targets only the `gate` service, uses the exact sealed image through its temporary Compose override, disables builds/pulls, and preserves the named state volume. No Hub/Pi replacement is requested by this command.

For an existing Gate, the durable reservation is acquired before Compose. It remains in force while the old instance is running, across the new instance's startup, and until Compose has returned successfully **and** the existing exact running-image/new-instance/unresolved-work checks pass. The implementation adds no same-instance finish exception and no automatic abort.

If a supposedly successful Compose call still leaves the same process, finish remains refused. Replacement errors, lost replies, wrong running images and an unavailable new private endpoint retain the reservation. A successful command exit alone is not replacement proof. The legacy Gate/no-reservation-API path still fails closed; this change provides no migration fallback or bypass.

## Regression evidence

The repeat-up fake deliberately models an already-converged service: without `--force-recreate`, it returns success while retaining the **same real Gate instance**; with the option it closes/reopens Gate against the same temporary state. Before implementation, the regression failed through the real finish path with `replacement instance not observed`, reproducing the reported defect rather than merely checking a command string.

After the change, two consecutive same-image/config `up` calls each produce a new Gate process identity and release the reservation. The fake asserts deployment/lifecycle admission and dispatch remain fenced during Compose, including after reopening; the real finish route is invoked only after Compose returns. Both admission types become usable after verified completion.

Additional regressions cover:

1. Compose success that deliberately ignores recreation and retains the original instance: finish rejected, reservation/admission fence retained.
2. A wrong running image after replacement: no finish request, reservation retained.
3. A lost/nonzero Compose reply after replacement: no finish request, reservation retained.
4. A new private endpoint not yet available after Compose success: no finish request, reservation retained.
5. Offline `up --help`: explicit same-image recreation, `--force-recreate`, new-instance proof and reservation semantics, with no Docker access.

## Commands and results

Working directory for every command: `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`.

```bash
/usr/bin/python3 -m unittest discover -s tests -p test_lifecycle_round2.py -v
/usr/bin/python3 -m unittest discover -s tests -p test_clients.py -v
/usr/bin/python3 -m unittest discover -s tests -p 'test_lifecycle*.py' -v
./gatectl up --help
```

| Verification | Result |
| --- | --- |
| Round2 regression RED, before product change | 5 tests; 1 intended failure; 0 errors; 0.238s |
| CLI/help RED, before product change | 13 tests; 1 intended failure; 0 errors; 1.076s |
| Round2 regression GREEN | **5 passed**, 0.275s, exit0 |
| Relevant CLI regression suite GREEN | **13 passed**, 1.061s, exit0 |
| Combined original + round1 + round2 lifecycle/upgrade suite | **69 passed**, 10.609s, exit0 |
| Direct offline `up --help` | exit0; explicit replacement semantics shown |

Only the combined lifecycle suite required approved temporary local HTTP/Unix test sockets. External Docker/Compose operations were simulated; no real Docker subprocess was run. TDD guided the defect-first regression; verification-before-completion required fresh test results. The Docker skill guided retention of the exact-image/state-volume boundary and the distinction between command completion and readiness/proof.

**Full suite was intentionally not rerun by this worker.** The previous round's 255-test pass is historical evidence, not a new round2 result. This round adds six tests, so the unchanged discovery set should total261; the controller must verify that result independently.

## Operational concerns and handoff

- Repeating `up` now intentionally recreates Gate and briefly interrupts its management interface. Help and README disclose this; it does not recreate Hub or Pi.
- If the new private endpoint is not ready when finish is attempted, the command still conservatively fails with the durable reservation retained. Existing inspected `upgrade-finish` / `upgrade-abort` procedures apply; no automatic early release was introduced.
- Old Gate images without reservation support still require the previously documented explicit host-admin migration. No live migration or installation was performed.
- No broader refactors or follow-on features are planned. All Gate edits have stopped; ready for controller full-suite/review coordination.
