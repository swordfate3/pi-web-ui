import assert from "node:assert/strict";
import { test } from "node:test";
import { createInteractionRequest } from "../extensions/interactions/protocol.ts";
import { createConnectionSlice } from "../src/web/src/core/store/connection-slice.ts";
import { createInteractionSlice } from "../src/web/src/core/store/interaction-slice.ts";
import { dispatchPiEvent } from "../src/web/src/core/store/event-dispatch.ts";
import type { PiWebUiStore } from "../src/web/src/core/store/types.ts";

function store() {
  const state = {} as PiWebUiStore;
  const set = (patch: object) => Object.assign(state, patch);
  const args = [set, () => state, {}] as unknown as Parameters<typeof createInteractionSlice>;
  Object.assign(state, createConnectionSlice(...args), createInteractionSlice(...args), { sessionId: "s", runtimeId: "r", connection: "connected" });
  return state;
}
const manifest = { id: "mcp-adapter", version: "6", packageName: "pi-mcp-adapter", commands: ["mcp-adapter"], methods: ["reconnect"] };
const statePayload = () => ({ sessionId: "s", runtimeId: "r", generation: "a".repeat(32), managementOrigin: "https://admin.example.test", authorityAvailable: true, panels: [manifest], adapters: [], pending: [{ requestId: "b".repeat(32), adapterId: "mcp-adapter", action: "reconnect", classification: "sensitive", state: "pending", deadline: Date.now() + 60000, request: { content: { secret: "NEVER RETAIN" } } }] });

test("public interaction state drops sensitive bodies, fences scope and clears on disconnect", () => {
  const state = store();
  dispatchPiEvent(state, { type: "event", event: "extension_interactions", payload: statePayload() });
  assert.equal(state.interactions?.pending.length, 1);
  assert.ok(!JSON.stringify(state.interactions).includes("NEVER RETAIN"));
  dispatchPiEvent(state, { type: "event", event: "extension_interactions", payload: { ...statePayload(), runtimeId: "old" } });
  assert.equal(state.interactions?.runtimeId, "r");
  state.setConnection("disconnected");
  assert.equal(state.interactions, null);
  dispatchPiEvent(state, { type: "event", event: "extension_interactions", payload: statePayload() });
  assert.equal(state.interactions, null);
});

test("panels route only explicit command ownership and stale async snapshots are discarded", async () => {
  const state = store();
  state.applyInteractions(statePayload());
  assert.equal(state.panelForCommand("mcp-adapter"), "mcp-adapter");
  assert.equal(state.panelForCommand("mcp"), null);
  let finish: (value: unknown) => void = () => {};
  state.send = async () => new Promise((resolve) => { finish = resolve; });
  const opening = state.openInteractionPanel("mcp-adapter");
  state.clearInteractions();
  finish({ registrationId: "c".repeat(32), revision: "v1", items: [] });
  await opening;
  assert.equal(state.interactionPanel, null);
});

test("action submit admits once, never reprepares on unknown delivery and can query original ID", async () => {
  const state = store();
  state.applyInteractions(statePayload());
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  state.send = async (method, params) => {
    calls.push({ method, params });
    if (method === "get_extension_panel") return { registrationId: "c".repeat(32), revision: "v1", items: [] };
    if (method === "prepare_extension_panel_action") return { ...(params!.action as object), actionId: "d".repeat(32) };
    if (method === "start_extension_panel_action") throw new Error("network interrupted");
    return { actionId: "d".repeat(32), state: "succeeded" };
  };
  await state.openInteractionPanel("mcp-adapter");
  await state.submitInteractionAction("reconnect", { server: "safe" });
  assert.equal(state.interactionAction?.state, "delivery_unknown");
  await state.submitInteractionAction("reconnect", { server: "safe" });
  assert.equal(calls.filter((call) => call.method === "prepare_extension_panel_action").length, 1);
  await state.refreshInteractionAction();
  assert.equal(state.interactionAction?.state, "succeeded");
  assert.equal(calls.at(-1)?.params?.actionId, "d".repeat(32));
});

test("unknown ordinary-choice delivery does not mint a second decision on repeated clicks", async () => {
  const state = store();
  const request = createInteractionRequest({ runId: "e".repeat(32), generation: "a".repeat(32), sessionId: "s", runtimeId: "r" }, { id: "profiles", version: "1", packageName: "profiles" }, { action: "choose", revision: "catalog-1", classification: "session", method: "select", schema: { kind: "select", options: ["fast", "careful"] }, content: { title: "Choose profile" }, deadline: Date.now() + 60000 });
  state.applyInteractions({ ...statePayload(), pending: [{ requestId: request.requestId, adapterId: "profiles", action: "choose", classification: "session", state: "pending", deadline: request.deadline, request }] });
  let deliveries = 0;
  state.send = async () => { deliveries++; throw new Error("Delivery unknown"); };
  const choice = state.interactions!.pending[0].request!;
  await state.respondInteraction(choice, "fast");
  await state.respondInteraction(choice, "fast");
  assert.equal(deliveries, 1);
});

test("invalid ordinary answers are correctable before a delivery attempt is recorded", async () => {
  for (const scenario of [
    { method: "input", schema: { kind: "text", maxBytes: 3 }, invalid: "中文", valid: "a" },
    { method: "select", schema: { kind: "select", options: ["fast", "careful"] }, invalid: "unknown", valid: "fast" },
    { method: "confirm", schema: { kind: "confirm" }, invalid: "true", valid: true },
  ] as const) {
    const state = store();
    const request = createInteractionRequest({ runId: "e".repeat(32), generation: "a".repeat(32), sessionId: "s", runtimeId: "r" }, { id: "profiles", version: "1", packageName: "profiles" }, { action: "choose", revision: "catalog-1", classification: "session", method: scenario.method, schema: scenario.schema as any, content: { title: "Choose" }, deadline: Date.now() + 60000 });
    state.applyInteractions({ ...statePayload(), pending: [{ requestId: request.requestId, adapterId: "profiles", action: "choose", classification: "session", state: "pending", deadline: request.deadline, request }] });
    let deliveries = 0;
    state.send = async () => { deliveries++; return { state: "allowed" }; };
    const choice = state.interactions!.pending[0].request!;
    await state.respondInteraction(choice, scenario.invalid);
    assert.equal(deliveries, 0);
    assert.deepEqual(state.interactionChoiceAttempts, []);
    assert.ok(state.interactionPanelError);
    await state.respondInteraction(choice, scenario.valid);
    assert.equal(deliveries, 1);
  }
});
