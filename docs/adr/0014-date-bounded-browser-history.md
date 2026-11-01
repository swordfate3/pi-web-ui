# ADR 0014: Date-bounded browser history

## Status

Accepted for the date-bounded history change; production rollout is separate.

## Context

The old initial snapshot duplicated the active branch and full tree message bodies in a single WebSocket message. A measured live frame was about 205 MiB. The Hub's 16 MiB message limit correctly rejected it; the browser then automatically retried the same oversized snapshot. A recent session can still contain months of history, and even one day's tool output can exceed the limit.

## Decision

Browser history is a read-only window, not the model's context or the persisted JSONL.

- Default to three calendar days. The browser supplies local-calendar half-open timestamp bounds; UTC is only the server bootstrap fallback.
- `state_sync`, `sync_request` and explicit history reads return bounded pages. Older/newer navigation replaces one visible page; it is not an unbounded in-memory accumulator. A cursor-only trail allows bidirectional navigation. The first older-page request captures `history.headId` as an inclusive `through` anchor so append-only chat cannot shift pages already read. Returning to latest explicitly clears the anchor and selects the recent local-calendar range.
- Pinned pages and past-date first pages retain their rows and reading position across background pushes/reconnects. New replies produce a notice rather than injecting live text. Live range-mismatched reconnect snapshots still trigger a scoped reconciliation, so replies completed offline are not lost. Proven branch replacements reset retired page identities; unknown anchors/cursors recover to the selected range's first page without an unbounded query. Transient page errors preserve the last successful page.
- The main conversation's date filter defaults to collapsed, showing the applied date range in a compact toggle. Expanding exposes the existing date controls and metadata; collapsing does not request history, change the applied range, or discard unapplied edits. Loading/error/historical-view warnings and pagination remain visible when collapsed. Saved-session picker date controls stay expanded.
- Date selection and pagination happen on the server before transferring message bodies. History metadata declares the range, count, next entry-ID cursor, preview count and partial-tree status.
- Tree navigation receives bounded previews rather than duplicate full tool outputs. IDs remain suitable for Pi navigation; the UI declares omitted nodes.
- A single oversized record becomes an explicitly marked browser preview. Persisted originals remain unchanged. No query bypass may send its original unbounded body.
- Preserve session/runtime fencing and never merge a delayed historical response into a different session. Preserve date bounds across background sync. Do not mix live current-day updates into a historical-only view.
- Saved-session discovery (`/resume`) returns compact, server-date-filtered metadata. The Hub portal continues to describe currently registered online processes; it is not a searchable archive of all saved sessions.
- Every complete UTF-8 `state_sync` / `get_history` / `sync_request` JSON envelope is at most 256 KiB before compression, including metadata and framing. A page has at most 40 entries / 192 KiB, each entry at most 16 KiB, and tree previews at most 200 nodes / 32 KiB. Final-envelope reduction preserves exact identities and older-page progress. Oversized non-history metadata fails closed with a small error, not repeated oversized frames.
- `get_entry_detail({entryId,sessionId,runtimeId,cursor?})` reads only a persisted entry on the current branch. Each complete response is at most 64 KiB. Authenticated opaque cursors bind session, runtime, current leaf, entry identity/revision and offset; stale/cross-scope requests are rejected. Readable text is returned without inline binary/base64 bodies or arbitrary path access.
- The browser retains at most 200 items / 512 KiB source-like serialized content, each at most 64 KiB, plus one detail chunk. Explicit previous/next interaction replaces rather than concatenates; only cursor metadata is retained. With `presentation:"markdown"`, textual entry pages prefer closed block boundaries and declare `format:"markdown"`; oversized atomic blocks or structured entries explicitly use `format:"text"`. Code fences, `$$` and native display-math blocks are kept together where they fit. This is a conservative boundary finder, not a full Markdown syntax/semantic preservation guarantee. The reader also offers source view. Date/page, branch/session/runtime and disconnect changes invalidate details. Tool invocation/result previews and individually bounded synthetic system preview rows preserve access to omitted source entries.
- Hub's separate 16 MiB in-flight transport slot preserves explicit file previews; it never enlarges the 256 KiB history budget. Initial JS/CSS, explicit upload/download streams and lifetime traffic are excluded.

## Consequences

Messages older than the selected dates require a date selection; messages within the range can be read in both directions. Very large individual records show previews with an explicit paged reader. This intentionally bounds mobile transfer/parse/render work. It does not delete history, compact model context, or alter TUI messages. Date-bounded loading alone did not fix resume-to-new-generation URL handoff; the separate follow-up fix is described in ADR 0013 and ADR 0008.

Pi core memory and getBranch/getTree work may still scale with original history;
serialized browser retention is not total JS/React memory. No constant RSS, CPU,
phone latency or Docker volume quota is promised. See [Hub budgets and safe rollout](../hub.md)
for 8 MiB logical state, preserve-only legacy/grant/receipt policy and Hub-first/all-writers ordering.

## Verification

Pure behavioral tests exercise dates, page cursors, oversized records, immutable inputs, and stale frontend responses. `e2e/date-history.integration.ts` exercises real Pi and packaged Hub with synthetic large JSONL. `e2e/features/date-history.feature` covers real browser date selection and responsive controls; screenshots are visually inspected separately from DOM assertions.

The [bounded-state validation record](../validation/bounded-hub-state.md) includes
full-frame byte measurements, unchanged temporary 20 MiB JSONL hashes and actual
1440px/390px screenshots through real Pi and the rebuilt packaged Hub. The visual
runner explicitly uses Playwright Chromium fallback, not in-app Browser automation.
