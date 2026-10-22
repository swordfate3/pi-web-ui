import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyFixture } from "../scripts/test-git-install.mjs";
import { verifyManifest } from "../scripts/web-dist.mjs";

test("Git-install fixture verifies ordinary Web and Hub sources and rejects stale content offline", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-install-runtime-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await copyFixture(dir);
  await verifyManifest(dir, { install: true });
  for (const file of ["extensions/mirror-server.ts", "extensions/terminal-prompt.ts", "hub/server.ts", "src/web/src/core/markdown-math.ts"]) {
    const source = path.join(dir, file);
    const original = readFileSync(source);
    writeFileSync(source, Buffer.concat([original, Buffer.from("\nchanged-source\n")]));
    await assert.rejects(verifyManifest(dir, { install: true }), /Source inventory mismatch/);
    writeFileSync(source, original);
  }
  await verifyManifest(dir, { install: true });
});

test("offline package ships ordinary Web and Hub without archived terminal or interpreter caches", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-install-runtime-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await copyFixture(dir);
  const cache = path.join(dir, "runtime/terminal/__pycache__");
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
  for (const file of ["dist/index.html", "dist/hub/pi-web-hub.mjs", "extensions/mirror-server.ts", "extensions/terminal-prompt.ts"])
    assert.ok(files.includes(file), `required package artifact: ${file}`);
  assert.equal(files.some((file) => /^(runtime\/|dist\/(runtime|terminal)\/)/.test(file)), false);
  assert.equal(files.some((file) => file.includes("__pycache__")), false, "unverified interpreter caches must not ship");
});

test("installed Hub lifecycle checks stay offline even when the caller permits public version checks", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-install-lifecycle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "external-fetch-attempted");
  const preload = path.join(dir, "observe-fetch.mjs");
  // Keep the real packaged CLI, HTTP, state and signal handling. Observe only
  // its external fetch boundary, and never make a public request in this test.
  writeFileSync(preload, `
    import { writeFileSync } from 'node:fs';
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === '127.0.0.1') return original(input, init);
      writeFileSync(${JSON.stringify(marker)}, 'attempted');
      return Promise.reject(new Error('Public version lookup blocked by regression fixture'));
    };
  `);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const runner = new URL("../scripts/test-git-install.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { assertHubLifecycle } from ${JSON.stringify(runner)};
    await assertHubLifecycle(${JSON.stringify(root)}, 'regression', ${JSON.stringify(dir)});
  `], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      PI_OFFLINE: "0",
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false, "package lifecycle validation must not start public version fetches");
});
