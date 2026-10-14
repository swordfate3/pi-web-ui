# Package-owned session hub

Approved local implementation direction, 2026-10-14. No deployment migration.

## Outcome

Ship two roles in one package: the existing per-Pi extension, and an explicitly
started `pi-web-hub` process. The hub owns discovery, a mobile-friendly `/sessions/`
portal and generation-scoped HTTP/WebSocket routing. It does not launch agents,
run Docker, change server credentials or require WSL/systemd.

## Trust and lifecycle

- Default HTTP listener: loopback. Remote HTTPS/login belongs to the existing
  trusted reverse proxy; tunnel the hub's port, not individual Pi ports.
- Registration uses a private local IPC socket, never a public enrollment API.
- A trusted operator issues one capability per Pi listener. The operator retains
  the grants directory; a Pi container gets only its credential and IPC access.
  Credentials contain no administrator token. Host address and display label are
  assigned by the operator, not by registration requests.
- Challenge the backend before accepting registration, and inject generation
  HMACs into every proxied request. Do not accept backend host/URL from a client.
- Renew every 15 seconds; default lease is 45 seconds. Unregister/expiry/revoke
  closes that generation's WebSockets. One agent exit does not stop the hub.
- Persist grants and a generation ownership ledger, not online sessions. A new
  hub boot rejects generations from the previous boot; clients renew with fresh
  generations. Old links return 410 and cannot become another session.
- Never expose credentials, local absolute paths or conversation text in the
  portal. Browser metadata consists of an operator-assigned label, generation,
  online timestamp and relative link.
- Require same-origin browser requests; permit only configured public origin
  or the actual loopback hub origin, and reject spoofed proof/forwarding headers.

## Interfaces

`pi-web-hub init|serve|issue|revoke --config <file>` owns central JSON configuration
and private state. `issue --output <file> --label <name> [--backend-host <host>]`
produces the existing extension capability format. No privileged container or
Docker socket needed. Explicit backend-host supports reachable container IP/DNS;
the default loopback works with Linux host networking or local Pi processes.

The session extension continues accepting `registration.socketPath` and
`registration.credentialFile`, including their existing environment overrides.
Standalone use remains unchanged. Root redirects to the portal. Session routes
are `/s/<generation>/`; session links use configured public URL when supplied.

## Local acceptance

Test capability scoping, HMAC challenge, request bounds, backend port reuse,
expiry, revocation, restart and HTTP/WS routing. Exercise two real Pi processes
and a real browser through the hub; quitting one leaves the other operational.
Capture desktop and mobile portal screenshots. Validate package files, type
checks, existing tests and frontend build. Do not commit/push or mutate running
WSL, Docker or Aliyun deployments as part of this local task.
