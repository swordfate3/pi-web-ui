# Minimal chat validation

## Functional checks

- `npm run check`: 103 files passed.
- `npx tsc --noEmit`: passed.
- `npm run build:web`: passed; existing large-chunk warning remains.
- Tree unit tests: 31 passed (`minimal-tree-unit.log`).
- Full real Pi / WebSocket / Chromium / faux-provider E2E: 27 passed (`minimal-e2e-final.log`).
- Long regression retains 6000 messages, three branches and labels, search, reload and complete snapshots. Its trace-enabled scenario timeout is 180 seconds; ordinary scenarios unchanged.
- New collapse fixture exercises native thinking and real Pi write, expansion and history refresh.

## Separate Browser visual checks

Isolated real Pi URLs inspected: `http://127.0.0.1:45453/` (workspace build), `http://127.0.0.1:45845/` (local runtime snapshot). Both temporary services were stopped after inspection.

Desktop 1440×900: default/empty/chat, expanded tree, on-demand Workspace dialog, Git diff panel.
Mobile 390×844: default chat, `/tree` Sheet, Workspace list, artifact detail surface, Settings dialog.

Screenshots are `minimal-*.png` in the external artifact directory described in [the report index](README.md). The default surface has no reserved sidebar width or workspace overlay. Chat and composer remain readable; mobile controls use two header rows. Tree rows truncate within the Sheet. Workspace Git/artifact rows stay within its dialog. Artifact content uses a full-width mobile detail surface rather than squeezed columns. Desktop Git selection closes the Workspace dialog and moves focus to `Hide right panel`. No visible overlap or horizontal page overflow was observed in these checked states.

The shared visible Chrome occasionally needed `bringToFront` for screenshot/action timeouts; some visual setup clicks used direct DOM click/force. Those are not treated as functional E2E evidence. The separately passing 27-test suite uses normal browser interactions against isolated Pi processes.

Actual local-release smoke: real write tool and completion response, Workspace artifact discovered, tree initially hidden; no application page errors observed during this smoke.

## Runtime snapshot

Installed under `$HOME/.pi/agent/local/pi-web-ui/releases/0.1.1-6c2704b5ff296a022c42b6a3`.
Full runtime inventory: 693 files, including extension, complete dist and ws dependency. Manifest records a snapshot of an uncommitted working tree, not a Git commit containing these changes.

Existing user sessions were not modified, prompted, reloaded or stopped. No Git commit/push was made.

## Limits

This is not complete Pi TUI parity. Dark-theme visual states, every model-name length and all cross-browser races were not exhaustively checked. The full real-Pi regression and the separate visual checks are reported independently.
