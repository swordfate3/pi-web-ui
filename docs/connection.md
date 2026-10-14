# Portable Web connections

Pi Web UI runs inside one Pi process. Local Web use needs no WSL, Docker,
registry, Alibaba account, or tunnel script. This page describes the portable
connection implementation; it does not install or operate a public gateway.

## Local use

Start Pi with the extension installed. The listener starts automatically on
`127.0.0.1:3001`. Its actual URL is shown in Pi's status/notice. If the port is
occupied, it tries successive ports up to 65535, with a 15-second retry deadline;
there is no fixed eight- or ten-session limit. `/webui` opens the advertised URL
using the platform browser opener and enables existing advanced session controls.
`/webui-stop` stops the listener; `/webui-start` starts it again.

Settings are read from `settings.json` in Pi's agent directory, normally
`~/.pi/agent`. `PI_CODING_AGENT_DIR` overrides that directory. Restart Pi or reload
the extension after editing settings; refreshing the browser alone is not enough.

```json
{
  "pi-web-ui": {
    "host": "127.0.0.1",
    "port": 3001,
    "disabled": false
  }
}
```

## Options and precedence

Explicit environment variables take precedence over the corresponding setting,
then defaults apply. In particular, `PI_WEB_UI_DISABLED=false` overrides
`disabled: true`. Host/port validation failure prevents listening and reports a
generic error; it never silently broadens access. Invalid optional public URL or
registration configuration leaves local Web usable with a generic warning.

| Setting under `pi-web-ui` | Environment override | Default |
| --- | --- | --- |
| `host` | `PI_WEB_UI_HOST` | `127.0.0.1` |
| `port` | `PI_WEB_UI_PORT` | `3001` |
| `disabled` | `PI_WEB_UI_DISABLED` | `false` |
| `publicUrl` | `PI_WEB_UI_PUBLIC_URL` | None |
| `registration.socketPath` | `PI_WEB_UI_REGISTRY_SOCKET` | None |
| `registration.credentialFile` | `PI_WEB_UI_REGISTRY_CREDENTIAL_FILE` | None |

`PI_WEB_UI_DISABLED` accepts `0`, `1`, `false`, `true`. Ports are integers from
1 through 65535. Existing `PI_WEB_UI_STATIC_DIR` and Pi session-directory overrides
remain available. Registration is enabled only with both valid path options.
No machine-specific IPC path is inferred automatically.

## Phone on the same LAN

Binding to `0.0.0.0` makes the listener reachable on network interfaces:

```sh
PI_WEB_UI_HOST=0.0.0.0 pi
```

The phone must have a route to the computer and use the computer's LAN address
and actual listening port. The status's loopback URL is for the computer, not
the phone. Firewalls, Docker port publication and host networking are separate
deployment concerns. Wildcard binding does not open firewall rules.

**This Web UI can control the agent and has no built-in login.** Do not expose
the raw listener to untrusted LAN users or the Internet. Use an authenticated
TLS gateway, a trusted private network, or another access-control boundary.
Localhost-only binding is the default, not an authentication mechanism.

## Public URL and reverse-proxy subpaths

```json
{
  "pi-web-ui": {
    "host": "127.0.0.1",
    "port": 3001,
    "publicUrl": "https://agent.example.com/session-a/"
  }
}
```

`publicUrl` advertises the browser entry and is used by `/webui`. It creates no
tunnel, listener, DNS record, TLS certificate or login. It accepts HTTPS, or HTTP
only for loopback testing. Credentials, query strings and fragments are rejected.
A missing trailing slash is normalized in the advertised URL.

Configure the proxy to redirect `/session-a` to `/session-a/`, forward HTTP and
WebSocket upgrades, and strip the prefix before forwarding:

| Browser request | Backend request |
| --- | --- |
| `/session-a/` | `/` |
| `/session-a/assets/...` | `/assets/...` |
| `/session-a/ws` | `/ws` |
| `/session-a/api/exports/<token>` | `/api/exports/<token>` |

