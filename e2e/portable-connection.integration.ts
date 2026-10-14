// Backend integration only; browser product E2E is the Playwright-BDD suite.
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const credential = { run_id: "1".repeat(32), token: "2".repeat(64) };
const proof = (text: string) => createHmac("sha256", credential.token).update(text).digest("hex");

async function eventually(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function fixture(t: test.TestContext, registration: "working" | "missing" | "off") {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-portable-"));
  const agentDir = path.join(dir, "agent");
  const workspaceDir = path.join(dir, "workspace");
  mkdirSync(agentDir);
  mkdirSync(workspaceDir);
  const socketPath = path.join(dir, "registry.sock");
  const credentialFile = path.join(dir, "capability.json");
  writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  const requests: Record<string, unknown>[] = [];
  const sockets = new Set<net.Socket>();
  const registry = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.split("\n")[0]);
      requests.push(request);
      socket.end(
        `${JSON.stringify({ ok: true, result: { url: `https://gateway.example/s/${request.generation}/` } })}\n`,
      );
    });
  });
  if (registration === "working") await new Promise<void>((resolve) => registry.listen(socketPath, resolve));
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  let child: ChildProcessWithoutNullStreams | undefined;
  const output: string[] = [];
  const closed = () =>
    new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  t.after(async () => {
    const exited = closed();
    child?.kill("SIGTERM");
    await exited;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => registry.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  const start = () => {
    child = spawn(
      process.env.PI_E2E_BIN || path.join(root, "node_modules/.bin/pi"),
      [
        "--mode",
        "rpc",
        "--model",
        "faux/faux-1",
        "--api-key",
        "faux-key",
        "--approve",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--extension",
        path.join(root, "e2e/fixtures/faux-provider-extension.ts"),
        "--extension",
        path.join(root, "e2e/fixtures/connection-lifecycle-extension.ts"),
        "--extension",
        path.join(root, "extensions/mirror-server.ts"),
      ],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_E2E: "1",
          PI_WEB_UI_HOST: "127.0.0.1",
          PI_WEB_UI_PORT: String(port),
          PI_WEB_UI_DISABLED: "false",
          PI_WEB_UI_STATIC_DIR: path.join(root, "dist"),
          PI_WEB_UI_PUBLIC_URL: undefined,
          PI_WEB_UI_REGISTRY_SOCKET: registration === "off" ? undefined : socketPath,
          PI_WEB_UI_REGISTRY_CREDENTIAL_FILE: registration === "off" ? undefined : credentialFile,
        },
      },
    );
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));
    child.on("error", (error) => output.push(error.message));
  };
  const send = (message: string) => {
    if (!child) throw new Error("Pi test process is not started");
    child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  };
  const ready = async (actualPort = port) =>
    eventually(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${actualPort}/`)).ok;
        } catch {
          return false;
        }
      },
      `Pi Web did not start: ${output.join("").slice(-2000)}`,
    );
  return { port, start, send, ready, requests, closed, stop: () => child?.kill("SIGTERM") };
}

test("real Pi registers natively, guards WebSockets, and unregisters on stop", { timeout: 30_000 }, async (t) => {
  const pi = await fixture(t, "working");
  pi.start();
  await pi.ready();
  await eventually(() => pi.requests.length > 0, "No native registration request received");
  assert.equal(pi.requests[0].port, pi.port);
  const generation = String(pi.requests[0].generation);
  const challenge = "3".repeat(48);
  const identity = await fetch(`http://127.0.0.1:${pi.port}/.pi-web-identity`, {
    headers: {
      "x-pi-web-challenge": challenge,
      "x-pi-web-challenge-proof": proof(challenge),
    },
  });
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { generation, proof: proof(`${challenge}:${generation}`) });
  const blocked = new WebSocket(`ws://127.0.0.1:${pi.port}/ws`, { headers: { "x-pi-web-generation": "4".repeat(32) } });
  await new Promise<void>((resolve, reject) => {
    blocked.once("error", () => resolve());
    blocked.once("open", () => {
      blocked.close();
      reject(new Error("Wrong generation upgraded"));
    });
  });
  const allowed = new WebSocket(`ws://127.0.0.1:${pi.port}/ws`, {
    headers: {
      "x-pi-web-generation": generation,
      "x-pi-web-proof": proof(generation),
    },
  });
  await new Promise<void>((resolve, reject) => {
    allowed.once("message", () => resolve());
    allowed.once("error", reject);
  });
  allowed.close();
  pi.send("/webui-stop");
  await eventually(() => pi.requests.some((value) => value.action === "unregister"), "Stop did not unregister");
  pi.send("/webui-start");
  await pi.ready();
  await eventually(
    () => pi.requests.filter((value) => value.action === "register").length >= 2,
    "Restart did not register",
  );
  const next = pi.requests.filter((value) => value.action === "register")[1];
  assert.notEqual(next.generation, generation);
  pi.send("/connection-test-reload");
  await eventually(
    () => pi.requests.filter((value) => value.action === "register").length >= 3,
    "Reload did not register a fresh generation",
  );
  const reloaded = pi.requests.filter((value) => value.action === "register")[2];
  assert.notEqual(reloaded.generation, next.generation);
  assert.equal(pi.requests.filter((value) => value.action === "unregister").length, 2);
  await pi.ready();
  const exited = pi.closed();
  pi.stop();
  await exited;
  assert.equal(pi.requests.at(-1)?.action, "unregister");
});

test("real Pi remains locally usable when configured registry is missing", { timeout: 20_000 }, async (t) => {
  const pi = await fixture(t, "missing");
  pi.start();
  await pi.ready();
  assert.equal((await fetch(`http://127.0.0.1:${pi.port}/`)).status, 200);
});

test("real Pi advances an occupied port without registration", { timeout: 20_000 }, async (t) => {
  const pi = await fixture(t, "off");
  const occupied = http.createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((resolve) => occupied.listen(pi.port, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        occupied.closeAllConnections();
        occupied.close(() => resolve());
      }),
  );
  pi.start();
  await pi.ready(pi.port + 1);
  assert.equal((await fetch(`http://127.0.0.1:${pi.port}/`)).status, 503);
});
