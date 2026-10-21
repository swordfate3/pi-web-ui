# Trusted native terminal (explicit opt-in)

This mode keeps one installed Pi TUI child for both local terminal use and a
separately authorized browser terminal. It is not an RPC shell, generic container
exec facility, or a second Pi session. Ordinary browser chat is **read-only from
startup** in this profile; all mutations go through the native terminal.

The source integration is default-off. These instructions do not authorize a
live deployment, Gate policy change, Hub restart, public hostname change, or
reuse of production resources for testing.

## Ordinary use and explicit startup

Ordinary `pirun` keeps its existing Compose arguments, mounts and behavior.
`PI_PIRUN_WEB_TERMINAL` defaults to `off`. Terminal startup requires all of:

- A local interactive TTY, saved native TUI session and extensions enabled.
- A deliberately built terminal-capable image selected by canonical immutable
  `sha256:` image ID, not a mutable tag.
- The trusted Gate already running the reviewed admin diagnostic and enabled
  terminal provider with that exact image in its frozen allowlist.
- An already configured, healthy Hub with its separate terminal listener and
  the two narrow provider mounts. The terminal public hostname must differ from
  chat/admin hostnames; another port alone is not isolation.

After a separately authorized installation/configuration, opt in per invocation:

```bash
PI_PIRUN_IMAGE=sha256:<approved-64-lowercase-hex-image-id> \
PI_PIRUN_WEB_TERMINAL=on pirun
```

Local input initially owns the terminal. To start with neither local nor remote
ownership (the browser must still explicitly acquire):

```bash
PI_PIRUN_IMAGE=sha256:<approved-64-lowercase-hex-image-id> \
PI_PIRUN_WEB_TERMINAL=on PI_PIRUN_WEB_TERMINAL_CONTROL=remote pirun
```

`on|off` and `local|remote` are closed choices. Missing TTY/Hub/provider/image
capability, unknown profile/owner, print/RPC/maintenance/update operations,
`--no-session`, and `--no-extensions` fail rather than silently falling back.
Preflight happens before issuing a run credential or launching Pi. Launcher
failure cleanup releases only the credential that invocation issued.

The host preflight uses the existing fixed trusted Gate admin transport and its
root-only0600 admin socket. It asks only for one immutable image and checks an
exact versioned success shape from the **live frozen provider policy**. It never
infers readiness from socket existence, an absent-run EOF, or policy on disk.
Request/response are bounded to4096bytes and the complete host invocation has a
single2second absolute budget. This point-in-time check is not future target
admission, authentication, or a reservation: provider reinspection remains the
final authority. An old/unavailable Gate fails closed; source changes do not
update an already running Gate.

## Pairing, handoff and stopping

Use the existing trusted host `pi-web-hub pair-terminal` command for the exact
run/runtime/session/terminal epoch and requested read/write scope. Paste the
one-time code manually on the separate terminal page; never put it in a URL or
reuse chat/admin credentials. Pairing, connecting and acquiring control are
separate deliberate actions. The page never auto-connects, reacquires, retries
input, or renews a lease. Writer leases last30seconds, connections at most300.

- Local `Ctrl+]`, then `w`: yield input so an explicitly connected browser can
  request it. It does not itself grant a browser a lease.
- Local `Ctrl+]`, then `l`: reclaim input and fence remote writes.
- Local `Ctrl+]`, then `Ctrl+]`: send the literal prefix to Pi.
- Browser text is a draft until Send is clicked. Enter is a separate explicit
  terminal key. IME composition blocks sending; manual resize is explicit.
- Rejected/unknown delivery disconnects and is not retried. Check the actual Pi
  state locally before deciding whether any action needs to be performed.
- Disconnect/release or hide/leave the page to lose browser authority. This
  closes its helper, not the Pi child. Exit Pi normally to end the run.

The terminal picture has its own scrollable viewport; on a small screen or tall
native dialog, scroll **inside** it to reach bottom choices. Horizontal scrolling
is also deliberate: browser viewport changes do not silently resize the native
TTY. Use the size controls when a different native size is desired.

