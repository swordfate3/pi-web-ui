import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { type RegistrationConfig, validatedPublicUrl } from "./connection-config.ts";
import { type RuntimeMetadata, readRuntimeMetadata } from "./runtime-metadata.ts";
import { readSoftwareMetadata, type SoftwareMetadata } from "./software-metadata.ts";

type Credential = { run_id: string; token: string };
const mac = (token: string, text: string) => createHmac("sha256", token).update(text).digest("hex");
function equal(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const supplied = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
class EndedGeneration extends Error {}

type RefreshBatch = { epoch: number; done: Promise<void>; bounded?: Promise<void> };
type RegistrationTarget = {
  epoch: number;
  port: number;
  onUrl: (url: string | null) => void;
  getSessionName: () => unknown;
  getRuntime: () => RuntimeMetadata | undefined;
  software?: SoftwareMetadata;
};

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
  private target: RegistrationTarget | undefined;
  private queued: RefreshBatch | undefined;

  constructor(credential: Credential, socketPath: string, options: { timeoutMs?: number; renewMs?: number } = {}) {
    this.credential = credential;
    this.socketPath = socketPath;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.renewMs = options.renewMs ?? 15000;
  }

  private request(
    action: "register" | "unregister",
    generation: string,
    port?: number,
    sessionName?: string | null,
    runtime?: RuntimeMetadata,
    software?: SoftwareMetadata,
  ): Promise<unknown> {
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
          `${JSON.stringify({ action, ...this.credential, generation, ...(port === undefined ? {} : { port, sessionName, ...(runtime ? { runtime } : {}), ...(software ? { software } : {}) }) })}\n`,
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

  async start(
    port: number,
    onUrl: (url: string | null) => void,
    getSessionName: () => unknown = () => null,
    getRuntime: () => RuntimeMetadata | undefined = () => undefined,
    software?: SoftwareMetadata,
  ): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const epoch = ++this.epoch;
    this.generation = randomBytes(16).toString("hex");
    // This is an initialization-time immutable display snapshot. Renewals never
    // reread package files, and do not imply that an on-disk update is running.
    this.target = { epoch, port, onUrl, getSessionName, getRuntime, software };
    await this.enqueueRefresh(this.target).done;
    if (epoch !== this.epoch) return;
    this.timer = setInterval(() => {
      if (this.target?.epoch === epoch) this.enqueueRefresh(this.target);
    }, this.renewMs);
    this.timer.unref();
  }

  /**
   * Best-effort metadata refresh, not a new generation. One in-flight request plus
   * one coalesced trailing batch; read the latest name only when that batch runs.
   * Callers share a 250ms ACK budget (including queue time), not the 5s IPC timeout.
   * Resolving means the attempt finished OR the budget elapsed, not Hub success.
   */
  refresh(): Promise<void> {
    if (!this.target) return Promise.resolve();
    const batch = this.enqueueRefresh(this.target);
    if (!batch.bounded) {
      batch.bounded = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 250);
        void batch.done.then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    return batch.bounded;
  }

  private enqueueRefresh(target: RegistrationTarget): RefreshBatch {
    if (this.queued?.epoch === target.epoch) return this.queued;
    const batch: RefreshBatch = { epoch: target.epoch, done: Promise.resolve() };
    batch.done = this.pending.then(async () => {
      // An old queued task must never clear the new epoch's pending batch.
      if (this.queued === batch) this.queued = undefined;
      await this.registerCurrent(target);
    });
    this.queued = batch;
    this.pending = batch.done;
    return batch;
  }

  private async registerCurrent(target: RegistrationTarget): Promise<void> {
    if (target.epoch !== this.epoch || !this.generation) return;
    let url: string | null = null;
    try {
      // A throwing getter skips this attempt rather than erasing known Hub metadata.
      const name = target.getSessionName();
      // Display-only metadata, never a route/capability identity or prompt excerpt.
      const sessionName =
        typeof name === "string"
          ? name
              .replace(/\p{Cc}/gu, " ")
              .trim()
              .slice(0, 256) || null
          : null;
      const runtime = readRuntimeMetadata(target.getRuntime());
      const software = readSoftwareMetadata(target.software);
      const reply = (await this.request("register", this.generation, target.port, sessionName, runtime, software)) as {
        url?: unknown;
      };
      url = validatedPublicUrl(reply?.url);
    } catch (error) {
      if (target.epoch !== this.epoch) return;
      // Preserve existing recovery only for a Hub-retired generation, not renames.
      if (error instanceof EndedGeneration) this.generation = randomBytes(16).toString("hex");
    }
    if (target.epoch !== this.epoch) return;
    // UI notification failure must not poison the serial registration queue.
    try {
      target.onUrl(url);
    } catch {}
  }

  async stop(): Promise<void> {
    // Fence before awaiting: late register replies must not resurrect an old URL.
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const generation = this.generation;
    this.generation = null;
    this.target = undefined;
    this.queued = undefined;
    // Put unregister on the same tail BEFORE yielding so a concurrent start cannot
    // register its successor first and then be affected by late old cleanup.
    this.pending = this.pending.then(async () => {
      if (generation) await this.request("unregister", generation).catch(() => {});
    });
    await this.pending;
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

/** Route claims must never fall back to unguarded local access when registration is unavailable. */
export function guardSessionRequest(
  registration: SessionRegistration | null,
  request: IncomingMessage,
  response?: ServerResponse,
): boolean {
  if (registration) return registration.guard(request, response);
  const identity = request.url?.split("?")[0] === "/.pi-web-identity";
  if (
    identity ||
    request.headers["x-pi-web-generation"] !== undefined ||
    request.headers["x-pi-web-proof"] !== undefined
  ) {
    response?.writeHead(identity ? 403 : 409, { "Cache-Control": "no-store" }).end();
    return false;
  }
  return true;
}

export function createSessionRegistration(config: RegistrationConfig): SessionRegistration {
  try {
    if (statSync(config.credentialFile).size > 4096) throw new Error();
    const credential = JSON.parse(readFileSync(config.credentialFile, "utf8"));
    if (
      typeof credential?.run_id !== "string" ||
      typeof credential?.token !== "string" ||
      !/^[0-9a-f]{32}$/.test(credential.run_id) ||
      !/^[0-9a-f]{64}$/.test(credential.token)
    ) {
      throw new Error();
    }
    return new SessionRegistration({ run_id: credential.run_id, token: credential.token }, config.socketPath);
  } catch {
    throw new Error("Invalid Pi Web registration credentials");
  }
}
