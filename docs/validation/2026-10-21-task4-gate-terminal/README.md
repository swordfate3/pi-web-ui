# Task 4 — default-disabled Gate terminal provider

Date: 2026-10-21. Task-scoped implementation/validation, not deployment or end-to-end product approval.

Repository implementation base: `b3634096bd5b5a2e9c22122ed0b5821eefb59bcf`. Controller clarification `cae83e382e8745715a8c9663b2639fe97a27cee4` changed only design/plan: terminal-profile Docker logging must be disabled. The review range from b363409 through the evidence commit includes that controller-owned clarification; this evidence commit owns only this directory. No repository product source/build changed in Task4, so no redundant web build/package run was performed.

## Reproducibility and scope

- `host-source.patch`: exact unified diff of 15 source/config/test files relative to the preserved source-only host baseline; nine modified originals and six new files. Apply from the parent of `pi-deploy-gate` and `pi-docker` with strip level1, after checking all before hashes. Do not apply to a deployed system without its separate rollout authority.
- `provenance.json`: exact host paths, original/new SHA256, patch SHA256, authorized immutable test base and successful disposable image identity. `before_sha256:null` means a new file, not an omitted original. Original copies remain in the ignored controller SDD `host-baseline` directory, never reconstructed from edits.
- `test-evidence.txt`: actual logs, including failures and the diagnostic that explains them. No credentials or terminal content are logged.
- All external direct edits used permission-aware escalated `apply_patch`. No production policy/state/token/volume changes, production image retags, deployments, broad cleanup, push, worktrees or subagents. The unrelated host-review report and recovery stash are excluded.

## Final verification

| Check | Actual result |
| --- | --- |
| Gate terminal admission + global inventory | Behavioral RED2/2, GREEN2/2 before pause; included in final full suite |
| Independent old supervisor refusal | Behavioral RED1/1, GREEN1/1 before pause; source unchanged since |
| Provider transport | Initial module absence/setup race distinguished from real RED; default-closed provider then failed four readiness assertions; GREEN9/9 |
| Service/configuration + expanded boundaries | RED2/15; GREEN15/15 |
| Terminal-only Docker logging refusal | RED allowed json-file; GREEN1/1 rejects json-file/local/missing/default logging before exec |
| Final focused provider | 23/23, 16.115s |
| Single final full Gate suite | 358/358, 78.327s, exit0; no warnings/failures in log |
| Isolated actual Docker | Image-build, volume/group/socket/token metadata, UID1000 read-only mount access, UID1001 denial, fixed helper/broker/supervisor/PT​Y traffic, close without runtime termination: passed |
| Baseline patch dry-run | All15 files passed |

Gate command: `env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests`. Focused provider command adds `-p test_terminal_provider.py`; logging-only adds `-k content_logging`. Old-supervisor command from pi-docker: `env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p test_pi_supervisor.py -k test_terminal_profile`.

Actual Docker command from Gate: `env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 tests/docker_terminal_provider.py`. It builds from cached immutable base `sha256:1a23ab4104c1d806a9cd2370f508ed04d83ea79c48ebdf9da8d99ae904cebae8`, no network/package download. Each invocation owns unique labelled test containers, two disposable IPC volumes and a test-only tag; exact cleanup runs on success and failure. The fixture copies the actual Gate Dockerfile (changing only its base to the authorized digest), Gate source and current bundled Task2 runtime into a sanitized context with no production policy/secrets. Synthetic child/adapter and metadata probes are image-owned test fixtures.

The first real-Docker attempt passed permission checks but never reached runtime ready. A second diagnostic isolated rejection of inherited PATH `/opt/huggingface/bin:/home/node/.local/bin:...`. The final attempt set the canonical PATH in the disposable launch, retained the strict production rule, and passed. Logs preserve both failures; no failure is hidden as a green result.

## Private configuration and narrow mounts — Task5 / Task6

Default image file `/app/terminal-policy.json` is exactly `{"enabled":false,"images":[]}`. The service accepts trusted startup option `--terminal-policy`; schema is closed `{enabled:boolean,images:string[]}`. At most64 immutable `sha256:` plus64-lowercase-hex image IDs; enabling requires a nonempty allowlist. This policy is distinct from deploy/lifecycle/runtime-update authorization, with no terminal enabling shortcut on their APIs. Enabled configuration is frozen for this provider instance; close/restart is required for revocation/configuration replacement. No runtime CAP_CHOWN/CAP_SETUID is added.

| Purpose | Gate path | Ownership/mode | Source-only Compose volume |
| --- | --- | --- | --- |
| IPC parent | `/run/pi-terminal-provider` | UID0:GID1000 /2770, created in image | `terminal-ipc`, explicit name `pi-terminal-provider-ipc` |
| Socket | `/run/pi-terminal-provider/provider.sock` | UID0:GID1000 /0660 | same dedicated IPC volume |
| Credential parent | `/run/pi-terminal-credentials` | UID0:GID1000 /2770, created in image | `terminal-credentials`, explicit name `pi-terminal-provider-credentials` |
| Token | `/run/pi-terminal-credentials/provider.token` | UID0:GID1000 /0640, regular single-link file | same dedicated credential volume |

