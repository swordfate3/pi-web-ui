// Real Pi + optional packaged Hub, isolated workspaces and faux LLM only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import WebSocket from "ws";
import { startHubCli } from "./harness/hub-cli.ts";
import { type PiWebUiHarness, startPiWebUi } from "./harness/pi-process.ts";

type Prepared = { uploadId: string; url: string; relativePath: string; maxBytes: number };
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeRoot = path.resolve(process.env.PI_E2E_RUNTIME_DIR ?? repositoryRoot);
for (const mode of ["direct", "hub"]) {
  test(`${mode}: HTTP file upload preserves binary bytes; prompt carries only verified workspace paths`, {
    timeout: 45000,
  }, async (t) => {
    const hub = mode === "hub" ? await startHubCli({ repositoryRoot }) : undefined;
    let agent: PiWebUiHarness | undefined;
    let ws: WebSocket | undefined;
    const pending = new Map<
      string,
      { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
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
        await hub?.close();
      }
    });
    agent = await startPiWebUi("chat-lifecycle", {
      repositoryRoot,
      git: false,
      registration: hub?.issue("upload-integration"),
    });
    let base = `${agent.pageUrl}/`;
    if (hub) {
      const deadline = Date.now() + 10000;
      let route: string | undefined;
      do {
        route = (await (await fetch(`${hub.url}api/sessions`)).json()).sessions[0]?.path;
        if (!route) await new Promise((resolve) => setTimeout(resolve, 100));
      } while (!route && Date.now() < deadline);
      assert.ok(route);
      base = new URL(route, hub.url).href;
    }
    const endpoint = new URL("ws", base);
    endpoint.protocol = "ws:";
    const socket = new WebSocket(endpoint, { origin: new URL(base).origin });
    ws = socket;
    const userMessages: string[] = [];
    const scope = await new Promise<{ sessionId: string; runtimeId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Missing state")), 10000);
      socket.on("error", reject);
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "event" && event.event === "state_sync") {
          clearTimeout(timer);
          resolve({ sessionId: event.payload.sessionId, runtimeId: event.payload.runtimeId });
        }
        if (event.type === "event" && event.event === "message_start" && event.payload.message.role === "user")
          userMessages.push(JSON.stringify(event.payload.message.content));
        if (event.type === "res") {
          const request = pending.get(event.id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(event.id);
          if (event.ok) request.resolve(event.result);
          else request.reject(new Error(event.error));
        }
      });
    });
    let count = 0;
    const request = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = `upload-${++count}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Missing response"));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: "req", id, method, params }));
      });
    const prepare = (filename: string, size: number, identity = scope) =>
      request("prepare_upload", { ...identity, filename, size }) as Promise<Prepared>;
    // Exercise the exact configured ceiling through both real HTTP paths.
    const bytes = Buffer.alloc(50 * 1024 * 1024);
    for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
    const file = await prepare("合成图片.png", bytes.length);
    assert.equal(file.maxBytes, 50 * 1024 * 1024);
    assert.match(file.url, /^\/api\/uploads\/[0-9a-f-]{36}$/);
    assert.ok(JSON.stringify(file).length < 1024);
    const url = new URL(file.url.slice(1), base);
    const put = (target: URL, body: Buffer) =>
      fetch(target, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(body.length),
          Origin: new URL(base).origin,
        },
        body: new Uint8Array(body),
      });
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: "PUT", headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(url, { method: "PUT", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal(
      (await fetch(`${url}?path=escape`, { method: "PUT", headers: { "Content-Length": "0" } })).status,
      404,
    );
    await assert.rejects(request("prompt", { ...scope, uploads: [file.uploadId], message: "Not complete" }));
    const response = await put(url, bytes);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      uploadId: file.uploadId,
      relativePath: file.relativePath,
      filename: "合成图片.png",
      size: bytes.length,
    });
    assert.deepEqual(readFileSync(path.join(agent.workspaceDir, file.relativePath)), bytes);
    assert.equal((await put(url, bytes)).status, 400);
    const empty = await prepare("empty.txt", 0);
    assert.equal((await put(new URL(empty.url.slice(1), base), Buffer.alloc(0))).status, 200);
    assert.equal(readFileSync(path.join(agent.workspaceDir, empty.relativePath)).length, 0);
    await assert.rejects(prepare(".env", 1));
    await assert.rejects(prepare("../escape", 1));
    await assert.rejects(prepare("too-large", 50 * 1024 * 1024 + 1));
    await assert.rejects(prepare("stale", 0, { ...scope, sessionId: "stale" }));
    await assert.rejects(prepare("stale", 0, { ...scope, runtimeId: "stale" }));
    await assert.rejects(request("prepare_upload", { filename: "missing-scope", size: 0 }));
    await assert.rejects(
      request("prompt", { ...scope, uploads: [file.uploadId, "unknown"], message: "Bad attachment" }),
    );
    await assert.rejects(
      request("prompt", { ...scope, runtimeId: "stale", uploads: [file.uploadId], message: "Stale scope" }),
    );
    // Failed dispatch policy must leave a completed receipt retryable.
    await assert.rejects(
      request("prompt", { ...scope, uploads: [file.uploadId], executePiCommand: true, message: "/new" }),
    );
    await request("prompt", {
      ...scope,
      uploads: [file.uploadId, empty.uploadId],
      message: "UPLOAD_INTEGRATION_MARKER",
      path: "/untrusted-client-path",
    });
    const deadline = Date.now() + 10000;
    while (!userMessages.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(userMessages.length, 1);
    assert.ok(userMessages[0].includes(file.relativePath));
    assert.ok(userMessages[0].includes(empty.relativePath));
    assert.ok(userMessages[0].includes("UPLOAD_INTEGRATION_MARKER"));
    assert.ok(!userMessages[0].includes("untrusted-client-path"));
    assert.ok(userMessages[0].length < 4096);
    await assert.rejects(request("prompt", { ...scope, uploads: [file.uploadId], message: "Already consumed" }));
    assert.deepEqual(readFileSync(path.join(agent.workspaceDir, file.relativePath)), bytes);
    // Invalid Hub generation/proof cannot bypass the original transport guard.
    assert.equal(
      (
        await fetch(`${agent.pageUrl}${empty.url}`, {
          method: "PUT",
          headers: { "x-pi-web-generation": "stale", "x-pi-web-proof": "invalid" },
        })
      ).status,
      409,
    );
  });
}

// In-process real Pi SDK lets the test hold compaction/input hooks and observe
// runner.onError, which is deliberately not available to mirror-server itself.
// All provider/model work stays on the same isolated faux provider as RPC tests.
test("real Pi: compaction refusal is retryable; async dispatch failure never ACKs or replays receipts", {
  timeout: 45000,
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-upload-acceptance-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const env = {
    PI_OFFLINE: "1",
    PI_WEB_UI_HOST: "127.0.0.1",
    PI_WEB_UI_PORT: String(port),
    PI_WEB_UI_DISABLED: "false",
    PI_WEB_UI_PUBLIC_URL: "",
    PI_WEB_UI_REGISTRY_SOCKET: "",
    PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: "",
    PI_WEB_UI_STATIC_DIR: path.join(runtimeRoot, "dist"),
    PI_WEB_UI_E2E_FIXTURE: "chat-lifecycle",
  };
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  let api!: ExtensionAPI;
  let releaseCompaction!: () => void;
  let enteredCompaction!: () => void;
  const compactionEntered = new Promise<void>((resolve) => {
    enteredCompaction = resolve;
  });
  const compactionGate = new Promise<void>((resolve) => {
    releaseCompaction = resolve;
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      path.join(repositoryRoot, "e2e/fixtures/faux-provider-extension.ts"),
      path.join(runtimeRoot, "extensions/mirror-server.ts"),
    ],
    extensionFactories: [
      (pi) => {
        api = pi;
        pi.on("session_before_compact", async () => {
          enteredCompaction();
          await compactionGate;
          return { cancel: true };
        });
      },
    ],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  t.after(async () => {
    releaseCompaction();
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });
  const runtimeErrors: string[] = [];
  await session.bindExtensions({
    mode: "rpc",
    onError: (event) => {
      runtimeErrors.push(`${event.event}: ${event.error}`);
    },
  });
  const model = modelRuntime.getModel("faux", "faux-1");
  assert.ok(model);
  await session.setModel(model);
  await session.prompt("Seed a real conversation for compaction");
  await session.prompt("Another turn to leave compactable history");
  const base = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base });
  t.after(() => socket.terminate());
  const replies = new Map<string, (response: { ok: boolean; error?: string; result?: unknown }) => void>();
  let userStarts = 0;
  const scope = await new Promise<{ sessionId: string; runtimeId: string }>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "event" && event.event === "state_sync") resolve(event.payload);
      if (event.type === "event" && event.event === "message_start" && event.payload.message.role === "user")
        userStarts++;
      if (event.type === "res") replies.get(event.id)?.(event);
    });
  });
  let sequence = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ ok: boolean; error?: string; result?: unknown }>((resolve, reject) => {
      const id = `accept-${++sequence}`;
      const timer = setTimeout(() => reject(new Error("Missing response")), 12000);
      replies.set(id, (result) => {
        clearTimeout(timer);
        replies.delete(id);
        resolve(result);
      });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const prepared = await request("prepare_upload", { ...scope, filename: "recoverable.txt", size: 0 });
  assert.equal(prepared.ok, true);
  const upload = prepared.result as Prepared;
  assert.equal(
    (
      await fetch(`${base}${upload.url}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": "0" },
      })
    ).status,
    200,
  );
  const compacting = session.compact().catch(() => {});
  await Promise.race([
    compactionEntered,
    compacting.then(() => {
      throw new Error("Compaction never reached hook");
    }),
  ]);
  assert.equal(session.isIdle, false);
  // This is a real compaction refusal, not executePiCommand policy.
  const refused = await request("prompt", { ...scope, uploads: [upload.uploadId], message: "Busy attachment" });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /compaction/);
  assert.equal(userStarts, 0);
  releaseCompaction();
  await compacting;
  const accepted = await request("prompt", { ...scope, uploads: [upload.uploadId], message: "Retry after compaction" });
  assert.equal(accepted.ok, true);
  assert.equal(userStarts, 1, "ACK must follow the actual matching user event");
  await session.waitForIdle();
  const second = await request("prepare_upload", { ...scope, filename: "unknown.txt", size: 0 });
  const unknown = second.result as Prepared;
  assert.equal(
    (
      await fetch(`${base}${unknown.url}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": "0" },
      })
    ).status,
    200,
  );
  // An auth resolution failure before dispatch leaves the same receipt retryable.
  const providerConfig = modelRuntime.getRegisteredProviderConfig("faux");
  assert.ok(providerConfig);
  modelRuntime.registerProvider("faux", { ...providerConfig, apiKey: "!exit 1", authHeader: true });
  const authRefused = await request("prompt", { ...scope, uploads: [unknown.uploadId], message: "Auth preflight" });
  assert.equal(authRefused.ok, false);
  assert.match(authRefused.error ?? "", /authentication failed/);
  assert.equal(userStarts, 1);
  modelRuntime.registerProvider("faux", providerConfig);
  await modelRuntime.refresh({ allowNetwork: false });
  // Remove the synthetic provider inside input, AFTER mirror's auth preflight.
  // Pi's async model/auth validation fails and only runner.onError sees it.
  const unsubscribe = api.on("input", async (event) => {
    if (event.text.includes("FAIL_UPLOAD_AUTH")) {
      modelRuntime.unregisterProvider("faux");
      await modelRuntime.refresh({ allowNetwork: false });
    }
  });
  const result = await request("prompt", { ...scope, uploads: [unknown.uploadId], message: "FAIL_UPLOAD_AUTH" });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /acceptance is unknown/);
  unsubscribe();
  const retry = await request("prompt", { ...scope, uploads: [unknown.uploadId], message: "Must not duplicate" });
  assert.equal(retry.ok, false);
  assert.match(retry.error ?? "", /Do not resend/);
  assert.equal(userStarts, 1);
  assert.equal(readFileSync(path.join(cwd, unknown.relativePath)).length, 0);
  assert.ok(
    runtimeErrors.some((error) => error.startsWith("send_user_message:")),
    "must exercise Pi's real async failure channel",
  );
});
