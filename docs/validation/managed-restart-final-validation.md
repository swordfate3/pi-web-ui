# Managed Pi restart — final development verification

Date:2026-10-17. This records isolated development evidence, not production
activation. The whole-branch independent review and source-install result are
recorded separately. Existing Hub/Gate/Pi services and private state were not used
as test fixtures, restarted or recreated.

The first whole-branch review found F1 shutdown/spawn and F2 historical-result
defects after the earlier results below. Both were corrected and received an
independent scoped spec/quality PASS in `managed-restart-final-rereview.md`.
They were not waived by earlier passing checks. Fresh controller evidence follows.

## Post-final-fix controller verification

- Complete Web/Hub unit suite:392total,391pass,0fail,0cancel,1opt-in skip;
  9.476s. Both TypeScript configurations and error-level Biome225files pass.
- Complete staged Pi Python:75total,72pass,0fail/error,3explicit opt-in skips;
  21.436s. Includes new real subprocess shutdown-race tests, not just mocks.
- Rebuilt isolated Pi test image from the fixed supervisor and pinned local
  base, with no network/pull:exit0. Build output manifest
  `sha256:79133097ec991fe5872aaa9f0c2462da6227fa07b354a7570878eba474e04f6a`.
  No production image tag or running container was replaced.
- Actual two-Docker exact-session runtime restoration:1pass,3.696s.
- Actual Gate + freshly packaged Hub + two Docker Pi +390px Chromium:
  3consecutive full-chain passes,26.462s. Original terminal/container/session/
  leaf retained, other Pi unchanged, query-only recovery and no prompt replay.
- Real Pi TUI guard scenarios:6pass,7.571s. Hostile-origin Chromium repeat:
  separate origins,0unauthorized provider POSTs, no readable secret, isolated
  hostile worker.
- Production Web/Hub build and `verify:dist`:exit0. Existing module-type and
  bundle-size warnings remain. Error-level lint is not a zero-warning claim.
- Visual-only fixture:390×1000 and1365×1000 lock/unlock and historical-success
  screens;0pageerrors/no horizontal overflow. Screenshots inspected directly:
  historical completion and unavailable-link wording readable, no stale result
  anchor, no clipping. This last state uses a synthetic API projection, not Pi
  E2E. `.tmp/managed-restart-visual/historical-{390,1365}.png`.
- Regenerated27-file source patch applied to new temporary baseline copies;
  every resulting file byte-identical to reviewed staging. Then scoped original
  files were backed up and the same source applied to existing host directories;
  all27installed files match staging. No credentials, policies or runtime state
  were included. Backup under
  `$HOME/docker_files/pi-docker/backup/managed-pi-restart-source-20261017-final`.
- Reproducible relative companion-source patch is retained at
  `deployment/managed-pi-restart/host-source.patch`. The invalidated earlier
  26-file script was not reused. New source manifest records source-only install.
- Fresh suites from the actual installed host source directories:Gate269pass,
  0fail/error/skip,52.824s;Pi75total,72pass,3opt-in skips,0fail/error,21.947s.
  Installed Node guard test runner passes as well. These use temporary test state,
  not the running production Gate/Hub or user conversations.

The following table is earlier evidence, not a second claim that every listed
check was rerun after the final fix. Gate source was unchanged by F1/F2.

## Controller-run evidence

| Check | Fresh result |
| --- | --- |
| Complete Web/Hub unit suite |384total,383pass,0fail,0cancel,1opt-in large-file skip; final rerun9.577s |
| Complete staged Gate suite |269pass,0fail/error/skip;54.457s |
| Complete staged Pi runtime/launcher Python suite |71total,68pass,0fail/error,3explicit opt-in skips;21.241s |
| Actual Pi TUI/WebSocket stdin guard scenarios |6pass;6.525s; includes omitted/false flags and audited command control |
| Standalone shipped guard/adapter snapshot |23pass/0skip/0fail;2.842s; separate temporary source directory, installed dependencies only, no adjacent host-source tree |
| Actual two-Docker runtime restoration |1pass;3.819s; unchanged container, exact saved session/leaf, other Pi and UID1000 workspace write |
| Actual Gate + packaged Hub + two Docker Pi + mobile Chromium |6consecutive post-correction passes, in two3-case runs27.392s/25.523s |
| Actual hostile-origin Chromium |isolated origins, no readable management secret,0unauthorized provider POSTs, isolated hostile worker |
| Both TypeScript configurations |exit0 |
| Error-level Biome |225files,0errors; warning-level style diagnostics still exist |
| Production build and dist correspondence |exit0; existing bundle-size/module-type warnings remain |
| Selected real Pi history/download/onboarding Playwright regressions |8pass on the guarded Hub source before the final narrow command/recovery correction |
| Source patch preflight |26reviewed host files applied to temporary copies; every output byte matches staged source |

