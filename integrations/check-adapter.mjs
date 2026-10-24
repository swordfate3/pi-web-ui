/** Check by default. Explicit --apply is for a reviewed, disposable source checkout. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const [id, suppliedRoot, option] = process.argv.slice(2);
if (!id || !suppliedRoot || option && option !== "--apply") throw new Error("Usage: node integrations/check-adapter.mjs <memory|knowledge|mcp|agents> <source-checkout> [--apply]");
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "adapters");
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const source = manifest.sources.find((item) => item.id === id);
if (manifest.schema !== 1 || !source) throw new Error("Unknown adapter artifact");
const supplied = path.resolve(suppliedRoot);
const root = realpathSync(supplied);
if (supplied !== root || !lstatSync(root).isDirectory()) throw new Error("Use an explicit real source directory, not a symlink");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.name !== source.packageName || pkg.version !== source.version) throw new Error("Package name/version does not match the reviewed source baseline");
const patchFile = path.join(dir, source.file);
if (sha(readFileSync(patchFile)) !== source.sha256) throw new Error("Adapter patch integrity mismatch");
for (const change of source.changes) {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(change.path) || path.isAbsolute(change.path) || change.path.split("/").some((part) => ["", ".", "..", ".git", "node_modules"].includes(part))) throw new Error("Invalid artifact path");
  let part = root;
  for (const segment of change.path.split("/")) { part = path.join(part, segment); if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error("Source path contains a symlink"); }
  const file = path.join(root, change.path);
  if (change.before === null ? existsSync(file) : !existsSync(file) || sha(readFileSync(file)) !== change.before) throw new Error(`Source baseline changed: ${change.path}`);
}
execFileSync("git", ["apply", "--check", "--", patchFile], { cwd: root, stdio: "pipe" });
if (option === "--apply") {
  execFileSync("git", ["apply", "--", patchFile], { cwd: root, stdio: "pipe" });
  for (const change of source.changes) if (sha(readFileSync(path.join(root, change.path))) !== change.after) throw new Error(`Postimage mismatch: ${change.path}`);
  console.log("Applied adapter to the explicit source checkout; every postimage verified. No runtime was restarted.");
} else console.log("Baseline and patch verified. Read-only check; no source file changed.");
