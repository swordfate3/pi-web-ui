# Task 4a checkpoint: artifact and durable-state scaffolding

Date: 2026-10-22. Starting HEAD: `2332375`.

## Status and scope

This is the explicitly requested **Task4a checkpoint**, not completed Task4 and
not an acceptance/release recommendation. The user split the remaining work into:

- **4a:** artifact preparation, helper identity, evidence schema, durable phases,
  policy/recovery fencing, regression verification and a scoped local commit.
- **4b:** actual offline real-Pi PTY/guard/Web behavioral probe.
- **4c:** source launch identity/bootstrap and disposable pre-stop session restore
  with archive transfer and barrier/identity rechecks.

Only 4a is being delivered here. `validate` still returns
`compatibility_probe_unavailable`; `RuntimeEngine.consumer_blocker` still returns
`source_evidence_unavailable`. These are explicit unfinished boundaries, not
implemented compatibility checks. No production change, push, merge, deployment,
subagent, UI/dist edit, or competing Docker/browser harness was performed.

## Implemented changes

### Artifact preparation and activation boundary

- Removed the installer's package-version allowlist. Exact stable versions must
  have a pinned release object; an unpinned request is refused before installation.
- Download the exact fixed official tarball URL with redirects and ambient proxy
  configuration disabled. Bound download time/size; verify canonical SHA-512
  integrity before invoking npm. Validate package identity and basic archive shape.
- Install the verified local tarball, not a second `package@version` resolution.
  Use `--ignore-scripts`, the fixed registry, a fresh scratch directory/cache, and
  an explicit subprocess environment without ambient npm configuration/credentials.
- Preparation and activation no longer execute the candidate's `--version` in a
  networked helper or with consumer credentials.
- Hash the complete candidate release tree, including dependency files, modes,
  directories and symlink targets. Reject escapes, special files, hardlinks and
  detected changes during hashing. No receipt file is excluded from the hash.
- Activation receives the candidate/evidence through Gate's fixed helper command,
  not a mutable runtime-volume receipt. Recheck the candidate tree and original
  entrypoint identity before the atomic symlink replacement.

### Durable state and fixed helper protocol

- Preserve `create(job, phase)`, `start(job, phase)`, `poll(job, phase)`, helper
  naming, durable container IDs and durable start intent. Add phase `validate`.
- Persist candidate identity before validation, and evidence before activation.
- Pin the execution profile on admission and recheck it with policy/artifact
  fencing. Manual admission records local source identity without requiring Docker.
- Recheck policy after helper creation, before durable start intent, and before
  accepting returned evidence. Recovered legacy refresh jobs cannot bypass evidence.
- Once activation start intent is durable, reconcile its helper outcome before
  considering new source blockers: an ambiguous activation remains recovery-required,
  not a clean pre-activation refusal.
- Validation helper: network `none`, read-only runtime mount/root filesystem,
  disposable `/tmp`, no credentials/workspace/session mounts. Preparation retains
  network `host`; activation uses network `none`.
- Check helper environment against immutable image defaults merged with explicit
  overrides. Reject duplicate/injected values and unsafe loader/credential-named
  variables while allowing inert image-specific paths such as `HF_HOME`.
- Tighten helper inspection for resources, namespace/sharing options, mounts,
  logging and restart policy; explicitly request zero maximum retries.

### Installed-version projection

- Supervisor status optionally reports `installed_version` separately from the
  running process's `version`. It reads the resolved official package manifest;
  it does not execute the shared CLI to obtain this display value.
- Gate forwards consistent installed-version observations without guessing from
  running versions. Conflicting observations make readiness unavailable; absent
  metadata remains absent.
- This metadata is **not** execution or compatibility proof. The existing Web
  runtime-control version allowlist and all taint/pending/barrier logic are unchanged.

## Exact interfaces available to the next implementer

The self-contained helper function is:

```python
install(prefix, version, task, action='prepare', *,
        release=None, candidate=None, evidence=None, profile=None)
```

The embedded invocation remains `/usr/bin/python3 -I -c <script>`, followed by
`version`, `task`, `phase`, and one JSON object containing the keyword arguments.
These arguments come from Gate's durable job, not the browser.

### Records

