import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { watchConnectionLifecycle } from "../src/web/src/core/connection-lifecycle.ts";
import { PiClient } from "../src/web/src/core/pi-client.ts";

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const keys = ["window", "document", "location", "WebSocket"];
  const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const windowTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    sent: { id: string; method: string }[] = [];
    constructor() {
      sockets.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
    }
    respond() {
      const request = this.sent.at(-1);
      assert.ok(request);
      assert.equal(request.method, "health");
      this.onmessage?.({ data: JSON.stringify({ type: "res", id: request.id, ok: true, result: { status: "ok" } }) });
    }
  }
  Object.assign(globalThis, {
    window: Object.assign(windowTarget, { setTimeout, clearTimeout, setInterval, clearInterval }),
    document: documentTarget,
    location: { href: "https://test.invalid/" },
    WebSocket: Socket,
  });
  const client = new PiClient({
    onConnectionChange() {},
    onError() {},
    onEvent() {},
    onOpen() {},
    onPromptResponse() {},
  });
  let current: PiClient | null = client;
  let synced = 0;
  const cleanup = watchConnectionLifecycle(
    () => current,
    () => {
      synced++;
    },
  );
  t.after(() => {
    cleanup();
    client.disconnect();
    keys.forEach((key, i) => {
      const descriptor = descriptors[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  });
  client.connect();
  const socket = sockets[0];
  socket.onopen?.();
  return {
    client,
    socket,
    sockets,
    windowTarget,
    documentTarget,
    cleanup,
    synced: () => synced,
    setCurrent: (next: PiClient | null) => {
      current = next;
    },
  };
}

test("visibility, BFCache, online and focus probe the real client and sync once when healthy", async (t) => {
  const { socket, windowTarget, documentTarget, cleanup, synced, setCurrent } = setup(t);
  for (const event of ["visibilitychange", "pageshow", "online", "focus"]) {
    if (event === "visibilitychange") documentTarget.dispatchEvent(new Event(event));
    else windowTarget.dispatchEvent(Object.assign(new Event(event), { persisted: true }));
    windowTarget.dispatchEvent(new Event("focus"));
    assert.equal(socket.sent.length, synced() + 1, "lifecycle bursts share one probe");
    socket.respond();
    await setImmediate();
    assert.equal(synced(), socket.sent.length);
  }
  documentTarget.visibilityState = "hidden";
  windowTarget.dispatchEvent(new Event("online"));
  assert.equal(socket.sent.length, 4, "do not resync hidden pages");
  documentTarget.visibilityState = "visible";
  windowTarget.dispatchEvent(new Event("focus"));
  setCurrent(null);
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 4, "late foreground result must not sync a different client");
  cleanup();
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(socket.sent.length, 5);
});

test("visible idle pages periodically send only health without syncing conversation history", async (t) => {
  const { socket, synced } = setup(t);
  t.mock.timers.tick(19999);
  assert.equal(socket.sent.length, 0, "do not probe immediately on mount");
  t.mock.timers.tick(1);
  assert.deepEqual(
    socket.sent.map((request) => request.method),
    ["health"],
  );
  socket.respond();
  await setImmediate();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(20000);
    assert.equal(socket.sent.length, i + 2, "continue checking while the page stays visible");
    socket.respond();
    await setImmediate();
  }
  assert.deepEqual(
    socket.sent.map((request) => request.method),
    ["health", "health", "health"],
  );
  assert.equal(synced(), 0, "healthy periodic probes must not invoke onHealthy");
});

test("hidden pages skip periodic checks but visibility resume still syncs", async (t) => {
  const { socket, documentTarget, synced } = setup(t);
  documentTarget.visibilityState = "hidden";
  t.mock.timers.tick(60000);
  assert.deepEqual(socket.sent, []);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 1);
  t.mock.timers.tick(20000);
  assert.equal(socket.sent.length, 2, "periodic checking resumes in the foreground");
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 1, "a periodic check after resume must not inherit its sync request");
});

test("locking the screen cancels a foreground health deadline instead of disconnecting a sleeping tab", async (t) => {
  const { socket, sockets, windowTarget, documentTarget, synced } = setup(t);
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(socket.sent.length, 1);
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(socket.readyState, 1, "background suspension is not proof that an OPEN socket died");
  assert.equal(sockets.length, 1);
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 1, "unlock starts a fresh health probe and resumes read-only state once");
});

test("rapid hide/show starts a fresh probe before the cancelled probe settles", async (t) => {
  const { socket, windowTarget, documentTarget, synced } = setup(t);
  windowTarget.dispatchEvent(new Event("focus"));
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  documentTarget.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(socket.sent.length, 2, "unlock must not join a cancelled foreground probe");
  await setImmediate();
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(socket.sent.length, 2, "the old finally must not clear the new probe's state");
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 1);
});

