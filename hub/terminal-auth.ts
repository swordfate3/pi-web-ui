import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { type HubConfig, readGrant, readPrivateJson } from "./config.ts";
import { type StateWriter, withStateWriter } from "./state-budget.ts";
import type { TerminalIdentity } from "./terminal-contract.ts";
import { parseTerminalTarget, sameTerminal } from "./terminal-contract.ts";

type TerminalScope = TerminalIdentity & { access: "read" | "write" };
type AuthState = {
  epoch: string;
  pairHash: string | null;
  expires: number;
  failures: number;
  scope: TerminalScope | null;
};
type Session = { epoch: string; expires: number; csrf: string; authorizationId: string; scope: TerminalScope };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const stateFile = (config: HubConfig) => path.join(config.stateDir, "terminal-auth.json");

export function parseTerminalScope(value: unknown): TerminalScope {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "access,runId,runtimeId,sessionId,terminalEpoch"
  )
    throw new Error("Invalid terminal scope");
  const v = value as Record<string, unknown>;
  if (v.access !== "read" && v.access !== "write") throw new Error("Invalid terminal scope");
  const target = parseTerminalTarget({
    v: 1,
    runId: v.runId,
    runtimeId: v.runtimeId,
    sessionId: v.sessionId,
    terminalEpoch: v.terminalEpoch,
    profile: "web-terminal-v1",
    inputState: "none",
    managedRestartEligible: false,
  });
  return {
    runId: target.runId,
    runtimeId: target.runtimeId,
    sessionId: target.sessionId,
    terminalEpoch: target.terminalEpoch,
    access: v.access,
  };
}

function readState(config: HubConfig): AuthState | undefined {
  if (!existsSync(stateFile(config))) return undefined;
  const v = readPrivateJson(stateFile(config));
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join(",") !== "epoch,expires,failures,pairHash,scope" ||
    !hex(v.epoch, 64) ||
    (v.pairHash !== null && !hex(v.pairHash, 64)) ||
    !Number.isSafeInteger(v.expires) ||
    v.expires < 0 ||
    !Number.isInteger(v.failures) ||
    v.failures < 0 ||
    v.failures > 10 ||
    (v.pairHash !== null && v.scope === null)
  )
    throw new Error("Terminal authorization unavailable");
  return { ...v, scope: v.scope === null ? null : parseTerminalScope(v.scope) };
}

function saveState(writer: StateWriter, value: AuthState, security = false) {
  writer.write("terminal-auth.json", value, { security });
}

/** Trusted CLI only. Scope names a child, but does not prove that it is live. */
export function issueTerminalCode(config: HubConfig, value: unknown, now = Date.now()) {
  if (!config.terminal) throw new Error("Terminal listener is disabled");
  const scope = parseTerminalScope(value);
  if (readGrant(config, scope.runId).revoked) throw new Error("Terminal run revoked");
  const code = randomBytes(16).toString("hex");
  return withStateWriter(config, (writer) => {
    if (readGrant(config, scope.runId).revoked) throw new Error("Terminal run revoked");
    const epoch = readState(config)?.epoch ?? randomBytes(32).toString("hex");
    const expiresAt = now + 600_000;
    saveState(writer, { epoch, pairHash: digest(code), expires: expiresAt, failures: 0, scope });
    return { code, expiresAt };
  });
}

export function revokeTerminal(config: HubConfig) {
  withStateWriter(config, (writer) => {
    saveState(
      writer,
      { epoch: randomBytes(32).toString("hex"), pairHash: null, expires: 0, failures: 0, scope: null },
      true,
    );
  });
}

