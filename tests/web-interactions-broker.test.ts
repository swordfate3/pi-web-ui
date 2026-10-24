import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { InteractionBroker } from "../extensions/interactions/broker.ts";
import { signInteractionEvidence, type InteractionClaim } from "../extensions/interactions/proof.ts";
import type { InteractionRequest } from "../extensions/interactions/protocol.ts";

const identity = { runId: "a".repeat(32), generation: "b".repeat(32), runtimeId: "runtime-1", sessionId: "session-1" };
const manifest = { id: "scoped-memory", version: "1.0.0", packageName: "pi-scoped-memory", actions: { write: { classification: "sensitive" as const, method: "confirm" as const } } };
const spec = () => ({ action: "write", revision: "prepared-17", classification: "sensitive" as const, method: "confirm" as const, schema: { kind: "confirm" as const }, content: { preview: "private memory" }, deadline: 100_000 });
function setup() {
  let now = 1000;
  const keys = generateKeyPairSync("ed25519");
  const broker = new InteractionBroker(identity, { pin: { issuer: "hub-key-1", publicKey: keys.publicKey }, now: () => now });
  const adapter = broker.registerAdapter(manifest);
  const challenge = broker.issueControlChallenge();
  const sign = (kind: InteractionClaim["kind"], payload: InteractionClaim["payload"], nonce = challenge) => signInteractionEvidence(keys.privateKey, {
    protocol: "pi-web-interactions-v1", audience: "pi-interaction-broker", kind, identity,
    issuer: "hub-key-1", epoch: "c".repeat(32), challenge: nonce, issuedAt: now, expiresAt: now + 5000, payload,
  });
  const control = broker.connectControl(challenge, sign("control", {}));
  const decision = (request: InteractionRequest, answer: boolean, overrides = {}) => sign("decision", {
    requestId: request.requestId, operationId: request.operationId, adapterId: request.adapter.id,
    adapterVersion: request.adapter.version, revision: request.revision, digest: request.digest,
    decisionId: "d".repeat(32), answer, ...overrides,
  });
  return { broker, adapter, control, sign, decision, clock: (value: number) => { now = value; } };
}

test("a trusted Web winner cancels local UI before resuming the source exactly once", async () => {
  const s = setup();
  let cancelled = false;
  let localResolve: (answer: boolean) => void = () => {};
  const source = s.adapter.request(spec(), { isCurrent: () => true, local: (signal) => new Promise<boolean>((resolve) => {
    localResolve = resolve;
    signal.addEventListener("abort", () => { cancelled = true; }, { once: true });
  }) });
  await Promise.resolve();
  assert.equal(s.control.decide(s.decision(source.request, true)), "allowed");
  const result = await source.result;
  assert.equal(cancelled, true);
  assert.deepEqual(result, { state: "allowed", answer: true, winner: "web" });
  localResolve(false);
  await Promise.resolve();
  assert.equal(s.control.decide(s.decision(source.request, true)), "allowed");
  assert.equal(s.broker.pending().length, 0);
  s.broker.close();
});

test("local reject wins over Web approval; completed receipts contain no request or answer bodies", async () => {
  const s = setup();
  const source = s.adapter.request(spec(), { isCurrent: () => true, local: async () => false });
  assert.deepEqual(await source.result, { state: "rejected", answer: false, winner: "local" });
  assert.throws(() => s.control.decide(s.decision(source.request, true)));
  assert.ok(!JSON.stringify(s.broker.completions()).includes("private memory"));
  assert.ok(!JSON.stringify(s.broker.completions()).includes("answer"));
  s.broker.close();
});

test("wrong digest, revision, adapter, schema or unknown decision fields cause zero approval", async () => {
  for (const override of [{ digest: "e".repeat(64) }, { revision: "new-revision" }, { adapterId: "other" }, { answer: "true" }, { approved: true }]) {
    const s = setup();
    const source = s.adapter.request(spec(), { isCurrent: () => true });
    assert.throws(() => s.control.decide(s.decision(source.request, true, override)));
    assert.equal(s.broker.pending().length, 1);
    source.cancel();
    assert.equal((await source.result).state, "cancelled");
    s.broker.close();
  }
});

test("source revision recheck defeats both local and signed stale approval", async () => {
  const s = setup();
  let current = true;
  const source = s.adapter.request(spec(), { isCurrent: () => current });
  current = false;
  assert.equal(s.control.decide(s.decision(source.request, true)), "stale");
  assert.equal((await source.result).state, "stale");
  s.broker.close();
});

test("at most eight pending source operations are admitted; browser cannot downgrade classification", async () => {
  const s = setup();
  const sources = Array.from({ length: 8 }, () => s.adapter.request(spec(), { isCurrent: () => true }));
  assert.throws(() => s.adapter.request(spec(), { isCurrent: () => true }));
  assert.throws(() => s.adapter.request({ ...spec(), classification: "session" }, { isCurrent: () => true }));
  assert.throws(() => s.adapter.request({ ...spec(), action: "unknown" }, { isCurrent: () => true }));
  assert.ok(!JSON.stringify(s.broker.pending()).includes("private memory"));
  s.broker.close();
  assert.ok((await Promise.all(sources.map((source) => source.result))).every((result) => result.state === "cancelled"));
});

