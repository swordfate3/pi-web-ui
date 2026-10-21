import { Buffer } from "node:buffer";
import serialize from "@xterm/addon-serialize";
import type { IDisposable, Terminal } from "@xterm/headless";
import headless from "@xterm/headless";

export type ScreenSnapshot = {
  sequence: number;
  columns: number;
  rows: number;
  /** ANSI framebuffer serialization, never HTML or an executable-command ACK. */
  data: string;
};

const MAX_WRITE_BYTES = 32_768;
const MAX_PENDING_BYTES = 1_048_576;
const MAX_PENDING_OPERATIONS = 128;
const MAX_SNAPSHOT_BYTES = 1_048_576;
const SCROLLBACK = 1_000;

// Suppress title/icon, hyperlinks, clipboard, palette, notifications, shell
// integration and common proprietary OSC effects. Unknown OSCs are ignored by
// headless. Public hooks run at sequence completion; xterm itself bounds
// unfinished OSC/DCS payloads (10 MB), separately from our pending-write budget.
// These hooks are not an authorization mechanism or an ANSI sanitizer.
const BLOCKED_OSC = [0, 1, 2, 4, 8, 9, 10, 11, 12, 22, 46, 50, 51, 52, 104, 110, 111, 112, 133, 777, 1337];

type Operation =
  | { kind: "write"; data: Uint8Array }
  | { kind: "resize"; columns: number; rows: number }
  | { kind: "capture" };
type Pending = {
  operation: Operation;
  bytes: number;
  resolve: (snapshot: ScreenSnapshot) => void;
  reject: (error: Error) => void;
};

function validSize(columns: number, rows: number): boolean {
  return (
    Number.isInteger(columns) && columns >= 20 && columns <= 240 && Number.isInteger(rows) && rows >= 5 && rows <= 120
  );
}

/**
 * One output-only parser, owned from child startup until dispose/failure.
 *
 * Fixed compatibility pair: @xterm/headless 6.0.0 / addon-serialize 0.14.0.
 * serialize is experimental: this is a rendered framebuffer snapshot, NOT a
 * checkpoint of the UTF-8 decoder, pending CSI/OSC, or every terminal state.
 * Known 0.14.0 limitation: shrinking wrapped content can restore the cursor
 * one column off even when visible cells match (covered by a regression test).
 * Restore each snapshot into a NEW/reset terminal at its exact dimensions.
 * Never resume it with raw deltas; subsequent updates must be full snapshots.
 * A write callback means parsed output only, not PTY delivery/command execution.
 * No onData/onBinary connection, input, authorization, HTML, or content logging.
 */
export class TerminalScreen {
  private readonly terminal: Terminal;
  private readonly serializer: serialize.SerializeAddon;
  private readonly hooks: IDisposable[] = [];
  private readonly queue: Pending[] = [];
  private active: Pending | undefined;
  private pendingBytes = 0;
  private sequence = 0;
  private failure: Error | undefined;
  private scheduled = false;

  constructor(columns = 120, rows = 40) {
    if (!validSize(columns, rows)) throw new Error("Invalid terminal screen dimensions");
    this.terminal = new headless.Terminal({
      cols: columns,
      rows,
      scrollback: SCROLLBACK,
      // Required by serialize's buffer/modes access and the public parser hooks.
      allowProposedApi: true,
      disableStdin: true,
      logLevel: "off",
    });
    this.serializer = new serialize.SerializeAddon();
    try {
      for (const id of BLOCKED_OSC) this.hooks.push(this.terminal.parser.registerOscHandler(id, () => true));
      // The addon declares browser Terminal (with DOM members), whereas its ANSI
      // path uses the shared buffer/modes/core present in headless 6.0.0. Keep
      // the compatibility cast at this one activation boundary; never use HTML.
      // We own/dispose the addon explicitly rather than claiming ITerminalAddon
      // browser/headless types are interchangeable throughout the application.
      this.serializer.activate(this.terminal as unknown as Parameters<serialize.SerializeAddon["activate"]>[0]);
    } catch {
      this.stop(new Error("Terminal screen initialization failed"));
      throw this.failure;
    }
  }

