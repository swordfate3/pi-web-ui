import { randomBytes } from "node:crypto";
import type { TerminalBinding, TerminalIdentity, TerminalTarget } from "./terminal-contract.ts";
import { parseTerminalInput, parseTerminalTarget, sameTerminal, validTerminalBinding } from "./terminal-contract.ts";

type RemoteLease = TerminalBinding & { id: string; expiresAt: number; sequence: number };
const LEASE_MS = 30_000;

/**
 * Dormant, synchronous single-writer model; NOT an authorization service or PTY.
 * Only trusted local code may call local handoff/grant/freeze. Before grant the
 * future host must verify permission, current target and the adapter barrier.
 * Every input still needs live authorization and sink-side checks. consume()
 * consumes a sequence, NOT execution: never retry returned bytes on uncertainty.
 */
export class TerminalLeaseState {
  private readonly target: TerminalTarget;
  private owner: TerminalTarget["inputState"];
  private remote: RemoteLease | null = null;
  private lastTime = -Infinity;
  private readonly now: () => number;

  constructor(target: unknown, now: () => number = () => performance.now()) {
    this.now = now;
    this.target = parseTerminalTarget(target);
    // A new local model cannot inherit a remote writer from advertised metadata.
    if (this.target.inputState !== "local" && this.target.inputState !== "none")
      throw new Error("Terminal writer must start local or unowned");
    this.owner = this.target.inputState;
  }

  private tick(): number {
    const time = this.now();
    if (!Number.isFinite(time) || time < this.lastTime) {
      this.freeze();
      throw new Error("Terminal clock unavailable");
    }
    this.lastTime = time;
    if (this.remote && time >= this.remote.expiresAt) this.dropRemote();
    return time;
  }

  private dropRemote() {
    this.remote = null;
    if (this.owner === "remote") this.owner = "none";
  }

  private matches(binding: TerminalBinding): boolean {
    return (
      validTerminalBinding(binding) &&
      this.remote?.authorizationId === binding.authorizationId &&
      this.remote.connectionId === binding.connectionId
    );
  }

  snapshot(): TerminalTarget {
    this.tick();
    return { ...this.target, inputState: this.owner };
  }

  // Called by a trusted local relay control gesture, not by a browser field.
  yieldLocal() {
    this.tick();
    if (this.owner !== "local") throw new Error("Local terminal does not own input");
    this.owner = "none";
  }

  reclaimLocal() {
    this.tick();
    if (this.owner === "fenced") throw new Error("Terminal is fenced");
    this.dropRemote();
    this.owner = "local";
  }

  grant(binding: TerminalBinding, expected: TerminalIdentity) {
    const time = this.tick();
    if (this.owner !== "none" || !validTerminalBinding(binding) || !sameTerminal(this.target, expected))
      throw new Error("Terminal control rejected");
    const lease = {
      authorizationId: binding.authorizationId,
      connectionId: binding.connectionId,
      id: randomBytes(16).toString("hex"),
      expiresAt: time + LEASE_MS,
      sequence: 0,
    };
    this.remote = lease;
    this.owner = "remote";
    return { leaseId: lease.id, expiresInMs: LEASE_MS };
  }

  /** Pure admission result, not an ACK, permission proof or completed PTY write. */
  consume(binding: TerminalBinding, expected: TerminalIdentity, value: unknown): string {
    this.tick();
    // An unrelated/stale socket must not be able to revoke the current writer.
    if (!this.matches(binding)) throw new Error("Terminal input rejected");
    try {
      const input = parseTerminalInput(value);
      const lease = this.remote;
      if (
        !lease ||
        this.owner !== "remote" ||
        !sameTerminal(this.target, expected) ||
        input.terminalEpoch !== this.target.terminalEpoch ||
        input.leaseId !== lease.id ||
        input.sequence !== lease.sequence + 1
      )
        throw new Error("Terminal input rejected");
      lease.sequence = input.sequence;
      return input.data;
    } catch {
      this.dropRemote();
      // Do not include bytes, tokens or validation details in errors/logs.
      throw new Error("Terminal input rejected");
    }
  }

  // Disconnect/logout/permission revocation must call this before awaiting I/O.
  revoke(binding: TerminalBinding) {
    this.tick();
    if (this.matches(binding)) this.dropRemote();
  }

  // Identity change, shutdown, restart preparation or adapter loss: terminal.
  // A successor target requires a NEW instance and explicit trusted re-attach.
  freeze() {
    this.remote = null;
    this.owner = "fenced";
  }
}
