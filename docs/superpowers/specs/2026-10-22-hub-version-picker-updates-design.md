# Hub-selected Pi versions with validated runtime refresh

Date: 2026-10-22

Branch: `codex/hub-version-picker-updates`

Status: chat design approved; written specification awaiting review. No implementation or production deployment is represented by this document.

## 1. User outcome and acceptance boundary

The user selects an officially published stable Pi version in the Hub, submits an update, and sees whether each managed Pi process actually adopted that version while preserving its session. A newly published version must not require adding its number to Hub, Gate, or extension source code before it can be evaluated.

Published, installed, validated, and running are different states. The UI must never describe a published version as compatible without evidence, or an installation as a completed process refresh.

The initial release candidate must demonstrate a real `1.3.0 -> 1.4.0` update through the browser/Hub/Gate/runtime path. It must also demonstrate a compatible synthetic-session `1.4.0 -> 1.3.0` rollback, and rejection without source-session mutation for an incompatible rollback fixture. These are test targets, not statements that either transition has passed today. Failure to satisfy the full acceptance matrix blocks release and production deployment.

## 2. Existing implementation and defect

At base commit `bdc17f43747ba5b1a1ccea89b0e2969b60d81516`:

- `hub/runtime-portal.ts` submits a manually entered exact version. There is no selectable published-version catalog.
- `hub/runtime-updates.ts` forwards bounded, authenticated requests to Gate and validates public job responses.
- `extensions/runtime-control.ts` treats versions outside `1.1.0` and `1.3.0` as busy/ineligible, even if the input guard is intact.
- Host Gate `gate/runtime_install.py` and `gate/runtime_updates.py` independently enforce the same fixed version set.
- The runtime installer prepares a separate release before atomically replacing the shared `bin/pi` symlink. A successful `--version` check is not sufficient compatibility evidence.
- Gate already has durable idempotent jobs, approval policy, consumer inventory, uncertain-result recovery, and idle-only refresh. These protections must remain.
- The image-owned input guard currently describes the reviewed transport as `pi-tui-1.1.0:stdin-data`. Merely deleting the version set would not establish compatibility with another terminal implementation.

Changing only the form, expanding the version set, or allowing every syntactically valid version does not solve the user request.

## 3. Chosen approach and alternatives

Chosen: bounded official version discovery plus isolated, evidence-producing compatibility checks, followed by the existing authorized installation and safe-refresh workflow.

Rejected alternatives:

1. Expand the hardcoded list with each Pi release. This repeats the current defect and requires repeated source updates.
2. Remove compatibility checks and rely on successful package installation. This cannot establish input safety or session recovery and risks disrupting active sessions.

The compatibility mechanism remains conservative. A future incompatible terminal protocol can require a new adapter, but an ordinary version number change with a passing supported protocol must not require a source edit.

## 4. Components and authority

### 4.1 Hub

Hub presents versions, process inventory, update state, and clear refusal reasons. It uses its existing restricted Gate client credential. It cannot execute Docker commands, install packages, approve a manual job, or change the administrator's runtime policy.

All new catalog and readiness routes are management routes. They retain the existing management-origin, authenticated-session, and CSRF protections. The chat origin must not gain an update API. Registry metadata is untrusted display data and is rendered as text, never HTML.

### 4.2 Gate

Gate owns official package resolution, package integrity selection, policy/approval, candidate preparation, compatibility evidence, activation, and the rollout state machine. Browser requests identify an exact version, not a package name, registry, tarball URL, command, volume, image, or compatibility override.

Use only `@earendil-works/pi-coding-agent` from the fixed HTTPS npm registry. Disable lifecycle install scripts and ambient npm credentials/configuration. Reject non-stable selectors, ranges, tags, prereleases, build metadata, malformed versions, and missing required integrity metadata.

Approval authorizes evaluating/installing the specified official release, not arbitrary future content served under its version string. Bind resolved package integrity and execution policy to the durable job; changing content or policy invalidates the authorization. Installation must prove that the candidate matches the resolved artifact, not resolve the version a second time and silently accept different content.

### 4.3 Runtime supervisor and extension

Keep the image-owned supervisor and input guard as the trusted refresh mechanism. Do not download or execute an arbitrary supervisor supplied by the browser or package. Compatibility is a versioned adapter/probe contract, not a new permanent list of package versions.

The extension still rejects missing, replaced, tainted, or unsafe input guards; pending work; uncertain asynchronous commands; stale session identities; and missing session persistence. A compatibility record does not clear these conditions.

An already-running process must have valid eligibility evidence for its own installed release and adapter. Candidate evidence does not make an old, unknown process safe to restart. Old containers without the required supervisor contract are explicitly blocked and need a normal, coordinated restart with a compatible image; the feature must not recreate them automatically.

## 5. Version catalog and readiness API

