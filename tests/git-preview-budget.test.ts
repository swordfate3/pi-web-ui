import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { type RawData, WebSocket } from "ws";

test("Git diff and file previews reject oversized complete WebSocket results with targeted errors", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-preview-budget-"));
  const workspace = path.join(root, "workspace");
  const staticDir = path.join(root, "static");
  const agentDir = path.join(root, "isolated-agent");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>fixture</title>");
  const envKeys = [
    "PI_WEB_UI_PORT",
    "PI_WEB_UI_HOST",
    "PI_WEB_UI_DISABLED",
    "PI_WEB_UI_STATIC_DIR",
    "PI_CODING_AGENT_DIR",
  ] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  process.env.PI_WEB_UI_PORT = String(port);
  process.env.PI_WEB_UI_HOST = "127.0.0.1";
  process.env.PI_WEB_UI_DISABLED = "1";
  process.env.PI_WEB_UI_STATIC_DIR = staticDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Preview fixture");
  writeFileSync(path.join(workspace, "tracked.txt"), "baseline\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "baseline");

  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands = new Map<string, { handler: (...args: unknown[]) => unknown }>();
  const pi = {
    events: createEventBus(),
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const listeners = events.get(event) ?? [];
      listeners.push(handler);
      events.set(event, listeners);
    },
    registerCommand(name: string, command: { handler: (...args: unknown[]) => unknown }) {
      commands.set(name, command);
    },
    getCommands: () => [],
    getSettings: () => ({ compaction: { enabled: true } }),
    getThinkingLevel: () => "off",
    getSessionName: () => "fixture",
    setSessionName: () => {},
    setThinkingLevel: () => {},
    sendUserMessage: () => {},
  };
  const ctx = {
    cwd: workspace,
    model: null,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => null,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getEntries: () => [{ type: "session", cwd: workspace }],
      getBranch: () => [],
      getTree: () => [],
      getLeafId: () => null,
      getSessionId: () => "synthetic-session",
      getSessionDir: () => path.join(workspace, ".sessions"),
      getSessionFile: () => null,
      getHeader: () => ({}),
    },
  };

  // Runtime registration harness; strict backend checking excludes the existing
  // untyped Pi adapter, as do the other mock-extension unit harnesses.
  const extensionModule = "../extensions/mirror-server.ts";
  const { default: registerExtension } = await import(extensionModule);
  registerExtension(pi as never);
  await Promise.all((events.get("session_start") ?? []).map((handler) => handler({}, ctx)));
  await commands.get("webui-start")?.handler("", ctx);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(async () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    await commands.get("webui-stop")?.handler("", ctx);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("local preview test server did not start")), 5000);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  let requestId = 0;
  const request = (method: string, requestedPath: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = `preview-${++requestId}`;
      const timeout = setTimeout(() => reject(new Error("local preview request timed out")), 5000);
      const onMessage = (data: RawData) => {
        const response = JSON.parse(data.toString()) as Record<string, unknown>;
        if (response.id !== id) return;
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve(response);
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ type: "req", id, method, params: { path: requestedPath } }));
    });

  writeFileSync(path.join(workspace, "tracked.txt"), `s${"a".repeat(1_200_000)}\n`);
  git("add", "tracked.txt");
  writeFileSync(path.join(workspace, "tracked.txt"), `u${"b".repeat(1_200_000)}\n`);
  const combinedTracked = await request("get_git_diff", "");
  assert.equal(combinedTracked.ok, false);
  assert.equal(
    combinedTracked.error,
    "Git diff is too large for Web preview. Narrow the changes or inspect it locally.",
  );

  git("reset", "--hard", "-q", "HEAD");
  writeFileSync(path.join(workspace, "tracked.txt"), `q${"d".repeat(3_500_000)}\n`);
  const singleTracked = await request("get_git_diff", "");
  assert.equal(singleTracked.ok, false);
  assert.equal(singleTracked.error, "Git diff is too large for Web preview. Narrow the changes or inspect it locally.");

  git("reset", "--hard", "-q", "HEAD");
  for (let i = 0; i < 5; i++) writeFileSync(path.join(workspace, `untracked-${i}.txt`), `${"c".repeat(650_000)}\n`);
  const combinedUntracked = await request("get_git_diff", "");
  assert.equal(combinedUntracked.ok, false);
  assert.equal(
    combinedUntracked.error,
    "Git diff is too large for Web preview. Narrow the changes or inspect it locally.",
  );

  git("clean", "-fdq");
  writeFileSync(path.join(workspace, "small-untracked.txt"), "complete diff\n");
  const smallDiff = await request("get_git_diff", "");
  assert.equal(smallDiff.ok, true);
  assert.match((smallDiff.result as { diff: string }).diff, /\+complete diff/);

  git("clean", "-fdq");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    writeFileSync(path.join(workspace, "unreadable.txt"), "must not silently disappear\n");
    chmodSync(path.join(workspace, "unreadable.txt"), 0);
    const unreadable = await request("get_git_diff", "");
    assert.equal(unreadable.ok, false);
    assert.equal(
      unreadable.error,
      "Git diff preview is unavailable because an untracked file could not be read. Retry or inspect it locally.",
    );
    chmodSync(path.join(workspace, "unreadable.txt"), 0o600);
  } else t.diagnostic("Unreadable file permissions subcase requires non-root POSIX; remaining budget cases still run.");
  git("clean", "-fdq");
  writeFileSync(path.join(workspace, "escaped-diff.txt"), "\u0001".repeat(550_000));
  const escapedDiff = await request("get_git_diff", "");
  assert.equal(escapedDiff.ok, false);
  assert.equal(escapedDiff.error, "Git diff is too large for Web preview. Narrow the changes or inspect it locally.");
  git("clean", "-fdq");
  writeFileSync(path.join(workspace, "tracked.txt"), `${"t".repeat(700_000)}\n`);
  for (let i = 0; i < 4; i++) writeFileSync(path.join(workspace, `mixed-${i}.txt`), `${"m".repeat(650_000)}\n`);
  const mixedDiff = await request("get_git_diff", "");
  assert.equal(mixedDiff.ok, false);
  assert.equal(mixedDiff.error, "Git diff is too large for Web preview. Narrow the changes or inspect it locally.");

  writeFileSync(path.join(workspace, "escaped.txt"), "\u0001".repeat(550_000));
  const escapedFile = await request("get_file_content", "escaped.txt");
  assert.equal(escapedFile.ok, false);
  assert.equal(escapedFile.error, "File preview is too large for Web transport. Download the file instead.");

  writeFileSync(path.join(workspace, "large.txt"), "x".repeat(1024 * 1024 + 1));
  const largeFile = await request("get_file_content", "large.txt");
  assert.equal(largeFile.ok, false);
  assert.equal(largeFile.error, "File preview is too large for Web transport. Download the file instead.");

  writeFileSync(path.join(workspace, "small.txt"), "complete preview\n");
  const smallFile = await request("get_file_content", "small.txt");
  assert.equal(smallFile.ok, true);
  assert.equal((smallFile.result as { content: string }).content, "complete preview\n");
});
