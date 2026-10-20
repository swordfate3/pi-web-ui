# Task 2 report — 2026-10-20

Historical Task 2 evidence, preserved in full from the task workspace before its
cleanup. Later packaging/integration results are in [Task 3 validation](bounded-hub-state.md).

Status: DONE_WITH_CONCERNS. Source implementation, self-review and final checks
are complete; no failing check, permission blocker or controller ruling remains.
Task 3 packaging/integration and the operational limitations below remain explicit.

Worktree: `.tmp/worktrees/bounded-hub` (relative to the repository checkout).
Branch/base: `codex/bounded-hub-state` / `90e5ecca763918525c10f5d0acea8947ce9f464c`.
Implementation commit: `3960ce1954e1b18925d395f17f71dedeac3505f4`.

Read Task 2 brief first, repository AGENTS/ADRs, binding design and registry
preflight. Used executing-plans, TDD, systematic-debugging and
verification-before-completion skills; self-reviewed without subagents as required.
Did not read the whole plan. No build/generated dist, push, deployment, restart
of user services, production-state/host-config/real-credential access or model
traffic. Tests used synthetic temporary files and localhost/Unix-socket fixtures.
The existing untracked node_modules symlink is untouched and unstaged.

## Implemented behavior and exact defaults

**Eight concurrent BROWSER WebSocket pairs, not eight Pi containers or registered
sessions.** Five independent Pi runs register and route in the integration test.
Each mobile/chat page can consume a pair even if several pages address one run.
Pending proof/handshake reserves a pair; the ninth pair is refused with 503.
Defaults are finite source constants, not a new runtime configuration surface.

| Resource | Exact bound |
| --- | --- |
| Persistent logical state | 8,388,608 bytes (8 MiB) |
| Normal-write security reserve | 65,536 bytes (64 KiB) |
| Active/non-revoked grants | 512, including offline grants |
| Browser pairs / raw HTTP connections | 8 / 128 (HTTP cap shared across chat and management) |
| Registry peers / admitted operations | 64 / 32; disconnected queued work retains operation credit |
| Concurrent backend proofs | 4 |
| WebSocket compression / HTTP compressors | 2 / 2 |
| Waiting per forwarding direction | 524,288 bytes (512 KiB), at most 512 messages |
| In flight per direction | ONE message, at most 16,777,216 bytes (16 MiB) |
| Retained admitted forwarding payload per direction | 17,301,504 bytes (16.5 MiB) |
| Pending generation lifetime | Fixed 5,000 ms, retries never extend it |
| Slow-send deadline / force-close grace | 5,000 ms / 250 ms |
| Authoritative state scan | At most 32,768 entries, depth 4; each managed JSON at most 8,192 bytes |
| Restart receipt count | Existing 1,000 ceiling, also subject to byte quota |

Eight pairs permit **264 MiB forwarding payload** (33 MiB each). Under the supplied
512 MiB production container limit, 248 MiB remains arithmetically for other
allocations. This is NOT an RSS guarantee: ws inbound materialization, parsing/
serialization copies, HTTP, compression and runtime overhead are separate.
No real 512 MiB cgroup stress measurement was performed. The concurrency/product
tradeoff is documented prominently in docs/hub.md; no silent Pi-run cap of four.

Task 1 contracts were not redesigned: complete UTF-8 history envelopes 256 KiB;
history 40 entries / 192 KiB / 16 KiB entry; tree 200 / 32 KiB; fenced detail
64 KiB complete envelope; browser content 200 items / 512 KiB / 64 KiB item.
The 16 MiB transport slot does not relax these producer/browser constraints.

## Compatibility and registry security

- New Hub + new extension: nonce-correlated authenticated negotiation selects
  bounded-v2. Hub-issued generations use
  `b2-<32hex boot>-<16hex slot>-<32hex nonce>`; run IDs and restart/runtime-update
  operation IDs remain exactly 32 lowercase hex.
- New Hub + legacy extension: legacy-compatible grants continue using the old
  registration protocol and global generation tombstones, under shared quota.
  Every legacy tombstone remains, INCLUDING revoked-run tombstones.