```text
release = {
  version, integrity, tarball, node
}
candidate = {
  version, integrity, tree_sha256, previous_target, previous_identity
}
profile = {
  contract: "pi-runtime-validation-v1",
  image, helper_sha256, adapter_sha256, web_sha256
}
evidence = {
  candidate_hash, release_hash, profile_hash, node,
  checks: {
    exact_version, node_engine, web_extension, pty_guard,
    input_barrier, async_taint, generation_idle, session_restore, no_replay
  }
}
```

Evidence hashes use `runtime_install.digest`: SHA-256 of JSON with sorted keys and
compact separators. Every check must be the boolean `true`, and the exact Node
version must satisfy the pinned release's supported `>=x.y.z` requirement. This
schema currently validates supplied observations; **there is no real evidence
producer yet**. Positive unit fixtures are synthetic Docker-boundary observations.

Current source hashes are computed from the checkout's Gate `.py`, runtime
`.py/.mjs`, and extension `.ts/.mjs` files. The profile is therefore tied to this
integration layout. It does not yet verify that `/opt/pi-web-ui` in the helper
image contains matching source files, nor explicitly hash a future probe runner.
4b must extend that binding; adding image-owned files invalidates old profiles.

### Results and stages

```text
prepare stdout success:
  {ok:true, version, changed:false, candidate}
validate stdout success schema (not produced by current implementation):
  {ok:true, version, changed:false, evidence}
activate stdout success:
  {ok:true, version, changed:true}
```

`poll` projects these to `state:"succeeded"`, retaining `version`, `changed`, and
the phase-specific `candidate`/`evidence`. Clean errors are `state:"failed"` with
a bounded stage; malformed output, missing dispatched helpers and ambiguous
activation remain `state:"unknown"` and become `recovery_required` in the ledger.

Stages: `preparing → prepared → validating → validated → activating → refreshing`.
Current real validation stops at `compatibility_probe_unavailable`. A synthetic
successful validation still cannot activate real consumers while source evidence
is unavailable. Private candidate/profile/evidence fields are not projected to Hub.

## TDD and verification evidence

All commands below ran from `/home/fate/gitproject/codex_project_v2/pi-web-ui`.
Python commands used `PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/gate/tests`.

Observed RED before corresponding production edits:

| Command/test | Observed failure |
| --- | --- |
| `python3 -m unittest test_runtime_security -v` (initial 8 tests) | 10 failed assertions/subtests: missing pinned-release input/tree digest/validation phase and accepted environment/namespace/resource mutations. |
| `python3 -m unittest test_runtime_validation_flow -v` (initial 7 tests) | 7 failures: no durable candidate/evidence phase, no profile/source fencing, and start dispatched after policy replacement. |
| `test_recovered_legacy_refresh_cannot_bypass_validation` | Recovered evidence-free refresh stayed running and enqueued lifecycle work instead of refusing. |
| `test_inert_image_defaults_are_matched_to_immutable_image_not_a_narrow_whitelist` | Valid immutable image path defaults were rejected. |
| `python3 -m unittest test_runtime_installed_version -v` | 4 failures and 1 error: no separate installed projection; old code attempted CLI execution (the invalid-metadata fixture hit an executable-permission error). |
| Existing request-only HTTP admission regression | HTTP 409 instead of 202; direct reproduction traced the new profile call into `lifecycle unavailable`. |
| `test_zero_retry_default_does_not_change_no_restart_helper_identity` | Zero-retry normalized helper was rejected. |
| `test_dispatched_activation_is_reconciled_before_new_source_admission` | Ambiguous dispatched activation was incorrectly labeled `failed`, not `recovery_required`. |

Intermediate GREEN runs included 8/8 initial security tests, 15/15 combined
security/validation tests, 59/59 focused runtime regressions, 5/5 installed-version
tests, and the two final edge regressions passing after their fixes.

Final complete imported suite command:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/gate/tests \
python3 -m unittest discover -s integrations/runtime-updater/gate/tests -q
```

Final rerun: **254 tests passed in 50.952 seconds**, exit code 0 (completed
session `14992`). This includes the two final regressions observed failing before
their fixes. No implementation changes were made after this run.

Additional controller-reported covering results on this checkpoint: **109 imported
runtime tests passed in 5.879 seconds**, **77 lifecycle tests passed in 13.435
seconds**, and the serialized whole Node suite had **637 passed, 0 failed,
0 cancelled, 1 existing skip in 111 seconds**. These are controller observations,
not independently rerun here. The lifecycle run emitted an unclosed-database
`ResourceWarning`, reported by the controller as pre-existing/specific to a lookup
test; it remains flagged rather than claimed fixed.

Focused existing extension/guard regression command:

```sh
node --import ./tests/register-ts.mjs --test \
  tests/runtime-control.test.ts tests/runtime-guard-process.test.ts
