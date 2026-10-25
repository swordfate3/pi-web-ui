# Hub Unified Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Administrators approve, reject, roll back and configure existing Gate tasks from Hub, with extension requests discoverable beside them.

**Architecture:** Add a dedicated restricted Gate management protocol, a trusted Hub proxy and a portal approval section. Retain independent execution and existing authentication boundaries.

**Tech Stack:** Python standard library/SQLite, TypeScript/Node HTTP, existing server-rendered Hub portal, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-hub-unified-approvals-design.md`

## Global Constraints

- Gate remains independently deployed; no Docker/admin socket is mounted in Hub.
- Dedicated management token only, never the request/lifecycle token; credential and upstream private bodies never reach browsers.
- Management origin + existing login + CSRF required; chat-origin routes cannot approve.
- Explicit reviewed revision + unique decision ID; unknown outcomes are reconciled, not retried.
- Existing trusted image allowlists are preserved by web policy changes.
- Only isolated temporary tests; do not deploy/restart or touch production state.

### Task 1: Restricted Gate approvals

**Files:** Create `integrations/runtime-updater/gate/gate/hub_management.py`, `integrations/runtime-updater/gate/tests/test_hub_management.py`; modify `gate/service.py`, `gate/admin.py`, `gatectl` under the same Gate integration.

**Interfaces:** Produces the Gate protocol in the spec exactly, including durable receipts and private bootstrap `hub-management-export`. Existing Gate execution methods remain the sole executors.

- [x] Add temporary Gate HTTP tests first; assert a request token receives 401 at the new routes and the dedicated token can read a safe pending deployment.
- [x] Add approval/rejection and receipt tests: `POST /v1/hub-management/decisions` with the exact task revision changes the existing real Store task; replay leaves one execution; changed payload/stale revision conflict.
- [x] Implement bounded `HubManagement` in a separate module, dedicated credential creation/export, fixed routing and safe projections; cover runtime/restart approvals, intent rejection, rollback, policies preserving image lists and resume.
- [x] Run `python3 -m unittest discover -s tests -p 'test_hub_management.py' -v` and affected existing Gate suites from the integration directory. Commit the task and report evidence.

### Task 2: Trusted Hub transport and inbox

**Files:** Create `hub/gate-management.ts`, `tests/hub-gate-management.test.ts`; modify `hub/config.ts`, `hub/server.ts`, `hub/restart-api.ts`, `hub/interactions.ts`, `tests/hub-interactions.test.ts`.

**Interfaces:** Consumes Task 1 HTTP protocol; produces identical sanitized result under `/api/management/gate`, optional `HubConfig.gateManagement`, management status `gateManagementAvailable`. Produces `GET /api/management/interactions` metadata inbox with `items`, `unavailable`, `truncated`; entries contain generation, requestId, adapterId, action, deadline, path only.

- [x] Write real Hub HTTP integration tests proving unauthorized/chat requests cannot reach Gate and valid management+CSRF decisions are forwarded once.
- [x] Add loopback provider with request/response bounds and timeout; validate exact schemas and reject route suffix/query/body abuse. Revalidate management after async operations.
- [x] Add authenticated extension metadata enumeration using verified current session targets and bounded channel concurrency. Keep existing per-request review behavior intact.
- [x] Run focused Hub transport, management and interaction tests. Commit task and report evidence.

### Task 3: Portal approvals and policy controls

**Files:** Create `hub/approvals-portal.ts`, `tests/hub-approvals-portal.test.ts`; modify `hub/portal.ts`, `hub/runtime-portal.ts` and affected browser tests.

**Interfaces:** Consumes Task 2 endpoints and `auth.gateManagementAvailable`. Exposes a portal module with `updateAuth`, `clearProtected`, `poll` integrated with existing authentication lifecycle. DOM contains task lists, explicit decision confirmation, receipt reconciliation, policy selectors and extension-review links.

- [x] Add behavior tests for one explicit approve, cancelled confirmation, reject, policy switching, stale revision and lost-response reconciliation without replay.
- [x] Build a mobile-friendly section above runtime updates, with scoped task details and an explicit review confirmation; preserve in-flight receipt IDs in session storage and clear private views on lock.
- [x] Point existing manual runtime/restart instructions to the portal approval section when configured. Show configuration-required state on older deployments.
- [x] Run focused portal and management regression tests; commit and report.

### Task 4: Integration, docs and rendered validation

**Files:** Update `docs/hub.md`, `docs/web-interactions.md`, `docs/development-log.md`, add `docs/validation/2026-10-25-hub-unified-approvals.md`, rebuild `dist/`.

- [x] Document one-time private credential bootstrap, optional Hub config, daily phone approvals, policy impact and recoverable unknown outcomes. Do not claim enrollment proposals execute without a registered service.
- [x] Run Python affected suites, Hub focused regression suites, type checks and required formatting/build checks; run `npm run build:web` and `npm run verify:dist`.
- [x] Follow the repository visual-check skill for real rendered synthetic desktop/phone portal states; inspect screenshots and fix visible issues.
- [x] Review the entire branch for privilege expansion, lost ACK retries, stale policy/task races and incomplete UI flows. Keep work on feature branch and report deployment requirements clearly.
