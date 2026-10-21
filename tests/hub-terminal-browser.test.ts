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
  let failRender = false;
  class ControlledTerminal {
    parser = { registerOscHandler() {} };
    view = { data: "", complete() {}, disposed: false };
    constructor() {
      views.push(this.view);
    }
    open() {
      if (failRender) throw new Error("controlled render failure");
    }
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
  let now = 0;
  const timers = new Map<number, { callback: () => void; delay: number; at: number }>();
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
    performance: { now: () => now },
    setTimeout(callback: () => void, delay: number) {
      timers.set(++timerId, { callback, delay, at: now + delay });
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
  const rendered = async () => {
    snapshot(0, "validated native prompt");
    views[0].complete();
    await settle();
  };
  const acquire = async () => {
    await rendered();
    element("acquire").click();
    ack(1, { ok: true, leaseId: "e".repeat(32), expiresInMs: 30000 });
    assert.equal(element("draft").disabled, false);
  };
  const edit = (value: string) => {
    element("draft").value = value;
    element("draft").dispatchEvent(new Event("input"));
  };
  const advance = async (ms: number, runTimers = true) => {
    now += ms;
    if (!runTimers) return;
    for (const [id, timer] of [...timers]) {
      if (timers.has(id) && timer.at <= now) {
        timers.delete(id);
        timer.callback();
        await settle();
      }
    }
  };
  return {
    element,
    socket,
    sockets,
    views,
    snapshot,
    ack,
    acquire,
    edit,
    keys,
    timers,
    document,
    rendered,
    advance,
    failNextRender: () => {
      failRender = true;
    },
  };
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
  await f.acquire();
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
  await f.acquire();
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
  await f.acquire();
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
      await f.rendered();
      f.element("acquire").click();
      f.ack(id, { ok: true, leaseId: "e".repeat(32), expiresInMs: 30000 });
      assert.equal(f.socket.closed, true);
      assert.equal(f.element("draft").disabled, true);
    });
  }
});

function assertInputFenced(f: Awaited<ReturnType<typeof fixture>>) {
  for (const id of ["send", "resize", "draft"]) assert.equal(f.element(id).disabled, true, `${id} must be fenced`);
  for (const key of f.keys) assert.equal(key.disabled, true);
  const before = f.socket.sent.length;
  // dispatchEvent deliberately bypasses disabled-button click suppression:
  // a visual-only fix cannot satisfy the real dispatch assertions.
  f.element("send").dispatchEvent(new Event("click"));
  for (const key of f.keys) key.dispatchEvent(new Event("click"));
  f.element("resize-form").dispatchEvent(new Event("submit"));
  assert.equal(f.socket.sent.length, before, "fenced handlers must emit no input/key/resize requests");
}

test("transport ready without a first screen cannot acquire or dispatch and expires at a bounded deadline", async (t) => {
  const f = await fixture(t);
  assert.equal(f.element("acquire").disabled, true);
  f.element("acquire").dispatchEvent(new Event("click"));
  assert.equal(f.socket.sent.length, 1, "transport ready is not interactive readiness");
  assertInputFenced(f);
  await f.advance(2001);
  assert.equal(f.socket.closed, true, "absent first screen cannot wait indefinitely");
});

test("partial first screen stays fenced and trickled frames do not renew establishment deadline", async (t) => {
  const f = await fixture(t);
  f.socket.receive({ type: "screen-start", target, sequence: 0, columns: 80, rows: 24, bytes: 1, chunks: 1 });
  await f.advance(1500);
  f.socket.receive({ type: "screen-chunk", terminalEpoch: target.terminalEpoch, sequence: 0, index: 0, data: "eA==" });
  assert.equal(f.element("acquire").disabled, true);
  f.element("acquire").dispatchEvent(new Event("click"));
  assert.equal(f.socket.sent.length, 1);
  assertInputFenced(f);
  await f.advance(501);
  assert.equal(f.socket.closed, true);
});

