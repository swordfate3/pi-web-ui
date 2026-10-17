# Task 2 final report — DONE_WITH_CONCERNS

Date: 2026-10-17 (Asia/Shanghai).

Implemented the staged Gate lifecycle API and host administration under the frozen
Task 2 protocol, including the coordinator's `started_at` correction and Task 1
round-1 asynchronous `running/checking` acknowledgment. Final verification:
**42 focused lifecycle tests passed; 233 full Gate tests passed; zero failures,
errors, or skips.** No production deployment or real-service verification performed.

## Scope and touched files

All code/test/documentation changes are under
`/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`:

- `gate/lifecycle.py` — new durable lifecycle manager, admission, worker, status-only recovery and explicit inspection receipt.
- `gate/lifecycle_contract.py` — new exact wire validation, safe public fields and trusted runtime/config/mount checks.
- `gate/store.py` — dedicated `lifecycle_policy` and `lifecycle_jobs` tables in existing `jobs.sqlite3`, initialized disabled.
- `gate/engine.py` — fixed filtered discovery, fixed bounded exec with Docker multiplex parsing, and named-volume verification.
- `gate/service.py` — independent private token, three HTTP routes, private admin routes, shared worker/admission and startup recovery wiring.
- `gate/admin.py` — private-socket lifecycle command transport.
- `gatectl` — offline lifecycle help, policy/query/approve/reject/resolve/export and lifecycle-aware upgrade guard.
- `tests/test_lifecycle.py` — original 21-test checkpoint preserved and extended to 42 tests.
- `README.md` — lifecycle protocol, exact admin usage, timing/recovery and trust boundary documentation.

The only change outside Gate is this required report:
`/home/fate/gitproject/codex_project_v2/pi-web-ui/docs/validation/managed-restart-task2-report.md`.

No Git commands, child agents, source installation, live Docker/Gate calls, real
credential reads/exports, image build, privilege enable, container restart or
deployment. Task 1 and Hub were inspected read-only; neither was edited. The
existing full suite includes a legacy host-boundary test that imports a launcher
source file read-only; it does not operate a live service.

## Implemented interface and integration decisions

### HTTP and credentials

Only the independent 64-lowercase-hex lifecycle token authorizes:

```text
GET  /v1/pi-lifecycle/runs/<run_id>       -> direct sanitized target
POST /v1/pi-lifecycle/restarts           -> HTTP 202, direct sanitized job
GET  /v1/pi-lifecycle/restarts/<id>       -> direct sanitized persisted job
```

Restart body is exactly `{run_id,runtime_id,session_id,leaf_id,idempotency_key}`.
Job `id == idempotency_key == supervisor operation_id`; conflicting identities
for the same key are rejected, including after completion. ID shape, bounded
identity text, Unicode controls, nullable leaf, statuses and stages are validated.
HTTP error text is generic. Public jobs contain only contract IDs/status/stage,
safe identities/versions and optional `started_at`; no private container IDs,
policy snapshots, paths, command output, intent timestamps or token values.

`lifecycle.token` is created in the private state directory, mode0600, separate
from `request.token`; reads reject symlinks, nonregular/multilink files and unsafe
permissions. Neither token authorizes the other's routes. Admin remains on the
private Unix socket. Existing deployment HTTP/CLI shapes are preserved; admin
status adds `lifecycle_active`, also consumed by the host upgrade guard.

### Corrected start time and Task 1 handshake

`started_at` is an immutable positive safe integer Unix epoch **milliseconds**.
It is durably set only with the pending/queued-to-running transition, before any
restart call. Running/succeeded public results require it. Pending/queued jobs
omit it. Recovery and later updates preserve it and reject mutation.

The Gate deadline is `started_at + 155000`, with a monotonic cap during each
worker; manual approval waiting is not charged. A test waits a simulated ten
minutes before approval and verifies a fresh execution budget. Hub must validate
the same finite safe-integer field and use this deadline, not submission time.

Initial Task 1 acknowledgment is accepted as `running/checking` with only
operation_id/status/stage. There is **no requirement for expected_version in the
checking acknowledgment or early checking status**. Version evidence arrives in
later status operation fields. Success requires original old runtime/session/leaf,
a changed new runtime, old-version consistency, `new_version == expected_version`,
and matching current status runtime/session/leaf/version. Once observed,
expected_version cannot change. All mismatches fail closed, never false success.

Coordinator/browser ruling retained for the separate Hub worker: the browser's
own120-second handoff budget starts only on old WebSocket disconnect, not prepare.
No browser code was changed by Task 2.

