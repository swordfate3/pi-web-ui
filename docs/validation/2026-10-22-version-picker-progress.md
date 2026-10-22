# Hub version picker: development checkpoint, not release acceptance

Date: 2026-10-22. Branch: `codex/hub-version-picker-updates`.
Base: `bdc17f43747ba5b1a1ccea89b0e2969b60d81516`.
Approved design commit: `effffba`.

## Verdict

**Not ready to merge or deploy.** The catalog and management UI are implemented;
the dynamically validated candidate/install/refresh path is not. No supported real
`1.3.0 -> 1.4.0` transition can be claimed from this checkpoint. Existing runtime
version guards remain in place, rather than being removed without evidence.

The source-only Gate integration does not replace the live Gate. No production
Hub, Gate, Pi process, tunnel, policy or persistent volume was changed.

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

## Release blockers and next work

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
