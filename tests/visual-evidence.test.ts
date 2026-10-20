import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "@playwright/test";
import { observeBrowserErrors, startVisualEvidence } from "../e2e/harness/visual-evidence.ts";

const secret = "private-prompt-token-and-path";
const url = `http://user:${secret}@localhost:1234/s/${secret}/api?token=${secret}#${secret}`;
function fixture() {
  const page = new EventEmitter();
  const gate = observeBrowserErrors(page as unknown as Page);
  return { page, gate };
}
const request = { url: () => url, method: () => "GET", failure: () => ({ errorText: `net::ERR_FAILED ${secret}` }) };

// Each missing listener or missing gate category would let its failure pass.
for (const kind of ["pageErrors", "consoleErrors", "requestFailures", "httpFailures", "webSocketErrors"] as const) {
  test(`visual gate rejects and sanitizes ${kind}`, () => {
    const { page, gate } = fixture();
    if (kind === "pageErrors") page.emit("pageerror", new Error(secret));
    if (kind === "consoleErrors") page.emit("console", { type: () => "error", text: () => secret });
    if (kind === "requestFailures") page.emit("requestfailed", request);
    if (kind === "httpFailures") page.emit("response", { status: () => 503, url: () => url, request: () => request });
    if (kind === "webSocketErrors") {
      const socket = Object.assign(new EventEmitter(), { url: () => url });
      page.emit("websocket", socket);
      socket.emit("socketerror", secret);
    }
    assert.throws(() => gate.assertClean());
    assert.equal(gate.errors[kind].length, 1);
    assert.ok(!JSON.stringify(gate.errors).includes(secret), "Never persist raw error text/URLs, credentials or prompts");
    gate.stop();
  });
}

test("visual gate accepts normal traffic and detaches only for deliberate teardown", () => {
  const { page, gate } = fixture();
  page.emit("console", { type: () => "warning", text: () => secret });
  for (const status of [200, 204, 302, 304]) page.emit("response", { status: () => status });
  const socket = Object.assign(new EventEmitter(), { url: () => url });
  page.emit("websocket", socket);
  socket.emit("close");
  assert.doesNotThrow(() => gate.assertClean());
  gate.stop();
  page.emit("pageerror", new Error(secret));
  page.emit("console", { type: () => "error", text: () => secret });
  page.emit("requestfailed", request);
  socket.emit("socketerror", secret);
  assert.doesNotThrow(() => gate.assertClean());
});

test("visual gate does not suppress favicon 404, localhost failures or aborted requests", () => {
  const { page, gate } = fixture();
  page.emit("response", { status: () => 404, url: () => "http://localhost/favicon.ico", request: () => request });
  page.emit("requestfailed", { ...request, failure: () => ({ errorText: "net::ERR_ABORTED" }) });
  assert.equal(gate.errors.httpFailures.length, 1);
  assert.equal(gate.errors.requestFailures.length, 1);
  assert.throws(() => gate.assertClean());
  gate.stop();
});

test("a rerun invalidates old success before browser launch and persists failure instead of stale pass", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "visual-evidence-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "evidence.json");
  writeFileSync(file, JSON.stringify({ status: "passed", runId: "old-run", evidence: [{ screenshots: ["old.png"] }] }));
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  const run = startVisualEvidence(file);
  assert.equal(read().status, "in_progress");
  assert.notEqual(read().runId, "old-run");
  assert.deepEqual(read().evidence, []);
  const { page, gate } = fixture();
  page.emit("console", { type: () => "error", text: () => secret });
  run.recordCase({ status: "failed", ...gate.errors });
  run.finish("failed");
  assert.equal(read().status, "failed");
  assert.equal(read().evidence[0].consoleErrors.length, 1);
  assert.ok(!readFileSync(file, "utf8").includes(secret));
  const fresh = startVisualEvidence(file);
  assert.equal(read().status, "in_progress");
  assert.deepEqual(read().evidence, []);
  fresh.recordCase({ status: "passed" });
  fresh.finish("passed");
  assert.equal(read().status, "passed");
  assert.equal(read().evidence.length, 1);
  gate.stop();
});
