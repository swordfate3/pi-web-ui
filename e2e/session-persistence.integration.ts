// Characterization of real Pi persistence and read-only Web session entry.
// All generated state stays inside dedicated temporary homes and agent dirs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startPiWebUi } from "./harness/pi-process.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function sessionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? sessionFiles(file) : entry.name.endsWith(".jsonl") ? [file] : [];
    })
    .sort();
}

test("print mode persists from a temporary cwd; explicit no-session leaves its isolated agent session-free", {
  timeout: 60_000,
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-print-persistence-"));
  try {
    const run = (name: string, ephemeral: boolean) => {
      const home = path.join(root, name, "home");
      const agent = path.join(root, name, "agent");
      const cwd = path.join(root, name, "workspace");
      for (const dir of [home, agent, cwd]) mkdirSync(dir, { recursive: true });
      const runtime = process.env.PI_E2E_RUNTIME_DIR || repositoryRoot;
      const result = spawnSync(
        process.env.PI_E2E_BIN || path.join(runtime, "node_modules/.bin/pi"),
        [
          "--print",
          ...(ephemeral ? ["--no-session"] : []),
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--extension",
          path.join(repositoryRoot, "e2e/fixtures/faux-provider-extension.ts"),
          "--model",
          "faux/faux-1",
          "--api-key",
          "faux-key",
          "SYNTHETIC_PERSISTENCE_PROBE",
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 25_000,
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            PI_CODING_AGENT_DIR: agent,
            PI_CODING_AGENT_SESSION_DIR: path.join(agent, "sessions"),
            PI_E2E: "1",
            PI_OFFLINE: "1",
            PI_WEB_UI_DISABLED: "true",
            PI_WEB_UI_REGISTRY_SOCKET: "",
            PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: "",
            PI_WEB_UI_E2E_FIXTURE: "chat-lifecycle",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Pi Web UI/, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
      return sessionFiles(agent);
    };
    assert.equal(run("ordinary-print", false).length, 1, "--print is not an ephemeral-session flag");
    assert.deepEqual(run("ephemeral-print", true), [], "the probe must not save any session JSONL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function eventually<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

type Frame = {
  type?: string;
  event?: string;
  id?: string;
  ok?: boolean;
  error?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

test("repeated Web entry, health and saved-session resume do not create extra persisted sessions", {
  timeout: 90_000,
}, async () => {
  let ends = 0;
  const harness = await startPiWebUi("chat-lifecycle", {
    repositoryRoot,
    git: false,
    onRpcEvent: (event) => {
      if (event.type === "agent_end") ends++;
    },
  });
  const sockets: WebSocket[] = [];
  let sequence = 0;
  async function connect() {
    const frames: Frame[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`);
    sockets.push(ws);
    let connectionError: Error | undefined;
    ws.on("error", (error) => {
      connectionError = error;
    });
    ws.on("close", () => {
      connectionError ??= new Error("Mirror replaced before snapshot");
    });
    ws.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
    const sync = await eventually(() => {
      const frame = frames.find((frame) => frame.event === "state_sync");
      if (!frame && connectionError) throw connectionError;
      return frame;
    }, "initial snapshot");
    assert.ok(sync.payload?.sessionId);
    return {
      ws,
      frames,
      scope: { sessionId: sync.payload.sessionId, runtimeId: sync.payload.runtimeId },
      async send(method: string, params: Record<string, unknown> = {}) {
        const id = `persistence-${++sequence}`;
        ws.send(JSON.stringify({ type: "req", id, method, params }));
        const response = await eventually(
          () => frames.find((frame) => frame.type === "res" && frame.id === id),
          method,
        );
        assert.equal(response.ok, true, response.error);
        return response.result;
      },
    };
  }
  async function prompt(message: string) {
    const before = ends;
    await harness.rpc({ type: "prompt", message });
    await eventually(() => (ends > before ? true : undefined), "synthetic turn completion");
  }
  try {
    await prompt("SYNTHETIC_SESSION_ONE");
    let client = await connect();
    const first = client.scope.sessionId;
    client.ws.terminate();
    await harness.rpc({ type: "new_session" });
    await prompt("SYNTHETIC_SESSION_TWO");
    client = await connect();
    const second = client.scope.sessionId;
    assert.notEqual(first, second);
    client.ws.terminate();
    const files = sessionFiles(harness.sessionDir);
    assert.equal(files.length, 2, "only the two explicitly seeded conversations should exist");
    const contents = files.map((file) => readFileSync(file, "utf8"));
    for (const target of [first, second, first]) {
      client = await connect();
      await client.send("health");
      await client.send("sync_request", client.scope);
      await harness.rpc({ type: "prompt", message: "/webui" });
      await eventually(
        () =>
          client.frames.some((frame) => frame.event === "webui_state" && frame.payload?.advancedFeatures)
            ? true
            : undefined,
        "command context ready",
      );
      const listing = await client.send("get_saved_sessions", client.scope);
      const saved = listing?.sessions as { id: string; sessionId: string }[];
      assert.equal(saved.length, 2);
      const selection = saved.find((session) => session.sessionId === target);
      assert.ok(selection);
      await client.send("switch_session", { id: selection.id, sessionId: client.scope.sessionId });
      client.ws.terminate();
      // The session action disposes the old mirror asynchronously. Re-enter only
      // when the actual new runtime is visible, without replaying the action.
      const deadline = Date.now() + 15_000;
      while (true) {
        try {
          const resumed = await connect();
          resumed.ws.terminate();
          if (resumed.scope.sessionId === target) break;
        } catch {
          // A real session replacement has a brief interval with no listener.
          // Retry the read-only connection, never the switch_session request.
        }
        assert.ok(Date.now() < deadline, "resume must activate the selected saved session");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(sessionFiles(harness.sessionDir), files, "entry and resume must not add session files");
      assert.deepEqual(
        files.map((file) => readFileSync(file, "utf8")),
        contents,
        "read-only entry/resume must not append conversation data",
      );
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    await harness.stop();
  }
});
