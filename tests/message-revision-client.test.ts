import assert from "node:assert/strict";
import test from "node:test";
import { parseMessageRevision } from "../src/web/src/core/message-revision.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { MessageRevisionPreview } from "../src/web/src/core/types.ts";

const preview: MessageRevisionPreview = {
  previewId: "preview-one",
  entryId: "assistant",
  mode: "regenerate",
  userEntryId: "user",
  text: "full original",
  hasImages: true,
  sourceLeafId: "leaf",
  sessionId: "s",
  runtimeId: "r",
};
function store() {
  let state: ReturnType<typeof createSessionSlice> & { send: (method: string, params?: unknown) => Promise<unknown> };
  state = createSessionSlice(
    ((patch: object | ((state: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  Object.assign(state, {
    connection: "connected",
    advancedFeatures: true,
    chatStatus: "ready",
    sessionId: "s",
    runtimeId: "r",
    leafId: "leaf",
    requestGitStatusRefresh() {},
    send: async (method: string) =>
      method === "sync_request"
        ? { sessionId: "s", runtimeId: "r", leafId: "leaf", entries: [], treeNodes: [], isStreaming: false }
        : preview,
  });
  return state;
}

test("revision preview rejects malformed or foreign full-text responses", () => {
  assert.deepEqual(parseMessageRevision(preview, "assistant", "regenerate", "s", "r"), preview);
  for (const bad of [
    null,
    {},
    { ...preview, sessionId: "other" },
    { ...preview, entryId: "other" },
    { ...preview, hasImages: 1 },
    { ...preview, text: 1 },
    { ...preview, sourceLeafId: undefined },
    { ...preview, previewId: undefined },
    { ...preview, previewId: "" },
  ])
    assert.throws(() => parseMessageRevision(bad, "assistant", "regenerate", "s", "r"));
});

test("read-only revision ignores bounded visible chat previews and fences late reads", async () => {
  const s = store();
  s.items = [{ kind: "message", role: "user", id: "ui", text: "truncated preview…" }];
  assert.equal((await s.getMessageRevision("assistant", "regenerate")).text, "full original");
  s.send = async (method) => {
    if (method === "sync_request")
      return { sessionId: "s", runtimeId: "r", leafId: "leaf", entries: [], treeNodes: [], isStreaming: false };
    s.leafId = "new";
    return preview;
  };
  await assert.rejects(s.getMessageRevision("assistant", "regenerate"), /branch changed/);
});

test("late persisted-leaf sync cannot resurrect a disconnected or locked revision", async () => {
  for (const patch of [{ connection: "disconnected" }, { sessionActionPending: true }, { advancedFeatures: false }]) {
    const s = store();
    const send = s.send;
    let reads = 0;
    s.send = async (method) => {
      if (method !== "sync_request") reads++;
      Object.assign(s, patch);
      return send(method);
    };
    await assert.rejects(s.getMessageRevision("assistant", "regenerate"), /branch changed/);
    assert.equal(reads, 0);
    if ("connection" in patch) assert.equal(Reflect.get(s, "connection"), "disconnected");
  }
});

test("submit locks double clicks, checks ACK without fabricating chat, and never replays after errors", async () => {
  const s = store();
  let resolve!: (v: unknown) => void;
  let sends = 0;
  s.send = async () => {
    sends++;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const action = s.submitMessageRevision(preview, "unused");
  assert.equal(s.sessionActionPending, true);
  await assert.rejects(s.submitMessageRevision(preview, "unused"), /branch changed/);
  resolve({ dispatched: true, sessionId: "s", runtimeId: "r", userEntryId: "user" });
  assert.equal(await action, true);
  assert.equal(s.items.length, 0, "real Pi events own messages");
  assert.equal(sends, 1);
  assert.equal(s.sessionActionPending, false);
  s.send = async () => {
    sends++;
    throw new Error("dispatch unknown");
  };
  await assert.rejects(s.submitMessageRevision(preview, "unused"), /dispatch unknown/);
  assert.equal(sends, 2, "no automatic resend");
});

test("cancel and runtime replacement preserve data without releasing newer locks", async () => {
  const s = store();
  s.send = async () => ({ cancelled: true });
  assert.equal(await s.submitMessageRevision(preview, "unused"), false);
  s.send = async () => {
    s.runtimeId = "new-r";
    s.sessionActionPending = true;
    return { dispatched: true };
  };
  await assert.rejects(s.submitMessageRevision(preview, "unused"), /branch changed/);
  assert.equal(s.sessionActionPending, true);
});

test("busy/disconnected/old leaf and empty edits do not dispatch", async () => {
  for (const patch of [
    { chatStatus: "streaming" },
    { connection: "disconnected" },
    { leafId: "other" },
    { advancedFeatures: false },
  ]) {
    const s = store();
    let sends = 0;
    s.send = async () => {
      sends++;
      return {};
    };
    Object.assign(s, patch);
    await assert.rejects(s.submitMessageRevision(preview, "unused"));
    assert.equal(sends, 0);
  }
  const s = store();
  await assert.rejects(s.submitMessageRevision({ ...preview, mode: "edit" }, "   "), /empty/);
});

test("runtime snapshot invalidates only the old revision operation and permits a new operation", async () => {
  const s = store();
  let firstResolve!: (v: unknown) => void;
  let nextResolve!: (v: unknown) => void;
  s.send = async () =>
    new Promise((resolve) => {
      firstResolve = resolve;
    });
  const first = s.submitMessageRevision(preview, "unused");
  assert.equal(s.sessionActionPending, true);
  s.applyStateSync({
    sessionId: "s",
    runtimeId: "r2",
    entries: [],
    treeNodes: [],
    leafId: "new-leaf",
    isStreaming: false,
  });
  assert.equal(s.sessionActionPending, false);
  s.send = async () =>
    new Promise((resolve) => {
      nextResolve = resolve;
    });
  const next = s.submitMessageRevision(
    { ...preview, runtimeId: "r2", sourceLeafId: "new-leaf", previewId: "new-preview" },
    "unused",
  );
  assert.equal(s.sessionActionPending, true);
  firstResolve({ dispatched: true, sessionId: "s", runtimeId: "r", userEntryId: "user" });
  await assert.rejects(first, /branch changed/);
  assert.equal(s.sessionActionPending, true, "old completion cannot unlock the new operation");
  nextResolve({ dispatched: true, sessionId: "s", runtimeId: "r2", userEntryId: "user" });
  assert.equal(await next, true);
  assert.equal(s.sessionActionPending, false);
});

test("ready before settled snapshot resolves full-text preview against freshly saved leaf", async () => {
  const s = store();
  s.leafId = "previous-turn";
  assert.equal((await s.getMessageRevision("assistant", "regenerate")).sourceLeafId, "leaf");
  assert.equal(s.leafId, "leaf");
});
