# Four cooperative Web interactions — development validation

Date: 2026-10-24. Branch: `codex/web-extension-interactions`.

## Boundary

This is development evidence, not production activation. Existing Hub, Gate,
Pi containers, installed extensions, credentials and volumes are not modified.
The unrelated trusted-terminal host review is preserved. The other runtime
refresh worktree is outside this task.

The Web/Hub change and four source adapter changes are separate artifacts.
Updating only the Web package cannot enable an unmodified source extension.

## Final source artifacts

All four unified patches were reapplied to fresh indexed baselines and their
postimage hashes verified. The final clean source run passed **56/56** with zero
failures/skips. The frozen development source trees were independently compared
against every exported postimage hash after the export.

| Adapter | Exact imported package baseline | Final focused cases |
| --- | --- | --- |
| Memory | `pi-scoped-memory@0.10.0` | 16 |
| Knowledge | `pi-knowledge-studio@0.1.0` | 15 |
| MCP | `pi-mcp-adapter@6.0.0` | 10 contracts + original OAuth + actual factory = 12 |
| Agents | `pi-subagents-lite@1.17.0-thinking.1` | 10 contracts + hosted budget + real config/coordinator + real manager/SDK child = 13 |

The MCP acceptance executes its real default factory and original OAuth
state/PKCE/callback flow against a synthetic local provider. Agents acceptance
crosses the actual `AgentManager`, `runAgent`, SDK `createAgentSession` and
`AgentSession.prompt` with a deterministic in-process provider. These are not
claims about a live external OAuth or model service.

`integrations/adapters/manifest.json` records exact package versions and per-file
pre/post SHA-256 values. These patches are for those exact source bytes, not a
blanket patch for every installation with the same version number.

## Verified development evidence

- Real temporary Pi RPC process + mirror + Hub: a cooperative sensitive
  confirmation is consumed once, closes the local SDK dialog and emits one
  source effect marker. The public socket never receives the private preview.
- Original native-dialog rejection tests remain in place; arbitrary
  `extension_ui_response` is not an authorization mechanism.
- Actual modified Memory and Knowledge entrypoints, temporary source-owned
  stores, no real provider: 31 new tests passed (Memory 16, Knowledge 15). These include
  approval/refusal, source lifecycle invalidation, missing-package fallback
  cancellation/deadline, failure-closed discovery, wrong folder/date/revision,
  active writer locks, profile catalog CAS, and generation refusal with zero
  provider fetch/export.
- Original session registration regressions: 20 passed. Legacy harnesses now
  use the real SDK event bus rather than incomplete API doubles.
- Browser acceptance: one real temporary Pi/Hub/Chromium test passed at desktop
  1365×960 and iPhone 13 size. Its source fixtures are synthetic; this is not
  acceptance of the four original packages or a real OAuth provider.
- The browser caught initial concurrency displaying `1` instead of source `2`.
  After the fix, source `2` is shown and editing to `3` survives a list refresh.
- Frontend and connection TypeScript checks passed. Production Web/Hub build
  passed; existing large-chunk warnings remain.
- Final complete Web run including recovery scenarios: 762 tests,
  761 passed, zero failed, one explicitly skipped (opt-in 1 GiB upload stress).
  The standalone management-page Chromium check was enabled in this final
  complete run; it also separately passed 41/41. The separate real Pi/Hub
  desktop/phone-sized browser suite passed 1/1 on the final build.
- Eight real Pi/Hub integration scenarios passed: trusted Web allow, cancelled
  native transition recovery, local allow/reject, Web reject, simultaneous
  local/Web allow, broker timeout, source cancellation and private Hub-channel
  disconnect. The allow/recovery assertions share one scenario. Every case
  checks private preview absence and one-or-zero source completion; late native
  replies cannot revive expired/refused/disconnected work.
- Three further real Pi/Hub scenarios passed independently and inside the
  complete run: successful session replacement, Pi reload, and recovery after
  Hub restart. An old request cannot create an effect; a new current request
  after recovery commits once. These use file-recorded source effects as well
  as actual SDK dialogs and HTTP/WebSocket transport, not UI doubles.
