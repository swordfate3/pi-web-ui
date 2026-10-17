# Unit and connection tests

Saved message-version paging regressions: `tests/message-versions.test.ts` covers the complete raw graph resolver, memoized system-patch context positions (including 12,000 shared patches, non-system boundaries, malformed ancestry and budgets), and mock WS navigation guards. `e2e/message-revision.integration.ts` checks real SDK system-patch revisions, shared user/answer 2/2 groups and generation-free old/new restoration plus followup context on Pi 1.1/1.3. Separately, `tests/message-versions-client.test.ts` validates bounded metadata/strict ACK/deadlines, and `tests/message-versions-scope.test.ts` exercises read scope checks and a real session slice with an old branch cursor read arriving after the new page. The real Pi `message-revision.feature` covers user/answer pager agreement, branch restoration including later dialogue, draft confirmation/cancellation, rapid duplicate clicks, refresh persistence and unchanged prompt/revision counts while navigating. See [message-version validation](validation/message-versions.md) for final results and evidence boundaries.

Run all commands from the repository root with the supported Node 22.19+ (verified with Node 24). Full suite (tree, i18n, rendering/cache and sidebar logic):

```sh
npm run test:unit
```

This includes TypeScript frontend tests and `tests/*.test.mjs` prebuilt-distribution integrity tests. Production install/update lifecycle checks are separate: `node scripts/test-git-install.mjs`.

Hub name metadata regressions live in `tests/session-registration.test.ts` and `tests/session-hub.test.ts`: current-name renewal, nullable/length/type guards, unchanged route identity and legacy registration. The real `session-hub.feature` additionally uses Pi `/name`, searches by the new name and verifies card labels and session isolation; see [Hub names validation](validation/hub-session-names.md).

Whale local-artwork regressions:

```sh
node --import ./tests/register-ts.mjs --test tests/whale-assets.test.ts tests/whale-pet.test.ts
```

The asset unit tests validate PNG/WebP/GIF signatures, GIF MIME/logical dimensions, byte budget, decoded dimensions, still-preview scaling and late bitmap cleanup after a decode deadline. Decoder/canvas mocks are not proof of animation playback: the real Pi `whale-companion.feature` additionally imports a synthetic two-frame GIF, checks original IndexedDB bytes, native image frame changes, reload recovery and both system/user reduced-motion behavior. Third-party artwork is not included in fixtures or distribution.

Large live transport and preview-budget regressions:

```sh
node --import ./tests/register-ts.mjs --test tests/live-transport.test.ts tests/history-store.test.ts tests/git-preview-budget.test.ts
```

These use synthetic JSON, an in-memory store, and an isolated temporary Git workspace/local mock-extension WebSocket. They do not read user session text. `transport-large.feature` separately runs real Pi with a faux provider over direct/Hub connections, checking >4 MiB tool arguments/results, original persisted JSONL/file integrity, bounded frame sizes, terminal synchronization and dismissible notice. See [validation and limitations](validation/transport-limits.md).

Only session-tree tests:

```sh
node --import ./tests/register-ts.mjs --test tests/session-tree-wire.test.ts
```

The tree, rendering, i18n and sidebar tests are pure logic tests, including a
minimal in-memory session slice. The connection suite additionally uses temporary
IPC sockets and TCP listeners; it needs permission to open local sockets. No
unit test reads real user sessions or starts Pi. The loader resolves existing
extensionless frontend TypeScript imports for Node's built-in type stripping.

The new connection tests are explicitly included in Biome and have a separate
backend type-check configuration:

```sh
npm run check
npx tsc --noEmit -p tsconfig.connection.json
```

## Real Pi backend integration

Install the Pi peer dependency or set `PI_E2E_BIN` to its binary. This integration
starts isolated Pi processes with a faux provider and temporary configuration:

```sh
node --import ./tests/register-ts.mjs --test e2e/portable-connection.integration.ts
```

It checks native registration, HTTP/WS proofs, stop/start/reload/shutdown,
unavailable registry and port conflicts. Missing/malformed/non-string capabilities
and disabled registration must reject stale proxy requests while retaining
header-free local HTTP/WS access. `PI_E2E_RUNTIME_DIR` selects the product
extension and assets from an installed snapshot; faux/lifecycle fixtures remain
in the test repository. CI runs these scenarios after obtaining its
production-only installation. It is **backend integration**, not browser E2E.

## Remote gateway transaction and real Caddy checks

Python standard-library tests cover strict account parsing, preservation, backup,
rollback, effective full-config account proof and concurrent-edit refusal:

```sh
python3 -m unittest discover -s tests -p 'test_gateway.py'
```

For the optional real gateway integration, explicitly select a temporary Caddy
2.8+ binary (this does not install or modify a system service):

```sh
CADDY_TEST_BIN=/path/to/caddy python3 -m unittest discover -s tests -p 'test_gateway*.py'
```

The integration uses loopback ports, a temporary private CA trusted only by the
test client, dummy credentials and a controlling PTY. System certificate trust
is not modified. It checks TLS/auth, foreign WebSocket Origin rejection, real
validation/reload/rollback and password recovery without terminal echo. Without
`CADDY_TEST_BIN`, the optional integration is skipped. All fixture resources are
cleaned up. This is not an Alibaba deployment or physical-phone test.

## Workspace uploads

