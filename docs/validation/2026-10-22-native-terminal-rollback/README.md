# Native terminal source rollback validation — 2026-10-22

## Scope and archive

Requested: archive the independent native terminal and remove it from main.
Archive branch: `codex/archive-native-terminal-20261022`, checkpoint `87e7839`.
This is a new rollback commit, not a reset or force-push. No production services,
host launchers, private configuration, credentials, tunnels or Caddy were changed.
The unrelated untracked host review was preserved and excluded from the commit.

Removed: terminal listener/pairing/provider/PTY sources, independent browser
bundle, terminal-only dependencies and browser-chat readonly takeover.
Preserved: ordinary model picker/chat, Hub lifecycle/runtime updates, bounded
history/detail/state, transfer compression, math, prompt lifecycle notices,
Git install safety and ordinary async lifecycle/upload cleanup improvements.

## Automated verification

- Ordinary-command regression first failed on the terminal readonly gate; it
  passes after removing that gate.
- Independent review found attachment-shutdown and file-opener lifecycle
  checks that needed preserving. New behavior tests first reproduced three
  failures; all four pending-mutation scenarios now pass with zero dispatches.
- Final full unit/local integration suite: **617 tests, 616 passed, one existing
  conditional skip, zero failures**.
- Production build and source/output manifest verification passed.
- Main and connection TypeScript checks passed. Biome reported no errors;
  warnings/informational diagnostics remain and are not claimed resolved.
- Real-Pi Chromium BDD regression covers ordinary `/model`/settings/tree,
  thinking/name, resume/export/reload and math rendering: final rerun
  **4/4 passed** (13.4 seconds).
- The retained installed-Hub lifecycle regression remains offline and passed
  within the full suite. No external install/update command was run against
  the user's active extension installation.

## Visible validation

No callable in-app Browser was available; used installed Playwright Chromium
against an isolated real-Pi local loopback server (`http://127.0.0.1:<port>/`).
Test browser and Pi process were stopped afterwards; no production URL inspected.

Inspected actual screenshots at **1440×1000** and **390×844**:

- `1440-ordinary-model-picker.png`, `390-ordinary-model-picker.png`: model
  picker stays inside the existing chat page, readable rows/search/close controls,
  no separate native terminal and no viewport clipping of the dialog.
- `1440-ordinary-chat.png`, `390-ordinary-chat.png`: input remains enabled and
  retains a typed draft, with upload/send controls visible. Zero page errors.
- Existing mobile whale placeholder text is partially clipped; not changed or
  claimed fixed by this rollback. This is viewport emulation, not a physical
  phone or public gateway test.

## Deployment boundary

Publishing main does not install the extension or replace the running Hub/Gate.
Current terminal-enabled private configuration and Gate asset requirements must
be adjusted in a separately authorized production rollback before deploying
this ordinary Hub build. No busy Pi session was restarted or state volume deleted.