- Unmodified old Hub + new extension: generic rejection is fail-closed; no
  speculative legacy register. Only an exact correlated HMAC-authenticated
  UNSUPPORTED_PROTOCOL permitting legacy-v1 authorizes fallback. Auth failure,
  timeout, malformed/forged reply, quota or ended generation never does.
- A run with a bounded record cannot silently re-enroll through legacy mode.
  Bounded syntax is disjoint from the old Hub's accepted namespace.
- One record per bounded run retains at most current + pending, boot, high-water
  slot and revision. Only exact membership authorizes registration; persisted
  current alone never restores a non-live/expired session. Unknown unregister
  is idempotent without creating bounded tombstones. Old unregister cannot
  remove a successor. Startup commits a fresh boot before accepting traffic.
- Backend proof occurs outside the writer; final grant/boot/revision/lifetime
  validation and durable transition stay under the shared writer through
  in-memory publication. Separate CLI revocation during proof wins. Later route
  checks still reject revoked/missing grants. No claim that file-only CLI revoke
  instantly terminates already-open sockets at acknowledgment.
- Client negotiation/issuance/register replies are epoch-fenced; identity is
  installed before proof, URL only after correlated registration. Uncertain
  registration retries the same tuple; stop serializes exact known unregister.
- Updated URL consumers: server, restart API, portal, PiClient and the additionally
  discovered Hub-home validator in connection-path.ts. Upload URLs already use
  the exact basePath fence; added b2 success/cross-route rejection coverage
  without changing upload production code.
- Rollout: quiesce/upgrade ALL administrative writers, deploy Hub first, then
  extensions. Old CLI binaries ignore the new lock/quota and are unsupported
  concurrent writers. Old/new servers must not share state via different runtime
  directories. This report authorizes no rollout or administrative downgrade.

## Storage, exports, GC and diagnostics

Canonical state has separate serving and writer directory locks. No guessed PID,
expiry, stale-lock stealing or automatic crash recovery. Trusted recovery requires
first proving every relevant owner/writer stopped, then handling only verified
exact lock paths; never recursively deleting state. Normal shutdown releases only
owned locks. Existing runtime hub.lock remains.

All grant/revoke, legacy/bounded registry, management auth and restart
receipt/clock writes share the short cross-process writer and authoritative scan.
Private no-follow reads/writes reject unsafe permissions, symlinks, non-regular
or multiply linked files. Quota includes all ordinary state files, unknown files,
staging copies and new credential-export reservations. Files and required parent
directory entries are fsynced before acknowledgment; replacements are atomic.

Normal admissions cannot spend the 64 KiB security reserve. Security transitions
can use it; normal quota refusal preserves existing grants and publishes no
export. Already oversized/unsafe upgrade state is never erased and can refuse
startup or mutation; reserved capacity is a prospective guarantee, not a promise
that arbitrary already-oversized state can still be revoked.

Issue commits/charges the authoritative grant FIRST and only then publishes its
exclusive external credential export. Failed/uncertain export publication retains
the grant and its charge; no unsafe grant rollback. `exportBytes` is retained even
after external export deletion. This deliberately overcounts rather than guessing
reclamation. Pre-upgrade external exports lacking this field are not inventoried
by scanning outside state; any remaining historical exports require separate
trusted migration accounting. External deletion is not revocation.

No grant TTL or automatic revoked-grant GC: the existing coordinator cannot prove
all active/pending/handoff/restart/in-flight dependencies absent across processes.
No legacy tombstone GC. No seven-day receipt/clock GC: the Gate interface does not
prove terminal status plus idempotency retention. An uncertain pre-submit receipt
is preserved so later requests query rather than execute a second stop. Finite
storage therefore eventually refuses new runs/receipts or legacy generations;
**there is no promise of unlimited run creation/revocation or legacy churn**.
Repeated bounded rotations replace the one run record, not thousands of files.
Original Pi JSONL, model context, project files and Gate records are untouched.

