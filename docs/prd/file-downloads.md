# Confirmed project-file downloads

## User flow

An assistant response such as **documents/求职/计算机硕士秋招简历-优化版.pdf**
becomes a clickable path. Clicking shows the path and a localized confirmation
dialog. **Yes, download** prepares a short-lived download; **Cancel**, Escape,
or dismissal makes no preparation request and does not download anything.

Recognized forms include plain/bold paths containing a directory and filename
extension, inline-code file paths, and local Markdown links. Inline code and
Markdown links can contain spaces. External links keep an external-link
confirmation; images and fenced code are not rewritten. A nonexistent or
restricted file reports an error without navigating away from the chat.

Downloads retain the original basename, including Chinese characters, and file
bytes. Browsers choose their normal save destination; this UI does not promise
a particular phone filesystem location. A history refresh keeps an open dialog;
a session or runtime replacement invalidates it. Reloaded history is linkified
again without changing the stored conversation.

## Access and transport

- Only ordinary files inside the current Pi workspace are downloadable. Absolute
  paths must resolve inside that same workspace.
- Traversal, symlinks, hardlinks, directories, hidden path components, common
  credential filenames and key extensions are rejected. Filename restrictions
  are defense in depth, not content classification: a renamed secret in an
  otherwise allowed project file is still the user's responsibility.
- The existing Pi Web access/authentication boundary still applies. This feature
  is not a public sharing service or a separate sandbox.
- `prepare_file_download` uses WebSocket with session/runtime identity. It returns
  bounded metadata and an opaque capability, never file contents or host paths.
- `GET`/`HEAD /api/downloads/<token>` revalidates workspace, session, lifecycle,
  file identity and expiry. Capabilities expire after two minutes, are bounded
  to 64 per runtime, and are cleared on replacement/reload/shutdown.
- HTTP streams the file as an attachment with UTF-8 Content-Disposition,
  `no-store`, `nosniff`, and sandbox CSP. File bytes do not count toward the
  WebSocket message-size limit. No Range/resume support is promised.
- The browser prefixes downloads with its current Hub session base path. The
  existing Hub proxy forwards the download; no Caddy/tunnel port change is needed.

## Verification

Unit coverage checks Markdown rewriting, forbidden paths, file identity/expiry
and stale frontend replies. Real Pi integration checks HTTP headers, methods,
Origin, 5 MiB binary integrity and forbidden paths both directly and through a
temporary packaged Hub. Playwright-BDD runs the Chinese PDF flow at desktop and
mobile sizes, including cancel, confirm, external links and missing files.

This does not fix unrelated oversized live-event messages or expand the
Markdown-only workspace artifact index.
