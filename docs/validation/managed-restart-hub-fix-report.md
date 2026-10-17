# Managed restart Hub security fix round1

Date: 2026-10-17. Worker status: **DONE_WITH_CONCERNS** (source and scoped verification complete; main-owned final build/dist, full-chain Gate/browser integration, visual acceptance and independent review remain outside this worker).

Requirements read: fix brief first, original six findings, approved plan, security rulings, progress ledger, repository AGENTS, and the complete subsequent timing ruling. The later explicit coalesced-report ruling is applied. Existing work was preserved. No Git commands, child agents, installs, production operations, Gate edits or live credentials were used.

## Implemented fences

- **F1:** strict optional `management: {port, publicUrl?}`; a dedicated 127.0.0.1 listener, including port0 testing, exposes a trailing-slash local `managementUrl` in `startHub` and CLI serve JSON. Effective local/public origins cannot overlap chat. Public management configuration requires canonical chat publicUrl. No management configuration means no HTTP management authority even with a provider configured. Chat status exposes only unavailable/unauthorized plus a canonical management URL hint; chat has no pairing form/API. Trusted management routes cannot proxy Pi content, arbitrary redirects, files, WebSockets, CONNECT tunnels or service workers. Management Host/Origin are checked against its own origins, with exact Origin/Host pairing on writes and retained cookie/CSRF checks. There is no CORS grant to chat. Both directions of upstream forwarding exclude `x-pi-hub-*`; request Cookie/Authorization and response Set-Cookie remain stripped. Portal session links and restored links use canonical chat URLs. Optional list runtime projection contains only version/managed; omitted runtime retains legacy JSON shape.
- **F2:** after asynchronous backend proof, successor selection rechecks current run, runtime, saved session, leaf, version and managed capability. Same-object registration renewal cannot satisfy the earlier comparison.
- **F4:** capture the original management key/epoch/CSRF/expiry and revalidate after body and proof waits, then immediately before receipt persistence, arming and submission. A withdrawn pre-submission authorization produces no POST or handoff; an owned but unsubmitted receipt is removed. A lost reply after submission still preserves its query-only receipt.
- **F5:** initial provider submission results use the same completion resolver as subsequent queries. Terminal Gate success cannot become Hub restoration without the full identity and live-proof checks.
- **F3:** fixed image-owned/root-owned preload in the supervisor's own directory, before SDK/extension loading, on initial and successor startup. Version probing also uses the guarded Node options. Arbitrary inherited preloads/loaders are rejected; only the audited explicit V8 memory-limit options are preserved. No environment-controlled guard path and no `.env` loading. Immutable global handle, exact supported transport/version checks, permanent uncertainty before forwarding input, permanent observed-displacement taint, no speculative buffering/replay, operation-and-adapter-owned barrier/release, non-extending lease, and shutdown suppression. `user_bash` and unaudited Web command dispatch taint. Runtime snapshots are ineligible when missing/incompatible/displaced/uncertain or on an unaudited SDK version; existing fresh identity, idle/pending/mutation checks remain. Serialized replies, including the newline/envelope, are bounded to16KiB before prepare acquires its barrier. Web mutations and extension UI responses remain blocked while stopping.
- **F6:** validated Unix-millisecond `started_at`, mandatory for running/succeeded, positive safe integer and at most5s ahead of the Hub clock. First observation is privately persisted in `<id>.started.json`; changed timestamps or loss of a previously observed timestamp fail closed. Exact registration readiness uses `started_at+210000`, not receipt or first-poll time. Pending handoff stays prepared while old generation/socket is live; its non-extending210s lease activates on retirement/disconnection. PiClient records120s on control but starts the deadline at old-WebSocket close; ordinary15s remains. Terminal failed jobs remove armed handoff state. A restoration proved within budget has a private `<id>.verified.json` record, so later authenticated queries do not retroactively change a completed restoration solely due to elapsed time; they still require the same live successor proof and do not renew the handoff lease.
- **Supervisor overhead ruling:**15s pre-stop deadline is established when accepting an operation and rechecked after prepare and immediately before SIGTERM. A late worker cannot start checking/stopping. Model sync runs in a bounded disposable helper; sync+spawn have a separate10s overhead budget before120s readiness. Overrun returns failed/recovery_required without a forced Pi kill, repeated stop or second submission. Readiness is checked again after snapshot waits.

## Exact edited/added files

