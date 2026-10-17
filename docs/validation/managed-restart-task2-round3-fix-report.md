# Gate Task2 round3 — mount-order fingerprint correction

Date: 2026-10-17. Status: **DONE** for the scoped correction and focused verification. All worker edits have stopped. Main owns the subsequent full Gate suite and repeated real-browser acceptance.

## Evidence and scope

Read `managed-restart-mount-order-diagnosis.md`. The controller's three traced failures identified only `Mounts` array order changing, with the same complete mount multiset; `_resolve` rejected the target fingerprint despite successful fixed-control exec exits. That supplied real-browser evidence was not rerun by this worker. The earlier untraced browser timeout remains unproven as the same cause.

This round changed exactly these staged Gate files:

- `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle.py`: only `Lifecycle._target_hash`.
- `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_lifecycle_round3.py`: eight new regressions.

The only write outside staged Gate is this report. No Git, child agents, production operations, real Docker calls, installs, runtime/Hub/main-harness changes, or timing-contract changes.

## Minimal correction

The fingerprint now obtains `Mounts` separately. If it is a list, `sorted(mounts, key=_json)` builds a new list ordered by each **complete entry's canonical JSON**, using the existing serializer. That list is inserted into the otherwise unchanged target projection before the existing fingerprint function runs.

Properties preserved:

- Every mount entry and every field/value remains present, including duplicate entries, source, destination, RW, options, mode, propagation, name/driver provenance and unknown future metadata.
- Sorting is not deduplication or a destination-keyed dictionary. Same-destination entries with different source/metadata are retained and ordered by their complete contents.
- Inspection input is not mutated. No mount object is rewritten.
- Only the top-level `Mounts` list is reordered. Env, argv/Cmd, nested option arrays and all other lists remain order-sensitive.
- Existing null/missing versus list distinctions are not coerced. Existing full projection fields—Id, Image, Config, HostConfig and State.StartedAt—remain fingerprinted.
- Trust validation, immutable ID/generation checks, single restart/durable intent, status-only recovery, reservation semantics and210-second timing are unchanged. There is no retry or exception swallowing added to `_resolve`.

## RED/GREEN coverage

Tests use the existing fake Docker inspect/control boundary with real Gate lifecycle logic and a temporary SQLite ledger. Positive cases cover:

1. Alternating mount order between admission, both execution-preflight inspections, and polling: succeeds with exactly one restart.
2. Reorder only after restart: successful supervisor evidence is consumed rather than becoming unknown.
3. Reopen with reordered mounts after persisted intent: completes by status polling, preserves `started_at`, and sends no restart.
4. All24 permutations of a four-entry mount fixture containing an exact duplicate and distinct same-destination entries: identical fingerprint without input mutation; changing duplicate multiplicity changes the fingerprint.

Negative cases verify deletion of each mount field, nested option-list reordering, unknown-field value changes, and real RW/source/destination/options changes remain detectable. Actual mount changes before execution produce stale with zero restarts; changes after restart produce recovery_required with exactly one restart. Reordering Env/Cmd still triggers `target changed`, and reordering cannot conceal a mount over control code.

Exact commands, run from `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`:

```bash
/usr/bin/python3 -m unittest discover -s tests -p test_lifecycle_round3.py -v
/usr/bin/python3 -m unittest discover -s tests -p 'test_lifecycle*.py' -v
```

| Checkpoint | Result |
| --- | --- |
| Initial RED, three-entry permutation fixture | 8 tests; 7 failing assertions/subtests; 0 errors; 0.773s |
| Expanded RED, same-destination/four-entry fixture, before product change | 8 tests; 25 failing assertions/subtests; 0 errors; 0.797s |
| Round3 GREEN | **8 passed**, 0.809s, exit0 |
| Combined original + rounds1–3 lifecycle/upgrade tests | **77 passed**, 11.779s, exit0 |

RED failures directly reproduced preflight stale and post-restart/recovery unknown outcomes on order-only changes; negative drift checks were already green. The combined suite required approved temporary local test sockets, not real services. All original and previous-round tests were retained. Main's full suite was intentionally not run; this round adds eight tests.

The systematic-debugging workflow kept the fix tied to the controller's confirmed boundary evidence; TDD required the executable failures before implementation, and verification-before-completion required fresh focused results before handoff.

## Handoff / limits

- Full Gate and repeated real-browser acceptance remain controller-owned. No real-browser success is claimed here.
- The correction does not rewrite stored pre-fix target hashes or auto-resolve historical stale/failed/unknown jobs. A pre-fix hash recorded in noncanonical order can still mismatch after a code transition; any retained unresolved test/deployment state needs coordinator-led inspection, not digest replacement or automatic restart replay. The reopen test covers a job admitted with the corrected fingerprint and a later reordered inspect.
- No trust checks were relaxed and no new recovery/migration mechanism was introduced. No follow-on source changes are planned by this worker.
