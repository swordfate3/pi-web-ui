import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect, type WebSocketRoute } from "@playwright/test";
import { build } from "esbuild";
import { initializeHub, issueSession, readHubConfig } from "../hub/config.ts";
import { issueManagementCode } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";
import { issueTerminalCode, revokeTerminal } from "../hub/terminal-auth.ts";
import type { TerminalTarget } from "../hub/terminal-contract.ts";
import { type TerminalProviderConfig, terminalProviderStatus } from "../hub/terminal-provider.ts";
import { startPiWebUi } from "./harness/pi-process.ts";

const artifacts = process.env.PI_E2E_ARTIFACT_DIR ?? "/tmp/pi-task5-browser";
test("browser client successive snapshots and delayed input ACK preserve current draft", {
  timeout: 30000,
}, async (t) => {
  // UI scheduling/ownership regression only: real production listener/assets and
  // actual xterm in Chromium, controlled HTTP/WS boundary. No Gate/Docker proof.
  const dir = mkdtempSync(path.join(tmpdir(), "task5-browser-fix1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 }, terminal: { port: 0 } });
  const hub = await startHub(readHubConfig(file));
  t.after(() => hub.close());
  assert.ok(hub.terminalUrl);
  const target = {
    v: 1,
    runId: "a".repeat(32),
    runtimeId: "browser-fix1",
    sessionId: "explicit-session",
    terminalEpoch: "b".repeat(32),
    profile: "web-terminal-v1",
    inputState: "none",
    managedRestartEligible: false,
  };
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  mkdirSync(artifacts, { recursive: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 1000 : 1050 } });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    await page.route("**/api/terminal/status", (route) =>
      route.fulfill({
        json: {
          authorized: true,
          available: true,
          csrf: "c".repeat(64),
          scope: { access: "write" },
          target,
        },
      }),
    );
    await page.route("**/api/terminal/attach", (route) => route.fulfill({ json: { nonce: "d".repeat(64) } }));
    let remote: WebSocketRoute | undefined;
    let input: Record<string, unknown> | undefined;
    const inputId = () => input?.id;
    let connections = 0;
    const screens: string[] = [];
    const respond = (id: unknown, result: object) => remote?.send(JSON.stringify({ type: "response", id, result }));
    await page.routeWebSocket("**/api/terminal/ws", (ws) => {
      connections++;
      remote = ws;
      ws.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "attach") {
          ws.send(JSON.stringify({ type: "ready", target }));
          // No display wait between two complete, independently valid snapshots.
          for (const [sequence, data] of ["BURST FIRST", "BURST SECOND 中文画面"].entries()) {
            const bytes = Buffer.from(data);
            for (const output of [
              { type: "screen-start", target, sequence, columns: 80, rows: 24, bytes: bytes.length, chunks: 1 },
              {
                type: "screen-chunk",
                sequence,
                terminalEpoch: target.terminalEpoch,
                index: 0,
                data: bytes.toString("base64"),
              },
              { type: "screen-end", sequence, terminalEpoch: target.terminalEpoch },
            ])
              screens.push(JSON.stringify(output));
          }
        } else if (frame.type === "acquire")
          respond(frame.id, { ok: true, leaseId: "e".repeat(32), expiresInMs: 30000 });
        else if (frame.type === "input") input = frame;
      });
    });
    await page.goto(hub.terminalUrl);
    await expect(page.locator("#connect")).toBeEnabled();
    await page.locator("#access").selectOption("write");
    await page.locator("#connect").click();
    await expect(page.locator("#connection-state")).toContainText("等待完整画面");
    await expect(page.locator("#acquire")).toBeDisabled();
    await expect(page.locator("#draft")).toBeDisabled();
    await expect(page.locator("#send")).toBeDisabled();
    await page.screenshot({ path: path.join(artifacts, `${width}-final-fix-awaiting-screen.png`), fullPage: true });
    const first = screens.shift();
    assert.ok(first && remote);
    remote.send(first);
    await expect(page.locator("#acquire")).toBeDisabled();
    for (const output of screens) remote?.send(output);
    await expect(page.locator("#screen-state")).toContainText("#1");
    await expect(page.locator("#terminal-screen .xterm-rows")).toContainText("BURST SECOND 中文画面");
    await page.locator("#acquire").click();
    await expect(page.locator("#draft")).toBeEnabled();
    const draft = page.locator("#draft");
    await draft.fill("未发送的中文草稿");
    await page.getByRole("button", { name: "Tab", exact: true }).click();
    await expect.poll(() => input?.data).toBe("\t");
    respond(inputId(), { ok: true, delivery: "written" });
    await expect(page.locator("#send")).toBeEnabled();
    await expect(draft).toHaveValue("未发送的中文草稿");
    input = undefined;
    await page.locator("#send").click();
    await expect.poll(() => input?.data).toBe("未发送的中文草稿");
    await draft.fill("新的未发送草稿，必须保留");
    respond(inputId(), { ok: true, delivery: "written" });
    await expect(page.locator("#send")).toBeEnabled();
    await expect(draft).toHaveValue("新的未发送草稿，必须保留");
    await expect(page.locator("#connection-state")).toContainText("控制申请已确认（非实时）");
    await expect(page.locator("#ownership-state")).toContainText("上次核对输入归属：无人（非实时");
    await expect(page.locator("#lease-state")).toContainText(/保守剩余 (?:[0-9]|[12][0-9]) 秒/);
    await page.screenshot({ path: path.join(artifacts, `${width}-final-fix-draft-preserved.png`), fullPage: true });
    input = undefined;
    await page.locator("#send").click();
    await expect.poll(() => input?.data).toBe("新的未发送草稿，必须保留");
    respond(inputId(), { ok: true, delivery: "written" });
    await expect(draft).toHaveValue("");
    await page.locator("#disconnect").click();
    await expect(page.locator("#screen-state")).toContainText("画面已清除");
    assert.equal(connections, 1, "no automatic reconnect");
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close();
  }
});
test("real Pi startup chat is visibly readonly with nonprivileged terminal link; manual restart outcome is explicit", {
  timeout: 60000,
}, async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "task5-chat-browser-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = "d".repeat(64),
    credentialFile = path.join(dir, "update.json");
  writeFileSync(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
  const job = {
    id: "e".repeat(32),
    version: "1.3.0",
    status: "manual_restart_required",
    stage: "installed_manual_restart_required",
    targets: [
      {
        run_id: "a".repeat(32),
        status: "manual_restart_required",
        profile: "web-terminal-v1",
        wait_reason: "terminal_profile_unaudited",
      },
    ],
  };
  // Only the runtime-update HTTP boundary is synthetic; the management UI,
  // decoder, auth and real Pi chat/mirror/registration path are production code.
  const update = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.method !== "GET") {
      res.writeHead(403).end();
      return;
    }
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ policy: { mode: "manual" }, jobs: [job], active: [] }));
  });
  await new Promise<void>((resolve) => update.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => update.close(() => resolve())));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 }, terminal: { port: 0 } });
  const config = readHubConfig(file);
  config.runtimeUpdates = { endpoint: `http://127.0.0.1:${(update.address() as AddressInfo).port}`, credentialFile };
  const hub = await startHub(config, { versions: { source: async () => ({}) } });
  assert.ok(hub.terminalUrl && hub.managementUrl);
  const terminalUrl = hub.terminalUrl,
    managementUrl = hub.managementUrl;
  t.after(() => hub.close());
  const registrationFile = path.join(dir, "registration.json");
  issueSession(config, registrationFile, { label: "Terminal readonly from startup" });
  const env = {
    PI_RUNTIME_PROFILE: "web-terminal-v1",
    PI_RUNTIME_RUN_ID: "a".repeat(32),
    PI_RUNTIME_TERMINAL_EPOCH: "b".repeat(32),
    PI_RUNTIME_CHILD_TOKEN: "c".repeat(64),
    PI_RUNTIME_EXTENSION_SOCKET: path.join(dir, "adapter.sock"),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  let agent: Awaited<ReturnType<typeof startPiWebUi>>;
  try {
    Object.assign(process.env, env);
    agent = await startPiWebUi("chat-lifecycle", {
      repositoryRoot: root,
      git: false,
      registration: { socketPath: hub.socketPath, credentialFile: registrationFile },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(() => agent.stop());
  let route = "";
  await expect
    .poll(async () => {
      const data = await (await fetch(`${hub.url}api/sessions`)).json();
      route = data.sessions[0]?.path ?? "";
      return !!route;
    })
    .toBe(true);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  mkdirSync(artifacts, { recursive: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    await page.goto(new URL(route, hub.url).href);
    await expect(page.getByTestId("terminal-readonly-banner")).toContainText("聊天从启动起只读");
    const link = page.getByRole("link", { name: "打开独立终端", exact: false });
    await expect(link).toHaveAttribute("href", terminalUrl);
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(page.locator("textarea").first()).toBeDisabled();
    await expect(page.getByText("Connect to the running Pi session and send a message.", { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Connect your phone to Pi", exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, `${width}-chat-startup-readonly.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.goto(`${managementUrl}sessions/`);
    await page.locator("details.management > summary").click();
    await page.getByLabel("一次性管理码").fill(issueManagementCode(config).code);
    await page.getByRole("button", { name: "解锁管理", exact: true }).click();
    await expect(page.locator("#runtime-update-results")).toContainText("手动");
    await expect(page.locator("#runtime-update-results")).toContainText("退出");
    await expect(page.locator("#runtime-update-results")).toContainText("重新启动");
    await page.screenshot({ path: path.join(artifacts, `${width}-manual-restart.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
test("production terminal assets: desktop/mobile unpaired and unavailable states never auto-attach", {
  timeout: 30000,
}, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "task5-browser-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 }, terminal: { port: 0 } });
  const config = readHubConfig(file);
  const grant = issueSession(config, path.join(dir, "run.json"), { label: "Task5 browser" });
  const scope = {
    runId: grant.run_id,
    runtimeId: "runtime",
    sessionId: "session",
    terminalEpoch: "a".repeat(32),
    access: "write",
  };
  const hub = await startHub(config);
  t.after(() => hub.close());
  assert.ok(hub.terminalUrl);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  mkdirSync(artifacts, { recursive: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 1000 : 1050 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.name));
    let websockets = 0;
    page.on("websocket", () => websockets++);
    await page.goto(hub.terminalUrl);
    await expect(page.getByRole("heading", { name: "独立终端" })).toBeVisible();
    await expect(page.getByRole("button", { name: "连接终端", exact: true })).toBeDisabled();
    await page.screenshot({ path: path.join(artifacts, `${width}-unpaired.png`), fullPage: true });
    await page.getByLabel("一次性终端配对码").fill(issueTerminalCode(config, scope).code);
    await page.getByRole("button", { name: "解锁终端", exact: true }).click();
    await expect(page.locator("#connection-state")).toContainText("不可用");
    await expect(page.getByRole("button", { name: "取得控制权", exact: true })).toBeDisabled();
    assert.equal(websockets, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(artifacts, `${width}-unavailable.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close();
  }
});

test("actual Chromium → production Hub → actual Gate/Engine → bundled runtime/PTY; explicit Chinese input and fencing", {
  timeout: 120000,
}, async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "task5-actual-gate-"));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 }, terminal: { port: 0 } });
  const config = readHubConfig(file);
  const grant = issueSession(config, path.join(dir, "run.json"), { label: "Task5 isolated Gate" });
  const probe = path.join(dir, "secret-probe.mjs");
  await build({
    stdin: {
      contents: `import assert from 'node:assert/strict'; import {readTerminalProviderSecret} from './hub/terminal-provider.ts'; import {readPrivateJson} from './hub/config.ts'; const file='/run/pi-terminal-credentials/provider.token'; if(process.argv[2]==='reject'){assert.throws(()=>readTerminalProviderSecret(file));}else{assert.match(readTerminalProviderSecret(file),/^[a-f0-9]{64}$/);assert.throws(()=>readPrivateJson(file));}`,
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: probe,
    logLevel: "silent",
  });
  const child = spawn(
    "/usr/bin/python3",
    ["-B", path.join(root, "e2e/fixtures/task5-gate-stack.py"), dir, grant.run_id],
    { env: { ...process.env, PI_TASK5_SECRET_PROBE: probe }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages: Record<string, unknown>[] = [];
  let output = "",
    diagnostic = "";
  child.stdout.on("data", (data) => {
    output += data;
    for (;;) {
      const end = output.indexOf("\n");
      if (end < 0) break;
      messages.push(JSON.parse(output.slice(0, end)));
      output = output.slice(end + 1);
    }
  });
  child.stderr.on("data", (data) => {
    if (diagnostic.length < 8192) diagnostic += data;
  });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    await browser?.close();
    await hub?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end("stop\n");
      const deadline = setTimeout(() => child.kill("SIGTERM"), 20000);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      clearTimeout(deadline);
    }
    assert.equal(
      messages.some((m) => m.type === "cleanup" && m.ownedResourcesRemoved === true),
      true,
      "fixture must report exact owned Docker cleanup",
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const wait = async (read: () => boolean, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (!read()) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`isolated Gate fixture exited; ${diagnostic}`);
      assert.ok(Date.now() < deadline, "isolated Gate condition timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await wait(() => messages.some((m) => m.type === "ready"), 60000);
  const ready = messages.find((m) => m.type === "ready");
  assert.ok(ready && config.terminal);
  assert.equal(
    ready.permissionProbe,
    true,
    "production reader tested root:GID1000/0640 readonly and refused writable/generic0600",
  );
  const target = ready.target as TerminalTarget;
  const providerConfig = ready.provider as TerminalProviderConfig;
  config.terminal.provider = providerConfig;
  hub = await startHub(config);
  assert.ok(hub.terminalUrl);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
  const scope = {
    runId: target.runId,
    runtimeId: target.runtimeId,
    sessionId: target.sessionId,
    terminalEpoch: target.terminalEpoch,
    access: "write",
  };
  const errors: string[] = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 1000 : 1050 } });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.name));
    let inputFrames = 0,
      connections = 0;
    page.on("websocket", (ws) => {
      connections++;
      ws.on("framesent", (event) => {
        const v = JSON.parse(String(event.payload));
        if (v.type === "input") inputFrames++;
      });
    });
    await page.goto(hub.terminalUrl);
    await page.getByLabel("一次性终端配对码").fill(issueTerminalCode(config, scope).code);
    await page.getByRole("button", { name: "解锁终端", exact: true }).click();
    await expect(page.getByRole("button", { name: "连接终端", exact: true })).toBeEnabled();
    assert.equal(connections, 0);
    await page.getByRole("button", { name: "连接终端", exact: true }).click();
    await expect(page.locator("#screen-state")).toContainText("完整画面快照");
    await expect(page.getByRole("button", { name: "取得控制权", exact: true })).toBeDisabled();
    await expect(page.locator("#connection-state")).toContainText("只读查看");
    await expect
      .poll(async () =>
        (await page.locator("#terminal-screen .xterm-rows").innerText()).includes("TASK5 NATIVE SCREEN READY"),
      )
      .toBe(true);
    await page.screenshot({ path: path.join(artifacts, `${width}-connected-readonly.png`), fullPage: true });
    await page.getByRole("button", { name: "断开 / 释放", exact: true }).click();
    await page.locator("#access").selectOption("write");
    await page.getByRole("button", { name: "连接终端", exact: true }).click();
    await expect(page.locator("#screen-state")).toContainText("完整画面快照");
    await page.getByRole("button", { name: "取得控制权", exact: true }).click();
    await expect(page.getByRole("button", { name: "发送文本", exact: true })).toBeEnabled();
    await expect(page.locator("#connection-state")).toContainText("控制申请已确认（非实时）");
    const draft = page.locator("#draft");
    await draft.dispatchEvent("compositionstart", { data: "中" });
    await draft.fill("中文输入");
    await expect(page.getByRole("button", { name: "发送文本", exact: true })).toBeDisabled();
    assert.equal(inputFrames, 0);
    await draft.dispatchEvent("compositionend", { data: "中文输入" });
    await expect(page.getByRole("button", { name: "发送文本", exact: true })).toBeEnabled();
    await draft.press("Enter");
    assert.equal(inputFrames, 0, "draft Enter does not tunnel keyboard input");
    await draft.fill("中文输入");
    await page.getByRole("button", { name: "发送文本", exact: true }).click();
    await expect(page.locator("#delivery-state")).toContainText("已写入终端");
    await page.getByRole("button", { name: "Enter", exact: true }).click();
    await expect
      .poll(async () => (await page.locator("#terminal-screen .xterm-rows").innerText()).includes("RECEIVED:中文输入"))
      .toBe(true);
    const before = inputFrames;
    await draft.fill("MULTI_ONE\nMULTI_TWO\n");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "发送文本", exact: true }).click();
    assert.equal(inputFrames, before);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "发送文本", exact: true }).click();
    await expect
      .poll(async () => (await page.locator("#terminal-screen .xterm-rows").innerText()).includes("RECEIVED:MULTI_TWO"))
      .toBe(true);
    await page.locator("summary").click();
    await page.locator("#columns").fill("90");
    await page.locator("#rows").fill("25");
    await page.getByRole("button", { name: "应用尺寸", exact: true }).click();
    await expect(page.locator("#delivery-state")).toContainText("尺寸已确认");
    await expect(page.locator("#screen-state")).toContainText("90 × 25");
    await page.screenshot({ path: path.join(artifacts, `${width}-controlled-ime.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const count = connections;
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("#connection-state")).toContainText("已断开");
    await expect(page.getByRole("button", { name: "发送文本", exact: true })).toBeDisabled();
    assert.equal(connections, count);
    await page.screenshot({ path: path.join(artifacts, `${width}-hidden-disconnected.png`), fullPage: true });
    await context.close();
    await expect
      .poll(async () => (await terminalProviderStatus(providerConfig, target.runId)).inputState)
      .not.toBe("remote");
  }
  // Browser reload never reconnects; changing the native child session cannot
  // silently retarget an existing explicit authorization.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  await page.goto(hub.terminalUrl);
  await page.getByLabel("一次性终端配对码").fill(issueTerminalCode(config, scope).code);
  await page.getByRole("button", { name: "解锁终端", exact: true }).click();
  await expect(page.getByRole("button", { name: "连接终端", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.locator("#connection-state")).toContainText("尚未连接");
  await page.locator("#access").selectOption("write");
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(page.locator("#screen-state")).toContainText("完整画面快照");
  await page.getByRole("button", { name: "取得控制权", exact: true }).click();
  await expect(page.locator("#draft")).toBeEnabled();
  await expect(page.locator("#connection-state")).toContainText("控制申请已确认（非实时）");
  // Advance only this browser's clock: this proves the local UI fence and
  // display, not a new real-time broker lease-expiry validation.
  await page.clock.fastForward(30001);
  await expect(page.locator("#connection-state")).toContainText("已断开");
  await expect(page.locator("#lease-state")).toContainText("未取得控制权");
  await expect(page.locator("#draft")).toBeDisabled();
  await expect(page.locator("#delivery-state")).toContainText("租期已结束");
  await page.screenshot({ path: path.join(artifacts, "1280-lease-expired.png"), fullPage: true });
  await expect
    .poll(async () => (await terminalProviderStatus(providerConfig, target.runId)).inputState)
    .not.toBe("remote");
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(page.locator("#screen-state")).toContainText("完整画面快照");
  await page.getByRole("button", { name: "取得控制权", exact: true }).click();
  await expect(page.locator("#draft")).toBeEnabled();
  revokeTerminal(config);
  await expect(page.locator("#connection-state")).toContainText("已断开");
  // A new pairing still binds the old explicit target; native session changes
  // must close that stream, not follow the replacement session automatically.
  await page.reload();
  await page.getByLabel("一次性终端配对码").fill(issueTerminalCode(config, scope).code);
  await page.getByRole("button", { name: "解锁终端", exact: true }).click();
  await page.locator("#access").selectOption("write");
  await page.getByRole("button", { name: "连接终端", exact: true }).click();
  await expect(page.locator("#screen-state")).toContainText("完整画面快照");
  await page.getByRole("button", { name: "取得控制权", exact: true }).click();
  await expect(page.locator("#draft")).toBeEnabled();
  let replacements = 0;
  page.on("websocket", () => replacements++);
  await page.locator("#draft").fill("SWITCH_SESSION");
  await page.getByRole("button", { name: "发送文本", exact: true }).click();
  await expect(page.locator("#delivery-state")).toContainText("已写入终端");
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.locator("#connection-state")).toContainText("已断开");
  await expect(page.locator("#draft")).toBeDisabled();
  await page.reload();
  await expect(page.locator("#connection-state")).toContainText("不可用");
  await expect(page.getByRole("button", { name: "连接终端", exact: true })).toBeDisabled();
  assert.equal(replacements, 0, "identity change and reload never reconnect or retarget");
  await page.screenshot({ path: path.join(artifacts, "1280-session-replaced.png"), fullPage: true });
  assert.deepEqual(errors, []);
  child.stdin.write("assert-live\n");
  await wait(() => messages.some((m) => m.type === "live" && m.sameChild === true));
  await context.close();
});
