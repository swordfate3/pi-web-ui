import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { InteractionPanels, installInteractionPanels, registerInteractionPanel, announceInteractionPanels } from "../extensions/interactions/panels.ts";

function fixture() {
  let calls = 0;
  let revision = "r1";
  let current = true;
  let now = Date.now();
  const panels = new InteractionPanels(() => now);
  const bus = createEventBus();
  const uninstall = installInteractionPanels(bus, panels);
  const source = registerInteractionPanel(bus, {
    manifest: { id: "agents", version: "1.0.0", packageName: "pi-subagents-lite", commands: ["agents"], methods: ["spawn"] },
    isCurrent: () => current,
    snapshot: async () => ({ revision, items: [{ id: "worker", label: "Worker" }], config: { concurrency: 2 } }),
    invoke: async () => { calls++; return { agentId: "child-1" }; },
  });
  return { panels, bus, source, uninstall, calls: () => calls, stale: () => { current = false; }, revise: () => { revision = "r2"; }, advance: (ms: number) => { now += ms; } };
}
const draft = () => ({ revision: "r1", method: "spawn", params: { task: "do work" } });
async function action(panels: InteractionPanels) {
  const snapshot = await panels.snapshot("agents");
  return panels.prepare("agents", { ...draft(), registrationId: snapshot.registrationId });
}
async function settled(panels: InteractionPanels, actionId: string) {
  for (let i = 0; i < 100; i++) {
    if (panels.actionStatus("agents", actionId).state !== "pending") return;
    await setImmediate();
  }
  assert.fail("source action did not settle");
}

test("explicit source command ownership and bounded panel snapshots are discoverable", async () => {
  const f = fixture();
  assert.equal(f.panels.list()[0]?.commands[0], "agents");
  assert.equal((await f.panels.snapshot("agents")).items[0]?.id, "worker");
  assert.throws(() => f.panels.prepare("agents", { ...draft(), registrationId: "a".repeat(32), method: "arbitrary-shell" }));
  f.source.dispose();
  assert.equal(f.panels.list().length, 0);
  f.uninstall(); f.bus.clear(); f.panels.close();
});

test("duplicate/reconnected action IDs return one receipt and never spawn twice", async () => {
  const f = fixture();
  const admitted = await action(f.panels);
  assert.equal(f.panels.start("agents", admitted).state, "pending");
  assert.equal(f.panels.start("agents", admitted).actionId, admitted.actionId);
  await settled(f.panels, admitted.actionId);
  assert.equal(f.panels.actionStatus("agents", admitted.actionId).state, "succeeded");
  assert.equal(f.panels.start("agents", admitted).state, "succeeded");
  assert.equal(f.calls(), 1);
  assert.throws(() => f.panels.start("agents", { ...admitted, params: { task: "a different task" } }));
  f.source.dispose(); f.uninstall(); f.bus.clear(); f.panels.close();
});

test("source revision and lifecycle changes reject before invoking side effects", async () => {
  const f = fixture();
  const admitted = await action(f.panels);
  f.revise();
  f.panels.start("agents", admitted);
  await settled(f.panels, admitted.actionId);
  assert.equal(f.panels.actionStatus("agents", admitted.actionId).state, "failed");
  assert.equal(f.calls(), 0);
  f.stale();
  await assert.rejects(() => f.panels.snapshot("agents"));
  f.source.dispose(); f.uninstall(); f.bus.clear(); f.panels.close();
});

test("evicted or expired admissions stay unknown and never become new executable actions", async () => {
  const f = fixture();
  const first = await action(f.panels);
  f.panels.start("agents", first);
  await settled(f.panels, first.actionId);
  for (let i = 0; i < 129; i++) {
    const admitted = await action(f.panels);
    f.panels.start("agents", admitted);
    await settled(f.panels, admitted.actionId);
  }
  const before = f.calls();
  assert.throws(() => f.panels.start("agents", first));
  const recent = await action(f.panels);
  f.panels.start("agents", recent);
  await settled(f.panels, recent.actionId);
  f.advance(300_001);
  assert.throws(() => f.panels.start("agents", recent));
  assert.equal(f.calls(), before + 1);
  f.source.dispose(); f.uninstall(); f.bus.clear(); f.panels.close();
});

test("unload/re-register cannot accept an action from the previous registration", async () => {
  const f = fixture();
  const admitted = await action(f.panels);
  f.source.dispose();
  const next = registerInteractionPanel(f.bus, {
    manifest: { id: "agents", version: "1", packageName: "agents", commands: ["agents"], methods: ["spawn"] },
    isCurrent: () => true, snapshot: async () => ({ revision: "r1", items: [] }), invoke: async () => assert.fail("old action executed"),
  });
  assert.throws(() => f.panels.start("agents", admitted));
  next.dispose(); f.uninstall(); f.bus.clear(); f.panels.close();
});

test("oversized and unpaginated panel lists are rejected without truncation", async () => {
  const panels = new InteractionPanels();
  panels.register({
    manifest: { id: "mcp-adapter", version: "1", packageName: "pi-mcp-adapter", commands: ["mcp-adapter"], methods: [] },
    isCurrent: () => true,
    snapshot: async () => ({ revision: "r1", items: Array.from({ length: 101 }, (_, i) => ({ id: String(i) })) }),
    invoke: async () => null,
  });
  await assert.rejects(() => panels.snapshot("mcp-adapter"));
  panels.close();
});

test("post-lifecycle ready reattaches source with a fresh registration and rejects old admission", async () => {
  const f = fixture();
  const old = await action(f.panels);
  f.panels.invalidate();
  assert.equal(f.panels.list().length, 0);
  announceInteractionPanels(f.bus);
  assert.equal(f.panels.list().length, 1);
  assert.notEqual((await f.panels.snapshot("agents")).registrationId, old.registrationId);
  assert.throws(() => f.panels.start("agents", old));
  const next = await action(f.panels);
  f.panels.start("agents", next);
  await settled(f.panels, next.actionId);
  assert.equal(f.calls(), 1);
  f.source.dispose(); f.uninstall(); f.bus.clear(); f.panels.close();
});

test("byte-budget eviction cannot turn an old receipt into another source effect", async () => {
  const panels = new InteractionPanels();
  let calls = 0;
  panels.register({ manifest: { id: "agents", version: "1", packageName: "agents", commands: ["agents"], methods: ["spawn"] }, isCurrent: () => true, snapshot: async () => ({ revision: "r1", items: [] }), invoke: async () => { calls++; return { body: "x".repeat(60000) }; } });
  const first = await action(panels);
  panels.start("agents", first);
  await settled(panels, first.actionId);
  for (let i = 0; i < 5; i++) { const next = await action(panels); panels.start("agents", next); await settled(panels, next.actionId); }
  assert.throws(() => panels.actionStatus("agents", first.actionId));
  assert.throws(() => panels.start("agents", first));
  assert.equal(calls, 6);
  panels.close();
});
