# Managed restart — fresh whole-branch final review

Date: 2026-10-17. Reviewer role: independent senior reviewer, not implementer.

## Verdict

**Spec: REQUEST CHANGES. Quality / ready-to-commit: NOT READY.** Two actionable defects remain: one P1 shutdown race and one P2 persistent-result correctness defect. Keep the prepared source installation paused. Component-scoped PASS reviews and the supplied six consecutive full-chain successes remain valid evidence of their tested scopes; they do not exercise or close these findings.

The accepted architecture does not need reopening. Separate management origin, conservative image-owned stdin guard, immutable 210-second execution clock, and ordinary 15-second recovery are appropriate boundaries in the reviewed implementation. The deployment prerequisites below are separate from the code defects and are not additional reasons to demand a redesign.

## Scope and method

Reviewed the working tree on `codex/pi-runtime-restart`, HEAD `7f4c19e1f8922eb7a5f37a3657482f4b279f90dd`, against `origin/main` `39176c9f973ea82f4017c76c8e13e5b29cf93236`. HEAD is not the implementation snapshot: the review included modified tracked files and new/untracked implementation, test and harness files, plus the staged sibling host sources.

Read the final review brief, approved design and implementation plan in full; applied the later security/timing rulings and progress-ledger refinements, including the bounded coalesced terminal-report exemption. Reviewed the progress/evidence ledger, final component-review reports, relevant correction reports and mount-order diagnosis as evidence rather than substitutes for source inspection.

Source review covered:

- Hub configuration, management pairing/session state, lifecycle client, restart receipts, HTTP/WS routing, portal and CLI.
- Extension snapshot/prepare/cancel adapter, canonical stdin preload, metadata/registration and surrounding mirror dispatch, upload, session-start and shutdown paths.
- Browser handoff/reconnect state and protocol types.
- Manifest/build/install changes, package inventory, typecheck/lint scope and changed registration/distribution/upload tests. Distribution correspondence was checked by the repository's read-only verifier; minified assets were not manually line-reviewed or independently rebuilt.
- All new management/lifecycle/restart/guard/browser-client unit-test files, the real-runtime/Gate/browser/hostile-origin/visual/guard harnesses and guard fixture.
- Staged Pi supervisor, control client, launch policy, model synchronization, Dockerfile, entrypoint, launcher and relevant tests; staged Gate lifecycle/contract, Engine, ledger, service/admin, gatectl, README and lifecycle/upgrade regressions, compared with the original host source.
- Operating/deployment documentation, Hub documentation and ADR0013.

No subagents, Git mutations, source edits, installs, live Docker operations, network/production calls, or full-suite reruns were performed. Only this report was written. The two new probes evaluated actual source with in-memory boundary doubles; they opened no listeners, sent no real process signals, launched no Pi/Docker processes and wrote no probe files. Python bytecode writes were disabled. Docker/Pi connection guidance informed the boundary review; systematic-debugging and verification guidance required reproducing the findings and distinguishing independent observations from supplied results.

## Findings

### F1 — P1: external shutdown does not cancel an in-flight restart before successor spawn

**Primary location:** [pi_supervisor.py:507](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:507), through the unconditional successor spawn at line 513.

**Related locations:** [forward_signal:615](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:615), [run loop:638](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:638), and the [spawn/publication boundary:237](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:237).

`forward_signal()` sets `stop_event` and forwards SIGHUP/SIGTERM to the child it currently sees. However, `perform_restart()` does not consult that event, and `run()` does not use it as a shutdown condition. If external shutdown arrives while the restart worker is waiting for the old child to exit—or after that exit but before successor creation—the worker proceeds through model synchronization and creates a new Pi. The newly spawned child did not receive the earlier signal. The main loop continues waiting for that child, while `serve()` has been told to stop accepting control requests.

This violates the explicit requirement that terminal closure and explicit stopping exit the managed run, rather than resurrecting Pi. It can leave a replacement running after the operator requested shutdown, without a functioning control service; an external container stop may subsequently resort to its own termination timeout. This is a lifecycle correctness defect, not a claim of credential bypass or arbitrary process execution.

