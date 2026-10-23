# Runtime updater integration — development only

This directory is a **reviewable source integration**, not a deployment bundle.
Do not copy it into a running Gate or use the branch's version picker in production.
The approved feature and release gate are in
[`../../docs/superpowers/specs/2026-10-22-hub-version-picker-updates-design.md`](../../docs/superpowers/specs/2026-10-22-hub-version-picker-updates-design.md).

## Ownership and scope

- `gate/gate/`: imported Gate implementation with branch-local catalog, artifact-resolution,
  readiness and trusted test-namespace changes.
- `gate/tests/`: imported runtime/lifecycle tests, their source dependencies and new unit tests.
- `pi-runtime/`: the image-owned supervisor, input guard, session-control and launch-policy
  baseline. These files are not installed or started by the Web extension.
- `provenance.json`: original source paths and original SHA-256 values, before branch edits.
  These are provenance records, not current-file checksums or deployment authorization.
  Source import may normalize a final newline.

No live configuration, policies, credentials, Gate database, private deployment records,
sessions or caches were imported. Ordinary npm installation excludes this integration area
via the package's `files` whitelist. Importing a Python module does not start Gate.

`gate/gatectl` is an imported host-CLI source snapshot used by client unit regressions.
It retains the production container-name default and must **not** be run against the
host Docker daemon or used by the isolated acceptance harness. No deployment entrypoint
is supplied by this integration directory.

## Current implementation boundary

Implemented in the development sources: bounded official version discovery and exact
integrity-pinned resolution; guarded npm transport; separate prepare, offline behavioral
validation and atomic activation; complete dependency-tree/profile evidence; measured
source admission; private pre-stop restoration with a bounded input-freeze lease; pinned
successor execution; idle-only refresh and conservative interrupted-operation recovery.
There is no Pi release-number allowlist. A newly published exact stable version can be
evaluated without editing one, but publication or installation is never compatibility
evidence. An incompatible adapter, session format, Node engine or image profile still
blocks the requested transition.

**Current-source isolated acceptance passed:** a real browser/Hub/Gate/Docker flow
upgraded two official Pi processes `1.3.0 -> 1.4.0` and rolled them back to `1.3.0`.
A generating consumer finished before its refresh; an incompatible-session rollback
was refused before stopping its original process. Exact evidence and limitations are in
[`../../docs/validation/2026-10-22-version-picker-progress.md`](../../docs/validation/2026-10-22-version-picker-progress.md).

No production Hub/Gate/Pi container was changed for this integration. User-authorized
local main integration is separate from a production deployment; ordinary extension
installation does not deploy Gate or image-owned supervisor/guard sources.

## Offline unit verification

Run from the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/gate/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/gate/tests -p 'test_runtime_[!h]*.py'
```

This pattern deliberately excludes `test_runtime_http.py`, which opens a localhost TCP
server. `test_runtime_discovery_http.py` exercises the actual request handler/authentication
in memory; despite its filename, it is **not** a TCP integration test. External boundaries
are fixtures in the scheduler/engine tests; those do not establish Docker or Pi compatibility.

The complete runtime suite requires permission to bind a temporary local port:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/gate/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/gate/tests -p 'test_runtime*.py'
```

## Isolated real-package acceptance

The dedicated `tests/runtime_test_bootstrap.py` factory requires
`runtime_volume='pi-runtime-update-test-<hex>'`,
where `<hex>` contains 12–32 lowercase hexadecimal characters. All other non-default
volume names are rejected. No HTTP/browser request may choose this setting.

Production retains the default `pi-runtime`. The test factory rejects that default,
omission and malformed alternatives before constructing Gate/RuntimeEngine or calling
the resource engine. Use the real acceptance harness below, with only
synthetic homes, sessions and workspaces, a faux model
provider, uniquely named containers and an explicit image identity. Never mount production
home/runtime/session volumes, SSH credentials, model credentials or the production Gate
state. Candidate execution must have no network and no production state access.

The opt-in real harness is `tests/real_version_acceptance.py`. It starts a temporary
Gate and built Hub, creates a new test runtime volume and two real official Pi processes,
then uses a real browser to select `1.4.0` and `1.3.0`. It checks actual process versions,
unchanged container identity, saved history/leaf, provider/model/thinking and browser
reconnection. `PI_RUNTIME_ACCEPTANCE_BUSY=1` also holds one real synthetic generation
until the other consumer has adopted the new version, then verifies its deferred refresh.
Only the model responses are simulated. `tests/probe_acceptance.py` and
`tests/candidate_acceptance.py` are narrower checks, not full transition acceptance.

Example, after building the dedicated image described by `tests/Dockerfile.acceptance`:

```sh
PI_REAL_DOCKER_TEST=1 PI_REAL_BROWSER_TEST=1 \
PI_RUNTIME_TEST_IMAGE=pi-runtime-update-test:<dedicated-test-tag> \
PYTHONDONTWRITEBYTECODE=1 python3 integrations/runtime-updater/tests/real_version_acceptance.py
```

When the installed Chromium differs from Playwright's default revision, explicitly set
`PI_E2E_BROWSER_EXECUTABLE` to the installed test browser. The harness must not install
or borrow user credentials to make a test pass. Evidence and screenshots are written
under `.tmp/runtime-version-acceptance/<unique-namespace>/` and cleanup uses exact IDs.

The required acceptance includes actual `1.3.0 -> 1.4.0`, compatible rollback,
incompatible-session refusal before stopping the source process, active-generation
deferral and mobile/browser checks. These passed on the frozen test image recorded in
the validation report. Recovery/fault-injection coverage is scheduler/transport fixture
coverage, not a real daemon-crash or power-loss experiment.
Cleanup must use recorded exact test resource identities; do not use broad prune commands.

Offline bootstrap regressions (no Docker resources are created):

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/tests -p 'test_runtime_test_bootstrap.py'
```
