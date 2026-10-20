# Bounded Hub state: integration and visual evidence

Date: 2026-10-20. Source-only validation on `codex/bounded-hub-state`, based on
reviewed Tasks 1–2 (`7471c87`). No production rollout, host Compose edits, real
credentials/models, Pi source-history cleanup or Gate-record changes.

## Guarantees and exclusions

| Boundary | Enforced budget |
| --- | --- |
| Complete state_sync / get_history / sync_request UTF-8 JSON before compression | 256 KiB / 262,144 bytes |
| History page | 40 entries, 192 KiB array, 16 KiB each |
| Tree preview | 200 nodes, 32 KiB |
| Complete entry-detail response | 64 KiB, fenced to session/runtime/branch/revision |
| Browser retained source-like content | 200 items, 512 KiB total, 64 KiB each, plus one detail chunk |
| Hub logical persistent state | 8 MiB; ordinary writes preserve 64 KiB security headroom |
| Active grants | 512, including deliberately offline grants |
| Forwarding in each direction | 512 KiB waiting / 512 messages, PLUS one ≤16 MiB in-flight message |
| Browser WebSocket pairs | 8 concurrent, including pending proofs/handshakes; not an eight-Pi-run cap |

Queues retain credit until send completion and buffer drain. An oversized second
message cannot wait; slow consumers close with 1013. Eight full pairs admit up to
264 MiB forwarding payload, **not** total RSS. Other runtime limits: 128 raw HTTP
connections across listeners; 64 IPC peers / 32 admitted IPC operations; four
backend probes; two WS and two static compression operations. Five independent Pi
runs are separately covered by the Task 2 unit suite. No 512 MiB cgroup stress or
constant CPU/RSS claim is made. Pi core getBranch/getTree and session memory may
scale with original history; browser React/JS overhead is outside serialized
retention. Initial JS/CSS, explicit upload/download and lifetime traffic are outside
the history-frame budget. No fixed phone latency or Docker named-volume quota.

Original Pi JSONL/model context, project files and Gate deployment records are never
modified/deleted by these bounds. Preview text is deterministic omission, not an LLM
summary. Detail retrieval is explicit, current-branch only, no arbitrary paths or
base64 binary bodies, and never automatically prefetches/concatenates the original.

## Measured real-Pi and packaged-Hub results

`e2e/date-history.integration.ts` measures raw WebSocket UTF-8 envelopes, not payload
arrays or compressed sizes. It checks all received history/sync/detail envelopes,
all older pages, date replacement, invalid offsets/signatures, cross-session/runtime
and entry identity, actual branch navigation invalidating cursors, off-branch denial,
and unchanged temporary 20 MiB JSONL. Registration must be bounded-v2 through the
rebuilt packaged Hub, not legacy fallback. A first representative passing run:

| Measurement | Bytes/count |
| --- | ---: |
| Largest full history envelope | 41,093 |
| Largest full detail envelope | 65,523 |
| Largest entries array / individual entry | 7,410 / 449 |
| Largest tree preview | 32,675 |
| Initial page entries / tree nodes | 40 / 104 |
| Non-overlapping recent pages / unique entries | 4 / 154 |
| Temporary JSONL file | 20,999,720 bytes |

The 154 includes 152 fixture messages and two real Pi startup metadata entries.
Before and after SHA-256:
`a1af24495580855fba57f58597e868b9520fe4ef48aa32f7a4a48ec597a845b1`.
Fixture timestamps/temp workspace paths make hashes differ across runs; equality
within each run is asserted. Unicode/escape-heavy detail is also exercised by the
real persisted tool fixture; adversarial metadata and revision-content mutation
fences remain covered by the unit tests, without rewriting a real session for testing.

## Screenshot evidence (honest fallback)

No callable in-app Browser automation was available. Used local Playwright Chromium
selected by `PI_E2E_BROWSER_EXECUTABLE`, real Pi RPC/WS, packaged Hub and temporary
synthetic sessions. No mocked WS/routes, DOM/store injection or production URL.
Finite screenshot animations are completed so dialogs are captured at rest.
Exact ephemeral localhost URLs, viewports and per-run JSONL hashes are in
[evidence.json](artifacts/bounded-hub-state/evidence.json); servers are stopped after
each run, so those URLs are evidence identifiers, not live services.

Artifacts use `{history|tools}-{1440|390}-{preview|detail-first|detail-next|scope-reset|old-date}.png`
under `docs/validation/artifacts/bounded-hub-state/`. Desktop is 1440×1000; mobile is
390×844. The implementer inspected the actual images; controller independently
inspected 12 representative images and confirmed the changed controls/dialog text,
close/next buttons fit, chunks visibly replace, and branch/date changes clear detail.

