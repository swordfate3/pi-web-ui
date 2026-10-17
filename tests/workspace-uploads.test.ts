import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  MAX_UPLOAD_BYTES,
  serveWorkspaceUpload,
  UPLOAD_TTL_MS,
  WorkspaceUploads,
} from "../extensions/workspace-uploads.ts";

function fixture(t: test.TestContext, now?: () => number) {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-upload-test-"));
  const store = new WorkspaceUploads(now);
  // Production HTTP/Pi owns a live handle; the standalone test process must
  // provide one while awaiting intentionally unref'ed TTL/dispatch timers.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => {
    clearInterval(keepAlive);
    store.clear();
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, store, scope: { cwd, sessionId: "session-1", epoch: 1 } };
}

for (const size of [0, 257, MAX_UPLOAD_BYTES]) {
  test(`stream ${size} bytes and consume receipt without deleting user file`, async (t) => {
    const { store, scope, cwd } = fixture(t);
    const p = store.prepare(scope, "二进制 image.png", size);
    assert.match(p.url, /^\/api\/uploads\/[0-9a-f-]{36}$/);
    assert.equal(p.maxBytes, MAX_UPLOAD_BYTES);
    assert.throws(() => store.resolve(scope, [p.uploadId]));
    const chunk = Buffer.alloc(65536, 137);
    const source = Readable.from(
      (function* () {
        for (let n = 0; n < size; n += chunk.length) yield chunk.subarray(0, Math.min(chunk.length, size - n));
      })(),
    );
    const result = await store.receive(p.uploadId, scope, size, source, () => true);
    const target = path.join(cwd, result.relativePath);
    assert.equal(statSync(target).size, size);
    assert.ok(readFileSync(target).every((byte) => byte === 137));
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(path.dirname(target)), [result.filename]);
    await assert.rejects(store.receive(p.uploadId, scope, size, Readable.from([]), () => true));
    // Resolving is not consumption: failed sends can retry.
    assert.deepEqual(store.resolve(scope, [p.uploadId]), [p.relativePath]);
    assert.deepEqual(store.resolve(scope, [p.uploadId]), [p.relativePath]);
    const message = `Use ${p.relativePath}`;
    await store.send(
      scope,
      [p.uploadId],
      message,
      async () => {},
      () => store.accept(scope, message),
    );
    assert.throws(() => store.resolve(scope, [p.uploadId]));
    store.clear();
    assert.ok(existsSync(target));
  });
}

test("reject invalid filename, size, identity and bounded pending requests", (t) => {
  const { store, scope } = fixture(t);
  for (const name of [
    "",
    ".env",
    "../escape",
    "/tmp/file",
    "C:\\file",
    "a/b",
    "a\nb",
    "a\0b",
    "a\u202eb",
    "file.",
    "con.txt",
  ])
    assert.throws(() => store.prepare(scope, name, 1), name);
  for (const size of [-1, 0.5, NaN, Infinity, MAX_UPLOAD_BYTES + 1, "1"])
    assert.throws(() => store.prepare(scope, "file", size));
  assert.throws(() => store.prepare({ ...scope, sessionId: "../escape" }, "file", 1));
  for (let n = 0; n < 16; n++) store.prepare(scope, "file", 1);
  assert.throws(() => store.prepare(scope, "file", 1), /Too many/);
});

test("size mismatches and stream failure clean partial files; capabilities are single use", async (t) => {
  const { store, scope, cwd } = fixture(t);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(2)]) {
    const p = store.prepare(scope, "data.bin", 1);
    await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([bytes]), () => true));
    assert.ok(!existsSync(path.join(cwd, path.dirname(p.relativePath))));
    await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([Buffer.alloc(1)]), () => true));
  }
  const p = store.prepare(scope, "data.bin", 1);
  await assert.rejects(store.receive(p.uploadId, scope, 0, Readable.from([]), () => true));
  const q = store.prepare(scope, "data.bin", 2);
  const stream = new PassThrough();
  const receiving = store.receive(q.uploadId, scope, 2, stream, () => true);
  stream.write(Buffer.alloc(1));
  stream.destroy(new Error("Disconnected"));
  await assert.rejects(receiving);
  assert.ok(!existsSync(path.join(cwd, path.dirname(q.relativePath))));
});

