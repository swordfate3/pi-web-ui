import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type PiWebUiHarness, startPiWebUi } from "../harness/pi-process";

const { When, Then, After } = createBdd();
let harness: PiWebUiHarness | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let mobile = false;
let requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
let sourceBetaId = "";
let editedId = "";
let regeneratedId = "";
function current() {
  if (!page) throw new Error("Revision page missing");
  return page;
}
function entries(): Array<{
  id: string;
  parentId: string | null;
  type: string;
  message?: { role: string; content: unknown };
}> {
  if (!harness) throw new Error("Revision harness missing");
  const { sessionDir } = harness;
  const files = readdirSync(sessionDir, { recursive: true }).filter(
    (f) => typeof f === "string" && f.endsWith(".jsonl"),
  );
  return files.flatMap((f) =>
    readFileSync(path.join(sessionDir, String(f)), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
}
function answerId(text: string) {
  const entry = entries().find(
    (e) => e.message?.role === "assistant" && JSON.stringify(e.message.content).includes(text),
  );
  if (!entry) throw new Error(`Missing saved answer ${text}`);
  return entry.id;
}
async function send(text: string) {
  const p = current();
  await p.getByTestId("message-input").fill(text);
  await p.getByTestId("submit-message").click();
}
async function ready(text: string) {
  const p = current();
  await expect(p.getByRole("log")).toContainText(text);
  await expect(p.getByRole("button", { name: "编辑并重新发送", exact: true }).first()).toBeEnabled();
}
async function switchVersion(id: string) {
  const p = current();
  const row = p.locator(`[data-tree-entry-id="${id}"]`);
  if (!(await row.isVisible())) await p.getByTestId("toggle-left-sidebar").click();
  await row.getByRole("button", { name: "继续分支", exact: true }).click();
  if (mobile) await expect(p.getByRole("dialog")).toHaveCount(0);
  await expect(p.getByRole("button", { name: "编辑并重新发送", exact: true }).first()).toBeEnabled();
}
When("我打开消息修订真实 Pi 的 {string} 页面", async ({ browser }, viewport: string) => {
  harness = await startPiWebUi("message-revision");
  mobile = viewport === "mobile";
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  page = await context.newPage();
  requests = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      const data = JSON.parse(String(payload));
      if (data.type === "req") requests.push(data);
    }),
  );
  await page.goto(harness.pageUrl);
  await expect(page.getByTestId("message-input")).toBeVisible();
});
When("我准备两轮可修订对话", async () => {
  await send("QUESTION_ALPHA");
  await expect(current().getByRole("log")).toContainText("ANSWER_ALPHA_ORIGINAL");
  await send("/webui");
  await ready("ANSWER_ALPHA_ORIGINAL");
  await send("QUESTION_BETA");
  await ready("ANSWER_BETA_ORIGINAL");
  await expect(current().getByRole("button", { name: "重新生成回答", exact: true })).toHaveCount(2);
  sourceBetaId = answerId("ANSWER_BETA_ORIGINAL");
});
When("我验证修订取消和草稿保护", async () => {
  const p = current();
  const count = () => requests.filter((r) => r.method === "submit_message_revision").length;
  const before = count();
  await p.getByRole("button", { name: "重新生成回答", exact: true }).last().click();
  await expect(p.getByRole("dialog")).toContainText("QUESTION_BETA");
  await expect(p.getByRole("dialog")).toContainText("不回滚代码文件");
  await p.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  expect(count()).toBe(before);
  await p.getByTestId("message-input").fill("KEEP_UNSENT_DRAFT");
  let alerted = false;
  p.once("dialog", async (d) => {
    alerted = true;
    await d.dismiss();
  });
  await p.getByRole("button", { name: "编辑并重新发送", exact: true }).first().click();
  expect(alerted).toBe(true);
  await expect(p.getByTestId("message-input")).toHaveValue("KEEP_UNSENT_DRAFT");
  await expect(p.getByRole("dialog")).toHaveCount(0);
  await p.getByTestId("message-input").fill("");
});
When("我编辑早期问题并验证忙碌保护", async () => {
  const p = current();
  await p.getByRole("button", { name: "编辑并重新发送", exact: true }).first().click();
  const dialog = p.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "编辑问题", exact: true })).toHaveValue("QUESTION_ALPHA");
  await dialog.getByRole("textbox", { name: "编辑问题", exact: true }).fill("  QUESTION_ALPHA_EDITED  ");
  await dialog.getByRole("button", { name: "编辑并重新发送", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(p.getByRole("button", { name: "编辑并重新发送", exact: true }).first()).toBeDisabled();
  await ready("ANSWER_ALPHA_EDITED");
  await expect(p.getByRole("log")).not.toContainText("QUESTION_BETA");
  await expect(p.getByRole("log")).not.toContainText("CONTEXT_LEAK");
  editedId = answerId("ANSWER_ALPHA_EDITED");
  const submit = requests.filter((r) => r.method === "submit_message_revision").at(-1);
  expect(submit?.params?.text).toBe("  QUESTION_ALPHA_EDITED  ");
  expect(typeof submit?.params?.previewId).toBe("string");
});
Then("旧分支和编辑分支可以切换", async () => {
  await switchVersion(sourceBetaId);
  await ready("ANSWER_BETA_ORIGINAL");
  await expect(current().getByRole("log")).not.toContainText("ANSWER_ALPHA_EDITED");
  await switchVersion(editedId);
  await ready("ANSWER_ALPHA_EDITED");
  await switchVersion(sourceBetaId);
  await ready("ANSWER_BETA_ORIGINAL");
  await expect(current().getByRole("button", { name: "重新生成回答", exact: true })).toHaveCount(2);
});
When("我重新生成原 BETA 回答", async () => {
  const p = current();
  await p.getByRole("button", { name: "重新生成回答", exact: true }).last().click();
  const dialog = p.getByRole("dialog");
  await expect(dialog).toContainText("QUESTION_BETA");
  await dialog.getByRole("button", { name: "重新生成", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await ready("ANSWER_BETA_REGENERATED");
  await expect(p.getByRole("log")).not.toContainText("CONTEXT_LEAK");
  await expect(p.getByRole("log")).not.toContainText("ANSWER_BETA_ORIGINAL");
  regeneratedId = answerId("ANSWER_BETA_REGENERATED");
  const submit = requests.filter((r) => r.method === "submit_message_revision").at(-1);
  expect(submit?.params?.text).toBeUndefined();
});
Then("重答和旧回答在刷新后仍可切换", async () => {
  const p = current();
  const saved = entries();
  expect(new Set([sourceBetaId, editedId, regeneratedId]).size).toBe(3);
  expect(saved.find((e) => e.id === sourceBetaId)).toBeDefined();
  expect(saved.find((e) => e.id === editedId)).toBeDefined();
  await p.reload();
  await ready("ANSWER_BETA_REGENERATED");
  await send("/webui");
  await ready("ANSWER_BETA_REGENERATED");
  await switchVersion(sourceBetaId);
  await ready("ANSWER_BETA_ORIGINAL");
  await switchVersion(regeneratedId);
  await ready("ANSWER_BETA_REGENERATED");
  expect(requests.filter((r) => r.method === "submit_message_revision")).toHaveLength(2);
});
After(async () => {
  if (context) await context.close();
  context = null;
  page = null;
  if (harness) await harness.stop();
  harness = null;
});
