# Managed Pi restart Task 1 review

Date: 2026-10-17

## Verdict

- **Specification compliance: FAIL.** The implementation satisfies many of the process-isolation and lifecycle invariants, but it does not reliably satisfy the binding “no replay” rule, and the synchronous control path can continue into a real restart after the fixed client has already reported a generic rejection.
- **Code quality/security: FAIL — changes required before integration.** The code is generally small, readable and defensive, but the two High findings below are unsafe lifecycle behavior and are not approval-level edge cases.
- **Scope discipline: PASS.** This review was limited to Task 1 staged `pi-docker` sources, the Task 1 brief/report/review diff, and the Task 1 portions of the referenced approved design. Hub implementation was not reviewed.

I did not modify source code, run Git, start child agents, rerun the reported test suites, install anything, or restart a live Pi/Hub/container. The existing report's `51 tests / 48 passed / 3 skipped / 0 failed` result was treated as supplied evidence, not independently rerun evidence.

## Binding-requirement summary

| Requirement | Verdict | Evidence / qualification |
| --- | --- | --- |
| UID/GID 1000, non-root, existing restrictions | PASS | `Dockerfile:50`, `compose.yaml:9-17`; runtime files are installed under image-owned `/usr/local`, while `/run/pi-runtime` is owned by `node`. |
| Gate invokes one fixed control executable/argv surface | PASS | `runtime/pi-session-control:20-35` accepts only `--request` and always selects `<PI_RUNTIME_DIR>/control.sock`; there is no command, executable or socket CLI override. |
| Child inherits the existing terminal | PASS | `runtime/pi_supervisor.py:205-210` launches without redirected stdin/stdout/stderr or a PTY wrapper. |
| Exact run/runtime/session/leaf/version successor | PASS for the implemented identity checks | Fresh extension snapshots are bound to `run_id`; restart acceptance checks runtime/session/leaf; success requires a new runtime plus the same session, leaf, session file, cwd and preflight version (`runtime/pi_supervisor.py:302-326`, `421-451`). This does not cure the replay defect below. |
| Graceful stop 30 seconds; readiness 120 seconds | PASS | Defaults are fixed at `30.0` and `120.0` (`runtime/pi_supervisor.py:24-25`); the production entrypoint does not override them. |
| No SIGKILL, no automatic retry/crash loop | PASS | Managed stop sends one SIGTERM and timeout becomes `recovery_required`; ordinary child exit is returned rather than respawned (`runtime/pi_supervisor.py:394-458`, `506-522`). |
| No user-message/tool replay | **FAIL** | Finding 2. |
| Legacy install/update/help/version/print/RPC calls remain direct | **FAIL** for valid reordered forms and delimiter handling | Finding 4. |
| Model configuration synchronized for the successor | **FAIL** | Finding 3. |
| Restart request returns promptly and remains safely observable | **FAIL** | Finding 1. |
| No live deployment/edit/restart in this task | PASS based on staged paths and supplied report | Reviewed changes are under `pi-runtime-restart-work/pi-docker`; this review made no live change. |

## Findings

### 1. High — the control client can report rejection while the supervisor continues and restarts Pi

Files/lines:

- `pi-runtime-restart-work/pi-docker/runtime/pi-session-control:32-35,50-53`
- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:266-285,302-326,334-381,469-488`

The fixed client has a three-second socket timeout. The supervisor handles a restart synchronously on its single control-server thread: it requests a snapshot, runs `pi --version` with a timeout of up to ten seconds, sends `prepare`, and only then records/returns the operation. Consequently, a slow executable/version read or extension response can exceed the client's three-second timeout. The client then prints `{"ok":false,"error":"request rejected"}` and exits nonzero, but the supervisor does not observe that disconnect as cancellation: it can finish validation, set `self.operation`, launch `perform_restart`, send SIGTERM to the current Pi and start the successor.

This violates the frozen requirement that restart submission return `{operation_id,status,stage}` promptly. More importantly, it creates an unsafe acknowledgement boundary: the caller can be told the request failed even though the destructive lifecycle action proceeds. Because the control server is single-threaded, status polling is also unavailable while this synchronous check is blocked.

Required change:

- Atomically validate only the bounded request shape/identity needed to reserve the operation, record a `running/checking` operation, and return promptly before slow extension/version work.
- Perform snapshot, version preflight, `prepare`, stopping, starting and verification in the operation worker; expose each stage through status.
- Define a safe terminal result for checking/prepare rejection without touching the child.
- Add a regression test with a deliberately slow `--version` path longer than three seconds. It must prove that the submitter receives an accepted operation promptly, status remains queryable, and no restart occurs after a client-visible rejection/timeout.

### 2. High — restart argv reconstruction can replay the original user prompt

Files/lines:

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:38-52,111-149`
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py:275-320`

For every unrecognized long option, `restart_argv()` assumes that the next non-option/non-`@` token is that option's value and copies both tokens. That assumption is false for legitimate Pi boolean options not listed in `VALUE_FLAGS` or `DROP_FLAGS`, including current core flags such as `--offline`, `--verbose`, `--no-tools`, `--no-builtin-tools`, `--no-mcp`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, `--approve`, and `--no-approve`.

For example, an original interactive launch equivalent to:

```text
pi --offline "original user message"
```

is reconstructed with both `--offline` and `"original user message"`, followed by the restored provider/model/thinking/session arguments. Pi still parses that copied token as an initial message, so the successor replays it. The same ambiguity applies to extension-defined boolean flags. The existing metacharacter test actually locks in the unsafe heuristic by requiring an unknown `--custom-option` and its following token to be preserved; it does not test a boolean option followed by a prompt.

This directly violates the binding “no replay” requirement and can repeat a message or tool-triggering instruction in the restored session.

Required change:

- Replace arity guessing with an explicit, reviewed allowlist of safe core options and exact arity.
- Never copy positional messages, `@file` inputs, or a token merely because it follows an unknown long flag.
- If extension-defined flags cannot be represented unambiguously by the frozen snapshot contract, reject managed restart for that launch shape rather than guessing. A future protocol extension could carry extension-produced sanitized restart options.
- Normalize or explicitly reject selector-like `--name=value` forms so future parser/extension changes cannot retain a conflicting continue/resume/session/fork selector.
- Add tests for every supported boolean option followed by a positional prompt, an `@file`, `--` followed by prompt text, and an extension-defined boolean flag. Every successor argv must contain no original message/file input.

### 3. Medium — the successor bypasses the required model-configuration synchronization

Files/lines:

- `pi-runtime-restart-work/pi-docker/pi-entrypoint:7-61,80-84`
- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:413-419`

