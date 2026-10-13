# Pi 1.1.0 slash-command support

This matrix is based on Pi 1.1.0's `docs/slash-commands.md`, `dist/core/slash-commands.js` (`BUILTIN_SLASH_COMMANDS`), and the Web UI implementation. **Mapped is not a claim of complete TUI parity.** Real Pi browser tests cover command discovery, common mappings and session replacement; clipboard permissions, export delivery and all provider-specific interactions are not exhaustively tested.

## Built-in command matrix

| Pi command | Web UI status | Behavior / boundary |
|---|---|---|
| `/settings` | Mapped | Opens browser settings, not all terminal settings. |
| `/model [provider/model]` | Mapped | Opens model picker; unique exact argument selects a model, otherwise searches. |
| `/thinking [level]` | Mapped | Reads/sets Pi thinking level; available levels depend on the active model. Does not control external search services. |
| `/scoped-models` | Not mapped; product decision | Define persistent model cycling configuration and a browser interaction before exposing it. |
| `/new` | Mapped | Creates a new session; reconnect/state sync restores the replacement session. |
| `/resume` | Partial mapping | Browser picker searches saved sessions for the current project and resumes through an opaque server-side selection ID. Does not expose Pi's rename/delete/sort/path controls. Requires `/webui`; replacement completion is confirmed by the target session ID in `state_sync`. |
| `/name [name]` | Mapped | Sets the session display name or, without an argument, reports the current name. Browser title follows Pi's session metadata; names are normalized by Pi. |
| `/session` | Partial mapping | Opens browser session details with identity, paths, tree counts, model, runtime, cumulative token/cost statistics and live context usage. It is a browser-specific view, not exact TUI formatting. Cumulative usage covers all entries and is distinct from live context. |
| `/tree` | Partial mapping | Opens conversation sidebar. Selecting a row focuses its displayed message; **Branch/Continue** navigate the tree within the same session. Not a new session or full TUI tree selector. |
| `/fork` | Mapped | Opens searchable user-message picker. Creates a separate session **before** the selected user message and puts its text in the browser draft. The original file is preserved. Requires `/webui`. |
| `/clone` | Mapped | Creates a separate session **at** the current leaf, preserving current history. Requires `/webui`. |
| `/compact [instructions]` | Mapped | Requests Pi compaction, optionally with custom instructions; receives completion/error events. |
| `/import <path>` | Not mapped; product decision | Browser file selection/upload is not equivalent to a host filesystem path. |
| `/copy` | Mapped | Copies latest assistant text using browser clipboard; requires supported browser permissions/context. |
| `/export [path]` | Partial mapping | Confirms disclosure, then downloads a Pi-generated HTML export through a runtime-scoped opaque token. Includes the full session tree and preserved pre-compaction/tool history; may contain sensitive data. Host output paths and JSONL export are not exposed. |
| `/share` | Not mapped; product decision | External transcript disclosure needs preview and explicit consent, not silent passthrough. |
| `/bug [description]` | Not mapped; product decision | Diagnostic/transcript disclosure and upload/package delivery need a dedicated flow. |
| `/login [provider]`, `/logout` | Not mapped; product decision | Credential changes and OAuth need an explicit authentication flow. Browser auth settings are not provider login/logout. |
| `/trust` | Not mapped; host-oriented | Host project trust policy, not a browser-local setting. |
| `/reload` | Partial mapping | Reloads Pi resources through a fresh command handler and waits for a new `runtimeId` in `state_sync` (the session ID remains the same). Requires `/webui`; afterwards run `/webui` again. Browser reload does not claim TUI keybinding reload parity. |
| `/hotkeys` | Not mapped; terminal-specific | Pi TUI bindings are not browser keyboard bindings. |
| `/changelog` | Not mapped; suitable next mapping | Could become a read-only version/changelog view. |
| `/quit` | Not mapped; host-specific | Would terminate the host Pi process, not merely close the browser. |

**Unsupported built-ins are rejected**, not passed to the model or assumed to execute in RPC mode. A separately registered extension or prompt with the same invocation may still be discovered, but that is a resource command, not native TUI support.

## Resources and routing

`pi.getCommands()` discovers registered extensions, prompt templates and enabled `/skill:name` commands. Web UI refreshes these on connection and routes execution through Pi's command/template expansion path. This does not guarantee support for extensions that require custom terminal components or terminal-only interaction. Dynamic resource commands take priority over browser mappings for the same invocation.

Internal commands `webui-new-session`, `webui-fork-session`, `webui-resume-session` and `webui-reload` are hidden from browser suggestions and reject direct browser prompt invocation. `/webui`, `/webui-start` and `/webui-stop` remain user-facing extension commands.

Pi's `/llama` is an additional built-in extension command, not an entry in the 1.1.0 `BUILTIN_SLASH_COMMANDS` table. Its terminal/router management UI is not browser-native support. `/debug` is an additional terminal diagnostic command, also outside that table; it is not mapped. `/mcp` is an extension management command whose browser availability and UI depend on the loaded MCP extension, not this matrix.

## Session lifecycle

Run `/webui` to enable advanced session controls. `/fork` and `/clone` do not change existing **Branch/Continue** semantics. They use short-lived Pi command handlers to replace the session, never cast an event context into a command context or directly mutate a session-manager leaf.

Replacement shuts down the old mirror server and invalidates its contexts. Browser acknowledgement only means the action was accepted; a new `sessionId` from real `state_sync` completes it. Requests are not replayed on disconnect. Busy, invalid, stale-selection and cancelled operations report errors and preserve the original session. After `/new`, `/fork`, `/clone`, switch or reload, **run `/webui` again** before advanced controls; no automatic context recapture is performed.

The fork draft and completion notice are browser-local and not persisted into Pi history. Refreshing the page restores Pi history, not the unsent fork draft.
