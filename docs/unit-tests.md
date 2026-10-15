# Unit and connection tests

Run all commands from the repository root with the supported Node 22.19+ (verified with Node 24). Full suite (tree, i18n, rendering/cache and sidebar logic):

```sh
npm run test:unit
```

This includes TypeScript frontend tests and `tests/*.test.mjs` prebuilt-distribution integrity tests. Production install/update lifecycle checks are separate: `node scripts/test-git-install.mjs`.

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
