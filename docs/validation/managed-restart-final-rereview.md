# Managed restart — scoped final F1/F2 re-review

Date: 2026-10-17. Reviewer role: independent source reviewer, not implementer.

## Verdict

| Item | Verdict |
| --- | --- |
| F1: external shutdown / child-publication race | **ADDRESSED** |
| F2: validated historical outcome versus current recovery link | **ADDRESSED** |
| Compliance with the scoped final-fix specification | **PASS** |
| Quality and security of the fixes and their immediate interactions | **PASS** |
| Remaining actionable source findings in this re-review | **None identified** |
| Ready-to-commit review disposition | **APPROVE from the F1/F2 source-review perspective; main must complete its fresh acceptance and artifact checks** |
| Production activation / source installation | **Not authorized or performed by this review** |

This closes the two blocking findings in the original final review. It is one scoped re-review, not a second whole-branch audit or an assertion that post-fix broad acceptance has already passed. The original review's other scope and deployment boundaries remain in force.

## Scope and evidence boundary

Read the original `managed-restart-final-review.md`, `managed-restart-final-fix-brief.md`, and `managed-restart-final-fix-report.md` fully. Inspected the affected staged supervisor and new shutdown tests, Hub restart resolver and management portal, affected test coverage, and operating text. Followed only the immediate existing lifecycle-validation, successor-proof, and handoff consumers needed to assess F2 regressions. No Gate redesign, broader architecture work, or unrelated source review was undertaken.

Independent work here was source/control-flow review and read-only file hashing. No test suites or runtime probes were executed; no subagents, Git commands, installs, builds, live Docker, external calls, production operations, or source edits were used. The only written artifact is this report. Verification-before-completion guidance was used to keep source-review conclusions separate from supplied execution evidence.

The fix report supplies: shutdown tests 4 methods / 28 scenarios PASS; existing supervisor 21 PASS; guard-overhead tests 6 PASS; focused Hub/portal/browser-timing tests 41 PASS; connection TypeScript and scoped error-level Biome PASS, with preceding RED evidence. I inspected the relevant regression assertions but **did not independently rerun these results**. Earlier broad-suite, real-Docker and repeated Chromium evidence predates these final fixes and is not substituted for main's fresh post-fix acceptance.

## F1 — ADDRESSED

File: `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py`.

- Admission checks the shutdown latch under the state lock at line 421; reserved dispatch checks it at line 463. A worker that races the dispatch check still encounters cancellation on entry at line 505.
- Checks after snapshot, version lookup and prepare at lines 382, 396 and 403 prevent blocked checking work from resuming an accepted restart after shutdown. Cancellation is checked again before the managed stop signal under the lock at line 548, after the old-child wait at line 562, around model sync/spawn at lines 567 and 570, and after readiness observation at line 601.
- The creation/publication gap is explicitly coordinated at line 238: `spawning` is published under the lock before creation, `Popen` does not hold the shutdown lock, and assigning the new child and forwarding the latched signal occur together under the lock at line 249. If shutdown wins before creation is admitted, creation is rejected; if it races a creation already in progress, publication signals the resulting child. There is no successor retry.
- `forward_signal` at line 682 latches shutdown and fails a running operation. `finish_operation` at line 496 serializes completion with that latch and prevents a later worker success from overwriting shutdown. This permits success that genuinely completed before shutdown, without permitting success after shutdown wins.
- The main loop at line 708 observes child/publication/shutdown state together and cannot return solely on the old child's exit while publication is in flight. It waits for the published child's graceful exit. Signal handlers precede initial startup at line 697. Foreground SIGINT remains the existing no-op parent handler at line 690; the child still receives terminal SIGINT. No Pi force-kill or prompt replay was introduced.

Regression coverage inspected in `/home/fate/gitproject/codex_project_v2/pi-runtime-restart-work/pi-docker/tests/test_shutdown_races.py`: admission/reservation at line 54; both signals across ten restart boundaries at line 68; actual synthetic subprocess shutdown during old-child stopping at line 136; and an event-coordinated concurrent creation/publication/main-loop scenario at line 169. The latter separately asserts waiting before publication and waiting after graceful signal delivery until child exit. This directly exercises the previously missed lifetime boundary rather than merely asserting an operation status.

The publication case uses controlled process doubles; the separate old-child-stop cases use actual subprocess signals. These are appropriate complementary focused tests, not evidence of an actual Pi/Docker/PTY shutdown run in this review.

## F2 — ADDRESSED

Main repository: `/home/fate/gitproject/codex_project_v2/pi-web-ui`.

