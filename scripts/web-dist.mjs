import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_NAME = "build-manifest.json";
const SCHEMA_VERSION = 1;
const REQUIRED_OUTPUTS = ["index.html", "hub/pi-web-hub.mjs"];
const SOURCE_DIRECTORIES = ["src/web", "public", "hub", "bin"];
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
const SOURCE_POLICY_PATHS = new Set(SOURCE_FILES);
const SOURCE_POLICY_PREFIXES = SOURCE_DIRECTORIES.map((directory) => `${directory}/`);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePathKey(key, label = "manifest path") {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.startsWith("/") ||
    path.posix.isAbsolute(key) ||
    path.win32.isAbsolute(key) ||
    /^[a-zA-Z]:/.test(key)
  ) {
    fail(`Invalid ${label}: expected a normalized relative POSIX path`);
  }
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`Invalid ${label}: path must not contain empty, "." or ".." segments`);
  }
  return key;
}

function isAllowedSourcePath(key) {
  return SOURCE_POLICY_PATHS.has(key) || SOURCE_POLICY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

async function checkedRoot(rootPath) {
  const root = path.resolve(rootPath);
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") fail(`Project root does not exist: ${root}`);
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`Project root must not be a symlink: ${root}`);
  if (!stat.isDirectory()) fail(`Project root must be a directory: ${root}`);
  return root;
}

async function checkedDirectory(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") fail(`Required directory is missing: ${relativePath}`);
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`Refusing to follow symlink: ${relativePath}`);
    if (!stat.isDirectory()) fail(`Expected a directory: ${relativePath}`);
  }
  return path.join(root, ...relativePath.split("/"));
}

async function checkedRegularFile(root, key, { optional = false } = {}) {
  validatePathKey(key, "file path");
  const segments = key.split("/");
  const fileName = segments.pop();
  let parent = root;
  if (segments.length > 0) parent = await checkedDirectory(root, segments.join("/"));
  const absolute = path.join(parent, fileName);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT" && optional) return null;
    if (error.code === "ENOENT") fail(`Required file is missing: ${key}`);
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`Refusing to follow symlink: ${key}`);
  if (!stat.isFile()) fail(`Expected a regular file: ${key}`);
  return absolute;
}

async function hashRegularFile(absolutePath, key) {
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`Expected a regular file: ${key}`);
    return sha256(await handle.readFile());
  } catch (error) {
    if (error.code === "ELOOP") fail(`Refusing to follow symlink: ${key}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function walkFiles(root, directoryKey, records) {
  const absoluteDirectory = await checkedDirectory(root, directoryKey);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read directory ${directoryKey}: ${error.message}`, { cause: error });
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));

  for (const entry of entries) {
    const key = `${directoryKey}/${entry.name}`;
    validatePathKey(key, "filesystem path");
    if (entry.isSymbolicLink()) fail(`Refusing to follow symlink: ${key}`);
    if (entry.isDirectory()) {
      await walkFiles(root, key, records);
    } else if (entry.isFile()) {
      const absolute = await checkedRegularFile(root, key);
      records.push({ path: key, sha256: await hashRegularFile(absolute, key) });
    } else {
      fail(`Unsupported filesystem entry (not a regular file or directory): ${key}`);
    }
  }
}

async function inventorySource(root, { excludePackageLock = false } = {}) {
  const records = [];
  for (const directory of SOURCE_DIRECTORIES) await walkFiles(root, directory, records);
  for (const key of SOURCE_FILES) {
    if (excludePackageLock && key === "package-lock.json") continue;
    const absolute = await checkedRegularFile(root, key);
    records.push({ path: key, sha256: await hashRegularFile(absolute, key) });
  }
  return makeInventory(records);
}