### Policy, trusted target, fixed execution

Independent policy is `{mode:"disabled"|"manual"|"auto",images:["sha256:<64hex>"]}`
with persisted generation/hash. Default disabled; Hub auto is not inherited.
Exact image IDs, not tags/RepoDigests, are used. Policy changes fence queued/start
authorization; they cannot approve historical pending requests retroactively.

Resolution uses fixed Engine running-container label filters followed by inspect.
It requires exactly one candidate, exact run/lifecycle labels, full immutable
Docker ID, allowlisted image, absolute `/usr/local/bin/pi-entrypoint`, uid/gid1000,
cap-drop ALL, nonprivileged/no added caps/groups/devices and unambiguous
no-new-privileges options. Authority/control-code mounts are rejected. The
existing launcher's reviewed data mount destinations are supported; named volumes
must also inspect as ordinary local volumes without driver options, and Hub's
registration runtime volume must be read-only. Arbitrary nonstandard layouts fail
closed. Config/mount/image/StartedAt fingerprints fence container generation drift
even when Docker ID is unchanged. Inspection is repeated immediately before exec.

Exec is only:

```text
[/usr/local/bin/pi-session-control, --request, JSON]
```

No shell, stdin, TTY, privileged exec or configurable argv. Exec runs as1000:1000
with a fixed system PATH and Python safe/no-user-site settings because the Task 1
client uses an env-based Python shebang. Total control call is capped at3seconds;
JSON output at16KiB. Raw non-TTY Docker multiplex frames are parsed, malformed or
stderr payloads rejected, and exec Running/ExitCode inspected before accepting
JSON. Only status/restart requests with exact fields are accepted.

### Durability, mutual exclusion, recovery

Lifecycle uses the existing Store RLock and SQLite FULL/WAL transactions. Restart
intent commits before control exec; a separate SQLite connection in the test
observes that committed state from inside the fake restart boundary. The single
Gate worker serializes lifecycle and deployment. Deployment auto dispatch, manual
approval, both rollback admission phases, cutover verification, registration and
host upgrade guards include lifecycle work. A lifecycle submission cannot race
an active deployment; admission is repeated after blocking target inspection.

At most one unresolved open job per run; globally at most8 open and1000 retained
lifecycle jobs. Pending/queued lifecycle work conservatively blocks image/Hub
execution and upgrade. Failed/recovery_required lifecycle outcomes block all
overlapping work until explicit host inspection. They do not increment Hub's
deployment failure counters.

On Gate startup, unstarted queued jobs become stale; running without an exec
intent becomes stale. Running with a durable intent is reconciled by status polls
only on the worker thread, preserving operation ID and started_at. No restart is
replayed. Missing/mismatched operation, transport uncertainty or expired budget
becomes recovery_required. HTTP health and persisted job queries remain responsive
while control polling is blocked.

Explicit resolve requires the original container/config generation, current
runtime confirmation, original session/leaf, idle/no pending/no busy and no
supervisor operation still running. Resolution atomically saves an inspection
receipt and audit while retaining the original failed/recovery_required status
and stage; it does not pretend unknown work succeeded. The original public job
remains historical failure/unknown; the admin active set excludes the resolved
receipt. No automatic deletion, retry, SIGKILL, npm update or container stop/restart.

## Exact host administration usage

Run from the staged Gate directory when explicitly authorized to administer the
eventual deployment. These are instructions, **not actions taken against live Gate**:

```bash
./gatectl lifecycle --help
./gatectl lifecycle-policy --help
./gatectl lifecycle-export --help
./gatectl lifecycle-approve --help
./gatectl lifecycle-reject --help
./gatectl lifecycle-resolve --help

./gatectl lifecycle
./gatectl lifecycle <32-lowercase-hex-job-id>

./gatectl lifecycle-policy manual --image sha256:<64-lowercase-hex-image-id>
./gatectl lifecycle-policy auto --image sha256:<64-lowercase-hex-image-id>
./gatectl lifecycle-policy disabled

./gatectl lifecycle-approve <32-lowercase-hex-job-id>
./gatectl lifecycle-reject <32-lowercase-hex-job-id>

./gatectl lifecycle-export /absolute/private-host-directory/pi-lifecycle.json

./gatectl lifecycle-resolve <32-lowercase-hex-job-id> \
  --runtime-id <inspected-current-runtime-id> \
  --acknowledge inspected_no_retry
```

