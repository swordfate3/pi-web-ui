import { Terminal } from "@xterm/xterm";
import type { ScreenSnapshot } from "../../hub/terminal-screen.ts";

/** Read-only browser experiment, not a production terminal input surface. */
export class TerminalScreenView {
  private terminal: Terminal | null = null;
  private sequence = -1;
  private busy = false;
  private disposed = false;
  private cancelWrite: (() => void) | undefined;
  private container: HTMLElement;
  constructor(container: HTMLElement) {
    this.container = container;
  }

  async restore(frame: ScreenSnapshot) {
    if (
      this.disposed ||
      this.busy ||
      !Number.isSafeInteger(frame.sequence) ||
      frame.sequence < 0 ||
      frame.sequence < this.sequence ||
      !Number.isInteger(frame.columns) ||
      frame.columns < 20 ||
      frame.columns > 240 ||
      !Number.isInteger(frame.rows) ||
      frame.rows < 5 ||
      frame.rows > 120 ||
      typeof frame.data !== "string" ||
      new TextEncoder().encode(frame.data).length > 1048576
    )
      throw new Error("Terminal snapshot rejected");
    this.busy = true;
    // Each snapshot is self-contained. Never combine it with a previous parser's
    // partial escape/UTF-8 state or any raw delta. No input/data/binary forwarding.
    this.terminal?.dispose();
    const terminal = new Terminal({
      cols: frame.columns,
      rows: frame.rows,
      scrollback: 1000,
      disableStdin: true,
      allowProposedApi: true,
      allowTransparency: false,
      cursorBlink: false,
      fontSize: 16,
      lineHeight: 1.2,
      fontFamily: "FixtureMono, monospace",
      windowOptions: {},
      linkHandler: { activate() {}, hover() {}, leave() {} },
      theme: { background: "#10151e", foreground: "#e4eaf3" },
    });
    for (const osc of [0, 1, 2, 8, 52]) terminal.parser.registerOscHandler(osc, () => true);
    this.terminal = terminal;
    try {
      terminal.open(this.container);
      await new Promise<void>((resolve, reject) => {
        this.cancelWrite = () => reject(new Error("Terminal view disposed"));
        terminal.write(frame.data, resolve);
      });
      if (this.disposed) throw new Error("Terminal view disposed");
      this.sequence = frame.sequence;
    } catch {
      this.dispose();
      throw new Error("Terminal snapshot restore failed");
    } finally {
      this.cancelWrite = undefined;
      this.busy = false;
    }
  }
  inspect() {
    const buffer = this.terminal?.buffer.active;
    if (!buffer) throw new Error("Terminal view unavailable");
    return {
      sequence: this.sequence,
      type: buffer.type,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      lines: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? ""),
    };
  }
  dispose() {
    this.disposed = true;
    this.cancelWrite?.();
    this.cancelWrite = undefined;
    this.terminal?.dispose();
    this.terminal = null;
  }
}
