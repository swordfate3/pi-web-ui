# ADR 0002: Raw Web UI Event Forwarding

## Status

Draft

## Context

Pi Web UI forwards a fixed set of Pi lifecycle events from `pi.on(...)` to the browser. This stream includes message, tool, session, model, compaction, retry, and extension UI events. The browser receives these events and decides how to render them.

The design boundary is important: Mirror Server is allowed to transport events and serve request/response methods, but it must not turn extension payloads or tool events into Pi Web UI product concepts such as artifacts, details, tabs, or status rows.

## Decision

Mirror Server remains a thin event transport. It may subscribe to known event sources, but it does not translate source events into UI models.

For WebSocket delivery, Pi Web UI preserves:

- The original event/channel name.
- The original event payload, except for explicit transport projections described below (JSON safety, redundant snapshots and oversized live frames).
- The ordering in which Mirror Server observes events.

The browser-side app owns feature-specific interpretation. For example, Workspace Artifacts are derived in the browser from `edit` / `write` tool events and session entries; Mirror Server does not emit an `artifact` event.

## Transport Shape

Pi core events use the unified WebSocket event envelope:

```json
{
  "type": "event",
  "event": "tool_execution_end",
  "payload": {
    "toolCallId": "toolu_...",
    "toolName": "edit",
    "result": {}
  }
}
```

Extension event-bus events use the same top-level WebSocket message kind and keep extension payloads nested under `payload`:

```json
{
  "type": "event",
  "event": "some-extension:updated",
  "payload": {
    "payload": {
      "id": "item_123",
      "status": "updated"
    }
  }
}
```

This preserves the source event. In the Web UI, `event` is the event name and `payload` is the event payload.

## Forwarding Rules

Mirror Server may do only transport-safe work:

- Subscribe to an event source.
- Wrap the observed event in Pi Web UI's WebSocket transport envelope.
- Ensure the payload is JSON-serializable.
- Optionally drop or truncate values that cannot be serialized safely.

Mirror Server must not:

- Infer UI state such as artifact, detail tab, status row, or attention state.
- Rename extension-specific fields.
- Derive display summaries.
- Merge multiple extension events into one UI event.
- Reach into extension internals such as raw managers.

## Bounded live transport exception

The application retains a **4 MiB UTF-8 JSON frame limit**, below the Hub's separate 16 MiB limit. Increasing these limits is not the large-session fix. Original Pi messages/session files are not mutated.

`extensions/live-transport.ts` performs only named transport projections:

- `message_update` text/thinking/toolcall deltas omit the duplicate cumulative `payload.message` and `assistantMessageEvent.partial`; the event name, delta, type, content index and other control fields are preserved.
- `agent_end` omits `messages`; `turn_end` omits `message` and `toolResults`. These fields redundantly repeat previously observed messages/history. Their event names and remaining lifecycle fields are preserved, and the browser already retrieves bounded saved history at these boundaries.
- Other payloads are unchanged. After serialization, an oversized allowlisted message/tool/turn/compaction event becomes an explicit `transport_omitted` control with `{sessionId,runtimeId,sourceEvent,bytes}`. It is **not** a fake successful source event, tool result or full-content preview. Unsupported/control events and oversized request responses retain fail-closed errors.

The browser validates identity and omission metadata, displays one dismissible notice per scope, and schedules its existing bounded-history synchronization for terminal omissions. Intermediate omissions do not create per-token polling. Notice text does not claim an unsaved streamed message is already recoverable; full persisted data remains in the original session. Session/runtime changes clear the notice; date/cursor and late-response fences remain in effect.

This exception intentionally narrows the earlier raw-payload promise to avoid repeatedly serializing and sending ever-growing duplicate snapshots. It does not add backend artifact/chat interpretation, remote model calls or arbitrary payload truncation. The final guard still serializes non-projected large fields before checking bytes; it is a wire limit, not an O(1)-memory or bounded-serialization-work guarantee.

## Event Discovery

Pi's `pi.events` event bus does not currently provide a wildcard subscription. Mirror Server cannot automatically hear every possible future extension event unless those extensions emit through a shared channel.

