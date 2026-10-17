# Whole-branch independent review brief

Review only after controller explicitly releases this brief against stable source.
You are a senior reviewer. Perform a broad plan/quality/security review yourself;
do not spawn subagents. This is a fresh whole-branch review, not another narrow
rerun of already resolved findings. Do not edit product code, Git state or any
deployment. Write only `docs/validation/managed-restart-final-review.md`.

## Binding requirements

Read `docs/superpowers/specs/2026-10-17-managed-pi-restart-design.md`, the matching
implementation plan, `managed-restart-security-rulings.md`,
`managed-restart-timing-ruling.md` and progress/report evidence in this directory.
Later accepted rulings supersede earlier design shorthand: separate management
browser origin; conservative image-owned pre-SDK guard; bounded210s total with
immutable execution start; preserve ordinary15s recovery.

The goal is one Gate-authorized restart of one Pi child, applying an already
installed executable, with unchanged container/terminal/saved session/leaf and
unrelated Pi. No Docker restart, automatic update/retry, replay, force-kill,
resume-latest, or privileges in ordinary Hub/Pi. Default lifecycle is disabled.

## Full source scope, including untracked files

This feature is uncommitted on `codex/pi-runtime-restart`. Git HEAD7f4c19e is a
design-only commit; base `origin/main`39176c9. Read working-tree diff against base,
**plus all new source files**; ordinary `git diff` omits untracked files.

- Hub: `hub/config.ts`, `management.ts`, `lifecycle.ts`, `restart-api.ts`,
  `server.ts`, `portal.ts`; `bin/pi-web-hub.mjs`.
- Extension: `extensions/mirror-server.ts`, `session-registration.ts`, new
  `runtime-control.ts`, `runtime-metadata.ts`, `runtime-stdin-guard.mjs`.
- Browser: `src/web/src/core/pi-client.ts`, `types.ts`.
- Build/install: `scripts/web-dist.mjs`, `test-git-install.mjs`, package inventory,
  `tsconfig.connection.json`, `biome.json`, rebuilt tracked `dist/` manifest and
  Hub bundle. Minified assets need correspondence verification, not line review.
- Tests: all new `tests/hub-*management*.test.ts`, `hub-lifecycle.test.ts`,
  `hub-restart-api.test.ts`, `runtime-control.test.ts`,
  `runtime-guard-process.test.ts`, `pi-client-managed-restart.test.ts`; changed
  registration/build/workspace-upload tests; all `e2e/harness/*managed*` and
  guard/hostile-origin harnesses and `e2e/fixtures/stdin-guard-probe.ts`.
- Host runtime source is outside this Git repository in sibling
  `../pi-runtime-restart-work/pi-docker`: new `runtime/`, changed Dockerfile,
  pi-entrypoint, scripts/pi-pirun and relevant tests.
- Host Gate source is in sibling `../pi-runtime-restart-work/gate`: changed
  gate/{admin,engine,service,store}.py, new lifecycle.py/lifecycle_contract.py,
  changed gatectl/README and new lifecycle tests.
- Host original comparisons are the existing `docker_files` source directories;
  controller supplies an exact changed-path manifest. Do not inspect private
  credentials/state, or use production management endpoints.
- Deployment/upgrade/rollback documentation: `docs/managed-pi-restart.md`,
  docs/hub.md, ADR0013, staged Gate README.

## Focus of broad pass

Look for cross-component gaps, unsafe execution/state/authorization races,
inaccurate persistence/migration claims, accidental behavior changes to legacy
Pi/Gate/Hub, restart/resume identity loss, disconnect/rejected recovery, weak
tests and clean-checkout/build portability. Check whether the new host-only
upgrade reservation can safely migrate an older Gate without silent fallback.
Reconcile proof, deadlines, exact successor and image guard across components.

Earlier task reviews are evidence, not substitutes for reading source. Do not
reopen accepted design tradeoffs without a concrete new broken invariant.
Do not infer test success from reports as if independently run. Any optional new
probe must be isolated and nonmutating to production; socket/Docker tests need
controller to arrange permissions. No production/source installation has occurred.

## Output

State strengths, concrete issues by actual severity with file:line + impact +
fix guidance, recommendations, and explicit Spec and Quality/Ready-to-commit
verdicts. Distinguish code defects from acknowledged deployment prerequisites
(separate authenticated admin HTTPS, new images/explicit container recreation,
default-disabled policy). Record supplied versus independently verified evidence.
