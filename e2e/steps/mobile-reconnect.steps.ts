import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type HubCliHarness, startHubCli } from "../harness/hub-cli";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { Given, When, Then, After } = createBdd();
let hub: HubCliHarness | undefined;
let pi: PiWebUiHarness | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let originalPath = "";
let prompts = 0;
const errors: string[] = [];

Given("an isolated real Pi session is open in a mobile browser", async ({ browser }) => {
  const managerDir = process.env.PI_E2E_MANAGER_DIR;
  test.skip(!managerDir, "set PI_E2E_MANAGER_DIR to an independently built Manager");
  hub = await startHubCli({ managerDir });
  pi = await startPiWebUi("chat-lifecycle", { registration: hub.issue("Mobile recovery") });
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  page = await context.newPage();
  errors.length = 0;
  prompts = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      try {
        if (JSON.parse(String(payload)).method === "prompt") prompts++;
      } catch {
        /* Protocol control. */
      }
    }),
  );
  await page.goto(`${hub.url}sessions/`);
  await page.getByRole("link", { name: "打开会话" }).click();
  await expect(page.getByRole("img", { name: "已连接", exact: true })).toBeVisible();
  originalPath = new URL(page.url()).pathname;
  await page.getByTestId("message-input").fill("mobile reconnect baseline");
  await page.getByTestId("submit-message").click();
  await expect(page.getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
  await page.getByTestId("message-input").fill("UNSENT_MOBILE_RECOVERY_DRAFT");
});

When("the mobile browser loses network for more than fifteen seconds", async () => {
  if (!context || !page) throw new Error("Missing isolated browser");
  await context.setOffline(true);
  // Exercise the real foreground handler even if the browser has not noticed
  // its socket went stale. No WebSocket/React state or server replies are mocked.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("img", { name: "已连接", exact: true })).not.toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(17000);
  await expect(page.getByText("会话链接已失效，请从总管重新打开这个 Pi。", { exact: true })).not.toBeVisible();
});

Then("returning online restores the same conversation and unsent draft", async ({ $testInfo }) => {
  if (!context || !page) throw new Error("Missing isolated browser");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("img", { name: "已连接", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(originalPath);
  await expect(page.getByTestId("message-input")).toHaveValue("UNSENT_MOBILE_RECOVERY_DRAFT");
  await expect(page.getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
  expect(prompts).toBe(1);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const screenshot = $testInfo.outputPath(`reconnected-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await $testInfo.attach(`reconnected ${viewport.width}`, { path: screenshot, contentType: "image/png" });
  }
  expect(errors).toEqual([]);
});

After(async () => {
  try {
    await context?.close();
  } finally {
    try {
      await pi?.stop();
    } finally {
      await hub?.close();
    }
  }
  context = undefined;
  page = undefined;
  pi = undefined;
  hub = undefined;
});
