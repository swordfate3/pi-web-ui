import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as historyApi from "../extensions/session-history.ts";

const scope = { sessionId: "s", runtimeId: "r", leafId: "entry" };
const request = { sessionId: "s", runtimeId: "r", entryId: "entry" };
const read = historyApi.readEntryDetail;

test("detail chunks traverse Unicode and escapes stably within the complete envelope without changing source", () => {
  const text = '秘密😀\n"\\\u0001'.repeat(30_000);
  const branch = [{ id: "entry", type: "message", message: { role: "assistant", content: text } }];
  const hash = () => createHash("sha256").update(JSON.stringify(branch)).digest("hex");
  const before = hash();
  let cursor: string | undefined;
  let collected = "";
  let count = 0;
  do {
    const params = { ...request, ...(cursor ? { cursor } : {}) };
    const chunk = read(branch, scope, params, "\u0001".repeat(512));
    assert.deepEqual(chunk, read(branch, scope, params, "\u0001".repeat(512)));
    assert.ok(Buffer.byteLength(JSON.stringify({ type: "res", id: "\u0001".repeat(512), ok: true, result: chunk })) <= 64 * 1024);
    assert.equal(chunk.entryId, "entry");
    assert.equal(chunk.sessionId, "s");
    assert.equal(chunk.runtimeId, "r");
    assert.ok(chunk.text.length > 0);
    assert.ok(!chunk.text.includes("\ufffd"));
    assert.notEqual(chunk.nextCursor, cursor);
    collected += chunk.text;
    cursor = chunk.nextCursor ?? undefined;
    assert.ok(++count < 200);
  } while (cursor);
  assert.ok(count > 1);
  assert.equal(collected, text);
  assert.equal(hash(), before);
});

test("detail cursors reject cross-session/runtime/branch, mutations, bad offsets and non-branch entries", () => {
  const branch = [{ id: "entry", type: "message", message: { role: "user", content: "x".repeat(100_000) } }];
  const cursor = read(branch, scope, request, "1").nextCursor;
  assert.ok(cursor);
  for (const params of [
    { ...request, sessionId: "other" }, { ...request, runtimeId: "other" },
    { ...request, entryId: "outside" }, { ...request, cursor: "-1" },
    { ...request, cursor: "x".repeat(2000) }, { ...request, cursor: `${cursor}x` },
  ]) assert.throws(() => read(branch, scope, params, "1"));
  assert.throws(() => read(branch, { ...scope, leafId: "changed" }, { ...request, cursor }, "1"));
  assert.throws(() => read(branch, { ...scope, runtimeId: "new" }, { ...request, runtimeId: "new", cursor }, "1"));
  branch[0].message.content += "changed";
  assert.throws(() => read(branch, scope, { ...request, cursor }, "1"));
});

test("details render readable text, thinking and tool arguments but never image/binary bodies", () => {
  const branch = [{ id: "entry", type: "message", message: { role: "assistant", content: [
    { type: "text", text: "Hello" }, { type: "thinking", thinking: "Reasoning" },
    { type: "toolCall", id: "call", name: "write", arguments: { path: "file.md", content: "Readable tool body" } },
    { type: "image", data: "BASE64_SECRET", mimeType: "image/png" },
  ] } }];
  const result = read(branch, scope, request, "1");
  for (const text of ["Hello", "Reasoning", "write", "file.md", "Readable tool body"]) assert.ok(result.text.includes(text));
  assert.ok(!result.text.includes("BASE64_SECRET"));
  assert.ok(!result.text.includes('"type":'));
  assert.equal(result.nextCursor, null);
});
