# Cooperative Web interactions: host rollout

Date: 2026-10-24. This supplements the development-only validation record.

## Published and deployed

- Feature commit `cf7d94075edd14beefc2e05cf37522bb08a6e855` was fast-forwarded
  into `main` and pushed, retaining `codex/web-extension-interactions`.
- HTTPS and GitHub CLI credentials were invalid. Existing authenticated SSH
  was used; no credential or remote configuration was overwritten.
- Gate request `abb11aa6dad7c213ff6cdfe33bff7774` completed `deployed/complete`.
  Source lookup was unavailable, so Gate required explicit host approval of
  plan `1c9242b31e8a8f3070997091fe425f6db174c074621bf6e0a7e182d881298a53`.
  The service policy remained unchanged.
- Hub image:
  `sha256:9a23e4c9a8a738dc66c83bd616f3e052495eae2e52e5a64a61fc30ca0d634be0`.
  Bundle SHA-256:
  `b940e6fea08847dd758e7b60055dfdea94554c5fedb7580d4a8553640592452e`.
  Previous Hub container is retained by Gate for rollback.
- Host-only private-state backup:
  `/home/fate/docker_files/pi-docker/backup/web-interactions-cf7d940-20261024/`.
  Do not publish its contents or mount it into Pi.
- The installed Web Git checkout in `pi-home` was fast-forwarded and its
  prebuilt assets verified. Gate and Pi images did not need replacement.

## Source adapter installation

All installed preimages matched the reviewed manifest exactly. Four independent
source copies were prepared, patched and checked in the persistent Agent home:

```text
/home/node/.pi/agent/local/web-interactions/releases/cf7d940-startup-safe/
  memory/
  knowledge/
  mcp/
  agents/
  settings.before.json
  release.json
```

Only the four existing global package entries were changed to these paths,
preserving their other filters and all unrelated settings. Activation compared
the complete settings preimage before atomic replacement and checked every
adapted postimage. Original source installations were not patched or removed.
Settings backup is private and must not be published.

Each copy links its ordinary dependencies from the existing installation and
links the actual public package name `@kkkiio/pi-web-ui` to the installed Web Git
checkout. No production resolver hook, development test loader or copied private
Hub state is used. The original older npm Web package was not activated.

These are intentionally local maintained adapter releases. `pi update --extensions`
does not automatically upgrade them to unrelated upstream versions. Future
adapter upgrades must check the new baselines, build/test a new release, and
switch the four package entries; otherwise the cooperative changes could be lost.
The Web Git package remains a Git-managed installation.

## Defects discovered by installed validation

1. MCP and Agents used `new Function(... import(...))`. The real Pi 1.4 loader
   evaluates extension code in a context without that dynamic-import callback.
   Both source imports were changed to evaluator-visible `import(specifier)`.
   Regression tests extract the actual distributed implementation and execute
   it through Jiti with normal package resolution, not an import alias.
   Missing optional API remains unavailable; unrelated import failures propagate.
2. A cached/deferred MCP session could return before registering its panel.
   The initial compatibility candidate constructed full source state for the
   panel, but independent review found that missing metadata could then start
   enabled lazy servers, including through direct-tool bootstrap. The MCP
   settings entry was temporarily restored to the untouched npm package while
   this was fixed. A new internal, default-off `deferLazyDiscovery` option now
   preserves the deferred snapshot's no-discovery policy on both paths. Explicit
   use, eager and keep-alive startup retain their normal initialization paths.
3. The optional API probe yielded while a runtime operation could initialize
   the same owner. Session startup now rechecks both published state and the
   pending promise after the probe, joining rather than replacing initialization.
   Enabled-lazy, direct-tools-lazy and concurrent-operation regressions failed
   before these fixes and passed afterwards. Disabled-only acceptance had not
   covered them. The independent reviewer rechecked the source fixes.

These fixes are distributed through regenerated patches and per-file hashes.
They do not change Hub or frontend build bytes.

