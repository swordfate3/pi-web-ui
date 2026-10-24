# Web extension interactions: four-adapter design

Date: 2026-10-24 (Asia/Shanghai)

Status: written design and implementation approved by the user on 2026-10-24.
Development is in progress; no production activation is claimed.

Source baseline: `428511e4743251883153a9a8cb15b8910b480240`.
Development branch: `codex/web-extension-interactions`.

## 1. User outcome and scope

The user can operate the following four installed capabilities from a phone:

| Capability | Required outcome |
| --- | --- |
| MCP adapter | Manage servers, inspect connection state, enable/disable, and complete OAuth authorization through a supported provider flow. |
| Scoped memory | Review the exact change and scope, then allow or reject write/forget/restore and an eligible stale-lock repair. |
| Knowledge Studio V2 | Select a model profile and review the existing import/index/egress/search/generation/export confirmations. |
| Subagents Lite | Open `/agents`, inspect running/queued agents, select models and supported thinking, configure concurrency, and create an agent. |

Normal management uses responsive panels in the existing chat page. Sensitive
confirmation uses a small top-level window/tab on the configured management
origin. It reuses existing gateway login and management unlock; it introduces no
new management code, default password, terminal hostname, or terminal-control UI.

Git command dialogs, architect, search, stash history, Telegram, Bilibili,
unrelated built-in selectors, and automatic conversion of arbitrary extension
TUIs are out of scope. MCP package installation/removal via the separate
`pi-mcp-installer` package is also deferred: its inventory command is not the
MCP adapter's server manager and its mutation tools need a later adapter.

Success means a real installed source extension consumes the answer and performs
or rejects its original operation. Merely drawing a modal, returning an ACK, or
passing a synthetic Web-only fixture does not satisfy acceptance.

## 2. Verified starting point

- `src/web/src/app.tsx` implements dedicated Web flows for `/model`, `/tree`,
  `/resume`, `/fork`, and `/settings`; these are not generic TUI mirroring.
- `extensions/terminal-prompt.ts` and `docs/terminal-prompts.md` intentionally
  carry only prompt kind/title. They have no body, choices, or resolver.
- `extensions/mirror-server.ts` rejects generic `extension_ui_response`.
  This rejection remains for unsupported/unadapted requests.
- `hub/management.ts` already provides gateway unlock, host-only management
  cookie, expiry, revocation epoch, and CSRF checks. `hub/server.ts` serves
  management on a separate listener and enforces allowed origins.
- MCP Adapter 6.0.0 has custom terminal panels, standard input/editor prompts,
  runtime guards, and an OAuth callback-input workflow. It also registers
  `/mcp-adapter`, `/mcp-auth`, and conditionally `/mcp`; built-in MCP coexists
  in the installation. A command's name alone does not prove its owner.
- The installed Subagents Lite entry registers `/agents` (plural), with custom
  TUI menus reading the extension-owned configuration and running-agent state.
- Scoped Memory 0.10.0 prepares an exact preview, asks for confirmation, then
  rechecks identity/signal/legacy conflicts before committing. Knowledge Studio
  V2 has explicit capability and operation-scoped confirmation boundaries.

These package versions describe the inspected installation, not a perpetual
allowlist of Pi versions. Runtime support is negotiated by adapter protocol and
capabilities, with exact tested artifact provenance recorded for each release.

## 3. Approach and ownership

Use explicit, cooperative adapters in the four source extensions plus a common
bounded interaction broker supplied by Pi Web UI.

Alternative: make a new RPC owner control the entire Pi child. Rejected for this
iteration because it changes normal launch/control ownership and still does not
translate custom MCP and subagent panels.

Alternative: restore the native terminal gateway. Rejected because the user
specifically wants task-oriented dialogs, not another terminal page or broad
keystroke control.

Responsibilities:

1. **Source adapter:** registers its identity/capabilities, creates a typed
   request from its own operation, and consumes the response through its existing
   service. It owns authorization semantics, cancellation, and commit guards.
