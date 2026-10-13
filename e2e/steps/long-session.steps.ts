import { expect, test } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import WebSocket from "ws";
import { configureLongSessionFixture, getActiveHarness } from "./workspace-status.steps";

const { Given, When, Then, After } = createBdd();
let states: Array<Record<string, unknown>> = [];
let observer: WebSocket | undefined;
let browserErrors: string[] = [];

Given("真实长会话 fixture 已准备", async ({ page }) => {
  // This scenario renders and searches 6000 actual messages twice. Give the
  // trace-enabled browser a separate budget without relaxing normal scenarios.
  test.setTimeout(180_000);
  configureLongSessionFixture();
  states = [];
  browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
});

async function connectObserver() {
  const harness = getActiveHarness();
  if (!harness) throw new Error("Pi Web UI harness is not active");
  observer = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
  observer.on("error", () => {});
  observer.on("message", (data) => {
    try {
      const envelope = JSON.parse(data.toString());
      if (envelope.type === "event" && envelope.event === "state_sync") states.push(envelope.payload);
    } catch {}
  });
  await new Promise<void>((resolve, reject) => {
    observer?.once("open", resolve);
    observer?.once("error", reject);
  });
}

When("我连接真实 state_sync observer", async ({ page }) => {
  await connectObserver();
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible();
  await expect.poll(() => states.length).toBeGreaterThan(0);
});

When("我刷新长会话 Web UI", async ({ page }) => {
  const previousSnapshots = states.length;
  observer?.close();
  await page.reload();
  await expect(page.getByPlaceholder("Message Pi...")).toBeVisible({ timeout: 60_000 });
  await connectObserver();
  await expect.poll(() => states.length).toBeGreaterThan(previousSnapshots);
});

Then("长会话主聊天区和侧边栏完整可用", async ({ page }) => {
  await expect(page.getByRole("log")).toContainText("LONG_SESSION_END_MARKER_7e91f4", { timeout: 60_000 });
  const search = page.getByPlaceholder("Search conversation...");
  if (!(await search.isVisible())) await page.getByRole("button", { name: "Toggle left sidebar", exact: true }).click();
  await expect(search).toBeVisible();
  await search.fill("LONG_BRANCH_LABEL_BETA");
  // The tree is virtualized: use public match navigation to mount an offscreen
  // match rather than querying DOM for thousands of ancestor rows.
  await page.locator('[data-tree-scroll-match="next"]').click();
  const labeledRow = page.locator('[data-tree-entry-id="00000bb8"][data-tree-search-match="true"]');
  await expect(labeledRow).toBeVisible();
  await search.fill("LONG_SESSION_END_MARKER_7e91f4");
  await page.locator('[data-tree-scroll-match="next"]').click();
  const lastRow = page.locator("[data-tree-entry-id]").filter({ hasText: "LONG_SESSION_END_MARKER_7e91f4" });
  await expect(lastRow).toBeVisible();
  expect(browserErrors).toEqual([]);
});

Then("state_sync 含完整长会话条目和分叉标签", async () => {
  await expect.poll(() => states.length).toBeGreaterThan(0);
  const snapshot = states.at(-1);
  if (!snapshot) throw new Error("No state_sync snapshot observed");
  const entries = snapshot.entries;
  const treeNodes = snapshot.treeNodes;
  if (!Array.isArray(entries) || !Array.isArray(treeNodes)) throw new Error("Invalid state_sync arrays");
  // Pi may append its model/name entries at startup. Count fixture IDs exactly
  // without assuming no legitimate runtime metadata was added.
  const labelIds = new Set(["f00001f4", "f0000bb8", "f0001388"]);
  const isFixtureId = (value: unknown) =>
    typeof value === "string" &&
    ((/^[0-9a-f]{8}$/.test(value) && Number.parseInt(value, 16) < 6000) ||
      labelIds.has(value) ||
      value.startsWith("branch-"));
  expect(entries.filter((entry) => isFixtureId(entry.id))).toHaveLength(6003);
  expect(treeNodes.filter((node) => isFixtureId(node.entry.id))).toHaveLength(6006);
  const serialized = JSON.stringify(snapshot);
  expect(serialized).toContain("LONG_SESSION_END_MARKER_7e91f4");
  expect(serialized).toContain("LONG_BRANCH_LABEL_ALPHA");
  expect(serialized).toContain("LONG_BRANCH_LABEL_BETA");
  expect(serialized).toContain("LONG_BRANCH_LABEL_GAMMA");
});

After(async () => {
  observer?.close();
  observer = undefined;
});
