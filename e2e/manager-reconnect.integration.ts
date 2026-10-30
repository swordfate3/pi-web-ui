// Real browser -> authenticated Manager -> Hub -> isolated real Pi RPC.
// Only model responses are synthetic; no production state or credentials are used.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { type PiWebUiHarness, startPiWebUi } from "./harness/pi-process.ts";

test("outer Manager recovers session replacement and visible mobile network loss without replay", {
  skip: !process.env.PI_E2E_MANAGER_DIR && "set PI_E2E_MANAGER_DIR to a built independent Manager",
  timeout: 150_000,
}, async () => {
  const selectedManager = process.env.PI_E2E_MANAGER_DIR;
  assert.ok(selectedManager);
  const manager = path.resolve(selectedManager);
  const { startLocalService } = await import(pathToFileURL(path.join(manager, "manager/local-service.ts")).href);
  const { readHubConfig, issueSession } = await import(pathToFileURL(path.join(manager, "hub/config.ts")).href);
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const output = path.join(repositoryRoot, ".tmp/manager-reconnect");
  const root = await mkdtemp(path.join(tmpdir(), "pi-manager-mobile-e2e-"));
  const home = path.join(root, "home");
  await mkdir(path.join(home, "projects/demo"), { recursive: true });
  await mkdir(output, { recursive: true });
  let service: Awaited<ReturnType<typeof startLocalService>> | undefined;
  let pi: PiWebUiHarness | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    service = await startLocalService({
      port: 0,
      chatPort: 0,
      home,
      workspaceRoots: { projects: path.join(home, "projects") },
      defaultWorkspace: { root: "projects", path: "demo" },
      stateRoot: path.join(root, "state"),
      launcher: "/usr/bin/false",
      hubCli: path.join(manager, "dist/hub/pi-web-hub.mjs"),
    });
    const hub = readHubConfig(path.join(root, "state/chat.json"));
    const credentialFile = path.join(root, "isolated-pi.json");
    issueSession(hub, credentialFile, { label: "Mobile reconnect regression" });
    pi = await startPiWebUi("chat-lifecycle", {
      repositoryRoot,
      registration: { credentialFile, socketPath: hub.socketPath },
    });
    browser = await chromium.launch({ executablePath: process.env.PI_E2E_BROWSER_EXECUTABLE });
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const mutations: string[] = [];
    const handoffStatuses: number[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/session-handoff") handoffStatuses.push(response.status());
    });
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.type === "req" && frame.method === "prompt") mutations.push(frame.params?.message ?? "prompt");
        } catch {
          /* Protocol control frames are not user commands. */
        }
      }),
    );
    const serviceUrl = service.url;
    await page.goto(`${serviceUrl}login`);
    await page.locator("#auth-username:not([disabled])").fill("isolated-tester");
    await page.locator("#auth-password").fill("isolated-e2e-password");
    const initialized = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/setup",
    );
    await page.locator("#auth-submit").click();
    assert.equal((await initialized).status(), 200, "isolated account setup must succeed before testing chat recovery");
    await expect(page).toHaveURL(service.url);
    let sessionPath = "";
    await expect
      .poll(async () => {
        const state = await (await page.request.get(`${serviceUrl}api/local/state`)).json();
        sessionPath = state.sessions?.[0]?.path ?? "";
        return sessionPath;
      })
      .not.toBe("");
    await page.goto(service.url.slice(0, -1) + sessionPath);
    const connected = page.getByRole("img", { name: "已连接", exact: true });
    const input = page.getByTestId("message-input");
    await expect(connected).toBeVisible();
    const send = async (message: string) => {
      await input.fill(message);
      await page.getByTestId("submit-message").click();
      await expect(input).toHaveValue("");
    };
    await send("OUTER_MANAGER_FIRST_MARKER");
    await expect(page.getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
    await send("/name outer-manager-first");
    await expect(page.getByText("outer-manager-first", { exact: true }).first()).toBeVisible();
    let unavailableHandoffs = 0;
    await page.route("**/api/session-handoff", async (route) => {
      if (unavailableHandoffs++ === 0) await route.fulfill({ status: 503, body: "" });
      else await route.continue();
    });
    const firstPath = new URL(page.url()).pathname;
    await send("/new");
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(firstPath);
    await expect(connected).toBeVisible();
    const secondPath = new URL(page.url()).pathname;
    await send("OUTER_MANAGER_SECOND_MARKER");
    await expect(page.getByRole("log")).toContainText("OUTER_MANAGER_SECOND_MARKER");
    await send("/webui");
    await send("/resume");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button").filter({ hasText: "outer-manager-first" }).click();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(secondPath);
    await expect(connected).toBeVisible();
    await expect(page.getByRole("log")).toContainText("OUTER_MANAGER_FIRST_MARKER");
    await expect(page.getByRole("log")).not.toContainText("OUTER_MANAGER_SECOND_MARKER");
    assert.ok(
      handoffStatuses.filter((status) => status === 200).length >= 2,
      "both handoffs must succeed through outer Manager",
    );
    assert.ok(!handoffStatuses.includes(404), "Manager must not drop the recovery API");
    assert.ok(handoffStatuses.includes(503), "temporary successor proof failure must recover without Hub navigation");

    const recoveredPath = new URL(page.url()).pathname;
    await input.fill("UNSENT_OUTER_MANAGER_DRAFT");
    const sentBeforeLoss = mutations.length;
    let unavailableRoutes = 0;
    await page.route("**/s/**/", async (route) => {
      if (route.request().method() === "HEAD" && unavailableRoutes < 2) {
        unavailableRoutes++;
        await route.fulfill({ status: 503, body: "" });
      } else await route.continue();
    });
    await context.setOffline(true);
    // No synthetic focus/online event: continuously visible periodic probing
    // must notice the dead leg even when browser readyState remains OPEN.
    await expect(connected).not.toBeVisible({ timeout: 35_000 });
    await context.setOffline(false);
    await expect(connected).toBeVisible({ timeout: 20_000 });
    assert.equal(unavailableRoutes, 2, "temporary same-route failures must be retried automatically");
    await expect(page.getByText("会话链接已失效，请从总管重新打开这个 Pi。", { exact: true })).not.toBeVisible();
    assert.equal(new URL(page.url()).pathname, recoveredPath);
    await expect(input).toHaveValue("UNSENT_OUTER_MANAGER_DRAFT");
    await expect(page.getByRole("log")).toContainText("OUTER_MANAGER_FIRST_MARKER");
    assert.equal(mutations.length, sentBeforeLoss, "reconnection must never replay a mutation");
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, `recovered-${viewport.width}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await pi?.stop();
      } finally {
        try {
          await service?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
});
