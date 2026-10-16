import path from "node:path";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type HubCapability, type HubCliHarness, startHubCli } from "../harness/hub-cli";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let hub: HubCliHarness | undefined;
let capabilities: HubCapability[] = [];
let context: BrowserContext | undefined;
let browserPage: Page | undefined;
let agents: PiWebUiHarness[] = [];
let screen = "desktop";
let oldPath = "";
let lastSessionId = "";
const errors: string[] = [];
function page() {
  if (!browserPage) throw new Error("Hub page is not initialized");
  return browserPage;
}
async function manager() {
  hub = await startHubCli({ repositoryRoot: path.resolve(__dirname, "../..") });
  return hub;
}

When("我在 {string} 打开有两个真实 Pi 的总管首页", async ({ browser }, viewport: string) => {
  screen = viewport;
  const managerCli = await manager();
  for (const label of ["工作项目 Alpha · ae32751f", "移动端 Beta · b1234567"]) {
    const capability = managerCli.issue(label);
    capabilities.push(capability);
    agents.push(await startPiWebUi("chat-lifecycle", { registration: capability }));
  }
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: screen === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: screen === "mobile",
    hasTouch: screen === "mobile",
  });
  browserPage = await context.newPage();
  lastSessionId = "";
  page().on("websocket", (socket) => {
    socket.on("framereceived", (frame) => {
      try {
        const value = JSON.parse(String(frame.payload));
        if (value.type === "event" && value.event === "state_sync" && value.payload.sessionId)
          lastSessionId = value.payload.sessionId;
      } catch {
        /* Ignore transport control frames. */
      }
    });
  });
  errors.length = 0;
  page().on("pageerror", (error) => errors.push(error.message));
  await page().goto(`${hub?.url}sessions/`);
});

