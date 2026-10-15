import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let usageRequests = 0;
let uploadRequests = 0;
// Synthetic 1x1 PNG, no third-party artwork is included in E2E/package.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYGD4DwAAAP//cGajQwAAAAZJREFUAwABDgEC81VxbAAAAABJRU5ErkJggg==",
  "base64",
);
function current() {
  if (!page) throw new Error("Whale page unavailable");
  return page;
}
async function open(browser: import("@playwright/test").Browser, mobile: boolean) {
  harness = await startPiWebUi("chat-lifecycle", { usageHistory: true });
  context = await browser.newContext({
    locale: "en",
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  page = await context.newPage();
  usageRequests = 0;
  uploadRequests = 0;
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const request = JSON.parse(String(payload));
      if (request.method === "get_usage_stats") usageRequests++;
      if (["prepare_upload", "prompt"].includes(request.method)) uploadRequests++;
    }),
  );
  page.on("request", (request) => {
    if (request.method() === "PUT" || request.method() === "POST") uploadRequests++;
  });
  await page.goto(harness.pageUrl);
  await expect(page.getByTestId("message-input")).toBeVisible();
  await expect(page.getByTestId("whale-pet")).toBeVisible();
}
When("我打开桌面鲸鱼娘的真实 Pi 页面", async ({ browser }) => open(browser, false));
When("我打开手机鲸鱼娘的真实 Pi 页面", async ({ browser }) => open(browser, true));

async function importIdle() {
  const p = current();
  await p.getByTestId("open-settings").click();
  await expect(p.getByTestId("whale-pet")).toHaveCount(0);
  const input = p.getByTestId("whale-asset-idle");
  await input.setInputFiles({ name: "local-only.png", mimeType: "image/png", buffer: png });
  await expect(p.getByTestId("whale-assets-status")).toContainText(/saved|stored|persistent|browser/i);
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  const image = p.getByTestId("whale-pet").locator("img");
  await expect(image).toBeVisible();
  expect(await image.getAttribute("src")).toMatch(/^blob:/);
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
}

