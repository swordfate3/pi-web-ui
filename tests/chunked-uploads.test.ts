import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  HARD_MAX_UPLOAD_BYTES,
  MAX_RESERVED_UPLOAD_BYTES,
  serveWorkspaceUpload,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_TTL_MS,
  WorkspaceUploads,
} from "../extensions/workspace-uploads.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture(t: test.TestContext, options: { now?: () => number; maxBytes?: number; pendingBytes?: number } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-chunk-upload-test-"));
  const store = new WorkspaceUploads(options.now, options.maxBytes, options.pendingBytes);
  const scope = { cwd, sessionId: "chunk-session", epoch: 1 };
  t.after(() => {
    store.clear();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, store, scope };
}
async function putChunk(
  store: WorkspaceUploads,
  scope: { cwd: string; sessionId: string; epoch: number },
  uploadId: string,
  index: number,
  bytes: Buffer,
  current = () => true,
) {
  return store.receiveChunk(uploadId, scope, index, bytes.length, Readable.from([bytes]), current);
}

test("v2 preparation enforces exact SHA-256 list shape and resumes only a matching file", (t) => {
  const { store, scope } = fixture(t);
  const bytes = Buffer.from("resumable");
  const hashes = [sha256(bytes)];
  assert.throws(() => store.prepareV2(scope, "file.bin", bytes.length, sha256(bytes), [], () => true));
  assert.throws(() => store.prepareV2(scope, "file.bin", bytes.length, "not-a-hash", hashes, () => true));
  const first = store.prepareV2(scope, "file.bin", bytes.length, sha256(bytes), hashes, () => true);
  assert.deepEqual(
    { protocol: first.protocol, chunkSize: first.chunkSize, nextChunk: first.nextChunk, complete: first.complete },
    { protocol: 2, chunkSize: UPLOAD_CHUNK_SIZE, nextChunk: 0, complete: false },
  );
  const resumed = store.prepareV2(scope, "file.bin", bytes.length, sha256(bytes), hashes, () => true);
  assert.equal(resumed.uploadId, first.uploadId);
  const different = store.prepareV2(
    scope,
    "file.bin",
    bytes.length,
    sha256(Buffer.from("different")),
    hashes,
    () => true,
  );
  assert.notEqual(different.uploadId, first.uploadId);
});

test("v2 chunks are ordered, exact-sized, hash checked, idempotent, and atomically completed", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const first = Buffer.alloc(UPLOAD_CHUNK_SIZE, 19);
  const last = Buffer.from([4, 5, 6]);
  const allHash = createHash("sha256").update(first).update(last).digest("hex");
  const chunkHashes = [sha256(first), sha256(last)];
  const upload = store.prepareV2(scope, "two-chunks.bin", first.length + last.length, allHash, chunkHashes, () => true);
  await assert.rejects(putChunk(store, scope, upload.uploadId, 1, last), /order/);
  await assert.rejects(putChunk(store, scope, upload.uploadId, 0, Buffer.alloc(first.length - 1)), /size/);
  await assert.rejects(putChunk(store, scope, upload.uploadId, 0, Buffer.alloc(first.length, 20)), /SHA-256/);
  await assert.rejects(
    store.complete(upload.uploadId, scope, () => true),
    /incomplete/,
  );
  assert.equal((await putChunk(store, scope, upload.uploadId, 0, first)).nextChunk, 1);
  const resumed = store.prepareV2(
    scope,
    "two-chunks.bin",
    first.length + last.length,
    allHash,
    chunkHashes,
    () => true,
  );
  assert.equal(resumed.uploadId, upload.uploadId);
  assert.equal(resumed.nextChunk, 1);
  assert.equal((await putChunk(store, scope, upload.uploadId, 0, first)).nextChunk, 1);
  await assert.rejects(putChunk(store, scope, upload.uploadId, 0, Buffer.alloc(first.length, 20)), /SHA-256/);
  assert.equal((await putChunk(store, scope, upload.uploadId, 1, last)).nextChunk, 2);
  const result = await store.complete(upload.uploadId, scope, () => true);
  const target = path.join(cwd, result.relativePath);
  assert.equal(statSync(target).size, first.length + last.length);
  assert.deepEqual(readFileSync(target), Buffer.concat([first, last]));
  const replay = store.prepareV2(scope, "two-chunks.bin", first.length + last.length, allHash, chunkHashes, () => true);
  assert.equal(replay.uploadId, upload.uploadId);
  assert.equal(replay.complete, true);
  assert.equal((await store.complete(upload.uploadId, scope, () => true)).relativePath, result.relativePath);
});

