# Cooperative extension interactions

This feature is available on `main`; the original development branch is retained as `codex/web-extension-interactions`. It is not a generic terminal-dialog renderer, and these source changes do not install or activate adapters in existing Pi processes. The [2026-10-24 host rollout record](validation/2026-10-24-web-extension-interactions-rollout.md) documents this host's separate adapter installation and the adoption boundary for existing sessions.

## What appears where

| Operation | Interface | Effect owner |
| --- | --- | --- |
| MCP server list; `/mcp-adapter`; source-owned `/mcp` alias | Panel inside the current chat | MCP Adapter |
| MCP enable/disable, reconnect and OAuth | Chat panel starts an operation; independent management page reviews it | Original config/reconnect/OAuth services |
| Scoped Memory write/forget/restore/lock repair | Exact prepared preview on management page | Original memory guards and commit |
| Knowledge V2 scope/generation confirmations | Exact scope/profile/operation review on management page | Original grant/workflow services |
| `/ks-v2-profiles` | Ordinary choice in chat, followed by exact sensitive review | Original profile store, with catalog compare-and-swap |
| `/agents` | Existing-chat panel for active tasks, model/thinking/concurrency settings and task submission | Original ConfigStore/SpawnCoordinator |

Only commands explicitly advertised by the installed source adapter route to a panel. An unrelated `/mcp` command is not captured by name. Commands with arguments keep their original Pi command behavior. Other extensions' custom terminal controls remain unsupported in Web; the existing terminal-required notice is intentional.

## Trust and prerequisites

The chat application does not receive sensitive previews, OAuth URLs/callbacks or a management signing key. A sensitive notice provides an explicit top-level management link, with an ordinary same-tab fallback if opening a separate tab is inconvenient.

Use the already configured separate management origin and its gateway login/unlock. There is no new application password or management code for gateway deployments. If an existing installation uses the original one-time-code unlock instead, that existing mode remains supported; the feature does not silently change authentication modes.

New credentials issued by the trusted host's `pi-web-hub issue` include only the Hub's public Ed25519 authority pin when management is configured. The private signing key stays in the Hub's bounded private state. Old credentials remain usable for existing Web access but do not magically gain confirmation authority. Enrol or rotate individual credentials through the trusted host/launcher before recreating the corresponding Pi process; do not copy Hub administrator state into Pi.

An actionable management link also requires a configured management public URL. A missing pin, source adapter, fresh context or valid registration results in an unavailable capability, never an insecure fallback to chat approval. The original local prompt remains the source-controlled fallback when the optional Web integration is absent.

## Source adapter adoption

All four packages must explicitly adopt the exported API `@kkkiio/pi-web-ui/interactions/v1`. Merely updating Pi Web does not rewrite third-party extensions.

The public subpath must be resolvable from each source package's module context.
Having another extension directory somewhere under the same Pi agent home is
not, by itself, a Node package dependency. A Git-installed Web checkout does not
automatically link its package name into every other extension's dependency
tree. Adopt and install the public API through the source package's supported
package/dependency workflow, then verify the loaded capabilities. The development
test loader only wires isolated test copies to this checkout; it is not shipped
as a production resolver or an installation workaround.

Reviewed source diffs and exact preimage/postimage hashes are distributed under `integrations/adapters/`. These target the recorded source copies, not every package sharing the same version string. Local policy modifications may mean your package requires its own review.

Check a **disposable source checkout** without changing it:

```bash
node integrations/check-adapter.mjs memory /absolute/path/to/source-checkout
```

After review, apply to that explicit checkout only:

```bash
node integrations/check-adapter.mjs memory /absolute/path/to/source-checkout --apply
```

Adapter IDs are `memory`, `knowledge`, `mcp` and `agents`. The checker rejects mismatched package versions, changed preimages, existing added files, symlinked paths and patch tampering. It does not install a package or restart a runtime. Repeated application is rejected rather than layered twice. Use the source package's own build and installation workflow after its tests pass; do not blindly patch a live shared-volume installation.

## Decision and network behavior

The source owns classification, preparation, validation and the final effect. The broker arbitrates terminal/Web/timeout/cancellation; exactly one answer can resume it. Authorization is bound to the run, Hub generation, runtime, session, adapter version, source revision, full preview digest and exact answer schema.

“Authorization delivered” is not “operation committed.” A stale source store/profile/configuration still rejects after approval. Panel completion means the source operation returned, which can include refusal or cancellation; inspect its actual state after refreshing.

On unknown delivery, query the original task. The UI does not recreate actions, reapprove, respawn or mint another decision automatically. Session/runtime changes, unload, source revision changes and private-channel loss invalidate pending work. Do not work around that by reopening old links or reusing old buttons.

Transient limits: 64 KiB per complete request; eight pending/Pi; 64 tracked pending/Hub and at most 4 MiB aggregate; lists at most 100 items/64 KiB per page. Confirmations are at most two minutes; OAuth source deadlines are at most ten minutes and may be shortened by the enclosing operation. Deduplication is bounded to 128 entries, five minutes and 256 KiB. Sensitive request bodies are not written into Hub state or conversation history. Independent original source tools may still write their normal authorized results to their own stores.

## Development validation

```bash
node --import ./tests/register-ts.mjs --test tests/web-interactions-*.test.ts tests/interaction-*.test.ts tests/interaction-artifacts.test.mjs tests/hub-interactions.test.ts
npx tsc --noEmit -p tsconfig.connection.json
npm run build:web
npm run verify:dist
npm run test:interactions:browser
```

The browser suite launches real temporary Pi/Hub services and a Chromium browser. It uses deliberately synthetic cooperative sources and synthetic data, not the four original packages. It is separate evidence from original-source adapter tests. Set `PI_E2E_BROWSER_EXECUTABLE` when using an existing compatible Chromium installation. Set `PI_INTERACTION_SCREENSHOTS` to retain safe fixture screenshots; otherwise temporary services and workspaces are cleaned up on exit.

See the dated validation record for executed evidence and outstanding acceptance gates. Do not infer production readiness or deployment from a passing transport fixture alone.
