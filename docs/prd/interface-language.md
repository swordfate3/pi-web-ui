# PRD: Interface Language

## Scope

Support Simplified Chinese (`zh-CN`) and English (`en`) in the existing React client without changing Pi, WebSocket semantics, or adding a second UI runtime.

## Preference

- Settings exposes a Language / 语言 section with `简体中文` and `English` choices.
- First visit follows browser language preferences: `zh*` chooses Simplified Chinese; other languages fall back to English.
- An explicit choice persists in browser-local `pi-web-ui-language` storage. Invalid values fall back to browser detection; inaccessible storage must not prevent rendering or switching.
- Switching is immediate and does not reload the page, reconnect WebSocket, replace a session, submit a prompt, or clear drafts/queued messages.
- Synchronize the document `lang` attribute for accessibility.

## Translation Boundary

Translate client-owned interface labels, placeholders, tool/reasoning presentation labels, descriptions of built-in commands, dialog explanations and controls. Accessible labels and tooltips follow the selected language.

Do not translate user/assistant message content, code, paths, session names, model IDs, wire identifiers, slash-command names, extension/skill/prompt supplied content or arbitrary server errors. Backend data stays unchanged. Unknown errors retain their original details rather than pretending to be translated.

Existing session-control protections and confirmations remain in force in both languages. A language choice is a browser display preference, not a Pi setting or instruction to the model.

## Verification

- Existing English real-Pi E2E coverage remains valid.
- Real-Pi bilingual flows verify live switching, refresh persistence, browser-locale defaults, draft preservation and unchanged message/session content.
- Desktop and mobile Browser screenshots separately verify Chinese readability, dialog wrapping, navigation and workspace controls.
- Publish a complete isolated local runtime snapshot after build and regression checks; do not patch only a subset of the runtime.
