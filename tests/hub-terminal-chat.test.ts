import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionSlice } from "../src/web/src/core/store/connection-slice.ts";
import { createSessionSlice } from "../src/web/src/core/store/session-slice.ts";
import type { PiWebUiStore } from "../src/web/src/core/store/types.ts";

function fixture() {
  let state: PiWebUiStore;
  const set = (patch: object | ((state: PiWebUiStore) => object)) =>
    Object.assign(state, typeof patch === "function" ? patch(state) : patch);
  const args = [set as never, (() => state) as never, {} as never] as const;
  state = { ...createConnectionSlice(...args), ...createSessionSlice(...args) } as PiWebUiStore;
  state.requestGitStatusRefresh = () => {};
  const calls: string[] = [];
  state.setClient({
    send: async (method: string) => {
      calls.push(method);
      return {};
    },
  } as never);
  return { state, calls };
}
test("startup policy disables browser mutations before first takeover but preserves explicit reads", async () => {
  const { state, calls } = fixture();
  state.applyStateSync({ sessionId: "s", runtimeId: "r", entries: [], browserInputPolicy: "terminal-readonly" });
  assert.equal(state.browserInputPolicy, "terminal-readonly");
  for (const method of ["prompt", "abort", "set_model", "extension_ui_response", "get_arbitrary_unknown"])
    await assert.rejects(state.send(method));
  await state.send("get_history");
  assert.deepEqual(calls, ["get_history"]);
  state.applyStateSync({ sessionId: "s", runtimeId: "r2", entries: [], browserInputPolicy: "terminal-readonly" });
  await assert.rejects(state.send("prompt"));
  assert.equal(state.browserInputPolicy, "terminal-readonly");
});
test("ordinary inherited-tui remains writable; invalid display policy fails closed", async () => {
  const { state } = fixture();
  state.applyStateSync({ sessionId: "s", runtimeId: "r", entries: [] });
  await state.send("prompt");
  state.applyStateSync({ sessionId: "s", runtimeId: "r", entries: [], browserInputPolicy: { latched: true } as never });
  await assert.rejects(state.send("prompt"));
});
