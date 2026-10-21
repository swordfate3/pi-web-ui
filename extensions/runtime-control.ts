import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { childTerminalBarrier } from "./terminal-barrier.ts";

export type RuntimeSnapshot = {
  run_id: string;
  runtime_id: string;
  session_id: string;
  leaf_id: string | null;
  session_file: string | null;
  cwd: string;
  version: string;
  idle: boolean;
  pending: boolean;
  busy: boolean;
  provider: string | null;
  model: string | null;
  thinking: string;
};

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
// Each entry requires real TUI guard/restart validation; future SDK versions
// stay blocked until their terminal input transport has been checked.
const auditedRuntimeVersions = new Set(["1.1.0", "1.3.0"]);
const equal = (a: unknown, b: string) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

type StdinGuard = {
  version: number;
  transport: string;
  intact(): boolean;
  safe(): boolean;
  taint(): void;
  freeze(owner: object, operation: string): boolean;
  release(owner: object, operation: string): boolean;
  shutdown(owner: object): void;
};
function stdinGuard(): StdinGuard | undefined {
  const key = Symbol.for("pi.runtime.stdin-guard.v1");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  const guard = descriptor?.value as StdinGuard | undefined;
  return descriptor?.configurable === false &&
    descriptor.writable === false &&
    guard?.version === 1 &&
    guard.transport === "pi-tui-1.1.0:stdin-data" &&
    Object.isFrozen(guard) &&
    guard.intact()
    ? guard
    : undefined;
}
export function taintRuntimeInput() {
  stdinGuard()?.taint();
}