test("a matching prepare reports busy while its chunk write is active", async (t) => {
  const { store, scope } = fixture(t);
  const bytes = Buffer.from("in progress");
  const hash = sha256(bytes);
  const upload = store.prepareV2(scope, "busy.bin", bytes.length, hash, [hash], () => true);
  const source = new PassThrough();
  const receiving = store.receiveChunk(upload.uploadId, scope, 0, bytes.length, source, () => true);
  source.end(bytes);
  assert.throws(() => store.prepareV2(scope, "busy.bin", bytes.length, hash, [hash], () => true), /busy/);
  await receiving;
  assert.equal(store.prepareV2(scope, "busy.bin", bytes.length, hash, [hash], () => true).nextChunk, 1);
});

test("failed stream preserves prior chunks and truncates only the failed chunk", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const confirmed = Buffer.alloc(UPLOAD_CHUNK_SIZE, 31);
  const last = Buffer.from("end");
  const upload = store.prepareV2(
    scope,
    "recover.bin",
    confirmed.length + last.length,
    createHash("sha256").update(confirmed).update(last).digest("hex"),
    [sha256(confirmed), sha256(last)],
    () => true,
  );
  await putChunk(store, scope, upload.uploadId, 0, confirmed);
  const interrupted = Readable.from(
    (async function* () {
      yield Buffer.from("partial failed chunk");
      throw new Error("connection dropped");
    })(),
  );
  await assert.rejects(store.receiveChunk(upload.uploadId, scope, 1, last.length, interrupted, () => true));
  const resumed = store.prepareV2(
    scope,
    "recover.bin",
    confirmed.length + last.length,
    createHash("sha256").update(confirmed).update(last).digest("hex"),
    [sha256(confirmed), sha256(last)],
    () => true,
  );
  assert.equal(resumed.nextChunk, 1);
  const targetDirectory = path.join(cwd, path.dirname(upload.relativePath));
  assert.equal(statSync(path.join(targetDirectory, ".partial")).size, UPLOAD_CHUNK_SIZE);
  await putChunk(store, scope, upload.uploadId, 1, last);
  await store.complete(upload.uploadId, scope, () => true);
  assert.deepEqual(readFileSync(path.join(cwd, upload.relativePath)), Buffer.concat([confirmed, last]));
});

test("full hash mismatch, expiry, scope change, and clear remove owned partials", async (t) => {
  let now = 0;
  const { store, scope, cwd } = fixture(t, { now: () => now });
  const bytes = Buffer.from("hash mismatch");
  const upload = store.prepareV2(
    scope,
    "bad-hash.bin",
    bytes.length,
    sha256(Buffer.from("wrong")),
    [sha256(bytes)],
    () => true,
  );
  await putChunk(store, scope, upload.uploadId, 0, bytes);
  await assert.rejects(store.complete(upload.uploadId, scope, () => true));
  assert.ok(!existsSync(path.join(cwd, path.dirname(upload.relativePath))));

  for (const reason of ["expiry", "scope", "clear"] as const) {
    let current = true;
    const next = store.prepareV2(scope, `${reason}.bin`, bytes.length, sha256(bytes), [sha256(bytes)], () => current);
    await putChunk(store, scope, next.uploadId, 0, bytes, () => current);
    if (reason === "expiry") now += UPLOAD_TTL_MS;
    if (reason === "scope") current = false;
    if (reason === "clear") store.clear();
    if (reason !== "clear") store.prepareV2(scope, `trigger-${reason}.bin`, 0, sha256(Buffer.alloc(0)), [], () => true);
    assert.ok(!existsSync(path.join(cwd, path.dirname(next.relativePath))));
  }
});

