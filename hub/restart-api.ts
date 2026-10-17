import { closeSync, constants, existsSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { RuntimeMetadata } from "../extensions/runtime-metadata.ts";
import { type HubConfig, privateDirectory, readPrivateJson } from "./config.ts";
import { GateLifecycle, type LifecycleJob, type RestartRequest } from "./lifecycle.ts";
import { HubManagement } from "./management.ts";

type RouteIdentity = { runId: string; generation: string; runtime?: RuntimeMetadata };
type Receipt = RestartRequest & { id: string; generation: string; requestedAt: number };
type Hooks = {
  clearHandoff: (id: string) => void;
  lookup: (generation: string) => Promise<RouteIdentity | undefined>;
  granted: (runId: string) => boolean;
  successor: (
    runId: string,
    runtimeId: string,
    sessionId: string,
    leafId: string | null,
    version: string,
  ) => Promise<string | undefined>;
  prepareHandoff: (
    runId: string,
    receipt: { id: string; generation: string; runtimeId: string; sessionId: string; leafId: string | null },
  ) => void;
};
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256 && !/\p{Cc}/u.test(v);

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new Error();
  const data = await new Promise<Buffer>((resolve, reject) => {
    let data = Buffer.alloc(0);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onError);
      if (error) reject(error);
      else resolve(data);
    };
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 8192) {
        request.resume();
        finish(new Error());
      }
    };
    const onEnd = () => finish();
    const onError = () => finish(new Error());
    const timer = setTimeout(onError, 5000);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onError);
  });
  const value = JSON.parse(data.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value;
}

