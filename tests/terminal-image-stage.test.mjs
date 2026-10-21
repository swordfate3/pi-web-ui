import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts/stage-terminal-image.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("terminal image staging verifies packaged assets and produces deterministic fixed inventory", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task6-stage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ["one", "two"]) {
    const result = spawnSync(process.execPath, [script, "--output", path.join(dir, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(await readFile(path.join(dir, name, "inventory.json"), "utf8"));
    assert.equal(inventory.v, 1);
    assert.ok(inventory.files["runtime/broker.cjs"]);
    assert.ok(inventory.files["package/extensions/mirror-server.ts"]);
    assert.ok(inventory.files["package/dist/terminal/app.js"]);
    assert.ok(inventory.files["package/node_modules/ws/index.js"]);
    for (const [key, digest] of Object.entries(inventory.files)) {
      assert.equal(hash(await readFile(path.join(dir, name, key))), digest);
      assert.ok(!key.includes(".env") && !key.includes(".credentials"));
    }
  }
  assert.deepEqual(await readFile(path.join(dir, "one/inventory.json")), await readFile(path.join(dir, "two/inventory.json")));
  const overwrite = spawnSync(process.execPath, [script, "--output", path.join(dir, "one")], { encoding: "utf8" });
  assert.notEqual(overwrite.status, 0, "never overwrite an existing context");
});

test("staging rejects tampered runtime before creating a build context", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task6-tamper-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clone = path.join(dir, "package");
  const manifest = JSON.parse(await readFile(path.join(root, "dist/build-manifest.json"), "utf8"));
  for (const entry of [...manifest.source.files, ...manifest.outputs.files.map((entry) => ({ ...entry, path: `dist/${entry.path}` }))]) {
    const target = path.join(clone, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, entry.path), target);
  }
  await cp(path.join(root, "dist/build-manifest.json"), path.join(clone, "dist/build-manifest.json"));
  await writeFile(path.join(clone, "dist/runtime/broker.cjs"), "tampered broker");
  const result = spawnSync(process.execPath, [script, "--root", clone, "--output", path.join(dir, "out")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hash|mismatch|inventory/i, JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout }));
});
