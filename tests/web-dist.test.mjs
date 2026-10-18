import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { createManifest, createSourceInventory, verifyManifest, writeManifest } from "../scripts/web-dist.mjs";

const SCRIPT = new URL("../scripts/web-dist.mjs", import.meta.url);
const roots = new Set();

const SOURCE_FILES = [
  "vite.config.ts",
  "vite.hub.config.ts",
  "tsconfig.json",
  "package.json",
  "package-lock.json",
  "extensions/mirror-server.ts",
  "extensions/connection-config.ts",
  "extensions/connection-listener.ts",
  "extensions/session-registration.ts",
  "extensions/software-metadata.ts",
  "extensions/runtime-control.ts",
  "extensions/runtime-metadata.ts",
  "extensions/runtime-stdin-guard.mjs",
  "extensions/session-history.ts",
  "extensions/live-transport.ts",
  "extensions/message-revision.ts",
  "extensions/message-versions.ts",
  "extensions/session-usage.ts",
  "extensions/file-downloads.ts",
  "extensions/workspace-uploads.ts",
  "extensions/remote-access/plan.ts",
  "extensions/remote-access/gateway.py",
  "scripts/web-dist.mjs",
];

async function fixture({ dist = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-dist-test-"));
  roots.add(root);
  await mkdir(path.join(root, "src/web/nested"), { recursive: true });
  await mkdir(path.join(root, "public/icons"), { recursive: true });
  await mkdir(path.join(root, "extensions/remote-access"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "hub"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  for (const file of SOURCE_FILES) {
    await writeFile(path.join(root, file), `fixture:${file}\n`);
  }
  await writeFile(path.join(root, "src/web/index.html"), "<main>source</main>\n");
  await writeFile(path.join(root, "scripts/web-dist.mjs"), "fixture script\n");
  await writeFile(path.join(root, "src/web/nested/app.tsx"), "export const app = true;\n");
  await writeFile(path.join(root, "public/icons/icon.svg"), "<svg/>\n");
  await writeFile(path.join(root, "hub/server.ts"), "export const hub = true;\n");
  await writeFile(path.join(root, "bin/pi-web-hub.mjs"), "console.log('hub');\n");
  if (dist) {
    await mkdir(path.join(root, "dist/assets"), { recursive: true });
    await mkdir(path.join(root, "dist/hub"), { recursive: true });
    await writeFile(path.join(root, "dist/hub/pi-web-hub.mjs"), "#!/usr/bin/env node\nconsole.log('hub fixture');\n");
    await writeFile(path.join(root, "dist/index.html"), '<script type="module" src="/assets/app.js?v=1#x"></script>\n');
    await writeFile(path.join(root, "dist/assets/app.js"), "console.log('fixture');\n");
  }
  return root;
}

async function loadManifest(root) {
  return JSON.parse(await readFile(path.join(root, "dist/build-manifest.json"), "utf8"));
}

function refreshInventory(inventory) {
  inventory.files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  inventory.count = inventory.files.length;
  inventory.sha256 = createHashForTest(JSON.stringify(inventory.files));
}

function createHashForTest(text) {
  // Keep test fixtures independent of implementation exports.
  return createHash("sha256").update(text).digest("hex");
}

async function saveManifest(root, manifest) {
  await writeFile(path.join(root, "dist/build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("build-time source identity needs no dist and matches the final manifest", async () => {
  const root = await fixture({ dist: false });
  const before = await createSourceInventory(root);
  await mkdir(path.join(root, "dist/hub"), { recursive: true });
  await writeFile(path.join(root, "dist/index.html"), "<main>fixture</main>");
  await writeFile(path.join(root, "dist/hub/pi-web-hub.mjs"), "// independent output\n");
  const manifest = await createManifest(root);
  assert.deepEqual(before, manifest.source);
  await writeFile(path.join(root, "package.json"), '{"version":"1.0.1"}');
  assert.notEqual((await createSourceInventory(root)).sha256, before.sha256);
});

test("creates and verifies deterministic source and output inventories", async () => {
  const root = await fixture();
  const first = await createManifest(root);
  const second = await createManifest(root);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.source.files.map(({ path: file }) => file),
    [
      "bin/pi-web-hub.mjs",
      "extensions/connection-config.ts",
      "extensions/connection-listener.ts",
      "extensions/file-downloads.ts",
      "extensions/live-transport.ts",
      "extensions/message-revision.ts",
      "extensions/message-versions.ts",
      "extensions/mirror-server.ts",
      "extensions/remote-access/gateway.py",
      "extensions/remote-access/plan.ts",
      "extensions/runtime-control.ts",
      "extensions/runtime-metadata.ts",
      "extensions/runtime-stdin-guard.mjs",
      "extensions/session-history.ts",
      "extensions/session-registration.ts",
      "extensions/session-usage.ts",
      "extensions/software-metadata.ts",
      "extensions/workspace-uploads.ts",
      "hub/server.ts",
      "package-lock.json",
      "package.json",
      "public/icons/icon.svg",
      "scripts/web-dist.mjs",
      "src/web/index.html",
      "src/web/nested/app.tsx",
      "tsconfig.json",
      "vite.config.ts",
      "vite.hub.config.ts",
    ],
  );
  assert.deepEqual(
    first.outputs.files.map(({ path: file }) => file),
    ["assets/app.js", "hub/pi-web-hub.mjs", "index.html"],
  );

  const written = await writeManifest(root);
  assert.deepEqual(written, first);
  const firstManifestBytes = await readFile(path.join(root, "dist/build-manifest.json"));
  await writeManifest(root);
  assert.deepEqual(await readFile(path.join(root, "dist/build-manifest.json")), firstManifestBytes);
  assert.deepEqual(await verifyManifest(root), first);
  assert.equal(await verifyManifest(root, { assetsOnly: true }).then((manifest) => manifest.schemaVersion), 1);
  assert.equal((await readFile(path.join(root, "dist/build-manifest.json"), "utf8")).endsWith("\n"), true);
});

test("requires an existing complete Vite dist and never creates it while writing", async () => {
  const absent = await fixture({ dist: false });
  await assert.rejects(writeManifest(absent), /Required directory is missing: dist/);
  await assert.rejects(readFile(path.join(absent, "dist")), { code: "ENOENT" });

  const incomplete = await fixture();
  await rm(path.join(incomplete, "dist/index.html"));
  await assert.rejects(createManifest(incomplete), /dist\/index.html is missing/);
});

test("refuses missing prebuilt hub in write, verify, install and assets-only", async () => {
  const root = await fixture();
  await writeManifest(root);
  await rm(path.join(root, "dist/hub/pi-web-hub.mjs"));
  await assert.rejects(writeManifest(root), /dist\/hub\/pi-web-hub\.mjs is missing/);
  for (const options of [{}, { install: true }, { assetsOnly: true }]) {
    await assert.rejects(verifyManifest(root, options), /dist\/hub\/pi-web-hub\.mjs is missing/);
  }
  // A manifest with a freshly recomputed inventory digest must not redefine
  // the package contract by omitting the bin, even when no source is checked.
  const manifest = await loadManifest(root);
  manifest.outputs.files = manifest.outputs.files.filter((entry) => entry.path !== "hub/pi-web-hub.mjs");
  refreshInventory(manifest.outputs);
  await saveManifest(root, manifest);
  for (const options of [{}, { install: true }, { assetsOnly: true }]) {
    await assert.rejects(verifyManifest(root, options), /outputs must include hub\/pi-web-hub\.mjs/);
  }
});

test("detects changed, missing, and extra output files", async () => {
  const root = await fixture();
  await writeManifest(root);
  await writeFile(path.join(root, "dist/assets/app.js"), "changed\n");
  await assert.rejects(verifyManifest(root), /Output inventory mismatch .*changed: assets\/app\.js/);

  await writeFile(path.join(root, "dist/assets/app.js"), "console.log('fixture');\n");
  await rm(path.join(root, "dist/assets/app.js"));
  await assert.rejects(verifyManifest(root), /HTML asset reference is missing from dist/);

  await writeFile(path.join(root, "dist/extra.txt"), "unexpected\n");
  await writeFile(path.join(root, "dist/assets/app.js"), "console.log('fixture');\n");
  await assert.rejects(verifyManifest(root), /Output inventory mismatch .*unexpected: extra\.txt/);
});

test("detects stale source content and source inventory omissions", async () => {
  const root = await fixture();
  await writeManifest(root);
  await writeFile(path.join(root, "src/web/nested/app.tsx"), "changed source\n");
  await assert.rejects(verifyManifest(root), /Source inventory mismatch .*changed: src\/web\/nested\/app\.tsx/);

  await writeFile(path.join(root, "src/web/nested/app.tsx"), "export const app = true;\n");
  const manifest = await loadManifest(root);
  manifest.source.files = manifest.source.files.filter((entry) => entry.path !== "src/web/nested/app.tsx");
  refreshInventory(manifest.source);
  await saveManifest(root, manifest);
  await assert.rejects(verifyManifest(root), /Source inventory mismatch .*unexpected: src\/web\/nested\/app\.tsx/);
});

test("rejects stale browser, connection and hub inputs in verify and install", async (t) => {
  const inputs = [
    ...SOURCE_FILES.filter((file) => file.startsWith("extensions/")),
    "hub/server.ts",
    "bin/pi-web-hub.mjs",
    "vite.hub.config.ts",
  ];
  for (const file of inputs) {
    await t.test(file, async () => {
      const root = await fixture();
      await writeManifest(root);
      await writeFile(path.join(root, file), "changed without rebuilding\n");
      await assert.rejects(verifyManifest(root), (error) => error.message.includes(`changed: ${file}`));
      await assert.rejects(verifyManifest(root, { install: true }), (error) => error.message.includes(`changed: ${file}`));
    });
  }
});

test("rejects unsafe manifest paths regardless of a recomputed inventory hash", async (t) => {
  const unsafePaths = ["../outside", "/absolute", "C:/absolute", "folder\\file", "bad\0path"];
  for (const unsafePath of unsafePaths) {
    await t.test(JSON.stringify(unsafePath), async () => {
      const root = await fixture();
      await writeManifest(root);
      const manifest = await loadManifest(root);
      manifest.source.files = [{ path: unsafePath, sha256: "a".repeat(64) }];
      refreshInventory(manifest.source);
      await saveManifest(root, manifest);
      await assert.rejects(verifyManifest(root), /Invalid manifest path:/);
    });
  }
});

test("does not let a manifest redefine the fixed source policy", async () => {
  const root = await fixture();
  await writeManifest(root);
  const manifest = await loadManifest(root);
  manifest.source.files.push({ path: "README.md", sha256: "a".repeat(64) });
  refreshInventory(manifest.source);
  await saveManifest(root, manifest);
  await assert.rejects(verifyManifest(root), /source path is outside the fixed source policy: README\.md/);
});

test("rejects malformed schemas, digest formats, and inconsistent inventory hashes", async () => {
  const root = await fixture();
  await writeManifest(root);

  const wrongSchema = await loadManifest(root);
  wrongSchema.schemaVersion = 2;
  await saveManifest(root, wrongSchema);
  await assert.rejects(verifyManifest(root), /Unsupported build manifest schemaVersion/);

  await writeManifest(root);
  const badDigest = await loadManifest(root);
  badDigest.outputs.files[0].sha256 = "not-a-hash";
  await saveManifest(root, badDigest);
  await assert.rejects(verifyManifest(root), /outputs\.files\[0\]\.sha256 must be a lowercase SHA-256 hash/);

  await writeManifest(root);
  const badInventoryHash = await loadManifest(root);
  badInventoryHash.outputs.sha256 = "0".repeat(64);
  await saveManifest(root, badInventoryHash);
  await assert.rejects(verifyManifest(root), /outputs\.sha256 does not match its file entries/);
});

test("refuses symlinks in source and output trees and for the manifest itself", async () => {
  const sourceRoot = await fixture();
  await writeManifest(sourceRoot);
  await symlink(path.join(sourceRoot, "public/icons/icon.svg"), path.join(sourceRoot, "src/web/nested/linked.tsx"));
  await assert.rejects(verifyManifest(sourceRoot), /Refusing to follow symlink: src\/web\/nested\/linked\.tsx/);

  const outputRoot = await fixture();
  await writeManifest(outputRoot);
  await symlink(path.join(outputRoot, "dist/index.html"), path.join(outputRoot, "dist/assets/linked.js"));
  await assert.rejects(
    verifyManifest(outputRoot, { assetsOnly: true }),
    /Refusing to follow symlink: dist\/assets\/linked\.js/,
  );

  const manifestRoot = await fixture();
  await writeManifest(manifestRoot);
  await rm(path.join(manifestRoot, "dist/build-manifest.json"));
  await symlink(path.join(manifestRoot, "dist/index.html"), path.join(manifestRoot, "dist/build-manifest.json"));
  await assert.rejects(
    verifyManifest(manifestRoot, { assetsOnly: true }),
    /Refusing to follow symlink: dist\/build-manifest\.json/,
  );
});

test("assets-only validates packaged output when source files are absent", async () => {
  const root = await fixture();
  await writeManifest(root);
  await rm(path.join(root, "src"), { recursive: true });
  await rm(path.join(root, "public"), { recursive: true });
  for (const file of SOURCE_FILES) await rm(path.join(root, file));

  await assert.rejects(verifyManifest(root), /Required directory is missing: src\/web/);
  assert.equal((await verifyManifest(root, { assetsOnly: true })).schemaVersion, 1);
});

test("install verification excludes only package-lock and accepts absent source, but rejects partial or stale source", async () => {
  const root = await fixture();
  await writeManifest(root);
  await writeFile(path.join(root, "src/web/nested/app.tsx"), "stale\n");
  await assert.rejects(verifyManifest(root, { install: true }), /Source inventory mismatch/);
  await writeFile(path.join(root, "src/web/nested/app.tsx"), "export const app = true;\n");
  await writeFile(path.join(root, "package-lock.json"), "changed lock\n");
  assert.equal((await verifyManifest(root, { install: true })).schemaVersion, 1);
  await assert.rejects(verifyManifest(root), /Source inventory mismatch .*package-lock.json/);
  await rm(path.join(root, "src"), { recursive: true });
  await rm(path.join(root, "public"), { recursive: true });
  for (const file of SOURCE_FILES) await rm(path.join(root, file));
  assert.equal((await verifyManifest(root, { install: true })).schemaVersion, 1);
  await writeFile(path.join(root, "package.json"), "partial\n");
  await mkdir(path.join(root, "src"));
  await assert.rejects(verifyManifest(root, { install: true }), /Required directory is missing: src\/web/);
});

test("write and verify reject missing HTML-referenced assets", async () => {
  const root = await fixture();
  await rm(path.join(root, "dist/assets/app.js"));
  await assert.rejects(writeManifest(root), /HTML asset reference is missing/);
});

test("CLI supports --root, verifies assets-only packages, and gives build guidance", async () => {
  const root = await fixture();
  const write = spawnSync(process.execPath, [SCRIPT.pathname, "--write", "--root", root], { encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr);
  const verify = spawnSync(process.execPath, [SCRIPT.pathname, "--root", root], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /Source and dist outputs verified/);

  await rm(path.join(root, "src"), { recursive: true });
  await rm(path.join(root, "public"), { recursive: true });
  for (const file of SOURCE_FILES) await rm(path.join(root, file));
  const assets = spawnSync(process.execPath, [SCRIPT.pathname, "--assets-only", "--root", root], { encoding: "utf8" });
  assert.equal(assets.status, 0, assets.stderr);
  assert.match(assets.stdout, /Packaged dist outputs verified/);

  await rm(path.join(root, "dist/index.html"));
  const incomplete = spawnSync(process.execPath, [SCRIPT.pathname, "--assets-only", "--root", root], {
    encoding: "utf8",
  });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /dist\/index\.html is missing/);
  assert.match(incomplete.stderr, /npm run build:web/);
  const unknown = spawnSync(process.execPath, [SCRIPT.pathname, "--wat"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown argument: --wat/);
});
