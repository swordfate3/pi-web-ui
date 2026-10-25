import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { copyFixture } from "../scripts/test-git-install.mjs";
import { verifyManifest } from "../scripts/web-dist.mjs";

test("Git-install fixture verifies Web sources and rejects stale content offline", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-install-runtime-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await copyFixture(dir);
  await verifyManifest(dir, { install: true });
  for (const file of ["extensions/mirror-server.ts", "extensions/terminal-prompt.ts", "src/web/src/core/markdown-math.ts"]) {
    const source = path.join(dir, file);
    const original = readFileSync(source);
    writeFileSync(source, Buffer.concat([original, Buffer.from("\nchanged-source\n")]));
    await assert.rejects(verifyManifest(dir, { install: true }), /Source inventory mismatch/);
    writeFileSync(source, original);
  }
  await verifyManifest(dir, { install: true });
});

test("offline package ships Web without Manager artifacts or interpreter caches", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-install-runtime-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await copyFixture(dir);
  const cache = path.join(dir, "extensions/remote-access/__pycache__");
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "unverified.pyc"), "not a verified source input");
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], {
    cwd: dir, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_cache: path.join(dir, "npm-cache") },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  // npm 10 may prefix JSON with its prepare hook's verification message.
  const start = result.stdout.indexOf("[\n");
  assert.ok(start >= 0);
  const files = JSON.parse(result.stdout.slice(start))[0].files.map((entry) => entry.path);
  for (const file of ["dist/index.html", "extensions/mirror-server.ts", "extensions/terminal-prompt.ts", "extensions/interactions/client.ts", "integrations/check-adapter.mjs", "integrations/adapters/manifest.json", "docs/web-interactions.md"])
    assert.ok(files.includes(file), `required package artifact: ${file}`);
  assert.equal(
    files.some(
      (file) =>
        file === "bin/pi-web-hub.mjs" ||
        file.startsWith("hub/") ||
        file.startsWith("dist/hub/") ||
        file.startsWith("integrations/runtime-updater/"),
    ),
    false,
    "Web package must not contain Manager source, runtime, or executable artifacts",
  );
  assert.equal(files.some((file) => file.includes("__pycache__")), false, "unverified interpreter caches must not ship");
});
