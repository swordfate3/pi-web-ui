# Trusted Terminal Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect an opt-in newly launched pirun to a trusted phone terminal controlling that same Pi, without changing ordinary pirun or weakening bounded Hub state.

**Architecture:** An image-owned PTY supervisor and fixed broker own the only Pi terminal. A separately authenticated, default-disabled Gate provider locates an approved terminal-profile container and opens only its fixed image client; Hub serves a third-origin terminal using that provider. Remote control permanently latches chat writes off for the child, and both supervisor and Gate reject managed restart for this profile.

**Tech Stack:** Python standard-library PTY/Unix IPC/Docker stream framing, Node 22+, TypeScript, ws, pinned xterm/headless/serialize, Vite, node:test, Python unittest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-21-trusted-terminal-runtime-design.md`

## Global Constraints

- Preserve ordinary `inherited-tui`; only explicit `web-terminal-v1` startup enables terminal; old running containers are not migrated/restarted.
- Default UID/GID `1000:1000`, cap-drop ALL, no-new-privileges, no sudo; no Docker socket or provider authority in Hub/Pi.
- First remote control latches chat writes off for the child; release/reload/idle/disconnect do not clear it.
- Terminal profile has `managedRestartEligible:false`, reason `terminal_profile_unaudited`, enforced in supervisor and Gate.
- Terminal origin differs from chat/admin; public HTTPS hostname is explicit, not created or deployed automatically.
- Dedicated provider credentials never reuse registry/deployment/lifecycle/runtime tokens.
- Input 8KiB decoded UTF-8; output chunks 32KiB; per-peer queue 256KiB; parser backlog 1MiB; snapshot 1MiB; screen 240x120/1000 scrollback; two readers/one writer; fixed 30s lease.
- Hub history 256KiB, detail 64KiB, browser history 200 items/512KiB, Hub persistent state 8MiB/512 active grants stay unchanged. All terminal persistent writes use `withStateWriter`.
- No terminal content/keystroke/credential logging; no automatic input retry, reconnect control, ANSI response forwarding, OSC52 or arbitrary command/path/container.
- Source edits use apply_patch; external docker_files writes require sandbox approval. Preserve the existing untracked validation report and unrelated worktree.
- User approved this spec and execution; continue through tasks without repeated product approval. Public deployment and shared-service interruption remain outside scope.

## Interface ledger

Existing experimental `TerminalTarget`, `TerminalInput`, `TerminalBinding`, `TerminalLeaseState`, and `TerminalScreen` retain their exported signatures. Target identity is `{runId,runtimeId,sessionId,terminalEpoch}` and must match at every boundary.

New production modules export closed interfaces:

```ts
// hub/terminal-provider.ts
type TerminalProviderConfig = { socketPath: string; credentialFile: string };
type TerminalProviderConnection = {
  target: TerminalTarget;
  request(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  onFrame(callback: (value: Record<string, unknown>) => void): () => void;
  close(): void;
};
async function terminalProviderStatus(config: TerminalProviderConfig, runId: string): Promise<TerminalTarget>;
async function connectTerminalProvider(config: TerminalProviderConfig, target: TerminalTarget, scope: "read"|"write", binding: TerminalBinding): Promise<TerminalProviderConnection>;
```

Provider first frame is strict JSONL `{v:1,op:"status",token,runId}` or `{v:1,op:"connect",token,target,scope,binding}`. It is private IPC, never browser protocol. Connection responses/events use `{type:"ready",target}`, `{type:"response",id,result}` and `{type:"screen-*",...}` frames; requests use positive integer `id`, `type` from `acquire|release|input|resize`, plus exact per-action fields. The fixed client talks to `/run/pi-runtime/terminal.sock`, not a supplied path. No request selects command, pid, cwd, env or container.

Runtime control adds action `terminal-prepare`, with current child token/run/runtime/session identity. It returns success only after draining admitted chat mutations and latching a child-global terminal barrier. A read-only `terminal-state` action exposes identity and barrier liveness. A replacement adapter/identity fences current terminal writes until an explicit new authorization.

## Task 1: Reconcile experimental sources and reproducible dependencies

**Files:** Merge reviewed source/tests/docs from `origin/experiment/trusted-terminal-host-test` at `9e45efa`; resolve `hub/server.ts`, `src/web/src/core/store/connection-slice.ts`, `docs/development-log.md`; regenerate rather than manually merge dist. Modify `package.json`, lock, `hub/terminal-auth.ts`; test `tests/hub-terminal.test.ts`, `tests/hub-state-budget.test.ts` and existing math/terminal suites.

**Produces:** Experimental modules on current main, authentication using common state writer, reproducible imports; no production terminal claim.

- [ ] Record base, merge with `--no-commit --no-ff`, resolve source conflicts preserving main bounds; retain local AGENTS policy rather than executing remote operational instructions.
- [ ] First add/run a regression proving terminal auth cannot write beyond the shared persistent budget and competes with the same cross-process lock. Expected RED: experimental auth bypasses common lock/budget.
- [ ] Use `withStateWriter` for issue/unlock/revoke/logout updates; retain scope/expiry/single-use behavior. Do not automatically break stale locks.
- [ ] Reproduce clean lockfile imports in a temporary install, explicitly pin esbuild when used and resolve the Pi/codemode compatibility combination without silently mutating installed SDK code.

```bash
NODE_OPTIONS='' node --import ./tests/register-ts.mjs --test tests/hub-terminal.test.ts tests/terminal-lease.test.ts
NODE_OPTIONS='' npm run test:unit
```

- [ ] Run targeted/unit/types checks; document actual clean-install evidence. Build assets after source integration, then commit only reviewed changes.

## Task 2: Image-owned PTY runtime, fixed broker and local relay

**Files:** Create `runtime/terminal/supervisor.py`, `client.py`, `broker.ts`, `protocol.ts`; `tests/terminal-runtime.test.ts`, `tests/test_terminal_runtime.py`; build entry/config and dist source inventory. No fixture imports in production.

**Consumes:** Terminal target/input/lease/screen from Task 1. **Produces:** Executable fixed supervisor/broker/client with private `/run/pi-runtime/terminal.sock`, no arbitrary network destination.

- [ ] Add failing real-PTY tests: one child PID, output, exact input, resize, local ownership, Ctrl+] w/l/double-prefix, lease expiry, child/group signals, termios restore, fixed-client framing, bounded backpressure and cleanup.

```python
def test_remote_input_is_rejected_while_local_owns_terminal(self):
    with self.runtime() as runtime:
        response = runtime.acquire()
        self.assertEqual(response['error'], 'local_owns_input')
        self.assertEqual(runtime.child_input(), b'')
```

- [ ] Implement Python PTY/session/process-group and relay, strict fixed-image Node launch. No user-controlled executable path is accepted through terminal protocol. Keep the old supervisor untouched until launch wiring.
- [ ] Implement image-owned Node broker using production lease/screen modules; sink-side checks and independent revoke before successor grant; bound every queue, parser and pending operation. Require Task 3 barrier before granting any remote lease; fail closed while absent.
- [ ] Implement fixed client: absolute Python, isolated mode, socket fixed by image, bounded stdin/stdout; EOF closes helper/connection only. No arbitrary argv/path.
- [ ] Build self-contained JS under `dist/runtime`; include Python sources with build inventory; run real PTY tests using temporary workspace/HOME and synthetic child, then real isolated Pi.
- [ ] Commit runtime, tests and verified build plumbing after task review.

## Task 3: Child-global chat mutation barrier

**Files:** `extensions/runtime-control.ts`, new `extensions/terminal-barrier.ts`, `extensions/mirror-server.ts`, `extensions/runtime-metadata.ts`; `tests/runtime-control.test.ts`, new `tests/terminal-barrier.test.ts` and real mirror integration.

**Consumes:** Terminal profile environment and current run/runtime/session identity. **Produces:** `terminal-prepare` and `terminal-state` adapter actions; latch survives extension reload in same child.

- [ ] RED: admit a long-running chat mutation, request terminal prepare, prove lease is not granted while mutation remains; prove queued mutation cannot execute after barrier. Cover another browser and context replacement.

```ts
test("release and reload never restore writes after terminal takeover", async () => {
  const adapter = await realAdapter();
  await adapter.terminalPrepare();
  await adapter.reload();
  assert.equal((await adapter.prompt("must not execute")).error, "terminal_untracked");
});
```

- [ ] Implement exact read-only allowlist at central ingress plus execution-time checks for async admitted work; latch on child-global state, never clear stdin taint. Ensure HTTP and extension-command mutation paths are covered, not just WS.
- [ ] Add live adapter heartbeat/identity fencing for broker; no pending control grant survives session switch, reload, adapter loss or child exit.
- [ ] Ensure latestCtx/latestExecuteCtx are used in asynchronous callbacks; preserve pure mirror forwarding and no extension stdout/stderr.
- [ ] Verify ordinary inherited-tui behavior and managed runtime tests remain unchanged; commit after scoped review.

## Task 4: Gate terminal provider and refresh admission

**Files:** External `/home/fate/docker_files/pi-deploy-gate/gate/terminal_provider.py`, `terminal_contract.py`, engine/service integration, lifecycle/runtime update admission, provider tests and Compose; version-controlled provenance/patch under `docs/validation/`. Obtain external-write approval before mutation.

**Consumes:** Interface ledger + fixed runtime client. **Produces:** Disabled-by-default dedicated Unix provider socket/credentials/policy and verified narrow exec stream.

- [ ] RED: wrong token (including real lifecycle token), unknown image/profile, duplicate run, unsafe mount/entrypoint/loader, arbitrary command fields all produce no Docker exec; terminal profile rejects restart even if extension claims idle.

```python
def test_terminal_profile_cannot_refresh(self):
    result = self.lifecycle.request(self.terminal_target())
    self.assertEqual(result['reason'], 'terminal_profile_unaudited')
    self.assertEqual(self.engine.started_execs, [])
```

- [ ] Implement distinct policy/token/socket, strict bounded frames and connection counts; reuse trusted container checks without granting terminal authority to legacy lifecycle callers. Fixed client uses immutable container ID, fixed command/user/interpreter/environment.
- [ ] Implement bounded Docker multiplex stream transport, explicit close/revoke, reinspection/identity checks; timeout/stderr/malformed streams close without forwarding diagnostics or affecting Pi.
- [ ] Enforce refresh rejection in Gate and old/new supervisors; global install reports terminal consumers as manual-restart-required rather than polling forever or claiming refreshed.
- [ ] Run provider behavioral tests against controlled Docker boundary, then isolated real Docker; ordinary Gate deployment/lifecycle tests pass. Record external baseline and exact diff, commit repository evidence separately.

## Task 5: Product Hub provider client and independent terminal page

**Files:** `hub/terminal-provider.ts`, `hub/terminal-server.ts`, `hub/config.ts`, browser terminal entry/source, `hub/server.ts`, CLI pairing/help, tests `tests/hub-terminal*.test.ts`, real browser integration under `e2e/`.

**Consumes:** Task 4 private provider and Task 1 auth; no test-only transport imports. **Produces:** third-origin status/attach/WS/static terminal with explicit read/control/input UI.

- [ ] RED: absent provider keeps unavailable, valid real provider attaches; wrong Origin/CSRF/session/target/scope denied before output; 2s first-frame deadline and eight-pending cap hold.
- [ ] Implement private provider client using interface ledger, validate all responses/limits/identity. No provider credential to browser; each action and stream checks current authorization and fences provider on revoke.
- [ ] Implement fixed terminal assets using pinned xterm, disableStdin and explicit draft/key controls; no automatic connection/retry/renewal, multiline confirmation, IME explicit-send, hidden/release/disconnect unknown semantics.
- [ ] Attach nonce is short-lived/session-bound; at most two readers and one writer; serialize/chunk snapshots with one 1MiB assembly, 256KiB outbound queue and no stale ANSI-tail recovery.
- [ ] Add nonprivileged chat link plus read-only explanation, no iframe or shared cookies/CORS. Keep terminal static assets separate from chat Service Worker.
- [ ] Run desktop/mobile screenshot checks, actual browser + production provider/runtime tests; exact current-session identity across resume/reload and no auto-retarget. Commit reviewed source and rebuilt assets.

## Task 6: Centralized pirun/Compose/image wiring and isolated deployment test

**Files:** External pi-docker `scripts/pi-pirun`, `scripts/pi-dockerctl`, `pi-entrypoint`, `Dockerfile`, Compose overlays, tests/help; repository `docs/trusted-terminal.md` and external patch provenance.

**Consumes:** Tasks 2–5. **Produces:** `PI_PIRUN_WEB_TERMINAL=on pirun`, optional `PI_PIRUN_WEB_TERMINAL_CONTROL=remote`, verified immutable runtime image and no live cutover.

- [ ] RED: ordinary launcher args remain identical; terminal mode missing TTY/Hub/provider/image capability fails before container launch; invalid owner rejected; maintenance/RPC does not silently enable terminal.
- [ ] Add explicit environment/label/profile preflight and fixed entrypoint dispatch. Never source `.env`. Copy verified runtime assets into root-owned image path; do not reuse mutable extension installation as broker.
- [ ] Add dedicated provider IPC/credential mounts only to Gate/Hub, no Docker/private provider mounts to Pi. Preserve volumes, node UID, security options and normal compose lifecycle.
- [ ] Build separate test tags, create disposable temporary project/HOME/state, launch actual new terminal Pi. Verify same PID, dialog refusal/confirmation and custom panel navigation through Hub, local/remote handoff and exit cleanup; do not stop existing services.
- [ ] Record exact host changes and rollback instructions; help clearly names new mode and restrictions. Commit repository artifacts, leave external active service configuration disabled unless separately authorized.

## Task 7: Whole-branch verification and integration

**Files:** `docs/validation/2026-10-21-trusted-terminal-runtime.md`, `docs/development-log.md`, package dist/build manifest, final implementation ledger.

- [ ] Run targeted Node/Python security/resource suites and main bounded-state/history regressions; both TypeScript configs; Biome; complete unit suite; production build and `verify:dist`; clean production Git install regression.
- [ ] Run real Browser→Hub→Gate provider→new Pi path with synthetic dialogs/custom side effects. No personal token/model API required; never count fixture-only success as production integration.
- [ ] Exercise revocation/expiry/two tabs/local reclaim/unknown delivery, output floods/slow peers/1MiB snapshot bounds, shutdown signals, termios restore, no orphan child/helper/socket and default-disabled behavior.
- [ ] Independent task and whole-branch review; fix critical/important findings and rerun covering tests. Summarize actual counts, skip reasons and real-device/public-gateway items not tested.
- [ ] Merge main only after all acceptance gates pass; preserve unrelated changes. Push only the approved integration, not experimental incomplete runtime. Public deployment/service restart is a separate handoff.

## Execution recording

Record task start/base, red/green commands, changed paths, commits, reviewer findings, rulings, and incomplete requirements in this plan's SDD ledger. Never mark a task complete solely because code compiles or an implementer says DONE. If external permissions or public deployment remain unavailable, retain a safe disabled implementation and report the exact outstanding acceptance gates; do not merge unfinished production claims.
