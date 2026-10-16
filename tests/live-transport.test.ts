import assert from "node:assert/strict";
import test from "node:test";
import { projectLiveEvent } from "../extensions/live-transport.ts";
import { guardHistoryFrame } from "../extensions/session-history.ts";

const large = "中\u0001".repeat(1024 * 1024);
const scope = { sessionId: "synthetic-session", runtimeId: "synthetic-runtime" };
test("delta projection drops duplicate cumulative snapshots without touching Pi source", () => {
  for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
    const message = { role: "assistant", content: large };
    const event = {
      type: "event",
      event: "message_update",
      payload: {
        type: "message_update",
        message,
        assistantMessageEvent: { type, contentIndex: 2, delta: "chunk", partial: message },
      },
    };
    const projected = projectLiveEvent(event);
    assert.deepEqual(projected, {
      type: "event",
      event: "message_update",
      payload: {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 2, delta: "chunk" },
      },
    });
    assert.equal(event.payload.message, message);
    assert.equal(event.payload.assistantMessageEvent.partial, message);
    assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 512);
  }
});
test("terminal lifecycle projection preserves control fields without retransmitting message history", () => {
  assert.deepEqual(
    projectLiveEvent({ type: "event", event: "agent_end", payload: { type: "agent_end", messages: [large] } }),
    {
      type: "event",
      event: "agent_end",
      payload: { type: "agent_end" },
    },
  );
  assert.deepEqual(
    projectLiveEvent({
      type: "event",
      event: "turn_end",
      payload: { type: "turn_end", turnIndex: 1, message: large, toolResults: [large], messageEntryId: "exact-id" },
    }),
    {
      type: "event",
      event: "turn_end",
      payload: { type: "turn_end", turnIndex: 1, messageEntryId: "exact-id" },
    },
  );
});

test("non-delta, extension, control and response values are not silently projected", () => {
  for (const event of [
    { type: "res", id: "1", result: large },
    { type: "event", event: "state_sync", payload: { message: large } },
    {
      type: "event",
      event: "message_update",
      payload: { assistantMessageEvent: { type: "text_end", content: large } },
    },
    { type: "event", event: "extension_ui_request", payload: { message: large } },
  ])
    assert.equal(projectLiveEvent(event), event);
});
test("oversized recoverable live events become scoped explicit omission controls, never fake source results", () => {
  const raw = JSON.stringify({ content: large });
  assert.ok(Buffer.byteLength(raw) > 4 * 1024 * 1024);
  const notice = JSON.parse(guardHistoryFrame(raw, { type: "event", event: "tool_execution_end" }, scope));
  assert.deepEqual(notice, {
    type: "event",
    event: "transport_omitted",
    payload: {
      ...scope,
      sourceEvent: "tool_execution_end",
      bytes: Buffer.byteLength(raw),
    },
  });
  assert.ok(!JSON.stringify(notice).includes("content"));
  assert.equal(JSON.parse(guardHistoryFrame(raw, { type: "res", id: "real-request" }, scope)).ok, false);
  for (const event of ["state_sync", "extension_ui_request", "unknown"]) {
    assert.equal(JSON.parse(guardHistoryFrame(raw, { type: "event", event }, scope)).code, "message_too_large");
  }
  assert.equal(JSON.parse(guardHistoryFrame(raw, { type: "event", event: "message_end" })).code, "message_too_large");
});
