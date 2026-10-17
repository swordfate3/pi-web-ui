#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = "pi-web-ui-install-tests";
const base = process.env.PI_INSTALL_TEST_ROOT || path.join(os.homedir(), ".local", "share", name);
const timeout = 180_000;
const keep = process.argv.includes("--keep");
const gitUrl = "https://github.com/pi-web-ui-install-test/pi-web-ui";
const gitSpec = "git:github.com/pi-web-ui-install-test/pi-web-ui";
let root;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function checked(command, args, options) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}`);
  return result;
}
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function safeEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(?:npm_config_(?:production|omit|include|only|legacy_peer_deps|ignore_scripts)|NODE_ENV|PI_OFFLINE|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+))$/i.test(
        key,
      )
    )
      delete env[key];
  }
  return { ...env, ...extra };
}
function piEnv(agentDir, gitRepo) {
  const env = safeEnv({
    PI_CODING_AGENT_DIR: agentDir,
    npm_config_omit: "dev",
    npm_config_include: "",
    npm_config_legacy_peer_deps: "true",
    npm_config_ignore_scripts: "false",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.file://${gitRepo}.insteadOf`,
    GIT_CONFIG_VALUE_0: `${gitUrl}`,
  });
  return env;
}
async function copyFixture(destination) {
  await mkdir(destination, { recursive: true });
  const files = [
    "package.json",
    "package-lock.json",
    ".gitignore",
    "LICENSE",
    "README.md",
    "docs/remote-access.md",
    "docs/hub.md",
    "scripts/web-dist.mjs",
    "vite.config.ts",
    "vite.hub.config.ts",
    "tsconfig.json",
  ];
  const dirs = ["bin", "hub", "extensions", "src/web", "public", "dist", "docs/images"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await cp(path.join(project, file), path.join(destination, file));
  }
  for (const dir of dirs) await cp(path.join(project, dir), path.join(destination, dir), { recursive: true });
}
async function distHash(dir) {
  const result = checked(process.execPath, [path.join(dir, "scripts/web-dist.mjs"), "--install", "--root", dir]);
  assert.match(result.stdout, /verified/i);
  const manifest = JSON.parse(await readFile(path.join(dir, "dist/build-manifest.json"), "utf8"));
  return manifest.outputs.sha256;
}
function git(repo, args) {
  return checked("git", args, { cwd: repo, env: safeEnv() });
}
async function packageCount(dir) {
  let count = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === ".package-lock.json" || entry.name === ".bin") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && entry.name.startsWith("@")) await walk(full);
      else if (entry.isDirectory()) count += 1;
    }
  }
  await walk(dir);
  return count;
}
async function assertHubLifecycle(installed, label) {
  const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  const cli = path.join(installed, pkg.bin["pi-web-hub"]);
  const privateRoot = path.join(root, `hub-${label}`);
  await mkdir(privateRoot, { mode: 0o700 });
  const config = path.join(privateRoot, "config.json");
  checked(process.execPath, [cli, "init", "--config", config, "--port", "0"], { cwd: privateRoot, env: safeEnv() });
  const credentialFile = path.join(privateRoot, "session.json");
  const issued = checked(process.execPath, [cli, "issue", "--config", config, "--label", "Install fixture", "--output", credentialFile], { cwd: privateRoot, env: safeEnv() });
  const credential = JSON.parse(await readFile(credentialFile, "utf8"));
  assert.ok(!`${issued.stdout}${issued.stderr}`.includes(credential.token), "CLI must not print session token");
  assert.equal((await stat(credentialFile)).mode & 0o077, 0);
  const child = spawn(process.execPath, [cli, "serve", "--config", config], { cwd: privateRoot, env: safeEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stderr.resume();
  let timer;
  try {
    const ready = await new Promise((resolve, reject) => {
      let output = "";
      timer = setTimeout(() => reject(new Error("Installed hub readiness timed out")), 10000);
      child.once("error", () => reject(new Error("Installed hub failed to spawn")));
      child.once("close", () => reject(new Error("Installed hub closed before ready")));
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 8192) return reject(new Error("Installed hub readiness output exceeded limit"));
        if (!output.includes("\n")) return;
        try { resolve(JSON.parse(output.split("\n")[0])); } catch { reject(new Error("Installed hub readiness is invalid")); }
      });
    });
    clearTimeout(timer);
    const page = await fetch(`${ready.localUrl}sessions/`, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200, "installed CLI must serve portal");
    assert.match(await page.text(), /<title>Pi/);
    const list = await fetch(`${ready.localUrl}api/sessions`, { signal: AbortSignal.timeout(5000) });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).sessions, []);
    checked(process.execPath, [cli, "revoke", "--config", config, "--run-id", credential.run_id], { cwd: privateRoot, env: safeEnv() });
    const grant = JSON.parse(await readFile(path.join(privateRoot, "state/grants", `${credential.run_id}.json`), "utf8"));
    assert.equal(grant.revoked, true);
    child.kill("SIGTERM");
    const result = await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Installed hub did not shut down")), 5000);
    })]);
    assert.equal(result, 0, "installed hub must exit successfully");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await rm(privateRoot, { recursive: true, force: true });
  }
}

