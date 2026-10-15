import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";

/** Legacy single-PUT protocol limit. Kept stable for existing clients. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const HARD_MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_RESERVED_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_RECEIPTS = 16;
const MAX_ACTIVE = 2;
export type UploadScope = { cwd: string; sessionId: string; epoch: number };
type UploadState = "pending" | "writing" | "finalizing" | "complete" | "reserved" | "handoff";
type Receipt = {
  scope: UploadScope;
  uploadId: string;
  filename: string;
  size: number;
  relativePath: string;
  expiresAt: number;
  protocol: 1 | 2;
  sha256?: string;
  chunkHashes?: string[];
  nextChunk: number;
  state: UploadState;
  directory?: string;
  directoryIdentity?: { dev: number; ino: number };
  partialIdentity?: { dev: number; ino: number };
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

function configuredMaxBytes() {
  const value = process.env.PI_WEB_UPLOAD_MAX_BYTES;
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_MAX_UPLOAD_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_MAX_UPLOAD_BYTES;
  return Math.min(parsed, HARD_MAX_UPLOAD_BYTES);
}
function configuredMaxPendingBytes() {
  const value = process.env.PI_WEB_UPLOAD_MAX_PENDING_BYTES;
  if (value === undefined || !/^\d+$/.test(value)) return MAX_RESERVED_UPLOAD_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return MAX_RESERVED_UPLOAD_BYTES;
  return Math.min(parsed, HARD_MAX_UPLOAD_BYTES * MAX_RECEIPTS);
}

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
function expectedChunkCount(receipt: Pick<Receipt, "size">) {
  return Math.ceil(receipt.size / UPLOAD_CHUNK_SIZE);
}
function chunkLength(receipt: Pick<Receipt, "size">, index: number) {
  return Math.min(UPLOAD_CHUNK_SIZE, receipt.size - index * UPLOAD_CHUNK_SIZE);
}
function syncFile(fd: number) {
  return new Promise<void>((resolve, reject) => {
    fs.fsync(fd, (error) => (error ? reject(error) : resolve()));
  });
}
function truncateFile(fd: number, length: number) {
  return new Promise<void>((resolve, reject) => {
    fs.ftruncate(fd, length, (error) => (error ? reject(error) : resolve()));
  });
}

/** Owns only temporary writes and in-memory receipts; completed files are user data. */
export class WorkspaceUploads {
  private readonly receipts = new Map<string, Receipt>();
  private timer?: NodeJS.Timeout;
  private active = 0;
  private handoff?: Handoff;
  private readonly now: () => number;
  readonly maxUploadBytes: number;
  readonly maxPendingUploadBytes: number;

  constructor(
    now = Date.now,
    maxUploadBytes = configuredMaxBytes(),
    maxPendingUploadBytes = configuredMaxPendingBytes(),
  ) {
    this.now = now;
    this.maxUploadBytes =
      Number.isSafeInteger(maxUploadBytes) && maxUploadBytes > 0
        ? Math.min(maxUploadBytes, HARD_MAX_UPLOAD_BYTES)
        : DEFAULT_MAX_UPLOAD_BYTES;
    this.maxPendingUploadBytes =
      Number.isSafeInteger(maxPendingUploadBytes) && maxPendingUploadBytes > 0
        ? Math.min(maxPendingUploadBytes, HARD_MAX_UPLOAD_BYTES * MAX_RECEIPTS)
        : MAX_RESERVED_UPLOAD_BYTES;
  }

