import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSessionHistory } from "../extensions/session-history.ts";
import { entryDetailTargets } from "../src/web/src/core/conversation-window.ts";
import { dispatchPiEvent } from "../src/web/src/core/store/event-dispatch.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { SessionEntry, StateSyncPayload } from "../src/web/src/core/types.ts";

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

function toolEntries(count: number, calls = 8): SessionEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "message",
    id: `entry-${i}`,
    timestamp: new Date(range.from + i).toISOString(),
    message: {
      role: "assistant",
      content: Array.from({ length: calls }, (_, j) => ({
        type: "toolCall",
        id: `call-${i}-${j}`,
        name: "read",
        arguments: { path: `${i}-${j}.txt` },
      })),
    },
  }));
}

function historyStore(entries: SessionEntry[]) {
  const state = store();
  const requests: Array<{ method: string; params: unknown }> = [];
  state.send = async (method, params) => {
    requests.push({ method, params });
    assert.equal(method, "get_history");
    assert.deepEqual(params, {
      ...range,
      sessionId: "s",
      runtimeId: "r",
      ...(state.historyBefore ? { before: state.historyBefore } : {}),
    });
    return { ...selectSessionHistory(entries, [], params as typeof range), sessionId: "s", runtimeId: "r" };
  };
  return { state, requests };
}

test("snapshot row eviction exposes an exact older cursor and recovers every entry without duplicates", async () => {
  for (const count of [40, 80]) {
    const entries = toolEntries(count);
    const original = JSON.stringify(entries);
    const { state, requests } = historyStore(entries);
    await state.loadHistory(range);
    assert.equal(requests.length, 1, "no automatic older-page fetch");
    assert.equal(state.items.length, 200);
    assert.equal(state.items[0].entryId, `entry-${count - 25}`);
    assert.equal(state.history?.nextBefore, `entry-${count - 25}`, "cursor must not skip browser-evicted entries");
    assert.equal(state.history?.returned, 25);
    const seen = new Set<string>();
    let pages = 0;
    for (;;) {
      assert.ok(++pages <= 4, "older pages must make progress");
      const ids = new Set(
        state.items.map((item) => {
          assert.ok(item.entryId);
          return item.entryId;
        }),
      );
      assert.equal(state.history?.returned, ids.size);
      assert.equal(state.history?.total, count);
      for (const id of ids) {
        assert.ok(!seen.has(id), `duplicate ${id}`);
        seen.add(id);
      }
      assert.equal(
        state.items.some((item) => item.historyPreview),
        false,
        "complete boundary entry is not a preview",
      );
      const before = state.history?.nextBefore;
      if (!before) break;
      assert.notEqual(before, state.historyBefore);
      await state.loadHistory(range, before);
    }
    assert.equal(seen.size, count);
    assert.equal(JSON.stringify(entries), original);
  }
});

test("partial tool entry boundary is an explicit full-entry detail target, not an automatic fetch", async () => {
  const entries = toolEntries(40, 9);
  const original = JSON.stringify(entries);
  const { state, requests } = historyStore(entries);
  await state.loadHistory(range);
  assert.equal(state.items[0].id, "call-17-7");
  assert.equal(state.items[0].entryId, "entry-17");
  assert.equal(state.items[0].historyPreview, true);
  assert.deepEqual(entryDetailTargets(state.items[0]), ["entry-17"]);
  assert.deepEqual(state.items[0].relatedEntryIds, ["entry-17"]);
  assert.equal(state.history?.returned, 23);
  assert.equal(state.history?.truncatedEntries, 1);
  assert.equal(state.history?.nextBefore, "entry-17");
  assert.equal(requests.length, 1);
  state.send = async (method, params) => {
    assert.equal(method, "get_entry_detail");
    assert.deepEqual(params, { sessionId: "s", runtimeId: "r", entryId: "entry-17" });
    return { sessionId: "s", runtimeId: "r", entryId: "entry-17", text: "all nine tool calls", nextCursor: null };
  };
  await state.loadEntryDetail(entryDetailTargets(state.items[0])[0]);
  assert.equal(state.entryDetail?.text, "all nine tool calls");
  assert.equal(JSON.stringify(entries), original);
});

test("byte-driven snapshot eviction also preserves traversable history and retained counts", async () => {
  let nested: unknown = Array.from({ length: 400 }, () => ({ value: "x" }));
  for (let i = 0; i < 20; i++) nested = { nested };
  const entries: SessionEntry[] = Array.from({ length: 30 }, (_, i) => ({
    type: "message",
    id: `result-${i}`,
    timestamp: new Date(range.from + i).toISOString(),
    message: { role: "toolResult", toolCallId: `call-${i}`, content: [{ type: "custom", nested }] },
  }));
  assert.equal(selectSessionHistory(entries, [], range).entries.length, 30);
  const { state } = historyStore(entries);
  await state.loadHistory(range);
  assert.ok(state.items.length < 30);
  assert.equal(state.history?.nextBefore, state.items[0].entryId);
  const seen = new Set<string>();
  let pages = 0;
  for (;;) {
    assert.ok(++pages <= 4);
    assert.ok(Buffer.byteLength(JSON.stringify(state.items)) <= 512 * 1024);
    assert.equal(state.history?.returned, state.items.length);
    assert.equal(state.history?.truncatedEntries, state.items.length);
    for (const item of state.items) {
      assert.ok(item.entryId);
      assert.ok(!seen.has(item.entryId));
      seen.add(item.entryId);
    }
    if (!state.history?.nextBefore) break;
    await state.loadHistory(range, state.history.nextBefore);
  }
  assert.equal(seen.size, 30);
});