Authenticated independent-management-origin `GET /api/management/storage`
returns only logicalBytes, files, activeGrants, revokedGrants, generationFiles,
receiptFiles, exportReservedBytes, limitBytes, activeGrantLimit,
securityReserveBytes and overBudget. No token/path/run ID/label/conversation
content; unauthenticated requests return 401, chat origin has no such route.
No new public/CLI diagnostic endpoint. The internal storageDiagnostics helper
uses the same writer fence. Unsafe/contended state fails closed.

## Transport and self-review

FIFO queue reserves complete uncompressed incoming bytes before retention/send.
It cannot move waiting messages into an unaccounted ws buffer. In-flight credit
requires BOTH send callback completion and zero outbound bufferedAmount.
Large second messages cannot wait; zero-byte floods have a 512-message cap.
Hub control frames share the same browser-outbound queue as ordinary frames.

Self-review reproduced an upstream slow-send close race: terminating the paired
browser immediately yielded 1006, hiding the intended reconnectable close.
The RED integration test now passes with 1013 / "Slow consumer; reconnect";
both peers get a bounded close grace, and further messages are not retained.
HTTP uploads/downloads remain streamed; excess HTTP compression demand uses
identity and no response cache. A full explicit 1 MiB UTF-8 JSON file preview
travels unchanged in both directions on a normally draining connection.
No extension stdout/stderr, latestCtx or feature interpretation was introduced.

Reviewed all persistent write call sites, replay membership, mixed-mode namespace,
post-await grant fences, separate-process quota/revoke races, callback/drain
credit, all generation regex consumers, unchanged 32hex operation IDs and
source-only staging. A final consumer audit caught the b2 Hub-home link omission:
RED null vs /sessions/, then GREEN; full source/static verification was repeated.
No unresolved concrete security/design ambiguity was found. Independent controller
review and packaged/real-Pi/browser validation remain Task 3, not claimed here.

## RED evidence (before corresponding production changes)

All commands below run from the worktree. Network tests use explicitly permitted
temporary local Unix/TCP sockets and subprocesses with synthetic credentials.
The first sandbox-only baseline hit `listen EPERM`; the permitted baseline passed
104/104. Node's pre-existing MODULE_TYPELESS_PACKAGE_JSON warning remains.

```text
node --import ./tests/register-ts.mjs --test --test-reporter=spec tests/hub-state-budget.test.ts tests/hub-bounded-registry.test.ts tests/hub-forward-queue.test.ts tests/session-registration.test.ts
tests 33; pass 20; fail 13; exit 1
```

Observed failures: negotiation `false !== true`; old Hub incorrectly received
legacy enrollment; missing quota/512-grant/writer-lock/symlink refusal; duplicate
serving ownership was admitted; missing bounded forwarding implementation.

```text
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='bounded successor|trusted managed|receipt admission|receipt clocks' tests/pi-client-managed-restart.test.ts tests/hub-portal-management.test.ts tests/hub-restart-api.test.ts
tests 5; pass 1; fail 4; exit 1
```

Observed failures: bounded successor link empty; bounded PiClient route fell back
to 1200 ms instead of 15000 ms; receipt quota admitted 202 instead of 409; clock
write under a held lock returned 200 instead of 409.

```text
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='browser admission|disconnected registry peers|concurrent backend proof' tests/hub-transfer.test.ts tests/hub-bounded-registry.test.ts
tests 3; pass 0; fail 3; exit 1
```

Observed failures with the prior looser caps: fifth pair admitted; disconnected
tail admission did not return HUB_BUSY; fifth proof returned 410 instead of 503.

```text
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='only two HTTP compressors' tests/hub-transfer.test.ts
tests 1; pass 0; fail 1; exit 1
actual ['gzip','gzip','gzip']; expected ['gzip','gzip',undefined]
```


Additional RED evidence from controller cap change and self-review:

```text
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='browser admission' tests/hub-transfer.test.ts
tests 1; pass 0; fail 1; exit 1
Error: Unexpected server response: 503
(the fifth pair still hit the former four-pair limit; then source raised to eight)

node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='stalled upstream send' tests/hub-transfer.test.ts
tests 1; pass 0; fail 1; exit 1
AssertionError: 1006 !== 1013

node --import ./tests/register-ts.mjs --test --test-reporter=spec tests/connection-path.test.ts tests/workspace-upload-client.test.ts
tests 14; pass 13; fail 1; exit 1
actual null; expected '/sessions/'
```

