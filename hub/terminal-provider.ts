import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import {
  parseTerminalTarget,
  sameTerminal,
  type TerminalBinding,
  type TerminalTarget,
  terminalId,
  validTerminalBinding,
} from "./terminal-contract.ts";
import {
  exact,
  parseTerminalJson,
  parseTerminalRequest,
  parseTerminalResult,
  TERMINAL_FRAME_BYTES,
  TERMINAL_QUEUE_BYTES,
  type TerminalRequest,
  type TerminalSnapshot,
  TerminalSnapshotAssembly,
} from "./terminal-wire.ts";

export type TerminalProviderConfig = { socketPath: string; credentialFile: string };
const unavailable = () => new Error("terminal_backend_unavailable");
/** Dedicated read-only secret mount only; never loosens the generic 0600 reader. */
export function readTerminalProviderSecret(file: string): string {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) throw unavailable();
  const parent = lstatSync(path.dirname(file));
  const uid = process.getuid?.();
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw unavailable();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    const local =
      stat.uid === uid && (stat.mode & 0o7777) === 0o600 && parent.uid === uid && (parent.mode & 0o077) === 0;
    const mounted =
      stat.uid === 0 &&
      stat.gid === 1000 &&
      (stat.mode & 0o7777) === 0o640 &&
      parent.uid === 0 &&
      parent.gid === 1000 &&
      (parent.mode & 0o7777) === 0o2770;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 64 || (!local && !mounted)) throw unavailable();
    if (
      mounted &&
      (process.platform !== "linux" ||
        !readFileSync("/proc/self/mountinfo", "utf8")
          .split("\n")
          .some((line) => {
            const fields = line.split(" ");
            return fields[4] === path.dirname(file).replaceAll(" ", "\\040") && fields[5]?.split(",").includes("ro");
          }))
    )
      throw unavailable();
    let ancestor = path.dirname(path.dirname(file));
    for (;;) {
      const directory = lstatSync(ancestor);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        ![0, uid].includes(directory.uid) ||
        ((directory.mode & 0o022) !== 0 && !(directory.uid === 0 && directory.mode & 0o1000))
      )
        throw unavailable();
      if (ancestor === path.dirname(ancestor)) break;
      ancestor = path.dirname(ancestor);
    }
    const token = readFileSync(fd, "utf8");
    if (!/^[a-f0-9]{64}$/.test(token)) throw unavailable();
    return token;
  } finally {
    closeSync(fd);
  }
}
export function terminalProviderConfig(value: unknown): TerminalProviderConfig {
  exact(value, "credentialFile,socketPath");
  for (const key of ["socketPath", "credentialFile"])
    if (
      typeof value[key] !== "string" ||
      !path.isAbsolute(value[key] as string) ||
      (value[key] as string).includes("\0") ||
      path.normalize(value[key] as string) !== value[key]
    )
      throw unavailable();
  return { socketPath: value.socketPath as string, credentialFile: value.credentialFile as string };
}
type Callbacks = {
  onSnapshot: (snapshot: TerminalSnapshot) => void | Promise<void>;
  onUnavailable: () => void;
  signal?: AbortSignal;
};
const active = new Set<Socket>();
class ProviderConnection {
  readonly ready: Promise<TerminalTarget>;
  private socket: Socket;
  private buffer = Buffer.alloc(0);
  private partialAt = 0;
  private startedAt = Date.now();
  private readyTarget?: TerminalTarget;
  private assembly?: TerminalSnapshotAssembly;
  private closed = false;
  private lastId = 0;
  private pending = new Map<
    number,
    {
      action: string;
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private resolveReady!: (target: TerminalTarget) => void;
  private rejectReady!: (error: Error) => void;
  private timer: NodeJS.Timeout;
  private readonly abort = () => this.close();
  private readonly opening: Record<string, unknown>;
  private readonly callbacks?: Callbacks;
  constructor(config: TerminalProviderConfig, opening: Record<string, unknown>, callbacks?: Callbacks) {
    this.opening = opening;
    this.callbacks = callbacks;
    if (active.size >= 8) throw unavailable();
    const token = readTerminalProviderSecret(config.credentialFile);
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.socket = new Socket({
      onread: {
        buffer: Buffer.alloc(32768),
        callback: (length, buffer) => {
          const chunk = Buffer.from(buffer.subarray(0, length));
          void this.consume(chunk)
            .then(() => {
              if (!this.closed) this.socket.resume();
            })
            .catch(() => this.close());
          return false;
        },
      },
    });
    active.add(this.socket);
    this.timer = setInterval(() => {
      const now = Date.now();
      if (
        (!this.readyTarget && now - this.startedAt >= 2000) ||
        (this.partialAt && now - this.partialAt >= 2000) ||
        now - this.startedAt >= 300000
      )
        this.close();
    }, 20);
    this.timer.unref();
    this.socket.once("connect", () => this.write({ ...opening, token }));
    this.socket.on("error", () => this.close());
    this.socket.on("end", () => this.close());
    this.socket.on("close", () => this.close());
    callbacks?.signal?.addEventListener("abort", this.abort, { once: true });
    if (callbacks?.signal?.aborted) this.close();
    else this.socket.connect(config.socketPath);
  }
  private write(frame: object) {
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (
      this.closed ||
      bytes.length > TERMINAL_FRAME_BYTES ||
      this.socket.writableLength + bytes.length > TERMINAL_QUEUE_BYTES
    ) {
      this.close();
      return;
    }
    this.socket.write(bytes);
  }
  private async consume(chunk: Buffer) {
    let start = 0;
    while (!this.closed && start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (this.buffer.length === 0 && end > start) this.partialAt = Date.now();
      if (this.buffer.length + end - start + 1 > TERMINAL_FRAME_BYTES) throw unavailable();
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(start, end)]);
      if (newline < 0) break;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer);
      const length = this.buffer.length + 1;
      this.buffer = Buffer.alloc(0);
      this.partialAt = 0;
      const frame = parseTerminalJson(text);
      if (frame.type === "screen-chunk" && length > 32768) throw unavailable();
      await this.frame(frame);
      start = newline + 1;
    }
  }
  private async frame(frame: Record<string, unknown>) {
    if (!this.readyTarget) {
      exact(frame, "target,type");
      if (frame.type !== "ready") throw unavailable();
      const target = parseTerminalTarget(frame.target);
      if (
        this.opening.op === "status"
          ? target.runId !== this.opening.runId
          : !sameTerminal(target, this.opening.target as TerminalTarget)
      )
        throw unavailable();
      this.readyTarget = target;
      this.assembly = new TerminalSnapshotAssembly(target);
      this.resolveReady(target);
      if (this.opening.op === "status") this.close();
      return;
    }
    if (frame.type === "response") {
      exact(frame, "id,result,type");
      const pending = this.pending.get(Number(frame.id));
      if (!pending || frame.id !== Number(frame.id)) throw unavailable();
      const result = parseTerminalResult(pending.action, frame.result);
      clearTimeout(pending.timer);
      this.pending.delete(Number(frame.id));
      pending.resolve(result);
      return;
    }
    if (frame.type === "screen-unavailable") {
      exact(frame, "type");
      this.assembly?.clear();
      this.callbacks?.onUnavailable();
      return;
    }
    const snapshot = this.assembly?.accept(frame);
    if (snapshot) {
      // Callbacks are installed before socket creation, including ready+screen in
      // one read. Pause parsing/reading during bounded downstream backpressure.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.callbacks?.onSnapshot(snapshot),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(unavailable()), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  request(value: TerminalRequest): Promise<Record<string, unknown>> {
    const frame = parseTerminalRequest(value);
    if (
      this.closed ||
      !this.readyTarget ||
      this.opening.scope !== "write" ||
      frame.id <= this.lastId ||
      this.pending.size >= 64
    )
      return Promise.reject(unavailable());
    this.lastId = frame.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 2000);
      this.pending.set(frame.id, { action: frame.type, resolve, reject, timer });
      this.write(frame);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.callbacks?.signal?.removeEventListener("abort", this.abort);
    active.delete(this.socket);
    this.buffer = Buffer.alloc(0);
    this.assembly?.clear();
    this.rejectReady(unavailable());
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.action === "input")
        pending.resolve({ ok: false, delivery: "unknown", error: "input_delivery_unknown" });
      else pending.reject(unavailable());
    }
    this.pending.clear();
    this.callbacks?.onUnavailable();
  }
}
export async function terminalProviderStatus(config: TerminalProviderConfig, runId: string) {
  if (!terminalId(runId)) throw unavailable();
  const client = new ProviderConnection(terminalProviderConfig(config), { v: 1, op: "status", runId });
  try {
    return await client.ready;
  } finally {
    client.close();
  }
}
export async function connectTerminalProvider(
  config: TerminalProviderConfig,
  value: TerminalTarget,
  scope: "read" | "write",
  binding: TerminalBinding,
  callbacks: Callbacks,
) {
  const target = parseTerminalTarget(value);
  if (!["read", "write"].includes(scope) || !validTerminalBinding(binding)) throw unavailable();
  const client = new ProviderConnection(
    terminalProviderConfig(config),
    { v: 1, op: "connect", target, scope, binding },
    callbacks,
  );
  try {
    await client.ready;
    return client;
  } catch {
    client.close();
    throw unavailable();
  }
}
