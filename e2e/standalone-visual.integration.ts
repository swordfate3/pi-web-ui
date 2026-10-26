// Real browser -> mirror HTTP/WS -> actual isolated Pi RPC. Only the model and
// source adapter data are synthetic; this runner never starts a Manager.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect } from "@playwright/test";
import { startPiWebUi } from "./harness/pi-process.ts";
import { observeBrowserErrors } from "./harness/visual-evidence.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(repositoryRoot, ".tmp/web-v1-acceptance/standalone-visual");
mkdirSync(output, { recursive: true });
const evidence: Record<string, unknown>[] = [];
const publish = (status: string) =>
  writeFileSync(
    path.join(output, "result.json"),
    `${JSON.stringify({ status, method: "Playwright fallback; standalone real Pi; synthetic model and adapters", evidence }, null, 2)}\n`,
  );
publish("in_progress");
const browser = await chromium.launch({ executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const mobile = viewport.width < 600;
    const screen = mobile ? "mobile" : "desktop";
    const rpcEvents: Record<string, unknown>[] = [];
    const agent = await startPiWebUi("chat-lifecycle", {
      repositoryRoot,
      extraExtensions: [path.join(repositoryRoot, "e2e/fixtures/web-interaction-extension.ts")],
      onRpcEvent: (event) => rpcEvents.push(event),
    });
    let context: BrowserContext | undefined;
    let gate: ReturnType<typeof observeBrowserErrors> | undefined;
    try {
      context = await browser.newContext({ viewport, locale: "en", isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const observer = observeBrowserErrors(page);
      gate = observer;
      const publicFrames: string[] = [];
      const snapshots: { sessionId: string; registrationId: string; panelId: string }[] = [];
      let currentSessionId: string | undefined;
      const screenshots: string[] = [];
      page.on("websocket", (socket) => {
        const requests = new Map<string, { panelId: string; sessionId: string }>();
        socket.on("framesent", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (frame.type === "req" && frame.method === "get_extension_panel") requests.set(frame.id, frame.params);
        });
        socket.on("framereceived", ({ payload }) => {
          publicFrames.push(String(payload));
          const frame = JSON.parse(String(payload));
          if (frame.type === "event" && frame.event === "state_sync") currentSessionId = frame.payload.sessionId;
          const request = requests.get(frame.id);
          if (frame.type === "res" && request) {
            requests.delete(frame.id);
            if (frame.ok && typeof frame.result?.registrationId === "string")
              snapshots.push({ ...request, registrationId: frame.result.registrationId });
          }
        });
      });
      const capture = async (name: string) => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No page overflow");
        const file = `${screen}-${name}.png`;
        await page.screenshot({ path: path.join(output, file), fullPage: true, animations: "disabled" });
        screenshots.push(file);
      };
      const command = async (text: string) => {
        await page.getByTestId("message-input").fill(text);
        await expect(page.getByTestId("submit-message")).toBeEnabled();
        await page.getByTestId("submit-message").click();
      };
      await page.goto(agent.pageUrl);
      await expect(page.getByTestId("message-input")).toBeVisible();
      await command("Hello isolated Web");
      await expect(page.getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
      await capture("chat");

      await command("/model");
      await expect(page.getByRole("dialog")).toContainText("Switch Model");
      await capture("model");
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();

      await command("/agents");
      let dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("子代理管理");
      await expect(dialog.getByLabel("最大并发数")).toHaveValue("2");
      const original = snapshots.find((snapshot) => snapshot.panelId === "pi-subagents-lite");
      assert.ok(original);
      assert.equal(currentSessionId, original.sessionId);
      await capture("agents");
      await dialog.getByLabel("代理类型").selectOption("worker");
      await expect(dialog.getByLabel("思考等级").locator("option")).toHaveText(["继承默认", "low", "medium"]);
      await dialog.getByRole("button", { name: "提交任务并确认", exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "提交任务并确认", exact: true })).toBeInViewport();
      await capture("agents-task");
      await dialog.getByRole("button", { name: "关闭面板", exact: true }).click();

      await command("/mcp-adapter");
      dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("MCP 服务管理");
      await expect(dialog).toContainText("isolated-tools");
      await expect(dialog.getByRole("button", { name: "OAuth 登录", exact: true })).toBeVisible();
      await capture("mcp");
      await dialog.getByRole("button", { name: "关闭面板", exact: true }).click();

      // Without a trusted Manager, sensitive preview/approval must remain in
      // the original terminal. Never simulate authority to make this green.
      const pending = agent.rpc({ type: "prompt", message: "/test-web-confirm" });
      void pending.catch(() => {});
      await expect
        .poll(() => rpcEvents.some((event) => event.type === "extension_ui_request" && event.method === "confirm"))
        .toBe(true);
      const request = rpcEvents.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
      assert.ok(request);
      const banner = page.getByTestId("terminal-prompt-banner");
      await expect(banner).toContainText("This page cannot approve or reject it");
      assert.ok(!publicFrames.join("\n").includes("PRIVATE-REAL-PI-PREVIEW"));
      await expect(banner.getByRole("button")).toHaveCount(0);
      await capture("terminal-fallback");
      agent.respondToUI(String(request.id), false);
      await pending;
      await expect(banner).toHaveCount(0);

      // Fresh session must rediscover panels, not retain old source bindings.
      await command("/new");
      await expect(page.getByRole("log")).not.toContainText("Hello isolated Web");
      await command("/agents");
      await expect(page.getByRole("dialog")).toContainText("子代理管理");
      await expect(page.getByRole("dialog").getByLabel("最大并发数")).toHaveValue("2");
      const successor = snapshots.at(-1);
      assert.ok(successor);
      assert.equal(successor.panelId, "pi-subagents-lite");
      assert.notEqual(currentSessionId, original.sessionId);
      assert.equal(successor.sessionId, currentSessionId);
      assert.notEqual(successor.registrationId, original.registrationId);
      await page.getByRole("dialog").getByRole("button", { name: "关闭面板", exact: true }).click();
      assert.ok(!publicFrames.join("\n").includes("PRIVATE-REAL-PI-PREVIEW"));
      observer.assertClean();
      evidence.push({
        status: "passed",
        url: agent.pageUrl,
        viewport,
        screenshots,
        sensitivePreviewInPublicFrames: false,
        freshSessionAndPanelRegistration: true,
        ...observer.errors,
      });
      publish("in_progress");
    } catch (error) {
      evidence.push({ status: "failed", viewport, ...gate?.errors });
      publish("failed");
      throw error;
    } finally {
      gate?.stop();
      try {
        await context?.close();
      } finally {
        await agent.stop();
      }
    }
  }
} catch (error) {
  publish("failed");
  throw error;
} finally {
  await browser.close();
}
publish("passed");
console.log("Standalone desktop/mobile visual checks passed; owned Pi/browser processes stopped.");
