# Managed restart Hub — independent scoped round1 re-review

Date: 2026-10-17. Reviewed current source in `pi-web-ui` and the permitted
`../pi-runtime-restart-work/pi-docker` guard/overhead changes.

## Verdicts

- **Spec compliance: FAIL — changes required.** F3 still permits an unaudited Web
  command to execute without latching uncertainty. F6's terminal cleanup also
  breaks ordinary recovery for an otherwise live, unchanged chat connection.
- **Quality/security: FAIL — changes required.** One P1 safety finding and one P2
  fix-induced recovery regression below. F1, F2, F4 and F5 are addressed in the
  reviewed source; the F6 clock correction itself is addressed.

The separate management origin, conservative process-lifetime uncertainty and
210-second execution contract are accepted, not reopened. This is not a Gate
review, production-readiness certification, or request for a different design.

## Scope and method

Read `managed-restart-hub-fix-brief.md` first, then the fix report, original F1–F6
review, round1 diff package, approved plan/design, and binding security, timing
and progress rulings. Current source takes precedence over package-era mechanical
format/import-order differences and the superseded report statement requiring an
adjacent staging tree for ordinary unit tests.

Checked only those fixes and their induced regressions: Hub listeners/auth/API,
exact successor proof, extension/guard, browser handoff, permitted supervisor
phase caps, packaging/parity and corresponding regression coverage. Gate source
and the other worker's changes are excluded. No Git commands, subagents,
installs, Docker runs, production calls or product edits were performed. Supplied
passing suites were not rerun. This report is the only repository file written.

## Findings

### R1 — P1: Web command taint is conditional on an optional client flag

**Primary location:** `extensions/mirror-server.ts:1776–1777`.
**Supporting locations:** `extensions/mirror-server.ts:1895–1907,1928–1932,2466–2467`.

The new `taintRuntimeInput()` call executes only when the request contains
`executePiCommand === true`. A normal `prompt` request containing a registered
extension command, for example `{message: "/guard-touch"}`, can omit that flag
or set it to false. The fallback accepts registered command names and reaches
`pi.sendUserMessage(message, {expandPromptTemplates: true})` without tainting.
This is an accepted server-side request path, not a hypothetical alternate TTY
reader or malicious in-process modification.