test("v2 prepare does not reuse a receipt reserved or fenced for message handoff", async (t) => {
  const { store, scope } = fixture(t);
  const bytes = Buffer.from("fenced handoff");
  const hash = sha256(bytes);
  const upload = store.prepareV2(scope, "fenced.bin", bytes.length, hash, [hash], () => true);
  await putChunk(store, scope, upload.uploadId, 0, bytes);
  await store.complete(upload.uploadId, scope, () => true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const message = `Read ${upload.relativePath}`;
  let markDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  const sending = store.send(scope, [upload.uploadId], message, () => gate, markDispatched);
  // The synchronous reservation happens before preflight begins. A retry at
  // this point is busy, not yet inside the post-dispatch unknown-acceptance fence.
  assert.throws(
    () => store.prepareV2(scope, "fenced.bin", bytes.length, hash, [hash], () => true),
    /preflight is in progress/,
  );
  release();
  // Wait for the actual dispatch boundary: only then is prepare fenced as unknown.
  await dispatched;
  assert.throws(
    () => store.prepareV2(scope, "fenced.bin", bytes.length, hash, [hash], () => true),
    /acceptance is unknown/,
  );
  store.accept(scope, message);
  await sending;
});

test("lost final-chunk and completion responses can be retried without duplicate publication", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const bytes = Buffer.from("last chunk response was lost");
  const digest = sha256(bytes);
  const upload = store.prepareV2(scope, "lost-response.bin", bytes.length, digest, [digest], () => true);

  // Server accepted the final chunk, but the client never observed its response.
  await putChunk(store, scope, upload.uploadId, 0, bytes);
  assert.equal((await putChunk(store, scope, upload.uploadId, 0, bytes)).nextChunk, 1);

  // Server published the file, but the completion response was lost as well.
  const firstReceipt = await store.complete(upload.uploadId, scope, () => true);
  const publishedPath = path.join(cwd, firstReceipt.relativePath);
  const beforeRetry = statSync(publishedPath);
  const resumed = store.prepareV2(scope, "lost-response.bin", bytes.length, digest, [digest], () => true);
  assert.equal(resumed.uploadId, upload.uploadId);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.nextChunk, 1);
  assert.equal((await store.complete(upload.uploadId, scope, () => true)).relativePath, firstReceipt.relativePath);
  const afterRetry = statSync(publishedPath);
  assert.equal(afterRetry.ino, beforeRetry.ino);
  assert.deepEqual(readFileSync(publishedPath), bytes);
  assert.deepEqual((await import("node:fs")).readdirSync(path.dirname(publishedPath)), ["lost-response.bin"]);
});

