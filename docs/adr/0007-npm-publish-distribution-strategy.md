# ADR 0007: Prebuilt frontend for Git and npm installation

## Status

Accepted; replaces the earlier prepack/prepare-build decision. That decision incorrectly assumed Pi Git installs included development tools.

## Context

The frontend builds with TypeScript/Vite to about 25 MB / 672 output files. Pi 1.1's managed Git install invokes `npm install --omit=dev --legacy-peer-deps`. npm runs prepare, but TypeScript/Vite are intentionally development dependencies. The old prepare attempted to build, requiring `npm_config_include=dev` as a workaround and roughly 500 installed packages. Git updates to a changed commit reset/clean the managed checkout and reinstall production dependencies, so an untracked dist also cannot survive an update reliably.

The extension imports Node built-ins, host-provided Pi APIs and `ws`. React, Zustand and the diff renderer are bundled by Vite; users of prebuilt assets do not need their source packages installed.

## Decision

- Commit complete prebuilt `dist/` together with its corresponding source changes on the installation branch (currently main). The plain `pi install git:github.com/swordfate3/pi-web-ui` command remains the supported path.
- `prepare` runs a Node-only integrity check, not a build or download. `build:web` runs TypeScript/Vite and writes `dist/build-manifest.json`. `prepack` still builds when a maintainer prepares an npm tarball.
- The optional hub CLI is also prebuilt with Vite into `dist/hub/pi-web-hub.mjs`, with Node built-ins and `ws` external. Its package `bin` points at this JavaScript file: Node cannot strip TypeScript directly inside `node_modules`. Source inventories include `hub/`, `bin/` and `vite.hub.config.ts`; consumers do not need a runtime compiler.
- The standalone Hub build embeds the package version and fixed source-inventory SHA-256 before generating outputs. It uses the same source policy as the final manifest (not the previous manifest or an output hash), so it remains descriptive and consistent when deployed without adjacent package/manifest files. Source execution still reads disk metadata; neither path proves authenticity.
- `dependencies` contains only `ws`; frontend dependencies live in devDependencies. The host Pi package remains a peer, not a nested runtime.
- Manifest inventories are deterministic SHA-256 lists for fixed source inputs and all output files, with no timestamps, credentials or machine paths. Source inputs include connection runtime modules and the remote-access plan/gateway files imported into the browser bundle, even though those files live outside `src/web/`. Local HTML script/CSS/modulepreload references must resolve to present dist files. Symlinks and non-normalized paths are rejected.
- Git prepare checks both source and output, except the installed package-lock bytes (npm may rewrite lock metadata). CI/default `verify:dist` includes lock bytes. A source-less npm tarball checks assets only; partially missing source trees fail.
- CI verifies the checked-in source/output correspondence before rebuilding, checks rebuilt output parity, runs unit/E2E tests, and tests plain Pi install/update against an isolated Git snapshot with production-only dependencies.

Hashes detect stale/missing/changed files relative to the manifest. They do not prove authenticity against someone able to replace both files and manifest, and are not an OS-user TOCTOU isolation boundary.

## Alternatives

- Building in prepare: rejected, shifts tool installation/compilation risk to users.
- Downloading GitHub release assets in prepare: rejected for this change; adds a network/verification/fallback path and asset-ref coordination beyond Git itself.
- Dedicated prebuilt release branch: useful later if main's asset churn becomes expensive, but adds promotion and ref-management steps. Not required for the current plain-main installation goal.

## Consequences

Users install production dependencies only and receive matching frontend/extension files. Developers run `npm run build:web` explicitly after editing source and commit updated dist. Missing assets fail installation with build guidance rather than installing an empty frontend. Git history now carries generated bundles and hash filename churn, an explicit trade-off for the simplest reliable installation.

Pi's same-HEAD package update may skip prepare when dependencies already exist. It is not a general repair command for a manually corrupted checkout. In that case remove/reinstall the Git package after preserving any local work; managed installs are not development worktrees. Development dependencies can still have audit warnings; production dependency audit and development audit are different evidence.

Node requirement is the package's `>=22.19.0`, not the older ADR's Node 18 assumption. No npm publication, remote push, existing settings switch or user session reload is authorized by this ADR itself.
