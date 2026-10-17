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

**WebSocket is the channel for server-client application commands and events.** HTTP remains for initial page load, WebSocket upgrade, and explicit binary attachment streaming. File downloads are prepared over WebSocket using session/runtime identity; only the resulting short-lived capability is used by `GET`/`HEAD /api/downloads/<token>`. File bytes must not be base64-encoded into application frames. See [file downloads](../prd/file-downloads.md) and [workspace uploads](../prd/file-uploads.md). Uploads are prepared over WebSocket, then streamed as same-origin 8 MiB `PUT /api/uploads/<uploadId>/chunks/<index>` requests and finalized by `complete_upload`; completed receipt IDs are bound to the current session/runtime and supplied with `prompt`, never arbitrary client paths. Legacy single-PUT upload remains available within its original 50 MiB limit. See [ADR 0016](0016-resumable-workspace-uploads.md).

### Saved message version navigation

`get_message_versions` accepts `{entryIds, sessionId, runtimeId, sourceLeafId}`. It reads only the current session's raw entries, groups the nearest user entries by their stable context position in the original ancestry (skipping only consecutive `type:message`, `role:system` parents), and returns identity-scoped metadata `{groups, limited, sessionId, runtimeId, sourceLeafId}` with no message bodies. A group is `{entryIds, userEntryId, index, total, versions:[{userEntryId,targetEntryId}]}`. Index is one-based in persisted append order. Different assistant entries within a tool turn share one group. System prompt/tool patches before either the original or revised user do not create a new version position. All other entries, including metadata/custom/user/assistant/tool results, remain context boundaries; this is not arbitrary branch equivalence. Malformed parent IDs, missing ancestry and cycles fail closed, never becoming root positions. Stable anchors are memoized during graph validation without a patch-depth cutoff; saved parent IDs and navigation ancestry are unchanged. Requests are limited to 100 message IDs and responses to 256 version references; omitted whole groups set `limited` rather than silently changing totals.

`switch_message_version` accepts `{entryId,userEntryId,targetEntryId,sessionId,runtimeId,sourceLeafId}`. The server re-resolves membership and a safe saved continuation from authoritative entries, requires idle advanced controls, checks source identity/leaf and mutation exclusion, then navigates with `{summarize:false}`. It never sends a prompt. Successful acknowledgement is `{switched:true,sessionId,runtimeId,leafId}`; cancellation is `{cancelled:true}`. No optimistic success or timeout retry is allowed. The client keeps its selected date range but loads the new branch's newest bounded history page, invalidating any old branch cursor and pending page reads; workspace files remain unchanged. The latest persisted leaf continuation is selected for an inactive version with deeper branching; Tree remains the explicit selector for other paths.

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

This preserves ADR 0002's thin-transport principle: the `event` field is the source name, except for the explicit scoped `transport_omitted` control for oversized live content. Delta cumulative snapshots and repeated agent/turn message bodies use the documented [bounded live transport projections](0002-web-ui-extension-event-protocol.md#bounded-live-transport-exception). Request responses are never silently truncated into success. Normal history/tree queries remain bounded and preserve exact navigation identities.

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
| `prompt` | `prompt` | `{ message, images?, uploads?, sessionId?, runtimeId?, streamingBehavior? }`; uploads require explicit current session/runtime identity |
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
| New | `get_message_revision` | `{ entryId, mode: "edit" \| "regenerate", sessionId, runtimeId }` → `{ previewId, entryId, userEntryId, text, hasImages, sourceLeafId, sessionId, runtimeId }` |
| New | `submit_message_revision` | `{ previewId, entryId, mode, sessionId, runtimeId, sourceLeafId, text? }`; text only for edit; dispatched ACK is not acceptance |
| `extension_ui_response` | `extension_ui_response` | `{ id, ...response }` |
| `GET /api/health` | `health` | — |
| `GET /api/files` | `get_files` | `{ path? }` |
| `POST /api/open` | `open_file` | `{ filePath }` |
| New | `get_git_status` | — |
| New | `get_git_diff` | `{ path? }` optional file-specific diff |
| New | `get_file_content` | `{ path }` |
| New | `prepare_upload` | `{ protocol: 2, filename, size, sha256, chunkHashes, sessionId, runtimeId }` → `{ protocol: 2, uploadId, url, relativePath, maxBytes, chunkSize, nextChunk, complete }`; default 1 GiB file limit, 8 MiB HTTP chunks, resume by matching file identity. Omitting protocol retains legacy 50 MiB single PUT. |
| New | `complete_upload` | `{ uploadId, sessionId, runtimeId }` → `{ uploadId, relativePath, filename, size }`; verify full size/digest and atomically publish before prompt handoff |
| New | `prepare_file_download` | `{ path, sessionId, runtimeId }` → `{ token, filename, size, downloadUrl }`; current-workspace ordinary files only |
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

### Message revision intent

`get_message_revision` is read-only: it resolves the original question from Pi's saved parent chain, not the bounded browser snapshot, and stores one connection-bound, single-use preview. Original image bytes stay on the backend. Full text has a JSON-escaped 2 MiB budget, with explicit rejection rather than truncation. Submit revalidates identity, source leaf, idle/pending state and preview, consumes the preview, navigates before the original question without a branch summary, then sends literal user content (`expandPromptTemplates:false`). Navigation cancellation returns `{cancelled:true}`. A successful reply `{dispatched:true,sessionId,runtimeId,userEntryId}` says only that the void Pi dispatch API was called, not that a turn was accepted or completed. No optimistic history is written.

Navigation and pending/unknown dispatch fence browser mutations. An active-mutation counter spans browser request awaits, so revision cannot start while an earlier asynchronous model/session mutation is still completing. The shared busy wait is bounded; its timeout does not prove cancellation or release the independent unknown fence. A matching user `message_start` may confirm dispatch; unrelated tree/user events cannot authorize a resend. Pi 1.1.0 exposes no dispatch correlation metadata. Confirmation requires unchanged lifecycle/session/runtime and the dispatch-time tree version, even if later navigation returns to the same parent. It compares all original text/image content (allowing Pi's fixed text-newline merge and image-after-text shape). The current leaf must equal the expected parent or reach it through at most 64 valid `type:message`, `role:system` entries: Pi can persist prompt/tool patches before user start. ID/parent validation, missing entries, cycles, other entry types/roles and over-budget chains fail closed; this does not skip arbitrary metadata. Input transformations, handling, exceptions or image normalization can prevent matching; unknown then persists despite unrelated messages or tree navigation. Read-only inspection and abort remain available. Inspect Pi in the terminal; when needed, explicitly replace the session/reload there, rather than blindly retrying. Another identical message at the same parent cannot be distinguished through this public API; this is a residual correlation limitation, not proof of exact acceptance. Frontend ACK deadline is 15 seconds and never replays a mutation. See [message branching PRD](../prd/branch-message.md).

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

## Read-only companion usage

`get_usage_stats({sessionId,runtimeId})` requires both current identities and returns only bounded usage counters, USD known-cost subtotals, unknown-price counts and actual response-model labels. It does not return messages, paths, or credentials. `statisticsScope: "all_entries"` includes all branches of the current session, independent of history pagination. The browser exposes an intent-level `getUsageStats()` action and rejects stale/malformed results. See [ADR 0017](0017-web-whale-companion.md).