test("HTTP chunk route accepts only bounded octet-stream PUT and returns the next index", async (t) => {
  const { store, scope } = fixture(t);
  const bytes = Buffer.from("http chunk");
  const upload = store.prepareV2(scope, "http.bin", bytes.length, sha256(bytes), [sha256(bytes)], () => true);
  const server = http.createServer((req, res) => {
    void serveWorkspaceUpload(req, res, store, scope, () => true, `http://${req.headers.host}`, false);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/uploads/${upload.uploadId}/chunks/0`;
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uploadId: upload.uploadId, nextChunk: 1 });
  assert.equal((await fetch(`${url}/extra`, { method: "PUT", body: bytes })).status, 404);
});

test("HTTP chunk failures redact filesystem paths and input-stream details", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const bytes = Buffer.from("sensitive fixture");
  const hash = sha256(bytes);
  const p = store.prepareV2(scope, "safe.bin", bytes.length, hash, [hash]);
  // Remove only this test's workspace after preparation, causing a real ENOENT.
  rmSync(cwd, { recursive: true, force: true });
  const server = http.createServer((req, res) => {
    void serveWorkspaceUpload(req, res, store, scope, () => true, `http://${req.headers.host}`, false);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/uploads/${p.uploadId}/chunks/0`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
  assert.equal(response.status, 400);
  const message = await response.text();
  assert.ok(!message.includes(cwd));
  assert.ok(!/ENOENT|lstat|sensitive fixture|\.partial/.test(message));
  assert.match(message, /Upload failed or expired/);
});

test("upload limit environment settings default safely and clamp to hard caps", (t) => {
  const { scope } = fixture(t);
  const previousMax = process.env.PI_WEB_UPLOAD_MAX_BYTES;
  const previousPending = process.env.PI_WEB_UPLOAD_MAX_PENDING_BYTES;
  t.after(() => {
    if (previousMax === undefined) delete process.env.PI_WEB_UPLOAD_MAX_BYTES;
    else process.env.PI_WEB_UPLOAD_MAX_BYTES = previousMax;
    if (previousPending === undefined) delete process.env.PI_WEB_UPLOAD_MAX_PENDING_BYTES;
    else process.env.PI_WEB_UPLOAD_MAX_PENDING_BYTES = previousPending;
  });
  delete process.env.PI_WEB_UPLOAD_MAX_BYTES;
  delete process.env.PI_WEB_UPLOAD_MAX_PENDING_BYTES;
  assert.equal(new WorkspaceUploads().maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES);
  assert.equal(new WorkspaceUploads().maxPendingUploadBytes, MAX_RESERVED_UPLOAD_BYTES);
  process.env.PI_WEB_UPLOAD_MAX_BYTES = String(HARD_MAX_UPLOAD_BYTES + 100);
  process.env.PI_WEB_UPLOAD_MAX_PENDING_BYTES = String(HARD_MAX_UPLOAD_BYTES + 100);
  assert.equal(new WorkspaceUploads().maxUploadBytes, HARD_MAX_UPLOAD_BYTES);
  assert.equal(new WorkspaceUploads().maxPendingUploadBytes, HARD_MAX_UPLOAD_BYTES + 100);

  const limited = new WorkspaceUploads(() => 0, 7, 4);
  assert.throws(() => limited.prepareV2(scope, "too-large.bin", 8, sha256(Buffer.alloc(8)), [sha256(Buffer.alloc(8))]));
  assert.throws(() =>
    limited.prepareV2(scope, "too-much-reserved.bin", 5, sha256(Buffer.alloc(5)), [sha256(Buffer.alloc(5))]),
  );
  const underLimit = limited.prepareV2(scope, "reserved.bin", 4, sha256(Buffer.alloc(4)), [sha256(Buffer.alloc(4))]);
  assert.equal(underLimit.maxBytes, 7);
  limited.clear();
});

test("v2 resumed writes reject swapped upload directories and never write outside the workspace", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const first = Buffer.alloc(UPLOAD_CHUNK_SIZE, 5);
  const tail = Buffer.from("tail");
  const full = createHash("sha256").update(first).update(tail).digest("hex");
  const p = store.prepareV2(scope, "swapped.bin", first.length + tail.length, full, [sha256(first), sha256(tail)]);
  await putChunk(store, scope, p.uploadId, 0, first);
  const owned = path.join(cwd, path.dirname(p.relativePath));
  const outside = mkdtempSync(path.join(tmpdir(), "pi-chunk-external-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "sentinel"), "unchanged");
  renameSync(owned, `${owned}-original`);
  symlinkSync(outside, owned);
  await assert.rejects(putChunk(store, scope, p.uploadId, 1, tail));
  assert.equal(readFileSync(path.join(outside, "sentinel"), "utf8"), "unchanged");
  assert.ok(!existsSync(path.join(outside, ".partial")));
  assert.ok(!existsSync(path.join(outside, "swapped.bin")));
});

test("full completion detects corruption of an already confirmed chunk", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const bytes = Buffer.from("original");
  const hash = sha256(bytes);
  const p = store.prepareV2(scope, "corrupt.bin", bytes.length, hash, [hash]);
  await putChunk(store, scope, p.uploadId, 0, bytes);
  const directory = path.join(cwd, path.dirname(p.relativePath));
  writeFileSync(path.join(directory, ".partial"), "tampered");
  await assert.rejects(store.complete(p.uploadId, scope, () => true));
  assert.ok(!existsSync(path.join(cwd, p.relativePath)));
  assert.ok(!existsSync(directory));
});

test("incomplete quota charges whole declared sizes and completion releases only temporary quota", async (t) => {
  const { store, scope, cwd } = fixture(t, { maxBytes: 8, pendingBytes: 8 });
  const bytes = Buffer.alloc(4, 1);
  const hash = sha256(bytes);
  const a = store.prepareV2(scope, "a.bin", 4, hash, [hash]);
  const b = store.prepareV2(scope, "b.bin", 4, hash, [hash]);
  assert.throws(
    () => store.prepareV2(scope, "c.bin", 1, sha256(Buffer.alloc(1)), [sha256(Buffer.alloc(1))]),
    /reserved/,
  );
  await putChunk(store, scope, a.uploadId, 0, bytes);
  assert.throws(
    () => store.prepareV2(scope, "c.bin", 1, sha256(Buffer.alloc(1)), [sha256(Buffer.alloc(1))]),
    /reserved/,
  );
  await store.complete(a.uploadId, scope, () => true);
  const c = store.prepareV2(scope, "c.bin", 4, hash, [hash]);
  assert.ok(c.uploadId !== b.uploadId);
  store.clear();
  assert.ok(existsSync(path.join(cwd, a.relativePath)), "quota and clear never delete completed files");
});

test("clear during active chunk or final verification cannot publish or retain old partials", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const bytes = Buffer.alloc(UPLOAD_CHUNK_SIZE, 4);
  const hash = sha256(bytes);
  const a = store.prepareV2(scope, "active.bin", bytes.length, hash, [hash]);
  const source = new PassThrough();
  const receiving = store.receiveChunk(a.uploadId, scope, 0, bytes.length, source, () => true);
  const rejected = assert.rejects(receiving);
  source.write(bytes.subarray(0, 1024));
  await new Promise<void>((resolve) => setImmediate(resolve));
  store.clear();
  await rejected;
  assert.ok(!existsSync(path.join(cwd, path.dirname(a.relativePath))));
  const b = store.prepareV2(scope, "finalizing.bin", bytes.length, hash, [hash]);
  await putChunk(store, scope, b.uploadId, 0, bytes);
  const completion = store.complete(b.uploadId, scope, () => true);
  const failed = assert.rejects(completion);
  store.clear();
  await failed;
  assert.ok(!existsSync(path.join(cwd, path.dirname(b.relativePath))));
});

test("1 GiB is streamed through reusable 8 MiB buffers and verified on disk", {
  timeout: 600_000,
  skip: process.env.PI_WEB_UPLOAD_TEST_1GIB !== "1",
}, async (t) => {
  const { store, scope, cwd } = fixture(t);
  const chunk = Buffer.alloc(UPLOAD_CHUNK_SIZE, 73);
  const chunkHash = sha256(chunk);
  const fullHasher = createHash("sha256");
  const chunkCount = (1024 * 1024 * 1024) / UPLOAD_CHUNK_SIZE;
  for (let index = 0; index < chunkCount; index++) fullHasher.update(chunk);
  const fullHash = fullHasher.digest("hex");
  const chunkHashes = Array.from({ length: chunkCount }, () => chunkHash);
  const upload = store.prepareV2(scope, "one-gib.bin", 1024 * 1024 * 1024, fullHash, chunkHashes, () => true);
  for (let index = 0; index < chunkCount; index++) {
    assert.equal((await putChunk(store, scope, upload.uploadId, index, chunk)).nextChunk, index + 1);
  }
  const result = await store.complete(upload.uploadId, scope, () => true);
  const target = path.join(cwd, result.relativePath);
  assert.equal(statSync(target).size, 1024 * 1024 * 1024);
  const actualHasher = createHash("sha256");
  const stream = (await import("node:fs")).createReadStream(target, { highWaterMark: UPLOAD_CHUNK_SIZE });
  for await (const bytes of stream) actualHasher.update(bytes);
  assert.equal(actualHasher.digest("hex"), fullHash);
});
