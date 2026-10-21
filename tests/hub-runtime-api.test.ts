import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readHubConfig } from "../hub/config.ts";
import { issueManagementCode, revokeManagement } from "../hub/management.ts";
import { startHub } from "../hub/server.ts";

const id = "a".repeat(32);
const version = "1.3.0";
const runId = "b".repeat(32);

test("terminal runtime update reports installed package separately from unrefreshed child", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  const target = {
    run_id: runId,
    status: "manual_restart_required",
    profile: "web-terminal-v1",
    wait_reason: "terminal_profile_unaudited",
  };
  f.setJob({
    id,
    version,
    status: "manual_restart_required",
    stage: "installed_manual_restart_required",
    targets: [target],
  });
  const response = await f.request(`runtime-updates/${id}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).targets, [target]);
});

async function fixture(t: test.TestContext, configured = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-runtime-api-"));
  const credentialFile = path.join(dir, "request.json");
  const token = "c".repeat(64);
  writeFileSync(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
  let job: Record<string, unknown> = { id, version, status: "pending", stage: "awaiting_approval", targets: [] };
  let posts = 0;
  let loseReply = false;
  let upstreamStatus = 200;
  let mode = "manual";
  let badResult: unknown;
  let hold: ((release: () => void) => void) | undefined;
  const calls: { method?: string; route?: string; value?: unknown }[] = [];
  const gate = http.createServer(async (req, res) => {
    // Model Gate's rejection of unauthenticated HTTP input, not an unhandled
    // assertion in an async HTTP callback. Missing provider auth still makes
    // the positive API expectations fail with503 instead of200/202.
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const value = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, route: req.url, value });
    if (req.method === "POST") {
      posts++;
      assert.equal(req.url, "/v1/runtime-updates");
      assert.deepEqual(value, { version, idempotency_key: id });
      if (loseReply) {
        req.socket.destroy();
        return;
      }
    }
    const release = () => {
      res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          badResult ??
            (req.url === "/v1/runtime-updates" && req.method === "GET"
              ? {
                  policy: { mode, images: ["private-image"], policy_hash: "private-policy" },
                  jobs: [job],
                  active: [job],
                }
              : job),
        ),
      );
    };
    if (hold) {
      const capture = hold;
      hold = undefined;
      capture(release);
    } else release();
  });
  await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
  const file = path.join(dir, "hub.json");
  writeFileSync(
    file,
    JSON.stringify({
      port: 0,
      management: { port: 0 },
      ...(configured
        ? { runtimeUpdates: { endpoint: `http://127.0.0.1:${(gate.address() as AddressInfo).port}`, credentialFile } }
        : {}),
    }),
    { mode: 0o600 },
  );
  const config = readHubConfig(file);
  let hub = await startHub(config);
  let cookie = "";
  let csrf = "";
  const request = (route: string, body?: unknown, headers: Record<string, string> = {}) => {
    assert.ok(hub.managementUrl);
    return fetch(`${hub.managementUrl}api/management/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: new URL(hub.managementUrl).origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Pi-Hub-Csrf": csrf,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  const unlock = async () => {
    const res = await request("unlock", { code: issueManagementCode(config).code });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie);
    cookie = setCookie.split(";")[0];
    csrf = (await res.json()).csrf;
  };
  t.after(async () => {
    await hub.close();
    gate.closeAllConnections();
    await new Promise<void>((resolve) => gate.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    request,
    unlock,
    calls,
    get posts() {
      return posts;
    },
    get hub() {
      return hub;
    },
    setJob: (value: Record<string, unknown>) => {
      job = value;
    },
    setBad: (value: unknown) => {
      badResult = value;
    },
    setStatus: (value: number) => {
      upstreamStatus = value;
    },
    setMode: (value: string) => {
      mode = value;
    },
    holdNextResponse: () =>
      new Promise<() => void>((resolve) => {
        hold = resolve;
      }),
    loseReply: () => {
      loseReply = true;
    },
    reopen: async () => {
      await hub.close();
      hub = await startHub(config);
    },
  };
}

test("runtime updates are separately configured, management-only, locked and CSRF protected", async (t) => {
  const f = await fixture(t);
  const status = await (await f.request("status")).json();
  assert.equal(status.available, true);
  assert.equal(status.runtimeUpdatesAvailable, true);
  assert.equal(status.restartAvailable, false);
  assert.equal(status.authorized, false);
  assert.equal((await f.request("runtime-updates")).status, 401);
  assert.equal((await fetch(`${f.hub.url}api/management/runtime-updates`)).status, 404);
  await f.unlock();
  const payload = { version, idempotencyKey: id };
  assert.equal((await f.request("runtime-updates", payload, { "X-Pi-Hub-Csrf": "" })).status, 401);
  assert.equal((await f.request("runtime-updates", payload, { Origin: "https://evil.invalid" })).status, 403);
  assert.equal(f.posts, 0);
  assert.equal((await f.request("runtime-updates/approve", {})).status, 404);
});

test("runtime list projects public policy and per-target progress without internal paths or credentials", async (t) => {
  const f = await fixture(t);
  f.setJob({
    id,
    version,
    status: "running",
    stage: "waiting_for_idle",
    created_at: 1792300000000,
    token: "private-token",
    helpers: { path: "/private/helper" },
    targets: [
      {
        run_id: runId,
        status: "waiting_for_idle",
        old_version: "1.1.0",
        wait_reason: "busy_race",
        container_id: "private-container",
        session_file: "/private/session",
      },
    ],
  });
  await f.unlock();
  const response = await f.request("runtime-updates");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.policy, { mode: "manual" });
  assert.equal(body.jobs[0].targets[0].status, "waiting_for_idle");
  assert.equal(body.active[0].id, id);
  assert.ok(!JSON.stringify(body).includes("private"));
  assert.equal(f.posts, 0);
});

test("submitting a global runtime update sends only the exact version and stable idempotency identity", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  const response = await f.request("runtime-updates", { version, idempotencyKey: id });
  assert.equal(response.status, 202);
  const job = await response.json();
  assert.equal(job.status, "pending");
  assert.equal(job.id, id);
  assert.equal(job.version, version);
  assert.equal(f.posts, 1);
  assert.ok(f.calls.every((call) => !call.route?.includes("admin")));
});

test("invalid versions, task IDs and extra request fields cannot reach Gate", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  for (const v of ["latest", "^1.3.0", "1.3.0-beta", "01.3.0", "1.3.0+build", "1.3", "1.3.0\n", "1.3.0\r"])
    assert.equal((await f.request("runtime-updates", { version: v, idempotencyKey: id })).status, 400, v);
  assert.equal((await f.request("runtime-updates", { version, idempotencyKey: id, approve: true })).status, 400);
  assert.equal((await f.request("runtime-updates", { version, idempotencyKey: "../admin" })).status, 400);
  assert.equal(f.posts, 0);
});

test("a submit reply must identify the exact requested task and version", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  for (const wrong of [
    { id: "e".repeat(32), version },
    { id, version: "1.1.0" },
  ]) {
    f.setBad({ ...wrong, status: "pending", stage: "awaiting_approval", targets: [] });
    assert.equal((await f.request("runtime-updates", { version, idempotencyKey: id })).status, 503);
  }
});

test("malformed runtime request bodies are rejected before Gate, not reported as provider conflicts", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  for (const value of [null, [], "invalid", { version: "x".repeat(9000) }]) {
    const response = await f.request("runtime-updates", value);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Invalid runtime update request/);
  }
  assert.equal(f.posts, 0);
});

test("provider redirects, oversized lists and malformed policy cannot expose unvalidated results", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  f.setStatus(302);
  assert.equal((await f.request("runtime-updates")).status, 503);
  f.setStatus(200);
  for (const result of [
    { policy: { mode: "admin" }, jobs: [], active: [] },
    { policy: { mode: "manual" }, jobs: "invalid", active: [] },
    { policy: { mode: "manual" }, jobs: [], active: {} },
    { policy: { mode: "manual" }, jobs: Array(101).fill({}), active: [] },
    { huge: "x".repeat(16 * 1024 * 1024) },
  ]) {
    f.setBad(result);
    assert.equal((await f.request("runtime-updates")).status, 503);
  }
  assert.equal(f.posts, 0);
});

test("full Gate history and cumulative replacement targets remain readable", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  const targets = Array.from({ length: 129 }, (_, i) => ({
    run_id: i.toString(16).padStart(32, "0"),
    status: i === 128 ? "waiting_for_idle" : "exited",
    old_version: "1.1.0",
  }));
  const current = { id, version, status: "running", stage: "waiting_for_idle", targets };
  f.setJob(current);
  let response = await f.request(`runtime-updates/${id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).targets.length, 129);
  const jobs = Array.from({ length: 100 }, (_, i) => ({
    ...current,
    id: i.toString(16).padStart(32, "0"),
    status: "succeeded",
    stage: "complete",
    targets: targets.slice(0, 128),
  }));
  const history = { policy: { mode: "manual" }, jobs, active: [current] };
  assert.ok(Buffer.byteLength(JSON.stringify(history)) > 1024 * 1024);
  f.setBad(history);
  response = await f.request("runtime-updates");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.jobs.length, 100);
  assert.equal(result.active[0].targets.length, 129);
  assert.equal(f.posts, 0);
});