export function createRestartApi(config: HubConfig, hooks: Hooks) {
  const management = new HubManagement(config);
  const provider = config.lifecycle ? new GateLifecycle(config.lifecycle) : undefined;
  const receipts = path.join(config.stateDir, "restarts");
  if (provider) privateDirectory(receipts);
  const file = (id: string) => {
    if (!hex(id)) throw new Error();
    return path.join(receipts, `${id}.json`);
  };
  const read = (id: string): Receipt => {
    const value = readPrivateJson(file(id));
    if (
      value.id !== id ||
      !hex(value.run_id) ||
      !hex(value.generation) ||
      value.idempotency_key !== id ||
      !text(value.runtime_id) ||
      !text(value.session_id) ||
      (value.leaf_id !== null && !text(value.leaf_id))
    )
      throw new Error();
    return value;
  };
  const save = (value: Receipt) => {
    if (readdirSync(receipts).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).length >= 1000) throw new Error();
    const destination = file(value.id);
    const fd = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
    } finally {
      closeSync(fd);
    }
  };
  const resolve = async (id: string, submitted?: LifecycleJob): Promise<Record<string, unknown>> => {
    if (!provider) throw new Error();
    const receipt = read(id);
    if (!hooks.granted(receipt.run_id)) throw new Error();
    const job = submitted ?? (await provider.operation(id));
    if (job.run_id !== receipt.run_id || !hooks.granted(receipt.run_id)) throw new Error();
    // Persist the first trusted execution timestamp. Later queries, including
    // after a Hub restart, cannot replace it with a fresh lease.
    const clockFile = path.join(receipts, `${id}.started.json`);
    if (job.started_at !== undefined && !existsSync(clockFile))
      writeFileSync(clockFile, JSON.stringify({ started_at: job.started_at }), { flag: "wx", mode: 0o600 });
    if (existsSync(clockFile) && readPrivateJson(clockFile).started_at !== job.started_at) throw new Error();
    const result: Record<string, unknown> = { id, status: job.status, stage: job.stage };
    const failed = (stage: string) => {
      hooks.clearHandoff(id);
      return { ...result, status: "failed", stage };
    };
    if (["failed", "recovery_required", "rejected", "stale"].includes(job.status)) hooks.clearHandoff(id);
    for (const key of ["old_version", "expected_version", "new_version"] as const) if (job[key]) result[key] = job[key];
    if (job.status === "succeeded") {
      if (
        job.old_runtime_id !== receipt.runtime_id ||
        job.session_id !== receipt.session_id ||
        job.leaf_id !== receipt.leaf_id ||
        !job.new_runtime_id ||
        job.new_runtime_id === receipt.runtime_id ||
        !job.new_version ||
        job.new_version !== job.expected_version
      )
        return failed("restored_identity_mismatch");
      if (job.started_at === undefined) throw new Error();
      const deadline = job.started_at + 210_000;
      const verifiedFile = path.join(receipts, `${id}.verified.json`);
      const completed = existsSync(verifiedFile) ? readPrivateJson(verifiedFile) : undefined;
      if (
        completed &&
        (completed.id !== id ||
          completed.run_id !== receipt.run_id ||
          completed.generation !== receipt.generation ||
          completed.old_runtime_id !== receipt.runtime_id ||
          completed.session_id !== receipt.session_id ||
          completed.leaf_id !== receipt.leaf_id ||
          completed.started_at !== job.started_at ||
          !Number.isSafeInteger(completed.at) ||
          completed.at >= deadline ||
          completed.at < job.started_at ||
          completed.at > Date.now() ||
          completed.runtimeId !== job.new_runtime_id ||
          completed.version !== job.new_version ||
          typeof completed.path !== "string" ||
          !/^\/s\/[a-f0-9]{32}\/$/.test(completed.path))
      )
        throw new Error();
      if (!completed && Date.now() >= deadline) return failed("registration_timeout");
      let route: string | undefined;
      try {
        route = await hooks.successor(
          receipt.run_id,
          job.new_runtime_id,
          receipt.session_id,
          receipt.leaf_id,
          job.new_version,
        );
      } catch (error) {
        if (!completed) throw error;
        // Failure to prove current availability cannot undo validated history.
        // Grant revocation still wins below; no path is issued without proof.
      }
      if (!hooks.granted(receipt.run_id)) throw new Error();
      if (completed) {
        // A persisted in-budget result is historical. Progress, quit or a new
        // generation may remove its link, but never turn it into a failed job.
        if (route === completed.path) result.path = route;
        return result;
      }
      if (Date.now() >= deadline) return failed("registration_timeout");
      if (route) {
        if (!existsSync(verifiedFile))
          writeFileSync(
            verifiedFile,
            JSON.stringify({
              id,
              run_id: receipt.run_id,
              generation: receipt.generation,
              old_runtime_id: receipt.runtime_id,
              session_id: receipt.session_id,
              leaf_id: receipt.leaf_id,
              started_at: job.started_at,
              at: Date.now(),
              path: route,
              runtimeId: job.new_runtime_id,
              version: job.new_version,
            }),
            { flag: "wx", mode: 0o600 },
          );
        result.path = route;
      } else {
        result.status = "running";
        result.stage = "waiting_for_registration";
      }
    }
    return result;
  };
  return {
    resolve,
    async handle(request: IncomingMessage, response: ServerResponse, sameOrigin: boolean): Promise<boolean> {
      const pathname = request.url?.split("?")[0] ?? "";
      if (!pathname.startsWith("/api/management/")) return false;
      const reply = (status: number, value: unknown, cookie?: string) => {
        response
          .writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            ...(cookie ? { "Set-Cookie": cookie } : {}),
          })
          .end(JSON.stringify(value));
      };
      let phase = "authorization";
      let unsubmittedReceipt: string | undefined;
      try {
        if (request.method === "GET" && pathname === "/api/management/status") {
          reply(200, { available: !!provider, ...management.status(request) });
          return true;
        }
        if (request.method === "POST" && !sameOrigin) {
          reply(403, { error: "Same-origin management request required" });
          return true;
        }
        if (request.method === "POST" && pathname === "/api/management/unlock") {
          const value = await body(request);
          if (Object.keys(value).join(",") !== "code") throw new Error();
          const result = management.unlock(value.code);
          reply(200, { authorized: true, csrf: result.csrf, expiresAt: result.expiresAt }, result.cookie);
          return true;
        }
        const authorization = management.authorize(request, request.method !== "GET");
        const revalidate = () => {
          phase = "authorization";
          management.revalidate(request, authorization, request.method !== "GET");
          phase = "provider";
        };
        if (request.method === "POST" && pathname === "/api/management/logout") {
          reply(200, { authorized: false }, management.logout(request));
          return true;
        }
        phase = "provider";
        if (!provider) {
          reply(503, { error: "Managed restart is not configured" });
          return true;
        }
        const targetMatch = /^\/api\/management\/targets\/([a-f0-9]{32})$/.exec(pathname);
        if (request.method === "GET" && targetMatch) {
          const selected = await hooks.lookup(targetMatch[1]);
          if (!selected) {
            reply(410, { error: "Session changed" });
            return true;
          }
          if (!selected.runtime?.managed) {
            reply(200, { managed: false });
            return true;
          }
          const target = await provider.target(selected.runId);
          if (!hooks.granted(selected.runId)) throw new Error();
          const { run_id: _runId, ...safe } = target;
          if (
            target.managed &&
            (target.runtime_id !== selected.runtime.runtimeId ||
              target.session_id !== selected.runtime.sessionId ||
              target.leaf_id !== selected.runtime.leafId)
          ) {
            reply(409, { error: "Session identity changed; refresh before restarting" });
            return true;
          }
          reply(200, safe);
          return true;
        }
        if (request.method === "POST" && pathname === "/api/management/restarts") {
          const value = await body(request);
          revalidate();
          if (
            Object.keys(value).sort().join(",") !== "generation,idempotencyKey,leafId,runtimeId,sessionId" ||
            !hex(value.generation) ||
            !hex(value.idempotencyKey) ||
            !text(value.runtimeId) ||
            !text(value.sessionId) ||
            (value.leafId !== null && !text(value.leafId))
          ) {
            reply(400, { error: "Invalid restart request" });
            return true;
          }
          const id = value.idempotencyKey;
          let receipt: Receipt;
          if (existsSync(file(id))) {
            receipt = read(id);
            if (
              receipt.generation !== value.generation ||
              receipt.runtime_id !== value.runtimeId ||
              receipt.session_id !== value.sessionId ||
              receipt.leaf_id !== value.leafId
            )
              throw new Error();
            // A retry is a query, never a second execution or a fresh target selection.
            reply(200, await resolve(id));
            return true;
          }
          const selected = await hooks.lookup(value.generation);
          revalidate();
          if (
            !selected?.runtime?.managed ||
            selected.runtime.runtimeId !== value.runtimeId ||
            selected.runtime.sessionId !== value.sessionId ||
            selected.runtime.leafId !== value.leafId
          ) {
            reply(409, { error: "Session changed or needs a managed image" });
            return true;
          }
          receipt = {
            id,
            generation: value.generation,
            requestedAt: Date.now(),
            run_id: selected.runId,
            runtime_id: value.runtimeId,
            session_id: value.sessionId,
            leaf_id: value.leafId as string | null,
            idempotency_key: id,
          };
          revalidate();
          save(receipt);
          unsubmittedReceipt = id;
          revalidate();
          hooks.prepareHandoff(selected.runId, {
            id,
            generation: value.generation,
            runtimeId: value.runtimeId,
            sessionId: value.sessionId,
            leafId: value.leafId as string | null,
          });
          revalidate();
          unsubmittedReceipt = undefined;
          const job = await provider.restart({
            run_id: receipt.run_id,
            runtime_id: receipt.runtime_id,
            session_id: receipt.session_id,
            leaf_id: receipt.leaf_id,
            idempotency_key: id,
          });
          if (job.id !== id || !hooks.granted(receipt.run_id)) throw new Error();
          reply(202, await resolve(id, job));
          return true;
        }
        const match = /^\/api\/management\/restarts\/([a-f0-9]{32})$/.exec(pathname);
        if (request.method === "GET" && match) {
          reply(200, await resolve(match[1]));
          return true;
        }
        reply(404, { error: "Management route not found" });
      } catch {
        if (unsubmittedReceipt) {
          hooks.clearHandoff(unsubmittedReceipt);
          unlinkSync(file(unsubmittedReceipt));
        }
        reply(phase === "authorization" ? 401 : 409, {
          error:
            phase === "authorization"
              ? "Management authorization required"
              : "Restart unavailable or outcome unknown; refresh status before retrying",
        });
      }
      return true;
    },
  };
}
