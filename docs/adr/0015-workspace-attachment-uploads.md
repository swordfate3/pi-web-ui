# ADR 0015: Workspace attachments via bounded binary HTTP uploads

## Status

Implemented and locally validated. The original single-PUT behavior below is retained for compatibility; [ADR 0016](0016-resumable-workspace-uploads.md) extends the current browser workflow with 8 MiB chunks and resumability. Production rollout is separate.

## Decision

Treat browser-selected files as explicit writes into the current Pi workspace,
not a new Hub-owned storage service. The extension adapter obtains plain
session/runtime/epoch/workspace identity; a dedicated upload module owns limits,
capabilities, streaming and filesystem cleanup. Do not retain Pi contexts in
HTTP callbacks. Hub continues as a transparent authenticated-route proxy.

Follow the existing download boundary in ADR 0008: prepare intent over the
session-bound WebSocket, stream raw bytes over one same-origin HTTP request,
then reference completed receipt IDs in a prompt. No arbitrary browser path,
HTTP command fallback, or base64 attachment body enters the message transport.
New image attachments also follow this path; the model uses the Pi file tools
to inspect them when needed rather than implicitly receiving inline image data.

The server generates `.pi-uploads/<session>/<random-upload>/<filename>` beneath
the current workspace. Uploads do not overwrite files. Names and every directory
component are validated; partial writes must not be presented as complete files.
Success preserves original bytes and filename, with owner-only permissions.
Files remain after receipt expiry, browser cancellation, extension reload and
session replacement; only unfinished writes and ephemeral authorizations are
cleaned. Same-UID/workspace administrators are not sandboxed adversaries.

Set 50 MiB per file. The UI allows five per submission and serializes uploads;
the backend independently bounds active operations and pending authorizations.
These bounds do not constitute persistent disk quotas or malware scanning.
Limit connection duration, respect stream backpressure, and terminate old scope
work when the session/runtime changes. Retries must not replay an accepted
prompt or send old-session attachments to a replacement session. Pi's
`sendUserMessage()` is fire-and-forget, not an acceptance acknowledgement.
Reserve receipts before asynchronous preflight, reject known compaction/busy,
missing-model and credential failures, and consume only on an exact user
`message_start` match in the current scope. An eight-second unconfirmed handoff
retains a no-retry fence instead of pretending success or blindly resending.
Late matching acceptance can settle the reservation; a successful ACK does not
promise successful subsequent model generation.

## Consequences

- Large documents and original images no longer compete with Hub's 16 MiB
  WebSocket frame limit. Text commands and streaming responses retain the same
  transport and provider behavior.
- Models/providers receive file paths in user messages; tool support determines
  which formats they can inspect. Saving a PDF is not equivalent to parsing it.
- Saved files participate in the user's workspace persistence and version control;
  no automatic `.gitignore` or retention policy is imposed.
- Existing inline-image clients remain legacy compatible at the backend. This
  feature does not increase Hub limits or guarantee their large-message behavior.
- Deployment requires extension source and its matching built UI, not merely
  refreshing old assets. No new Hub service or tunnel is automatically started.

See [requirements](../prd/file-uploads.md) and
[validation](../validation/workspace-uploads.md) for actual evidence and limits.
