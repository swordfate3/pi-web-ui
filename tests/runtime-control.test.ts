import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import "../extensions/runtime-stdin-guard.mjs";
import { type RuntimeSnapshot, startRuntimeControl } from "../extensions/runtime-control.ts";
import { childTerminalBarrier } from "../extensions/terminal-barrier.ts";

const token = "a".repeat(64);
const operation = "b".repeat(32);
async function fixture(terminal = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-runtime-adapter-"));
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, "saved\n");
  let snapshot: RuntimeSnapshot = {
    run_id: "c".repeat(32),
    runtime_id: "runtime-1",
    session_id: "session-1",
    leaf_id: "leaf-1",
    session_file: file,
    cwd: directory,
    version: "1.1.0",
    idle: true,
    pending: false,
    busy: false,
    provider: "faux",
    model: "faux-1",
    thinking: "off",
  };
  const socket = path.join(directory, "extension.sock");
  const adapter = await startRuntimeControl(
    {
      PI_RUNTIME_RUN_ID: snapshot.run_id,
      PI_RUNTIME_CHILD_TOKEN: token,
      PI_RUNTIME_EXTENSION_SOCKET: socket,
      ...(terminal ? { PI_RUNTIME_PROFILE: "web-terminal-v1", PI_RUNTIME_TERMINAL_EPOCH: "e".repeat(32) } : {}),
    },
    () => snapshot,
  );
  assert.ok(adapter);
  const request = (value: Record<string, unknown>) =>
    new Promise<{ ok: boolean; result: RuntimeSnapshot & { adapterInstanceId: string; latched: boolean } }>(
      (resolve, reject) => {
        const client = net.createConnection(socket);
        let data = "";
        client.on("connect", () => client.end(`${JSON.stringify({ token, ...value })}\n`));
        client.on("data", (chunk) => {
          data += chunk;
        });
        client.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
        client.on("error", reject);
      },
    );
  return {
    directory,
    adapter,
    request,
    set: (value: Partial<RuntimeSnapshot>) => {
      snapshot = { ...snapshot, ...value };
    },
    close: async () => {
      await adapter.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("terminal adapter authenticates exact live identity, drains browser work, survives replacement, and never restart-prepares", async () => {
  let f = await fixture(true);
  const expected = {
    runId: "c".repeat(32),
    terminalEpoch: "e".repeat(32),
    runtimeId: "runtime-1",
    sessionId: "session-1",
  };
  const state = { action: "terminal-state", expected };
  const prepare = { action: "terminal-prepare", expected };
  try {
    f.set({ idle: false, pending: true, busy: true, session_file: null, version: "unaudited" });
    const discovery = await f.request({
      action: "terminal-state",
      expected: { runId: expected.runId, terminalEpoch: expected.terminalEpoch },
    });
    assert.equal(discovery.ok, true);
    assert.deepEqual(Object.keys(discovery.result).sort(), [
      "adapterInstanceId",
      "latched",
      "runId",
      "runtimeId",
      "sessionId",
      "terminalEpoch",
    ]);
    assert.equal(discovery.result.latched, false);
    assert.match(discovery.result.adapterInstanceId, /^[a-f0-9]{32}$/);
    for (const invalid of [
      { ...prepare, token: "d".repeat(64) },
      { ...prepare, expected: { runId: expected.runId, terminalEpoch: expected.terminalEpoch } },
      { ...prepare, expected: { ...expected, sessionId: "old" } },
      { ...state, expected: { ...expected, terminalEpoch: "f".repeat(32) } },
      { ...state, extra: true },
    ])
      assert.equal((await f.request(invalid)).ok, false);
    const barrier = childTerminalBarrier();
    assert.equal(barrier.blocked, false);
    const finish = barrier.enter();
    const started = performance.now();
    assert.equal((await f.request(prepare)).ok, false);
    assert.ok(performance.now() - started < 500, "failed drain must fit the broker handshake budget");
    const stillWritable = barrier.enter();
    stillWritable();
    assert.equal((await f.request(state)).result.latched, false);
    finish();

    const staleFinish = barrier.enter();
    const stalePrepare = f.request(prepare);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(barrier.blocked, true, "admission pauses while preparation is pending");
    f.set({ session_id: "session-2" });
    staleFinish();
    assert.equal((await stalePrepare).ok, false, "identity must be rechecked before committing");
    assert.equal(barrier.blocked, false);
    f.set({ session_id: "session-1" });

    const drained = barrier.enter();
    const preparing = f.request(prepare);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(barrier.blocked, true);
    assert.equal(barrier.latched, false);
    drained();
    assert.equal((await preparing).result.latched, true);
    assert.equal((await f.request(state)).result.latched, true);
    assert.equal(
      (
        await f.request({
          action: "prepare",
          operation_id: operation,
          expected: { runtime_id: "runtime-1", session_id: "session-1", leaf_id: "leaf-1" },
        })
      ).ok,
      false,
    );
    assert.equal((await f.request({ action: "snapshot" })).result.busy, true);
    f.set({ session_id: "session-2" });
    assert.equal((await f.request(state)).ok, false);
    await f.close();
    f = await fixture(true);
    const replacement = await f.request(state);
    assert.equal(replacement.result.latched, true);
    assert.notEqual(replacement.result.adapterInstanceId, discovery.result.adapterInstanceId);
    assert.throws(() => childTerminalBarrier().enter(), /terminal_untracked/);
  } finally {
    await f.close();
  }
});

test("runtime IPC is opt-in and rejects partially configured supervision", async () => {
  assert.equal(await startRuntimeControl({}, () => null), undefined);
  await assert.rejects(startRuntimeControl({ PI_RUNTIME_CHILD_TOKEN: token }, () => null));
});

test("only the current child token can read a fresh runtime snapshot", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request({ action: "snapshot", token: "d".repeat(64) })).ok, false);
    assert.equal((await f.request({ action: "snapshot" })).result.runtime_id, "runtime-1");
    f.set({ runtime_id: "runtime-2", session_id: "session-2" });
    assert.equal((await f.request({ action: "snapshot" })).result.session_id, "session-2");
    assert.equal(statSync(path.join(f.directory, "extension.sock")).mode & 0o077, 0);
  } finally {
    await f.close();
  }
});