There are two acceptable patterns.

### Pattern A: Known Source Channels

For an extension that emits named channels, Mirror Server may subscribe to a small explicit allowlist and forward each payload unchanged.

Use this only when a source extension is intentionally supported by Pi Web UI and a small Mirror Server subscription update is acceptable.

### Pattern B: Shared Pi Web UI Event Channel

For extensions that want to avoid adding a new Mirror Server subscription, emit a Pi Web UI-visible event through a common channel:

```ts
pi.events.emit("tau:web:event", {
  type: "my-extension:item_updated",
  payload: {
    id: "item_123",
    status: "running"
  }
});
```

Mirror Server subscribes to `tau:web:event` once and forwards it as:

```json
{
  "type": "event",
  "event": "my-extension:item_updated",
  "payload": {
    "id": "item_123",
    "status": "running"
  }
}
```

This is optional. It keeps Mirror Server subscription code smaller, but the extension must opt into the shared channel convention.

## Workspace Features

Workspace features use request/response methods when the browser needs current git state or file content:

- Git status is requested by the browser through a WebSocket method.
- Full git diff is requested when the user opens the `git-diff` right panel tab.
- Artifact file content is requested when the user opens an `artifact-file` right panel tab. Artifacts may live inside or outside the git workspace; Mirror Server reads them as session artifacts produced by successful `edit` / `write` tool calls.

These queries are not raw event forwarding. They are explicit browser-driven reads of current git state or current artifact file content. The browser decides when to refresh them based on connection, sync, tool, and turn events.

## Recommended Extension Event Design

Extensions that want to render well in Pi Web UI should emit self-contained, namespaced, JSON-safe events.

Recommended rules:

- Event names should be namespaced: `source:action`, e.g. `tasks:updated`, `git:diff_changed`.
- Every lifecycle entity should have a stable `id`.
- Every event should include enough fields for the Web UI to update from that event alone.
- Terminal events should include final result/error fields where appropriate.
- Payloads should use plain JSON values only.
- Long text is allowed, but extensions should include a compact summary if they want a compact UI row.
- If state matters after reconnect, provide either persisted session entries or a snapshot/list event.

## Alternatives Considered

### A. Mirror Server Projects Generic Context Items

Mirror Server would convert extension payloads into generic context items.

Rejected. It creates a second place to update when UI semantics change and makes Mirror Server too aware of product features.

### B. Mirror Server Raw Forwards Source Events

Mirror Server forwards event names and payloads only.

Accepted. It keeps the transport simple and puts feature behavior in the Web UI.

### C. Web UI Only Reads Session History

The Web UI could avoid extension events and reconstruct everything from session entries.

Rejected for live UI. Session entries are useful for reconnect and history, but they are not enough for timely running-state updates.

## Consequences

- Adding support for a new extension may require a small Mirror Server subscription update.
- Adding or changing UI behavior should remain a Web UI change.
- Existing extension event shapes stay visible to the browser.
- Mirror Server still needs either explicit channel subscriptions for legacy extension events or one shared Pi Web UI event channel for future extensions.
- The Web UI must tolerate unknown event types and ignore events it does not understand.
- Reconnect behavior depends on event replay, session entries, explicit query methods, or extension snapshot events. This is handled per feature, not by a generic context item cache in Mirror Server.

## Public terminal-prompt lifecycle metadata

`ui_prompt_start` / `ui_prompt_end` (Pi 1.1 and 1.3) are forwarded as
`{kind,title?,sessionId,runtimeId}` only. The bridge keeps one transient outer-prompt
metadata record for `state_sync.terminalPrompt`; session start, shutdown and server
stop clear it. This reconnect projection contains no body, choices or resolver and
is not persisted. The browser renders a terminal-required banner, not a confirmation
UI. Ordinary RPC `extension_ui_request` is not a `pi.on` event and is not intercepted.
Web `extension_ui_response` requests return an unsupported error; there is no trusted
approval channel on the chat origin. See [terminal prompt boundaries](../terminal-prompts.md).
