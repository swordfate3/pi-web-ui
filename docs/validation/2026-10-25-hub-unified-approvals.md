# Unified Hub approvals — development validation

Date: 2026-10-25. Branch: `codex/hub-unified-approvals`.
This is development validation, not a production deployment record.

## Scope

Gate stays independent. A new private management credential authorizes only
fixed decision, receipt, mode-policy and resume routes, never arbitrary admin
dispatch. Hub gets no Docker/admin socket or Gate state. Revisions bind complete
authoritative task and policy data. Durable intent precedes execution; replay
returns its stored receipt; post-intent errors stay delivery-unknown.

The trusted management portal supports deployment/runtime/restart decisions,
eligible rollback, mode-only changes and paused-service resume. It persists a
decision ID before POST and only queries after an uncertain result. An approval
receipt is explicitly distinct from successful execution. Source data, previews,
credentials and raw snapshots never enter the aggregate inbox.

The extension inbox admits one enumeration at a time, four simultaneous source
opens, 64 sources/requests and a 4.5-second overall enumeration deadline.
Unavailable sources/overflow are explicit. Existing review pages retain their
per-request source identity and approval guards.

## Tests

- Gate commit `ba3bf80`: 29 focused management tests; final complete Gate suite
  **467 tests, 8 skipped, no failures**. HTTP/SQLite/accounting are real; external
  Docker/npm boundaries are offline fixtures. The full suite emitted a Python
  3.14 SQLite resource warning; the focused run was clean.
- Hub command below: **232 passed, zero failed/cancelled/skipped**, about 47s.
  Includes actual temporary Hub → Python Gate HTTP integration, approval, exact
  receipt replay, changed-payload conflict, final deployed status and projection.
  Only Docker execution is substituted; no production deployment is implied.

  ```sh
  node --import ./tests/register-ts.mjs --test --test-concurrency=4 \
    tests/hub-*.test.ts tests/session-hub.test.ts
  ```

- First broad Hub run had six failures: `/gate` intercepted `/gateway`, and an
  exact old status assertion lacked inbox/explicit restart-provider capability.
  Fixed the route segment boundary and availability semantics; 51 covering route
  tests passed before the final complete run above.
- UI tests showed RED against an empty module, then GREEN for approve/reject,
  cancellation, mode-only changes, stale revisions, uncertain-result lookup,
  unknown-operation blocking, storage refusal, inbox links and locked-state
  clearing. Inbox scan admission test showed RED then GREEN with concurrent503.

## Rendered validation (not real Pi E2E)

`e2e/hub-approvals.visual.ts`: **1 browser test passed**, temporary real Hub and
synthetic Gate responses, random-port loopback `/sessions/` URLs only. All
temporary services and browser contexts were closed after the test.

The app Browser tool was unavailable. Used installed Chromium through Playwright
and opened both resulting screenshots for actual visual inspection:

- **1440×1000 desktop**: readable task details and decision buttons, mode selector,
  save/resume controls, paused status and empty extension inbox.
- **390×844 phone**: wrapped revisions/IDs; full-width stacked buttons/select;
  no horizontal overflow; all controls accessible by scrolling.
- Both sizes accepted a revision-bound confirmation, displayed the recorded
  receipt and cleared protected task views on lock, without browser page errors.
- Local untracked artifacts: `.tmp/hub-approvals-visual/desktop-approvals.png`
  and `.tmp/hub-approvals-visual/phone-approvals.png`.

## Static/build evidence

Normal build types and `tsconfig.connection.json` passed. Production Web/Hub
build and `npm run verify:dist` passed. Existing Vite large-chunk and native Node
module-type warnings remain. Scoped Biome passed with only an existing assertion
warning in `hub/server.ts`. `just check` ran: types passed, but full Biome reported
two existing import-order/format errors in unchanged
`e2e/web-interactions.browser.ts`, plus existing warnings/information. Do not
describe the full repository formatting gate as green.

## Deployment and limitations

No push/merge, production credential export, host config change, live service
restart, production Docker operation or volume access was performed.
Existing deployments need matching Gate/Hub code and a one-time dedicated token
export into Hub private state plus `gateManagement` config; updating the Pi
extension alone is not sufficient. Follow [setup](../hub.md).

New service registration still requires audited initial administrator setup;
proposals are reject-only. OAuth consent belongs to the provider; only cooperating
adapters appear. Unknown decisions remain blocked pending investigation; no
automatic retry/cleanup/recovery was added. Receipt storage is bounded and full
storage refuses writes, not history deletion. Physical phones/Safari, public
HTTPS/proxy/tunnel delivery and real live Docker updates were not exercised.
