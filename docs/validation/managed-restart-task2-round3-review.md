# Gate Task 2 round-3 scoped integration review

Date: 2026-10-17. Reviewed staged Gate at `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`.

## Verdicts

- **Spec compliance: APPROVED within the released scope.** `_target_hash` canonicalizes only the top-level `Mounts` order while preserving complete entries, duplicate multiplicity, and all other existing identity inputs.
- **Quality/security: APPROVED within scope.** No actionable defect or induced regression was identified. Configuration changes still fail closed; the fix does not introduce retries or relax trust validation.

Scope was the mount-order correction and induced regressions only. No specifications were reopened, and no broader lifecycle/Hub/runtime review was performed. Main's full Gate and real-browser runs remain separate acceptance evidence; this report does not claim their outcome.

## Source assessment

The correction at [gate/lifecycle.py:102](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle.py:102) uses `sorted(mounts, key=_json)` only when `Mounts` is a list, then fingerprints the resulting projection.

- **Complete entries and duplicates retained:** sorting creates a list, not a set or destination-keyed mapping. Every original entry remains, including exact duplicates and distinct entries sharing a destination. The key serializes the complete entry, so source, destination, RW, mode, propagation, options, provenance, and unknown metadata all affect its ordering and final hash.
- **No mutation:** `sorted` creates a new outer list. Neither the original list nor its entry objects is modified; serialization reads their values without rewriting them.
- **No unrelated list normalization:** `Config` and `HostConfig` remain unchanged in the projection. Environment, argv/Cmd, and nested option arrays preserve their order. [gate/store.py:41](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/store.py:41) canonicalizes object keys, not array elements; [gate/registry.py:36](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/registry.py:36) retains the existing final canonical JSON/SHA-256 behavior and rejects non-finite values.
- **Existing identity projection preserved:** `Id`, `Image`, `Config`, `HostConfig`, and `State.StartedAt` remain included. Missing/null `Mounts` retain their prior `None` representation, distinct from an empty list; the fix introduces no new coercion.
- **Trust and failure behavior preserved:** [gate/lifecycle.py:112](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle.py:112) still validates the exact target and trusted configuration before comparing the fingerprint. Mount validation and named-volume checks remain in place. Real mismatches still raise `target changed`; pre-intent failures remain stale and post-intent uncertainty remains recovery-required, without another restart.

This directly addresses the supplied diagnosis: three traced failures showed identical complete mount multisets in different inspect-array orders. The implementation removes that order-only difference from identity; it does not treat changes in mount contents as equivalent.

## Regression-source review

Inspected all eight tests in [tests/test_lifecycle_round3.py](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_lifecycle_round3.py). Coverage includes:

- Alternating inspect order across admission, both preflight inspections, and polling, with exactly one restart.
- Order reversal only after restart, and reopen/status-only recovery with immutable `started_at` and no replay.
- All24 positional permutations of a four-entry fixture containing an exact duplicate and distinct same-destination entries; input equality before/after hashing; additions/removals affecting multiplicity still change the hash.
- Deletion of each fixture field, unknown-field changes, and nested option-array reordering remaining detectable.
- Actual RW/source/destination/options drift before execution producing stale with zero restarts, and after restart producing recovery-required with exactly one restart.
- Env/Cmd order changes still triggering `target changed`, and reordered mounts not concealing a mount over control code.

The tests exercise real Gate lifecycle/ledger logic with fake inspection/control boundaries. They do not merely assert the presence of sorting code. No additional probe was needed for this bounded transformation.

## Evidence, limitations, and handoff

**Supplied evidence, not rerun:** the round-3 fix report records8 new regressions passing and77 combined lifecycle/upgrade tests passing. The8 are included in the77. The mount-order diagnosis records three traced real-browser failures with successful fixed-control exit observations and `Mounts` as the only changed projection field. These are controller/worker results, not fresh reviewer executions.

**Pre-fix ledger limitation remains explicit:** an existing target hash computed from a noncanonical mount order may mismatch after moving to this code. This fix does not rewrite historical hashes, automatically resolve unknown jobs, or replay a restart. The reopen regression uses a hash originally created by the corrected implementation; it is not a migration test. Retained pre-fix unresolved state requires coordinator-led inspection. This disclosed fail-closed boundary is not a reason to weaken the narrow correction.

The identified order-only failure mechanism is addressed in reviewed source. Main must use its repeated real-browser/full Gate results to decide final acceptance. The earlier untraced timeout is not retrospectively proven to have the same cause, and this review does not declare every possible control-unknown outcome resolved.

No suite reruns, new executable probes, Git, production requests, Docker operations, subagents, or product edits were performed. Only this report was written. The Docker security skill guided mount/provenance preservation checks; verification-before-completion guided evidence labeling and final artifact readback.
