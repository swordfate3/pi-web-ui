# Task6 — centralized opt-in native-terminal wiring

Implemented/verified 2026-10-22 on `codex/trusted-terminal-runtime`, base
`a180f9a6964170d17be3da14348d34b56a04d011`. This is source implementation and
isolated acceptance, **not live deployment or independent review approval**.

## What changed

- The existing central launcher has explicit terminal on/off and local/remote
  startup choices, early prerequisites, exact profile/label/PATH, and the actual
  Compose logging overlay. Ordinary launch arguments are unchanged.
- A separate image derivative installs manifest-verified broker/client/supervisor
  and mirror assets root-owned outside mutable mounts. Pi itself launches from
  the existing shared installation; normal SSH/model preparations are retained.
- Source-only Hub overlay mounts only the two dedicated provider directories
  read-only. No provider/Docker/whole-Gate mount is added to Pi.
- The controller-approved diagnostic uses the existing root0600 admin boundary,
  fixed host→Gate admin transport, live frozen provider allowlist, closed image
  request/exact success shape,4096byte bounds and one2second host budget. It does
  not call Engine, grant target execution, change policy, reserve admission, or
  add a provider-wire operation. Missing/old/unavailable Gate fails closed.
- Actual root `pi-dockerctl` help, [operating guide](../../trusted-terminal.md),
  verified staging/distribution fixtures, and native Playwright-BDD are included.

## Fresh results and limits

| Check | Actual result |
| --- | --- |
| Admin focused | RED9 tests/10 failing assertions; GREEN9/9 |
| Launcher focused | RED27 incl20 existing; GREEN27/27, then full suite below includes2 added source-contract regressions |
| Shared-version source / SSH-model preparation ordering | Each focused1failed →1passed; real native preparation also verified |
| Missing image capability supplemental boundary |1/1 prereq test (five refusal subcases),0.369s; post-implementation coverage, not a new behavioral RED |
| Deterministic stage/tamper refusal |2/2 GREEN; initial missing-module and sandboxEPERM are setup history, not behavioral tamper RED |
| Final full Gate |373/373,104.733s, exit0 |
| Final full pi-docker |143 run,140 passed,3 skipped,40.194s, exit0 |
| First full repository Node suite |752 tests:748 passed,3 failed,1 skipped; all3 failures were new staging-script fixture/inventory integration omissions |
| Corrected covering package/inventory/staging suite |58/58,6.842s, exit0; full Node suite was not repeated—Task7 owns final whole-suite acceptance |
| Final `just check` |exit0,317 files,32 existing warnings/7 infos; first5 owned formatting errors fixed |
| Connection/E2E TypeScript and owned Biome |exit0; owned4 files have no warnings/errors |
| Final build / dist correspondence |exit0; existing Vite large-chunk warning retained; source/output hash consistency is not authenticity |
| Native BDD final |1/1,20.5s runner, real installed Pi1.1.0 TUI, no RPC/synthetic child substitution |
| External patch forward/reverse |12/12 exact before/final/rollback hashes verified in a disposable fixture |

Commands/raw excerpts are retained in [test-evidence.txt](test-evidence.txt), with
full local-log references in the task's append-only SDD report. The3 pi-docker
skips are the live Hub test gated by `PI_REAL_HUB_TEST=1` and2 live ordinary-Docker
tests gated by `PI_REAL_DOCKER_TEST=1`; they would use existing host services or
production-named volumes and were deliberately not enabled. The Node skip is
the existing opt-in1GiB streamed-upload stress check. No old-port excuse is
applied to the3 real new-script integration failures.

The earlier native attempts remain disclosed: bare cached image ID was parsed as
a registry reference by BuildKit; a test redundantly clicked Disconnect after
input rejection had already closed it; wheel over nested xterm did not scroll
the outer viewport. Each attempt cleaned its exact resources. Final test uses a
unique checked local base alias and scrolls outer padding; no CSS was changed.

## Actual native chain

### Review fix round 1: cleanup failure paths

Independent review R1 found that the original fixture's successful cleanup did
not cover partial initialization or cleanup exceptions. The fixture now guards
the exact provider-IPC volume role, attempts all recorded owned resources even
after errors, aggregates incomplete-cleanup failures, and leaves failed entries
retryable. Exact name/label checks and the cached-base immutable-ID check remain;
no broad removal or prune was introduced. A timed-out cleanup probe is itself
tracked and removed. Failed socket verification cannot be silently upgraded to
a socket proof by a later cleanup retry.

[Fix-round evidence](fix-round-1.md) records behavioral RED (four failures and the
real one-volume IndexError) followed by GREEN, including the final9/9 mocked
cleanup cases. Only disposable temporary files are real; Docker/Engine calls
are substituted. No native, broad regression suite or live operation was rerun.
The native run/screenshots below remain the original successful acceptance,
not evidence of running the amended fixture against Docker. Existing warning
debt (R2) and final whole-suite acceptance remain deferred to Task7. This fix
does not change the external patch/provenance or require rebuilding dist;
`npm run verify:dist` still verifies the unchanged release inventory.

### Original installed-native acceptance

