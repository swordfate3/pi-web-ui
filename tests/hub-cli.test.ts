import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/pi-web-hub.mjs", import.meta.url));
test("CLI initializes once and issues private individual credentials without printing tokens", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, "--config", config], { encoding: "utf8" });
  assert.equal(run("init", "--port", "0").status, 0);
  assert.notEqual(run("init").status, 0, "existing configuration must not be overwritten");
  const file = path.join(dir, "session.json");
  const result = run("issue", "--output", file, "--label", "Project A");
  assert.equal(result.status, 0, result.stderr);
  const credential = JSON.parse(readFileSync(file, "utf8"));
  assert.match(credential.token, /^[a-f0-9]{64}$/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(credential.token));
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(run("revoke", "--run-id", credential.run_id).status, 0);
  const grant = JSON.parse(readFileSync(path.join(dir, "state", "grants", `${credential.run_id}.json`), "utf8"));
  assert.equal(grant.revoked, true);
  assert.notEqual(run("issue", "--output", file, "--label", "B").status, 0);
  assert.notEqual(run("serve", "--unknown", "secret-value").status, 0);
});

test("standalone hub serves a portal and shuts down cleanly on SIGTERM", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-cli-"));
  const config = path.join(dir, "config.json");
  assert.equal(spawnSync(process.execPath, [cli, "init", "--config", config, "--port", "0"]).status, 0);
  const child = spawn(process.execPath, [cli, "serve", "--config", config], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const ready = await new Promise<{ localUrl: string }>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Hub stopped before ready")));
  });
  const response = await fetch(`${ready.localUrl}sessions/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Pi/);
  // A hostile peer need not finish its TCP write half after a rejected upgrade.
  const address = new URL(ready.localUrl);
  const peer = net.createConnection({ host: address.hostname, port: Number(address.port), allowHalfOpen: true });
  t.after(() => peer.destroy());
  await new Promise<void>((resolve, reject) => {
    peer.once("error", reject);
    peer.once("data", () => resolve());
    peer.once("connect", () =>
      peer.write(
        `GET /s/${"f".repeat(32)}/ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${address.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      ),
    );
  });
  const closed = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("shutdown blocked by rejected upgrade"), 2000);
        }),
      ]),
      0,
    );
  } finally {
    clearTimeout(timer);
    peer.destroy();
  }
});
