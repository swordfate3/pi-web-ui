# Single existing Hub — native-terminal production rollout

Date: 2026-10-22. Branch: `codex/single-hub-terminal-deployment`.
User explicitly approved the single-Hub rollout. Published Hub source commit:
`0f6caeb5a876363336c97fe08805d7cec980d7b8`. No second Hub, Pi migration,
ordinary-image replacement or shared Pi package update was performed.

## Result and entry points

- Existing chat portal: `https://pi.swordfate.cn/sessions/` (unchanged).
- Separate native-terminal origin: `https://terminal.swordfate.cn/`.
- Existing Caddy gateway credentials were preserved. Terminal access additionally
  requires an independently scoped one-time terminal pairing code.
- Native mode is explicit per new `pirun`; ordinary startup remains unchanged.
  The six Pi consumers present at rollout start kept their IDs, start times and
  images. A seventh ordinary user container started during final checks; it was
  left untouched. Disposable acceptance containers were exited, not retained.

The operator guide is centralized at
`/home/fate/docker_files/pi-docker/docs/native-terminal.md` and linked from the
host usage guide. [Generic profile boundary](../../trusted-terminal.md) still
applies; this dated record supersedes its historical *not deployed* statement
only for this particular host and these exact approved images.

## Closed host changes

- Gate accepts only the complete three-file terminal browser inventory, with
  explicit size/type/duplicate limits and deterministic asset digest. Old
  releases retain their two-element artifact return contract. The repository
  Dockerfile is never accepted as Gate build instructions.
- Optional administrator policy `terminal_provider: true` adds exactly two fixed
  read-only provider mounts. An opted-in target can migrate from the exact old
  two-volume template or validate the exact four-volume template. Partial,
  writable, wrong-name or option-drifted provider mounts are refused.
- Provider volume names are forbidden as writable Hub state even without the
  opt-in. Absent policy fields keep their historical normalized/hash shape;
  saved job policies and database records were not rewritten.
- Gate sealing now covers `terminal-policy.json`; the closed `.dockerignore`
  explicitly includes that existing Dockerfile input. The live policy allows
  only the immutable terminal image below, rather than arbitrary Pi images.
- Host Hub lifecycle/config rendering understands the exact four-volume shape.
  The provider Compose entries are read-only with `nocopy: true`.
- Gate retains the only Docker socket. Pi receives neither provider volume.
  Hub receives only the provider IPC and credential volumes, read-only.

`host-source.patch` and `provenance.json` record exact non-secret source/test
deltas against the private pre-rollout backup. They are an audit/reproduction
artifact, not a blanket authorization to deploy elsewhere. Live private config,
Gate database, Caddy password hashes, custom gateway headers, SSH keys and
pairing codes are deliberately excluded.

## Deployed identities

| Component | Immutable identity |
| --- | --- |
| Terminal Pi image | `sha256:3603564462e1b5b6f3912239aff3605074c2b1f430f068d58809e5b7f242501d` |
| Ordinary Pi image, unchanged | `sha256:1a23ab4104c1d806a9cd2370f508ed04d83ea79c48ebdf9da8d99ae904cebae8` |
| Gate image | `sha256:8e572f3f6901ea77db75783302abdfdfd4e0caca671d6ebdf195be2fd2d4f965` |
| Hub image | `sha256:1bc4e71622c17c178c4760dffb3eff0eda61512ae6e5399db8c151150209cd43` |
| Hub Gate request | `3971fea975eec3fba230e84f69e4ea3e`, automatic, `deployed / complete` |
| Hub plan | `bd8b191c894a95b9d501877b09998a1371ea14800f9b5dc4c1cc5146dde992b0` |
| Hub policy revision | 2; opt-in only, mode `auto` retained |

Hub fixed mounts:

```text
pi-web-hub-private                  -> /hub/private                  RW
pi-web-hub-runtime                  -> /run/pi-web-hub               RW
pi-terminal-provider-ipc            -> /run/pi-terminal-provider     RO
pi-terminal-provider-credentials    -> /run/pi-terminal-credentials  RO
```

The live private Hub config additionally enables port16184 with the separate
terminal public URL and fixed provider socket/credential paths. No unrelated
private configuration key or login password was changed.

