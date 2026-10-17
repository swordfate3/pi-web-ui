# Managed restart Tasks 3–5 review

Date: 2026-10-17. Method: task-scoped static source/diff review; no code changes, Git commands, child agents, test execution, or production requests. This report is the only review output written.

## Verdicts

- **Spec compliance: FAIL — changes required.** The exact-successor fence, full TUI prepare barrier, management revocation at submission, and success reporting do not satisfy the frozen contract/binding security requirements. Pending/manual operations also conflict with the current deadline implementation.
- **Quality/security: FAIL — changes required before enabling management.** Four P1 findings and two P2 findings below. In particular, management authority is not isolated from Pi-originated browser code.

Requirements are limited to Tasks 3–5 and the frozen protocol in `docs/superpowers/plans/2026-10-17-managed-pi-restart.md`, with `docs/superpowers/specs/2026-10-17-managed-pi-restart-design.md` supplying binding security constraints. Reviewed `docs/validation/managed-restart-hub-review-diff.md`, current corresponding source/tests, and `docs/validation/managed-restart-progress.md`. Installed Pi SDK source was read only to verify actual TUI/input semantics. Gate implementation is paused and **not reviewed**; its absence is not a finding. F6 is a real interface conflict with the explicitly allowed pending/manual contract, not a finding against unimplemented Gate code.

## Findings

### F1 — P1: Pi-served JavaScript can exercise an unlocked browser's management authority

**Location:** `hub/restart-api.ts:155–156`; supporting `hub/management.ts:101–109,138–139` and `hub/server.ts:535–550`.

The new status endpoint returns the session's CSRF nonce to any script on the Hub origin. Meanwhile `/s/<generation>/...` still serves arbitrary backend response bodies on that same origin, without browser-origin isolation. Once an administrator has paired, script served by an ordinary registered Pi can fetch `/api/management/status` with the browser's cookie, read the CSRF nonce, enumerate `/api/sessions`, obtain a target, and submit a restart with that nonce. Origin and SameSite checks pass because the script is genuinely same-origin; HttpOnly only prevents directly reading the cookie. No lifecycle token or private Hub file needs to be stolen.

This makes “registered Pi can serve a page” sufficient to borrow an already-unlocked administrator's authority over other eligible runs, without the selected-card confirmation. Stripping upstream Cookie/Authorization and backend Set-Cookie is useful but does not close this browser-side route. The design's shared-UID isolation caveat does not resolve a browser authority crossover that requires no filesystem compromise.

**Required correction:** isolate the trusted management surface from executable Pi content using an actual browser security boundary, or an equivalently enforceable design. Do not treat a different URL path, Referer check, or HttpOnly flag as an origin boundary. Also keep management-specific headers out of upstream forwarding; the current generic filter does not exclude `x-pi-hub-csrf`.

**Missing regression:** load a registered backend page in a paired browser and verify it cannot read management authorization material or submit a restart for another run.

### F2 — P1: Exact successor identity is checked before the await, but not after it

**Location:** `hub/server.ts:236–249`; supporting `hub/server.ts:218–227,334–337`.

`successor()` compares runtime/session/leaf/version, then awaits `verified(generation)`. That helper checks only that the same `Session` object remains current after the backend challenge. Registration renewal mutates that object's `runtime` property in place. A renewal changing session, leaf, runtime, or version can therefore finish during the challenge; the object-identity fence still passes and the old pre-await identity match produces a successful path to the now-different registration. The challenge itself proves generation ownership, not the frozen runtime tuple.

Concrete ordering: matching successor is selected → hold its identity challenge response → renew the same generation with different runtime metadata → release the challenge. The current code returns the route instead of rejecting/waiting. This violates the requirement to follow only the exact restored run/runtime/session/leaf/version.

**Required correction:** recheck the complete expected identity against the current verified registration after the await, with a registration revision/immutable snapshot fence where needed. Preserve the existing grant, expiry, retirement, and shutdown checks.

**Missing regression:** mutate runtime metadata on the same generation while the successor proof is pending; neither operation polling nor browser handoff may return success for it.

### F3 — P1: The prepare barrier does not cover TUI commands or ongoing TUI bash work

**Location:** `extensions/mirror-server.ts:409–425,1315–1323`.