[Structured evidence](native-evidence.json) records actual Gate preflight before
Pi creation, runtime/Gate immutable IDs, child PID18/PPID1/kernel start27959636 and
shared CLI source/Pi1.1.0. All later event reads independently recheck that kernel
identity, not just Docker supervisor PID1. Native confirmation produced false
then true and exactly one temporary effect; Chinese input, custom panel/BETA,
120x40→96x30 actual native resize, local reclaim/rejected remote input, local
command and new explicitly acquired remote command all ran on that same child.

Actual Hub UID1000/cap-dropALL read the root:GID1000/0640 provider credential
through the dedicated read-only mounts. Pi had no provider or Docker mount.
Actual installed Compose config and container inspect showed logging `none`, no
LogPath, and no retrievable native marker after exit. SSH/model preparation used
only synthetic inputs. Normal exit0, helper disappearance after disconnect,
Gate/Hub socket removal and exact empty resource inventories passed.

The isolated service intentionally has no production-named home/runtime volumes:
Gate's unchanged admission rejects renamed authority volumes. It therefore
exercises the same absolute Pi path in the image's ephemeral home, not an actual
shared-volume upgrade. Launcher/credential tests separately preserve ordinary
Compose arguments. No production-volume test or install/update of shared Pi was
performed. Manual relaunch consumes the then-installed shared Pi path; terminal
inventory still makes no current/new child-version claim. The historical frozen
`/opt/pi-terminal-agent` candidate was corrected before final acceptance.

## Separate visual gate

Actual Playwright Chromium screenshots were opened and inspected at1440x1000
(chat),1440x1100 (terminal) and390x1000 (mobile emulation), on isolated loopback
chat/terminal origins with dynamically allocated ports, now stopped:

- [Startup read-only chat](1440-native-chat-readonly.png): clear read-only banner,
  history-only empty state and disabled composer.
- [Native confirmation bottom](1440-native-confirm-bottom.png): after real outer
  wheel scrolling, both Yes and No, keyboard-navigation hint, bottom border and
  native footer are visible. The unscrolled max55vh viewport is not missing rows.
- [Mobile native panel bottom](390-native-panel-bottom.png): ALPHA, selected BETA,
  GAMMA and native footer visible, readable wrapped control rows and96x30manual
  size. Long native rows deliberately scroll horizontally inside the viewport;
  the page itself does not overflow horizontally or auto-resize the TTY.
- [Mobile renewed handoff](390-native-handoff.png): REMOTE_AGAIN visible, matching
  acquired target/control statuses and usable explicit input controls.

Wheel over xterm may be consumed by its nested handler; outer padding scrolling
was actually exercised, not inferred from overflow CSS. Screenshot evidence is
not a pixel assertion or physical-device certification. Composition events are
browser-dispatched; physical OS IME, phone/Safari, public hostname/gateway and
real user extension approvals remain separate gates.

## Exact external provenance and rollback

[host-source.patch](host-source.patch) is the precise Task6 delta for12 external
files; [provenance.json](provenance.json) gives exact host paths, before/final
SHA256 and modes. Those external files are **not themselves committed in this
repository**. All direct host source edits used precise permission-aware
escalated `apply_patch`. New files have null before hashes and standard
`/dev/null` patch headers, not fabricated originals.

For overlapping Gate service.py the base is reviewed **Task4 final**, not the
pre-Task4 baseline. Gate admin.py/gatectl use Task6-start copies; launcher,
entrypoint and actual root CLI use preserved original SDD host-baseline copies.
All14 other Task4 final files still match. Ordinary Dockerfile, Compose files and
original launcher tests remain byte-identical to their saved baselines.

There is one disclosed evidence gap: `pi-web-hub-session` was transiently edited
and the worker's additions were reversed before introducing the new dedicated
preflight helper, but no independent original before-copy was captured. Its final
hash is recorded; no reconstructed baseline, exact unavailable inverse patch,
or independently proven original byte-equality is claimed. It has no intended
Task6 delta and was not edited again.

Do not apply this patch to live hosts without separate authorization. For an
authorized source checkout, first verify **every** before hash and absence of new
paths, then from the parent of `pi-deploy-gate`/`pi-docker` use
`patch --batch --forward --dry-run -p1 -i <absolute-patch>` before applying the
same patch without `--dry-run`. For rollback first verify every final hash, then
`patch --batch -R --dry-run -p1 -i <absolute-patch>` before the authorized reverse
apply. Restore/check recorded file modes explicitly if needed (unified text
patches do not encode chmod). Reverse removes only Task6 new files and restores
Task4-final overlapping sources; it does not roll back Task4 provider/admission
or touch state. Both directions were applied and hash-checked only in a temporary
fixture, which was removed.

All owned final resources used prefix `pi-task6-29efb1538992`: tags
`:cached-base/:runtime/:gate`, containers `-gate/-hub/-pi`, volumes
`-state/-ipc/-credentials`, and self-removing `-cleanup-probe`. They are gone;
earlier attempt prefixes were also cleaned. No prune was used; ordinary build
cache may remain. No live up/restart, user token, production volume, `.env` read,
pi-sandbox retag, policy edit, DNS/Caddy/tunnel/password change, merge/push,
worktree, subagent or Task7 run. Independent controller review and separately
authorized public deployment/device acceptance remain outstanding.
