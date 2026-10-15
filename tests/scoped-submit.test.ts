import assert from "node:assert/strict";
import { test } from "node:test";
import { createScopedSubmitLock, runIfAttachmentsEnabled } from "../src/web/src/core/scoped-submit.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { StateSyncPayload } from "../src/web/src/core/types.ts";
import { MAX_WORKSPACE_UPLOAD_BYTES, uploadWorkspaceFiles } from "../src/web/src/core/workspace-uploads.ts";

function createStore() {
  let state: ReturnType<typeof createSessionSlice> & {
    send: (method: string, params?: unknown) => Promise<unknown>;
    error: unknown;
  };
  state = createSessionSlice(
    ((patch: object | ((state: unknown) => object)) =>
      Object.assign(state, typeof patch === "function" ? patch(state) : patch)) as never,
    (() => state) as never,
    {} as never,
  ) as typeof state;
  Object.assign(state, {
    connection: "connected",
    error: null,
    mergeArtifactsFromToolEvent() {},
    requestGitStatusRefresh() {},
    send: async () => undefined,
  });
  return state;
}

function session(sessionId: string, runtimeId: string): StateSyncPayload {
  return { sessionId, runtimeId, entries: [], treeNodes: [] };
}

test("a new scope can submit while an old scope is pending, and old finally cannot release it", () => {
  const lock = createScopedSubmitLock();
  const oldAttempt = lock.acquire("old-session");
  assert.ok(oldAttempt);
  assert.throws(() => lock.acquire("old-session"), /already in progress/, "duplicate submission rejects");

  const newAttempt = lock.acquire("new-session");
  assert.ok(newAttempt, "new session is not blocked by old pending work");
  lock.release(oldAttempt);
  assert.throws(
    () => lock.acquire("new-session"),
    /already in progress/,
    "old finally cannot release the newer attempt",
  );

  lock.release(newAttempt);
  const retryAttempt = lock.acquire("new-session");
  assert.ok(retryAttempt, "the owning attempt can release its own lock");
  lock.release(retryAttempt);
});

test("a hanging old prepare cannot block a new scope or send a prompt after the scope changes", async () => {
  const state = createStore();
  state.applyStateSync(session("old-session", "old-runtime"));
  const lock = createScopedSubmitLock();
  const oldAttempt = lock.acquire("old-scope");
  assert.ok(oldAttempt);

  let resolvePrepare!: (response: unknown) => void;
  let prepareStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    prepareStarted = resolve;
  });
  let promptCalls = 0;
  const file = Object.assign(new Blob(["attachment"]), { name: "old.txt", lastModified: 1 });
  const oldUpload = uploadWorkspaceFiles([{ id: "old-file", file: file as File }], {
    scope: { sessionId: "old-session", runtimeId: "old-runtime", generation: "/" },
    origin: "https://pi.example",
    pathname: "/",
    signal: new AbortController().signal,
    send: async (method) => {
      assert.equal(method, "prepare_upload");
      prepareStarted();
      return new Promise((resolve) => {
        resolvePrepare = resolve;
      });
    },
    isCurrent: () => state.sessionId === "old-session" && state.runtimeId === "old-runtime",
  }).finally(() => lock.release(oldAttempt));
  await started;

  state.applyStateSync(session("new-session", "new-runtime"));
  const newAttempt = lock.acquire("new-scope");
  assert.ok(newAttempt, "new-session submit must not wait for the old prepare request");
  state.send = async (method) => {
    if (method === "prompt") promptCalls++;
    return undefined;
  };
  await state.sendPrompt({
    id: "new-prompt",
    message: "new session prompt",
    scope: { sessionId: "new-session", runtimeId: "new-runtime" },
  });

  resolvePrepare({
    protocol: 2,
    uploadId: "123e4567-e89b-42d3-a456-426614174000",
    url: "/api/uploads/123e4567-e89b-42d3-a456-426614174000",
    relativePath: ".pi-uploads/old-session/123e4567-e89b-42d3-a456-426614174000/old.txt",
    maxBytes: MAX_WORKSPACE_UPLOAD_BYTES,
    chunkSize: 8 * 1024 * 1024,
    nextChunk: 0,
    complete: false,
  });
  await assert.rejects(oldUpload, /session changed/i);
  assert.equal(promptCalls, 1, "only the new prompt reaches the prompt RPC");
  assert.equal(state.sessionId, "new-session");
  assert.equal(state.chatStatus, "submitted");
  assert.throws(
    () => lock.acquire("new-scope"),
    /already in progress/,
    "the old finally must not release the new submit lock",
  );
  lock.release(newAttempt);
});

test("attachment add/drop and remove mutations are ignored during handoff", () => {
  const attachments = ["already-selected"];
  runIfAttachmentsEnabled(true, () => attachments.push("dropped-during-handoff"));
  runIfAttachmentsEnabled(true, () => attachments.splice(0, 1));
  assert.deepEqual(attachments, ["already-selected"]);

  runIfAttachmentsEnabled(false, () => attachments.push("added-after-handoff"));
  assert.deepEqual(attachments, ["already-selected", "added-after-handoff"]);
});

test("late prompt rejection from an old session leaves the new snapshot and status untouched", async () => {
  const state = createStore();
  state.applyStateSync(session("old-session", "old-runtime"));

  let rejectPrompt!: (error: Error) => void;
  state.send = () =>
    new Promise((_, reject) => {
      rejectPrompt = reject;
    });
  const prompt = state.sendPrompt({
    id: "old-prompt",
    message: "old text",
    uploads: ["old-upload"],
    scope: { sessionId: "old-session", runtimeId: "old-runtime" },
  });
  assert.equal(state.chatStatus, "submitted");

  state.applyStateSync(session("new-session", "new-runtime"));
  assert.equal(state.chatStatus, "ready");
  rejectPrompt(new Error("old prompt rejected"));
  await assert.rejects(prompt, /old prompt rejected/);

  assert.equal(state.sessionId, "new-session");
  assert.equal(state.runtimeId, "new-runtime");
  assert.equal(state.chatStatus, "ready", "stale rejection must not overwrite new snapshot status");
  assert.equal(state.error, null, "stale rejection must not overwrite new snapshot error state");
});

test("prompt with an already stale attachment scope rejects before changing status", async () => {
  const state = createStore();
  state.applyStateSync(session("new-session", "new-runtime"));

  await assert.rejects(
    state.sendPrompt({
      id: "stale-prompt",
      message: "old text",
      uploads: ["old-upload"],
      scope: { sessionId: "old-session", runtimeId: "old-runtime" },
    }),
    /session changed/i,
  );
  assert.equal(state.chatStatus, "ready");
  assert.equal(state.error, null);
});
