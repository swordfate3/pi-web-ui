import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { watchConnectionLifecycle } from "../src/web/src/core/connection-lifecycle.ts";
import { PiClient } from "../src/web/src/core/pi-client.ts";

test("visibility, BFCache, online and focus probe the real client and sync once when healthy", async (t) => {
  const keys = ["window", "document", "location", "WebSocket"];
  const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const windowTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let socket!: Socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    sent: { id: string; method: string }[] = [];
    constructor() {
      socket = this;
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
    window: Object.assign(windowTarget, { setTimeout, clearTimeout }),
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
  socket.onopen?.();
  for (const event of ["visibilitychange", "pageshow", "online", "focus"]) {
    if (event === "visibilitychange") documentTarget.dispatchEvent(new Event(event));
    else windowTarget.dispatchEvent(Object.assign(new Event(event), { persisted: true }));
    windowTarget.dispatchEvent(new Event("focus"));
    assert.equal(socket.sent.length, synced + 1, "lifecycle bursts share one probe");
    socket.respond();
    await setImmediate();
    assert.equal(synced, socket.sent.length);
  }
  documentTarget.visibilityState = "hidden";
  windowTarget.dispatchEvent(new Event("online"));
  assert.equal(socket.sent.length, 4, "do not resync hidden pages");
  documentTarget.visibilityState = "visible";
  windowTarget.dispatchEvent(new Event("focus"));
  current = null;
  socket.respond();
  await setImmediate();
  assert.equal(synced, 4, "late foreground result must not sync a different client");
  cleanup();
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(socket.sent.length, 5);
});
