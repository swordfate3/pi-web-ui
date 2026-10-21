import path from "node:path";
import { type RuntimeSnapshot, startRuntimeControl } from "../../extensions/runtime-control.ts";
import { childTerminalBarrier } from "../../extensions/terminal-barrier.ts";

const directory = process.argv[2];
const barrier = childTerminalBarrier();
let finish: (() => void) | undefined;
const snapshot: RuntimeSnapshot = {
  run_id: "a".repeat(32),
  runtime_id: "runtime",
  session_id: "session",
  leaf_id: null,
  session_file: null,
  cwd: directory,
  version: "unaudited",
  idle: false,
  pending: true,
  busy: true,
  provider: null,
  model: null,
  thinking: "off",
};
const adapter = await startRuntimeControl(
  {
    PI_RUNTIME_RUN_ID: snapshot.run_id,
    PI_RUNTIME_CHILD_TOKEN: "c".repeat(64),
    PI_RUNTIME_EXTENSION_SOCKET: path.join(directory, "adapter.sock"),
    PI_RUNTIME_PROFILE: "web-terminal-v1",
    PI_RUNTIME_TERMINAL_EPOCH: "b".repeat(32),
  },
  () => snapshot,
);

process.on("message", async (message: { id: number; action: string }) => {
  try {
    switch (message.action) {
      case "admit":
        finish = barrier.enter();
        break;
      case "finish":
        finish?.();
        break;
      case "unknown":
        barrier.markUnknown();
        break;
      case "write":
        barrier.enter()();
        break;
      case "replace":
        snapshot.session_id = "replacement";
        break;
      case "stop":
        await adapter?.close();
        process.disconnect?.();
        return;
    }
    process.send?.({ id: message.id, ok: true, blocked: barrier.blocked, latched: barrier.latched });
  } catch {
    process.send?.({ id: message.id, ok: false, blocked: barrier.blocked, latched: barrier.latched });
  }
});
process.on("disconnect", () => {
  void adapter?.close();
});
process.send?.({ ready: true });
