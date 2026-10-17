# Managed restart Hub round2 — bounded R1/R2 fix report

Date: 2026-10-17. Status: **DONE — scoped implementation and focused verification complete; independent review and full-chain acceptance remain with controller.** Source edits stopped after this report.

Requirements: `managed-restart-hub-round2-brief.md`, R1/R2 in `managed-restart-hub-round1-review.md`, and the accepted security/timing rulings. No design reopening, Gate/staged runtime edits, Git operations, installs, build/dist writes, production calls or deployment. Existing canonical guard packaging and controller-owned harnesses were preserved.

## Changes

### R1 — command taint independent of client flag

The registered-command fallback in `extensions/mirror-server.ts` now latches uncertainty before any remaining expansion-enabled slash prompt reaches `sendUserMessage`, whether Pi is idle or streaming. The explicit `executePiCommand:true` path retains its existing pre-dispatch latch. The fallback check follows the audited, tracked builtin handlers, so those operations are not newly tainted. Image/upload paths that disable command expansion and the audited internal-command dispatch path remain unchanged.

Installed SDK source inspection confirmed that `sendUserMessage` defaults command expansion to false, while this fallback explicitly enables it. SDK command handlers execute before ordinary input processing and are awaited internally behind the extension API's void wrapper. A browser ACK is therefore not command completion. No SDK, preload, guard or runtime shim was changed.

Focused dispatcher tests execute the actual nested `handleRequest` function, extracted with the TypeScript parser, with synthetic SDK/context boundaries and the real package preload. Six scenarios cover omitted/false/true flags × idle/streaming, holding an async dispatch across ACK and checking taint before dispatch and after completion. This is dispatcher coverage, not an assertion that a fake SDK is real Pi.

The separate real-TUI fixture also exercises actual Pi + mirror WebSocket + runtime IPC. New omitted/false-flag cases hold a registered async command open until an explicit synthetic release file. They verify `safeAtDispatch:false`, ACK before command completion, SDK idle/no pending work, busy snapshot, prepare refusal, permanent uncertainty after completion, and normal quit. A positive audited `/name` case checks fresh post-rename identity and successful prepare/cancel. Existing terminal suppression, no-replay, bash and reload tests remain.

### R2 — remove managed authority without stranding live original chat

`hub/server.ts` records the original runtime ID in the in-memory managed handoff. Terminal cleanup removes the operation's managed routing state. For an associated socket that is still OPEN and mapped to the same valid generation/run/runtime, it preserves the existing token as ordinary recovery and sends a trusted `hub_route` frame without restart metadata. PiClient already handles that frame by clearing its managed window; no frontend production edit was necessary.

The preserved token is pinned to the original generation and runtime. It cannot bind to a later registration. Subsequent handoff requests still require live backend proof and recheck the runtime after the await, as well as the existing grant, registration and expiry fences. This is an ordinary connection capability, not retained failed-operation authority. Disconnected, retired, runtime-changed or revoked originals do not receive the downgrade.

The existing socket-close handler starts the ordinary Hub capability lease (45 seconds). PiClient's ordinary recovery budget remains **15 seconds**. Neither is the managed 210-second Hub / 120-second browser window; those managed clocks and their non-extension behavior are unchanged. Repeated terminal-result polling does not rearm the removed operation.

Regressions cover rejected, pre-stop failed/checking_rejected, stale and recovery_required jobs while the original Pi backend remains alive, followed by transient disconnect and same-generation recovery. They also check the connected-client ordinary route notification, terminal polling, ordinary expiry, refusal to follow an unapproved successor, invalid-original cases, and runtime replacement during asynchronous proof. The existing browser test now explicitly verifies the managed-to-ordinary route update restores its 15-second budget.

## Exact files edited in round2

- `extensions/mirror-server.ts`
- `hub/server.ts`
- `tests/runtime-guard-process.test.ts`
- `tests/hub-restart-api.test.ts`
- `tests/pi-client-managed-restart.test.ts`
- `e2e/fixtures/stdin-guard-probe.ts`
- `e2e/harness/test-stdin-guard-tui.py`
- `docs/validation/managed-restart-hub-round2-fix-report.md`

