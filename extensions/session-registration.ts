import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { type RegistrationConfig, validatedPublicUrl } from "./connection-config.ts";
import { BOUNDED_PROTOCOL, isBoundedGeneration } from "./hub-generation.ts";
import { type InteractionPin, validateInteractionPin } from "./interactions/enrollment.ts";
import {
  type InteractionIdentity,
  type InteractionRegistration,
  readInteractionRegistration,
} from "./interactions/protocol.ts";
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
class RegistryChanged extends Error {}

type RefreshBatch = { epoch: number; done: Promise<void>; bounded?: Promise<void> };
type RegistrationTarget = {
  epoch: number;
  port: number;
  onUrl: (url: string | null) => void;
  getSessionName: () => unknown;
  getRuntime: () => RuntimeMetadata | undefined;
  getInteraction?: () => InteractionRegistration | undefined;
  software?: SoftwareMetadata;
  mode?: "bounded" | "legacy";
  boot?: string;
  slot?: string;
  issuance?: { request_id: string; slot: string };
};

/** One Pi server lifetime, not a multi-process session manager or login provider. */
export class SessionRegistration {
  readonly interactionPin?: InteractionPin;
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

  constructor(
    credential: Credential,
    socketPath: string,
    options: { timeoutMs?: number; renewMs?: number; interactionPin?: InteractionPin } = {},
  ) {
    this.credential = credential;
    this.socketPath = socketPath;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.renewMs = options.renewMs ?? 15000;
    this.interactionPin =
      options.interactionPin === undefined ? undefined : validateInteractionPin(options.interactionPin);
  }

  interactionIdentity(runtimeId: string, sessionId: string): InteractionIdentity | null {
    return this.generation
      ? { runId: this.credential.run_id, generation: this.generation, runtimeId, sessionId }
      : null;
  }

