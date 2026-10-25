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

- Gate commits `ba3bf80` and `154d867`: initial 29 then 32 focused management tests;
  post-review complete Gate suite **471 tests, 8 skipped, no failures**. HTTP/SQLite/accounting are real; external
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
- Final complete Node run after build completion: **788 tests, 786 passed,
  2 skipped, zero failed/cancelled**, about 76s. Includes temporary actual Pi,
  Hub and Gate regression paths and packaging/source-inventory checks:

  ```sh
  node --import ./tests/register-ts.mjs --test --test-concurrency=4 \
    tests/*.test.ts tests/*.test.mjs \
    src/web/src/core/i18n.test.ts \
    src/web/src/components/pi-web-ui/sidebar-tree.test.ts
  ```

  The first complete attempt ran concurrently with dist rebuilding: two
  packaging checks read the old inventory and a 2,000-rotation filesystem test
  timed out. Build was allowed to finish before the complete rerun; no assertion,
  iteration count or timeout was relaxed. Raw final log:
  `/tmp/pi-hub-approvals-all-node-final.log` (local, untracked).

## Independent review fixes

The initial scoped Gate review identified two P2 defects. `154d867` adds durable
service management generations so a delayed resume cannot authorize a later
failure incident with repeatable service state. Existing executor policy hashes
and pinned plans do not change merely because accounting advances. Long valid
pinned image identities (270/327 chars) remain intact under a coordinated512
field bound; executable actions are withheld if the identity must be redacted.
New regressions demonstrated RED before fixes. Same-ID receipts still replay
without a second mutation, including after temporary Gate state is reopened.

The scoped Hub review identified two P2 defects. `07c7390` revalidates each inbox
batch's original channel record, channel, target and deadline synchronously just
before response assembly. Stable keyed portal cards preserve expanded details
and unsaved policy drafts across unchanged polls, while changed revisions replace
only the affected card and revocation clears caches. The independent scoped
re-review found both addressed, with seven selected regressions passing and no
actionable residual. Hub's pinned-image projection also accepts the coordinated
512-character bound; its regression showed RED before the correction.

Final independent whole-branch source review returned **ReadyToMerge: yes**,
with no actionable findings. It traced the complete original-base-to-working-tree
diff, cross-component contracts, credential isolation, durable intent/replay,
policy generations, browser authorization/callbacks and bounded inbox behavior.
All four prior P2 findings remained closed. The reviewer independently hashed
188 manifest source entries without mismatch; it did not rerun the owner suites
or authorize deployment. Full-repository formatting limitations remain below.

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
- Both sizes retained an expanded detail and an unsaved policy selection across
  two actual scheduled overview polls, not merely direct render calls.
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