test("held first render does not certify readiness; successful completion alone enables acquisition", async (t) => {
  const f = await fixture(t);
  f.snapshot(0, "visible only after completion");
  assert.equal(f.element("acquire").disabled, true);
  f.element("acquire").dispatchEvent(new Event("click"));
  assert.equal(f.socket.sent.length, 1);
  assertInputFenced(f);
  f.views[0].complete();
  await settle();
  assert.equal(f.element("acquire").disabled, false);
  assertInputFenced(f); // Seeing a screen alone is not a writer grant.
});

test("failed first render never enables interaction or certifies readiness by timeout", async (t) => {
  const f = await fixture(t);
  f.failNextRender();
  f.snapshot(0, "cannot render");
  assert.equal(f.element("acquire").disabled, true);
  assertInputFenced(f);
  await settle();
  assert.equal(f.socket.closed, true);
  await f.advance(30000);
  assertInputFenced(f);
});

test("replacement render fences a valid lease at dispatch and blocked drafts do not consume input sequence", async (t) => {
  const f = await fixture(t);
  await f.acquire();
  f.edit("keep my draft");
  f.snapshot(1, "replacement prompt");
  assertInputFenced(f);
  f.views[1].complete();
  await settle();
  assert.equal(f.element("send").disabled, false);
  f.element("send").click();
  assert.equal(f.socket.sent.at(-1)?.sequence, 1);
  f.ack(2);
  f.edit("next input");
  f.element("draft").dispatchEvent(new Event("compositionstart"));
  f.element("send").dispatchEvent(new Event("click"));
  f.element("draft").dispatchEvent(new Event("compositionend"));
  f.element("send").click();
  assert.equal(f.socket.sent.at(-1)?.sequence, 2, "blocked composition dispatch cannot skip a sequence either");
});

test("queued newer screen prevents earlier completion from briefly re-enabling acquisition", async (t) => {
  const f = await fixture(t);
  f.snapshot(0, "first");
  f.snapshot(1, "newer");
  f.views[0].complete();
  await settle();
  assert.equal(f.element("acquire").disabled, true);
  assertInputFenced(f);
  f.views[1].complete();
  await settle();
  assert.equal(f.element("acquire").disabled, false);
});

test("identity change and disconnect fence readiness before any late render callback", async (t) => {
  const f = await fixture(t);
  await f.acquire();
  f.snapshot(1, "held replacement");
  f.element("disconnect").click();
  f.views[1].complete();
  await settle();
  assertInputFenced(f);
  assert.equal(f.element("screen-state").textContent, "画面已清除");
  assert.equal(f.timers.size, 0);
  const other = await fixture(t);
  await other.acquire();
  other.socket.receive({
    type: "screen-start",
    target: { ...target, sessionId: "replacement" },
    sequence: 1,
    columns: 80,
    rows: 24,
    bytes: 1,
    chunks: 1,
  });
  assert.equal(other.socket.closed, true);
  assertInputFenced(other);
});

test("ownership feedback is explicitly last-known and countdown is conservative from acquire dispatch, not ACK", async (t) => {
  const f = await fixture(t);
  await f.rendered();
  f.element("acquire").click();
  await f.advance(1500, false);
  f.ack(1, { ok: true, leaseId: "e".repeat(32), expiresInMs: 30000 });
  assert.match(f.element("connection-state").textContent, /申请已确认.*非实时/);
  assert.match(f.element("lease-state").textContent, /保守剩余 28 秒/);
  assert.match(f.element("ownership-state").textContent, /上次.*无人.*非实时/);
  await f.advance(1000);
  assert.match(f.element("lease-state").textContent, /保守剩余 27 秒/);
  const staleCallbacks = [...f.timers.values()].map((timer) => timer.callback);
  f.element("disconnect").click();
  for (const callback of staleCallbacks) callback();
  await settle();
  assert.equal(f.timers.size, 0, "late local timers never reschedule after disconnect");
  assertInputFenced(f);
});

test("expired conservative grant rejects dispatch even if a delayed browser timer has not fired", async (t) => {
  const f = await fixture(t);
  await f.acquire();
  f.edit("must not send");
  await f.advance(30001, false);
  f.element("send").dispatchEvent(new Event("click"));
  assert.equal(f.socket.closed, true);
  assert.equal(f.socket.sent.length, 2, "attach and acquire only; never input after the local deadline");
  assertInputFenced(f);
});