## Final GREEN commands and output

All executed from the worktree. Raw final logs are temporary local artifacts in
`/tmp/pi-hub-task2-verification.AfzGUF`, not committed or production logs.

```sh
set -o pipefail
node --import ./tests/register-ts.mjs --test --test-reporter=spec tests/session-hub.test.ts tests/session-registration.test.ts tests/hub-state-budget.test.ts tests/hub-bounded-registry.test.ts tests/hub-forward-queue.test.ts tests/hub-management.test.ts tests/hub-management-origin.test.ts tests/hub-gateway-login.test.ts tests/hub-restart-api.test.ts tests/hub-portal-management.test.ts tests/hub-lifecycle.test.ts tests/hub-runtime-api.test.ts tests/hub-runtime-portal.test.ts tests/runtime-control.test.ts tests/runtime-guard-process.test.ts tests/hub-transfer.test.ts tests/pi-client-managed-restart.test.ts 2>&1 | tee /tmp/pi-hub-task2-verification.AfzGUF/targeted.log
```

```text
ℹ tests 210
ℹ suites 0
ℹ pass 210
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 59203.391696
exit 0
```

```sh
set -o pipefail
mapfile -t source_tests < <(rg --files tests -g '*.test.ts' -g '*.test.mjs' -g '!hub-cli.test.ts' | sort)
node --import ./tests/register-ts.mjs --test --test-concurrency=4 --test-reporter=spec "${source_tests[@]}" src/web/src/core/i18n.test.ts src/web/src/components/pi-web-ui/sidebar-tree.test.ts 2>&1 | tee /tmp/pi-hub-task2-verification.AfzGUF/source-suite-final.log
```

```text
ℹ tests 563
ℹ suites 0
ℹ pass 562
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 41159.203692
exit 0
```

The optional 1 GiB streaming test is the one skip. Excluded hub-cli.test.ts runs
the tracked packaged dist executable, which is intentionally not rebuilt here;
Task 3 owns its verification. web-dist.test.mjs IS included: it uses synthetic
temporary manifests and does not rewrite repository dist. The earlier full run
before the final Hub-home regression was 562 tests / 561 pass / 1 skip / 0 fail.

```sh
./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/tsc --noEmit -p tsconfig.connection.json && ./node_modules/.bin/biome check . --max-diagnostics=10 && git diff --check
```

```text
TypeScript (both): no output, exit 0
Checked 260 files in 196ms. No fixes applied.
Found 33 warnings.
Found 7 infos.
Biome: 0 errors, exit 0
git diff --check: no output, exit 0
```

Focused post-review GREEN:
`node --import ./tests/register-ts.mjs --test --test-reporter=spec tests/connection-path.test.ts tests/workspace-upload-client.test.ts`
= 14/14, exit 0.
Cap/preview/close/five-Pi group = 4/4, exit 0.
The final full run includes all of them plus 2,000 real bounded rotations,
constant generation-file count, stale/cross-run/restart replay denial,
separate CLI grant-slot races and revocation during proof.
Node's existing MODULE_TYPELESS_PACKAGE_JSON and experimental MockTimers warnings
remain. Lint warnings are reported, not described as a warning-free run.

## Files and Task 3 handoff

New production files:
- extensions/hub-generation.ts
- hub/state-budget.ts
- hub/bounded-registry.ts
- hub/forward-queue.ts
- hub/limits.ts

Modified production: extensions/session-registration.ts; hub/config.ts,
management.ts, restart-api.ts, server.ts, asset-transfer.ts, portal.ts;
src/web/src/core/pi-client.ts and connection-path.ts.

New tests: tests/hub-state-budget.test.ts, hub-bounded-registry.test.ts,
hub-forward-queue.test.ts.
Extended tests: session-hub, session-registration, hub-restart-api, hub-transfer,
hub-portal-management, pi-client-managed-restart, connection-path,
workspace-upload-client.
Check registration: biome.json, tsconfig.connection.json.
Docs: docs/hub.md, docs/development-log.md and this required report.

