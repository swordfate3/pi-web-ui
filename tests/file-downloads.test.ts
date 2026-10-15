import assert from "node:assert/strict";
import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attachmentDisposition, WorkspaceDownloads } from "../extensions/file-downloads.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-file-download-test-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(path.join(workspace, "documents/求职"), { recursive: true });
  const requested = "documents/求职/计算机硕士秋招简历-优化版.pdf";
  const file = path.join(workspace, requested);
  writeFileSync(file, Buffer.from("%PDF-1.7\n\0binary resume\n"));
  const outside = path.join(root, "private.pdf");
  writeFileSync(outside, "OUTSIDE_SECRET");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, requested, file, outside, scope: { workspace, sessionId: "s1", epoch: 1 } };
}

test("a Chinese project PDF downloads byte-for-byte and never places its path in the capability URL", (t) => {
  const f = fixture(t);
  const store = new WorkspaceDownloads();
  const prepared = store.prepare(f.scope, f.requested);
  assert.equal(prepared.filename, "计算机硕士秋招简历-优化版.pdf");
  assert.match(prepared.downloadUrl, /^\/api\/downloads\/[0-9a-f-]{36}$/);
  const opened = store.open(prepared.token, f.scope);
  try {
    assert.deepEqual(readFileSync(opened.fd), readFileSync(f.file));
  } finally {
    closeSync(opened.fd);
  }
  assert.equal(
    attachmentDisposition(prepared.filename),
    `attachment; filename="download.pdf"; filename*=UTF-8''${encodeURIComponent(prepared.filename)}`,
  );
});

test("binary files larger than the WebSocket frame limit are available as file streams", (t) => {
  const f = fixture(t);
  const bytes = Buffer.alloc(5 * 1024 * 1024, 123);
  writeFileSync(path.join(f.workspace, "large.zip"), bytes);
  const store = new WorkspaceDownloads();
  const prepared = store.prepare(f.scope, "large.zip");
  assert.equal(prepared.size, bytes.length);
  assert.ok(JSON.stringify(prepared).length < 1024);
  const opened = store.open(prepared.token, f.scope);
  try {
    assert.deepEqual(readFileSync(opened.fd), bytes);
  } finally {
    closeSync(opened.fd);
  }
});

test("outside paths, traversal, hidden credentials, key files, directories and symlinks are rejected", (t) => {
  const f = fixture(t);
  for (const file of [".env", "auth.json", "token", "server.key", "id_ed25519", "id_rsa.pub"])
    writeFileSync(path.join(f.workspace, file), "SECRET");
  mkdirSync(path.join(f.workspace, ".ssh"));
  writeFileSync(path.join(f.workspace, ".ssh/config"), "SECRET");
  symlinkSync(f.outside, path.join(f.workspace, "escape.pdf"));
  symlinkSync(path.dirname(f.outside), path.join(f.workspace, "alias"));
  linkSync(f.outside, path.join(f.workspace, "hardlink.pdf"));
  const store = new WorkspaceDownloads();
  for (const file of [
    f.outside,
    "../private.pdf",
    "documents/../../private.pdf",
    ".env",
    ".ssh/config",
    "auth.json",
    "token",
    "server.key",
    "id_ed25519",
    "id_rsa.pub",
    "documents",
    "escape.pdf",
    "alias/private.pdf",
    "hardlink.pdf",
    "missing.pdf",
    "a\u0000.pdf",
  ]) {
    assert.throws(() => store.prepare(f.scope, file), Error, file);
  }
});

test("expired, cleared, replaced-file and old-session download capabilities fail closed", (t) => {
  const f = fixture(t);
  let now = 0;
  const store = new WorkspaceDownloads(() => now);
  let prepared = store.prepare(f.scope, f.requested);
  assert.throws(() => store.open(prepared.token, { ...f.scope, sessionId: "s2" }));
  assert.throws(() => store.open(prepared.token, { ...f.scope, epoch: 2 }));
  now = 10 * 60 * 1000;
  assert.throws(() => store.open(prepared.token, f.scope));
  prepared = store.prepare(f.scope, f.requested);
  store.clear();
  assert.throws(() => store.open(prepared.token, f.scope));
  prepared = store.prepare(f.scope, f.requested);
  renameSync(f.file, `${f.file}.old`);
  writeFileSync(f.file, "REPLACEMENT");
  assert.throws(() => store.open(prepared.token, f.scope));
});
