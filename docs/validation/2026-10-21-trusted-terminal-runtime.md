# Trusted terminal runtime — candidate verification and final fix

The original Task7 results below are **historical evidence for the pre-fix
candidate**, not acceptance of modified bytes. See the dated final whole-branch
fix section at the end for refreshed browser, package and installed-native
evidence on BASE `be3f7158bfd472d9a3464a2dee85896d5c3b5516`. Complete postmerge
Node verification and independent fix-only re-review remain controller-owned.

## Historical Task7 candidate (before final whole-branch readiness fix)

Executed 2026-10-22 on `codex/trusted-terminal-runtime`, starting at
`1a97213908e9789f531f5259312e7f70220f6659` after controller acceptance of Task6
and its independent R1 fix review. The 2026-10-21 filename identifies the approved
design, not the execution date. Independent Task7 and whole-branch reviews are
controller-owned and remain pending at this implementation handoff.

This verifies source and an isolated installed native chain, **not production
activation**. Ordinary `pirun` remains unchanged; the opt-in profile is default-off
and ordinary browser chat is read-only **from startup**, independently of the
later successful terminal-prepare latch. No SDK completion heuristic is claimed.

## Bounded changes and behavioral RED/GREEN

Only two fixture defects were repaired; production runtime/fallback/provider,
external policies and dependency metadata were not changed.

| Fixture | Actual RED | Actual GREEN | Scope |
| --- | --- | --- | --- |
| `tests/web-connection.test.ts` | 11 tests: 10 pass, 1 fail; exit 1 | 11/11; exit 0 | Real TCP listeners and unchanged production fallback |
| R3 native cleanup evidence | 10 tests: 9 pass, 1 fail; exit 1 | 10/10; exit 0 | Real `Stack.close`, files, persistence and retry; mocked Docker boundary |

Port RED closed an owned offset-one transient after the old allocator skipped
its failed bind. Correct production fallback then selected the hole, failing
`all twelve blockers must outlive a transient collision`. This reproduces the
invalid lifetime assumption, not the identity of a historical external occupant.
The corrected allocator retains its first ephemeral socket, rejects a whole
candidate on **any** collision or range above 65535, closes only owned candidate
sockets, and selects another range under 50 attempts / 5 seconds. All twelve
owned blockers remain listening through fallback and close in `finally`. The
regression also verifies that collision handling never closes the other occupant.

R3 RED populated actual native-event/effect files, failed the cleanup probe,
captured the records and removed the temporary source, then retried real cleanup.
Retry overwrote the event list with `[]`. The narrow fix preserves previously
captured records when each source is absent, while reading a present source
normally. All nine prior cleanup cases remain. The regression explicitly checks
that retaining native records does **not** invent a successful socket proof.

Commands, with logs at `/tmp/pi-task7-{port,r3}-{red,green}.log`:

```sh
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test tests/web-connection.test.ts
env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p test_task6_native_cleanup.py -v
```

An earlier restricted Node invocation produced only a file-level failure and is
not counted as behavioral RED. The permission-aware run above produced the
expected assertion. Scoped Biome formatting made no changes.

## Final executable gates

All final results below are executed on the same finalized fixture/source/build
candidate. They are separate suites, **not an invented combined test total**.