**Task 3 manifest whitelist: extensions/hub-generation.ts is the sole new
extension module from Task 2.** Add it to the fixed source inventory (and matching
manifest fixture), alongside Task 1's already-reported additions, before rebuilding.
No dependencies or generated dist changed. Task 3 owns build/dist, packaged Hub/
real Pi, browser/mobile/screenshots and documentation validation. No deployment
or host edit was performed; docs describe the requested 2 MiB × 3 Docker-log budget.

## Commits

Implementation: `3960ce1954e1b18925d395f17f71dedeac3505f4`
(`feat(hub): bound registry state and slow-consumer queues`).
This SHA recording is the only change in the report-only follow-up commit,
`docs: record bounded hub Task 2 verification commit`.
Post-commit inspection: tracked worktree clean; only the original untracked
node_modules symlink remains. No dist or node_modules entry was staged.

## Task 2 fix round 1 — 2026-10-20

Base: `b74db5909fa709ff341cfe528200b6b9794aaea2`.
Independent reviewer: Volta `01a15815-1504-7770-afc3-fc9140d40bc3`.
Scope: the two Important findings only. Implementation and verification complete;
the separate fix commit is titled
`fix(hub): fence overquota state and cancelled handshakes`.
No full source suite, build, browser, deployment, push or subagent was run in
this fix round, as instructed. Earlier full-suite evidence above belongs to the
original Task 2 implementation, not this fix round.

### Changes and self-review

- Existing active-grant overcount now rejects ordinary writes and startup boot
  publication, even when the write uses the existing security-headroom option.
  Registration checks admission under the common writer both before and after
  backend proof, including write-free legacy renewals. Bounded issuance also
  checks admission before any idempotent-return path.
- The only count-recovery exception is an existing active grant changed exactly
  to `revoked: true`, with every other field unchanged and active count reduced
  by one. No general quota-bypass flag was added. Tests cover existing 514 grants
  → revoke → 513 (ordinary writes still rejected) → revoke → 512 (ordinary
  admissions recover). A token-changing purported revocation is rejected.
  Existing 513-grant startup rejection preserves every grant byte; after
  revocation, startup succeeds with all 513 grant files still present.
- Browser cancellation is checked after asynchronous proof and before creating
  the upstream. Pair credit remains reserved until the upgrade handler settles,
  the browser closes, and any created upstream emits close. Cleanup is
  idempotent, including abort after construction but before upstream open.
  The real-network fixture holds signed proof responses, aborts raw TCP browser
  sockets, and leaves backend upgrade handshakes unfinished. It observes actual
  Hub continuation completion through a pass-through listener wrapper; no
  production test interface or fake transport was added.
- Self-review checked both proof/close orderings, constructor/handshake failure,
  repeated credit release, grant preservation, the write-free renewal path,
  startup security-headroom behavior, and scope of the staged diff. Existing
  successful handshake, cross-origin rejection, 1 MiB preview, compression and
  five independent Pi-run routing cases remain green.

Files in this fix: `hub/state-budget.ts`, `hub/server.ts`,
`tests/hub-state-budget.test.ts`, `tests/hub-transfer.test.ts`, and this report.
No bounded-registry source or test change was needed; its covering suite ran.
No dependency, extension module or generated dist changes. The Task 3 manifest
handoff remains unchanged: `extensions/hub-generation.ts` is the sole new
extension module from the original Task 2 implementation.

### Exact RED/GREEN commands and output excerpts

All commands ran from this isolated worktree. Network/subprocess tests used
only temporary fixture state and local sockets with sandbox escalation.

Finding 1 RED, before quota production changes:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='pre-existing' tests/hub-state-budget.test.ts
```

```text
tests 3; pass 0; fail 3; exit 1
First two failures: AssertionError: Missing expected exception.
Third: renewal must not bypass admission just because it has no disk write
actual undefined; expected 'STATE_QUOTA'
```

Same command GREEN after quota changes:

```text
tests 3; pass 3; fail 0; cancelled 0; skipped 0
duration_ms 448.067998
exit 0
```

Finding 2 RED, before handshake production changes:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='browser abort' tests/hub-transfer.test.ts
```

