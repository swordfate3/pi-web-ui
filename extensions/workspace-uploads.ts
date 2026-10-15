import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const UPLOAD_TTL_MS = 10 * 60 * 1000;
const MAX_RECEIPTS = 16;
const MAX_ACTIVE = 2;
export type UploadScope = { cwd: string; sessionId: string; epoch: number };
type Receipt = {
  scope: UploadScope;
  uploadId: string;
  filename: string;
  size: number;
  relativePath: string;
  expiresAt: number;
  state: "pending" | "writing" | "complete" | "reserved" | "handoff";
  cancel?: () => void;
  isCurrent?: () => boolean;
};
type Handoff = {
  scope: UploadScope;
  ids: string[];
  message: string;
  dispatched: boolean;
  finish: (error?: Error) => void;
};
const unknownAcceptance = () =>
  new Error(
    "Pi acceptance is unknown. Do not resend these attachments. Check the conversation before manually recovering the saved workspace files.",
  );
const unavailable = () => new Error("Upload unavailable or expired. Select the file again.");
const sameScope = (a: UploadScope, b: UploadScope) =>
  a.cwd === b.cwd && a.sessionId === b.sessionId && a.epoch === b.epoch;

function validFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 200 &&
    !value.startsWith(".") &&
    !/[\\/<>:"|?*]/.test(value) &&
    !/[. ]$/.test(value) &&
    !Array.from(value).some((char) => /\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u.test(char)) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}

// Validate every ancestor, not just the final file. Pin the private upload
// directory on Linux so a parent rename/symlink swap cannot redirect writes.
function checkedDirectory(directory: string) {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
}
function makeDirectory(directory: string) {
  checkedDirectory(path.dirname(directory));
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkedDirectory(directory);
}

/** Owns only temporary writes and in-memory receipts; completed files are user data. */
export class WorkspaceUploads {
  private readonly receipts = new Map<string, Receipt>();
  private timer?: NodeJS.Timeout;
  private active = 0;
  private handoff?: Handoff;
  private readonly now: () => number;
  constructor(now = Date.now) {
    this.now = now;
  }

