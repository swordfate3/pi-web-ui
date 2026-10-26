import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";

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
// This adapter admits an intact, versioned input-guard protocol, not specific
// release numbers. Gate independently requires measured source/candidate and
// disposable-restore evidence before it may authorize any runtime update.
const stableRuntimeVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const equal = (a: unknown, b: string) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const snapshotFields = [
  "run_id",
  "runtime_id",
  "session_id",
  "leaf_id",
  "session_file",
  "cwd",
  "version",
  "idle",
  "pending",
  "busy",
  "provider",
  "model",
  "thinking",
] as const;
function sameSnapshot(a: unknown, b: RuntimeSnapshot): boolean {
  return (
    !!a &&
    typeof a === "object" &&
    !Array.isArray(a) &&
    Object.keys(a).sort().join() === [...snapshotFields].sort().join() &&
    snapshotFields.every((key) => (a as Record<string, unknown>)[key] === b[key])
  );
}

type StdinGuard = {
  version: number;
  transport: string;
  intact(): boolean;
  safe(): boolean;
  taint(): void;
  freeze(owner: object, operation: string): boolean;
  release(owner: object, operation: string): boolean;
  shutdown(owner: object): void;
  webInput?: string;
  dispatchPrompt?(message: string): boolean;
};
function stdinGuard(): StdinGuard | undefined {
  const key = Symbol.for("pi.runtime.stdin-guard.v1");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  const guard = descriptor?.value as StdinGuard | undefined;
  return descriptor?.configurable === false &&
    descriptor.writable === false &&
    guard?.version === 1 &&
    (guard.transport === "pi-tui-1.1.0:stdin-data" || guard.transport === "pi-rpc-v1:stdin-stdout-jsonl") &&
    Object.isFrozen(guard) &&
    guard.intact()
    ? guard
    : undefined;
}
export function taintRuntimeInput() {
  stdinGuard()?.taint();
}

/** Account before Pi's void API can enter asynchronous prompt preflight. */
export function dispatchRuntimeUserMessage(dispatch: () => void) {
  const guard = stdinGuard();
  if (guard?.transport === "pi-rpc-v1:stdin-stdout-jsonl") {
    // The public extension API provides neither a completion promise nor a
    // dispatch ID. agent_start/agent_settled may belong to another submission;
    // handled/queued input may still own work. Fail closed for this process.
    guard.taint();
  }
  dispatch();
}

/** Explicit managed RPC profile: idle text only, never a retry/fallback after refusal. */
export function dispatchRuntimeRpcTextPrompt(message: string): boolean {
  if (process.env.PI_RUNTIME_RPC_WEB_INPUT !== "correlated-text-v1") return false;
  const guard = stdinGuard();
  if (
    guard?.transport !== "pi-rpc-v1:stdin-stdout-jsonl" ||
    guard.webInput !== "correlated-text-v1" ||
    typeof guard.dispatchPrompt !== "function" ||
    !guard.dispatchPrompt(message)
  )
    throw new Error("Managed text input is unavailable or busy; the message was not retried.");
  return true;
}

/** Private container IPC only. It never signals processes or accepts executable arguments. */
export async function startRuntimeControl(env: NodeJS.ProcessEnv, snapshot: () => RuntimeSnapshot | null) {
  const keys = [env.PI_RUNTIME_RUN_ID, env.PI_RUNTIME_CHILD_TOKEN, env.PI_RUNTIME_EXTENSION_SOCKET];
  if (keys.every((key) => !key)) return undefined;
  const [runId, token, socketPath] = keys;
  if (!hex(runId, 32) || !hex(token, 64) || !socketPath || !path.isAbsolute(socketPath))
    throw new Error("Invalid managed runtime configuration");
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
  let heldSnapshot: RuntimeSnapshot | undefined;
  let committed = false;
  let lease: NodeJS.Timeout | undefined;
  const guard = stdinGuard();
  const owner = Object.freeze({});
  const release = () => {
    if (committed) return;
    if (prepared) guard?.release(owner, prepared);
    prepared = null;
    heldSnapshot = undefined;
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
        value.busy || !guard || stdinGuard() !== guard || !guard.safe() || !stableRuntimeVersion.test(value.version),
    };
    // Validate the complete outbound envelope before acquiring a barrier.
    if (Buffer.byteLength(`${JSON.stringify({ ok: true, result })}\n`) > 16384) throw new Error("Runtime unavailable");
    return result;
  };
  const server = net.createServer((peer) => {
    if (peers.size >= 8 || closed) {
      peer.destroy();
      return;
    }
    peers.add(peer);
    let data = Buffer.alloc(0);
    let replied = false;
    const timer = setTimeout(() => peer.destroy(), 2000);
    peer.on("error", () => {});
    peer.once("close", () => {
      clearTimeout(timer);
      peers.delete(peer);
    });
    peer.on("data", (chunk: Buffer) => {
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
        const request = JSON.parse(data.subarray(0, end).toString("utf8"));
        if (!request || typeof request !== "object" || Array.isArray(request) || !equal(request.token, token))
          throw new Error();
        // A prepared lease cannot strand the user's terminal forever if its controller vanished.
        if (prepared && !committed && performance.now() - preparedAt >= 150_000) release();
        let result: unknown;
        if (request.action === "snapshot" && Object.keys(request).every((key) => ["action", "token"].includes(key))) {
          result = fresh();
        } else if (request.action === "prepare") {
          if (committed) throw new Error();
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
            preparedAt = performance.now();
            heldSnapshot = { ...value };
            lease = setTimeout(release, 150_000);
            lease.unref();
          }
          prepared = request.operation_id;
          result = value;
        } else if (request.action === "commit") {
          if (
            Object.keys(request).sort().join() !== "action,expected,operation_id,token" ||
            committed ||
            !prepared ||
            request.operation_id !== prepared ||
            !heldSnapshot ||
            performance.now() - preparedAt >= 150_000
          )
            throw new Error();
          const value = fresh();
          if (
            !sameSnapshot(request.expected, heldSnapshot) ||
            !sameSnapshot(value, heldSnapshot) ||
            !value.idle ||
            value.pending ||
            value.busy ||
            !guard
          )
            throw new Error();
          // No await between complete live-state comparison and the permanent
          // admission latch. A lost acknowledgement must never reopen input.
          if (performance.now() - preparedAt >= 150_000) throw new Error();
          committed = true;
          clearTimeout(lease);
          guard.shutdown(owner);
          if (guard.safe()) throw new Error();
          result = { committed: true, operation_id: prepared, snapshot: value };
        } else if (request.action === "cancel") {
          if (
            committed ||
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
      if (prepared && !committed && performance.now() - preparedAt >= 150_000) release();
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
