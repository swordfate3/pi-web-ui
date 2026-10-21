import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeHub, issueSession, readHubConfig, revokeSession } from "../hub/config.ts";
import { HubManagement, issueManagementCode } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";
import { storageDiagnostics, withStateWriter } from "../hub/state-budget.ts";
import { HubTerminalAuth, issueTerminalCode, revokeTerminal } from "../hub/terminal-auth.ts";
import { startTerminalServer } from "../hub/terminal-server.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hub-terminal-"));
  const file = path.join(dir, "hub.json");
  initializeHub(file, { port: 0, management: { port: 0 }, terminal: { port: 0 } });
  const config = readHubConfig(file);
  const credential = issueSession(config, path.join(dir, "run.json"), { label: "Synthetic fixture" });
  const scope = {
    runId: credential.run_id,
    runtimeId: "fixture-runtime",
    sessionId: "fixture-session",
    terminalEpoch: "a".repeat(32),
    access: "write" as "read" | "write",
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file, config, scope };
}
function cookieHeader(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";")[0];
}
function request(cookie = "", csrf?: string) {
  return { headers: { cookie, ...(csrf ? { "x-pi-hub-terminal-csrf": csrf } : {}) } } as http.IncomingMessage;
}
function session(t: test.TestContext, access: "read" | "write" = "write") {
  const f = fixture(t);
  let now = 100;
  const auth = new HubTerminalAuth(f.config, () => now);
  const pairing = issueTerminalCode(f.config, { ...f.scope, access }, now);
  const unlocked = auth.unlock(pairing.code);
  const cookie = unlocked.cookie.split(";")[0];
  return { ...f, auth, unlocked, cookie, pairing, setTime: (value: number) => (now = value) };
}

async function live(t: test.TestContext) {
  const f = fixture(t);
  const hub = await startHub(f.config);
  t.after(() => hub.close());
  assert.ok(hub.terminalUrl);
  const origin = new URL(hub.terminalUrl).origin;
  const post = (route: string, value: unknown, extra: Record<string, string> = {}) =>
    fetch(hub.terminalUrl + route, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...extra },
      body: JSON.stringify(value),
    });
  return { ...f, hub, origin, post };
}

test("terminal scope is exact and pairing requires a configured listener and existing run", (t) => {
  const { config, scope } = fixture(t);
  for (const value of [
    { ...scope, command: "arbitrary" },
    { ...scope, access: "admin" },
    { ...scope, terminalEpoch: "" },
    { ...scope, runtimeId: "\n" },
    { ...scope, sessionId: "" },
    { ...scope, runId: "b".repeat(32) },
  ])
    assert.throws(() => issueTerminalCode(config, value));
  assert.throws(() => issueTerminalCode({ ...config, terminal: undefined }, scope), /disabled/);
});

test("pairing stores only a digest and explicit child scope; code is single-use", (t) => {
  const { auth, config, scope, pairing, cookie, unlocked } = session(t);
  assert.throws(() => auth.unlock(pairing.code), /rejected/);
  const state = readFileSync(path.join(config.stateDir, "terminal-auth.json"), "utf8");
  assert.ok(!state.includes(pairing.code));
  assert.ok(!state.includes(cookie.split("=")[1]));
  assert.equal(statSync(path.join(config.stateDir, "terminal-auth.json")).mode & 0o077, 0);
  assert.deepEqual(auth.status(request(cookie)), {
    authorized: true,
    csrf: unlocked.csrf,
    expiresAt: unlocked.expiresAt,
    scope,
  });
  assert.match(unlocked.cookie, /HttpOnly; SameSite=Strict/);
  const copy = auth.authorize(request(cookie));
  copy.scope.runId = "changed";
  assert.equal(auth.authorize(request(cookie)).scope.runId, scope.runId);
});

test("wrong-code attempts lock pairing; expired/revoked codes cannot be redeemed", (t) => {
  const { config, scope } = fixture(t);
  let now = 100;
  const auth = new HubTerminalAuth(config, () => now);
  const first = issueTerminalCode(config, scope, now);
  for (let i = 0; i < 10; i++) assert.throws(() => auth.unlock("wrong"));
  assert.throws(() => auth.unlock(first.code));
  const second = issueTerminalCode(config, scope, now);
  now = second.expiresAt;
  assert.throws(() => auth.unlock(second.code));
  const third = issueTerminalCode(config, scope, now);
  revokeTerminal(config);
  assert.throws(() => auth.unlock(third.code));
});