2. **Pi interaction broker:** keeps bounded transient requests, checks identity,
   validates response schemas, and arbitrates terminal/Web completion once.
3. **Mirror transport:** transports explicitly supported public panel messages;
   does not infer prompts from tool output or inspect another extension's private
   manager. Sensitive bodies and answers are not public WebSocket events.
4. **Hub interaction API:** locates the fixed registered Pi backend, verifies
   current registration, applies management authorization for sensitive requests,
   and delivers request-bound approval evidence.
5. **Chat UI:** renders ordinary management panels, displays pending-action
   notices, and offers an explicit button opening trusted review.
6. **Management UI:** independently fetches the authoritative request, displays
   its complete bounded preview, and submits a human decision.

No monkey-patching `ctx.ui`, private runner access, replacing another RPC owner,
simulated terminal keys, arbitrary shell execution, or generic cross-container
control is introduced.

Source changes must be maintained in reviewable source checkouts, not edited
silently inside the shared installed package or old release directory. Local
release packages/patches must identify their exact upstream and modified source.
Upgrading the Web package alone must not imply its adapters are installed.

## 4. Identity, capability, and request contract

An adapter advertises protocol `pi-web-interactions-v1`, adapter ID, package and
adapter version, and an explicit supported action list. The broker binds that
registration to the current extension runtime, not a browser-supplied ID.

Every interaction carries:

- A cryptographically random request ID and operation ID.
- Fixed run ID, Hub generation, runtime ID, session ID, and adapter ID/version.
- Operation-specific revision: prepared-memory revision, model profile revision,
  server config revision, or subagent configuration revision as applicable.
- Method (`confirm`, `select`, `input`, `editor`, or a named panel action),
  schema version, creation time, absolute deadline, and current state.
- Canonical digest of the complete semantic request, including scope, choices,
  target and original confirmation wording. Security decisions bind this digest.
- An allowlisted response schema and classification (`session` or `sensitive`).

Only the source adapter defines the classification; the browser cannot downgrade
it. Trust/config changes, credential operations, data egress, durable memory
mutations, and source-required approval all use `sensitive` review.

Read-only panel snapshots and ordinary session settings can use the existing
session-control boundary. MCP reconnect/enable and any action that may start
server code require sensitive review. Agent creation remains an explicit
session action under the existing subagent tool policy; it does not gain new
tools, mounts, credentials, or administrative privileges.

The response repeats the fixed identity, request digest, request revision, and
decision ID. The sink validates the chosen option/value against the original
schema and freshly rechecks operation ownership immediately before effects.

## 5. Trusted confirmation channel

The chat page shows only an adapter label, operation label, pending request ID,
and state for sensitive work. It does not receive sensitive previews, OAuth
callback values, management cookies, CSRF values, or approval capabilities.

User flow:

1. The source operation registers a pending request. No effect is approved yet.
2. The chat page offers **Review and confirm**. This click opens the configured
   management origin using `noopener,noreferrer`; no automatic popup is used.
3. The management page reuses gateway login and explicitly unlocks management
   using the existing login action when necessary. Authentication is not a
   decision to approve the pending operation.
4. It retrieves the live request from Hub. Request IDs in URLs are locators,
   not bearer capabilities. It renders source text as text, not agent HTML.
5. An explicit allow/reject submission requires the management cookie, CSRF,
   exact Origin, live management epoch and exact current request revision.
6. Hub revalidates the fixed registration after any asynchronous backend work,
   signs a short-lived decision, and sends it only to that registered Pi.
7. The Pi broker verifies the decision and the source adapter resumes the
   original operation, preserving its original post-confirmation guards.

