# Hub version picker: validated source integration

Date: 2026-10-22. Branch: `codex/hub-version-picker-updates`.
Base: `bdc17f43747ba5b1a1ccea89b0e2969b60d81516`.
Approved design commit: `effffba`.

## Verdict

**Ready for the user-authorized local main integration, not production deployment.**
Current-source normal browser acceptance passed actual two-consumer
`1.3.0 -> 1.4.0 -> 1.3.0`, including active-generation deferral. A separate
current-source test refused incompatible-session rollback before stopping the
original process. Final independent review accepted both Important fixes and the
numeric upgrade/downgrade disclosure, with no remaining Important finding.

The user has now authorized completing the feature and merging local `main`
after acceptance. This does not authorize a production rollout, service restart
or remote push. Source integration does not imply that the live services run it.

The source-only Gate integration does not replace the live Gate. No production
Hub, Gate, Pi process, tunnel, policy or persistent volume was changed.

## Final current-source evidence: 2026-10-23

Production source base: `66db093f2b15d58d48e5b88dfb3a0ca69f444832` plus the
final integration changes recorded by the commit containing this report. The
reviewed product source was frozen during acceptance. Test image immutable ID:
`sha256:d9c59c6bfcde16d53e55806ab27406f37fb53c520c3f0c59b51d21824f6cd33f`.
Node: 24.21.0. Official package: `@earendil-works/pi-coding-agent`.

Official artifact SRI values also retained in the development evidence (the
successful browser projections deliberately do not expose internal Gate records):

```text
1.3.0 sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw==
1.4.0 sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==
```

| Acceptance area | Observed result and boundary |
| --- | --- |
| Discovery | PASS: stable numeric sort, paging/search, stale/error bounds; synthetic future `99.0.0` is evaluated without a source-version ceiling. Not a real future-release compatibility claim. |
| Authority | PASS: authentication/origin/CSRF, extra-field, arbitrary-source and malformed selector regression tests; real browser uses protected management routes. |
| Artifact | PASS: pinned official integrity, guarded transport, full tree/profile/source identity, mutation and entrypoint fences; actual official packages executed in isolated helpers. |
| Eligibility | PASS: all-state inventory plus durable required-consumer IDs, paused/unmanaged/uninspectable blocking and exact-ID exit tests. Independent scoped rereview accepted the fix. |
| Upgrade | PASS: normal run `0e5c673a672749c6b88899c273daa33c`, task `2e3c7ccc89f95234f8bbb88362b9e592`, two actual processes `1.3.0 -> 1.4.0`. |
| Compatible rollback | PASS: same run, task `67c54de81eb52a4f21cd48e870e69e9d`, both actual processes `1.4.0 -> 1.3.0`. |
| Incompatible rollback | PASS refusal: normal run `a0e3b1cfa2fd447c9c2ea011b955a4cb`, upgrade `53450df6a99c3326a8caf311dc252954`, refused rollback `189b9d366116e76113b43eed3a5c0981`; original runtime/session/leaf/history/container unchanged at `1.4.0`. Gate reports `recovery_required / restore_pre_stop_failed`, not success. |
| Active generation | PASS: idle consumer adopted `1.4.0` while the generating consumer stayed on its original `1.3.0` process, then completed and refreshed. Exactly one synthetic model call; no prompt replay or forced termination. |
| Preservation/reconnect | PASS: unchanged container and session IDs, exact original history prefix, actual frozen branch leaf, cwd/provider/model/thinking, selected actual process version; existing chat pages reconnected, zero browser page errors. |
| Recovery and fault cases | PASS in scheduler/transport fixtures: duplicate submissions, network failure, changed policy, tampered candidates, restart/ambiguous-intent reconciliation and capture cancellation. These are not a real daemon-crash or power-loss test. |
| Mobile/desktop | PASS screenshot inspection at `1365x1000` and `390x1000`: controls/readable states and numeric upgrade/downgrade warnings visible, no overlap or horizontal overflow. Browser completed the flow under auto policy without a host approval step. In-app Browser was unavailable; Playwright screenshots were directly inspected instead. |
| Existing Pi regressions | PASS: four real-Pi backend cases covering bounded 20 MiB history, edit/regenerate branches and subsequent turns, multi-session registration/exit/Hub restart. Real TeX browser case passed, desktop/mobile screenshots directly inspected. |

