import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalBinding, TerminalTarget } from "../../hub/terminal-contract.ts";
import { TerminalLeaseState } from "../../hub/terminal-lease.ts";
import { TerminalScreen } from "../../hub/terminal-screen.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const id = () => randomBytes(16).toString("hex");
const MAX_FRAME = 65_536;
const QUEUE_BYTES = 262_144;
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(",") === keys;

/**
 * Test-only private Unix transport. Reuses the product lease model with a real
 * Python PTY sink, but is NOT a Hub provider, browser API or authorization UI.
 * Explicit startup means remote-only test control; there is no local TTY relay.
 */
export async function startPtyTransport(options: { screen?: boolean; runId?: string } = {}) {
  if (options.runId !== undefined && !/^[a-f0-9]{32}$/.test(options.runId))
    throw new Error("Invalid isolated transport run identity");
  const screen = options.screen ? new TerminalScreen() : null;
  const directory = mkdtempSync(path.join(tmpdir(), "pi-pty-transport-"));
  chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "terminal.sock");
  const readToken = randomBytes(32).toString("hex");
  const writeToken = randomBytes(32).toString("hex");
  const child = spawn("python3", ["-I", "-B", path.join(ROOT, "e2e/harness/pty-stream-worker.py")], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PI_E2E_BIN: process.env.PI_E2E_BIN,
      PI_PTY_TUI_MODE: process.env.PI_PTY_TUI_MODE,
      PI_PTY_FENCE_DIR: directory,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Do not copy worker stderr or terminal bytes into test error/log output.
  child.stderr.resume();
  let stopped = false;
  let ready = false;
  let target: TerminalTarget;
  let state: TerminalLeaseState;
  let piPid = 0;
  let sequence = 0;
  let outputSequence = 0;
  let screenWork = Promise.resolve();
  let queuedScreenBytes = 0;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSnapshot = () => {
    if (!screen || stopped || snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      const work = screenWork.then(async () => {
        const snapshot = await screen.capture();
        if (stopped) return;
        for (const peer of sockets)
          if (peer.authenticated) emit(peer, { type: "screen", terminalEpoch: target.terminalEpoch, ...snapshot });
      });
      screenWork = work;
      void work.catch(fail);
    }, 50);
  };
  let workerBuffer = Buffer.alloc(0);
  let writer: Peer | null = null;
  let revoking = false;
  let grantTimer: ReturnType<typeof setTimeout> | undefined;
  const sockets = new Set<Peer>();
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
  type Peer = {
    socket: Socket;
    binding: TerminalBinding;
    authenticated: boolean;
    write: boolean;
    dead: boolean;
    buffer: Buffer;
    leaseId?: string;
    timer?: ReturnType<typeof setTimeout>;
  };
  const rpc = (message: Record<string, unknown>) => {
    if (stopped || child.stdin.destroyed || pending.size >= 4 || child.stdin.writableLength > MAX_FRAME)
      return Promise.reject(new Error("PTY worker unavailable"));
    const requestId = ++sequence;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("PTY delivery unknown; do not retry"));
        fail();
      }, 2000);
      pending.set(requestId, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ ...message, id: requestId })}\n`, (error) => {
        if (error) fail();
      });
    });
  };
  const emit = (peer: Peer, message: Record<string, unknown>) => {
    if (peer.dead) return;
    const bytes = `${JSON.stringify(message)}\n`;
    if (peer.socket.writableLength + Buffer.byteLength(bytes) > QUEUE_BYTES) {
      drop(peer);
      return;
    }
    peer.socket.write(bytes);
  };
  const revoke = async (peer: Peer) => {
    if (writer !== peer) return;
    // Independent of the FIFO: sink checks this marker immediately before write.
    // A check that already passed is in-flight/unknown, never claimed cancelled.
    if (peer.leaseId) {
      try {
        unlinkSync(path.join(directory, peer.leaseId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Do not pretend the independent fence succeeded on an I/O failure.
          fail();
          return;
        }
      }
    }
    writer = null;
    revoking = true;
    clearTimeout(grantTimer);
    state.revoke(peer.binding); // fence broker synchronously, before any I/O
    try {
      const result = await rpc({ type: "revoke", terminalEpoch: target.terminalEpoch, leaseId: peer.leaseId });
      if (result.ok !== true) throw new Error();
      revoking = false; // successor grant only after the real sink acknowledges revoke
      for (const reader of sockets) if (reader.authenticated) emit(reader, { type: "control-released" });
    } catch {
      fail();
    }
  };
  const drop = (peer: Peer) => {
    if (peer.dead) return;
    peer.dead = true;
    clearTimeout(peer.timer);
    sockets.delete(peer);
    if (writer === peer) void revoke(peer);
    peer.socket.destroy();
  };
  const fail = () => {
    if (stopped) return;
    stopped = true;
    const previousWriter = writer;
    writer = null;
    if (previousWriter?.leaseId) {
      try {
        unlinkSync(path.join(directory, previousWriter.leaseId));
      } catch {
        /* shutdown remains unknown on filesystem failure */
      }
    }
    clearTimeout(grantTimer);
    clearTimeout(snapshotTimer);
    screen?.dispose();
    if (ready) state.freeze();
    rejectReady?.(new Error("Isolated PTY unavailable"));
    for (const peer of sockets) drop(peer);
    for (const request of pending.values()) request.reject(new Error("PTY delivery unknown; do not retry"));
    pending.clear();
    child.stdin.end(); // worker EOF cleans up the only Pi
    server.close();
  };
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.once("close", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    workerBuffer = Buffer.concat([workerBuffer, chunk]);
    if (workerBuffer.length > MAX_FRAME * 2) return fail();
    while (workerBuffer.includes(10)) {
      const end = workerBuffer.indexOf(10);
      if (end > MAX_FRAME) return fail();
      const line = workerBuffer.subarray(0, end);
      workerBuffer = workerBuffer.subarray(end + 1);
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
        if (value.type === "ready" && !ready) {
          if (!/^[a-f0-9]{32}$/.test(value.terminalEpoch) || !Number.isSafeInteger(value.pid) || value.pid <= 1)
            return fail();
          target = {
            v: 1,
            runId: options.runId ?? id(),
            runtimeId: id(),
            sessionId: "isolated-ephemeral",
            terminalEpoch: value.terminalEpoch,
            profile: "web-terminal-v1",
            inputState: "none",
            managedRestartEligible: false,
          };
          state = new TerminalLeaseState(target);
          piPid = value.pid;
          ready = true;
          resolveReady();
        } else if (value.type === "ack" && Number.isSafeInteger(value.id) && pending.has(value.id)) {
          pending.get(value.id)?.resolve(value);
          pending.delete(value.id);
        } else if (value.type === "geometry" && ready) {
          if (
            !Number.isInteger(value.columns) ||
            value.columns < 20 ||
            value.columns > 240 ||
            !Number.isInteger(value.rows) ||
            value.rows < 5 ||
            value.rows > 120
          )
            return fail();
          if (screen) {
            const work = screenWork.then(async () => {
              await screen.resize(value.columns, value.rows);
              scheduleSnapshot();
            });
            screenWork = work;
            void work.catch(fail);
          }
        } else if (value.type === "output" && ready && typeof value.data === "string") {
          const bytes = Buffer.from(value.data, "base64");
          if (bytes.length > 32768 || bytes.toString("base64") !== value.data) return fail();
          if (screen) {
            queuedScreenBytes += bytes.length;
            if (queuedScreenBytes > 1048576) return fail();
            const work = screenWork.then(async () => {
              await screen.write(bytes);
              queuedScreenBytes -= bytes.length;
              scheduleSnapshot();
            });
            screenWork = work;
            void work.catch(fail);
          } else {
            // Raw mode remains a test-only transport, NOT a reconnect screen.
            const sequence = ++outputSequence;
            for (const peer of sockets)
              if (peer.authenticated)
                emit(peer, { type: "output", terminalEpoch: target.terminalEpoch, sequence, data: value.data });
          }
        } else return fail();
      } catch {
        return fail();
      }
    }
    if (workerBuffer.length > MAX_FRAME) fail();
  });
  const authorized = (token: unknown, expected: string) =>
    typeof token === "string" &&
    token.length === expected.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  const handle = async (peer: Peer, value: Record<string, unknown>) => {
    if (stopped || peer.dead) return;
    if (!peer.authenticated) {
      if (!exact(value, "token,type") || value.type !== "auth") return drop(peer);
      const write = authorized(value.token, writeToken);
      if (!write && !authorized(value.token, readToken)) return drop(peer);
      peer.authenticated = true;
      peer.write = write;
      clearTimeout(peer.timer);
      peer.timer = undefined;
      if (screen) {
        // Install the peer and capture its first full frame in the same serial queue
        // as parser writes. No live delta can overtake or precede the first snapshot.
        peer.authenticated = false;
        const work = screenWork.then(async () => {
          const snapshot = await screen.capture();
          if (peer.dead || stopped) return;
          peer.authenticated = true;
          emit(peer, { type: "attached", target: state.snapshot(), write, screenAvailable: true });
          emit(peer, { type: "screen", terminalEpoch: target.terminalEpoch, ...snapshot });
        });
        screenWork = work;
        await work;
      } else emit(peer, { type: "attached", target: state.snapshot(), write, screenAvailable: false });
      return;
    }
    if (value.type === "control" && exact(value, "terminalEpoch,type")) {
      if (!peer.write || writer || revoking || value.terminalEpoch !== target.terminalEpoch) {
        emit(peer, { type: "denied" });
        return;
      }
      const lease = state.grant(peer.binding, target);
      writer = peer;
      peer.leaseId = lease.leaseId;
      writeFileSync(path.join(directory, lease.leaseId), "", { flag: "wx", mode: 0o600 });
      grantTimer = setTimeout(() => {
        drop(peer);
      }, lease.expiresInMs);
      const result = await rpc({ type: "grant", terminalEpoch: target.terminalEpoch, ...lease });
      if (result.ok !== true) return fail();
      if (peer.dead || writer !== peer) return;
      emit(peer, { type: "control", ...lease });
      return;
    }
    if (value.type === "input") {
      if (writer !== peer || !peer.write) return drop(peer);
      const data = state.consume(peer.binding, target, value);
      // No await between live checks and delivery to the bounded, fixed sink pipe.
      const result = await rpc({
        type: "input",
        terminalEpoch: target.terminalEpoch,
        leaseId: peer.leaseId,
        sequence: value.sequence,
        data,
      });
      if (result.ok !== true) return drop(peer);
      emit(peer, { type: "written", sequence: value.sequence, bytesWritten: result.bytesWritten });
      return;
    }
    if (value.type === "resize" && exact(value, "columns,leaseId,rows,terminalEpoch,type")) {
      if (
        writer !== peer ||
        state.snapshot().inputState !== "remote" ||
        value.terminalEpoch !== target.terminalEpoch ||
        value.leaseId !== peer.leaseId
      )
        return drop(peer);
      if (
        !Number.isInteger(value.columns) ||
        !Number.isInteger(value.rows) ||
        Number(value.columns) < 20 ||
        Number(value.columns) > 240 ||
        Number(value.rows) < 5 ||
        Number(value.rows) > 120
      )
        return drop(peer);
      const result = await rpc({ ...value });
      if (result.ok !== true) return drop(peer);
      await screenWork; // ordered geometry notification precedes ACK and redraw output
      scheduleSnapshot();
      emit(peer, { type: "resized" });
      return;
    }
    drop(peer);
  };
  const server = createServer((socket) => {
    if (stopped || sockets.size >= 3) return socket.destroy();
    const peer: Peer = {
      socket,
      binding: { authorizationId: id(), connectionId: id() },
      authenticated: false,
      write: false,
      dead: false,
      buffer: Buffer.alloc(0),
    };
    sockets.add(peer);
    peer.timer = setTimeout(() => drop(peer), 2000);
    socket.on("error", () => drop(peer));
    socket.on("close", () => drop(peer));
    socket.on("end", () => drop(peer));
    let handling = false;
    socket.on("data", (chunk: Buffer) => {
      // One outstanding frame. Pipelined keystrokes are not queued or auto-retried.
      if (handling || peer.buffer.length + chunk.length > MAX_FRAME) return drop(peer);
      peer.buffer = Buffer.concat([peer.buffer, chunk]);
      const end = peer.buffer.indexOf(10);
      if (end < 0) {
        if (!peer.timer) peer.timer = setTimeout(() => drop(peer), 2000);
        return;
      }
      if (end !== peer.buffer.length - 1) return drop(peer);
      const line = peer.buffer;
      peer.buffer = Buffer.alloc(0);
      clearTimeout(peer.timer);
      peer.timer = undefined;
      handling = true;
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
        if (!value || typeof value !== "object" || Array.isArray(value)) return drop(peer);
        void handle(peer, value)
          .catch(() => drop(peer))
          .finally(() => {
            handling = false;
          });
      } catch {
        drop(peer);
      }
    });
  });
  server.on("error", fail);
  const waitForExit = async () => {
    const wait = (ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        exit.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    if (await wait(1000)) return;
    // kill() uses the owned ChildProcess handle, not a recycled external PID.
    child.kill("SIGTERM");
    child.kill("SIGCONT"); // a stopped worker must run its finally to reap Pi
    if (!(await wait(26_000)))
      throw new Error("PTY worker cleanup incomplete; inspect isolated test processes (no automatic retry)");
  };
  try {
    await Promise.race([
      readiness,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("PTY startup timed out")), 25_000);
        readiness.finally(() => clearTimeout(timer)).catch(() => {});
      }),
    ]);
    if (screen) {
      const barrier = await rpc({ type: "barrier" });
      if (barrier.ok !== true) throw new Error("Terminal startup stream unavailable");
      await screenWork; // startup stream parsed before anyone can attach
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  } catch (error) {
    fail();
    await waitForExit();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    readToken,
    writeToken,
    get target() {
      return { ...target };
    },
    get piPid() {
      return piPid;
    },
    get workerPid() {
      return child.pid;
    },
    get controlState() {
      return stopped ? "fenced" : revoking ? "revoking" : state.snapshot().inputState;
    },
    async close() {
      if (!stopped) {
        try {
          await rpc({ type: "stop" });
        } catch {
          /* delivery remains unknown */
        }
      }
      fail();
      await waitForExit();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
