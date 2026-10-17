# Managed Pi restart Task 1 round 1 re-review

Date: 2026-10-17

## Scope and evidence

This re-review is limited to the four findings in `managed-restart-task1-review.md`, their round-1 fixes, and regressions introduced by those fixes. It does not review the independently developed Hub/Gate work or reopen unrelated Task 1 design areas.

Reviewed evidence:

- `managed-restart-task1-brief.md` and its frozen Task 1 protocol;
- the four original findings in `managed-restart-task1-review.md`;
- the appended round-1 implementation/test report in `managed-restart-task1-report.md`;
- the candidate package in `managed-restart-task1-round1-diff.md` and the corresponding current staged source/tests under `pi-runtime-restart-work/pi-docker`.

No Git command, product-source edit, child agent, production call, image/container operation, or existing test-suite rerun was performed. The supplied `61 tests, 3 skips, 0 failures` result and the independently rerun real-Pi two-TUI fixture result (`1 passed in 1.596s`) are accepted as supplied evidence, not independently reproduced evidence. This review report is the only file written.

## Verdict

- **Original finding 1 — ADDRESSED.** Restart acceptance is acknowledged before slow checking begins, and an unacknowledged reservation is failed without starting the worker.
- **Original finding 2 — ADDRESSED.** Unknown-option arity guessing is removed; supported options have explicit arity, positional/file inputs are not copied, and ambiguous/unknown forms fail before prepare or SIGTERM.
- **Original finding 3 — ADDRESSED.** Model synchronization is now a fixed image-owned helper invoked before the initial child and before each accepted successor spawn.
- **Original finding 4 — ADDRESSED.** Launcher and entrypoint use the same option-aware policy, recognize reordered direct-only flags, stop at `--`, and use the absolute allowlisted entrypoint.
- **Specification compliance: FAIL for round 1.** The original defects are fixed, but two fix-induced regressions still violate the frozen current-status and safe-original-options contracts.
- **Code quality/security: FAIL — one more revision required.** Both remaining findings are fail-safe with respect to unauthorized stopping/replay, but they can make managed restart unavailable or incorrectly targeted after otherwise valid activity.

## Original-finding verification

### 1. Prompt acknowledgement and responsive checking — ADDRESSED

Evidence:

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:356-425`
- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:437-475`
- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:515-553`
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py:358-381`

The synchronous path now performs only bounded request validation and reserves `running/checking`. The control thread serializes and sends the response before `start_reserved_restart()` launches the worker. If `sendall()` raises, `fail_unacknowledged_restart()` records `failed/acknowledgement_failed` and leaves the child untouched. Slow snapshot/version/prepare work runs in the worker, so the fixed client's three-second timeout no longer races a ten-second version subprocess.

The supplied slow-version regression directly exercises a 3.5-second preflight and checks sub-second submission and status response. No continuation-after-client-rejection path remains in the normal bounded response path.

### 2. Explicit no-replay argv policy — ADDRESSED

Evidence:

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:40-58`
- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:117-161`
- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:319-348`
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py:427-489`

The former “unknown long option consumes the next token” heuristic is gone. Core booleans and value options have explicit arity; provider/model/thinking/session selectors are replaced from the prepared snapshot; unknown and equals-form options are rejected before extension prepare; and prompt, `@file`, and post-`--` tokens are not copied into the successor argv. The supplied regression matrix covers all listed booleans followed by a prompt, file/delimited message inputs, an unknown extension flag, and an equals-form selector.

This resolves the original message-replay defect. Finding R2 below concerns loss of later safe options, not replay of the positional message itself.

### 3. Successor model synchronization — ADDRESSED

Evidence:

- `pi-runtime-restart-work/pi-docker/runtime/pi_model_sync.py:1-89`
- `pi-runtime-restart-work/pi-docker/pi-entrypoint:6-22`
- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:468-474`
- `pi-runtime-restart-work/pi-docker/Dockerfile:29-38`
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py:491-518`

The synchronization logic is installed under `/usr/local/lib/pi-runtime`, outside shared writable home volumes. The entrypoint runs it before the initial launch, and the supervisor runs the imported fixed helper immediately before successor spawn. The implementation preserves validated JSON input, same-directory atomic replacement and `0600` mode. The supplied test changes external model configuration after the first child starts and verifies that the successor observes the updated copy.

