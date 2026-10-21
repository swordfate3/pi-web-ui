import { appendFileSync } from "node:fs";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** Test commands only; all UI and keystrokes are the installed real Pi TUI. */
export default function (pi: ExtensionAPI) {
  if (process.env.PI_TASK6_NATIVE_TEST !== "1") throw new Error("Isolated native test required");
  const record = (event: string, extra: Record<string, unknown> = {}) =>
    appendFileSync("native-events.jsonl", `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI || !process.stdin.isTTY) throw new Error("Native Pi TUI required");
    record("ready", { mode: ctx.mode, tty: process.stdin.isTTY, entry: process.argv[1], version: VERSION });
    ctx.ui.setStatus("task6-native", "TASK6_NATIVE_PI_READY");
  });
  pi.on("session_shutdown", () => record("shutdown"));
  pi.registerCommand("task6-confirm", {
    description: "Isolated native confirmation; append exactly one test effect only on approval",
    handler: async (_args, ctx) => {
      record("confirm-open");
      const approved = await ctx.ui.confirm(
        "TASK6_NATIVE_CONFIRM",
        "仅测试：确认后追加一次 temporary effect。中文预览 🐳",
      );
      if (approved) appendFileSync("native-effects.txt", "APPROVED_ONCE\n");
      record("confirm-result", { approved });
      ctx.ui.notify(approved ? "NATIVE_ACCEPTED_ONCE" : "NATIVE_REJECTED_ZERO_EFFECTS");
    },
  });
  pi.registerCommand("task6-chinese", {
    description: "Record explicit native Chinese text input in the temporary test workspace",
    handler: async (args, ctx) => {
      record("chinese", { text: args });
      ctx.ui.notify(`NATIVE_TEXT_${args}`);
    },
  });
  pi.registerCommand("task6-panel", {
    description: "Native custom panel with keyboard navigation and real resize",
    handler: async (_args, ctx) => {
      record("panel-open");
      const result = await ctx.ui.custom<string>((tui, _theme, keys, done) => {
        let selected = 0;
        let previousWidth = 0;
        const choices = ["ALPHA", "BETA", "GAMMA"];
        return {
          render(width) {
            if (previousWidth !== width) {
              record("panel-render", { width, columns: process.stdout.columns, rows: process.stdout.rows });
              previousWidth = width;
            }
            return [
              "TASK6_NATIVE_CUSTOM_PANEL",
              "方向键选择 · Enter 确认 · 中文 🐳",
              ...choices.map((item, i) => `${selected === i ? ">" : " "} ${item}`),
            ].map((line) => truncateToWidth(line, width));
          },
          invalidate() {},
          handleInput(data) {
            if (keys.matches(data, "tui.select.cancel")) done("CANCELLED");
            else if (keys.matches(data, "tui.select.confirm")) done(choices[selected] ?? "CANCELLED");
            else if (matchesKey(data, "down")) selected = Math.min(2, selected + 1);
            else if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
            tui.requestRender();
          },
        };
      });
      record("panel-result", { result });
      ctx.ui.notify(`NATIVE_PANEL_${result}`);
    },
  });
}