Within `pi-web-ui`:

```text
bin/pi-web-hub.mjs
hub/config.ts
hub/lifecycle.ts
hub/management.ts
hub/portal.ts
hub/restart-api.ts
hub/server.ts
extensions/mirror-server.ts
extensions/runtime-control.ts
src/web/src/core/pi-client.ts
tests/hub-management-origin.test.ts                   (new)
tests/hub-management.test.ts
tests/hub-portal-management.test.ts
tests/hub-restart-api.test.ts
tests/pi-client-managed-restart.test.ts
tests/runtime-control.test.ts
tests/runtime-guard-process.test.ts                   (new)
e2e/fixtures/stdin-guard-probe.ts                      (new)
e2e/harness/test-stdin-guard-tui.py                    (new)
docs/hub.md
docs/validation/managed-restart-hub-fix-report.md      (new)
```

Within sibling `pi-runtime-restart-work/pi-docker`:

```text
Dockerfile
runtime/pi_supervisor.py
runtime/pi_stdin_guard.mjs                           (new)
tests/test_guard_overheads.py                        (new)
tests/test_stdin_guard.mjs                           (new)
```

The main-owned runtime/Gate/hostile-management harnesses were only read/reused, never edited. No build/dist/manifest/tsconfig/ledger/review-package edits were made. `docs/managed-pi-restart.md`, staged Gate and host `docker_files` were untouched. A temporary synthetic input-tracing wrapper was removed before final verification; no production input logging remains.

## RED evidence and corrections

1. `node --import ./tests/register-ts.mjs --test tests/hub-restart-api.test.ts`: initial **4 pass /7 fail**. Two terminal POSTs incorrectly returned succeeded; revocation during proof returned202; four same-generation tuple mutations returned succeeded. After fixes the initial11 tests passed.
2. `... --test tests/hub-management-origin.test.ts`: **0 pass /3 fail**, showing absent separate listener, chat still exposing unlock, and accepted unsafe configuration. Final origin tests pass. A raw Host-header test was corrected to use Node HTTP because fetch did not retain its supplied Host; this was a fixture correction, not relaxation of the assertion.
3. `node --test tests/test_stdin_guard.mjs` in staged pi-docker: initial **0 pass /5 fail**, missing fixed preload. Additional observed-displacement test failed before the permanent displacement latch; additional coalesced-report test failed before the narrowly bounded packet allowlist. Final **7/7 pass**.
4. `python3 -m unittest discover -s tests -p test_guard_overheads.py -v`: inherited require/import/loader options were initially accepted and fixed guard options missing; bounded-helper entrypoint was absent. The first clock fixture also exhausted its fake clock while executing the old unbounded path; it was corrected to mock successor creation and represent pre-check/post-prepare times explicitly. Final expanded **6/6 pass**, included in the full staged suite below.
5. `... --test tests/pi-client-managed-restart.test.ts tests/hub-restart-api.test.ts`: timing RED **11 pass /3 fail**—200s approval delay exhausted readiness, invalid/mutable started_at was accepted, and browser close had0ms remaining. Final tests cover >3min pending, valid recovery after160s execution,210s expiry, non-renewing handoff, and ordinary15s behavior.
6. Adapter process regression for oversized prepare initially left `adapter.prepared=true` despite rejecting the reply. Final size validation happens before barrier acquisition; all9 adapter process scenarios pass.
7. Previously verified completion initially turned failed at210s on a later query. The new regression failed with `failed !== succeeded`; verified-within-budget evidence now persists while live identity is still rechecked.

## Synthetic terminal packet investigation

The unchanged main launcher initially reached version1.1.0/idle=true/pending=false/busy=true without user keys. A temporary **synthetic-only** pre-SDK observer captured one data packet containing two complete primary-DA reports: `1b5b3f313b32631b5b3f313b3263` (`ESC[?1;2c` twice). Separating writes demonstrated the coalescing cause, but that fixture timing workaround was removed.

The later binding ruling allows an entire packet of at most4 complete audited `ESC[1;1R` / `ESC[?1;2c` reports, at most28bytes. The final guard accepts only this exact anchored grammar. More than4 reports, unknown CSI, truncated reports, paste, or any user bytes mixed with reports taint immediately before downstream emission. Tests include these positive and negative cases. Final TUI tests reuse the original main launcher/drainer with no inserted reply delays.

## Final worker verification

