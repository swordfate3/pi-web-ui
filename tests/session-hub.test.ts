import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createSessionRegistration } from "../extensions/session-registration.ts";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../hub/config.ts";
import { startHub } from "../hub/server.ts";
import { PiClient } from "../src/web/src/core/pi-client.ts";

function exchange(socketPath: string, value: Record<string, unknown>) {
  return new Promise<{ ok: boolean; error?: string; result?: { url: string } }>((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.write(`${JSON.stringify(value)}\n`));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(data));
      }
    });
    socket.on("error", reject);
  });
}

async function fixture(t: test.TestContext, leaseMs = 45000) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-test-"));
  const configFile = path.join(dir, "config.json");
  initializeHub(configFile, { port: 0, leaseMs });
  const config = readHubConfig(configFile);
  let hub = await startHub(config);
  const backends: { stop: () => Promise<void> }[] = [];
  t.after(async () => {
    for (const backend of backends) await backend.stop();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function backend(label: string, initialFrame = label) {
    const file = path.join(dir, `${label}.json`);
    const credential = issueSession(config, file, { label });
    const registration = createSessionRegistration({ socketPath: hub.socketPath, credentialFile: file });
    let holdProof: (() => Promise<void>) | undefined;
    let failUpgrade: (() => Promise<void>) | undefined;
    const server = http.createServer(async (req, res) => {
      if (req.headers["x-pi-web-challenge"] && holdProof) {
        const wait = holdProof;
        holdProof = undefined;
        await wait();
      }
      if (registration.guard(req, res)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ label, url: req.url, proof: req.headers["x-pi-web-proof"] }));
      }
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", async (req, socket, head) => {
      if (failUpgrade) {
        const fail = failUpgrade;
        failUpgrade = undefined;
        await fail();
        socket.destroy();
        return;
      }
      if (!registration.guard(req)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => ws.send(initialFrame));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    let url: string | null = null;
    await registration.start(port, (value) => {
      url = value;
    });
    const stop = async () => {
      await registration.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    backends.push({ stop });
    return {
      credential,
      registration,
      port,
      pauseNextProof() {
        let release!: () => void;
        let started!: () => void;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        holdProof = () => {
          started();
          return waiting;
        };
        t.after(release);
        return { entered, release };
      },
      failNextUpgrade(action: () => Promise<void>) {
        failUpgrade = action;
      },
      broadcast(value: unknown) {
        for (const ws of wss.clients) ws.send(JSON.stringify(value));
      },
      disconnectBrowsers() {
        for (const ws of wss.clients) ws.terminate();
      },
      get url() {
        return url;
      },
    };
  }
  return {
    config,
    configFile,
    backend,
    get hub() {
      return hub;
    },
    async restart() {
      await hub.close();
      hub = await startHub(config);
    },
  };
}

async function handoffConnection(t: test.TestContext, url: string, origin: string) {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}ws`, { origin });
  t.after(() => socket.terminate());
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hub did not supply an in-memory handoff capability")), 1500);
    socket.on("error", reject);
    socket.on("message", (data) => {
      try {
        const value = JSON.parse(data.toString());
        if (value.type === "event" && value.event === "hub_route") {
          clearTimeout(timer);
          resolve(value.payload.token);
        }
      } catch {
        /* A backend may also send non-JSON test frames. */
      }
    });
    socket.once("close", () => clearTimeout(timer));
  });
  assert.match(token, /^[a-f0-9]{48}$/);
  return { socket, token };
}

function resolveHandoff(url: string, token: string, origin = new URL(url).origin) {
  return fetch(`${url}api/session-handoff`, {
    method: "POST",
    headers: { Origin: origin, "X-Pi-Web-Handoff": token },
  });
}

test("a successor registered during proof leaves the browser handoff retryable", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  const proof = a.pauseNextProof();
  const inFlight = resolveHandoff(f.hub.url, token);
  await proof.entered;
  await a.registration.stop();
  await a.registration.start(a.port, () => {});
  proof.release();
  assert.equal((await inFlight).status, 202, "a verified successor arriving during proof is not a terminal 410");
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 200);
});

test("backend events cannot overwrite the Hub-owned handoff control frame", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { socket, token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  const received: string[] = [];
  const ordinary = new Promise<void>((resolve) =>
    socket.on("message", (data) => {
      received.push(data.toString());
      if (data.toString().includes('"event":"ordinary"')) resolve();
    }),
  );
  a.broadcast({
    type: "event",
    event: "hub_route",
    payload: { generation: new URL(a.url).pathname.split("/")[2], token: "0".repeat(48) },
  });
  a.broadcast({ type: "event", event: "ordinary", payload: { value: "unchanged" } });
  await ordinary;
  assert.equal(
    received.some((value) => value.includes('"event":"hub_route"')),
    false,
  );
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 200);
});

test("PiClient keeps its capability until a replacement socket receives fresh Hub control", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A", JSON.stringify({ type: "event", event: "ordinary", payload: {} }));
  assert.ok(a.url);
  let page = new URL(a.url);
  const origin = page.origin;
  const actualFetch = globalThis.fetch;
  const saved = new Map(
    ["window", "location", "WebSocket", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const client = new PiClient({
    onConnectionChange() {},
    onError() {},
    onEvent() {},
    onPromptResponse() {},
    onOpen() {
      opens += 1;
    },
  });
  let opens = 0;
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, get: () => page });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
        history: {
          state: null,
          replaceState(_state: unknown, _title: string, value: string) {
            page = new URL(value, page);
          },
        },
      },
    });
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: class extends WebSocket {
        constructor(url: string) {
          super(url, { origin });
        }
      },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: (url: string, init: RequestInit) =>
        actualFetch(new URL(url, page), { ...init, headers: { ...init.headers, Origin: origin } }),
    });
    client.connect();
    await until(() => opens === 1);
    // A network drop first resolves to still-current A. That replacement
    // handshake fails while the real Pi registration moves to B.
    a.failNextUpgrade(async () => {
      await a.registration.stop();
      await a.registration.start(a.port, () => {});
    });
    a.disconnectBrowsers();
    await until(() => opens === 2);
    assert.notEqual(page.pathname, new URL(a.url).pathname);
    assert.equal((await actualFetch(page)).status, 200);
  } finally {
    client.disconnect();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function until(condition: () => boolean) {
  const end = Date.now() + 2500;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "real transport did not reconnect to the successor");
}

test("an open browser follows only its Pi successor while the old route stays gone", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  const b = await f.backend("B");
  assert.ok(a.url && b.url);
  const old = a.url;
  const { token } = await handoffConnection(t, old, new URL(f.hub.url).origin);
  const stillLive = await resolveHandoff(f.hub.url, token);
  assert.equal(stillLive.status, 200);
  assert.equal((await stillLive.json()).path, new URL(old).pathname, "B is not a substitute for A");
  assert.equal((await resolveHandoff(f.hub.url, token, "https://attacker.example")).status, 403);
  assert.equal((await resolveHandoff(f.hub.url, "0".repeat(48))).status, 410);
  await a.registration.stop();
  assert.equal((await fetch(old)).status, 410);
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 202);
  let next = "";
  await a.registration.start(a.port, (url) => {
    next = url ?? "";
  });
  const response = await resolveHandoff(f.hub.url, token);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.path, new URL(next).pathname);
  assert.notEqual(result.path, new URL(b.url).pathname);
  assert.equal((await fetch(old)).status, 410, "handoff must not revive a retired link");
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 200, "a lost response may be retried idempotently");
  await a.registration.stop();
  await a.registration.start(a.port, () => {});
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410, "never follow a second unrelated replacement");
});

test("revocation and Hub restart invalidate browser handoff capabilities", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  revokeSession(f.config, a.credential.run_id);
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410);
  const b = await f.backend("B");
  assert.ok(b.url);
  const other = await handoffConnection(t, b.url, new URL(f.hub.url).origin);
  await f.restart();
  assert.equal((await resolveHandoff(f.hub.url, other.token)).status, 410);
});

test("a disconnected browser capability expires even when the Pi later registers again", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const { socket, token } = await handoffConnection(t, a.url, new URL(f.hub.url).origin);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await a.registration.stop();
  await closed;
  // Advance only Date; sockets and registration deadlines remain real.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(46_000);
  await a.registration.start(a.port, () => {});
  assert.equal((await resolveHandoff(f.hub.url, token)).status, 410);
});

test("two separately authorized sessions route HTTP and remove only the stopped generation", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("Project A");
  const b = await f.backend("Project B");
  assert.ok(a.url && b.url && a.url !== b.url);
  const list = await (await fetch(`${f.hub.url}api/sessions`)).json();
  assert.deepEqual(list.sessions.map((s: { label: string }) => s.label).sort(), ["Project A", "Project B"]);
  const metadata = JSON.stringify(list);
  assert.ok(!metadata.includes(a.credential.token) && !metadata.includes(f.config.stateDir));
  const response = await fetch(`${a.url}assets/test.js?x=1`, { headers: { "x-pi-web-proof": "spoofed" } });
  const body = await response.json();
  assert.equal(body.label, "Project A");
  assert.equal(body.url, "/assets/test.js?x=1");
  assert.match(body.proof, /^[a-f0-9]{64}$/);
  const oldUrl = a.url;
  await a.registration.stop();
  assert.equal((await fetch(oldUrl)).status, 410);
  assert.equal((await fetch(b.url)).status, 200);
});

test("WebSocket routing injects proof and rejects cross-origin connections", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  const ws = new WebSocket(`${a.url.replace("http:", "ws:")}ws`, { origin: new URL(f.hub.url).origin });
  t.after(() => ws.terminate());
  assert.equal(
    await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => {
        if (data.toString() === "A") resolve("A");
      });
      ws.once("error", reject);
    }),
    "A",
  );
  const rejected = new WebSocket(`${a.url.replace("http:", "ws:")}ws`, { origin: "https://attacker.example" });
  await new Promise<void>((resolve, reject) => {
    rejected.once("error", () => resolve());
    rejected.once("open", () => {
      rejected.terminate();
      reject(new Error("Hostile origin accepted"));
    });
  });
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  await a.registration.stop();
  await closed;
});

test("expired and pre-restart generation URLs cannot be reused", async (t) => {
  const f = await fixture(t, 500);
  const a = await f.backend("A");
  assert.ok(a.url);
  const old = a.url;
  // start() begins its deadline before awaiting a probe: allow the full lease after reply.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal((await fetch(old)).status, 410);
  await a.registration.start(a.port, () => {});
  const beforeRestart = (await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions[0].path;
  await f.restart();
  assert.equal((await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions.length, 0);
  assert.equal((await fetch(`${f.hub.url.slice(0, -1)}${beforeRestart}`)).status, 410);
});

test("revoking one grant blocks enrollment and retires its current route", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  assert.ok(a.url);
  revokeSession(f.config, a.credential.run_id);
  assert.equal((await fetch(a.url)).status, 410);
  assert.equal((await (await fetch(`${f.hub.url}api/sessions`)).json()).sessions.length, 0);
});

test("IPC rejects forged credentials, oversized requests and unproved backend ports", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  const exchange = (value: string) =>
    new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const socket = net.createConnection(f.hub.socketPath, () => socket.write(value));
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("\n")) {
          socket.destroy();
          resolve(JSON.parse(data));
        }
      });
      socket.on("error", reject);
    });
  assert.equal(
    (
      await exchange(
        `${JSON.stringify({ action: "register", ...a.credential, token: "0".repeat(64), generation: "a".repeat(32), port: a.port })}\n`,
      )
    ).ok,
    false,
  );
  assert.equal((await exchange(`${"a".repeat(8193)}\n`)).ok, false);
  const fake = http.createServer((_req, res) =>
    res.end(JSON.stringify({ generation: "b".repeat(32), proof: "not-a-proof" })),
  );
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => fake.close(() => resolve())));
  const port = (fake.address() as net.AddressInfo).port;
  assert.equal(
    (await exchange(`${JSON.stringify({ action: "register", ...a.credential, generation: "b".repeat(32), port })}\n`))
      .ok,
    false,
  );
  assert.equal(
    (await fetch(`${f.hub.url}api/sessions`, { headers: { Origin: "https://attacker.example" } })).status,
    403,
  );
});

test("registration IPC can be mounted without exposing administrator grants", async (t) => {
  const f = await fixture(t);
  assert.ok(!f.hub.socketPath.startsWith(`${f.config.stateDir}${path.sep}`));
});

test("concurrent starts cannot replace a newly live registration socket", async (t) => {
  const f = await fixture(t);
  await f.hub.close();
  const stale = spawnSync(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))",
    f.config.socketPath,
  ]);
  assert.equal(stale.status, 0);
  const results = await Promise.allSettled([startHub(f.config), startHub(f.config)]);
  const hubs = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  t.after(async () => {
    for (const hub of hubs) await hub.close();
  });
  assert.equal(hubs.length, 1, "only one manager may acquire the registry");
  assert.equal((await exchange(f.config.socketPath, {})).ok, false, "winner registry remains reachable");
});

test("a renewal whose proof crosses expiry reports an ended generation", async (t) => {
  const f = await fixture(t, 500);
  const credential = issueSession(f.config, path.join(path.dirname(f.configFile), "slow.json"), { label: "Slow" });
  const generation = "c".repeat(32);
  let delay = 0;
  const backend = http.createServer((req, res) => {
    const challenge = req.headers["x-pi-web-challenge"];
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            generation,
            proof: createHmac("sha256", credential.token).update(`${challenge}:${generation}`).digest("hex"),
          }),
        ),
      delay,
    );
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => backend.close(() => resolve())));
  const request = { action: "register", ...credential, generation, port: (backend.address() as net.AddressInfo).port };
  assert.equal((await exchange(f.hub.socketPath, request)).ok, true);
  delay = 650;
  const renewal = await exchange(f.hub.socketPath, request);
  assert.equal(renewal.ok, false);
  assert.equal(renewal.error, "ended generation");
});

test("unregister before enrollment fences that generation permanently", async (t) => {
  const f = await fixture(t);
  const a = await f.backend("A");
  const generation = "d".repeat(32);
  assert.equal((await exchange(f.hub.socketPath, { action: "unregister", ...a.credential, generation })).ok, true);
  const result = await exchange(f.hub.socketPath, { action: "register", ...a.credential, generation, port: a.port });
  assert.equal(result.ok, false);
  assert.equal(result.error, "ended generation");
});