test("prepare freezes one exact saved session and only a matching cancel releases it", async () => {
  const f = await fixture();
  try {
    const expected = { runtime_id: "runtime-1", session_id: "session-1", leaf_id: "leaf-1" };
    const prepare = { action: "prepare", operation_id: operation, expected };
    assert.equal((await f.request({ ...prepare, expected: { ...expected, leaf_id: "other" } })).ok, false);
    assert.equal(f.adapter.prepared, false);
    assert.equal((await f.request(prepare)).ok, true);
    assert.equal(f.adapter.prepared, true);
    assert.equal((await f.request(prepare)).ok, true);
    assert.equal((await f.request({ ...prepare, operation_id: "e".repeat(32) })).ok, false);
    assert.equal((await f.request({ action: "cancel", operation_id: "f".repeat(32) })).ok, false);
    assert.equal(f.adapter.prepared, true);
    assert.equal((await f.request({ action: "cancel", operation_id: operation })).ok, true);
    assert.equal(f.adapter.prepared, false);
  } finally {
    await f.close();
  }
});

test("audited Pi 1.3.0 can prepare while unknown versions stay blocked", async () => {
  const f = await fixture();
  try {
    f.set({ version: "1.3.0" });
    assert.equal((await f.request({ action: "snapshot" })).result.busy, false);
    const expected = { runtime_id: "runtime-1", session_id: "session-1", leaf_id: "leaf-1" };
    assert.equal((await f.request({ action: "prepare", operation_id: operation, expected })).ok, true);
    assert.equal((await f.request({ action: "cancel", operation_id: operation })).ok, true);
    f.set({ version: "99.0.0" });
    assert.equal((await f.request({ action: "snapshot" })).result.busy, true);
    assert.equal((await f.request({ action: "prepare", operation_id: operation, expected })).ok, false);
  } finally {
    await f.close();
  }
});

for (const state of [{ idle: false }, { pending: true }, { busy: true }, { session_file: null }]) {
  test(`prepare refuses unsafe state ${JSON.stringify(state)}`, async () => {
    const f = await fixture();
    try {
      f.set(state);
      const reply = await f.request({
        action: "prepare",
        operation_id: operation,
        expected: { runtime_id: "runtime-1", session_id: "session-1", leaf_id: "leaf-1" },
      });
      assert.equal(reply.ok, false);
      assert.equal(f.adapter.prepared, false);
      assert.ok(!JSON.stringify(reply).includes(f.directory));
    } finally {
      await f.close();
    }
  });
}

test("snapshot failures are generic and close removes only the owned socket", async () => {
  const f = await fixture();
  const saved = readFileSync(path.join(f.directory, "session.jsonl"), "utf8");
  f.set({ version: "\nsecret" });
  assert.equal((await f.request({ action: "snapshot" })).ok, false);
  await f.adapter.close();
  assert.equal(readFileSync(path.join(f.directory, "session.jsonl"), "utf8"), saved);
  rmSync(f.directory, { recursive: true, force: true });
});
