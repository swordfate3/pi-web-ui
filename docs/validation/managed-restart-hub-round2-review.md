# Managed restart Hub — independent scoped round2 re-review

Date: 2026-10-17.

## Verdicts

- **Spec compliance: PASS for round1 R1/R2 and their fix-induced regression scope.**
- **Quality/security: PASS for the same scope.** No remaining actionable finding
  identified in the reviewed changes. R1 (previous P1) and R2 (previous P2) are
  closed by this review.

This is a scoped source/test review, not a claim that the reviewer reran tests or
that full-chain acceptance or production readiness is complete.

## Scope and evidence method

Read `managed-restart-hub-round2-fix-report.md`, the prior
`managed-restart-hub-round1-review.md`, and `managed-restart-hub-round2-brief.md`.
Traced the current Hub/extension/client paths and their focused unit and real-TUI
regression sources. Installed SDK source was consulted only to confirm command
expansion defaults at the R1 dispatch boundary.

Only R1/R2 and regressions introduced by their corrections were considered. The
accepted management-origin boundary, process-lifetime uncertainty and timing
contract were not reopened. Gate and staged runtime implementation are excluded;
the disjoint Gate worker was not inspected or disturbed. Earlier findings and
packaging work were not reopened as new review tasks.

No code changes, Git operations, subagents, production calls, installs, builds,
test-suite reruns or isolated probes were performed. Source inspection supplied
enough evidence for this review; no concrete unresolved behavior required a new
probe. This report is the only file written in this turn.

## R1 — closed: unaudited command taint no longer depends on the client flag

**Spec verdict: PASS. Quality/security verdict: PASS. Previous severity: P1;
no remaining finding.**

At `extensions/mirror-server.ts:1902–1905`, the fallback now latches uncertainty
before either idle or streaming expansion-enabled slash-command dispatch. This
check does not depend on `executePiCommand`. The explicit true-flag path retains
its pre-dispatch latch at `:1776–1783`; omitted and false values therefore cannot
bypass the guard through the registered-command fallback.

The new latch follows the audited builtin handlers, which complete or establish
their tracked operation before returning. It does not newly taint those paths.
The image/upload paths keep expansion disabled, and the plain steer/follow-up
calls do not enable it. The installed SDK's `sendUserMessage` defaults expansion
to false (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1848–1873`).
Thus the correction covers the previously missed command-expanding fallback
without turning every ordinary prompt into permanent uncertainty. No late
extension preload or replacement guard was introduced by this change.

Regression coverage inspected:

- `tests/runtime-guard-process.test.ts:6–65`: omitted/false/true flags crossed
  with idle/streaming states. Executes the actual extracted dispatcher with
  synthetic API boundaries and the canonical package guard; holds asynchronous
  dispatch across ACK and asserts taint before dispatch and after completion.
- `e2e/fixtures/stdin-guard-probe.ts:20–31` and
  `e2e/harness/test-stdin-guard-tui.py:107–130`: actual-Pi fixture with an async
  command held past Web ACK; checks `safeAtDispatch:false`, SDK idle/no pending
  work, busy snapshot, prepare rejection, persistent uncertainty and normal quit
  for both omitted and false flags.
- `e2e/harness/test-stdin-guard-tui.py:132–140`: positive audited `/name` case
  uses fresh post-rename identity and checks successful prepare/cancel. This
  guards against an overbroad fix disabling all audited Web operations.

The report correctly distinguishes synthetic dispatcher coverage from actual-Pi
coverage. No additional R1-induced regression was identified.

## R2 — closed: unsuccessful operations return valid live originals to ordinary recovery

**Spec verdict: PASS. Quality/security verdict: PASS. Previous severity: P2;
no remaining finding.**

`hub/server.ts:254–282` removes the matching operation from managed routing and
preserves an associated ordinary capability only if the browser socket is OPEN,
still mapped to the original generation, and that generation has the expected
run and original runtime. The runtime is captured at prepare (`:326–329`).
Invalid or already-disconnected originals are removed rather than granted a new
recovery path.

For a valid original, cleanup clears `item.restart`, pins `item.successor` to
`item.from`, records `originalRuntimeId`, and sends a trusted `hub_route` frame
without restart metadata. The existing PiClient handler clears its managed
window on that frame (`src/web/src/core/pi-client.ts:79–92`), so the next close
uses the ordinary **15-second browser budget** (`:204–210`). The server's existing
close handler separately starts its **45-second ordinary capability lease**
(`hub/server.ts:820–823`). Neither is a renewed managed 120/210-second window.

The preserved capability does not authorize an arbitrary later registration:
its successor is already bound to the original generation, and the ordinary
handoff path rechecks the current runtime after asynchronous backend proof
(`hub/server.ts:562–606`). The same path checks map membership, grant/token/host,
expiry, shutdown and current-registration identity after the await. Subsequent
terminal polls cannot downgrade/rearm the entry again because it no longer has
the failed operation's `restart.id`. Existing managed-success routing remains
separate from this ordinary fallback.

Regression coverage inspected:

- `tests/hub-restart-api.test.ts:285–315`: rejected, pre-stop failed, stale and
  recovery_required cases; ordinary route notification, repeated terminal query,
  transient disconnect, same-generation recovery, ordinary expiry and rejection
  of an unapproved successor. Provider submission count remains one.
- `tests/hub-restart-api.test.ts:317–329`: disconnected, retired, runtime-changed
  and revoked originals do not receive ordinary recovery authority.
- `tests/hub-restart-api.test.ts:331–347`: same-generation runtime renewal while
  proof is held must reject the downgraded capability after proof returns.
- `tests/pi-client-managed-restart.test.ts:5–92`: managed-to-ordinary control
  restores the 15-second budget; valid managed control retains 120 seconds from
  close, and malformed controls do not grant it.

The test helper waits for backend close before moving its fake clock, matching
the server's real close-triggered lease boundary. Keeping already-disconnected
or invalid originals fail-closed is consistent with this bounded correction.
No additional R2-induced regression was identified.

## Verification provenance and acceptance boundary

The round2 worker reports the following final-source results; they were **read
and accepted as supplied evidence, not independently rerun**:

- Focused Hub/guard/client/existing session-Hub tests: **74/74 PASS**, zero
  failures/cancellations/skips, 3.772 seconds.
- Actual-Pi TUI/WS/IPC guard acceptance: **6/6 PASS**, 6.469 seconds.
- Connection-scope TypeScript check: **PASS**, exit0.
- Scoped Biome check at error diagnostic level: **PASS**, exit0; this is not a
  claim that warning-level diagnostics are absent.

The report supplies pre-fix RED evidence for both corrections and explicitly
separates sandbox setup errors and corrected fixture mistakes from product RED
results. This review does not independently reproduce those historical runs.

Main is running full verification and stable-source browser repeats separately.
Those results remain controller-owned and are not preemptively certified here.
The earlier browser timeout is not dismissed or overwritten by this scoped PASS.
No Gate approval, runtime re-review, production activation or deployment authority
is implied. **R1/R2 need no further changes identified by this review.**
