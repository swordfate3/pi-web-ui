# Managed Pi restart Task 1 validation report

Date: 2026-10-17

## Scope and final result

Implemented and revised the isolated non-root Pi supervisor, fixed control client,
image-owned model synchronization, entrypoint policy, and trusted `pi-pirun`
identity/label wiring described by `managed-restart-task1-brief.md`.

The review's four original findings and the two round-1 fix-induced findings are
fixed in staged sources. Final staged regression result: **65 tests run, 62
passed, 3 explicitly skipped, 0 failed**.
The three skips are the pre-existing opt-in real Docker/Hub tests; their live
prerequisites were intentionally not enabled.

All source changes are confined to:

```text
/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker
```

This report is the only changed file outside that staged tree. No live
`/home/fate/docker_files` file was edited, no image was built or installed, no
container or service was restarted, and no Git operation was performed.

## Fix round 1

### 1. Prompt acknowledgement and responsive checking

Restart submission now performs only bounded request-shape, run-ID,
operation-ID, and immutable request-identity validation synchronously. Under the
supervisor lock it reserves one operation as:

```json
{"operation_id":"...","status":"running","stage":"checking"}
```

The control-server thread serializes and sends that accepted response before it
dispatches the operation worker. If sending the acceptance fails, the reserved
operation becomes `failed/acknowledgement_failed` and the worker is not started,
so no child is touched after a failed acknowledgement boundary.

The worker performs restart-argv validation, extension snapshot, exact
run/runtime/session/leaf checks, idle/pending/busy checks, saved-file/cwd checks,
the potentially slow `pi --version` preflight, extension `prepare`, graceful
stop, model synchronization, successor start, and readiness verification.
Checking failures are recorded asynchronously as
`failed/checking_rejected` without signalling or replacing the current child.

Status remains available while checking is in progress. During an operation it
uses the last validated extension snapshot and the locked operation copy rather
than blocking behind the slow version subprocess. A regression with a 3.5-second
`--version` path proves that submission and an immediate status query each return
in less than one second, while the eventual restart still succeeds.

### 2. Explicit no-replay argv policy

The previous unknown-option arity guess has been removed. Successor argv is now
built only from an explicit reviewed set of core options with exact arity.

Supported boolean options include:

```text
--no-tools -nt --no-builtin-tools -nbt --no-mcp
--no-skills -ns --no-prompt-templates -np --no-themes
--no-context-files -nc --verbose --approve -a
--no-approve -na --offline
```

Reviewed value options such as `--system-prompt`, `--tools`, `--extension`,
`--skill`, and `--tui-mode` retain exactly one value. Provider, model, thinking,
session, fork, name, continue, and resume selectors are consumed or removed and
replaced with the prepared provider/model/thinking and exact saved session.

The parser stops copying at the first positional message, `@file` input, or `--`
delimiter. Every unknown option is rejected; no following token is guessed as
its value. All option `--name=value` forms are conservatively rejected, including
selector-like forms such as `--session=...`. Unknown extension flags and equals
selectors therefore end as `failed/checking_rejected` before extension prepare,
SIGTERM, model synchronization, or successor spawn.

Regression tests cover every supported boolean followed by a positional prompt,
`@prompt.md`, prompt text after `--`, an unknown extension boolean flag, and an
equals-form session selector. The success test also preserves metacharacters as
literal argv data and proves the original user prompt is absent.

### 3. Fixed model synchronization for every child generation

Model synchronization was extracted from shell into the fixed image-owned module:

```text
/usr/local/lib/pi-runtime/pi_model_sync.py
```

The Dockerfile copies it before `USER node`, so the installed helper is
root-owned and outside shared writable home volumes. There is no configurable
helper executable or caller-supplied helper path. The source-tree fallback used
by staged entrypoint tests is selected only when the entrypoint itself is not
running from `/usr/local/bin`.

The helper preserves JSON validation, warning behavior, atomic same-directory
replacement, and mode `0600`. It runs once before the initial Pi launch and again
inside the supervisor immediately before every accepted successor spawn. A
regression changes the external CC Switch `models.json` after the first child has
started and proves the successor reads the updated synchronized content.

The main real-Pi/Docker E2E harness must include the fixed sibling path above when
it stages `/usr/local/lib/pi-runtime/pi_supervisor.py`.

### 4. Shared launch classification and absolute entrypoint

Launcher and entrypoint managed-mode classification now share the fixed policy
module installed at:

```text
/usr/local/lib/pi-runtime/pi_launch_policy.py
```

The host launcher executes the same staged source from
`runtime/pi_launch_policy.py`. The policy skips exact-arity known values, detects
direct-only help/version/print/mode/export/list/no-session/no-extension forms in
the option region regardless of order, and stops at `--`. Thus:

- `pi --offline --version` remains direct;
- `pi --provider X --model Y --help` remains direct;
- `pi -- --no-session` remains an eligible managed interactive launch because
  `--no-session` is literal prompt text after the delimiter.