| Gate | Actual result | Raw log |
| --- | --- | --- |
| Complete Node suite, final bounded-concurrency run | 753 total: 752 pass, 1 skip, 0 fail/cancel; 48.617 s; exit 0 | `/tmp/pi-task7-unit-final.log` |
| Runtime Python PTY suite | 31/31; 82.714 s; exit 0 | `/tmp/pi-task7-pty.log` |
| Full external Gate suite | 373/373; 89.600 s; exit 0 | `/tmp/pi-task7-gate.log` |
| Full external launcher/supervisor suite | 143 run: 140 pass, 3 skip; 33.364 s; exit 0 | `/tmp/pi-task7-pi-docker.log` |
| Supplemental gateway Python | 19 run: 15 pass, 4 skip; 0.293 s; exit 0 | `/tmp/pi-task7-gateway.log` |
| Default web TypeScript | Passed inside `build:web`; exit 0 | `/tmp/pi-task7-build.log` |
| Connection/E2E TypeScript | Passed; exit 0 | `/tmp/pi-task7-types-connection.log` |
| Full Biome | 317 files, 0 errors, 32 warnings / 7 infos; exit 0 | `/tmp/pi-task7-biome.log` |
| Production build | Passed; existing large-chunk warning; exit 0 | `/tmp/pi-task7-build.log` |
| Dist correspondence | Passed; exit 0 | `/tmp/pi-task7-dist.log` |
| BDD generation | Passed; exit 0 | `/tmp/pi-task7-bdd-gen.log` |
| Clean production Git install/update + tarball + installed Hub | Passed; 18 stale-input rejections; exit 0 | `/tmp/pi-task7-install.log` |
| Final actual native BDD, **one invocation** | 1/1; 30.5 s scenario / 31.6 s runner; exit 0 | `/tmp/pi-task7-native.log` |
| External/report provenance | 33/33 hashes match; exit 0 | `/tmp/pi-task7-provenance-before.log` |

Primary commands (run asynchronously and all sessions collected):

```sh
NODE_OPTIONS='' npm run build:web
NODE_OPTIONS='' node_modules/.bin/tsc --noEmit -p tsconfig.connection.json
NODE_OPTIONS='' node_modules/.bin/biome check .
NODE_OPTIONS='' npm run verify:dist
NODE_OPTIONS='' npm run e2e:gen
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test --test-concurrency=4 tests/*.test.ts tests/*.test.mjs src/web/src/core/i18n.test.ts src/web/src/components/pi-web-ui/sidebar-tree.test.ts
env PYTHONDONTWRITEBYTECODE=1 NODE_OPTIONS='' /usr/bin/python3 -m unittest discover -s tests -p test_terminal_runtime.py -v
# In each unchanged external Gate / pi-docker source directory:
env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -v
env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p 'test_gateway*.py' -v
```

`build:web` runs `tsc --noEmit` for the default configuration before building.
Thus both TypeScript configurations ran; equivalent checks are not counted
again as an additional `just check` run. Rebuilding produced **no dist delta**:
the fixture/docs changes are outside the release inventory, and deterministic
outputs already matched the finalized runtime sources.

### Initial full Node timeout: disclosed, diagnosed, then closed by a full pass

The initial `NODE_OPTIONS='' npm run test:unit` was **not green**: 753 total,
751 pass, 1 skip, 1 cancelled, exit 1, 63.613 s. The raw block at
`/tmp/pi-task7-unit.log:679..688` identifies
`tests/hub-bounded-registry.test.ts:110`, “thousands of bounded rotations compact
one run record and never revive discarded URLs”: `testTimeoutFailure` at
60009.477482 ms against its existing 60000 ms bound. There were no failed
assertions, but cancellation is a failed gate, not a pass.

The unchanged 2000-rotation test passed alone in 33.259 s. A second focused
timing diagnostic forwarded **every real fsync call**, without bypassing writes,
changing results or altering assertions: 8020 calls spent 24372.786 ms in fsync,
maximum 180.106 ms, during a 33688.672 ms process; the test passed in 33550.648 ms.
Logs: `/tmp/pi-task7-registry-diagnostic.log` and
`/tmp/pi-task7-registry-profile.log`; temporary timing preload:
`/tmp/pi-task7-fsync-profile.mjs`. Task6's historical same-test duration was
53596.753 ms. This establishes real durable-I/O cost and resource-sensitive
wall time; the original cancelled process was not profiled, so its precise
per-syscall delay is **not** retrospectively asserted.

The smallest correction was execution scheduling, not another source patch:
run the complete Node gate alone with four-file concurrency. The same 2000
rotations, 60-second deadline, real protocol/crypto/durable writer, bounds,
tombstones and all assertions remained intact. The final full run passed with
this test at 45369.937 ms. No timeout increase/removal, production shortcut,
fsync stub, reduced iteration count or focused-pass substitution was used.
No other broad gate or native BDD was repeated.

