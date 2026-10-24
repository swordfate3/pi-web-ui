/** Development artifact builder; reads staged source baselines, never installed packages. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), "adapters");
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error("Usage: node integrations/export-adapters.mjs <development-source-copies-root>");
mkdirSync(output, { recursive: true });
const sources = [];
for (const id of ["memory", "knowledge", "mcp", "agents"]) {
  const cwd = path.resolve(sourceRoot, id);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const tracked = git("diff", "--name-only", "-z").split("\0").filter(Boolean).sort();
  const added = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter((file) => /\.(?:ts|mjs|cjs|js|json)$/.test(file)).sort();
  const baseline = JSON.parse(git("show", ":package.json"));
  const changes = [];
  for (const file of [...tracked, ...added]) {
    if (!file || path.isAbsolute(file) || file.split("/").some((part) => part === ".." || part === ".git" || part === "node_modules") || !/^[A-Za-z0-9_.\/-]+$/.test(file)) throw new Error("Unsupported source path");
    const before = tracked.includes(file) ? Buffer.from(git("show", `:${file}`)) : null;
    const after = readFileSync(path.join(cwd, file));
    changes.push({ path: file, before: before ? sha(before) : null, after: sha(after) });
  }
  let patch = git("diff", "--binary", "--no-ext-diff", "--no-color");
  for (const file of added) {
    const body = readFileSync(path.join(cwd, file), "utf8");
    if (body.includes("\0") || !body.endsWith("\n")) throw new Error("New adapter sources must be newline-terminated text");
    const lines = body.slice(0, -1).split("\n");
    patch += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}`;
  }
  const file = `${id}.patch`;
  writeFileSync(path.join(output, file), patch);
  sources.push({ id, packageName: baseline.name, version: baseline.version, file, sha256: sha(patch), changes });
}
writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify({ schema: 1, protocol: "pi-web-interactions-v1", sources }, null, 2)}\n`);
console.log(`Exported ${sources.length} adapters with exact preimage/postimage hashes.`);
