# Task 2 — Gate lifecycle authorization and execution

Read this first — requirements and exact interface values below are binding.

Write scope ONLY `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate` and report `docs/validation/managed-restart-task2-report.md` in pi-web-ui. Do not touch production `/home/fate/docker_files`, git, live services, real credentials, or other worker files. No child agents. Use apply_patch and TDD.

## Goal

Implement a separate lifecycle API for restarting the Pi child, NEVER Docker restart or arbitrary exec. Existing image/commit deploy behavior remains unchanged. Default disabled; host administrator may explicitly enable manual/auto with image digest allowlist. Do not inherit Hub deploy auto.

## HTTP contract

New private lifecycle token (64 lowercase hex), persisted0600 in Gate private state. Not existing request.token. Auth only these routes; lifecycle token cannot reach admin or ordinary deployment APIs; ordinary token cannot reach lifecycle:

- GET `/v1/pi-lifecycle/runs/<run_id>` -> direct sanitized target.
- POST `/v1/pi-lifecycle/restarts` exact `{run_id,runtime_id,session_id,leaf_id,idempotency_key}` -> direct job.
- GET `/v1/pi-lifecycle/restarts/<id>` -> direct job.

IDs run_id/idempotency_key/operation_id/id are lowercase32hex. runtime/session/leaf strings bounded256, nonempty, no controls; leaf nullable. Job `id` MUST equal idempotency_key. Same key different identity rejected. Response job `{id,run_id,status,stage,...safe identities and versions}`; statuses pending/queued/running/succeeded/failed/recovery_required/rejected/stale. stage lowercase underscores<=64. Safe fields runtime_id,session_id,leaf_id,old_runtime_id,new_runtime_id,old_version,expected_version,new_version. No container IDs, paths, output, secrets. Target `{managed:true,run_id,runtime_id,session_id,leaf_id,version,idle,pending,busy,mode}` or `{managed:false}`. Errors generic.

## Trusted target + fixed control

Use Engine list/filter+inspect to resolve exactly one running container, NOT body-provided name/path. Exact label `cn.swordfate.pi.run-id=<run_id>` and `cn.swordfate.pi.lifecycle=1`. Image ID `sha256:<64hex>` must be in independent policy images. Trusted launcher entrypoint `/usr/local/bin/pi-entrypoint`, runtime wrapper `/usr/local/lib/pi-runtime/pi_supervisor.py` is internally called by entrypoint. Docker config must remain uid/gid1000, cap-drop ALL, no-new-privileges, no privileged, no extra caps, no Docker socket or control authority mounts. Reject ambiguous/forged/stale target. Use policy snapshot plus immutable Docker ID to fence execution. Validate target again immediately before fixed exec.

Only executable `/usr/local/bin/pi-session-control`; exact argv `["/usr/local/bin/pi-session-control","--request",JSON]`. Docker exec must run as uid/gid1000, no shell, no TTY/stdin, bounded timeout/output (16KiB JSON), parse raw Docker multiplex stream and inspect exit code. No configurable argv or shell.

Control request `{action:"status"}` -> `{ok:true,result:{managed:true,run_id,runtime_id,session_id,leaf_id,version,idle,pending,busy,operation?}}`.
Restart request `{action:"restart",run_id,runtime_id,session_id,leaf_id,operation_id}` -> `{ok:true,result:{operation_id,status,stage}}` promptly. Poll status.result.operation. Operation statuses running/succeeded/failed/recovery_required, final `{old_runtime_id,new_runtime_id,session_id,leaf_id,old_version,expected_version,new_version}`. Initial expected runtime/session/leaf must match status, idle=true,pending=false,busy=false. Final requires exact original session/leaf, changed runtime, new_version=expected_version; otherwise recovery_required/failed, not false success.

Use dedicated SQLite tables in existing jobs.sqlite3 with Store RLock. Policy `{mode:"disabled"|"manual"|"auto",images:["sha256:<64hex>"]}` independent persisted generation/hash. At most one active same-run. Exclude lifecycle executions from ALL image deploy/manual approve/rollback/upgrade worker paths using shared lock/admission check. Failure/recovery_required must block overlapping work until host inspection. Policy changes fence queued/start, cannot retroactively authorize. On Gate crash reconcile by status query only, never repeat restart; store intent BEFORE exec. Unknown outcome = recovery_required. No SIGKILL, container restart, npm update or retry stop. Supervisor deadlines are stop30/start120 seconds; corrected Gate total is210 seconds under `managed-restart-timing-ruling.md`, superseding the original155s. Health/status API must stay responsive.

## Admin and help

Host-only policy/query/approve/reject via existing admin socket + gatectl, offline --help docs. Explicit lifecycle resolve if needed for recovery, must not erase unknown outcome silently. Provision lifecycle token via explicit admin export captured to a0600 file, never print it in regular status/help. Export can be a private internal admin endpoint if gatectl safely writes0600 chosen host destination; reject unsafe overwrite. Do not execute export against live service. Gate image/router commands and CLI backward compatible. Upgrade/status active guards include lifecycle work.

## Tests

First write tests/test_lifecycle.py; run `/usr/bin/python3 -m unittest discover -s tests -p test_lifecycle.py -v` RED for missing implementation. Use temporary SQLite and precise fake Engine, never real Docker. Cover disabled/manual/auto, auth token separation HTTP, image+label+runtime config rejection, stale identities, idempotency and conflicts, deploy exclusion, policy changes, operation mismatch, recovery without replay, malformed input/oversize and fixed Engine exec framing. Then implement minimal code and run focused GREEN plus full Gate suite. No tests that merely assert source strings for key security behavior.

## Report

Write full report to `/home/fate/gitproject/codex_project_v2/pi-web-ui/docs/validation/managed-restart-task2-report.md`: touched files, RED/GREEN commands/output totals, exact admin usage, interface decisions, unverified items/concerns. Return concise DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED, one-line tests, paths. No commits, production edits, privilege enable or deploy.
