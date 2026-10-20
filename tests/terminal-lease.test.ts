import assert from "node:assert/strict";
import { test } from "node:test";
import type { TerminalBinding, TerminalTarget } from "../hub/terminal-contract.ts";
import { parseTerminalInput, parseTerminalTarget } from "../hub/terminal-contract.ts";
import { TerminalLeaseState } from "../hub/terminal-lease.ts";

const target: TerminalTarget = {
  v: 1,
  runId: "a".repeat(32),
  runtimeId: "fixture-runtime",
  sessionId: "fixture-session",
  terminalEpoch: "b".repeat(32),
  profile: "web-terminal-v1",
  inputState: "local",
  managedRestartEligible: false,
};
const binding: TerminalBinding = { authorizationId: "c".repeat(32), connectionId: "d".repeat(32) };
const other = { ...binding, connectionId: "e".repeat(32) };
function fixture() {
  let time = 100;
  const state = new TerminalLeaseState(target, () => time);
  state.yieldLocal();
  const lease = state.grant(binding, target);
  const frame = (sequence = 1, data = "fixture input") => ({
    v: 1,
    type: "input",
    terminalEpoch: target.terminalEpoch,
    leaseId: lease.leaseId,
    sequence,
    data,
  });
  return { state, lease, frame, setTime: (value: number) => (time = value) };
}

test("target parser is exact, defensive, and does not grant trust or remote ownership", () => {
  const copy = parseTerminalTarget(target);
  copy.runtimeId = "changed";
  assert.equal(target.runtimeId, "fixture-runtime");
  for (const invalid of [
    null,
    [],
    { ...target, v: 2 },
    { ...target, runId: "not a run" },
    { ...target, sessionId: "\n" },
    { ...target, runtimeId: "x".repeat(257) },
    { ...target, terminalEpoch: "" },
    { ...target, profile: "inherited-tui" },
    { ...target, managedRestartEligible: true },
    { ...target, inputState: "yes" },
    { ...target, command: "arbitrary shell" },
    { ...target, socketPath: "/arbitrary/path" },
  ])
    assert.throws(() => parseTerminalTarget(invalid), /Invalid terminal target/);
  for (const inputState of ["remote", "fenced"])
    assert.throws(() => new TerminalLeaseState({ ...target, inputState }), /must start local or unowned/);
});

test("input parser enforces UTF-8 byte budget, valid Unicode and exact schema", () => {
  const { frame } = fixture();
  assert.equal(parseTerminalInput(frame(1, "x".repeat(8192))).data.length, 8192);
  assert.equal(parseTerminalInput(frame(1, "中".repeat(2730))).data.length, 2730);
  for (const invalid of [
    frame(1, "x".repeat(8193)),
    frame(1, "中".repeat(2731)),
    frame(1, "\ud800"),
    frame(1, ""),
    frame(0),
    frame(-1),
    frame(1.5),
    frame(NaN),
    frame(Infinity),
    frame(Number.MAX_SAFE_INTEGER + 1),
    { ...frame(), sequence: "1" },
    { ...frame(), v: 2 },
    { ...frame(), type: "resize" },
    { ...frame(), leaseId: "bad" },
    { ...frame(), confirmed: true },
  ])
    assert.throws(() => parseTerminalInput(invalid), /Invalid terminal input/);
});

test("local writer must explicitly yield; one remote binding owns input at a time", () => {
  const state = new TerminalLeaseState(target);
  assert.throws(() => state.grant(binding, target), /control rejected/);
  state.yieldLocal();
  assert.throws(() => state.yieldLocal(), /does not own/);
  for (const key of ["runId", "runtimeId", "sessionId", "terminalEpoch"])
    assert.throws(() => state.grant(binding, { ...target, [key]: "wrong" }), /control rejected/);
  assert.throws(() => state.grant({ ...binding, connectionId: "bad" }, target), /control rejected/);
  state.grant(binding, target);
  assert.throws(() => state.grant(other, target), /control rejected/);
  assert.equal(state.snapshot().inputState, "remote");
  assert.equal(state.snapshot().managedRestartEligible, false);
});

test("successive frames consume once; replay fences the writer and bytes are never queued", () => {
  const { state, frame } = fixture();
  assert.equal(state.consume(binding, target, frame()), "fixture input");
  assert.equal(state.consume(binding, target, frame(2, "\r")), "\r");
  assert.throws(() => state.consume(binding, target, frame(2, "\r")), /input rejected/);
  assert.equal(state.snapshot().inputState, "none");
  assert.throws(() => state.consume(binding, target, frame(3)), /input rejected/);
});

