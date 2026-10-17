import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { type HubConfig, privateDirectory, readPrivateJson } from "./config.ts";

type ManagementState = { epoch: string; pairHash: string | null; expires: number; failures: number };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const stateFile = (config: HubConfig) => path.join(config.stateDir, "management.json");

function readState(config: HubConfig): ManagementState | undefined {
  const file = stateFile(config);
  if (!existsSync(file)) return undefined;
  const value = readPrivateJson(file);
  if (
    !hex(value.epoch, 64) ||
    (value.pairHash !== null && !hex(value.pairHash, 64)) ||
    !Number.isSafeInteger(value.expires) ||
    !Number.isInteger(value.failures) ||
    value.failures < 0 ||
    value.failures > 10
  )
    throw new Error("Management state unavailable");
  return value;
}

function saveState(config: HubConfig, value: ManagementState) {
  privateDirectory(config.stateDir);
  const temporary = path.join(config.stateDir, `.management-${randomBytes(12).toString("hex")}`);
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, stateFile(config));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Trusted CLI only: return a short-lived code to its administrator's terminal. */
export function issueManagementCode(config: HubConfig, now = Date.now()) {
  const code = randomBytes(16).toString("hex");
  const epoch = readState(config)?.epoch ?? randomBytes(32).toString("hex");
  const expires = now + 600_000;
  saveState(config, { epoch, pairHash: digest(code), expires, failures: 0 });
  return { code, expiresAt: expires };
}

export function revokeManagement(config: HubConfig) {
  saveState(config, { epoch: randomBytes(32).toString("hex"), pairHash: null, expires: 0, failures: 0 });
}

/** Additional management privilege, deliberately separate from gateway/list access. */
export class HubManagement {
  private readonly sessions = new Map<string, { epoch: string; expires: number; csrf: string }>();
  private readonly config: HubConfig;
  private readonly now: () => number;
  private readonly secure: boolean;
  private readonly cookieName: string;

  constructor(config: HubConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
    this.secure = config.management?.publicUrl?.startsWith("https:") ?? false;
    this.cookieName = this.secure ? "__Host-pi-hub-management" : "pi_hub_management_local";
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
    let state: ManagementState | undefined;
    try {
      state = readState(this.config);
    } catch {
      return undefined;
    }
    if (!session || session.expires <= this.now() || !state || session.epoch !== state.epoch) {
      this.sessions.delete(key);
      return undefined;
    }
    return { key, ...session };
  }

  status(request: IncomingMessage) {
    const session = this.session(request);
    return session ? { authorized: true, csrf: session.csrf, expiresAt: session.expires } : { authorized: false };
  }

  authorize(request: IncomingMessage, write = false) {
    const session = this.session(request);
    const csrf = request.headers["x-pi-hub-csrf"];
    if (!session || (write && (typeof csrf !== "string" || !hex(csrf, 64) || !equal(csrf, session.csrf))))
      throw new Error("Management authorization required");
    return session;
  }

  revalidate(request: IncomingMessage, expected: ReturnType<HubManagement["authorize"]>, write = false) {
    const current = this.authorize(request, write);
    if (
      current.key !== expected.key ||
      current.epoch !== expected.epoch ||
      current.csrf !== expected.csrf ||
      current.expires !== expected.expires
    )
      throw new Error("Management authorization changed");
  }

  unlock(code: unknown) {
    const state = readState(this.config);
    if (!state || !state.pairHash || state.expires <= this.now() || state.failures >= 10)
      throw new Error("Management unlock rejected");
    if (!hex(code, 32) || !equal(digest(code), state.pairHash)) {
      saveState(this.config, { ...state, failures: state.failures + 1 });
      throw new Error("Management unlock rejected");
    }
    saveState(this.config, { ...state, pairHash: null, expires: 0 });
    for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 64) throw new Error("Management unlock rejected");
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    const expires = this.now() + 1_800_000;
    this.sessions.set(digest(token), { epoch: state.epoch, expires, csrf });
    return { csrf, expiresAt: expires, cookie: this.cookie(token, 1800) };
  }

  logout(request: IncomingMessage) {
    const session = this.authorize(request, true);
    this.sessions.delete(session.key);
    return this.cookie("", 0);
  }

  private cookie(token: string, maxAge: number) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
  }
}
