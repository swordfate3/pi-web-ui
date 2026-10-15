# ADR 0008: Unified WebSocket Protocol — Single Channel for All Server-Client Interaction

## Status

Proposed

## Context

pi-web-ui currently uses **two communication channels** between the browser frontend and the mirror-server extension:

| Channel | Direction | Content |
|---------|-----------|---------|
| **WebSocket** (`/ws`) | Bidirectional | Real-time Pi events (`event`), state snapshots (`mirror_sync`), commands (`prompt`, `abort`, etc.), responses (`response`), and error messages |
| **HTTP** (`/api/*`) | Request/Response | Health check, RPC proxy (same commands as WS), session list, session file loading, session search, file browser, project list/launch |

This dual-channel design has several problems:

1. **Duplication** — The `/api/rpc` endpoint proxies the same commands that WebSocket already handles. The frontend uses `sendWs()` for writes when connected, falling back to `rpc()` (HTTP POST) when disconnected. This creates two code paths for every command.

2. **Inconsistent patterns** — HTTP endpoints each have ad-hoc request/response shapes. WebSocket messages have `type: "event"`, `type: "response"`, `type: "mirror_sync"`, `type: "state"`, and `type: "error"` — five different top-level shapes with no unified envelope.

3. **State coupling** — The frontend's `app.tsx` maintains `connection` state and conditionally chooses `sendWs()` vs `rpc()`. The `rpc()` function is used both as a fallback for disconnected WS and as the primary path for `refreshState()` and `loadSessions()`.

4. **Session history endpoints moot** — Per ADR 0007, session history browsing is being removed. `/api/sessions`, `/api/sessions/:dir/:file`, `/api/search`, and `/api/sessions/switch` will be deleted anyway.

5. **Unnecessary HTTP server complexity** — The HTTP server does three unrelated things (static files, API routes, WebSocket upgrade). With API routes moving to WebSocket, the HTTP server's only remaining job is static file serving + WebSocket upgrade.

## Decision

**WebSocket becomes the single channel for all server-client application communication.** HTTP remains only for initial page load (static files) and WebSocket upgrade.

### Unified Envelope

All WebSocket messages use a single envelope with a `type` discriminator:

```typescript
type WsMessage =
  | WsRequest       // browser → server
  | WsResponse      // server → browser (reply to request)
  | WsEvent         // server → browser (server-initiated)
  | WsError;        // server → browser (protocol error)
```

#### Request (browser → server)

```typescript
interface WsRequest {
  /** "req" discriminates requests from other message types */
  type: "req";
  /** Unique request ID for matching response. Use nanoid or incrementing counter. */
  id: string;
  /** Command name — matches handler name on server side */
  method: string;
  /** Optional params. Undefined if command takes no params. */
  params?: Record<string, unknown>;
}
```

Examples:
```json
{ "type": "req", "id": "r1", "method": "prompt", "params": { "message": "Hello" } }
{ "type": "req", "id": "r2", "method": "get_state" }
{ "type": "req", "id": "r3", "method": "set_model", "params": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" } }
{ "type": "req", "id": "r4", "method": "navigate_tree", "params": { "entryId": "a1b2c3d4" } }
{ "type": "req", "id": "r5", "method": "get_files", "params": { "path": "/src" } }
{ "type": "req", "id": "r6", "method": "get_git_status" }
{ "type": "req", "id": "r7", "method": "get_git_diff" }
{ "type": "req", "id": "r8", "method": "get_file_content", "params": { "path": "docs/prd/workspace-artifacts.md" } }
```

`get_file_content` supports artifact paths produced by the current session's successful Markdown `edit` / `write` tool calls, including paths outside the git workspace. The response method reads the current file content for display in the read-only `artifact-file` tab.

#### Response (server → browser)

```typescript
interface WsResponse {
  /** "res" discriminates responses from other message types */
  type: "res";
  /** Echoes the request ID for correlation */
  id: string;
  /** true if the method executed successfully */
  ok: boolean;
  /** Result data on success. Omit/undefined on error. */
  result?: unknown;
  /** Error message on failure. Omit/undefined on success. */
  error?: string;
}
```

