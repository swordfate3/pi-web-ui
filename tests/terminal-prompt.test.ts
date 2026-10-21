import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TERMINAL_UI_REQUIRED, TerminalPromptState } from "../extensions/terminal-prompt.ts";
import { createConnectionSlice } from "../src/web/src/core/store/connection-slice.ts";
import { createDialogSlice } from "../src/web/src/core/store/dialog-slice.ts";
import { dispatchPiEvent } from "../src/web/src/core/store/event-dispatch.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { PiWebUiStore } from "../src/web/src/core/store/types.ts";

function store() {
  const state = {} as PiWebUiStore;
  const set = (patch: object | ((s: PiWebUiStore) => object)) =>
    Object.assign(state, typeof patch === "function" ? patch(state) : patch);
  const args = [set, () => state, {}] as unknown as Parameters<typeof createDialogSlice>;
  Object.assign(state, createConnectionSlice(...args), createSessionSlice(...args), createDialogSlice(...args), {
    connection: "connected",
    sessionId: "s",
    runtimeId: "r",
    requestGitStatusRefresh() {},
  });
  return state;
}
const payload = { kind: "confirm", title: "Scoped memory · GLOBAL", sessionId: "s", runtimeId: "r" };

test("backend tracks only public metadata, bounds pending state to outer prompt and clears on end", () => {
  const tracker = new TerminalPromptState();
  for (const kind of ["confirm", "select", "input", "editor", "custom"]) {
    tracker.observe({ kind, title: "Original title", message: "SECRET BODY", resolver() {} }, true);
    assert.deepEqual(tracker.snapshot(), { kind, title: "Original title" });
    tracker.observe({ kind }, false);
    assert.equal(tracker.snapshot(), null);
  }
  assert.equal(tracker.observe({ kind: "unknown" }, true), null);
  tracker.observe({ kind: "custom" }, true);
  assert.deepEqual(tracker.snapshot(), { kind: "custom" }, "no fabricated title/body");
  tracker.clear();
  assert.equal(tracker.snapshot(), null);
});

test("banner start/end is scope fenced; disconnect clears; snapshot restores only current transient metadata", () => {
  const state = store();
  const dispatch = (p: Record<string, unknown>, event = "ui_prompt_start") =>
    dispatchPiEvent(state, { type: "event", event, payload: p });
  dispatch(payload, "future_unknown_event");
  assert.equal(state.terminalPrompt, null);
  dispatch({ ...payload, sessionId: "old" });
  dispatch({ ...payload, runtimeId: "old" });
  dispatch({ ...payload, kind: "invalid" });
  assert.equal(state.terminalPrompt, null);
  dispatch(payload);
  assert.deepEqual(state.terminalPrompt, { kind: "confirm", title: payload.title });
  dispatch({ ...payload, runtimeId: "old" }, "ui_prompt_end");
  assert.ok(state.terminalPrompt);
  dispatch(payload, "ui_prompt_end");
  assert.equal(state.terminalPrompt, null);
  dispatch(payload);
  state.setConnection("disconnected");
  assert.equal(state.terminalPrompt, null);
  dispatch(payload);
  assert.equal(state.terminalPrompt, null);
  state.setConnection("connected");
  assert.equal(state.terminalPrompt, null, "reconnect alone does not invent a prompt");
  state.applyStateSync({
    sessionId: "s",
    runtimeId: "r",
    terminalPrompt: { kind: "editor" },
    entries: [],
    treeNodes: [],
  });
  assert.deepEqual(state.terminalPrompt, { kind: "editor" });
  state.applyStateSync({ sessionId: "s", runtimeId: "r2", entries: [], treeNodes: [] });
  assert.equal(state.terminalPrompt, null);
  state.applyStateSync({ sessionId: "new", runtimeId: "r2", terminalPrompt: null, entries: [], treeNodes: [] });
  assert.equal(state.terminalPrompt, null);
  assert.equal(state.items.length, 0, "metadata is not saved into chat history");
});

test("unsupported response errors are visible and never become approval", async () => {
  const state = store();
  state.send = async () => {
    throw new Error(TERMINAL_UI_REQUIRED);
  };
  state.setDialog({ id: "not-an-approval-token", method: "confirm" });
  state.respondDialog({ confirmed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.error, TERMINAL_UI_REQUIRED);
  assert.equal(state.dialog, null);
  const source = readFileSync(new URL("../extensions/mirror-server.ts", import.meta.url), "utf8");
  assert.match(source, /case "extension_ui_response": \{\s*sendTo\(ws, error\(TERMINAL_UI_REQUIRED\)\)/);
  assert.doesNotMatch(source, /pi\.on\("extension_ui_request"/);
});
