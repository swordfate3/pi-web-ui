# Hub Create Pi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch an independent managed Pi from Hub using an existing directory under the configured gitproject root.

**Architecture:** Dedicated management protocol in Gate; private fixed Docker launch profile; Hub directory picker and bounded job polling. Reuse existing grant CLI with fixed operations and per-run credential file, not a host shell.

**Tech Stack:** Python standard library/SQLite/Docker HTTP, TypeScript/Node HTTP, server-rendered portal, Node test runner and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-hub-create-pi-design.md`

## Global Constraints

- Selectable deployment root `/home/fate/gitproject`, initial `pi_projects`; existing directories only.
- No production operations, credentials or volumes. No push, merge, deploy or running-service restart.
- Dedicated Hub management credential only; Hub/Pi never receive Docker or Gate admin socket.
- Browser cannot select images, arbitrary commands, environment or auxiliary mounts; UID/GID1000, no-new-privileges, cap-dropALL.
- Unknown writes are queried, never automatically replayed; no deletion of projects, volumes or unrelated containers.
- Maximum16live/unresolved launches,256retained jobs,4096scanned directory entries,200directories per page.
- Bind selected workspace only; per-run credentials read-only; never share Hub/Gate private state with Pi.

### Task 1: Restricted Gate launch capability

**Files:** Create `gate/pi_launches.py`, `gate/pi_launch_engine.py`, `tests/test_pi_launches.py`, `tests/test_pi_launch_engine.py` under `integrations/runtime-updater/gate`; modify its `gate/service.py` and `gate/hub_management.py`. Setup examples belong in the integration README, not production folders.

**Interfaces:** Implement the five `/v1/hub-management` routes in the spec exactly. `PiLaunches(gate, policy=None, engine=None)` exposes `configuration()`, `browse(path='',cursor=None)`, `submit(value)`, `jobs()`, `get(id)`, `active()`, `tick()`, `recover()`. Gate defaults to disabled; accept optional constructor launch_policy/launch_engine for isolated tests and an explicit `--launch-policy` private JSON file in service main. The private profile must define all host/image/credential sources and is validated before any dispatch. Existing fixed Engine transport is the only Docker boundary.

- [ ] Write real temporary filesystem/Store tests first, including forbidden path `../outside`, absolute and sibling-prefix paths, symlinks, changed inode, duplicate request payload conflict and disabled capability. Assert a normal request token cannot browse/submit through actual temporary Gate HTTP.

  ```python
  response = management_get('/v1/hub-management/workspaces?path=pi_projects')
  assert response['path'] == 'pi_projects'
  assert response['parent'] == ''
  assert response['entries'] == [{'name': 'project-a', 'path': 'pi_projects/project-a'}]
  first = submit_launch(id='a'*32, path='pi_projects/project-a')
  assert submit_identical(first)['id'] == first['id']
  assert launch_side_effect_count() == 0  # queued until tick, not during HTTP
  ```

- [ ] Run the focused tests and record the expected missing-capability RED. Implement no-follow browse, private policy validation, revision-bound durable jobs and token-separated fixed routes. Never put raw private job/template data in HTTP responses.
- [ ] Test the actual fixed Docker engine against a recording fake Unix Docker server: inspect pinned images/Hub, provision distinct grant, create detached TTY with exact allowed mounts/security, start, observe exited and revoke only owned grant. Test ambiguous grant/create/start and stage persistence; no retry after uncertain outcome. Implement bounded worker/recovery and all Gate admission fences.
- [ ] Run focused and existing Gate suites; self-review and commit only integration Gate paths. Report schema, commands/counts, RED/GREEN and limitations to the task report. Independent scoped spec+quality review precedes task completion.

### Task 2: Trusted Hub launch proxy and directory picker

**Files:** Modify `hub/gate-management.ts`, `hub/server.ts`, `hub/portal.ts`; create `hub/launch-portal.ts`, `tests/hub-launches.test.ts`, `tests/hub-launch-portal.test.ts`; modify `tsconfig.connection.json`.

**Interfaces:** Consume Task1 wire contract without translating identifiers. Extend fixed proxy with launch configuration/browse/job schemas and exact POST fields. `createGateManagementApi` may accept a synchronous run_id-to-current-session URL resolver; untrusted upstream URLs are never accepted. Portal module exposes `poll`, `updateAuth`, `clearProtected` alongside existing modules.

- [ ] Add provider/API RED tests for authorized browse and launch, missing management/CSRF/chat-origin refusal, invalid query keys, oversized and secret-bearing responses and no upstream write retry. Exercise a real temporary Hub with fake Gate HTTP only at the external boundary.

  ```ts
  assert.equal((await managementGet('gate/workspaces?path=pi_projects')).path, 'pi_projects');
  assert.equal((await chatPost('gate/launches', request)).status, 404);
  assert.equal((await postWithoutCsrf('gate/launches', request)).status, 401);
  ```

- [ ] Implement strict schema projection, query/body bounds, stale-auth checks and exact run_id URL lookup. Extend route matching without catching unrelated management routes. Test malicious URL projection and auth revocation during awaits.
- [ ] Add portal behavior RED tests for default-directory selection, parent navigation, start confirmation, storage refusal, duplicate clicks, GET-only uncertain-result lookup, unchanged-poll draft preservation and lock clearing. Implement responsive directory form and job cards in the existing management portal, with chat entry linking to management only.
- [ ] Run focused Hub tests and existing management regressions. Self-review; commit task and submit a scoped spec+quality review package.

### Task 3: Disposable integration, rendered validation and delivery docs

**Files:** Add `e2e/hub-launches.visual.ts`, `docs/validation/2026-10-25-hub-create-pi.md`; update `docs/hub.md`, integration setup documentation, `docs/development-log.md`, tracked `dist/`.

- [ ] Verify temporary actual Hub-to-Gate HTTP/SQLite flow, keeping Docker boundary substituted; separately run a disposable real Docker/Pi launch if available and authorized. Do not mark an unavailable real Docker test passed. Ensure normal launch/control remains compatible with existing runtime/lifecycle validation.
- [ ] Follow webui-visual-check at desktop1440x1000 and phone390x844: inspect screenshots of directory selection, confirmation, registration waiting, success and lock. No production session access.
- [ ] Run types, scoped formatting, `just check`, production build then dist verification, sequentially before full packaging tests. Preserve and report existing unrelated formatting baseline errors.
- [ ] Record exact test counts, independent review results, resource cleanup and one-time setup. Commit all source/output correspondence. Obtain final whole-branch review; keep branch/worktree, no deployment or remote mutation.
