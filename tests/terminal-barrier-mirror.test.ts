import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { childTerminalBarrier } from "../extensions/terminal-barrier.ts";

async function until(read: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!read()) {
    assert.ok(Date.now() < deadline, "fixture checkpoint timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real mirror rejects startup browser mutations before preflight, SDK and upload effects across contexts", {
  timeout: 20_000,
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-terminal-mirror-race-"));
  mkdirSync(path.join(directory, "terminal"));
  for (const file of ["index.html", "app.js", "app.css"])
    writeFileSync(path.join(directory, "terminal", file), "terminal-only");
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = {
    PI_WEB_UI_PORT: String(port),
    PI_WEB_UI_HOST: "127.0.0.1",
    PI_WEB_UI_DISABLED: "1",
    PI_WEB_UI_STATIC_DIR: directory,
    PI_CODING_AGENT_DIR: directory,
    PI_WEB_UI_REGISTRY_SOCKET: "",
    PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: "",
    PI_WEB_UI_PUBLIC_URL: "",
    PI_RUNTIME_PROFILE: "web-terminal-v1",
    PI_RUNTIME_RUN_ID: "a".repeat(32),
    PI_RUNTIME_TERMINAL_EPOCH: "b".repeat(32),
    PI_RUNTIME_CHILD_TOKEN: "c".repeat(64),
    PI_RUNTIME_EXTENSION_SOCKET: path.join(directory, "adapter.sock"),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  type Handler = (event: unknown, ctx: ReturnType<typeof context>) => unknown;
  type Command = { handler: (args: string, ctx: ReturnType<typeof context>) => unknown };
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  let generation = 0;
  let sessionId = "session-1";
  const models = [
    { provider: "faux", id: "one" },
    { provider: "faux", id: "two" },
  ];
  const model = models[0];
  const effects: string[] = [];
  const context = () => {
    const ownGeneration = generation;
    const check = () => assert.equal(ownGeneration, generation, "stale SDK context was accessed");
    return {
      cwd: directory,
      get model() {
        check();
        return model;
      },
      modelRegistry: {
        getAvailable: () => {
          check();
          effects.push("model lookup");
          return models;
        },
        getApiKeyAndHeaders: () => {
          check();
          effects.push("credentials");
          return { ok: true };
        },
      },
      ui: { notify() {}, setStatus() {} },
      isIdle: () => {
        check();
        return true;
      },
      hasPendingMessages: () => {
        check();
        return false;
      },
      getContextUsage: () => {
        check();
        return undefined;
      },
      compact: () => {
        check();
        effects.push("compact");
      },
      sessionManager: {
        getSessionId: () => {
          check();
          return sessionId;
        },
        getLeafId: () => {
          check();
          return null;
        },
        getSessionDir: () => {
          check();
          return directory;
        },
        getSessionFile: () => {
          check();
          return undefined;
        },
        getEntries: () => {
          check();
          return [];
        },
        getBranch: () => {
          check();
          return [];
        },
        getTree: () => {
          check();
          return [];
        },
      },
    };
  };
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of events.get(name) ?? []) await handler(event, context());
  };
  const pi = {
    on(name: string, callback: Handler) {
      events.set(name, [...(events.get(name) ?? []), callback]);
    },
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    getThinkingLevel: () => "off",
    getSessionName: () => "fixture",
    setSessionName() {
      effects.push("session name");
    },
    getCommands: () => [],
    getSettings: () => ({}),
    setModel: async () => {
      effects.push("set model");
      return true;
    },
    sendUserMessage() {
      effects.push("send");
    },
  };
  const module = "../extensions/mirror-server.ts";
  const sockets: WebSocket[] = [];
  let sequence = 0;
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const messages: {
      type?: string;
      event?: string;
      id?: string;
      ok: boolean;
      error?: string;
      result: { runtimeId: string; uploadId: string; relativePath: string };
    }[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await until(() => messages.some((message) => message.event === "state_sync"));
    const initial = messages.find((message) => message.event === "state_sync") as unknown as {
      payload: { browserInputPolicy: unknown };
    };
    assert.equal(
      initial.payload.browserInputPolicy,
      "terminal-readonly",
      "startup display is independent of successful prepare",
    );
    return async (method: string, params: object = {}) => {
      const id = String(++sequence);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      await until(() => messages.some((message) => message.id === id && message.type === "res"));
      const response = messages.find((message) => message.id === id && message.type === "res");
      assert.ok(response);
      return response;
    };
  };
  const adapter = (action: string, expected: object) =>
    new Promise<{ ok: boolean; result: { latched: boolean } }>((resolve, reject) => {
      const socket = net.createConnection(env.PI_RUNTIME_EXTENSION_SOCKET);
      let data = "";
      socket.on("connect", () =>
        socket.end(`${JSON.stringify({ action, expected, token: env.PI_RUNTIME_CHILD_TOKEN })}\n`),
      );
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
  try {
    (await import(module)).default(pi);
    await emit("session_start");
    const start = commands.get("webui-start");
    assert.ok(start);
    await start.handler("", context());
    for (const route of ["/terminal/index.html", "/terminal/app.js", "/terminal/app.css", "//terminal/app.js"]) {
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}${route}`)).status,
        404,
        "terminal assets must not be served by chat",
      );
    }
    const request = await connect();
    const second = await connect();
    const diskBefore = readdirSync(directory, { recursive: true }).sort();
    const baseline = effects.length;
    for (const ask of [request, second]) {
      for (const method of [
        "prompt",
        "steer",
        "follow_up",
        "abort",
        "enter_arch_mode",
        "exit_arch_mode",
        "set_model",
        "cycle_model",
        "cycle_thinking_level",
        "set_thinking_level",
        "set_session_name",
        "set_auto_compaction",
        "compact",
        "export_html",
        "switch_session",
        "reload",
        "fork_session",
        "navigate_tree",
        "submit_message_revision",
        "switch_message_version",
        "set_auth",
        "prepare_upload",
        "complete_upload",
        "prepare_file_download",
        "open_file",
        "extension_ui_response",
        "get_future_write",
        "arbitrary_extension_command",
      ]) {
        const response = await ask(method, {
          message: "/arbitrary-command",
          executePiCommand: true,
          provider: "faux",
          modelId: "two",
          name: "not renamed",
          filename: "input.txt",
          size: 3,
          filePath: directory,
          uploads: ["untrusted"],
          confirmed: true,
        });
        assert.equal(response.error, "terminal_untracked", method);
      }
      assert.equal((await ask("health")).ok, true);
      assert.equal((await ask("get_messages")).ok, true);
    }
    assert.deepEqual(effects.slice(baseline), [], "no SDK mutation or async model/credential preflight");
    for (const suffix of ["", "/invalid", "?uploadId=invalid"]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/uploads${suffix}`, {
        method: "PUT",
        headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/octet-stream" },
        body: "abc",
      });
      assert.equal(response.status, 409, suffix);
    }
    assert.deepEqual(
      readdirSync(directory, { recursive: true }).sort(),
      diskBefore,
      "no upload directory or file effects",
    );
    const snapshot = (await request("get_messages")).result;
    const expected = {
      runId: env.PI_RUNTIME_RUN_ID,
      terminalEpoch: env.PI_RUNTIME_TERMINAL_EPOCH,
      sessionId,
      runtimeId: snapshot.runtimeId,
    };
    assert.equal((await adapter("terminal-state", expected)).result.latched, false);
    // Internal accounting remains genuine even though browsers cannot create it.
    const finish = childTerminalBarrier().enter();
    assert.equal((await adapter("terminal-prepare", expected)).ok, false);
    assert.equal(childTerminalBarrier().latched, false);
    assert.equal(
      (await second("prompt", { message: "still readonly after failed prepare" })).error,
      "terminal_untracked",
    );
    finish();
    generation++;
    sessionId = "session-2";
    await emit("session_start");
    assert.equal((await request("set_model", { provider: "faux", modelId: "two" })).error, "terminal_untracked");
    const current = { ...expected, sessionId };
    assert.equal((await adapter("terminal-prepare", expected)).ok, false, "old identity stays fenced");
    assert.equal((await adapter("terminal-prepare", current)).result.latched, true);
    assert.equal((await request("get_messages")).ok, true, "fresh context remains readable");
    assert.equal((await second("prompt", { message: "latched too" })).error, "terminal_untracked");
    assert.deepEqual(effects.slice(baseline), []);
  } finally {
    for (const ws of sockets) ws.terminate();
    await emit("session_shutdown", { reason: "quit" });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