test("active writer malformed, out-of-order and wrong-target frames revoke control", () => {
  for (const invalid of [
    (frame: ReturnType<typeof fixture>["frame"]) => frame(2),
    (frame: ReturnType<typeof fixture>["frame"]) => ({ ...frame(), terminalEpoch: "f".repeat(32) }),
    (frame: ReturnType<typeof fixture>["frame"]) => ({ ...frame(), leaseId: "f".repeat(32) }),
    () => ({ arbitrary: "PRIVATE_INPUT_MARKER" }),
  ]) {
    const { state, frame } = fixture();
    assert.throws(() => state.consume(binding, target, invalid(frame)), /^Error: Terminal input rejected$/);
    assert.equal(state.snapshot().inputState, "none");
  }
  for (const key of ["runId", "runtimeId", "sessionId", "terminalEpoch"]) {
    const { state, frame } = fixture();
    assert.throws(() => state.consume(binding, { ...target, [key]: "wrong" }, frame()), /input rejected/);
    assert.equal(state.snapshot().inputState, "none");
  }
});

test("unrelated connections or authorization generations cannot write or revoke active lease", () => {
  const { state, frame } = fixture();
  for (const stale of [other, { ...binding, authorizationId: "e".repeat(32) }]) {
    assert.throws(() => state.consume(stale, target, frame()), /input rejected/);
    state.revoke(stale);
    assert.equal(state.snapshot().inputState, "remote");
  }
  assert.equal(state.consume(binding, target, frame()), "fixture input");
});

test("disconnect/revocation is immediate and reconnect needs new explicit lease", () => {
  const { state, lease, frame } = fixture();
  state.revoke(binding);
  assert.equal(state.snapshot().inputState, "none");
  assert.throws(() => state.consume(binding, target, frame()), /input rejected/);
  const next = state.grant(other, target);
  assert.notEqual(next.leaseId, lease.leaseId);
  assert.throws(() => state.consume(binding, target, frame()), /input rejected/);
  assert.equal(state.snapshot().inputState, "remote", "old socket cannot revoke new writer");
  assert.equal(state.consume(other, target, { ...frame(), leaseId: next.leaseId }), "fixture input");
});

test("local reclaim revokes remote before local ownership and never revives old keys", () => {
  const { state, frame } = fixture();
  state.reclaimLocal();
  assert.equal(state.snapshot().inputState, "local");
  assert.throws(() => state.consume(binding, target, frame()), /input rejected/);
  state.yieldLocal();
  const next = state.grant(binding, target);
  assert.notEqual(next.leaseId, frame().leaseId);
});

test("lease expires exactly at deadline and activity never silently extends permission", () => {
  const { state, frame, setTime, lease } = fixture();
  setTime(100 + lease.expiresInMs - 1);
  assert.equal(state.consume(binding, target, frame()), "fixture input");
  setTime(100 + lease.expiresInMs);
  assert.throws(() => state.consume(binding, target, frame(2)), /input rejected/);
  assert.equal(state.snapshot().inputState, "none");
});

test("clock failure or reversal permanently fences the model", () => {
  for (const time of [99, NaN, Infinity, -Infinity]) {
    const { state, frame, setTime } = fixture();
    setTime(time);
    assert.throws(() => state.consume(binding, target, frame()), /clock unavailable/);
    setTime(200);
    assert.equal(state.snapshot().inputState, "fenced");
    assert.throws(() => state.grant(binding, target), /control rejected/);
  }
});

test("identity loss, adapter loss and restart freeze are terminal, including local ownership", () => {
  const { state, frame } = fixture();
  state.freeze();
  state.freeze();
  assert.equal(state.snapshot().inputState, "fenced");
  assert.throws(() => state.consume(binding, target, frame()), /input rejected/);
  assert.throws(() => state.grant(binding, target), /control rejected/);
  assert.throws(() => state.reclaimLocal(), /fenced/);
  assert.throws(() => state.yieldLocal(), /does not own/);
  const local = new TerminalLeaseState(target);
  local.freeze();
  assert.throws(() => local.reclaimLocal(), /fenced/);
});

test("target and binding mutations after construction/grant cannot alter stored ownership", () => {
  const mutableTarget = { ...target, inputState: "none" as const };
  const state = new TerminalLeaseState(mutableTarget);
  const mutableBinding = { ...binding };
  const lease = state.grant(mutableBinding, target);
  mutableTarget.runId = "changed";
  mutableBinding.connectionId = "changed";
  const snapshot = state.snapshot();
  snapshot.runtimeId = "changed";
  assert.equal(state.snapshot().runId, target.runId);
  assert.equal(state.snapshot().runtimeId, target.runtimeId);
  assert.equal(
    state.consume(binding, target, {
      v: 1,
      type: "input",
      terminalEpoch: target.terminalEpoch,
      leaseId: lease.leaseId,
      sequence: 1,
      data: "fixture input",
    }),
    "fixture input",
  );
});