Image-owned setgid parents provide GID1000 inheritance under Gate UID0:GID0 with cap-drop ALL. Existing metadata is validated, never repaired with runtime chown. Token is64 lowercase hex bytes with no newline; generated on enabled startup only. Disabled startup creates no token/socket. Gate retains a separate0600 lock in its IPC directory; it is not a Hub credential.

Task5's Hub UID1000 mounts only the **two dedicated volumes read-only** at those paths (or equivalent trusted config paths). It never mounts `/state`, whole Gate directories or the Docker socket. Pi receives neither volume nor token. Task5 must add a **narrow provider-token reader** validating this exact root:GID1000/0640 single-link regular file and trusted non-symlink parent; do not globally weaken existing private-state0600 readers. Volume directory mounts must be read-only on Hub; no copy-up from Hub, no production volume reuse during tests.

Task6 launch/admission requirements:

- Terminal role requires an allowlisted immutable image ID; unique running container for runId across all run-labelled candidates; immutable64-hex container ID; exact `User:"1000:1000"`, entrypoint `[/usr/local/bin/pi-entrypoint]`; safe capabilities/security options/mounts/local-volume metadata, inherited from shared container checks.
- Exact label `cn.swordfate.pi.runtime-profile=web-terminal-v1`, `PI_RUNTIME_PROFILE=web-terminal-v1`, and matching `PI_RUNTIME_RUN_ID`; duplicate environment names are refused. Unknown image/profile/entrypoint, protected-code/authority mounts and loader overrides fail before helper exec. Node options/path and shell loader variables are refused; existing LD/Python checks remain.
- If PATH is present, it must equal `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. The cached base inherits a broader PATH, so Task6 must explicitly set the canonical PATH and use an image-owned absolute Pi launch path where necessary. The fixed helper command is absolute regardless of PATH.
- **Terminal `HostConfig.LogConfig.Type` must equal `none`** (launcher `--log-driver=none`). Missing/default/json-file/local drivers are refused independently by Gate before exec and during stream reinspection. This applies to terminal-role inventory as well. Ordinary lifecycle role remains unchanged. Provider/broker log suppression alone cannot protect the supervisor's raw stdout/TTY; the Docker driver rule is mandatory.
- Lifecycle labels/idle claims do not grant restart authority to terminal containers. Gate restart and old supervisor refuse independently with `terminal_profile_unaudited`. Task2's new supervisor has one child/no restart endpoint and remains unchanged.

## Exact private provider wire — Task5

UTF-8 JSON objects followed by LF, maximum65,536 bytes **including LF**. Duplicate keys, nonfinite JSON, malformed UTF-8, non-object frames, surplus/unknown fields and invalid IDs fail closed. No browser frame carries provider credentials. Private first frame is exactly one of:

```typescript
{ v: 1, op: "status", token: providerCredential, runId }
{ v: 1, op: "connect", token: providerCredential, target, scope: "read" | "write", binding }

