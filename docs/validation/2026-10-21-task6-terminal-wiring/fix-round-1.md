# Task6 fix round 1 — R1 native-stack cleanup

Base: `c6b6cce8af829d807fcac907341958b9eec0e5ce`. Scope is independent-review
R1/P2 only: partial startup, cleanup errors, and safe retry in the acceptance
fixture. R2 warning debt is not changed. No external source, production runtime,
provider wire, policy, deployment or browser UI changed.

## Behavioral RED before changing cleanup

Command, from the repository root:

```sh
env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p test_task6_native_cleanup.py -v
```

Raw log: `/tmp/pi-task6-fix1-red.log`, exit1. Relevant unmodified output excerpts:

```text
test_early_container_removal_failure_attempts_all_resources_then_retries (test_task6_native_cleanup.NativeCleanupTests) ... FAIL
test_label_mismatch_preserves_foreign_resource_but_cleans_owned_peers (test_task6_native_cleanup.NativeCleanupTests) ... FAIL
test_probe_failure_does_not_gate_resource_removal_and_can_retry (test_task6_native_cleanup.NativeCleanupTests) ... FAIL
test_second_volume_creation_failure_cleans_first_volume_and_images (test_task6_native_cleanup.NativeCleanupTests) ... ERROR
test_stop_failure_still_attempts_force_remove_and_later_resources (test_task6_native_cleanup.NativeCleanupTests) ... FAIL
```

```text
  File "/home/fate/gitproject/codex_project_v2/pi-web-ui/e2e/fixtures/task6-native-stack.py", line 345, in close
    '--mount','type=volume,src='+self.volumes[1]+',dst=/run/pi-terminal-provider,readonly',
IndexError: list index out of range
```

```text
Ran 5 tests in 0.005s

FAILED (failures=4, errors=1)
```

The error is the actual cleanup defect with the first volume recorded and no
second volume, not a module/setup error. Other failures inspect remaining
modelled resources after executing the real cleanup method. Docker is replaced
at the external command boundary; actual temporary-directory deletion, saved
evidence and Stack state remain real. No Docker process is spawned.

## GREEN and supplemental checks

Same command, `/tmp/pi-task6-fix1-green.log`, exit0:

```text
Ran 5 tests in 0.006s

OK
```

Expanded tests additionally exercise a probe created before timeout, complete
close/idempotence, missing recorded resources, simultaneous volume/image/alias
errors, and evidence-read failure with private error content excluded. First
expansion had8passed/1failed because a test-edit hunk moved the early-container
retry assertions into the evidence-read test after its successful retry. That
test placement was corrected; it is not a product RED. Raw intermediate log:
`/tmp/pi-task6-fix1-green-expanded.log`.

Final same command, `/tmp/pi-task6-fix1-green-final.log`, exit0:

```text
test_complete_cleanup_is_idempotent_and_preserves_socket_proof (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_early_container_removal_failure_attempts_all_resources_then_retries (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_label_mismatch_preserves_foreign_resource_but_cleans_owned_peers (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_missing_recorded_resources_are_verified_absent_before_completion (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_native_evidence_error_does_not_block_cleanup_or_retry (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_probe_failure_does_not_gate_resource_removal_and_can_retry (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_second_volume_creation_failure_cleans_first_volume_and_images (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_stop_failure_still_attempts_force_remove_and_later_resources (test_task6_native_cleanup.NativeCleanupTests) ... ok
test_volume_image_and_alias_failures_are_aggregated_and_retried (test_task6_native_cleanup.NativeCleanupTests) ... ok

----------------------------------------------------------------------
Ran 9 tests in 0.009s

OK
```

`npm run verify:dist`, exit0:

```text
Source and dist outputs verified (hash consistency only; not trust/authenticity).
```

No build is required: the amended E2E fixture and Python tests are outside the
release source inventory. No native, full Gate/Pi/Node, public gateway or device
test was repeated. The original native1/1, screenshots and cleaned resource
inventory are preserved historical successful-run evidence; these mocked
failure tests do not replace or rerun them. No real Docker resources were owned
in this fix round; all test temporary roots/artifact directories were removed.

## Behavior and source correspondence

- Errors do not short-circuit peer cleanup or temporary-directory cleanup.
  Even failed graceful stop is followed by a force-removal attempt for the
  same verified owned container.
- Only exact recorded role names with matching labels are removed. Inspect
  failure alone is not absence; a name inventory must confirm absence.
  The unlabelled cached-base alias still requires its exact name and base ID.
- IPC probing requires the recorded `prefix-ipc` name; partial creation with
  only `prefix-state` skips it. The transient probe joins the owned ledger
  before invocation so a timeout cannot strand it outside cleanup accounting.
- Successful removals leave the pending lists; failed entries remain retryable.
  `closed` is true only after an error-free pass. Failure history remains in
  evidence; retry does not fabricate the failed socket-verification result.
- Incomplete cleanup saves negative status and raises one aggregated error.
  The fixture cannot print its success cleanup response after that exception.

SHA256 correspondence:

| Path | Before | After |
| --- | --- | --- |
| `e2e/fixtures/task6-native-stack.py` | `3de6cef99e0eed9ddb81d2dda6bc74b2ac1fa4655605204b9e7111dfb452bb3f` | `ff015f537d5b1cbd222623abc8e9273b12f93d1eabab5cd83a6f2c9aa3ffb1ab` |
| `tests/test_task6_native_cleanup.py` | New file | `c30174827b1b5a0b4345608c5673d395d4497d83eb6b5edf65881f10bed80576` |

The unchanged external `host-source.patch` remains SHA256
`a32b8f1d29071818de4fca924cfece3cbc1b1779d02d6281ef57c1a45a6ea25a`.
Original external baselines, rollback, helper-evidence gap and retained user
files/stash remain as previously recorded. Independent controller re-review
and Task7 final acceptance remain outstanding.