- Isolated real Pi Git install/update and npm tarball installation passed,
  including 11 stale-source rejection probes, production-only dependencies,
  and installed Hub init/issue/serve/HTTP/revoke/shutdown. No installed user
  package was updated by this check.
- Targeted lint: 26 production files, zero errors, one pre-existing
  non-null-assertion warning in `hub/server.ts`.

## Visual inspection

The in-app Browser tool is not available in this run. Isolated Playwright
Chromium is the fallback; screenshots are inspected as images, not accepted
from selectors alone. URLs are temporary loopback Pi and Hub management
listeners, with no production hostname or real user data.

Screenshots under `.tmp/interaction-screenshots/` show readable MCP controls,
the separate full-preview review page, and the phone agent dialog. The initial
phone focus scrolled away the title; focusing without scrolling fixed this.
The phone dialog stays inside the viewport and scrolls its long body. Screenshots
are transient fixture evidence, not committed machine-specific paths.

## Commands

```bash
# Shared/focused transport and management tests
node --import ./tests/register-ts.mjs --test \
  tests/web-interactions-*.test.ts tests/interaction-*.test.ts \
  tests/interaction-artifacts.test.mjs tests/hub-interactions.test.ts

# Actual Memory/Knowledge entrypoints from development source copies
node --experimental-transform-types \
  --import ./integrations/source-test-loader.mjs --test \
  ../pi-web-interactions-sources/memory/tests/web-interactions.test.ts \
  ../pi-web-interactions-sources/knowledge/tests/web-interactions.test.ts

# Browser needs an installed compatible Chromium, not a production browser
PI_E2E_BROWSER_EXECUTABLE=<chromium-executable> \
  PI_INTERACTION_SCREENSHOTS="$PWD/.tmp/interaction-screenshots" \
  npm run test:interactions:browser

npx tsc --noEmit
npx tsc --noEmit -p tsconfig.connection.json
npm run build:web
npm run verify:dist
npm run test:unit

# Bounded file concurrency used for the complete final regression
PI_INTERACTION_TEST_BROWSER=<chromium-executable> \
node --import ./tests/register-ts.mjs --test --test-concurrency=4 \
  tests/*.test.ts tests/*.test.mjs src/web/src/core/i18n.test.ts \
  src/web/src/components/pi-web-ui/sidebar-tree.test.ts

# Installer must use disposable state, not the default user-local test root
PI_INSTALL_TEST_ROOT=/tmp/pi-web-interactions-install-20261024 \
  node scripts/test-git-install.mjs

# Reproduce source artifacts against their indexed original baselines
node integrations/export-adapters.mjs ../pi-web-interactions-sources
node integrations/verify-adapter-release.mjs ../pi-web-interactions-sources --keep
```

## Failures investigated, not hidden

- First broad source-copy run: Knowledge's PDF worker could not resolve
  optional `unpdf`; Memory uses existing TS parameter properties unsupported
  by strip-only Node. These environment errors are not passing assertions.
  Transform mode resolved Memory execution. An isolated install of the exact
  locked `unpdf@1.8.1` proved the real child worker resolves its dependency and
  reaches input validation with empty stdin. Full PDF worker tests still failed
  (4/14 passed, 10/14 failed) with subprocess/stdio failures. No parser changes
  were made, and no full original PDF or package-wide upstream pass is claimed.
  Temporary optional-dependency installs/links were removed.
- First complete Web unit run: 712 tests, 662 passed, 48 failed, 2 skipped.
  Failures clustered in three incomplete mirror test doubles (missing event
  bus) and the packaging fixture (missing newly mandatory interaction source
  inventory). Both fixtures were updated without weakening production guards;
  the complete rerun passed as reported above.
- A subsequent run exposed a cancelled transition followed by a fresh input
  leaving zero source panels. A stricter actual socket query reproduced
  `0 !== 2`; rediscovery now follows fresh authoritative input. It does not
  revive old pending requests/admissions. Independent scoped re-review and
  nine related integration/panel tests passed.
- First final clean-source run: 51 tests, 50 passed, one failed because the
  new actual MCP factory test imported the original sibling checkout path.
  Resolving the public API entrypoint fixed that location dependency. A later
  clean reapplication passed 55/55; after the budget regression below, the final
  clean reapplication and source suite passed 56/56.
