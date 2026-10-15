# Date-bounded browser history validation

## Scope and reproduction

The previous initial snapshot copied both the active branch and tree message
bodies into one frame. A live diagnostic measured 214,925,659 bytes, exceeding
the Hub's existing 16 MiB limit. The initial handshake succeeded, but the large
snapshot was rejected and the browser retried. This change bounds history at
the source; it does not raise that limit or edit session files.

Before implementation, the new real Pi/Hub regression failed with
`Hub closed before bounded state_sync` using a temporary 20 MiB message. The
same regression now receives a bounded initial page, loads selected old dates
and older pages, rejects invalid/stale queries, and verifies that the original
JSONL hash is unchanged. Tests use synthetic data and isolated processes only.

## Functional coverage

- Backend half-open dates, entry-ID cursors, count/byte limits, oversized
  text/tool/image/custom previews, immutable inputs, and bounded tree data.
- Browser local-calendar dates, stale session/runtime replies, date-preserving
  background sync, and historical-view isolation from current live events.
- Real Pi plus packaged Hub, including server-filtered saved sessions.
- Real browser date changes, recent/old page isolation, and the `/resume`
  date picker on desktop and mobile viewports.
- Existing 6,000-entry regression now verifies bounded history and a declared
  partial tree rather than requiring every original body in a single frame.
- Large tool regression now checks explicit previews and complete original
  workspace files. It no longer claims that a bounded parameter preview is a
  complete copy of an original 300 KiB tool argument.

The backend regression is included in CI against the production-only installed
runtime. The selector is included in source/dist correspondence checks and
connection-module type checks.

## Review and measured results

The independent review reproduced two page-boundary defects: orphan tool
results were dropped by the browser converter, and returning to live dates
could lose streaming deltas because Pi persists assistants only at message end.
Both now have failing-before/passing-after behavioral tests. Orphan results
remain independently expandable, including `read`; live deltas create a fresh
stream target without modifying the last completed assistant. Final message
end restores the complete answer. An initial large-tool browser regression
also exposed lost tool identity in previews; previews now retain bounded
invocation structure and explicit notices. Follow-up review verified all three
reproduction paths and found no remaining material issue in those fixes.

- Final Node unit suite: 165 passed, 0 failed, 0 skipped.
- Real Pi connection/Hub/history backend suite: 10 passed, 0 failed.
- The final 20 MiB fixture produced a maximum received frame of 67,646 bytes,
  100 initial entries, and 154 lightweight tree nodes; its JSONL hash stayed
  unchanged. This is a synthetic regression measurement, not a claim that a
  production process has already loaded this build.
- Frontend build, connection-module type checks, Biome, source/dist hash
  correspondence, and whitespace checks passed. The existing Vite chunk-size
  and Node typeless-package warnings remain; no dependency changes were made
  to silence them.

- Full browser rerun: 47 passed. The initial 45-pass/2-fail run exposed the
  tool identity regression described above; those failures were addressed,
  not skipped.
- Production-only Git installation, update and tarball consumption passed.
  Real prepare rejected changed source and all six existing stale-input
  variants. Packaged Hub init/issue/serve/HTTP/revoke/SIGTERM lifecycle passed
  after both Git update and tarball installation. No shared Pi installation
  was modified.

## Visual inspection

Inspected an isolated real Pi page at its temporary loopback URL, not the live
public site. Browser automation used standalone Chromium because the in-app
Browser control interface was unavailable. This is not an actual phone test.

- Desktop: 1440 × 1000; date fields, actions, old-only message and composer
  remain visible without overlap.
- Mobile: 390 × 844; two date columns fit, action buttons wrap, pagination and
  preview/partial-tree notices remain readable, and the composer fits.
- Mobile saved-session picker: date controls, old-date result and Cancel action
  fit inside the viewport.

Raw screenshots are ignored local test artifacts:
`.tmp/history-visual-{desktop,mobile}-{old,recent,saved}.png`.

## Deployment and remaining boundaries

This validation concerns source and locally built assets. No production Pi,
Hub, container, gateway or SSH tunnel was restarted, reconfigured, or updated.
Installed extensions and already running Pi processes do not change merely
because a Git commit is pushed.

The Hub portal still lists online Pi processes; saved-session archive dates
are selected in the Pi `/resume` picker. Browser date filtering does not prune
model context, delete history, or make full oversized records available in the
browser. Full records remain in the original session files.

The separate resume-to-new-generation URL handoff defect is not fixed by
date-bounded loading. Do not treat this change as a blanket fix for every
WebSocket disconnect or every resume failure.

Follow-up: the independent generation handoff repair and its own verification
are documented in [resume-hub-handoff](2026-10-15-resume-hub-handoff.md).