```text
✖ browser abort during held proof never creates orphan backend handshakes
ℹ cancelled=9, backend handshakes=9, peak=9, pending=9
AssertionError: cancelled proof must never construct an upstream
9 !== 0
✖ browser abort retains pair credit until held proof settles
AssertionError: unfinished proofs must retain all eight admission credits
actual: 'HTTP/1.1 502 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
expected: /^HTTP\/1\.1 503/
✔ browser abort after upstream construction cleans hanging handshakes before capacity reuse
tests 3; pass 1; fail 2; cancelled 0; skipped 0
duration_ms 438.084977
exit 1
```

Before this behavioral RED, the test harness was corrected to wait for socket
close without rejecting the intentional ECONNRESET, and to combine four
unfinished upstream handshakes with four held proofs (respecting the independent
four-probe cap). The initial reset error and probe-limit timeout are not counted
as evidence of the production defect.

Same command GREEN after handshake changes:

```text
✔ browser abort during held proof never creates orphan backend handshakes
ℹ cancelled=9, backend handshakes=0, peak=0, pending=0
✔ browser abort retains pair credit until held proof settles
✔ browser abort after upstream construction cleans hanging handshakes before capacity reuse
tests 3; pass 3; fail 0; cancelled 0; skipped 0
duration_ms 474.785648
exit 0
```

Final covering tests, after formatting:

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec tests/hub-state-budget.test.ts tests/hub-transfer.test.ts tests/hub-bounded-registry.test.ts
```

```text
ℹ cancelled=9, backend handshakes=0, peak=0, pending=0
ℹ tests 44
ℹ suites 0
ℹ pass 44
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36233.907309
exit 0
```

This includes 2,000 bounded rotations, separate-process grant issuance races,
revocation during proof, all six new regression cases, draining 1 MiB previews,
and the eight-browser-pair boundary.

```sh
node --import ./tests/register-ts.mjs --test --test-reporter=spec --test-name-pattern='five independent Pi|WebSocket routing' tests/session-hub.test.ts
```

```text
✔ five independent Pi runs register and route without consuming browser-pair admission
✔ WebSocket routing injects proof and rejects cross-origin connections
tests 2; pass 2; fail 0; cancelled 0; skipped 0
duration_ms 462.070848
exit 0
```

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.connection.json
./node_modules/.bin/biome check hub/state-budget.ts hub/server.ts tests/hub-state-budget.test.ts tests/hub-transfer.test.ts
git diff --check
```

```text
TypeScript: no output, exit 0
Checked 4 files in 27ms. No fixes applied.
Found 1 warning.
Found 4 infos.
Biome: 0 errors, exit 0
git diff --check: no output, exit 0
```

The lint notices are pre-existing: one non-null assertion in bounded promotion
and four template-string suggestions in transfer tests. Node's existing
MODULE_TYPELESS_PACKAGE_JSON warning remains. Newly added test non-null
assertions were replaced with runtime assertions before the final checks.

### Compatibility, storage/diagnostics and remaining caveats

The concurrent **BROWSER cap stays eight pairs**, not eight Pi runs or sessions;
pending proof/handshake/cleanup now also occupies its credit correctly. A
cancelled proof retains credit until it settles or reaches the existing proof
timeout. The 264 MiB maximum admitted forwarding-payload calculation is unchanged
and is not a total-RSS guarantee under the 512 MiB container limit.

Storage diagnostics retain the same aggregate-only interface. An existing
overcount still reports its actual count and `overBudget: true`; ordinary
admission and boot now agree with that diagnostic. Recovery revocation still
must fit the existing byte/staging ceiling; this is not an automatic repair for
an already byte-oversized or unsafe store. No grants, legacy tombstones or
receipts are deleted. Preserve-only grant/receipt GC, no offline-grant TTL,
grant-first export publication and conservative retained export reservations
are unchanged. Export removal does not free its retained reservation, and quota
refusal remains possible; there is no promise of unlimited session churn.

No unresolved security/design ruling is needed for these two fixes. Hub-first
rollout and Task 3 packaged/build/real-Pi/browser validation remain required.
The original untracked node_modules symlink is preserved and is not staged.
