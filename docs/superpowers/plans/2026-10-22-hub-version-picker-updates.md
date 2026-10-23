# Validated Hub Version Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select an official Pi release in Hub and verify installation plus safe process refresh without a source-version allowlist.

**Architecture:** Gate resolves official releases and owns durable validation/activation; Hub is an authenticated request-only client. Image-owned runtime controls retain input/session safeguards. Gate/runtime sources are imported into an integration directory rather than editing live host files.

**Tech Stack:** TypeScript/Node, Python standard library, Docker, real Pi TUI, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-22-hub-version-picker-updates-design.md`

## Execution status (2026-10-23)

Implementation, independent finding resolution, current-source two-consumer
upgrade/rollback, busy deferral and incompatible-session refusal are complete.
Exact evidence, remaining limitations and skipped optional tests are recorded in
`docs/validation/2026-10-22-version-picker-progress.md`. Recovery/fault cases use
scheduler/transport fixtures rather than real power-loss injection. The initial
baseline/checkpoint sequencing deviation is retained at the end of this plan.

The user's later instruction explicitly authorizes local main integration after
acceptance. It supersedes the original development-only no-merge constraint;
remote push and production deployment/restarts remain out of scope.

## Global Constraints

- Do not deploy production Hub/Gate/runtime. Local main integration is authorized only after acceptance.
- Use only `@earendil-works/pi-coding-agent` from the fixed HTTPS npm registry.
- Browser requests identify an exact version, not a package name, registry, tarball URL, command, volume, image, or compatibility override.
- Manual jobs wait for host approval; auto jobs proceed under existing policy.
- A successful installation is not a completed process refresh.
- Busy, pending, tainted or unknown input state cannot be cleared to force an update.
- Tests use unique temporary state/volume/container identities, never production volumes or credentials.
- `dist/` remains tracked and must correspond to source changes.
- Initial acceptance requires real `1.3.0 -> 1.4.0`, compatible rollback and incompatible-session refusal.

## Source layout

`integrations/runtime-updater/gate/` contains the imported Python Gate package and selected unit tests. `integrations/runtime-updater/pi-runtime/` contains the image-owned supervisor/guard/control source. `integrations/runtime-updater/provenance.json` records original paths and baseline content hashes, never operational data. Normal npm distribution excludes the integration directory.

New Gate modules separate registry/catalog (`runtime_catalog.py`), candidate evidence (`runtime_validation.py`), and installation (`runtime_install.py`). Existing scheduler remains the authority for idempotency, approval and refresh. Hub client and portal remain separate files.

### Task 1: Reviewable baseline and isolated test boundaries

**Files:** Create `integrations/runtime-updater/{gate,pi-runtime}/`, provenance and integration README. Existing host sources are read-only inputs.

**Interfaces:** Imported Gate preserves its package imports. Test/bootstrap configuration can select an explicit test runtime volume; HTTP request fields cannot.

- [x] Import only source `.py`/runtime scripts and runtime/lifecycle unit tests using `apply_patch`; record SHA-256 baselines.
- [x] Run baseline Gate runtime tests and extension runtime tests before behavior changes.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/runtime-updater/gate/tests -p 'test_runtime*.py'
NODE_OPTIONS='' PI_OFFLINE=1 node --import ./tests/register-ts.mjs --test tests/runtime-control.test.ts tests/runtime-guard-process.test.ts
```

- [x] Add a failing test that a test helper cannot reference production `pi-runtime`; implement trusted runtime namespace configuration and reject browser overrides.
- [x] Verify exact test cleanup targets and record the baseline/checkpoint sequencing deviation below.

### Task 2: Official catalog, exact resolution and readiness

**Files:** Create Gate `gate/runtime_catalog.py`, `tests/test_runtime_catalog.py`; modify `gate/service.py`, `gate/runtime_updates.py`.

**Interfaces:** `RuntimeCatalog.catalog(query='', cursor=None)` returns `{status, checked_at, versions:[{version}], next_cursor?}`; `RuntimeCatalog.resolve(version)` returns a pinned `{version, integrity, tarball, node}` record. `RuntimeUpdates.readiness()` returns `{status, consumers:[{run_id, version?, ready, reason?}], installed_version?}`. GET `/v1/runtime-versions?query=...&cursor=...` and `/v1/runtime-readiness` use the lifecycle/runtime credential.

- [x] Write failing real-parser/cache tests: numeric sorting, stable-only filtering, page/search limits, stale timestamp, redirects/oversize/errors, exact release identity and strict integrity/origin.

```python
def test_stable_catalog_is_numeric_not_lexical(self):
    source = self.registry({'versions': {'1.9.0': {}, '1.10.0': {}, '2.0.0-beta.1': {}}})
    self.assertEqual([r['version'] for r in source.catalog()['versions']], ['1.10.0', '1.9.0'])
```

- [x] Run the tests, observe the expected missing-feature failure, implement bounded fixed-origin registry fetch/cache and exact resolution.
- [x] Persist exact resolution into a submitted job before approval; preserve idempotent return without another remote request for the same ID/version.
- [x] Add auth/field-filter tests for catalog/readiness. Existing manual/auto policy semantics remain.
- [x] Run Gate runtime regression tests and commit.

### Task 3: Hub version picker and management API