async function assertProductionInstall(agentDir, expectedHash) {
  const installed = path.join(agentDir, "git", "github.com", "pi-web-ui-install-test", "pi-web-ui");
  assert.equal(await distHash(installed), expectedHash, "installed dist integrity check");
  const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["ws"]);
  const modules = path.join(installed, "node_modules");
  for (const forbidden of ["vite", "typescript", "react", "pi-coding-agent", "@earendil-works/pi-coding-agent"]) {
    await assert.rejects(stat(path.join(modules, forbidden)), { code: "ENOENT" });
  }
  const count = await packageCount(modules);
  assert.equal(count, 1, "Git install must contain only ws");
  assert.match(
    checked(process.execPath, [path.join(installed, pkg.bin["pi-web-hub"]), "--help"]).stdout,
    /independent multi-session portal/,
    "Git install must include a working hub CLI",
  );
  return { installed, packageCount: count };
}

try {
  await mkdir(base, { recursive: true });
  root = await mkdtemp(path.join(base, "run-"));
  const fixture = path.join(root, "fixture");
  const workspace = path.join(root, "workspace");
  const agent = path.join(root, "agent");
  const repo = path.join(root, "source.git");
  await copyFixture(fixture);
  await mkdir(workspace);
  const initialHash = await distHash(fixture);
  checked("git", ["init", "-b", "main", fixture]);
  checked("git", ["config", "user.name", "Install Test"], { cwd: fixture });
  checked("git", ["config", "user.email", "install-test@example.invalid"], { cwd: fixture });
  checked("git", ["add", "-A"], { cwd: fixture });
  checked("git", ["commit", "-m", "fixture v1"], { cwd: fixture });
  checked("git", ["clone", "--bare", fixture, repo]);

  const install = run(process.env.PI_INSTALL_TEST_BIN || "pi", ["install", gitSpec], {
    cwd: workspace,
    env: piEnv(agent, repo),
  });
  assert.equal(install.status, 0, `Pi git install failed (${install.status}):\n${install.stderr}`);
  const first = await assertProductionInstall(agent, initialHash);

  await writeFile(path.join(first.installed, "dist", "stale-sentinel"), "stale\n");
  await writeFile(path.join(fixture, "docs/installation-test.txt"), "fixture-only update\n");
  checked("git", ["add", "-A"], { cwd: fixture });
  checked("git", ["commit", "-m", "fixture v2"], { cwd: fixture });
  checked("git", ["push", repo, "main"], { cwd: fixture });
  const update = run(process.env.PI_INSTALL_TEST_BIN || "pi", ["update", gitSpec], {
    cwd: workspace,
    env: piEnv(agent, repo),
  });
  assert.equal(update.status, 0, `Pi git update failed (${update.status}):\n${update.stderr}`);
  const second = await assertProductionInstall(agent, initialHash);
  await assertHubLifecycle(second.installed, "git-update");
  await assert.rejects(stat(path.join(second.installed, "dist", "stale-sentinel")), { code: "ENOENT" });
  const actualHead = git(second.installed, ["rev-parse", "HEAD"]).stdout.trim();
  const fixtureHead = git(fixture, ["rev-parse", "HEAD"]).stdout.trim();
  assert.equal(actualHead, fixtureHead, "updated checkout must point at fixture HEAD");

  const staleInputs = [
    "src/web/index.html",
    "extensions/remote-access/plan.ts",
    "extensions/remote-access/gateway.py",
    "hub/server.ts",
    "bin/pi-web-hub.mjs",
    "vite.hub.config.ts",
    "extensions/workspace-uploads.ts",
    "extensions/runtime-control.ts",
    "extensions/runtime-metadata.ts",
    "extensions/runtime-stdin-guard.mjs",
    "src/web/src/core/incremental-sha256.ts",
  ];
  for (const [index, input] of staleInputs.entries()) {
    const sourcePath = path.join(fixture, input);
    const originalSource = await readFile(sourcePath);
    await writeFile(sourcePath, Buffer.concat([originalSource, Buffer.from("\n<!-- stale-source-test -->\n")]));
    const negative = run(process.execPath, [path.join(fixture, "scripts/web-dist.mjs"), "--install", "--root", fixture]);
    assert.notEqual(negative.status, 0, `source mismatch should fail verification: ${input}`);
    checked("git", ["add", "-A"], { cwd: fixture });
    checked("git", ["commit", "-m", `fixture stale input must fail installation: ${input}`], { cwd: fixture });
    checked("git", ["push", repo, "main"], { cwd: fixture });
    const rejectedInstall = run(process.env.PI_INSTALL_TEST_BIN || "pi", ["install", gitSpec], {
      cwd: workspace,
      env: piEnv(path.join(root, `negative-agent-${index}`), repo),
    });
    assert.notEqual(rejectedInstall.status, 0, `Real Pi install must reject a stale-source commit via prepare: ${input}`);
    assert.match(rejectedInstall.stdout + rejectedInstall.stderr, /Source inventory mismatch/);
    await writeFile(sourcePath, originalSource);
  }

  const packDir = path.join(root, "pack");
  await mkdir(packDir);
  checked("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], { cwd: fixture, env: safeEnv() });
  const tgz = path.join(
    packDir,
    (await readdir(packDir)).find((file) => file.endsWith(".tgz")),
  );
  const consumer = path.join(root, "npm-consumer");
  await mkdir(consumer);
  checked("npm", ["install", tgz, "--prefix", consumer, "--omit=dev", "--legacy-peer-deps"], {
    cwd: root,
    env: safeEnv(),
  });
  const packed = path.join(consumer, "node_modules", "@kkkiio", "pi-web-ui");
  assert.match(
    checked(process.execPath, [path.join(packed, "scripts/web-dist.mjs"), "--install", "--root", packed]).stdout,
    /verified/i,
  );
  for (const required of [
    "dist/build-manifest.json",
    "docs/images",
    "docs/remote-access.md",
    "docs/hub.md",
    "bin/pi-web-hub.mjs",
    "dist/hub/pi-web-hub.mjs",
    "hub/server.ts",
    "extensions/connection-config.ts",
    "extensions/connection-listener.ts",
    "extensions/runtime-control.ts",
    "extensions/runtime-metadata.ts",
    "extensions/runtime-stdin-guard.mjs",
    "extensions/workspace-uploads.ts",
    "extensions/session-registration.ts",
    "extensions/remote-access/plan.ts",
    "extensions/remote-access/gateway.py",
    "scripts/web-dist.mjs",
    "LICENSE",
  ]) {
    await stat(path.join(packed, required));
  }
  const packedManifest = JSON.parse(await readFile(path.join(packed, "dist/build-manifest.json"), "utf8"));
  await assertHubLifecycle(packed, "tarball");
  const packedPkg = JSON.parse(await readFile(path.join(packed, "package.json"), "utf8"));
  assert.match(
    checked(process.execPath, [path.join(packed, packedPkg.bin["pi-web-hub"]), "--help"]).stdout,
    /independent multi-session portal/,
    "Tarball must include a working hub CLI",
  );
  assert.equal(packedManifest.outputs.sha256, initialHash);
  assert.deepEqual(Object.keys(packedPkg.dependencies ?? {}).sort(), ["ws"]);
  const count = await packageCount(path.join(consumer, "node_modules"));
  assert.equal(count, 2, "Tarball consumer must contain only the root package and ws");
  const lockChanged =
    sha(await readFile(path.join(second.installed, "package-lock.json"))) !==
    sha(await readFile(path.join(fixture, "package-lock.json")));
  console.log(
    JSON.stringify({
      result: "passed",
      install: "passed",
      update: "passed",
      sourceMismatch: "rejected by real Pi install prepare",
      rejectedStaleInputs: staleInputs,
      tarball: "passed",
      installedHubLifecycle: "init/issue/serve/HTTP/revoke/SIGTERM passed for Git update and tarball",
      productionPackages: second.packageCount,
      tarballConsumerPackages: count,
      npmRewroteLock: lockChanged,
      ...(keep ? { runtimeRoot: root, installedRuntime: second.installed } : {}),
    }),
  );
} catch (error) {
  console.error(`Git install production test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (root && !keep) await rm(root, { recursive: true, force: true });
}