  private cleanupPartial(receipt: Receipt, removeDirectory = true) {
    const directory = receipt.directory;
    if (!directory) return;
    let directoryFd: number | undefined;
    try {
      checkedDirectory(path.dirname(directory));
      directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(directoryFd);
      if (
        !receipt.directoryIdentity ||
        stat.dev !== receipt.directoryIdentity.dev ||
        stat.ino !== receipt.directoryIdentity.ino ||
        (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${directoryFd}`) !== directory)
      )
        return;
      const pinned = process.platform === "linux" ? `/proc/self/fd/${directoryFd}` : directory;
      const partial = path.join(pinned, ".partial");
      try {
        const partialStat = fs.lstatSync(partial);
        if (
          partialStat.isFile() &&
          !partialStat.isSymbolicLink() &&
          partialStat.nlink === 1 &&
          receipt.partialIdentity &&
          partialStat.dev === receipt.partialIdentity.dev &&
          partialStat.ino === receipt.partialIdentity.ino
        ) {
          fs.unlinkSync(partial);
        }
      } catch {}
    } catch {
      // Cleanup is best-effort only for paths still proven to be ours.
    } finally {
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
    }
    if (removeDirectory) {
      try {
        const stat = fs.lstatSync(directory);
        if (
          stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          receipt.directoryIdentity &&
          stat.dev === receipt.directoryIdentity.dev &&
          stat.ino === receipt.directoryIdentity.ino
        )
          fs.rmdirSync(directory);
      } catch {}
      receipt.directory = undefined;
      receipt.directoryIdentity = undefined;
      receipt.partialIdentity = undefined;
    }
  }

  private discard(receipt: Receipt) {
    receipt.cancel?.();
    if (receipt.state === "complete") this.cleanupPartial(receipt, false);
    else if (receipt.state !== "reserved" && receipt.state !== "handoff") {
      // Do not unlink a file while an active descriptor is mutating/reading it.
      // The operation's finally block closes its descriptors before cleanup.
      if (receipt.state !== "writing" && receipt.state !== "finalizing") this.cleanupPartial(receipt);
    }
    this.receipts.delete(receipt.uploadId);
  }

  private prune() {
    for (const receipt of this.receipts.values()) {
      if (receipt.expiresAt <= this.now() || (receipt.isCurrent && !receipt.isCurrent())) this.discard(receipt);
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

  private schedulePrune() {
    if (!this.timer) {
      this.timer = setInterval(() => this.prune(), 1000);
      this.timer.unref();
    }
  }

  private reservedBytes() {
    let total = 0;
    for (const receipt of this.receipts.values()) {
      if (receipt.state !== "complete" && receipt.state !== "reserved" && receipt.state !== "handoff")
        total += receipt.size;
    }
    return total;
  }

  private response(receipt: Receipt) {
    return {
      uploadId: receipt.uploadId,
      url: `/api/uploads/${receipt.uploadId}`,
      relativePath: receipt.relativePath,
      maxBytes: receipt.protocol === 1 ? MAX_UPLOAD_BYTES : this.maxUploadBytes,
      ...(receipt.protocol === 2
        ? {
            protocol: 2 as const,
            chunkSize: UPLOAD_CHUNK_SIZE,
            nextChunk: receipt.nextChunk,
            complete: receipt.state === "complete",
          }
        : {}),
    };
  }

  prepare(scope: UploadScope, filename: unknown, size: unknown, isCurrent?: () => boolean) {
    this.prune();
    if (!validFilename(filename)) throw new Error("Invalid upload filename. Use a visible filename without a path.");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BYTES)
      throw new Error("Upload must be between 0 and 50 MiB.");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope.sessionId) || !path.isAbsolute(scope.cwd)) throw unavailable();
    if (this.receipts.size >= MAX_RECEIPTS) throw new Error("Too many uploads. Wait for pending uploads to expire.");
    if (this.reservedBytes() + size > this.maxPendingUploadBytes)
      throw new Error("Too many bytes are reserved for incomplete uploads. Wait for an upload to finish or expire.");
    const receipt = this.newReceipt(scope, filename, size, 1, isCurrent);
    this.receipts.set(receipt.uploadId, receipt);
    this.schedulePrune();
    return this.response(receipt);
  }

  prepareV2(
    scope: UploadScope,
    filename: unknown,
    size: unknown,
    sha256: unknown,
    chunkHashes: unknown,
    isCurrent?: () => boolean,
  ) {
    this.prune();
    if (!validFilename(filename)) throw new Error("Invalid upload filename. Use a visible filename without a path.");
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > this.maxUploadBytes)
      throw new Error(`Upload must be between 0 and ${this.maxUploadBytes} bytes.`);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope.sessionId) || !path.isAbsolute(scope.cwd)) throw unavailable();
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256))
      throw new Error("A full-file SHA-256 hex digest is required.");
    const count = Math.ceil(size / UPLOAD_CHUNK_SIZE);
    if (
      !Array.isArray(chunkHashes) ||
      chunkHashes.length !== count ||
      !chunkHashes.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash))
    )
      throw new Error("Chunk SHA-256 hashes do not match the declared file size.");
    const normalizedHash = sha256.toLowerCase();
    const normalizedChunks = (chunkHashes as string[]).map((hash) => hash.toLowerCase());

    const existing = [...this.receipts.values()].find(
      (entry) =>
        entry.protocol === 2 &&
        sameScope(entry.scope, scope) &&
        entry.filename === filename &&
        entry.size === size &&
        entry.sha256 === normalizedHash &&
        entry.chunkHashes?.length === normalizedChunks.length &&
        entry.chunkHashes.every((hash, index) => hash === normalizedChunks[index]),
    );
    if (existing) {
      if (existing.state === "reserved") throw new Error("Attachment preflight is in progress. Try again shortly.");
      if (existing.state === "handoff") throw unknownAcceptance();
      if (existing.state === "writing" || existing.state === "finalizing")
        throw new Error("Upload is busy. Try again shortly.");
      existing.isCurrent = isCurrent ?? existing.isCurrent;
      existing.expiresAt = this.now() + UPLOAD_TTL_MS;
      this.schedulePrune();
      return this.response(existing);
    }
    if (this.receipts.size >= MAX_RECEIPTS) throw new Error("Too many uploads. Wait for pending uploads to expire.");
    if (this.reservedBytes() + size > this.maxPendingUploadBytes)
      throw new Error("Too many bytes are reserved for incomplete uploads. Wait for an upload to finish or expire.");
    const receipt = this.newReceipt(scope, filename, size, 2, isCurrent, normalizedHash, normalizedChunks);
    this.receipts.set(receipt.uploadId, receipt);
    this.schedulePrune();
    return this.response(receipt);
  }

  private newReceipt(
    scope: UploadScope,
    filename: string,
    size: number,
    protocol: 1 | 2,
    isCurrent?: () => boolean,
    sha256?: string,
    chunkHashes?: string[],
  ): Receipt {
    const uploadId = randomUUID();
    return {
      scope: { ...scope },
      uploadId,
      filename,
      size,
      relativePath: `.pi-uploads/${scope.sessionId}/${uploadId}/${filename}`,
      expiresAt: this.now() + UPLOAD_TTL_MS,
      protocol,
      ...(sha256 ? { sha256 } : {}),
      ...(chunkHashes ? { chunkHashes } : {}),
      nextChunk: 0,
      state: "pending",
      isCurrent,
    };
  }

  private openUploadDirectory(receipt: Receipt) {
    checkedDirectory(receipt.scope.cwd);
    const root = path.join(receipt.scope.cwd, ".pi-uploads");
    makeDirectory(root);
    checkedDirectory(root);
    const session = path.join(root, receipt.scope.sessionId);
    makeDirectory(session);
    checkedDirectory(session);
    const directory = path.join(session, receipt.uploadId);
    if (!receipt.directory) {
      // Never reuse an existing directory, even when empty.
      fs.mkdirSync(directory, { mode: 0o700 });
      checkedDirectory(directory);
      const stat = fs.lstatSync(directory);
      receipt.directory = directory;
      receipt.directoryIdentity = { dev: stat.dev, ino: stat.ino };
    }
    const directoryFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(directoryFd);
      if (
        !receipt.directoryIdentity ||
        stat.dev !== receipt.directoryIdentity.dev ||
        stat.ino !== receipt.directoryIdentity.ino ||
        (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${directoryFd}`) !== directory)
      )
        throw unavailable();
    } catch (error) {
      fs.closeSync(directoryFd);
      throw error;
    }
    return {
      directoryFd,
      pinned: process.platform === "linux" ? `/proc/self/fd/${directoryFd}` : directory,
      directory,
    };
  }

  private openPartial(receipt: Receipt, pinned: string, create: boolean, write: boolean) {
    const partial = path.join(pinned, ".partial");
    const flags = (write ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(partial, create ? flags | fs.constants.O_CREAT | fs.constants.O_EXCL : flags, 0o600);
    try {
      const opened = fs.fstatSync(fd);
      const onDisk = fs.lstatSync(partial);
      if (
        !opened.isFile() ||
        !onDisk.isFile() ||
        onDisk.isSymbolicLink() ||
        onDisk.nlink !== 1 ||
        opened.dev !== onDisk.dev ||
        opened.ino !== onDisk.ino ||
        (receipt.partialIdentity &&
          (opened.dev !== receipt.partialIdentity.dev || opened.ino !== receipt.partialIdentity.ino))
      )
        throw unavailable();
      receipt.partialIdentity = { dev: opened.dev, ino: opened.ino };
      return { fd, partial };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  async receive(id: string, scope: UploadScope, length: number, source: Readable, isCurrent: () => boolean) {
    this.prune();
    const receipt = this.receipts.get(id);
    if (
      !receipt ||
      receipt.protocol !== 1 ||
      receipt.state !== "pending" ||
      !sameScope(receipt.scope, scope) ||
      !isCurrent()
    )
      throw unavailable();
    // A legacy PUT consumes its capability, even if its length or disk write fails.
    receipt.state = "writing";
    if (length !== receipt.size || this.active >= MAX_ACTIVE) {
      this.receipts.delete(id);
      throw new Error("Upload size mismatch or upload concurrency limit reached.");
    }
    this.active++;
    let fd: number | undefined;
    let directoryFd: number | undefined;
    let temporary: string | undefined;
    let published = false;
    let failed = false;
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
      const opened = this.openUploadDirectory(receipt);
      directoryFd = opened.directoryFd;
      temporary = path.join(opened.pinned, ".partial");
      const partial = this.openPartial(receipt, opened.pinned, true, true);
      fd = partial.fd;
      let written = 0;
      for await (const chunk of source) {
        check();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        written += bytes.length;
        if (written > receipt.size || written > MAX_UPLOAD_BYTES) throw new Error("Upload exceeds declared size.");
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      }
      check();
      if (written !== receipt.size) throw new Error("Upload size mismatch.");
      const directoryStat = fs.fstatSync(directoryFd);
      if (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${directoryFd}`) !== receipt.directory)
        throw unavailable();
      const openedStat = fs.fstatSync(fd);
      const onDisk = fs.lstatSync(temporary);
      if (!onDisk.isFile() || onDisk.nlink !== 1 || openedStat.dev !== onDisk.dev || openedStat.ino !== onDisk.ino)
        throw unavailable();
      if (
        !receipt.directoryIdentity ||
        directoryStat.dev !== receipt.directoryIdentity.dev ||
        directoryStat.ino !== receipt.directoryIdentity.ino
      )
        throw unavailable();
      fs.fsyncSync(fd);
      fs.linkSync(temporary, path.join(opened.pinned, receipt.filename));
      published = true;
      fs.unlinkSync(temporary);
      temporary = undefined;
      receipt.partialIdentity = undefined;
      receipt.state = "complete";
      receipt.cancel = undefined;
      receipt.expiresAt = this.now() + UPLOAD_TTL_MS;
      return { uploadId: id, relativePath: receipt.relativePath, filename: receipt.filename, size: receipt.size };
    } catch {
      failed = true;
      this.receipts.delete(id);
      throw unavailable();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporary && !published) {
        try {
          fs.unlinkSync(temporary);
        } catch {}
      }
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
      if (failed) this.cleanupPartial(receipt);
      this.active--;
      receipt.cancel = undefined;
      this.prune();
    }
  }

  async receiveChunk(
    id: string,
    scope: UploadScope,
    index: number,
    length: number,
    source: Readable,
    isCurrent: () => boolean,
  ) {
    this.prune();
    const receipt = this.receipts.get(id);
    if (
      !receipt ||
      receipt.protocol !== 2 ||
      (receipt.state !== "pending" && receipt.state !== "writing") ||
      !sameScope(receipt.scope, scope) ||
      !isCurrent()
    )
      throw unavailable();
    const count = expectedChunkCount(receipt);
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("Chunk index is out of range.");
    const expectedLength = chunkLength(receipt, index);
    if (length !== expectedLength) throw new Error("Chunk size mismatch.");
    if (receipt.state === "writing" || this.active >= MAX_ACTIVE)
      throw new Error("Upload concurrency limit reached. Retry this chunk shortly.");
    if (index > receipt.nextChunk) throw new Error("Chunks must be uploaded in order.");
    const duplicate = index < receipt.nextChunk;
    const expectedHash = receipt.chunkHashes?.[index];
    if (!expectedHash) throw unavailable();
    receipt.state = "writing";
    receipt.isCurrent = isCurrent;
    receipt.expiresAt = this.now() + UPLOAD_TTL_MS;
    this.active++;
    let cancelled = false;
    let fd: number | undefined;
    let directoryFd: number | undefined;
    const offset = receipt.nextChunk * UPLOAD_CHUNK_SIZE;
    let wrote = 0;
    let keep = true;
    const digest = createHash("sha256");
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
      if (!duplicate) {
        const opened = this.openUploadDirectory(receipt);
        directoryFd = opened.directoryFd;
        const partial = this.openPartial(receipt, opened.pinned, receipt.partialIdentity === undefined, true);
        fd = partial.fd;
        const currentSize = fs.fstatSync(fd).size;
        if (currentSize < offset) {
          keep = false;
          throw new Error("Previously confirmed upload chunks are missing.");
        }
        if (currentSize > offset) fs.ftruncateSync(fd, offset);
      }
      let actual = 0;
      for await (const chunk of source) {
        check();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        actual += bytes.length;
        if (actual > expectedLength) throw new Error("Chunk exceeds declared size.");
        digest.update(bytes);
        if (!duplicate && bytes.length) {
          let written = 0;
          while (written < bytes.length) {
            const countWritten = fs.writeSync(fd as number, bytes, written, bytes.length - written, offset + wrote);
            if (countWritten <= 0) throw new Error("Unable to write upload chunk.");
            written += countWritten;
            wrote += countWritten;
          }
        }
      }
      check();
      if (actual !== expectedLength) throw new Error("Chunk size mismatch.");
      if (digest.digest("hex") !== expectedHash) throw new Error("Chunk SHA-256 mismatch.");
      if (!duplicate) {
        // fsync may block on slow or network-backed workspaces. Do not block
        // Pi's event loop, and do not acknowledge until the durable sync finishes.
        await syncFile(fd as number);
        check();
        if (fs.fstatSync(fd as number).size !== offset + expectedLength)
          throw new Error("Upload write was incomplete.");
        receipt.nextChunk++;
      }
      receipt.state = "pending";
      receipt.expiresAt = this.now() + UPLOAD_TTL_MS;
      return { uploadId: id, nextChunk: receipt.nextChunk };
    } catch (error) {
      if (!duplicate && fd !== undefined) {
        try {
          await truncateFile(fd, offset);
          await syncFile(fd);
          check();
        } catch {
          keep = false;
        }
      }
      if (!keep || cancelled || !isCurrent() || receipt.expiresAt <= this.now()) {
        this.discard(receipt);
      } else if (this.receipts.get(id) === receipt) {
        receipt.state = "pending";
        receipt.expiresAt = this.now() + UPLOAD_TTL_MS;
      }
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
      if (this.receipts.get(id) !== receipt) this.cleanupPartial(receipt);
      this.active--;
      receipt.cancel = undefined;
      this.prune();
    }
  }

  async complete(id: string, scope: UploadScope, isCurrent: () => boolean) {
    this.prune();
    const receipt = this.receipts.get(id);
    if (!receipt || receipt.protocol !== 2 || !sameScope(receipt.scope, scope) || !isCurrent()) throw unavailable();
    if (receipt.state === "reserved" || receipt.state === "handoff") throw unknownAcceptance();
    if (receipt.state === "complete")
      return { uploadId: id, relativePath: receipt.relativePath, filename: receipt.filename, size: receipt.size };
    if (receipt.state !== "pending") throw new Error("Upload is busy. Try again shortly.");
    if (receipt.nextChunk !== expectedChunkCount(receipt)) throw new Error("Upload is incomplete.");
    if (this.active >= MAX_ACTIVE) throw new Error("Upload concurrency limit reached. Try again shortly.");
    receipt.state = "finalizing";
    receipt.isCurrent = isCurrent;
    this.active++;
    let directoryFd: number | undefined;
    let fd: number | undefined;
    let success = false;
    const check = () => {
      if (!isCurrent() || receipt.expiresAt <= this.now() || this.receipts.get(id) !== receipt) throw unavailable();
    };
    try {
      check();
      const opened = this.openUploadDirectory(receipt);
      directoryFd = opened.directoryFd;
      if (!receipt.partialIdentity) {
        const created = this.openPartial(receipt, opened.pinned, true, true);
        fd = created.fd;
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
      }
      const partial = path.join(opened.pinned, ".partial");
      fd = fs.openSync(partial, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const openedStat = fs.fstatSync(fd);
      const onDisk = fs.lstatSync(partial);
      if (
        !openedStat.isFile() ||
        !onDisk.isFile() ||
        onDisk.isSymbolicLink() ||
        onDisk.nlink !== 1 ||
        openedStat.dev !== onDisk.dev ||
        openedStat.ino !== onDisk.ino ||
        !receipt.partialIdentity ||
        openedStat.dev !== receipt.partialIdentity.dev ||
        openedStat.ino !== receipt.partialIdentity.ino ||
        openedStat.size !== receipt.size
      )
        throw new Error("Upload file integrity check failed.");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < receipt.size) {
        check();
        const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, receipt.size - position), position);
        if (length <= 0) throw new Error("Upload file ended unexpectedly.");
        hash.update(buffer.subarray(0, length));
        position += length;
        // Yield between bounded reads so large files do not monopolize Pi's loop.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      check();
      if (fs.fstatSync(fd).size !== receipt.size || hash.digest("hex") !== receipt.sha256)
        throw new Error("Full-file SHA-256 mismatch.");
      const dirStat = fs.fstatSync(directoryFd);
      if (
        !receipt.directoryIdentity ||
        dirStat.dev !== receipt.directoryIdentity.dev ||
        dirStat.ino !== receipt.directoryIdentity.ino ||
        (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${directoryFd}`) !== receipt.directory)
      )
        throw unavailable();
      fs.linkSync(partial, path.join(opened.pinned, receipt.filename));
      // The no-replace link is the publication boundary. If unlinking the
      // private name fails, retain the completed receipt for idempotent retry.
      receipt.state = "complete";
      receipt.expiresAt = this.now() + UPLOAD_TTL_MS;
      success = true;
      try {
        fs.unlinkSync(partial);
        receipt.partialIdentity = undefined;
      } catch {}
      return { uploadId: id, relativePath: receipt.relativePath, filename: receipt.filename, size: receipt.size };
    } catch (error) {
      if (this.receipts.get(id) === receipt) this.discard(receipt);
      throw error instanceof Error && error.message === "Upload incomplete." ? error : unavailable();
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
      if (this.receipts.get(id) !== receipt) this.cleanupPartial(receipt);
      this.active--;
      if (!success && this.receipts.get(id) === receipt && receipt.state === "finalizing") receipt.state = "pending";
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
    for (const id of handoff.ids) this.receipts.delete(id);
    this.handoff = undefined;
    handoff.finish();
    this.prune();
  }

  clear() {
    this.handoff?.finish(unknownAcceptance());
    this.handoff = undefined;
    for (const receipt of this.receipts.values()) this.discard(receipt);
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
  const fail = (status: number, error: string, bodyLimit = MAX_UPLOAD_BYTES) => {
    const length = req.headers["content-length"];
    const bounded =
      length !== undefined && /^\d+$/.test(length) && Number(length) <= bodyLimit && !req.headers["transfer-encoding"];
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
  const url = req.url ?? "";
  const legacyMatch = /^\/api\/uploads\/([0-9a-f-]{36})$/.exec(url);
  const chunkMatch = /^\/api\/uploads\/([0-9a-f-]{36})\/chunks\/(\d+)$/.exec(url);
  if ((!legacyMatch && !chunkMatch) || !scope || !isCurrent()) return fail(404, "Upload unavailable or expired");
  const bodyLimit = chunkMatch ? UPLOAD_CHUNK_SIZE : MAX_UPLOAD_BYTES;
  const length = req.headers["content-length"];
  if (!length || !/^\d+$/.test(length) || req.headers["transfer-encoding"] !== undefined)
    return fail(411, "A known Content-Length is required", bodyLimit);
  const numericLength = Number(length);
  if (!Number.isSafeInteger(numericLength) || numericLength > bodyLimit)
    return fail(413, chunkMatch ? "Chunk exceeds 8 MiB" : "Upload exceeds 50 MiB", bodyLimit);
  if (req.headers["content-type"] !== "application/octet-stream")
    return fail(415, "Use application/octet-stream", bodyLimit);
  try {
    const result = legacyMatch
      ? await store.receive(legacyMatch[1], scope, numericLength, req, isCurrent)
      : await store.receiveChunk(chunkMatch?.[1] ?? "", scope, Number(chunkMatch?.[2]), numericLength, req, isCurrent);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch {
    // Filesystem and stream failures may embed private host paths or source
    // details. Keep the HTTP boundary generic, as in the legacy upload path.
    if (!res.destroyed) fail(400, "Upload failed or expired. Retry the file to resume confirmed chunks.", bodyLimit);
  }
}
