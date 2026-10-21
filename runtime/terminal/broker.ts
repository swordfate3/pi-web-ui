import { chmodSync, lstatSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { TerminalBinding, TerminalTarget } from "../../hub/terminal-contract.ts";
import { parseTerminalTarget, sameTerminal, terminalId } from "../../hub/terminal-contract.ts";
import { TerminalLeaseState } from "../../hub/terminal-lease.ts";
import type { ScreenSnapshot } from "../../hub/terminal-screen.ts";
import { TerminalScreen } from "../../hub/terminal-screen.ts";
import type { Frame } from "./protocol.ts";
import {
  bytes,
  encode,
  exact,
  firstFrame,
  INPUT_BYTES,
  JsonLines,
  OUTPUT_BYTES,
  PEER_BYTES,
  size,
} from "./protocol.ts";

type Startup = {
  type: "start";
  directory: string;
  runId: string;
  childToken: string;
  terminalEpoch: string;
  owner: "local" | "none";
  columns: number;
  rows: number;
};
type AdapterState = {
  runId: string;
  runtimeId: string;
  sessionId: string;
  terminalEpoch: string;
  adapterInstanceId: string;
  latched: boolean;
};
type Peer = {
  socket: net.Socket;
  binding?: TerminalBinding;
  target?: TerminalTarget;
  scope?: "read" | "write";
  closed: boolean;
  lastId: number;
  pending: boolean;
  leaseId?: string;
  snapshot?: Buffer;
  snapshotSequence?: number;
  chunk: number;
  timer: NodeJS.Timeout;
  outputTimer?: NodeJS.Timeout;
};

/** The inherited nonblocking PTY descriptor is the only input sink. No stream writes/retries. */
class Broker {
  private readonly peers = new Set<Peer>();
  private readonly screen: TerminalScreen;
  private lease?: TerminalLeaseState;
  private target?: TerminalTarget;
  private adapter?: AdapterState;
  private heartbeatAt = -Infinity;
  private remoteDisabled = false;
  private parserFailed = false;
  private generation = 0;
  private owner: "local" | "none";
  private acquiring = false;
  private writer?: Peer;
  private polling = false;
  private stopped = false;
  private dirty = true;
  private capturing = false;
  private resizeAt = -Infinity;
  private resize?: { peer: Peer; id: number; generation: number; columns: number; rows: number; timer: NodeJS.Timeout };
  private readonly pendingAdapters = new Set<net.Socket>();
  private readonly server: net.Server;
  private readonly interval: NodeJS.Timeout;
  private socketIdentity?: { ino: number; dev: number };

  constructor(
    private readonly config: Startup,
    private readonly master: number,
    private readonly relay: net.Socket,
  ) {
    exact(config as unknown as Frame, "childToken,columns,directory,owner,rows,runId,terminalEpoch,type");
    if (
      config.type !== "start" ||
      !terminalId(config.runId) ||
      !terminalId(config.terminalEpoch) ||
      !/^[a-f0-9]{64}$/.test(config.childToken) ||
      !["local", "none"].includes(config.owner) ||
      !size(config.columns, config.rows) ||
      !path.isAbsolute(config.directory)
    )
      throw new Error();
    const stat = lstatSync(config.directory);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      realpathSync(config.directory) !== config.directory
    )
      throw new Error();
    this.owner = config.owner;
    this.screen = new TerminalScreen(config.columns, config.rows);
    this.server = net.createServer((socket) => this.connect(socket));
    this.server.on("error", () => this.close());
    this.server.listen(path.join(config.directory, "terminal.sock"), () => {
      chmodSync(path.join(config.directory, "terminal.sock"), 0o600);
      this.socketIdentity = lstatSync(path.join(config.directory, "terminal.sock"));
      this.localFrame({ type: "started", managedRestartEligible: false, reason: "terminal_profile_unaudited" });
    });
    this.interval = setInterval(() => {
      if (this.adapter && performance.now() - this.heartbeatAt > 750) this.fence();
      void this.poll();
      this.publish();
    }, 100);
    void this.poll();
  }

  private localFrame(frame: object) {
    if (this.relay.destroyed || this.relay.writableLength + 65_536 > PEER_BYTES) {
      this.close();
      return;
    }
    this.relay.write(encode(frame));
  }

  private fence() {
    const first = !this.remoteDisabled;
    this.remoteDisabled = true;
    this.writer = undefined;
    this.generation++;
    for (const peer of this.peers)
      if (peer.binding) {
        this.lease?.revoke(peer.binding);
        peer.leaseId = undefined;
        peer.snapshot = undefined;
        if (first && !this.stopped) this.send(peer, { type: "screen-unavailable" });
      }
  }

  private screenFailure() {
    if (this.parserFailed) return;
    this.parserFailed = true;
    this.fence();
    this.screen.dispose();
    this.localFrame({ type: "screen-disabled" });
  }

  private async adapterCall(action: "terminal-state" | "terminal-prepare"): Promise<AdapterState> {
    if (this.pendingAdapters.size >= 2 || this.stopped) throw new Error();
    const expected = this.target
      ? {
          runId: this.target.runId,
          runtimeId: this.target.runtimeId,
          sessionId: this.target.sessionId,
          terminalEpoch: this.target.terminalEpoch,
        }
      : { runId: this.config.runId, terminalEpoch: this.config.terminalEpoch };
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path.join(this.config.directory, "adapter.sock"));
      this.pendingAdapters.add(socket);
      let settled = false;
      const finish = (state?: AdapterState) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingAdapters.delete(socket);
        socket.destroy();
        if (state) resolve(state);
        else reject(new Error("adapter_unavailable"));
      };
      const timer = setTimeout(() => finish(), 500);
      const parser = new JsonLines((frame) => {
        try {
          exact(frame, "ok,result");
          if (frame.ok !== true || !frame.result || typeof frame.result !== "object" || Array.isArray(frame.result))
            throw new Error();
          const state = frame.result as AdapterState;
          exact(state as unknown as Frame, "adapterInstanceId,latched,runId,runtimeId,sessionId,terminalEpoch");
          const target = parseTerminalTarget({
            v: 1,
            ...expected,
            runtimeId: state.runtimeId,
            sessionId: state.sessionId,
            profile: "web-terminal-v1",
            managedRestartEligible: false,
            inputState: "none",
          });
          if (
            state.runId !== this.config.runId ||
            state.terminalEpoch !== this.config.terminalEpoch ||
            !terminalId(state.adapterInstanceId) ||
            typeof state.latched !== "boolean" ||
            (this.target && !sameTerminal(this.target, state)) ||
            !sameTerminal(target, state)
          )
            throw new Error();
          finish(state);
        } catch {
          finish();
        }
      });
      socket.on("connect", () => socket.write(encode({ action, token: this.config.childToken, expected })));
      socket.on("data", (chunk: Buffer) => {
        try {
          parser.push(chunk);
        } catch {
          finish();
        }
      });
      socket.on("error", () => finish());
      socket.on("end", () => finish());
    });
  }

  private observe(state: AdapterState): boolean {
    if (this.stopped || this.remoteDisabled) return false;
    if (
      this.adapter &&
      (this.adapter.adapterInstanceId !== state.adapterInstanceId ||
        !sameTerminal(this.adapter, state) ||
        (this.adapter.latched && !state.latched))
    ) {
      this.fence();
      return false;
    }
    if (!this.target) {
      this.target = parseTerminalTarget({
        v: 1,
        runId: state.runId,
        runtimeId: state.runtimeId,
        sessionId: state.sessionId,
        terminalEpoch: state.terminalEpoch,
        profile: "web-terminal-v1",
        managedRestartEligible: false,
        inputState: this.owner,
      });
      this.lease = new TerminalLeaseState(this.target);
    }
    this.adapter = state;
    this.heartbeatAt = performance.now();
    return true;
  }

  private async poll() {
    if (this.polling || this.acquiring || this.remoteDisabled || this.stopped) return;
    this.polling = true;
    try {
      this.observe(await this.adapterCall("terminal-state"));
    } catch {
      if (this.adapter) this.fence();
    } finally {
      this.polling = false;
    }
  }

  private current() {
    const target = this.lease?.snapshot();
    return target && { ...target, inputState: this.remoteDisabled ? ("fenced" as const) : target.inputState };
  }

  private drop(peer: Peer) {
    if (peer.closed) return;
    peer.closed = true;
    // Synchronous invalidation precedes destruction and any async continuation.
    if (peer.binding) this.lease?.revoke(peer.binding);
    if (this.writer === peer) this.writer = undefined;
    peer.leaseId = undefined;
    peer.snapshot = undefined;
    clearTimeout(peer.timer);
    clearTimeout(peer.outputTimer);
    this.peers.delete(peer);
    peer.socket.destroy();
  }

  private send(peer: Peer, value: object): boolean {
    if (peer.closed || peer.socket.destroyed) return false;
    const data = encode(value);
    if (peer.socket.writableLength + data.length > PEER_BYTES) {
      this.drop(peer);
      return false;
    }
    const writable = peer.socket.write(data);
    if (!writable && !peer.outputTimer) peer.outputTimer = setTimeout(() => this.drop(peer), 2000);
    return writable;
  }

  private connect(socket: net.Socket) {
    if (this.peers.size >= 8 || this.stopped) {
      socket.destroy();
      return;
    }
    const peer: Peer = {
      socket,
      closed: false,
      lastId: 0,
      pending: false,
      chunk: 0,
      timer: setTimeout(() => this.drop(peer), 2000),
    };
    this.peers.add(peer);
    const parser = new JsonLines((value) => {
      if (peer.closed) return;
      try {
        if (!peer.target) {
          const first = firstFrame(value);
          const target = this.current();
          if (!target || this.remoteDisabled) {
            this.send(peer, { type: "error", error: "terminal_backend_unavailable" });
            socket.end();
            return;
          }
          if (first.op === "status") {
            if (first.runId !== target.runId) throw new Error();
            this.send(peer, { type: "ready", target });
            socket.end();
            return;
          }
          if (
            !sameTerminal(first.target, target) ||
            [...this.peers].filter((p) => p.target).length >= 2 ||
            [...this.peers].some((p) => p.binding?.connectionId === first.binding.connectionId)
          )
            throw new Error();
          peer.target = first.target;
          peer.binding = first.binding;
          peer.scope = first.scope;
          clearTimeout(peer.timer);
          this.send(peer, { type: "ready", target });
          this.dirty = true;
          this.publish();
        } else this.request(peer, value);
      } catch {
        this.drop(peer);
      }
    });
    socket.on("data", (data: Buffer) => {
      try {
        parser.push(data);
      } catch {
        this.drop(peer);
      }
    });
    socket.on("end", () => this.drop(peer));
    socket.on("close", () => this.drop(peer));
    socket.on("error", () => this.drop(peer));
    socket.on("drain", () => {
      clearTimeout(peer.outputTimer);
      peer.outputTimer = undefined;
      this.pump(peer);
    });
  }

  private live(peer: Peer): boolean {
    return (
      !this.stopped &&
      !this.remoteDisabled &&
      !peer.closed &&
      !peer.socket.destroyed &&
      !peer.socket.readableEnded &&
      !peer.socket.writableEnded &&
      this.peers.has(peer) &&
      peer.scope === "write" &&
      !!peer.target &&
      !!this.target &&
      sameTerminal(peer.target, this.target) &&
      !!this.adapter?.latched &&
      performance.now() - this.heartbeatAt <= 750
    );
  }

  private reply(peer: Peer, id: number, result: object) {
    this.send(peer, { type: "response", id, result });
  }

  private request(peer: Peer, value: Frame) {
    if (!peer.binding || !peer.target || !this.lease) throw new Error();
    const binding = peer.binding;
    const target = peer.target;
    const leaseState = this.lease;
    if (!Number.isSafeInteger(value.id) || Number(value.id) <= peer.lastId) throw new Error();
    const id = Number(value.id);
    peer.lastId = id;
    if (value.type === "release") {
      exact(value, "id,type");
      leaseState.revoke(binding);
      if (this.writer === peer) this.writer = undefined;
      peer.leaseId = undefined;
      // Cancels this connection's pending prepare without revoking another owner.
      peer.pending = false;
      this.reply(peer, id, { ok: true });
      return;
    }
    if (value.type === "acquire") {
      exact(value, "id,type");
      void this.acquire(peer, id);
      return;
    }
    if (value.type === "input") {
      exact(value, "data,id,leaseId,sequence,terminalEpoch,type,v");
      const { id: _id, ...input } = value;
      try {
        if (!this.live(peer) || this.writer !== peer) throw new Error();
        const data = Buffer.from(leaseState.consume(binding, target, input), "utf8");
        // No await, stream write, queue, or retry may enter this final admission→sink section.
        if (!this.live(peer) || this.writer !== peer || leaseState.snapshot().inputState !== "remote")
          throw new Error();
        try {
          const written = writeSync(this.master, data);
          if (written !== data.length) throw new Error();
        } catch {
          leaseState.revoke(binding);
          peer.leaseId = undefined;
          this.reply(peer, id, { ok: false, delivery: "unknown", error: "input_delivery_unknown" });
          return;
        }
        this.reply(peer, id, { ok: true, delivery: "written" });
      } catch {
        leaseState.revoke(binding);
        peer.leaseId = undefined;
        this.reply(peer, id, { ok: false, delivery: "rejected", error: "input_rejected" });
      }
      return;
    }
    if (value.type === "resize") {
      exact(value, "columns,id,leaseId,rows,type");
      if (
        !this.live(peer) ||
        this.writer !== peer ||
        !peer.leaseId ||
        value.leaseId !== peer.leaseId ||
        leaseState.snapshot().inputState !== "remote" ||
        !size(value.columns, value.rows) ||
        this.resize ||
        performance.now() - this.resizeAt < 100
      ) {
        this.reply(peer, id, { ok: false, error: "resize_rejected" });
        return;
      }
      this.resizeAt = performance.now();
      this.resize = {
        peer,
        id,
        generation: this.generation,
        columns: Number(value.columns),
        rows: Number(value.rows),
        timer: setTimeout(() => {
          if (this.resize) this.reply(this.resize.peer, this.resize.id, { ok: false, error: "resize_unknown" });
          this.resize = undefined;
        }, 500),
      };
      this.localFrame({ type: "resize", id, columns: value.columns, rows: value.rows });
      return;
    }
    throw new Error();
  }

  private async acquire(peer: Peer, id: number) {
    const state = this.lease?.snapshot().inputState;
    if (state === "local") {
      this.reply(peer, id, { ok: false, error: "local_owns_input" });
      return;
    }
    if (state !== "none" || peer.scope !== "write" || peer.pending || this.acquiring || this.remoteDisabled) {
      this.reply(peer, id, { ok: false, error: "control_unavailable" });
      return;
    }
    peer.pending = true;
    this.acquiring = true;
    const generation = this.generation;
    const instance = this.adapter?.adapterInstanceId;
    try {
      const prepared = await this.adapterCall("terminal-prepare");
      if (
        !peer.pending ||
        peer.closed ||
        generation !== this.generation ||
        prepared.adapterInstanceId !== instance ||
        !prepared.latched ||
        !this.observe(prepared)
      )
        throw new Error();
      const state = await this.adapterCall("terminal-state");
      if (
        !peer.pending ||
        peer.closed ||
        generation !== this.generation ||
        state.adapterInstanceId !== instance ||
        !state.latched ||
        !this.observe(state) ||
        !this.live(peer)
      )
        throw new Error();
      if (!this.lease || !peer.binding || !peer.target) throw new Error();
      const lease = this.lease.grant(peer.binding, peer.target);
      this.writer = peer;
      peer.leaseId = lease.leaseId;
      this.reply(peer, id, { ok: true, ...lease });
    } catch {
      if (!peer.closed) this.reply(peer, id, { ok: false, error: "control_unavailable" });
    } finally {
      peer.pending = false;
      this.acquiring = false;
    }
  }

  local(value: Frame) {
    if (value.type === "output") {
      exact(value, "data,type");
      const data = bytes(value.data, OUTPUT_BYTES);
      if (!this.parserFailed)
        void this.screen.write(data).then(
          () => {
            this.dirty = true;
          },
          () => this.screenFailure(),
        );
    } else if (value.type === "screen-failed") {
      exact(value, "type");
      this.screenFailure();
    } else if (value.type === "local-input") {
      exact(value, "data,type");
      const data = bytes(value.data, INPUT_BYTES);
      if ((this.lease ? this.lease.snapshot().inputState : this.owner) !== "local") return;
      try {
        if (writeSync(this.master, data) !== data.length) throw new Error();
      } catch {
        this.localFrame({ type: "local-input-unknown" });
      }
    } else if (value.type === "local-yield" || value.type === "local-reclaim") {
      exact(value, "type");
      const current = this.lease?.snapshot().inputState ?? this.owner;
      if (value.type === "local-yield") {
        if (current === "local") {
          this.generation++;
          this.lease?.yieldLocal();
          this.owner = "none";
        }
      } else {
        this.generation++;
        this.lease?.reclaimLocal();
        this.owner = "local";
        this.writer = undefined;
        for (const peer of this.peers) peer.leaseId = undefined;
      }
      this.localFrame({ type: "owner", owner: this.lease?.snapshot().inputState ?? this.owner });
    } else if (value.type === "local-resize") {
      exact(value, "columns,rows,type");
      if (size(value.columns, value.rows) && (this.lease?.snapshot().inputState ?? this.owner) === "local")
        this.localFrame({ type: "resize", id: 0, columns: value.columns, rows: value.rows });
    } else if (value.type === "resized") {
      exact(value, "columns,id,rows,type");
      if (!size(value.columns, value.rows)) throw new Error();
      if (!this.parserFailed)
        void this.screen.resize(Number(value.columns), Number(value.rows)).then(
          () => {
            this.dirty = true;
          },
          () => this.screenFailure(),
        );
      if (this.resize && value.id === this.resize.id) {
        const resize = this.resize;
        clearTimeout(resize.timer);
        this.resize = undefined;
        this.reply(resize.peer, resize.id, {
          ok:
            this.live(resize.peer) &&
            this.writer === resize.peer &&
            this.lease?.snapshot().inputState === "remote" &&
            resize.generation === this.generation,
        });
      }
    } else throw new Error();
  }

  private publish() {
    if (
      !this.dirty ||
      this.capturing ||
      this.parserFailed ||
      this.stopped ||
      ![...this.peers].some((p) => p.target && !p.snapshot)
    )
      return;
    this.dirty = false;
    this.capturing = true;
    void this.screen
      .capture()
      .then(
        (snapshot) => {
          for (const peer of this.peers) {
            if (!peer.target) continue;
            if (peer.snapshot) this.dirty = true;
            else if (peer.snapshotSequence !== snapshot.sequence) this.snapshot(peer, snapshot);
          }
        },
        () => this.screenFailure(),
      )
      .finally(() => {
        this.capturing = false;
      });
  }

  private snapshot(peer: Peer, snapshot: ScreenSnapshot) {
    if (peer.closed || this.remoteDisabled) return;
    peer.snapshot = Buffer.from(snapshot.data);
    peer.snapshotSequence = snapshot.sequence;
    peer.chunk = 0;
    this.send(peer, {
      type: "screen-start",
      target: this.current(),
      sequence: snapshot.sequence,
      columns: snapshot.columns,
      rows: snapshot.rows,
      bytes: peer.snapshot.length,
      chunks: Math.ceil(peer.snapshot.length / 20_480),
    });
    this.pump(peer);
  }

  private pump(peer: Peer) {
    while (!peer.closed && peer.snapshot && peer.socket.writableLength < 65_536) {
      const offset = peer.chunk * 20_480;
      if (offset >= peer.snapshot.length) {
        this.send(peer, {
          type: "screen-end",
          terminalEpoch: this.config.terminalEpoch,
          sequence: peer.snapshotSequence,
        });
        peer.snapshot = undefined;
        return;
      }
      const data = peer.snapshot.subarray(offset, offset + 20_480).toString("base64");
      const writable = this.send(peer, {
        type: "screen-chunk",
        terminalEpoch: this.config.terminalEpoch,
        sequence: peer.snapshotSequence,
        index: peer.chunk++,
        data,
      });
      if (!writable) return;
    }
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.fence();
    clearInterval(this.interval);
    if (this.resize) clearTimeout(this.resize.timer);
    for (const socket of this.pendingAdapters) socket.destroy();
    for (const peer of this.peers) this.drop(peer);
    this.screen.dispose();
    this.server.close();
    try {
      const file = path.join(this.config.directory, "terminal.sock");
      const stat = lstatSync(file);
      if (
        stat.isSocket() &&
        this.socketIdentity &&
        stat.ino === this.socketIdentity.ino &&
        stat.dev === this.socketIdentity.dev
      )
        unlinkSync(file);
    } catch {
      /* Never remove a successor's socket. */
    }
    this.relay.destroy();
  }
}

// Fixed image executable; only the supervisor supplies these inherited fd numbers.
function main() {
  if (process.argv.length !== 4) throw new Error();
  const [master, control] = process.argv.slice(2).map(Number);
  if (![master, control].every((fd) => Number.isInteger(fd) && fd >= 3) || master === control) throw new Error();
  const relay = new net.Socket({ fd: control, readable: true, writable: true });
  let broker: Broker | undefined;
  const timer = setTimeout(() => relay.destroy(), 2000);
  const parser = new JsonLines((value) => {
    if (!broker) {
      broker = new Broker(value as Startup, master, relay);
      clearTimeout(timer);
    } else broker.local(value);
  });
  relay.on("data", (data: Buffer) => {
    try {
      parser.push(data);
    } catch {
      broker?.close();
      relay.destroy();
    }
  });
  relay.on("error", () => {
    broker?.close();
    clearTimeout(timer);
  });
  relay.on("close", () => {
    broker?.close();
    clearTimeout(timer);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => {
      broker?.close();
      relay.destroy();
    });
}
try {
  main();
} catch {
  process.exitCode = 1;
}