### Actual skips

- Node: the existing opt-in 1 GiB upload stress case,
  `PI_WEB_UPLOAD_TEST_1GIB`, was not enabled.
- Pi: one `PI_REAL_HUB_TEST=1` case requires the existing local Docker Hub;
  two `PI_REAL_DOCKER_TEST=1` cases use shared/production-named volumes. These
  were deliberately not enabled. The new native gate used disposable resources.
- Supplemental gateway: three optional real Caddy cases require
  `CADDY_TEST_BIN`; one distinct-GID test reported inability to assign an
  already-held group on its temporary file. None is a terminal/provider skip.
- Runtime PTY, Gate, cleanup GREEN and final native BDD had no skips.

## Named acceptance coverage map

These files ran within the **final full Node run**, not a redundantly summed
terminal subset. Controlled-boundary tests and real installed-native proof are
kept distinct.

| Requirement | Fresh covering tests / evidence | Evidence boundary |
| --- | --- | --- |
| Startup browser rejection before SDK/tool/upload effects; ordinary chat still works; latch distinct from policy | `terminal-barrier-integration.test.ts`: real SDK rejects browser prompt/command before prepare, checks actual messages/events, then prepares and operates a dialog; ordinary inherited-tui produces an actual assistant response. `terminal-barrier-mirror.test.ts`, `terminal-barrier.test.ts`, callbacks/broker tests cover both browser connections, queued/unknown work, failed prepare and reload. | SDK/RPC integration + real mirror controlled contexts; final native BDD separately proves installed TUI and startup read-only UI, not a new browser-prompt rejection assertion in that BDD. |
| Wrong origin/CSRF/scope/epoch, pairing/revocation, fixed target, tabs, deadlines | `hub-terminal.test.ts`, `hub-terminal-server.test.ts`, `hub-terminal-provider.test.ts`, `terminal-lease.test.ts`: private tokens, single-use nonce, two readers/one writer, pending first-frame limits, expiry, revocation during pending acquire and no retarget/resurrection. | Real HTTP/WS/private sockets with controlled backend where documented; not public DNS/device proof. |
| Local reclaim, fixed lease expiry, unknown delivery/no replay | Lease tests; PTY `same_child_local_handoff_remote_input_and_reclaim`, `lease_expires_without_input_renewal_and_old_sequence_is_not_replayed`, `pty_backpressure_is_unknown_and_revokes_without_retry`; provider missing input ACK; final native local reclaim/no MUST_NOT_EXECUTE/local command/new explicit handoff. | Fixed 30-second expiry is covered in lease/PTY tests, not falsely attributed to waiting 30 seconds in native BDD. |
| 8 KiB inputs, 32 KiB chunks, 256 KiB queues, parser/snapshot 1 MiB, bounded screen/scrollback | `terminal-lease.test.ts`, `terminal-runtime.test.ts`, `terminal-screen.test.ts`: UTF-8/schema budgets, queue/backlog boundaries, actual serialize expansion >1 MiB fails, 1000-line scrollback, query/OSC exclusion. PTY chunking/reader limit/output flood/slow reader tests; Gate full provider framing/deadline cases. | Real parser/PTY and controlled external boundaries; no unlimited-output or RSS performance guarantee. |
| Task5 R1 render/draft/ID regressions | All 19 actual cases in `hub-terminal-browser.test.ts`: delayed render succession, 256 KiB queue, deadline, malformed queued snapshot, draft revision/fixed-key preservation and exact numeric response IDs. | Browser application boundary/real validators, not installed-provider proof. |
| Shutdown, signals, termios, descendants, orphan helper/socket | Full 31-case Python PTY suite: signal resize/termios restore, raw Ctrl+C/canonical EOF, final drain and hung-up-TTY deadlines, descendant groups, fixed client EOF. Native evidence: actual same child exit 0, helper gone, sockets removed, empty owned resources. Cleanup fault tests: retry and R3 preservation. | Synthetic PTY stress + separate real installed Pi exit; no claim every real extension/signal/device combination ran in native BDD. |
| Default-disabled, trusted admission, independent refresh refusal | Full Gate `test_terminal_admission.py`, `test_terminal_provider.py`, `test_terminal_preflight.py`, lifecycle/runtime-update suites; Pi supervisor/launcher terminal and ordinary cases. | No live provider activation, policy edit or existing-container migration. |
| Main bounded-state/history regression budgets preserved | `hub-state-budget.test.ts`, `hub-bounded-registry.test.ts`, `hub-forward-queue.test.ts`, `hub-transfer.test.ts`, `session-history.test.ts`, `history-store.test.ts`, `history-dates.test.ts`, `entry-detail.test.ts`, `live-transport.test.ts` and other full-suite files. | Existing Hub 8 MiB / 512 grants, history 256 KiB, detail 64 KiB, browser 200 entries / 512 KiB and existing FIFO/tombstones remain unchanged. |

