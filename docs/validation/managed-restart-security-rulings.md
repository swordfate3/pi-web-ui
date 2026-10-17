# Managed restart: bounded security rulings for F1 and F3

Date: 2026-10-17.

Status: **Security refinements within the user-approved task; implementation and acceptance verification remain pending.** These are agent-recorded rulings, not separate user approval for remote infrastructure changes. This artifact records the bounded decisions for the next worker. It does not claim either finding is fixed and does not authorize production activation.

References:

- Review findings: `docs/validation/managed-restart-hub-review.md` (F1 and F3).
- Tasks 3–5 and frozen protocol: `docs/superpowers/plans/2026-10-17-managed-pi-restart.md`.
- Binding security design: `docs/superpowers/specs/2026-10-17-managed-pi-restart-design.md`.

The rulings below refine the implementation boundary without reopening the design. They do not close or reprioritize F2, F4, F5, or F6. Gate implementation is outside this ruling's implementation scope and is tracked separately in the progress ledger.

## F1 — Accepted direction: actual separate management origin and listener

**Verdict:** Implement the management surface on an actual separate browser origin, served by a dedicated loopback listener. Do not implement the same-origin page-memory/COOP capability workaround.

### Configuration and defaults

- Add optional management configuration with a distinct loopback port and an optional explicit public URL. Management is disabled by default; absence of this configuration preserves existing chat configuration and behavior.
- The management listener must not bind the chat listener's port. Its effective local origin must differ from the chat origin.
- If a management public URL is configured, compare normalized URL origins and reject any configuration that gives management the chat public origin. A different path on the same origin is not separation. Do not infer a remote management origin from the chat URL or silently fall back to it.
- Management authentication remains independent of ordinary chat access, localhost reachability, and gateway login. Lifecycle execution remains subject to the independent Gate policy and credential.

### Listener and browser boundary

- The trusted management listener serves only the administrator portal, its trusted static assets, sanitized session-list data, and management APIs.
- It must never proxy Pi HTTP content, forward Pi WebSockets, accept upgrade tunnels, serve Pi-owned scripts/documents, or expose Service Worker scripts. Pi-controlled content must never be served under the management origin, including through route aliases and error/fallback handling.
- The main chat listener rejects management APIs. An optional nonprivileged status response may report management unavailable on that listener and give a configured administrator URL hint; it must not expose management authorization, CSRF material, or operation results.
- Portal cards link to the canonical configured chat public URL plus `/s/<generation>/`. For local-only use, use the canonical chat loopback URL. Never derive these links from backend-provided URLs or resolve them relative to the management origin.
- Do not enable CORS access to management for the chat origin. Management Host/Origin validation uses the management listener's own allowed origins, not the chat listener's allowlist. Mutating management requests retain the required same-origin and CSRF checks.
- Only the management listener issues and accepts management credentials. Preserve short-lived HttpOnly/SameSite management cookies, Secure for HTTPS, private session state, pairing expiry/single-use/failure limits, and administrator revocation.
- Cookies are not port-scoped: different loopback ports are a browser-origin boundary, not a cookie-delivery boundary. The main listener must never treat an arriving management cookie as authority and must strip Cookie, Authorization, and management-specific `x-pi-hub-*` headers from Pi forwarding. Backend responses must not set browser cookies or inject management headers.
- Pair/revoke CLI operations continue using the same Hub-private administrator state. Do not copy management/provider credentials into Pi volumes or backend requests.

The earlier per-page capability, forced mismatching COOP, and re-pair-on-reload proposal is **not the chosen security boundary**. Do not spend this fix rebuilding or validating that workaround. Existing chat-origin Service Workers do not justify serving management at that origin; separation is the ruling.

### Deployment boundary

Remote DNS/Caddy/TLS provisioning for a distinct public management origin is an **explicit deployment prerequisite**, not work authorized by this artifact. Do not modify remote DNS, Caddy, tunnels, live services, or production privileges. Until separately provisioned, the new management listener is local-only; do not expose its APIs through the existing chat origin to make remote access appear available.

### Required implementation acceptance

- Default-disabled compatibility and same-origin/equal-port configuration rejection.
- Main-listener management rejection; management-listener proxy/WS/upgrade/worker rejection.
- Pairing, expiry, CSRF, Host/Origin validation, logout, and CLI revocation on the management listener only.
- Correct canonical cross-origin chat links; no private paths or credentials in listing/status/hints.
- Real-browser hostile chat-page checks: management status/targets/restart cannot be read or authorized by chat content; popup/opener access cannot inspect a paired management page; a chat-scoped worker cannot control management pages.

## F3 — Accepted direction: fixed image-owned pre-SDK stdin-emission guard

**Verdict:** Use a fixed Node preload to guard the installed SDK's stdin data-event path before SDK or extension loading. Keep the existing plugin environment and inherited TTY. Do not disable extensions, add a PTY relay, alter the user's shell, or fork/monkeypatch SDK command execution.

### Established transport basis and limits

