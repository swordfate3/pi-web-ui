import assert from "node:assert/strict";
import { test } from "node:test";
import { boundConversationWindow, boundedToolOutput } from "../src/web/src/core/conversation-window.ts";
import { entryDetailTargets } from "../src/web/src/core/conversation-window.ts";
import { syncToItems } from "../src/web/src/core/chat-conversion.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import { createWorkspaceSlice } from "../src/web/src/core/store/workspace-slice.ts";
import { createConnectionSlice } from "../src/web/src/core/store/connection-slice.ts";
import type { PiWebUiStore } from "../src/web/src/core/store/types.ts";
import type { ChatItem } from "../src/web/src/core/types.ts";

test("window retains newest items and Unicode previews without cloning unchecked nested inputs", () => {
  const items: ChatItem[] = Array.from({ length: 220 }, (_, i) => ({ kind: "message", id: String(i), role: "user", text: "中😀".repeat(4000) }));
  const window = boundConversationWindow(items);
  assert.ok(window.items.length < 200);
  assert.equal(window.items.at(-1)?.id, "219");
  assert.ok(Buffer.byteLength(JSON.stringify(window.items)) <= 512 * 1024);
  const huge: ChatItem = { kind: "tool", id: "exact", entryId: "entry", name: "write", state: "input-streaming",
    input: { content: "中".repeat(100_000), toJSON() { throw new Error("source serialization forbidden"); } } };
  const result = boundConversationWindow([huge]).items[0];
  assert.equal(result.id, "exact");
  assert.equal(result.entryId, "entry");
  assert.equal(result.historyPreview, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.equal((huge.input as { content: string }).content.length, 100_000);
  assert.equal(boundedToolOutput(huge.input).preview, true);
});

test("history conversion exposes message/tool previews and exact detail targets", () => {
  const items = syncToItems([
    { type: "message", id: "user", historyPreview: true, message: { role: "user", content: "preview" } },
    { type: "message", id: "call", historyPreview: true, message: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "write" }] } },
    { type: "message", id: "result", historyPreview: true, message: { role: "toolResult", toolCallId: "tool", content: "preview output" } },
  ], (prefix) => prefix);
  assert.equal(items[0].historyPreview, true);
  assert.equal(items[1].historyPreview, true);
  assert.equal(items[1].detailEntryId, "result");
  assert.deepEqual(items[1].relatedEntryIds, ["call", "result"]);
  assert.deepEqual(entryDetailTargets(items[1]), ["call", "result"]);
});

test("pretty-print expansion of a small persisted tool result remains an explicit preview", () => {
  let nested: unknown = Array.from({ length: 400 }, () => ({ value: "x" }));
  for (let i = 0; i < 20; i++) nested = { nested };
  const entries = [{ type: "message", id: "result", message: { role: "toolResult", toolCallId: "tool", content: [{ type: "custom", nested }] } }];
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) < 16 * 1024);
  const items = syncToItems(entries, (prefix) => prefix);
  assert.equal(items[0].historyPreview, true);
  assert.deepEqual(entryDetailTargets(items[0]), ["result"]);
});

test("malformed, oversized and superseded detail responses cannot populate the viewer", async () => {
  for (const result of [
    { sessionId: "other", runtimeId: "r", entryId: "entry", text: "wrong scope", nextCursor: null },
    { sessionId: "s", runtimeId: "r", entryId: "other", text: "wrong entry", nextCursor: null },
    { sessionId: "s", runtimeId: "r", entryId: "entry", text: "x".repeat(70_000), nextCursor: null },
    { sessionId: "s", runtimeId: "r", entryId: "entry", text: "text", nextCursor: -1 },
  ]) {
    const state = store();
    state.send = async () => result;
    await state.loadEntryDetail("entry");
    assert.equal(state.entryDetail?.text, "");
    assert.ok(state.entryDetailError);
    assert.equal(state.entryDetailLoading, false);
  }
  const state = store();
  const resolvers: Array<(value: unknown) => void> = [];
  state.send = () => new Promise((resolve) => resolvers.push(resolve));
  const first = state.loadEntryDetail("first");
  const second = state.loadEntryDetail("second");
  resolvers[1]({ sessionId: "s", runtimeId: "r", entryId: "second", text: "new", nextCursor: null });
  await second;
  resolvers[0]({ sessionId: "s", runtimeId: "r", entryId: "first", text: "old", nextCursor: null });
  await first;
  assert.equal(state.entryDetail?.text, "new");
});

function store() {
  let state: PiWebUiStore;
  const set = ((patch: Partial<PiWebUiStore> | ((s: PiWebUiStore) => Partial<PiWebUiStore>)) => Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never;
  const get = (() => state) as never;
  state = { ...createSessionSlice(set, get, {} as never), ...createWorkspaceSlice(set, get, {} as never),
    ...createConnectionSlice(set, get, {} as never) } as PiWebUiStore;
  Object.assign(state, { sessionId: "s", runtimeId: "r", connection: "connected", requestGitStatusRefresh() {} });
  return state;
}

test("artifact side caches follow retained rows during long tool bursts", () => {
  const state = store();
  for (let i = 0; i < 250; i++) {
    const args = { path: `file-${i}.md` };
    state.applyToolExecutionStart({ type: "tool_execution_start", toolCallId: `t-${i}`, toolName: "write", args });
    state.applyToolExecutionEnd({ type: "tool_execution_end", toolCallId: `t-${i}`, toolName: "write", args, result: "done" });
  }
  assert.ok(state.artifacts.length <= 200);
  assert.ok(!state.artifacts.some((artifact) => artifact.path === "file-0.md"));
  state.mergeArtifactsFromToolEvent({ type: "tool_execution_end", toolName: "write", args: { path: "outside.md" } });
  assert.ok(!state.artifacts.some((artifact) => artifact.path === "outside.md"));
});

test("detail is cleared on disconnect, branch/date changes and explicit close; stale replies stay ignored", async () => {
  for (const change of ["disconnect", "branch", "date", "close"]) {
    const state = store();
    let resolve!: (value: unknown) => void;
    state.send = () => new Promise((r) => { resolve = r; });
    const pending = state.loadEntryDetail("entry");
    const oldResolve = resolve;
    if (change === "disconnect") state.setConnection("disconnected");
    if (change === "branch") state.applyStateSync({ sessionId: "s", runtimeId: "r", leafId: "new", entries: [] });
    if (change === "date") void state.loadHistory({ from: 1, to: 2 });
    if (change === "close") state.closeEntryDetail();
    assert.equal(state.entryDetail, null, change);
    oldResolve({ sessionId: "s", runtimeId: "r", entryId: "entry", text: "stale", nextCursor: null });
    await pending;
    assert.equal(state.entryDetail, null, change);
  }
});