Examples:
```json
{ "type": "res", "id": "r1", "ok": true }
{ "type": "res", "id": "r2", "ok": true, "result": { "model": {...}, "thinkingLevel": "off" } }
{ "type": "res", "id": "r3", "ok": false, "error": "Model not found" }
```

#### Event (server → browser)

```typescript
interface WsEvent {
  /** "event" discriminates server-initiated events */
  type: "event";
  /** Event name. Pi core events keep their native names; extension events are namespaced. */
  event: string;
  /** Event payload. Shape depends on the event type. */
  payload: Record<string, unknown>;
}
```

This preserves ADR 0002's event forwarding principle — the `event` field is the event name and `payload` is the original payload unchanged.

Examples:
```json
{ "type": "event", "event": "agent_start", "payload": {} }
{ "type": "event", "event": "message_start", "payload": { "message": { "role": "assistant", ... } } }
{ "type": "event", "event": "session_tree", "payload": { "newLeafId": "xyz", "oldLeafId": "abc" } }
{ "type": "event", "event": "session_name", "payload": { "name": "New name" } }
```

#### Error (server → browser)

For protocol-level errors (malformed JSON, missing `method`, unknown `type`):

```typescript
interface WsError {
  type: "error";
  /** Related request ID if applicable */
  id?: string;
  /** Error code for machine handling */
  code: string;
  /** Human-readable message */
  message: string;
}
```

### State Sync Event

**Date-bounded history update:** see [ADR 0014](0014-date-bounded-browser-history.md).
`state_sync` now includes a bounded page rather than every historical message.
`get_history` and `sync_request` accept inclusive numeric `from`, exclusive numeric
`to`, optional `before` entry-ID cursor, and `sessionId` fencing. The returned
`history` metadata includes `from`, `to`, `nextBefore`, `total`, `returned`,
`truncatedEntries`, and `treeLimited`. A lightweight partial `treeNodes` is
declared as such. `get_saved_sessions` accepts the same date range and returns
only compact matching session metadata. Raw Pi events retain their source
meaning; display-window filtering belongs to the browser.

The current `mirror_sync` type becomes a standard event:

```json
{
  "type": "event",
  "event": "state_sync",
  "payload": {
    "entries": [...],
    "treeNodes": [
      { "entry": { "id": "abc123", "parentId": null, "type": "message" }, "parentNodeId": null }
    ],
    "leafId": "abc123",
    "model": {...},
    "thinkingLevel": "off",
    "sessionName": "My session",
    "sessionFile": "/path/to/session.jsonl",
    "isStreaming": false,
    "contextUsage": {...}
  }
}
```

`treeNodes` is a flat DFS-preorder list of all session-tree nodes. Each record
contains `entry`, `parentNodeId` (the structural parent's ID, or `null` for a
root), and optional `label` / `labelTimestamp`. The browser validates IDs and
parent relationships, then rebuilds its internal nested tree iteratively. This
keeps JSON nesting independent of history length and preserves every branch;
`entry.parentId` is persisted history metadata, not a replacement for the wire
parent. `get_tree` returns the same `{ treeNodes }` representation.

The browser also validates legacy nested `tree` snapshots. Invalid topology
(such as string `children`, duplicate IDs or cycles) reports a conversation-sync
error and does not replace the last valid tree. A generic payload depth limiter
must never truncate session-tree topology.

Sent on WebSocket connect (full state snapshot). After `session_tree` or turn
completion events, the browser requests a fresh snapshot with `sync_request`
instead of the extension broadcasting an unsolicited full state update.

Workspace git state is intentionally not part of `state_sync`. The browser asks
for it with `get_git_status` when connection, sync, tool, or turn events imply
the workspace may have changed.

### RPC Method Registry

All current commands become methods under the unified `req`/`res` pattern:

