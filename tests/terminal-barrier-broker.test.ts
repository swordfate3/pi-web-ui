import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
type Frame = {
  id?: number;
  type?: string;
  ready?: boolean;
  ok?: boolean;
  blocked?: boolean;
  latched?: boolean;
  result?: Frame;
};
async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("broker fixture checkpoint timed out");
}
function frames(stream: Duplex) {
  const received: Frame[] = [];
  let data = "";
  stream.on("data", (chunk: Buffer) => {
    data += chunk.toString();
    let end = data.indexOf("\n");
    while (end >= 0) {
      received.push(JSON.parse(data.slice(0, end)));
      data = data.slice(end + 1);
      end = data.indexOf("\n");
    }
  });
  return received;
}

for (const scenario of ["drain", "timeout", "unknown"] as const) {
  test(`actual broker and adapter ${scenario} preparation preserves the handoff contract`, {
    timeout: 15000,
  }, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pi-barrier-broker-"));
    const adapter = fork(path.join(root, "tests/fixtures/terminal-barrier-adapter.ts"), [directory], {
      execArgv: ["--import", path.join(root, "tests/register-ts.mjs")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const messages: Frame[] = [];
    adapter.on("message", (message: Frame) => messages.push(message));
    let sequence = 0;
    const control = async (action: string) => {
      const id = ++sequence;
      adapter.send({ id, action });
      return until(() => messages.find((message) => message.id === id));
    };
    let broker: ReturnType<typeof spawn> | undefined;
    let peer: net.Socket | undefined;
    try {
      await until(() => messages.find((message) => message.ready));
      const bundle = path.join(directory, "broker.cjs");
      await build({
        entryPoints: [path.join(root, "runtime/terminal/broker.ts")],
        outfile: bundle,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "cjs",
        logLevel: "silent",
      });
      broker = spawn(process.execPath, [bundle, "3", "4"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
      const relay = broker.stdio[4] as Duplex;
      const relayFrames = frames(relay);
      const target = {
        v: 1,
        runId: "a".repeat(32),
        terminalEpoch: "b".repeat(32),
        runtimeId: "runtime",
        sessionId: "session",
        profile: "web-terminal-v1",
        inputState: "none",
        managedRestartEligible: false,
      };
      relay.write(
        `${JSON.stringify({
          type: "start",
          directory,
          runId: target.runId,
          terminalEpoch: target.terminalEpoch,
          childToken: "c".repeat(64),
          owner: "none",
          columns: 80,
          rows: 24,
        })}\n`,
      );
      await until(() => relayFrames.find((frame) => frame.type === "started"));
      // Allow the production broker's first adapter discovery/heartbeat to run.
      await new Promise((resolve) => setTimeout(resolve, 120));
      peer = net.createConnection(path.join(directory, "terminal.sock"));
      const responses = frames(peer);
      await once(peer, "connect");
      peer.write(
        `${JSON.stringify({
          v: 1,
          op: "connect",
          scope: "write",
          target,
          binding: { authorizationId: "d".repeat(32), connectionId: "e".repeat(32) },
        })}\n`,
      );
      await until(() => responses.find((frame) => frame.type === "ready"));
      let requestId = 0;
      const request = (type: string, fields = {}) => {
        const id = ++requestId;
        peer?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
        return until(() => responses.find((frame) => frame.type === "response" && frame.id === id)?.result);
      };
      await control(scenario === "unknown" ? "unknown" : "admit");
      const start = performance.now();
      const acquiring = request("acquire");
      if (scenario === "drain") {
        while (!(await control("state")).blocked) assert.ok(performance.now() - start < 200);
        assert.equal((await control("write")).ok, false);
        assert.equal((await control("state")).latched, false);
        await control("finish");
      }
      const acquired = await acquiring;
      assert.ok(performance.now() - start < 500, "composition must fit the unchanged broker adapter deadline");
      assert.equal(acquired.ok, scenario === "drain");
      if (scenario !== "drain") {
        assert.equal((await control("write")).ok, true, "failed acquire must preserve browser admission");
        assert.equal((await control("state")).latched, false);
        if (scenario === "unknown") {
          assert.equal((await request("acquire")).ok, false, "unknown was not cleared by rejection or another write");
          return;
        }
        await control("finish");
        assert.equal((await request("acquire")).ok, true, "explicit retry can succeed after real tracked completion");
      }
      assert.equal((await control("write")).ok, false);
      assert.equal((await control("state")).latched, true);
      assert.equal((await request("release")).ok, true);
      assert.equal((await control("write")).ok, false, "release cannot restore committed browser writes");
    } finally {
      peer?.destroy();
      const children = [broker, adapter].filter((child) => child !== undefined);
      const exits = children.map((child) =>
        child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit"),
      );
      for (const child of children) child.kill("SIGTERM");
      const deadline = setTimeout(() => {
        for (const child of children) child.kill("SIGKILL");
      }, 1000);
      await Promise.all(exits);
      clearTimeout(deadline);
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
