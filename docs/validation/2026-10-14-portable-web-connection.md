# Portable Web connection validation · 2026-10-14

## Scope and environment

Feature branch: `codex/portable-web-connection`, based on
`00a0366ab8999b85af5192505b0fb7b72c32dd20`.
The implementation adds portable connection settings, optional native registry
registration, lifecycle fencing, and browser entry-directory routing. It does
not deploy or configure a public gateway.

Tests used Node 22.19.0, npm 10.9.3, an isolated real Pi 1.1.0 process, the existing
faux provider, temporary IPC capabilities, and local Chromium. No real model
requests or changes to running user containers were needed.

## Results

| Check | Result |
| --- | --- |
| Unit suite, including connection, IPC and service-worker boundaries | 77 passed, 0 failed |
| Real Pi backend integration | 3 passed, 0 failed |
| Complete real Pi/browser suite | 39 passed, 0 failed; 2.6 minutes |
| Biome | 132 files checked; passed |
| Connection module/test TypeScript check | Passed |
| Production frontend TypeScript and Vite build | Passed |
| Git whitespace check | Passed |
| npm dry-run package inventory | Includes the mirror server, all three new backend modules and built HTML |
| Production dependency audit | 0 vulnerabilities |

The unit suite covers strict bind validation, environment precedence, optional
configuration failure without losing local access, bounded IPC, stale callbacks,
renewal/unregister generations, identity and HTTP/WS proofs, IPv6/scoped URLs,
and the root service worker's cache/interception boundary. A listener regression
was reproduced before its fix: repeated occupied-port attempts accumulated Node
close listeners. The fixed test passes with more than ten occupied ports and
without a listener accumulation warning.

Backend integration starts a real isolated Pi process and checks native
registration with the actual listening port, signed identity, wrong/correct WS
proofs, stop/start, real extension reload, fresh generations, shutdown cleanup,
missing-registry fallback, and occupied-port fallback. This is backend integration,
not browser E2E.

The 39 browser scenarios retain the existing command/model/thinking, skill,
session, export, language, workspace, large-tool and long-history regressions.
Three new scenarios use a real strip-prefix HTTP/WS proxy, not browser-global
patches. They verify entry-scoped assets, live frames, actual Pi message/reply,
HTML attachment download and absence of a subpath service worker.

The first complete run had 36 passes and three export timeouts. Investigation
found that the new tests dismissed the existing sensitive-export confirmation
dialog by default. Adding explicit confirmation handling made the targeted three
scenarios and the complete 39-scenario rerun pass; the failed run is not counted
as a success.

## Rendered visual evidence

The app Browser tool was not callable in this environment. As an explicitly
reported fallback, Chromium screenshots were opened and inspected after the
successful real Pi/browser run:

| Entry URL pattern (temporary, now stopped) | Viewport | Visible result |
| --- | --- | --- |
| `http://127.0.0.1:<test-port>/` | 1440 × 900 | Green connection indicator, readable reply and visible input/header controls |
| `http://127.0.0.1:<test-port>/s/test-session/` | 1440 × 900 | Same connected layout through the scoped entry; no blank content |
| `http://127.0.0.1:<test-port>/s/test-session/` | 390 × 844, touch/mobile emulation | Wrapped header controls, readable reply and visible bottom input; no observed clipping |

Screenshots are generated under the ignored `test-results/` portable-connection
scenario directories as `portable-root-desktop.png`,
`portable-subpath-desktop.png` and `portable-subpath-mobile.png`. They are local
test artifacts, not npm package contents or committed resources. The visual
inspection is not app-Browser validation, an independent performance benchmark,
or a physical-phone test.

## Reproduction

Use a Pi binary and Chromium executable installed in your environment. The
`PI_E2E_BIN` and optional `PI_E2E_BROWSER_EXECUTABLE` paths are machine-specific
test inputs, not production connection settings.

```sh
node --import ./tests/register-ts.mjs --test tests/*.test.ts \
  src/web/src/core/i18n.test.ts \
  src/web/src/components/pi-web-ui/sidebar-tree.test.ts
node --import ./tests/register-ts.mjs --test e2e/portable-connection.integration.ts
npm run check
npx tsc --noEmit -p tsconfig.connection.json
npm run build:web
npm run e2e:gen
npx playwright test -c e2e/playwright.config.ts
git diff --check
```

The IPC/TCP and browser checks need permission to bind temporary local sockets.

## Boundaries and known warnings

- Native Windows/macOS browser openers and Windows named-pipe registration have
  not been exercised on those operating systems. No cross-platform success claim
  is based solely on Linux tests.
- The actual Alibaba gateway, SSH tunnel, Docker mount migration and physical
  mobile connection have not been changed or tested by this branch.
- A public URL advertises an entry; it creates no tunnel or user login. Registry
  proofs prevent stale process routing, not unauthenticated human access.
- An old installed root service worker must be updated or cleared on the actual
  deployment before verifying a migration; fresh test contexts cannot establish
  the state of an existing user's browser cache.
- The production audit is clean, but the earlier development-inclusive install
  reported 15 findings. This branch does not upgrade dependencies or claim that
  development dependency findings are resolved.
- Existing Node module-type warnings, a browser color-environment warning and
  Vite's large-chunk warning remain. No npm publish, merge, push or deployment
  is part of this handoff. Tests stop their own temporary processes and listeners.