`--image` is repeatable and each policy command replaces the complete allowlist.
Approve first requires reviewing the exact job via lifecycle query. Approval
returns queued promptly; query the same ID for eventual result.

Export captures the private admin response and writes exactly `{"token":"..."}`
to a new0600 file; it never prints the token and does not enable policy. It rejects
existing targets, symlinked path components and parent directories not owned by
the current user or writable by others. A failed export may leave an empty0600
file; the tool does not overwrite or silently remove it. Do not manually run the
internal `gate.admin lifecycle-export` transport or send its stdout to logs.

Private socket API: GET `/admin/lifecycle` or `/admin/lifecycle/<id>`; POST
`/admin/lifecycle-policy` with `{mode,images}`; POST `/admin/lifecycle-approve`
or `/admin/lifecycle-reject` with `{id}`; POST `/admin/lifecycle-resolve` with
`{id,runtime_id,acknowledge:"inspected_no_retry"}`; POST
`/admin/lifecycle-export` with `{}` (internal captured transport only).

## Verification evidence

Working directory for all commands:
`/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`.

Focused command throughout:

```text
/usr/bin/python3 -m unittest discover -s tests -p test_lifecycle.py -v
```

- Original checkpoint clean RED:21 tests,21 failures,0 errors,1.026s; missing Gate/Engine API assertions. Earlier socket-sandbox/test-guard errors were corrected and are not counted as product RED.
- Resume RED with started_at/async checking:23 tests,23 failures,0 errors,1.113s.
- Initial focused GREEN:23 tests,OK,4.982s.
- Host/mount/interpreter regression RED:32 tests,12 failed assertions (includes parameterized help cases),0 errors,7.195s; then32 tests,OK,7.081s.
- Generation/security-option RED:40 tests,2 failures,0 errors,8.380s; then40 tests,OK,8.329s.
- Named-volume/control-mount RED:42 tests,2 failures,0 errors,8.703s.
- **Final focused GREEN:42 tests,OK,8.302s.**

Full Gate command:

```text
/usr/bin/python3 -m unittest discover -s tests -v
```

Earlier intermediate run:214 tests,OK,49.612s. **Final run:233 tests in49.970s,
OK, no failures/errors/skips.** All lifecycle Engine activity uses precise fakes or
temporary fake-Docker Unix HTTP servers. Socket-binding permission was requested
only to allow these temporary/local test listeners. Neither opt-in real Docker
integration script was executed.

Additional checks:

```text
/usr/bin/python3 -m compileall -q gate gatectl tests
./gatectl lifecycle-policy --help
./gatectl lifecycle-export --help
./gatectl lifecycle-approve --help
```

All returned exit0. Tests also exercise all six new help commands without Docker,
host export with fake admin output, real private admin socket transport, token
separation over real local HTTP, concurrent submissions, all final identity/version
mismatch variants, manual wait/recovery timestamp preservation, deployment/rollback/
upgrade exclusion, and HTTP responsiveness during a blocked poll. No key security
test merely searches production source text.

## Remaining concerns / integration boundary

1. **No real Docker/Pi/Hub/browser E2E was run.** Main owns separate Hub fixes and end-to-end validation, including handoff timing and real supervisor process behavior. Gate's fake transport coverage is not a claim that deployed images were validated.
2. **Host bind provenance remains a trusted launcher/administrator boundary.** Gate rejects dangerous known sources/destinations and requires the reviewed layout, but Docker inspect alone does not prove an arbitrary daemon-host bind source's symlink target. Gate lacks the daemon host filesystem namespace. Do not enable this for arbitrary host-created lookalike containers or hand ordinary Pi Docker/Gate authority. A stronger hostile-host-bind proof would need separately approved launcher/host attestation; this task does not invent that authority or silently claim it exists.
3. **Nonstandard mounts/security options fail closed.** Reviewed launcher data mounts are covered, including writable CC Switch models, Hugging Face cache, readonly Hub registration volume and optional readonly VS Code bridge. Other variants require explicit review, not relaxing checks on live services.
4. **Unknown outcomes with vanished/replaced targets remain blocked.** Resolve cannot force-clear a container/config-generation mismatch; it only records verifiable host inspection while preserving history. A separate host recovery decision is required if target identity cannot be re-established.
5. **A transient control/inspect failure is conservative recovery_required**, not a retry. The maximum155-second execution budget includes asynchronous checking, so unusually slow preflight can expire before supervisor's full stop30/start120 sequence finishes. Host inspection must not retry the stop.
6. The prior short-entrypoint concern is resolved in Task 1 round1: the inspected staged Dockerfile now uses `/usr/local/bin/pi-entrypoint`. Gate enforces that exact value. Hub implementation remains untouched and must consume started_at under the coordinator's correction.

