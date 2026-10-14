# Git prebuilt installation validation

## Goal and change

Make the ordinary Pi 1.1 Git install/update consume prebuilt frontend files, without TypeScript/Vite or a development-dependency environment override. `dist/` is intended to be committed on the installation ref. `prepare` only runs the Node-built-in checker. Extension production dependencies contain only `ws`; frontend packages and a pinned development-only Pi 1.1 test runner are development dependencies. The host API remains a peer and is not physically installed into the consumer's runtime.

## Actual local evidence

- 72 unit tests passed: existing 55 plus 17 distribution tests (`npm run test:unit`).
- Biome, TypeScript/build, script syntax and diff whitespace checks passed.
- Clean isolated snapshot: `npm ci --legacy-peer-deps` then `npm run build:web` reproduced the full source/output manifest from the development build.
- `scripts/test-git-install.mjs`: real Pi install, changed-commit update and production-only tarball consumer passed. Pi source URL was rewritten only in subprocess configuration to a local temporary Git repository; there was no remote publication and no personal settings change.
- Git consumer contained exactly one physical runtime dependency, `ws`; tarball consumer contained exactly two packages, the root package and `ws`. No React/Vite/TypeScript/nested host Pi was present. These counts are now assertions, not only reported observations.
- A stale-source Git commit was given to a separate real Pi install. npm prepare rejected it with Source inventory mismatch, proving the lifecycle hook is executed, not merely testing the checker after installation.
- Update changed the actual installed commit, deleted an intentionally untracked stale dist sentinel, and verified prebuilt assets after production dependency reconciliation.
- Production `npm audit --omit=dev` reported 0 advisories. This is not a security guarantee for bundled frontend code or build tools.
- npm did not rewrite lock bytes in this tested environment. Install verification tolerates lock byte changes only; default/CI verification still compares the build-time lock.
- Normal maintainer `npm pack` (not ignore-scripts) completed the prepack build and prepare verification. Produced 685 files, about 4.8 MB compressed / 25.0 MB unpacked. Content includes the checker, manifest, LICENSE and README screenshot resources. Nothing was published to npm.
- The production-only installed runtime passed all 36 real Pi CLI → extension → WebSocket → Chromium → faux-provider E2E, including long history, language, lifecycle, tool full-content and workspace flows. Later dev-test-runner metadata changes were verified by a clean rebuild to have unchanged frontend output hashes.

## Boundaries

This is an installation/distribution change, not a UI design change: no new screenshot set was taken. Existing visual reports remain applicable to unchanged frontend output. E2E evidence is independent of file hashing.

The checker verifies all inventoried assets and local quoted HTML entry script/CSS/modulepreload references. It is not a general HTML parser or a recursive proof of every JS/CSS external dependency graph. It rejects static symlinks/path escapes, but is not an adversarial same-OS-user concurrency sandbox. Hashes establish correspondence, not trusted provenance.

The regression isolates Pi agent settings, workspace and Git source rewrite. npm/Git still use their normal executable/network/config environment for registry access; it is not a hermetic test of every npm version or OS. Linux/Node 24/Pi 1.1 were tested. Windows native and pnpm/Bun are not claimed tested.

Pi can skip prepare on a same-HEAD update when runtime dependencies are already present. `pi update` is not a guaranteed repair for manual dist corruption; remove/reinstall after preserving any local edits. Production audit results are not a security audit of all bundled frontend packages; development/build dependency advisories remain and were not automatically fixed.

## Publication state

Local validation was completed before publication. The maintainer subsequently authorized publishing the source scripts and complete prebuilt dist together to remote main; the actual publication commit is recorded by Git rather than embedded in its own build manifest. Previously installed user packages and active Pi sessions are not automatically updated or reloaded by a push.

CI now verifies checked-in manifest correspondence, clean rebuild parity, unit tests, real Pi production install/update, and E2E against that installed production-only runtime. The updated workflow has not yet run on GitHub; local evidence is reported separately.