- Preview notice and **Load entry detail** are visibly available, including a
  synthetic system row for a tool result whose merged invocation row was evicted
  by the 200-item browser limit. Fixture has 205 persisted tool calls, not injected UI.
- Long Unicode/escaped tool output is readable in the scrollable chunk area.
  First/next history texts are 65,145 bytes each; tool texts 58,621 / 58,619 bytes.
  These text sizes are not substitutes for the full-envelope checks above.
- Exactly two user-requested detail reads per case; next chunk no longer has the
  first-chunk marker. Actual Pi branch navigation while detail is open closes it;
  subsequent date selection displays only the old marker, with no stale dialog.
- All four cases: zero uncaught page errors, console errors, failed requests,
  HTTP responses with status ≥400, and WebSocket errors; no page horizontal overflow. No assertion
  of global zero overlap: existing Whale companion overlaps some bottom-right
  ordinary chat/notice text, especially on mobile, but not detail buttons/modal
  controls. Synthetic system previews repeat the notice in the text row and control
  span. Both observations remain for final review. Neither issue was hidden by
  removing the widget.

![390px tool system preview](artifacts/bounded-hub-state/tools-390-preview.png)
![390px replacement detail chunk](artifacts/bounded-hub-state/tools-390-detail-next.png)

## Storage safety, migration and operator boundary

All writers (CLI issue/revoke, serve registration, authentication and receipts/clocks)
must use the same cross-process lock/quota implementation. Stop/upgrade old writers,
then Hub, then Pi extensions and browser assets. Build tracked dist **before**
packaged integration: an old unmodified Hub fails closed with new clients; only a
signed, explicit unsupported-protocol response permits legacy negotiation fallback.

New generations are `b2-<boot32hex>-<slot16hex>-<nonce32hex>`; old 32hex generations
remain supported. Run/operation IDs remain 32hex. All legacy tombstones are retained,
including revoked-run tombstones; deleting them could allow old URLs to be reused.
No automatic downgrade/legacy compaction is supported. Bounded tuples replace per-run
records and reject replay after supersession/unregister/boot change.

Offline grants are not expired. Revoked grant/receipt GC is **not enabled** without
proof that every dependency / Gate terminal state / idempotency retention obligation
has ended. Seven-day receipt TTL is conditional design, not active cleanup. Receipts
also have the existing 1,000-count ceiling. Quota refusal preserves existing data,
does not trigger broad deletion, and does not promise unlimited run churn. Ordinary
writes stop at quota; existing active grants can be revoked subject to remaining
byte/staging capacity. Already unsafe/oversized state can refuse startup too.

Credential issue first commits the grant and conservative export reservation, then
publishes the external export. Failed/uncertain export leaves that authoritative
reservation intact; removing an export later does not free accounting. Legacy exports
without accounting are not discovered by scanning unrelated directories.

`GET /api/management/storage` is available only on the authenticated management
origin, reporting aggregate bytes/counts/budgets/export reservations/overBudget,
never tokens, paths, prompts or run identities. No new public/CLI diagnostic.
Locks are not automatically stolen by PID or age. Trusted recovery must establish
all relevant services/writers are stopped and handle only the verified specific lock;
never recursively remove state, legacy proofs, unknown files or symlinks. See
[Hub operations](../hub.md) for the full boundary.

Recommend Docker log rotation **2 MiB × 3**, retaining container memory/tmpfs limits.
This is a documentation recommendation only; no host Compose/log settings changed.

## Reproduction

```sh
npm run build:web
npm run verify:dist
npm run test:unit
npx tsc --noEmit
npx tsc -p tsconfig.connection.json --noEmit
npm run check
node --import ./tests/register-ts.mjs --test --test-concurrency=1 --test-reporter=spec e2e/date-history.integration.ts e2e/session-hub.integration.ts e2e/message-revision.integration.ts e2e/file-download.integration.ts e2e/file-upload.integration.ts
npm run e2e:gen
# Set PI_E2E_BROWSER_EXECUTABLE to an approved local Chromium executable.
./node_modules/.bin/playwright test -c e2e/playwright.config.ts --grep '恢复、统计|总管连接|恢复会话自动|@date-history'
node --import ./tests/register-ts.mjs e2e/harness/visual-bounded-hub-state.ts
```

## Verification results and diagnostic history

The following full-suite results are the original Task 3 verification, not a claim
that those suites were rerun for the focused review fix described below.