test("Gate rejection and unknown outcome are not relabeled as successful installation", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  for (const status of [400, 409, 503]) {
    f.setStatus(status);
    const response = await f.request("runtime-updates", { version, idempotencyKey: id });
    assert.equal(response.status, status);
    const result = await response.json();
    assert.equal(result.status, undefined);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
  f.setStatus(401);
  assert.equal((await f.request("runtime-updates")).status, 503);
});

test("lost submit reply can be queried by original ID after a Hub restart without another POST", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  f.loseReply();
  assert.equal((await f.request("runtime-updates", { version, idempotencyKey: id })).status, 503);
  assert.equal(f.posts, 1);
  await f.reopen();
  await f.unlock();
  const response = await f.request(`runtime-updates/${id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, id);
  assert.equal(f.posts, 1);
});

test("unknown and malformed upstream jobs never become trusted progress", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  f.setStatus(404);
  assert.equal((await f.request(`runtime-updates/${id}`)).status, 404);
  f.setStatus(200);
  for (const bad of [
    null,
    [],
    { id: "d".repeat(32), version, status: "succeeded", stage: "complete", targets: [] },
    { id, version, status: "made_up_success", stage: "complete", targets: [] },
    { id, version: "latest", status: "succeeded", stage: "complete", targets: [] },
    { id, version, status: "succeeded", stage: "complete", targets: "invalid" },
  ]) {
    f.setBad(bad === null ? false : bad);
    assert.equal((await f.request(`runtime-updates/${id}`)).status, 503);
  }
});

test("management revocation and logout also revoke global update access", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  assert.equal((await f.request("logout", {})).status, 200);
  assert.equal((await f.request("runtime-updates")).status, 401);
  await f.unlock();
  revokeManagement(f.config);
  assert.equal((await f.request("runtime-updates", { version, idempotencyKey: id })).status, 401);
  assert.equal(f.posts, 0);
});

test("revoking management while Gate is responding suppresses the late protected result", async (t) => {
  const f = await fixture(t);
  await f.unlock();
  const held = f.holdNextResponse();
  const pending = f.request("runtime-updates");
  const release = await held;
  revokeManagement(f.config);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal((await response.json()).jobs, undefined);
  assert.equal(f.posts, 0);
});

test("unconfigured global updating remains unavailable even with management unlocked", async (t) => {
  const f = await fixture(t, false);
  await f.unlock();
  assert.equal((await f.request("runtime-updates")).status, 503);
  assert.equal(f.posts, 0);
});

test("runtime provider configuration refuses arbitrary hosts, relative credential paths and extra capabilities", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-runtime-config-"));
  try {
    const file = path.join(dir, "hub.json");
    for (const runtimeUpdates of [
      { endpoint: "https://evil.invalid", credentialFile: "/private/token" },
      { endpoint: "http://127.0.0.1:16182/admin", credentialFile: "/private/token" },
      { endpoint: "http://127.0.0.1:16182", credentialFile: "relative.json" },
      { endpoint: "http://127.0.0.1:16182", credentialFile: "/private/token", admin: true },
    ]) {
      writeFileSync(file, JSON.stringify({ runtimeUpdates }), { mode: 0o600 });
      assert.throws(() => readHubConfig(file));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
