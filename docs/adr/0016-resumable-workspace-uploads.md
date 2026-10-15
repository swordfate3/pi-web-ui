# ADR 0016: Bounded, resumable workspace upload chunks

## Decision

Extend ADR 0015 with an explicit version-2 protocol. Keep WebSocket as the
session-bound control plane and HTTP as the byte transport. No new server,
package dependency, authentication system or Hub storage is introduced.

- Default maximum file size: 1 GiB. The server may configure a limit up to an
  8 GiB hard ceiling. The browser accepts selection up to the hard ceiling,
  then enforces the server-advertised limit before sending file bytes.
- Fixed 8 MiB chunks, sequential per file. At most five files per submission.
  Zero-byte files have no chunks and still require completion.
- Before preparation the browser computes the complete SHA-256 and each chunk's
  SHA-256 with bounded buffers. Hashing is a separate, cancellable progress phase;
  the complete file must never be buffered in memory.
- The version-2 preparation identity is scope, original filename, size, complete
  digest and ordered chunk digests. Repeating preparation in the same running
  scope discovers its confirmed next-chunk position. No user-controlled
  filesystem path or permanent browser bearer token is needed.
- Each chunk is authenticated by the existing upload capability and scope. A
  successful response confirms a verified chunk, not an entire file. A failed
  or interrupted chunk must not advance the confirmed position. Duplicate
  acknowledged chunks must be validated without appending a second copy.
- Completion checks the entire size and full digest before atomic no-replace
  publication. Only then may its receipt be attached to a Pi prompt. Existing
  reservation and real user `message_start` acknowledgement remain mandatory;
  resumability must not bypass the uncertain-acceptance no-retry fence.

## Lifecycle and resources

Cancelling pauses transmission, leaving verified partial chunks until the
inactivity deadline. Retrying or refreshing and reselecting the same original
file within the same runtime can resume. A browser refresh does not retain the
file permission, draft or attachment selection; the user must reselect it and
explicitly send again. Model work already dispatched to Pi cannot be undone by
upload cancellation.

Uploads are scoped to the current Pi runtime/session epoch. Extension reload,
server stop, session replacement and process exit are not durable checkpoints;
normal lifecycle cleanup removes incomplete files and invalidates receipts.
The implementation does not scan arbitrary old upload directories or promise
recovery after a crash. A crash can leave orphaned partial files for manual
workspace cleanup.

Limit incomplete declared bytes independently of file size, receipt count and
active operations. A reservation charges the entire declared file size before
writing so many paused large files cannot silently evade the bound. Completed
files are user-owned data and are not removed by quota enforcement or receipt
expiry. This is not a persistent quota covering all files or multiple Pi
processes in a workspace.

## Compatibility and limits

The legacy prepare/single-PUT path retains its 50 MiB bound. New clients require
version-2 preparation; they must not silently fall back to a legacy server for
large files. New routes are forwarded by the existing same-origin Hub HTTP
proxy, preserving Content-Length and backpressure. A chunk bounds each request,
not arbitrary network duration; existing gateway/request/idle timeouts can still
interrupt a chunk. HTTPS/login/tunnel setup and production proxy validation are
separate deployment work.

Saving a large file does not make it readable in a single model context. The
Pi tools and file format determine how it can be processed.