test("foreground replaces a pre-freeze probe even without a hidden event or timer delivery", async (t) => {
  const { socket, windowTarget, synced } = setup(t);
  windowTarget.dispatchEvent(new Event("focus"));
  t.mock.timers.setTime(Date.now() + 60_000);
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(socket.sent.length, 2);
  await setImmediate();
  windowTarget.dispatchEvent(new Event("online"));
  assert.equal(socket.sent.length, 2);
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 1);
  assert.equal(socket.readyState, 1);
});

for (const event of ["visibilitychange", "pageshow", "online", "focus"]) {
  test(`${event} coalesces with an in-flight periodic health check without losing state sync`, async (t) => {
    const { socket, documentTarget, windowTarget, synced } = setup(t);
    t.mock.timers.tick(20000);
    assert.equal(socket.sent.length, 1, "periodic health check is in flight");
    for (let i = 0; i < 2; i++) {
      if (event === "visibilitychange") documentTarget.dispatchEvent(new Event(event));
      else windowTarget.dispatchEvent(Object.assign(new Event(event), { persisted: true }));
    }
    assert.equal(socket.sent.length, 1, "lifecycle bursts share the periodic probe");
    socket.respond();
    await setImmediate();
    assert.equal(synced(), 1, "the coalesced lifecycle event still requests one sync");
    t.mock.timers.tick(20000);
    socket.respond();
    await setImmediate();
    assert.equal(synced(), 1, "the next periodic probe is health-only again");
  });
}

test("a periodic tick shares an in-flight resume probe without suppressing its sync", async (t) => {
  const { socket, windowTarget, synced } = setup(t);
  t.mock.timers.tick(19999);
  windowTarget.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(1);
  assert.equal(socket.sent.length, 1);
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 1);
});

test("periodic health timeout recovers a silent socket without replaying user mutations", async (t) => {
  const { client, socket, sockets, synced } = setup(t);
  const prompt = assert.rejects(client.send("prompt", { message: "only once" }), /disconnected/);
  t.mock.timers.tick(20000);
  assert.deepEqual(
    socket.sent.map((request) => request.method),
    ["prompt", "health"],
  );
  t.mock.timers.tick(15000);
  await prompt;
  await setImmediate();
  assert.equal(socket.readyState, 3, "the existing health timeout retires the silent transport");
  t.mock.timers.tick(1200);
  assert.equal(sockets.length, 2);
  sockets[1].onopen?.();
  assert.deepEqual(sockets[1].sent, [], "reconnect must not replay the prompt or load history here");
  assert.equal(synced(), 0, "a failed health check must not request state sync");
});

test("cleanup removes the periodic timer and all listeners and fences late healthy results", async (t) => {
  const { socket, windowTarget, documentTarget, cleanup, synced } = setup(t);
  const clearTimer = t.mock.method(window, "clearInterval");
  const removeWindowListener = t.mock.method(windowTarget, "removeEventListener");
  const removeDocumentListener = t.mock.method(documentTarget, "removeEventListener");
  t.mock.timers.tick(20000);
  assert.equal(socket.sent.length, 1);
  windowTarget.dispatchEvent(new Event("focus"));
  cleanup();
  assert.equal(clearTimer.mock.callCount(), 1);
  assert.deepEqual(removeWindowListener.mock.calls.map((call) => call.arguments[0]).sort(), [
    "focus",
    "online",
    "pageshow",
  ]);
  assert.deepEqual(
    removeDocumentListener.mock.calls.map((call) => call.arguments[0]),
    ["visibilitychange"],
  );
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 0, "a pending sync request cannot escape teardown");
  t.mock.timers.tick(60000);
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  for (const event of ["focus", "online", "pageshow"]) {
    windowTarget.dispatchEvent(Object.assign(new Event(event), { persisted: true }));
  }
  assert.equal(socket.sent.length, 1, "teardown leaves no probes or listeners behind");
});

test("periodic checks wait for a client and reject late results from a replaced client", async (t) => {
  const { client, socket, windowTarget, setCurrent, synced } = setup(t);
  setCurrent(null);
  t.mock.timers.tick(20000);
  assert.deepEqual(socket.sent, []);
  setCurrent(client);
  t.mock.timers.tick(20000);
  assert.equal(socket.sent.length, 1);
  windowTarget.dispatchEvent(new Event("online"));
  setCurrent(null);
  socket.respond();
  await setImmediate();
  assert.equal(synced(), 0, "coalesced resume cannot sync the replaced client");
});
