# Stable-browser acceptance — Mounts-order false drift

Controller diagnosis,2026-10-17. Not an actual target/configuration replacement.

Three sequential real Gate + packaged Hub + two actual Docker/Pi + Chromium390
tests failed on stable source before correction. Initial generic browser timeout
was made fail-fast on a visible terminal result, with safe synthetic boundary
diagnostics in the integration harness. No production operation occurred.

All fixed exec observations were Running=false/ExitCode0. The failing boundary
was `Lifecycle._resolve` raising `RuntimeError('target changed')`. Repeated Docker
inspect projections then established, for each failure:

```json
{"boundary":"inspect-drift","changed_fields":["Mounts"],
 "mount_order":["/run/secrets/pi-web-session.json","/workspace"],
 "same_mount_set":true}
```

The same source/destination/options mount objects were returned in a different
array order. Lifecycle._target_hash fingerprints the whole Mounts array without
canonicalization. That treats ordering-only inspection output as an immutable
configuration change. Depending on timing, the job becomes stale before stop or
recovery_required after the single restart, even though supervisor restores the
exact session/leaf successfully. The diagnostic3case run failed3/3 in23.962s.
Earlier evidence also included a success, so no claimed deterministic engine
ordering is assumed. The earlier unexplained timeout is compatible with this
cause but cannot be retrospectively proven identical without its missing trace.

## Released scoped correction

The original Gate worker is the sole implementation worker. Canonicalize only
semantically unordered Docker Mounts entries for the target fingerprint, retaining
every entry and every source/destination/options/read-only/provenance field.
Do not sort unrelated order-sensitive argv/env lists, omit mount fields, weaken
trusted validation or retry restart execution. Do not mutate inspect input.

Add RED/GREEN regressions for order-only variation across admission/preflight/
poll/recovery, and real RW/source/destination/options changes still failing
closed. Bounded duplicate/multiset semantics must not drop entries. Use existing
fake inspected objects plus actual mechanism checks as needed. Report exact
source/test delta in `managed-restart-task2-round3-fix-report.md`. Main owns the
subsequent repeated real browser acceptance and full Gate suite. No production
or runtime/Hub changes, Git operations or timing-contract changes.