TDD, verification-before-completion and local security/self-review guided the
changes. No independent reviewer was spawned because the task expressly forbids
child agents; parent-scoped review can inspect these staged files next.

---

# Historical Task 2 checkpoint — PAUSED (superseded by final report above)

Date: 2026-10-17 (Asia/Shanghai).

Paused at the coordinator's explicit request pending Task 1 fixes for blocking lifecycle acknowledgment/replay defects. No Task 2 production implementation has been written. Do not interpret this checkpoint as completion.

## Files changed

- Added `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate/tests/test_lifecycle.py`.
- Added this checkpoint report.
- No Engine, Store, service, admin, gatectl, Hub, supervisor, or launcher implementation files modified.
- No git commands, child agents, live Docker/Gate operations, real credential access/export, deployment, or privilege enable performed.

## Inspection completed

Read the Task 2 brief and inspected existing Gate Engine, Store, service, admin, gatectl, deployment router, representative Gate tests, Task 1 supervisor control/status implementation, and Hub `hub/lifecycle.ts` consumer (read-only).

Planned implementation: independent lifecycle tables/policy in existing SQLite with Store RLock; separate private token; exact lifecycle HTTP routes; immutable trusted-container resolution; fixed bounded control exec; shared deployment/lifecycle admission; durable intent before restart; status-only recovery; explicit host administration/export.

## Test checkpoint / RED evidence

Working directory:

`/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/gate`

Command:

```text
/usr/bin/python3 -m unittest discover -s tests -p test_lifecycle.py -v
```

Latest run, before any production changes:

```text
Ran 21 tests in 1.026s
FAILED (failures=21)
```

Exit status 1; zero test errors. All failures explicitly identify missing Gate lifecycle API or missing Engine fixed lifecycle exec.

Earlier attempts encountered sandbox restrictions on local test sockets and then one missing-method test error. The test guard was corrected before the latest clean RED run. The latest run used approved permission to bind temporary fake Docker Unix sockets/local test HTTP listeners; no live Docker daemon was contacted.

Tests currently cover disabled/default token isolation, manual approval/rejection, auto success with SQLite intent visibility before exec, policy fences, target config rejection, stale/busy identities, idempotency/conflicts, deployment approval/rollback/upgrade exclusion, mismatched final/ack operations, transport uncertainty, crash recovery without replay, HTTP token separation/body limits/sanitization, and fixed exec multiplex framing/exit/output constraints.

No GREEN run or full Gate suite run yet. More focused cases are still needed after initial implementation (including broader final verification variants, host CLI/export/resolve, asynchronous checking-phase behavior, concurrency and responsiveness).

## Coordinator update to preserve

Task 1 independent review found blocking lifecycle acknowledgment/replay defects. Original Task 1 implementer will fix these before Task 2 resumes.

HTTP/control contract remains unchanged: restart now promptly returns `running/checking`, then validates asynchronously. Current test fake returns `running/prepared`; revise it to the corrected frozen Task 1 behavior on resume and test the checking phase explicitly. Gate must not require a pre-existing `expected_version` in the immediate acknowledgment; validate final operation evidence from status polling. Job ID must remain equal to idempotency key and supervisor operation ID. Recovery must query status only, never replay restart.

## Known integration concern from read-only inspection

The inspected staged `pi-docker/Dockerfile` currently declares `ENTRYPOINT ["pi-entrypoint"]`, whereas the Task 2 brief requires trusted launcher entrypoint `/usr/local/bin/pi-entrypoint`. Task 2 should enforce the brief and coordinate any launcher/image correction outside its scope. No out-of-scope change made.

## Next step after explicit resume

1. Read Task 1 fix/review handoff and recheck corrected acknowledgment/status semantics without editing Task 1 or Hub.
2. Adjust precise fake control behavior and add focused tests for asynchronous `running/checking` and subsequent failure/success/recovery evidence; run RED before implementation.
3. Implement Gate lifecycle storage/API/fixed Engine exec and host administration within the allowed Gate directory, preserving existing staged code.
4. Run focused GREEN and the entire Gate suite using only fake Engine/temporary state; self-review integration and exclusion paths.
5. Replace this checkpoint with the final report including exact admin usage, files, test totals, and remaining concerns.

No further implementation or edits are authorized during this pause.