## Version source and manual updates

Supervisor, broker, fixed client and mirror adapter are root-owned image assets
outside writable home/workspace mounts. Pi itself is **not frozen in a second
image copy**: the fixed child command uses `/usr/local/bin/node` and the installed
Pi CLI at `/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
The image-owned SDK link resolves to this same package. Normal Compose still
mounts shared `pi-runtime` at `/home/node/.local`; normal SSH-copy/permission and
model synchronization preparations run before either profile launches Pi.

The global update contract is unchanged: a successful install changes the shared
package, not this running child's version. Terminal consumers report
`manual_restart_required` / `installed_manual_restart_required`, with no claimed
old/new child version or managed restart. Exit Pi and explicitly relaunch to read
the then-installed shared package; managed restart remains refused. Updating the
immutable broker/client/adapter requires a separately reviewed image rebuild,
new image ID, and separately authorized Gate configuration/deployment—not a
shared Pi package update. This task does not perform a production package update.

## Build and Compose boundary

Build-time staging verifies the complete release source/output manifest before
copying a closed inventory into a **new** directory:

```bash
npm run build:web
npm run verify:dist
node scripts/stage-terminal-image.mjs --output <new-context-directory>
```

`Dockerfile.terminal` is a separate explicit derivative; ordinary `Dockerfile`
and `pi-sandbox` are not replaced. Supply the verified context as the named
BuildKit context `pi_terminal`, and a reviewed local base reference via build
argument `PI_TERMINAL_BASE`. Check the base ID before building and resulting
immutable image ID afterward. A bare local `sha256:...` ID is not a portable
BuildKit `FROM` reference; the isolated test uses its own checked local alias,
never retags the user's `pi-sandbox`. No runtime protocol accepts a build path,
executable, destination container, or arbitrary helper argv.

The terminal-only `compose.terminal.yaml` overlay sets logging driver `none`
(Compose run has no `--log-driver` option), plus memory/CPU/PID limits. The
launcher explicitly sets canonical PATH
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, exact profile/run
environment and profile label. It preserves UID/GID1000, cap-dropALL,
no-new-privileges and normal data mounts. Root-owned inventory is verified at
build and entry; failed verification cannot launch an inherited fallback.

The source-only `compose.hub-terminal.yaml` adds only dedicated provider IPC and
credential directories read-only to Hub. Gate owns their image-initialized
root:GID1000 parents and separate0660 socket/0640 token. Pi receives neither
provider mount, whole Gate state, nor Docker socket. The matching Gate Compose
configuration/policy remains Task4's reviewed default-disabled source. An overlay
does not enable a listener, create authorization, or grant deployment permission.

## Validation, rollback and remaining deployment gates

[Task6 evidence](validation/2026-10-21-task6-terminal-wiring/README.md) records
focused tests, actual installed native-Pi Playwright-BDD, independent kernel child
PID/start-time checks, screenshot inspection, exact external deltas/hashes and
cleanup. Native TUI is the narrow approved exception to the normal RPC E2E
convention; existing RPC scenarios are unchanged. The faux model only replaces
model responses. Tests use temporary synthetic inputs and disposable resources,
never personal tokens or production volumes. Browser-dispatched composition and
desktop/mobile emulation do not certify physical OS IME, phone, Safari or the
public gateway. An actual shared-version install/upgrade is not claimed by a
fixed version-source test.

To stop using the new profile, exit its Pi normally and omit the opt-in variable
on the next launch. Do not replace files beneath a running child to imply that
it has refreshed. External rollback uses only the Task6 reverse patch after
checking final hashes; its base for overlapping Gate code is **Task4 final**,
not the original pre-Task4 file. Leave unrelated Task4 provider/admission changes
and production data intact. Review the versioned provenance before any apply.

Public activation remains separate: reviewed image publication/allowlist,
Gate/Hub rebuild and deployment, initialized dedicated-volume metadata, listener
and distinct-hostname configuration, external-origin/security checks, physical
device acceptance, and operator rollback authorization. No live service, policy,
volume, DNS, Caddy, tunnel or password was changed for this implementation.