test("read scope never becomes write authority; CSRF token is distinct from management", (t) => {
  const { auth, cookie, unlocked } = session(t, "read");
  assert.ok(auth.authorize(request(cookie), false, "read"));
  assert.throws(() => auth.authorize(request(cookie), false, "write"), /authorization required/);
  assert.throws(() => auth.authorize(request(cookie, "wrong"), true));
  assert.throws(() => auth.authorize(request(cookie), true));
  assert.ok(auth.authorize(request(cookie, unlocked.csrf), true, "read"));
  const scoped = auth.authorizeTarget(request(cookie, unlocked.csrf), auth.authorize(request(cookie)).scope);
  assert.equal(scoped.scope.access, "read");
  for (const key of ["runId", "runtimeId", "sessionId", "terminalEpoch"])
    assert.throws(() => auth.authorizeTarget(request(cookie, unlocked.csrf), { ...scoped.scope, [key]: "wrong" }));
  assert.equal(auth.status(request(`${cookie}; ${cookie}`)).authorized, false);
});

test("management/terminal credentials are not interchangeable in either direction", (t) => {
  const { auth, cookie, config } = session(t);
  const management = new HubManagement(config);
  const code = issueManagementCode(config).code;
  assert.throws(() => auth.unlock(code));
  const unlocked = management.unlock(code);
  assert.equal(auth.status(request(unlocked.cookie)).authorized, false);
  assert.equal(management.status(request(cookie)).authorized, false);
  const terminalCode = issueTerminalCode(config, auth.authorize(request(cookie)).scope).code;
  assert.throws(() => management.unlock(terminalCode));
  assert.ok(auth.unlock(terminalCode));
});

test("session timeout, CLI revocation and run grant revocation invalidate existing sessions", (t) => {
  const f = session(t);
  const expected = f.auth.authorize(request(f.cookie));
  f.setTime(f.unlocked.expiresAt);
  assert.equal(f.auth.status(request(f.cookie)).authorized, false);
  assert.throws(() => f.auth.revalidate(request(f.cookie), expected));
  const code = issueTerminalCode(f.config, f.scope, f.unlocked.expiresAt);
  const unlocked = f.auth.unlock(code.code);
  const cookie = unlocked.cookie.split(";")[0];
  revokeTerminal(f.config);
  assert.equal(f.auth.status(request(cookie)).authorized, false);
  const next = issueTerminalCode(f.config, f.scope, f.unlocked.expiresAt);
  const nextCookie = f.auth.unlock(next.code).cookie;
  revokeSession(f.config, f.scope.runId);
  assert.equal(f.auth.status(request(nextCookie)).authorized, false);
  assert.throws(() => issueTerminalCode(f.config, f.scope), /revoked/);
});

test("logout requires terminal CSRF and clears only that browser session", (t) => {
  const { auth, cookie, config, scope, unlocked } = session(t);
  const next = auth.unlock(issueTerminalCode(config, scope, 100).code);
  assert.throws(() => auth.logout(request(cookie)));
  assert.match(auth.logout(request(cookie, unlocked.csrf)), /Max-Age=0/);
  assert.equal(auth.status(request(cookie)).authorized, false);
  assert.equal(auth.status(request(next.cookie)).authorized, true);
  auth.close();
  assert.equal(auth.status(request(next.cookie)).authorized, false);
});

test("corrupt or non-private persisted state fails closed without granting a session", (t) => {
  const { auth, config, cookie } = session(t);
  writeFileSync(path.join(config.stateDir, "terminal-auth.json"), "{}", { mode: 0o600 });
  assert.equal(auth.status(request(cookie)).authorized, false);
  assert.throws(() => auth.unlock("a".repeat(32)));
});

