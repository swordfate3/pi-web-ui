# Package session hub implementation plan

Execute inline using test-driven-development and verification-before-completion.
Work in the user's existing `codex/portable-web-connection` checkout; do not
create another branch or publish. Spec: `../specs/2026-10-14-package-session-hub.md`.

1. Add protocol tests in `tests/session-hub.test.ts`; observe missing hub failure.
   Cover isolated credentials, two sessions, HTTP/WS proofs, hostile origins,
   bounded enrollment, lease expiry, restart and old-link fencing.
2. Implement `hub/config.ts`, `hub/server.ts` and `hub/portal.ts`. Preserve the
   existing registration wire contract. Store grants/ledger privately, fence
   async registrations against stop and verify the target before trusting it.
3. Test the real CLI in `tests/hub-cli.test.ts` before adding
   `bin/pi-web-hub.mjs`. Add init/serve/issue/revoke; no auto-start hidden daemon,
   no shared administrator credentials and no extension stdout output.
4. Add a real-Pi multi-session harness, backend lifecycle integration and
   Playwright-BDD portal scenarios. Check screenshots at desktop/mobile sizes.
5. Update packaging, central operating guide, scope ADR, connection docs and
   development log. Include dedicated-container deployment example and clear
   persistence boundaries; distinguish local validation from remote deployment.
6. Run fresh unit/integration/browser checks, TypeScript, Biome, frontend build
   and package inventory. Request a focused security/lifecycle review; resolve
   important findings. Leave verified changes local for user review.