Non-TTY launches and trusted-run-ID validation remain separate mandatory gates.
The Dockerfile now uses the Gate-allowlisted absolute declaration:

```dockerfile
ENTRYPOINT ["/usr/local/bin/pi-entrypoint"]
```

## Preserved lifecycle and security behavior

- The actual supervisor module remains
  `/usr/local/lib/pi-runtime/pi_supervisor.py`; the fixed Gate client remains
  `/usr/local/bin/pi-session-control --request JSON`.
- The supervisor owns one Pi child, inherits the existing terminal descriptors,
  uses argv arrays without a shell, and creates a fresh cryptographic 64-hex
  child token for every spawn.
- Runtime/control paths remain private: runtime directory mode `0700`, control
  socket mode `0600`, bounded 16 KiB newline JSON, and generic public errors.
- Restart requires the exact current run/runtime/session/leaf identity, an idle
  saved session, no pending/busy state, an existing absolute session file, and an
  existing absolute cwd.
- The old child receives one SIGTERM and a 30-second default deadline. Timeout is
  `recovery_required/stopping_timeout`; no SIGKILL, second child, automatic retry,
  or crash loop is introduced.
- Readiness has a 120-second default deadline and requires a new runtime ID plus
  the exact session ID, leaf ID, session file, cwd, and preflight version.
- Normal Pi exit is returned once. Ctrl+C continues to reach the foreground Pi
  child without removing the supervisor control socket.
- Existing UID/GID `1000:1000`, `cap-drop: ALL`, `no-new-privileges`, host network,
  volumes, workspace mounts, Hub credential handling, attachment lifetime, and
  `.env` suppression are preserved.

## Final-operation invariants

The operation is initialized with `old_runtime_id` copied directly from the
accepted restart request. Checking then requires the extension snapshot and
prepared snapshot to match that requested runtime together with the exact
session and leaf. It is never overwritten with a different runtime.

A successful terminal operation includes:

- `old_runtime_id` matching the request;
- a different verified `new_runtime_id`;
- the original `session_id` and `leaf_id`;
- `old_version`, preflight `expected_version`, and observed `new_version`;
- `status: "succeeded"` and `stage: "complete"` only when
  `new_version == expected_version` and all identity/readiness checks match.

A successor reporting a different version is recorded with its actual
`new_version` as `failed/readiness_mismatch`, never success.

## TDD evidence

### Original Task 1 RED/GREEN

The original implementation began with eight supervisor tests failing because
`runtime/pi_supervisor.py` did not exist, followed by focused implementation and
incremental RED/GREEN cycles for sequential operations, prepared model/thinking,
Ctrl+C handling, and repeated-operation identity. Before round 1 review, the
staged suite reported 51 tests run, 48 passed, 3 skipped, and 0 failed.

### Round 1 regression RED

Production code was unchanged while all four review regressions were added.
Tests that bind private Unix sockets were rerun with narrowly scoped permission
for temporary local sockets after the ordinary sandbox correctly denied socket
creation; sandbox-denial runs were not counted as product RED evidence.

Supervisor command:

```text
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p 'test_pi_supervisor.py' -v
```

Observed RED:

```text
Ran 17 tests in 20.441s
FAILED (failures=17)
```

The failures demonstrated synchronous stale/busy rejection, the slow-version
client timeout, positional-prompt replay after boolean options, successful
restart despite unknown/equals-form flags, and stale successor model content.

Launcher command:

```text
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p 'test_pirun_runtime.py' -v
```

Observed RED:

```text
Ran 20 tests in 3.421s
FAILED (failures=3)
```

The failures were the two reordered help/version forms receiving managed
identity/labels and the delimited literal `--no-session` form receiving none.

Entrypoint/model/packaging command:

```text
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p 'test_entrypoint_models.py' -v
```

Observed RED:

```text
Ran 6 tests in 0.205s
FAILED (failures=3, errors=1)
```

This showed reordered direct calls entering the installed-supervisor path,
delimited text launching without a child token, and the missing absolute
Dockerfile entrypoint/fixed model helper.

### Round 1 focused GREEN

The same focused commands then produced:

```text
test_pi_supervisor.py:   Ran 17 tests in 11.286s — OK
test_pirun_runtime.py:  Ran 20 tests in 3.583s  — OK
test_entrypoint_models.py: Ran 6 tests in 0.363s — OK
```

## Final verification

Complete staged suite:

```text
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -v
```

Result:

```text
Ran 61 tests in 18.211s
OK (skipped=3)
```

The skips were the native Hub integration requiring a running local Docker Hub
and two real Docker persistence/session tests requiring
`PI_REAL_DOCKER_TEST=1`.

Additional checks:

```text
bash -n pi-entrypoint scripts/pi-pirun
    passed

Python AST parse of runtime/*.py and tests/test_*.py
    AST OK: 9 Python files

docker build --check --progress=plain .
    Check complete, no warnings found.
```