The approval authority must not be an HMAC derived only from a Pi run token:
the Pi itself knows that token. Use an asymmetric Hub signing key kept solely
in private Hub state and pin its public key through host-owned, read-only
per-run enrollment. The public key may be an additive, versioned field in the
existing per-run credential document; do not introduce a shared administrator
secret into Pi home. Enrollment and public-key/schema changes need coordinated
launcher compatibility checks before activation. No live credential is rewritten
as part of development tests.

Signed evidence binds audience, request and operation IDs, fixed run/generation/
runtime/session/adapter identity, content digest, revision, decision, issued time,
deadline, broker challenge, and issuer epoch. Reject replay, an unknown issuer,
expired evidence, a rotated generation, changed request content, or the wrong
adapter. A sensitive read response also requires backend proof of trusted
management access; it cannot be obtained through the public chat route.

The broker challenge is negotiated for one live authenticated Hub-control
connection and issuer epoch. Control-channel loss invalidates that challenge
and its undecided requests before a new channel is admitted. Previously signed
messages cannot be buffered into the new channel, even when their wall-clock
deadline has not elapsed. A public run-authenticated connection cannot establish
an approval channel without the pinned Hub signing proof.

The management review surface remains top-level and non-frameable. It has no
agent-generated artifacts, service worker, arbitrary return URL or opener-based
approval. If a phone blocks the popup, a clearly labeled same-tab link works;
return navigation is to a validated same-deployment session path only.

Threat boundary: this separates untrusted chat-origin content from trusted Web
confirmation. It is not isolation against a malicious extension with arbitrary
code execution in the same Pi process or a compromised host/Hub administrator.
No stronger sandbox claim is made.

## 6. Four source adapters

### 6.1 MCP Adapter

Provide a Web-native server panel backed by the adapter's own services. Required
operations are list/status, reconnect, enable/disable, and selecting/starting an
OAuth sign-in. Read views redact environment values, headers, embedded URL
credentials, tokens, and secret-bearing command arguments.

Resolve the actual command owner/capability before routing `/mcp`; when ownership
is ambiguous, offer the explicit `/mcp-adapter` target instead of selecting one
silently. The built-in MCP manager is not implicitly adapted by this release.

OAuth uses the adapter's existing provider, redirect URI, state/PKCE checks,
credential storage and reconnect path. The trusted window presents the real
provider link and a callback-input form where the current provider supports
pasted callbacks. It does not submit a fake consent on behalf of the provider.
The authorization URL and callback exist only in the trusted flow's transient
state; they are absent from public chat, logs, browser storage and analytics.
Validate the callback through the provider's flow; never fetch a browser-supplied
callback URL as a generic server request.

Do not claim every OAuth provider works on a remote phone. Unsupported callbacks
or flows fail with an explicit explanation and retain the terminal alternative.
Bearer-token entry remains deferred; the current adapter refuses unmasked secret
input, and this release must not silently route it through a normal input field.
Raw MCP config editing, setup/import wizards, and Jev setup are deferred beyond
the agreed server-management and OAuth scope.

### 6.2 Scoped Memory

Replace only the confirmation selection boundary with an opt-in adapter call;
prepare, exact preview, folder/global scope rules, dated identity, revision,
signal, legacy-conflict checks and commit remain owned by Scoped Memory.

Cover both explicit slash commands and their existing mutation tools. A Web
answer never creates a new prepared operation from browser text or substitutes
`approved=true`. Reject a changed prepared revision rather than applying a
different preview. Stale-lock repair retains its active-owner and stability
checks before and after approval.

### 6.3 Knowledge Studio V2

Route existing capability confirmations and the combined generation-workflow
confirmation through the adapter, preserving their text, requested grants,
operation identity, source/destination, model/profile revision, costs warning,
signals and guarded execution path. The browser cannot add capabilities.

`/ks-v2-profiles` gets a normal selection panel followed by trusted confirmation
of the exact default-profile change. Existing indexes remain unchanged. A
combined generation approval covers only the source-defined operation and
capability set, not unrelated work or all future prompts.

### 6.4 Subagents Lite

