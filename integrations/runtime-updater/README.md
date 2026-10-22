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

Implemented: bounded official catalog; exact stable release metadata resolution; a pinned
top-level artifact integrity record before approval; idempotent request replay; authenticated
catalog/readiness projections; a trusted bootstrap-only test runtime namespace.

**Not implemented:** the candidate behavior-validation pipeline, full installed-tree
integrity binding, execution-profile evidence, pre-stop downgrade/session checks and
dynamic-version runtime admission. The imported installer and Web runtime-control
extension still retain the old audited-version guards. A successful catalog lookup or
saved integrity record is **not** proof that installation uses that artifact or that
`1.4.0` can safely replace a running process.

No production Hub/Gate/Pi container was changed for this integration. Main must not be
merged or deployed on the strength of these unit tests.

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

## Isolation requirements for the unfinished acceptance harness

The dedicated `tests/runtime_test_bootstrap.py` factory requires
`runtime_volume='pi-runtime-update-test-<hex>'`,
where `<hex>` contains 12–32 lowercase hexadecimal characters. All other non-default
volume names are rejected. No HTTP/browser request may choose this setting.

Production retains the default `pi-runtime`. The test factory rejects that default,
omission and malformed alternatives before constructing Gate/RuntimeEngine or calling
the resource engine. This factory is not yet a complete acceptance harness. Use only
synthetic homes, sessions and workspaces, a faux model
provider, uniquely named containers and an explicit image identity. Never mount production
home/runtime/session volumes, SSH credentials, model credentials or the production Gate
state. Candidate execution must have no network and no production state access.

The required acceptance includes actual `1.3.0 -> 1.4.0`, compatible rollback,
incompatible-session refusal before stopping the source process, active-generation
deferral, recovery and mobile/browser checks. These have **not** passed for this branch.
Cleanup must use recorded exact test resource identities; do not use broad prune commands.

Offline bootstrap regressions (no Docker resources are created):

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/tests -p 'test_runtime_test_bootstrap.py'
```