## Clean production installation: no package or registry substitutes

First ran a bounded official npm metadata preflight. It returned
`@xterm/addon-serialize@0.14.0` version `0.14.0`, exit 0. The audited wrapper
`/tmp/pi-task7-install.mjs` preserves only existing **nonempty** PATH/LANG/HOME
and proxy keys; it does not synthesize empty lowercase proxies. It explicitly
sets empty `NODE_OPTIONS`, npm userconfig `/dev/null`, a **distinct nonexistent**
globalconfig under a fresh `/tmp` root, official npm registry, proven temporary
cache `/tmp/pi-install-prerequisite-anGuK3/npm-cache`, `GIT_CONFIG_GLOBAL=/dev/null`
and `GIT_CONFIG_NOSYSTEM=1`. No user npm/Git settings or token was supplied.
`PI_INSTALL_TEST_BIN` is the checkout-local installed Pi CLI;
`PI_CODING_AGENT_DIR` is created only by the harness beneath its isolated root.

Final invocation ran the complete unchanged `scripts/test-git-install.mjs`, with
a 480-second wrapper deadline, against this candidate's source/build. It used
real production dependencies from the registry/cache, real Pi Git install/update,
a temporary Git source repository, real tarball consumer installation, and actual
installed Hub init/issue/serve/HTTP/revoke/SIGTERM in both package forms.
Its local fixture-to-bare-repository pushes never target an external Git remote.

Result: install/update/tarball/lifecycle passed; **18** actual stale-source
prepare rejections; 3 production dependencies / 4 consumer packages;
`npmRewroteLock:false`. Root `/tmp/pi-task7-install-bsNx5B` has
`remainingRunDirectories:[]`; harness fixture/run/state directories were removed.
The proven temporary cache/raw logs were retained. Prior controller/Task1
installation evidence is historical only, not this final gate.

## Actual final native chain and visual evidence

The single final invocation used the cached Chromium executable, regenerated
BDD and the final built assets:

```sh
NODE_OPTIONS='' PI_TASK6_NATIVE_E2E=1 \
PI_TASK6_GATE_SOURCE=<reviewed Gate source> \
PI_TASK6_DOCKER_SOURCE=<reviewed pi-docker source> \
PI_E2E_BROWSER_EXECUTABLE=<existing cached Chromium> \
PI_E2E_ARTIFACT_DIR=/tmp/pi-task7-native \
node_modules/.bin/playwright test -c e2e/playwright.config.ts --grep @native-terminal
```

This is the approved installed native-TUI exception: Browser → production Hub →
real Gate/Engine/provider → installed fixed helper/broker/supervisor → real
Pi 1.1.0, normal mirror extension, temporary workspace and synthetic commands;
only the model is faux. No older Task6 run, synthetic PTY child or mocked product
WebSocket replaces this gate.

[Fresh structured evidence](2026-10-21-task7-final/native-evidence.json):

- Prefix `pi-task6-d65212f03feb`; actual Pi child PID 18 / PPID 1 / kernel
  start 28211376 / executable `/usr/local/bin/node`. Its shared-install CLI path
  and every subsequent native identity check agree.
