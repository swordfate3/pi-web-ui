// Real Pi + real packaged Hub regression; never loads user sessions or real models.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type {
  HistoryMetadata,
  SavedSessionsResult,
  SessionEntry,
  SessionTreeNodeWire,
} from "../src/web/src/core/types.ts";
import { startHubCli } from "./harness/hub-cli.ts";
import { type PiWebUiHarness, startPiWebUi } from "./harness/pi-process.ts";

type HistorySnapshot = {
  entries: SessionEntry[];
  treeNodes: SessionTreeNodeWire[];
  history: HistoryMetadata;
  sessionId: string;
  runtimeId: string;
};

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("large dated history remains connected through Hub and loads only requested pages without modifying JSONL", {
  timeout: 45000,
}, async (t) => {
  const hub = await startHubCli({ repositoryRoot });
  let agent: PiWebUiHarness | undefined;
  let ws: WebSocket | undefined;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  t.after(async () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Test ended"));
    }
    ws?.terminate();
    try {
      await agent?.stop();
    } finally {
      await hub.close();
    }
  });
  agent = await startPiWebUi("chat-lifecycle", {
    repositoryRoot,
    datedHistory: true,
    registration: hub.issue("dated-history"),
  });
  const filename = readdirSync(agent.sessionDir).find((file) => file.includes("8e91f4c2-3000-4500-8500-000000000003"));
  assert.ok(filename, "Large dated fixture was written");
  const sessionFile = path.join(agent.sessionDir, filename);
  const originalHash = digest(sessionFile);
  let route: string | undefined;
  const deadline = Date.now() + 10000;
  do {
    const result = await (await fetch(`${hub.url}api/sessions`)).json();
    route = result.sessions[0]?.path;
    if (route) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.ok(route, "Pi registers in the isolated Hub");
  const wsUrl = new URL(`${route}ws`, hub.url);
  wsUrl.protocol = "ws:";
  const frames: number[] = [];
  let nextId = 0;
  const snapshots: HistorySnapshot[] = [];
  const socket = new WebSocket(wsUrl, { origin: new URL(hub.url).origin, maxPayload: 16 * 1024 * 1024 });
  ws = socket;
  const initial = new Promise<HistorySnapshot>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bounded state_sync did not arrive")), 10000);
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      reject(new Error("Hub closed before bounded state_sync"));
    });
    socket.on("message", (raw) => {
      frames.push(raw.length);
      const value = JSON.parse(raw.toString());
      if (value.type === "event" && value.event === "state_sync") {
        snapshots.push(value.payload);
        clearTimeout(timer);
        resolve(value.payload);
      }
      if (value.type === "res") {
        const request = pending.get(value.id);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(value.id);
          if (value.ok) request.resolve(value.result);
          else request.reject(new Error(value.error));
        }
      }
    });
  });
  const first = await initial;
  assert.ok(first.history, "Initial snapshot declares its bounded history window");
  assert.ok(first.entries.length <= 100);
  assert.ok(Buffer.byteLength(JSON.stringify(first.entries)) <= 512 * 1024);
  assert.ok(first.treeNodes.length <= 1000);
  assert.ok(!JSON.stringify(first).includes("DATED_OLD_ONLY_MARKER"));
  assert.ok(JSON.stringify(first.entries).includes("DATED_RECENT_END_MARKER"));
  assert.ok(first.history.truncatedEntries > 0, "The giant message has an explicit preview");
  assert.ok(first.history.nextBefore, "A recent day is paged rather than sent in full");

  const request = <T = HistorySnapshot>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = `history-${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`No response to ${method}`));
      }, 10000);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const next = await request("get_history", {
    from: first.history.from,
    to: first.history.to,
    before: first.history.nextBefore,
    sessionId: first.sessionId,
  });
  assert.ok(next.entries.length > 0);
  const firstIds = new Set(first.entries.map((entry) => entry.id));
  assert.ok(
    next.entries.every((entry) => !firstIds.has(entry.id)),
    "Consecutive pages do not overlap",
  );
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = midnight - 14 * 86400000;
  const old = await request("get_history", { from, to: from + 86400000, sessionId: first.sessionId });
  assert.deepEqual(
    old.entries.map((entry) => entry.id),
    ["datedold"],
  );
  assert.match(JSON.stringify(old.entries), /DATED_OLD_ONLY_MARKER/);
  assert.ok(!JSON.stringify(old).includes("DATED_RECENT_END_MARKER"));
  const synced = await request("sync_request", { from, to: from + 86400000, sessionId: first.sessionId });
  assert.deepEqual(
    synced.entries.map((entry) => entry.id),
    ["datedold"],
  );
  const recent = await request("get_history", {
    from: first.history.from,
    to: first.history.to,
    sessionId: first.sessionId,
  });
  assert.match(JSON.stringify(recent.entries), /DATED_RECENT_END_MARKER/);
  const recentSessions = await request<SavedSessionsResult>("get_saved_sessions", {
    from: first.history.from,
    to: first.history.to,
  });
  assert.ok(
    !recentSessions.sessions.some((session) => session.sessionId === "9e91f4c2-0000-4500-8500-000000000014"),
    "Old saved sessions are not returned by a recent-date query",
  );
  const oldSessions = await request<SavedSessionsResult>("get_saved_sessions", { from, to: from + 86400000 });
  assert.deepEqual(
    oldSessions.sessions.map((session) => session.sessionId),
    ["9e91f4c2-0000-4500-8500-000000000014"],
  );
  assert.ok(
    !JSON.stringify(oldSessions).includes("DATED_LARGE_START"),
    "Saved-session queries only return compact metadata",
  );
  await assert.rejects(
    request("get_history", { from, to: from + 86400000, sessionId: "not-the-current-session" }),
    /session/i,
  );
  await assert.rejects(
    request("get_history", { from, to: from + 86400000, before: "unknown-entry", sessionId: first.sessionId }),
    /cursor/i,
  );
  await assert.rejects(
    request("get_history", { from: 123, to: 122, sessionId: first.sessionId }),
    /range|date|time|from/i,
  );
  const tree = await request("get_tree");
  assert.ok(Buffer.byteLength(JSON.stringify(tree)) < 2 * 1024 * 1024, "Tree query cannot resend full message bodies");
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.ok(frames.every((bytes) => bytes < 16 * 1024 * 1024));
  assert.equal(digest(sessionFile), originalHash, "History queries never rewrite the original session");
  console.log(
    JSON.stringify({
      maxFrameBytes: Math.max(...frames),
      initialEntries: first.entries.length,
      initialTreeNodes: first.treeNodes.length,
      snapshots: snapshots.length,
    }),
  );
});
