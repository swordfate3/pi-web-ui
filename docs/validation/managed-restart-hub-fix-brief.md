# Managed restart Tasks3–5 — scoped fix round1

Read this first. Original findings (all six are binding):
`docs/validation/managed-restart-hub-review.md`.
Approved protocol: `docs/superpowers/plans/2026-10-17-managed-pi-restart.md`.
Security decisions: `docs/validation/managed-restart-security-rulings.md` when available,
and the rulings in `docs/validation/managed-restart-progress.md`.

## Scope and constraints

Own ONLY the feature's extension/Hub/frontend/tests/docs source in this repository,
plus the necessary guard installation in sibling staged `pi-docker/runtime`,
`pi-docker/Dockerfile` and its tests. Do not edit staged Gate or the host
`docker_files`. No Git, subagents, installs, live service changes or real secrets.
Existing modifications belong to this task and must be preserved. Do not replace
the feature with a narrower plugin-disabled profile or a PTY relay.

Only one implementation worker is allowed; wait for explicit dispatch before
starting. Main owns `e2e/harness/test-managed-runtime.py`,
`e2e/harness/test-managed-gate.py`, `Dockerfile.managed-runtime`, build/dist,
`e2e/harness/hostile-management.ts`, `docs/managed-pi-restart.md`, the progress ledger and review packages. Coordinate any additional E2E file rather
than editing those three main-owned harness files concurrently.

## F1 — real browser-origin isolation

Implement an OPTIONAL separate management HTTP listener bound to 127.0.0.1.
Use strict `management: {port, publicUrl?}` configuration (0 allowed for isolated
tests); the runtime/public management origin must differ from the chat origin.
Remote public management configuration requires a canonical chat publicUrl.
Expose the local trusted listener as optional `managementUrl` on startHub and
CLI serve JSON, with a trailing slash, for main's isolated browser/Docker harness.
Never infer trust from a Host header or a different URL path. Configuration
without `management` preserves all legacy chat behavior and exposes no management
authority, even if a lifecycle provider is configured.

The dedicated management listener serves only trusted portal/static content,
sanitized session lists and management APIs. It MUST NOT proxy `/s/` content,
backend files, backend WebSockets, service workers or arbitrary redirects. No CORS
permission to the chat origin. Writes require exact admin-origin/host checks plus
the existing management cookie/CSRF. The chat listener refuses management routes;
its unauthenticated status may advertise only a canonical management URL and no
authority. Add an “打开运行管理” link there; do not offer pairing on the chat origin.
Admin card links open the canonical chat origin, not its own `/s/` path.

The separate origin allows retaining the existing short-lived cookie/session UX;
do not introduce per-page capability tricks. Strip x-pi-hub-* from upstream
request/response forwarding. Keep CLI pair/revoke on the existing private state;
add optional CLI init flags/help if needed. No actual remote DNS/Caddy changes.
Document the distinct HTTPS management origin as an explicit deployment
prerequisite. Add real Chromium hostile Pi-origin probes against the paired admin
origin: no authorization material readable and zero unauthorized provider POSTs.

## F2/F4/F5 — identity and authorization fences

- Recheck the complete immutable expected successor tuple after backend proof;
  renewal of the same Session object during await must not produce success.
- Preserve and revalidate the SAME management session/key/epoch/CSRF and expiry
  after all body/proof waits, immediately before receipt/save/arm/provider POST.
  Revocation/logout/expiry during either wait must produce zero new submissions
  and no handoff.
- Initial terminal succeeded submission responses use the same verified resolve
  path as GET; Gate success without a matching live successor is not restoration.

Write focused regressions for each interleaving before fixing source.

## F3 — pre-SDK stdin guard, fail closed

Add fixed, root-owned `runtime/pi_stdin_guard.mjs` to the staged image and install
it via supervisor-controlled Node startup options before every child loads SDK
or any extension. Reject conflicting earlier --require/-r/--import/--loader
preloads rather than allowing an unknown first reader. Do not read .env.

The synchronous preload wraps `process.stdin.emit` for `data` before forwarding
to the original emitter. This precedes the verified SDK1.1.0 stdin-data transport
and all extension listeners. Preserve all non-data events and ordinary terminal
behavior. Maintain an immutable process-global guard identity and permanently
latch uncertainty BEFORE forwarding any unverified terminal bytes. Exempt only
complete audited harmless terminal reports; mixed, unknown or fragmented input
taints immediately (no delayed speculative reset). No buffered/replayed keys.

The fresh extension snapshot is restart-ineligible if guard absent, incompatible,
displaced, reloaded without proven continuity, or uncertain. Taint also on
user_bash and before unaudited Web command dispatch. Do not pretend these mean
“busy, wait”; document that a new local Pi process is needed. Keep all existing
fresh identity/pending/mutation checks.

Prepare/cancel freeze/release terminal emission synchronously under exact
operation ownership. Stale adapter cleanup cannot release a newer barrier.
Shutdown close must not reopen dispatch while the process is still alive.
Cancel/lease expiry never clears uncertainty. Guard continuity survives reload
and session replacement; a fresh child alone resets uncertainty. Missing input
transport proof fails closed; do not assert malicious in-process code isolation.

Also bound serialized IPC replies to16KiB. Add guard unit/process tests and a
separate real TUI fixture for ! in progress, mutating builtin/extension input
after prepare, Web arbitrary-command tainting, reload persistence and normal quit.
Main's harness may be imported/reused, not rewritten while main uses it.

## F6 — pending is not executing

Sanitized lifecycle job now includes immutable `started_at` in Unix epoch
milliseconds, durably set by Gate on execution start. Pending/queued may omit;
running/succeeded require it. Strict bounded validation, no first-poll timestamps.
Use started_at+210s for Hub registration timeout, per the binding
`managed-restart-timing-ruling.md` (supersedes155s). Reject unreasonable future
timestamps rather than granting an unbounded lease.

Keep managed handoff prepared while the original connection/generation remains
alive; start its210s Hub lifetime on real retirement/disconnection, not request
submission. PiClient stores the trusted120s budget but starts it only at old WS
close. Repeated controls/polls never extend an active deadline. Clean terminal
failed jobs without leaving orphaned authority. Preserve ordinary15s recovery.
Regression: manual pending>3min followed by bounded exact-successor recovery.

## UI and verification

Cards must display safe optional running version/managed capability; preserve
legacy session JSON shape when runtime omitted. Do not expose runtime/session
file paths, container IDs or credentials. Update docs for the separate admin
origin, conservative terminal eligibility and exact local administrator steps.

Run RED/GREEN tests covering the changes plus relevant existing Hub/registration
tests. Main handles final build/dist/full suite/visual and Docker integration.
Write report `docs/validation/managed-restart-hub-fix-report.md` with commands,
RED/GREEN output, exact files and any open concerns. Return only DONE /
DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED and a one-line test summary.