- Runtime `sha256:362c010450a7cf3e7817beaa9615732f7c78ba4532f0c36e897dad2eb4d8be95`;
  Gate `sha256:9ddffe66d114f5c9da495ece016b2df8a370712babb3448e52033efded11bbf0`.
- Live admin preflight before Pi creation; actual Compose/inspect logging `none`,
  no retrievable TUI marker; real UID1000/cap-dropALL Hub reads only dedicated
  read-only provider mounts; Pi has no provider/Docker mount. Synthetic normal
  SSH/model preparations passed.
- Confirmation false then true, `effects:[APPROVED_ONCE]`; Chinese input,
  custom BETA and native 120×40 → 96×30 resize; local reclaim rejects old remote
  input, then local command and a new explicit remote handoff; same child.
- Native exit 0, helper gone after disconnect, Gate/Hub sockets removed,
  `cleanupFailures:[]`, `ownedResourcesRemoved:true`; active ledger is false.

Fresh screenshots were opened and inspected separately, following the repository
visual-check guidance. No controllable in-app Browser tool was exposed, so actual
BDD-captured Chromium screenshots were viewed directly instead of claiming a
Browser-tool check. Isolated dynamic loopback origins are now stopped.

- [1440×1000 startup read-only chat](2026-10-21-task7-final/1440-native-chat-readonly.png):
  explicit startup banner, history-only empty state, disabled composer.
- [1440×1100 native confirmation bottom](2026-10-21-task7-final/1440-native-confirm-bottom.png):
  after outer-padding wheel scroll, both Yes/No, navigation hint, bottom border
  and footer are visible; controls and Chinese preview are readable.
- [390×1000 custom panel bottom](2026-10-21-task7-final/390-native-panel-bottom.png):
  ALPHA, selected BETA, GAMMA and footer visible; wrapped controls/96×30 size.
- [390×1000 renewed handoff](2026-10-21-task7-final/390-native-handoff.png):
  REMOTE_AGAIN, consistent acquired-control headings and usable input controls.

Long terminal rows intentionally scroll horizontally inside the viewport; browser
width does not auto-resize Pi. Wheel over xterm can be consumed by its nested
handler; outer-padding wheel scrolling reaches the bottom. No CSS/layout change
was made. Full-page screenshots show scrollable content, not simultaneous physical
phone viewport visibility. Browser-dispatched composition is not OS IME proof.

## Provenance, warnings, cleanup and unclaimed work

The unchanged release manifest has 191 source entries / 738 output entries:

```text
manifest SHA256 e201ab3fa3ea8fac0bb109bc805f1c82dc01a6b008c55e90964c4e4dfbd9e8e3
source SHA256   dd906fca6b3b2e9934fb2df234959705d17ad212c231512b0494dc1f54d0f410
outputs SHA256  006166a682481411ed21160d5cd26453b34e6b0298c9019d13448d9c944ab1b0
port fixture    74c053df5cb2fca054f39c333f754dae5ae61df3bf66fffd2b940bf318f7949e
cleanup test    a3233c50e24ce14b41826d23a34e303ebb8eb03465a88e1eb4afaa866c76dcdb
native fixture  9cfec5de3d328637ccba6664f35ec3c6029c291b069bc0ddd4e331d931bd64ca
```

All Task6 external final hashes, 14 preserved Task4 paths, four unchanged ordinary
paths, helper final hash, exact host patch hash and unrelated host-review hash
matched (33 checks). [Task6 provenance](2026-10-21-task6-terminal-wiring/provenance.json)
and patch remain unchanged. The helper's missing original independent before-copy
remains a historical evidence gap; no reconstructed baseline or original-byte
equality claim was added. The retained recovery stash was already applied and
was neither reapplied nor dropped; unrelated host review/worktree were untouched.