test("terminal uses a third listener and explicitly reports backend unavailable", async (t) => {
  const { hub, config, scope, post } = await live(t);
  assert.notEqual(hub.terminalUrl, hub.url);
  assert.notEqual(hub.terminalUrl, hub.managementUrl);
  const status = await fetch(`${hub.terminalUrl}api/terminal/status`);
  assert.deepEqual(await status.json(), {
    authorized: false,
    available: false,
    reason: "terminal_backend_unavailable",
  });
  assert.equal(status.headers.get("access-control-allow-origin"), null);
  assert.match(status.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const code = issueTerminalCode(config, scope).code;
  const unlocked = await post("api/terminal/unlock", { code });
  assert.equal(unlocked.status, 200);
  const cookie = cookieHeader(unlocked);
  const withAuth = await fetch(`${hub.terminalUrl}api/terminal/status`, { headers: { Cookie: cookie } });
  const value = await withAuth.json();
  assert.equal(value.authorized, true);
  assert.equal(value.available, false, "pairing must not pretend a terminal exists");
  assert.deepEqual(value.scope, scope);
  assert.equal((await post("api/terminal/attach", {}, { Cookie: cookie })).status, 404);
  assert.equal((await post("api/terminal/logout", {}, { Cookie: cookie })).status, 403);
  assert.equal(
    (await post("api/terminal/logout", {}, { Cookie: cookie, "X-Pi-Hub-Terminal-Csrf": value.csrf })).status,
    200,
  );
});

test("chat and management cannot pair/read terminal authority even when cookie is delivered", async (t) => {
  const { hub, config, scope, post } = await live(t);
  const code = issueTerminalCode(config, scope).code;
  const response = await post("api/terminal/unlock", { code });
  const cookie = cookieHeader(response);
  assert.ok(hub.managementUrl);
  for (const base of [hub.url, hub.managementUrl]) {
    for (const route of ["api/terminal/status", "api/terminal/unlock", "api/terminal/logout"]) {
      const res = await fetch(base + route, { headers: { Cookie: cookie } });
      assert.notEqual(res.status, 200, `${base}${route}`);
      assert.ok(!(await res.text()).includes(cookie.split("=")[1]));
    }
    assert.equal((await post("api/terminal/unlock", { code }, { Origin: new URL(base).origin })).status, 403);
    const cross = await fetch(`${hub.terminalUrl}api/terminal/status`, {
      headers: { Cookie: cookie, Origin: new URL(base).origin },
    });
    assert.equal(cross.status, 403);
  }
});

test("terminal rejects bad Host, missing/cross Origin writes, worker routes and all Pi content", async (t) => {
  const { hub, config, scope, post } = await live(t);
  const code = issueTerminalCode(config, scope).code;
  const body = JSON.stringify({ code });
  const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request(
      `${hub.terminalUrl}api/terminal/unlock`,
      {
        method: "POST",
        headers: {
          Host: new URL(hub.url).host,
          Origin: new URL(hub.terminalUrl ?? "").origin,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await post("api/terminal/unlock", { code }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal(
    (
      await fetch(`${hub.terminalUrl}api/terminal/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
    ).status,
    403,
  );
  for (const route of [
    "/",
    "/sessions/",
    "/hub.js",
    "/sw.js",
    `/s/${"a".repeat(32)}/`,
    "/api/management/status",
    "/api/terminal/status?alias=1",
    "/ws",
  ])
    assert.equal((await fetch(new URL(route, hub.terminalUrl))).status, 404, route);
  assert.equal(
    (await fetch(`${hub.terminalUrl}api/terminal/status`, { headers: { "Service-Worker": "script" } })).status,
    403,
  );
  assert.equal((await post("api/terminal/unlock", { code })).status, 200, "rejected requests did not consume pairing");
});

test("unlock has bounded exact JSON request schema and does not echo invalid values", async (t) => {
  const { post, config, scope } = await live(t);
  const code = issueTerminalCode(config, scope).code;
  for (const value of [{ code, command: "PRIVATE_FIXTURE" }, [], null, { code: "PRIVATE_FIXTURE" }]) {
    const response = await post("api/terminal/unlock", value);
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes("PRIVATE_FIXTURE"));
  }
  assert.equal((await post("api/terminal/unlock", { code: "x".repeat(2048) })).status, 413);
  assert.equal((await post("api/terminal/unlock", { code })).status, 200);
});

test("terminal rejects Upgrade/CONNECT rather than exposing a raw tunnel", { timeout: 5000 }, async (t) => {
  const { hub } = await live(t);
  assert.ok(hub.terminalUrl);
  const address = new URL(hub.terminalUrl);
  for (const text of [
    `GET /ws HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${address.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    `CONNECT arbitrary.invalid:22 HTTP/1.1\r\nHost: ${address.host}\r\n\r\n`,
  ]) {
    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: address.hostname, port: Number(address.port) });
      let data = "";
      socket.on("error", reject);
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.once("close", () => resolve(data));
      socket.once("connect", () => socket.end(text));
    });
    assert.ok(!received.includes("101 Switching"));
    assert.ok(!received.includes("200"));
  }
});

test("configuration rejects shared ports/origins, HTTP public terminal and unknown target settings", (t) => {
  const { file } = fixture(t);
  const base = {
    port: 16180,
    publicUrl: "https://chat.example/",
    management: { port: 16181, publicUrl: "https://admin.example/" },
  };
  for (const terminal of [
    { port: 16180 },
    { port: 16181 },
    { port: -1 },
    { port: 65536 },
    { port: 0, publicUrl: "https://chat.example/" },
    { port: 0, publicUrl: "https://admin.example/" },
    { port: 0, publicUrl: "http://terminal.example/" },
    { port: 0, publicUrl: "https://terminal.example/nested/" },
    { port: 0, host: "0.0.0.0" },
    { port: 0, endpoint: "http://arbitrary.invalid/" },
  ]) {
    writeFileSync(file, JSON.stringify({ ...base, terminal }), { mode: 0o600 });
    assert.throws(() => readHubConfig(file));
  }
  writeFileSync(file, JSON.stringify({ ...base, terminal: { port: 0, publicUrl: "https://terminal.example/" } }), {
    mode: 0o600,
  });
  assert.equal(readHubConfig(file).terminal?.publicUrl, "https://terminal.example/");
});

test("HTTPS terminal cookies use their own __Host name and Secure attribute", (t) => {
  const { config, scope } = fixture(t);
  assert.ok(config.terminal);
  config.terminal.publicUrl = "https://terminal.example/";
  const auth = new HubTerminalAuth(config);
  const result = auth.unlock(issueTerminalCode(config, scope).code);
  assert.match(result.cookie, /^__Host-pi-hub-terminal=/);
  assert.match(result.cookie, /; Secure$/);
});

test("unconfigured Hub has no third listener or terminal authority", async (t) => {
  const { config } = fixture(t);
  delete config.terminal;
  const hub = await startHub(config);
  t.after(() => hub.close());
  assert.equal(hub.terminalUrl, undefined);
  assert.equal((await fetch(`${hub.url}api/terminal/status`)).status, 404);
});

test("effective public/local origin collision is rejected before returning a listener", async (t) => {
  const { config } = fixture(t);
  config.terminal = { port: 0, publicUrl: "https://chat.example/" };
  await assert.rejects(startTerminalServer(config, ["https://chat.example/"]), /must differ/);
});

test("terminal listener startup failure releases Hub listeners and lock for a clean retry", async (t) => {
  const { config } = fixture(t);
  const occupied = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  config.terminal = { port: address.port };
  await assert.rejects(startHub(config), /EADDRINUSE/);
  config.terminal = { port: 0 };
  const hub = await startHub(config);
  await hub.close();
  await hub.close();
});

test("Hub close cancels an in-flight terminal body and closes its sockets", { timeout: 5000 }, async (t) => {
  const { hub } = await live(t);
  assert.ok(hub.terminalUrl);
  const address = new URL(hub.terminalUrl);
  const socket = net.createConnection({ host: address.hostname, port: Number(address.port) });
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    `POST /api/terminal/unlock HTTP/1.1\r\nHost: ${address.host}\r\nOrigin: ${address.origin}\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{`,
  );
  await hub.close();
  await closed;
});

test("terminal auth common lock contention rejects all mutation paths without changing state", (t) => {
  const { config, scope, auth } = fixtureAuth(t);
  const unlocked = auth.unlock(issueTerminalCode(config, scope).code);
  const code = issueTerminalCode(config, scope).code;
  const file = path.join(config.stateDir, "terminal-auth.json");
  const before = readFileSync(file, "utf8");
  const lock = path.join(config.stateDir, ".writer.lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    assert.throws(() => issueTerminalCode(config, scope), /lock busy/);
    assert.throws(() => revokeTerminal(config), /lock busy/);
    assert.throws(() => auth.unlock(code), /lock busy/);
    assert.throws(() => auth.unlock("wrong"), /lock busy/);
    assert.throws(() => auth.logout(request(unlocked.cookie, unlocked.csrf)), /lock busy/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(auth.status(request(unlocked.cookie)).authorized, true);
    assert.ok(existsSync(lock), "a pre-existing lock must never be stolen");
  } finally {
    rmdirSync(lock);
  }
  assert.ok(auth.unlock(code));
});

test("terminal auth common writer fences competing CLI processes", (t) => {
  const { config, file, scope } = fixture(t);
  const code = issueTerminalCode(config, scope).code;
  const before = readFileSync(path.join(config.stateDir, "terminal-auth.json"), "utf8");
  const authUrl = new URL("../hub/terminal-auth.ts", import.meta.url).href;
  const configUrl = new URL("../hub/config.ts", import.meta.url).href;
  withStateWriter(config, () => {
    for (const operation of [
      `issueTerminalCode(config, ${JSON.stringify(scope)})`,
      "revokeTerminal(config)",
      `new HubTerminalAuth(config).unlock(${JSON.stringify(code)})`,
      'new HubTerminalAuth(config).unlock("wrong")',
    ]) {
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import assert from 'node:assert/strict';
        import { readHubConfig } from ${JSON.stringify(configUrl)};
        import { HubTerminalAuth, issueTerminalCode, revokeTerminal } from ${JSON.stringify(authUrl)};
        const config = readHubConfig(${JSON.stringify(file)});
        assert.throws(() => ${operation}, /lock busy/);
      `,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(child.status, 0, child.stderr);
    }
  });
  assert.equal(readFileSync(path.join(config.stateDir, "terminal-auth.json"), "utf8"), before);
  assert.ok(new HubTerminalAuth(config).unlock(code));
});

for (const operation of ["issue", "unlock", "wrong", "revoke"] as const) {
  test(`terminal auth shared budget rejects ${operation} without changing persistent state`, (t) => {
    const { config, scope, auth } = fixtureAuth(t);
    const code = issueTerminalCode(config, scope).code;
    const file = path.join(config.stateDir, "terminal-auth.json");
    const before = readFileSync(file, "utf8");
    const used = storageDiagnostics(config).logicalBytes;
    writeFileSync(path.join(config.stateDir, "private-padding"), Buffer.alloc(8 * 1024 * 1024 - used), { mode: 0o600 });
    const action = {
      issue: () => issueTerminalCode(config, scope),
      unlock: () => auth.unlock(code),
      wrong: () => auth.unlock("wrong"),
      revoke: () => revokeTerminal(config),
    }[operation];
    assert.throws(action, /quota/);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(storageDiagnostics(config).logicalBytes, 8 * 1024 * 1024);
  });
}

test("terminal auth shared budget reserves space for revocation but not new authority", (t) => {
  const { config, scope, auth } = fixtureAuth(t);
  const unlocked = auth.unlock(issueTerminalCode(config, scope).code);
  const used = storageDiagnostics(config).logicalBytes;
  writeFileSync(path.join(config.stateDir, "private-padding"), Buffer.alloc(8 * 1024 * 1024 - 64 * 1024 - used), {
    mode: 0o600,
  });
  assert.throws(() => issueTerminalCode(config, scope), /quota/);
  revokeTerminal(config);
  assert.equal(auth.status(request(unlocked.cookie)).authorized, false);
  assert.ok(storageDiagnostics(config).logicalBytes <= 8 * 1024 * 1024);
});

function fixtureAuth(t: test.TestContext) {
  const f = fixture(t);
  return { ...f, auth: new HubTerminalAuth(f.config) };
}

test("concurrent CLI revocation cannot be overwritten by correct/wrong unlock or CLI issue", (t) => {
  for (const operation of ["correct", "wrong", "issue"]) {
    const { config, file, scope, auth } = fixtureAuth(t);
    const old = auth.unlock(issueTerminalCode(config, scope).code);
    const pair = issueTerminalCode(config, scope);
    const authUrl = new URL("../hub/terminal-auth.ts", import.meta.url).href;
    const configUrl = new URL("../hub/config.ts", import.meta.url).href;
    const revoke = `const {readHubConfig}=await import(${JSON.stringify(configUrl)}); const {revokeTerminal}=await import(${JSON.stringify(authUrl)}); try {revokeTerminal(readHubConfig(${JSON.stringify(file)}));process.stdout.write('revoked');} catch {process.stdout.write('rejected');}`;
    // A separate process pauses logically at the read inside its locked transaction
    // by synchronously attempting a competing CLI revoke. No product test hook.
    const code = `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {spawnSync} from 'node:child_process';
      const original=fs.readFileSync;
      const stateIdentity=fs.statSync(${JSON.stringify(path.join(config.stateDir, "terminal-auth.json"))});
      let attempted=false;
      fs.readFileSync=function(file,...args) {
        const identity=typeof file==='number' ? fs.fstatSync(file) : undefined;
        if (!attempted && identity?.ino===stateIdentity.ino && identity?.dev===stateIdentity.dev) {
          attempted=true;
          const child=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(revoke)}],{encoding:'utf8'});
          if (child.status!==0 || child.stdout!=='rejected') throw new Error('concurrent revoke was not fenced');
        }
        return original.call(this,file,...args);
      };
      syncBuiltinESMExports();
      const {readHubConfig}=await import(${JSON.stringify(configUrl)});
      const {HubTerminalAuth,issueTerminalCode}=await import(${JSON.stringify(authUrl)});
      const config=readHubConfig(${JSON.stringify(file)});
      let succeeded=false;
      try {
        ${operation === "issue" ? `issueTerminalCode(config,${JSON.stringify(scope)})` : `new HubTerminalAuth(config).unlock(${JSON.stringify(operation === "correct" ? pair.code : "wrong")})`};
        succeeded=true;
      } catch (error) { if (error.message.includes('concurrent revoke')) throw error; }
      if (!attempted || succeeded!==${operation !== "wrong"}) throw new Error('transaction did not reach controlled interleaving');
      process.stdout.write('fenced');
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "fenced");
    const revoked = spawnSync(process.execPath, ["--input-type=module", "-e", revoke], { encoding: "utf8" });
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.equal(revoked.stdout, "revoked");
    // Do not touch the old cookie until all post-revocation mutation attempts end.
    assert.throws(() => auth.unlock(pair.code));
    issueTerminalCode(config, scope);
    assert.equal(auth.status(request(old.cookie)).authorized, false);
  }
});

test("global revocation frees all 64 slots without visiting any old cookie", (t) => {
  const { config, scope, auth } = fixtureAuth(t);
  for (let i = 0; i < 64; i++) auth.unlock(issueTerminalCode(config, scope).code);
  assert.throws(() => auth.unlock(issueTerminalCode(config, scope).code));
  revokeTerminal(config);
  assert.ok(auth.unlock(issueTerminalCode(config, scope).code));
});

test("revoked run sessions free capacity for another run without visiting old cookies", (t) => {
  const { config, dir, scope, auth } = fixtureAuth(t);
  for (let i = 0; i < 64; i++) auth.unlock(issueTerminalCode(config, scope).code);
  revokeSession(config, scope.runId);
  const next = issueSession(config, path.join(dir, "other.json"), { label: "Other fixture" });
  assert.ok(auth.unlock(issueTerminalCode(config, { ...scope, runId: next.run_id }).code));
});

test("built CLI exposes explicit opt-in pairing/revocation without creating a PTY", (t) => {
  const { file, config, scope } = fixture(t);
  const cli = fileURLToPath(new URL("../dist/hub/pi-web-hub.mjs", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, "--config", file], { encoding: "utf8" });
  const result = run(
    "pair-terminal",
    "--run-id",
    scope.runId,
    "--runtime-id",
    scope.runtimeId,
    "--session-id",
    scope.sessionId,
    "--terminal-epoch",
    scope.terminalEpoch,
    "--access",
    "read",
  );
  assert.equal(result.status, 0, result.stderr);
  const auth = new HubTerminalAuth(config);
  const unlocked = auth.unlock(JSON.parse(result.stdout).code);
  assert.equal(auth.authorize(request(unlocked.cookie)).scope.access, "read");
  assert.equal(run("revoke-terminal").status, 0);
  assert.equal(auth.status(request(unlocked.cookie)).authorized, false);
  assert.notEqual(run("pair-terminal", "--run-id", scope.runId).status, 0);
});

test("built CLI init validates optional third listener flags without binding ports", (t) => {
  const { dir } = fixture(t);
  const cli = fileURLToPath(new URL("../dist/hub/pi-web-hub.mjs", import.meta.url));
  const run = (file: string, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "init", "--config", file, ...args]);
  const valid = path.join(dir, "terminal-init.json");
  assert.equal(run(valid, "--port", "0", "--management-port", "0", "--terminal-port", "0").status, 0);
  assert.deepEqual(readHubConfig(valid).terminal, { port: 0 });
  assert.notEqual(run(path.join(dir, "same-port.json"), "--port", "16180", "--terminal-port", "16180").status, 0);
  assert.notEqual(run(path.join(dir, "no-port.json"), "--terminal-public-url", "https://terminal.example/").status, 0);
});