| Verification | Result |
| --- | --- |
| Manifest regression (`node --test --test-reporter=spec tests/web-dist.test.mjs`) | 44 pass, 0 fail; missing four-module inventory first reproduced RED |
| `npm run build:web` | Exit 0; browser 5,693 modules, packaged Hub 21 modules / 168.47 kB; manifest written |
| `npm run verify:dist` | Exit 0; source and output hash consistency verified |
| Complete `npm run test:unit`, including packaged hub-cli | 584 total: **583 pass, 0 fail, 1 pre-existing skip**; 43,523 ms |
| `npx tsc --noEmit` | Exit 0, no diagnostics |
| `npx tsc -p tsconfig.connection.json --noEmit` | Exit 0, no diagnostics |
| `npm run check` | Exit 0; 261 files, **0 errors, 33 warnings, 7 infos** |
| Serial backend integrations (five files listed above) | **9 pass, 0 fail**, final rebuilt-artifact run 82,773 ms |
| Serial Playwright date/resume/Hub scenarios | **7 pass, 0 fail**, 55.8 s; run after backend integrations, one worker |
| Real-flow visual runner | Four cases, 20 PNGs; zero page errors / page horizontal overflow; all four JSONL hashes unchanged |
| `git diff --cached --check -- ':!dist'` | Exit 0 for source/docs; full staged check reports four generated-bundle trailing-whitespace lines |

The skipped unit case is the pre-existing opt-in 1 GiB upload stress test, not a
skipped file or disabled packaged Hub suite. Existing Node module-type, Vite large
chunk and Playwright color-environment warnings remain; the result is not warning-free.
No optional Docker-managed-runtime harness, production deployment or cgroup stress
run is claimed.

Final rebuilt-artifact history run reproduced all byte/count maxima in the table
above. Its temporary JSONL before/after SHA-256 was
`be8e9db9446774520ec1bd91f8e2d5f6906d48824c6dd467c86cabf75d9eb77a`.
The generated main bundle `dist/assets/index-DTKR0QRq.js` has trailing whitespace
at lines 59, 703, 721 and 910 (full staged whitespace check exits 2). It is retained
exactly as generated, not hand-edited; build/manifest verification passes. Source
and documentation whitespace checks pass. All temporary Pi/Hub/browser processes
are stopped by the test harnesses.

The upload integration uses the installed Pi SDK's own Undici fetch, matching its
global dispatcher; Node 22's bundled fetch otherwise rejects zero-length PUT before
the HTTP request reaches the product. No dependency or production upload change.
The initial upload run had three failures; a localhost-only reproduction returned
`UND_ERR_INVALID_ARG` with Node fetch versus HTTP 200 with SDK fetch. All original
HTTP assertions remain. Two initial browser card/focus failures were traced to
version metadata changing from `checking` to `unavailable`, despite unchanged
session data. Tests now wait for initial version lookup completion, refresh, and
assert both response equality and the original DOM identity/focus across a poll.

One initial backend run reported `Hub CLI issue failed`; two independent reruns
and a subsequent complete run passed. The initial safe harness intentionally did
not expose child stderr, so its cause is unproven. A fixed, whitelisted lock-busy
diagnostic was added; no blind retries or lock-policy weakening. This remains a
recorded intermittent setup observation, not a claimed production defect/fix.

### Review fix 1: complete browser-error gate and fresh evidence

On 2026-10-20, based on `c57c24b`, the visual runner's pageerror-only gate was
replaced with five separately persisted arrays: `pageErrors`, `consoleErrors`,
`requestFailures`, `httpFailures` and `webSocketErrors`. Listeners attach before
navigation and remain active through the final screenshot/assertions; they detach
before intentional context/server teardown. Every recorded error fails the case.
There are **no expected-failure exclusions**, including for favicon requests,
localhost or aborted requests. Console warnings, successful/redirect responses
and normal WebSocket closure are not error events.

Error messages and URLs are persisted only as SHA-256 correlation hashes, with
allowlisted HTTP methods and numeric status codes where relevant. Raw messages,
credentials, paths, stack traces, query strings and frame bodies are not recorded
in these error arrays. The synthetic localhost product URLs remain recorded
separately as screenshot identifiers.

Before launching Chromium, the runner atomically replaces `evidence.json` with a
new run ID, start time, `status: "in_progress"` and an empty case list. It publishes
each case, and changes status to `passed` only after all four cases and cleanup
succeed; caught failures publish `failed`. An interrupted run remains
`in_progress`. Only a `passed` manifest with all four passing cases establishes a
current pass: PNGs left by an older or partial run are not independently passing
evidence. The manifest records `expectedFailureExclusions: []` explicitly.

