# Date-bounded History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prevent large-session reconnect loops and provide date-selected, bounded browser history.

**Architecture:** A pure backend history selector creates bounded entry pages and lightweight tree previews. Mirror Server uses it for bootstrap and explicit queries. Browser state owns local-calendar date selection and guards asynchronous page loads by session/runtime identity.

**Tech Stack:** TypeScript, Node, ws, React, Zustand, real Pi faux-provider integration and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-date-bounded-history.md`

## Global Constraints

- Preserve source JSONL, project scoping, runtime fences, and session capabilities.
- No production restarts, credentials changes, new dependencies, or Hub limit increases.
- Three local calendar days; inclusive numeric `from`, exclusive numeric `to`.
- Each page: at most 100 entries and 512 KiB serialized entry data. Tree: at most 1,000 lightweight nodes.
- Run tests against real behavior. Rebuild tracked dist; keep installation usable without development dependencies.

### Task 1: Bounded backend and browser integration

**Files:** Create `extensions/session-history.ts`, `tests/session-history.test.ts`, browser history controls/date utilities and tests; modify `extensions/mirror-server.ts`, frontend types/store/app/resume picker/i18n, and `scripts/web-dist.mjs` source policy.

**Interfaces:** `get_history({from,to,before?,sessionId})` returns `StateSyncPayload` with `history: {from,to,nextBefore,total,returned,truncatedEntries,treeLimited}`. `sync_request` accepts the selected range; `get_saved_sessions` accepts range and returns filtered compact metadata plus explicit truncation if capped. Existing no-argument requests have a bounded default.

- [x] Write failing behavioral tests before implementation. A fixture with an older entry and two recent entries must only return the recent IDs, unchanged and chronological. A huge text/tool/image/custom entry and 10,000-node tree must remain below the page/transport budgets and mark previews.

```ts
assert.deepEqual(page.entries.map(e => e.id), ["recent-a", "recent-b"]);
assert.ok(Buffer.byteLength(JSON.stringify(page.entries)) <= 512 * 1024);
assert.equal(original.message.content, originalContent);
assert.throws(() => queryWithUnknownCursor(), /cursor/i);
```

- [x] Run targeted tests and record expected red output; implement selector, cursor validation, bounded safe previews and lightweight tree data; verify green.
- [x] Integrate all bootstrap/sync/history/tree entry points. Preserve fresh-context policy. Add a conservative final send guard and explicit oversized-message error.
- [x] Implement local-calendar controls and server-backed saved-session date filtering; fence stale requests and retain dates during background sync. Expose empty, loading, truncated-preview and partial-tree states; keep mobile controls inside viewport.
- [x] Run focused frontend/store tests, backend tests, and type checking. Review changes for data loss, cross-session mixing, and bypass routes before marking complete.

### Task 2: Real-path regression, packaging, review and push

**Files:** Add `e2e/date-history.integration.ts`, related real Pi fixture support if needed, focused browser regression, protocol/development documentation, and rebuilt `dist/` assets.

**Interfaces:** Consume Task 1's public WebSocket queries through an isolated real Pi/Hub. Fixtures use only temporary sessions and faux models.

- [x] Create a real saved JSONL containing older entries and a synthetic oversized recent message. Start temporary Pi + Hub and assert every received initial frame remains below 16 MiB.
- [x] Request a chosen old date; assert only the expected marker appears, return to recent range, test paging and stale session rejection, and confirm the original file bytes are unchanged.
- [x] Capture desktop and mobile screenshots of real rendered date controls. Check visible layout and loading/history states, not just DOM existence. Stop temporary processes.
- [x] Run `npm run test:unit`, `npm run check`, `npm run build:web`, `npm run verify:dist` and targeted real-path regressions. Record exact pass/fail outcomes; distinguish baseline issues.
- [x] Obtain an independent code review, address significant findings and re-run affected tests. See the validation report for the findings and measured outcomes.

Delivery gate: commit only scoped files and push without force; verify the remote hash in the final handoff. Do not deploy or restart live processes. Delivery is recorded after Git acknowledges it, not predeclared by this plan.