async function rejectUnsafeImage() {
  const p = current();
  await p.getByTestId("open-settings").click();
  await p
    .getByTestId("whale-asset-idle")
    .setInputFiles({ name: "not-really.png", mimeType: "image/png", buffer: Buffer.from("<svg onload='alert(1)'/>") });
  await expect(p.getByRole("alert")).toContainText(/PNG|WebP|image|format|invalid|unsupported/i);
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expect(p.getByTestId("whale-pet").locator("img")).toBeVisible();
  await expect
    .poll(() =>
      p
        .getByTestId("whale-pet")
        .locator("img")
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
}
async function openCard() {
  const p = current();
  await p.getByTestId("whale-pet-body").click();
  const card = p.getByTestId("whale-usage-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("billed-model-a");
  await expect(card).toContainText("billed-model-b");
  await expect(card).toContainText("465");
  await expect(card).toContainText("Known subtotal");
  await expect(card).toContainText("unpriced");
  return card;
}
Then("我验证鲸鱼娘本地素材、会话用量与显示生命周期", async () => {
  const p = current();
  expect(usageRequests).toBe(0);
  await importIdle();
  await rejectUnsafeImage();
  await p.emulateMedia({ reducedMotion: "reduce" });
  await openCard();
  expect(
    await p
      .getByTestId("whale-pet")
      .locator("img")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  const initialRequests = usageRequests;
  expect(initialRequests).toBeGreaterThan(0);
  await p.keyboard.press("Escape");
  await expect(p.getByTestId("whale-usage-card")).toHaveCount(0);
  await p.waitForTimeout(5200);
  expect(usageRequests).toBe(initialRequests);
  expect(uploadRequests).toBe(0);
  const drag = p.getByTestId("whale-drag");
  await drag.focus();
  const before = await p.getByTestId("whale-pet").boundingBox();
  await p.keyboard.press("ArrowLeft");
  const after = await p.getByTestId("whale-pet").boundingBox();
  if (!after || !before) throw new Error("Whale bounds unavailable");
  expect(after.x).toBeLessThan(before.x);
  await p.getByRole("button", { name: "Collapse whale", exact: true }).click();
  await expect(p.getByTestId("whale-pet")).toHaveClass(/compact/);
  await p.reload();
  await expect(p.getByTestId("whale-pet")).toHaveClass(/compact/);
  await p.getByRole("button", { name: "Hide whale", exact: true }).click();
  await expect(p.getByTestId("whale-pet")).toHaveCount(0);
  await p.reload();
  await expect(p.getByTestId("whale-pet")).toHaveCount(0);
  await p.getByTestId("open-settings").click();
  await p.getByTestId("whale-mode-full").click();
  await p.getByRole("button", { name: "Close dialog", exact: true }).last().click();
  await expect(p.getByTestId("whale-pet").locator("img")).toBeVisible();
  await p.getByTestId("whale-pet-body").click();
  await expect(p.getByTestId("whale-usage-card")).toContainText("465");
  await p.keyboard.press("Escape");
  await p.getByTestId("message-input").fill("/new");
  await p.getByTestId("submit-message").click();
  await expect(p.getByRole("log")).not.toContainText("SYNTHETIC_USAGE_RESPONSE");
  await p.getByTestId("whale-pet-body").click();
  await expect(p.getByTestId("whale-usage-card")).not.toContainText("billed-model-a");
  await expect(p.getByTestId("whale-usage-card")).not.toContainText("billed-model-b");
  await expect(p.getByTestId("whale-usage-card")).toContainText("No response yet");
});
Then("我验证手机鲸鱼娘边界和本地素材刷新恢复", async () => {
  const p = current();
  await importIdle();
  await p.reload();
  await expect(p.getByTestId("whale-pet").locator("img")).toBeVisible();
  await openCard();
  for (const id of ["whale-pet", "whale-usage-card"]) {
    const bounds = await p.getByTestId(id).boundingBox();
    if (!bounds) throw new Error("Whale bounds unavailable");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  }
  await p.keyboard.press("Escape");
  const drag = await p.getByTestId("whale-drag").boundingBox();
  if (!drag) throw new Error("Whale drag handle unavailable");
  await p.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await p.mouse.down();
  await p.mouse.move(1, 1, { steps: 8 });
  await p.mouse.up();
  const pet = await p.getByTestId("whale-pet").boundingBox();
  if (!pet) throw new Error("Whale bounds unavailable");
  expect(pet.x).toBeGreaterThanOrEqual(0);
  expect(pet.y).toBeGreaterThanOrEqual(0);
  await openCard();
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(uploadRequests).toBe(0);
});
Then("我验证素材恢复竞态与部分持久化失败警告", async () => {
  const p = current();
  await importIdle();
  // Existing idle must survive a concurrent new-slot import while stored images decode slowly.
  await p.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) =>
      new Promise<ImageBitmap>((resolve, reject) => {
        setTimeout(() => {
          (decode as (...items: unknown[]) => Promise<ImageBitmap>)(...args).then(resolve, reject);
        }, 800);
      })) as typeof createImageBitmap;
  });
  await p.reload();
  await p.getByTestId("open-settings").click();
  await p.getByTestId("whale-asset-success").setInputFiles({ name: "success.png", mimeType: "image/png", buffer: png });
  await expect(p.getByRole("region", { name: "Local whale artwork" }).locator("img")).toHaveCount(2);
  await expect(p.getByTestId("whale-assets-status")).toContainText("saved locally");
  // First write fails, next slot succeeds. The first slot must remain visibly marked temporary.
  await p.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (++calls === 1) throw new DOMException("Synthetic storage failure", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await p.getByTestId("whale-asset-idle").setInputFiles({ name: "temporary.png", mimeType: "image/png", buffer: png });
  await expect(p.getByTestId("whale-assets-status")).toContainText("This page only: Idle");
  await p
    .getByTestId("whale-asset-thinking")
    .setInputFiles({ name: "thinking.png", mimeType: "image/png", buffer: png });
  await expect(p.getByRole("region", { name: "Local whale artwork" }).locator("img")).toHaveCount(3);
  await expect(p.getByTestId("whale-assets-status")).toContainText("This page only: Idle");
  await expect(p.getByTestId("whale-assets-status")).not.toContainText("Assets are saved locally");
});

After(async () => {
  if (!harness) return;
  await context?.close();
  context = null;
  page = null;
  await harness.stop();
  harness = null;
});
