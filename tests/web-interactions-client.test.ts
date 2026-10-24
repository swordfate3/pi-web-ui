import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { InteractionBroker } from "../extensions/interactions/broker.ts";
import { createInteractionClient, installInteractionBroker } from "../extensions/interactions/client.ts";

const manifest = { id: "memory", version: "1.0.0", packageName: "pi-scoped-memory", actions: { write: { classification: "sensitive" as const, method: "confirm" as const } } };
const spec = () => ({ action: "write", revision: "preview-1", classification: "sensitive" as const, method: "confirm" as const, schema: { kind: "confirm" as const }, content: { title: "Memory", preview: "exact" }, deadline: Date.now() + 1000 });
const identity = { runId: "a".repeat(32), generation: "b".repeat(32), runtimeId: "runtime-1", sessionId: "session-1" };

test("a source client created before Web loads discovers the broker on first operation", async () => {
  const bus = createEventBus();
  const client = createInteractionClient(bus, manifest);
  const broker = new InteractionBroker(identity);
  const uninstall = installInteractionBroker(bus, broker);
  const result = await client.interact(spec(), { isCurrent: () => true, local: async () => true });
  assert.equal(result.state, "allowed");
  assert.equal(broker.completions().length, 1);
  assert.equal(broker.capabilities()[0]?.id, "memory");
  client.dispose();
  assert.equal(broker.capabilities().length, 0);
  uninstall();
  broker.close();
  bus.clear();
});

test("an expired terminal-only request cannot approve", async () => {
  const bus = createEventBus();
  const client = createInteractionClient(bus, manifest);
  assert.equal((await client.interact({ ...spec(), deadline: Date.now() - 1 }, { isCurrent: () => true, local: async () => true })).state, "expired");
  client.dispose(); bus.clear();
});

test("dispose aborts an unresponsive terminal-only prompt and settles without approval", async () => {
  const bus = createEventBus();
  const client = createInteractionClient(bus, manifest);
  let signal: AbortSignal | undefined;
  const outcome = client.interact(spec(), { isCurrent: () => true, local: (localSignal) => { signal = localSignal; return new Promise(() => {}); } });
  await setImmediate();
  client.dispose();
  assert.equal((await outcome).state, "cancelled");
  assert.equal(signal?.aborted, true);
  bus.clear();
});

test("a surviving client rediscovers only new operations after host registration replacement", async () => {
  const bus = createEventBus();
  const broker = new InteractionBroker(identity);
  const off = installInteractionBroker(bus, broker);
  const client = createInteractionClient(bus, manifest);
  await client.interact(spec(), { isCurrent: () => true, local: async () => false });
  broker.replaceIdentity({ ...identity, runtimeId: "new-runtime" });
  assert.equal(client.status(), "available");
  assert.equal((await client.interact(spec(), { isCurrent: () => true, local: async () => true })).state, "allowed");
  client.dispose(); off(); broker.close(); bus.clear();
});

test("an absent broker preserves original terminal rejection without claiming Web capability", async () => {
  const bus = createEventBus();
  const client = createInteractionClient(bus, manifest);
  assert.equal(client.status(), "absent");
  assert.deepEqual(await client.interact(spec(), { isCurrent: () => true, local: async () => false }), { state: "rejected", answer: false, winner: "local" });
  assert.equal(client.status(), "absent");
  client.dispose();
  bus.clear();
});

test("an advertised incompatible broker is not mistaken for absent or used for Web approval", async () => {
  const bus = createEventBus();
  bus.on("pi-web-interactions:discover", (data) => { (data as { accept: (offer: unknown) => void }).accept({ protocol: "future-unsupported" }); });
  const client = createInteractionClient(bus, manifest);
  assert.equal(client.status(), "unsupported");
  assert.equal((await client.interact(spec(), { isCurrent: () => true, local: async () => true })).winner, "local");
  client.dispose();
  bus.clear();
});

test("stale or aborted source cannot resume even on terminal-only fallback", async () => {
  const bus = createEventBus();
  const client = createInteractionClient(bus, manifest);
  const controller = new AbortController();
  controller.abort();
  let effects = 0;
  const local = async () => { effects++; return true; };
  assert.equal((await client.interact(spec(), { isCurrent: () => true, signal: controller.signal, local })).state, "cancelled");
  assert.equal((await client.interact(spec(), { isCurrent: () => false, local })).state, "stale");
  assert.equal(effects, 0);
  client.dispose();
  bus.clear();
});

test("immediate cancellation or disposal cannot open a queued terminal prompt", async () => {
  for (const kind of ["abort", "dispose"] as const) {
    const bus = createEventBus();
    const client = createInteractionClient(bus, manifest);
    const controller = new AbortController();
    let prompts = 0;
    const result = client.interact(spec(), { isCurrent: () => true, signal: controller.signal, local: async () => { prompts++; return true; } });
    if (kind === "abort") controller.abort();
    else client.dispose();
    assert.equal((await result).state, "cancelled");
    await setImmediate();
    assert.equal(prompts, 0);
    client.dispose(); bus.clear();
  }
});

test("a delayed timer cannot extend the capped terminal confirmation deadline", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const bus = createEventBus();
  const client = createInteractionClient(bus, manifest);
  const request = { ...spec(), deadline: now + 600_000 };
  const result = await client.interact(request, { isCurrent: () => true, local: async () => { now += 120_001; return true; } });
  assert.equal(result.state, "expired");
  client.dispose(); bus.clear();
});