Normal run `0e5c...` records `passed_basic_transitions:true`,
`busy_deferral_observed:true`, `cleanup:true`, `production_touched:false`.
The negative incompatible run records `incompatible_refused_before_stop:true`;
its `passed_basic_transitions:false` is deliberate because it tests refusal.
Evidence and screenshots remain under `.tmp/runtime-version-acceptance/<run>/`.
Only synthetic sessions/model responses/credentials and unique test volumes were
used. All exact test containers, helpers, volumes and temporary services were removed.

### Fresh full regression results

| Check | Result |
| --- | --- |
| Full serialized Node suite | 649 total: 648 passed, 1 existing opt-in stress skip, 0 failed/cancelled; 120.171 s |
| Full imported Gate/lifecycle suite | 438 total: 430 passed, 8 explicit opt-in skips, 0 failed; 91.275 s |
| Pi runtime/probe suite | 49 total: 45 passed, 4 explicit opt-in skips, 0 failed |
| Acceptance-bootstrap/harness contracts | 9 passed, including system-role accounting and exact live-generation observation |
| Connection TypeScript, `just check` | Passed; existing 33 warnings and 7 informational diagnostics remain |
| Production asset build and source/dist check | Passed; existing chunk/plugin timing warnings remain; consistency is not authenticity verification |
| Whitespace/diff check | Passed |

The SQLite tests emit an existing unclosed-connection ResourceWarning under
Python 3.14. Skipped optional stress/package tests are not counted as passed.
Independent whole-branch review initially requested two Important corrections:
all-state durable consumer coverage and source-evidence checks for independent
lifecycle restarts. Both were implemented and independently rereviewed PASS.
Ordinary restart without a matching completed Gate evidence record now blocks,
even at the same version; it does not use a no-proof live supervisor fallback.
The numeric direction and both narrowly corrected harness predicates also passed review.

### Limitations and historical failed attempts

- No fixed Pi-version allowlist remains, but each exact stable release still
  requires official metadata, compatible Node/adapter/profile and successful
  source/candidate/session validation. Testing `1.4.0` does not guarantee all future versions.
- Earlier isolated source/candidate probes intermittently failed closed before
  activation. Their fixed receipts did not establish a root cause; the successful
  final runs do not constitute a diagnosis or proof that this cannot recur.
- Two failed busy attempts were harness defects, not passing acceptance:
  guard-taint `busy` is not generation, and Pi legitimately writes a `system`
  message before generation. Focused red/green tests corrected observation only;
  exact historical bytes, frozen leaf, process/settings and provider-call checks remain.
- Real crash/power-loss fault injection, malicious shared-extension isolation and
  remote phone/carrier connectivity are not claimed. Recovery fixtures and finite
  offline behavioral probes have narrower scope.
- This feature spans Hub, Gate and image-owned supervisor/guard. Updating only
  the Web extension cannot deploy it. No live configuration, password, policy,
  tunnel, container or production volume was modified by this work.

## Historical checkpoints (superseded by the verdict above)

The sections below retain the development chronology. Their pending/not-run
statements describe those earlier checkpoints, not the current verdict.

### Earlier continuation: 2026-10-23

- **Normal real acceptance `165ca767ac77460ba60aa4490bff237c`: passed** both
  official `1.3.0 -> 1.4.0` and compatible synthetic-session `1.4.0 -> 1.3.0`.
  Browser task IDs were `3532c697c6737d21fece09deced736bd` and
  `31c87888741471943f330581839bc6ef`. Actual snapshots reported the selected
  versions, unchanged container identity, preserved session/leaf/cwd/model/
  provider/thinking, exact original message prefix and no model-call replay.
  Existing chat pages reconnected; no browser page errors. Test image:
  `sha256:e935acc25df3d972a0a9c7978a445254281ac2ea5c251df5c9a6f15b807592f3`.
  Structured evidence/screenshots: `.tmp/runtime-version-acceptance/` under that
  namespace. Exact cleanup passed; production was not touched. This run predates
  the final-review fix wave and must be rerun after source changes.
- Independent whole-branch review requested changes: discover and retain all
  required shared-runtime consumer identities (including paused consumers), and
  require Gate-owned measured-source/profile evidence through the independent
  lifecycle restart route. A minor finding requests numeric upgrade/downgrade
  direction disclosure. Fixes are in progress; no findings are waived.
- Scoped review passed read-only helper observation and inventory retries.
  They retry only typed read timeouts, never start/stop/activation mutations.
  Known HTTP errors retain their original nonretryable status. Covering tests
  reported **161 passed**. The bounded durable helper quota and intent deadline
  remain enforced.