```sh
node --import ./tests/register-ts.mjs --test tests/workspace-uploads.test.ts tests/chunked-uploads.test.ts tests/workspace-upload-client.test.ts tests/incremental-sha256.test.ts
# Optional physical 1 GiB filesystem verification (not a browser/public-network test):
mkdir -p .tmp/chunk-test-tmp
TMPDIR="$PWD/.tmp/chunk-test-tmp" PI_WEB_UPLOAD_TEST_1GIB=1 node --import ./tests/register-ts.mjs --test --test-name-pattern='1 GiB is streamed' tests/chunked-uploads.test.ts
node --import ./tests/register-ts.mjs --test --test-timeout=70000 e2e/file-upload.integration.ts
```

Pure tests use disposable workspaces and HTTP fixtures or injectable browser
transport. Backend integration starts real isolated Pi plus packaged Hub;
browser E2E additionally uses the real picker, progress, cancellation/retry,
symlink-directory failure/recovery, a second browser switching sessions during
upload, refresh/reselection recovery, chunk integrity/order and the real Pi
`read` tool. Chunked-upload tests must use reusable buffers or sparse-file
metadata rather than allocating a whole GiB in memory; declared-size acceptance
is distinct from physically writing and hashing the full boundary file.
No test uploads files to the live public deployment. See
[file uploads](prd/file-uploads.md) and its [validation report](validation/workspace-uploads.md).

## Real Pi browser E2E

```sh
LC_CTYPE=C.UTF-8 npm run e2e
```

Use an installed UTF-8 process locale for Chromium (CI sets `LC_CTYPE=C.UTF-8`).
A POSIX/C process locale can reduce UTF-8 download names to `download` even when
the HTTP disposition and original bytes are correct; browser context locale
alone does not set the native process encoding.

The portable connection feature covers root and strip-prefix proxy entries,
desktop/mobile viewports, real prompt/reply, relative assets/WS and export
downloads. It captures rendered screenshots. Optional
`PI_E2E_BROWSER_EXECUTABLE` selects a local compatible Chromium executable;
otherwise Playwright uses its default browser installation. All temporary Pi
processes, proxy servers and test workspaces are cleaned up by the harness.

## Per-message editing and regeneration

`tests/message-revision.test.ts` checks the raw parent-chain resolver, complete text budget, exact original image content, unsupported attachments and a mock mirror WS server with session/runtime/leaf, lifecycle, cancellation, one-use per-socket preview, shared mutation lock and unknown-dispatch fences. It includes a delayed (>8 second) dispatch and unrelated events, plus plain queued-prompt identity. These are adapter tests, not proof of a real Pi input-hook cancellation.

`tests/queued-prompt.test.ts` checks exact session/runtime binding and rejects stale/offline queue dispatch; navigation-draft ownership checks protect delayed branch results. Browser mutations carrying identity are validated on the backend as well.

`tests/message-revision-client.test.ts` verifies full-text reads, preview schema, persisted-leaf sync before a revision, strict submit ACK, no optimistic chat, double-click lock and runtime-replacement ownership. `e2e/features/message-revision.feature` uses real Pi + a context-inspecting faux provider on desktop/mobile: editing an early question without later context, whitespace preservation, busy/draft/cancel guards, Tree switches and refresh persistence. It never replaces WS or constructs fake UI messages.

```sh
node --import ./tests/register-ts.mjs --test tests/message-revision.test.ts tests/message-revision-client.test.ts
npm run e2e:gen
node_modules/.bin/playwright test -c e2e/playwright.config.ts message-revision
```

## Hub navigation and immediate metadata refresh

`tests/session-registration.test.ts` uses real Unix IPC to cover bounded/coalesced rename refresh, epoch fencing and both mirror rename entries. `tests/session-hub.test.ts` executes portal JS with a minimal DOM for stable cards and merged history-return refresh, and real HTTP/IPC for proof/retirement gaps, first-successor binding and deadlines. The PiClient test verifies the route notification; React scope timing is additionally checked by real Hub handoff E2E, not certified by the stub alone. `tests/connection-path.test.ts` restricts the return-home link to exact Hub entries. The Hub browser flow tests immediate rename/return, cancellation with unsent text and attachments, native back and one initial Git request. See [Hub navigation validation](validation/hub-navigation.md).

## Web companion

`tests/session-usage.test.ts` covers actual response-model grouping, cache/reasoning subset semantics, mixed/unknown pricing, summaries, malformed values, and bounded model rows. `tests/usage-stats-client.test.ts` checks reply parsing and session/runtime/disconnect fences. `tests/whale-pet.test.ts` covers visible-viewport positioning and optional local storage. Local image validation tests are separate from actual IndexedDB browser evidence.

```sh
node --import ./tests/register-ts.mjs --test tests/session-usage.test.ts tests/usage-stats-client.test.ts tests/whale-pet.test.ts tests/whale-assets.test.ts
PI_E2E_BIN="$PWD/node_modules/.bin/pi" node --import ./tests/register-ts.mjs --test e2e/whale-usage.integration.ts
npm run e2e:gen
node_modules/.bin/playwright test -c e2e/playwright.config.ts whale-companion
```

The real Pi usage fixture contains synthetic old/current dates and sibling branches, priced/unknown responses and different actual model IDs; no real session is opened. Companion browser scenarios use a generated one-pixel PNG, not downloaded fan art, and verify local storage/reload, lack of uploads, display lifecycle, scope replacement and mobile bounds. Visual screenshots of imported fan artwork are local-only artifacts, not package assets or functional proof by themselves.