type Target = {
  v: 1; runId: string; runtimeId: string; sessionId: string; terminalEpoch: string;
  profile: "web-terminal-v1";
  inputState: "local" | "none" | "remote" | "fenced";
  managedRestartEligible: false;
};
type Binding = { authorizationId: string; connectionId: string };
```

runId, terminalEpoch, authorizationId and connectionId are32 lowercase hex. runtimeId/sessionId are1..256 Unicode characters excluding control/surrogate characters. Gate authenticates against its separate token **before any Docker request**, then removes `token`; runtime receives the unchanged Task2 first frame without it. Deployment/lifecycle/runtime-update tokens do not authorize this socket. No request chooses an executable, argv, cwd, PID, container identifier/name, environment or socket destination.

Successful status/connect starts with `{type:"ready",target}`. Status then closes. Connect accepts only the existing Task2 requests, with positive safe-integer strictly increasing `id`:

```typescript
{ id, type: "acquire" }
{ id, type: "release" }
{ id, v: 1, type: "input", terminalEpoch, leaseId, sequence, data }
{ id, type: "resize", leaseId, columns, rows }
```

Read scope is streaming only: it cannot acquire/release/input/resize. Input text is nonempty valid UTF-8, at most8,192 bytes; sequence is a positive safe integer, with exact lease sequencing enforced by the broker. leaseId is32 lowercase hex. Size is integer columns20..240, rows5..120. Gate permits at most64 pending requests; results must correlate to a pending request/action. Broker owns leases, adapter preparation, 30-second expiry and final write authority; Gate does not invent them or retry actions.

Responses remain `{type:"response",id,result}`:

- Acquire: `{ok:true,leaseId,expiresInMs:30000}` or `{ok:false,error:"local_owns_input"|"control_unavailable"}`.
- Release: `{ok:true}`.
- Input: `{ok:true,delivery:"written"}`, `{ok:false,delivery:"rejected",error:"input_rejected"}`, or `{ok:false,delivery:"unknown",error:"input_delivery_unknown"}`.
- Resize: `{ok:true}`, `{ok:false}`, or `{ok:false,error:"resize_rejected"|"resize_unknown"}`.

Screen envelopes are unchanged: `{type:"screen-start",target,sequence,columns,rows,bytes,chunks}`, `{type:"screen-chunk",terminalEpoch,sequence,index,data}`, `{type:"screen-end",terminalEpoch,sequence}`, `{type:"screen-unavailable"}`. Snapshot is at most1MiB, chunks at most20,480 decoded bytes, canonical base64 and ordered counts/identity; no raw ANSI output forwarding. Hub must assemble and validate whole snapshots as required by Task2, not append raw chunks to a terminal stream.

Only the fixed broker error `{type:"error",error:"terminal_backend_unavailable"}` may be forwarded before readiness. Other auth/trust/schema/stream/deadline failures produce EOF/reset with **no diagnostic payload**. Hub must map closed/unavailable transport to unavailable; missing input ACK is unknown and must not trigger retry. Gate never generates ready without actual helper output.

## Fixed exec and limits

Exec uses immutable inspected container ID, `User:"1000:1000"`, `Privileged:false`, `Tty:false`, stdin/stdout/stderr attached, fixed `WorkingDir:"/"`, and exactly:

```text
/usr/bin/python3 -I /usr/local/lib/pi-runtime/terminal/client.py
```

No extra arguments. Fixed exec overrides: canonical PATH above, `PYTHONNOUSERSITE=1`, `PYTHONSAFEPATH=1`, `PYTHONDONTWRITEBYTECODE=1`. Container loader/env checks additionally guard inherited variables. Helper connects only to `/run/pi-runtime/terminal.sock`; provider token is absent from argv, env and stdin.

- Dedicated Unix listener and bounded transport; no extension of the legacy16KiB buffered lifecycle RPC and no generic exec proxy.
- Global8 accepted peers (including handshakes/status), at most2 connected readers per run including writer, at most1 writer; active connectionId is unique. Admission is bounded before thread dispatch at the listener and before helper creation.
- First peer frame deadline2s; runtime readiness, partial frames and queued batches each have2s loop deadlines. Duplex queues cap256KiB each; read blocks cap32KiB. Each Docker stdout multiplex payload caps64KiB, exact8-byte header, zero reserved bytes, stdout only; stderr/invalid/truncated frames close with no forwarded diagnostics. HTTP upgrade header caps8KiB with a3s absolute Engine budget.
- Overall connection cap300s. No automatic reconnect/reacquire/input resend. Task5 must treat expiry/close as loss of connection/authority, not continued readiness.
- Full immutable identity/safety reinspection before create, between create/start, and periodically every0.5s while streaming; target hash includes ID/image/config/host config/full normalized mounts/StartedAt. Each inspection has a bounded4s budget; synchronous inspection can extend observation of loop deadlines by that bounded duration. Failure/change closes the helper without signalling Pi.
- `close()` revokes this provider's connections; Hub revokes individual authority by closing its connection. EOF/disconnect is not a release/command-success ACK. No terminal-content or credential diagnostics are emitted.

## Public runtime-update additions — Task5 decoder/UI follow-up

Existing ordinary statuses are unchanged. Add exactly:

| Location | Added value/field |
| --- | --- |
| Job `status` | `manual_restart_required` — terminal/non-active outcome |
| Job `stage` | `installed_manual_restart_required` |
| Target `status` | `manual_restart_required` |
| Target optional `profile` | `web-terminal-v1` |
| Target `wait_reason` | `terminal_profile_unaudited` |

Terminal target retains `run_id` but deliberately omits `old_version`, `version`, and `restart_id`. The explicit internal inventory marker is **not** adapter state/version proof. Installation proceeds normally; terminal consumers never poll nonexistent legacy `control.sock`, never stay `state=None` waiting forever, and never count as refreshed. A mixed rollout may remain running for ordinary busy consumers; once all are succeeded/exited/manual-restart-required, manual restarts produce the terminal outcome above. UI wording must distinguish installed shared version from still-running child version, which is unknown here.

## Evidence limits and remaining cross-task gates

The actual Docker PTY child/adapter is synthetic, using the real bundled runtime and production Gate transport. Permission tests use separate isolated Gate/probe containers; this is not the product Hub client/browser path or a real Pi session. Same running container/runtime remains after helper close; Task2 supplies single-child/no-respawn guarantees. No real user/model credentials or production Pi/Hub volumes were used. No live deployment/configuration/rollout occurred; provider remains disabled by default.

Task3 startup-read-only browser contract and six-field adapter latch remain unchanged. SDK completion correlation is not solved by Task4. Task5 still must implement its dedicated provider client, strict credential reader, public update statuses and separate startup-read-only display indicator. Task6 still must install all trusted runtime artifacts together and enforce launch/log/PATH requirements. Full Browser→Hub→Gate→real Pi, installed-image trust, packaging/system interaction and deployment gates remain with Tasks5–7/controller. Independent review has not been substituted by implementer self-review.
