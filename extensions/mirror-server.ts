/**
 * pi-web-ui Mirror Server Extension
 *
 * Starts a WebSocket + HTTP server inside the running Pi process,
 * allowing a browser to connect and mirror the TUI session in real-time.
 *
 * - Forwards all Pi events to connected browser clients
 * - Accepts commands from the browser and executes them via the extension API
 * - Serves static files for the pi-web-ui frontend
 * - Sends full state snapshot on client connect (messages, model, etc.)
 */

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { WebSocket, WebSocketServer } from "ws";
import { type ConnectionSettings, localWebUrl, resolveConnectionConfig } from "./connection-config.ts";
import { listenWithFallback } from "./connection-listener.ts";
import { attachmentDisposition, WorkspaceDownloads } from "./file-downloads.ts";
import { projectLiveEvent } from "./live-transport.ts";
import { matchesRevisionDispatch, resolveMessageRevision, revisionContent } from "./message-revision.ts";
import { resolveMessageVersions } from "./message-versions.ts";
import { startRuntimeControl, taintRuntimeInput } from "./runtime-control.ts";
import {
  guardHistoryFrame,
  historyRange,
  readEntryDetail,
  selectSavedSessions,
  selectSessionHistory,
  serializeHistoryEnvelope,
} from "./session-history.ts";
import { createSessionRegistration, guardSessionRequest, type SessionRegistration } from "./session-registration.ts";
import { getSessionUsageStatistics } from "./session-usage.ts";
import { captureSoftwareMetadata } from "./software-metadata.ts";
import { serveWorkspaceUpload, WorkspaceUploads } from "./workspace-uploads.ts";

type BrowserImage = {
  data?: string;
  mimeType?: string;
};

type WsRequest = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type WsResponse = {
  type: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type TextContentBlock = {
  type: "text";
  text: string;
};

type ImageContentBlock = {
  type: "image";
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
};

type SessionEntry = {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  name?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    isError?: boolean;
  };
};

type BrowserTreeNode = {
  entry: SessionEntry & { id: string };
  parentNodeId: string | null;
  label?: string;
  labelTimestamp?: string;
};

type FileListItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number | null;
  mtime: number;
};

type GitStatusResult = {
  isRepo: boolean;
  branch: string | null;
  hasChanges: boolean;
  additions: number;
  deletions: number;
  untracked: number;
};

type GitDiffResult = {
  isRepo: boolean;
  branch: string | null;
  diff: string;
};

type FileContentResult = {
  path: string;
  name: string;
  size: number;
  content: string;
};

type ModelCandidate = {
  provider?: string;
  id?: string;
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type BrowserThinkingLevel = (typeof THINKING_LEVELS)[number];

function isThinkingLevel(value: unknown): value is BrowserThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function getAvailableThinkingLevels(ctx: ExtensionContext | null): BrowserThinkingLevel[] {
  const model = ctx?.model;
  if (!model) return [...THINKING_LEVELS];
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

type ExtensionAPIWithEvents = ExtensionAPI & {
  events?: {
    on?: (eventType: string, listener: (payload: unknown) => void) => void;
    emit?: (eventType: string, payload: unknown) => void;
  };
};

type AliveWebSocket = WebSocket & {
  isAlive?: boolean;
};

type WritableSocket = Pick<WebSocket, "readyState" | "send">;

const AGENT_DIR = path.resolve(
  (process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi/agent")).replace(/^~(?=$|\/)/, homedir()),
);

// Load pi-web-ui settings from the Pi agent directory (falls back to env vars)
function loadSettings() {
  let settings: ConnectionSettings = {};
  try {
    const settingsPath = path.join(AGENT_DIR, "settings.json");
    settings =
      (
        JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
          "pi-web-ui"?: ConnectionSettings;
        }
      )["pi-web-ui"] || {};
  } catch {}
  try {
    return { ...resolveConnectionConfig(settings), error: undefined };
  } catch {
    // Invalid bind configuration must not crash other extensions or silently expose a server.
    return { ...resolveConnectionConfig({}, {}), autoStart: false, error: "Invalid Pi Web connection settings" };
  }
}

const SETTINGS = loadSettings();
const PORT = SETTINGS.port;
const HOST = SETTINGS.host;
const AUTO_START = SETTINGS.autoStart;
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const ARTIFACT_TOOL_NAMES = new Set(["edit", "write"]);
const MARKDOWN_EXTENSIONS = [".md", ".mdx", ".markdown"];
// @ts-expect-error — __dirname is provided by jiti at runtime
const STATIC_DIR = process.env.PI_WEB_UI_STATIC_DIR || findStaticDir();
const MAX_BROWSER_SERIALIZATION_DEPTH = 256;

function toBrowserJsonValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (depth >= MAX_BROWSER_SERIALIZATION_DEPTH) return "[Truncated]";

  const objectValue = value as object;
  if (seen.has(objectValue)) return "[Circular]";
  seen.add(objectValue);
  try {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      return value.map((item) => toBrowserJsonValue(item, depth + 1, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      try {
        output[key] = toBrowserJsonValue(child, depth + 1, seen);
      } catch {
        output[key] = "[Unserializable]";
      }
    }
    return output;
  } finally {
    seen.delete(objectValue);
  }
}

function toBrowserSessionEntry(entry: SessionEntry): SessionEntry {
  // Keep persisted entry metadata intact; only message/tool payloads need the
  // bounded serializer. Do not silently replace custom entry data or topology.
  return entry.message === undefined
    ? entry
    : { ...entry, message: toBrowserJsonValue(entry.message) as SessionEntry["message"] };
}

function stringifyForBrowser(data: unknown): string {
  if (data && typeof data === "object") {
    const envelope = data as Record<string, unknown>;
    const field = envelope.type === "event" && envelope.event === "state_sync" ? "payload" : "result";
    const payload = envelope[field];
    if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).treeNodes)) {
      const { treeNodes, entries, ...rest } = payload as {
        treeNodes: BrowserTreeNode[];
        entries?: SessionEntry[];
      };
      // Sanitize other fields, but never run the generic depth limiter over
      // treeNodes or entry metadata. Flat topology has constant JSON depth.
      const safeEnvelope = toBrowserJsonValue({ ...envelope, [field]: rest }) as Record<string, unknown>;
      safeEnvelope[field] = {
        ...(safeEnvelope[field] as Record<string, unknown>),
        ...(entries === undefined ? {} : { entries: entries.map(toBrowserSessionEntry) }),
        treeNodes: treeNodes.map((node) => ({ ...node, entry: toBrowserSessionEntry(node.entry) })),
      };
      return JSON.stringify(safeEnvelope);
    }
  }
  return JSON.stringify(toBrowserJsonValue(data)) ?? "null";
}

