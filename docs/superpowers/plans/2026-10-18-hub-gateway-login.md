# Hub Gateway Login Implementation Plan

> **For agentic workers:** Execute the tightly coupled authorization flow in this session; run an independent security review before deployment. Steps use checkbox syntax for tracking.

**Goal:** A phone user authenticated by the existing HTTPS gateway can request audited Pi updates without obtaining a pairing code from a computer.

**Architecture:** Preserve the separate management origin. An opt-in gateway configuration requires a private shared request credential and an authenticated user header on every management request. The browser exchanges that verified gateway identity for the existing short-lived HttpOnly management session and CSRF token; Gate policy remains unchanged.

**Tech Stack:** TypeScript, Node HTTP, existing Hub management sessions, Caddy Basic authentication, SSH reverse forwarding.

**Spec:** User-approved design in this conversation, 2026-10-18: existing login credentials replace pairing for configured gateway mode; mobile update requests remain subject to manual Gate approval.

## Global Constraints

- Default pairing behavior remains unchanged when gateway mode is absent.
- Management and chat origins remain distinct; no management API, cookie or gateway credential is exposed to Pi backends.
- Accept neither client-supplied identity alone nor any Authorization value as proof of gateway authentication.
- Gateway overwrites dedicated verification headers only after existing login succeeds; the token is a private 0600 JSON file, never a URL, browser secret, shared Pi volume or logged value.
- Validate the gateway proof and identity on every management request, including requests carrying an existing cookie. Fail closed on unreadable/rotated credentials and bind cookies to the authenticated user.
- All management writes retain exact Origin and CSRF checks, except the same-origin empty-body session-bootstrap endpoint which issues CSRF.
- Never submit a real runtime update, alter Gate approval policy, restart Pi containers or change existing login passwords during verification.
- Public management requires a distinct HTTPS origin; missing DNS is an explicit deployment prerequisite, not permission to merge origins or expose plaintext ports.

## Task 1: Trusted gateway authentication and API

Files: `hub/config.ts`, new `hub/gateway-auth.ts`, `hub/management.ts`, `hub/restart-api.ts`, `hub/server.ts`, new `tests/hub-gateway-login.test.ts`, `tsconfig.connection.json`.

- [ ] Add real HTTP regressions proving missing/wrong proof, identity-only spoofing, cookie reuse without proof, changed user, cross-origin bootstrap and writes are denied. Exercise successful bootstrap without pairing and a request reaching a simulated manual Gate.
- [ ] Run `node --import ./tests/register-ts.mjs --test tests/hub-gateway-login.test.ts` and observe failure before implementation.
- [ ] Add `management.gateway: { credentialFile: string }` strict configuration, private token validation, per-request gateway guard, user-bound sessions, and `POST /api/management/gateway` accepting only `{}`. Keep pairing mode unchanged and unavailable in gateway mode.
- [ ] Re-run new and existing management/runtime tests plus connection typecheck.

## Task 2: Mobile management flow and operator documentation

Files: `hub/portal.ts`, `tests/hub-runtime-portal.test.ts`, `docs/hub.md`, `docs/adr/0013-package-owned-session-hub.md`, `docs/development-log.md`.

- [ ] Extend the existing behavioral harness with `authMode: "gateway"`, automatic initial bootstrap, no pairing form, explicit gateway re-unlock, logout without automatic re-entry and no update replay after expired authorization.
- [ ] Run affected tests and observe the new expectations fail.
- [ ] Implement the alternate flow using the existing serialized authorization transition; preserve idempotent update submission and stale response isolation.
- [ ] Document exact JSON, header names, Caddy authentication/overwrite ordering, private secret handling, DNS/tunnel prerequisites, administrator scope and password reuse behavior across origins.
- [ ] Build, typecheck, run full unit suite and verify tracked dist. Inspect desktop and mobile screenshots of the compiled Hub; label this visual/integration validation, not real Pi E2E.

## Task 3: Review and controlled deployment

- [ ] Independent read-only security review of the feature diff; fix and re-test findings.
- [ ] Commit reviewed code on `codex/hub-gateway-login`; use the previously authorized merge/push/update workflow only after all checks pass.
- [ ] Back up Hub private configuration and relevant tunnel/Caddy configuration before production edits. Provision only the dedicated management credential, not Gate admin credentials.
- [ ] If public DNS is unavailable, leave the working chat route unchanged, hand off the exact DNS prerequisite, and do not claim phone access works.
- [ ] If public DNS is available, configure separate authenticated HTTPS management ingress and reverse forward, verify unauthenticated 401, spoof denial, authenticated session/status, CSRF and chat-origin denial, then clean up test browser sessions.
- [ ] Record commit, deployment task, verified scope and any remaining prerequisites without secrets.