**Independent reproduction:** imported the current supervisor with bytecode writes disabled, constructed it with a synthetic run ID, and used process doubles for the old/new child. Reserved a normal restart; made the old child's `wait()` deliver `forward_signal()` before returning; kept checking/sync/snapshot boundaries synthetic. For each signal, the actual `perform_restart()` produced:

```text
SIGHUP:  shutdown_latched=True, successor_spawn_count=1, result=succeeded
SIGTERM: shutdown_latched=True, successor_spawn_count=1, result=succeeded
```

This reproduces the missing cancellation decision without sending signals to real processes. Source inspection also shows the narrower publication race: a signal can observe the exited old child while `Popen` is in progress and before `self.child` is updated.

**Fix guidance:** make external shutdown a monotonic cancellation state shared by admission, the worker and child publication. Check it after blocking phases and before successor creation; coordinate the spawn/publication race so shutdown during creation reaches the newly created child gracefully. Once shutdown wins, do not declare successful restart or launch another successor. Preserve no-SIGKILL, no-retry and normal foreground SIGINT behavior. This is a targeted lifecycle correction, not a request for a different supervisor architecture.

**Required regression:** cover both SIGHUP and SIGTERM while checking/prepared, during old-child wait, between exit and spawn, and during spawn publication. Assert no successor after shutdown wins, or graceful shutdown of a child created concurrently; assert supervisor exit, no replay, no force-kill and no success outcome. Existing `test_pi_supervisor.py` covers ordinary child exit, SIGINT and stop timeout, but not external shutdown concurrent with restart. The six full-browser successes exercise normal restart and later `/quit`, not this race.

### F2 — P2: an already-verified successful operation is rewritten as failure when live registration changes

**Primary location:** [hub/restart-api.ts:156](/home/fate/gitproject/codex_project_v2/pi-web-ui/hub/restart-api.ts:156), especially line 169.

**Related location:** [hub/server.ts:289](/home/fate/gitproject/codex_project_v2/pi-web-ui/hub/server.ts:289), whose successor lookup requires the original session/leaf on every query.

After success has been verified within budget and `<id>.verified.json` has been saved, `resolve()` still reruns the original exact-leaf lookup and requires its route to equal the saved generation path. Normal continued conversation changes the leaf; normal session switching or quitting removes the original match; restarting Hub rotates registrations. Any of these can make a previously completed operation return `failed / registration_timeout`, even before the original deadline and even though Gate's durable job and the Hub's own completion evidence still say it succeeded.

This conflates historical operation outcome with current link eligibility. It makes reconnect/re-pair/query-only recovery misleading and can report a failure for work the user has already resumed successfully. It also clears the operation's handoff state as a side effect of querying historical success. There is no need to weaken live proof or follow a different generation to fix the historical-result error.

**Independent reproduction:** transpiled the current `restart-api.ts` into an in-memory evaluator, supplied a Map-backed filesystem and a fixed successful Gate job, and invoked the real `createRestartApi().resolve()` implementation:

```text
First matching successor:                 succeeded / complete, verified receipt saved
Same job, original leaf no longer live:   failed / registration_timeout
Same job, successor at a new generation:  failed / registration_timeout
```

The second and third calls retained the first call's completion record and unchanged immutable job identity. The changed lookup results model the concrete filtering in `hub/server.ts` and normal Hub generation retirement; this was not an actual browser or Hub restart test.

**Fix guidance:** preserve a validated, in-budget historical completion as the operation outcome. Independently withhold/expire its actionable path or report current link unavailability when live proof no longer matches. Keep grant revocation, exact-successor proof and existing handoff deadlines enforced; do not renew a lease, redirect an old capability to a newly selected route, or convert an unverified operation to success. Update the operating text that presently conflates repeat outcome queries with live identity checks.

**Required regression:** complete and persist a verified operation, then advance the successor leaf, switch/exit that session, and simulate/reopen Hub with a rotated generation. Historical status must remain succeeded for an authorized query while unauthorized/stale handoff remains denied. The current late-query regression at `tests/hub-restart-api.test.ts:580` changes only time, leaving the exact successor live, so it misses this case.

## Strengths and cross-component assessment