  private prune() {
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= this.now() || (receipt.isCurrent && !receipt.isCurrent())) {
        receipt.cancel?.();
        this.receipts.delete(id);
      }
    }
    if (this.handoff?.ids.some((id) => !this.receipts.has(id))) {
      this.handoff.finish(unknownAcceptance());
      this.handoff = undefined;
    }
    if (!this.receipts.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  prepare(scope: UploadScope, filename: unknown, size: unknown) {
    this.prune();
    if (!validFilename(filename)) throw new Error("Invalid upload filename. Use a visible filename without a path.");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES)
      throw new Error("Upload must be between 0 and 50 MiB.");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope.sessionId) || !path.isAbsolute(scope.cwd)) throw unavailable();
    if (this.receipts.size >= MAX_RECEIPTS) throw new Error("Too many uploads. Wait for pending uploads to expire.");
    const uploadId = randomUUID();
    const relativePath = `.pi-uploads/${scope.sessionId}/${uploadId}/${filename}`;
    this.receipts.set(uploadId, {
      scope: { ...scope },
      uploadId,
      filename,
      size,
      relativePath,
      expiresAt: this.now() + UPLOAD_TTL_MS,
      state: "pending",
    });
    if (!this.timer) {
      this.timer = setInterval(() => this.prune(), 1000);
      this.timer.unref();
    }
    return { uploadId, url: `/api/uploads/${uploadId}`, relativePath, maxBytes: MAX_UPLOAD_BYTES };
  }

  async receive(id: string, scope: UploadScope, length: number, source: Readable, isCurrent: () => boolean) {
    this.prune();
    const receipt = this.receipts.get(id);
    if (!receipt || receipt.state !== "pending" || !sameScope(receipt.scope, scope) || !isCurrent())
      throw unavailable();
    // A PUT consumes its capability, even if its length or disk write fails.
    receipt.state = "writing";
    if (length !== receipt.size || this.active >= MAX_ACTIVE) {
      this.receipts.delete(id);
      throw new Error("Upload size mismatch or upload concurrency limit reached.");
    }
    this.active++;
    let fd: number | undefined;
    let directoryFd: number | undefined;
    let ownedDirectory: string | undefined;
    let temporary: string | undefined;
    let published = false;
    let cancelled = false;
    receipt.isCurrent = isCurrent;
    receipt.cancel = () => {
      cancelled = true;
      source.destroy(unavailable());
    };
    const check = () => {
      if (cancelled || !isCurrent() || receipt.expiresAt <= this.now() || this.receipts.get(id) !== receipt)
        throw unavailable();
    };
    try {
      check();
      checkedDirectory(scope.cwd);
      const root = path.join(scope.cwd, ".pi-uploads");
      makeDirectory(root);
      const session = path.join(root, scope.sessionId);
      makeDirectory(session);
      const directory = path.join(session, id);
      // Never reuse an existing directory, even when empty.
      fs.mkdirSync(directory, { mode: 0o700 });
      ownedDirectory = directory;
      checkedDirectory(directory);
      directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const directoryStat = fs.fstatSync(directoryFd);
      if (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${directoryFd}`) !== directory)
        throw unavailable();
      const verifyDirectory = () => {
        checkedDirectory(directory);
        const stat = fs.lstatSync(directory);
        if (stat.dev !== directoryStat.dev || stat.ino !== directoryStat.ino) throw unavailable();
      };
      const pinned = process.platform === "linux" ? `/proc/self/fd/${directoryFd}` : directory;
      temporary = path.join(pinned, ".partial");
      fd = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      let written = 0;
      for await (const chunk of source) {
        check();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        written += bytes.length;
        if (written > receipt.size || written > MAX_UPLOAD_BYTES) throw new Error("Upload exceeds declared size.");
        // Bounded incoming chunks; never buffer the full file. Synchronous writes
        // keep scope validation and each filesystem mutation in one event turn.
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      }
      check();
      if (written !== receipt.size) throw new Error("Upload size mismatch.");
      verifyDirectory();
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd);
      const onDisk = fs.lstatSync(temporary);
      if (!onDisk.isFile() || onDisk.nlink !== 1 || opened.dev !== onDisk.dev || opened.ino !== onDisk.ino)
        throw unavailable();
      // link is an atomic, no-replace publication (rename would overwrite).
      fs.linkSync(temporary, path.join(pinned, receipt.filename));
      published = true;
      fs.unlinkSync(temporary);
      temporary = undefined;
      receipt.state = "complete";
      receipt.cancel = undefined;
      receipt.expiresAt = this.now() + UPLOAD_TTL_MS;
      return { uploadId: id, relativePath: receipt.relativePath, filename: receipt.filename, size: receipt.size };
    } catch {
      this.receipts.delete(id);
      throw unavailable();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary) {
        try {
          fs.unlinkSync(temporary);
        } catch {}
      }
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
      if (ownedDirectory && !published) {
        try {
          fs.rmdirSync(ownedDirectory);
        } catch {}
      }
      this.active--;
      receipt.cancel = undefined;
      this.prune();
    }
  }

  resolve(scope: UploadScope, ids: unknown) {
    this.prune();
    if (!Array.isArray(ids) || ids.length > MAX_RECEIPTS || new Set(ids).size !== ids.length) throw unavailable();
    return ids.map((id) => {
      const receipt = typeof id === "string" ? this.receipts.get(id) : undefined;
      if (receipt && sameScope(receipt.scope, scope) && receipt.state === "handoff") throw unknownAcceptance();
      if (!receipt || receipt.state !== "complete" || !sameScope(receipt.scope, scope)) throw unavailable();
      return receipt.relativePath;
    });
  }

  /** Reserve before any await, across all browsers. Void dispatch is NOT acceptance. */
  async send(
    scope: UploadScope,
    ids: string[],
    message: string,
    preflight: () => Promise<void>,
    dispatch: () => void,
    timeoutMs = 8_000,
  ): Promise<void> {
    this.resolve(scope, ids);
    if (this.handoff) throw new Error("An attachment handoff is unresolved. Wait and check the conversation.");
    if (!ids.length) throw unavailable();
    const receipts = ids.map((id) => {
      const receipt = this.receipts.get(id);
      if (!receipt) throw unavailable();
      return receipt;
    });
    for (const receipt of receipts) receipt.state = "reserved";
    return new Promise<void>((resolve, reject) => {
      const handoff: Handoff = {
        scope: { ...scope },
        ids: [...ids],
        message,
        dispatched: false,
        finish: (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      };
      const release = () => {
        if (this.handoff !== handoff) return;
        this.handoff = undefined;
        for (const receipt of receipts) {
          if (receipt.state === "reserved") receipt.state = "complete";
        }
      };
      const timer = setTimeout(() => {
        // Preflight has no dispatch side effect; late completion is fenced below.
        // Once handed to Pi, retain the receipts and the no-retry fence, even if
        // its unobservable async failure or an input hook prevents acceptance.
        if (!handoff.dispatched) release();
        handoff.finish(
          handoff.dispatched ? unknownAcceptance() : new Error("Attachment preflight timed out. Nothing was sent."),
        );
      }, timeoutMs);
      timer.unref();
      this.handoff = handoff;
      void (async () => {
        try {
          await preflight();
          if (this.handoff !== handoff) return;
          this.prune();
          if (this.handoff !== handoff) return;
          handoff.dispatched = true;
          for (const receipt of receipts) receipt.state = "handoff";
          dispatch();
        } catch (error) {
          if (!handoff.dispatched) release();
          handoff.finish(
            handoff.dispatched ? unknownAcceptance() : error instanceof Error ? error : new Error("Preflight failed"),
          );
        }
      })();
    });
  }

  /** Only a matching user message_start proves that Pi has entered the agent loop. */
  accept(scope: UploadScope, message: string) {
    const handoff = this.handoff;
    if (!handoff?.dispatched || !sameScope(handoff.scope, scope) || handoff.message !== message) return;
    // No clock check: a late real acceptance still settles the handoff safely.
    for (const id of handoff.ids) this.receipts.delete(id);
    this.handoff = undefined;
    handoff.finish();
    this.prune();
  }

  clear() {
    this.handoff?.finish(unknownAcceptance());
    this.handoff = undefined;
    for (const receipt of this.receipts.values()) receipt.cancel?.();
    this.receipts.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Called only behind the mirror server's existing Hub proof guard. */
export async function serveWorkspaceUpload(
  req: IncomingMessage,
  res: ServerResponse,
  store: WorkspaceUploads,
  scope: UploadScope | undefined,
  isCurrent: () => boolean,
  expectedOrigin: string,
  hubProven: boolean,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const fail = (status: number, error: string) => {
    const length = req.headers["content-length"];
    const bounded =
      length !== undefined &&
      /^\d+$/.test(length) &&
      Number(length) <= MAX_UPLOAD_BYTES &&
      !req.headers["transfer-encoding"];
    // Drain only bounded requests. Closing a socket while a legitimate client
    // is still sending its body races the JSON response (notably through Hub).
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json", ...(!bounded ? { Connection: "close" } : {}) });
      res.end(JSON.stringify({ error }));
    };
    if (bounded && !req.complete) {
      req.setTimeout(10_000, () => req.destroy());
      req.once("end", send);
      req.resume();
    } else send();
  };
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return fail(405, "Method not allowed");
  }
  if (
    req.headers["sec-fetch-site"] === "cross-site" ||
    (req.headers.origin && !hubProven && req.headers.origin !== expectedOrigin)
  )
    return fail(403, "Forbidden");
  const match = /^\/api\/uploads\/([0-9a-f-]{36})$/.exec(req.url ?? "");
  if (!match || !scope || !isCurrent()) return fail(404, "Upload unavailable or expired");
  const length = req.headers["content-length"];
  if (!length || !/^\d+$/.test(length) || req.headers["transfer-encoding"] !== undefined)
    return fail(411, "A known Content-Length is required");
  if (Number(length) > MAX_UPLOAD_BYTES) return fail(413, "Upload exceeds 50 MiB");
  if (req.headers["content-type"] !== "application/octet-stream") return fail(415, "Use application/octet-stream");
  try {
    const result = await store.receive(match[1], scope, Number(length), req, isCurrent);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch {
    if (!res.destroyed) fail(400, "Upload failed or expired. Select the file again.");
  }
}