Implement a responsive `/agents` panel rather than screen-scraping its custom
SelectList menus. Use source-owned accessors/commands for running/queued agents,
visible agent types, models, supported thinking, concurrency and spawn.

Reuse the existing ConfigStore validation and task execution services. Validate
model availability, thinking policy, concurrency limits and exact agent type at
submit time. Updates carry an expected configuration revision so two tabs do not
silently overwrite each other. Show whether a change affects future agents or
an existing task. Do not pretend that changing defaults restarts running agents.

Creation requires an explicit task and a single-use action ID; a reconnect or
double click cannot spawn a second agent. Diagnostic/advanced terminal-only
settings remain outside this panel's advertised capability list.

## 7. Lifecycle and failure semantics

States are `pending`, `delivering`, `allowed`, `rejected`, `cancelled`, `expired`,
`stale`, and `delivery_unknown`. Allowed means the decision was consumed, not
that the source operation committed successfully; display its separate outcome.

- Only one completion wins between terminal, Web, cancellation and timeout.
- Local terminal handling is retained. Its source prompt is cancellable; a Web
  winner closes the pending local interaction without synthesizing keystrokes.
- The common confirmation coordinator wraps the choice point before the
  original `ctx.ui.confirm` starts. It can deliver either local or trusted Web
  results to the same guarded operation; it does not resolve an arbitrary SDK
  dialog from another extension.
- Session replacement/fork/tree/reload, runtime exit, registration revocation,
  adapter unload, or changed operation revision invalidates pending work. New
  contexts cannot inherit the old resolver. Use fresh lifecycle identity rather
  than long-lived captured contexts.
- Browser disconnect drops local display state; an otherwise live operation may
  remain pending until its original deadline. Reconnect fetches current state
  without approving, retrying effects, or extending the deadline.
- Hub restart never restores unresolved approvals from disk. Invalidate its old
  challenge/issuer epoch and cancel affected pending channels; requests do not
  migrate to a new generation. Cancelling remote review does not silently grant
  approval or restart a source operation; a terminal fallback is an explicit new
  choice under the source's still-current operation rules.
- If delivery becomes uncertain, do not resend an effect. Query the same
  decision's bounded completion record; if unavailable, show unknown and require
  a new explicit source operation after the user checks the source state.
- Unsupported adapters keep the existing terminal-required notice. Missing
  management, pinned key, registration or supported adapter cannot downgrade a
  sensitive operation into an ordinary Web approval.

## 8. Resource and privacy limits

All pending bodies and callback data are transient. Hub does not append them to
session files, its persistent registry, management state, or ordinary logs.

Initial limits:

| Resource | Bound |
| --- | --- |
| Complete interaction JSON, including preview | 64 KiB UTF-8 |
| Pending requests per Pi | 8; at most one sensitive request actively presented per operation |
| Pending requests across Hub | 64, also subject to a 4 MiB aggregate serialized-payload budget |
| Ordinary confirmation deadline | Minimum of source deadline and 120 seconds |
| OAuth interaction deadline | Minimum of provider/source deadline and 10 minutes |
| Non-sensitive terminal outcomes retained for deduplication | 128 per Pi, 5 minutes, at most 256 KiB; no prompt/answer bodies |
| Panel list response | 100 items and 64 KiB, cursor/revision required for more |

Reject an oversized confirmation instead of truncating details required for an
informed decision. Reject over-budget requests before admission; no unbounded
queues. Preserve existing Hub state, history and transport budgets. Polling is
bounded and active only while a visible panel/review needs it; hidden tabs do
not accumulate interval loops. Cleanup runs on deadlines and lifecycle changes.

Audit records, if needed, contain only IDs, adapter/action labels, digest,
deadline and terminal state; no task text, memory contents, callback, token,
headers, preview, hidden reasoning or raw error payload. New persistent signing
metadata participates in the existing state-budget writer, not a parallel store.

## 9. Packaging and compatibility