/** Private container IPC only. It never signals processes or accepts executable arguments. */
export async function startRuntimeControl(env: NodeJS.ProcessEnv, snapshot: () => RuntimeSnapshot | null) {
  const keys = [env.PI_RUNTIME_RUN_ID, env.PI_RUNTIME_CHILD_TOKEN, env.PI_RUNTIME_EXTENSION_SOCKET];
  if (keys.every((key) => !key)) return undefined;
  const [runId, token, socketPath] = keys;
  if (!hex(runId, 32) || !hex(token, 64) || !socketPath || !path.isAbsolute(socketPath))
    throw new Error("Invalid managed runtime configuration");
  const terminal = env.PI_RUNTIME_PROFILE === "web-terminal-v1";
  const terminalEpoch = env.PI_RUNTIME_TERMINAL_EPOCH;
  if ((terminal && !hex(terminalEpoch, 32)) || (!terminal && terminalEpoch))
    throw new Error("Invalid terminal runtime configuration");
  const barrier = terminal ? childTerminalBarrier() : undefined;
  const adapterInstanceId = randomBytes(16).toString("hex");
  const parent = path.dirname(socketPath);
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent ||
    existsSync(socketPath)
  )
    throw new Error("Unsafe managed runtime directory");
  let prepared: string | null = null;
  let closed = false;
  let preparedAt = 0;
  let lease: NodeJS.Timeout | undefined;
  const guard = terminal ? undefined : stdinGuard();
  const owner = Object.freeze({});
  const release = () => {
    if (prepared) guard?.release(owner, prepared);
    prepared = null;
    clearTimeout(lease);
  };
  const peers = new Set<net.Socket>();
  const fresh = () => {
    const value = snapshot();
    if (
      !value ||
      value.run_id !== runId ||
      !identifier(value.runtime_id) ||
      !identifier(value.session_id) ||
      (value.leaf_id !== null && !identifier(value.leaf_id)) ||
      !identifier(value.version) ||
      typeof value.cwd !== "string" ||
      !path.isAbsolute(value.cwd) ||
      typeof value.idle !== "boolean" ||
      typeof value.pending !== "boolean" ||
      typeof value.busy !== "boolean" ||
      (value.session_file !== null &&
        (typeof value.session_file !== "string" || !path.isAbsolute(value.session_file))) ||
      (value.provider !== null && !identifier(value.provider)) ||
      (value.model !== null && !identifier(value.model)) ||
      !identifier(value.thinking)
    )
      throw new Error("Runtime unavailable");
    const result = {
      ...value,
      busy:
        terminal ||
        value.busy ||
        !guard ||
        stdinGuard() !== guard ||
        !guard.safe() ||
        !auditedRuntimeVersions.has(value.version),
    };
    // Validate the complete outbound envelope before acquiring a barrier.
    if (Buffer.byteLength(`${JSON.stringify({ ok: true, result })}\n`) > 16384) throw new Error("Runtime unavailable");
    return result;
  };
  const server = net.createServer({ allowHalfOpen: true }, (peer) => {
    if (peers.size >= 8 || closed) {
      peer.destroy();
      return;
    }
    peers.add(peer);
    let data = Buffer.alloc(0);
    let replied = false;
    const preparation = new AbortController();
    const timer = setTimeout(() => peer.destroy(), 2000);
    peer.on("error", () => {});
    peer.once("close", () => {
      preparation.abort();
      clearTimeout(timer);
      peers.delete(peer);
    });
    peer.on("data", async (chunk: Buffer) => {
      if (replied) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > 16384) {
        peer.destroy();
        return;
      }
      const end = data.indexOf(10);
      if (end < 0) return;
      replied = true;
      try {
        const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, end)));
        if (!request || typeof request !== "object" || Array.isArray(request) || !equal(request.token, token))
          throw new Error();
        // A prepared lease cannot strand the user's terminal forever if its controller vanished.
        if (prepared && Date.now() - preparedAt > 150_000) release();
        let result: unknown;
        if (request.action === "terminal-state" || request.action === "terminal-prepare") {
          if (!barrier || Object.keys(request).sort().join(",") !== "action,expected,token") throw new Error();
          const expected = request.expected;
          if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error();
          const keys = Object.keys(expected).sort().join(",");
          const discovery = request.action === "terminal-state" && keys === "runId,terminalEpoch";
          if (!discovery && keys !== "runId,runtimeId,sessionId,terminalEpoch") throw new Error();
          // Deliberately not fresh(): native turns/dialogs do not need to be idle,
          // restart-audited, saved, or qualified by the legacy stdin guard.
          const current = snapshot();
          if (
            !current ||
            current.run_id !== runId ||
            expected.runId !== runId ||
            expected.terminalEpoch !== terminalEpoch ||
            !identifier(current.runtime_id) ||
            !identifier(current.session_id) ||
            /[\uD800-\uDFFF]/u.test(current.runtime_id + current.session_id) ||
            (!discovery && (expected.runtimeId !== current.runtime_id || expected.sessionId !== current.session_id))
          )
            throw new Error();
          if (request.action === "terminal-prepare") {
            const isCurrent = () => {
              const live = snapshot();
              return (
                !closed &&
                !peer.destroyed &&
                live?.run_id === runId &&
                live.runtime_id === current.runtime_id &&
                live.session_id === current.session_id
              );
            };
            // Unknown work is rejected without closing chat. Observable work gets
            // a reversible bounded drain; only a successful drain commits the latch.
            if (!(await barrier.prepareWhenDrained(preparation.signal, isCurrent))) throw new Error();
          }
          result = {
            runId,
            runtimeId: current.runtime_id,
            sessionId: current.session_id,
            terminalEpoch,
            adapterInstanceId,
            latched: barrier.latched,
          };
        } else if (
          request.action === "snapshot" &&
          Object.keys(request).every((key) => ["action", "token"].includes(key))
        ) {
          result = fresh();
        } else if (request.action === "prepare") {
          if (terminal) throw new Error();
          if (Object.keys(request).some((key) => !["action", "token", "operation_id", "expected"].includes(key)))
            throw new Error();
          const value = fresh();
          const expected = request.expected;
          if (
            !hex(request.operation_id, 32) ||
            (prepared && prepared !== request.operation_id) ||
            !expected ||
            Object.keys(expected).sort().join(",") !== "leaf_id,runtime_id,session_id" ||
            value.runtime_id !== expected.runtime_id ||
            value.session_id !== expected.session_id ||
            value.leaf_id !== expected.leaf_id ||
            !value.idle ||
            value.pending ||
            value.busy ||
            !value.session_file
          )
            throw new Error();
          const stat = lstatSync(value.session_file);
          if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error();
          if (!guard?.freeze(owner, request.operation_id)) throw new Error();
          if (!prepared) {
            preparedAt = Date.now();
            lease = setTimeout(release, 150_000);
            lease.unref();
          }
          prepared = request.operation_id;
          result = value;
        } else if (request.action === "cancel") {
          if (
            Object.keys(request).some((key) => !["action", "token", "operation_id"].includes(key)) ||
            !prepared ||
            request.operation_id !== prepared
          )
            throw new Error();
          release();
          result = { cancelled: true };
        } else throw new Error();
        const reply = `${JSON.stringify({ ok: true, result })}\n`;
        if (Buffer.byteLength(reply) > 16384) throw new Error();
        peer.end(reply);
      } catch {
        peer.end(`${JSON.stringify({ ok: false, error: "Runtime request rejected" })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  const owned = lstatSync(socketPath);
  server.on("error", () => {});
  return {
    get prepared() {
      if (prepared && Date.now() - preparedAt > 150_000) release();
      return prepared !== null;
    },
    async close(shutdown = false) {
      if (closed) return;
      closed = true;
      if (shutdown) guard?.shutdown(owner);
      release();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const current = lstatSync(socketPath);
        if (current.isSocket() && current.ino === owned.ino && current.dev === owned.dev) unlinkSync(socketPath);
      } catch {}
    },
  };
}
