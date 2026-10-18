# ADR 0013: Package-owned optional session hub, not agent orchestration

## Status

Accepted for this local feature branch, 2026-10-14. No deployment or publication.
Supersedes the package-level registry exclusion in ADR 0006/0012; preserves the
one-Pi-process boundary of the extension itself.

## Decision

Ship an independently launched `pi-web-hub` CLI in the same package as the
extension. It owns scoped registration capabilities, leases, a portal and
HTTP/WebSocket routing, using the existing native Unix IPC client contract.
It never launches Pi, manages containers or executes remote administration.
There is no hidden daemon spawned during extension import.

Each live Pi has a unique capability and process generation. The administrator
chooses its label and backend host. Grant records and the generation ledger are
private state; IPC runtime and per-Pi credential files are distinct mount scopes.
No shared administrator credential, Docker socket, privileged container or
mandatory WSL service is required. Session lists are live memory, not persistent
online claims. Persist the ledger to reject links belonging to former hub boots.

Backend identity is challenged before enrollment and forwarding. Forwarding
strips browser-supplied proof, authentication and forwarding headers and injects
the session proof. Origin/Host checks supplement, but do not replace, gateway
authentication. This does not guarantee isolation from a hostile same-UID actor
or a target change between identity verification and forwarding connections.

An exclusive runtime lock precedes stale socket recovery and is held until
shutdown. After an ungraceful crash, lock recovery is deliberately manual and
fail-closed; PID guessing cannot safely authorize takeover.

## Consequences

The package no longer needs a user-specific WSL registry/router for opt-in
multi-session access. Existing single-session use and external registries remain
available. Linux is locally tested; macOS is not validated and native Windows
hub is unsupported until a safe IPC implementation exists. Authenticated TLS,
tunnels, supervised process startup, UID alignment and mounts remain deployment
responsibilities. Current remote onboarding templates remain single-session.

The generation ledger grows across lifetimes and has no automatic pruning.
There is no arbitrary fixed session-count limit. Review and monitor state growth
and service resources before public deployment. See [operating guide](../hub.md).

## Browser handoff after session replacement (2026-10-15)

Retiring a generation still closes its sockets and permanently invalidates its
URL. An already connected browser may now use an in-memory, short-lived Hub
capability to follow only that Pi's first verified successor. This is not a
redirect from the retired route, not selection of the most recently active Pi,
and not reuse of the administrator or registration credential. Revocation,
expiry, Hub restart and the disappearance of the bound successor stop handoff.
The browser replaces its address while keeping its mounted app and action
waiter; it never repeats `/resume`, `/new` or other lifecycle commands.

See ADR 0008 for the transport contract. Deployment requires the new Hub server
and browser assets together; a frontend-only update cannot teach an old Hub this
endpoint. The existing state, grants and generation ledger must be retained.

## Optional lifecycle delegation (2026-10-17)

An explicitly configured loopback lifecycle provider may receive a narrowly scoped
request to restart one managed Pi child. The Hub does not acquire Docker or shell
authority: an independent Gate validates its own lifecycle policy, image digest,
launcher labels, runtime configuration and immutable target identity, then calls
one fixed control client. Existing image-deployment auto approval is not authority
for process restarts. Old clients remain routable but do not advertise management.

Gateway access and registration credentials are not management authorization.
The trusted CLI issues a short-lived single-use pairing code; an additional
HttpOnly management session, same-origin writes and CSRF token are required.
The provider credential and management state remain Hub-private, outside all
Agent-shared home/runtime volumes. A lifecycle-only Gate token cannot deploy.

Hub persists an idempotency receipt before submitting. The Gate job ID is exactly
that key, so a lost HTTP reply is recovered by query, not repeat execution.
An explicitly armed managed handoff does not bind an arbitrary first successor:
Gate must report the original runtime/session/leaf, a new runtime and expected
loaded version, and Hub must prove the matching live registration. Only that
operation receives a bounded120-second browser wait. General handoff behavior
and permanent generation retirement remain unchanged. No message is replayed.

The container supervisor and trusted launcher are deployment responsibilities,
not a mandatory daemon hidden in extension import. Their runtime socket is private
to that container, not the shared Hub registry. No lifecycle provider configured
means management is unavailable, without changing standalone extension behavior.

## Optional global runtime update requests (2026-10-18)

An independent `runtimeUpdates` provider configuration delegates exact stable Pi
version requests to Gate's fixed loopback `/v1/runtime-updates` API. It uses the
ordinary request credential, not the lifecycle or administrator credential.
Management authentication, separate management origin, CSRF and revocation checks also protect
these routes. The browser never receives a Gate credential or approval ability.
Omitting this provider preserves existing chat and restart behavior.

Gate owns runtime policy, audited SDK versions, installation and safe consumer
refresh. Hub only submits and projects bounded public progress. A Hub image's
auto approval does not authorize runtime auto approval. Waiting for approval,
waiting for idle and recovery-required outcomes remain distinct from success;
the browser cannot clear a recovery block, force a restart or roll back software.
Old containers without trusted runtime control still need operator migration.

Before sending, the management page persists its task ID and exact version in
tab-scoped session storage. An uncertain reply is recovered with GET of that ID,
including after Hub restart and re-pairing; the browser never automatically
repeats POST. Gate owns the durable task record. No installation or refresh is
performed in the Hub or hidden inside extension import. See the optional global
update section in the [operating guide](../hub.md).

## Optional trusted gateway management login (2026-10-18)

Default deployments keep one-time management pairing. A separately configured
`management.gateway.credentialFile` permits an authenticated HTTPS gateway to
replace manual pairing: every management HTTP request must carry both a private
server-to-server proof and a valid authenticated user identifier. The gateway
must overwrite these headers after login, not forward client assertions.
The proof is independent of Gate request/lifecycle/admin credentials and never
enters the browser, chat backend, shared Agent home, URL or public response.

Only the separate management listener exposes the empty-body, same-origin
session-bootstrap route. It issues the existing short-lived HttpOnly/Secure
management cookie and CSRF token; subsequent writes retain Origin and CSRF checks.
Sessions are bound to the gateway user and current proof fingerprint. Missing,
unreadable or rotated proof fails closed even with a previously valid cookie.
An administrator can still revoke browser sessions without modifying login passwords.

The browser automatically bootstraps only on initial entry. After logout or an
expired/unknown request it requires explicit re-entry and never automatically
replays an update. Re-entry and logout use the existing serialized authorization
transition to avoid stale-response and late Set-Cookie races. Pairing is disabled
only for this explicit mode. All valid gateway users may request administration;
this is a single-owner trust decision, not per-user RBAC. Gate manual approval,
version/image allowlists, idle checks and recovery controls remain independent.
Distinct HTTPS origin, DNS and a private reverse forward remain deployment
prerequisites; sharing the chat origin is not a supported shortcut.