Retained warning debt for independent final review: Node
`MODULE_TYPELESS_PACKAGE_JSON`, experimental VM-module warnings where emitted,
native runner NO_COLOR/FORCE_COLOR hint, Vite chunk warning, Biome 32 warnings /
7 infos including `hub/server.ts:576` non-null assertion. Existing generated
chat-bundle trailing bytes and exact nested host-patch/raw-excerpt whitespace
are not rewritten or declared branch-pristine. Unrelated mobile-pet clipping is
not resolved or recertified by the terminal screenshots. The Task7-owned diff
is checked separately; no warning was suppressed and no minified content edited.

Only exact labelled native resources were removed: `-gate/-hub/-pi` containers,
`-state/-ipc/-credentials` volumes, `:runtime/:gate/:cached-base` tags and the
owned cleanup probe. Independent exact-prefix inventories were empty. Temporary
fixture/PTY/Hub/install children and sockets are closed; no active command session
is left at handoff. Build cache and raw logs/evidence may remain; no prune.

Still unclaimed: physical phone/Safari/OS IME; public DNS/Caddy/tunnel/external
gateway; actual shared Pi package upgrade with production volumes; every real
user extension or memory/MCP authorization; helper original-byte equivalence;
independent Task7/whole-branch review approval. Public activation, image allowlist,
Gate/Hub installation/restart and rollout/rollback remain separately authorized
handoffs. No `.env`/personal credential read, production resource use, existing
container migration, service restart, retag of `pi-sandbox`, merge or external
push occurred. Source completion is not a claim of live terminal availability.

## 2026-10-22 — final whole-branch readiness/feedback fix

This is the single final fix wave on BASE
`be3f7158bfd472d9a3464a2dee85896d5c3b5516`, following the whole-branch review.
I1 is addressed in the terminal browser only: transport ready is separate from
interactive readiness. Acquire, draft, text, fixed keys and resize stay fenced
until a complete, identity-validated current-generation snapshot successfully
renders. The same check guards dispatch, not just disabled controls. Initial
and replacement screen establishment have a fixed 2-second bound, not renewed
by trickled frames. Incoming replacement starts fence immediately, including
while another render is outstanding; an earlier callback cannot enable input
ahead of queued newer frames. Disconnect/invalid identity/render failure fence
and clear state; late callbacks cannot resurrect it. Existing one 1 MiB
assembly/parser, serialized 256 KiB raw peer queue and render deadline remain.
Blocked input does not consume a sequence; draft-revision ACK behavior remains.

M1 is addressed without claiming new live sink evidence: the UI labels a grant
as last acknowledged/non-real-time, shows last checked target input ownership
with explicit staleness/local-reclaim limits, and shows conservative local
remaining seconds. Local expiry is anchored to acquire **request dispatch**,
not delayed ACK receipt; dispatch checks expiry even when browser timers lag.
Nothing renews/acquires/reconnects automatically. M2 remains deferred,
nonblocking warning/exact-evidence whitespace debt. No protocol, authority,
runtime/Hub/provider/Gate, dependency or external host source changed.

### Fresh executable evidence for the modified bytes

| Gate | Actual result | Raw log |
| --- | --- | --- |
| Actual-entry browser-handler behavioral RED | 28 total, 20 pass / 8 fail; exit 1; 140.888404 ms | `/tmp/pi-final-fix-red.log` |
| Initial covering GREEN | 28/28, 0 fail/cancel/skip; exit 0; 137.156542 ms | `/tmp/pi-final-fix-green1.log` |
| Final covering browser + named terminal/server regressions | 95/95, 0 fail/cancel/skip; exit 0; 4.972 s | `/tmp/pi-final-fix-focused.log` |
| Affected controlled Chromium browser case, desktop/mobile | 1/1; exit 0; 1.733 s test / 2.062 s process | `/tmp/pi-final-fix-browser.log` |
| Default TypeScript (inside build) and connection/E2E TypeScript | Both exit 0 | `/tmp/pi-final-fix-build.log`, `/tmp/pi-final-fix-types-connection.log` |
| Scoped format/check; full Biome | Exit 0; scoped clean; full 317 files, 32 warnings / 7 infos | `/tmp/pi-final-fix-format.log`, `/tmp/pi-final-fix-biome-{scoped,full}.log` |
| Production build / dist correspondence / BDD generation | Exit 0 each; existing chunk warning | `/tmp/pi-final-fix-{build,dist,bdd-gen}.log` |
| Fresh real Git install/update/tarball/installed Hub | Exit 0; 18 real stale-input rejections; 3 dependencies / 4 consumer packages; lock unchanged | `/tmp/pi-final-fix-install.log` |
| Refreshed actual installed native BDD, **one invocation** | 1/1; exit 0; 35.2 s scenario / 35.9 s runner | `/tmp/pi-final-fix-native.log` |
| External/report provenance, before and after | 33/33 unchanged hashes; exit 0 each | `/tmp/pi-final-fix-provenance-{before,after}.log` |
| Exact-owned cleanup / retained stash / process audit | Exit 0; zero resources/processes, install root empty | `/tmp/pi-final-fix-audit.log` |

