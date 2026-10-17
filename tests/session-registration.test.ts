import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WebSocket } from "ws";
import {
  createSessionRegistration,
  guardSessionRequest,
  SessionRegistration,
} from "../extensions/session-registration.ts";

const credential = { run_id: "a".repeat(32), token: "b".repeat(64) };
const proof = (text: string) => createHmac("sha256", credential.token).update(text).digest("hex");
type Request = typeof credential & { action: string; generation: string; port?: number; sessionName?: string | null };

async function registry(t: test.TestContext, reply: (request: Request, socket: net.Socket) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-register-"));
  const socketPath = path.join(dir, "r.sock");
  const credentialFile = path.join(dir, "capability.json");
  writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const sockets = new Set<net.Socket>();
  const requests: Request[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]) as Request;
      requests.push(request);
      reply(request, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, credentialFile, requests };
}

test("register and unregister speak the existing capability protocol with the actual port", async (t) => {
  const fixture = await registry(t, (request, socket) =>
    socket.end(
      `${JSON.stringify({
        ok: true,
        result: request.action === "register" ? { url: `https://gateway.example/s/${request.generation}/` } : {},
      })}\n`,
    ),
  );
  const lifecycle = createSessionRegistration(fixture);
  let url: string | null = null;
  await lifecycle.start(43210, (value) => {
    url = value;
  });
  assert.match(String(url), /^https:\/\/gateway\.example\/s\/[0-9a-f]{32}\/$/);
  assert.equal(fixture.requests[0].run_id, credential.run_id);
  assert.equal(fixture.requests[0].token, credential.token);
  assert.equal(fixture.requests[0].port, 43210);
  await lifecycle.stop();
  assert.equal(fixture.requests[1].action, "unregister");
  assert.equal(fixture.requests[1].generation, fixture.requests[0].generation);
});

test("managed runtime identity renews from a fresh getter without exposing saved paths", async (t) => {
  const fixture = await registry(t, (_request, socket) => socket.end('{"ok":true,"result":{}}\n'));
  const lifecycle = createSessionRegistration(fixture);
  let sessionId = "saved-a";
  await lifecycle.start(
    43210,
    () => {},
    () => null,
    () => ({
      runtimeId: "runtime-a",
      sessionId,
      leafId: null,
      version: "1.1.0",
      managed: true,
    }),
  );
  assert.deepEqual((fixture.requests[0] as any).runtime, {
    runtimeId: "runtime-a",
    sessionId: "saved-a",
    leafId: null,
    version: "1.1.0",
    managed: true,
  });
  sessionId = "saved-b";
  await lifecycle.refresh();
  assert.equal((fixture.requests[1] as any).runtime.sessionId, "saved-b");
  assert.ok(!JSON.stringify(fixture.requests).includes("session_file"));
  await lifecycle.stop();
});

test("registration renewals read the current display name, sanitize and bound it without rotating the route", async (t) => {
  const fixture = await registry(t, (_request, socket) =>
    socket.end('{"ok":true,"result":{"url":"https://gateway.example/"}}\n'),
  );
  const lifecycle = new SessionRegistration(credential, fixture.socketPath, { renewMs: 20 });
  t.after(() => lifecycle.stop());
  let name: unknown = "  Initial\nname  ";
  await lifecycle.start(
    43210,
    () => {},
    () => name,
  );
  assert.equal(fixture.requests[0].sessionName, "Initial name");
  const generation = fixture.requests[0].generation;
  for (const [value, expected] of [
    ["Renamed 会话", "Renamed 会话"],
    ["x".repeat(300), "x".repeat(256)],
    [null, null],
  ] as const) {
    const before = fixture.requests.length;
    name = value;
    const deadline = Date.now() + 1000;
    while (!fixture.requests.slice(before).some((req) => req.sessionName === expected)) {
      assert.ok(Date.now() < deadline, "name renewal did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(fixture.requests.every((request) => request.generation === generation));
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "socket fixture did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const registeredReply = '{"ok":true,"result":{"url":"https://gateway.example/"}}\n';

test("explicit refresh updates the name immediately and coalesces concurrent requests behind one writer", async (t) => {
  let held: net.Socket | undefined;
  let hold = false;
  let active = 0;
  let peak = 0;
  const fixture = await registry(t, (request, socket) => {
    if (request.action === "register") {
      peak = Math.max(peak, ++active);
      if (hold) {
        held = socket;
        return;
      }
      active--;
    }
    socket.end(registeredReply);
  });
  const lifecycle = createSessionRegistration(fixture);
  let name = "Initial";
  await lifecycle.start(
    43210,
    () => {},
    () => name,
  );
  name = "Immediate rename";
  await lifecycle.refresh();
  assert.equal(fixture.requests[1].sessionName, name);
  hold = true;
  name = "In flight";
  const first = lifecycle.refresh();
  await waitFor(() => Boolean(held));
  const waiting: Promise<void>[] = [];
  for (let index = 0; index < 1000; index++) {
    name = `Latest ${index}`;
    waiting.push(lifecycle.refresh());
  }
  assert.ok(
    waiting.every((promise) => promise === waiting[0]),
    "one shared bounded waiter per queued batch",
  );
  assert.equal(fixture.requests.length, 3);
  hold = false;
  active--;
  held?.end(registeredReply);
  await Promise.all([first, ...waiting]);
  assert.equal(fixture.requests.length, 4);
  assert.equal(fixture.requests[3].sessionName, "Latest 999");
  assert.equal(peak, 1);
  assert.ok(fixture.requests.every((request) => request.generation === fixture.requests[0].generation));
  await lifecycle.stop();
  await lifecycle.refresh();
  assert.equal(fixture.requests.length, 5, "refresh after stop is a no-op");
});

test("refresh ACK budget includes a stalled request and queue time; trailing work still runs", async (t) => {
  let held: net.Socket | undefined;
  let hold = false;
  const fixture = await registry(t, (request, socket) => {
    if (hold && request.action === "register") held = socket;
    else socket.end(registeredReply);
  });
  const lifecycle = createSessionRegistration(fixture); // Real default 5s IPC deadline.
  let name = "Initial";
  await lifecycle.start(
    43210,
    () => {},
    () => name,
  );
  hold = true;
  const started = Date.now();
  const first = lifecycle.refresh();
  await waitFor(() => Boolean(held));
  name = "After stall";
  const trailing = lifecycle.refresh();
  await Promise.all([first, trailing]);
  assert.ok(Date.now() - started < 1000, "ACK must not wait for the 5s IPC deadline");
  assert.equal(fixture.requests.length, 2);
  hold = false;
  held?.end(registeredReply);
  await waitFor(() => fixture.requests.length === 3);
  assert.equal(fixture.requests[2].sessionName, name);
  await lifecycle.stop();
});

test("timer ticks coalesce with explicit refreshes while IPC is stalled and stop discards the trailing batch", async (t) => {
  let held: net.Socket | undefined;
  const fixture = await registry(t, (request, socket) => {
    if (request.action === "register" && fixture.requests.length > 1) held = socket;
    else socket.end(registeredReply);
  });
  const lifecycle = new SessionRegistration(credential, fixture.socketPath, { renewMs: 5 });
  await lifecycle.start(43210, () => {});
  await waitFor(() => Boolean(held));
  const refresh = lifecycle.refresh();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fixture.requests.length, 2, "renewal ticks must not open concurrent sockets");
  const stopping = lifecycle.stop();
  held?.end(registeredReply);
  await Promise.all([refresh, stopping]);
  assert.deepEqual(
    fixture.requests.map((request) => request.action),
    ["register", "register", "unregister"],
  );
});

test("stop/start fences old refreshes, callbacks and errors and serializes unregister before the successor", async (t) => {
  for (const lateReply of [registeredReply, '{"ok":false,"error":"ended generation"}\n']) {
    let held: net.Socket | undefined;
    let hold = false;
    const fixture = await registry(t, (request, socket) => {
      if (hold && request.action === "register") held = socket;
      else socket.end(registeredReply);
    });
    const lifecycle = createSessionRegistration(fixture);
    const oldNotices: (string | null)[] = [];
    let oldReads = 0;
    await lifecycle.start(
      43210,
      (url) => oldNotices.push(url),
      () => {
        oldReads++;
        return "Old";
      },
    );
    hold = true;
    const running = lifecycle.refresh();
    await waitFor(() => Boolean(held));
    const queued = lifecycle.refresh();
    const stopping = lifecycle.stop();
    const newNotices: (string | null)[] = [];
    const restarting = lifecycle.start(
      43211,
      (url) => newNotices.push(url),
      () => "New",
    );
    const newRefresh = lifecycle.refresh();
    hold = false;
    held?.end(lateReply);
    await Promise.all([running, queued, stopping, restarting, newRefresh]);
    assert.deepEqual(
      fixture.requests.map((request) => request.action),
      ["register", "register", "unregister", "register"],
    );
    assert.equal(oldReads, 2, "stale queued work must not even read the old getter");
    assert.equal(oldNotices.length, 1, "late success/error cannot notify the old epoch");
    assert.deepEqual(newNotices, ["https://gateway.example/"]);
    assert.equal(fixture.requests[2].generation, fixture.requests[0].generation);
    assert.notEqual(fixture.requests[3].generation, fixture.requests[0].generation);
    assert.equal(fixture.requests[3].port, 43211);
    assert.equal(fixture.requests[3].sessionName, "New");
    await lifecycle.refresh();
    assert.equal(
      fixture.requests[4].generation,
      fixture.requests[3].generation,
      "late ended-generation cannot rotate successor",
    );
    await lifecycle.stop();
  }
});

test("getter and notification errors do not poison refresh or erase known registry metadata", async (t) => {
  const fixture = await registry(t, (_request, socket) => socket.end(registeredReply));
  const lifecycle = createSessionRegistration(fixture);
  let throwing = false;
  const notices: (string | null)[] = [];
  await lifecycle.start(
    43210,
    (url) => {
      notices.push(url);
      throw new Error("UI unavailable");
    },
    () => {
      if (throwing) throw new Error("stale context");
      return "Known name";
    },
  );
  throwing = true;
  await lifecycle.refresh();
  assert.equal(fixture.requests.length, 1);
  assert.equal(notices.at(-1), null);
  throwing = false;
  await lifecycle.refresh();
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[1].sessionName, "Known name");
  await lifecycle.stop();
});

test("identity requires a signed challenge and gateway generation proofs protect HTTP", async (t) => {
  const fixture = await registry(t, (_request, socket) =>
    socket.end('{"ok":true,"result":{"url":"https://gateway.example/"}}\n'),
  );
  const lifecycle = createSessionRegistration(fixture);
  await lifecycle.start(43210, () => {});
  t.after(() => lifecycle.stop());
  const server = http.createServer((req, res) => {
    if (guardSessionRequest(lifecycle, req, res)) res.writeHead(200).end("local");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  assert.equal((await fetch(`${url}/.pi-web-identity`)).status, 403);
  const challenge = "c".repeat(48);
  const identity = await fetch(`${url}/.pi-web-identity`, {
    headers: {
      "x-pi-web-challenge": challenge,
      "x-pi-web-challenge-proof": proof(challenge),
    },
  });
  assert.equal(identity.headers.get("cache-control"), "no-store");
  const generation = fixture.requests[0].generation;
  assert.deepEqual(await identity.json(), { generation, proof: proof(`${challenge}:${generation}`) });
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { headers: { "x-pi-web-generation": generation } })).status, 409);
  assert.equal(
    (await fetch(url, { headers: { "x-pi-web-generation": generation, "x-pi-web-proof": proof(generation) } })).status,
    200,
  );
  assert.equal(
    (await fetch(url, { headers: { "x-pi-web-generation": "d".repeat(32), "x-pi-web-proof": proof(generation) } }))
      .status,
    409,
  );
});

test("stop fences a delayed registration reply and restart has a different generation", async (t) => {
  let release: (() => void) | undefined;
  let received!: () => void;
  const registered = new Promise<void>((resolve) => {
    received = resolve;
  });
  const fixture = await registry(t, (request, socket) => {
    const send = () => socket.end(`${JSON.stringify({ ok: true, result: { url: "https://gateway.example/" } })}\n`);
    if (request.action === "register" && !release) {
      release = send;
      received();
    } else send();
  });
  const lifecycle = createSessionRegistration(fixture);
  const notices: (string | null)[] = [];
  const starting = lifecycle.start(43210, (value) => notices.push(value));
  await registered;
  const stopping = lifecycle.stop();
  assert.ok(release);
  release();
  await Promise.all([starting, stopping]);
  assert.equal(notices.length, 0);
  const first = fixture.requests[0].generation;
  await lifecycle.start(43211, (value) => notices.push(value));
  assert.notEqual(fixture.requests[2].generation, first);
  assert.equal(notices.length, 1);
  await lifecycle.stop();
});

test("a stalled registry times out without leaking credentials or remote error details", async (t) => {
  const fixture = await registry(t, (request, socket) => {
    if (request.action === "unregister") socket.end('{"ok":true,"result":{}}\n');
  });
  const lifecycle = new SessionRegistration(credential, fixture.socketPath, { timeoutMs: 40 });
  const notices: (string | null)[] = [];
  await lifecycle.start(43210, (value) => notices.push(value));
  assert.deepEqual(notices, [null]);
  await lifecycle.stop();
});

test("renewal drops unsafe registry URLs and retries without stopping local service", async (t) => {
  const fixture = await registry(t, (request, socket) => {
    if (request.action === "unregister") {
      socket.end('{"ok":true,"result":{}}\n');
      return;
    }
    if (fixture.requests.filter((value) => value.action === "register").length === 1) {
      socket.end('{"ok":true,"result":{"url":"https://name:secret@gateway.example/"}}\n');
    } else socket.end('{"ok":true,"result":{"url":"https://gateway.example/"}}\n');
  });
  const lifecycle = new SessionRegistration(credential, fixture.socketPath, { renewMs: 20 });
  const notices: (string | null)[] = [];
  let renewed!: () => void;
  const ready = new Promise<void>((resolve) => {
    renewed = resolve;
  });
  await lifecycle.start(43210, (value) => {
    notices.push(value);
    if (value) renewed();
  });
  await ready;
  assert.deepEqual(notices.slice(0, 2), [null, "https://gateway.example/"]);
  await lifecycle.stop();
});

test("oversized, malformed and prematurely closed replies are rejected", async (t) => {
  for (const reply of ["x".repeat(8193), "not-json\n", '{"ok":true']) {
    const fixture = await registry(t, (_request, socket) => socket.end(reply));
    const lifecycle = new SessionRegistration(credential, fixture.socketPath, { timeoutMs: 100 });
    const notices: (string | null)[] = [];
    await lifecycle.start(43210, (value) => notices.push(value));
    assert.deepEqual(notices, [null]);
    await lifecycle.stop();
  }
});

test("an ended generation is replaced on renewal rather than reused", async (t) => {
  const fixture = await registry(t, (request, socket) => {
    if (request.action === "register" && fixture.requests.length === 1) {
      socket.end('{"ok":false,"error":"ended generation: secret"}\n');
    } else socket.end('{"ok":true,"result":{"url":"https://gateway.example/"}}\n');
  });
  const lifecycle = new SessionRegistration(credential, fixture.socketPath, { renewMs: 20 });
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  await lifecycle.start(43210, (url) => {
    if (url) resolve();
  });
  await ready;
  assert.notEqual(fixture.requests[0].generation, fixture.requests[1].generation);
  await lifecycle.stop();
});

test("both browser rename commands refresh over IPC before ACK and tolerate getter/registry failures", async (t) => {
  let mode: "ready" | "reject" | "hold" = "ready";
  let held: net.Socket | undefined;
  const fixture = await registry(t, (request, socket) => {
    if (request.action === "register" && mode === "hold") {
      held = socket;
      return;
    }
    socket.end(mode === "reject" ? '{"ok":false,"error":"private remote details"}\n' : registeredReply);
  });
  const dir = path.dirname(fixture.socketPath);
  // Isolate all settings reads; no user config, model, subprocess or production Hub.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const environment = {
    PI_CODING_AGENT_DIR: dir,
    PI_WEB_UI_STATIC_DIR: dir,
    PI_WEB_UI_HOST: "127.0.0.1",
    PI_WEB_UI_PORT: String(port),
    PI_WEB_UI_DISABLED: "false",
    PI_WEB_UI_PUBLIC_URL: "https://gateway.example/",
    PI_WEB_UI_REGISTRY_SOCKET: fixture.socketPath,
    PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: fixture.credentialFile,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  // Runtime harness, like git-preview-budget: do not pull the existing adapter
  // into the strict backend compilation graph just to type its entry point.
  const extensionModule = "../extensions/mirror-server.ts";
  let mirror: (pi: ExtensionAPI) => void;
  try {
    Object.assign(process.env, environment);
    mirror = (await import(extensionModule)).default;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  let name = "Initial";
  let getterThrows = false;
  const ctx = {
    cwd: dir,
    model: undefined,
    ui: { notify() {}, setStatus() {} },
    isIdle: () => true,
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => [],
      getTree: () => [],
      getLeafId: () => null,
      getSessionFile: () => undefined,
      getSessionId: () => "fixture-session",
    },
  } as unknown as ExtensionContext;
  mirror({
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand() {},
    getThinkingLevel: () => "off",
    setSessionName(value: string) {
      name = value;
    },
    getSessionName() {
      if (getterThrows) throw new Error("stale context");
      return name;
    },
  } as unknown as ExtensionAPI);
  t.after(async () => {
    mode = "ready";
    held?.end(registeredReply);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  });
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  await waitFor(() => fixture.requests.length === 1);
  const ws = new WebSocket(`ws://127.0.0.1:${fixture.requests[0].port}/ws`);
  t.after(() => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let sequence = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<{ ok: boolean; result?: { name: string } }>((resolve, reject) => {
      const id = String(++sequence);
      const timeout = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new Error("Missing rename ACK"));
      }, 2000);
      const onMessage = (data: Buffer) => {
        const response = JSON.parse(data.toString());
        if (response.type !== "res" || response.id !== id) return;
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve(response);
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  for (const [method, params, expected] of [
    ["prompt", { message: "/name Slash rename" }, "Slash rename"],
    ["set_session_name", { name: "  Direct rename  " }, "Direct rename"],
  ] as const) {
    const before = fixture.requests.length;
    const response = await request(method, params);
    assert.equal(response.ok, true);
    assert.equal(response.result?.name, expected);
    assert.equal(fixture.requests.length, before + 1, "Hub must receive rename before ACK on a healthy socket");
    assert.equal(fixture.requests.at(-1)?.sessionName, expected);
    assert.equal(fixture.requests.at(-1)?.generation, fixture.requests[0].generation);
  }
  getterThrows = true;
  for (const method of ["prompt", "set_session_name"]) {
    const before = fixture.requests.length;
    const response = await request(
      method,
      method === "prompt" ? { message: "/name Getter unavailable" } : { name: "Getter unavailable" },
    );
    assert.equal(response.ok, true);
    assert.equal(response.result?.name, "Getter unavailable");
    assert.equal(name, "Getter unavailable");
    assert.equal(fixture.requests.length, before, "throwing getter must not clear Hub metadata");
  }
  getterThrows = false;
  mode = "reject";
  assert.equal((await request("set_session_name", { name: "Hub rejected" })).ok, true);
  assert.equal(name, "Hub rejected");
  mode = "hold";
  const started = Date.now();
  assert.equal((await request("prompt", { message: "/name Slow Hub" })).ok, true);
  assert.equal(name, "Slow Hub");
  assert.ok(Date.now() - started < 1000, "web rename must not await the default 5s deadline");
  assert.ok(held);
  mode = "ready";
  held.end(registeredReply);
});

