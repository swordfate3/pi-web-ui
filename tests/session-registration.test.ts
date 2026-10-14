import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSessionRegistration,
  guardSessionRequest,
  SessionRegistration,
} from "../extensions/session-registration.ts";

const credential = { run_id: "a".repeat(32), token: "b".repeat(64) };
const proof = (text: string) => createHmac("sha256", credential.token).update(text).digest("hex");
type Request = typeof credential & { action: string; generation: string; port?: number };

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