Installed SDK1.1.0 source confirms that this option executes extension commands
before normal input handlers (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1522–1533`),
awaits the command handler internally (`:1636–1650`), and exposes the extension API
through a void wrapper (`:2712–2720`). Consequently the mirror acknowledges and
decrements `activeBrowserMutations` while an asynchronous command may still be
running. An otherwise saved, idle process with no agent work can remain eligible
for prepare and be stopped during that untracked command. The stdin guard cannot
observe this Web-only input.

**Independent evidence:** a new in-memory probe extracted the actual current
`handleRequest` function with the TypeScript parser, executed it with synthetic
API/context boundaries and the shipped real stdin guard, and compared omitted
versus true flag values. Exit0 output established:

```text
unflagged: dispatched /guard-touch, expandPromptTemplates=true,
           safeAtDispatch=true, ACK ok=true, activeBrowserMutations=0
flagged:   safeAtDispatch=false
```

This is a dispatcher-level reproduction, not a claimed full real-TUI reproduction
of stopping an asynchronous command. The SDK call chain establishes the missing
completion tracking. The supplied real-TUI Web-command test uses
`executePiCommand:true` in `e2e/harness/test-stdin-guard-tui.py` and therefore does
not cover the bypass.

**Spec verdict: FAIL (F3). Quality/security verdict: FAIL (P1).** Latch before
every accepted unaudited command-dispatch path, independent of the optional UI
flag, or reject paths that are not covered. Add omitted/false-flag regressions
with an asynchronous command held in progress; verify taint before dispatch and
prepare refusal after the browser ACK. Keep audited tracked operations working.

### R2 — P2: Rejected/failed restart cleanup removes a live chat's ordinary recovery token

**Primary location:** `hub/server.ts:253–255`.
**Supporting locations:** `hub/restart-api.ts:114–118`;
`hub/server.ts:501–506,779–799`; `src/web/src/core/pi-client.ts:117–120,239–258`.

`prepareHandoff()` upgrades the existing browser handoff entry to managed-restart
state. When an operation becomes rejected, stale, failed or recovery_required,
`clearHandoff()` deletes every associated entry, including entries whose chat
WebSocket is still open and whose original generation is still healthy. It does
not return that connection to ordinary handoff state or send a replacement
ordinary `hub_route` frame. New tokens are issued only at WebSocket establishment.

Concrete sequence: open a healthy chat, submit a manual restart, reject the job
without stopping Pi, and let management polling observe the rejection. The live
chat now holds a token that no longer exists at Hub. On a subsequent transient
network disconnect, `/api/session-handoff` returns410 immediately. PiClient stops
recovery and displays the expired-link error instead of reconnecting to the same
still-live Pi under the ordinary15-second recovery behavior. The same problem
can follow a pre-stop refusal; it does not require a broken successor or revoked
run grant.

**Evidence:** deterministic source-path analysis of cleanup, token issuance,
missing-token410 and the client non202 terminal branch. A new isolated scenario
reusing only the existing fixture helper (not registering/running its suite) was
attempted, but the sandbox rejected its first temporary127.0.0.1 listener with
`listen EPERM` before scenario assertions ran. It is **not** reported as a runtime
reproduction, a passing test, or a product test failure.

**Spec verdict: FAIL (ordinary recovery preservation in F6).
Quality verdict: FAIL (P2 availability regression).** Remove managed authority
without stranding an open connection: preserve/reissue an ordinary, correctly
fenced handoff when the original generation remains valid, and inform PiClient
that the managed window ended. Do not retain failed-operation authority or permit
fallback to an arbitrary successor. Add a rejected/pre-stop-failed job followed
by transient disconnect regression with the old Pi left alive.

## Disposition of the requested fixes

| Item | Scoped disposition and evidence |
| --- | --- |
| F1: management origin | Addressed. Strict optional config and runtime cross-origin checks; dedicated127.0.0.1 listener; trusted route allowlist; no Pi proxy/WS/CONNECT/service-worker surface; no chat management authority; exact management Host/Origin writes; no chat CORS grant; upstream `x-pi-hub-*` stripping; canonical cross-origin links and sanitized cards. Actual Chromium hostile-origin PASS is supplied evidence, not rerun. |
| F2: successor race | Addressed. `hub/server.ts:262–289` rechecks run, managed flag, runtime, saved session, leaf and version after live proof. Existing same-object renewal regressions cover runtime/session/leaf/version changes. |
| F3: terminal fence | Pre-SDK guard implementation addressed, but overall F3 remains open due R1. Fixed preload, immutable handle, permanent uncertainty, bounded whole-packet report allowlist, observed-displacement latch, owner/operation freeze/release, shutdown suppression, fresh snapshots and16KiB outbound validation are present. |
| F4: management authorization | Addressed. `hub/management.ts:115–124` revalidates the same key/epoch/CSRF/expiry; `hub/restart-api.ts` repeats checks after body/proof waits and before save/arm/POST, with unsubmitted-receipt cleanup. Revoke/logout/expiry × body/proof coverage was inspected. |
| F5: initial terminal response | Addressed. POST calls the same `resolve(id, job)` used by query/handoff; identity, version and live successor proof precede public success. Missing/mismatched successor submission regressions are present. |
| F6: clocks and cleanup | Immutable bounded `started_at`,210s registration deadline, nonrenewing retirement/disconnection handoff clock and120s browser clock from old WS close are addressed. Pending>3min and160s/210s timing cases are present. Terminal cleanup introduces R2. Persisted verified completion still requires live exact successor proof. |
| Supervisor overhead caps | No additional scoped finding. `pi_supervisor.py:415,459–498` establishes15s checking at acceptance and checks before work, after prepare and immediately before the one SIGTERM. `:507–538` bounds sync/spawn separately to10s and checks readiness after snapshot waits. Sync uses a timeout-bound disposable helper; no Pi force-kill or second stop was introduced. Gate's outer timing implementation is excluded. |
| Standalone realguard/image parity | Addressed in current source, superseding the worker report's adjacent-tree dependency. Both ordinary guard test files import the actual package guard; no adjacent staged import remains in `tests/`. The package includes `extensions/`, the guard is in the distribution inventory, and installation regression inputs include it. Staged Dockerfile installs its copy root-owned at the fixed preload path. |

Independent checksum inspection found both
`extensions/runtime-stdin-guard.mjs` and
`../pi-runtime-restart-work/pi-docker/runtime/pi_stdin_guard.mjs` equal to:

```text
f966e83a5f0e7c9e446488e7ede6d0bd0ec2477878bdfaa14a00667eaa92c223
```

`e2e/harness/test-managed-runtime.py:45–46` checks staged/package byte parity and
`:165–172` checks the actual Docker image's fixed guard checksum. These checks
were inspected, not rerun. Ordinary unit tests do not invoke this staged-image
harness. The two new guard/origin test files are present in both Biome scope and
`tsconfig.connection.json`. An ordinary Pi extension does not load the package
guard as a late substitute for the image preload.

## Verification record and remaining acceptance boundary

Accepted as **main/worker-supplied evidence**, without rerunning:

- Main's fresh full unit run:369total,368pass,1opt-in skip,0fail,0cancel.
- Main's two TypeScript configurations:PASS; post-package mechanical import/format
  changes reported as nonsemantic.
- Actual Chromium hostile-origin isolation:PASS, including no readable management
  authority and zero unauthorized provider POSTs.
- Fresh real two-Docker runtime test:PASS.
- Real Gate + Hub + two Docker containers + mobile browser full chain:PASS in8.631s.
- Worker-specific guard, adapter, authorization, timing, supervisor and real-TUI
  passing results remain supplied evidence as recorded in the fix report.

Independent work here consists of source/test review, SHA-256 parity verification
and the new dispatcher probe described in R1. The separate R2 loopback probe was
blocked by sandboxEPERM and did not exercise its assertions. No supplied passing
suite was rerun, skipped, stubbed or represented as independently reconfirmed.

The earlier full-browser timeout remains unresolved evidence; the later8.631s
PASS does not erase it. Main's stable-source repeats are still planned after the
disjoint Gate fix. This review neither labels that timeout irrelevant nor claims
all integration acceptance is finished. Resolve R1/R2 and perform the planned
bounded acceptance before claiming this security fix complete; no production
activation or new deployment authority is implied.