test("a partial single entry keeps its existing older cursor and cannot stall pagination", async () => {
  // Compact tool calls fit the server entry budget but expand beyond 200 UI rows.
  const entries = toolEntries(1, 220).map((entry) => ({
    ...entry,
    message: { role: "assistant", content: Array.from({ length: 220 }, (_, i) => ({ type: "toolCall", id: `t${i}` })) },
  }));
  const { state, requests } = historyStore(entries);
  await state.loadHistory(range);
  assert.equal(state.items.length, 200);
  assert.equal(state.items[0].historyPreview, true);
  assert.deepEqual(entryDetailTargets(state.items[0]), ["entry-0"]);
  assert.equal(state.history?.nextBefore, null);
  assert.equal(state.history?.returned, 1);
  assert.equal(state.history?.truncatedEntries, 1);
  assert.equal(requests.length, 1);
  const page = selectSessionHistory(entries, [], range);
  state.applyStateSync(
    {
      ...page,
      sessionId: "s",
      runtimeId: "r",
      history: { ...page.history, nextBefore: "older-exact-id", total: 2 },
    } as StateSyncPayload,
    { requested: true },
  );
  assert.equal(state.history?.nextBefore, "older-exact-id");
  assert.equal(state.items[0].historyPreview, true);
});

test("partial invocation keeps omitted result entries inspectable without changing tool associations", async () => {
  const entries = toolEntries(20, 11).flatMap((entry, i): SessionEntry[] => [
    { ...entry, timestamp: new Date(range.from + 2 * i).toISOString() },
    {
      type: "message",
      id: `result-${i}`,
      timestamp: new Date(range.from + 2 * i + 1).toISOString(),
      message: { role: "toolResult", toolCallId: `call-${i}-0`, content: `output-${i}` },
    },
  ]);
  const original = JSON.stringify(entries);
  const { state, requests } = historyStore(entries);
  await state.loadHistory(range);
  const boundary = state.items[0];
  assert.equal(boundary.id, "call-1-9");
  assert.equal(boundary.entryId, "entry-1");
  assert.deepEqual(boundary.relatedEntryIds, ["entry-1"], "do not associate tool 0's result with tool 9");
  assert.deepEqual(
    entryDetailTargets(boundary),
    ["entry-1", "result-1"],
    "result-1 is newer than the older-page cursor and needs explicit detail access",
  );
  assert.equal(state.history?.nextBefore, "entry-1");
  assert.equal(state.history?.returned, 38);
  assert.equal(state.history?.truncatedEntries, 2);
  const retainedTool = state.items.find((item) => item.id === "call-2-0");
  assert.ok(retainedTool);
  assert.deepEqual(retainedTool.relatedEntryIds, ["entry-2", "result-2"]);
  assert.equal(retainedTool.kind === "tool" && retainedTool.output, "output-2");
  assert.equal(requests.length, 1);
  assert.ok(state.history?.nextBefore);
  await state.loadHistory(range, state.history.nextBefore);
  assert.equal(state.history?.nextBefore, null);
  assert.equal(state.items.length, 11);
  assert.equal(state.items[0].entryId, "entry-0");
  assert.equal(JSON.stringify(entries), original);
});

test("every live path enforces count, per-item and aggregate retained-content budgets", () => {
  const state = store();
  const check = () => {
    assert.ok(state.items.length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify(state.items)) <= 512 * 1024);
    for (const item of state.items) assert.ok(Buffer.byteLength(JSON.stringify(item)) <= 64 * 1024);
  };
  for (let i = 0; i < 230; i++) {
    state.addSystemMessage(`system-${i}`);
    check();
  }
  state.applyAgentStart();
  for (let i = 0; i < 100; i++) {
    state.applyMessageUpdate({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "😀\u0001".repeat(2000) },
    });
    check();
  }
  assert.equal(state.items.at(-1)?.historyPreview, true);
  state.applyMessageEnd({ type: "message_end", message: { role: "assistant", content: "large".repeat(100_000) } });
  check();
  for (let i = 0; i < 230; i++) {
    state.applyToolExecutionStart({
      type: "tool_execution_start",
      toolCallId: `tool-${i}`,
      toolName: "write",
      args: { content: "x".repeat(100_000) },
    });
    state.applyToolExecutionUpdate({
      type: "tool_execution_update",
      toolCallId: `tool-${i}`,
      partialResult: { content: [{ type: "text", text: "y".repeat(100_000) }] },
    });
    state.applyToolExecutionEnd({ type: "tool_execution_end", toolCallId: `tool-${i}`, result: "z".repeat(100_000) });
    check();
    assert.equal(state.items.at(-1)?.id, `tool-${i}`);
    assert.equal(state.items.at(-1)?.historyPreview, true);
  }
});

test("detail viewer holds one chunk, sends exact scope, and ignores replies after lifecycle changes", async () => {
  const state = store();
  const requests: unknown[] = [];
  state.send = async (method, params) => {
    requests.push({ method, params });
    return {
      sessionId: "s",
      runtimeId: "r",
      entryId: "entry",
      text: requests.length === 1 ? "first" : "second",
      nextCursor: "opaque",
    };
  };
  await state.loadEntryDetail("entry");
  await state.loadEntryDetail("entry", "opaque");
  assert.deepEqual(requests[1], {
    method: "get_entry_detail",
    params: { sessionId: "s", runtimeId: "r", entryId: "entry", cursor: "opaque" },
  });
  assert.equal(state.entryDetail?.text, "second");
  let resolve!: (value: unknown) => void;
  state.send = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = state.loadEntryDetail("entry", "opaque");
  state.applyStateSync({ sessionId: "new", runtimeId: "new-r", entries: [] });
  assert.equal(state.entryDetail, null);
  resolve({ sessionId: "s", runtimeId: "r", entryId: "entry", text: "stale", nextCursor: null });
  await pending;
  assert.equal(state.entryDetail, null);
});

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
