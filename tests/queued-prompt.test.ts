import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canDispatchQueuedPrompt,
  createQueuedPrompt,
  navigationResultIsCurrent,
  queuedPromptMatchesScope,
} from "../src/web/src/core/queued-prompt.ts";

test("queueing requires a connected session and runtime and binds both identities", () => {
  assert.equal(
    createQueuedPrompt({ id: "offline", message: "hello" }, { sessionId: "s1", runtimeId: "r1" }, false),
    null,
  );
  assert.equal(
    createQueuedPrompt({ id: "unscoped", message: "hello" }, { sessionId: "s1", runtimeId: null }, true),
    null,
  );
  const prompt = createQueuedPrompt({ id: "queued", message: "hello" }, { sessionId: "s1", runtimeId: "r1" }, true);
  assert.ok(prompt);
  assert.deepEqual(prompt.scope, { sessionId: "s1", runtimeId: "r1" });
  assert.deepEqual(prompt.sourceScope, { sessionId: "s1", runtimeId: "r1" });
});

test("queued prompt dispatch requires ready, connected, non-pending state and exact source identity", () => {
  const prompt = createQueuedPrompt({ id: "queued", message: "hello" }, { sessionId: "s1", runtimeId: "r1" }, true);
  assert.ok(prompt);
  const state = {
    sessionId: "s1",
    runtimeId: "r1",
    connection: "connected",
    chatStatus: "ready",
    sessionActionPending: false,
  };
  assert.equal(canDispatchQueuedPrompt(prompt, state), true);
  assert.equal(canDispatchQueuedPrompt(prompt, { ...state, connection: "disconnected" }), false);
  assert.equal(canDispatchQueuedPrompt(prompt, { ...state, sessionId: "s2" }), false);
  assert.equal(canDispatchQueuedPrompt(prompt, { ...state, runtimeId: "r2" }), false);
  assert.equal(canDispatchQueuedPrompt(prompt, { ...state, chatStatus: "streaming" }), false);
  assert.equal(canDispatchQueuedPrompt(prompt, { ...state, sessionActionPending: true }), false);
});

test("branch results require unchanged session/runtime and draft text/version", () => {
  const sourceScope = { sessionId: "s1", runtimeId: "r1" };
  const sourceDraft = { text: "draft", version: 3 };
  assert.equal(navigationResultIsCurrent(sourceScope, sourceScope, sourceDraft, sourceDraft), true);
  assert.equal(
    navigationResultIsCurrent(sourceScope, { sessionId: "s2", runtimeId: "r2" }, sourceDraft, sourceDraft),
    false,
  );
  assert.equal(navigationResultIsCurrent(sourceScope, sourceScope, sourceDraft, { text: "edited", version: 4 }), false);
  assert.equal(navigationResultIsCurrent(sourceScope, sourceScope, sourceDraft, { text: "draft", version: 4 }), false);
});

test("a stale queued prompt never silently matches the replacement scope", () => {
  const prompt = createQueuedPrompt({ id: "queued", message: "hello" }, { sessionId: "s1", runtimeId: "r1" }, true);
  assert.ok(prompt);
  assert.equal(queuedPromptMatchesScope(prompt, { sessionId: "s2", runtimeId: "r2" }), false);
});
