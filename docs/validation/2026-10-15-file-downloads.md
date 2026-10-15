# Confirmed project-file downloads: validation

## Scope

Clicking the assistant's bold
`documents/求职/计算机硕士秋招简历-优化版.pdf` path opens confirmation.
Cancel sends no download preparation; confirmation downloads the original bytes
with the Chinese basename. Plain paths, inline-code paths and local Markdown
links are recognized. Direct and Hub session routes are covered.

Downloads are confined to ordinary files in the current workspace. The filename
denylist is defense in depth, not a promise to identify all sensitive content.
HTTP streams file bytes independently of the WebSocket size limit. This does
not repair unrelated oversized live-event messages.

## Red/green and compatibility findings

- Initial tests failed against missing link/capability modules and old built UI.
- Actual Streamdown rendering uses a span for bold content and anchor-shaped
  navigation requires controlling link safety. Browser selectors were aligned
  with real rendered markup, without bypassing normal Pi/tool behavior.
- A real final-history snapshot remounted the clicked message row and closed
  its local confirmation. Moving the confirmation boundary outside keyed rows
  kept it open through history synchronization; cancel then passed.
- Playwright does not reliably emit ordinary request events for attachment
  downloads. The cancel assertion now observes real outgoing WebSocket
  preparation requests, while successful download assertions check the actual
  browser download event, filename and file bytes.
- Full browser regression first passed 52/53: the existing language test still
  expected a button-shaped external link and its former modal. The stable
  confirmation retains external-link confirmation and localized Copy link;
  the regression now uses the semantic link and public dialog controls. The
  subsequent full run passed 53/53.
- A repeated run exposed a pre-existing collapse-test scheduling race: a real
  settled-history snapshot could replace the row between its expand and collapse
  clicks, reopening a fresh collapsed trigger. The test now observes the real
  `sync_request` reply with its completed fixture before interacting, as the
  existing language fixture already does. All collapse assertions remain; no
  product collapse behavior or timeout was changed.

## Final evidence

- Full unit suite: **185 passed, 0 failed**.
- Real Pi download backend integrations: **2 passed, 0 failed**, direct and
  packaged Hub. Each checks a 5 MiB binary, zero-byte file, UTF-8 attachment
  headers, GET/HEAD, unsupported methods, Origin/Fetch Metadata, unknown tokens,
  unsafe paths, missing/stale identities and a changed file.
- A full real Pi Playwright-BDD run passed **53/53**, about 2.4 minutes.
  A later repeat on the final clipboard guard/test-wait version passed **52/53**:
  the mobile Hub session-resume handoff timed out on session identity and showed
  an expired-link notice. That path is not changed by this feature; causality
  has not been established and it is not claimed fixed here. All four download
  cases (direct/Hub × desktop/mobile), cancel, confirmed binary integrity,
  missing-file errors, external links and the stabilized collapse test passed.
- Frontend and connection TypeScript, Biome, build, source/dist verification
  and `git diff --check`: passed. Source/dist verification is hash consistency,
  not authenticity.
- The user-authorized release check on October 15 ran the complete browser
  suite again: **53 passed, 0 failed** (2.2 minutes), including both Hub
  resume scenarios and all four download scenarios. This does not erase the
  earlier intermittent failure or establish its cause.
- Independent source review found no actionable security/correctness issues in
  the scoped implementation and independently passed the nine link/backend
  unit tests available at review time.
- A small follow-up review found a non-blocking stale clipboard-feedback race
  when closing one external-link dialog and opening another before copy
  completion. Operation generations now invalidate late feedback on close,
  reopening, another copy and unmount; this does not alter file-download scope.

Known non-failing notices include Vite's chunk-size warning and Node's
typeless-package warning. Build tools were not upgraded for this feature.

## Visual inspection

The in-app Browser tool was unavailable. Actual Chromium screenshots from
isolated real Pi/Hub pages were opened and inspected instead. URLs were ephemeral
loopback direct routes and `/s/<generation>/` routes, not the public deployment.

- Desktop: 1440 × 900, centered confirmation, legible Chinese path and both
  buttons inside the viewport.
- Mobile: 390 × 844, wrapped path and vertically stacked, reachable buttons;
  no horizontal page overflow, overlap or clipped dialog.
- Screenshots wait for the opening animation to finish. Earlier mid-animation
  captures were not accepted as final visual evidence.
- Evidence: `.tmp/file-download-visual/` and the final browser run's
  `test-results/` contain `download-confirm-desktop.png` and
  `download-confirm-mobile.png` under their individual scenario directories.

This is browser viewport validation, not a physical-phone or public-site test.

## Deployment boundary

The implementation and validation phase changed only local source,
documentation, tests and tracked built assets. The user subsequently authorized
committing/pushing and updating/restarting the deployed extension and Hub.
Actual rollout outcomes are reported separately; this validation report does
not pre-claim deployment success. Temporary Pi and Hub fixtures stop when their
tests finish. No tunnel, Caddy, credential or persistent-data changes are
required for this feature.

The intermittent resume-handoff failure remains a release-check concern; a
passing isolated rerun does not establish that all reconnect races are fixed.
The isolated desktop/mobile resume-handoff scenarios were then repeated twice:
**4 passed, 0 failed** (21.3 seconds). This is a stability observation, not a
causal diagnosis or a fix for the intermittent failure.

To enable the feature online, deploy the updated Pi extension and its matching
browser assets, reload/restart that Pi using the existing update workflow, then
refresh/reopen its page. The existing Hub transparently proxies attachments;
no Hub restart or tunnel/port change is required solely for this feature.