Relevant commands (run from the package unless noted):

```sh
npm run test:unit
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc -p tsconfig.connection.json --noEmit
npm run check -- --diagnostic-level=error
npm run build:web
npm run verify:dist
git diff --check
PYTHONDONTWRITEBYTECODE=1 python3 e2e/harness/test-stdin-guard-tui.py
PI_RUNTIME_TEST_IMAGE=pi-runtime-test:managed-20261017 \
  PYTHONDONTWRITEBYTECODE=1 python3 e2e/harness/test-managed-runtime.py
PI_REAL_DOCKER_TEST=1 PI_REAL_BROWSER_TEST=1 \
  PI_RUNTIME_TEST_IMAGE=pi-runtime-test:managed-20261017 \
  PYTHONDONTWRITEBYTECODE=1 python3 e2e/harness/test-managed-gate.py \
  RealGateIntegration RealGateIntegration RealGateIntegration
node --import ./tests/register-ts.mjs e2e/harness/hostile-management.ts
node --import ./tests/register-ts.mjs e2e/harness/visual-managed-restart.ts
```

For each staged Python component, the complete command was
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v` in that
component's directory. The supplied opt-in test image is separately built from
the reviewed runtime source; the actual image's fixed stdin-guard checksum is
compared with the packaged guard before integration assertions.

## What the six browser cases proved

Each case started its own temporary Gate/Hub and two actual Pi containers with
synthetic credentials/conversations, then used the real management page at390px:

- Open the original saved chat, pair the independent admin origin, select the
  exact target card and accept its native confirmation.
- Send one restart, wait for Gate execution plus exact live Hub successor proof,
  and verify that the original chat automatically follows that successor.
- Verify the same container, saved session/leaf and expected loaded version;
  the other Pi runtime is unchanged and saved prompts were not replayed.
- Query/repeat the same idempotency key without executing another restart.
- Quit normally through the retained original terminal; the other Pi stays alive.

This is real local-browser/device-width evidence, not a physical-phone/public
Aliyun test. Actual Pi version in these fixtures was1.1.0; no npm update, new
published version installation or real user's conversation was performed.

## Visual evidence

Temporary local Hub `/sessions/` pages were rendered and screenshots inspected
at390×1000 and1365×1000. Management lock/unlock, session cards, target controls and
restored-result link were readable with no horizontal overflow, clipping or page
errors. Restored mobile chat visibly retained the synthetic saved reply.

Screenshots are task-local artifacts under `.tmp/managed-restart-visual/` and
`.tmp/managed-restart-browser/`, not production data. All fixture HTTP/WS servers,
browser instances and temporary Pi containers were closed by test cleanup.

## Failures retained, not waived

Stable-source acceptance first reproduced false stale/unknown outcomes despite
actual supervisor success. Test-only boundary evidence isolated Mounts-order-only
fingerprint drift; see `managed-restart-mount-order-diagnosis.md`. The regression
tests failed before the minimal canonicalization fix and passed after. The six
consecutive passes above are after that correction. Earlier untraced timeout
cannot be retroactively asserted to have the same cause.

One attempted combined-test permission review timed out before execution; the
permitted individual invocation was retried successfully. An npm dry-run using
the default read-only cache failed before retry with a temporary writable cache.
These environment/setup failures are not product RED evidence or passing tests.

## Deployment limits

No production images, lifecycle credentials/policy, Caddy/DNS/SSH routes or active
containers were changed. Optional management requires a separate authenticated
HTTPS origin; an old Pi container needs explicitly authorized recreation with
the new image/labels before it can support managed restart. Conservative guard
eligibility is audited for Pi1.1.0, and terminal/unaudited Web activity can make
an existing process ineligible. Failed/unknown old jobs and pre-fix fingerprints
are not rewritten or automatically retried. See `docs/managed-pi-restart.md`.
