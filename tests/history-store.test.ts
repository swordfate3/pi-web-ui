import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchPiEvent } from "../src/web/src/core/store/event-dispatch.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { StateSyncPayload } from "../src/web/src/core/types.ts";

const range = { from: 1_700_000_000_000, to: 1_700_086_400_000 };
function snapshot(text: string, sessionId = "s", runtimeId = "r"): StateSyncPayload {
  return {
    sessionId,
    runtimeId,
    entries: [{ id: text, type: "message", message: { role: "user", content: text } }],
    treeNodes: [],
    history: { ...range, total: 101, returned: 1, nextBefore: "cursor", truncatedEntries: 0, treeLimited: true },
  };
}
function store() {
  let state: ReturnType<typeof createSessionSlice> & { send: (method: string, params?: unknown) => Promise<unknown> };
  state = createSessionSlice(
    ((patch: object | ((state: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  Object.assign(state, {
    requestGitStatusRefresh() {},
    mergeArtifactsFromToolEvent() {},
    send: async () => snapshot("loaded"),
    connection: "connected",
    sessionId: "s",
    runtimeId: "r",
  });
  return state;
}

test("transport omission is scoped, deduplicates notices, and only terminal events schedule bounded recovery", () => {
  const state = store();
  const calls: unknown[] = [];
  state.requestConversationSync = (options) => {
    calls.push(options);
  };
  const payload = { sessionId: "s", runtimeId: "r", sourceEvent: "message_update", bytes: 5 * 1024 * 1024 };
  const dispatch = (value: Record<string, unknown>) =>
    dispatchPiEvent(state as never, { type: "event", event: "transport_omitted", payload: value });
  for (const bad of [
    { ...payload, sessionId: "old" },
    { ...payload, runtimeId: "old" },
    { ...payload, bytes: 1 },
    { ...payload, sourceEvent: "extension_ui_request" },
  ])
    dispatch(bad);
  assert.equal(state.transportNotice, null);
  dispatch(payload);
  dispatch(payload);
  assert.ok(state.transportNotice);
  assert.equal(calls.length, 0);
  assert.equal(state.items.length, 0, "notices are not injected as fake Pi messages");
  dispatch({ ...payload, sourceEvent: "tool_execution_end" });
  assert.deepEqual(calls, [{ debounce: true }]);
  state.applyStateSync({ sessionId: "s", runtimeId: "r", entries: [], treeNodes: [] });
  assert.ok(state.transportNotice, "same scope history refresh retains the explicit notice");
  state.dismissTransportNotice();
  assert.equal(state.transportNotice, null);
  dispatch(payload);
  state.applyStateSync({ sessionId: "new", runtimeId: "r2", entries: [], treeNodes: [] });
  assert.equal(state.transportNotice, null);
});

test("burst terminal omissions coalesce and a failed bounded recovery stays visible without automatic retry", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const state = store();
  let calls = 0;
  state.send = async () => {
    calls++;
    throw new Error("synthetic bounded recovery unavailable");
  };
  for (let i = 0; i < 20; i++)
    state.applyTransportOmitted({
      sessionId: "s",
      runtimeId: "r",
      sourceEvent: "tool_execution_end",
      bytes: 5 * 1024 * 1024,
    });
  assert.ok(state.transportNotice);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(calls, 1);
  assert.equal(state.conversationSyncError, "synthetic bounded recovery unavailable");
  assert.equal(state.conversationSyncing, false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(calls, 1);
  assert.ok(state.transportNotice);
  state.clearConversationTimers();
});

test("history requests use numeric selected dates and page changes replace, never append", async () => {
  const state = store();
  const requests: unknown[] = [];
  state.send = async (method, params) => {
    requests.push({ method, params });
    return snapshot("loaded");
  };
  await state.loadHistory(range);
  assert.deepEqual(requests[0], { method: "get_history", params: { ...range, sessionId: "s", runtimeId: "r" } });
  assert.equal(state.items.length, 1);
  await state.loadHistory(range, "cursor");
  assert.equal(state.items.length, 1);
  assert.equal(state.historyBefore, "cursor");
});

test("background sync preserves range, cursor and identity fences", async () => {
  const state = store();
  await state.loadHistory(range, "cursor");
  const requests: unknown[] = [];
  state.send = async (method, params) => {
    requests.push({ method, params });
    return snapshot("synced");
  };
  await state.requestConversationSync();
  assert.deepEqual(requests[0], {
    method: "sync_request",
    params: { ...range, before: "cursor", sessionId: "s", runtimeId: "r" },
  });
  assert.equal(state.historyBefore, "cursor");
  assert.equal(state.items.length, 1);
});

test("late history replies cannot overwrite a new session or a newer date request", async () => {
  const state = store();
  let resolve!: (value: unknown) => void;
  state.send = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = state.loadHistory(range);
  state.applyStateSync({ sessionId: "new", runtimeId: "new-r", entries: [] });
  resolve(snapshot("stale"));
  await pending;
  assert.equal(state.sessionId, "new");
  assert.deepEqual(state.items, []);
  assert.equal(state.historyLoading, false);

  const next = store();
  let first!: (value: unknown) => void;
  next.send = () =>
    new Promise((r) => {
      first = r;
    });
  const oldRequest = next.loadHistory(range);
  next.send = async () => ({ ...snapshot("newer"), history: { ...snapshot("").history!, from: range.from - 1000 } });
  await next.loadHistory({ ...range, from: range.from - 1000 });
  first(snapshot("old"));
  await oldRequest;
  assert.equal(next.items[0]?.kind === "message" && next.items[0].text, "newer");
});

test("late sync replies cannot overwrite a runtime replacement or a date transition", async () => {
  const state = store();
  await state.loadHistory(range);
  let resolve!: (value: unknown) => void;
  state.send = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = state.requestConversationSync();
  const resolveOld = resolve;
  state.send = async () => ({ ...snapshot("", "s", "new-r"), entries: [] });
  state.applyStateSync({ sessionId: "s", runtimeId: "new-r", entries: [] });
  resolveOld(snapshot("stale"));
  await pending;
  assert.equal(state.runtimeId, "new-r");
  assert.deepEqual(state.items, []);
  state.applyMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "old runtime" },
  });
  assert.deepEqual(state.items, [], "a ready replacement runtime must not acquire a streaming placeholder");
});

test("live streaming and tool events do not inject today's content into past dates or older pages", async () => {
  const state = store();
  await state.loadHistory(range);
  const before = JSON.stringify(state.items);
  state.applyAgentStart();
  state.applyMessageUpdate({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "today" } });
  state.applyMessageStart({ type: "message_start", message: { role: "user", content: "today" } });
  state.applyToolExecutionStart({ type: "tool_execution_start", toolCallId: "tool", args: "today" });
  dispatchPiEvent(state as never, { type: "event", event: "auto_compaction_start", payload: {} });
  assert.equal(JSON.stringify(state.items), before);
  const now = Date.now();
  await state.loadHistory({ from: now - 1000, to: now + 1000 }, "cursor");
  const older = JSON.stringify(state.items);
  state.applyAgentStart();
  state.applyMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "today" },
  });
  state.applyMessageStart({ type: "message_start", message: { role: "user", content: "today" } });
  assert.equal(JSON.stringify(state.items), older);
});