## Remote route

```text
phone browser
  -> terminal.swordfate.cn HTTPS + existing Caddy gateway login
  -> Aliyun loopback 127.0.0.1:13003
  -> restricted reverse SSH tunnel
  -> existing local Hub terminal listener 127.0.0.1:16184
  -> dedicated provider Unix socket (Hub RO mounts)
  -> Gate-admitted, explicitly selected native Pi child
```

Only port13003 was added to the restricted account's authorized-key and SSHD
PermitListen lists. It listens on loopback, not a public interface. SSHD and
Caddy configuration validation passed before reload. Existing chat13001 and
management13002 routes remain unchanged; all three local tunnel services are
active. The new unit source is centralized under
`pi-docker/systemd/pi-web-terminal-tunnel.service`.

## Verification and honest limits

| Check | Observed result |
| --- | --- |
| Full Gate regression | 399 tests passed |
| Full Pi host regression | 146 run; 143 passed, 3 intentionally gated skips |
| Real isolated Docker migration | two-to-four RO migration, subsequent strict validation, explicit rollback, unhealthy-candidate rollback and owned-resource cleanup passed |
| Independent scoped re-review | approved; 56 focused tests independently passed; provider writable-role ban, Compose nocopy, Dockerignore inclusion rechecked |
| Actual production-backed browser acceptance | temporary empty workspace; actual pirun, installed Pi1.3.0, provider, browser pairing, complete WebSocket native snapshot, writer lease and `/model` picker passed |
| Native effects | picker opened then cancelled; no model request, package update or model selection committed |
| Handoff | local yield, browser input and subsequent local reclaim passed; only exact disposable acceptance Pi exited |
| Visual validation | actual Chromium screenshots inspected at1440px desktop and390px mobile emulation; native model list visible; mobile terminal deliberately scrollable, controls wrap inside page |
| Baseline | original six IDs/start times/images, settings/models hashes and ordinary-image ID unchanged |
| Final services | Gate/Hub healthy; Gate idle; upgrade reservation clear; live terminal preflight passed |
| Published assets | root HTML, `/terminal.js`, `/terminal.css` equal verified release bytes |
| Public edge | direct real-IP TLS verification passed, unauthenticated request401; foreign chat Origin403 |
| Physical phone / authenticated public WebSocket | **not tested**; local real-browser WebSocket is not evidence of public authenticated browser connectivity |

Before the successful browser run, one attempt stopped because the current
Playwright package expected an absent browser revision. The final run used the
already installed Chromium executable. Another attempt's pairing CLI refused;
no cause was established and no lock/auth state was deleted to force recovery.
All attempts ran only disposable acceptance containers and cleaned those exact
containers. The final successful run and baseline check are recorded separately.

An ordinary hostname request on this WSL host resolves through proxy Fake-IP
`198.18.x.x` and timed out for both the new terminal and existing chat hostnames.
Using the actual Aliyun IP with the original TLS hostname succeeded. No proxy,
DNS or phone-VPN settings were changed to mask that client-routing limitation.

## Private backups and rollback

Complete host backup:
`/home/fate/docker_files/pi-docker/backup/terminal-deploy-20261022-i6_ye042`.
Includes consistent SQLite online backup, source/seal, original Hub config and
original consumer baseline. An earlier incomplete backup is not the recovery
baseline. Remote backup:
`/opt/caddy-sub2api/backups/native-terminal-20261022T025611Z`.

Gate retains the exact old Hub container as
`pi-web-hub-gate-backup-3971fea975eec3fba230e84f69e4ea3e`.
Before any rollback, verify the live Hub still equals this request's candidate
and check unrelated drift. Restore/remove only the added terminal config using
the private pre-rollout config, then invoke trusted-host Gate rollback with this
exact request ID and plan digest. Do not restart the old Hub with a terminal
config it does not support. Preserve both Hub volumes and the Gate database.

The optional terminal route can be disabled independently by stopping only
`pi-web-terminal-tunnel.service`; do not stop chat/admin tunnels. Remote config
restore requires a current diff and validation, not blind overwrite of backups.
Gate source/image rollback must use its reservation-protected upgrade protocol,
not direct Compose recreation or database deletion. No rollback was needed.
