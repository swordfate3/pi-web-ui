import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type NativeEvent = {
  event: string;
  pid: number;
  approved?: boolean;
  result?: string;
  text?: string;
  columns?: number;
  rows?: number;
};
export type NativeResult = {
  events: NativeEvent[];
  effects: string[];
  native: { pid: number; ppid: number; start: string };
};
export type NativeReady = { terminalUrl: string; chatUrl: string; chatPath: string; code: string; prefix: string };
type Reply = Record<string, unknown>;
export class NativeTerminalStack {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private replies: Reply[] = [];
  private waiters: Array<{ resolve: (value: Reply) => void; reject: (error: Error) => void }> = [];
  private stderr = "";
  private exited: Promise<void>;
  readonly artifacts = process.env.PI_E2E_ARTIFACT_DIR ?? "/tmp/pi-task6-browser";

  constructor(root: string) {
    mkdirSync(this.artifacts, { recursive: true });
    this.child = spawn("/usr/bin/python3", [path.join(root, "e2e/fixtures/task6-native-stack.py")], {
      cwd: root,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    this.exited = new Promise((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") this.stderr = `${this.stderr}\n${error.message}`;
    });
    this.child.stderr.on("data", (data) => {
      this.stderr = (this.stderr + String(data)).slice(-12000);
    });
    this.child.stdout.on("data", (data) => {
      this.buffer += String(data);
      if (this.buffer.length > 65536) throw new Error("Native fixture reply limit");
      while (this.buffer.includes("\n")) {
        const index = this.buffer.indexOf("\n");
        const value = JSON.parse(this.buffer.slice(0, index)) as Reply;
        this.buffer = this.buffer.slice(index + 1);
        if (value.type === "progress") {
          writeFileSync(path.join(this.artifacts, "active-resources.json"), `${JSON.stringify(value, null, 2)}\n`);
          console.info(`Task6 isolated ${value.prefix}: ${value.stage}`);
          continue;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.replies.push(value);
      }
    });
    this.child.on("exit", (code) => {
      for (const waiter of this.waiters.splice(0))
        waiter.reject(new Error(`Native fixture exited ${code}: ${this.stderr}`));
    });
  }

  private next(): Promise<Reply> {
    const value = this.replies.shift();
    if (value) return Promise.resolve(value);
    if (this.child.exitCode !== null) return Promise.reject(new Error(`Native fixture exited: ${this.stderr}`));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async ready(): Promise<NativeReady> {
    const value = await this.next();
    if (value.type !== "ready") throw new Error(`Native startup failed: ${this.stderr}`);
    return value as unknown as NativeReady;
  }
  async request(value: object): Promise<Reply> {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
    const result = await this.next();
    if (result.type !== "result") throw new Error(`Native request failed: ${this.stderr}`);
    return result;
  }
  async events(): Promise<NativeResult> {
    return this.request({ op: "events" }) as unknown as Promise<NativeResult>;
  }
  async local(data: string) {
    await this.request({ op: "local", data: Buffer.from(data).toString("base64") });
  }
  async close() {
    if (this.child.exitCode === null) this.child.stdin.end('{"op":"stop"}\n');
    await this.exited;
    const cleanup = this.replies.find((reply) => reply.type === "cleanup");
    if (this.child.exitCode !== 0 || cleanup?.ownedResourcesRemoved !== true)
      throw new Error(`Native cleanup failed: ${this.stderr}`);
    writeFileSync(
      path.join(this.artifacts, "active-resources.json"),
      '{"active":false,"ownedResourcesRemoved":true}\n',
    );
  }
}
