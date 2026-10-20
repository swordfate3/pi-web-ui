import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import type { ScreenSnapshot } from "../hub/terminal-screen.ts";
import { startPtyTransport } from "./harness/pty-transport.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
async function until(predicate: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Synthetic screen condition timed out; content not logged");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function frameReader(accept: (value: Record<string, unknown>) => void) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, "utf8") > 2097152) throw new Error("Synthetic screen receive budget exceeded");
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const value = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      accept(value);
    }
  };
}

test("screen client preserves Chinese and emoji across every UTF-8 byte boundary", () => {
  const value = { type: "screen", sequence: 1, columns: 40, rows: 8, data: "预览：中文与 emoji 🐳\r\n\x1b[31mEND" };
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  for (let boundary = 0; boundary <= encoded.length; boundary++) {
    const received: unknown[] = [];
    const read = frameReader((frame) => received.push(frame));
    read(encoded.subarray(0, boundary));
    read(encoded.subarray(boundary));
    assert.deepEqual(received, [value]);
  }
  const received: unknown[] = [];
  const read = frameReader((frame) => received.push(frame));
  for (const byte of encoded) read(Buffer.from([byte]));
  assert.deepEqual(received, [value]);
});

async function client(socketPath: string, token: string) {
  const socket = createConnection(socketPath);
  const frames: ScreenSnapshot[] = [];
  const messages: Record<string, unknown>[] = [];
  let closed = false;
  socket.on("error", () => {
    closed = true;
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.on(
    "data",
    frameReader((value) => {
      messages.push(value);
      if (value.type === "screen") frames.push(value as ScreenSnapshot);
    }),
  );
  const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
  const request = async (value: unknown, type: string) => {
    const start = messages.length;
    send(value);
    await until(() => messages.slice(start).some((m) => m.type === type) || closed);
    assert.equal(closed, false, "transport closed during screen request");
    return messages.slice(start).find((m) => m.type === type) as Record<string, unknown>;
  };
  const attached = await request({ type: "auth", token }, "attached");
  assert.equal(attached.screenAvailable, true);
  await until(() => frames.length > 0);
  return { socket, frames, messages, request, send, close: () => socket.destroy() };
}

test("real Pi framebuffer survives reader reconnect and restores in browser at desktop/mobile sizes", {
  timeout: 60000,
}, async (t) => {
  const transport = await startPtyTransport({ screen: true });
  t.after(() => transport.close());
  const writer = await client(transport.socketPath, transport.writeToken);
  t.after(writer.close);
  const lease = await writer.request({ type: "control", terminalEpoch: transport.target.terminalEpoch }, "control");
  let sequence = 0;
  const input = (data: string) =>
    writer.request(
      {
        v: 1,
        type: "input",
        terminalEpoch: transport.target.terminalEpoch,
        leaseId: lease.leaseId,
        sequence: ++sequence,
        data,
      },
      "written",
    );
  await input("/pty-confirm-normal");
  await input("\r");
  await until(() => writer.frames.some((f) => f.data.includes("PTY_CONFIRM_PREVIEW_END")));
  const confirmation = [...writer.frames]
    .reverse()
    .find((f) => f.data.includes("PTY_CONFIRM_PREVIEW_END")) as ScreenSnapshot;
  const reader = await client(transport.socketPath, transport.readToken);
  t.after(reader.close);
  assert.ok(reader.frames[0].data.includes("PTY_CONFIRM_PREVIEW_BEGIN"));
  assert.ok(reader.frames[0].data.includes("预览：中文与 emoji"));
  assert.ok(reader.frames[0].sequence >= confirmation.sequence);
  assert.equal(
    reader.messages.some((m) => m.type === "output"),
    false,
    "screen mode never mixes raw deltas",
  );
  reader.close();
  await input("\x1b");
  const workspace = readlinkSync(`/proc/${transport.piPid}/cwd`);
  const events = () =>
    readFileSync(path.join(workspace, "pty-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  await until(() => events().some((e) => e.event === "confirm-result"));
  await input("/pty-panel");
  await input("\r");
  await input("\x1b[B");
  await until(() => writer.frames.some((f) => f.data.includes("PTY_CUSTOM_PANEL") && f.data.includes("> BETA")));
  const reconnected = await client(transport.socketPath, transport.readToken);
  t.after(reconnected.close);
  assert.ok(reconnected.frames[0].data.includes("PTY_CUSTOM_PANEL"));
  assert.ok(reconnected.frames[0].data.includes("> BETA"));
  await writer.request(
    { type: "resize", terminalEpoch: transport.target.terminalEpoch, leaseId: lease.leaseId, columns: 64, rows: 24 },
    "resized",
  );
  await until(() =>
    reconnected.frames.some((f) => f.columns === 64 && f.rows === 24 && f.data.includes("PTY_CUSTOM_PANEL")),
  );
  const panel = [...reconnected.frames]
    .reverse()
    .find((f) => f.columns === 64 && f.rows === 24 && f.data.includes("PTY_CUSTOM_PANEL")) as ScreenSnapshot;
  assert.deepEqual([...new Set(events().map((e) => e.pid))], [transport.piPid]);

  // Standalone read-only visual harness, not a product terminal origin or input API.
  const bundle = await build({
    stdin: {
      contents:
        'import {TerminalScreenView} from "./e2e/fixtures/terminal-screen-view.ts"; window.fixtureView = new TerminalScreenView(document.getElementById("terminal"));',
      resolveDir: ROOT,
    },
    bundle: true,
    write: false,
    format: "iife",
  });
  const css = readFileSync(path.join(ROOT, "node_modules/@xterm/xterm/css/xterm.css"));
  // Reuse an already installed monospaced font; no font downloads or host installs.
  const font = readFileSync(path.join(ROOT, "node_modules/katex/dist/fonts/KaTeX_Typewriter-Regular.woff2"));
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; frame-ancestors 'none'",
    );
    if (req.url === "/app.js")
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].contents);
    else if (req.url === "/style.css") res.writeHead(200, { "Content-Type": "text/css" }).end(css);
    else if (req.url === "/mono.woff2") res.writeHead(200, { "Content-Type": "font/woff2" }).end(font);
    else if (req.url === "/")
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>隔离 PTY 只读画面验证</title><style>@font-face{font-family:FixtureMono;src:url(/mono.woff2)}body{background:#10151e;color:#e4eaf3;font:14px sans-serif;margin:16px}h1{font-size:18px}#viewport{overflow:auto;border:1px solid #52627a;padding:8px}#terminal{width:max-content;min-width:100%;}p{line-height:1.6}</style><h1>隔离 PTY · 只读画面验证</h1><p>合成测试数据 · 同一 Pi 的完整屏幕快照<br>本页面不提供终端输入或真实授权<br>保持终端原始列宽；小屏请横向滚动画面</p><div id="viewport"><div id="terminal"></div></div><script src="/app.js"></script>',
        );
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const artifacts = path.join(ROOT, "../../downloads/pi-web-ui-visual-check");
  mkdirSync(artifacts, { recursive: true });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    const page = await browser.newPage({ viewport });
    try {
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.waitForFunction(() => !!(window as unknown as { fixtureView?: unknown }).fixtureView);
      await page.evaluate(async () => {
        await document.fonts.load("16px FixtureMono");
        await document.fonts.ready;
      });
      const restore = (frame: ScreenSnapshot) =>
        page.evaluate(async (snapshot) => {
          const view = (
            window as unknown as {
              fixtureView: { restore: (frame: ScreenSnapshot) => Promise<void>; inspect: () => { lines: string[] } };
            }
          ).fixtureView;
          await view.restore(snapshot);
          return view.inspect();
        }, frame);
      const first = await restore(confirmation);
      assert.ok(first.lines.some((s) => s.includes("PTY_CONFIRM_PREVIEW_BEGIN")));
      assert.ok(first.lines.some((s) => s.includes("PTY_CONFIRM_PREVIEW_END")));
      await page.screenshot({ path: path.join(artifacts, `terminal-screen-confirm-${name}.png`), fullPage: true });
      const next = await restore(panel);
      assert.ok(next.lines.some((s) => s.includes("> BETA")));
      await page.screenshot({ path: path.join(artifacts, `terminal-screen-panel-${name}.png`), fullPage: true });
      assert.equal(await page.locator("a").count(), 0);
      // Disposing while xterm's asynchronous write is active must settle, not hang.
      assert.equal(
        await page.evaluate(async (snapshot) => {
          const view = (
            window as unknown as {
              fixtureView: { restore: (frame: ScreenSnapshot) => Promise<void>; dispose: () => void };
            }
          ).fixtureView;
          const result = view.restore(snapshot).then(
            () => false,
            () => true,
          );
          view.dispose();
          return await result;
        }, panel),
        true,
      );
    } finally {
      await page.close();
    }
  }
});