- The pre-stop restore probe now maps only the disposable copy's header cwd to
  its private workspace, preserving original bytes and all other metadata/body.
  This prevents a missing-project confirmation prompt in the offline helper;
  actual live cwd accessibility still has to pass the final supervisor checks.
  Scoped review passed; probe tests: **45 passed, 4 explicit opt-in skips**.
- Diagnostic-only `b28cd7c71ad54184971cf2d14a327751` also exercised both
  directions, but remains explicitly excluded from release acceptance. Earlier
  attempts exposed two harness defects, now corrected: leaf IDs may refer to
  non-message session entries, and completion must match the current exact task
  ID rather than a previous completed job. Preservation/no-replay assertions
  were retained and strengthened with the actual frozen pre-stop leaf.
- Normal attempt `7672dd3cce4d441fb690a719425fd91f` failed candidate behavioral
  validation before activation, exit1/no OOM. No specific cause has yet been
  established for the intermittent fixed-receipt source/candidate failures.

The following bullets preserve the earlier continuation chronology:

- Fixed exec-stdin snapshot transfer and restore/control/recovery regressions:
  **31 passed**. The transfer correction passed independent scoped review.
- Exact target-exit confirmation: **19 focused tests passed** on the controller
  rerun, including successful malformed/empty inspect responses not being treated
  as HTTP404 and reconciliation of saved source helpers for omitted adopters.
  Independent round-two review passed specification and quality checks.
- Standalone official1.3.0 `run_probe` source wrapper passed all nine checks with
  Node24.21.0 in the fixed read-only/offline test profile (`adc5505…`).
- Normal full-path attempt `5c7d52e1c190499babeb6e60873a1706` failed the source
  helper before installation: exit1, no OOM, only the fixed failure receipt.
- Diagnostic-only attempt `da5e3fb4da194548b19326b187685c44` passed source and
  official1.4.0 preparation, then hit a read-only Docker inspect timeout. It is
  **not release acceptance**, and no process refresh was verified.
- Each completed attempt removed its exact synthetic resources and recorded
  `production_touched:false`. The new observation-timeout fix and a lower-overhead
  diagnostic run are pending; no checks are bypassed to obtain a passing result.

The older results below are historical checkpoints, not acceptance of the current
uncommitted integration. Version numbers in real fixtures are transition examples,
not the supported-version ceiling.

## Earlier real browser checkpoint

The complete Gate suite passed **359 tests** (8 explicit opt-in skips); the
serialized Node suite reported **638 passed, 0 failed**, with one existing
opt-in stress test skipped. The current static/build/dist checks passed with
the project's existing warnings. These are regression results, not complete
upgrade acceptance, and must be rerun after the transport correction.

Three probe findings (post-cancel/fresh-input replay observation, disposable
history preservation, and rehashing executed copies) were corrected and passed
scoped re-review. Future session formats are compared with the actual selected
SDK's format capability, not a fixed format allowlist. Supervisor target pinning,
last-moment freshness and provider/model/thinking preservation passed scoped
re-review. Interrupted pre-stop capture/helper reconciliation also passed its
scoped review; a non-blocking suggestion for stronger real-inspector coverage
remains to be triaged in the final review.

Real browser runs now load actual synthetic saved conversations, select the
published version and submit the update through Hub. The earlier invisible
conversation was a fixture error: its fixed October17 date was outside the
default recent-three-day window. Synthetic fixtures now use current UTC dates;
the product date filter was not bypassed or relaxed.

In the latest full attempt, official1.4.0 preparation, candidate validation and
activation succeeded, but the original process remained official1.3.0 because
pre-stop restore validation could not receive the frozen history. Docker29.3's
archive upload returned404 for `/tmp/restore-input` despite real exec confirming
that directory exists inside the running helper's tmpfs. A new fixed Docker
exec-stdin receiver is being implemented to preserve memory-only, local-only,
non-logged transfer. No bind mount or shared-session-volume fallback is allowed.

The source/adoption integration review also identified a separate blocker:
absence from a filtered running-consumer list is not confirmation of exit.
Persisted immutable target IDs must be inspected before they count as exited.
That correction and its negative regressions are still pending.

All completed attempts report exact-resource cleanup and
`production_touched:false`. The browser/tooling tests did not use real user
sessions, model credentials, SSH configuration, policies or production volumes.
Nothing has been merged, pushed or deployed.

## Continued implementation and observed evidence

Implementation checkpoints include `69342b2` (artifact/durable phases),
`b211f68` (fixed real behavioral probes), `b3ac3b9` (measured-source validation)
and `f29a6f7` (exact image-profile binding). Additional controller integration
changes are still uncommitted; these commits do not describe a completed feature.