`sync_models_config` runs once in the entrypoint before the initial supervisor/child starts. During managed restart, the supervisor directly spawns the successor and never re-enters the entrypoint or invokes an equivalent fixed synchronization step. This misses the approved design requirement to synchronize model configuration before launching the new Pi process.

If the external CC Switch `models.json` changes while the container remains alive, the successor can load the stale persistent Pi copy. That can make the prepared provider/model unavailable or materially different from the configuration the user expects after applying an update.

Required change:

- Move the synchronization into a fixed image-owned helper with no caller-provided path/executable surface, and invoke it before both the initial Pi child and every accepted successor spawn; alternatively, make the supervisor own the same bounded synchronization logic.
- Keep the existing atomic replace, JSON validation and file permissions.
- Add a test that changes the external model file after the first child starts and proves the second child sees the newly synchronized file.

### 4. Medium — legacy direct-call classification is order-sensitive and scans past `--`

Files/lines:

- `pi-runtime-restart-work/pi-docker/pi-entrypoint:63-82`
- `pi-runtime-restart-work/pi-docker/scripts/pi-pirun:157-175,268-280`

Maintenance/help/version subcommands and flags are recognized as direct only when they are the first argument, while the later loop checks only a subset of unsupported flags. Valid forms such as `pi --offline --version` or `pi --provider X --model Y --help` therefore receive lifecycle labels/run identity and enter the supervisor even though help/version are required to preserve direct execution. Conversely, the loop does not stop at the `--` option delimiter, so a literal prompt token such as `pi -- "--no-session"` disables managed mode even though it is message text rather than a CLI option.

The resulting Pi output may often look the same because the short-lived child exits normally, but the process topology and advertised lifecycle capability are no longer the legacy direct path. The duplicated classifier in `pi-pirun` and `pi-entrypoint` also creates a drift risk: host labels and in-container behavior must make the same decision.

Required change:

- Parse only the option region before `--`, recognizing help/version and every direct-only mode regardless of their position where Pi itself permits reordered global flags.
- Keep command/subcommand handling exact rather than treating message text as flags.
- Centralize the eligibility contract or add a table-driven parity test that feeds the same argv corpus to launcher and entrypoint classifiers.
- Add reordered help/version cases and `--` literal-message cases to the existing launcher and entrypoint tests.

## Quality notes that passed review

- The supervisor/client use bounded newline JSON and generic external errors; public status omits `session_file`, cwd, socket paths and internal exceptions.
- Runtime/control socket permissions are explicitly tightened to `0700/0600`.
- Child tokens are fresh 64-hex values per spawn, and extension snapshots are bound back to the stable run ID.
- Process creation uses argv arrays without a shell and inherits the terminal descriptors.
- The old child must exit before the successor is spawned; stop timeout does not send SIGKILL or start a second child.
- Success verification checks the exact session/leaf/session-file/cwd, a new runtime ID and the preflight version, and a normal child exit is not crash-looped.
- Image-owned supervisor/client files are outside shared writable home volumes, while existing UID/GID, capabilities, security options and named volumes remain unchanged.

## Approval condition

Do not integrate or deploy Task 1 in its current form. Re-review after Findings 1 and 2 are fixed and regression-covered. Findings 3 and 4 are also specification gaps and should be resolved in the same Task 1 revision, before Hub/Gate integration relies on the lifecycle contract.