test("identity replacement and adapter unload invalidate outstanding resolvers", async () => {
  const s = setup();
  const first = s.adapter.request(spec(), { isCurrent: () => true });
  s.broker.replaceIdentity({ ...identity, sessionId: "new-session" });
  assert.equal((await first.result).state, "stale");
  assert.throws(() => s.control.decide(s.decision(first.request, true)));
  const second = s.adapter.request(spec(), { isCurrent: () => true });
  s.adapter.dispose();
  assert.equal((await second.result).state, "stale");
  assert.throws(() => s.adapter.request(spec(), { isCurrent: () => true }));
  s.broker.close();
});

test("timeout and cancellation settle without waiting for an unresponsive terminal", async () => {
  const s = setup();
  const source = s.adapter.request({ ...spec(), deadline: 1500 }, { isCurrent: () => true, local: () => new Promise(() => {}) });
  s.clock(1500);
  assert.equal(s.broker.pending().length, 0);
  assert.equal((await source.result).state, "expired");
  const signal = new AbortController();
  signal.abort();
  const cancelled = s.adapter.request(spec(), { isCurrent: () => true, signal: signal.signal });
  assert.equal((await cancelled.result).state, "cancelled");
  s.broker.close();
});

test("sensitive reads require signed management proof and channel loss invalidates requests and challenge", async () => {
  const s = setup();
  const source = s.adapter.request(spec(), { isCurrent: () => true });
  assert.throws(() => s.control.read(source.request.requestId, {}));
  const proof = s.sign("read", { requestId: source.request.requestId });
  const read = s.control.read(source.request.requestId, proof);
  assert.equal(read.content.preview, "private memory");
  read.content.preview = "mutated";
  assert.equal(s.control.read(source.request.requestId, proof).content.preview, "private memory");
  s.control.close();
  assert.equal((await source.result).state, "cancelled");
  assert.throws(() => s.control.read(source.request.requestId, proof));
  assert.throws(() => s.broker.connectControl(s.broker.issueControlChallenge(), s.sign("control", {})));
  s.broker.close();
});

test("request/operation/decision replay cannot create another effect and completion state stays bounded", async () => {
  const s = setup();
  let originalId = "";
  for (let i = 0; i < 140; i++) {
    const source = s.adapter.request(spec(), { isCurrent: () => true, operationId: i.toString(16).padStart(32, "0") });
    originalId ||= source.request.requestId;
    s.control.decide(s.decision(source.request, true, { decisionId: i.toString(16).padStart(32, "0") }));
    assert.equal((await source.result).state, "allowed");
    assert.throws(() => s.adapter.request(spec(), { isCurrent: () => true, operationId: source.request.operationId }));
  }
  assert.equal(s.broker.completions().length, 128);
  assert.ok(!s.broker.completions().some((item) => item.requestId === originalId));
  s.clock(302_000);
  assert.equal(s.broker.completions().length, 0);
  s.broker.close();
});

test("without host-pinned authority local operation remains available but Web cannot claim trust", async () => {
  const broker = new InteractionBroker(identity);
  const adapter = broker.registerAdapter(manifest);
  assert.throws(() => broker.connectControl(broker.issueControlChallenge(), {}));
  const source = adapter.request({ ...spec(), deadline: Date.now() + 1000 }, { isCurrent: () => true, local: async () => true });
  assert.equal((await source.result).winner, "local");
  broker.close();
});

test("ordinary session choices bind the full source request and never approve sensitive work", async () => {
  const s = setup();
  assert.equal(typeof s.broker.decideSession, "function");
  const panel = s.broker.registerAdapter({ id: "profiles", version: "1", packageName: "profiles", actions: { choose: { classification: "session", method: "select" } } });
  const operation = panel.request({ action: "choose", revision: "catalog-1", classification: "session", method: "select", schema: { kind: "select", options: ["fast", "careful"] }, content: { title: "Choose profile" }, deadline: 10000 }, { isCurrent: () => true });
  const payload = (request: InteractionRequest, answer: string | boolean) => ({ identity, requestId: request.requestId, operationId: request.operationId, adapterId: request.adapter.id, adapterVersion: request.adapter.version, digest: request.digest, revision: request.revision, decisionId: "e".repeat(32), answer });
  const sensitive = s.adapter.request(spec(), { isCurrent: () => true });
  assert.throws(() => s.broker.decideSession(payload(sensitive.request, true)));
  assert.throws(() => s.broker.decideSession({ ...payload(operation.request, "fast"), digest: "f".repeat(64) }));
  assert.throws(() => s.broker.decideSession({ ...payload(operation.request, "fast"), identity: { ...identity, runtimeId: "other" } }));
  assert.throws(() => s.broker.decideSession(payload(operation.request, "unknown")));
  assert.equal(s.broker.decideSession(payload(operation.request, "careful")), "allowed");
  assert.deepEqual(await operation.result, { state: "allowed", answer: "careful", winner: "web" });
  assert.equal(s.broker.decideSession(payload(operation.request, "careful")), "allowed");
  assert.throws(() => s.broker.decideSession(payload(operation.request, "fast")));
  s.broker.close();
});

test("a real expiry timer aborts an unresponsive local prompt before resolving the source", async () => {
  const broker = new InteractionBroker(identity);
  const adapter = broker.registerAdapter(manifest);
  let aborted = false;
  const source = adapter.request({ ...spec(), deadline: Date.now() + 30 }, { isCurrent: () => true, local: (signal) => { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); } });
  const guard = setTimeout(() => source.cancel(), 2000);
  try { assert.equal((await source.result).state, "expired"); assert.equal(aborted, true); } finally { clearTimeout(guard); broker.close(); }
});