Fresh checks on 2026-10-22:

- Official Pi **1.3.0** passed all nine source behavioral checks through the
  unmodified fixed probe CLI, including PTY guard/barrier, real WebSocket,
  generation/idle, async/reload taint, supervisor child refresh, session restore
  and no saved-prompt replay. Node was **24.21.0**. Source and root were read-only,
  network was disabled, only private tmpfs was writable; state was synthetic.
- Official Pi **1.4.0** prepared from the pinned SHA-512 artifact and passed all
  nine candidate behavioral checks. Both phases reported `changed:false`:
  this proves candidate preparation/behavior, **not a live upgrade**.
- Tested image: `sha256:e079af6c881ba1e7ccdab435b411d4f587f23fc047ada0e8864f847ec4b6f7ce`.
  Candidate installed-tree SHA-256:
  `794ddb0fb7c34702c2a3d973ccae633d44e4b22ae6d71cdbe41c632c5afff980`.
  Exact execution profiles were bound to each run; subsequent changes invalidate
  those records for reuse. A newer test image has since been built for full acceptance.
- Real npm transport fixtures passed **11/11** inside the fixed test image with
  no external network. They exercise legitimate registry fetches, dependency
  metadata, transitive dependencies, a packaged dependency shrinkwrap, HTTP,
  redirects and swallowed optional-dependency refusal. The guard-disabled
  control reached the forbidden sink, establishing negative-test sensitivity.
  The initial root-local-tarball shrinkwrap fixture was ignored by the real
  resolver and was corrected to a published dependency shrinkwrap; the failed
  fixture runs are not counted as security evidence.
- Focused Gate launcher/security/origin checks passed **3 + 14 + 5**; frozen
  restore envelope/ordering/archive tests passed **5**; existing validation-flow
  tests passed **9** after fixtures were updated for earlier source refusal.
- TypeScript and production asset build passed; existing Vite chunk-size/plugin
  timing warnings remain. The integration is still being changed, so a final
  full regression and source/dist check are required.

The offline source probe exposed a real noexec-tmpfs launch problem. The
supervisor now starts measured Pi JavaScript through the fixed image Node,
instead of directly executing the private script; noexec isolation was retained.
The corresponding launch-boundary regression failed before and passed after.

An initial candidate run stopped on a bounded read-only Docker query timeout;
the repeat passed. Only test harness outcome queries gained finite retries;
start/activation intents are not repeated and production timeout caps are unchanged.

All recorded test containers/volumes from those completed runs were removed by
their exact IDs/names. No production sessions, credentials or volumes were used.

Remaining release gates: complete browser/Hub/Gate upgrades and compatible
rollback; incompatible-session refusal before stop; busy deferral, recovery,
preservation/reconnect, mobile visual inspection, independent reviews and final
full regressions. The earlier sections below are historical checkpoint evidence,
not the current implementation inventory.

## Implemented and checked

- Official stable-version discovery, numeric sorting, prefix search, pages of 50,
  bounded continuation tokens, five-minute cache and explicit stale/unavailable states.
- Exact official top-level package metadata resolution, canonical SHA-512 SRI and
  expected tarball origin checks. Pinned metadata is saved before manual approval.
- Idempotent request replay returns the original task without another registry lookup.
- Overlapping same-key submissions share one bounded resolution. Joining is atomic
  with the durable lookup; waiting and network access do not hold the Store lock.
  Ambiguous follower timeouts remain HTTP 503 so clients keep the original task ID.
- Authenticated Gate handler routes and strict Hub management projections with bounded
  response bodies. Browser input cannot choose a package, registry, image or volume.
- Trusted test-namespace injection; ordinary browser requests cannot change the
  shared runtime volume. Production remains on the default name.
- Readiness inspection uses one overall four-second budget and checks the same
  policy before/after inventory. This reports management readiness, not compatibility.
- Published-version picker with search/pagination, independently retained selection,
  stale/error states, task ID and manual-approval instructions. Known blocked or
  unavailable readiness disables submission. Busy trusted consumers may submit and
  are described as waiting for idle.

Official registry availability was checked during development: exact metadata for
`1.3.0` and `1.4.0` resolved with `engines.node >=22.19.0`. That is availability
evidence only, not runtime compatibility or a permanent support guarantee.

## Verification record

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=integrations/runtime-updater/gate:integrations/runtime-updater/gate/tests \
python3 -m unittest discover \
  -s integrations/runtime-updater/gate/tests -p 'test_runtime_[!h]*.py'

