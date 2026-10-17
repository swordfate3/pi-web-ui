# Managed restart final F1/F2 fix report

Date: 2026-10-17. Status: **DONE_WITH_CONCERNS — scoped fixes and focused verification complete; independent final review, rebuilt artifacts/integration, and the completion-record compatibility boundary below remain explicit.** All edits stop with this report.

Requirements read in full: `managed-restart-final-fix-brief.md` and `managed-restart-final-review.md`, with the accepted architecture/security/timing contracts retained. No Gate changes, Git operations, subagents, installs, Docker/build/dist work, production calls, credential/policy changes or source installation were performed.

## F1 — monotonic external shutdown

Staged `pi-docker/runtime/pi_supervisor.py` now treats SIGHUP/SIGTERM as a monotonic shutdown state shared by admission, restart work, child publication and completion:

- Reject restart admission after shutdown; a reserved but undispatched operation cannot start a worker after shutdown.
- Check shutdown before work and after snapshot/version/prepare, before the managed stop signal, after old-child wait, around model sync/spawn, and after readiness awaits. A checking/prepare return cannot resume the restart after shutdown won.
- Serialize the managed stop decision and final operation publication with shutdown. An in-flight operation becomes `failed / shutdown`; later worker results cannot overwrite that with success.
- Do not hold the shutdown lock across `Popen`. Mark creation in flight first. If shutdown arrives while creation is underway, publishing the child forwards the latched graceful signal to it. Each published live child receives that shutdown signal once; no managed retry or SIGKILL is introduced.
- The run loop cannot exit while child creation/publication is in flight. After publication it waits for the current child to exit gracefully. It does not remain alive solely because an already-cancelled restart had been active.
- Install signal handlers before initial startup as well. Foreground SIGINT handling is unchanged. Existing exact-session/no-replay argv and overhead budgets are unchanged; no guard or Gate contract was changed.

Shutdown tests use deterministic boundary doubles for both SIGHUP and SIGTERM at snapshot, version, prepare, prepared, old-child wait, after exit/before spawn, model sync, publication, readiness and completion. They check no success, no post-shutdown managed stop, no successor except one already being created, graceful signal delivery to that child, and no replay/force-kill. Separate concurrent runner/publication tests prove the supervisor waits both for publication and for graceful child exit. Two actual synthetic subprocess scenarios hold the old child in its graceful-stop handler, deliver external shutdown to the supervisor, release the exit, and assert no successor was created. These are real process/signal tests, not real Pi or Docker tests.

## F2 — historical result separate from current link

`hub/restart-api.ts` now preserves a validated, in-budget persisted completion as historical `succeeded / complete` even when current live lookup no longer returns the saved generation. Normal leaf progress, session switch/quit, generation rotation and Hub reopen therefore do not rewrite a completed restart as `failed / registration_timeout`.

The actionable `path` remains independently gated by current exact successor/run/session/leaf/version proof and equality with the original saved generation path. If that proof is unavailable, fails, or identifies another generation, the historical response omits `path`. No fallback to latest registration, handoff rearm, completion-time rewrite or lease extension occurs. Initial success still requires the original exact live proof within the immutable 210-second execution window. Grant revocation is checked before and after live-proof awaits, including historical queries.

Because persisted evidence can now establish history without a current live match, new completion records explicitly bind the operation ID, run, original generation/runtime/session/leaf and immutable `started_at`, in addition to verified time, successor runtime/version/path. Queries validate this binding and the in-budget, nonfuture completion time. Mismatched/corrupt/transplanted identity fields fail closed. This is not a claim to defend against an administrator able to rewrite every Hub-private receipt and credential.

`hub/portal.ts` explains historical success with an unavailable current link instead of displaying a restart failure. Polling explicitly clears the previous `path` before merging the new result, so an omitted path cannot leave a stale actionable link cached from the submission response. No new API status or frontend transport event was needed.

Operating wording in `docs/managed-pi-restart.md` and `docs/hub.md` now distinguishes initial proof, persistent historical outcome and current link availability, and documents monotonic external shutdown.

### Completion-record compatibility concern

The earlier development-only `.verified.json` format lacks the new receipt/identity binding. Such pre-fix records now fail closed rather than being silently promoted to historical authority. No automatic migration, deletion, fabricated completion or production-state mutation was added. The reviewed feature/source installation remains unapplied; controller integration should create fresh operations with corrected source. If preserving records created by an earlier development build becomes a separate requirement, an explicit evidence-preserving migration needs review rather than bypassing these checks.

## Exact edited paths

In `/home/fate/gitproject/codex_project_v2/pi-web-ui`:

- `hub/restart-api.ts`
- `hub/portal.ts`
- `tests/hub-restart-api.test.ts`
- `tests/hub-portal-management.test.ts`
- `docs/managed-pi-restart.md`
- `docs/hub.md`
- `docs/validation/managed-restart-final-fix-report.md`

