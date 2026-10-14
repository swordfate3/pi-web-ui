# Portable Web connection design

## Approved scope

Pi Web UI remains the UI of one live Pi process. Local use must not require WSL,
Docker, a registry, or an SSH tunnel. Default bind address is `127.0.0.1`, port
`3001`; an occupied port advances to the next free port, within a 15-second
deadline and the TCP port range. No fixed session-count limit is introduced.

Connection options live in `settings.json["pi-web-ui"]`, with explicit environment
overrides. Existing `host`, `port`, and `disabled` settings remain compatible.
New options are `publicUrl` and `registration: { socketPath, credentialFile }`.
The registry is optional and explicitly configured; no WSL-specific default path
is built in. Node local IPC supports Unix sockets and Windows named pipes.

Registration speaks the existing newline JSON capability protocol (register,
unregister, run ID, token, generation, actual listening port). Renew every 15
seconds. Timeout, malformed replies, missing credentials, and unavailable registry
must not prevent local use. Credentials and remote errors never appear in notices.
Stop/reload invalidates pending callbacks before awaiting resource cleanup.
Generations are unique per server lifetime, not per conversation tree node.

The optional identity endpoint and authenticated generation headers preserve the
existing gateway contract for HTTP and WebSocket upgrades. They identify a process,
not a logged-in human. Remote exposure still requires an external authenticated
TLS gateway. A configured public URL only advertises a URL; it creates no tunnel.

The browser resolves assets, WebSockets and export attachments relative to its
entry directory, including `/s/<generation>/`. Do not monkeypatch browser globals.
Subpath pages do not install a service worker that can cache a former live session.

## Non-goals and rollout

No built-in login, QR pairing, tunnel provider, daemon, registry server, or process
launcher. Do not change npm/Git distribution strategy in this branch. Do not edit
the existing dirty checkout, deploy to pi-docker, restart containers, merge main,
or push without a separate request. Deliver a tested feature-branch commit.

## Evidence required

Config validation tests, real IPC contract and lifecycle tests, signed identity and
generation tests, occupied-port tests, frontend subpath/export tests, current unit
regressions, static checks, production build, and isolated real Pi/browser checks.
Report untested platforms and actual gateway deployment separately from fixtures.
