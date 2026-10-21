import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { issueTerminalCode, revokeTerminal } from "../hub/terminal-auth.ts";
import { startTerminalServer } from "../hub/terminal-server.ts";

async function live(t: test.TestContext, access: "read" | "write" = "write", stalledAcquire = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "task5-server-"));
  const file = path.join(dir, "hub.json");
  const credentialFile = path.join(dir, "provider.token");
  const socketPath = path.join(dir, "provider.sock");
  writeFileSync(credentialFile, "e".repeat(64), { mode: 0o600 });
  initializeHub(file, { port: 0, terminal: { port: 0, provider: { socketPath, credentialFile } } });
  const config = readHubConfig(file);
  const grant = issueSession(config, path.join(dir, "run.json"), { label: "Task5 fixture" });
  const target = {
    v: 1 as const,
    runId: grant.run_id,
    runtimeId: "runtime",
    sessionId: "session",
    terminalEpoch: "a".repeat(32),
    profile: "web-terminal-v1" as const,
    inputState: "none" as const,
    managedRestartEligible: false as const,
  };
  const scope = {
    runId: target.runId,
    runtimeId: target.runtimeId,
    sessionId: target.sessionId,
    terminalEpoch: target.terminalEpoch,
    access,
  };
  const sockets = new Set<net.Socket>();
  const requests: Record<string, unknown>[] = [];
  const provider = net.createServer((s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
    let buffer = "";
    s.on("data", (b) => {
      buffer += b;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const v = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(v);
        if (v.op === "status") s.end(`${JSON.stringify({ type: "ready", target })}\n`);
        else if (v.op === "connect")
          s.write(
            [
              { type: "ready", target },
              { type: "screen-start", target, sequence: 0, columns: 80, rows: 24, bytes: 3, chunks: 1 },
              { type: "screen-chunk", terminalEpoch: target.terminalEpoch, sequence: 0, index: 0, data: "5Lit" },
              { type: "screen-end", terminalEpoch: target.terminalEpoch, sequence: 0 },
            ]
              .map((f) => `${JSON.stringify(f)}\n`)
              .join(""),
          );
        else if (v.type === "acquire" && !stalledAcquire)
          s.write(
            `${JSON.stringify({
              type: "response",
              id: v.id,
              result: { ok: true, leaseId: "f".repeat(32), expiresInMs: 30000 },
            })}\n`,
          );
        else if (v.type === "input")
          s.write(`${JSON.stringify({ type: "response", id: v.id, result: { ok: true, delivery: "written" } })}\n`);
      }
    });
  });
  await new Promise<void>((r) => provider.listen(socketPath, r));
  const server = await startTerminalServer(config, []);
  t.after(async () => {
    await server.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => provider.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = new URL(server.url).origin;
  let cookie = "",
    csrf = "";
  const post = (route: string, value: unknown, extra: Record<string, string> = {}) =>
    fetch(`${server.url}api/terminal/${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Pi-Hub-Terminal-Csrf": csrf,
        ...extra,
      },
      body: JSON.stringify(value),
    });
  const unlock = await post("unlock", { code: issueTerminalCode(config, scope).code });
  cookie = (unlock.headers.get("set-cookie") ?? "").split(";")[0];
  csrf = (await unlock.json()).csrf;
  const attach = async (value = target, selected = access) => post("attach", { target: value, access: selected });
  const ws = async (nonce: string, extra: Record<string, unknown> = {}) => {
    const socket = new WebSocket(`${server.url.replace("http", "ws")}api/terminal/ws`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (b) => frames.push(JSON.parse(b.toString())));
    await new Promise<void>((r, reject) => {
      socket.once("open", r);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "attach", nonce, csrf, target, access, ...extra }));
    return {
      socket,
      frames,
      action: (request: Record<string, unknown>) => socket.send(JSON.stringify({ ...request, csrf, target })),
    };
  };
  return {
    config,
    target,
    scope,
    post,
    attach,
    ws,
    requests,
    url: server.url,
    sockets,
    headers: { Origin: origin, Cookie: cookie },
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
test("production terminal listener attaches real private socket and preserves coalesced initial screen", async (t) => {
  const f = await live(t);
  const response = await f.attach();
  assert.equal(response.status, 200);
  const { nonce } = await response.json();
  const peer = await f.ws(nonce);
  await until(() => peer.frames.some((v) => v.type === "screen-end"));
  assert.equal(peer.frames[0].type, "ready");
  assert.equal(peer.frames.filter((v) => v.type === "screen-start").length, 1);
  peer.action({ id: 1, type: "acquire" });
  await until(() => peer.frames.some((v) => v.type === "response"));
  peer.action({
    id: 2,
    v: 1,
    type: "input",
    terminalEpoch: f.target.terminalEpoch,
    leaseId: "f".repeat(32),
    sequence: 1,
    data: "中文\r",
  });
  await until(() => peer.frames.some((v) => v.id === 2));
  assert.deepEqual(peer.frames.find((v) => v.id === 2)?.result, { ok: true, delivery: "written" });
  peer.socket.close();
});
test("wrong origin, CSRF, immutable identity and write scope are rejected before provider output", async (t) => {
  const f = await live(t, "read");
  for (const extra of [
    { Origin: "https://evil.invalid" },
    { "X-Pi-Hub-Terminal-Csrf": "wrong" },
    { Cookie: "" },
  ] as Record<string, string>[])
    assert.equal((await f.post("attach", { target: f.target, access: "read" }, extra)).status, 403);
  assert.equal((await f.attach({ ...f.target, sessionId: "changed" })).status, 403);
  assert.equal((await f.attach(f.target, "write")).status, 403);
  assert.equal(f.requests.length, 0);
  const { nonce } = await (await f.attach()).json();
  const peer = await f.ws(nonce, { csrf: "wrong" });
  await until(() => peer.socket.readyState === WebSocket.CLOSED);
  assert.equal(peer.frames.length, 0);
  assert.equal(f.requests.length, 0);
});
test("nonce is single-use and two readers/one writer admission is enforced without retarget", async (t) => {
  const f = await live(t, "read");
  const { nonce } = await (await f.attach()).json();
  const one = await f.ws(nonce);
  await until(() => one.frames.some((v) => v.type === "ready"));
  const replay = await f.ws(nonce);
  await until(() => replay.socket.readyState === WebSocket.CLOSED);
  assert.equal(replay.frames.length, 0);
  const next = await (await f.attach()).json();
  const two = await f.ws(next.nonce);
  await until(() => two.frames.some((v) => v.type === "ready"));
  assert.equal((await f.attach()).status, 409);
  one.socket.close();
  two.socket.close();
});
test("revocation and close fence pending acquire, screen and input with no resurrection", async (t) => {
  const f = await live(t, "write", true);
  const { nonce } = await (await f.attach()).json();
  const peer = await f.ws(nonce);
  await until(() => peer.frames.some((v) => v.type === "screen-end"));
  peer.action({ id: 1, type: "acquire" });
  await until(() => f.requests.some((v) => v.type === "acquire"));
  revokeTerminal(f.config);
  peer.action({
    id: 2,
    v: 1,
    type: "input",
    terminalEpoch: f.target.terminalEpoch,
    leaseId: "f".repeat(32),
    sequence: 1,
    data: "not-delivered",
  });
  await until(() => peer.socket.readyState === WebSocket.CLOSED);
  assert.equal(
    f.requests.some((v) => v.type === "input"),
    false,
  );
  assert.equal(
    peer.frames.some((v) => v.type === "response"),
    false,
  );
});
test("public same-host different-port terminal is refused; local separate ports remain explicit exception", (t) => {
  // Cookie authority is hostname-, not port-scoped.
  const dir = mkdtempSync(path.join(tmpdir(), "task5-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub.json");
  initializeHub(file, {
    publicUrl: "https://chat.example/",
    terminal: { port: 16182, publicUrl: "https://chat.example:8443/" },
  });
  assert.throws(() => readHubConfig(file), /distinct/);
});

test("expired attach nonce fails before provider output even with a still-valid session", async (t) => {
  const f = await live(t);
  const { nonce } = await (await f.attach()).json();
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now + 10001);
  try {
    const peer = await f.ws(nonce);
    await until(() => peer.socket.readyState === WebSocket.CLOSED);
    assert.deepEqual(peer.frames, []);
    assert.deepEqual(f.requests, []);
  } finally {
    clock.mock.restore();
  }
});

test("eight websocket first frames are bounded and expire in two seconds without provider calls", {
  timeout: 6000,
}, async (t) => {
  const f = await live(t);
  const sockets: WebSocket[] = [];
  t.after(() => {
    for (const socket of sockets) socket.terminate();
  });
  const started = Date.now();
  for (let index = 0; index < 8; index++) {
    const socket = new WebSocket(`${f.url.replace("http", "ws")}api/terminal/ws`, { headers: f.headers });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
  }
  const ninth = new WebSocket(`${f.url.replace("http", "ws")}api/terminal/ws`, { headers: f.headers });
  sockets.push(ninth);
  await new Promise<void>((resolve) => {
    ninth.once("error", () => resolve());
    ninth.once("open", () => assert.fail("ninth pending handshake admitted"));
  });
  await until(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
  assert.ok(Date.now() - started >= 1900 && Date.now() - started < 3000);
  assert.deepEqual(f.requests, []);
});
