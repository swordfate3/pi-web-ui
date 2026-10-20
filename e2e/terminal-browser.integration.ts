import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { type Browser, chromium, expect, type Page } from "@playwright/test";
import { WebSocket } from "ws";
import { revokeSession } from "../hub/config.ts";
import { startTerminalBrowserServer } from "./harness/terminal-browser-server.ts";

async function until(predicate: () => boolean, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Synthetic terminal browser condition timed out; output not logged");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const browserErrors = new WeakMap<Browser, { count: number }>();
async function launch(t: TestContext) {
  const fixture = await startTerminalBrowserServer();
  t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const errors = { count: 0 };
  browserErrors.set(browser, errors);
  t.after(() => assert.equal(errors.count, 0, "terminal fixture must not have pageerror/unhandled rejection"));
  const workspace = readlinkSync(`/proc/${fixture.transport.piPid}/cwd`);
  const events = () =>
    readFileSync(path.join(workspace, "pty-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  return { ...fixture, browser, workspace, events };
}
async function pair(
  browser: Browser,
  fixture: Awaited<ReturnType<typeof startTerminalBrowserServer>>,
  access: "read" | "write" = "write",
  width = 1440,
) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 1100 : 1000 } });
  context.on("page", (page) =>
    page.on("pageerror", () => {
      const errors = browserErrors.get(browser);
      if (errors) errors.count++;
    }),
  );
  const page = await context.newPage();
  await page.goto(fixture.url);
  await expect(page.getByRole("button", { name: "解锁", exact: true })).toBeEnabled();
  await page.getByLabel("配对码", { exact: true }).fill(fixture.issueCode(access));
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByRole("button", { name: "连接终端", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(page.locator("#terminal-state")).toContainText("画面快照");
  return { page, context };
}
async function control(page: Page) {
  await page.getByRole("button", { name: "取得控制权", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeEnabled();
}
async function text(page: Page, data: string) {
  await page.getByLabel("终端文本", { exact: true }).fill(data);
  await page.getByRole("button", { name: "发送文本", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeEnabled();
}
async function key(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeEnabled();
}
async function command(page: Page, data: string) {
  await text(page, data);
  await key(page, "Enter");
}
const screenText = (page: Page) => page.locator("#terminal-screen .xterm-rows");

// The code used below grants only the fixed, newly spawned synthetic Pi target.
// Browser buttons do not constitute a real extension approval or new authority.
test("browser WS reaches the same Pi: explicit control, native confirm rejection, custom panel and live reconnect", {
  timeout: 60000,
}, async (t) => {
  const f = await launch(t);
  const { page, context } = await pair(f.browser, f);
  t.after(() => context.close());
  await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeDisabled();
  assert.equal(f.transport.controlState, "none");
  await control(page);
  await command(page, "/pty-confirm-normal");
  await expect(screenText(page)).toContainText("PTY_CONFIRM_PREVIEW_END");
  await expect(screenText(page)).toContainText("预览：中文与 emoji");
  const artifacts = path.resolve("../../downloads/pi-web-ui-visual-check");
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "terminal-browser-confirm-desktop.png"), fullPage: true });
  await key(page, "下"); // Synthetic native dialog: move to No, never approve real operations.
  await key(page, "Enter");
  await until(() => f.events().some((e) => e.event === "confirm-result"));
  assert.equal(f.events().find((e) => e.event === "confirm-result").approved, false);
  assert.equal(existsSync(path.join(f.workspace, "approved.txt")), false);
  await command(page, "/pty-panel");
  await expect(screenText(page)).toContainText("PTY_CUSTOM_PANEL");
  await key(page, "下");
  await page.getByLabel("列数", { exact: true }).fill("64");
  await page.getByLabel("行数", { exact: true }).fill("24");
  await page.getByRole("button", { name: "调整尺寸", exact: true }).click();
  await expect(page.locator("#terminal-state")).toContainText("64×24");
  await page.getByRole("button", { name: "释放控制权", exact: true }).click();
  await until(() => f.transport.controlState === "none");
  await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeDisabled();
  await expect(page.locator("#terminal-screen")).toBeEmpty();
  // No reconnect or implicit new lease after release; the next connection is an explicit click.
  await page.waitForTimeout(200);
  assert.equal(f.transport.controlState, "none");
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(screenText(page)).toContainText("> BETA");
  await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeDisabled();
  await control(page);
  await key(page, "Enter");
  await until(() => f.events().some((e) => e.event === "panel-result"));
  assert.equal(f.events().find((e) => e.event === "panel-result").result, "BETA");
  assert.deepEqual([...new Set(f.events().map((e) => e.pid))], [f.transport.piPid]);
  await page.getByRole("button", { name: "退出授权", exact: true }).click();
  await expect(page.locator("#pairing-status")).toContainText("未配对");
});

test("desktop/mobile real WS visuals, draft and IME do not auto-send, read grant cannot acquire control", {
  timeout: 60000,
}, async (t) => {
  const f = await launch(t);
  const artifacts = path.resolve("../../downloads/pi-web-ui-visual-check");
  mkdirSync(artifacts, { recursive: true });
  for (const [name, width] of [
    ["desktop", 1440],
    ["mobile", 390],
  ] as const) {
    const { page, context } = await pair(f.browser, f, "write", width);
    try {
      await control(page);
      await page.getByLabel("终端文本", { exact: true }).fill("\\".repeat(8193));
      await page.getByRole("button", { name: "发送文本", exact: true }).click();
      await expect(page.locator("#terminal-notice")).toContainText("超过 8192 字节");
      await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeEnabled();
      const opened = f.events().filter((e) => e.event === "panel-open").length;
      await page.getByLabel("终端文本", { exact: true }).fill("/pty-panel");
      await page.getByLabel("终端文本", { exact: true }).press("Enter");
      assert.equal(f.events().filter((e) => e.event === "panel-open").length, opened);
      await page.getByLabel("终端文本", { exact: true }).fill("/pty-panel");
      await page.getByLabel("终端文本", { exact: true }).dispatchEvent("compositionstart");
      await expect(page.getByRole("button", { name: "发送文本", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeDisabled();
      await page.getByLabel("终端文本", { exact: true }).dispatchEvent("compositionend");
      await page.getByRole("button", { name: "发送文本", exact: true }).click();
      await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeEnabled();
      await key(page, "Enter");
      await expect(screenText(page)).toContainText("PTY_CUSTOM_PANEL");
      await key(page, "下");
      await page.getByLabel("列数", { exact: true }).fill("40");
      await page.getByLabel("行数", { exact: true }).fill("20");
      await page.getByRole("button", { name: "调整尺寸", exact: true }).click();
      await expect(page.locator("#terminal-state")).toContainText("40×20");
      await page.screenshot({ path: path.join(artifacts, `terminal-browser-panel-${name}.png`), fullPage: true });
      const widthOkay = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      assert.equal(widthOkay, true, "page layout should wrap; only terminal container may scroll");
      await key(page, "Esc");
      await page.getByRole("button", { name: "释放控制权", exact: true }).click();
      await until(() => f.transport.controlState === "none");
    } finally {
      await context.close();
    }
  }
  const { page, context } = await pair(f.browser, f, "read", 390);
  try {
    await expect(page.getByRole("button", { name: "取得控制权", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Enter", exact: true })).toBeDisabled();
    assert.equal(f.transport.controlState, "none");
    await page.screenshot({ path: path.join(artifacts, "terminal-browser-read-mobile.png"), fullPage: true });
  } finally {
    await context.close();
  }
});

test("revocation while Enter is paused at sink closes browser and latches unknown without replay", {
  timeout: 45000,
}, async (t) => {
  const f = await launch(t);
  const { page, context } = await pair(f.browser, f);
  t.after(() => context.close());
  await control(page);
  await command(page, "/pty-confirm-normal");
  await expect(screenText(page)).toContainText("PTY_CONFIRM_PREVIEW_END");
  const dir = path.dirname(f.transport.socketPath);
  writeFileSync(path.join(dir, "pause-before-write"), "");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await until(() => existsSync(path.join(dir, "input-paused")));
  f.revoke();
  await until(() => f.transport.controlState === "revoking");
  await expect(page.locator("#terminal-notice")).toHaveText("输入交付未知，请检查终端；不要自动重试");
  unlinkSync(path.join(dir, "pause-before-write"));
  await until(() => f.transport.controlState === "none");
  assert.equal(existsSync(path.join(f.workspace, "approved.txt")), false);
  assert.equal(
    f.events().some((e) => e.event === "confirm-result"),
    false,
  );
  await expect(page.getByRole("button", { name: "连接终端", exact: true })).toBeDisabled();
  await expect(page.locator("#terminal-screen")).toBeEmpty();
  const artifacts = path.resolve("../../downloads/pi-web-ui-visual-check");
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "terminal-browser-unknown-desktop.png"), fullPage: true });
  await page.waitForTimeout(200);
  assert.equal(
    f.events().some((e) => e.event === "confirm-result"),
    false,
  );
});

async function credentials(
  f: Awaited<ReturnType<typeof startTerminalBrowserServer>>,
  access: "read" | "write" = "write",
) {
  const status = await (await fetch(`${f.url}api/status`)).json();
  const response = await fetch(`${f.url}api/unlock`, {
    method: "POST",
    headers: {
      Origin: new URL(f.url).origin,
      "Content-Type": "application/json",
      "x-pi-hub-terminal-csrf": status.csrf,
    },
    body: JSON.stringify({ code: f.issueCode(access) }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return { cookie, csrf: (await response.json()).csrf as string };
}
async function wsConnect(
  f: Awaited<ReturnType<typeof startTerminalBrowserServer>>,
  cookie: string,
  origin = new URL(f.url).origin,
) {
  const ws = new WebSocket(`${f.url.replace(/^http/, "ws")}ws`, { headers: { Cookie: cookie, Origin: origin } });
  const messages: Record<string, unknown>[] = [];
  let closed = false;
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()));
  });
  ws.on("error", () => {
    closed = true;
  });
  ws.on("close", () => {
    closed = true;
  });
  await until(() => ws.readyState === WebSocket.OPEN || closed);
  return { ws, messages, isClosed: () => closed, wait: until };
}

test("strict HTTP/WS auth rejects foreign origins, missing CSRF, readers and stale grants; active revoke closes idle readers", {
  timeout: 45000,
}, async (t) => {
  const f = await startTerminalBrowserServer();
  t.after(() => f.close());
  const { cookie, csrf } = await credentials(f, "read");
  const forbiddenHeaders: Record<string, string>[] = [
    { Origin: "https://foreign.invalid" },
    { "sec-fetch-site": "cross-site" },
    { "Service-Worker": "script" },
  ];
  for (const headers of forbiddenHeaders) {
    assert.equal((await fetch(f.url, { headers })).status, 403);
  }
  for (const route of ["sw.js", "api/status?target=other", "arbitrary", "api/files"])
    assert.equal((await fetch(f.url + route)).status, 404);
  assert.equal(
    (
      await fetch(`${f.url}api/logout`, {
        method: "POST",
        headers: { Origin: new URL(f.url).origin, Cookie: cookie, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  const foreign = await wsConnect(f, cookie, "https://foreign.invalid");
  await until(foreign.isClosed);
  const missing = await wsConnect(f, cookie);
  missing.ws.send(JSON.stringify({ type: "attach", csrf: "a".repeat(64) }));
  await until(missing.isClosed);
  const reader = await wsConnect(f, cookie);
  reader.ws.send(JSON.stringify({ type: "attach", csrf }));
  await until(() => reader.messages.some((v) => v.type === "screen"));
  reader.ws.send(JSON.stringify({ type: "control" }));
  await until(reader.isClosed);
  assert.equal(f.transport.controlState, "none");
  const idle = await wsConnect(f, cookie);
  idle.ws.send(JSON.stringify({ type: "attach", csrf }));
  await until(() => idle.messages.some((v) => v.type === "screen"));
  revokeSession(f.config, f.transport.target.runId);
  await until(idle.isClosed);
  const stale = await wsConnect(f, cookie);
  await until(stale.isClosed);
});

test("real browser foreign origin cannot fetch terminal state, frame terminal UI or open authorized WS", {
  timeout: 45000,
}, async (t) => {
  const f = await launch(t);
  const { page, context } = await pair(f.browser, f);
  t.after(() => context.close());
  const foreign = http.createServer((req, res) => {
    if (req.url === "/sw.js") {
      res
        .writeHead(200, { "Content-Type": "text/javascript" })
        .end(
          'self.addEventListener("install", () => self.skipWaiting());self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));self.addEventListener("fetch", e => e.respondWith(fetch(e.request)));',
        );
    } else
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<!doctype html><title>synthetic foreign origin</title><body>Foreign fixture</body>");
  });
  await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => foreign.close(() => resolve())));
  const address = foreign.address();
  assert.ok(address && typeof address !== "string");
  const attacker = await context.newPage();
  // Different port is a different origin; Origin checks are required even when SameSite cookies may be sent.
  await attacker.goto(`http://127.0.0.1:${address.port}/`);
  await attacker.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }),
      );
  });
  assert.equal(await attacker.evaluate(() => !!navigator.serviceWorker.controller), true);
  const blocked = await attacker.evaluate(async (target) => {
    const fetchBlocked = await fetch(`${target}api/status`, { credentials: "include" }).then(
      () => false,
      () => true,
    );
    const socketBlocked = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${target.replace(/^http/, "ws")}ws`);
      const timer = setTimeout(() => {
        ws.close();
        resolve(false);
      }, 2500);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.close();
        resolve(false);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    const frame = document.createElement("iframe");
    frame.src = target;
    document.body.append(frame);
    return { fetchBlocked, socketBlocked };
  }, f.url);
  assert.deepEqual(blocked, { fetchBlocked: true, socketBlocked: true });
  await attacker.waitForTimeout(150);
  assert.equal(
    attacker.frames().filter((frame) => frame.url() === f.url).length,
    0,
    "frame-ancestors must block terminal document",
  );
  await expect(page.locator("#terminal-state")).toContainText("画面快照");
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
  const popupEvent = attacker.waitForEvent("popup");
  await attacker.evaluate((target) => {
    window.open(target, "_blank");
  }, f.url);
  const popup = await popupEvent;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(await popup.evaluate(() => window.opener === null), true, "COOP must sever foreign opener");
  await popup.close();
});

test("two real tabs never share a writer; page hiding releases and fixed lease expires without renewal", {
  timeout: 60000,
}, async (t) => {
  const f = await launch(t);
  const first = await pair(f.browser, f);
  const second = await pair(f.browser, f);
  t.after(() => first.context.close());
  t.after(() => second.context.close());
  await control(first.page);
  await second.page.getByRole("button", { name: "取得控制权", exact: true }).click();
  await expect(second.page.locator("#terminal-notice")).toContainText("控制权请求被拒绝");
  await expect(second.page.getByRole("button", { name: "Enter", exact: true })).toBeDisabled();
  await first.page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await until(() => f.transport.controlState === "none");
  await expect(first.page.locator("#terminal-screen")).toBeEmpty();
  await control(second.page);
  await command(second.page, "/pty-panel");
  await expect(screenText(second.page)).toContainText("PTY_CUSTOM_PANEL");
  await key(second.page, "下");
  await expect(second.page.getByRole("button", { name: "Enter", exact: true })).toBeDisabled({ timeout: 32000 });
  await until(() => f.transport.controlState === "none", 32000);
  await expect(second.page.locator("#terminal-state")).toContainText("已断开");
  assert.equal(
    f.events().some((e) => e.event === "panel-result"),
    false,
  );
  await second.page.waitForTimeout(200);
  assert.equal(f.transport.controlState, "none");
});

for (const reason of ["release", "hidden", "timeout"] as const) {
  test(`${reason} cannot erase unknown while Enter is already in flight`, { timeout: 30000 }, async (t) => {
    const f = await launch(t);
    const { page, context } = await pair(f.browser, f);
    t.after(() => context.close());
    await control(page);
    await command(page, "/pty-confirm-normal");
    await expect(screenText(page)).toContainText("PTY_CONFIRM_PREVIEW_END");
    const dir = path.dirname(f.transport.socketPath);
    writeFileSync(path.join(dir, "pause-before-write"), "");
    await page.getByRole("button", { name: "Enter", exact: true }).click();
    await until(() => existsSync(path.join(dir, "input-paused")));
    if (reason === "release") await page.getByRole("button", { name: "释放控制权", exact: true }).click();
    else if (reason === "hidden")
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    // timeout case leaves Enter paused until the actual worker delivery deadline.
    await until(() => f.transport.controlState === "revoking" || f.transport.controlState === "fenced");
    await expect(page.locator("#terminal-notice")).toHaveText("输入交付未知，请检查终端；不要自动重试");
    unlinkSync(path.join(dir, "pause-before-write"));
    if (reason !== "timeout") {
      await until(() => f.transport.controlState === "none");
      assert.equal(existsSync(path.join(f.workspace, "approved.txt")), false);
      assert.equal(
        f.events().some((e) => e.event === "confirm-result"),
        false,
      );
    }
    await expect(page.getByRole("button", { name: "连接终端", exact: true })).toBeDisabled();
  });
}

test("8192 decoded input bytes survive worst-case JSON escaping; malformed/overlapping frames fence without crashing server", {
  timeout: 45000,
}, async (t) => {
  const f = await startTerminalBrowserServer();
  t.after(() => f.close());
  const { cookie, csrf } = await credentials(f, "write");
  const attach = async () => {
    const client = await wsConnect(f, cookie);
    client.ws.send(JSON.stringify({ type: "attach", csrf }));
    await until(() => client.messages.some((value) => value.type === "screen"));
    t.after(() => client.ws.terminate());
    return client;
  };
  const client = await attach();
  client.ws.send(JSON.stringify({ type: "control" }));
  await until(() => client.messages.some((value) => value.type === "control"));
  const samples = ["\\".repeat(8192), "\x01".repeat(8192)];
  for (const [index, data] of samples.entries()) {
    client.ws.send(JSON.stringify({ type: "input", sequence: index + 1, data }));
    await until(() => client.messages.some((value) => value.type === "written" && value.sequence === index + 1));
    assert.equal(
      client.messages.find((value) => value.type === "written" && value.sequence === index + 1)?.bytesWritten,
      8192,
    );
  }
  client.ws.close();
  await until(() => f.transport.controlState === "none");
  for (const payload of [
    "{",
    "x".repeat(65537),
    JSON.stringify({ type: "input", sequence: 1, data: "x".repeat(8193) }),
  ]) {
    const bad = await attach();
    if (payload.includes('"sequence":1')) {
      bad.ws.send(JSON.stringify({ type: "control" }));
      await until(() => bad.messages.some((value) => value.type === "control"));
    }
    bad.ws.send(payload);
    await until(bad.isClosed);
    await until(() => f.transport.controlState === "none");
    assert.equal((await fetch(`${f.url}api/status`)).status, 200);
  }
  const overlap = await attach();
  overlap.ws.send(JSON.stringify({ type: "control" }));
  // A second command before its ACK cannot be queued as future input.
  overlap.ws.send(JSON.stringify({ type: "input", sequence: 1, data: "\r" }));
  await until(overlap.isClosed);
  await until(() => f.transport.controlState === "none");
  assert.equal((await fetch(`${f.url}api/status`)).status, 200);
});