The Docker command used only Docker's static `--check` path; it did not build an
image, create a container, or restart a service.

## Files changed

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py`
- `pi-runtime-restart-work/pi-docker/runtime/pi-session-control`
- `pi-runtime-restart-work/pi-docker/runtime/pi_model_sync.py` (new in round 1)
- `pi-runtime-restart-work/pi-docker/runtime/pi_launch_policy.py` (new in round 1)
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py`
- `pi-runtime-restart-work/pi-docker/tests/test_pirun_runtime.py`
- `pi-runtime-restart-work/pi-docker/tests/test_entrypoint_models.py`
- `pi-runtime-restart-work/pi-docker/scripts/pi-pirun`
- `pi-runtime-restart-work/pi-docker/pi-entrypoint`
- `pi-runtime-restart-work/pi-docker/Dockerfile`
- `pi-web-ui/docs/validation/managed-restart-task1-report.md` (this report)

## Remaining integration boundary

The parent-owned extension runtime-control and registration implementation is
reported green under the frozen contract. The main real-Pi PTY harness already
passed the initial baseline branches and can now rerun with the fixed sibling
helper `/usr/local/lib/pi-runtime/pi_model_sync.py` (and packaged launch policy)
available beside the supervisor.

This task did not copy staged files into production, build or install a
replacement image, run the opt-in real Pi/Docker restart scenario, or touch live
services. End-to-end graceful shutdown and exact successor registration remain
the parent integration/deployment validation boundary, not an implementation
blocker in Task 1.

## Fix round 2: R1/R2

Round 2 was limited to the two fix-induced findings in
`managed-restart-task1-round1-review.md`. No Hub preload/guard work, protocol
extension, launcher policy change, packaging change, or unrelated runtime guard
was included.

### R1: refresh current status after terminal operations

`status()` now uses `last_snapshot` directly only while the retained operation
has `status: "running"`, preserving responsive checking and transition polling.
Once the retained operation is terminal (`succeeded`, `failed`, or
`recovery_required`), status calls `safe_snapshot()` again and attaches an
unchanged copy of the retained terminal operation to the newly current public
snapshot.

The new regressions mutate the fake extension after terminal operations and
prove that:

- a busy restart rejection can later report `idle: true` and `busy: false`;
- a successful runtime can later report changed session and leaf identity;
- both refreshed responses retain the exact final operation object.

If a fresh terminal extension query is temporarily unavailable,
`safe_snapshot()` retains the existing fallback behavior and returns the last
validated snapshot rather than exposing an internal error.

### R2: preserve reviewed options after prompt and file inputs

Before the `--` delimiter, `restart_prefix()` now discards each positional
message or `@file` token and continues scanning. Later reviewed boolean/value
options are preserved with their exact declared arity, and later
provider/model/thinking/session/fork/name/continue/resume selectors are still
removed or replaced from the prepared snapshot.

Unknown, ambiguous, and equals-form options continue to raise a checking
rejection wherever they occur in the pre-delimiter region. At `--`, scanning
still stops and the complete remaining message region is discarded. Therefore
the change preserves later safe options without replaying any prompt/file token
or weakening the pre-stop unknown-option refusal.

The new regressions cover:

- a positional prompt followed by `--offline`, `--extension`, replaced provider,
  and continue selector;
- an `@file` input followed by `--system-prompt`, `--no-tools`, and a replaced
  session selector;
- unknown options after both a positional prompt and an `@file`, each ending as
  `failed/checking_rejected` with one child and no stop signal.

### Round 2 TDD evidence

Focused command, run before the two production edits:

```text
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -p 'test_pi_supervisor.py' -v
```

Observed RED:

```text
Ran 21 tests in 22.325s
FAILED (failures=6)
```

The six failure instances were the two stale terminal-status assertions, two
safe-option-loss subcases, and two post-input unknown-option subcases that
incorrectly completed a restart.

After the minimal R1/R2 production changes, the same focused command produced:

```text
Ran 21 tests in 12.503s
OK
```

### Round 2 final verification

Complete staged suite:

```text
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -v
```

Result:

```text
Ran 65 tests in 19.611s
OK (skipped=3)
```

The same three pre-existing opt-in tests remain skipped: one local Docker Hub
integration and two real Docker runtime tests. Additional round-2 checks:

```text
bash -n pi-entrypoint scripts/pi-pirun
    passed

Python AST parse of runtime/*.py and tests/test_*.py
    AST OK: 9 Python files
```

Dockerfile/package sources were unchanged in round 2, so the passing round-1
Docker static check remains the applicable packaging evidence.

### Round 2 files changed

- `pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py`
- `pi-runtime-restart-work/pi-docker/tests/test_pi_supervisor.py`
- `pi-web-ui/docs/validation/managed-restart-task1-report.md` (this report)

No live file, image, container, service, or Git state was changed in round 2.
