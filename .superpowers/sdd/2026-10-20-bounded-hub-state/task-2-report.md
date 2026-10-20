# Task 2 report — 2026-10-20

Status: DONE_WITH_CONCERNS. Source implementation, self-review and final checks
are complete; no failing check, permission blocker or controller ruling remains.
Task 3 packaging/integration and the operational limitations below remain explicit.

Worktree: `/home/fate/gitproject/codex_project_v2/pi-web-ui/.tmp/worktrees/bounded-hub`.
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