The browser uses its own entry directory for assets, WebSockets and exports;
there is no global `WebSocket`/`fetch` monkeypatch. Each tab can use a different
entry. Subpath pages do not install a service worker. The root worker caches only
its shell/assets, not proxied sessions, APIs, or other applications. A browser
with an older root worker must update it by revisiting the root deployment, or
clear that site's old worker/cache before validating a migrated gateway.

## Optional native session registration

An external registry may provide a per-process public URL. Enable its client:

```json
{
  "pi-web-ui": {
    "registration": {
      "socketPath": "/run/pi-web/registry.sock",
      "credentialFile": "/run/secrets/pi-web-session.json"
    }
  }
}
```

These are example container paths, not hard-coded defaults. The deployment must
provide a live registry and a valid capability file readable by the Pi user.
For Docker, mount the IPC directory containing the socket and a single credential
file; the credential file should be read-only. Read-only socket-directory mounts
do not by themselves prohibit sending requests to the socket. Do not mount all
of a host home directory simply to expose this capability.

The extension uses Node local IPC: Unix sockets on Unix-like systems, named pipes
on Windows (for example `\\.\pipe\pi-web-registry`). Native Windows/macOS runtime
behavior has not been verified in this change. The registry implementation is
external, not bundled; its protocol must match the contract below.

The capability file has `run_id` (32 lowercase hex characters) and `token`
(64 lowercase hex characters), maximum 4096 bytes. It is a secret minted by the
trusted launcher/registry, not a model API key. Do not commit or paste it into
chat. Credentials and remote error text are never included in notices.

### Protocol contract

- Newline-delimited local IPC JSON request: `action` (`register`/`unregister`),
  `run_id`, `token`, `generation` (random 32-hex ID), and `port` for registration.
- Success response: `{"ok":true,"result":{"url":"https://gateway.example/s/<generation>/"}}`.
  Unregister may return an empty result. Replies are limited to 8192 bytes and
  each request has an absolute five-second deadline.
- Renew every 15 seconds. On an `ended generation` error, obtain a new generation
  for the next renewal. Otherwise retry without interrupting the local listener.
- Stop/reload fences late replies, cancels renewal, and unregisters the old
  generation. A new listener lifetime gets a fresh generation; conversation
  branching is not a new server lifetime.
- Registry-provided valid URLs take precedence over `publicUrl`; failure falls
  back to configured `publicUrl`, then the local URL.

The gateway can verify `GET /.pi-web-identity` with a 48-hex challenge and
`x-pi-web-challenge-proof = HMAC-SHA256(token, challenge)`. The response includes
`generation` and `proof = HMAC-SHA256(token, challenge + ":" + generation)`.
HMAC uses the token's literal string as its key, not decoded hex bytes.

For proxied HTTP/WS, the gateway supplies `x-pi-web-generation` and
`x-pi-web-proof = HMAC-SHA256(token, generation)`. Missing/incorrect pairs are
rejected with 409; direct local requests with neither header remain allowed.
These proofs fence stale process routes; **they are not human authentication**.
The gateway must authenticate users, strip untrusted client-supplied routing
headers, add its own proofs, use TLS and enforce its own lease expiry.

## Migration from WSL-specific adapters

The built-in client replaces the need for a source-hash patch or injected WSL
registration extension. The existing external registry/router/tunnel can still
be reused by supplying the two paths and mounting them into the container.
Do not run both an injected registration adapter and this native client for the
same process. A container started without required mounts must be recreated;
Pi reload cannot add Docker mounts. Replacing deployment adapters and restarting
real containers are separate operations, not performed by this feature branch.

## Boundaries

This does not bundle tunnel providers, a registry daemon, a login page, QR pairing,
or multi-agent process management. Local Web is independent of WSL; public mobile
access still needs reachable networking and trusted authentication infrastructure.
See [ADR 0012](adr/0012-portable-web-connection.md) and the
[validation report](validation/2026-10-14-portable-web-connection.md).
