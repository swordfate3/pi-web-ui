# Terminal prompt visibility (not Web approval)

Pi Web UI now shows a persistent **Waiting for terminal interaction** banner while Pi is blocked on a public `ui_prompt_start` event. It supports `confirm`, `select`, `input`, `editor`, and `custom`. Pi 1.1 and 1.3 expose these lifecycle events.

Only the original `kind` and optional `title` are displayed. These events do **not** contain the prompt body, choices, input text, or confirmation preview. The Web UI does not invent those fields or claim that the title is enough to approve a mutation. Review the complete prompt and respond in the Pi terminal, or in the existing trusted RPC client that owns that Pi process.

## Security boundary

This is a visibility mitigation for scoped-memory confirmations, **not a completion of Web Yes/No support**. Scoped memory's `ctx.hasUI`, original `ctx.ui.confirm`, cancellation, runtime guards, and commit path are unchanged. Its source and installed release are not modified.

The chat Web origin can also serve agent-generated HTML. An Origin check or nonce does not establish human intent, and being a session control surface does not grant Hub administration or trusted memory approval authority. There are no approve/reject buttons in this banner. A WebSocket `extension_ui_response` returns an explicit unsupported / terminal-required error, never a successful ACK and never a result to Pi's confirm resolver. Existing frontend response failures are surfaced rather than silently swallowed.

A future Web Yes/No design requires a separately reviewed isolated management-origin confirmation channel using the Hub's existing authorization boundary. It must not silently turn the ordinary chat WebSocket into that channel.

## Lifecycle and data handling

- The bridge holds only the current outer prompt's kind/title in runtime memory, bounded to one prompt (Pi's public lifecycle events represent the outer blocking prompt).
- Start/end events include the current session/runtime identity. The browser rejects events from a different identity or while disconnected.
- `ui_prompt_end` clears the banner. Pi emits it when the owning dialog settles, including rejection, timeout or cancellation.
- Session start, runtime shutdown, and server stop clear bridge metadata. WebSocket disconnect clears the browser banner; it does not cancel or approve the underlying trusted dialog.
- A newly connected browser receives `terminalPrompt` in `state_sync`, so a still-waiting prompt is visible even if the browser missed its start. A cleared prompt is not revived, and no response is automatically resent.
- Metadata is not written into chat items, session entries, localStorage, or other persistent storage by this feature. Confirmation bodies are never transported by it. Titles can contain extension-supplied private text, so connected clients receive exactly that existing public metadata.
- No `ctx.ui` monkey patch, private runner access, keyboard simulation, or SDK change is used. Ordinary RPC `extension_ui_request` is an RPC stdout/stdin protocol, **not** a `pi.on` event; this bridge does not implement generic RPC dialogs. If a host emits no lifecycle events, no waiting banner can be inferred.

## Validation

`node --import ./tests/register-ts.mjs --test tests/terminal-prompt.test.ts tests/history-store.test.ts`

`node --import ./tests/register-ts.mjs --test tests/terminal-prompt-integration.test.ts`

The integration test loads an independent synthetic extension through `extraExtensions`, calls real `ctx.ui.confirm`, checks live/reconnect metadata and rejection of a forged Web approval, then rejects via the harness's trusted RPC stdin and checks end/cleared snapshot. Separate cases exercise the SDK's 100ms timeout and AbortController cancellation without sending any RPC answer. It does not use a model or write memory. All three cases passed with both Pi 1.1 and Pi 1.3. The test harness cleans up its temporary Pi process and data.

Desktop and mobile Browser screenshots were inspected against the real Pi fixture. Unified math/build checks and remaining limits are recorded in [the combined validation report](validation/math-terminal-prompts.md). This change has not been installed or deployed to production.
