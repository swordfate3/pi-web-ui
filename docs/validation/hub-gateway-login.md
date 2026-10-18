# Hub trusted gateway login validation

Date: 2026-10-18. Base main `9ed58ae`; feature branch `codex/hub-gateway-login`.

## Approved behavior

Existing authenticated gateway users can request global Pi updates from a phone
without fetching a pairing code from a computer. Keep separate chat/management
origins, CSRF, private server-to-server proof, short-lived browser sessions and
manual Gate approval. Default pairing remains available for deployments which
do not explicitly configure gateway mode.

## Test evidence

- New real HTTP API regressions: six tests, covering proof/identity spoofing,
  cookie binding, exact Origin, CSRF, bootstrap body, logout/revocation, proof
  rotation, file permissions, manual Gate request and invalid configuration.
  Before implementation, five tests failed because the gateway config was unsupported.
- Two added browser-script behavioral tests initially failed, then passed with
  automatic initial gateway entry, no pairing form, explicit re-entry, serialized
  logout, pending-task protection and no replay after an unauthorized submission.
  The test fixture waits for asynchronous status reads before attempting a submission;
  a previously pending job correctly keeps new submission disabled after re-entry.
- Full suite: 488 tests, 487 pass, one optional skip, zero failures/cancellations.
- Connection typecheck, full build, tracked dist verification and whitespace check
  passed. Biome retains the baseline 30 warnings and one info, zero errors.
- Independent source-level security review found no actionable correctness or
  security findings. This does not verify production gateway configuration or TLS.

## Compiled Hub browser/visual check

The app Browser-control tool was unavailable. Used independent Playwright Chromium
against the actual compiled Hub behind an isolated temporary HTTPS Basic-auth
gateway and a simulated Gate; this is integration/visual evidence, not real Pi E2E.

- Desktop 1440×1000 and mobile 390×844 screenshots were opened and inspected.
  Text/controls were readable; mobile form wraps vertically, no horizontal overflow,
  pairing form hidden, login-based entry and manual policy visible.
- The browser received a Secure/HttpOnly/SameSite=Strict `__Host-` management cookie.
- Unauthenticated requests carrying spoofed gateway headers returned401 at the gateway.
- Exactly one simulated update POST reached Gate and remained awaiting manual approval.
  Lock/re-entry did not resubmit. No page errors; test browser and temporary servers stopped.
- Evidence: `.tmp/gateway-{unit,build,check,visual}.log`,
  `.tmp/hub-gateway-{desktop,mobile,mobile-pending,mobile-locked}.png`.

## Deployment boundary

The proposed separate management domain requires a real DNS record. At initial
production inspection it was absent; local proxy fake-IP resolution was not
treated as evidence of public DNS. Missing DNS must not be worked around by
sharing the chat origin or publishing plaintext management ports. Deployment
receipts and remaining prerequisites are reported separately; these checks did
not submit a production Pi update or change Gate policy/passwords.