```

Result: **24 passed, 0 failed/cancelled/skipped**, 3.240 seconds. Node emitted the
existing module-type warning; no package configuration was changed to suppress it.
Owned-file `git diff --check` passed before final staging.

### Interpreter/environment findings

- Shell `python3` is Python 3.14.3; `/usr/bin/python3` is Python 3.10.12.
- The imported cache-security test originally generated a 3.14 cache fixture then
  attempted to load it with fixed `/usr/bin/python3`. The test now constructs that
  fixture using the actual control interpreter, retaining the original exploit
  demonstration and refusal assertions. No lifecycle production behavior changed.
- A full system-Python 3.10 run exposed a pre-existing empty-query parsing behavior:
  `parse_qs('', strict_parsing=True)` raises there, making the readiness handler
  return 400. The final suite uses shell Python 3.14. This service compatibility
  issue is recorded, not silently fixed as broader functionality in 4a.
- Local-socket tests ran with permission-approved execution. They used temporary
  state and synthetic Docker boundaries, not a live production Gate.

## Explicit incomplete boundaries and concerns

1. **4b absent:** no real candidate PTY/Web/guard probe, synthetic refresh proof,
   measured Node evidence, or incompatible-contract real-package acceptance.
   Do not replace the current refusal with static `true` checks.
2. **4c absent:** no supervisor launch-tree identity, source evidence bootstrap,
   session archive transfer, disposable pre-stop restore, or restore grant/barrier
   recheck. No `prepare_restore` wire operation or new probe module was added.
3. **Artifact scope limitation:** fixed-origin/integrity enforcement is implemented
   for the top-level official artifact. npm is given a fixed registry and the root
   manifest's non-range dependencies are refused, but transitive dependency source
   redirects/URL declarations are not comprehensively confined. A strict
   all-dependency-origin claim is not established and remains a release blocker.
   The conservative root dependency syntax may also reject legitimate npm aliases.
4. The downloader intentionally ignores ambient proxies. Connectivity in the real
   test image must be established without silently borrowing host credentials or
   weakening the fixed-origin policy. This agent did not download real packages.
5. Hash/recheck logic detects ordinary drift; it is not isolation from hostile
   concurrent writers sharing a writable runtime volume. The spec's threat-boundary
   caveat still applies.
6. Helper definitions/polling were unit-tested against synthetic Docker responses.
   Main owns real Docker normalization, source startup, upgrade/rollback, browser,
   mobile, preservation and cleanup acceptance. No Task5 row is claimed passed here.
7. Supervisor installed metadata is display/precondition information, not a substitute
   for executing and validating the target in 4b/4c. UI and dist rebuilds remain Main's.
8. The integration README still describes the earlier import checkpoint; this report
   is the current 4a handoff. That out-of-scope README was not edited.

## Owned files in this checkpoint

- `integrations/runtime-updater/gate/gate/runtime_engine.py`
- `integrations/runtime-updater/gate/gate/runtime_install.py`
- `integrations/runtime-updater/gate/gate/runtime_updates.py`
- `integrations/runtime-updater/gate/tests/test_lifecycle_round1.py`
- `integrations/runtime-updater/gate/tests/test_runtime_engine.py`
- `integrations/runtime-updater/gate/tests/test_runtime_install.py`
- `integrations/runtime-updater/gate/tests/test_runtime_installed_version.py`
- `integrations/runtime-updater/gate/tests/test_runtime_regressions.py`
- `integrations/runtime-updater/gate/tests/test_runtime_security.py`
- `integrations/runtime-updater/gate/tests/test_runtime_updates.py`
- `integrations/runtime-updater/gate/tests/test_runtime_validation_flow.py`
- `integrations/runtime-updater/pi-runtime/pi_supervisor.py`
- This explicitly requested report.

Main's E2E/harness, Dockerfile, provider, bootstrap and acceptance-script changes
are excluded. The user-owned untracked
`docs/validation/2026-10-20-trusted-terminal-host-review.md` is preserved untouched.
The unrelated math commit remains preserved. No independent/subagent code review
was claimed; the scoped diff was reviewed locally under the no-subagents instruction.
