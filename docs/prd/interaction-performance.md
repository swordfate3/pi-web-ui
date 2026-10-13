# PRD: Responsive interactions

## Goal

Opening navigation or one tool detail should not repeat rendering and parsing work for the entire conversation. Preserve full history and raw output; improve the work scheduling and mounted view, not the source data.

## First optimization scope

- Isolate the chat list from unrelated application UI state. Reuse unchanged item references and stable callbacks; language changes remain observable.
- Cache derived tool previews. Bound both lines and characters so a huge single line is not an accidental unlimited preview.
- Keep access to original tool data. If expensive full output is displayed as plain text or a limited page, clearly identify that presentation and retain a full-copy route.
- Deduplicate pending syntax-highlighting work and use a bounded, correct-key cache. Promise scheduling is not described as worker offloading.
- Virtualize sidebar rows without deleting nodes from the tree. Search/navigation must locate unmounted matches by their model index, not query the DOM for every historical row.
- Reuse tree structure and summaries where inputs are unchanged; search and collapse should operate on that model rather than regenerate unused large tool summaries.

## Presentation and scheduling details

- Tool previews show at most 12 lines / 4096 characters. Large complete content is available through explicit expansion, plain-text pages (16000 characters / 200 lines), and full-copy controls. Pi tool-level truncation remains visible; UI copy cannot recover bytes Pi never returned.
- Highlighter caches are bounded and identical work is deduplicated. Large code avoids whole-content Shiki and excessive token DOM. This is not worker offloading.
- Desktop sidebar gap width commits once rather than animating every historical message's layout; the fixed surface uses transform animation with reduced-motion support.
- Conversation initial/resize bottom following is immediate instead of spring animation during tool height changes. Explicit user scroll controls retain their own behavior; upward reading position must remain preserved.
- Tree previews have a separate scan budget, including whitespace. A focused virtual row is retained outside the visible window (at most one extra row); session identity resets navigation owner state.

## Invariants

- Complete Pi tree, branch/source identity, labels, search, selected/current state, Branch/Continue and manual `/webui` gates remain intact.
- Opening/closing surfaces does not submit messages, reconnect WebSocket or clear drafts/queued messages.
- English/Chinese text and dynamic content boundaries remain intact.
- Default-hidden sidebar and default-collapsed reasoning/tool details remain.
- Existing-session files and running user Pi instances are not performance fixtures.

## Evidence

Use isolated real Pi fixtures for 6000-message navigation and large tool outputs. Record viewport, fixture, baseline runtime, number of mounted tree rows, click-to-render samples and browser long tasks. These are local measurements, not universal latency guarantees. Functional E2E, pure logic tests and actual desktop/mobile Browser screenshots are reported separately.

## Later scope

Streaming delta coalescing, normalized store updates, chat dynamic-height virtualization and worker-based syntax highlighting require additional lifecycle/scroll-state validation and are not automatically included in this first pass.
