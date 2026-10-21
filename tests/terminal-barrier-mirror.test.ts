import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(read: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!read()) {
    assert.ok(Date.now() < deadline, "fixture checkpoint timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("real mirror drains admitted HTTP/compaction and cancels deferred model/upload dispatch with fresh context", {
  timeout: 20_000,
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-terminal-mirror-race-"));
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
  type Compaction = { onComplete: (result: { summary: string }) => void; onError: (error: Error) => void };
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  let generation = 0;
  let sessionId = "session-1";
  const models = [
    { provider: "faux", id: "one" },
    { provider: "faux", id: "two" },
  ];
  let model = models[0];
  let getModels = async () => models;
  let getCredentials = async () => ({ ok: true });
  let compactOptions: Compaction | undefined;
  let sends = 0;
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
          return getModels();
        },
        getApiKeyAndHeaders: () => {
          check();
          return getCredentials();
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
      compact: (options: Compaction) => {
        check();
        compactOptions = options;
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
    getCommands: () => [],
    getSettings: () => ({}),
    setModel: async (value: typeof model) => {
      model = value;
      return true;
    },
    sendUserMessage() {
      sends++;
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
    const request = await connect();
    const second = await connect();
    let lookupStarted = false;
    const oldLookup = deferred<typeof models>();
    getModels = () => {
      lookupStarted = true;
      return oldLookup.promise;
    };
    const oldChange = request("set_model", { provider: "faux", modelId: "two" });
    await until(() => lookupStarted);
    generation++;
    sessionId = "session-2";
    await emit("session_start");
    oldLookup.resolve(models);
    assert.equal((await oldChange).ok, false, "old session model lookup must not dispatch into replacement");
    assert.equal(model.id, "one");

    const snapshot = (await request("get_messages")).result;
    const scope = { sessionId, runtimeId: snapshot.runtimeId };
    const expected = { runId: env.PI_RUNTIME_RUN_ID, terminalEpoch: env.PI_RUNTIME_TERMINAL_EPOCH, ...scope };
    const upload = await request("prepare_upload", { ...scope, filename: "input.txt", size: 3 });
    assert.equal(upload.ok, true);
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/uploads/${upload.result.uploadId}`, {
      method: "PUT",
      headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/octet-stream" },
      body: "abc",
    }).catch((error: Error) => {
      throw new Error(`Upload fixture transport failed: ${String(error.cause)}`, { cause: error });
    });
    assert.equal(uploaded.status, 200);
    let credentialsStarted = false;
    const credentials = deferred<{ ok: boolean }>();
    getCredentials = () => {
      credentialsStarted = true;
      return credentials.promise;
    };
    const send = request("prompt", { ...scope, message: "attachment", uploads: [upload.result.uploadId] });
    await until(() => credentialsStarted);

    lookupStarted = false;
    let lookupCount = 0;
    const lookup = deferred<typeof models>();
    getModels = () => {
      lookupCount++;
      lookupStarted = true;
      return lookup.promise;
    };
    const change = request("set_model", { provider: "faux", modelId: "two" });
    const cycle = second("cycle_model");
    await until(() => lookupCount === 2);
    assert.equal((await second("compact")).ok, true);
    assert.ok(compactOptions);
    const pendingUpload = await second("prepare_upload", { ...scope, filename: "partial.txt", size: 6 });
    assert.equal(pendingUpload.ok, true);
    let httpRequest!: http.ClientRequest;
    const httpResult = new Promise<number>((resolve) => {
      httpRequest = http.request(
        `http://127.0.0.1:${port}/api/uploads/${pendingUpload.result.uploadId}`,
        {
          method: "PUT",
          headers: {
            Origin: `http://127.0.0.1:${port}`,
            "Content-Length": "6",
            "Content-Type": "application/octet-stream",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
          res.on("error", () => resolve(0));
        },
      );
      httpRequest.on("error", () => resolve(0));
      httpRequest.setTimeout(3000, () => httpRequest.destroy());
      httpRequest.write("abc");
    });
    const partialPath = path.join(directory, path.dirname(pendingUpload.result.relativePath), ".partial");
    await until(() => existsSync(partialPath) && statSync(partialPath).size === 3);
    assert.equal((await adapter("terminal-prepare", expected)).ok, false);
    assert.equal((await second("abort")).error, "terminal_untracked");
    lookup.resolve(models);
    credentials.resolve({ ok: true });
    httpRequest.end("def");
    assert.equal((await change).error, "terminal_untracked");
    assert.equal((await cycle).error, "terminal_untracked");
    assert.equal((await send).ok, false);
    assert.notEqual(await httpResult, 200);
    assert.equal(existsSync(path.join(directory, pendingUpload.result.relativePath)), false);
    assert.equal(model.id, "one", "neither delayed model operation reaches the sink");
    assert.equal(sends, 0, "attachment preflight cannot dispatch after takeover");
    assert.equal((await adapter("terminal-prepare", expected)).ok, false, "compaction ACK is not completion");
    generation++; // New event context within the same session; compact closure is stale.
    await emit("turn_start");
    compactOptions.onComplete({ summary: "done" });
    assert.equal((await request("get_messages")).ok, true, "compact callback must not restore its stale context");
    assert.equal((await adapter("terminal-prepare", expected)).result.latched, true);
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
