# Bounded Hub State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep browser session transfer and Hub-owned state bounded without deleting original Pi conversations.

**Architecture:** The extension produces byte-budgeted previews and scoped detail chunks; the browser keeps a bounded live window. Hub uses bounded issued generations, safe state quota and forwarding queues while retaining old-client safety.

**Tech Stack:** TypeScript, Node >=22.19.0, ws, React/Zustand, node:test, real-Pi RPC integration, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-bounded-hub-state-design.md`

## Global Constraints

- Original Pi JSONL, model context, project files and Gate deployment records are never modified or deleted.
- Every state_sync/get_history/sync_request complete UTF-8 JSON envelope is at most 256 KiB before compression.
- History: at most 40 entries, 192 KiB entries, 16 KiB per entry; tree: 200 nodes and 32 KiB.
- Detail chunks: at most 64 KiB complete envelope, scoped to exact session/runtime/current branch and stable entry revision.
- Browser window: at most 200 items, 512 KiB retained content, 64 KiB per item; detail viewer retains one chunk only.
- Hub persistent logical state: 8 MiB; grant count: 512; pending forwarding bytes: 512 KiB per direction.
- Existing generation tombstones and credentials must not be unsafely erased, replayed or expired. Fail closed when safe cleanup is unavailable.
- No production deploy/restart, network credential changes or host configuration mutation. Merge locally to main only after verification.
- Use latestCtx in delayed extension handlers, no stdout/stderr from extensions, thin transport projections only, and tracked dist rebuilt before merge.

---

### Task 1: Bounded history, details and browser live window

**Files:** Modify `extensions/session-history.ts`, `extensions/mirror-server.ts`, `extensions/live-transport.ts`, `src/web/src/core/types.ts`, `src/web/src/core/chat-conversion.ts`, `src/web/src/core/store/session-slice.ts`, relevant chat components and i18n. Create focused history-budget/detail/window modules if needed. Extend `tests/session-history.test.ts`, `tests/history-store.test.ts`; add `tests/entry-detail.test.ts` and window tests. Update connection tsconfig for new tests.

**Interfaces:** Existing state_sync/get_history/sync_request retain their envelope and scope fields. New `get_entry_detail` request consumes `{sessionId,runtimeId,entryId,cursor?}` and returns `{sessionId,runtimeId,entryId,text,nextCursor}` with opaque revision-fenced cursor; text is deterministic readable content, not source JSON/base64. Expose `historyPreview` on chat items; button loads one detail chunk. Final history envelope budget must include model/status and request id, not only selected entries.

- [ ] Write tests that fail on current code: worst-case entries+tree+metadata complete envelope exceeds 256 KiB; newest-first byte pages must make progress; oversized UTF-8 details require stable continuation and cross-scope rejection; long live stream and tool bursts exceed browser retention; stale detail replies must not update the new session.

```ts
assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 256 * 1024);
assert.ok(Buffer.byteLength(JSON.stringify(detailEnvelope)) <= 64 * 1024);
assert.equal(hashOriginalSessionAfter, hashOriginalSessionBefore);
assert.ok(state.items.length <= 200);
```

- [ ] Run targeted node:test with the existing TS loader and confirm expected RED before implementation.
- [ ] Implement budgeted selection, final-envelope reduction, immutable chunk reads, explicit preview UI, and centralized window limits on every store update. Preserve identity/cursors, disable unsafe copy/regenerate on previews if full source is required, reset details on lifecycle changes. Do not store full entries in preview metadata.
- [ ] Re-run targeted tests plus related revision/download/history/store suites and connection tsc; update existing count-dependent paging tests to assert the approved contract and full traversal.
- [ ] Commit source/tests only as `feat(history): bound snapshots and load entry details on demand` and provide RED/GREEN commands/results in task report.

### Task 2: Bounded Hub storage, registration and forwarding

**Files:** Modify `hub/server.ts`, `hub/config.ts`, `hub/restart-api.ts`, `hub/management.ts`, `extensions/session-registration.ts`. Create `hub/state-budget.ts`, bounded-registration/queue helpers as needed. Extend `tests/session-hub.test.ts`, `tests/session-registration.test.ts`, `tests/hub-restart-api.test.ts`; add storage/queue tests.

**Interfaces:** Existing legacy register/unregister remains fail-closed. Add explicit protocol negotiation and Hub-authorized generation issuance: response names unsupported protocol distinctly, never infers unsupported from auth errors. Bounded protocol authorizes exact current generation/boot/run and short pending successor; discarded generations remain invalid without append-only tombstones. Common write helpers atomically reserve/verify logical state before writes; diagnostics return only aggregate bytes/counts/limits. Storage quota cannot remove live grants or security dependencies. Forward queues reserve queued bytes before send and close slow consumers deterministically.

- [ ] Write RED tests for state growth across thousands of rotations, replay after restart/unregister/supersession/compaction, legacy-client compatibility, unsupported-only fallback, quota failure preserving live state, no symlink deletion, and slow-consumer reservation including the incoming frame.

```ts
assert.equal(oldGenerationResponse.status, 410);
assert.ok(storage.logicalBytes <= 8 * 1024 * 1024);
assert.ok(storage.generationFiles <= activeRunCount * 2 + legacyFiles);
assert.equal(JSON.stringify(beforeLiveGrant), JSON.stringify(afterQuotaFailureGrant));
```

- [ ] Run RED tests before production code. Implement fail-closed atomic quota, bounded protocol and cleanup with crash-safe ordering. Keep legacy tombstones unless a proven migration boundary makes removal safe. Reclaim revoked grants only after dependency checks. Receipt cleanup must preserve idempotency: preserve rather than delete when terminal status/retention is unprovable, and document this limitation.
- [ ] Implement connection/probe/queue caps without changing HTTP downloads/uploads or normal routing/Origin/auth semantics. All errors are small and secret-free; no conversation persistence.
- [ ] Run targeted protocol/Hub lifecycle/management/runtime/transfer suites and tsc. Commit as `feat(hub): bound registry state and slow-consumer queues`; report exact compatibility/cleanup behavior.

### Task 3: Integration, visual evidence, packaging and documentation

**Files:** Extend `e2e/date-history.integration.ts`, add focused real-Pi detail integration if needed; use `e2e/harness/` for synthetic screenshot setup. Update `docs/hub.md`, ADR 0014 and event protocol, `docs/development-log.md`, new `docs/validation/bounded-hub-state.md`; rebuild tracked `dist/`.

**Interfaces:** Consume final Task 1 detail/window contract and Task 2 storage/protocol helpers; do not introduce a third incompatible budget. Distribution manifest must cover all new source modules using the existing build script.

- [ ] Strengthen real-Pi assertions to check the complete 256 KiB envelope, detail chunks and scope failures, old-page progress and unchanged JSONL. Run with synthetic sessions only, no production tokens/models.
- [ ] Build with `npm run build:web`, run `npm run verify:dist`, `npm run test:unit`, `npx tsc -p tsconfig.connection.json --noEmit`, `npm run check`, and serial real-Pi integration tests relevant to history, resume, revision and Hub.
- [ ] Inspect screenshots at desktop and 390px mobile widths for preview indication, detail continuation, switching scope, and long tool output. Browser errors/overflows are failures; pure DOM existence is not visual proof.
- [ ] Document actual guarantees/exclusions, aggregate diagnostic access, storage-full behavior, legacy-state migration/downgrade boundary, safe cleanup limitations and deployment recommendation of 2 MiB x 3 log rotation. Do not claim Docker volume quota or constant memory/CPU.
- [ ] Independent whole-branch review, fix findings with covering tests, rebuild dist, re-run checks, then merge feature branch to main locally and re-run unit/dist verification on main. Do not push/deploy unless separately authorized.
