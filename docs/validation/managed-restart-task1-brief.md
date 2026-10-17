# Managed Pi restart implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Apply an already installed Pi update from the Hub while retaining the container, exact saved conversation and terminal.

**Architecture:** Hub delegates to an independently authorized Gate lifecycle API. Gate verifies an enrolled, image-allowlisted container and calls one fixed in-container control client. A non-root supervisor owns the Pi child and restarts it once after an idle snapshot and graceful exit; Hub validates its exact successor.

**Tech Stack:** Python3 standard library, SQLite, Node/TypeScript, existing Hub HTML/JS, real Pi and Docker integration tests.

**Spec:** `docs/superpowers/specs/2026-10-17-managed-pi-restart-design.md` (user approved).

## Global constraints

- Existing live Hub/Pi and remote Caddy/tunnel stay untouched during development.
- UID/GID 1000, cap-drop ALL, no-new-privileges, existing named volumes unchanged.
- No Docker socket or administrator token in ordinary Pi or Hub; Hub gets a lifecycle-request-only token.
- Only saved idle TUI conversations initially. Never force-kill, replay a message, resume latest, or automatically retry a failed restart.
- Graceful stop deadline 30 seconds; new-process readiness deadline 120 seconds.
- No .env reading, project copies of credentials, stdout/stderr from extension code, arbitrary shell or browser-provided executable/paths.
- Host source edits first staged in `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work`, then installed into the existing docker_files directories only after tests and scoped backup.
- Work on existing dedicated `codex/pi-runtime-restart` branch. No additional worktree or production service migration is needed to edit/test these sources.

## Frozen cross-component protocol

All IPC JSON is newline-delimited and bounded at 16 KiB; public HTTP requests at 8 KiB. Errors are generic. IDs: run_id/operation_id/idempotency_key are lowercase 32 hex; runtime_id/session_id/leaf_id are bounded non-control strings (leaf may be null).

Supervisor environment: `PI_RUNTIME_RUN_ID` (Hub run), `PI_RUNTIME_DIR` defaults `/run/pi-runtime`. It spawns the child with `PI_RUNTIME_CHILD_TOKEN` (64 hex), `PI_RUNTIME_EXTENSION_SOCKET=<runtimeDir>/extension.sock`, `PI_RUNTIME_CONTROL_SOCKET=<runtimeDir>/control.sock`. Private runtime is not shared among containers. Fixed Gate executable is `/usr/local/bin/pi-session-control`.

Extension socket requests: `{action:"snapshot"|"prepare"|"cancel",token,operation_id?,expected?:{runtime_id,session_id,leaf_id}}`. Responses: `{ok:true,result:Snapshot}` or `{ok:false,error:"..."}`. `prepare` freezes inputs and snapshots accurate local identity; `cancel` clears only its matching operation. `Snapshot` uses snake_case: `{run_id,runtime_id,session_id,leaf_id,session_file,cwd,version,idle,pending,busy,provider,model,thinking}`. `session_file` and cwd never reach public APIs. A missing file/ctx, pending agent work or any current mutation is not ready. `version` comes from cached SDK VERSION, not a later disk read.

Control client: `/usr/local/bin/pi-session-control --request JSON`; `action` is `status` or `restart`. Status result: `{managed:true,run_id,runtime_id,session_id,leaf_id,version,idle,pending,busy,operation?}`. Restart request additionally includes `{run_id,runtime_id,session_id,leaf_id,operation_id}` and accepts exactly that current identity. Returns `{operation_id,status,stage}` promptly; status polls include the operation. Statuses `running|succeeded|failed|recovery_required`, stages `checking|prepared|stopping|starting|verifying|complete|...`. Final operation includes `old_runtime_id,new_runtime_id,session_id,leaf_id,old_version,expected_version,new_version` when known. A readiness mismatch fails; normal exit must exit supervisor. Run identification in Docker label `cn.swordfate.pi.run-id`, capability label `cn.swordfate.pi.lifecycle=1`.

Gate lifecycle HTTP (request-only distinct token): GET `/v1/pi-lifecycle/runs/<run_id>` → sanitized target status; POST `/v1/pi-lifecycle/restarts` exact `{run_id,runtime_id,session_id,leaf_id,idempotency_key}` → job; GET `/v1/pi-lifecycle/restarts/<id>` → job. Job has `{id,run_id,status,stage,...safe versions and identities}`. Pending/manual status allowed. Dedicated tables in the existing jobs.sqlite3 keep immutable policy/target identity. Administrator lifecycle policy `{mode:"disabled"|"manual"|"auto",images:["sha256:<64hex>"]}` defaults disabled; image identity and exact labels/entrypoint/runtime restrictions are checked server-side. Gate calls only fixed control argv, never Docker restart. Reconciliation queries operation status and never repeats a stop.

Hub optional configuration `lifecycle:{endpoint:"http://127.0.0.1:16182",credentialFile:"/private/lifecycle.json"}`. File `{token:<64hex>}` is Hub-private, not the ordinary request token. No provider → safe unsupported UI. Pairing code generated by trusted `pi-web-hub pair --config FILE`, 10-minute lifetime, consumed once, max 10 failed tries. Short-lived management cookie, CSRF header and same-origin required for writes. Public management routes under `/api/management/`: `status`, `unlock`, `logout`, `targets/<generation>`, `restarts` and `restarts/<id>`. No token printed by server or UI. Browser submits generation + expected identity + idempotency key, never container IDs/commands/paths.

Registration optional `runtime` object `{runtimeId,sessionId,leafId,version,managed}`; old clients omit it. It is identity metadata, not authorization. A successful restart resolves only to the exact run + new runtime + original session and leaf. A 120-second managed restart wait is independent from ordinary 15-second handoff. Gate stays authority for execution; Hub stays authority for verified live registration.

### Task 1: Supervisor, fixed control client and pirun wiring

**Files:** staged pi-docker `runtime/pi_supervisor.py`, `runtime/pi-session-control`, `tests/test_pi_supervisor.py`; modify Dockerfile, pi-entrypoint, scripts/pi-pirun. Source deployment destination remains docker_files/pi-docker.

**Interfaces:** consume frozen extension socket contract; produce frozen control client contract and labels. No writes outside staging.

- [ ] Add subprocess tests for normal exit (once only), idle restart preserving exact session/leaf, stale identity, busy refusal, timeout without kill, failed new version, argv metacharacters and no replay.
- [ ] RED: `/usr/bin/python3 -m unittest discover -s tests -p test_pi_supervisor.py -v` must fail because runtime is missing.
- [ ] Implement supervisor with inherited terminal, fixed executable control, private sockets, bounded requests, single owned child/operation, stable run id, graceful SIGTERM, exact saved session argv and verification. Re-run the focused tests.
- [ ] Wire startup only for normal managed interactive calls. Pass run id and labels from trusted launcher; old flags/install/RPC paths stay unchanged. Run existing pirun and entrypoint tests.
- [ ] Report RED/GREEN output and touched files; no real Docker restart, no service installation or git operations.