function findStaticDir(): string {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (dir: string) => {
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  // 1) Bundled React build output, then legacy public fallback.
  addCandidate(path.resolve(__dirname, "dist"));
  addCandidate(path.resolve(__dirname, "../dist"));
  addCandidate(path.resolve(__dirname, "public"));
  addCandidate(path.resolve(__dirname, "../public"));

  // 2) Installed package path (for npm-installed extension execution)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkgPath = require.resolve("@kkkiio/pi-web-ui/package.json");
    const pkgDir = path.dirname(pkgPath);
    addCandidate(path.join(pkgDir, "dist"));
    addCandidate(path.join(pkgDir, "public"));
  } catch {}

  // 3) Development fallback from current working directory
  addCandidate(path.resolve(process.cwd(), "dist"));
  addCandidate(path.resolve(process.cwd(), "public"));
  addCandidate(path.resolve(process.cwd(), "node_modules/@kkkiio/pi-web-ui/dist"));
  addCandidate(path.resolve(process.cwd(), "node_modules/@kkkiio/pi-web-ui/public"));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }

  return path.resolve(process.cwd(), "dist");
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export default function (pi: ExtensionAPI) {
  // Snapshot package/build metadata once for this extension runtime. This is
  // descriptive only: renewals never inspect disk or imply running updated code.
  const softwareMetadata = captureSoftwareMetadata(VERSION);
  let server: http.Server | null = null;
  let listenController: AbortController | null = null;
  let registration: SessionRegistration | null = null;

  async function renameSession(name: string): Promise<string | null> {
    pi.setSessionName(name);
    // Read before yielding: a session replacement can invalidate Pi's old runtime.
    // A failed read/Hub refresh must not turn a successful Pi rename into an error.
    let currentName: string | null = name;
    try {
      currentName = pi.getSessionName() ?? null;
    } catch {}
    await registration?.refresh(); // Shared, bounded ACK wait; renewal remains the fallback.
    return currentName;
  }
  let wss: WebSocketServer | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const clients = new Set<WebSocket>();

  // Store latest context reference for use in command handlers
  let latestCtx: ExtensionContext | null = null;
  let archExtensionPresent = false;
  let advancedFeaturesEnabled = false;
  let latestExecuteCtx: ExtensionCommandContext | null = null;
  const liveArtifactPaths = new Set<string>();
  let sessionReplacementPending = false;
  let revisionAttempt: { cancelled: boolean } | null = null;
  let revisionTreeVersion = 0;
  // One one-shot preview per live socket; no permanent branch fence or receipt history.
  let revisionPreviews = new WeakMap<
    WritableSocket,
    {
      previewId: string;
      epoch: number;
      entryId: unknown;
      mode: unknown;
      sourceLeafId: string | null;
    }
  >();
  let revisionDispatch: {
    treeVersion: number;
    epoch: number;
    sessionId: string;
    runtimeId: string;
    parentId: string | null;
    content: ReturnType<typeof revisionContent>;
  } | null = null;
  let revisionDispatchTimer: NodeJS.Timeout | null = null;
  let revisionDispatchUnknown = false;
  // Keep pre-existing async browser mutations ineligible to race revision navigation.
  let activeBrowserMutations = 0;
  let activeHttpMutations = 0;
  let runtimeControl: Awaited<ReturnType<typeof startRuntimeControl>>;
  let runtimeStopping = false;
  // Protocol: replacement acknowledgements mean accepted, never completed.
  // Resume completes on state_sync.sessionId === targetSessionId; reload keeps
  // that ID and completes only on a different state_sync.runtimeId. Both clear
  // advancedFeatures and require /webui again. Never replay either on reconnect.
  const runtimeId = randomUUID();
  let lifecycleEpoch = 0;
  let runtimeActive = false;
  let exportGeneration = 0;
  let dispatchTimer: NodeJS.Timeout | null = null;
  let pendingSessionCommand: string | null = null;
  let pendingDispatchId: string | null = null;
  let pendingResume: Readonly<SavedSelection> | null = null;
  const CAPABILITY_TTL_MS = 10 * 60 * 1000;
  const MAX_SAVED_SELECTIONS = 1024;
  const MAX_RETAINED_EXPORTS = 8;
  const internalCommands = new Set(["webui-new-session", "webui-fork-session", "webui-resume-session", "webui-reload"]);
  type SavedSelection = {
    path: string;
    targetSessionId: string;
    sessionId: string;
    cwd: string;
    sessionDir: string;
    epoch: number;
    expiresAt: number;
  };
  // Capabilities are bounded and expire on TTL/lifecycle, not another browser's
  // listing. Paths never come from the browser; downloads serve only owned HTML.
  const savedSelections = new Map<string, Readonly<SavedSelection>>();
  const exports = new Map<string, { path: string; directory: string; filename: string; expiresAt: number }>();
  const fileDownloads = new WorkspaceDownloads();
  const workspaceUploads = new WorkspaceUploads();
  let activeExport: { controller: AbortController; done: Promise<unknown> } | null = null;

  const runtimeMetadata = () =>
    runtimeControl && latestCtx && runtimeActive
      ? {
          runtimeId,
          sessionId: latestCtx.sessionManager.getSessionId(),
          leafId: latestCtx.sessionManager.getLeafId(),
          version: VERSION,
          managed: true as const,
        }
      : undefined;

  pi.on("input", (_event, ctx) => {
    latestCtx = ctx;
    if (runtimeStopping || runtimeControl?.prepared) {
      ctx.ui.notify("Pi is preparing to restart. Nothing was sent; wait for reconnection.", "warning");
      return { action: "handled" };
    }
    return { action: "continue" };
  });
  pi.on("user_bash", (_event, ctx) => {
    latestCtx = ctx;
    taintRuntimeInput();
  });
  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "session_before_compact",
  ] as const) {
    pi.on(event, (_event, ctx) => {
      latestCtx = ctx;
      if (runtimeStopping || runtimeControl?.prepared) return { cancel: true };
    });
  }

  function clearSessionAction() {
    if (revisionDispatchTimer) clearTimeout(revisionDispatchTimer);
    revisionDispatchTimer = null;
    if (dispatchTimer) clearTimeout(dispatchTimer);
    dispatchTimer = null;
    sessionReplacementPending = false;
    pendingSessionCommand = null;
    pendingDispatchId = null;
    pendingResume = null;
  }

  function pruneSavedSelections() {
    const now = Date.now();
    for (const [id, selection] of savedSelections) {
      if (selection.expiresAt <= now || !scopeIsCurrent(selection)) savedSelections.delete(id);
    }
  }

  function removeExport(token: string) {
    const exported = exports.get(token);
    if (!exported) return;
    exports.delete(token);
    try {
      fs.rmSync(exported.directory, { recursive: true, force: true });
    } catch {}
  }

  function pruneExports() {
    const now = Date.now();
    for (const [token, exported] of exports) {
      if (exported.expiresAt <= now) removeExport(token);
    }
  }

  function sessionScope(ctx: ExtensionContext) {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: path.resolve(ctx.cwd),
      sessionDir: path.resolve(ctx.sessionManager.getSessionDir()),
      epoch: lifecycleEpoch,
    };
  }

  function scopeIsCurrent(scope: ReturnType<typeof sessionScope>) {
    return (
      runtimeActive &&
      !!latestCtx &&
      scope.epoch === lifecycleEpoch &&
      scope.sessionId === latestCtx.sessionManager.getSessionId() &&
      scope.cwd === path.resolve(latestCtx.cwd) &&
      scope.sessionDir === path.resolve(latestCtx.sessionManager.getSessionDir())
    );
  }

  function allowedSessionPath(filePath: string, sessionDir: string) {
    // Direct regular files only: no symlinks or paths outside the configured store.
    try {
      const resolved = path.resolve(filePath);
      return (
        path.dirname(resolved) === sessionDir &&
        path.extname(resolved) === ".jsonl" &&
        fs.lstatSync(resolved).isFile() &&
        path.dirname(fs.realpathSync(resolved)) === fs.realpathSync(sessionDir)
      );
    } catch {
      return false;
    }
  }

  async function listSavedSessions(params: Record<string, unknown> = {}) {
    if (!latestCtx) throw new Error("No context available");
    if (sessionReplacementPending) throw new Error("A session action is already in progress");
    checkHistoryIdentity(params);
    const range = historyRange(params);
    const scope = sessionScope(latestCtx);
    // Pass the actual public manager's sessionDir, including CLI --session-dir.
    // Never use listAll: custom stores can contain multiple projects.
    const sessions = await SessionManager.list(scope.cwd, scope.sessionDir);
    if (!scopeIsCurrent(scope) || sessionReplacementPending)
      throw new Error("Session changed. Reopen the session picker.");
    pruneSavedSelections();
    const filtered = selectSavedSessions(
      sessions.filter(
        (session) =>
          session.cwd && path.resolve(session.cwd) === scope.cwd && allowedSessionPath(session.path, scope.sessionDir),
      ),
      range,
      100,
    );
    return {
      sessionId: scope.sessionId,
      runtimeId,
      cwd: scope.cwd,
      ...range,
      total: filtered.total,
      truncated: filtered.truncated,
      sessions: filtered.sessions.map((session) => {
        const existing = [...savedSelections].find(
          ([, selection]) => selection.path === session.path && selection.targetSessionId === session.id,
        );
        const id = existing?.[0] ?? randomUUID();
        if (!existing && savedSelections.size >= MAX_SAVED_SELECTIONS) {
          const oldest = savedSelections.keys().next().value;
          if (oldest) savedSelections.delete(oldest);
        }
        savedSelections.set(
          id,
          Object.freeze({
            ...scope,
            path: session.path,
            targetSessionId: session.id,
            expiresAt: Date.now() + CAPABILITY_TTL_MS,
          }),
        );
        return {
          id,
          sessionId: session.id,
          name: session.name?.slice(0, 160) ?? null,
          created: session.created.toISOString(),
          modified: session.modified.toISOString(),
          messageCount: session.messageCount,
          firstMessage: session.firstMessage.slice(0, 240),
          isCurrent: session.id === scope.sessionId,
        };
      }),
    };
  }

  function requireSessionAction(action: string, advanced = true) {
    if (sessionReplacementPending) throw new Error("A session action is already in progress");
    if (!latestCtx) throw new Error("No context available");
    if (advanced && (!advancedFeaturesEnabled || !latestExecuteCtx))
      throw new Error(`Run /webui first to enable ${action}`);
    if (!latestCtx.isIdle() || latestCtx.hasPendingMessages())
      throw new Error("Wait for the current Pi turn and queued messages to finish");
  }

  function acceptSessionAction(command: string) {
    sessionReplacementPending = true;
    const [invocation, ...args] = command.trim().split(/\s+/);
    pendingSessionCommand = invocation.slice(1);
    pendingDispatchId = randomUUID();
    const dispatchId = pendingDispatchId;
    const epoch = lifecycleEpoch;
    // sendUserMessage is void. Pi reports asynchronous dispatch failures as RPC
    // extension_error, NOT a public pi.on event. Bound the pre-handler lock even
    // when dispatch fails before a command context can be supplied.
    dispatchTimer = setTimeout(() => {
      if (runtimeActive && lifecycleEpoch === epoch && pendingDispatchId === dispatchId && sessionReplacementPending)
        reportSessionCommandError("Pi could not dispatch the session action. Try again.");
    }, 10_000);
    dispatchTimer.unref();
    try {
      // Fence a delayed dispatch too: an expired command cannot execute under
      // the lock of a later request for the same operation.
      pi.sendUserMessage(`${invocation} ${dispatchId} ${args.join(" ")}`.trimEnd(), { expandPromptTemplates: true });
    } catch {
      clearSessionAction();
      throw new Error("Pi could not dispatch the session action. Try again.");
    }
  }

  function requestResume(id: unknown, sessionId: unknown) {
    requireSessionAction("session resume commands");
    pruneSavedSelections();
    const selection = typeof id === "string" ? savedSelections.get(id) : undefined;
    if (!selection || sessionId !== selection.sessionId || !scopeIsCurrent(selection)) {
      throw new Error("Session selection expired. Reopen the session picker.");
    }
    if (selection.targetSessionId === selection.sessionId) throw new Error("That session is already active");
    // Pin plain immutable data before dispatch; eviction/re-listing cannot change
    // the target while Pi is preparing the command handler.
    pendingResume = Object.freeze({ ...selection });
    acceptSessionAction(`/webui-resume-session ${id}`);
    return {
      action: "resume",
      accepted: true,
      sessionId: selection.sessionId,
      targetSessionId: selection.targetSessionId,
    };
  }

  function requestReload(sessionId?: unknown) {
    requireSessionAction("runtime reload");
    if (!latestCtx) throw new Error("No context available");
    const currentSessionId = latestCtx.sessionManager.getSessionId();
    if (sessionId !== undefined && sessionId !== currentSessionId)
      throw new Error("Session changed. Try reload again.");
    const result = { action: "reload", accepted: true, sessionId: currentSessionId, runtimeId };
    acceptSessionAction("/webui-reload");
    return result;
  }

  function buildSessionDetails(ctx: ExtensionContext) {
    const entries = ctx.sessionManager.getEntries();
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let totalMessages = 0;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const costs = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const addUsage = (
      usage:
        | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: Partial<typeof costs> }
        | undefined,
    ) => {
      if (!usage) return;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) tokens[key] += usage[key] ?? 0;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
        costs[key] += usage.cost?.[key] ?? 0;
    };
    for (const entry of entries) {
      if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")
        addUsage(entry.usage);
      if (entry.type !== "message") continue;
      totalMessages++;
      const message = entry.message;
      if (message.role === "user") userMessages++;
      if (message.role === "assistant") {
        assistantMessages++;
        toolCalls += message.content.filter((block) => block.type === "toolCall").length;
        addUsage(message.usage);
      }
      if (message.role === "toolResult") {
        toolResults++;
        addUsage(message.usage);
      }
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return {
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionName: pi.getSessionName() ?? null,
      cwd: ctx.cwd,
      sessionDir: ctx.sessionManager.getSessionDir(),
      header: ctx.sessionManager.getHeader(),
      leafId: ctx.sessionManager.getLeafId(),
      entryCount: entries.length,
      branchEntryCount: ctx.sessionManager.getBranch().length,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages,
      tokens,
      cost: costs.total,
      costs,
      contextUsage: ctx.getContextUsage() ?? null,
      model: ctx.model ?? null,
      thinkingLevel: pi.getThinkingLevel(),
      isStreaming: !ctx.isIdle(),
      hasPendingMessages: ctx.hasPendingMessages(),
      // Public effective settings, not a private AgentSession/settings manager.
      autoCompactionEnabled: pi.getSettings().compaction?.enabled !== false,
      runtimeId,
      statisticsScope: "all_entries",
    };
  }

  function exportCli(): { file: string; args: string[] } {
    // An explicit host configuration may select a CLI executable or JS entry.
    // Never fall back to an arbitrary `pi` on PATH (or copy credential CLI args).
    const configured = process.env.PI_WEB_UI_PI_BIN || process.env.PI_E2E_BIN;
    if (configured) {
      if (!path.isAbsolute(configured) && !configured.includes(path.sep))
        throw new Error("HTML export requires an explicit Pi CLI path");
      try {
        const entry = fs.realpathSync(path.resolve(configured));
        if (!fs.statSync(entry).isFile()) throw new Error("Not a CLI file");
        return /\.[cm]?js$/.test(entry) ? { file: process.execPath, args: [entry] } : { file: entry, args: [] };
      } catch {
        throw new Error("Configured Pi CLI is unavailable for HTML export");
      }
    }
    // Node retains the invoked CLI in argv[1], including symlink invocations.
    // Verify it against its owning Pi package's public bin metadata, rather than
    // require.resolve (which could select a different installed SDK/CLI version).
    try {
      const entry = fs.realpathSync(process.argv[1]);
      let directory = path.dirname(entry);
      for (;;) {
        const manifestPath = path.join(directory, "package.json");
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
            name?: string;
            bin?: string | Record<string, string>;
          };
          const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
          if (
            ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(manifest.name ?? "") &&
            bins.some((bin) => fs.realpathSync(path.resolve(directory, bin)) === entry)
          )
            return { file: process.execPath, args: [entry] };
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch {}
    throw new Error("Cannot locate the current Pi CLI. Set PI_WEB_UI_PI_BIN to an explicit CLI path.");
  }

  function exportHtml(ctx: ExtensionContext, outputPath?: unknown) {
    if (outputPath !== undefined) throw new Error("Browser exports do not accept host output paths");
    if (!runtimeActive || !server) throw new Error("Pi Web UI is not running");
    if (sessionReplacementPending) throw new Error("A session action is already in progress");
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for Pi to become idle before exporting");
    if (activeExport) throw new Error("An HTML export is already in progress");
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || !fs.existsSync(sessionFile)) throw new Error("No saved session file to export");
    const scope = sessionScope(ctx);
    const generation = exportGeneration;
    const cli = exportCli();
    const controller = new AbortController();
    // Everything from ctx is copied synchronously. No captured ctx is accessed
    // after the child awaits, including validation and failure/shutdown cleanup.
    const done = generateExport(sessionFile, scope, generation, cli, controller);
    const job = { controller, done };
    activeExport = job;
    void done
      .finally(() => {
        if (activeExport === job) activeExport = null;
      })
      .catch(() => {});
    return done;
  }

  async function generateExport(
    sessionFile: string,
    scope: ReturnType<typeof sessionScope>,
    generation: number,
    cli: ReturnType<typeof exportCli>,
    controller: AbortController,
  ) {
    let directory: string | undefined;
    let retained = false;
    try {
      directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pi-web-ui-export-")));
      const input = path.join(directory, "input.jsonl");
      // CLI export may auto-migrate legacy JSONL. Only its private copy is opened.
      fs.copyFileSync(sessionFile, input, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(input, 0o600);
      const filename = `session-${randomUUID()}.html`;
      const output = path.join(directory, filename);
      await new Promise<void>((resolve, reject) => {
        let failed = false;
        const child = execFile(
          cli.file,
          [...cli.args, "--export", input, output],
          {
            cwd: scope.cwd,
            timeout: 30_000,
            killSignal: "SIGKILL",
            signal: controller.signal,
            maxBuffer: 64 * 1024,
            encoding: "utf8",
          },
          (err) => {
            // Never propagate execFile's error.message/stdout/stderr/argv: any of
            // them can contain transcript contents or host credentials.
            failed = !!err;
          },
        );
        child.once("error", () => {
          failed = true;
        });
        // Abort's callback may fire before the child exits. Wait for close before
        // removing its directory or releasing the single-export concurrency slot.
        child.once("close", (code, signal) => {
          if (failed || code !== 0 || signal) reject(new Error("HTML export failed or timed out"));
          else resolve();
        });
        child.stdin?.end();
      });
      // Shutdown/stop can overlap the await. Fence before accessing fresh context
      // or committing a token; a completed old job can never repopulate the map.
      if (
        !runtimeActive ||
        generation !== exportGeneration ||
        scope.epoch !== lifecycleEpoch ||
        sessionReplacementPending
      )
        throw new Error("HTML export cancelled because the Pi runtime changed");
      if (!fs.lstatSync(output).isFile() || fs.realpathSync(output) !== output)
        throw new Error("HTML export was not generated");
      fs.chmodSync(output, 0o600);
      fs.rmSync(input, { force: true });
      pruneExports();
      while (exports.size >= MAX_RETAINED_EXPORTS) {
        const oldest = exports.keys().next().value;
        if (oldest) removeExport(oldest);
      }
      const token = randomUUID();
      exports.set(token, { path: output, directory, filename, expiresAt: Date.now() + CAPABILITY_TTL_MS });
      retained = true;
      return { token, filename, downloadUrl: `/api/exports/${token}` };
    } catch {
      throw new Error("HTML export failed, timed out, or was cancelled. Try again while Pi is idle.");
    } finally {
      if (directory && !retained) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function serializeFrame(data: unknown) {
    const projected = projectLiveEvent(data);
    const history = serializeHistoryEnvelope(projected);
    if (history !== null) return history;
    return guardHistoryFrame(stringifyForBrowser(projected), projected, {
      sessionId: latestCtx?.sessionManager.getSessionId(),
      runtimeId,
    });
  }

  function sendTo(ws: WritableSocket, data: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(serializeFrame(data));
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: unknown) {
    let json: string | undefined;
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        // No open clients means no serialization; otherwise serialize only once.
        json ??= serializeFrame(data);
        client.send(json);
      }
    }
  }

  let mirrorUrl = "";
  let mirrorStatusBase = "";

  function updateMirrorStatus() {
    if (!mirrorStatusBase) {
      latestCtx?.ui.setStatus("webui", "");
      return;
    }
    const clientCount = clients.size;
    const clientText = clientCount > 0 ? ` • ${clientCount} web ${clientCount === 1 ? "client" : "clients"}` : "";
    latestCtx?.ui.setStatus("webui", `${mirrorStatusBase}${clientText}`);
  }

  // ═══════════════════════════════════════
  // Helper: stop the server
  // ═══════════════════════════════════════
  async function stopServer() {
    // Fence synchronously, before any server-close or child-process await.
    listenController?.abort();
    listenController = null;
    const closingRegistration = registration;
    registration = null;
    const unregistered = closingRegistration?.stop();
    exportGeneration++;
    const closingExport = activeExport;
    closingExport?.controller.abort();
    for (const token of exports.keys()) removeExport(token);
    fileDownloads.clear();
    workspaceUploads.clear();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (wss) {
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      try {
        wss.close();
      } catch {}
      wss = null;
    }
    const closingServer = server;
    server = null;
    mirrorUrl = "";
    mirrorStatusBase = "";
    if (closingServer) {
      // Finish releasing the listening port before Pi creates the new runtime.
      await new Promise<void>((resolve) => {
        closingServer.close(() => resolve());
        closingServer.closeAllConnections();
      });
    }
    if (closingExport) await closingExport.done.catch(() => {});
    await unregistered;
  }

  // ═══════════════════════════════════════
  // /webui-stop and /webui-start commands
  // ═══════════════════════════════════════
  pi.registerCommand("webui-stop", {
    description: "Stop the pi-web-ui server",
    handler: async (_args, ctx) => {
      if (!server) {
        ctx.ui.notify("pi-web-ui is not running", "warning");
        return;
      }
      latestCtx = ctx;
      await stopServer();
      latestCtx?.ui.setStatus("webui", "");
      latestCtx?.ui.notify("pi-web-ui server stopped", "info");
    },
  });

  pi.registerCommand("webui-start", {
    description: "Start the pi-web-ui server",
    handler: async (_args, ctx) => {
      if (server) {
        ctx.ui.notify(`pi-web-ui is already running at ${mirrorUrl}`, "warning");
        return;
      }
      latestCtx = ctx;
      startServer();
      ctx.ui.notify("pi-web-ui server starting...", "info");
    },
  });

  // ═══════════════════════════════════════
  // /webui command — open Pi Web UI in browser
  // ═══════════════════════════════════════
  pi.registerCommand("webui-setup", {
    description: "Open local remote-access and login-management setup (no server changes)",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      const address = server?.address();
      if (!address || typeof address === "string") {
        ctx.ui.notify("Start Pi Web with /webui-start first", "warning");
        return;
      }
      const url = `${localWebUrl(HOST, address.port)}#remote-access`;
      const command =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
      const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
      execFile(command, args, (error) => {
        if (error)
          latestCtx?.ui.notify("Open the local setup URL shown in Pi; Docker may need a host browser", "warning");
      });
      ctx.ui.notify(`Pi Web setup (local, no server changes): ${url}`, "info");
    },
  });

  pi.registerCommand("webui", {
    description: "Open Pi Web UI in browser",
    handler: async (_args, ctx) => {
      latestCtx = ctx;
      if (!mirrorUrl) {
        ctx.ui.notify("pi-web-ui server not running yet", "warning");
        return;
      }
      const command =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
      const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", mirrorUrl] : [mirrorUrl];
      // No shell interpolation; configured public URLs are untrusted input.
      execFile(command, args, (error) => {
        if (error)
          latestCtx?.ui.notify(
            "Could not open a browser automatically; use the Pi Web URL shown in the status",
            "warning",
          );
      });
      ctx.ui.notify(`pi-web-ui: ${mirrorUrl}`, "info");
      advancedFeaturesEnabled = true;
      // Capture full ExtensionCommandContext for session-control methods (navigateTree, fork, etc.).
      // Cleared on session_start/session_shutdown; user must re-run /webui after session replacement.
      latestExecuteCtx = ctx;
      broadcast({ type: "event", event: "webui_state", payload: { advancedFeatures: true } });
    },
  });

  function reportSessionCommandError(message: string) {
    clearSessionAction();
    if (runtimeActive) broadcast({ type: "event", event: "webui_command_error", payload: { message } });
  }

  function registerSessionCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
    pi.registerCommand(name, {
      ...command,
      handler: async (args, commandCtx) => {
        const [dispatchId, ...commandArgs] = args.trim().split(/\s+/);
        if (
          !runtimeActive ||
          pendingSessionCommand !== name ||
          pendingDispatchId !== dispatchId ||
          !sessionReplacementPending
        )
          return;
        if (dispatchTimer) clearTimeout(dispatchTimer);
        dispatchTimer = null;
        const epoch = lifecycleEpoch;
        try {
          await command.handler(commandArgs.join(" "), commandCtx);
        } catch {
          // Includes errors from the initial idle/stale-context checks, which Pi
          // would otherwise report only via extension_error on the RPC transport.
          if (runtimeActive && epoch === lifecycleEpoch && pendingDispatchId === dispatchId)
            reportSessionCommandError("Pi could not complete the session action. Try again.");
        } finally {
          // Success replaces/disposes this runtime. Do not consult commandCtx/pi.
          if (
            runtimeActive &&
            epoch === lifecycleEpoch &&
            pendingDispatchId === dispatchId &&
            sessionReplacementPending
          )
            reportSessionCommandError("Pi did not replace the session. Try again.");
        }
      },
    });
  }

  // Browser-triggered session replacement runs through a command context supplied
  // by Pi, so no long-lived command context is retained between WebSocket requests.
  registerSessionCommand("webui-new-session", {
    description: "Internal Pi Web UI new-session action",
    handler: async (_args, commandCtx) => {
      if (!sessionReplacementPending || !commandCtx.isIdle() || commandCtx.hasPendingMessages()) {
        reportSessionCommandError("Request a new session from Web UI while Pi is idle.");
        return;
      }
      try {
        const result = await commandCtx.newSession();
        if (result.cancelled) {
          reportSessionCommandError("Starting a new session was cancelled.");
        }
      } catch (commandError) {
        reportSessionCommandError(commandError instanceof Error ? commandError.message : String(commandError));
      }
    },
  });

  // Session-fork actions use command contexts, never the event context held by a
  // WebSocket callback. Pi invalidates both contexts during session replacement.
  registerSessionCommand("webui-fork-session", {
    description: "Internal Pi Web UI fork action",
    handler: async (args, commandCtx) => {
      const match = args.match(/^(fork)(?:\s+(\S+))?$|^(clone)$/);
      if (!match) {
        reportSessionCommandError("Invalid session fork request.");
        return;
      }
      if (!sessionReplacementPending || !commandCtx.isIdle() || commandCtx.hasPendingMessages()) {
        reportSessionCommandError("Request a fork from Web UI while Pi is idle.");
        return;
      }
      if (!advancedFeaturesEnabled) {
        reportSessionCommandError("Run /webui first to enable session fork commands.");
        return;
      }
      try {
        const action = match[1] ? "fork" : "clone";
        const requestedEntryId = match[2];
        const entryId = action === "clone" ? commandCtx.sessionManager.getLeafId() : requestedEntryId;
        if (!entryId) {
          reportSessionCommandError(
            action === "clone" ? "Nothing to clone yet." : "Select a user message to fork from.",
          );
          return;
        }
        const result = await commandCtx.fork(entryId, action === "clone" ? { position: "at" } : undefined);
        // On success the old runtime and sockets are gone. The browser waits for
        // the replacement session's state_sync; never use commandCtx here.
        if (result.cancelled) {
          reportSessionCommandError(`${action === "clone" ? "Cloning" : "Forking"} the session was cancelled.`);
        }
      } catch (commandError) {
        reportSessionCommandError(commandError instanceof Error ? commandError.message : String(commandError));
      }
    },
  });

  registerSessionCommand("webui-resume-session", {
    description: "Internal Pi Web UI resume action",
    handler: async (id, commandCtx) => {
      const selection = pendingResume;
      // The map remains only a picker cache; the accepted target is pinned.
      if (!id.trim()) {
        reportSessionCommandError("Invalid session resume request.");
        return;
      }
      if (
        !sessionReplacementPending ||
        !selection ||
        !scopeIsCurrent(selection) ||
        !advancedFeaturesEnabled ||
        !commandCtx.isIdle() ||
        commandCtx.hasPendingMessages()
      ) {
        reportSessionCommandError("Session selection expired or Pi is busy. Reopen the session picker.");
        return;
      }
      try {
        // Re-list through the public API at execution time: a selection is not
        // authority to switch to a file that has since moved or changed project.
        const sessions = await SessionManager.list(selection.cwd, selection.sessionDir);
        if (!scopeIsCurrent(selection)) throw new Error("Session changed. Reopen the session picker.");
        // The asynchronous disk scan can overlap terminal input or another client.
        if (!commandCtx.isIdle() || commandCtx.hasPendingMessages())
          throw new Error("Wait for the current Pi turn and queued messages to finish");
        const target = sessions.find(
          (session) =>
            session.path === selection.path &&
            session.id === selection.targetSessionId &&
            session.cwd &&
            path.resolve(session.cwd) === selection.cwd,
        );
        if (!target || !allowedSessionPath(target.path, selection.sessionDir))
          throw new Error("Saved session is no longer available");
        // Parsing is read-only (SessionManager.open can migrate/rewrite a file).
        // Recheck the pinned path after listing; validate only the bounded first JSONL line.
        if (!allowedSessionPath(target.path, selection.sessionDir))
          throw new Error("Saved session is no longer available");
        const fd = fs.openSync(target.path, "r");
        let headerLine = "";
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
          headerLine = buffer.subarray(0, newline < 0 ? bytesRead : newline).toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
        let header: SessionEntry | undefined;
        try {
          header = JSON.parse(headerLine) as SessionEntry;
        } catch {
          throw new Error("Saved session project changed");
        }
        if (
          header?.type !== "session" ||
          header.id !== selection.targetSessionId ||
          !header.cwd ||
          path.resolve(header.cwd) !== selection.cwd
        )
          throw new Error("Saved session project changed");
        const result = await commandCtx.switchSession(target.path);
        if (result.cancelled) reportSessionCommandError("Resuming the session was cancelled.");
        // Success is confirmed by the new runtime's state_sync, not this ctx.
      } catch (err) {
        reportSessionCommandError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  registerSessionCommand("webui-reload", {
    description: "Internal Pi Web UI reload action",
    handler: async (_args, commandCtx) => {
      if (
        !sessionReplacementPending ||
        !advancedFeaturesEnabled ||
        !commandCtx.isIdle() ||
        commandCtx.hasPendingMessages()
      ) {
        reportSessionCommandError("Run /webui first and wait for Pi to be idle before reloading.");
        return;
      }
      try {
        await commandCtx.reload();
        // The command ctx, pi, sockets and maps now belong to the old runtime.
        // Do not access them: reconnect/state_sync with a new runtimeId completes reload.
      } catch (err) {
        reportSessionCommandError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all Pi events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "auto_compaction_start",
    "auto_compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "model_select",
    "thinking_level_select",
    "session_info_changed",
  ] as const;

  for (const eventType of eventTypes) {
    pi.on(eventType as Parameters<ExtensionAPI["on"]>[0], async (event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      const eventPayload = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};

      if (eventType === "tool_execution_end" && eventPayload.isError !== true) {
        let workspaceDir = path.resolve(process.cwd());
        try {
          const entries = ctx.sessionManager.getEntries() as SessionEntry[];
          const sessionEntry = entries.find((entry) => entry.type === "session");
          if (typeof sessionEntry?.cwd === "string" && sessionEntry.cwd) workspaceDir = path.resolve(sessionEntry.cwd);
        } catch {}

        const toolName = typeof eventPayload.toolName === "string" ? eventPayload.toolName.toLowerCase() : "";
        const args =
          eventPayload.args && typeof eventPayload.args === "object" && !Array.isArray(eventPayload.args)
            ? (eventPayload.args as Record<string, unknown>)
            : {};
        const rawPath = ["path", "filePath", "filepath", "file_path", "file", "target", "filename"]
          .map((key) => args[key])
          .find((value): value is string => typeof value === "string" && value.trim().length > 0);
        const normalizedPath = rawPath
          ?.trim()
          .replace(/^file:\/\//, "")
          .replace(/\\/g, "/");
        const lowerPath = normalizedPath?.toLowerCase() || "";
        if (
          ARTIFACT_TOOL_NAMES.has(toolName) &&
          MARKDOWN_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))
        ) {
          liveArtifactPaths.add(
            path.isAbsolute(normalizedPath || "")
              ? path.resolve(normalizedPath || "")
              : path.resolve(workspaceDir, normalizedPath || ""),
          );
        }
      }

      broadcast({
        type: "event",
        event: eventType,
        payload: eventPayload,
      });
    });
  }

  pi.on("session_tree", async (event: unknown, ctx: ExtensionContext) => {
    latestCtx = ctx;
    revisionTreeVersion++;
    const payload = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
    broadcast({ type: "event", event: "session_tree", payload });
  });

  // Forward arch-mode state changes from other extensions to browser clients
  (pi as ExtensionAPIWithEvents).events?.on?.("arch:state-changed", (payload: unknown) => {
    broadcast({
      type: "event",
      event: "arch:state-changed",
      payload: typeof payload === "object" && payload !== null ? payload : {},
    });
  });

  // Listen for arch-mode extension presence announcement
  (pi as ExtensionAPIWithEvents).events?.on?.("arch:ready", () => {
    archExtensionPresent = true;
    broadcast({ type: "event", event: "webui_state", payload: { archAvailable: true } });
  });

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    runtimeActive = true;
    runtimeStopping = false;
    if (!runtimeControl) {
      try {
        runtimeControl = await startRuntimeControl(process.env, () => {
          const current = latestCtx;
          if (!current || !runtimeActive) return null;
          return {
            run_id: process.env.PI_RUNTIME_RUN_ID ?? "",
            runtime_id: runtimeId,
            session_id: current.sessionManager.getSessionId(),
            leaf_id: current.sessionManager.getLeafId(),
            session_file: current.sessionManager.getSessionFile() ?? null,
            cwd: current.cwd,
            version: VERSION,
            idle: current.isIdle(),
            pending: current.hasPendingMessages(),
            busy: !!(
              sessionReplacementPending ||
              revisionAttempt ||
              revisionDispatchUnknown ||
              activeExport ||
              activeBrowserMutations ||
              activeHttpMutations
            ),
            provider: current.model?.provider ?? null,
            model: current.model?.id ?? null,
            thinking: pi.getThinkingLevel(),
          };
        });
      } catch {
        latestCtx?.ui.notify("Managed Pi restart is unavailable; check the private runtime configuration.", "warning");
      }
    }
    lifecycleEpoch++;
    revisionAttempt = null;
    revisionPreviews = new WeakMap();
    revisionDispatch = null;
    revisionDispatchUnknown = false;
    savedSelections.clear();
    fileDownloads.clear();
    workspaceUploads.clear();
    advancedFeaturesEnabled = false;
    latestExecuteCtx = null;
    clearSessionAction();
    broadcast({ type: "event", event: "state_sync", payload: buildStateSnapshot(ctx).payload });
    liveArtifactPaths.clear();
    broadcast({ type: "event", event: "webui_state", payload: { advancedFeatures: false } });
    turnCount = 0;
    titleSet = false;
    userMessages = [];
  });

  pi.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Pi's void sendUserMessage API does not expose runner.onError. Confirm the
  // exact path-bearing user message, not input/agent_start or normal void return.
  pi.on("message_start", (event, ctx) => {
    latestCtx = ctx;
    if (event.message.role !== "user") return;
    // Pi 1.1 has no dispatch ID on message_start (input.source is not propagated).
    // Persistence occurs at message_end. SDK system patches may already have
    // advanced the leaf; only that bounded parent chain can confirm this start.
    // A navigation away and back still invalidates confirmation.
    if (
      revisionDispatch &&
      runtimeActive &&
      revisionDispatch.epoch === lifecycleEpoch &&
      revisionDispatch.sessionId === latestCtx.sessionManager.getSessionId() &&
      revisionDispatch.runtimeId === runtimeId &&
      revisionDispatch.treeVersion === revisionTreeVersion &&
      matchesRevisionDispatch(revisionDispatch, latestCtx.sessionManager.getLeafId(), event.message.content, (id) =>
        latestCtx?.sessionManager.getEntry(id),
      )
    ) {
      revisionDispatch = null;
      revisionDispatchUnknown = false;
      if (revisionDispatchTimer) clearTimeout(revisionDispatchTimer);
      revisionDispatchTimer = null;
      if (!revisionAttempt) sessionReplacementPending = false;
    }
    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    workspaceUploads.accept(sessionScope(ctx), text);
  });

  // Capture user messages for title generation via message_start
  pi.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find(
        (b): b is TextContentBlock =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      );
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    const sessionName = pi.getSessionName();
    if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
      titleSet = true;
      return;
    }

    // Generate title from collected messages
    const title = generateSessionTitle(userMessages);
    if (title) {
      pi.setSessionName(title);
      titleSet = true;
      // Broadcast to connected clients
      broadcast({
        type: "event",
        event: "session_name",
        payload: { name: title },
      });
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find((m) => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, "")
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = `${title.substring(0, spaceIdx > 20 ? spaceIdx : 57)}…`;
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  function checkHistoryIdentity(params: Record<string, unknown>, required = false) {
    if (!latestCtx || !runtimeActive) throw new Error("No context available");
    if (sessionReplacementPending) throw new Error("A session action is already in progress");
    if ((required || params.sessionId !== undefined) && params.sessionId !== latestCtx.sessionManager.getSessionId())
      throw new Error("Session changed. Request history again.");
    if (params.runtimeId !== undefined && params.runtimeId !== runtimeId)
      throw new Error("Pi runtime changed. Request history again.");
    return latestCtx;
  }

  function buildStateSnapshot(ctx: ExtensionContext, params: Record<string, unknown> = {}) {
    // Get session entries for message history
    const page = selectSessionHistory(ctx.sessionManager.getBranch(), ctx.sessionManager.getTree(), {
      ...historyRange(params),
      ...(params.before === undefined ? {} : { before: params.before as string }),
    });
    const leafId = ctx.sessionManager.getLeafId();

    // Get model info
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    const sessionName = pi.getSessionName();
    const sessionFile = ctx.sessionManager.getSessionFile();

    // Context usage
    const contextUsage = ctx.getContextUsage();

    return {
      type: "event",
      event: "state_sync",
      payload: {
        ...page,
        leafId,
        model,
        thinkingLevel,
        availableThinkingLevels: getAvailableThinkingLevels(ctx),
        sessionName,
        sessionFile,
        sessionId: ctx.sessionManager.getSessionId(),
        runtimeId,
        isStreaming: !ctx.isIdle(),
        contextUsage,
      },
    };
  }

  function requireRevisionIdentity(params: Record<string, unknown>) {
    if (!runtimeActive || !latestCtx) throw new Error("No context available");
    if (params.sessionId !== latestCtx.sessionManager.getSessionId() || params.runtimeId !== runtimeId)
      throw new Error("Session or Pi runtime changed. Reopen the message revision.");
  }

  function getMessageRevision(ws: WritableSocket, params: Record<string, unknown>) {
    requireRevisionIdentity(params);
    requireSessionAction("message revision");
    if (!latestCtx) throw new Error("No context available");
    const original = resolveMessageRevision(
      (id) => latestCtx?.sessionManager.getEntry(id),
      params.entryId,
      params.mode,
    );
    const preview = {
      previewId: randomUUID(),
      epoch: lifecycleEpoch,
      entryId: params.entryId,
      mode: params.mode,
      sourceLeafId: latestCtx.sessionManager.getLeafId(),
    };
    revisionPreviews.set(ws, preview);
    return {
      previewId: preview.previewId,
      entryId: original.entryId,
      userEntryId: original.userEntryId,
      text: original.text,
      hasImages: original.hasImages,
      sourceLeafId: latestCtx.sessionManager.getLeafId(),
      sessionId: params.sessionId,
      runtimeId,
    };
  }

  async function submitMessageRevision(ws: WritableSocket, params: Record<string, unknown>) {
    const preview = revisionPreviews.get(ws);
    if (!preview || typeof params.previewId !== "string" || preview.previewId !== params.previewId)
      throw new Error("Message revision preview expired or was consumed. Reopen the message revision.");
    // Consume before validation/navigation: a failed or uncertain operation is never replayable.
    revisionPreviews.delete(ws);
    if (
      preview.epoch !== lifecycleEpoch ||
      preview.entryId !== params.entryId ||
      preview.mode !== params.mode ||
      preview.sourceLeafId !== params.sourceLeafId
    )
      throw new Error("Message revision preview changed. Reopen the message revision.");
    requireRevisionIdentity(params);
    requireSessionAction("message revision");
    if (activeBrowserMutations > 1)
      throw new Error("Another browser mutation is still in progress. Reopen the message revision.");
    if (!latestCtx || !latestExecuteCtx) throw new Error("No command context available");
    const sourceLeafId = latestCtx.sessionManager.getLeafId();
    if (params.sourceLeafId !== sourceLeafId)
      throw new Error("Session leaf changed. Reopen the message revision; nothing was sent.");
    const original = resolveMessageRevision(
      (id) => latestCtx?.sessionManager.getEntry(id),
      params.entryId,
      params.mode,
    );
    const content = revisionContent(original, params.mode, params.text);
    if (sourceLeafId === original.userEntryId)
      throw new Error(
        "Pi cannot revise a user message at the current leaf. Wait for a saved response or choose another branch.",
      );
    const epoch = lifecycleEpoch;
    const treeVersion = revisionTreeVersion;
    const attempt = { cancelled: false };
    revisionAttempt = attempt;
    sessionReplacementPending = true;
    let navigated = false;
    let navigationReturned = false;
    try {
      // Capture only plain source data. Never reuse command/event ctx after this await.
      const result = await latestExecuteCtx.navigateTree(original.userEntryId, { summarize: false });
      navigationReturned = true;
      if (result.cancelled) return { cancelled: true };
      navigated = revisionTreeVersion !== treeVersion;
      requireRevisionIdentity(params);
      if (epoch !== lifecycleEpoch || revisionAttempt !== attempt || !latestCtx)
        throw new Error("Session lifecycle changed");
      if (attempt.cancelled) throw new Error("Revision cancelled");
      // A fresh session_tree context is mandatory. This also catches Pi's target==leaf no-op.
      if (revisionTreeVersion !== treeVersion + 1 || latestCtx.sessionManager.getLeafId() !== original.parentId)
        throw new Error("Navigation did not reach the original question's parent");
      if (!latestCtx.isIdle() || latestCtx.hasPendingMessages()) throw new Error("Pi became busy during navigation");
      // Set before the void API call, including synchronous throw/unknown delivery outcomes.
      revisionDispatch = {
        parentId: original.parentId,
        content,
        treeVersion: revisionTreeVersion,
        epoch,
        sessionId: latestCtx.sessionManager.getSessionId(),
        runtimeId,
      };
      revisionDispatchUnknown = true;
      // Hold the shared mutation lock through asynchronous void dispatch. Timeout is
      // unknown, not cancellation/acceptance. Only an exact correlated user start
      // or session lifecycle reset can release unknown, even after this timeout.
      // Transforms/image normalization may prevent confirmation: inspect Pi and
      // replace/reload the session from the terminal; tree navigation is not recovery.
      revisionDispatchTimer = setTimeout(() => {
        revisionDispatchTimer = null;
        if (epoch === lifecycleEpoch && !revisionAttempt) sessionReplacementPending = false;
      }, 8_000);
      revisionDispatchTimer.unref();
      pi.sendUserMessage(content, { expandPromptTemplates: false });
      return { dispatched: true, sessionId: params.sessionId, runtimeId, userEntryId: original.userEntryId };
    } catch {
      if (revisionDispatchTimer && epoch === lifecycleEpoch) {
        clearTimeout(revisionDispatchTimer);
        revisionDispatchTimer = null;
      }
      if (navigated || revisionTreeVersion !== treeVersion)
        throw new Error(
          "The branch has switched, but message dispatch failed or is unknown. Check the session; do not automatically retry.",
        );
      if (!navigationReturned)
        throw new Error(
          "Message revision navigation failed or its outcome is unknown. Check the session; do not automatically retry.",
        );
      throw new Error("Message revision was not dispatched. Check the session; do not automatically retry.");
    } finally {
      // An old completion must never unlock a newer session action.
      if (epoch === lifecycleEpoch && revisionAttempt === attempt) {
        revisionAttempt = null;
        sessionReplacementPending = revisionDispatchTimer !== null;
        // A successful switch remains visible even when sending fails. No optimistic message.
        try {
          if (runtimeActive && latestCtx) broadcast(buildStateSnapshot(latestCtx));
        } catch {
          // session_tree already forwarded; the browser can explicitly resync.
        }
      }
    }
  }

  function requireVersionScope(params: Record<string, unknown>) {
    requireRevisionIdentity(params);
    if (
      (params.sourceLeafId !== null && typeof params.sourceLeafId !== "string") ||
      params.sourceLeafId !== latestCtx?.sessionManager.getLeafId()
    )
      throw new Error("Session leaf changed. Request message versions again.");
  }

  function getMessageVersions(params: Record<string, unknown>) {
    requireVersionScope(params);
    if (!latestCtx) throw new Error("No context available");
    return {
      sessionId: params.sessionId,
      runtimeId,
      sourceLeafId: params.sourceLeafId,
      ...resolveMessageVersions(
        latestCtx.sessionManager.getEntries(),
        params.entryIds,
        latestCtx.sessionManager.getLeafId(),
      ),
    };
  }

  async function switchMessageVersion(params: Record<string, unknown>) {
    requireVersionScope(params);
    requireSessionAction("message version switching");
    // handleRequest counts this mutation too. All earlier awaits must finish.
    if (activeBrowserMutations > 1) throw new Error("Another browser mutation is still in progress.");
    if (!latestCtx || !latestExecuteCtx) throw new Error("No command context available");
    const resolved = resolveMessageVersions(
      latestCtx.sessionManager.getEntries(),
      [params.entryId],
      latestCtx.sessionManager.getLeafId(),
    );
    const version = resolved.groups[0]?.versions.find((item) => item.userEntryId === params.userEntryId);
    if (!version?.targetEntryId || version.targetEntryId !== params.targetEntryId)
      throw new Error("Message version target changed or is unavailable. Request message versions again.");
    const target = latestCtx.sessionManager.getEntry(version.targetEntryId);
    if (!target || target.type === "custom_message" || (target.type === "message" && target.message.role === "user"))
      throw new Error("Invalid message version target");
    const targetId = target.id;
    const ack = { switched: true, sessionId: params.sessionId, runtimeId, leafId: targetId };
    if (latestCtx.sessionManager.getLeafId() === targetId) return ack;
    const epoch = lifecycleEpoch;
    const treeVersion = revisionTreeVersion;
    const attempt = { cancelled: false };
    revisionAttempt = attempt;
    sessionReplacementPending = true;
    try {
      const result = await latestExecuteCtx.navigateTree(targetId, { summarize: false });
      if (result.cancelled) return { cancelled: true };
      // No captured command/event ctx survives the await. Only fresh latestCtx
      // and a matching lifecycle/leaf can acknowledge the completed switch.
      requireRevisionIdentity(params);
      if (
        epoch !== lifecycleEpoch ||
        revisionAttempt !== attempt ||
        attempt.cancelled ||
        !latestCtx ||
        revisionTreeVersion !== treeVersion + 1 ||
        latestCtx.sessionManager.getLeafId() !== targetId ||
        !latestCtx.isIdle() ||
        latestCtx.hasPendingMessages()
      )
        throw new Error("Message version navigation was not confirmed");
      return ack;
    } catch {
      throw new Error(
        "Message version switch failed or its outcome is unknown. Check the session; do not automatically retry.",
      );
    } finally {
      // Never clear a replacement lifecycle's lock or broadcast from stale ctx.
      if (epoch === lifecycleEpoch && revisionAttempt === attempt) {
        revisionAttempt = null;
        sessionReplacementPending = false;
        try {
          if (runtimeActive && latestCtx) broadcast(buildStateSnapshot(latestCtx));
        } catch {
          // ACK depends on confirmed navigation, not delivery of a best-effort snapshot.
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleRequest(ws: WritableSocket, request: WsRequest) {
    const ctx = latestCtx;
    const params = request.params ?? {};

    const success = (result?: unknown): WsResponse => {
      const response: WsResponse = { type: "res", id: request.id, ok: true };
      if (result !== undefined) response.result = result;
      return response;
    };

    const error = (message: string): WsResponse => ({
      type: "res",
      id: request.id,
      ok: false,
      error: message,
    });

    let ownsMutation = false;
    const mutates =
      !request.method.startsWith("get_") &&
      !["abort", "health", "sync_request", "extension_ui_response"].includes(request.method);
    try {
      if (
        (runtimeStopping || runtimeControl?.prepared) &&
        (mutates || request.method === "abort" || request.method === "extension_ui_response")
      )
        throw new Error("Pi is preparing to restart. Wait for reconnection; nothing was sent.");
      if (
        (revisionAttempt || revisionDispatchUnknown) &&
        !request.method.startsWith("get_") &&
        !["abort", "health", "sync_request", "extension_ui_response"].includes(request.method)
      ) {
        throw new Error(
          revisionAttempt
            ? "A message revision is already in progress"
            : "Message revision dispatch is pending or unknown. Check Pi in the terminal; do not automatically retry.",
        );
      }
      if (mutates) {
        activeBrowserMutations++;
        ownsMutation = true;
      }
      switch (request.method) {
        case "prompt": {
          // Plain queued prompts may also carry a source identity. Enforce it
          // server-side as well as in the browser before any dispatch/command.
          if (params.sessionId !== undefined || params.runtimeId !== undefined) {
            checkHistoryIdentity(params, true);
            if (params.runtimeId !== runtimeId) throw new Error("Session or Pi runtime changed. Nothing was sent.");
          }
          if (sessionReplacementPending) {
            sendTo(ws, error("A session action is already in progress"));
            break;
          }
          if (params.uploads !== undefined) {
            const uploadCtx = checkHistoryIdentity(params, true);
            if (params.runtimeId !== runtimeId) throw new Error("Pi runtime changed. Select the files again.");
            const scope = sessionScope(uploadCtx);
            const paths = workspaceUploads.resolve(scope, params.uploads);
            if (paths.length) {
              if (Array.isArray(params.images) && params.images.length)
                throw new Error("Upload images as files when using file attachments.");
              if (params.executePiCommand === true) throw new Error("File attachments cannot execute Pi commands.");
              const text = typeof params.message === "string" ? params.message : "";
              const message = `${text}\n\nUploaded workspace files (saved, not yet analyzed):\n${paths.map((file) => `- ${JSON.stringify(file)}`).join("\n")}`;
              const checkReady = () => {
                if (!scopeIsCurrent(scope) || sessionReplacementPending || !latestCtx)
                  throw new Error("Session changed. Select the files again.");
                // Pi 1.1.0 isIdle includes manual/automatic compaction. Never
                // queue attachments: queued/handled input is not acceptance.
                if (!latestCtx.isIdle() || latestCtx.hasPendingMessages())
                  throw new Error("Wait for Pi to finish its current turn or compaction before sending attachments.");
                if (!latestCtx.model) throw new Error("Select a model before sending attachments.");
                return latestCtx.model;
              };
              await workspaceUploads.send(
                scope,
                params.uploads as string[],
                message,
                async () => {
                  const model = checkReady();
                  // Resolve credentials before dispatch, including command/token
                  // resolution errors. Never put auth details into WS errors.
                  let authenticated = false;
                  try {
                    authenticated = (await latestCtx?.modelRegistry.getApiKeyAndHeaders(model))?.ok === true;
                  } catch {}
                  if (!authenticated) throw new Error("Model authentication failed. Check Pi credentials and retry.");
                  if (checkReady() !== model) throw new Error("Model changed. Retry the attachment prompt.");
                },
                () => {
                  checkReady();
                  pi.sendUserMessage(message, { expandPromptTemplates: false });
                },
              );
              sendTo(ws, success());
              break;
            }
          }
          const message = typeof params.message === "string" ? params.message : "";
          const images = Array.isArray(params.images) ? (params.images as BrowserImage[]) : [];
          const slashCommand = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
          const commandName = slashCommand?.[1];
          const normalizedCommandName = commandName?.toLowerCase();
          const commandArgs = slashCommand?.[2]?.trim() ?? "";
          if (normalizedCommandName && internalCommands.has(normalizedCommandName)) {
            sendTo(ws, error("Internal Web UI commands cannot be invoked directly"));
            break;
          }
          if (slashCommand && params.executePiCommand === true && images.length === 0) {
            taintRuntimeInput();
            const registeredCommand = pi.getCommands().some((command) => command.name === commandName);
            if (!registeredCommand) {
              sendTo(ws, error(`Unknown Pi command: /${commandName}`));
              break;
            }
            pi.sendUserMessage(message, { expandPromptTemplates: true });
            sendTo(ws, success({ command: commandName, source: "pi" }));
            break;
          }
          if (slashCommand && normalizedCommandName === "new" && images.length === 0) {
            if (commandArgs) {
              sendTo(ws, error("Usage: /new"));
              break;
            }
            requireSessionAction("new session", false);
            acceptSessionAction("/webui-new-session");
            sendTo(ws, success({ command: "new" }));
            break;
          }
          if (slashCommand && normalizedCommandName === "resume" && images.length === 0) {
            if (commandArgs) {
              sendTo(ws, error("Usage: /resume (select a saved session in the browser)"));
              break;
            }
            sendTo(ws, success({ command: "resume", ...(await listSavedSessions()) }));
            break;
          }
          if (slashCommand && normalizedCommandName === "reload" && images.length === 0) {
            if (commandArgs) throw new Error("Usage: /reload");
            sendTo(ws, success({ command: "reload", ...requestReload() }));
            break;
          }
          if (slashCommand && normalizedCommandName === "session" && images.length === 0) {
            if (commandArgs) throw new Error("Usage: /session");
            if (!latestCtx) throw new Error("No context available");
            sendTo(ws, success({ command: "session", ...buildSessionDetails(latestCtx) }));
            break;
          }
          if (slashCommand && normalizedCommandName === "export" && images.length === 0) {
            if (commandArgs)
              throw new Error("Usage: /export (HTML browser download; host paths and JSONL are not supported)");
            if (!latestCtx) throw new Error("No context available");
            sendTo(ws, success({ command: "export", ...(await exportHtml(latestCtx)) }));
            break;
          }
          if (slashCommand && normalizedCommandName === "thinking" && images.length === 0) {
            const requested = commandArgs.toLowerCase();
            const availableThinkingLevels = getAvailableThinkingLevels(latestCtx);
            if (!requested) {
              sendTo(
                ws,
                success({ command: "thinking", thinkingLevel: pi.getThinkingLevel(), availableThinkingLevels }),
              );
              break;
            }
            if (!isThinkingLevel(requested)) {
              sendTo(ws, error(`Unknown thinking level: ${requested}. Use ${availableThinkingLevels.join(", ")}.`));
              break;
            }
            if (!availableThinkingLevels.includes(requested)) {
              sendTo(
                ws,
                error(
                  `Thinking level "${requested}" is not supported by the current model. Use ${availableThinkingLevels.join(", ")}.`,
                ),
              );
              break;
            }
            pi.setThinkingLevel(requested);
            sendTo(
              ws,
              success({
                command: "thinking",
                thinkingLevel: pi.getThinkingLevel(),
                availableThinkingLevels,
                message: `Thinking level: ${pi.getThinkingLevel()}`,
              }),
            );
            break;
          }
          if (slashCommand && normalizedCommandName === "compact" && images.length === 0) {
            if (!latestCtx) {
              sendTo(ws, error("No Pi context available"));
              break;
            }
            const compactScope = sessionScope(latestCtx);
            const compactCtx = latestCtx;
            const finishCompact = (payload: { summary?: unknown }) => {
              if (!scopeIsCurrent(compactScope)) return;
              latestCtx = compactCtx;
              broadcast({ type: "event", event: "auto_compaction_end", payload });
            };
            broadcast({ type: "event", event: "auto_compaction_start", payload: {} });
            compactCtx.compact({
              customInstructions: commandArgs || undefined,
              onComplete: (result: { summary?: unknown }) => finishCompact({ summary: result?.summary }),
              onError: (err: Error) => finishCompact({ summary: `Error: ${err.message}` }),
            });
            sendTo(ws, success({ command: "compact" }));
            break;
          }
          if (slashCommand && normalizedCommandName === "name" && images.length === 0) {
            if (!commandArgs) {
              const name = pi.getSessionName() ?? null;
              sendTo(
                ws,
                success({ command: "name", name, message: name ? `Session name: ${name}` : "Session has no name" }),
              );
              break;
            }
            const name = await renameSession(commandArgs);
            sendTo(
              ws,
              success({ command: "name", name, message: name ? `Session renamed to: ${name}` : "Session has no name" }),
            );
            break;
          }
          if (slashCommand && images.length === 0) {
            const registeredCommand = pi.getCommands().some((command) => command.name === commandName);
            if (!registeredCommand) {
              sendTo(ws, error(`Unsupported or unknown slash command: /${commandName}`));
              break;
            }
          }
          // SDK command expansion also runs on the fallback (including while
          // streaming). Its void API acknowledges before async handlers finish;
          // the optional UI flag is not a command-completion safety boundary.
          if (images.length === 0 && message.startsWith("/")) taintRuntimeInput();
          const commandContext = latestCtx;
          if (commandContext && !commandContext.isIdle()) {
            const behavior = typeof params.streamingBehavior === "string" ? params.streamingBehavior : "steer";
            pi.sendUserMessage(message, {
              deliverAs: behavior === "followUp" ? "followUp" : "steer",
              expandPromptTemplates: images.length === 0,
            });
          } else {
            if (images.length) {
              const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
              const content: Array<TextContentBlock | ImageContentBlock> = [
                { type: "text", text: message || "(see attached image)" },
              ];
              for (const img of images) {
                if (!img.data || typeof img.data !== "string") continue;
                const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
                const mimeType = (validMimes.includes(img.mimeType) ? img.mimeType : "image/png") as
                  | "image/png"
                  | "image/jpeg"
                  | "image/gif"
                  | "image/webp";
                content.push({ type: "image", data, mimeType });
              }
              pi.sendUserMessage(content.some((block) => block.type === "image") ? content : message, {
                expandPromptTemplates: false,
              });
            } else {
              pi.sendUserMessage(message, { expandPromptTemplates: true });
            }
          }
          sendTo(ws, success());
          break;
        }

        case "steer": {
          if (sessionReplacementPending) throw new Error("A session action is already in progress");
          pi.sendUserMessage(typeof params.message === "string" ? params.message : "", { deliverAs: "steer" });
          sendTo(ws, success());
          break;
        }

        case "follow_up": {
          if (sessionReplacementPending) throw new Error("A session action is already in progress");
          pi.sendUserMessage(typeof params.message === "string" ? params.message : "", { deliverAs: "followUp" });
          sendTo(ws, success());
          break;
        }

        case "abort": {
          if (revisionAttempt) revisionAttempt.cancelled = true;
          latestCtx?.abort();
          sendTo(ws, success());
          break;
        }

        case "enter_arch_mode": {
          (pi as ExtensionAPIWithEvents).events?.emit?.("cmd:arch:enter", {});
          sendTo(ws, success());
          break;
        }

        case "exit_arch_mode": {
          (pi as ExtensionAPIWithEvents).events?.emit?.("cmd:arch:exit", {});
          sendTo(ws, success());
          break;
        }

        case "get_commands": {
          const commands = [
            { name: "thinking", description: "Set the current thinking level", source: "builtin" },
            { name: "compact", description: "Compact the current context", source: "builtin" },
            { name: "name", description: "Show or set the session name", source: "builtin" },
            { name: "resume", description: "Choose a saved session in the current project", source: "builtin" },
            { name: "reload", description: "Reload Pi resources and reconnect Web UI", source: "builtin" },
            { name: "new", description: "Start a new session", source: "builtin" },
            { name: "fork", description: "Create a new session from a user message", source: "builtin" },
            { name: "clone", description: "Duplicate the session at its current position", source: "builtin" },
            { name: "settings", description: "Open Web UI settings", source: "builtin" },
            { name: "model", description: "Select a model", source: "builtin" },
            { name: "session", description: "Show session statistics", source: "builtin" },
            { name: "tree", description: "Open the conversation tree", source: "builtin" },
            { name: "copy", description: "Copy the last assistant message", source: "builtin" },
            { name: "export", description: "Export the current session as HTML", source: "builtin" },
            ...pi
              .getCommands()
              .filter(({ name }) => !internalCommands.has(name))
              .map(({ name, description, source }) => ({ name, description, source })),
          ];
          sendTo(ws, success({ commands }));
          break;
        }

        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("No context available"));
            break;
          }
          sendTo(
            ws,
            success({
              model: ctx.model,
              thinkingLevel: pi.getThinkingLevel(),
              availableThinkingLevels: getAvailableThinkingLevels(latestCtx),
              isStreaming: !ctx.isIdle(),
              sessionFile: ctx.sessionManager.getSessionFile(),
              sessionName: pi.getSessionName(),
              autoCompactionEnabled: true,
            }),
          );
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("No context available"));
            break;
          }
          sendTo(ws, success(buildStateSnapshot(checkHistoryIdentity(params), params).payload));
          break;
        }

        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("No context available"));
            break;
          }
          sendTo(ws, success({ models: await ctx.modelRegistry.getAvailable() }));
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          const model = (models as ModelCandidate[]).find(
            (candidate) => candidate.provider === params.provider && candidate.id === params.modelId,
          );
          if (!model) {
            sendTo(ws, error(`Model not found: ${params.provider}/${params.modelId}`));
            break;
          }
          if (!(await pi.setModel(model))) {
            sendTo(ws, error("No API key for this model"));
            break;
          }
          sendTo(
            ws,
            success({
              model,
              thinkingLevel: pi.getThinkingLevel(),
              availableThinkingLevels: getAvailableThinkingLevels(latestCtx),
            }),
          );
          break;
        }

        case "cycle_model": {
          if (!ctx) {
            sendTo(ws, success(null));
            break;
          }
          const availModels = await ctx.modelRegistry.getAvailable();
          const currentModel = ctx.model;
          if (!currentModel || availModels.length <= 1) {
            sendTo(ws, success(null));
            break;
          }
          const idx = (availModels as ModelCandidate[]).findIndex(
            (candidate) => candidate.provider === currentModel.provider && candidate.id === currentModel.id,
          );
          const nextModel = availModels[(idx + 1) % availModels.length];
          await pi.setModel(nextModel);
          sendTo(
            ws,
            success({
              model: nextModel,
              thinkingLevel: pi.getThinkingLevel(),
              availableThinkingLevels: getAvailableThinkingLevels(latestCtx),
            }),
          );
          break;
        }

        case "cycle_thinking_level": {
          const levels = getAvailableThinkingLevels(latestCtx);
          const current = pi.getThinkingLevel() as BrowserThinkingLevel;
          const currentIndex = levels.indexOf(current);
          const next = levels[(currentIndex + 1 + levels.length) % levels.length];
          pi.setThinkingLevel(next);
          sendTo(ws, success({ level: pi.getThinkingLevel(), availableThinkingLevels: levels }));
          break;
        }

        case "set_thinking_level": {
          if (!isThinkingLevel(params.level)) {
            sendTo(ws, error(`Invalid thinking level: ${String(params.level)}`));
            break;
          }
          const availableThinkingLevels = getAvailableThinkingLevels(latestCtx);
          if (!availableThinkingLevels.includes(params.level)) {
            sendTo(
              ws,
              error(
                `Thinking level "${params.level}" is not supported by the current model. Use ${availableThinkingLevels.join(", ")}.`,
              ),
            );
            break;
          }
          pi.setThinkingLevel(params.level);
          sendTo(ws, success({ level: pi.getThinkingLevel(), availableThinkingLevels }));
          break;
        }

        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("No context available"));
            break;
          }
          sendTo(ws, success(buildSessionDetails(ctx)));
          break;
        }

        case "get_usage_stats": {
          const usageCtx = checkHistoryIdentity(params, true);
          if (params.runtimeId !== runtimeId) throw new Error("Pi runtime changed. Request usage statistics again.");
          sendTo(
            ws,
            success(
              getSessionUsageStatistics(
                usageCtx.sessionManager.getEntries(),
                usageCtx.sessionManager.getSessionId(),
                runtimeId,
              ),
            ),
          );
          break;
        }

        case "get_saved_sessions": {
          sendTo(ws, success(await listSavedSessions(params)));
          break;
        }

        case "switch_session": {
          sendTo(ws, success(requestResume(params.id, params.sessionId)));
          break;
        }

        case "reload": {
          sendTo(ws, success(requestReload(params.sessionId)));
          break;
        }

        case "get_fork_messages": {
          if (!ctx || !advancedFeaturesEnabled || !latestExecuteCtx) {
            sendTo(ws, error("Run /webui first to enable session fork commands"));
            break;
          }
          const messages = ctx.sessionManager
            .getEntries()
            .filter((entry) => entry.type === "message" && entry.message?.role === "user")
            .map((entry) => {
              const content = entry.message?.content;
              const text =
                typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content
                        .filter((part) => part.type === "text" && typeof part.text === "string")
                        .map((part) => part.text)
                        .join("\n")
                    : "";
              return { entryId: entry.id, text, timestamp: entry.timestamp };
            })
            .filter((entry) => entry.entryId && entry.text.trim())
            .reverse();
          sendTo(ws, success({ messages, sessionId: ctx.sessionManager.getSessionId() }));
          break;
        }

        case "set_session_name": {
          const name = typeof params.name === "string" ? params.name.trim() : "";
          if (!name) {
            sendTo(ws, error("Name cannot be empty"));
            break;
          }
          const currentName = await renameSession(name);
          sendTo(ws, success({ name: currentName }));
          break;
        }

        case "set_auto_compaction": {
          sendTo(ws, success());
          break;
        }

        case "compact": {
          if (ctx) {
            const compactScope = sessionScope(ctx);
            const compactCtx = ctx;
            const finishCompact = (payload: { summary?: unknown }) => {
              if (!scopeIsCurrent(compactScope)) return;
              latestCtx = compactCtx;
              broadcast({ type: "event", event: "auto_compaction_end", payload });
            };
            broadcast({ type: "event", event: "auto_compaction_start", payload: {} });
            compactCtx.compact({
              customInstructions: typeof params.customInstructions === "string" ? params.customInstructions : undefined,
              onComplete: (result: { summary?: unknown }) => finishCompact({ summary: result?.summary }),
              onError: (err: Error) => finishCompact({ summary: `Error: ${err.message}` }),
            });
          }
          sendTo(ws, success());
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("No context available"));
            break;
          }
          if (sessionReplacementPending) throw new Error("A session action is already in progress");
          sendTo(ws, success(await exportHtml(ctx, params.outputPath)));
          break;
        }

        case "get_entry_detail": {
          const detailCtx = checkHistoryIdentity(params, true);
          sendTo(
            ws,
            success(
              readEntryDetail(
                detailCtx.sessionManager.getBranch(),
                {
                  sessionId: detailCtx.sessionManager.getSessionId(),
                  runtimeId,
                  leafId: detailCtx.sessionManager.getLeafId(),
                },
                params,
                request.id,
              ),
            ),
          );
          break;
        }

        case "get_history":
        case "get_tree":
        case "sync_request": {
          const historyCtx = checkHistoryIdentity(params, request.method === "get_history");
          if (request.method === "get_history" && (params.from === undefined || params.to === undefined))
            throw new Error("Invalid history date range: from and to are required");
          const snapshot = buildStateSnapshot(historyCtx, params);
          sendTo(ws, success(snapshot.payload));
          break;
        }

        case "health": {
          sendTo(ws, success({ status: "ok", mode: "webui", mirrorUrl }));
          break;
        }

        case "get_files": {
          const explicitPath = typeof params.path === "string" ? params.path : "";
          let dirPath = explicitPath || process.cwd();
          if (!explicitPath && latestCtx) {
            try {
              const entries = latestCtx.sessionManager.getEntries() as SessionEntry[];
              const sessionEntry = entries.find((entry) => entry.type === "session");
              if (typeof sessionEntry?.cwd === "string") dirPath = sessionEntry.cwd;
            } catch {}
          }
          sendTo(ws, success(getFileList(dirPath)));
          break;
        }

        case "get_git_status": {
          sendTo(ws, success(getGitStatus(ctx)));
          break;
        }

        case "get_git_diff": {
          const filePath = typeof params.path === "string" ? params.path : undefined;
          sendTo(ws, success(getGitDiff(ctx, filePath)));
          break;
        }

        case "prepare_upload": {
          const uploadCtx = checkHistoryIdentity(params, true);
          if (params.runtimeId !== runtimeId) throw new Error("Invalid upload identity");
          const scope = sessionScope(uploadCtx);
          const isCurrent = () => scopeIsCurrent(scope) && !sessionReplacementPending;
          if (params.protocol === 2) {
            sendTo(
              ws,
              success(
                workspaceUploads.prepareV2(
                  scope,
                  params.filename,
                  params.size,
                  params.sha256,
                  params.chunkHashes,
                  isCurrent,
                ),
              ),
            );
            break;
          }
          if (params.protocol !== undefined) throw new Error("Unsupported upload protocol");
          sendTo(ws, success(workspaceUploads.prepare(scope, params.filename, params.size, isCurrent)));
          break;
        }

        case "complete_upload": {
          const uploadCtx = checkHistoryIdentity(params, true);
          if (params.runtimeId !== runtimeId || typeof params.uploadId !== "string")
            throw new Error("Invalid upload identity");
          const scope = sessionScope(uploadCtx);
          const result = await workspaceUploads.complete(
            params.uploadId,
            scope,
            () => scopeIsCurrent(scope) && !sessionReplacementPending,
          );
          sendTo(ws, success(result));
          break;
        }

        case "prepare_file_download": {
          const downloadCtx = checkHistoryIdentity(params, true);
          if (typeof params.path !== "string" || params.runtimeId !== runtimeId)
            throw new Error("Invalid file download request");
          sendTo(
            ws,
            success(
              fileDownloads.prepare(
                {
                  workspace: downloadCtx.cwd,
                  sessionId: downloadCtx.sessionManager.getSessionId(),
                  epoch: lifecycleEpoch,
                },
                params.path,
              ),
            ),
          );
          break;
        }

        case "get_file_content": {
          const filePath = typeof params.path === "string" ? params.path : "";
          if (!filePath) {
            sendTo(ws, error("path required"));
            break;
          }
          sendTo(ws, success(getFileContent(ctx, filePath)));
          break;
        }

        case "open_file": {
          const filePath = typeof params.filePath === "string" ? params.filePath : "";
          if (!filePath) {
            sendTo(ws, error("filePath required"));
            break;
          }
          const { execFile } = await import("node:child_process");
          execFile("open", [filePath], (err) => {
            if (err) latestCtx?.ui.notify(`Failed to open file: ${err.message}`, "warning");
          });
          sendTo(ws, success({ ok: true }));
          break;
        }

        case "get_web_connection": {
          const address = server?.address();
          if (!address || typeof address === "string") throw new Error("Pi Web listener unavailable");
          sendTo(
            ws,
            success({
              port: address.port,
              localUrl: localWebUrl(HOST, address.port),
              advertisedUrl: mirrorUrl,
              registrationConfigured: Boolean(SETTINGS.registration),
            }),
          );
          break;
        }

        case "get_auth": {
          sendTo(ws, success({ configured: false, enabled: false }));
          break;
        }

        case "set_auth": {
          sendTo(
            ws,
            error(
              "Authentication is not supported. Use tailscale serve or a reverse proxy with TLS for remote access.",
            ),
          );
          break;
        }

        case "fork_session": {
          requireSessionAction("session fork commands");
          if (!latestCtx) throw new Error("No context available");
          const action = params.action === "clone" ? "clone" : params.action === "fork" ? "fork" : null;
          if (!action) {
            sendTo(ws, error("Unknown session action"));
            break;
          }
          if (params.sessionId !== latestCtx.sessionManager.getSessionId()) {
            sendTo(ws, error("Session changed. Refresh the fork message picker and try again."));
            break;
          }
          const requestedEntryId = typeof params.entryId === "string" ? params.entryId : "";
          const entryId = action === "clone" ? latestCtx.sessionManager.getLeafId() : requestedEntryId;
          if (!entryId) {
            sendTo(ws, error(action === "clone" ? "Nothing to clone yet" : "Select a user message to fork from"));
            break;
          }
          const entry = latestCtx.sessionManager.getEntry(entryId) as SessionEntry | undefined;
          if (!entry || (action === "fork" && (entry.type !== "message" || entry.message?.role !== "user"))) {
            sendTo(ws, error("Select a valid user message to fork from"));
            break;
          }
          acceptSessionAction(`/webui-fork-session ${action}${action === "fork" ? ` ${entryId}` : ""}`);
          sendTo(ws, success({ action, entryId }));
          break;
        }

        case "get_message_versions": {
          sendTo(ws, success(getMessageVersions(params)));
          break;
        }

        case "switch_message_version": {
          sendTo(ws, success(await switchMessageVersion(params)));
          break;
        }

        case "get_message_revision": {
          sendTo(ws, success(getMessageRevision(ws, params)));
          break;
        }

        case "submit_message_revision": {
          sendTo(ws, success(await submitMessageRevision(ws, params)));
          break;
        }

        case "navigate_tree": {
          if (!advancedFeaturesEnabled || !latestExecuteCtx) {
            sendTo(ws, error("Run /webui first to enable editing"));
            break;
          }
          if (sessionReplacementPending || !latestCtx?.isIdle() || latestCtx.hasPendingMessages()) {
            sendTo(ws, error("Agent or session action is busy"));
            break;
          }
          const entryId = typeof params.entryId === "string" ? params.entryId : "";
          const entry = latestCtx.sessionManager.getEntry(entryId);
          if (!entry) {
            sendTo(ws, error("Entry not found"));
            break;
          }
          if (!latestCtx.model) {
            sendTo(ws, error("No model selected"));
            break;
          }
          sessionReplacementPending = true;
          try {
            const result = await latestExecuteCtx.navigateTree(entryId);
            if (result.cancelled) {
              sendTo(ws, success({ cancelled: true }));
              break;
            }
            sendTo(ws, success({ editorText: result.editorText, cancelled: false }));
          } finally {
            sessionReplacementPending = false;
          }
          break;
        }

        case "extension_ui_response": {
          sendTo(ws, success());
          break;
        }

        default:
          sendTo(ws, error(`Unknown method: ${request.method}`));
      }
    } catch (e: unknown) {
      sendTo(ws, error(e instanceof Error ? e.message : String(e)));
    } finally {
      if (ownsMutation) activeBrowserMutations--;
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = req.url || "/";

    // Strip query params
    urlPath = urlPath.split("?")[0];

    if (urlPath.startsWith("/api/uploads")) {
      if (runtimeStopping || runtimeControl?.prepared) {
        res.writeHead(409, { "Cache-Control": "no-store" }).end();
        return;
      }
      const scope = runtimeActive && latestCtx && !sessionReplacementPending ? sessionScope(latestCtx) : undefined;
      activeHttpMutations++;
      void serveWorkspaceUpload(
        req,
        res,
        workspaceUploads,
        scope,
        () =>
          !!scope &&
          !runtimeStopping &&
          !runtimeControl?.prepared &&
          !sessionReplacementPending &&
          scopeIsCurrent(scope),
        SETTINGS.publicUrl ? new URL(SETTINGS.publicUrl).origin : `http://${req.headers.host}`,
        !!registration && typeof req.headers["x-pi-web-proof"] === "string",
      ).finally(() => {
        activeHttpMutations--;
      });
      return;
    }

    if (urlPath.startsWith("/api/downloads")) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end("Method not allowed");
        return;
      }
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (!registration &&
          req.headers.origin &&
          req.headers.origin !==
            (SETTINGS.publicUrl ? new URL(SETTINGS.publicUrl).origin : `http://${req.headers.host}`))
      ) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const match = /^\/api\/downloads\/([0-9a-f-]{36})$/.exec(urlPath);
      try {
        if (!match || !runtimeActive || !latestCtx || sessionReplacementPending)
          throw new Error("Download unavailable");
        const opened = fileDownloads.open(match[1], {
          workspace: latestCtx.cwd,
          sessionId: latestCtx.sessionManager.getSessionId(),
          epoch: lifecycleEpoch,
        });
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": attachmentDisposition(opened.filename),
          "Content-Length": opened.size,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        });
        if (req.method === "HEAD" || opened.size === 0) {
          fs.closeSync(opened.fd);
          res.end();
        } else {
          const stream = fs.createReadStream("", {
            fd: opened.fd,
            autoClose: true,
            ...(opened.size > 0 ? { end: opened.size - 1 } : {}),
          });
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          stream.pipe(res);
        }
      } catch {
        res.writeHead(404);
        res.end("File download unavailable or expired");
      }
      return;
    }

    if (urlPath.startsWith("/api/exports")) {
      pruneExports();
      const match = /^\/api\/exports\/([0-9a-f-]{36})$/.exec(urlPath);
      const exported = match ? exports.get(match[1]) : undefined;
      if (!exported) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end("Export not found or expired");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end("Method not allowed");
        return;
      }
      try {
        // Reject a locally replaced symlink too. Tokens never resolve arbitrary paths.
        if (!fs.lstatSync(exported.path).isFile() || fs.realpathSync(exported.path) !== exported.path)
          throw new Error("Export expired");
        const content = fs.readFileSync(exported.path);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exported.filename}"`,
          "Content-Length": content.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : content);
      } catch {
        if (match) removeExport(match[1]);
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end("Export not found or expired");
      }
      return;
    }

    // Default to index.html
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules",
    ".git",
    "__pycache__",
    ".DS_Store",
    ".Trash",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".cache",
    ".turbo",
    "venv",
    ".venv",
    "env",
    ".env.local",
    ".pi",
    "coverage",
    ".nyc_output",
    ".parcel-cache",
  ]);

  function getGitStatus(ctx: ExtensionContext | null): GitStatusResult {
    let workspaceDir = path.resolve(process.cwd());
    if (ctx) {
      try {
        const entries = ctx.sessionManager.getEntries() as SessionEntry[];
        const sessionEntry = entries.find((entry) => entry.type === "session");
        if (typeof sessionEntry?.cwd === "string" && sessionEntry.cwd) workspaceDir = path.resolve(sessionEntry.cwd);
      } catch {}
    }

    const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceDir,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    if (rootResult.error || rootResult.status !== 0 || typeof rootResult.stdout !== "string") {
      return { isRepo: false, branch: null, hasChanges: false, additions: 0, deletions: 0, untracked: 0 };
    }
    const gitRoot = path.resolve(rootResult.stdout.trim());

    const gitOptions = { cwd: gitRoot, encoding: "utf8" as const, maxBuffer: MAX_GIT_OUTPUT_BYTES };
    const outputs = new Map<string, string>();
    const commands: Array<[string, string[]]> = [
      ["branch", ["branch", "--show-current"]],
      ["head", ["rev-parse", "--short", "HEAD"]],
      ["porcelain", ["status", "--porcelain=v1", "--untracked-files=all"]],
      ["unstagedStat", ["diff", "--numstat"]],
      ["stagedStat", ["diff", "--cached", "--numstat"]],
      ["untracked", ["ls-files", "--others", "--exclude-standard", "-z"]],
    ];
    for (const [name, args] of commands) {
      const result = spawnSync("git", args, gitOptions);
      if (result.error) throw result.error;
      if (result.status !== 0 && name !== "branch") {
        throw new Error(String(result.stderr || `git ${args.join(" ")} failed`).trim());
      }
      outputs.set(name, typeof result.stdout === "string" ? result.stdout : "");
    }

    let additions = 0;
    let deletions = 0;
    for (const line of `${outputs.get("unstagedStat") || ""}\n${outputs.get("stagedStat") || ""}`.split(/\r?\n/)) {
      const [added, deleted] = line.split("\t");
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isFinite(addedCount)) additions += addedCount;
      if (Number.isFinite(deletedCount)) deletions += deletedCount;
    }

    const untrackedPaths = (outputs.get("untracked") || "").split("\0").filter(Boolean);
    let untrackedAdditions = 0;

    for (const relativePath of untrackedPaths) {
      const absolutePath = path.resolve(gitRoot, relativePath);
      try {
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile() || stat.size > MAX_FILE_CONTENT_BYTES) continue;
        const content = fs.readFileSync(absolutePath, "utf8");
        if (content.includes("\0")) continue;
        untrackedAdditions += content ? (content.match(/\n/g)?.length ?? 0) + (content.endsWith("\n") ? 0 : 1) : 0;
      } catch {}
    }

    return {
      isRepo: true,
      branch: (outputs.get("branch") || outputs.get("head") || "").trim() || null,
      hasChanges: (outputs.get("porcelain") || "").trim().length > 0,
      additions: additions + untrackedAdditions,
      deletions,
      untracked: untrackedPaths.length,
    };
  }

  function getGitDiff(ctx: ExtensionContext | null, requestedPath?: string): GitDiffResult {
    const maxResponseBytes = 3 * 1024 * 1024;
    const responseSafetyMargin = 1024;
    const tooLargeError = "Git diff is too large for Web preview. Narrow the changes or inspect it locally.";
    let workspaceDir = path.resolve(process.cwd());
    if (ctx) {
      try {
        const entries = ctx.sessionManager.getEntries() as SessionEntry[];
        const sessionEntry = entries.find((entry) => entry.type === "session");
        if (typeof sessionEntry?.cwd === "string" && sessionEntry.cwd) workspaceDir = path.resolve(sessionEntry.cwd);
      } catch {}
    }

    const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspaceDir,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    if (rootResult.error || rootResult.status !== 0 || typeof rootResult.stdout !== "string") {
      return { isRepo: false, branch: null, diff: "" };
    }
    const gitRoot = path.resolve(rootResult.stdout.trim());
    let requestedRelativePath: string | null = null;
    if (requestedPath) {
      const absolutePath = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : path.resolve(workspaceDir, requestedPath);
      if (absolutePath !== workspaceDir && !absolutePath.startsWith(`${workspaceDir}${path.sep}`)) {
        throw new Error("path outside workspace");
      }
      requestedRelativePath = path.relative(gitRoot, absolutePath).replace(/\\/g, "/");
      if (requestedRelativePath.startsWith("..") || path.isAbsolute(requestedRelativePath)) {
        throw new Error("path outside git repository");
      }
    }

    const gitOptions = { cwd: gitRoot, encoding: "utf8" as const, maxBuffer: maxResponseBytes };
    const pathArgs = requestedRelativePath ? ["--", requestedRelativePath] : [];
    const outputs = new Map<string, string>();
    const commands: Array<[string, string[]]> = [
      ["branch", ["branch", "--show-current"]],
      ["head", ["rev-parse", "--short", "HEAD"]],
      ["staged", ["diff", "--cached", "--no-ext-diff", ...pathArgs]],
      ["unstaged", ["diff", "--no-ext-diff", ...pathArgs]],
      ["untracked", ["ls-files", "--others", "--exclude-standard", "-z"]],
    ];
    for (const [name, args] of commands) {
      const result = spawnSync("git", args, gitOptions);
      if (result.error) {
        if (
          (name === "staged" || name === "unstaged" || name === "untracked") &&
          (result.error as NodeJS.ErrnoException).code === "ENOBUFS"
        )
          throw new Error(tooLargeError);
        throw result.error;
      }
      if (result.status !== 0 && name !== "branch") {
        throw new Error(String(result.stderr || `git ${args.join(" ")} failed`).trim());
      }
      const output = typeof result.stdout === "string" ? result.stdout : "";
      outputs.set(name, output);
    }

    const untrackedPaths = (outputs.get("untracked") || "")
      .split("\0")
      .filter(Boolean)
      .filter((relativePath) => !requestedRelativePath || relativePath === requestedRelativePath);
    const parts: string[] = [];
    let diffJsonBytes = 0;
    const jsonStringContentBytes = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
    const addPart = (part: string) => {
      const bytes = jsonStringContentBytes(part) + (parts.length ? 4 : 0);
      if (diffJsonBytes + bytes > maxResponseBytes - responseSafetyMargin) throw new Error(tooLargeError);
      parts.push(part);
      diffJsonBytes += bytes;
    };
    const staged = (outputs.get("staged") || "").trimEnd();
    const unstaged = (outputs.get("unstaged") || "").trimEnd();

    if (staged) addPart(`## Staged changes\n\n${staged}`);
    if (unstaged) addPart(`## Working tree changes\n\n${unstaged}`);
    if (untrackedPaths.length) {
      const untrackedDiffs: string[] = [];
      let untrackedJsonBytes = 0;
      const untrackedHeading = "## Untracked files\n\n";
      const assertUntrackedFits = (jsonBytes: number) => {
        const total =
          diffJsonBytes +
          (parts.length ? 4 : 0) +
          jsonStringContentBytes(untrackedHeading) +
          untrackedJsonBytes +
          untrackedDiffs.length * 4 +
          jsonBytes;
        if (total > maxResponseBytes - responseSafetyMargin) throw new Error(tooLargeError);
      };
      const addUntrackedDiff = (diff: string) => {
        const jsonBytes = jsonStringContentBytes(diff);
        assertUntrackedFits(jsonBytes);
        untrackedDiffs.push(diff);
        untrackedJsonBytes += jsonBytes;
      };
      for (const relativePath of untrackedPaths) {
        const absolutePath = path.resolve(gitRoot, relativePath);
        try {
          const stat = fs.statSync(absolutePath);
          if (!stat.isFile()) continue;
          if (stat.size > MAX_FILE_CONTENT_BYTES) {
            addUntrackedDiff(`diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n[large file]`);
            continue;
          }
          const content = fs.readFileSync(absolutePath, "utf8");
          if (content.includes("\0")) {
            addUntrackedDiff(`diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n[binary file]`);
            continue;
          }
          const lines = content.split(/\r?\n/);
          if (lines.at(-1) === "") lines.pop();
          // Account for JSON escaping before allocating all prefixed diff lines.
          const header = [
            `diff --git a/${relativePath} b/${relativePath}`,
            "new file mode 100644",
            "--- /dev/null",
            `+++ b/${relativePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
          ].join("\n");
          let estimatedJsonBytes = jsonStringContentBytes(header);
          if (lines.length) {
            estimatedJsonBytes += 2;
            for (const line of lines) estimatedJsonBytes += 1 + jsonStringContentBytes(line) + 2;
            estimatedJsonBytes -= 2;
          }
          assertUntrackedFits(estimatedJsonBytes);
          const diff = lines.length ? `${header}\n${lines.map((line) => `+${line}`).join("\n")}` : header;
          addUntrackedDiff(diff);
        } catch (error) {
          if (error instanceof Error && error.message === tooLargeError) throw error;
          throw new Error(
            "Git diff preview is unavailable because an untracked file could not be read. Retry or inspect it locally.",
          );
        }
      }
      if (untrackedDiffs.length) addPart(`${untrackedHeading}${untrackedDiffs.join("\n\n")}`);
    }

    const result = {
      isRepo: true,
      branch: (outputs.get("branch") || outputs.get("head") || "").trim() || null,
      diff: parts.join("\n\n"),
    };
    const responseBytes = Buffer.byteLength(JSON.stringify({ type: "res", id: "", ok: true, result }));
    if (responseBytes > maxResponseBytes - responseSafetyMargin) throw new Error(tooLargeError);
    return result;
  }

  function getFileContent(ctx: ExtensionContext | null, requestedPath: string): FileContentResult {
    let workspaceDir = path.resolve(process.cwd());
    let entries: SessionEntry[] = [];
    if (ctx) {
      try {
        entries = ctx.sessionManager.getEntries() as SessionEntry[];
        const sessionEntry = entries.find((entry) => entry.type === "session");
        if (typeof sessionEntry?.cwd === "string" && sessionEntry.cwd) workspaceDir = path.resolve(sessionEntry.cwd);
      } catch {}
    }

    const normalizedRequest = requestedPath
      .trim()
      .replace(/^file:\/\//, "")
      .replace(/\\/g, "/");
    const absolutePath = path.isAbsolute(normalizedRequest)
      ? path.resolve(normalizedRequest)
      : path.resolve(workspaceDir, normalizedRequest);
    const insideWorkspace = absolutePath === workspaceDir || absolutePath.startsWith(`${workspaceDir}${path.sep}`);
    const artifactPaths = new Set(liveArtifactPaths);
    const pendingToolCalls = new Map<string, string>();

    for (const entry of entries) {
      const message = entry.message;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== "object" || Array.isArray(block)) continue;
          const record = block as Record<string, unknown>;
          if (record.type !== "toolCall" || typeof record.id !== "string") continue;
          const tool = typeof record.name === "string" ? record.name.toLowerCase() : "";
          const args =
            record.arguments && typeof record.arguments === "object"
              ? (record.arguments as Record<string, unknown>)
              : {};
          const rawPath = ["path", "filePath", "filepath", "file_path", "file", "target", "filename"]
            .map((key) => args[key])
            .find((value): value is string => typeof value === "string" && value.trim().length > 0);
          const normalizedPath = rawPath
            ?.trim()
            .replace(/^file:\/\//, "")
            .replace(/\\/g, "/");
          const lowerPath = normalizedPath?.toLowerCase() || "";
          if (ARTIFACT_TOOL_NAMES.has(tool) && MARKDOWN_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))) {
            pendingToolCalls.set(
              record.id,
              path.isAbsolute(normalizedPath || "")
                ? path.resolve(normalizedPath || "")
                : path.resolve(workspaceDir, normalizedPath || ""),
            );
          }
        }
      }

      if (message?.role === "toolResult" && typeof message.toolCallId === "string" && message.isError !== true) {
        const artifactPath = pendingToolCalls.get(message.toolCallId);
        if (artifactPath) artifactPaths.add(artifactPath);
      }

      const entryRecord = entry as SessionEntry & { toolName?: unknown; args?: unknown; isError?: unknown };
      if (entry.type === "tool_execution_end" && entryRecord.isError !== true) {
        const tool = typeof entryRecord.toolName === "string" ? entryRecord.toolName.toLowerCase() : "";
        const args =
          entryRecord.args && typeof entryRecord.args === "object" && !Array.isArray(entryRecord.args)
            ? (entryRecord.args as Record<string, unknown>)
            : {};
        const rawPath = ["path", "filePath", "filepath", "file_path", "file", "target", "filename"]
          .map((key) => args[key])
          .find((value): value is string => typeof value === "string" && value.trim().length > 0);
        const normalizedPath = rawPath
          ?.trim()
          .replace(/^file:\/\//, "")
          .replace(/\\/g, "/");
        const lowerPath = normalizedPath?.toLowerCase() || "";
        if (ARTIFACT_TOOL_NAMES.has(tool) && MARKDOWN_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))) {
          artifactPaths.add(
            path.isAbsolute(normalizedPath || "")
              ? path.resolve(normalizedPath || "")
              : path.resolve(workspaceDir, normalizedPath || ""),
          );
        }
      }
    }

    if (!insideWorkspace && !artifactPaths.has(absolutePath)) {
      throw new Error("file is not a session artifact");
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const tooLargeError = "File preview is too large for Web transport. Download the file instead.";
    if (stat.size > MAX_FILE_CONTENT_BYTES) throw new Error(tooLargeError);
    const content = fs.readFileSync(absolutePath, "utf8");
    if (content.includes("\0")) throw new Error("Binary file cannot be previewed");
    const relativePath = path.relative(workspaceDir, absolutePath).replace(/\\/g, "/");
    const result = {
      path: relativePath || path.basename(absolutePath),
      name: path.basename(absolutePath),
      size: stat.size,
      content,
    };
    if (Buffer.byteLength(JSON.stringify({ type: "res", id: "", ok: true, result })) > 3 * 1024 * 1024 - 1024)
      throw new Error(tooLargeError);
    return result;
  }

  function getFileList(dirPath: string) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      throw new Error("Not a directory");
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items: FileListItem[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (IGNORED_NAMES.has(entry.name)) continue;

      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = fs.statSync(fullPath);
        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? null : stat.size,
          mtime: stat.mtimeMs,
        });
      } catch {
        /* skip inaccessible */
      }
    }

    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { path: dirPath, items };
  }

  // ═══════════════════════════════════════
  // Start server function (reusable)
  // ═══════════════════════════════════════
  function startServer() {
    if (server) return; // Already running
    if (SETTINGS.error) {
      latestCtx?.ui.notify(SETTINGS.error, "error");
      return;
    }
    for (const warning of SETTINGS.warnings) latestCtx?.ui.notify(warning, "warning");
    let activeRegistration: SessionRegistration | null = null;
    if (SETTINGS.registration) {
      try {
        activeRegistration = createSessionRegistration(SETTINGS.registration);
      } catch {
        latestCtx?.ui.notify(
          "Pi Web registration unavailable: check the capability file; local Web is still enabled",
          "warning",
        );
      }
    }
    registration = activeRegistration;
    const controller = new AbortController();
    listenController = controller;
    const activeServer = http.createServer((request, response) => {
      if (guardSessionRequest(activeRegistration, request, response)) serveStaticFile(request, response);
    });
    server = activeServer;
    wss = new WebSocketServer({ noServer: true });

    activeServer.on("upgrade", (request, socket, head) => {
      if (!guardSessionRequest(activeRegistration, request)) {
        socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
        return;
      }
      if (request.url === "/ws") {
        const activeWss = wss;
        if (!activeWss) {
          socket.destroy();
          return;
        }
        activeWss.handleUpgrade(request, socket, head, (ws) => {
          activeWss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws) => {
      clients.add(ws);
      updateMirrorStatus();
      const aliveWs = ws as AliveWebSocket;
      aliveWs.isAlive = true;

      ws.on("pong", () => {
        aliveWs.isAlive = true;
      });

      // Send initial web UI capability state.
      sendTo(ws, {
        type: "event",
        event: "webui_state",
        payload: {
          advancedFeatures: advancedFeaturesEnabled && !!latestExecuteCtx,
          archAvailable: archExtensionPresent,
        },
      });

      // Immediately send state snapshot
      if (latestCtx) {
        try {
          sendTo(ws, buildStateSnapshot(latestCtx));
        } catch {
          sendTo(ws, { type: "error", code: "STATE_SYNC_FAILED", message: "Could not load bounded session history" });
        }
      }

      ws.on("message", (data) => {
        try {
          const request = JSON.parse(data.toString()) as Partial<WsRequest>;
          // Validate before dispatch: both success and catch responses echo this
          // opaque identity. Never truncate it or construct an oversized error.
          if (
            request.type !== "req" ||
            typeof request.id !== "string" ||
            request.id.length > 512 ||
            typeof request.method !== "string"
          ) {
            sendTo(ws, { type: "error", code: "bad_request", message: "Invalid client request" });
            return;
          }
          handleRequest(ws, request as WsRequest);
        } catch (_e) {
          sendTo(ws, { type: "error", code: "invalid_json", message: "Invalid client message" });
        }
      });

      ws.on("close", () => {
        clients.delete(ws);
        updateMirrorStatus();
      });

      ws.on("error", () => {
        clients.delete(ws);
        updateMirrorStatus();
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    heartbeatTimer = setInterval(() => {
      pruneExports();
      pruneSavedSelections();
      let changed = false;
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          clients.delete(client);
          changed = true;
          continue;
        }

        const aliveClient = client as AliveWebSocket;
        if (!aliveClient.isAlive) {
          try {
            client.terminate();
          } catch {}
          clients.delete(client);
          changed = true;
          continue;
        }

        aliveClient.isAlive = false;
        try {
          client.ping();
        } catch {}
      }
      if (changed) updateMirrorStatus();
    }, 20000);

    const onListening = (port: number) => {
      if (server !== activeServer || controller.signal.aborted) return;
      const localUrl = localWebUrl(HOST, port);
      mirrorUrl = SETTINGS.publicUrl || localUrl;
      mirrorStatusBase = `pi-web-ui: ${mirrorUrl}`;
      updateMirrorStatus();
      latestCtx?.ui.notify(
        `pi-web-ui local: ${localUrl}${SETTINGS.publicUrl ? ` • public: ${SETTINGS.publicUrl}` : ""}`,
        "info",
      );
      if (activeRegistration) {
        let unavailableNotified = false;
        void activeRegistration.start(
          port,
          (url) => {
            if (server !== activeServer || controller.signal.aborted) return;
            const previousUrl = mirrorUrl;
            mirrorUrl = url || SETTINGS.publicUrl || localUrl;
            mirrorStatusBase = `pi-web-ui: ${mirrorUrl}${url ? "" : " • registration unavailable"}`;
            updateMirrorStatus();
            if (url && url !== previousUrl) latestCtx?.ui.notify(`pi-web-ui public: ${url}`, "info");
            if (!url && !unavailableNotified) {
              unavailableNotified = true;
              latestCtx?.ui.notify("Pi Web registration unavailable; local Web is still running", "warning");
            }
          },
          () => (latestCtx ? pi.getSessionName() : null),
          runtimeMetadata,
          softwareMetadata,
        );
      }
    };

    void listenWithFallback(activeServer, { port: PORT, host: HOST }, controller.signal)
      .then(onListening)
      .catch(() => {
        if (server !== activeServer || controller.signal.aborted) return;
        latestCtx?.ui.setStatus("webui", "");
        latestCtx?.ui.notify("Pi Web could not obtain a listening port; check host and port settings", "error");
        void stopServer();
      });
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    if (!AUTO_START) {
      if (SETTINGS.error) latestCtx?.ui.notify(SETTINGS.error, "error");
      return;
    }

    startServer();
  });

  // ═══════════════════════════════════════
  // Cleanup on shutdown
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async (event) => {
    runtimeStopping = true;
    if (event.reason !== "quit" && runtimeControl?.prepared) taintRuntimeInput();
    await runtimeControl?.close(event.reason === "quit");
    runtimeControl = undefined;
    runtimeActive = false;
    lifecycleEpoch++;
    revisionAttempt = null;
    revisionPreviews = new WeakMap();
    revisionDispatch = null;
    revisionDispatchUnknown = false;
    savedSelections.clear();
    clearSessionAction();
    advancedFeaturesEnabled = false;
    latestExecuteCtx = null;
    latestCtx = null;
    liveArtifactPaths.clear();
    await stopServer();
  });
}