| Current Command/HTTP | New Method | Params |
|---------------------|------------|--------|
| `prompt` | `prompt` | `{ message, images?, streamingBehavior? }` |
| `steer` | `steer` | `{ message }` |
| `follow_up` | `follow_up` | `{ message }` |
| `abort` | `abort` | — |
| `enter_arch_mode` | `enter_arch_mode` | — |
| `exit_arch_mode` | `exit_arch_mode` | — |
| `get_state` | `get_state` | — |
| `get_messages` | `get_messages` | — |
| `get_available_models` | `get_available_models` | — |
| `set_model` | `set_model` | `{ provider, modelId }` |
| `cycle_model` | `cycle_model` | — |
| `cycle_thinking_level` | `cycle_thinking_level` | — |
| `set_thinking_level` | `set_thinking_level` | `{ level }` |
| `get_session_stats` | `get_session_stats` | — |
| `set_session_name` | `set_session_name` | `{ name }` |
| `set_auto_compaction` | `set_auto_compaction` | `{ enabled }` |
| `compact` | `compact` | — |
| `export_html` | `export_html` | `{ outputPath? }` |
| `mirror_sync_request` | `sync_request` | — |
| `get_auth` | `get_auth` | — |
| New | `get_web_connection` | — (read-only actual listener / advertised entry / registry configuration) |
| `set_auth` | `set_auth` | `{ enabled }` |
| `navigate_tree` | `navigate_tree` | `{ entryId }` |
| `extension_ui_response` | `extension_ui_response` | `{ id, ...response }` |
| `GET /api/health` | `health` | — |
| `GET /api/files` | `get_files` | `{ path? }` |
| `POST /api/open` | `open_file` | `{ filePath }` |
| New | `get_git_status` | — |
| New | `get_git_diff` | `{ path? }` optional file-specific diff |
| New | `get_file_content` | `{ path }` |
| `GET /api/projects` | Deleted (unused in current UI) | — |
| `POST /api/projects/launch` | Deleted (iTerm2-specific) | — |
| `GET /api/sessions` | Deleted (ADR 0007) | — |
| `GET /api/search` | Deleted (ADR 0007) | — |
| `GET /api/sessions/:dir/:file` | Deleted (ADR 0007) | — |
| `POST /api/sessions/switch` | Deleted (ADR 0007) | — |

`get_web_connection` returns the typed `WebConnectionInfo` used by the store's
`getWebConnection()` intent: actual `port`, local URL, optional advertised URL,
and `registrationConfigured`. It does not expose registry paths or credentials,
probe the gateway, prove a lease, or change connection settings. Account management
remains an independently executed server-terminal operation, not an RPC method.

### Hub route handoff (2026-10-15)

Hub-proxied sockets additionally receive one transport-owned `hub_route` event
with `{ generation, token }`. `PiClient` consumes it directly: it never enters
the domain store, Pi backend, model context, browser storage or page URL. The
token authorizes a same-origin `POST /api/session-handoff` in a request header
after the socket closes. This narrow HTTP control-plane exception cannot execute
Pi commands and is not an RPC fallback.

The Hub returns the still-live original path, `202` while waiting for the first
successor of the exact same grant/run ID, or that successor's verified path.
Capabilities expire 45 seconds after disconnection, are bounded in memory, and
do not survive Hub restart. Revoked grants and superseded successors fail closed.
Original generation URLs remain `410`; opening an old bookmark does not acquire
a handoff capability. A browser waits at most 15 seconds, replaces only a strict
same-origin `/s/<generation>/` path, and reconnects without replaying user intent.
Direct connections and older Hubs retain their existing reconnect behavior.
The Hub reserves this control event and drops backend-origin copies. If the
successor registers while backend proof is in flight, route resolution returns
`202` for another lookup. Failed replacement handshakes retain the previous
capability until a fresh Hub control frame arrives; these attempts share one
15-second recovery deadline instead of renewing it indefinitely.

