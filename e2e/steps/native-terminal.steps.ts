import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { createBdd } from "playwright-bdd";
import { type NativeReady, NativeTerminalStack } from "../harness/native-terminal-stack";

const { Given, When, Then, After } = createBdd();
let stack: NativeTerminalStack | undefined;
let ready: NativeReady;
let terminal: Page | undefined;
let inputs = 0;
let errors: string[] = [];
const page = () => {
  if (!terminal) throw new Error("Native terminal not initialized");
  return terminal;
};
const service = () => {
  if (!stack) throw new Error("Native stack not initialized");
  return stack;
};
const screen = () => page().locator("#terminal-screen .xterm-rows").innerText();
const button = (name: string) => page().getByRole("button", { name, exact: true });
async function key(name: string) {
  await button(name).click();
  await expect(page().locator("#delivery-state")).toContainText("已写入终端");
}
async function command(text: string) {
  await page().locator("#draft").fill(text);
  await button("发送文本").click();
  await expect(page().locator("#draft")).toHaveValue("");
  await key("Enter");
}
async function connect() {
  await page().locator("#access").selectOption("write");
  await button("连接终端").click();
  await expect(page().locator("#screen-state")).toContainText("完整画面快照");
}
async function acquire() {
  await button("取得控制权").click();
  await expect(page().locator("#draft")).toBeEnabled();
}
async function scrollNativeBottom() {
  const scroll = page().locator("#screen-scroll");
  // Scroll the outer viewport's padding, not xterm's nested wheel handler.
  await scroll.hover({ position: { x: 4, y: 20 } });
  await page().mouse.wheel(0, 2000);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1);
}

Given("an isolated installed native Pi with the approved live admin preflight", async ({ $testInfo }) => {
  $testInfo.setTimeout(240_000);
  stack = new NativeTerminalStack(path.resolve(__dirname, "../.."));
  ready = await stack.ready();
  errors = [];
  inputs = 0;
});

Then("its ordinary Hub chat is read-only from startup", async ({ browser }) => {
  const chat = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await chat.goto(new URL(ready.chatPath, ready.chatUrl).href);
    await expect(chat.getByTestId("message-input")).toBeDisabled();
    await expect(chat.getByText(/从启动起.*只读|启动起.*只读/).first()).toBeVisible();
    await chat.screenshot({ path: path.join(service().artifacts, "1440-native-chat-readonly.png"), fullPage: true });
  } finally {
    await chat.close();
  }
});

When("I pair the separate terminal and explicitly yield local input", async ({ browser }) => {
  terminal = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page().on("pageerror", (error) => errors.push(error.name));
  page().on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (JSON.parse(String(frame.payload)).type === "input") inputs++;
    }),
  );
  await page().goto(ready.terminalUrl);
  await page().getByLabel("一次性终端配对码").fill(ready.code);
  await button("解锁终端").click();
  await expect(button("连接终端")).toBeEnabled();
  await connect();
  await expect.poll(screen).toContain("TASK6_NATIVE_PI_READY");
  await button("取得控制权").click();
  await expect(page().locator("#draft")).toBeDisabled();
  await service().local("\x1dw");
  await acquire();
});

Then("native confirmation rejection has zero effects and acceptance has exactly one", async () => {
  await command("/task6-confirm");
  await expect.poll(screen).toContain("TASK6_NATIVE_CONFIRM");
  await page().screenshot({ path: path.join(service().artifacts, "1440-native-confirm.png"), fullPage: true });
  await scrollNativeBottom();
  await page().screenshot({ path: path.join(service().artifacts, "1440-native-confirm-bottom.png"), fullPage: true });
  expect((await service().events()).effects).toEqual([]);
  await key("Esc");
  await expect
    .poll(async () =>
      (await service().events()).events
        .filter((event) => event.event === "confirm-result")
        .map((event) => event.approved),
    )
    .toEqual([false]);
  expect((await service().events()).effects).toEqual([]);
  await command("/task6-confirm");
  await expect.poll(screen).toContain("TASK6_NATIVE_CONFIRM");
  await key("Enter");
  await expect.poll(async () => (await service().events()).effects).toEqual(["APPROVED_ONCE"]);
  expect(
    (await service().events()).events
      .filter((event) => event.event === "confirm-result")
      .map((event) => event.approved),
  ).toEqual([false, true]);
});

