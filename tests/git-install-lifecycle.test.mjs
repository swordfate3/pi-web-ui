import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