No new distribution modules/test manifest entries are required. No edits to Gate, staged supervisor/guard, canonical guard, main-owned harnesses, build/verification configuration, dist or ledger. `docs/managed-pi-restart.md` is unchanged: this fixes compliance with the existing contract rather than defining a new one.

## RED / GREEN evidence

All commands below were run from `/home/fate/gitproject/codex_project_v2/pi-web-ui`.

R1 dispatcher RED, before the source fix:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='Web dispatcher' tests/runtime-guard-process.test.ts
```

Result: **6 tests, 2 pass / 4 fail**. Both omitted and false flags failed in idle and streaming modes with `guard must be tainted before the SDK sees the command`, actual true versus expected false. True-flag controls passed.

R1 real-TUI RED, before the source fix:

```sh
/usr/bin/python3 e2e/harness/test-stdin-guard-tui.py
```

Result: **6 tests, 4 pass / 2 fail** (6.153s). Both new omitted/false-flag cases observed `safeAtDispatch:true` while their async command was held beyond ACK. The audited rename control and three existing cases passed. An earlier test-authoring run used the pre-rename leaf for prepare; corrected to the fresh post-rename identity before this RED result.

R2 RED, before the Hub source fix:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='ordinary|failed restart' tests/hub-restart-api.test.ts
```

Result: **9 tests, 4 pass / 5 fail**. Four live-original cases returned410 instead of200 after cleanup; the proof-race test also found that cleanup removed the token before live proof could start. Invalid-original controls passed.

An intermediate GREEN attempt exposed a test-clock synchronization race: the fake clock advanced after client close but before Hub observed that close. The fixture now awaits the backend close boundary before advancing time. No extra product timeout or lease extension was introduced.

## Fresh final verification

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec tests/hub-restart-api.test.ts tests/runtime-guard-process.test.ts tests/pi-client-managed-restart.test.ts tests/session-hub.test.ts
```

**74/74 PASS, 0 failures/cancellations/skips, 3.772s.** Includes the R1/R2 regressions, existing authorization/successor/timing coverage, and ordinary Hub recovery tests. This is a focused set, not the full repository suite.

```sh
/usr/bin/python3 e2e/harness/test-stdin-guard-tui.py
```

**6/6 PASS, 6.469s**, on final product/fixture source. Uses main's launcher read-only; no main harness edits or Docker runs.

```sh
node_modules/.bin/tsc -p tsconfig.connection.json --noEmit
```

**PASS, exit0.** A formatter briefly replaced two existing test-helper non-null assertions with optional chaining, producing two type errors; those unrelated rewrites were restored before the final typecheck and final 74-test run.

```sh
node_modules/.bin/biome check --diagnostic-level=error extensions/mirror-server.ts hub/server.ts tests/hub-restart-api.test.ts tests/runtime-guard-process.test.ts tests/pi-client-managed-restart.test.ts e2e/fixtures/stdin-guard-probe.ts
```

**PASS, exit0, 6 files checked, no fixes applied.** This is error-level scoped validation, not a claim that all warning-level diagnostics are absent.

Initial sandbox-local executions could not provide usable listener/child-test results; isolated listener tests were rerun with approved sandbox escalation. Those setup errors are not counted as product RED evidence. Existing Node module-type and experimental MockTimers warnings remain.

## Remaining acceptance boundary

- No known unresolved R1/R2 failure in these focused checks. Independent review remains required.
- Full suites, build/dist refresh and repeated stable-source Gate + two-Docker + real mobile-browser acceptance are controller-owned and were not duplicated. Prior integration results are not represented as new round2 verification.
- R2 tests use real Hub HTTP/WS and backend identity proof with a synthetic lifecycle provider/backend; they are not real-Pi mobile-browser end-to-end evidence. R1 has separate actual-Pi TUI/WS evidence.
- Ordinary recovery is restored only for the still-open, valid original connection. A connection already gone when failed-operation cleanup occurs remains fail-closed; no arbitrary successor or new managed lease is granted.
- No production readiness, activation, new privileges or deployment is implied. Gate's queued independent follow-up can proceed after this handoff.