Run from `pi-web-ui` unless noted:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec \
  tests/hub-*.test.ts tests/session-hub.test.ts tests/session-registration.test.ts \
  tests/runtime-control.test.ts tests/runtime-guard-process.test.ts \
  tests/pi-client-managed-restart.test.ts
```

**104 tests,104 pass,0 fail,0 cancelled,0 skipped** (6.060s). Includes the authorization body/proof × revoke/logout/expiry matrix; zero provider POSTs and no receipt; exact tuple-renewal races; management default-disabled/origin/config checks; initial terminal-success verification; pending/started_at/handoff clocks; safe canonical links; existing Hub and registration regressions; missing/incompatible/displaced/tainted/unsupported-version guards; reply bound; lease/stale-cleanup/shutdown tests.

```sh
# In pi-runtime-restart-work/pi-docker
/usr/bin/python3 -m unittest discover -s tests -v
node --test tests/test_stdin_guard.mjs
```

Python: **71 tests,68 pass,3 existing opt-in skips,0 failures/errors** (21.163s). The skips require explicitly enabled real Docker/live-local-Hub fixtures and were not enabled by this worker. Guard Node processes: **7/7 pass**,0 fail.

```sh
/usr/bin/python3 e2e/harness/test-stdin-guard-tui.py
```

**3/3 real TUI tests pass** (3.883s): in-progress bash is ineligible and remains so after finishing; prepared built-in/extension input cannot mutate and is not replayed on cancel; arbitrary Web command observes taint before dispatch, survives reload, and `/quit` exits normally. Isolated temporary saved conversations, faux provider and synthetic credentials only; no user installation/session used.

```sh
node --import ./tests/register-ts.mjs e2e/harness/hostile-management.ts
```

Reused main-owned Chromium fixture, unchanged. Final result:

```json
{"isolatedOrigins":true,"secretReadableFromPi":false,"unauthorizedPosts":0,"hostileWorkerIsolated":true,"realBrowser":true,"syntheticOnly":true}
```

`node_modules/.bin/tsc -p tsconfig.connection.json --noEmit`: **exit0**. Scoped Biome check/format over edited TS/JS source/tests: **exit0 at error diagnostic level**; existing warning-level `any`/non-null style diagnostics remain in test code. Node emits the existing MODULE_TYPELESS_PACKAGE_JSON warning. No warning was represented as an assertion failure or silently fixed through package metadata changes.

Main independently reported its rebuilt-image two-Pi Docker fixture passing1 test in3.835s after the packet correction, including initial eligibility, exact saved leaf, changed runtime, same container ID, UID1000 writes, other Pi unchanged, no replay and normal quit. This is **main-supplied evidence**, not a Docker run by this worker, and precedes final main build/full-chain acceptance.

## Remaining boundaries / handoff to main

- No known failing scoped assertion remains. Main still owns final full repository suite/build/dist verification, full Gate+two-Docker+mobile-browser scenario, visual review and independent review; this report does not certify those pending results or production readiness.
- Gate's separately queued210s transport/deadline refinement was not edited. Coordinate the final shared timing contract before enabling management.
- A distinct authenticated HTTPS management origin is an explicit deployment prerequisite. Nothing here provisions DNS/Caddy/TLS or activates management in an existing deployment.
- Supported terminal transport is intentionally restricted to audited Pi/pi-tui1.1.0. Applying an installed newer SDK can complete exact successor restoration, but that new process is not eligible for another remote restart until its transport is audited. Terminal input uncertainty remains process-lifetime, not temporary busy state; local restart is required. Neither shared UID nor this guard isolates malicious in-process code or arbitrary alternate direct-fd readers.
- Guard-specific Node tests intentionally import the actual staged preload from the adjacent `pi-runtime-restart-work/pi-docker/runtime` tree. That source tree must be present for these coordinated-source tests; do not replace it with an unverified stub or silently skip the security regressions when assembling the review/CI fixture.
- Main documentation should retain both private sidecar records (`started` and `verified`) alongside each receipt in retention/backup guidance. They are internal identities/timing only, never credentials or session-file paths.

Process skills used: executing the approved bounded plan, systematic root-cause investigation, regression-first fixes and verification-before-completion; Docker guidance applied to image-owned preload placement. No repeat design approval, Git/worktree mutation, or subagent review was attempted because the dispatch explicitly prohibited those operations and main handles independent integration/review.
