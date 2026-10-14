# ADR 0012: Portable connection configuration and optional native registration

## Status

Accepted for this feature branch, 2026-10-14. Not deployed by this change.

The subsequent [ADR 0013](0013-package-owned-session-hub.md) adds an optional
package-owned hub. The client and one-process listener decisions here still
apply; the exclusion of a bundled registry is superseded for that separate role.

## Context

Local Web should not require a user's WSL launcher. An external gateway needs to
register the live Pi listener without patching extension source, and its prefixed
URLs must work without rewriting browser globals. The former ten-port retry also
imposed an arbitrary instance limit.

## Decision

- Keep one listener inside one Pi process, loopback-only by default.
- Centralize validated settings with explicit environment overrides.
- Advertise an optional public URL, without implying connectivity or login.
- Implement an explicitly configured native local-IPC registration client with
  capability credentials, bounded requests, renewals and generation fencing.
- Tie registration to the listener lifetime; stop/reload invalidates callbacks
  before asynchronous cleanup. Registry failure leaves local Web operational.
- Resolve built assets, WS and exports relative to the browser entry directory;
  isolate root PWA caching from proxied session paths.
- Retry occupied ports within a time/range bound, not a fixed session count.

## Scope and security

This adds an external-registry **client**, not an instance registry server,
multi-session daemon or process launcher. It therefore refines ADR 0006 without
changing its one-process/one-Web-UI boundary. User authentication, TLS, tunnel
creation, registry minting and host/container mounts remain deployment concerns.
The native HMAC contract identifies a process generation, not a logged-in user.

## Alternatives

- WSL-only source patch: rejected as a required product dependency; difficult to
  update safely and excludes other launchers/platforms.
- Integrated tunnel/auth/daemon in this change: deferred, expands lifecycle and
  security scope substantially beyond a portable connection client.
- Browser-global monkeypatches: rejected in favor of owned URL construction.

## Consequences

Existing local settings continue to work. Registry opt-in requires explicit
paths/capabilities and a matching trusted gateway. No real containers or external
infrastructure are migrated automatically. Native Windows/macOS behavior and
actual gateway deployment require separate validation.