/** Independent of management/chat auth. Caller MUST enforce terminal Host/Origin. */
export class HubTerminalAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly config: HubConfig;
  private readonly now: () => number;
  private readonly secure: boolean;
  private readonly cookieName: string;

  constructor(config: HubConfig, now: () => number = Date.now) {
    if (!config.terminal) throw new Error("Terminal listener is disabled");
    this.config = config;
    this.now = now;
    this.secure = !!config.terminal.publicUrl;
    this.cookieName = this.secure ? "__Host-pi-hub-terminal" : "pi_hub_terminal_local";
  }

  private session(request: IncomingMessage) {
    const values = (request.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item.startsWith(`${this.cookieName}=`));
    if (values.length !== 1) return undefined;
    const token = values[0].slice(this.cookieName.length + 1);
    if (!hex(token, 64)) return undefined;
    const key = digest(token);
    const session = this.sessions.get(key);
    if (!session) return undefined;
    try {
      const state = readState(this.config);
      if (
        session.expires <= this.now() ||
        !state ||
        session.epoch !== state.epoch ||
        readGrant(this.config, session.scope.runId).revoked
      )
        throw new Error();
    } catch {
      this.sessions.delete(key);
      return undefined;
    }
    return { key, ...session, scope: { ...session.scope } };
  }

  status(request: IncomingMessage) {
    const session = this.session(request);
    return session
      ? { authorized: true, csrf: session.csrf, expiresAt: session.expires, scope: session.scope }
      : { authorized: false };
  }

  authorize(request: IncomingMessage, requireCsrf = false, access: "read" | "write" = "read") {
    const session = this.session(request);
    const csrf = request.headers["x-pi-hub-terminal-csrf"];
    if (
      !session ||
      (access === "write" && session.scope.access !== "write") ||
      (requireCsrf && (!hex(csrf, 64) || !equal(csrf, session.csrf)))
    )
      throw new Error("Terminal authorization required");
    return session;
  }

  /** Target check is mandatory before any future provider/PTY operation. */
  authorizeTarget(
    request: IncomingMessage,
    expected: TerminalIdentity,
    requireCsrf = true,
    access: "read" | "write" = "read",
  ) {
    const session = this.authorize(request, requireCsrf, access);
    if (!sameTerminal(session.scope, expected)) throw new Error("Terminal target authorization required");
    return session;
  }

  revalidate(
    request: IncomingMessage,
    expected: ReturnType<HubTerminalAuth["authorize"]>,
    requireCsrf = false,
    access: "read" | "write" = "read",
  ) {
    const current = this.authorize(request, requireCsrf, access);
    if (current.key !== expected.key || current.epoch !== expected.epoch || current.expires !== expected.expires)
      throw new Error("Terminal authorization changed");
  }

  unlock(code: unknown) {
    return withStateWriter(this.config, (writer) => this.unlockLocked(writer, code));
  }

  private unlockLocked(writer: StateWriter, code: unknown) {
    const state = readState(this.config);
    if (!state?.scope || !state.pairHash || state.expires <= this.now() || state.failures >= 10)
      throw new Error("Terminal unlock rejected");
    if (!hex(code, 32) || !equal(digest(code), state.pairHash)) {
      saveState(writer, { ...state, failures: state.failures + 1 }, true);
      throw new Error("Terminal unlock rejected");
    }
    if (readGrant(this.config, state.scope.runId).revoked) throw new Error("Terminal unlock rejected");
    for (const [key, session] of this.sessions) {
      try {
        if (
          session.expires <= this.now() ||
          session.epoch !== state.epoch ||
          readGrant(this.config, session.scope.runId).revoked
        )
          this.sessions.delete(key);
      } catch {
        this.sessions.delete(key);
      }
    }
    if (this.sessions.size >= 64) throw new Error("Terminal unlock rejected");
    saveState(writer, { ...state, pairHash: null, expires: 0, scope: null });
    const token = randomBytes(32).toString("hex");
    const session: Session = {
      epoch: state.epoch,
      expires: this.now() + 1_800_000,
      csrf: randomBytes(32).toString("hex"),
      authorizationId: randomBytes(16).toString("hex"),
      scope: { ...state.scope },
    };
    this.sessions.set(digest(token), session);
    return { csrf: session.csrf, expiresAt: session.expires, cookie: this.cookie(token, 1800) };
  }

  logout(request: IncomingMessage) {
    return withStateWriter(this.config, () => {
      const session = this.authorize(request, true);
      this.sessions.delete(session.key);
      return this.cookie("", 0);
    });
  }

  close() {
    this.sessions.clear();
  }

  private cookie(token: string, maxAge: number) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
  }
}
