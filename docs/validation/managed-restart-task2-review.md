# Task 2 independent review — changes required

Date: 2026-10-17. Scope: staged, uncommitted Gate under `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`.

## Verdicts

- **Spec compliance: NOT APPROVED.** The fixed-control trust boundary and shared upgrade exclusion have gaps. The 155-second total also needs an explicit cross-component contract correction before full stop/start allowances can be supported.
- **Quality/security: NOT APPROVED.** One P1 and two P2 findings below. The implementation has substantial defensive coverage, but the supplied green suites do not cover these cases.

Read the Task 2 brief first, then its implementation report, supplied review diff, staged sources/tests, and binding plan/design. Task 1 inspection was limited to the fixed client's interpreter/import interface and supervisor timing evidence needed for this review. No Hub implementation review, Git, subagents, production requests, product edits, Docker execution, or passed-suite reruns.

## Findings

### T2-R1 — P1: inherited Python bytecode-cache configuration bypasses fixed-control code provenance

Primary location: [gate/lifecycle_contract.py:123](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle_contract.py:123), environment validation at lines 123–129. Execution boundary: [gate/engine.py:123](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/engine.py:123), lines 123–128.

`trusted()` rejects `LD_*`, `PYTHONPATH`, and `PYTHONHOME`, but accepts `PYTHONPYCACHEPREFIX=/workspace/pycache`. The exec overrides PATH, `PYTHONNOUSERSITE`, and `PYTHONSAFEPATH`, leaving that inherited setting intact. The fixed client uses `#!/usr/bin/env python3` and imports `json` ([pi-session-control:1](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi-session-control:1)).

For an otherwise admitted container with this environment setting, ordinary UID1000 code can populate the writable alternate cache with an unchecked-hash `.pyc` for a standard-library import. Python then executes that bytecode during the Gate's fixed control invocation, despite the three safety overrides. Image allowlisting, fixed argv, and protected control-script files do not authenticate the code actually executed. Substitute code can forge control evidence or perform process actions outside the intended control implementation. This is not a claim of host/root execution or that a running Pi process can change Docker's creation-time environment: the concrete prerequisite is an admitted container already carrying the accepted setting.

**Evidence:** the sole additional focused check constructed a matching inspect object, confirmed `trusted()` accepted that environment, and ran an isolated Python import with the exec safety overrides and a temporary forged cache. It printed the injected marker and exited successfully. No Docker or real target was used; see verification below.

**Required correction:** make the fixed client's interpreter configuration independent of untrusted inherited Python settings, or reject/neutralize the complete relevant interpreter configuration surface, including the bytecode-cache prefix. Keep the frozen fixed argv/UID boundary. Add a regression that actually exercises a writable substitute cache; checking only the presence of safe-path flags is insufficient.

### T2-R2 — P2: upgrade guard is a snapshot, not shared exclusion

Primary location: [gatectl:63](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gatectl:63), lines 63–66. Use site: [gatectl:334](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gatectl:334), lines 334–342.

`up` reads `lifecycle_active`, then verifies the image and invokes Compose replacement. It acquires no Gate-side admission reservation. A valid interleaving is: status reports idle; a lifecycle request is admitted and dispatched; image verification finishes; replacement proceeds. The newly added guard therefore does not enforce the brief's shared exclusion with upgrades.

The existing 600-second Compose grace period and Gate's worker join are important mitigations: this finding does **not** assume immediate killing of an ordinary 155-second worker. However, they do not fix admission, and shutdown does not veto replacement if the intervening lifecycle finishes `failed`/`recovery_required`. In that case the worker returns, Gate exits, and the already-authorized upgrade proceeds without the required host inspection. Persisted recovery state can block later work, but cannot retroactively reject that upgrade.

**Required correction:** acquire an atomic host-admin upgrade reservation under the same admission lock, after checking all unresolved work, and hold exclusion through replacement or explicit abort. It must prevent new lifecycle/deployment work and refuse unresolved outcomes; another unlocked status read is not sufficient. Cover the interleaving after the initial status response, including an intervening unknown outcome. The current test at [tests/test_lifecycle.py:425](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_lifecycle.py:425) tests only a lifecycle job already present when status is queried.

### T2-R3 — P2, cross-contract: 155 seconds from execution start truncates valid component allowances

Primary location: [gate/lifecycle.py:305](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle.py:305), lines 302–315. Start anchor: [gate/lifecycle.py:229](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/gate/lifecycle.py:229).