NODE_OPTIONS='' node --experimental-test-isolation=none \
  --import ./tests/register-ts.mjs --test tests/hub-runtime-portal.test.ts

NODE_OPTIONS='' npx tsc --noEmit -p tsconfig.connection.json
NODE_OPTIONS='' just check
NODE_OPTIONS='' npm run build:web
NODE_OPTIONS='' npm run verify:dist
git diff --check
```

Observed at this checkpoint:

| Check | Result and boundary |
| --- | --- |
| Offline Gate runtime suite | 82 passed after both review-fix rounds; scheduler/Docker boundaries are fixtures, not real Pi execution |
| Test-only bootstrap | 2 passed; omitted/production/malformed volume makes zero constructor/resource-engine calls |
| Offline lifecycle regressions | 13 passed (`test_lifecycle_round2` and `test_lifecycle_round3`); fixed-target/mount-order invariants, not Docker acceptance |
| Portal script suite | 29 passed after the readiness-response ordering fix; VM logic, not browser rendering |
| Combined management/version/runtime portal regressions | 41 passed; non-network VM tests, including the 29 runtime portal tests above |
| Hub HTTP API suite | Implementer reported 20 passed before final portal-only changes; later rerun did not execute due to permission-review timeout |
| Connection TypeScript | Passed |
| `just check` | Exit 0; existing 33 warnings and 7 informational diagnostics remain |
| Production build | Passed after final readiness-response ordering fix; existing large-chunk warning remains |
| Source/dist hash verification | Passed after that rebuild; not trust/authenticity validation |
| Desktop/mobile screenshots | Not run |
| Real Docker/Pi upgrade or downgrade | Not run |

The non-network Node runs still emit the pre-existing `MODULE_TYPELESS_PACKAGE_JSON`
warning; package module-mode cleanup was not folded into this feature.

Independent scoped source review approved the Hub implementation. Its readiness
response-ordering finding was accepted and fixed with three red/green race regressions.
The scoped re-review confirmed that success/error/loading/reset paths use request
sequence and authorization-generation checks; no new fix-scope findings were raised.
The Gate task review identified concurrent duplicate resolution and the explicit
test-bootstrap production-volume fence. The scoped re-review confirmed both were
addressed, then identified an error-category regression: deterministic local policy
conflicts were translated into registry-unavailable responses. The narrow follow-up
preserves the leader's known local conflicts and uses `finally` for flight cleanup;
its scoped re-review was approved with no new fix-scope findings. The controller independently observed the final
82-test runtime checkpoint and two bootstrap tests passing.

One attempted full Gate runtime run executed 76 tests at an earlier checkpoint:
74 passed and two localhost HTTP tests raised sandbox socket permission errors.
Those two tests are **not passed**. The correctly scoped offline command above
then passed; it deliberately does not run `test_runtime_http.py`.

Two later automatic permission reviews for temporary localhost API tests timed out
before execution. That was not a code assertion failure or approval to bypass the
sandbox. The permitted retry was exhausted; no alternate agent/process path was
used to repeat the elevated test. Non-network VM/unit/static checks continued.

## Historical release blockers at the first checkpoint

1. Implement an isolated prepare/validate/activate pipeline. The installer currently
   still uses its imported audited-version set and does not consume the pinned SRI.
   Metadata pinning alone does not ensure installed bytes match the approved artifact.
2. Bind full installed package/dependency-tree content, Node/image/adapter/Web code
   identity and real behavioral probe evidence to Gate-owned durable records.
3. Prove eligibility of the already-running source process. Candidate evidence or an
   Agent-writable JSON file must not make an unknown source process eligible.
4. Check downgrade/session compatibility on disposable local state before stopping
   the source process. Preserve original history, session/leaf/cwd/model/thinking.
5. Expose the actual shared installed version separately; do not infer it from a
   running process's reported version.
6. Complete an explicitly isolated real browser/Hub/Gate/Docker/Pi harness, using no
   production volumes or credentials. Demonstrate actual `1.3.0 -> 1.4.0`, compatible
   rollback, incompatible-session refusal, busy deferral and recovery cases.
7. Finish desktop/mobile visual checks, regression verification, final review and
   matching rebuilt assets. Only then report exact supported transitions.

Needed execution capability: temporary localhost/Unix test sockets, a browser, and
isolated Docker resources with unique test-only names. Test cleanup must target only
recorded test IDs. No production restart, deployment, merge or push is authorized
by these test needs.
