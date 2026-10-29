import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { PiClient } from "../src/web/src/core/pi-client.ts";

const generation = "a".repeat(32);
const sessionPath = `/s/${generation}/`;

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent: { id: string; method: string }[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() {
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    close() {
      this.readyState = 3;
    }
    drop() {
      this.readyState = 3;
      this.onclose?.();
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    message(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) });
    }
    reply(request: { id: string }, result: unknown) {
      this.message({ type: "res", id: request.id, ok: true, result });
    }
    route() {
      this.message({ type: "event", event: "hub_route", payload: { generation, token: "b".repeat(48) } });
    }
  }
  const descriptors = new Map(
    ["window", "location", "WebSocket", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const location = { pathname: sessionPath, href: `https://test.invalid${sessionPath}` };
  Object.assign(globalThis, {
    window: {
      setTimeout,
      clearTimeout,
      history: {
        state: null,
        replaceState(_state: unknown, _unused: string, next: string) {
          location.pathname = next;
        },
      },
      dispatchEvent() {},
    },
    location,
    WebSocket: Socket,
    fetch: async () => new Response(null, { status: 200 }),
  });
  const states: string[] = [];
  const errors: unknown[] = [];
  let opened = 0;
  const client = new PiClient({
    onConnectionChange: (s) => states.push(s),
    onError: (e) => errors.push(e),
    onEvent() {},
    onOpen() {
      opened++;
    },
    onPromptResponse() {},
  });
  t.after(() => {
    client.disconnect();
    for (const [key, value] of descriptors) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  client.connect();
  sockets[0].open();
  return { client, sockets, states, errors, opened: () => opened };
}

test("foreground verifies an OPEN socket and shares a concurrent health check", async (t) => {
  const { client, sockets } = setup(t);
  const first = client.ensureConnected();
  const second = client.ensureConnected();
  assert.equal(sockets[0].sent.length, 1);
  assert.equal(sockets[0].sent[0].method, "health");
  sockets[0].reply(sockets[0].sent[0], { status: "ok", mode: "webui", mirrorUrl: "" });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(sockets.length, 1);
});

test("a zombie socket is replaced without waiting for its missing close event", async (t) => {
  const { client, sockets } = setup(t);
  const checking = client.ensureConnected();
  t.mock.timers.tick(5000);
  await setImmediate();
  t.mock.timers.tick(16000);
  await setImmediate();
  assert.equal(await checking, false);
  assert.equal(sockets.length, 2);
  sockets[0].onclose?.();
  sockets[1].open();
  assert.equal(sockets[1].readyState, 1, "late old close must not close the replacement");
});

test("temporary network failure beyond 15s retries and reconnects the same session", async (t) => {
  const { sockets, errors } = setup(t);
  sockets[0].route();
  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  sockets[0].drop();
  for (let i = 0; i < 6; i++) {
    await setImmediate();
    t.mock.timers.tick(16000);
  }
  await setImmediate();
  assert.ok(!errors.some((e) => (e as { key?: string })?.key?.includes("expired")));
  globalThis.fetch = async () => new Response(null, { status: 200 });
  t.mock.timers.tick(16000);
  await setImmediate();
  assert.equal(sockets.length, 2);
});

test("foreground bypasses retry delay after connectivity returns", async (t) => {
  const { client, sockets } = setup(t);
  sockets[0].route();
  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  sockets[0].drop();
  await setImmediate();
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await client.ensureConnected();
  await setImmediate();
  assert.equal(sockets.length, 2);
});

test("expired handoff token is not used when the exact original route still exists", async (t) => {
  const { sockets } = setup(t);
  sockets[0].route();
  const requests: string[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push(`${options?.method} ${url}`);
    return new Response(null, { status: url === sessionPath ? 200 : 410 });
  };
  sockets[0].drop();
  await setImmediate();
  assert.equal(sockets.length, 2);
  assert.deepEqual(requests, [`HEAD ${sessionPath}`]);
});

test("retired generation resolves only the capability-bound successor", async (t) => {
  const { sockets } = setup(t);
  sockets[0].route();
  const nextPath = `/s/${"c".repeat(32)}/`;
  globalThis.fetch = async (url) =>
    url === sessionPath ? new Response(null, { status: 410 }) : Response.json({ path: nextPath });
  sockets[0].drop();
  await setImmediate();
  assert.equal(location.pathname, nextPath);
  assert.equal(sockets.length, 2);
});

test("definitive invalid capability stops retries including foreground wake", async (t) => {
  const { client, sockets, errors } = setup(t);
  sockets[0].route();
  globalThis.fetch = async () => new Response(null, { status: 410 });
  sockets[0].drop();
  await setImmediate();
  assert.ok(errors.some((e) => (e as { key?: string })?.key?.includes("expired")));
  await client.ensureConnected();
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
});

test("authentication refusal does not retry or follow a login redirect", async (t) => {
  const { client, sockets, errors } = setup(t);
  sockets[0].route();
  globalThis.fetch = async (_url, options) => {
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.redirect, "manual");
    return new Response(null, { status: 401 });
  };
  sockets[0].drop();
  await setImmediate();
  await client.ensureConnected();
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
  assert.ok(errors.some((e) => (e as { key?: string })?.key?.includes("Sign in")));
});

test("disconnect cancels recovery and a late response cannot resurrect the client", async (t) => {
  const { client, sockets } = setup(t);
  sockets[0].route();
  let resolve!: (r: Response) => void;
  globalThis.fetch = () =>
    new Promise((r) => {
      resolve = r;
    });
  sockets[0].drop();
  client.disconnect();
  resolve(new Response(null, { status: 200 }));
  await setImmediate();
  t.mock.timers.tick(60000);
  await client.ensureConnected();
  assert.equal(sockets.length, 1);
});

test("reconnection never replays a prompt, approval or queued session action", async (t) => {
  const { client, sockets } = setup(t);
  const prompt = assert.rejects(client.send("prompt", { message: "once" }), /disconnected/);
  const approval = assert.rejects(client.send("respond_extension_interaction", { confirmed: true }), /disconnected/);
  sockets[0].drop();
  await Promise.all([prompt, approval]);
  await assert.rejects(client.send("switch_session"), /Reconnect/);
  t.mock.timers.tick(16000);
  await setImmediate();
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, []);
});

test("stalled recovery times out and foreground can retry after browser suspension", async (t) => {
  const { client, sockets, errors } = setup(t);
  sockets[0].route();
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  sockets[0].drop();
  t.mock.timers.tick(9000);
  await setImmediate();
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await client.ensureConnected();
  assert.equal(sockets.length, 2);
  assert.ok(!errors.some((e) => (e as { key?: string })?.key?.includes("expired")));
});

test("late invalid handoff body cannot change errors after intentional disconnect", async (t) => {
  const { client, sockets, errors } = setup(t);
  sockets[0].route();
  let resolve!: (value: unknown) => void;
  globalThis.fetch = async (url) =>
    url === sessionPath
      ? new Response(null, { status: 410 })
      : ({
          status: 200,
          json: () =>
            new Promise((r) => {
              resolve = r;
            }),
        } as Response);
  sockets[0].drop();
  await setImmediate();
  const before = errors.length;
  client.disconnect();
  resolve({ path: "https://untrusted.invalid/" });
  await setImmediate();
  assert.equal(errors.length, before);
  assert.equal(sockets.length, 1);
});

test("a stalled handshake is retired and does not block future foreground recovery", async (t) => {
  const { client, sockets } = setup(t);
  sockets[0].drop();
  t.mock.timers.tick(1200);
  assert.equal(sockets.length, 2);
  await client.ensureConnected();
  assert.equal(sockets.length, 2, "do not duplicate a live handshake");
  t.mock.timers.tick(8000);
  t.mock.timers.tick(3000);
  assert.equal(sockets.length, 3);
});

test("managed restart recovery never extends its 120s authorization deadline", async (t) => {
  const { client, sockets, errors } = setup(t);
  sockets[0].message({
    type: "event",
    event: "hub_route",
    payload: {
      generation,
      token: "b".repeat(48),
      restart: { id: "d".repeat(32), timeoutMs: 120000 },
    },
  });
  globalThis.fetch = async (url) => new Response(null, { status: url === sessionPath ? 410 : 202 });
  sockets[0].drop();
  await setImmediate();
  t.mock.timers.tick(120001);
  await setImmediate();
  await client.ensureConnected();
  assert.ok(errors.some((e) => (e as { key?: string })?.key?.includes("expired")));
  assert.equal(sockets.length, 1);
});

test("a prompt or approval submitted during retry backoff cannot enter a successor", async (t) => {
  const { client, sockets } = setup(t);
  sockets[0].route();
  globalThis.fetch = async () => {
    throw new TypeError("offline");
  };
  sockets[0].drop();
  await setImmediate();
  const prompt = client.send("prompt", { message: "must not cross scope" });
  const approval = client.send("respond_extension_interaction", { confirmed: true });
  const rejections = Promise.all([assert.rejects(prompt, /Reconnect/), assert.rejects(approval, /Reconnect/)]);
  globalThis.fetch = async (url) =>
    url === sessionPath ? new Response(null, { status: 410 }) : Response.json({ path: `/s/${"c".repeat(32)}/` });
  t.mock.timers.tick(1200);
  await setImmediate();
  sockets[1].open();
  for (const request of sockets[1].sent) sockets[1].reply(request, {});
  await rejections;
  assert.deepEqual(sockets[1].sent, []);
});

test("repeated failed upgrades back off even when the exact route HEAD succeeds", async (t) => {
  const { sockets } = setup(t);
  sockets[0].route();
  sockets[0].drop();
  await setImmediate();
  assert.equal(sockets.length, 2);
  sockets[1].drop();
  await setImmediate();
  assert.equal(sockets.length, 2, "a failed handshake must wait for its retry timer");
  t.mock.timers.tick(1200);
  await setImmediate();
  assert.equal(sockets.length, 3);
  sockets[2].drop();
  t.mock.timers.tick(1200);
  await setImmediate();
  assert.equal(sockets.length, 3, "consecutive failures increase the delay");
  t.mock.timers.tick(1200);
  await setImmediate();
  assert.equal(sockets.length, 4);
});

test("HEAD resolving after a suspended managed deadline cannot open a socket", async (t) => {
  const { sockets, errors } = setup(t);
  sockets[0].message({
    type: "event",
    event: "hub_route",
    payload: {
      generation,
      token: "b".repeat(48),
      restart: { id: "d".repeat(32), timeoutMs: 120000 },
    },
  });
  let resolve!: (response: Response) => void;
  globalThis.fetch = () =>
    new Promise((r) => {
      resolve = r;
    });
  sockets[0].drop();
  // Advance wall time without running the browser's suspended task queue.
  t.mock.method(Date, "now", () => 122000);
  resolve(new Response(null, { status: 200 }));
  await setImmediate();
  assert.equal(sockets.length, 1);
  assert.ok(errors.some((e) => (e as { key?: string })?.key?.includes("expired")));
});
