# Remote access onboarding implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a usable bilingual connection wizard and safe terminal-driven Caddy account management on `codex/portable-web-connection`.

**Architecture:** Browser-only generation of nonsecret deployment materials, a standalone Python Caddy administrator, and a local terminal entry. New deployments support one loopback-bound Pi session, OpenSSH and Linux/Caddy; existing compatible multi-session gateways remain a separate, explicitly labelled integration mode. No web endpoint executes SSH, manages passwords, probes arbitrary URLs or writes arbitrary files.

**Tech Stack:** TypeScript/React, Python 3 standard library, OpenSSH, Caddy 2, Node tests, real Pi/Playwright-BDD.

**Spec:** `docs/superpowers/specs/2026-10-14-remote-access-onboarding-design.md`

## Global constraints

- No fixed usernames/passwords, no secrets in forms, scripts or browser storage.
- No changes to the user's current gateway, tunnel, credentials or shared installation.
- Existing deployment credentials remain unchanged until explicit terminal execution.
- Generated materials are pending, not applied; actual authentication is checked separately.
- New multi-session router installation and native Windows/macOS service installation are not supported by this first template. Explain this in the UI and materials.
- The existing isolated clone and branch are retained; user requested branch push, not merge or deployment.

### Task 1: Validated deployment plans and executable login manager

**Files:** `extensions/remote-access/plan.ts`, `extensions/remote-access/gateway.py`, `tests/remote-access.test.ts`, `tests/test_gateway.py`.

**Interfaces:** `validateRemotePlan(input: unknown): RemotePlan`; `gateway.py` exports `update_account(text, domain, old_user, new_user, password_hash, keep_old)` and `apply_config(site_file, candidate, validate, reload)`.

- [x] Tests reject domain/SSH/port/URL injection and unknown credential fields; final Node suite passes. Initial missing-feature run is not separately recorded in the validation report.
- [x] Implement strict schema validation; accept only HTTPS public URLs without credentials/query/fragment and ports 1–65535.
- [x] Python tests cover account preservation, ambiguous configs and validation/reload rollback. Global-order and cross-listener security regressions were observed failing before their fixes and passing afterward.
- [x] Implement a self-contained terminal script: interactive confirmed password via stdin to Caddy, account confirmation, exclusive maintenance lock, backups, full-config validation, reload and rollback. Support host Caddy and explicitly selected Docker Caddy; do not install software or alter firewall/SSH policy.
- [x] Add independent HTTPS verification which checks anonymous rejection and actual new-login success, without redirecting credentials or printing them.

### Task 2: Downloadable materials and bilingual wizard

**Files:** `src/web/src/core/remote-access-materials.ts`, `src/web/src/components/pi-web-ui/remote-access-panel.tsx`, `settings-panel.tsx`, `src/web/src/core/messages.ts`, `src/web/src/app.tsx`, `extensions/mirror-server.ts`, `e2e/features/remote-access.feature`, `e2e/steps/remote-access.steps.ts`.

**Interfaces:** `buildRemoteMaterials(plan: RemotePlan, managerSource: string): {name: string; content: string}[]`; `RemoteAccessPanel({initialTab,onClose})`.

- [x] Real-Pi BDD tests cover first-run skip, settings entry, Chinese/mobile access, validation, generation/pending status and absence of password inputs; both new scenarios pass. Initial missing-UI run is not separately recorded in the validation report.
- [x] Implement local/LAN/remote modes, new-single/existing gateway distinction, dependency and privilege notices, preview and individual file download.
- [x] Persist only validated nonsecret plan JSON in browser preferences when explicitly saved. Cancel/discard does not update Pi connection settings; applying local connection is an explicit generated launch script, never an implicit settings mutation.
- [x] Add `/webui-setup` to open the local listener with `#remote-access`, avoiding any dependency on an already-working public gateway.
- [x] Generate SSH tunnel launch with fixed argument arrays/strictly validated fields, explicit loopback binding and fail-on-forward-error. Existing gateway mode explains native registry/mount requirements and never creates another router.
- [x] Login management downloads the same independent recovery tool, explains terminal-only password entry and shared gateway impact; never shows verified/applied based on script generation.

### Task 3: Verification, documentation and branch delivery

**Files:** `docs/remote-access.md`, `docs/validation/remote-access-onboarding.md`, `docs/development-log.md`, `README.md`, `package.json`.

- [x] Run fresh unit/Python tests, build, Biome and real-Pi browser tests.
- [x] Exercise Caddy authentication/rollback in an isolated fixture; distinguish real Caddy checks from pure parser/transaction checks.
- [x] Inspect desktop/mobile screenshots of the actual real-Pi page. Report lack of in-app Browser/real-phone testing if tools are unavailable.
- [x] Verify package includes deployment script, update usage/recovery limitations and stop transient test services.

Branch-only delivery follows verification: review the final diff, commit, push the existing branch and compare local/remote hashes. The delivery result and exact commit are reported in the handoff, not preclaimed in this pre-commit checklist. No main merge, package publication or real deployment is included.