### 4. Shared launch policy and legacy direct calls — ADDRESSED

Evidence:

- `pi-runtime-restart-work/pi-docker/runtime/pi_launch_policy.py:9-48`
- `pi-runtime-restart-work/pi-docker/pi-entrypoint:24-36`
- `pi-runtime-restart-work/pi-docker/scripts/pi-pirun:157-167,260-274`
- `pi-runtime-restart-work/pi-docker/Dockerfile:58`
- `pi-runtime-restart-work/pi-docker/tests/test_pirun_runtime.py:228-254`
- `pi-runtime-restart-work/pi-docker/tests/test_entrypoint_models.py:124-158`

Both host and container call the same policy source. The parser skips exact-arity values, detects reordered help/version and other direct-only modes before the delimiter, and stops interpreting tokens after `--`. The fixed Docker entrypoint is now the absolute Gate-allowlisted path. The supplied launcher and entrypoint regressions cover the two reordered forms and literal `--no-session` after the delimiter.

## Fix-induced findings

### R1. Medium — terminal operations permanently pin status to a cached snapshot

File/lines:

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:270-281`

`status()` uses `last_snapshot` whenever `self.operation` is non-null. Final operations are intentionally retained for status/idempotency, so `self.operation` remains non-null after `succeeded`, `failed`, or `recovery_required`. As a result, after the first operation the supervisor never calls `safe_snapshot()` again.

The cached snapshot is initially adequate for the terminal transition, but it becomes incorrect when the surviving Pi later changes state. Concrete cases include:

- a busy restart attempt ends as `failed/checking_rejected`; after Pi becomes idle, status continues to report the cached `busy: true` forever;
- after a successful restart, a later branch/session change is not reflected in runtime/session/leaf status;
- a recovered current child can remain represented by an old readiness snapshot indefinitely.

This violates the frozen status contract, which describes the current managed runtime identity/readiness plus an optional retained operation. It can prevent a legitimate later restart or cause Gate/Hub to submit an identity that the worker subsequently rejects. The existing sequential-operation test succeeds because its fake successor identity never changes after the cached success snapshot; it does not test post-operation state mutation.

Required change:

- Use the cached snapshot only while an operation is actively `running` and fresh extension access would interfere with responsive checking/transition handling.
- Once the operation is terminal, call `safe_snapshot()` again and attach the retained terminal operation to that current snapshot.
- Add regressions that mutate idle/busy and session/leaf identity after a terminal operation and prove status refreshes while preserving the final operation object.

### R2. Medium — replay-safe parsing silently drops valid safe options after a positional input

File/lines:

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:117-149`
- `pi-runtime-restart-work/pi-docker/runtime/pi_launch_policy.py:26-44`

`restart_prefix()` stops scanning at the first positional message or `@file`. The candidate's shared launch-policy parser, consistent with current Pi option parsing, treats the complete pre-`--` argument region as option-capable and continues scanning after positional tokens. Therefore a managed launch such as:

```text
pi "initial prompt" --offline --extension /fixed/extension.ts
```

is eligible and starts with those options, but its successor argv drops both `--offline` and `--extension`. Other reviewed safe options placed after a positional input are lost in the same way. Dropping `--extension`, `--system-prompt`, tool restrictions, approval/offline controls, or resource paths can materially change the restored runtime; dropping a required explicit extension can make successor readiness fail only after the old child has already exited.

The no-replay tests cover safe options before the first positional token, but none places a reviewed safe option after a positional message or `@file`. This is a regression from the fix's early `break`, not a recurrence of the original prompt replay.

Required change:

- Before `--`, discard positional and `@file` inputs but continue scanning subsequent tokens with the same exact-arity allowlist.
- Continue to reject every unknown/ambiguous option wherever it occurs in the pre-delimiter region.
- At `--`, stop and discard the entire remaining message region.
- Add cases with safe boolean/value options, replaced selectors, and unknown flags after positional and `@file` inputs. The successor must preserve safe options, replace selectors, reject unknown options before prepare, and never copy any message/file token.

## Final disposition

All four original review findings are **ADDRESSED**, and the supplied unit/integration evidence—including the reported real-Pi two-TUI pass—supports those specific fixes. Task 1 round 1 nevertheless remains **not approved** because R1 and R2 are specification-visible regressions introduced by the fixes. Re-review should be limited to those two corrections and their regression coverage.