Prior read-only inspection confirmed installed Pi and Pi TUI version 1.1.0. In `node_modules/@earendil-works/pi-tui/dist/terminal.js`, `ProcessTerminal` registers `process.stdin.on("data", ...)`, feeds `StdinBuffer`, and then forwards parsed input/paste to the UI. The preload wraps `process.stdin.emit` before that chain is installed, avoiding extension input-listener ordering as the interception boundary.

The supported claim covers this verified stdin data-event transport. It is not a sandbox against malicious in-process code that can modify Node internals, and it does not claim coverage of alternate direct-fd/TTY readers or untracked autonomous plugin work. Unsupported transport or inability to establish guard continuity means no managed-restart eligibility; do not silently claim coverage.

### Guard ownership and installation

- The supervisor supplies a fixed `NODE_OPTIONS --import` path for every supervised Pi child, including the successor. The preload is image-owned/root-owned, outside writable/shared volumes, with no dependency on Pi-writable replacement code.
- Control startup options so the guard truly runs before application preloads, SDK modules, and plugins. In particular, competing `--require` preloads must not run ahead of it; merely appending `--import` to inherited arbitrary options is insufficient.
- Publish a nonreplaceable process-global guard handle with private process-lifetime state and a defined compatibility version. The extension must verify the guard is present and intact before advertising readiness or accepting prepare. Replacing/displacing it or losing continuity fails closed.
- Install once per child process. Extension reload, session switch/fork, adapter cleanup, and prepare cancellation do not uninstall the emission guard or reset its uncertainty latch. Only a genuinely fresh Pi child starts with a fresh latch.

### Observation, preparation, and cleanup

- Observe all stdin `data` emissions from installation onward. Latch uncertainty synchronously **before** forwarding any nonexempt input, regardless of which listener would otherwise consume it.
- Exempt only exact, whole, audited terminal-report chunks. Unknown, fragmented, or mixed chunks conservatively latch immediately; do not defer uncertainty pending parsing or use broad escape-sequence exemptions. False-positive ineligibility is preferable to permitting an unproved idle restart.
- Outside prepare, preserve input behavior: forward unchanged data and other events, without logging input or introducing replay, pauses, decoding changes, or extra terminal ownership. Normal `/quit` remains unchanged.
- While prepared, suppress user data before any downstream terminal listener. Do not queue it for cancel/reload or replay it into the successor. Observation remains active even when input is suppressed.
- Set the preparation guard synchronously with successful adapter prepare. Preparation ownership and cancellation/release must be fenced to the matching operation and adapter lifetime; stale cleanup cannot release a newer barrier.
- Keep barrier release bounded and consistent with the adapter's lease/cancel behavior, without ever clearing permanent uncertainty. Distinguish ordinary cancellation/reload cleanup from process stopping: adapter close during shutdown must not reopen input dispatch before the process stops accepting input.
- Preserve SIGHUP/SIGTERM shutdown and the supervisor's graceful-stop/no-force-kill contract. Do not intercept these signals as terminal keys or alter `user_bash` execution to enforce the latch.

### Eligibility and preserved work

- Snapshot `busy` includes permanent uncertainty in addition to all existing active mutation/export/upload/session-transition checks. Continue using fresh `latestCtx`, exact saved session/leaf identity, SDK idle/pending state, and the existing Web mutation barrier.
- Latch on `user_bash` and **before** dispatch of unaudited Web commands whose completion cannot be proved. A returned browser ACK or `sendUserMessage()` return is not proof of arbitrary command completion. Audited, completion-tracked Web operations may retain eligibility.
- Once latched, returning to idle, waiting, reconnecting, canceling, resuming, or reloading does not restore eligibility. Document the limitation as requiring a new Pi process, not as a temporary busy state that will clear automatically.
- Do not disable plugins to satisfy this ruling. Keep the limitation explicit rather than promising managed restart after unverified interaction.

### Required implementation acceptance

- Preload installation before SDK/earlier terminal listeners, and fail-closed behavior when absent, incompatible, or displaced.
- Process-lifetime latch survival across reload and session changes, with reset only in a fresh child.
- Ordinary terminal input, built-ins, paste, and `user_bash` taint eligibility; unaudited Web dispatch taints before execution.
- Prepared input cannot reach even an earlier/prepended listener and is never replayed after cancel or restart.
- Exact terminal-report exemptions and conservative handling of split/mixed reports.
- Operation-fenced cancel/close/lease release; normal `/quit`, signal shutdown, and the existing inherited terminal continue working.

## Handoff status

This is a documentation-only security decision. No product code, launcher/image source, private configuration, credentials, remote infrastructure, or production state was changed to create it. No Git operations, child agents, product tests, or browser regressions were run for this artifact. Existing green test reports are not evidence that these new corrections have been implemented.

Next worker: implement these bounded rulings within the approved task/staging boundaries, add the focused regressions, and seek review of the resulting changes. Do not reopen the same-origin F1 workaround or the extension-disabling F3 profile as the default approach.