In `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker`:

- `runtime/pi_supervisor.py` — existing staged path, changed.
- `tests/test_shutdown_races.py` — **new staged path**, add to baseline/source-install manifest and regenerated patch.

Final staged SHA-256:

```text
d3c259e1dc0462699d77724173d1940111405842669addca6f1f14bdecb11ce0  runtime/pi_supervisor.py
fcd63f97642972a852eb67e3b3d7d2a5e9aa1cf8da80bb4055389f1b1b034ba6  tests/test_shutdown_races.py
```

No edits to canonical/staged guard, staged Gate, main-owned integration harnesses, build manifests, dist, installation patch/manifest or production `docker_files`.

## RED / GREEN evidence

### F1 RED

From staged `pi-docker`:

```sh
/usr/bin/python3 -B -m unittest discover -s tests -p test_shutdown_races.py -v
```

Before the runtime fix: **3 test methods, 26 failing subcases** (0.575s). Twenty signal × blocking-boundary cases published `succeeded` after shutdown. Four admission/reserved cases did not reject after shutdown. Both real subprocess cases spawned the deliberately distinguishable successor, returning its exit19 instead of old-child exit0. The later concurrent runner/publication test adds two more scenarios to the final coverage.

### F2 RED

From `pi-web-ui`:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='historical|persisted completion' tests/hub-restart-api.test.ts tests/hub-portal-management.test.ts
```

Before the Hub/portal fix: **8 tests, 1 pass / 7 fail** (0.635s). Five progress/switch/exit/rotation/reopen cases rewrote success to failure; the completion-binding case accepted a mismatched operation ID; the portal kept the old link when the next response omitted it. The revocation-during-live-proof control already passed.

## Fresh focused verification

From staged `pi-docker`:

```sh
/usr/bin/python3 -B -m unittest discover -s tests -p test_shutdown_races.py -v
```

**4/4 methods PASS, 28 signal/boundary/admission/publication/subprocess scenarios, 0.677s** on the final test/source files.

```sh
/usr/bin/python3 -B -m unittest discover -s tests -p test_pi_supervisor.py -v
```

**21/21 PASS, 13.908s**, including foreground SIGINT, normal exit, stop timeout without kill/second child, exact identity, no prompt replay, no retry, and loaded-version mismatch.

```sh
/usr/bin/python3 -B -m unittest discover -s tests -p test_guard_overheads.py -v
```

**6/6 PASS, 0.007s**, retaining pre-stop deadline checks, bounded model-sync overhead and fixed preload behavior. These three focused Python files total31 test methods; no broad staged/Gate suite was rerun.

From `pi-web-ui`:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec tests/hub-restart-api.test.ts tests/hub-portal-management.test.ts tests/pi-client-managed-restart.test.ts
```

**41/41 PASS, 0 failures/cancellations/skips, 2.629s** after formatting. Includes history before/after deadline passage, actual local Hub close/reopen, byte-unchanged persisted completion, omitted unsafe links, stale handoff denial, unchanged submission count, mismatched completion/operation fields, unauthorized queries, grant revocation, initial exact proof, successor races and 15/120-second browser clocks.

```sh
node_modules/.bin/tsc -p tsconfig.connection.json --noEmit
node_modules/.bin/biome check --diagnostic-level=error hub/restart-api.ts hub/portal.ts tests/hub-restart-api.test.ts tests/hub-portal-management.test.ts
```

Both **PASS, exit0**. Biome checked4 files without changes. Existing Node module-type warnings remain; error-level lint is not a zero-warning claim. Listener/process tests used approved sandbox escalation for isolated temporary fixtures only.

## Handoff and remaining acceptance

- Source installation remains **disabled**. The prepared26-path patch/manifest is stale and **must not be applied**. Regenerate against corrected source, include the new `pi-docker/tests/test_shutdown_races.py` path, and obtain focused final re-review before any authorized installation.
- Main owns testimage/dist rebuild, full suites, stable full-browser repetitions, visual verification of the new unavailable-link text, and regenerated source-install artifacts. These were not duplicated or claimed complete by this worker.
- F2 fixtures use real local Hub HTTP/WS and registration proof with a synthetic lifecycle provider/backend; they are not real-Pi/mobile-browser evidence. The portal check is a behavior test, not a screenshot review.
- No known focused F1/F2 test failure remains. The old development completion-record compatibility boundary above is intentional and explicit.
- Graceful shutdown is not a promise that an unresponsive child or uninterruptible OS creation call can be forcibly completed: the supervisor still does not kill Pi or retry a successor. It waits for an in-flight creation to publish and for the graceful child exit.
- Accepted separate-origin, conservative-guard, exact-successor and fixed-clock architecture remains unchanged. No production activation, new privileges, policy enablement or deployment is implied.
