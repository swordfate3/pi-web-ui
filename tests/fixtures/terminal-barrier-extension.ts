import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let turnDialog = false;
  pi.registerCommand("test-barrier-arm-turn-dialog", {
    description: "Arm one synthetic dialog during a real agent turn",
    handler: async () => {
      turnDialog = true;
    },
  });
  pi.on("turn_start", async (_event, ctx) => {
    if (!turnDialog) return;
    turnDialog = false;
    ctx.ui.notify(`FIXTURE_DIALOG_IDLE_${ctx.isIdle()}`);
    await ctx.ui.confirm("Synthetic dialog during agent turn", "No external action", { timeout: 30_000 });
    ctx.ui.notify("FIXTURE_TURN_DIALOG_COMPLETED");
  });
  pi.registerCommand("test-barrier-reload", {
    description: "Reload only the isolated test runtime",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