Then("Chinese composition and manual native panel resize use the same child", async () => {
  // New explicit connection/acquire keeps the real30s lease; no renewal shortcut.
  await button("断开 / 释放").click();
  await connect();
  await acquire();
  const draft = page().locator("#draft");
  const before = inputs;
  await draft.dispatchEvent("compositionstart", { data: "中" });
  await draft.fill("/task6-chinese 中文输入 🐳");
  await expect(button("发送文本")).toBeDisabled();
  expect(inputs).toBe(before);
  await draft.dispatchEvent("compositionend", { data: "中文输入 🐳" });
  await draft.press("Enter");
  expect(inputs).toBe(before);
  await command("/task6-chinese 中文输入 🐳");
  await expect
    .poll(async () =>
      (await service().events()).events.filter((event) => event.event === "chinese").map((event) => event.text),
    )
    .toEqual(["中文输入 🐳"]);
  await command("/task6-panel");
  await expect.poll(screen).toContain("TASK6_NATIVE_CUSTOM_PANEL");
  await key("↓");
  await page().locator("summary").click();
  await page().locator("#columns").fill("96");
  await page().locator("#rows").fill("30");
  await button("应用尺寸").click();
  await expect(page().locator("#screen-state")).toContainText("96 × 30");
  await expect
    .poll(async () =>
      (await service().events()).events.some(
        (event) => event.event === "panel-render" && event.columns === 96 && event.rows === 30,
      ),
    )
    .toBe(true);
  await page().screenshot({ path: path.join(service().artifacts, "1440-native-panel-resized.png"), fullPage: true });
  await page().setViewportSize({ width: 390, height: 1000 });
  await expect(page().locator("#screen-state")).toContainText("96 × 30");
  expect(await page().evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page().screenshot({ path: path.join(service().artifacts, "390-native-panel-resized.png"), fullPage: true });
  await scrollNativeBottom();
  await page().screenshot({ path: path.join(service().artifacts, "390-native-panel-bottom.png"), fullPage: true });
  await key("Enter");
  await expect
    .poll(async () => (await service().events()).events.find((event) => event.event === "panel-result")?.result)
    .toBe("BETA");
});

Then("local reclaim fences remote input and a new explicit handoff works", async () => {
  await service().local("\x1dl");
  await page().locator("#draft").fill("/task6-chinese MUST_NOT_EXECUTE");
  await button("发送文本").click();
  await expect(page().locator("#delivery-state")).toContainText(/拒绝|未知/);
  // A refused input already closes the connection by product contract.
  await expect(button("断开 / 释放")).toBeDisabled();
  await service().request({ op: "assert-helpers-closed" });
  await service().local("/task6-chinese LOCAL_NATIVE\r");
  await expect
    .poll(async () => (await service().events()).events.some((event) => event.text === "LOCAL_NATIVE"))
    .toBe(true);
  expect((await service().events()).events.some((event) => event.text?.includes("MUST_NOT_EXECUTE"))).toBe(false);
  await service().local("\x1dw");
  await button("检查状态").click();
  await connect();
  await acquire();
  await command("/task6-chinese REMOTE_AGAIN");
  await expect
    .poll(async () => (await service().events()).events.some((event) => event.text === "REMOTE_AGAIN"))
    .toBe(true);
  expect((await service().events()).effects).toEqual(["APPROVED_ONCE"]);
  await page().screenshot({ path: path.join(service().artifacts, "390-native-handoff.png"), fullPage: true });
});

Then("native exit leaves no active child helper socket or owned Docker resource", async () => {
  await button("断开 / 释放").click();
  await service().request({ op: "assert-helpers-closed" });
  await service().request({ op: "exit" });
  expect(errors).toEqual([]);
  await page().close();
  terminal = undefined;
  const owned = service();
  stack = undefined;
  await owned.close();
});

After({ tags: "@native-terminal" }, async () => {
  await terminal?.close();
  terminal = undefined;
  const owned = stack;
  stack = undefined;
  if (owned) await owned.close();
});
