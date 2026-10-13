# Bilingual interface validation

## Functional evidence

- Build / TypeScript passed; existing large-chunk warning retained.
- Biome: 110 files passed. Diff whitespace check passed.
- 38 frontend unit tests passed: 7 i18n and 31 session-tree tests (`i18n-unit-final.log`).
- Full real Pi CLI → extension/WebSocket → Chromium → faux provider: 32 tests passed (`i18n-e2e-final.log`).
- Five bilingual scenarios cover desktop/mobile language changes, draft preservation, refresh persistence, zh-CN/en browser defaults, invalid preference fallback, real session JSONL identity/content, and existing Markdown controls switching while code/table/URL content stays unchanged.
- Independent read-only review found no language-driven WS/draft/protocol regression; identified Streamdown controls and notice timestamp display issues, both fixed and covered by added tests.

## Separate visual evidence

Inspected isolated real Pi at `http://127.0.0.1:45039/` (workspace build) and `http://127.0.0.1:44791/` (actual local release). Both stopped after inspection.

Desktop 1440×900: Chinese Settings, chat, on-demand Workspace dialog. Mobile 390×844: Chinese/English Settings, Chinese chat/tree/workspace, actual release chat and artifact details. See `i18n-*.png` in the external artifact directory described in [the report index](README.md).

Checked Chinese labels and input hints, language selection state, wrapped thinking controls, navigation search/footer, artifact paths and unchanged English message/document content. No overlap, clipped controls or horizontal page overflow observed in the checked surfaces. Settings remains readable on mobile.

Shared visible Chrome occasionally needed `bringToFront` and direct DOM clicks for visual setup. These screenshots prove appearance, not functional browser interaction. Normal interactions are separately covered by the passing E2E suite.

Actual release smoke completed a real Pi write and rendered its original English response and workspace artifact with Chinese UI. No application page errors observed during that smoke.

## Installed runtime

`$HOME/.pi/agent/local/pi-web-ui/releases/0.1.1-3455d073085dedfbc606806b`

693 runtime files verified against SHA256 inventory; complete frontend/extension/ws snapshot, no workspace symlinks; one enabled WebUI registration. It captures an uncommitted working tree, not a Git commit containing the changes. No commit/push was made.

## Translation boundary / limits

Messages, code, paths, model IDs, session names, slash-command identifiers, tool names/payloads, dynamic extension content and unknown raw server errors remain unchanged. Streamdown's supported translation API is covered; a few third-party Mermaid internal loading/error/zoom texts remain hardcoded upstream. Dark-theme bilingual visual states and all multi-browser race conditions were not exhaustively checked.

Existing user sessions were not prompted, modified, reloaded or stopped. Test services and generated reports were cleaned up.