test("missing and malformed capability files fail with a generic error, without coercing fields", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-capability-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { credentialFile: path.join(dir, "capability.json"), socketPath: path.join(dir, "r.sock") };
  const rejected = () =>
    assert.throws(() => createSessionRegistration(config), {
      name: "Error",
      message: "Invalid Pi Web registration credentials",
    });
  rejected();
  for (const contents of ["not-json", "null", "[]", "{}", '"secret"', "x".repeat(4097)]) {
    writeFileSync(config.credentialFile, contents);
    rejected();
  }
  for (const field of ["run_id", "token"] as const) {
    for (const value of [[credential[field]], [[credential[field]]], null, {}, 123, true, "invalid"]) {
      writeFileSync(config.credentialFile, JSON.stringify({ ...credential, [field]: value }));
      rejected();
    }
  }
});

test("no registration denies route claims and identity but preserves headerless local access", async (t) => {
  const server = http.createServer((req, res) => {
    if (guardSessionRequest(null, req, res)) res.writeHead(200).end("local");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const generation = "d".repeat(32);
  const claims: Record<string, string>[] = [
    { "x-pi-web-generation": generation, "x-pi-web-proof": proof(generation) },
    { "x-pi-web-generation": generation },
    { "x-pi-web-proof": proof(generation) },
    { "x-pi-web-generation": "" },
    { "x-pi-web-proof": "" },
  ];
  for (const headers of claims) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
    // Upgrade requests use the same guard without a ServerResponse.
    assert.equal(guardSessionRequest(null, { url: "/ws", headers } as http.IncomingMessage), false);
  }
  const challenge = "c".repeat(48);
  for (const suffix of ["/.pi-web-identity", "/.pi-web-identity?probe=1"]) {
    const response = await fetch(`${url}${suffix}`, {
      headers: { "x-pi-web-challenge": challenge, "x-pi-web-challenge-proof": proof(challenge) },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
  assert.equal(await (await fetch(url)).text(), "local");
  assert.equal(guardSessionRequest(null, { url: "/ws", headers: {} } as http.IncomingMessage), true);
});