test("symlink ancestors, existing upload directory and final-file overwrite are rejected", async (t) => {
  const { store, scope, cwd } = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), "pi-upload-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(cwd, ".pi-uploads"));
  let p = store.prepare(scope, "data.bin", 1);
  await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([Buffer.alloc(1)]), () => true));
  assert.deepEqual(readdirSync(outside), []);
  rmSync(path.join(cwd, ".pi-uploads"));
  mkdirSync(path.join(cwd, ".pi-uploads"));
  symlinkSync(outside, path.join(cwd, ".pi-uploads", scope.sessionId));
  p = store.prepare(scope, "data.bin", 1);
  await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([Buffer.alloc(1)]), () => true));
  rmSync(path.join(cwd, ".pi-uploads", scope.sessionId));
  p = store.prepare(scope, "data.bin", 1);
  mkdirSync(path.join(cwd, path.dirname(p.relativePath)), { recursive: true });
  writeFileSync(path.join(cwd, p.relativePath), "DO_NOT_OVERWRITE");
  await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([Buffer.alloc(1)]), () => true));
  assert.equal(readFileSync(path.join(cwd, p.relativePath), "utf8"), "DO_NOT_OVERWRITE");
  p = store.prepare(scope, "data.bin", 1);
  const stream = new PassThrough();
  const receiving = store.receive(p.uploadId, scope, 1, stream, () => true);
  writeFileSync(path.join(cwd, p.relativePath), "ALREADY_EXISTS");
  stream.end(Buffer.alloc(1));
  await assert.rejects(receiving);
  assert.equal(readFileSync(path.join(cwd, p.relativePath), "utf8"), "ALREADY_EXISTS");
  assert.ok(!existsSync(path.join(cwd, path.dirname(p.relativePath), ".partial")));
});

test("OS write permission errors fail closed", {
  skip: process.getuid?.() === 0 ? "root bypasses directory permissions" : false,
}, async (t) => {
  const { store, scope, cwd } = fixture(t);
  const root = path.join(cwd, ".pi-uploads");
  mkdirSync(root, { mode: 0o500 });
  t.after(() => {
    if (existsSync(root)) chmodSync(root, 0o700);
  });
  const p = store.prepare(scope, "data.bin", 1);
  await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([Buffer.alloc(1)]), () => true));
  assert.deepEqual(readdirSync(root), []);
  chmodSync(root, 0o700);
});

test("session/runtime fencing, expiry, stop and concurrency limits", async (t) => {
  let now = 0;
  const { store, scope, cwd } = fixture(t, () => now);
  let p = store.prepare(scope, "data.bin", 1);
  for (const changed of [
    { ...scope, epoch: 2 },
    { ...scope, sessionId: "other" },
    { ...scope, cwd: path.dirname(cwd) },
  ])
    await assert.rejects(store.receive(p.uploadId, changed, 1, Readable.from([]), () => true));
  await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([]), () => false));
  now = UPLOAD_TTL_MS;
  await assert.rejects(store.receive(p.uploadId, scope, 1, Readable.from([]), () => true));
  for (const invalidate of ["clear", "scope", "expiry"]) {
    p = store.prepare(scope, "data.bin", 1);
    let current = true;
    const source = new PassThrough();
    const receiving = store.receive(p.uploadId, scope, 1, source, () => current);
    if (invalidate === "clear") store.clear();
    if (invalidate === "scope") current = false;
    if (invalidate === "expiry") now += UPLOAD_TTL_MS;
    source.end(Buffer.alloc(1));
    await assert.rejects(receiving);
    assert.ok(!existsSync(path.join(cwd, path.dirname(p.relativePath))));
  }
  const active = Array.from({ length: 2 }, () => {
    const p = store.prepare(scope, "data.bin", 1);
    return store.receive(p.uploadId, scope, 1, new PassThrough(), () => true);
  });
  p = store.prepare(scope, "data.bin", 1);
  await assert.rejects(
    store.receive(p.uploadId, scope, 1, Readable.from([Buffer.alloc(1)]), () => true),
    /concurrency/,
  );
  store.clear();
  await Promise.all(active.map((promise) => assert.rejects(promise)));
  p = store.prepare(scope, "kept.bin", 1);
  await store.receive(p.uploadId, scope, 1, Readable.from([Buffer.alloc(1)]), () => true);
  assert.throws(() => store.resolve({ ...scope, epoch: 99 }, [p.uploadId]));
  now += UPLOAD_TTL_MS;
  assert.throws(() => store.resolve(scope, [p.uploadId]));
  assert.ok(existsSync(path.join(cwd, p.relativePath)));
});

