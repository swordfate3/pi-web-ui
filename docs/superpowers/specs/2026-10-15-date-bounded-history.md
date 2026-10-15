# Date-bounded history loading

## Approved scope

Default saved-session discovery and conversation history to the most recent three calendar days. Older history is fetched only after choosing its dates. The user approved implementation and a push from the updated `main` checkout. Do not restart production Pi, Hub, or SSH services, change credentials, or edit persisted session JSONL files.

## Observed failure

A real Pi initial `state_sync` frame announced 214,925,659 bytes, while Hub accepts messages up to 16 MiB. It completed the WebSocket handshake and sent `webui_state`, then disconnected before history arrived. Date filtering alone is insufficient: a single recent day or one tool result can also exceed that limit.

## Contract

- `state_sync` remains immediately available with fresh session/runtime identity and a bounded default history page. Every reconnect and `sync_request` uses bounded snapshots; neither tree nor legacy history queries may bypass the limit.
- Browser history requests pass numeric inclusive `from` and exclusive `to` epoch milliseconds. The browser calculates local-calendar boundaries; the server has a safe UTC-calendar three-day bootstrap before the browser supplies its range. Dates must be finite and ordered. An explicit `sessionId` fences requests to the current session.
- Add `get_history` returning a bounded `StateSyncPayload`, including `history: { from, to, nextBefore, total, returned, truncatedEntries, treeLimited }`. `before` is an opaque entry ID, not an array offset. Unknown cursors reject rather than silently changing pages. Pages are newest-first selections returned in chronological order, at most 100 entries and at most 512 KiB of serialized entry data.
- A single oversized entry is represented by an explicitly marked, bounded browser preview. Never mutate its original object or disk contents. Do not silently send base64 images, huge tool arguments, or custom data in a preview. Full persisted data stays available in the original session. Explain the preview in the UI.
- Tree data is a bounded navigation preview, not another full copy of all historical message bodies. Preserve IDs and valid structural parents among included nodes, cap at 1,000 nodes, include explicit `treeLimited` metadata, and do not claim a partial tree is complete. Keep fork/navigation targeting original IDs.
- The UI defaults to recent three days, supports Today and explicit start/end calendar dates, and displays loading/error/empty/preview states. Page changes replace the visible history page, bounding browser memory. Stale replies after session/runtime changes must not overwrite the new session. Background sync retains the chosen date range; live events must not inject today's messages into an explicitly historical date view.
- The saved-session picker (`/resume`) defaults to sessions modified in the recent three-day range. Filtering takes place on the server; only compact metadata is sent. Allow a date change to issue a fresh query, retain existing project scoping, opaque selection capabilities and runtime fences. A capped result must report that it is capped. The Hub portal remains an online-process directory, not a saved-history database.
- Do not increase Hub's 16 MiB limit. Keep ordinary raw Pi events unchanged; if an outgoing envelope itself would violate a conservative transport ceiling, return a small explicit error instead of repeatedly sending an oversized frame.

## Acceptance

Unit tests cover calendar ranges, half-open boundaries, cursors, very large individual entries, bounded tree payloads, unchanged source objects, stale replies, and date-preserving sync. Real isolated Pi/Hub tests prove the oversized-history case receives a bounded initial snapshot and remains connected, dates load only requested entries, and invalid/stale requests reject. Verify desktop and mobile UI screenshots, the frontend build, unit suite and source/dist correspondence before push.