Gate exposes bounded catalog and readiness projections to the runtime client; Hub proxies typed public results. Do not reuse the unrelated public "latest release" badge as a compatibility source.

Catalog behavior:

- Exact stable versions sorted numerically, newest first; not lexical sorting.
- Pages of at most 50 entries, with version-prefix search and a bounded continuation cursor so older releases remain selectable.
- Five-minute cache with request coalescing, a finite timeout, a maximum metadata body size, and a last-successful-fetch timestamp.
- Explicit fresh/stale/unavailable state. Stale data may be browsed but does not bypass a fresh exact-version and integrity check when submitting an update.
- A fixed registry origin, no redirected download to an unapproved origin, and no URLs echoed from a browser request.
- A catalog row is initially "published; not yet validated". It can display validation evidence only for the current matching execution profile.
- Invalid engines metadata is rejected as unknown/incompatible. A candidate requiring a newer Node than the selected helper/consumer profile is refused before activation.

Readiness behavior:

- Show the current shared installed version separately from each process's reported version.
- List a bounded set of managed consumer run IDs/labels and public blocking reason codes.
- Identify legacy/unmanaged consumers before the user submits an update, without leaking container IDs, host paths, credentials, or session content.
- Re-inventory at execution time; the readiness screen is informational and never a lock or authorization.

## 6. Durable update flow

1. The user chooses an exact catalog version. Hub explains global scope, upgrade/downgrade direction where known, approval mode, and current blockers.
2. Hub persists an idempotency key before submitting. An ambiguous response is queried by the same key, not automatically submitted under a new ID.
3. Gate resolves and pins the official artifact and checks admission, policy, quotas, and the consumer trust boundary. Manual jobs wait for host approval; auto jobs proceed under existing policy.
4. A restricted preparation helper installs into a distinct candidate release. Preparation does not replace the current entrypoint or mutate a running session.
5. Compatibility checks execute against the candidate in isolated test state with a faux provider, never production model credentials. Candidate execution has no network and no production home, SSH, Docker socket, workspace, or session-volume access.
6. A successful validation produces a durable record tied to exact candidate contents, adapter/probe contract, Web extension contents, runtime image identity, Node runtime, and test results. A version string alone cannot select an old record.
7. Immediately before activation, Gate rechecks approval/policy, candidate identity, and consumer compatibility. A concurrent direct update or changed entrypoint is a conflict, not an excuse to overwrite it.
8. Atomically activate the prepared entrypoint, then refresh compatible idle consumers through their existing supervisor. Active generation, queued work, and uncertain input remain deferred or explicitly blocked.
9. Refresh verifies the actual new process version and preserved session, leaf, working directory, provider/model, and thinking settings. No saved user prompt is replayed and no container is recreated.
10. Report per-target results. Complete success requires verified refresh or a confirmed target exit; failure/unknown/blocked states remain visible and cannot be relabeled success.

Keep durable observations around side effects. Gate restart must reconcile previously created helpers and refresh operation IDs instead of issuing an unobserved action again. Existing `recovery_required` semantics remain.

## 7. Compatibility checks and records

Required checks cover actual behavior, not just symbol presence:

- Executable reports the exact requested version and starts using the intended Node runtime.
- Web extension loads and reports the managed runtime control contract through a real Pi process.
- Real PTY input uses the supported guard path; unknown/fragmented input taints immediately, barriers block input, and unsafe terminal or asynchronous Web commands cannot regain eligibility through reload.
- Safe generation state can become eligible after generation completes without falsifying user-input state.
- Synthetic saved sessions, branch leaf identity, model and thinking survive an idle child refresh, without duplicate prompt/tool execution.
- A deliberately incompatible contract fixture fails and leaves the current entrypoint untouched.

Record the content digest of the installed release, including the resolved dependency tree, not just the top-level package tarball. Revalidate contents before reuse/activation. Cache records are bounded and invalidated on any execution-profile or probe-contract change. Gate is the authority for accepting records; an Agent-writable JSON file or environment flag cannot authorize an update.

A finite probe suite is compatibility evidence for the tested contract, not a proof that arbitrary future packages or malicious extensions are safe. Ordinary Pi containers sharing writable state are not mutually isolated from malicious code. Preserve this evidence boundary in documentation and UI wording.

## 8. Downgrades and session safety

Downgrades are allowed to be selected, not assumed to be compatible. The flow must inspect supported session format requirements before restarting a process and test restoration in disposable state without modifying the original session. Session snapshots stay local and out of logs; test helpers have no network.

An incompatible or uninspectable session blocks that target before it is stopped. Do not silently migrate, truncate, reset, or overwrite the user's original history. Recheck session identity and readiness at the refresh barrier so a passing check for an earlier leaf cannot authorize a different session.

If partial rollout makes the outcome uncertain, keep explicit recovery state. Do not automatically roll back every process or shared entrypoint after some consumers have already adopted the new version.