  write(data: Uint8Array): Promise<ScreenSnapshot> {
    if (this.failure) return Promise.reject(this.failure);
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_WRITE_BYTES) {
      return this.rejectAndStop("Terminal screen write limit exceeded");
    }
    if (!this.hasCapacity(data.byteLength)) return this.rejectAndStop("Terminal screen pending budget exceeded");
    // Own the bytes: callers may reuse PTY Buffers before the async parser runs.
    try {
      return this.enqueue({ kind: "write", data: Uint8Array.from(data) }, data.byteLength);
    } catch {
      return this.rejectAndStop("Terminal screen write failed");
    }
  }

  resize(columns: number, rows: number): Promise<ScreenSnapshot> {
    if (this.failure) return Promise.reject(this.failure);
    if (!validSize(columns, rows)) return this.rejectAndStop("Invalid terminal screen dimensions");
    return this.enqueue({ kind: "resize", columns, rows }, 0);
  }

  capture(): Promise<ScreenSnapshot> {
    return this.enqueue({ kind: "capture" }, 0);
  }

  dispose(): void {
    this.stop(new Error("Terminal screen disposed"));
  }

  private hasCapacity(bytes: number): boolean {
    return (
      this.pendingBytes + bytes <= MAX_PENDING_BYTES &&
      this.queue.length + (this.active ? 1 : 0) < MAX_PENDING_OPERATIONS
    );
  }

  private enqueue(operation: Operation, bytes: number): Promise<ScreenSnapshot> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.hasCapacity(bytes)) return this.rejectAndStop("Terminal screen pending budget exceeded");
    const result = new Promise<ScreenSnapshot>((resolve, reject) => {
      this.queue.push({ operation, bytes, resolve, reject });
      this.pendingBytes += bytes;
    });
    this.schedule();
    return result;
  }

  private schedule(): void {
    if (this.scheduled || this.active || this.failure) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.failure || this.active) return;
    const pending = this.queue.shift();
    if (!pending) return;
    this.active = pending;
    try {
      const operation = pending.operation;
      if (operation.kind === "write") {
        // Only one write may enter xterm's async queue. Capture/resize cannot
        // overtake its completion callback, even for split UTF-8 or CSI input.
        this.terminal.write(operation.data, () => this.complete(pending));
      } else {
        if (operation.kind === "resize") this.terminal.resize(operation.columns, operation.rows);
        this.complete(pending);
      }
    } catch {
      // Do not forward third-party error messages: they may contain output.
      this.stop(new Error("Terminal screen operation failed"));
    }
  }

  private complete(pending: Pending): void {
    // Disposal can cancel the xterm timer without firing its callback, or a
    // callback may already be in flight. Neither can strand/resurrect a promise.
    if (this.failure || this.active !== pending) return;
    try {
      if (pending.operation.kind !== "capture") {
        if (this.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Sequence exhausted");
        this.sequence++;
      }
      const data = this.serializer.serialize({ scrollback: SCROLLBACK });
      if (Buffer.byteLength(data, "utf8") > MAX_SNAPSHOT_BYTES) {
        this.stop(new Error("Terminal screen snapshot budget exceeded"));
        return;
      }
      const snapshot: ScreenSnapshot = {
        sequence: this.sequence,
        columns: this.terminal.cols,
        rows: this.terminal.rows,
        data,
      };
      this.pendingBytes -= pending.bytes;
      this.active = undefined;
      pending.resolve(snapshot);
      this.schedule();
    } catch {
      this.stop(new Error("Terminal screen snapshot failed"));
    }
  }

  private rejectAndStop(message: string): Promise<ScreenSnapshot> {
    this.stop(new Error(message));
    return Promise.reject(this.failure);
  }

  private stop(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.active) this.active.reject(error);
    this.active = undefined;
    for (const pending of this.queue) pending.reject(error);
    this.queue.length = 0;
    this.pendingBytes = 0;
    // Settle everything before disposing resources; cleanup must not mask the
    // original failure or leak terminal content via a third-party exception.
    for (const resource of [...this.hooks, this.serializer, this.terminal]) {
      try {
        resource.dispose();
      } catch {
        // Already permanently failed; no fallback/retry or content logging.
      }
    }
    this.hooks.length = 0;
  }
}
