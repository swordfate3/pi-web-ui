# ADR 0014: Date-bounded browser history

## Status

Accepted for the date-bounded history change; production rollout is separate.

## Context

The old initial snapshot duplicated the active branch and full tree message bodies in a single WebSocket message. A measured live frame was about 205 MiB. The Hub's 16 MiB message limit correctly rejected it; the browser then automatically retried the same oversized snapshot. A recent session can still contain months of history, and even one day's tool output can exceed the limit.

## Decision

Browser history is a read-only window, not the model's context or the persisted JSONL.

- Default to three calendar days. The browser supplies local-calendar half-open timestamp bounds; UTC is only the server bootstrap fallback.
- `state_sync`, `sync_request` and explicit history reads return bounded pages. The visible page is replaced when changing dates or requesting an older page; it is not an unbounded in-memory accumulator.
- Date selection and pagination happen on the server before transferring message bodies. History metadata declares the range, count, next entry-ID cursor, preview count and partial-tree status.
- Tree navigation receives bounded previews rather than duplicate full tool outputs. IDs remain suitable for Pi navigation; the UI declares omitted nodes.
- A single oversized record becomes an explicitly marked browser preview. Persisted originals remain unchanged. No query bypass may send its original unbounded body.
- Preserve session/runtime fencing and never merge a delayed historical response into a different session. Preserve date bounds across background sync. Do not mix live current-day updates into a historical-only view.
- Saved-session discovery (`/resume`) returns compact, server-date-filtered metadata. The Hub portal continues to describe currently registered online processes; it is not a searchable archive of all saved sessions.
- Keep Hub's 16 MiB ceiling. Unexpected oversized outgoing envelopes produce a small explicit error rather than a repeated oversized frame.

## Consequences

Older messages require a date selection; very large individual records show previews. This intentionally bounds mobile transfer/parse/render work. It does not delete history, compact model context, or alter TUI messages. Date-bounded loading alone did not fix resume-to-new-generation URL handoff; the separate follow-up fix is described in ADR 0013 and ADR 0008.

## Verification

Pure behavioral tests exercise dates, page cursors, oversized records, immutable inputs, and stale frontend responses. `e2e/date-history.integration.ts` exercises real Pi and packaged Hub with synthetic large JSONL. `e2e/features/date-history.feature` covers real browser date selection and responsive controls; screenshots are visually inspected separately from DOM assertions.
