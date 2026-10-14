# Unit and connection tests

Run all commands from the repository root with the supported Node 22.19+ (verified with Node 24). Full suite (tree, i18n, rendering/cache and sidebar logic):

```sh
node --import ./tests/register-ts.mjs --test \
  tests/*.test.ts \
  src/web/src/core/i18n.test.ts \
  src/web/src/components/pi-web-ui/sidebar-tree.test.ts
```

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
unavailable registry and port conflicts. It is **backend integration**, not
browser E2E.

## Real Pi browser E2E

```sh
npm run e2e
```

The portable connection feature covers root and strip-prefix proxy entries,
desktop/mobile viewports, real prompt/reply, relative assets/WS and export
downloads. It captures rendered screenshots. Optional
`PI_E2E_BROWSER_EXECUTABLE` selects a local compatible Chromium executable;
otherwise Playwright uses its default browser installation. All temporary Pi
processes, proxy servers and test workspaces are cleaned up by the harness.
