# Hub: create a managed Pi in an allowed project directory

Approved in conversation: add New Pi to the trusted Hub management page. The
only selectable host root for this deployment is `/home/fate/gitproject`,
initial selection `pi_projects`. Existing directories only; no mkdir/delete.
This is a new capability, not a claim that the interactive pirun script already
supports detached operation. Delivery is an isolated development branch, not a
production rollout.

## Architecture and alternatives

Use the existing dedicated Hub-to-Gate management credential and fixed protocol.
Gate owns a fixed, administrator-installed Docker launch profile. Hub owns the
directory picker and displays progress; it does not receive Docker or host shell
access. Direct Docker access in Hub would expand the trusted web process's
authority; a separate general host command daemon would duplicate Gate. Neither
alternative is used.

The fixed launch engine uses Docker detached mode with open stdin and a TTY,
the image-owned entrypoint/supervisor, UID/GID1000, no-new-privileges, cap-dropALL,
host networking and the existing named home/runtime/config/cache volumes. Only
the selected workspace is bound at /workspace, not its parent project root.
The engine never invokes a workspace script or interactive host .bashrc.
Optional environment and auxiliary binds come only from the private launch
profile, never from HTTP. No .env loading is introduced.

Gate provisions one independent Hub grant per launch using fixed CLI operations
against the configured immutable Hub container image. Its Docker exec target,
CLI, config and export paths are server-controlled. An exported credential is
copied to a dedicated administrator directory outside the project root, then
only that launch's file is bound read-only into Pi. Pi receives neither the
other grants nor Hub/Gate private state. All command output is private and
bounded; no token, environment value or raw Docker error enters HTTP/logs.

## Directory boundary

Browse takes a root-relative POSIX path, not a host absolute path. Root is the
empty string. Reject absolute paths, traversal, empty interior components,
backslashes, controls, links in any component and non-directories. Walk using
no-follow directory descriptors; list directories only. Capture selected
directory device/inode in a revision and recheck it before dispatch. Recheck
the fixed profile revision too. Reject detected replacement or link changes.
This is an HTTP path/selection guard, not a complete isolation promise against
a malicious host administrator, daemon, or same-UID concurrent filesystem
attacker. Do not claim realpath alone closes the daemon's bind-resolution race.

Directory enumeration is bounded: at most4096 scanned entries, 200 directories
per page, explicit nextCursor/truncated. Private profile and credential roots
must not overlap the selectable root in either direction. Gate sees the
selectable root read-only for browsing; only the selected project is writable
in the Pi container. Missing/inaccessible default directory is shown, never
silently created or replaced with a broader root selection.

## Wire contract

All routes are below `/v1/hub-management`, mirrored below
`/api/management/gate`, and require the dedicated management credential.
The browser additionally needs trusted management origin, cookie and CSRF.

- GET `/launch-config`: `{enabled,rootLabel,defaultPath,revision,maxActive}`.
  revision is64lowercasehex. Disabled is an explicit supported result.
- GET `/workspaces?path=<relative>&cursor=<name>`: query keys path and cursor
  only, single occurrences; path defaults to empty. Returns
  `{path,parent,revision,entries:[{name,path}],truncated,nextCursor?}`.
  parent is null at root; revision is selected directory identity64hex.
- POST `/launches`: exactly
  `{id,path,label,policy_revision,workspace_revision}`; id32hex, revisions64hex,
  label nonempty trimmed <=80characters without controls, relative path <=1024.
- GET `/launches`: `{jobs:[LaunchJob]}`, newest first, <=256records.
- GET `/launches/<id>`: exact LaunchJob.

LaunchJob: `{id,path,label,status,stage,created_at,updated_at,run_id?}`; status is
queued/starting/running/exited/failed/recovery_required. Public stages are
server-owned safe identifiers, not raw exception output. No credential paths,
templates or environment values. Hub may add `sessionUrl` only when the exact
run_id currently has a registered live generation in this Hub; link uses the
chat origin. Docker running alone is not registration-ready.

## Lifecycle and idempotency

Clicking Start is the explicit authorization for this bounded launch operation;
no second host approve is needed. Feature defaults disabled until a trusted
administrator installs the launch policy and required mounts. The profile pins
Pi and Hub image identities and all authority mounts; browser cannot override.

Persist the canonical request under its browser-generated id before side
effects. Same id/same payload returns the saved job; changed payload conflicts.
The browser persists id and request before POST and refuses to submit if that
storage fails. Unknown result is queried using that id, never re-POSTed or
replaced automatically. Explicit New Another Pi creates a new id; same directory
may have multiple independently named Pi containers.

Only one launch worker executes at a time. At most16live or unresolved launch
jobs and256retained jobs; full storage refuses new work, not eviction. Launch
admission/execution is fenced against Gate upgrades, runtime updates and existing
deployment/lifecycle work. Deterministic container names and exact id/ownership
labels permit read-only reconciliation after ambiguous Docker creation. Never
blindly reissue an ambiguous grant or repeat create/start after uncertainty.
Persist stages before grant/create/start. On restart unfinished side effects
become recovery_required unless their exact recorded result can be proved.

Closing the browser, locking management, restarting Hub or restarting Gate
does not stop a running Pi. Gate shutdown joins its own short bounded worker,
not the Pi lifetime. Only after an exact owned container is proven exited may
Gate revoke its grant and remove its known temporary credential/container;
cleanup failure remains visible/recoverable. Never delete projects, volumes,
other containers or grant history. Registration waiting is displayed separately
from process running, including a helpful timeout message and original job id.

## Portal behavior and acceptance

Add a visible New Pi entry to the existing portal: chat-origin entry links to
management; directory list/details/form only render on trusted management.
Default pi_projects selection, parent navigation stops at gitproject, current
directory can be selected, optional user-facing label defaults to folder name.
Show confirmation, lifecycle state, original task id and exact current session
link. Stable polling preserves path/name drafts; auth generation checks discard
late results, and lock clears private paths/jobs. No terminal page is added.

Acceptance includes real temporary filesystem/SQLite/HTTP tests, negative auth
and request-token tests, symlink/traversal/sibling-prefix and changed-directory
rejections, pagination, duplicate/lost-response/restart cases, fixed Docker
request construction, cleanup isolation and refusal to alter protected mounts.
Actual Pi detached registration must be tested in disposable resources before
claiming Docker end-to-end support. Synthetic browser screenshots cover desktop
and phone and are explicitly not Docker/Pi E2E. Rebuild tracked dist and verify.
Document the one-time launch-profile and read-only root/private-credential mounts;
ordinary extension update alone does not install this capability. No production
credentials, volumes, service restarts, pushes or merges are part of this task.