test("screen transport disconnect still fences an Enter paused before actual PTY admission", {
  timeout: 30000,
}, async (t) => {
  const transport = await startPtyTransport({ screen: true });
  t.after(() => transport.close());
  const writer = await client(transport.socketPath, transport.writeToken);
  t.after(writer.close);
  const epoch = transport.target.terminalEpoch;
  const lease = await writer.request({ type: "control", terminalEpoch: epoch }, "control");
  const input = (sequence: number, data: string) =>
    writer.request({ v: 1, type: "input", terminalEpoch: epoch, leaseId: lease.leaseId, sequence, data }, "written");
  await input(1, "/pty-confirm-normal");
  await input(2, "\r");
  await until(() => writer.frames.some((f) => f.data.includes("PTY_CONFIRM_PREVIEW_END")));
  const directory = path.dirname(transport.socketPath);
  writeFileSync(path.join(directory, "pause-before-write"), "");
  writer.send({ v: 1, type: "input", terminalEpoch: epoch, leaseId: lease.leaseId, sequence: 3, data: "\r" });
  await until(() => existsSync(path.join(directory, "input-paused")));
  writer.close();
  await until(() => transport.controlState === "revoking");
  assert.equal(existsSync(path.join(directory, String(lease.leaseId))), false);
  unlinkSync(path.join(directory, "pause-before-write"));
  await until(() => transport.controlState === "none");
  const workspace = readlinkSync(`/proc/${transport.piPid}/cwd`);
  assert.equal(existsSync(path.join(workspace, "approved.txt")), false);
  const events = () =>
    readFileSync(path.join(workspace, "pty-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  assert.equal(
    events().some((event) => event.event === "confirm-result"),
    false,
  );
  const successor = await client(transport.socketPath, transport.writeToken);
  t.after(successor.close);
  const next = await successor.request({ type: "control", terminalEpoch: epoch }, "control");
  await successor.request(
    { v: 1, type: "input", terminalEpoch: epoch, leaseId: next.leaseId, sequence: 1, data: "\x1b" },
    "written",
  );
  await until(() => events().some((event) => event.event === "confirm-result"));
  assert.equal(events().find((event) => event.event === "confirm-result").approved, false);
});