## 9. UI contract

Keep the existing Hub management page; do not add a separate terminal or second management product.

The version control includes search, a selectable version list, selected-version details, current process versions, a refresh-catalog action, and the existing explicit submit confirmation. Display these distinctions:

| State | Meaning |
| --- | --- |
| Published / unvalidated | Release exists; compatibility has not been established |
| Validating | Isolated checks are running; live processes unchanged |
| Compatible | Matching compatibility record exists; approval and current readiness still apply |
| Awaiting approval | Manual Gate policy requires host approval; show task ID and exact host command |
| Waiting for idle | A known busy target remains untouched |
| Blocked / incompatible | Explain the specific consumer, engine, input, session, or contract reason |
| Refreshing | Supervisor is restoring the same session under the target runtime |
| Completed | All required targets verified adopted the version or confirmed exited |
| Recovery required | Outcome is uncertain; do not retry side effects blindly |

No hardcoded placeholder or allowed-version message may imply only `1.1.0`/`1.3.0` are supported. A remote catalog failure is distinct from Gate policy disabled, and disabled UI alone is never an authorization check.

## 10. Source ownership and isolation

Hub/extension changes live in the existing repository on the feature branch. Gate/runtime production sources currently live outside that repository under `/home/fate/docker_files` and must not be edited in place for this feature.

Bring only necessary executable source and selected tests into a reviewable integration area in this branch, with provenance hashes and explicit import boundaries. Exclude production configs, policies, credentials, runtime databases, private deployment records, user sessions, caches, and generated Python bytecode. Integration code is not installed by the normal Pi Web npm package and has no startup side effects.

Tests use unique container names, isolated temporary state, and test-only volume names. Existing engine assumptions about the literal `pi-runtime` volume must be made injectable only by trusted test/bootstrap configuration, never by Hub/browser input. Test opt-in must fail closed if it resolves to a production volume or service. Cleanup is by recorded exact test identities, never broad Docker prune or production-name patterns.

The current main-branch native-terminal rollback has not been applied to production. Any future deployment must account for existing Hub/Gate asset contracts and terminal settings separately. This feature must not silently combine that operational change with its tests.

## 11. Acceptance matrix and evidence

All rows are required for an end-to-end release recommendation:

| Area | Required evidence |
| --- | --- |
| Discovery | Stable sorting/paging/search; future-version fixture admitted without a source allowlist edit; stale/network/oversize/redirect errors bounded |
| Authority | Unauthenticated, wrong-origin, missing-CSRF, arbitrary-source, extra-field and malformed-version requests rejected server-side |
| Artifact | Exact metadata integrity binding; tampered candidate, changed dependency tree, profile mismatch and changed entrypoint rejected |
| Eligibility | Legacy consumer surfaced before submit and blocked again before activation; no silent skip of a shared-runtime user |
| Compatibility | Real PTY/guard/extension checks; incompatible fixture does not switch live entrypoint |
| Upgrade | Browser selects `1.4.0`; real isolated Hub/Gate updates real Pi `1.3.0` processes and verifies actual `1.4.0` snapshots |
| Rollback | Compatible synthetic `1.4.0 -> 1.3.0` succeeds; incompatible-session fixture refuses before stopping source process |
| Active generation | One consumer continues generation while another is idle; no forced kill or prompt replay; deferred refresh occurs when safely eligible |
| Preservation | Same container, session, leaf, cwd, provider/model and thinking after refresh; generation link refresh and browser reconnection work |
| Recovery | Preparation/network failure preserves old entrypoint; duplicate submissions have one effect; Gate restart reconciles uncertain helper/refresh state |
| Mobile | Desktop and mobile screenshots inspected; browser completes version selection and observes progress/results without host-only UI steps in auto mode |
| Regression | Unit/static/type/build/dist checks plus existing real Pi session/resume/model/reload behavior pass |

Tests may use a faux model provider, but cannot mock Pi, Gate, Docker execution or WebSocket state in the acceptance upgrade path. Skipped Docker/browser suites are missing evidence, not passed acceptance.

The final validation report records exact code commit, registry release/integrity, test image identities, before/after actual process versions, commands, outcomes, limitations, and cleanup results. It distinguishes unit fixtures from real package tests.

## 12. Delivery and release gate

Deliver a reviewed feature branch, reproducible integration sources/tests, user instructions, and an honest acceptance report. Do not merge to main or deploy production Hub/Gate/runtime as part of development. Passing tests establishes readiness for an explicit later deployment decision, not deployment authorization by itself.

If `1.4.0`, the required downgrade, or any other acceptance row cannot be demonstrated, identify the failing boundary and leave the feature off production. Do not claim a generic version manager is finished because the picker renders, `npm install` succeeds, or a version was added to another allowlist.