async function inventoryOutputs(root) {
  const records = [];
  const distDirectory = await checkedDirectory(root, "dist");
  await walkOutputDirectory(root, distDirectory, "dist", records);
  const inventory = makeInventory(records);
  for (const key of REQUIRED_OUTPUTS) {
    if (!inventory.files.some((entry) => entry.path === key)) fail(`Build output is incomplete: dist/${key} is missing`);
  }
  await validateHtmlReferences(root, inventory);
  return inventory;
}

async function validateHtmlReferences(root, inventory) {
  const index = await checkedRegularFile(root, "dist/index.html");
  const html = (await readFileNoFollow(index, "dist/index.html")).toString("utf8");
  const references = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gis)) references.push(match[2]);
  for (const match of html.matchAll(/<link\b([^>]*)>/gis)) {
    const attrs = new Map(
      [...match[1].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map((entry) => [entry[1].toLowerCase(), entry[3]]),
    );
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("stylesheet") || rel.includes("modulepreload")) {
      if (attrs.has("href")) references.push(attrs.get("href"));
    }
  }
  const outputPaths = new Set(inventory.files.map((entry) => entry.path));
  for (const reference of references) {
    if (/^(?:https?:)?\/\//i.test(reference) || /^[a-z][a-z0-9+.-]*:/i.test(reference)) continue;
    let pathname;
    try {
      pathname = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    } catch {
      fail(`Invalid encoded HTML asset reference: ${reference}`);
    }
    const key = path.posix.normalize(pathname.startsWith("/") ? pathname.slice(1) : pathname);
    if (!pathname || key === ".." || key.startsWith("../") || key.startsWith("/"))
      fail(`HTML asset reference escapes dist: ${reference}`);
    validatePathKey(key, "HTML asset reference");
    if (!outputPaths.has(key)) fail(`HTML asset reference is missing from dist: ${reference}`);
  }
}

async function walkOutputDirectory(root, absoluteDirectory, relativeDirectory, records) {
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read directory ${relativeDirectory}: ${error.message}`, { cause: error });
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));

  for (const entry of entries) {
    const key = `${relativeDirectory}/${entry.name}`;
    validatePathKey(key, "filesystem path");
    if (key === `dist/${MANIFEST_NAME}`) continue;
    if (entry.isSymbolicLink()) fail(`Refusing to follow symlink: ${key}`);
    const absolute = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) fail(`Refusing to follow symlink: ${key}`);
      if (!stat.isDirectory()) fail(`Expected a directory: ${key}`);
      await walkOutputDirectory(root, absolute, key, records);
    } else if (entry.isFile()) {
      const checked = await checkedRegularFile(root, key);
      records.push({ path: key.slice("dist/".length), sha256: await hashRegularFile(checked, key) });
    } else {
      fail(`Unsupported filesystem entry (not a regular file or directory): ${key}`);
    }
  }
}

function makeInventory(records) {
  const files = records.sort((left, right) => compareStrings(left.path, right.path));
  return {
    count: files.length,
    sha256: sha256(JSON.stringify(files)),
    files,
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isObject(value)) fail(`Invalid manifest: ${label} must be an object`);
  const actual = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`Invalid manifest: ${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function validateInventory(inventory, label) {
  assertExactKeys(inventory, ["count", "sha256", "files"], label);
  if (!Number.isSafeInteger(inventory.count) || inventory.count < 0) {
    fail(`Invalid manifest: ${label}.count must be a non-negative integer`);
  }
  if (!Array.isArray(inventory.files) || inventory.count !== inventory.files.length) {
    fail(`Invalid manifest: ${label}.count does not match its files`);
  }
  if (typeof inventory.sha256 !== "string" || !HASH_PATTERN.test(inventory.sha256)) {
    fail(`Invalid manifest: ${label}.sha256 must be a lowercase SHA-256 hash`);
  }

  let previousPath = null;
  for (const [index, file] of inventory.files.entries()) {
    assertExactKeys(file, ["path", "sha256"], `${label}.files[${index}]`);
    validatePathKey(file.path);
    if (typeof file.sha256 !== "string" || !HASH_PATTERN.test(file.sha256)) {
      fail(`Invalid manifest: ${label}.files[${index}].sha256 must be a lowercase SHA-256 hash`);
    }
    if (previousPath !== null && compareStrings(previousPath, file.path) >= 0) {
      fail(`Invalid manifest: ${label}.files must be sorted and contain no duplicate paths`);
    }
    previousPath = file.path;
    if (label === "source" && !isAllowedSourcePath(file.path)) {
      fail(`Invalid manifest: source path is outside the fixed source policy: ${file.path}`);
    }
  }

  if (label === "source") {
    const paths = new Set(inventory.files.map((entry) => entry.path));
    const missingRequired = SOURCE_FILES.filter((key) => !paths.has(key));
    if (missingRequired.length) {
      fail(`Invalid manifest: source is missing required paths: ${missingRequired.join(", ")}`);
    }
  }

  const expectedHash = sha256(JSON.stringify(inventory.files));
  if (inventory.sha256 !== expectedHash) fail(`Invalid manifest: ${label}.sha256 does not match its file entries`);
}

function validateManifest(manifest) {
  assertExactKeys(manifest, ["schemaVersion", "source", "outputs"], "root");
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    fail(`Unsupported build manifest schemaVersion: ${String(manifest.schemaVersion)}`);
  }
  validateInventory(manifest.source, "source");
  validateInventory(manifest.outputs, "outputs");
  for (const key of REQUIRED_OUTPUTS) {
    if (!manifest.outputs.files.some((entry) => entry.path === key)) fail(`Invalid manifest: outputs must include ${key}`);
  }
}

async function readManifest(root) {
  const key = `dist/${MANIFEST_NAME}`;
  const absolute = await checkedRegularFile(root, key, { optional: true });
  if (!absolute) fail(`Build manifest is missing: ${key}`);
  let bytes;
  try {
    bytes = await readFileNoFollow(absolute, key);
  } catch (error) {
    throw new Error(`Cannot read ${key}: ${error.message}`, { cause: error });
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`Invalid JSON in ${key}: ${error.message}`);
  }
  validateManifest(manifest);
  return manifest;
}