- `hub/restart-api.ts:107` preserves the first trusted execution timestamp. `hub/restart-api.ts:121` still validates the Gate success identity against the original receipt before accepting either initial or historical success.
- `hub/restart-api.ts:135` validates persisted completion against the operation ID, run, original generation/runtime/session/leaf, immutable start time, successor runtime/version, bounded nonfuture verification time, and local generation-path format. A prior file's mere existence is not sufficient historical authority.
- `hub/restart-api.ts:154` and `hub/restart-api.ts:176` retain the execution deadline for initial verification. Without a validated completion, the resolver still requires the exact live successor and persists its evidence before issuing initial success; a missing registration remains pending inside budget and fails after budget.
- `hub/restart-api.ts:170` separates the two decisions: validated history retains the successful job result, while `path` is returned only when current exact proof produces the same saved generation path. Missing proof, changed leaf/session, exit, or a different generation cannot replace historical success with a registration timeout or substitute a latest route. The historical branch does not rewrite completion time or create a new handoff.
- Run-grant checks remain before provider observation and after the asynchronous live proof (`hub/restart-api.ts:104`, `:106`, `:169`). Management-route authorization remains in place. Narrowly traced the existing successor consumer at `hub/server.ts:289`: exact identity is checked both before and after backend proof. The handoff consumer at `hub/server.ts:544` still checks its own expiry/grant and requires a successful result **with a path**; historical success without a path produces denial, not another-generation recovery.
- `hub/portal.ts:155` removes a previous response's path before merging a new poll result. `hub/portal.ts:142` explains unavailable current linkage without presenting the completed restart as failed. This covers the submission-response-to-poll stale-field case. It does not claim that completed rows are continuously re-polled: terminal rows still stop polling at `hub/portal.ts:153`; link availability is a point-in-time observation and existing route checks remain authoritative on navigation.

Regression assertions inspected at `tests/hub-restart-api.test.ts:599` cover leaf progress, session switch/exit, generation rotation and actual fixture Hub reopen, both immediately and after deadline passage. They require historical success, omitted path, stale-handoff denial, byte-unchanged completion evidence and one execution submission, followed by authorization/revocation checks. Binding mutations are covered at line 644 and revocation across held live proof at line 679. `tests/hub-portal-management.test.ts:201` exercises removal of a previously returned submission path and the unavailable-link explanation. Existing initial-proof, immutable-clock and successor-renewal race coverage was also inspected for interaction with the changed branch.

Operating text at `docs/managed-pi-restart.md:166` and `docs/hub.md:86` describes initial proof versus historical outcome/current link, with shutdown behavior at `docs/managed-pi-restart.md:182`. No new API status, authority-bearing frontend event, or Gate contract is required.

## Residual load-bearing boundaries and release prerequisites

1. **Old development completion files intentionally fail closed.** They lack the newly required binding. This is accepted for the stated unactivated feature; it is not a migration guarantee and not an unresolved F2 defect. Do not loosen validation or fabricate records to make old fixtures succeed. Any future preservation/migration requirement needs separate review.
2. **Graceful shutdown is not guaranteed forced termination.** A child that ignores the graceful signal, or an uninterruptible creation call, can delay exit. The reviewed behavior intentionally waits rather than killing Pi or spawning again. This preserves the accepted safety contract.
3. **Historical evidence remains within the existing trust and availability model.** Hub-private records and authenticated lifecycle results remain trusted inputs; this is not protection against an administrator rewriting all private state, nor an offline history service when the provider cannot answer. Current path proof and handoff expiry remain separate from historical success.
4. **Main owns fresh post-fix integration acceptance.** Rebuilt packaged Hub/dist and Pi image, broad suites, actual two-container/browser repetitions, and visual verification of unavailable-link wording remain outside this review. No claim of their completion is made here.
5. **The old 26-path install package remains invalid.** Regenerate the manifest, hashes, modes, exact patch and backups against corrected source, including the new staged `pi-docker/tests/test_shutdown_races.py` path, and repeat exact temporary-copy application/comparison. Adding this file makes 27 host paths if the previous 26-path inventory is otherwise unchanged; main must establish the final inventory, not reuse the old count. This approval does not re-enable an invalidated script or authorize production activation.

No residual blocking source concern was identified within F1/F2 or their induced interactions. The prerequisites above are evidence/deployment boundaries, not requests for another implementation round.

## Independently observed source identity

The staged runtime/test hashes match the final fix report. Hashes below were read from the reviewed files, not inferred from supplied test output.

```text
d3c259e1dc0462699d77724173d1940111405842669addca6f1f14bdecb11ce0  pi-runtime-restart-work/pi-docker/runtime/pi_supervisor.py
fcd63f97642972a852eb67e3b3d7d2a5e9aa1cf8da80bb4055389f1b1b034ba6  pi-runtime-restart-work/pi-docker/tests/test_shutdown_races.py
d6559f4e0e499258420b966c465f7917bd409836230ab2704aa31d4031d6665b  pi-web-ui/hub/restart-api.ts
7ada905284def7892cadd6aba2fbf3c69fbcb2d98d7ce5468438dbc9f72fd47f  pi-web-ui/hub/portal.ts
2fb3028051bbcd3a60f24758a36e2737ef695a589084885bbf1cd8331ea31749  pi-web-ui/tests/hub-restart-api.test.ts
1d18cb6bc546e116ad5a68766e17dc8f49bbb0bf7781fa354260714361ce0dd1  pi-web-ui/tests/hub-portal-management.test.ts
23d17fb98d2717d91f7f229faee86a6a2d705104c4173c718da9dd1a2ecd9a56  pi-web-ui/docs/managed-pi-restart.md
936b1c5746b7342a24fc12763405f92de821735c7e7f1eccd3db3a40f11e1db6  pi-web-ui/docs/hub.md
```

Paths in this hash block are relative to `/home/fate/gitproject/codex_project_v2`.
