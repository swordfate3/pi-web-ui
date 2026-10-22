# Single-Hub native terminal deployment

> **For agentic workers:** Execute with superpowers:executing-plans, test-first and independent review before live changes.

**Goal:** Publish the existing native terminal through the existing Hub and an independent HTTPS origin without restarting existing Pi consumers.

**Architecture:** Gate continues to own immutable Hub publication. An administrator-only policy opt-in adds exactly two readonly provider volumes, accepts the exact old two-volume template for initial migration, and never accepts a partial or writable provider mount. Ordinary jobs retain their policy snapshots. Existing SSH and Caddy gain a separate loopback terminal route; chat stays unchanged.

**Tech stack:** Python stdlib Gate/host tooling, Node Hub, Docker Engine/Compose, SSH, Caddy.

**Spec:** `docs/trusted-terminal.md` and the user's approved single-Hub deployment instruction.

## Global constraints

- Preserve all existing Pi container IDs/start times, Pi 1.3.0, models and settings.
- No Docker socket in Hub or Pi; UID/GID 1000, cap-drop ALL, no-new-privileges retained.
- Provider mounts only `pi-terminal-provider-ipc:/run/pi-terminal-provider:ro` and `pi-terminal-provider-credentials:/run/pi-terminal-credentials:ro`.
- Terminal image is pinned to `sha256:3603564462e1b5b6f3912239aff3605074c2b1f430f068d58809e5b7f242501d`.
- No credentials, pairing codes, private configuration or session contents in public evidence.
- External configuration is first tested in `/tmp/pi-single-hub-terminal-20261022`, then backed up and applied with explicit privileges.

## Task 1: Closed release publication and policy migration

- [x] Extend artifact tests first: a complete fixed terminal inventory (`index.html`, `app.js`, `app.css`) enters the generated context; partial, linked, oversized or duplicate terminal assets fail. Legacy releases without terminal assets remain supported.
- [x] Keep `fetch_bundle(commit)` backward-compatible by returning the existing pair for old releases and a third fixed asset map for complete new releases; make Deployer handle both. Dockerfile instructions remain Gate-generated, never repository-provided.
- [x] Add strict administrator policy field `terminal_provider: true`; preserve absent field/hash semantics. Only this opt-in can add the two fixed RO mounts.
- [x] Test two-to-four migration, exact four-mount validation, partial/wrong/RW mounts and HostConfig option drift rejection, old-container rollback, and old policy snapshots.
- [x] Include `terminal-policy.json` in image sealing and test policy drift invalidates the seal.
- [x] Run full Gate unit suite and inspect all changed trust-boundary code independently.

## Task 2: Host lifecycle compatibility

- [x] Add CLI regression tests that accept the exact four-mount Hub, reject partial/RW/wrong-name mounts, and select the terminal Compose overlay only for the real four-mount Hub.
- [x] Modify `scripts/pi-hub-control.py`, focused tests and the provider-only overlay; preserve fixed ordinary template and no implicit env files. Independent review additionally required explicit `nocopy: true` on both provider mounts.
- [x] Run Pi host unit suite and check rendered Compose against the live immutable image after deployment.

## Task 3: Authorized production rollout

- [x] Capture private source/seal/config backups, immutable images, and a consistent SQLite online backup; recheck Gate is idle and existing Pi baseline.
- [x] Install reviewed external deltas, enable the exact terminal image policy, and use `gatectl build` / reservation-protected `gatectl up`.
- [x] Register the reviewed Hub opt-in through the private admin endpoint and request the exact published Hub commit through Gate. Do not force-recreate Hub outside Gate.
- [x] Verify full assets and RO provider mounts before enabling the terminal listener in private config. Preserve unrelated configuration keys.
- [x] Configure a free local terminal port, restricted separate reverse tunnel and Caddy origin `terminal.swordfate.cn`; backup and validate before reload.
- [x] Verify TLS, all assets, unauthenticated/foreign-origin denials, provider preflight and original Pi IDs/start times. Use only a temporary empty workspace and no model prompts in a disposable native-terminal acceptance run.
- [x] Record exact deployment/rollback results and give user manual pairing/startup steps. Physical-phone acceptance is not inferred from HTTP checks.

## Review and rulings

The tasks share the mount inventory but not an arbitrary template interface. Terminal resource publication is deliberately closed to three browser files and remains compatible with old requests. The migration concession is only the exact legacy two-volume template, not arbitrary missing mounts. No second Hub or new Pi installation is introduced.

## Completion record

See [deployment evidence](../../validation/2026-10-22-single-hub-terminal-deployment/README.md).
Gate399/399; Pi host146 run with3 gated skips; isolated real-Docker migration and
rollback; production-backed real Chromium pairing/WebSocket/native `/model`;
desktop/mobile-emulation screenshot inspection; six original consumers unchanged.
User's additional ordinary consumer was not modified. Public TLS/auth denial was
verified separately; physical-phone and authenticated public WebSocket acceptance
remain explicitly outside the completed automated checks.