test("legacy snapshots without history remain renderable and live streaming works on the current range", () => {
  const state = store();
  state.applyStateSync({
    sessionId: "s",
    runtimeId: "r",
    entries: [{ type: "message", message: { role: "user", content: "legacy" } }],
  });
  assert.equal(state.items.length, 1);
  state.applyMessageStart({ type: "message_start", message: { role: "user", content: "live" } });
  assert.equal(state.items.length, 2);
});

test("reconnect bootstrap cannot replace a selected old range and reloads selected dates", async () => {
  const state = store();
  await state.loadHistory(range);
  const calls: unknown[] = [];
  state.send = async (method, params) => {
    calls.push({ method, params });
    return snapshot("restored");
  };
  state.applyStateSync({ ...snapshot("bootstrap"), history: { ...snapshot("").history!, from: 0, to: 100 } });
  await Promise.resolve();
  assert.ok(!state.items.some((item) => item.kind === "message" && item.text === "bootstrap"));
  assert.deepEqual(state.historyRange, range);
  assert.equal(calls.length, 1);
});

test("an old sync in flight cannot replace a newer selected range", async () => {
  const state = store();
  await state.loadHistory(range);
  let resolve!: (value: unknown) => void;
  state.send = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = state.requestConversationSync();
  state.send = async () => snapshot("selected");
  await state.loadHistory({ ...range, from: range.from - 1000 });
  resolve(snapshot("late sync"));
  await pending;
  assert.equal(state.items[0]?.kind === "message" && state.items[0].text, "selected");
});

