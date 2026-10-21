import { appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** Explicitly loaded only by the isolated PTY harness. No real grants or memory. */
export default function (pi: ExtensionAPI) {
  if (process.env.PI_WEB_UI_PTY_FIXTURE !== "1") throw new Error("PTY fixture requires isolated test launcher");
  let latestCtx: ExtensionContext | undefined;
  const record = (event: string, extra: Record<string, unknown> = {}) => {
    appendFileSync("pty-events.jsonl", `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
  };
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    record("ready", {
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      stdinTTY: process.stdin.isTTY,
      stdoutTTY: process.stdout.isTTY,
    });
    ctx.ui.setStatus("pty-fixture", "PTY_FIXTURE_READY");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    latestCtx = ctx;
    record("shutdown");
  });
  for (const mode of ["normal", "timeout", "abort"] as const) {
    pi.registerCommand(`pty-confirm-${mode}`, {
      description: "Synthetic PTY confirmation; writes only a test workspace marker",
      handler: async (_args, ctx) => {
        latestCtx = ctx;
        if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Real TUI required");
        record("confirm-open", { mode });
        const controller = new AbortController();
        const timer = mode === "abort" ? setTimeout(() => controller.abort(), 600) : undefined;
        try {
          const approved = await ctx.ui.confirm(
            "PTY_CONFIRM_PREVIEW_BEGIN",
            "SYNTHETIC ONLY: write approved.txt in this temporary workspace.\n预览：中文与 emoji 🐳\nPTY_CONFIRM_PREVIEW_END",
            mode === "timeout" ? { timeout: 600 } : { signal: controller.signal, timeout: 30_000 },
          );
          if (approved) writeFileSync("approved.txt", "SYNTHETIC_APPROVED\n");
          record("confirm-result", { mode, approved });
          latestCtx?.ui.notify(approved ? "PTY_CONFIRM_APPROVED" : "PTY_CONFIRM_REJECTED");
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }
  pi.registerCommand("pty-panel", {
    description: "Synthetic custom TUI with real keyboard navigation",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (ctx.mode !== "tui") throw new Error("Real TUI required");
      record("panel-open");
      const result = await ctx.ui.custom<string>((tui, _theme, keys, done) => {
        let selected = 0;
        let lastWidth = 0;
        const choices = ["ALPHA", "BETA", "GAMMA"];
        return {
          render(width) {
            if (width !== lastWidth) {
              record("panel-render", { width, columns: process.stdout.columns, rows: process.stdout.rows });
              lastWidth = width;
            }
            return [
              "PTY_CUSTOM_PANEL",
              "方向键选择 / Enter 确认 / Esc 取消 🐳",
              ...choices.map((choice, index) => `${index === selected ? ">" : " "} ${choice}`),
            ].map((line) => truncateToWidth(line, width));
          },
          invalidate() {},
          handleInput(data) {
            if (keys.matches(data, "tui.select.cancel")) done("CANCELLED");
            else if (keys.matches(data, "tui.select.confirm")) done(choices[selected] ?? "CANCELLED");
            else if (matchesKey(data, "down")) selected = Math.min(choices.length - 1, selected + 1);
            else if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
            tui.requestRender();
          },
        };
      });
      record("panel-result", { result });
      latestCtx?.ui.notify(`PTY_PANEL_RESULT_${result}`);
    },
  });
}