async function readFileNoFollow(absolutePath, key) {
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`Expected a regular file: ${key}`);
    return await handle.readFile();
  } catch (error) {
    if (error.code === "ELOOP") fail(`Refusing to follow symlink: ${key}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function assertInventoriesMatch(label, recorded, actual) {
  const actualByPath = new Map(actual.files.map((entry) => [entry.path, entry.sha256]));
  const recordedByPath = new Map(recorded.files.map((entry) => [entry.path, entry.sha256]));
  const missing = recorded.files.filter((entry) => !actualByPath.has(entry.path)).map((entry) => entry.path);
  const unexpected = actual.files.filter((entry) => !recordedByPath.has(entry.path)).map((entry) => entry.path);
  const changed = recorded.files
    .filter((entry) => actualByPath.has(entry.path) && actualByPath.get(entry.path) !== entry.sha256)
    .map((entry) => entry.path);
  if (missing.length || unexpected.length || changed.length) {
    const details = [];
    if (missing.length) details.push(`missing: ${missing.join(", ")}`);
    if (unexpected.length) details.push(`unexpected: ${unexpected.join(", ")}`);
    if (changed.length) details.push(`changed: ${changed.join(", ")}`);
    fail(`${label} inventory mismatch (${details.join("; ")})`);
  }
}

/** Create a deterministic manifest from an existing source tree and Vite dist output. */
export async function createManifest(rootPath = DEFAULT_ROOT) {
  const root = await checkedRoot(rootPath);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: await inventorySource(root),
    outputs: await inventoryOutputs(root),
  };
}

/** Write the manifest into an already-built dist directory; this function never builds or creates dist. */
export async function writeManifest(rootPath = DEFAULT_ROOT) {
  const root = await checkedRoot(rootPath);
  const manifest = await createManifest(root);
  const target = path.join(root, "dist", MANIFEST_NAME);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  let handle;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o644);
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`Expected a regular file: dist/${MANIFEST_NAME}`);
    await handle.writeFile(bytes, "utf8");
  } catch (error) {
    if (error.code === "ELOOP") fail(`Refusing to follow symlink: dist/${MANIFEST_NAME}`);
    throw error;
  } finally {
    await handle?.close();
  }
  return manifest;
}

/** Verify output assets, and by default also compare the fixed source policy inventory. */
export async function verifyManifest(rootPath = DEFAULT_ROOT, { assetsOnly = false, install = false } = {}) {
  const root = await checkedRoot(rootPath);
  const manifest = await readManifest(root);
  const outputs = await inventoryOutputs(root);
  assertInventoriesMatch("Output", manifest.outputs, outputs);
  if (!assetsOnly) {
    let compareSource = true;
    if (install) {
      try {
        const srcStat = await lstat(path.join(root, "src"));
        if (srcStat.isSymbolicLink()) fail("Refusing to follow symlink: src");
      } catch (error) {
        if (error.code === "ENOENT") compareSource = false;
        else throw error;
      }
    }
    if (compareSource) {
      const source = await inventorySource(root, { excludePackageLock: install });
      const recorded = install
        ? { ...manifest.source, files: manifest.source.files.filter((entry) => entry.path !== "package-lock.json") }
        : manifest.source;
      if (install) {
        recorded.count = recorded.files.length;
        recorded.sha256 = sha256(JSON.stringify(recorded.files));
      }
      assertInventoriesMatch("Source", recorded, source);
    }
  }
  return manifest;
}

function parseArguments(argv) {
  let mode = "verify";
  let modeSpecified = false;
  let install = false;
  let root = DEFAULT_ROOT;
  let rootSpecified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write" || argument === "--assets-only") {
      if (modeSpecified) fail("Choose only one of --write and --assets-only");
      modeSpecified = true;
      mode = argument === "--write" ? "write" : "assets-only";
    } else if (argument === "--install") {
      if (install) fail("--install may be specified only once");
      install = true;
    } else if (argument === "--root") {
      if (rootSpecified) fail("--root may be specified only once");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--root requires a path argument");
      root = path.resolve(value);
      rootSpecified = true;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      return { mode: "help", root };
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  if (mode === "assets-only") mode = "verify-assets";
  if (install && mode !== "verify") fail("--install cannot be combined with --write or --assets-only");
  return { mode, root, install };
}

const HELP = `Usage: node scripts/web-dist.mjs [--write | --assets-only | --install] [--root <path>]

  (no mode)       Verify source files and existing dist outputs
  --write         Write dist/build-manifest.json from existing source and dist
  --assets-only   Verify packaged dist outputs without requiring source files
  --install       Verify outputs; if src exists, compare source excluding package-lock.json
  --root <path>   Use another project root (for tests and fixtures)

SHA-256 values check content consistency; they do not establish trust or authenticity.`;

/** Run the CLI with an argument vector. Importing this module does not run the CLI. */
export async function main(argv = process.argv.slice(2)) {
  try {
    const { mode, root, install } = parseArguments(argv);
    if (mode === "help") {
      console.log(HELP);
      return 0;
    }
    if (mode === "write") {
      await writeManifest(root);
      console.log(`Wrote dist/${MANIFEST_NAME}.`);
      return 0;
    }
    await verifyManifest(root, { assetsOnly: mode === "verify-assets", install });
    console.log(
      mode === "verify-assets"
        ? "Packaged dist outputs verified (hash consistency only; not trust/authenticity)."
        : "Source and dist outputs verified (hash consistency only; not trust/authenticity).",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `web-dist: ${message}\nHint: run \`npm run build:web\` before \`node scripts/web-dist.mjs --write\`; for a packaged dist without source, use \`--assets-only\`.`,
    );
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