The barrier intercepts the Pi `input` event and four session-before events, but `input` is not a raw terminal-input gate. In the installed SDK, built-ins such as `/model`, `/thinking`, `/export`, `/name`, `/reload`, and `!` commands are dispatched before normal prompt input (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:2540–2699`). Extension commands also execute before `_runInputHandlers` (`.../dist/core/agent-session.js:1524–1538`). None of the four added session-before hooks covers all these paths.

Consequently a terminal user can start a mutation after `prepare` succeeds. Additionally, a pre-existing terminal `!` command is tracked separately as `isBashRunning` (`.../dist/core/agent-session.js:3152–3154`); `isIdle` only checks agent-run/compaction state (`.../dist/core/agent-session.js:1053–1054`), and the new `busy` expression tracks browser/HTTP/export activity rather than that terminal work. An otherwise idle saved conversation can therefore be accepted while terminal work is active. This can stop in-flight work or change the saved identity/settings after the supposedly frozen snapshot.

**Required correction:** establish a barrier before terminal command/keybinding dispatch, and account for operations already in progress. Fail closed for activity whose quiescence cannot be determined. Preserve intended normal-exit behavior and remove any terminal interception on cancel/shutdown/reload.

**Missing regression:** real TUI tests for an already-running `!` command and attempts to execute mutating built-in/extension commands after prepare. The adapter tests only vary supplied snapshot booleans and cannot establish this integration property.

### F4 — P1: Revocation during request-body or backend-proof waits does not prevent submission

**Location:** `hub/restart-api.ts:170,206–207,234–268`.

Management authorization is checked once, before reading the POST body and before the asynchronous backend lookup. The handler can wait up to five seconds for the body and then for backend proof. If the administrator runs `revoke-management`, the browser logs out, or the management session expires during those waits, the handler still writes the receipt, arms handoff, and calls `provider.restart()`. Subsequent checks inspect the run grant, not the management session/epoch. No operation has yet been submitted to Gate when that management authorization is withdrawn.

**Required correction:** revalidate the same management session, expiry, epoch, and CSRF after the last pre-submission await and immediately before accepting/persisting/submitting a new operation. This is distinct from attempting to cancel an operation that was already submitted before logout.

**Missing regression:** hold the body or backend challenge, revoke/logout/expire management, release the wait, and assert zero provider POSTs and no armed restart handoff.

### F5 — P2: The submission response can report Gate success without Hub successor verification

**Location:** `hub/restart-api.ts:262–270`; supporting `hub/portal.ts:120–123,161–163`.

The POST path returns `job.status` and `job.stage` directly after checking only job ID and the run grant. If the provider returns an already-completed `succeeded` job, this bypasses all identity/version and live-registration checks in `resolve()`. The frozen provider contract does not forbid a terminal job response. The portal immediately renders that response as “已恢复原会话”, even if no matching successor exists or the job's restored identity is wrong. A later poll may correct the display, but the API and UI have already claimed success.

**Required correction:** route terminal submission results through the same verified completion logic as GET/retry, or return a nonterminal verifying state until that logic succeeds. Gate success alone must never become public Hub success.

**Missing regression:** POST returns `succeeded` with no matching live registration, and separately with a mismatched restored tuple; neither initial API response nor initial portal rendering may claim restoration.

### F6 — P2: Manual approval consumes the restart/re-registration deadline before execution starts

**Location:** `hub/server.ts:263–274`; supporting `hub/restart-api.ts:128–133,247,255–268` and `src/web/src/core/pi-client.ts:86–88,208–209`.

Handoff is armed before Gate submission. Its Hub deadline is submission time plus 155 seconds, and the browser starts its 120-second budget when it receives that control. The registration timeout is also measured from the receipt's submission time. Yet the frozen contract explicitly allows a job to remain pending for manual approval, and the portal offers that mode.

With approval after three minutes, the old Pi may have remained healthy throughout, but its armed handoff has already expired and been swept. When the approved restart actually disconnects it, PiClient's stored deadline is in the past and recovery immediately fails. If Gate completes before the new Hub registration arrives, polling also immediately returns terminal `registration_timeout` because approval time was charged against readiness; the portal then stops polling. A compliant Gate cannot repair these Hub/browser clocks.

**Required correction:** separate pending/manual approval time from the bounded execution/readiness/handoff window. Arm or activate the relevant deadline at a trusted lifecycle transition, without repeated polling extending an active lease. If this requires protocol information, resolve that interface explicitly rather than silently assuming approval within 120 seconds.

**Missing regression:** keep a manual job pending beyond 155 seconds, approve it, and verify bounded exact-successor recovery still works without treating the approval delay as startup failure.

## Coverage and evidence limits

- **Authorization primitives:** separate management pairing/session state; one-use hashed 10-minute codes; 10 failed attempts; 30-minute sessions; 64-session bound; Secure/HttpOnly/SameSite cookie handling; same-origin write and CSRF checks are present. F1 and F4 prevent an overall security pass despite those primitives.
- **Secret handling/provider:** provider token is loaded from a private bounded file, used only in the loopback provider Authorization header, and omitted from public target/job projections. HTTP transport disables agent reuse, uses a fixed loopback endpoint, rejects non-2xx including redirects, and has a five-second timeout/16-KiB response limit. Cookie and Authorization are stripped from ordinary Pi proxy requests. This does not solve F1's same-origin authority issue.
- **Receipt/idempotency/lost reply:** an exclusive private receipt is written before provider submission; matching retries query by its ID rather than repost; mismatched identity reuse is rejected. Gate job ID equality is enforced by the API after POST and by the provider on GET. Receipt files are capped at 1,000; retention is documented as manual. No duplicate-execution defect is asserted here.
- **Extension freshness and lifecycle:** snapshot and registration getters read `latestCtx`; version uses imported SDK `VERSION`; prepare checks exact identity, idle/pending/busy, and an owned saved file; cancel is operation-fenced. IPC input has a 16-KiB cap, eight-peer cap and two-second peer timeout; the barrier lease is bounded; socket cleanup checks the owned inode. The serialized IPC reply has no explicit byte-size guard, so the frozen all-message bound is not fully demonstrated by the input check alone. The material prepare integration defect is F3.
- **Handoff and UI:** matching success polls normally compare old/new identity and expected loaded version; handoff control is Hub-generated and backend `hub_route` text events are filtered. Ordinary PiClient failure retains its 15-second default; valid managed control grants a separate bounded window. Portal stores operation receipts, confirms the selected target, checks unsupported/busy capability, and queries after lost replies. F2, F5 and F6 identify failures in those integration paths.
- **Test evidence:** the user reports targeted **37 + 3** tests and the isolated real Pi TUI test green. The progress file records the focused suites, the two-run TUI test, and its explicit lack of Docker/public-mobile validation. These are supplied evidence, not tests executed or independently reconfirmed in this review. Existing tests were inspected, not rerun. No new regression test, build, dist verification, or visual validation was performed. Full Task 5 acceptance is therefore not certified; missing Gate implementation, production activation, and deployment are not findings in this review.

All six findings are static code-path findings, with proposed regression scenarios rather than claimed runtime reproductions. No implementation fixes were applied.