The release comprises Pi Web UI/Hub plus the four source adapters. Capability
discovery reports absent, unsupported, available and temporarily unavailable
separately. The UI must explain which component needs updating.

No WSL-specific daemon or Docker API is required for panel interaction. Existing
authenticated Hub registration is reused. Normal Pi remains UID/GID 1000 with
existing security options; no sudo, Docker socket, host service control or
administrator key is added to the Pi container.

Expose a versioned small interaction client/protocol through the distributed Web
package without depending on another package's private module path. Adapters
remain optional and fall back to the original terminal path when the Web broker
is absent. If Web is configured but fails verification, fail closed for that Web
decision and report the usable terminal alternative; never auto-approve.

The implementation plan must identify exact source checkouts and releasable
artifacts for each adapter. Source review, clean install/update, observed loaded
capabilities, and runtime adoption are separate checks. Do not hot-edit installed
release directories or declare success from a synthetic adapter alone.

## 10. Acceptance gates

Tests use temporary settings, credentials, workspaces, ports and volumes only;
no real user's sessions, tokens, memory store, MCP credentials, or production
volumes. Provider network calls use deterministic test servers. A real-provider
phone test is a separately authorized deployment check, not an offline claim.

Required gates:

1. Protocol/schema/budget tests reject invalid identities, unknown options,
   revision changes, oversize bodies, duplicate decisions and adapter spoofing.
2. Management API tests reject public-chat approval, wrong Origin/Host, missing
   or stale CSRF, revoked/expired management sessions, forged signatures,
   expired/replayed evidence, changed backend identity and arbitrary redirects.
3. Real Pi tests cover local allow/reject, Web allow/reject, simultaneous local
   and Web answers, cancellation, timeout, reload, session replacement, Hub
   restart, disconnect and no-effect replay. Keep unadapted native-confirm
   rejection tests passing.
4. MCP tests load the actual modified adapter: panel data, enable/disable,
   reconnect and synthetic OAuth with real state/PKCE/callback validation where
   applicable. Prove public chat/logs contain neither callback nor secret values.
5. Memory tests load the actual modified extension: exact-preview allow commits
   once; reject/timeout/stale revision and wrong folder cause zero mutation;
   active locks remain protected.
6. Knowledge Studio tests load its actual adapter: profile revision changes,
   grant scoping, combined generation, egress target and cancellation; refusal
   causes no forbidden I/O or provider call.
7. Subagent tests load the actual modified extension: model/thinking choices,
   revision conflicts, concurrency constraints, queued/running state and exactly
   one actual spawn under duplicate/reconnect conditions.
8. Desktop and phone-sized browser tests exercise real Web/Hub/Pi transport,
   full readable previews, keyboard/focus behavior, popup-blocked fallback,
   terminal settlement and stale-button disabling. Visual checks supplement
   real E2E; mocked transport is not substituted for it.
9. Types, full relevant unit/security regression, production builds, dist/source
   correspondence and clean package install/update all pass on final bytes.

Write exact commands, versions, pass/fail/skip results and resource cleanup in a
dated validation report. Disclose missing acceptance evidence explicitly.

## 11. Delivery and rollout boundary

Develop in `codex/web-extension-interactions`; preserve unrelated user files.
Create the implementation plan only after written-spec review. Work may be
decomposed into broker/auth foundation, sensitive adapters, and custom panels,
but all four named outcomes must pass before calling this release complete.

Do not merge, push, rebuild the live Hub/Gate, replace the shared installed
extensions, enroll production signing keys, or restart live Pi containers as an
implicit design/documentation step. Source delivery and production deployment
are separate actions. The final handoff lists any adapter-source release or
process restart still required.

Rollback disables the optional interaction capability and restores the original
source adapter paths while preserving Pi data and existing management login.
Pending decisions are cancelled, not migrated or automatically approved. The
existing terminal operation remains the fallback; no old terminal deployment is
reintroduced.