| Fix-round verification | Result |
| --- | --- |
| Focused gate/manifest RED | 8 tests: 1 pass, **7 fail** against pageerror-only behavior and end-only evidence publication |
| Focused gate/manifest GREEN, final repeat | **8 pass, 0 fail, 0 skip**; 54.620 ms; five event categories, sanitization, no broad exclusions, teardown, stale-pass invalidation |
| Real Pi + packaged Hub visual rerun | **4 pass, 0 fail**, 20 PNGs regenerated; each of five error arrays empty in every case; all four JSONL hashes unchanged |
| Targeted TypeScript check of the two harness files and focused test | Exit 0; no diagnostics |
| Targeted Biome check of the two harness files | 2 files; no fixes, **0 errors** |
| `npm run verify:dist` | Exit 0; existing built outputs/source hashes consistent; no rebuild needed for harness/tests/docs-only changes |

Current evidence run ID: `6400afd3-9a5a-474d-9759-bbf3b85628eb`, started
`2026-10-20T08:27:44.649Z`. Viewports remain 1440×1000 and 390×844 for both history
and tool-eviction fixtures. The implementer inspected 12 actual regenerated PNGs,
including both changed old-date captures, desktop/mobile previews, first/next
mobile details, desktop tool next detail and mobile history scope reset. Controls
fit, the first marker disappears on chunk replacement, and reset/date screenshots
have no stale dialog. The duplicate system notice and Whale overlap described
above remain visible; this fix does not alter product UI. Prior controller image
inspection predates this focused rerun. Temporary Pi/Hub processes were confirmed
stopped. No full unit/backend/browser integration suite was rerun in this fix round.

Focused reproduction (same approved `PI_E2E_BROWSER_EXECUTABLE` as above):

```sh
node --import ./tests/register-ts.mjs --test --experimental-test-isolation=none --test-reporter=spec tests/visual-evidence.test.ts
./node_modules/.bin/biome check e2e/harness/visual-evidence.ts e2e/harness/visual-bounded-hub-state.ts
./node_modules/.bin/tsc --ignoreConfig --noEmit --module esnext --moduleResolution bundler --target es2022 --allowImportingTsExtensions --skipLibCheck --types node e2e/harness/visual-evidence.ts e2e/harness/visual-bounded-hub-state.ts tests/visual-evidence.test.ts
node --import ./tests/register-ts.mjs e2e/harness/visual-bounded-hub-state.ts
npm run verify:dist
git diff --check
```

The initial explicit-file TypeScript command omitted `--ignoreConfig` and exited
with TS5112; the corrected command above passed. The existing Node
`MODULE_TYPELESS_PACKAGE_JSON` warning remains in focused tests and the visual
runner. No warning-free result, production rollout or additional runtime coverage
is claimed.

### Final review fix: tool view state cannot evict history after a snapshot

The whole-branch review found a valid server page that fit initially but lost its
oldest browser row when adding the `open` field during tool expansion. The generic
post-snapshot retention gate could not repair the already-established history
cursor/counts. The fix reserves the largest serialized tool view state
(`open: false`) during both item and window accounting, before the history boundary
is chosen. Actual source objects are not mutated, budgets are not increased, and
all source-changing paths still pass through the central retention gate. Opening
or closing tools now uses already-reserved capacity; it cannot cause new eviction
or a new content projection. Any initial eviction is handled by the existing
history-aware snapshot boundary and remains reachable through **Older page**.

The regression uses the reviewer's exact 16 orphan-tool-result fixture: 20 nested
wrappers around `{ rows: [{ value: "x" }, ...], pad: "" }`, with 400 rows in the
first 15 entries and 163 in the last. It runs the real server history selector,
snapshot conversion and session store, not pre-populated store rows.

| Boundary / observation | Measured result |
| --- | --- |
| Server page entries / serialized entries / largest entry | 16 / 92,935 B / 6,016 B; within 40 / 192 KiB / 16 KiB limits |
| Converted rows before browser budgeting | 16 / 524,194 B; full snapshot envelope asserted ≤256 KiB |
| Fixed initial retained page | `e1`–`e15`; returned 15, truncated 14, total 16, exact nextBefore `e1` |
| After repeated all-tool or individual open/close operations | Same rows, output, detail targets and metadata; closed-window size 491,352 B |
| Explicit older page | `e0`; returned 1, truncated 1, total 16, nextBefore null; closed-window size 33,051 B |
| Recovery | All 16 identities visited once; `e0` detail read with exact session/runtime/entry scope; fixture unchanged |

