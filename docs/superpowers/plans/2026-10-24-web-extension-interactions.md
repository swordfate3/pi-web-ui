# Web extension interactions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operate MCP Adapter, Scoped Memory, Knowledge Studio V2 and Subagents Lite from Pi Web without weakening their original authorization.

**Architecture:** A versioned cooperative source client registers explicit adapters with a bounded in-process broker. Ordinary panel messages use the existing chat transport; sensitive previews and decisions use a pinned, asymmetric-authenticated Hub control channel and the existing separate management origin. Original source services retain preparation, validation and effects.

**Tech Stack:** Node crypto/HTTP, TypeScript, ws, React, existing Pi extension event bus, Node test runner and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-web-extension-interactions-design.md`

## Global constraints

- Protocol `pi-web-interactions-v1`; optional cooperative adapters, never arbitrary `ctx.ui` interception, key simulation or a new RPC owner.
- Full JSON <=64 KiB UTF-8; 8 pending/Pi; 64 pending/Hub and 4 MiB aggregate; lists <=100 items/64 KiB with revision and cursor.
- Confirm deadline <=120 seconds; OAuth <=10 minutes; source deadline always wins. Dedup <=128/Pi, <=5 minutes, <=256 KiB, no bodies.
- Exactly one terminal/Web/expiry/cancellation winner. Invalidate on session/runtime/Hub-generation/adapter/revision changes and control-channel loss.
- Hub Ed25519 private key stays in private bounded Hub state; host-pinned public key only in Pi. Run-token HMAC alone cannot authorize.
- Reuse existing management login/cookie/CSRF/Origin/revocation checks. Never put sensitive previews, OAuth material or management capabilities in public transport, logs or storage.
- Preserve `latestCtx` lifecycle rules; no source behavior inferred inside mirror transport.
- Source development only: no push, merge, deployment, installed-package edits, real keys, service restart or production-data tests.
- Continue in the existing approved feature checkout/branch, preserve unrelated untracked review document. Do not alter the separate global-runtime-refresh worktree.
- Source copies live at `/home/fate/gitproject/codex_project_v2/pi-web-interactions-sources/{mcp,memory,knowledge,agents}`. Release review includes reproducible source patches and provenance, not silent edits to installed releases.

## Task 1: Bounded protocol and source-owned arbitration

**Files:** create `extensions/interactions/{protocol,broker,proof,client}.ts`, `tests/web-interactions-{protocol,broker,proof,client}.test.ts`; modify package exports, `scripts/web-dist.mjs`, `tsconfig.connection.json`.

**Interfaces:**

```ts
type InteractionIdentity = { runId:string; generation:string; runtimeId:string; sessionId:string };
type AdapterIdentity = { id:string; version:string; packageName:string; actions:readonly string[] };
type ResponseSchema = {kind:"confirm"}|{kind:"select";options:readonly string[]}|{kind:"text";maxBytes:number};
type InteractionState = "pending"|"delivering"|"allowed"|"rejected"|"cancelled"|"expired"|"stale"|"delivery_unknown";
// Requests bind source identity, action, revision, full content digest and exact response schema.
// The broker returns a source handle, never a browser-created operation.
// Local confirmation callback receives AbortSignal and is cancelled before effect resumption.
```

- [ ] Add tests with fixed fixture identities: canonical key order produces one digest; changed wording/scope/schema changes digest; invalid/extra/prototype-bearing fields, invalid numbers and non-JSON input are rejected; multibyte oversized preview is rejected, not truncated.
- [ ] Run `node --import ./tests/register-ts.mjs --test tests/web-interactions-protocol.test.ts`; observe missing protocol failure, then implement strict JSON/type/size validation, canonical SHA-256 and source-clamped deadlines. Run green.
- [ ] Add broker tests for capacity, operation duplication, immutable copies, exactly one local/Web winner, terminal cancellation before resume, timer cancellation, signals, stale source revision, adapter unload and identity replacement. Tests assert source completion and zero duplicate effects, not mocks' existence.
- [ ] Implement broker with opaque source registration handles, bounded transient entries, metadata-only terminal results and lifecycle cleanup. Unknown adapter/actions fail closed. Public projection emits fixed adapter/action IDs and state only for sensitive work.
- [ ] Add Ed25519 tests: independent keypair verifies; altered value/identity/revision/challenge/issuer/audience, forged key, HMAC bytes, expired/future evidence and replay cannot authorize. Implement proof signing/verification with short-lived challenge-bound envelopes, no private key accessible to broker.
- [ ] Add optional public client tests using actual event bus and source operation; no broker uses original local prompt, unsupported protocol never claims capability. Export public client as package subpath; never import another package's private source path.
- [ ] Run all four focused tests, connection types and original terminal-prompt regressions. Record exact checks; commit only feature files.

## Task 2: Private authenticated Hub control and management routes

**Files:** create `extensions/interactions/control.ts`, `hub/interactions.ts`, `hub/interaction-signing.ts`, `tests/hub-interactions.test.ts`, `tests/interaction-control.test.ts`; modify `hub/{server,restart-api,state-budget}.ts`, `extensions/session-registration.ts`, credential parser and source manifest.

**Interfaces:** broker from Task 1; `createRestartApi(config,hooks,management?)` shares the same `HubManagement` instance with interaction routes; control lookup binds registered run/generation/runtime/session before and after async work. Pin schema is additive/versioned; absent pin means unavailable, not insecure fallback.

- [ ] Add tests with temporary Hub state and fake-provider socket servers for trusted handshake, rejected run-token-only handshake, reconnect challenge invalidation and wrong registration. Test the actual HTTP/WS routes, not source strings.
- [ ] Implement private control endpoint with fresh challenge plus pinned Hub signature, bounded frames and one active channel per runtime. Channel loss invalidates unresolved decisions, never buffers old signed messages into a new channel.
- [ ] Create/read bounded Ed25519 signing metadata through existing StateWriter, not arbitrary file writes. Add host-facing enrollment/public-key export in package-owned setup path; test compatibility with old credential parser. No production enrollment.
- [ ] Add management GET `/api/management/interactions/<generation>/<requestId>` and POST decision route. Tests cover chat-origin denial, Host/Origin, no cookie/CSRF, stale cookie/CSRF/epoch, authorization revoked during backend await, stale runtime and duplicate decision.
- [ ] Implement management routes sharing existing login state; independently obtain current source request, validate response against it, revalidate login and registration, sign exact decision, deliver once. Uncertain delivery queries bounded status only, no effect replay.
- [ ] Test global 64-request/4MiB limits and revocation/session/runtime/Hub restart cleanup. Run management/registration/state-budget regressions and connection types; commit.

## Task 3: Scoped Memory and Knowledge Studio source adapters

**Files:** development copies `memory/src/pi/index.ts`, `knowledge/extensions/v2.ts` and dedicated source helpers/tests; tracked release patches/provenance under `integrations/` in Web repo.

**Interfaces:** public Task-1 cooperative client. Source callback receives AbortSignal and passes it to original `ctx.ui.confirm`; source rechecks prepared revision, live context and guards after decision. Optional import absence preserves original local behavior.

- [ ] Hash and record original source/package versions; use development copies only. Tests load actual modified source entrypoints using temporary settings and stores.
- [ ] Add memory tests for exact prepared preview allow/once, deny/no mutation, wrong folder/date, legacy conflicts, cancelled signals, changed revision and active repair owner. Run red; wrap only the original confirmation selection, keep prepare/guard/commit flow; run green.
- [ ] Add Knowledge tests for grant scope, combined workflow, disclosure of source/destination/profile/cost and zero provider I/O on refusal. Run red; wrap `approve`/`approveGenerationWorkflow` and preserve source-owned signals/guards; run green.
- [ ] Add profile selection with expected revision and sensitive exact-profile confirmation; changed profile/endpoint revision must reject before store mutation. Keep indexes untouched.
- [ ] Generate source patches, include application/hash validation and package metadata; clean reapplication must match tested source. Run actual package tests and integration suite; commit release artifacts.

## Task 4: MCP server management/OAuth and Subagents panel adapters

**Files:** development copies `mcp/{index,commands}.ts`, source-owned new Web bridge; `agents/src/{registration,shell}.ts`, source-owned new Web panel service; tracked `integrations/` patches/provenance/tests.

**Interfaces:** public client; panel descriptor has explicit actions and source revision/cursor. Actions use original managers and validators. No `mcp` owner guessed from command name; advertise `mcp-adapter` explicitly.

- [ ] Add actual MCP source tests for bounded redacted list (URL credentials/env/args/headers absent), status, enable/disable and reconnect. Run red, add source-owned handlers requiring sensitive review for code-start/config changes, run green.
- [ ] Add synthetic provider OAuth test exercising original state/PKCE/callback-validation and reconnect path. Authorization link/callback travel only in trusted transient channel; malformed callback causes no credential write. Reject bearer-token UI with existing explanation, do not create unmasked input.
- [ ] Add actual Subagents source tests for running/queued snapshot, model/thinking policy validation, concurrency bounds, CAS collision, task-required spawn and duplicate action ID => one actual spawn. Run red; reuse original ConfigStore/execution services, run green.
- [ ] Advertise only implemented actions; future-agent defaults clearly do not restart running tasks. Advanced terminal options remain deferred. Generate reproducible source patches and run clean source tests; commit.

## Task 5: Existing-chat panels and top-level trusted review

**Files:** `src/web/src/{app.tsx,core/types.ts,core/store/*}`, new `components/pi-web-ui/interaction-panel.tsx`; management portal entry/module under `hub/`; E2E features/steps/fixtures; docs.

**Interfaces:** public notices and explicit panel APIs from Tasks 1/4; trusted review API from Task 2. Never send `extension_ui_response` for unadapted dialogs. Capability state distinguishes absent/unsupported/available/temporarily-unavailable.

- [ ] Add real Pi+mirror+Hub browser tests: `/mcp-adapter` and `/agents` panels, scope/profile confirmations, local winner and Web winner, stale buttons, session switch/reload, duplicate clicks and reconnect. Use synthetic provider network only, no mocked WS.
- [ ] Implement responsive panels inside existing chat. Fetch bounded snapshots only while visible. Keep all sensitive body fields out of public state/events/snapshots/history.
- [ ] Implement management top-level review text-only rendering, full bounded preview, explicit decision, existing unlock, CSP/frame denial, no service worker/browser storage; open explicit `noopener,noreferrer` link and same-tab fallback. No arbitrary redirects.
- [ ] Validate desktop/phone focus, readable multiline preview, long lists/empty states, cancelled/expired operations and OAuth guidance. Read/run project `.agents/skills/webui-visual-check/SKILL.md`, screenshot actual UI and inspect images.
- [ ] Update feature docs, source inventory and `dist` via build; run `npm run verify:dist`, connection/frontend types, lint and relevant regressions. Commit final-byte build.

## Task 6: Independent review, clean artifacts and honest handoff

**Files:** `docs/validation/2026-10-24-web-extension-interactions.md`, `docs/development-log.md`, release provenance.

- [ ] Review all nine design acceptance gates against executed evidence; name each missing proof explicitly, never substitute synthetic adapters for original-source acceptance.
- [ ] Run focused tests, full relevant tests, `npm run build:web`, `npm run verify:dist`, clean package install and clean application/build of all four source patches on final bytes.
- [ ] Request independent security/source review of identity, stale source guards, duplicate effect prevention, secret projection, management auth reuse and package adoption. Fix actionable findings test-first and rerun affected/final checks.
- [ ] Record exact versions, commands, tests/passes/failures/skips and cleanup. Preserve production processes/volumes and unrelated untracked document. No merge/push/deploy without separate authorization.

## Execution ledger

- 2026-10-24: user approved written design and implementation. Existing feature branch is the approved development location; no extra worktree or unrelated checkout changes.
- Source copies obtained read-only from `b6d780fa82af`; npm/git metadata, dependency directories and caches excluded. No installed source modified.
- Baseline: 29 terminal-prompt/management/origin/registration tests passed using temporary local endpoints after sandbox permission escalation. Initial restricted attempts could not bind/connect; they were environment failures, not assertions.
- Scope review: Tasks 1→2 share broker identity/proof; Tasks 1→3/4 share public client; Tasks 2/4→5 share versioned explicit wire contract. Each consumer must use the exact exported contract, and unavailable capabilities stay unavailable until actual source integration passes. Task 6 validates final-byte evidence rather than adding capabilities.
- Continuation: foundational protocol/broker/client/private-control, management review, explicit chat panels and all four source-copy integrations are implemented; final source acceptance, clean artifacts and review remain in progress. See `docs/validation/2026-10-24-web-extension-interactions.md` for executed evidence and failures rather than inferring completion from this implementation inventory.
- Review fixes: panel invocation now uses a one-use prepare/start admission; lifecycle changes use fresh registration IDs; fallback confirmation cancels/expires even when local UI never returns; inactive clients/panels rediscover only fresh operations. Ordinary session decisions cannot approve sensitive requests or replay their receipts.
- Browser evidence: real temporary Pi/Hub with synthetic sources passed desktop/phone. Screenshot inspection found phone focus scrolling the title out of view; fixed using `preventScroll`. A new assertion caught inaccurate initial concurrency and now verifies source configuration and unsent draft preservation.
- Regression investigation: the first complete unit run exposed old fixture contracts (missing SDK event bus and new fixed source inventory). Tests are being updated to reflect the actual public SDK and distributed sources; production behavior is not weakened to satisfy incomplete doubles.
- Final Web validation: 762 tests, 760 pass, zero fail, two opt-in skips. The standalone management page was separately rerun with Chromium enabled: 41/41 pass. Three real Pi source-effect cases additionally verify successful replacement, reload, and Hub-restart recovery without old-decision replay; eight real Pi arbitration cases cover local/Web/timeout/cancellation/disconnect and cancelled-transition panel recovery.
- Source review: three P2s (effective MCP execution binding, complete local previews, final settings abort guards) were fixed and independently closed. A clean four-adapter reapplication passed 55 tests. A follow-up payload-inflation P2 is being fixed before the final artifact export; only structured intent should travel once, while complete local preview formatting stays local.
- Final source freeze: payload-inflation P2 closed by independent actual-client/broker reproduction (33,674-byte complete quote-heavy request, exact task retained, one spawn). All four final patches match frozen source postimages and pass 56/56 cases from fresh baseline copies. Final isolated real Pi Git install/update, 11 stale-source refusals, npm tarball and installed Hub lifecycle pass. No push/merge/source release/install/production enrollment/restart/deployment was performed; upstream-suite and physical-phone/provider limitations remain explicit in the validation report.
- Delivery verification: final build and source/dist verification passed, final real Pi/Hub browser rerun 1/1, complete Node run with the management-page browser enabled: 762 total, 761 pass, zero fail, one explicitly unexecuted 1 GiB stress case. Development source is frozen; source/API resolution and production rollout remain separate from this local handoff.
