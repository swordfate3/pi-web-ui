import assert from "node:assert/strict";
import test, { before } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

// Execute the production entry and real wire validators. Only the DOM/socket
// boundary and xterm's documented asynchronous completion are controlled here;
// no production hooks or duplicate application state machine are introduced.
let application: string;
before(async () => {
  const result = await build({
    entryPoints: ["src/web/terminal/app.ts"],
    bundle: true,
    write: false,
    format: "iife",
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "controlled-xterm-completion",
        setup(builder) {
          builder.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({ path: "xterm", namespace: "test" }));
          builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: "export const Terminal = globalThis.controlledTerminal;",
          }));
        },
      },
    ],
  });
  application = result.outputFiles[0].text;
});

const target = {
  v: 1,
  runId: "a".repeat(32),
  runtimeId: "runtime",
  sessionId: "session",
  terminalEpoch: "b".repeat(32),
  profile: "web-terminal-v1",
  inputState: "none",
  managedRestartEligible: false,
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class Surface extends EventTarget {
  value = "";
  textContent = "";
  disabled = false;
  dataset: Record<string, string> = {};
  replaceChildren() {}
  append() {}
  querySelector() {
    return new Surface();
  }
  click() {
    if (!this.disabled) this.dispatchEvent(new Event("click"));
  }
}

async function fixture(t: test.TestContext) {
  const elements = new Map<string, Surface>();
  const element = (id: string) => {
    let value = elements.get(id);
    if (!value) {
      value = new Surface();
      elements.set(id, value);
    }
    return value;
  };
  const keys = ["Up", "Tab", "CtrlC"].map((key) => {
    const surface = new Surface();
    surface.dataset.key = key;
    return surface;
  });
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById: element,
    querySelectorAll: () => keys,
    createElement: () => new Surface(),
  });
  const views: { data: string; complete: () => void; disposed: boolean }[] = [];
  class ControlledTerminal {
    parser = { registerOscHandler() {} };
    view = { data: "", complete() {}, disposed: false };
    constructor() {
      views.push(this.view);
    }
    open() {}
    write(data: string, callback: () => void) {
      this.view.data = data;
      this.view.complete = callback;
    }
    dispose() {
      this.view.disposed = true;
    }
  }
  const sockets: ControlledSocket[] = [];
  class ControlledSocket {
    bufferedAmount = 0;
    closed = false;
    sent: Record<string, unknown>[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      sockets.push(this);
    }
    send(text: string) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
    receive(value: object) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  let timerId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  vm.runInNewContext(application, {
    document,
    window: Object.assign(new EventTarget(), { confirm: () => true }),
    location: { protocol: "http:", host: "127.0.0.1" },
    controlledTerminal: ControlledTerminal,
    WebSocket: ControlledSocket,
    AbortController,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    setTimeout(callback: () => void, delay: number) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    async fetch(route: string) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify(
            route.endsWith("attach")
              ? { nonce: "d".repeat(64) }
              : {
                  authorized: true,
                  available: true,
                  csrf: "c".repeat(64),
                  scope: { access: "write" },
                  target,
                },
          ),
      };
    },
  });
  t.after(() => element("disconnect").click());
  await settle();
  element("access").value = "write";
  element("connect").click();
  await settle();
  const socket = sockets[0];
  assert.ok(socket, "production connect creates a socket after explicit click");
  socket.onopen?.();
  socket.receive({ type: "ready", target });
  const snapshot = (sequence: number, data: string) => {
    const bytes = Buffer.from(data);
    socket.receive({
      type: "screen-start",
      target,
      sequence,
      columns: 80,
      rows: 24,
      bytes: bytes.length,
      chunks: Math.ceil(bytes.length / 20480),
    });
    for (let offset = 0, index = 0; offset < bytes.length; offset += 20480, index++)
      socket.receive({
        type: "screen-chunk",
        terminalEpoch: target.terminalEpoch,
        sequence,
        index,
        data: bytes.subarray(offset, offset + 20480).toString("base64"),
      });
    socket.receive({ type: "screen-end", terminalEpoch: target.terminalEpoch, sequence });
  };
  const ack = (id: unknown, result: object = { ok: true, delivery: "written" }) =>
    socket.receive({ type: "response", id, result });
  const acquire = () => {
    element("acquire").click();
    ack(1, { ok: true, leaseId: "e".repeat(32), expiresInMs: 30000 });
    assert.equal(element("draft").disabled, false);
  };
  const edit = (value: string) => {
    element("draft").value = value;
    element("draft").dispatchEvent(new Event("input"));
  };
  return { element, socket, sockets, views, snapshot, ack, acquire, edit, keys, timers, document };
}