- **Management authority is genuinely separated.** The management listener does not proxy Pi routes, WS upgrades or worker scripts; chat does not accept management writes. Same-origin/CSRF, single-use pairing, expiring sessions and administrator revocation are separate from chat/registration credentials. Proxy request headers strip Cookie/Authorization and reserved Hub headers; backend cookie and management response headers are removed. The hostile-origin harness meaningfully exercises browser fetch, worker and opener boundaries rather than only matching source strings.
- **Execution is narrow and fail-closed.** Gate uses an independent default-disabled policy/token, exact run/runtime/session/leaf and image/container checks, a fixed non-root control argv and bounded Docker transport. Python import/cache environment restrictions protect the fixed-control path. Ordinary Hub/Pi gain no Docker/admin socket. Bind provenance remains the disclosed trusted-host/launcher boundary, not an unsupported hostile-host attestation claim.
- **No replay or implicit fallback was introduced.** Hub persists the request identity before submission and retries as queries. Gate persists intent before dispatch and reconciles through status only. Supervisor strips positional inputs and old session selectors, preserves reviewed options, requires the old child to exit before replacement and does not force-kill it on stop timeout.
- **Guard corrections are substantive.** The preload runs before SDK listeners, permanently latches uncertainty and fences prepared stdin by owner/operation. Unknown Web command expansion taints before dispatch, including omitted/false client flags. Tests include actual extracted dispatch logic and separate actual-Pi fixtures; package tests use the shipped guard rather than requiring the untracked sibling tree. Guard copies are byte-identical.
- **Clock contract is coherent.** Gate persists immutable millisecond `started_at`, bounds execution by wall and monotonic time, and limits each transport. Hub records the first start and uses 210 seconds; browser recovery starts at close and retains its separate 120-second window. Ordinary recovery remains 15 seconds. Fake-clock tests cover beyond-155-second success, expiry and non-extension. These positives do not remove F1/F2.
- **Mount normalization is appropriately narrow.** It sorts complete top-level mount entries without deduplication or input mutation. Duplicate multiplicity, unknown fields and actual mount changes remain fingerprinted; Env/Cmd and nested arrays remain ordered. The round3 tests cover admission, preflight, polling and status-only recovery. The supplied confirmed mount-order failures are not dismissed as generic flakiness; the earlier untraced timeout is still not retrospectively proven identical.
- **Old Gate migration does not silently fall back.** `gatectl up` requires a durable reservation for an existing Gate. Old Gate without that API is refused before replacement. Reservation blocks admissions/dispatch, survives restart and requires explicit finish/abort. Repeat-up forces Gate recreation and checks image/new instance before release; failures leave the reservation intact. Initial old-version migration remains an explicitly isolated administrator maintenance procedure, not an automatic upgrade feature. Pre-fix lifecycle hashes are not rewritten to conceal unresolved work.
- **Scope and packaging are controlled.** New source modules and the canonical guard participate in distribution hashing and package directories. Test-only upload keepalive changes do not alter production upload behavior. The 26-path host manifest provides a precise installation boundary; copying those files would still not build an image or activate policy.

## Evidence provenance

### Independently observed in this review

- Read-only Git branch/base/status/diff inspection, including untracked source discovery; `git diff --check origin/main` exited 0. That whitespace check covers tracked differences, not an assertion that untracked files were checked by Git.
- `node scripts/web-dist.mjs` exited 0: **source/output hash consistency verified**, not independent rebuild reproducibility or authenticity.
- All **26** staged files match the installation manifest's SHA-256 and mode; all corresponding original host files match `host_before` or are absent as declared. Manifest status is `prepared_not_applied`. No original source installation was observed.
- Package and staged image guard bytes match.
- The two bounded in-memory reproductions above demonstrate F1 and F2. These are targeted behavioral probes, not full integration reruns.

Key reviewed-source digests:

```text
hub/restart-api.ts  6e48c38399829572fdfa00c6632a0a7c7600f084848d2988902a0c7e43488c9d
hub/server.ts      afa7ad84604397d3c562505fbfc739d4a753915e94a319dc98b7e0a06370f63a
pi_supervisor.py   203f062cd4558747a183edb670d842a8963b8b604f7749851d0f56eb13da2177
```