`started_at` is correctly persisted before Gate preflight. The same timestamp then anchors a total 155-second budget, including preflight, control admission, asynchronous checking, preparation, stopping, startup, and final observation. At expiry Gate permanently records `recovery_required`; subsequent ticks do not continue normal reconciliation for that terminal state.

Necessary supervisor interface evidence: [pi_supervisor.py:299](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:299) allows version discovery up to 10 seconds; [pi_supervisor.py:328](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:328) sequences snapshot, version discovery, and prepare; [pi_supervisor.py:464](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:464) allows 30 seconds for stop; [pi_supervisor.py:482](/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py:482) begins the separate 120-second readiness deadline only after spawn.

For example, 2 seconds of Gate preflight + 10 seconds total checking/preparation (with version discovery below its 10-second limit) + 29 seconds stopping + 119 seconds readiness = 160 seconds, before final polling overhead. None of those component allowances is exceeded. Nevertheless Gate times out at 155, while the supervisor may still succeed. The result is a false operational failure/unknown requiring host inspection, not false success or an automatic second stop.

**Contract distinction:** the Task 2 brief explicitly permits bounded 155-second polling, and the implementer discloses this limitation. Thus choosing 155 is not an undisclosed deviation from that brief. It is a real inconsistency with supporting the original plan/design's separate stop30/start120 allowances plus asynchronous preflight. The immutable millisecond timestamp correction does not itself establish a 155-second total in the frozen plan.

**Required coordinator ruling:** 155 seconds must not be treated as sufficient for the complete successful execution/registration path. Preserve the immutable `started_at`, exclude manual waiting, and retain a fixed non-extending recovery deadline. Explicitly revise the shared Gate/Hub total to cover bounded Gate preflight + supervisor checking/prepare + stop30 + spawn/start120 + final observation/registration margin. Establish bounds for intervening overhead before choosing the numeric total; merely changing 155 to an unexplained larger constant is not a proof. Alternatively, a deliberately shorter total requires an explicit product-contract limitation acknowledging that otherwise in-budget supervisor work can become unknown. Do not silently shrink stop/start allowances or reset timestamps while polling. Hub's proposed 155-second registration budget needs the same correction; browser recovery remains a separate clock. No interface or Hub code was changed in this review.

## Requirements with supporting implementation evidence

Apart from the findings above, static inspection supports:

- Independent lifecycle token and dedicated default-disabled policy, with policy generation/hash fencing; ordinary and lifecycle route credentials are separated.
- Exact restart body validation; `id == idempotency_key == operation_id`; conflicting identity reuse rejected; bounded retained/open lifecycle state.
- Exact immutable container ID/image/labels/absolute entrypoint/UID checks, restrictive mounts/security settings, and repeated configuration/StartedAt fingerprint validation before execution. Host bind provenance remains the expressly documented trusted-host boundary, not a newly claimed proof.
- Fixed UID1000 control argv without shell/stdin/TTY, bounded transport/output, Docker stream parsing and exit inspection, subject to R1's interpreter-environment hole.
- Durable intent before exec, immutable millisecond execution-start timestamp, status-only crash recovery, and no automatic restart replay.
- Shared in-process worker/admission checks for deployment, approval, and rollback; failed/unknown outcomes block until explicit inspected resolution. Upgrade exclusion is the exception in R2.
- Allowlisted public job fields, generic errors, private admin/export path, and exact successor runtime/session/leaf/version validation before success.

## Verification and limits

The implementation report supplies **42 focused / 233 full tests passed**. These are supplied results, not independently rerun here. Existing tests and source were inspected; no production or real Docker/Pi integration was attempted.

Exactly **one additional focused check** was used for R1. It imported the staged `trusted()` validator, constructed an otherwise admissible inspect record, and created an isolated temporary alternate Python cache. A subprocess using `/usr/bin/python3 -B`, the exec PATH/safe-path/no-user-site overrides, and the temporary cache prefix imported `json`. The cache contained a valid unchecked-hash bytecode module that printed a marker. The check asserted validator acceptance, successful subprocess exit, and that marker. Result:

```text
Gate trusted(): accepts PYTHONPYCACHEPREFIX=/workspace/pycache
Python with the exec safety overrides: loaded substitute json bytecode
Focused check: confirmed; temporary generated bytecode removed
```

This establishes the local validator/interpreter mechanism, not an end-to-end deployed exploit. The temporary cache was cleaned up; bytecode generation in the repository was disabled. R2 and R3 are static control-flow/timing findings, not additional executed tests.

The Docker security skill guided review of image/configuration, mounts, and execution provenance; no Docker operations were performed. Verification-before-completion was applied by reading back this artifact and distinguishing supplied tests from the single fresh check. The only persistent review write is this report.