test("valid next snapshot waits for delayed first render and is displayed in order", async (t) => {
  const f = await fixture(t);
  f.snapshot(0, "first");
  f.snapshot(1, "second");
  assert.equal(f.socket.closed, false, "valid output during rendering must not disconnect");
  assert.equal(f.views.length, 1, "only one xterm parser/render is active");
  f.views[0].complete();
  await settle();
  assert.equal(f.views.length, 2);
  assert.equal(f.views[0].disposed, true);
  assert.equal(f.views[1].data, "second");
  f.views[1].complete();
  await settle();
  assert.match(f.element("screen-state").textContent, /#1/);
  assert.equal(f.socket.closed, false);
});

test("pending screen work has a 256 KiB encoded-byte bound, not an unbounded render queue", async (t) => {
  const f = await fixture(t);
  f.snapshot(0, "held");
  for (let sequence = 1; sequence <= 8; sequence++) f.snapshot(sequence, "x".repeat(20480));
  assert.equal(f.socket.closed, false, "eight small snapshots fit the pending byte budget");
  f.snapshot(9, "x".repeat(20480));
  f.snapshot(10, "x".repeat(20480));
  assert.equal(f.socket.closed, true, "overflow fences and closes rather than retaining more work");
  f.views[0].complete();
  await settle();
  assert.equal(f.views.length, 1, "queued screens do not render after the fence");
  assert.equal(f.element("screen-state").textContent, "画面已清除");
});

test("stalled render has a bounded deadline and late completion cannot resurrect the screen", async (t) => {
  const f = await fixture(t);
  f.snapshot(0, "held");
  const deadline = [...f.timers.values()].find((timer) => timer.delay === 2000);
  assert.ok(deadline, "render completion must have its own deadline");
  deadline.callback();
  f.views[0].complete();
  await settle();
  assert.equal(f.socket.closed, true);
  assert.equal(f.element("screen-state").textContent, "画面已清除");
});

test("queued malformed snapshot still fails closed when rendering drains", async (t) => {
  const f = await fixture(t);
  f.snapshot(0, "held");
  f.socket.receive({ type: "screen-end", sequence: 1, terminalEpoch: target.terminalEpoch });
  f.views[0].complete();
  await settle();
  assert.equal(f.socket.closed, true);
  assert.equal(f.element("screen-state").textContent, "画面已清除");
});

test("fixed-key ACKs preserve an unrelated nonempty draft", async (t) => {
  const f = await fixture(t);
  f.acquire();
  f.edit("unsent 中文 draft");
  for (const [index, key] of f.keys.entries()) {
    key.click();
    assert.equal(f.socket.sent.at(-1)?.data, ["\x1b[A", "\t", "\x03"][index]);
    f.ack(index + 2);
    assert.equal(f.element("draft").value, "unsent 中文 draft");
  }
});

test("text ACK preserves intervening edits including edit-away-and-back revision", async (t) => {
  const f = await fixture(t);
  f.acquire();
  f.edit("draft A");
  f.element("send").click();
  assert.equal(f.socket.sent.at(-1)?.data, "draft A");
  f.edit("draft B");
  f.ack(2);
  assert.equal(f.element("draft").value, "draft B");
  f.element("send").click();
  f.edit("temporary");
  f.edit("draft B");
  f.ack(3);
  assert.equal(f.element("draft").value, "draft B", "same text with a new revision is not the submitted draft");
});

test("text ACK clears only an unchanged submitted draft", async (t) => {
  const f = await fixture(t);
  f.acquire();
  f.edit("submitted");
  f.element("send").click();
  f.ack(2);
  assert.equal(f.element("draft").value, "");
  assert.equal(f.socket.closed, false);
});

test("response IDs are exact positive safe-integer numbers, never coerced", async (t) => {
  for (const id of ["1", "01", true, false, null, 0, -1, 1.5, 9007199254740992, {}, []]) {
    await t.test(`reject ${JSON.stringify(id)}`, async (t) => {
      const f = await fixture(t);
      f.element("acquire").click();
      f.ack(id, { ok: true, leaseId: "e".repeat(32), expiresInMs: 30000 });
      assert.equal(f.socket.closed, true);
      assert.equal(f.element("draft").disabled, true);
    });
  }
});
