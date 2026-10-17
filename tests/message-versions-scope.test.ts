import assert from "node:assert/strict";
import test from "node:test";
import { loadMessageVersionHistory, messageVersionsReadIsCurrent } from "../src/web/src/core/message-versions-scope.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { ChatItem } from "../src/web/src/core/types.ts";

test("switching from an older branch page resets its cursor and fences late old-page completion", async () => {
  let state: ReturnType<typeof createSessionSlice> & { send: (method: string, params?: unknown) => Promise<unknown> };
  state = createSessionSlice(
    ((patch: object | ((s: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  const replies: Array<(value: unknown) => void> = [];
  const reads: Array<{ method: string; params: unknown }> = [];
  Object.assign(state, {
    connection: "connected",
    sessionId: "s",
    runtimeId: "r",
    requestGitStatusRefresh() {},
    send: (method: string, params: unknown) => {
      reads.push({ method, params });
      return new Promise((resolve) => replies.push(resolve));
    },
  });
  const range = { from: 1, to: 10 };
  const abandoned = state.loadHistory(range, "old-branch-only-entry");
  const switched = loadMessageVersionHistory({ ...range, before: "old-branch-only-entry" }, state, () => true);
  assert.equal(state.historyBefore, null);
  assert.deepEqual(reads[1], { method: "get_history", params: { ...range, sessionId: "s", runtimeId: "r" } });
  const snapshot = (text: string) => ({
    sessionId: "s",
    runtimeId: "r",
    leafId: text,
    treeNodes: [],
    history: { ...range, total: 1, returned: 1, nextBefore: null, treeLimited: false, truncatedEntries: 0 },
    entries: [{ id: text, type: "message", message: { role: "assistant", content: text } }],
  });
  replies[1](snapshot("new-version"));
  await switched;
  replies[0](snapshot("old-abandoned-page"));
  await abandoned;
  assert.equal(state.items[0]?.kind === "message" && state.items[0].text, "new-version");
  await loadMessageVersionHistory({ ...range, before: null }, state, () => false);
  await loadMessageVersionHistory({ ...range, from: 0, before: null }, state, () => true);
  assert.equal(reads.length, 2, "lost ownership or changed page never triggers a new read");
});

test("an unknown old-branch cursor after reconnect reloads the current branch", async () => {
  let state: ReturnType<typeof createSessionSlice> & { send: (method: string, params?: unknown) => Promise<unknown> };
  state = createSessionSlice(
    ((patch: object | ((s: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  const replies: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const reads: Array<{ method: string; params: unknown }> = [];
  Object.assign(state, {
    connection: "connected",
    sessionId: "s",
    runtimeId: "r",
    historyRange: { from: 1, to: 10 },
    historyBefore: "old-branch-cursor",
    leafId: "old-leaf",
    items: [{ kind: "message", role: "assistant", id: "old", entryId: "old", text: "old page" }],
    requestGitStatusRefresh() {},
    send: (method: string, params: unknown) => {
      reads.push({ method, params });
      return new Promise((resolve, reject) => replies.push({ resolve, reject }));
    },
  });

  state.applyStateSync({
    sessionId: "s",
    runtimeId: "r",
    leafId: "new-leaf",
    treeNodes: [],
    history: {
      from: 1,
      to: 10,
      total: 101,
      returned: 100,
      nextBefore: "old-branch-cursor",
      treeLimited: false,
      truncatedEntries: 0,
    },
    entries: [{ id: "new-leaf", type: "message", message: { role: "assistant", content: "reconnect snapshot" } }],
  });
  assert.deepEqual(reads[0], {
    method: "get_history",
    params: { from: 1, to: 10, before: "old-branch-cursor", sessionId: "s", runtimeId: "r" },
  });
  replies[0].reject(new Error("Unknown history cursor for this date range"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads[1], {
    method: "get_history",
    params: { from: 1, to: 10, sessionId: "s", runtimeId: "r" },
  });

  replies[1].resolve({
    sessionId: "s",
    runtimeId: "r",
    leafId: "new-leaf",
    treeNodes: [],
    entries: [
      { id: "new-leaf", type: "message", message: { role: "assistant", content: "current branch latest page" } },
    ],
    history: { from: 1, to: 10, total: 1, returned: 1, nextBefore: null, treeLimited: false, truncatedEntries: 0 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.historyBefore, null);
  assert.equal(state.historyError, null);
  assert.equal(state.items[0]?.kind === "message" && state.items[0].text, "current branch latest page");
});

test("a valid old-page cursor survives a reconnect snapshot on a growing branch", async () => {
  let state: ReturnType<typeof createSessionSlice> & { send: (method: string, params?: unknown) => Promise<unknown> };
  state = createSessionSlice(
    ((patch: object | ((s: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  let resolveRead!: (value: unknown) => void;
  const reads: Array<{ method: string; params: unknown }> = [];
  Object.assign(state, {
    connection: "connected",
    sessionId: "s",
    runtimeId: "r",
    historyRange: { from: 1, to: 10 },
    historyBefore: "valid-old-page-cursor",
    leafId: "old-leaf",
    items: [{ kind: "message", role: "assistant", id: "old", entryId: "old", text: "selected old page" }],
    requestGitStatusRefresh() {},
    send: (method: string, params: unknown) => {
      reads.push({ method, params });
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    },
  });

  state.applyStateSync({
    sessionId: "s",
    runtimeId: "r",
    leafId: "appended-leaf",
    treeNodes: [],
    history: {
      from: 1,
      to: 10,
      total: 120,
      returned: 100,
      nextBefore: "valid-old-page-cursor",
      treeLimited: false,
      truncatedEntries: 0,
    },
    entries: [{ id: "appended-leaf", type: "message", message: { role: "assistant", content: "new append" } }],
  });
  assert.deepEqual(reads[0], {
    method: "get_history",
    params: { from: 1, to: 10, before: "valid-old-page-cursor", sessionId: "s", runtimeId: "r" },
  });
  resolveRead({
    sessionId: "s",
    runtimeId: "r",
    leafId: "appended-leaf",
    treeNodes: [],
    entries: [{ id: "older-entry", type: "message", message: { role: "assistant", content: "selected old page" } }],
    history: {
      from: 1,
      to: 10,
      total: 120,
      returned: 100,
      nextBefore: "even-older-cursor",
      treeLimited: false,
      truncatedEntries: 0,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 1, "valid append cursors do not trigger a latest-page reload");
  assert.equal(state.historyBefore, "valid-old-page-cursor");
  assert.equal(state.historyError, null);
  assert.equal(state.items[0]?.kind === "message" && state.items[0].text, "selected old page");

  state.send = (method, params) => {
    reads.push({ method, params });
    return Promise.reject(new Error("synthetic network failure"));
  };
  await state.loadHistory({ from: 1, to: 10 }, "valid-old-page-cursor");
  assert.equal(reads.length, 2, "network errors must not trigger cursor fallback");
  assert.equal(state.historyBefore, "valid-old-page-cursor");
  assert.equal(state.historyError, "synthetic network failure");
});

const source = {
  sessionId: "s",
  runtimeId: "r",
  sourceLeafId: "leaf",
  from: 1,
  to: 2,
  before: null,
  entryIds: ["u", "a"],
};
const items: ChatItem[] = [
  { kind: "message", role: "user", id: "ui-u", entryId: "u", text: "question" },
  { kind: "message", role: "assistant", id: "ui-a", entryId: "a", text: "answer" },
];
const current = {
  connection: "connected",
  sessionId: "s",
  runtimeId: "r",
  leafId: "leaf",
  chatStatus: "ready",
  sessionActionPending: false,
  historyLoading: false,
  conversationSyncing: false,
  historyRange: { from: 1, to: 2 },
  historyBefore: null,
  items,
};

test("version metadata cannot complete into another scope, page, live state or saved-message set", () => {
  assert.equal(messageVersionsReadIsCurrent(source, current), true);
  for (const patch of [
    { connection: "disconnected" },
    { sessionId: "other" },
    { runtimeId: "reload" },
    { leafId: "new-leaf" },
    { chatStatus: "streaming" },
    { sessionActionPending: true },
    { historyLoading: true },
    { conversationSyncing: true },
    { historyRange: { from: 0, to: 2 } },
    { historyRange: { from: 1, to: 3 } },
    { historyBefore: "older-page" },
    { items: items.slice(0, 1) },
    { items: [...items].reverse() },
  ])
    assert.equal(messageVersionsReadIsCurrent(source, { ...current, ...patch }), false);
  assert.equal(
    messageVersionsReadIsCurrent(source, {
      ...current,
      items: [...items, { kind: "system", id: "notice", text: { key: "Copy" } }],
    }),
    true,
    "unrelated notices do not invalidate saved-message metadata",
  );
});
