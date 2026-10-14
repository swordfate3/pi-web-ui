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
