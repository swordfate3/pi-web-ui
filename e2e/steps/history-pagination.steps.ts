import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { Given, When, Then, After } = createBdd();
let agent: PiWebUiHarness | undefined;
let screen = "desktop";
let errors: string[] = [];
let savedFile = "";
let initialHash = "";
const hash = () => createHash("sha256").update(readFileSync(savedFile)).digest("hex");
const rows = (page: Page) => page.locator("[data-chat-item-id]").allTextContents();
const capture = async (page: Page, name: string) => {
  mkdirSync(".tmp/history-pagination", { recursive: true });
  await page.screenshot({
    path: `.tmp/history-pagination/${screen}-${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
};

Given("an isolated paginated conversation is running at {string} size", async ({ page }, viewport: string) => {
  screen = viewport;
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(viewport === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  agent = await startPiWebUi("chat-lifecycle", { pagedHistory: true, git: false });
  const filename = readdirSync(agent.sessionDir).find((name) => name.endsWith(".jsonl"));
  if (!filename) throw new Error("Missing synthetic pagination session");
  savedFile = path.join(agent.sessionDir, filename);
  initialHash = hash();
  await page.goto(agent.pageUrl);
  await expect(page.getByRole("log")).toContainText("PAGING_LATEST_MARKER");
  await expect(page.getByRole("button", { name: "Expand date filters", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

When("I browse older answers and return one page at a time", async ({ page }) => {
  const latest = await rows(page);
  const scroll = page.getByRole("log").locator(":scope > div").first();
  await scroll.evaluate((element) => {
    element.scrollTop = 400;
    element.dispatchEvent(new Event("scroll"));
  });
  const firstOffset = await scroll.evaluate((element) => element.scrollTop);
  expect(firstOffset).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Older page", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  const middle = await rows(page);
  await page.getByRole("button", { name: "Older page", exact: true }).click();
  await expect(page.getByText("Page 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Newer page", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  expect(await rows(page)).toEqual(middle);
  await page.getByRole("button", { name: "Newer page", exact: true }).click();
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
  expect(await rows(page)).toEqual(latest);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(firstOffset, 0);
  expect(hash()).toBe(initialHash);
  await capture(page, "pinned-latest");
});

Then("long results can be read as Markdown pages in both directions", async ({ page }) => {
  await page.getByRole("button", { name: "Read full result", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Result section 0", exact: true })).toBeVisible();
  await expect(dialog.locator("table").first()).toContainText("完整");
  await expect(dialog.locator(".katex").first()).toBeVisible();
  const first = await dialog.getByTestId("entry-detail-body").innerText();
  await dialog.getByRole("button", { name: "Next result page", exact: true }).click();
  await expect(dialog.getByText("Result page 2", { exact: true })).toBeVisible();
  await expect.poll(() => dialog.getByTestId("entry-detail-body").innerText()).not.toBe(first);
  await capture(page, "markdown-page");
  await dialog.getByRole("button", { name: "Previous result page", exact: true }).click();
  await expect(dialog.getByText("Result page 1", { exact: true })).toBeVisible();
  await expect.poll(() => dialog.getByTestId("entry-detail-body").innerText()).toBe(first);
  await dialog.getByRole("button", { name: "Source", exact: true }).click();
  await expect(dialog.getByTestId("entry-detail-body")).toContainText("## Result section 0");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(hash()).toBe(initialHash);
});

Then("incoming replies leave the historical page and scroll position unchanged", async ({ page }) => {
  await page.getByRole("button", { name: "Older page", exact: true }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  const oldRows = await rows(page);
  const scroll = page.getByRole("log").locator(":scope > div").first();
  await scroll.evaluate((element) => {
    element.scrollTop = 400;
  });
  const top = await scroll.evaluate((element) => element.scrollTop);
  if (!agent) throw new Error("Missing isolated Pi");
  await agent.rpc({ type: "prompt", message: "Synthetic new reply while reading older results" });
  await expect(page.getByText("New replies available", { exact: true })).toBeVisible();
  await expect.poll(async () => rows(page)).toEqual(oldRows);
  expect(await scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
  await capture(page, "new-replies");
});

When("I explicitly return to the newest replies", async ({ page }) => {
  await page.getByRole("button", { name: "Return to latest", exact: true }).click();
});

Then("the newest generated answer is visible and pagination fits the viewport", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("你好，Pi Web UI 已收到消息。");
  await expect(page.getByText("New replies available", { exact: true })).toHaveCount(0);
  const size = page.viewportSize();
  if (!size) throw new Error("Missing viewport");
  const width = size.width;
  for (const button of await page
    .getByRole("region", { name: "Conversation history", exact: true })
    .getByRole("button")
    .all()) {
    const box = await button.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await capture(page, "live");
  const scroll = page.getByRole("log").locator(":scope > div").first();
  await scroll.evaluate((element) => {
    element.scrollTop = 400;
    element.dispatchEvent(new Event("scroll"));
  });
  const top = await scroll.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  if (!agent) throw new Error("Missing isolated Pi");
  await agent.rpc({ type: "prompt", message: "Synthetic reply while reading upward on the live page" });
  await expect
    .poll(async () => (await rows(page)).filter((row) => row.includes("你好，Pi Web UI 已收到消息。")).length)
    .toBe(2);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeCloseTo(top, 0);
  await capture(page, "live-reading");
});

After(async () => {
  await agent?.stop();
  agent = undefined;
});