test("failed date loads cannot leave the previous page mislabeled as the selected dates", async () => {
  const state = store();
  await state.loadHistory(range);
  state.send = async () => {
    throw new Error("load failed");
  };
  await state.loadHistory({ from: range.from - 1000, to: range.from });
  assert.deepEqual(state.items, []);
  assert.equal(state.history, null);
  assert.equal(state.historyLoading, false);
  assert.ok(state.historyError);
});

test("returning to live dates mid-stream resumes deltas when Pi has persisted only the user", async () => {
  const state = store();
  await state.loadHistory(range);
  const now = Date.now();
  const liveRange = { from: now - 1000, to: now + 1000 };
  state.send = async () => ({
    ...snapshot("unused"),
    isStreaming: true,
    history: { ...snapshot("").history!, ...liveRange },
    entries: [{ type: "message", id: "persisted-user", message: { role: "user", content: "question" } }],
  });
  await state.loadHistory(liveRange);
  state.applyMessageUpdate({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " done" } });
  assert.equal(state.items[1]?.kind === "message" && state.items[1].text, " done");
  state.applyMessageEnd({ type: "message_end", message: { role: "assistant", content: "complete answer done" } });
  assert.equal(state.items[1]?.kind === "message" && state.items[1].text, "complete answer done");
  assert.equal(state.items[1]?.kind === "message" && state.items[1].streaming, false);
});

test("a streaming snapshot never treats the previous completed assistant as the current stream", async () => {
  const state = store();
  const now = Date.now();
  const liveRange = { from: now - 1000, to: now + 1000 };
  state.send = async () => ({
    ...snapshot("unused"),
    isStreaming: true,
    history: { ...snapshot("").history!, ...liveRange },
    entries: [{ type: "message", id: "completed", message: { role: "assistant", content: "previous answer" } }],
  });
  await state.loadHistory(liveRange);
  state.applyMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "new thought" },
  });
  state.applyMessageUpdate({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "new answer" },
  });
  assert.equal(state.items[0]?.kind === "message" && state.items[0].text, "previous answer");
  assert.ok(state.items[0]?.kind === "message" && !state.items[0].streaming);
  assert.equal(state.items[1]?.kind === "message" && state.items[1].text, "new answer");
  assert.equal(state.items[1]?.kind === "message" && state.items[1].reasoning, "new thought");
});

test("legacy push snapshots cannot replace an explicitly selected history page", async () => {
  const state = store();
  await state.loadHistory(range);
  state.send = async () => snapshot("selected");
  state.applyStateSync({ sessionId: "s", runtimeId: "r", entries: snapshot("legacy-unfiltered").entries });
  await Promise.resolve();
  assert.ok(!state.items.some((item) => item.kind === "message" && item.text === "legacy-unfiltered"));
  assert.deepEqual(state.historyRange, range);
});

test("a new-session UTC bootstrap is replaced with the browser local calendar range", async () => {
  const state = store();
  const localRange = state.historyRange;
  const requests: unknown[] = [];
  state.send = async (method, params) => {
    requests.push({ method, params });
    return { ...snapshot("local", "new", "new-r"), history: { ...snapshot("").history!, ...localRange } };
  };
  state.applyStateSync(snapshot("utc", "new", "new-r"));
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.deepEqual(state.historyRange, localRange);
  assert.ok(!state.items.some((item) => item.kind === "message" && item.text === "utc"));
});

test("a partial legacy snapshot cannot invalidate a runtime-fenced history request", async () => {
  const state = store();
  const replies: Array<(value: unknown) => void> = [];
  state.send = () => new Promise((resolve) => replies.push(resolve));
  const pending = state.loadHistory(range);
  state.applyStateSync({ runtimeId: "unidentified-runtime", entries: [] });
  assert.equal(state.runtimeId, "r");
  assert.equal(replies.length, 1);
  replies[0](snapshot("valid"));
  await pending;
  assert.equal(state.items[0]?.kind === "message" && state.items[0].text, "valid");
});
