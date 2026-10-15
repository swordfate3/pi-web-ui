# Resume through Hub: generation handoff repair

## Scope and cause

`/resume` successfully replaced the Pi session, but this also replaced its Web
registration generation. The Hub correctly retired the old generation and
closed its WebSockets. The browser then repeatedly dialed the retired path
(`410`), so returning to the portal and selecting the Pi was necessary.
This reproduced with tiny histories and is independent of large snapshot size.

The repair gives an already connected browser an in-memory capability to resolve
the exact Pi's first verified successor. The browser changes only its route and
reconnects; it does not reissue the session action or reload the mounted app.
Old links stay invalid. Cross-origin requests, unknown/expired capabilities,
revoked grants, Hub restart and a disappeared bound successor cannot authorize
a move to a different live Pi.

## Regression evidence

- Before implementation, three targeted Hub tests failed because no browser
  handoff capability was provided. Both desktop/mobile real-browser scenarios
  failed to receive a replacement session snapshot after `/new`.
- After implementation, all 15 Hub/transport tests passed. Tests cover the still-live
  original, a pending replacement, the same Pi's first successor, another Pi's
  exclusion, old-path `410`, idempotent lost-response retry, refusal to follow a
  second successor, cross-origin refusal, revocation, restart and 45-second
  expiry. Only the expiry test advances the Date clock; sockets remain real.
- Independent review reproduced three additional races/control-plane problems:
  replacement during backend proof, a failed replacement handshake losing the
  capability, and a backend-origin reserved event overwriting it. All three got
  deterministic failing real-transport regressions before their repairs. The
  original capability now remains until a fresh Hub control frame arrives;
  successive failed handshakes share the same 15-second recovery deadline.
  Reserved Hub control frames from backends are dropped; ordinary Pi events
  retain their bytes and semantics.
- The targeted browser scenarios passed on desktop and mobile: create/name two
  histories, then restore each in succession without portal navigation. Actual
  WebSocket snapshot IDs, path changes, correct history and the untouched other
  Pi route are asserted. No WebSocket or store is mocked.
- The expired-link recovery message has an English/Chinese regression that
  failed before adding its dictionary entry, then passed in the full unit suite.
- The first full-browser run passed 48/49. The existing large-tool test read
  `innerText` from offscreen `content-visibility:auto` parameters. Waiting for
  text alone did not help; explicitly scrolling the parameter code block into
  view fixed the test without changing its original preview-size, content or
  file-integrity assertions. The next full run passed 49/49. Final verification
  after the independent-review repairs is recorded below.

## Final verification

After the three review repairs, the final rebuilt assets passed:

- `npm run test:unit`: 172 passed, 0 failed (including 15 Hub/transport tests).
- `npm run check`, frontend TypeScript and `tsconfig.connection.json`: passed.
- `npm run build:web` and `npm run verify:dist`: passed; tracked frontend and
  Hub outputs correspond to the current source.
- Real Pi backend integrations for portable connection, Hub and date history:
  10 passed, 0 failed.
- Full Playwright-BDD suite: 49 passed, 0 failed, approximately 1.9 minutes.
- Isolated production-only Git install/update and tarball install: passed;
  stale-source prepare checks rejected all six exercised mismatches; installed
  Hub init/issue/serve/HTTP/revoke/SIGTERM passed for Git update and tarball.
- Source/doc `git diff --check -- ':!dist'`: passed. Generated JavaScript is
  kept as emitted, not manually reformatted.

Existing warnings remain: Vite's large-chunk notice and Node's typeless-package
and experimental MockTimers notices. They did not fail these checks.

The independent bounded re-review cleared all three reported P2 findings and
found no additional actionable issue in those changes or adjacent lifecycle/
security paths. It independently rechecked first-successor fencing, the shared
retry deadline, abort/visibility guards, rejection of sends during recovery,
fresh-capability replacement and absence of lifecycle replay. This is scoped
review evidence, not a claim that all possible network failures are eliminated.

## Rendered-page inspection

The app Browser tool was not available. Inspected screenshots from isolated
Chromium pages served by the real Pi/Hub path at ephemeral loopback
`/s/<generation>/` routes, not the public site:

- `.tmp/resume-handoff-desktop.png`: 1440 × 900.
- `.tmp/resume-handoff-mobile.png`: 390 × 844.

Both show the correct second restored session, a green connection indicator,
its unique message marker and reply, the successful-resume notice, date
controls and an unobstructed message input. Mobile text wraps without overlap
or horizontal overflow; no WebSocket-error banner or blank content was visible.
This is screenshot validation, not a claim of physical-phone/public-site testing.

## Deployment boundary

No running Pi, Hub, Docker volume, tunnel, Caddy deployment or password was
changed by these tests. Temporary Pi and Hub processes stop through their test
fixtures. Test installation uses a dedicated temporary root, not shared Pi state.

Deploy the Hub server and Pi's browser assets together. Updating only the
frontend cannot add the handoff endpoint to an old Hub. Preserve config/state,
grants and generation records while updating/restarting Hub; its restart closes
existing browser connections, which must first reopen the Pi from the portal.
The short-lived browser capabilities intentionally do not survive that restart.
Existing SSH/Caddy destinations do not change for this fix.

Direct (non-Hub) pages retain their original reconnect flow. This does not
auto-enable Pi's advanced command context: after replacement, `/webui` is still
required before another advanced session operation, as explained by the UI.