The 200-item / 512-KiB aggregate / 64-KiB item limits remain unchanged and are
asserted after each toggle cycle. A separate exactly-64-KiB item test covers
reserving view state before projection. Existing full-window test fixtures now
include the largest view-state encoding when filling their byte budget exactly.

| Final-fix verification (base `34eea23`) | Result |
| --- | --- |
| Exact fixture RED | All-tool and individual-tool regressions both fail by losing `e0` |
| Mutation check with view-state reservation removed | **3 tests, 0 pass, 3 fail**, including the per-item boundary regression |
| Focused history-store / conversation-window / chat-performance / session-history / history-dates / tree-wire / visual-gate tests | **100 pass, 0 fail, 0 skip**, 2,293.534 ms |
| Frontend and connection TypeScript checks; explicit harness/test type check | Exit 0, no diagnostics |
| `npm run build:web` | Exit 0; browser 5,693 modules; packaged Hub 21 modules / 168.47 kB; tracked assets/manifest rebuilt |
| `npm run verify:dist` | Exit 0, source/output hashes verified |
| `npm run check` | Exit 0; 264 files, **0 errors, 33 warnings, 7 infos** |
| Real Pi + packaged Hub tool-toggle visual cases | **2 pass**, desktop 1440×1000 and mobile 390×844; all five browser-error arrays empty, no exclusions, no page horizontal overflow |

This is scoped final-fix verification, not a rerun of the original full unit or
backend integration suites. Controller owns the full-unit run, scoped re-review
and final merge. No production services, credentials or model traffic were used.

New visual evidence is separate from the original Task 3 screenshots:
[tool-toggle manifest](artifacts/bounded-tool-toggle/evidence.json), run
`09080483-4dbd-45f8-bd74-af00529b6329`, started `2026-10-20T09:14:52.231Z`.
It records exact ephemeral URLs and equal before/after JSONL hashes for both
temporary real Pi sessions. The implementer inspected all 10 actual PNGs:
`toggle-{1440|390}-{initial|all-open|single-open|older-e0|e0-detail}.png`.
Counts remain visibly 15 of 16 after expansion; the older page visibly shows 1 of
16 with its detail control, and the recovered entry's dialog fits both viewports.
On mobile the expanded date controls leave a small scrollable conversation area;
long tool content requires scrolling. The existing Whale overlaps ordinary tool
text, not the recovered-entry detail button or dialog close control. No global
zero-overlap claim is made, and the previously recorded UI caveats are unchanged.

Initial harness runs exposed an over-broad nested-toggle locator and an incorrect
expectation that the final Older page button is disabled (it is absent). These
test expectations were corrected to the existing product behavior. Screenshot
inspection also caught `content-visibility:auto` placeholders; the harness now
scrolls the code container itself into view and waits for actual rendering rather
than accepting text presence. An intermediate mobile paint wait failed because
only the header had been scrolled into view; its manifest correctly reported
failure. The final run passed without error exclusions or UI state injection.
All temporary processes were stopped. Existing Node/Vite warnings and generated
bundle whitespace remain; no unrelated cleanup was performed.
The final staged source/docs whitespace check passed; the full staged check exited
2 for the same four generated trailing-whitespace lines (59, 703, 721, 910), now
in `dist/assets/index-v5q8elB2.js`. The generated bundle was not hand-edited.

```sh
node --import ./tests/register-ts.mjs --test --experimental-test-isolation=none --test-reporter=spec tests/history-store.test.ts tests/conversation-window.test.ts tests/chat-rendering-performance.test.ts tests/session-history.test.ts tests/history-dates.test.ts tests/session-tree-wire.test.ts tests/visual-evidence.test.ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.connection.json --noEmit
./node_modules/.bin/tsc --ignoreConfig --noEmit --module esnext --moduleResolution bundler --target es2022 --allowImportingTsExtensions --skipLibCheck --types node e2e/harness/visual-tool-toggle.ts tests/history-store.test.ts tests/conversation-window.test.ts
npm run build:web
npm run verify:dist
npm run check
# Supply the approved local Chromium through PI_E2E_BROWSER_EXECUTABLE.
node --import ./tests/register-ts.mjs e2e/harness/visual-tool-toggle.ts
```

The complete historical [Task 2 RED/GREEN and storage-boundary report](bounded-hub-state-task-2.md)
has also been moved out of scratch storage. All 514 original lines of evidence
are preserved, with only a provenance introduction and repository-relative
worktree notation added/normalized; the development-log link now points there.
