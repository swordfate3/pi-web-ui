# Portable Web Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local Web use independent of WSL and make external session registration an explicit built-in option.

**Architecture:** Small connection configuration and registration modules are owned by the current mirror-server lifetime. Browser URL helpers resolve routes under the current entry directory; the existing external gateway remains optional.

**Tech Stack:** Node >=22.19.0, TypeScript, Node test runner, HTTP/local IPC, React/Vite, existing real Pi faux-provider harness.

**Spec:** `docs/superpowers/specs/2026-10-14-portable-web-connection.md`

## Global Constraints

- Default bind address is `127.0.0.1`, port `3001`.
- No WSL-specific default path is built in.
- Remote exposure still requires an external authenticated TLS gateway.
- Stop/reload invalidates pending callbacks before awaiting resource cleanup.
- Credentials and remote errors never appear in notices.
- Do not monkeypatch browser globals.
- Do not deploy, merge main, or push without a separate request.

### Task 1: Configuration and port allocation

**Files:** Create `extensions/connection-config.ts`, `extensions/connection-listener.ts`, and `tests/web-connection.test.ts`.

**Interfaces:** `resolveConnectionConfig(settings, env)` returns validated host, port, autoStart, publicUrl, registration and sanitized warnings. `localWebUrl(host, port)` returns a browser-usable local URL. `listenWithFallback(server, {host,port}, signal)` returns the actual listening port and obeys cancellation.

- [x] Write tests: empty configuration yields loopback; env overrides settings; invalid ports (`3001junk`, zero, negative, >65535) fail; public URLs reject credentials/query/fragment; partial registration disables only registration; real occupied socket advances port; abort cannot re-listen.
- [x] Run `node --import ./tests/register-ts.mjs --test tests/web-connection.test.ts`; confirm missing behavior is red.
- [x] Implement strict validation, IPv6 brackets/wildcard-to-loopback display and bounded abortable port retry.
- [x] Run the same test to green; run existing unit tests.

### Task 2: Optional capability registration

**Files:** Create `extensions/session-registration.ts` and `tests/session-registration.test.ts`.

**Interfaces:** `createSessionRegistration(config)` reads/validates the capability and returns a `SessionRegistration`; `start(port, onUrl)` renews, `stop()` synchronously fences then unregisters, `guard(request,response?)` verifies identity/generation for HTTP and WS.

- [x] Write real temporary IPC tests for register/unregister shape, signed challenge, rejected wrong generation/proof, timeout, invalid replies, stale callbacks after stop and restart.
- [x] Run `node --import ./tests/register-ts.mjs --test tests/session-registration.test.ts` and observe red.
- [x] Implement bounded newline IPC, generic errors, random generations, serialized renewal and timing-safe HMAC proof checks. Accept only validated HTTP(S) URLs from registry.
- [x] Run both new test files; ensure no leaked sockets/timers or secrets.

### Task 3: Mirror lifecycle and browser entry paths

**Files:** Modify `extensions/mirror-server.ts`, `src/web/src/core/ws.ts`, `src/web/src/core/export-download.ts`, `src/web/src/app.tsx`, `src/web/index.html`, `vite.config.ts`; create `src/web/src/core/connection-path.ts` and `tests/connection-path.test.ts`.

**Interfaces:** `webBasePath(pathname)` returns the entry directory; `webRoute(route, pathname)` resolves same-entry routes. Export validation still accepts only the exact UUID attachment endpoint. Registrar guards HTTP and WS before application handlers.

- [x] Test literal root/subpath/IPv6 WS URLs and scoped export URLs; reject arbitrary export URLs and invalid registry links.
- [x] Run tests red before modifying helpers; implement relative build/assets and native helpers.
- [x] Replace loose settings parsing and fixed 10-port fallback; connect start/stop to registrar, use `latestCtx` for all async notifications, and never use stale registration results.
- [x] Run build and real isolated Pi checks for local start, occupied port, stop/reload and optional registry failure.
- [x] Inspect rendered desktop/mobile entry pages and capture visual evidence; do not call frontend-only checks E2E.

### Task 4: Documentation and handoff

**Files:** Modify `README.md`, `docs/development-log.md`, `docs/unit-tests.md`; create `docs/connection.md`, an ADR and `docs/validation/2026-10-14-portable-web-connection.md`.

- [x] Document settings/env precedence, local/LAN/public examples, explicit IPC mount requirements and authentication boundary.
- [x] Run fresh unit tests, type/format checks and production build; inspect final diff for races and sensitive data.
- [x] Record passed checks and untested Windows/macOS/actual Alibaba deployment separately.
- [x] Commit intentional changes on `codex/portable-web-connection`; retain branch without merging, pushing or deploying.

## Final evidence

See `docs/validation/2026-10-14-portable-web-connection.md`: 77 unit tests,
3 real Pi backend integration tests, and 39 real Pi/browser scenarios passed.
Rendered Chromium screenshots were inspected as a fallback, not app-Browser or
physical-phone validation. Deployment and native Windows/macOS remain untested.