Then("首页清晰显示两个会话并保存总管截图", async ({ $testInfo }) => {
  await expect(page().locator(".card")).toHaveCount(2);
  await expect(page().getByRole("heading", { name: "所有会话，一个入口。" })).toBeVisible();
  await expect(page().getByText("● 总管已连接")).toBeVisible();
  await expect(page().locator(".card h3")).toHaveText(["工作项目 Alpha", "移动端 Beta"]);
  await expect(page().locator(".card h3").first()).toHaveAttribute("title", "工作项目 Alpha");
  await page().getByRole("searchbox").fill("ae32751f");
  await expect(page().locator(".card")).toHaveCount(0);
  await page().getByRole("searchbox").fill("");
  await expect(page().locator(".card")).toHaveCount(2);
  await expect(page().locator(".session-name")).toHaveText(["Pi Web UI E2E", "Pi Web UI E2E"]);
  const api = await (await page().request.get(`${hub?.url}api/sessions`)).json();
  for (const session of api.sessions)
    expect((await page().locator(".card").allTextContents()).join("\n")).not.toContain(session.generation.slice(0, 8));
  await page().getByRole("searchbox").fill("Pi Web UI E2E");
  await expect(page().locator(".card")).toHaveCount(2);
  await page().getByRole("searchbox").fill("");
  expect(await page().evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  const screenshot = $testInfo.outputPath(`hub-${screen}.png`);
  await page().screenshot({ path: screenshot, fullPage: true });
  await $testInfo.attach("hub portal rendered page", { path: screenshot, contentType: "image/png" });
});

When("我搜索并打开第二个 Pi 会话", async () => {
  oldPath = (await page().locator(".card").filter({ hasText: "Alpha" }).getByRole("link").getAttribute("href")) ?? "";
  await page().getByRole("searchbox").fill("Beta");
  await expect(page().locator(".card")).toHaveCount(1);
  await page().getByRole("link", { name: "打开会话" }).click();
  await expect(page().getByTestId("message-input")).toBeVisible();
  expect(new URL(page().url()).pathname).toMatch(/^\/s\/[a-f0-9]{32}\/$/);
});

Then("总管路由中的 Pi 可以收发真实测试消息", async () => {
  await page().getByTestId("message-input").fill("hub integration test");
  await page().getByTestId("submit-message").click();
  await expect(page().getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
  expect(errors).toEqual([]);
  await inputRenameAndCheckHubName();
});

async function inputRenameAndCheckHubName() {
  const p = page();
  const originalPath = new URL(p.url()).pathname;
  await p.getByTestId("message-input").fill("/name Hub 命名测试 Beta");
  await p.getByTestId("submit-message").click();
  await expect(p.getByText("Hub 命名测试 Beta", { exact: true }).first()).toBeVisible();
  await expect
    .poll(
      async () => {
        const value = await (await p.request.get(`${hub?.url}api/sessions`)).json();
        return value.sessions.find((session: { path: string }) => session.path === originalPath)?.sessionName;
      },
      { timeout: 25000 },
    )
    .toBe("Hub 命名测试 Beta");
  await p.goto(`${hub?.url}sessions/`);
  await p.getByRole("searchbox").fill("Hub 命名测试");
  await expect(p.locator(".card")).toHaveCount(1);
  await expect(p.locator(".session-name")).toHaveText("Hub 命名测试 Beta");
  await expect(p.locator(".card h3")).toHaveText("移动端 Beta");
}

Then("新建和恢复会话自动跟随原 Pi 的新链接", async () => {
  const input = page().getByTestId("message-input");
  const send = async (message: string) => {
    await input.fill(message);
    await page().getByTestId("submit-message").click();
    await expect(input).toHaveValue("");
  };
  await send("HANDOFF_FIRST_SESSION_MARKER");
  await expect(page().getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
  await send("/name handoff-first-beta");
  await expect(page().getByText("handoff-first-beta", { exact: true }).first()).toBeVisible();
  const firstId = lastSessionId;
  expect(firstId).toBeTruthy();
  const firstPath = new URL(page().url()).pathname;
  await send("/new");
  await expect.poll(() => lastSessionId).not.toBe(firstId);
  await expect.poll(() => new URL(page().url()).pathname).not.toBe(firstPath);
  const secondId = lastSessionId;
  const secondPath = new URL(page().url()).pathname;
  expect((await page().request.get(`${hub?.url.slice(0, -1)}${firstPath}`)).status()).toBe(410);
  await send("HANDOFF_SECOND_SESSION_MARKER");
  await expect(page().getByRole("log")).toContainText("HANDOFF_SECOND_SESSION_MARKER");
  await send("/name handoff-second-beta");
  await expect(page().getByText("handoff-second-beta", { exact: true }).first()).toBeVisible();
  for (const [name, id, marker, absent] of [
    ["handoff-first-beta", firstId, "HANDOFF_FIRST_SESSION_MARKER", "HANDOFF_SECOND_SESSION_MARKER"],
    ["handoff-second-beta", secondId, "HANDOFF_SECOND_SESSION_MARKER", "HANDOFF_FIRST_SESSION_MARKER"],
  ]) {
    await send("/webui");
    await send("/resume");
    await expect(page().getByRole("dialog")).toBeVisible();
    await page().getByRole("dialog").getByRole("button").filter({ hasText: name }).click();
    await expect.poll(() => lastSessionId).toBe(id);
    await expect(page().getByRole("log")).toContainText(marker);
    await expect(page().getByRole("log")).not.toContainText(absent);
    await expect(page().getByRole("dialog")).toBeHidden();
    await expect(page().getByText("WebSocket 错误", { exact: true })).toBeHidden();
    await expect(page().getByText("WebSocket error", { exact: true })).toBeHidden();
    await expect(input).toBeVisible();
  }
  expect(new URL(page().url()).pathname).not.toBe(secondPath);
  expect((await page().request.get(`${hub?.url.slice(0, -1)}${secondPath}`)).status()).toBe(410);
  // The untouched Alpha is still live; none of the handoffs selected it.
  expect((await page().request.get(`${hub?.url.slice(0, -1)}${oldPath}`)).status()).toBe(200);
  expect(errors).toEqual([]);
  expect(await page().evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page().screenshot({ path: path.resolve(__dirname, `../../.tmp/resume-handoff-${screen}.png`) });
});

When("第一个 Pi 退出并返回总管首页", async () => {
  await agents.shift()?.stop();
  await page().goto(`${hub?.url}sessions/`);
});

Then("第二个 Pi 保持在线且旧会话链接已经失效", async () => {
  await expect(page().locator(".card")).toHaveCount(1);
  await expect(page().getByRole("heading", { name: "移动端 Beta" })).toBeVisible();
  const response = await page().request.get(`${hub?.url.slice(0, -1)}${oldPath}`);
  expect(response.status()).toBe(410);
  await page().getByRole("link", { name: "打开会话" }).click();
  await expect(page().getByTestId("message-input")).toBeVisible();
  expect(errors).toEqual([]);
});

When("我打开没有 Pi 的总管首页", async ({ browser }) => {
  await manager();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  browserPage = await context.newPage();
  await page().goto(`${hub?.url}sessions/`);
});

Then("首页显示无会话提示而不是空白页面", async () => {
  await expect(page().getByRole("heading", { name: "还没有在线会话" })).toBeVisible();
  await expect(page().getByText("● 总管已连接")).toBeVisible();
  await expect(page().locator(".card")).toHaveCount(0);
});

After(async () => {
  const results = await Promise.allSettled([context?.close()]);
  try {
    results.push(...(await Promise.allSettled(agents.map(async (agent) => agent.stop()))));
    results.push(...(await Promise.allSettled(capabilities.map(async (capability) => hub?.revoke(capability)))));
  } finally {
    results.push(...(await Promise.allSettled([hub?.close()])));
    context = undefined;
    browserPage = undefined;
    agents = [];
    capabilities = [];
    hub = undefined;
  }
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Hub scenario cleanup failed",
    );
});