### Supplied by the controller/reports; not independently rerun

| Evidence | Reported result |
| --- | --- |
| Final Node unit rerun | 384 total; 383 pass; 1 opt-in skip; 9576 ms |
| Full Gate | 269 pass; 54.457 s |
| Final staged Pi Python | 71 total; 68 pass; 3 opt-in skips |
| Actual two-Docker runtime | Pass; 3.819 s |
| Actual Pi TUI guard | 6 pass |
| Actual Gate + packaged Hub + two Docker/Pi + Chromium at width 390 | Six consecutive successes: two batches of 3, 27.392 s and 25.523 s |
| Typechecks, build, distribution and error-level Biome | Controller reports pass; final Biome covered 225 files; not a claim of zero warnings |
| Hostile Chromium and visual checks | Controller reports origin isolation and readable 390/1365 layouts without overflow/page errors |
| Exact host-source installation patch | Controller reports dry application to temporary original-source copies, all 26 byte comparisons matching staged source |

The patch dry-application was not repeated by this reviewer. Browser fixtures demonstrate the tested local isolated chain, not deployed HTTPS/mobile-device acceptance or universal reliability. The real runtime fixture primarily exercises current-version restart; fake-process tests exercise differing executable versions. No fresh production or actual new-release upgrade claim is made here.

## Exact host-source scope: 26 paths

Authoritative hashes, original baselines and modes are in `docs/validation/managed-restart-source-install-manifest.json`. Staging root is `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work`. Manifest prefix `gate/` maps to original host source `/home/fate/docker_files/pi-deploy-gate/`; `pi-docker/` maps to `/home/fate/docker_files/pi-docker/`. Credentials, private state and generated caches are outside this installation scope.

```text
pi-docker/Dockerfile
pi-docker/tests/test_stdin_guard.mjs
pi-docker/tests/test_pi_supervisor.py
pi-docker/tests/test_entrypoint_models.py
pi-docker/tests/test_pirun_runtime.py
pi-docker/tests/test_guard_overheads.py
pi-docker/pi-entrypoint
pi-docker/runtime/pi_supervisor.py
pi-docker/runtime/pi-session-control
pi-docker/runtime/pi_stdin_guard.mjs
pi-docker/runtime/pi_model_sync.py
pi-docker/runtime/pi_launch_policy.py
pi-docker/scripts/pi-pirun
gate/tests/test_lifecycle_round2.py
gate/tests/test_clients.py
gate/tests/test_lifecycle.py
gate/tests/test_lifecycle_round3.py
gate/tests/test_lifecycle_round1.py
gate/gatectl
gate/README.md
gate/gate/lifecycle.py
gate/gate/service.py
gate/gate/lifecycle_contract.py
gate/gate/engine.py
gate/gate/store.py
gate/gate/admin.py
```

## Deployment prerequisites and handoff

These remain explicit prerequisites, not newly discovered code defects:

1. Provision a separate authenticated HTTPS management origin and reviewed proxy/tunnel routing; do not expose management under the chat origin.
2. Build/review the new image and explicitly recreate selected old containers when authorized. Updating the extension or `/reload` cannot install image-owned runtime files, mounts or labels.
3. Provision the lifecycle-only credential into Hub-private storage, retain grants/ledger/state and enable the independent image-allowlisted policy explicitly. Default remains disabled.
4. Migrate an older Gate only in the documented isolated maintenance window with private-state/old-image backups; do not bypass unavailable reservations using a status snapshot. Source installation is not production activation.
5. Retain the guard's audited-transport/version limitation and manual recovery/no-downgrade constraints. Validate a future executable release before claiming managed eligibility for that release.

**Recommended disposition:** fix F1 and F2 within their existing components, add the specified focused regressions, rebuild/reverify affected packaged artifacts, refresh the exact host-source patch/manifest where changed, and obtain focused re-review. Preserve the supplied stable-browser evidence but run the relevant integration acceptance after the fixes through the controller's authorized workflow. Do not install the currently prepared source set or describe this branch as ready-to-commit on the strength of the prior scoped PASS results alone.
