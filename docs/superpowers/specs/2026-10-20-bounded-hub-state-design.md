# Bounded Hub state and browser transport

Status: approved in conversation on 2026-10-20; implementation on `codex/bounded-hub-state`, merge to main after verification. Deployment is separate.

## Contract

Original Pi JSONL, model context, project files and Gate deployment records are never modified or deleted. Hub remains a thin, authenticated transport and does not persist conversation bodies. Every state_sync/get_history/sync_request complete UTF-8 JSON envelope is at most 256 KiB before compression, including metadata and envelope overhead. Initial app JS/CSS, user-requested downloads/uploads, total lifetime traffic and Pi core session memory are not covered by this ceiling.

## Browser history

Use at most 40 entries and 192 KiB entries per history page; entry maximum 16 KiB. Tree previews use at most 200 nodes and 32 KiB total. The complete envelope is checked and reduced deterministically before sending, preserving exact opaque IDs and cursor progress. Oversized non-history metadata fails closed with a small explicit error, never a retry loop. Date selection and older-page loading replace the window. Preview truncation is explicit, deterministic, never an LLM summary or a mutation of source data.

Add a session/runtime-scoped `get_entry_detail` read of a persisted entry on the current branch. Input includes entryId and a bounded cursor; return readable text sections with a maximum 64 KiB complete envelope per chunk, explicit continuation and original-entry identity. No arbitrary filesystem read, cross-session lookup or unbounded JSON serialization. Images/binary data are not returned as base64 detail bodies. Reject bad offsets, obsolete revisions/cursors and changed session/runtime. Expose a user-triggered chunk viewer on preview messages/tool rows, preserving permission and scope fences. No automatic whole-entry concatenation or prefetch.

Browser retained conversation content has limits of 200 rendered items, 512 KiB aggregate serialized source-like content and 64 KiB per live item. Budget is applied at every state-changing path (including live deltas, tools and system messages), not only sync. Oversized live items get a visible preview indication; subsequent content cannot make them grow indefinitely. Current detail viewer holds only one 64 KiB chunk and resets on session/runtime change. Per-item trimming must avoid quadratic cloning of a huge input. Preserve tool identity, ordering, action safety and explicit notices. Artifact collection/side caches derived from the window must not accumulate indefinitely.

## Hub persistent state

Fixed logical state ceiling: 8 MiB; active grant count ceiling: 512. All Hub-created persistent writes (grant issue, generation issuance, restart receipts and operation clocks, authentication state) must respect a common safe quota boundary; the bounded scan is not performed for each streamed delta. No-follow private file checks and atomic replacement are required. Quota failure leaves existing data intact, produces a small non-secret error and does not trigger broad deletion. File-system allocation, Docker images/build cache and Docker logs are separate budgets.

Legacy generation files must never be removed merely because they are old. Introduce an opt-in/version-negotiated bounded registration flow: Hub issues a generation for an authenticated run, scoped to the current Hub boot and a monotonically superseding per-run issuance slot. Keep only bounded pending/current handoff state. Bounded generations use a disjoint `b2-` URL namespace so they cannot be laundered through legacy arbitrary 32-hex enrollment. Previously issued generations cannot be registered again after supersession/unregister/restart, even after compaction. Old clients retain the safe legacy path with existing tombstones and quota; missing protocol support must not silently relax identity. A new Hub handles both old and new extensions; a new extension degrades to an old Hub only on an explicit unsupported-protocol response, not on authentication/timeout/other failures. An unmodified old Hub has no such response and is therefore below the new extension's automatic-registration version floor: deploy Hub first. Do not change capability token secrecy, routing proofs, Origin checks or per-run credential isolation.

All existing legacy tombstones remain in this mixed-mode release: they protect the global URL namespace even after their original grant is revoked. Future legacy compaction requires globally disabling arbitrary legacy enrollment and externally enforcing a minimum executable version, a separate compatibility-breaking migration. Never erase proof of revocation or let old generation URLs target a different Pi. Unused grants cannot be silently expired: existing long-running containers and deliberately offline credentials must keep their semantics. Safely revoked grants can be removed once all associated active/handoff/operation dependencies are gone, because missing grants reject authentication. Remaining genuine live grants obey quota, failing closed if full. CLI issue/revoke and serve share one cross-process writer lock and atomic quota reservation; a process-local mutex is insufficient. Preserve revocation capacity at quota, and never auto-steal a writer lock that could belong to a live process.

Finished operation detail may be reclaimed after seven days, with count/byte quota, only when gate terminal status and idempotency retention are proven; otherwise preserve the security-relevant receipt and fail closed on quota. Do not guess terminal state or repeat an old operation after reclamation. Expose safe storage diagnostics (bytes/counts/budgets, no tokens/paths/prompt data). If a dependency prevents safe TTL deletion, state the limitation instead of unsafe deletion.

## Hub transient state

No persistent static-response/body cache. Bound browser sockets and registration peers, concurrent backend probes, compression concurrency and queued messages. Use an explicit FIFO forwarding queue with at most 512 KiB waiting per direction including incoming waiting-message reservation, plus one at-most-16-MiB in-flight message. A second message above 512 KiB cannot queue; it closes the slow-consumer connection. Thus maximum retained forwarding payload is 16.5 MiB per direction, not total process memory; this exception preserves existing explicit large file previews without enlarging the 256 KiB history budget. Do not release credit merely when send() returns: account send completion and outbound buffering. Close slow consumers with a reconnectable reason instead of indefinite buffering. Retain existing origin, session, runtime and handoff semantics. Browser reconnect must not rapidly resubmit an oversized payload. Upload/download streams remain streamed and separate from chat budgets.

## Deployment budget

Document Hub Docker logs at 2 MiB x 3 and keep container memory/tmpfs limits. Changing the running host Compose or deploying is not part of this source-only merge. State ceiling is enforced by application writes, not by claiming a named volume has an automatic quota. Existing oversized state is reported, not deleted on upgrade. Old protocol state remains readable; unsafe downgrade is documented and must fail closed rather than accepting retired links.

## Acceptance

- Real Pi + packaged Hub: synthetic large JSONL remains byte-identical and all initial/history/sync frames obey 256 KiB; every older page makes progress.
- Huge Unicode, escape-heavy strings, deep/wide metadata and tool content cannot bypass budget; detail chunks obey 64 KiB and reject stale or cross-scope requests.
- Long live streams/tool loops stay within browser window and pending-queue limits; no duplicate actions or hidden content loss.
- Thousands of bounded generation rotations do not create thousands of persistent files. Replay after unregister, supersession, restart, migration and quota exhaustion fails; live sessions recover normally.
- Grant/receipt/quota tests use private temp directories, not production credentials or state; unknown/symlinked files are never deleted.
- Full unit/static/build/dist verification, real-Pi integration, desktop/mobile screenshot review and independent whole-branch review before main merge.

## Boundaries

CPU cost of Pi SDK getBranch/getTree can still scale with original history. Avoid repeated full tree fetch for live deltas; do not promise constant-time Pi loading. Browser RAM includes React/JS engine overhead beyond the retained-content budget. No fixed phone page-load latency is promised.
