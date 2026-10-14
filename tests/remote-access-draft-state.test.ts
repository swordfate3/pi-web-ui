import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRemotePlan } from "../extensions/remote-access/plan.ts";
import {
  createRemoteAccessDraft,
  remoteAccessDraftReducer,
} from "../src/web/src/components/pi-web-ui/remote-access-draft-state.ts";
import { buildRemoteMaterials } from "../src/web/src/core/remote-access-materials.ts";

function generatedMaterials(plan: ReturnType<typeof defaultRemotePlan>) {
  return buildRemoteMaterials(plan, "import json\nPLAN = None\n");
}

function generate(state: ReturnType<typeof createRemoteAccessDraft>) {
  const sourcePlan = { ...state.plan };
  return remoteAccessDraftReducer(state, {
    type: "materials-generated",
    sourcePlan,
    materials: generatedMaterials(sourcePlan),
  });
}

test("a delayed listener response never overwrites a manually edited local port", () => {
  const initial = createRemoteAccessDraft(defaultRemotePlan());
  const edited = remoteAccessDraftReducer(initial, { type: "edit", field: "localPort", value: 4321 });
  const afterLateResponse = remoteAccessDraftReducer(edited, { type: "listener-port-received", port: 9876 });

  assert.equal(afterLateResponse.plan.localPort, 4321);
  assert.equal(afterLateResponse.localPortEdited, true);
});

test("a delayed listener response invalidates generated materials based on the old default port", () => {
  const initial = createRemoteAccessDraft(defaultRemotePlan());
  const withMaterials = generate(initial);
  assert.ok(withMaterials.materials.length > 0);

  const afterLateResponse = remoteAccessDraftReducer(withMaterials, { type: "listener-port-received", port: 9876 });

  assert.equal(afterLateResponse.plan.localPort, 9876);
  assert.deepEqual(afterLateResponse.materials, []);
});

test("a reconnect reporting a different port invalidates materials and regeneration uses the new port", () => {
  const initial = createRemoteAccessDraft(defaultRemotePlan());
  const firstMaterials = generate(initial);
  const afterReconnect = remoteAccessDraftReducer(firstMaterials, { type: "listener-port-received", port: 4567 });

  assert.equal(afterReconnect.plan.localPort, 4567);
  assert.deepEqual(afterReconnect.materials, []);

  const regenerated = generate(afterReconnect);
  assert.ok(regenerated.materials.length > 0);
  const connectionPlan = regenerated.materials.find((material) => material.name === "connection-plan.json");
  assert.ok(connectionPlan);
  assert.equal(JSON.parse(connectionPlan.content).localPort, 4567);
});

test("late material generation is ignored after the port plan changes", () => {
  const initial = createRemoteAccessDraft(defaultRemotePlan());
  const edited = remoteAccessDraftReducer(initial, { type: "edit", field: "localPort", value: 4321 });
  const lateGeneration = remoteAccessDraftReducer(edited, {
    type: "materials-generated",
    sourcePlan: initial.plan,
    materials: generatedMaterials(initial.plan),
  });

  assert.deepEqual(lateGeneration.materials, []);
  assert.equal(lateGeneration.plan.localPort, 4321);
});

test("an unchanged listener report preserves current materials", () => {
  const generated = generate(createRemoteAccessDraft(defaultRemotePlan()));
  const afterResponse = remoteAccessDraftReducer(generated, { type: "listener-port-received", port: 3001 });

  assert.equal(afterResponse, generated);
  assert.ok(afterResponse.materials.length > 0);
});
