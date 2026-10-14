import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { initializeHub, issueSession, readHubConfig } from "../../hub/config";
import { startHub } from "../../hub/server";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let dir: string | undefined;
let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let context: BrowserContext | undefined;
let browserPage: Page | undefined;
let agents: PiWebUiHarness[] = [];
let screen = "desktop";
let oldPath = "";
const errors: string[] = [];
function page() {
  if (!browserPage) throw new Error("Hub page is not initialized");
  return browserPage;
}
async function manager() {
  dir = mkdtempSync(path.join(tmpdir(), "pi-hub-browser-"));
  const configFile = path.join(dir, "config.json");
  initializeHub(configFile, { port: 0 });
  const config = readHubConfig(configFile);
  hub = await startHub(config);
  return config;
}

When("我在 {string} 打开有两个真实 Pi 的总管首页", async ({ browser }, viewport: string) => {
  screen = viewport;
  const config = await manager();
  for (const label of ["工作项目 Alpha", "移动端 Beta"]) {
    const credentialFile = path.join(dir ?? "", `${label}.json`);
    issueSession(config, credentialFile, { label });
    agents.push(
      await startPiWebUi("chat-lifecycle", { registration: { socketPath: config.socketPath, credentialFile } }),
    );
  }
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: screen === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: screen === "mobile",
    hasTouch: screen === "mobile",
  });
  browserPage = await context.newPage();
  errors.length = 0;
  page().on("pageerror", (error) => errors.push(error.message));
  await page().goto(`${hub?.url}sessions/`);
});

Then("首页清晰显示两个会话并保存总管截图", async ({ $testInfo }) => {
  await expect(page().locator(".card")).toHaveCount(2);
  await expect(page().getByRole("heading", { name: "所有会话，一个入口。" })).toBeVisible();
  await expect(page().getByText("● 总管已连接")).toBeVisible();
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
  await context?.close();
  context = undefined;
  browserPage = undefined;
  for (const agent of agents) await agent.stop();
  agents = [];
  await hub?.close();
  hub = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