### Frontend request lifecycle

1. **Single `send()` function** — Replace `sendWs()` + `rpc()` with a single `send(method, params?)` that returns `Promise<WsResponse>`. Internally queues messages when disconnected, sends immediately when connected.

2. **Remove `rpc()` entirely** — Pi commands have no HTTP POST fallback. The separate Hub handoff POST described above resolves transport routes only.

3. **Resilience** — Socket closure rejects outstanding and queued requests. Never replay prompts or session actions into a replacement session. Hub route resolution reconnects transport only; there is no HTTP command fallback.

4. **`ConnectionState`** simplifies: `"connecting" | "connected" | "disconnected"`. Hub handoff rejects new requests while resolving. Requests queued for an opening direct socket never survive its closure.

### Backend Changes

1. **Remove HTTP API routes** — All `/api/*` handlers deleted except:
   - `/ws` WebSocket upgrade (kept)
   - Static file serving (kept)
   - `/api/health` moved to a WS method

2. **Unified command handler** — Current `handleCommand()` adapts to the `req` envelope. The method name maps directly to existing `switch` cases.

3. **Event broadcast** — All events use the `{ type: "event", event, payload }` shape. The current `mirror_sync` type becomes `state_sync` event.

### Migration Path

**Phase 1**: Add new envelope alongside existing format. Server sends both old and new shapes during transition. Frontend adopts new `send()` function but keeps WS-only; HTTP endpoints remain.

**Phase 2**: Frontend fully migrated to new envelope. Remove HTTP API routes. Remove old message shapes from server.

**Phase 3**: Clean up — remove `BrowserCommand`, `BrowserResponse` types, unify server-side handler dispatch.

### Why Not...

#### Why not keep HTTP as fallback?

The fallback path (`rpc()`) already can't work for most commands when the agent is running — `prompt`, `abort`, etc. need an active Pi process. The only commands useful without WebSocket are `health` and `get_state` — both can be WS methods that queued and delivered on reconnect. Removing HTTP simplifies the codebase and eliminates the dual-path testing matrix.

#### Why not SSE for events?

SSE is unidirectional (server → browser). We'd still need a request channel (HTTP POST or WebSocket). Using WebSocket for everything avoids maintaining two protocols.

#### Why not use JSON-RPC 2.0?

Considered. JSON-RPC's `method`/`params`/`id`/`result`/`error` pattern is well-established. However:

- JSON-RPC requires `"jsonrpc": "2.0"` version field (noise)
- JSON-RPC uses `{"code": number, "message": string}` for errors, which adds nesting
- Our `ok` boolean is simpler for the frontend to branch on
- We don't need JSON-RPC's batch or notification semantics

Our custom envelope is isomorphic enough to JSON-RPC that migration later is trivial if needed.

## Consequences

### Positive

- Single communication channel eliminates dual-path bugs
- Unified envelope makes message handling predictable (switch on `type`, then on `method` or `event`)
- Request/response correlation via `id` eliminates the fragile current pattern where responses echo `command` name
- Frontend code simplifies: one `send()` function, no HTTP fallback
- Server code simplifies: remove ~150 lines of HTTP routing

### Negative

- Breaking change — all message shapes change. Requires coordinated frontend + backend update
- During WebSocket reconnect, requests are queued in memory (browser tab). If tab is closed, queued requests are lost (acceptable — Pi session continues in terminal)
- Health check requires WebSocket connection (minor — page won't load without WS anyway)

### Neutral

- The `state` type (with `advancedFeatures` and `archAvailable`) is folded into the `state_sync` event payload
- Error reporting becomes more structured with error codes

## References

- [ADR 0002: Raw Web UI Event Forwarding](./0002-web-ui-extension-event-protocol.md) — event forwarding principle preserved
- [Conversation Tree Sidebar PRD](../prd/tree-sidebar.md) — current-session tree scope (the previously linked ADR 0007 tree document is not present in this repository)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification) — considered, not adopted