**Files:** Modify `hub/runtime-updates.ts`, `hub/restart-api.ts`, `hub/runtime-portal.ts`, `hub/portal.ts`; add/extend `tests/hub-runtime-api.test.ts`, `tests/hub-runtime-portal.test.ts`.

**Interfaces:** Gate projections above are strictly validated by `GateRuntimeUpdates.catalog({query?,cursor?})` and `.readiness()`. Browser management routes are GET `/api/management/runtime-versions` and `/api/management/runtime-readiness`; no browser-provided registry URL or compatibility overrides.

- [x] Write failing HTTP and portal tests for selectable published versions, query/paging, unavailable/stale results and consumer blockers.

```ts
assert.equal((await fixture.request('runtime-versions')).status, 200);
assert.equal((await fixture.request('runtime-versions', { registry: 'https://evil.invalid' })).status, 404);
```

- [x] Implement the bounded typed Gate client, protected routes and picker while retaining durable idempotency and original-ID ambiguous-result queries.
- [x] Distinguish catalog existence from validation; retain manual approval text and show exact task ID.
- [x] Extend user-facing stage labels for resolving/validating/incompatible/blocked states without inventing success.
- [x] Run targeted tests, connection TypeScript, full unit/static/build/dist checks; inspect desktop/mobile screenshots with the visual-check skill. Commit matching built assets.

### Task 4: Candidate validation and safe activation

**Files:** Gate `runtime_install.py`, new `runtime_validation.py`, `runtime_engine.py`, `runtime_updates.py`, corresponding tests; extension `runtime-control.ts` and runtime supervisor/guard integration sources/tests.

**Interfaces:** A durable validation record binds candidate tree hash, package integrity, image/Node identity, adapter/probe contract and Web extension digest. Only Gate accepts it. Candidate evaluation has no production state/network. New exact versions are evaluated rather than rejected by static source sets.

- [x] Write failing tests that a future exact version reaches candidate evaluation, failed validation never changes the entrypoint, evidence cannot be replayed across differing content/profile, and mutable local evidence cannot grant authority.

```python
self.assertEqual(before_entrypoint, after_failed_validation_entrypoint)
self.assertEqual(self.docker.restarts, [])
```

- [x] Replace static allowlists with protocol/evidence admission, keeping old-process guard/eligibility checks and conservative unknown-state rejection.
- [x] Implement integrity-bound preparation and full tree hashing, dependency/script restrictions, durable prepare/validate/activate phases and changed-entrypoint fencing.
- [x] Run real candidate PTY/extension probes for terminal input, barriers, async commands, generation, session/leaf/model/thinking preservation. Validate current source processes as well as destination release.
- [x] Add pre-stop session-compatibility checks against disposable local snapshots; incompatible/unknown formats block without mutating original history.
- [x] Add preparation/activation crash, policy-change and ambiguous-outcome regressions; run complete imported runtime/lifecycle suite and extension unit suite. Commit only if behavior and review pass.

### Task 5: Real upgrade/rollback and whole-branch acceptance

**Files:** New isolated integration harness under `integrations/runtime-updater/tests/`, Playwright flow under `e2e/harness/`, validation report under `docs/validation/`; update `docs/hub.md` and integration README.

**Interfaces:** Harness requires explicit opt-in, fixed test image, unique test volume and synthetic provider/session state. It runs the built Hub, real Gate, real Docker/Pi and a browser; mocks are limited to registry fault fixtures and model responses.

- [x] Create isolated real test resources, install initial official `1.3.0`, and verify actual process version before accepting the fixture.
- [x] Browser selects `1.4.0` and submits once; assert real process versions, session preservation, unchanged container IDs, idle/busy scheduling and reconnect behavior.
- [x] Select `1.3.0` for compatible rollback; run incompatible-session refusal before source stop. Capture structured, redacted evidence.
- [x] Exercise duplicate submission, network failure, tampered candidate, policy denial and Gate restart without duplicate side effects.
- [x] Run regression suite, inspect desktop/mobile screenshots, obtain independent code review, and resolve load-bearing findings.
- [x] Record each specification acceptance row as pass/fail/not-run, exact commits/artifact identities, commands and cleanup. No skipped integration test is a pass.
- [x] Keep production unchanged; report tested transitions/limits and honor the later local-main-only integration decision.

## Self-review and execution decision

Tasks 2/3 share the catalog/readiness schema; Task 4 extends existing job stages without changing exact-version/idempotency semantics. Task 5 consumes all earlier interfaces and blocks any completion/deployment claim if evidence is missing. The approved request is to proceed in this session: use a bounded Hub implementer and independent reviewers for disjoint work while the main agent owns coupled Gate/runtime integration. Do not pause again for an execution-style choice.

## Development checkpoint ruling

The baseline import and discovery changes are being saved together in one explicitly
incomplete local checkpoint, rather than manufacturing a separate pristine-baseline
index after implementation. Original source hashes remain in `provenance.json`, and
task reviews compared the changes against those read-only original sources. This
trades a larger checkpoint diff for preserving the tested work as-is. It does not
close Tasks 4/5 or authorize merge, push or deployment by itself. Tasks 4/5 were
subsequently completed under the later local-integration authorization. See the progress/acceptance
boundary in `docs/validation/2026-10-22-version-picker-progress.md`.
