import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { validatedPublicUrl } from "../extensions/connection-config.ts";
import { type LifecycleConfig, lifecycleConfig } from "./lifecycle.ts";

export type HubConfig = {
  stateDir: string;
  runtimeDir: string;
  socketPath: string;
  host: "127.0.0.1" | "::1";
  port: number;
  leaseMs: number;
  publicUrl?: string;
  lifecycle?: LifecycleConfig;
  runtimeUpdates?: LifecycleConfig;
  management?: { port: number; publicUrl?: string; gateway?: { credentialFile: string } };
};
export type Grant = { run_id: string; token: string; label: string; backendHost: string; revoked?: boolean };

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  ) {
    throw new Error("Hub state directory must be private and owned by the current user");
  }
}

export function readPrivateJson(file: string) {
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.size > 8192 ||
    (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error("Invalid private hub file");
  return JSON.parse(readFileSync(file, "utf8"));
}

export function initializeHub(
  file: string,
  options: Partial<Pick<HubConfig, "port" | "publicUrl" | "leaseMs" | "management">> = {},
) {
  // The config parent may be an existing project; only hub state must be private.
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ port: 16180, ...options }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export function readHubConfig(file: string): HubConfig {
  const value = readPrivateJson(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hub configuration");
  const host = value.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1")
    throw new Error("Hub HTTP must bind to loopback; use a trusted TLS gateway");
  const port = value.port ?? 16180;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid hub port");
  const leaseMs = value.leaseMs ?? 45000;
  if (!Number.isInteger(leaseMs) || leaseMs < 500 || leaseMs > 300000) throw new Error("Invalid hub lease");
  const parent = path.dirname(path.resolve(file));
  if (
    value.stateDir !== undefined &&
    (typeof value.stateDir !== "string" || !value.stateDir || value.stateDir.includes("\0"))
  ) {
    throw new Error("Invalid hub state directory");
  }
  const stateDir = path.resolve(parent, value.stateDir ?? "state");
  if (
    value.runtimeDir !== undefined &&
    (typeof value.runtimeDir !== "string" || !value.runtimeDir || value.runtimeDir.includes("\0"))
  )
    throw new Error("Invalid hub runtime directory");
  const runtimeDir = path.resolve(parent, value.runtimeDir ?? "runtime");
  if (
    runtimeDir === stateDir ||
    runtimeDir.startsWith(`${stateDir}${path.sep}`) ||
    stateDir.startsWith(`${runtimeDir}${path.sep}`)
  )
    throw new Error("Hub IPC and administrator state must be separate directories");
  const publicUrl = value.publicUrl === undefined ? undefined : validatedPublicUrl(value.publicUrl);
  if (publicUrl && new URL(publicUrl).pathname !== "/") throw new Error("Hub public URL must use the domain root");
  // Unix sockets can be shared with ordinary containers. No host PID/Docker API required.
  if (process.platform === "win32")
    throw new Error("Bundled hub currently requires Unix IPC (Linux/macOS); standalone Pi Web still works");
  const lifecycle = value.lifecycle === undefined ? undefined : lifecycleConfig(value.lifecycle);
  const runtimeUpdates = value.runtimeUpdates === undefined ? undefined : lifecycleConfig(value.runtimeUpdates);
  const management = value.management === undefined ? undefined : managementConfig(value.management, port, publicUrl);
  return {
    stateDir,
    runtimeDir,
    socketPath: path.join(runtimeDir, "registry.sock"),
    host,
    port,
    leaseMs,
    publicUrl,
    ...(lifecycle ? { lifecycle } : {}),
    ...(runtimeUpdates ? { runtimeUpdates } : {}),
    ...(management ? { management } : {}),
  };
}

export function managementConfig(
  value: unknown,
  chatPort: number,
  chatPublicUrl?: string,
): NonNullable<HubConfig["management"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid management configuration");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((key) => !["port", "publicUrl", "gateway"].includes(key)) ||
    !Number.isInteger(v.port) ||
    Number(v.port) < 0 ||
    Number(v.port) > 65535 ||
    (v.port !== 0 && v.port === chatPort)
  )
    throw new Error("Management requires a distinct port");
  const publicUrl = v.publicUrl === undefined ? undefined : validatedPublicUrl(v.publicUrl);
  if (
    publicUrl &&
    (!chatPublicUrl ||
      new URL(publicUrl).pathname !== "/" ||
      new URL(publicUrl).origin === new URL(chatPublicUrl).origin)
  )
    throw new Error("Management requires a distinct canonical public origin");
  let gateway: { credentialFile: string } | undefined;
  if (v.gateway !== undefined) {
    const g = v.gateway as Record<string, unknown>;
    if (
      !g ||
      typeof g !== "object" ||
      Array.isArray(g) ||
      Object.keys(g).join(",") !== "credentialFile" ||
      typeof g.credentialFile !== "string" ||
      !path.isAbsolute(g.credentialFile) ||
      g.credentialFile.includes("\0") ||
      (publicUrl && !publicUrl.startsWith("https:"))
    )
      throw new Error("Invalid management gateway configuration");
    gateway = { credentialFile: g.credentialFile };
  }
  return { port: Number(v.port), ...(publicUrl ? { publicUrl } : {}), ...(gateway ? { gateway } : {}) };
}

function validHost(host: string) {
  return Boolean(isIP(host)) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host);
}
function hasControls(value: string) {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function readGrant(config: HubConfig, runId: string): Grant {
  if (!/^[0-9a-f]{32}$/.test(runId)) throw new Error("Invalid session capability");
  const grant = readPrivateJson(path.join(config.stateDir, "grants", `${runId}.json`));
  if (
    grant.run_id !== runId ||
    !/^[0-9a-f]{64}$/.test(grant.token) ||
    typeof grant.label !== "string" ||
    grant.label.length > 120 ||
    hasControls(grant.label) ||
    typeof grant.backendHost !== "string" ||
    !validHost(grant.backendHost)
  )
    throw new Error("Invalid session capability");
  return grant;
}

export function issueSession(config: HubConfig, output: string, options: { label: string; backendHost?: string }) {
  privateDirectory(config.stateDir);
  privateDirectory(path.join(config.stateDir, "grants"));
  const backendHost = options.backendHost ?? "127.0.0.1";
  if (!validHost(backendHost) || !options.label.trim() || options.label.length > 120 || hasControls(options.label))
    throw new Error("Invalid session label or backend host");
  const credential = { run_id: randomBytes(16).toString("hex"), token: randomBytes(32).toString("hex") };
  const grant = { ...credential, label: options.label, backendHost };
  // Never overwrite an existing credential/config. The private grant directory is admin-only.
  const resolvedOutput = path.resolve(output);
  if (resolvedOutput === config.socketPath || resolvedOutput.startsWith(`${config.stateDir}${path.sep}`)) {
    throw new Error("Session credential must be outside the administrator state directory");
  }
  writeFileSync(resolvedOutput, `${JSON.stringify(credential)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(config.stateDir, "grants", `${credential.run_id}.json`), `${JSON.stringify(grant)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return credential;
}

export function revokeSession(config: HubConfig, runId: string) {
  const grant = readGrant(config, runId);
  writeFileSync(
    path.join(config.stateDir, "grants", `${runId}.json`),
    `${JSON.stringify({ ...grant, revoked: true })}\n`,
    { mode: 0o600 },
  );
}
