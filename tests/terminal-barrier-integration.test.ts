import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startPiWebUi } from "../e2e/harness/pi-process.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const runId = "a".repeat(32);
const terminalEpoch = "b".repeat(32);
const token = "c".repeat(64);
async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for isolated fixture");
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-terminal-barrier-real-"));
  const socketPath = path.join(directory, "adapter.sock");
  const env = {
    PI_RUNTIME_RUN_ID: runId,
    PI_RUNTIME_TERMINAL_EPOCH: terminalEpoch,
    PI_RUNTIME_CHILD_TOKEN: token,
    PI_RUNTIME_EXTENSION_SOCKET: socketPath,
    PI_RUNTIME_PROFILE: "web-terminal-v1",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const events: Record<string, unknown>[] = [];
  let harness: Awaited<ReturnType<typeof startPiWebUi>>;
  try {
    harness = await startPiWebUi("basic", {
      repositoryRoot: root,
      git: false,
      extraExtensions: [
        path.join(root, "e2e/fixtures/terminal-prompt-extension.ts"),
        path.join(root, "tests/fixtures/terminal-barrier-extension.ts"),
      ],
      onRpcEvent: (event) => events.push(event),
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const sockets: WebSocket[] = [];
  let sequence = 0;
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
    sockets.push(ws);
    const messages: { type?: string; event?: string; id?: string; ok: boolean; error?: string }[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await waitFor(() => messages.find((message) => message.event === "state_sync"));
    return async (method: string, params: Record<string, unknown> = {}) => {
      const id = String(++sequence);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      return waitFor(() => messages.find((message) => message.type === "res" && message.id === id));
    };
  };
  const adapter = (action: string, expected: object = { runId, terminalEpoch }) =>
    new Promise<{
      ok: boolean;
      result: { runtimeId: string; sessionId: string; adapterInstanceId: string; latched: boolean };
    }>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let data = "";
      socket.setTimeout(2000, () => socket.destroy(new Error("adapter timeout")));
      socket.on("connect", () => socket.end(`${JSON.stringify({ action, token, expected })}\n`));
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("error", reject);
      socket.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
  const identity = async () => {
    const state = (await adapter("terminal-state")).result;
    return { runId, terminalEpoch, runtimeId: state.runtimeId, sessionId: state.sessionId };
  };
  return {
    harness,
    events,
    connect,
    adapter,
    identity,
    async close() {
      for (const socket of sockets) socket.terminate();
      await harness.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("real native dialog permits takeover; two browsers and HTTP cannot mutate; native reload preserves latch", {
  timeout: 60_000,
}, async () => {
  const f = await fixture();
  try {
    const first = await f.connect();
    const second = await f.connect();
    const command = f.harness.rpc({ type: "prompt", message: "/test-terminal-confirm" });
    void command.catch(() => {}); // A failed assertion still shuts down the waiting fixture.
    const dialog = await waitFor(() =>
      f.events.find((e) => e.type === "extension_ui_request" && e.method === "confirm"),
    );
    const before = await f.adapter("terminal-state");
    const identity = await f.identity();
    assert.equal((await f.adapter("terminal-prepare", identity)).result.latched, true);
    for (const request of [first, second]) {
      for (const method of [
        "prompt",
        "steer",
        "follow_up",
        "abort",
        "set_model",
        "cycle_model",
        "set_thinking_level",
        "set_session_name",
        "compact",
        "navigate_tree",
        "submit_message_revision",
        "switch_message_version",
        "reload",
        "fork_session",
        "switch_session",
        "prepare_upload",
        "complete_upload",
        "open_file",
        "set_auth",
        "extension_ui_response",
        "get_future_write",
      ]) {
        const response = await request(method, {
          message: "must not execute",
          name: "must not rename",
          id: dialog.id,
          confirmed: true,
        });
        assert.equal(response.error, "terminal_untracked", method);
      }
      assert.equal((await request("health")).ok, true);
      assert.equal((await request("get_messages")).ok, true);
    }
    assert.equal(
      (await fetch(`http://127.0.0.1:${f.harness.port}/api/uploads/invalid`, { method: "PUT", body: "blocked" }))
        .status,
      409,
    );
    assert.equal(
      f.events.some((e) => e.message === "FIXTURE_APPROVED_BY_RPC"),
      false,
    );
    f.harness.respondToUI(String(dialog.id), false);
    await command;
    await waitFor(() => f.events.find((e) => e.message === "FIXTURE_REJECTED_BY_RPC"));
    await f.harness.rpc({ type: "prompt", message: "/test-barrier-reload" });
    const after = await f.adapter("terminal-state");
    assert.equal(after.result.latched, true);
    assert.notEqual(after.result.adapterInstanceId, before.result.adapterInstanceId);
    assert.equal((await f.adapter("terminal-prepare", identity)).ok, false);
    assert.equal((await (await f.connect())("prompt", { message: "still blocked" })).error, "terminal_untracked");
  } finally {
    await f.close();
  }
});

test("real SDK void browser command ACK and later dialog completion never prove mutation drained", {
  timeout: 60_000,
}, async () => {
  const f = await fixture();
  try {
    const request = await f.connect();
    assert.equal((await request("prompt", { message: "/test-terminal-confirm", executePiCommand: true })).ok, true);
    const dialog = await waitFor(() =>
      f.events.find((e) => e.type === "extension_ui_request" && e.method === "confirm"),
    );
    assert.equal((await f.adapter("terminal-prepare", await f.identity())).ok, false);
    assert.equal((await request("prompt", { message: "must not execute" })).error, "terminal_untracked");
    f.harness.respondToUI(String(dialog.id), false);
    await waitFor(() => f.events.find((e) => e.message === "FIXTURE_REJECTED_BY_RPC"));
    assert.equal((await f.adapter("terminal-prepare", await f.identity())).ok, false);
    await f.harness.rpc({ type: "prompt", message: "/test-barrier-reload" });
    assert.equal((await f.adapter("terminal-prepare", await f.identity())).ok, false);
  } finally {
    await f.close();
  }
});

test("real native agent-turn dialog grants terminal control without core idle qualification", {
  timeout: 60_000,
}, async () => {
  const f = await fixture();
  try {
    const request = await f.connect();
    await f.harness.rpc({ type: "prompt", message: "/test-barrier-arm-turn-dialog" });
    const turn = f.harness.rpc({ type: "prompt", message: "Synthetic isolated fixture turn" });
    void turn.catch(() => {});
    const dialog = await waitFor(() =>
      f.events.find((event) => event.type === "extension_ui_request" && event.method === "confirm"),
    );
    assert.ok(f.events.some((event) => event.message === "FIXTURE_DIALOG_IDLE_false"));
    assert.equal((await f.adapter("terminal-prepare", await f.identity())).result.latched, true);
    assert.equal((await request("abort")).error, "terminal_untracked");
    f.harness.respondToUI(String(dialog.id), false);
    await turn;
    await waitFor(() => f.events.find((event) => event.message === "FIXTURE_TURN_DIALOG_COMPLETED"));
  } finally {
    await f.close();
  }
});
