import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionSlice } from "../src/web/src/core/store/connection-slice.ts";
import type { PiWebUiStore } from "../src/web/src/core/store/types.ts";

test("ordinary browser commands reach Pi without a native-terminal input-policy handshake", async () => {
  // A native takeover gate used to reject these before state_sync. Ordinary
  // Web clients must use their established transport, not a second terminal.
  const sent: { method: string; params: unknown }[] = [];
  let state: PiWebUiStore;
  state = createConnectionSlice(
    (patch) => Object.assign(state, typeof patch === "function" ? patch(state) : patch),
    () => state,
    {} as never,
  ) as PiWebUiStore;
  state.setClient({
    send: async (method: string, params: unknown) => {
      sent.push({ method, params });
      return { accepted: true };
    },
  } as never);
  assert.deepEqual(await state.send("set_model", { provider: "fixture", modelId: "text-model" }), {
    accepted: true,
  });
  assert.deepEqual(await state.send("prompt", { message: "hello" }), { accepted: true });
  assert.deepEqual(sent, [
    { method: "set_model", params: { provider: "fixture", modelId: "text-model" } },
    { method: "prompt", params: { message: "hello" } },
  ]);
});
