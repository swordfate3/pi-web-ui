import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { type RegistrationConfig, validatedPublicUrl } from "./connection-config.ts";

type Credential = { run_id: string; token: string };
const mac = (token: string, text: string) => createHmac("sha256", token).update(text).digest("hex");
function equal(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
class EndedGeneration extends Error {}

/** One Pi server lifetime, not a multi-process session manager or login provider. */
export class SessionRegistration {
  private credential: Credential;
  private socketPath: string;
  private timeoutMs: number;
  private renewMs: number;
  private generation: string | null = null;
  private epoch = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(credential: Credential, socketPath: string, options: { timeoutMs?: number; renewMs?: number } = {}) {
    this.credential = credential;
    this.socketPath = socketPath;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.renewMs = options.renewMs ?? 15000;
  }

  private request(action: "register" | "unregister", generation: string, port?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.socketPath);
      let data = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      // Absolute deadline, not inactivity timeout: a trickling peer cannot hold stop forever.
      const timeout = setTimeout(() => finish(new Error("Pi Web registration unavailable")), this.timeoutMs);
      client.once("error", () => finish(new Error("Pi Web registration unavailable")));
      client.once("close", () => finish(new Error("Pi Web registration unavailable")));
      client.once("connect", () =>
        client.write(
          `${JSON.stringify({ action, ...this.credential, generation, ...(port === undefined ? {} : { port }) })}\n`,
        ),
      );
      client.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        if (data.length > 8192) {
          finish(new Error("Pi Web registration unavailable"));
          return;
        }
        const end = data.indexOf(10);
        if (end < 0) return;
        try {
          const reply = JSON.parse(data.subarray(0, end).toString("utf8"));
          if (reply?.ok !== true) {
            // Only this protocol condition is interpreted; never display remote text.
            if (typeof reply?.error === "string" && reply.error.includes("ended generation")) {
              finish(new EndedGeneration());
            } else finish(new Error("Pi Web registration unavailable"));
          } else finish(undefined, reply.result);
        } catch {
          finish(new Error("Pi Web registration unavailable"));
        }
      });
    });
  }

  async start(port: number, onUrl: (url: string | null) => void): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const epoch = ++this.epoch;
    this.generation = randomBytes(16).toString("hex");
    const refresh = async () => {
      if (epoch !== this.epoch || !this.generation) return;
      try {
        const reply = (await this.request("register", this.generation, port)) as { url?: unknown };
        const url = validatedPublicUrl(reply?.url);
        if (epoch === this.epoch) onUrl(url);
      } catch (error) {
        if (epoch !== this.epoch) return;
        if (error instanceof EndedGeneration) this.generation = randomBytes(16).toString("hex");
        onUrl(null);
      }
    };
    this.pending = this.pending.then(refresh);
    await this.pending;
    if (epoch !== this.epoch) return;
    this.timer = setInterval(() => {
      this.pending = this.pending.then(refresh);
    }, this.renewMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    // Fence before awaiting: late register replies must not resurrect an old URL.
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const generation = this.generation;
    this.generation = null;
    await this.pending.catch(() => {});
    if (generation) await this.request("unregister", generation).catch(() => {});
  }

  guard(request: IncomingMessage, response?: ServerResponse): boolean {
    const generation = this.generation;
    if (request.url?.split("?")[0] === "/.pi-web-identity") {
      const challenge = request.headers["x-pi-web-challenge"];
      const allowed =
        request.method === "GET" &&
        typeof challenge === "string" &&
        /^[0-9a-f]{48}$/.test(challenge) &&
        equal(request.headers["x-pi-web-challenge-proof"], mac(this.credential.token, challenge));
      if (!allowed || !generation) {
        response?.writeHead(403, { "Cache-Control": "no-store" }).end();
        return false;
      }
      response
        ?.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ generation, proof: mac(this.credential.token, `${challenge}:${generation}`) }));
      return false;
    }
    if (request.headers["x-pi-web-generation"] !== undefined || request.headers["x-pi-web-proof"] !== undefined) {
      if (
        !generation ||
        request.headers["x-pi-web-generation"] !== generation ||
        !equal(request.headers["x-pi-web-proof"], mac(this.credential.token, generation))
      ) {
        response?.writeHead(409, { "Cache-Control": "no-store" }).end();
        return false;
      }
    }
    return true;
  }
}

export function createSessionRegistration(config: RegistrationConfig): SessionRegistration {
  try {
    if (statSync(config.credentialFile).size > 4096) throw new Error();
    const credential = JSON.parse(readFileSync(config.credentialFile, "utf8"));
    if (!/^[0-9a-f]{32}$/.test(credential?.run_id) || !/^[0-9a-f]{64}$/.test(credential?.token)) throw new Error();
    return new SessionRegistration({ run_id: credential.run_id, token: credential.token }, config.socketPath);
  } catch {
    throw new Error("Invalid Pi Web registration credentials");
  }
}