RED failures were actual assertions: premature readiness for absent/partial/held/
failed first render and replacement/queued render, incorrect ownership/countdown,
and input after local expiry. The original 19 render/draft/ID cases remain;
their acquire setup now renders a screen before obtaining control. Boundary
doubles control DOM/socket/xterm completion and clock, while executing the
production entry and real validators. They are not installed-native proof.

Commands (all logs above retained; no active command sessions):

```sh
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test tests/hub-terminal-browser.test.ts
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test tests/hub-terminal-browser.test.ts tests/hub-terminal-server.test.ts tests/hub-terminal.test.ts tests/terminal-screen.test.ts tests/terminal-lease.test.ts
NODE_OPTIONS='' node_modules/.bin/tsc --noEmit -p tsconfig.connection.json
NODE_OPTIONS='' node_modules/.bin/biome check src/web/terminal/app.ts src/web/terminal/index.html tests/hub-terminal-browser.test.ts e2e/task5-terminal.integration.ts e2e/steps/native-terminal.steps.ts
NODE_OPTIONS='' node_modules/.bin/biome check .
NODE_OPTIONS='' npm run build:web
NODE_OPTIONS='' npm run verify:dist
NODE_OPTIONS='' npm run e2e:gen
NODE_OPTIONS='' PI_E2E_BROWSER_EXECUTABLE=<cached Chromium> PI_E2E_ARTIFACT_DIR=/tmp/pi-final-fix-browser node --import ./tests/register-ts.mjs --test --test-name-pattern='browser client successive snapshots' e2e/task5-terminal.integration.ts
NODE_OPTIONS='' node /tmp/pi-task7-install.mjs final
NODE_OPTIONS='' PI_TASK6_NATIVE_E2E=1 PI_TASK6_GATE_SOURCE=<reviewed Gate> PI_TASK6_DOCKER_SOURCE=<reviewed pi-docker> PI_E2E_BROWSER_EXECUTABLE=<cached Chromium> PI_E2E_ARTIFACT_DIR=/tmp/pi-final-fix-native PLAYWRIGHT_HTML_OUTPUT_DIR=/tmp/pi-final-fix-native-report node_modules/.bin/playwright test -c e2e/playwright.config.ts --grep @native-terminal --output=/tmp/pi-final-fix-native-results
```

The audited install wrapper was reused unchanged with fresh root
`/tmp/pi-task7-install-W1U5CU`, isolated npm/Git config, official registry and
the proven cache/nonempty proxy allowlist. No user token or dependency stand-in
was supplied. Both installed-Hub forms exercise init/issue/serve/HTTP/revoke/
SIGTERM; all temporary run/fixture/private state was removed. No extra metadata
preflight, browser download, broad Node/PTY/Gate/pi-docker or old Docker-browser
fixture rerun occurred. Controller retains complete postmerge Node verification.

### New build/native identity, visual inspection and cleanup