- Source-security review found three P2 issues for correction before delivery:
  fresh-disk versus loaded MCP execution binding, incomplete local intent
  previews, and a post-approval cancellation race at settings effects.
  All three were fixed and independently re-reviewed. Reconnect binds both
  disk and loaded-runtime fingerprints plus the effective execution target,
  including a recheck after asynchronous module loading. Actual public-client
  cancellation reproductions showed zero writes in all six settings branches.
- A follow-up review reproduced request inflation from duplicating complete
  intent inside a formatted message: a valid escape-heavy 16 KiB task exceeded
  64 KiB. Fixed by transmitting complete structured intent once and formatting
  the full local confirmation separately. The actual hosted-client regression
  passes. Independent fix-only re-review measured a 33,674-byte complete request
  with the exact task preserved in wire/local/spawn input and one spawn under
  duplicate delivery. No task truncation or budget increase was introduced.
  The review closed this P2 and found no remaining actionable P1/P2 within its
  reviewed scope. This is not a claim that the entire upstream package ecosystem
  or all future source revisions are vulnerability-free.

## Acceptance ledger

| Gate | Evidence / remaining work |
| --- | --- |
| 1. Schema/budgets/arbitration | Protocol/broker/panels and complete Web regressions passed; independent foundation findings fixed. |
| 2. Management authority | Actual private WS/HTTP, Origin/CSRF/stale identity/revocation, signature and replay tests passed. |
| 3. Real Pi lifecycle | Eight arbitration/cancellation cases plus three actual replacement/reload/Hub-restart recovery cases passed. Original unadapted native-dialog rejection regressions still pass. |
| 4. MCP original source | Ten source contract cases, actual default factory/panel and original synthetic-provider state/PKCE flow passed in the final clean copy. Execution-binding/local-preview/cancellation review findings closed. |
| 5. Memory original source | 16 actual entrypoint cases passed, including folder/day/revision/lock guards. |
| 6. Knowledge original source | 15 actual entrypoint cases passed, including profile CAS and generation refusal/zero egress; original full PDF/upstream suites have unresolved harness limits, not a claimed pass. |
| 7. Subagents original source | Ten contracts, hosted escape-heavy budget regression, real ConfigStore/SpawnCoordinator and real AgentManager/SDK child execution passed in the final clean copy. |
| 8. Desktop/phone | Real Pi/Hub browser with synthetic sources passed; screenshots inspected. |
| 9. Packaging/final bytes | Build/types/dist, 761 passing Web tests (one 1 GiB opt-in skip), final 56/56 clean source cases and repeated isolated Git install/update/tarball passed. Final source hashes match exported artifacts; scoped review fixes closed. |

## Remaining rollout and evidence boundaries

- No push, main merge, source-package release/install, production enrollment,
  deployment, or live process restart was performed. Existing installed source
  extensions cannot gain these features from a Web update alone.
- The public API subpath must resolve from the adopted source packages. A
  sibling Git checkout is not an implicit Node dependency. The development
  resolver is test-only and is not a production installation mechanism.
- Authored source whitespace checks pass. An unfiltered staged
  `git diff --check` also flags generated minified vendor-string content and
  the literal single-space blank context lines inside the distributed unified
  patches. Those are generated/data artifacts, not hand-formatted source;
  trimming them would alter verified build bytes or patch data. They are
  excluded explicitly from that whitespace-only check, not from manifest,
  clean-apply, package or test verification.
- A physical phone, Safari, public Aliyun/Caddy access, and a live provider
  OAuth login were not tested. Desktop/phone-sized Chromium used actual
  temporary Pi/Hub transport with synthetic adapters; actual source acceptance
  is the separate 56-case campaign above.
- No full original Memory/Knowledge/MCP/Agents upstream-suite pass is claimed.
  Knowledge PDF/docx subprocess and copied-package dependency/config omissions
  are disclosed above. The opt-in 1 GiB stress case remains unexecuted.
- Temporary Pi/Hub/browser/installer processes were stopped by their test
  cleanup; isolated install roots were cleaned. Clean source replay directories
  and safe fixture screenshots may remain as development evidence. No
  production containers, volumes, user data, or credentials were removed.

No live phone-provider OAuth, production enrollment, deployment, push or merge
is claimed by these checks.
