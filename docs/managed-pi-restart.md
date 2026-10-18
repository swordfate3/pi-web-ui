# Apply installed Pi updates through the Hub

This is the deployment and operating contract for the managed-restart feature.
It is not evidence that an existing installation has been upgraded or enabled.
Keep the current Pi sessions and chat gateway running while preparing the new
components. Do not replace a user's active container to test this feature.

## What the operation does

An administrator selects one saved, idle Pi conversation. Hub asks a separately
authorized Gate to restart **that Pi child process once**. A supervisor remains
inside the same container and retains the foreground terminal. The successor
loads the already-installed executable and restores the exact saved conversation
and branch. Hub follows only its verified new registration.

It does not run npm update, rebuild an image, restart Hub, recreate the Pi
container, replay a prompt, or select the latest available conversation. There is
no automatic retry/crash loop or automatic downgrade.

```text
Chat HTTPS origin ──────────→ Hub chat listener → selected Pi Web UI

Separate admin HTTPS origin → Hub management listener
                              │ independent lifecycle credential
                              ▼
                            Gate → fixed in-container control client
                                     ▼
                                  supervisor → exact Pi child/session
```

Only Gate has Docker management access. Ordinary Pi and Hub do not receive the
Docker socket, the Gate administrator socket or a global administrator token.

## New image and launcher prerequisites

The administrator-controlled Pi image must contain the supervisor, fixed control
client, shared launch-policy/model-sync helpers and pre-SDK stdin guard under
`/usr/local`. These are image-owned files, not replacements loaded from a shared
Pi home volume. The entrypoint is `/usr/local/bin/pi-entrypoint`.

The reviewed guard source is shipped as `extensions/runtime-stdin-guard.mjs`.
The image build context's `runtime/pi_stdin_guard.mjs` must be a byte-identical
copy installed at the fixed image-owned path; ordinary Pi never loads a
replacement from its writable package checkout. The integration harness checks
both staged-source parity and the actual test image's guard checksum. Unit
security tests use the shipped implementation, not an external host directory
or a substitute stub, so a clean package checkout can run them.

The trusted launcher gives each eligible interactive container a stable run ID
and the lifecycle label. UID/GID1000, cap-drop ALL, no-new-privileges, existing
workspace mounts and named volumes remain unchanged. Installation, update,
help/version, print/RPC and unsupported launches retain their direct behavior.

An old container cannot gain these image files or launcher labels through an
extension update or `/reload`. It continues to chat normally, but is not eligible
for managed restart. Recreating one is a separate, explicit administrator action
that ends its current Pi process. Do not migrate all live sessions implicitly.

## Independent Gate policy

The lifecycle policy is separate from image-deployment service policies. A Hub
image with automatic deployment does **not** authorize Pi process restarts.
Lifecycle defaults to disabled. After installing and validating the new Gate
source, the host administrator can inspect its offline help and live policy:

```bash
./gatectl lifecycle --help
./gatectl lifecycle-policy --help
./gatectl lifecycle
```

Approve only the reviewed new Pi image's full `sha256:` image ID:

```bash
./gatectl lifecycle-policy manual --image sha256:<reviewed-64-hex-image-id>
# Or, after validation, explicitly allow daily phone requests without host approval:
./gatectl lifecycle-policy auto --image sha256:<reviewed-64-hex-image-id>
```

Manual jobs can wait for approval without consuming the execution/readiness
deadline. Host-only operations are separate from existing image-deployment jobs:

```bash
./gatectl lifecycle <32-hex-job-id>
./gatectl lifecycle-approve <32-hex-job-id>
./gatectl lifecycle-reject <32-hex-job-id>
./gatectl lifecycle-policy disabled
```

Use `lifecycle-resolve --help` only after inspecting an uncertain outcome. It
records an explicit administrator decision; it is not a second restart attempt.

## Hub-private lifecycle credential

`lifecycle-export` creates a new0600 file in an administrator-selected private
host directory; it never displays the token and does not enable the policy:

```bash
./gatectl lifecycle-export /absolute/private/directory/pi-lifecycle.json
```

Provision that file into **Hub's existing private state** as an administrator,
readable by Hub's UID1000. Do not put it in `pi-home`, `pi-runtime`,
`pi-user-home`, a project or an ordinary Pi credential directory. Do not paste it
into an agent conversation. It is not the ordinary Gate request token.

## Separate management origin is required

Registered Pi pages can execute JavaScript. A different path on the chat origin
is not a security boundary for privileged management. Configure a genuinely
different browser origin for the management listener; it never serves Pi HTTP
content, files, workers, WebSockets or arbitrary upstream redirects. No CORS
permission is granted to Pi pages.

For local testing, distinct127.0.0.1 ports suffice. For a phone, provision a
separate HTTPS management hostname/origin behind the existing trusted gateway
and login. Keep the existing chat origin unchanged. A second tunnel/reverse-proxy
route may be needed for the management listener. This package does not create
DNS, TLS certificates, Caddy entries, SSH tunnels or firewall rules for you.

Merge these **additional properties** into the existing private Hub config;
retain its state/runtime paths and existing grants:

```json
{
  "port": 16181,
  "publicUrl": "https://pi.example.test/",
  "management": {
    "port": 16183,
    "publicUrl": "https://pi-admin.example.test/"
  },
  "lifecycle": {
    "endpoint": "http://127.0.0.1:16182",
    "credentialFile": "/hub/private/pi-lifecycle.json"
  }
}
```

