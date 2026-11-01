import assert from "node:assert/strict";
import test from "node:test";
import { selectSessionHistory } from "../extensions/session-history.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { SessionEntry, StateSyncPayload } from "../src/web/src/core/types.ts";

const now = Date.now();
const range = { from: now - 100_000, to: now + 100_000 };
const entry = (i: number): SessionEntry & { id: string } => ({
  id: `entry-${i}`,
  type: "message",
  timestamp: new Date(now - 1000 + i).toISOString(),
  message: { role: "assistant", content: `ANSWER_${i}` },
});

function fixture(count = 125) {
  const entries = Array.from({ length: count }, (_, i) => entry(i));
  const calls: Record<string, unknown>[] = [];
  let state: ReturnType<typeof createSessionSlice> & {
    connection: string;
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
  state = createSessionSlice(
    ((patch: object | ((s: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  Object.assign(state, {
    connection: "connected",
    sessionId: "s",
    runtimeId: "r",
    requestGitStatusRefresh() {},
    mergeArtifactsFromToolEvent() {},
    send: async (_method: string, params: Record<string, unknown>) => {
      calls.push(params);
      return {
        ...selectSessionHistory(entries, [], params as never),
        sessionId: "s",
        runtimeId: "r",
        leafId: entries.at(-1)?.id,
      };
    },
  });
  const texts = () => state.items.flatMap((row) => (row.kind === "message" ? [row.text] : []));
  return { state, entries, calls, texts };
}

test("history can return one page at a time without keeping old message bodies", async () => {
  const { state, texts } = fixture();
  await state.loadHistory(range);
  const latest = texts();
  assert.equal(typeof state.loadOlderHistory, "function");
  await state.loadOlderHistory();
  const middle = texts();
  assert.equal(middle[0], "ANSWER_45");
  assert.equal(state.historyPageIndex, 1);
  await state.loadOlderHistory();
  assert.equal(texts()[0], "ANSWER_5");
  await state.loadNewerHistory();
  assert.deepEqual(texts(), middle);
  await state.loadNewerHistory();
  assert.deepEqual(texts(), latest);
  assert.equal(state.historyPageIndex, 0);
  assert.ok(state.items.length <= 40);
  assert.ok(state.historyTrail.every((cursor) => cursor === null || typeof cursor === "string"));
});

test("append-only chat does not shift a page while returning toward the newest page", async () => {
  const { state, entries, texts } = fixture();
  await state.loadHistory(range);
  const latest = texts();
  assert.equal(typeof state.loadOlderHistory, "function");
  await state.loadOlderHistory();
  entries.push(...Array.from({ length: 10 }, (_, i) => entry(125 + i)));
  await state.loadNewerHistory();
  assert.deepEqual(texts(), latest, "new replies must not make previously viewed results unreachable");
  assert.equal(state.isHistoryLive(), false, "the anchored latest page is still a historical view");
  await state.returnToLatestHistory();
  assert.equal(texts().at(-1), "ANSWER_134");
  assert.equal(state.isHistoryLive(), true);
  assert.equal(state.historyAnchor, null);
});

test("pushed snapshots and live turns preserve historical rows and advertise new replies", async () => {
  const { state, entries, calls } = fixture();
  await state.loadHistory(range);
  assert.equal(typeof state.loadOlderHistory, "function");
  await state.loadOlderHistory();
  const rows = state.items;
  const cursor = state.historyBefore;
  const count = calls.length;
  state.applyMessageStart({ type: "message_start", message: { role: "assistant", content: "new answer" } });
  assert.equal(state.historyHasUpdates, true);
  entries.push(entry(125));
  state.applyStateSync({
    ...selectSessionHistory(entries, [], range),
    sessionId: "s",
    runtimeId: "r",
    leafId: "entry-125",
  } as StateSyncPayload);
  await Promise.resolve();
  assert.equal(state.items, rows, "a background push must not replace/rekey the reader's rows");
  assert.equal(state.historyBefore, cursor);
  assert.equal(calls.length, count, "a background push must not trigger a competing page reload");
  await state.requestConversationSync();
  assert.equal(state.items, rows, "background terminal sync must not replace historical content either");
});

test("failed page navigation keeps the last successfully displayed page and permits retry", async () => {
  const { state, texts } = fixture();
  await state.loadHistory(range);
  const latest = texts();
  const send = state.send;
  state.send = async () => {
    throw new Error("temporary disconnect");
  };
  assert.equal(typeof state.loadOlderHistory, "function");
  await state.loadOlderHistory();
  assert.deepEqual(texts(), latest);
  assert.equal(state.historyPageIndex, 0);
  assert.equal(state.historyBefore, null);
  assert.ok(state.historyError);
  state.send = send;
  await state.loadOlderHistory();
  assert.equal(texts()[0], "ANSWER_45");
});

test("changing session discards all page navigation identities and stale replies", async () => {
  const { state } = fixture();
  await state.loadHistory(range);
  assert.equal(typeof state.loadOlderHistory, "function");
  await state.loadOlderHistory();
  let resolve!: (value: unknown) => void;
  state.send = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = state.loadOlderHistory();
  state.applyStateSync({ sessionId: "other", runtimeId: "other-r", entries: [] });
  resolve({ ...selectSessionHistory([entry(0)], [], range), sessionId: "s", runtimeId: "r" });
  await pending;
  assert.equal(state.sessionId, "other");
  assert.equal(state.historyAnchor, null);
  assert.equal(state.historyPageIndex, 0);
  assert.deepEqual(state.historyTrail, [null]);
  assert.deepEqual(state.items, []);
});

test("history server pins an exact upper entry and rejects missing or invalid anchors", () => {
  const entries = Array.from({ length: 100 }, (_, i) => entry(i));
  const first = selectSessionHistory(entries, [], range);
  assert.equal(first.history.headId, "entry-99");
  assert.ok(first.history.nextBefore);
  const older = selectSessionHistory(entries, [], { ...range, before: first.history.nextBefore, through: "entry-99" });
  entries.push(entry(100));
  const pinned = selectSessionHistory(entries, [], { ...range, through: "entry-99" });
  assert.deepEqual(pinned.entries, first.entries);
  assert.equal(pinned.history.total, 100);
  assert.equal(older.entries.at(-1)?.id, "entry-59");
  assert.throws(() => selectSessionHistory(entries, [], { ...range, through: "missing" }), /anchor/i);
  assert.throws(() => selectSessionHistory(entries, [], { ...range, through: "x".repeat(513) }), /anchor/i);
});

test("live reconnect reconciles a differently ranged bootstrap after offline completion", async () => {
  const { state, entries, texts, calls } = fixture();
  await state.loadHistory(range);
  entries.push(entry(125));
  state.applyStateSync({
    ...selectSessionHistory(entries, [], { from: range.from - 1, to: range.to + 1 }),
    sessionId: "s",
    runtimeId: "r",
    leafId: "entry-125",
  } as StateSyncPayload);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(texts().at(-1), "ANSWER_125");
  assert.equal(calls.length, 2);
  assert.equal(state.historyHasUpdates, false);
});

test("past-date first page survives background sync and agent completion without rekeying", async () => {
  const { state, entries } = fixture();
  const past = { from: now - 200_000, to: now - 1 };
  await state.loadHistory(past);
  const rows = state.items;
  const detail = { sessionId: "s", runtimeId: "r", entryId: "entry-0", text: "reading", nextCursor: null };
  Object.assign(state, { entryDetail: detail });
  entries.push(entry(125));
  await state.requestConversationSync();
  assert.equal(state.items, rows);
  assert.equal(state.entryDetail, detail);
  // Avoid browser-only debounce timers while exercising the terminal event.
  state.requestConversationSync = async () => {};
  state.applyAgentEnd();
  assert.equal(state.items, rows);
});

test("branch rewind discards the retired anchor instead of retaining old rows", async () => {
  const { state, entries, texts } = fixture();
  for (let i = 0; i < entries.length; i++) entries[i].parentId = i ? entries[i - 1].id : null;
  const nodes = entries.map((entry) => ({ entry, parentNodeId: entry.parentId ?? null }));
  await state.loadHistory(range);
  state.applyStateSync(
    {
      ...selectSessionHistory(entries, [], range),
      treeNodes: nodes,
      sessionId: "s",
      runtimeId: "r",
      leafId: "entry-124",
    } as StateSyncPayload,
    { requested: true },
  );
  await state.loadOlderHistory();
  const branch = entries.splice(50);
  state.applyStateSync({
    ...selectSessionHistory(entries, [], range),
    treeNodes: nodes,
    sessionId: "s",
    runtimeId: "r",
    leafId: "entry-49",
  } as StateSyncPayload);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.leafId, "entry-49");
  assert.equal(state.historyAnchor, null);
  assert.equal(state.historyPageIndex, 0);
  assert.equal(texts().at(-1), "ANSWER_49");
  assert.ok(branch.length);
});

test("retired anchors recover from page errors without leaving navigation stuck", async () => {
  const { state, entries, texts } = fixture();
  await state.loadHistory(range);
  await state.loadOlderHistory();
  entries.splice(50);
  await state.loadNewerHistory();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.historyAnchor, null);
  assert.equal(state.historyPageIndex, 0);
  assert.equal(state.historyError, null);
  assert.equal(texts().at(-1), "ANSWER_49");
});

test("a branch replacement with bootstrap dates never displays rows under the wrong selected dates", async () => {
  const { state, entries, texts } = fixture();
  await state.loadHistory(range);
  await state.loadOlderHistory();
  entries.splice(50);
  entries[49].parentId = null;
  let resolve!: (value: unknown) => void;
  state.send = () =>
    new Promise((done) => {
      resolve = done;
    });
  state.applyStateSync({
    ...selectSessionHistory(entries, [], { from: range.from - 1, to: range.to + 1 }),
    sessionId: "s",
    runtimeId: "r",
    leafId: "entry-49",
  } as StateSyncPayload);
  assert.deepEqual(state.items, [], "do not install the differently dated bootstrap page");
  assert.equal(state.leafId, "entry-49");
  assert.deepEqual(state.historyRange, range);
  resolve({ ...selectSessionHistory(entries, [], range), sessionId: "s", runtimeId: "r", leafId: "entry-49" });
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(texts().at(-1), "ANSWER_49");
  assert.equal(state.historyAnchor, null);
});