  private request(
    action: string,
    generation?: string,
    port?: number,
    sessionName?: string | null,
    runtime?: RuntimeMetadata,
    software?: SoftwareMetadata,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
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
        else resolve(result as Record<string, unknown>);
      };
      // Absolute deadline, not inactivity timeout: a trickling peer cannot hold stop forever.
      const timeout = setTimeout(() => finish(new Error("Pi Web registration unavailable")), this.timeoutMs);
      client.once("error", () => finish(new Error("Pi Web registration unavailable")));
      client.once("close", () => finish(new Error("Pi Web registration unavailable")));
      client.once("connect", () =>
        client.write(
          `${JSON.stringify({ action, ...this.credential, generation, ...extra, ...(port === undefined ? {} : { port, sessionName, ...(runtime ? { runtime } : {}), ...(software ? { software } : {}) }) })}\n`,
        ),
      );
      client.on("data", (chunk: Buffer) => {
        if (data.length + chunk.length > 8192) {
          finish(new Error("Pi Web registration unavailable"));
          return;
        }
        data = Buffer.concat([data, chunk]);
        const end = data.indexOf(10);
        if (end < 0) return;
        try {
          const reply = JSON.parse(data.subarray(0, end).toString("utf8"));
          if (action === "registry_negotiate") {
            finish(undefined, reply);
            return;
          }
          if (reply?.ok !== true) {
            // Only this protocol condition is interpreted; never display remote text.
            if (
              (action === "register" && typeof reply?.error === "string" && reply.error.includes("ended generation")) ||
              reply?.code === "ENDED_GENERATION"
            ) {
              finish(new EndedGeneration());
            } else if (["ISSUANCE_STALE", "PROTOCOL_REJECTED"].includes(reply?.code)) {
              finish(new RegistryChanged());
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
    getInteraction?: () => InteractionRegistration | undefined,
  ): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const epoch = ++this.epoch;
    this.generation = null;
    // This is an initialization-time immutable display snapshot. Renewals never
    // reread package files, and do not imply that an on-disk update is running.
    this.target = { epoch, port, onUrl, getSessionName, getRuntime, software, getInteraction };
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
    if (target.epoch !== this.epoch) return;
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
      const interaction = readInteractionRegistration(target.getInteraction?.());
      if (!target.mode || (target.mode === "bounded" && !target.boot)) {
        const nonce = randomBytes(16).toString("hex");
        const negotiated = await this.request(
          "registry_negotiate",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { protocol: BOUNDED_PROTOCOL, nonce },
        );
        if (target.epoch !== this.epoch) return;
        const result = negotiated?.result as Record<string, unknown> | undefined;
        if (
          negotiated?.ok === true &&
          result?.protocol === BOUNDED_PROTOCOL &&
          result.nonce === nonce &&
          typeof result.boot === "string" &&
          /^[a-f0-9]{32}$/.test(result.boot) &&
          typeof result.slot === "string" &&
          /^[a-f0-9]{16}$/.test(result.slot) &&
          equal(result.proof, mac(this.credential.token, `${nonce}:${BOUNDED_PROTOCOL}:${result.boot}:${result.slot}`))
        ) {
          target.mode = "bounded";
          target.boot = result.boot;
          target.slot = result.slot;
          target.issuance = undefined;
          this.generation = null;
        } else if (
          !target.mode &&
          negotiated?.ok === false &&
          negotiated.code === "UNSUPPORTED_PROTOCOL" &&
          negotiated.protocol === BOUNDED_PROTOCOL &&
          negotiated.nonce === nonce &&
          negotiated.legacy === "legacy-v1" &&
          equal(
            negotiated.proof,
            mac(this.credential.token, `${nonce}:${BOUNDED_PROTOCOL}:UNSUPPORTED_PROTOCOL:legacy-v1`),
          )
        ) {
          target.mode = "legacy";
          this.generation = randomBytes(16).toString("hex");
        } else throw new Error("Pi Web registration unavailable");
      }
      if (target.mode === "bounded" && !this.generation) {
        if (!target.slot) throw new Error("Pi Web registration unavailable");
        target.issuance ??= { request_id: randomBytes(16).toString("hex"), slot: target.slot };
        const issued = await this.request("bounded_issue", undefined, target.port, undefined, undefined, undefined, {
          protocol: BOUNDED_PROTOCOL,
          boot: target.boot,
          ...target.issuance,
        });
        if (target.epoch !== this.epoch) return;
        if (
          !isBoundedGeneration(issued?.generation) ||
          issued.boot !== target.boot ||
          typeof issued.slot !== "string" ||
          !/^[a-f0-9]{16}$/.test(issued.slot) ||
          !issued.generation.startsWith(`b2-${target.boot}-${issued.slot}-`) ||
          BigInt(`0x${issued.slot}`) !== BigInt(`0x${target.issuance.slot}`) + 1n
        )
          throw new Error("Pi Web registration unavailable");
        // Install identity BEFORE Hub proof. A late reply from a stopped epoch
        // is discarded above; its unobserved pending tuple simply expires.
        this.generation = issued.generation;
        target.slot = issued.slot;
        target.issuance = undefined;
      }
      if (!this.generation) throw new Error("Pi Web registration unavailable");
      const reply = (await this.request(
        target.mode === "bounded" ? "bounded_register" : "register",
        this.generation,
        target.port,
        sessionName,
        runtime,
        software,
        {
          ...(target.mode === "bounded" ? { protocol: BOUNDED_PROTOCOL, boot: target.boot } : {}),
          ...(interaction ? { interaction } : {}),
        },
      )) as {
        url?: unknown;
      };
      if (target.epoch !== this.epoch) return;
      url = validatedPublicUrl(reply?.url);
      if (target.mode === "bounded" && new URL(url).pathname !== `/s/${this.generation}/`)
        throw new Error("Pi Web registration unavailable");
    } catch (error) {
      if (target.epoch !== this.epoch) return;
      // Preserve existing recovery only for a Hub-retired generation, not renames.
      if (error instanceof EndedGeneration || error instanceof RegistryChanged) {
        this.generation = target.mode === "legacy" ? randomBytes(16).toString("hex") : null;
        if (target.mode === "bounded") {
          target.boot = undefined;
          target.issuance = undefined;
        }
      }
      url = null;
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
    const target = this.target;
    this.generation = null;
    this.target = undefined;
    this.queued = undefined;
    // Put unregister on the same tail BEFORE yielding so a concurrent start cannot
    // register its successor first and then be affected by late old cleanup.
    this.pending = this.pending.then(async () => {
      if (generation)
        await this.request(
          target?.mode === "bounded" ? "bounded_unregister" : "unregister",
          generation,
          undefined,
          undefined,
          undefined,
          undefined,
          target?.mode === "bounded" ? { protocol: BOUNDED_PROTOCOL, boot: target.boot } : {},
        ).catch(() => {});
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
    return new SessionRegistration({ run_id: credential.run_id, token: credential.token }, config.socketPath, {
      ...(credential.interactions === undefined
        ? {}
        : { interactionPin: validateInteractionPin(credential.interactions) }),
    });
  } catch {
    throw new Error("Invalid Pi Web registration credentials");
  }
}