The domains above are documentation examples, not working user endpoints. Both
listeners bind loopback. No management config means no management listener or
authority; existing standalone chat use is unchanged. A configured provider alone
does not turn the chat origin into a management endpoint.

## Pair and use

From a trusted Hub administrator terminal, generate a single-use10-minute code:

```bash
node /opt/pi-web-ui/dist/hub/pi-web-hub.mjs pair --config /hub/private/config.json
```

Enter it directly into the dedicated management page. Do not send it to the
model. Gateway login and management pairing are separate. The management session
is short-lived; each restart also requires same-origin/CSRF checks and the exact
selected runtime/session/branch. To revoke management sessions:

```bash
node /opt/pi-web-ui/dist/hub/pi-web-hub.mjs revoke-management --config /hub/private/config.json
```

Select the correct card and confirm “apply installed update and restart this Pi”.
If there is no newer installed version, this is a current-version restart, not an
upgrade. Keep the management page while it queries the operation; a lost reply
does not justify pressing restart again. Queries reuse the saved operation ID.

The old child has30seconds to exit gracefully; no SIGKILL is used. The new child
has120seconds to become ready. Manual-approval delay is not charged to these
deadlines. Gate success alone is not initial Hub success: exact restored identity,
expected loaded version and verified live registration are all required before
Hub persists an in-budget completion bound to that operation and receipt.

An authorized later query retains that validated historical success after normal
conversation progress, session switch/quit, generation rotation or Hub reopen.
The current recovery link is a separate live-proof decision: it is omitted when
the original verified generation and exact successor identity are no longer
available. The page explains link unavailability without calling the completed
restart a failure. Choose the current session explicitly from the online list;
an old operation or browser handoff never redirects to an arbitrary new route.
Queries do not renew a handoff lease, rewrite completion time, bypass revoked
run grants or turn an unverified Gate result into historical Hub success.

SIGHUP/SIGTERM cancels restart admission and in-flight work. If shutdown races
with process creation, the published child also receives the graceful signal;
the supervisor waits for its exit without force-kill or another spawn. Foreground
SIGINT retains its normal Pi-terminal behavior and does not request a restart.

Gate and Hub use a fixed210-second total from actual execution start, including
bounded preflight, checking, stop, spawn, readiness and final observation. It is
not reset by polling or reconnecting. An overhead stall beyond its allowance is
an uncertain outcome requiring inspection; it does not permit force-killing Pi
or a second restart. Browser recovery separately allows120seconds from the old
WebSocket's actual disconnection. Waiting for manual approval consumes neither
the execution budget nor a still-live browser connection's recovery budget.

## Conservative terminal eligibility

The runtime-control adapter currently audits Pi **1.1.0 and 1.3.0**. Both retain
the image-owned stdin guard; unknown SDK versions remain ineligible rather than
being assumed compatible. Pi 1.3.0 was checked using an isolated real Docker TUI
for exact session/leaf recovery and terminal/async-command protection. Updating
this allowlist requires the same real-runtime validation, not just a version
string change. See [the validation record](validation/runtime-control-1.3.md).

SDK idle state cannot prove that arbitrary terminal commands, extension dialogs
or background shell operations have finished. The image-owned guard observes the
verified SDK stdin-data path before listeners and permanently marks unverified
terminal activity as ineligible for remote restart. Unknown or fragmented
terminal reports may conservatively do the same. Untracked Web extension commands
also make the process ineligible.

This uncertainty does **not** disappear by waiting, canceling, `/reload`, resume
or reconnecting. Start a new Pi locally if remote restart is refused for this
reason. Ordinary terminal input, plugins and normal `/quit` still work; the guard
does not disable them. During an accepted prepare, new input is rejected without
buffering or replay. This is not isolation from malicious code inside Pi, an
alternate terminal reader or arbitrary autonomous plugin work.

## Where records live

| Item | Owner/location | Lifetime |
| --- | --- | --- |
| Source and launcher | administrator's pi-docker source directory | host files; included in reviewed image |
| Supervisor/guard/control | `/usr/local` inside Pi image | image-owned; not Agent-writable home |
| Control socket and recovery snapshot | `/run/pi-runtime` inside each Pi container | private0700/0600; not shared across containers |
| Pi executable | existing `pi-runtime` mount | retained; update installation is a separate operation |
| Conversation and settings | existing `pi-home` mount | retained; no deletion or prompt replay |
| Gate policy, lifecycle jobs and audit | Gate-private `/state/jobs.sqlite3` | persistent Gate state, separate lifecycle tables |
| Lifecycle request token | Gate-private state; provisioned copy in Hub-private state | never ordinary Pi/shared home |
| Hub management epochs and restart receipts | Hub-private `stateDir` | pairing/revocation state and bounded operation receipts |
| Hub online registration/routes | Hub runtime/memory plus normal Pi renewal | live availability, not another conversation copy |

Same UID and shared Pi home/runtime volumes are not a hostile-agent isolation
boundary. The feature limits the authorized lifecycle operation; it does not turn
a shared development environment into a multi-tenant security sandbox.

## Failure and rollout

Check a failed or uncertain job before doing anything else. Saved conversations,
workspaces, credentials and other Pi containers are not cleaned up on failure.
There is no private old-version executable copy for automatic rollback.

Roll out source, image and optional config only after isolated tests and review.
Keep lifecycle disabled until image identity and the separate management origin
are verified. Provisioning a production credential, enabling auto policy,
changing gateway/tunnels, restarting Hub/Gate, or recreating a user's Pi requires
an explicit deployment decision. A source commit is not a deployed feature.