## Executed checks

- Initial complete Web suite: 762 tests, 760 passed, 0 failed, 2 opt-in skips.
- Post-import-fix complete suite: 766 tests, 764 passed, 0 failed, 2 opt-in skips.
  The final suite after the deferred-MCP artifact update repeated these results.
  Skips: 1 GiB stress and standalone opt-in Chromium page check. Earlier
  development browser evidence is recorded separately, not rerun by this command.
- The earlier compatible candidate had 56/56 focused source tests pass, but
  lacked enabled-lazy and startup-race coverage. The startup-safe candidate adds
  those three cases and includes the `init.ts` postimage in its manifest:
  its clean-source single-concurrency run passed 59/59, with no skips.
- The earlier installed-release readback matched all 29 adapted file hashes.
  The startup-safe release adds the MCP initialization file. The artifact/Jiti regression suite
  also passed 5/5 with the same authorized test environment as the full suite.
- After activation, a read-only check confirmed all four global entries point
  at the startup-safe release and all 30 file hashes match the final manifest.
- Actual installed Pi 1.4 + installed Web + all four candidate packages,
  with a separate temporary Hub/config/credential/empty workspace:
  registration and authority pin succeeded; MCP and Agents panels were present
  with deferred configuration, direct tools enabled, a disabled command and an
  enabled lazy server. The latter would write an isolated temporary sentinel if
  launched; no sentinel appeared.
  No model request or real OAuth was made. Temporary services were stopped and
  the temporary credential deleted.
- Public HTTPS/Caddy checks (Aliyun endpoint pinned, not a general DNS test):
  chat page/API/assets require login; authenticated access succeeds; foreign
  Origin is refused; management routes remain isolated from chat; management
  login and version catalog are available. Runtime readiness reports blocked
  for the existing consumers; that is not an update success claim.
- Source/dist consistency passed after source-adapter fixes. No frontend or Hub
  bundle changed in the compatibility follow-up.

After the startup-policy review fixes, a parallel run reported two failures in
previously passing time-sensitive assertions: the Memory ownerless-lock age
fixture returned `not-repairable`, and the Hub lease-expiry fixture returned
200 rather than 410. These results were retained, not discarded. Single-
concurrency reruns passed all 59 adapter tests and the complete Web suite
(766 total, 764 passed, 0 failed, 2 opt-in skips). These reruns do not claim
that timing sensitivity itself has been fixed; no unrelated production logic
was changed to conceal the failures.

The first production credential smoke test was revoked after its failure.
A later launcher-open attempt failed and reported cleanup warnings; read-only
inspection found zero remaining `export-*` files and the Hub healthy. Subsequent
validation was deliberately moved to a separate temporary Hub. This is not proof
that every future production launcher enrollment succeeds.

## Existing sessions and user entrypoints

- Chat portal: `https://pi.swordfate.cn/sessions/`.
- Existing management origin: `https://pi-admin.swordfate.cn/`.
- Five Pi containers were preserved. Three were registered with the Hub, and
  all three reported a busy/unsafe-to-restart condition through supervisor checks.
  No Pi process was killed, restarted or silently re-enrolled.
- Their current credentials predate the new public signing pin. Installed files
  changing does not reload these processes or grant them confirmation authority.
- New `pirun` invocations use the updated global packages and obtain credentials
  through the existing trusted launcher. Finish/save current work before exiting
  an old session and using `pirun --resume` to restore the desired saved session.
  If enrollment fails, inspect the host launcher and Hub; never bypass the pin
  check or copy Hub administrator state into Pi.
- `/agents` and `/mcp-adapter` are source-advertised chat panels. Sensitive
  operations open the existing separately authenticated management origin.
  This does not enable arbitrary terminal custom UI from every extension.

No physical phone/Safari, live external OAuth or full upstream package-suite
pass is claimed. No volumes, project data or unrelated containers were removed.
