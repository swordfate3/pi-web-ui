import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

export type DownloadScope = { workspace: string; sessionId: string; epoch: number };
type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number };
type Capability = { scope: DownloadScope; relative: string; identity: FileIdentity; expiresAt: number };

const unavailable = () =>
  new Error("File unavailable for download. Use a regular, non-sensitive file in the current project.");

function privateName(segment: string) {
  return (
    segment.startsWith(".") ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|auth\.json|credentials(?:\.[^.]+)?|tokens?(?:\.[^.]+)?|secrets?(?:\.[^.]+)?)$/i.test(
      segment,
    ) ||
    /\.(?:pem|key|p12|pfx)$/i.test(segment)
  );
}

/** Open only ordinary project files; never serve the browser's arbitrary host path. */
function openProjectFile(workspace: string, requested: string) {
  if (
    typeof requested !== "string" ||
    !requested ||
    requested.length > 4096 ||
    Array.from(requested).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    requested.includes("\\") ||
    requested.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(requested)
  )
    throw unavailable();
  if (requested.split("/").includes("..")) throw unavailable();
  const lexicalRoot = path.resolve(workspace);
  const relative = path.relative(lexicalRoot, path.resolve(lexicalRoot, requested));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw unavailable();
  const segments = relative.split(path.sep);
  if (segments.some(privateName)) throw unavailable();
  const root = fs.realpathSync(lexicalRoot);
  if (root === path.parse(root).root) throw unavailable();
  let target = root;
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw unavailable();
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    const current = fs.statSync(target);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      fs.realpathSync(target) !== target
    )
      throw unavailable();
    // Inspect the opened descriptor too: swapping a parent symlink cannot make
    // a Linux container serve a different file between validation and open.
    if (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${fd}`) !== target) throw unavailable();
    return {
      fd,
      relative,
      filename: path.basename(target),
      identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    };
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    throw unavailable();
  }
}

/** Short-lived, bounded, per-runtime capabilities. No file bytes enter WebSocket. */
export class WorkspaceDownloads {
  private readonly capabilities = new Map<string, Capability>();
  private readonly now: () => number;
  constructor(now = Date.now) {
    this.now = now;
  }

  prepare(scope: DownloadScope, requested: string) {
    try {
      const opened = openProjectFile(scope.workspace, requested);
      fs.closeSync(opened.fd);
      for (const [token, capability] of this.capabilities)
        if (capability.expiresAt <= this.now()) this.capabilities.delete(token);
      while (this.capabilities.size >= 64) {
        const oldest = this.capabilities.keys().next().value;
        if (oldest) this.capabilities.delete(oldest);
      }
      const token = randomUUID();
      this.capabilities.set(token, {
        scope: { ...scope },
        relative: opened.relative,
        identity: opened.identity,
        expiresAt: this.now() + 120_000,
      });
      return { token, filename: opened.filename, size: opened.identity.size, downloadUrl: `/api/downloads/${token}` };
    } catch {
      throw unavailable();
    }
  }

  open(token: string, scope: DownloadScope) {
    const capability = this.capabilities.get(token);
    if (
      !capability ||
      capability.expiresAt <= this.now() ||
      capability.scope.sessionId !== scope.sessionId ||
      capability.scope.epoch !== scope.epoch ||
      capability.scope.workspace !== scope.workspace
    )
      throw unavailable();
    const opened = openProjectFile(scope.workspace, capability.relative);
    if (
      Object.entries(capability.identity).some(([key, value]) => opened.identity[key as keyof FileIdentity] !== value)
    ) {
      fs.closeSync(opened.fd);
      this.capabilities.delete(token);
      throw unavailable();
    }
    return { fd: opened.fd, filename: opened.filename, size: opened.identity.size };
  }

  clear() {
    this.capabilities.clear();
  }
}

export function attachmentDisposition(filename: string) {
  const extension = path
    .extname(filename)
    .replace(/[^a-z0-9.]/gi, "")
    .slice(0, 16);
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download${extension}"; filename*=UTF-8''${encoded}`;
}