test("HTTP rejects unknown lengths, excess sizes, verbs, query paths, MIME and cross-origin requests", async (t) => {
  const { store, scope } = fixture(t);
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
  const p = store.prepare(scope, "zero.bin", 0);
  const url = `http://127.0.0.1:${address.port}${p.url}`;
  for (const [headers, status] of [
    [{ "Content-Length": String(MAX_UPLOAD_BYTES + 1) }, 413],
    [{ "Content-Length": "0", Origin: "https://evil.example" }, 403],
    [{ "Content-Length": "0", "Sec-Fetch-Site": "cross-site" }, 403],
    [{ "Content-Length": "0", "Content-Type": "text/plain" }, 415],
    [{ "Transfer-Encoding": "chunked" }, 411],
  ] as const) {
    const response = await new Promise<number>((resolve, reject) => {
      const req = http.request(url, { method: "PUT", headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(response, status);
  }
  assert.equal((await fetch(url)).status, 405);
  assert.equal(
    (await fetch(`${url}?path=elsewhere`, { method: "PUT", headers: { "Content-Length": "0" } })).status,
    404,
  );
  const good = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": "0" },
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).relativePath, p.relativePath);
});

test("idle stalled uploads are cancelled by TTL/scope sweeper without receiving another chunk", async (t) => {
  let now = 0;
  const { store, scope, cwd } = fixture(t, () => now);
  for (const reason of ["expiry", "scope"]) {
    let current = true;
    const p = store.prepare(scope, "stalled.bin", 2);
    const stream = new PassThrough();
    const receiving = store.receive(p.uploadId, scope, 2, stream, () => current);
    const rejected = assert.rejects(receiving);
    stream.write(Buffer.alloc(1));
    await new Promise((resolve) => setImmediate(resolve));
    if (reason === "expiry") now += UPLOAD_TTL_MS;
    else current = false;
    await rejected;
    assert.ok(!existsSync(path.join(cwd, path.dirname(p.relativePath))));
  }
});

async function completed(t: test.TestContext) {
  const f = fixture(t);
  const upload = f.store.prepare(f.scope, "kept.txt", 0);
  await f.store.receive(upload.uploadId, f.scope, 0, Readable.from([]), () => true);
  return { ...f, upload, message: `Read ${upload.relativePath}` };
}

test("void dispatch cannot consume; only exact user acceptance settles, with atomic cross-browser reservation", async (t) => {
  const { store, scope, upload, message } = await completed(t);
  let dispatches = 0;
  let settled = false;
  const sending = store.send(
    scope,
    [upload.uploadId],
    message,
    async () => {},
    () => {
      dispatches++;
    },
  );
  void sending.then(() => {
    settled = true;
  });
  await assert.rejects(
    store.send(
      scope,
      [upload.uploadId],
      message,
      async () => {},
      () => {
        dispatches++;
      },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatches, 1);
  assert.equal(settled, false);
  store.accept({ ...scope, epoch: 2 }, message);
  store.accept(scope, `${message} transformed`);
  assert.equal(settled, false);
  store.accept(scope, message);
  await sending;
  assert.throws(() => store.resolve(scope, [upload.uploadId]));
});

test("preflight failure releases receipt; post-dispatch failure/timeout preserves a no-retry fence", async (t) => {
  const { store, scope, cwd, upload, message } = await completed(t);
  await assert.rejects(
    store.send(
      scope,
      [upload.uploadId],
      message,
      async () => {
        throw new Error("busy/auth");
      },
      () => assert.fail("must not dispatch"),
    ),
    /busy\/auth/,
  );
  assert.deepEqual(store.resolve(scope, [upload.uploadId]), [upload.relativePath]);
  const sending = store.send(
    scope,
    [upload.uploadId],
    message,
    async () => {},
    () => {},
    20,
  );
  await assert.rejects(sending, /acceptance is unknown/);
  assert.throws(() => store.resolve(scope, [upload.uploadId]), /Do not resend/);
  await assert.rejects(
    store.send(
      scope,
      [upload.uploadId],
      message,
      async () => {},
      () => assert.fail("duplicate"),
    ),
    /Do not resend/,
  );
  assert.ok(existsSync(path.join(cwd, upload.relativePath)));
  // A delayed event may still settle the receipt, but never dispatch it again.
  store.accept(scope, message);
  assert.throws(() => store.resolve(scope, [upload.uploadId]), /unavailable/);
});

test("preflight timeout fences late completion without dispatch, and lifecycle cleanup settles waiters", async (t) => {
  const { store, scope, upload, message } = await completed(t);
  let release!: () => void;
  const preflight = new Promise<void>((resolve) => {
    release = resolve;
  });
  await assert.rejects(
    store.send(
      scope,
      [upload.uploadId],
      message,
      () => preflight,
      () => assert.fail("late dispatch"),
      20,
    ),
    /Nothing was sent/,
  );
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(store.resolve(scope, [upload.uploadId]), [upload.relativePath]);
  const sending = store.send(
    scope,
    [upload.uploadId],
    message,
    async () => {},
    () => {},
  );
  const rejected = assert.rejects(sending, /acceptance is unknown/);
  store.clear();
  await rejected;
});

test("a throw after the dispatch boundary is unknown, never a safe retry", async (t) => {
  const { store, scope, upload, message } = await completed(t);
  await assert.rejects(
    store.send(
      scope,
      [upload.uploadId],
      message,
      async () => {},
      () => {
        throw new Error("runtime failure");
      },
    ),
    /acceptance is unknown/,
  );
  assert.throws(() => store.resolve(scope, [upload.uploadId]), /Do not resend/);
});