```text
manifest SHA256 de5cc43a8c619f70944aff227e394c6fda1249a57dfcc1ffcec3164017dd3691
source SHA256   0c26c986bc6f800373bfb269299b1055651c2119a9299e63b4b5ae4bb93e854f
outputs SHA256  ec86b70d9ea94223abe97dfee6e68ce3e75b5fc211015e7f2586d64362ee37ef
source/output entries: 191/738
native prefix   pi-task6-1d61c25164e7
runtime image   sha256:3fad4e56512274fe291b7fe42da8efeda5527f574094a5f065b3f68d08a4347c
Gate image      sha256:b2ad2c5d23f78755bfb5e2f9f2a04d29912a3186b901c5039f6889886f4d14b4
cached base     sha256:1a23ab4104c1d806a9cd2370f508ed04d83ea79c48ebdf9da8d99ae904cebae8
native child    Pi1.1.0; PID18/PPID1/start28532070; /usr/local/bin/node
```

The generated Hub bundle changes only its embedded source-build identity;
authority source is unchanged. New native evidence is
`/tmp/pi-final-fix-native/pi-task6-1d61c25164e7-evidence.json`, not the historical
Task7 artifact. Actual Browser → Hub → Gate/Engine/provider → installed fixed
helper/broker/supervisor → shared-path installed Pi1.1.0 passed preflight before
Pi creation, confirmation false/true with only `APPROVED_ONCE`, Chinese/emoji,
BETA/120×40→96×30, local reclaim/no rejected remote execution, LOCAL_NATIVE and
REMOTE_AGAIN, same child and exit0. Real readonly0640 provider mount permission,
SSH/models setup, logging none/no retrievable marker, no Pi provider/Docker
mounts, helper absence and Gate/Hub socket removal are retained. This fixture
uses isolated Compose with the real overlay, synthetic commands and faux model;
it is not full production pirun/shared-volume package-upgrade acceptance.

No controllable in-app Browser tool is available. Actual cached Chromium
screenshots were opened with view_image, not accepted from DOM checks alone:

- `/tmp/pi-final-fix-browser/{1440,390}-final-fix-awaiting-screen.png`:
  desktop1440×1050/mobile390×1000, input/acquire disabled before first screen.
- `/tmp/pi-final-fix-browser/{1440,390}-final-fix-draft-preserved.png`:
  complete latest screen, preserved edited Chinese draft, coherent non-live
  grant/29-second conservative feedback. Controlled HTTP/WS boundary only.
- `/tmp/pi-final-fix-native/1440-native-confirm-bottom.png`,1440×1100:
  actual Yes/No/navigation/footer, readable non-live grant/29s.
- `/tmp/pi-final-fix-native/390-native-panel-bottom.png`,390×1000:
  ALPHA/selectedBETA/GAMMA/footer,96×30/manual controls, non-live28s.
- `/tmp/pi-final-fix-native/390-native-handoff.png`,390×1000:
  REMOTE_AGAIN and non-live29s; no contradictory live-control claim.
- `/tmp/pi-final-fix-native/1440-native-chat-readonly.png`,1440×1000:
  startup read-only banner, disabled composer, read-only empty state.

Layouts are readable/wrapped without apparent overlap; horizontal native rows
scroll intentionally. These are full-page captures of dynamic isolated loopback
origins, now closed, not simultaneous physical-phone viewport visibility or
Safari/OS IME/public-gateway proof. Raw screenshots/reports remain under /tmp.

Exact-owned cleanup removed only the new labelled gate/hub/pi/probe containers,
state/ipc/credentials volumes and runtime/gate/cached-base tags. Fresh ledger is
inactive, `cleanupFailures:[]`, sockets removed; independent exact-prefix
inventories are empty. No fixture process or command session remains. Provenance
is still33/33; the unrelated host report and already-applied retained stash OID
`8f091de8f84eec89cc850c1f69062e6c84f89c33` are unchanged. No external host source
write, live service/production volume, retag pi-sandbox, merge/push/deploy occurred.

The earlier historical “pending” statements apply to those checkpoints only.
All requested fix-wave executable gates above are complete. Independent
fix-only re-review and complete postmerge Node remain controller-owned. M2
warnings/whitespace, original helper baseline gap and the physical-device,
public-gateway, real shared-upgrade/user-extension limits remain explicit;
no pristine-output or live terminal availability claim is made.
