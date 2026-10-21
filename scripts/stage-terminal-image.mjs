/** Build-time only: verify the release and stage a closed, deterministic context. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyManifest } from "./web-dist.mjs";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function stage(root, output) {
  const manifest = await verifyManifest(root);
  // mkdir without recursive deliberately refuses overwrite/symlink destinations.
  await mkdir(output, { mode: 0o700 });
  const files = new Map();
  const add = async (source, target) => {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Non-regular staging input");
    files.set(target, await readFile(source));
  };
  for (const name of ["broker.cjs", "supervisor.py", "client.py"]) {
    await add(path.join(root, "dist/runtime", name), `runtime/${name}`);
  }
  for (const entry of manifest.source.files) {
    if (entry.path.startsWith("extensions/")) await add(path.join(root, entry.path), `package/${entry.path}`);
  }
  for (const entry of manifest.outputs.files) {
    await add(path.join(root, "dist", entry.path), `package/dist/${entry.path}`);
  }
  await add(path.join(root, "dist/build-manifest.json"), "package/dist/build-manifest.json");
  await add(path.join(root, "package.json"), "package/package.json");
  // mirror-server's only non-SDK runtime dependency. No mutable global extension
  // directory, credentials, home state or arbitrary workspace enters the context.
  const wsRoot = path.join(root, "node_modules/ws");
  const wsPackage = JSON.parse(await readFile(path.join(wsRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (wsPackage.version !== lock.packages["node_modules/ws"].version) throw new Error("ws lock mismatch");
  const walk = async (directory, relative = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), key);
      else await add(path.join(directory, entry.name), `package/node_modules/ws/${key}`);
    }
  };
  await walk(wsRoot);
  const inventory = { v: 1, sourceManifest: hash(await readFile(path.join(root, "dist/build-manifest.json"))), files: {} };
  const checks = [];
  for (const key of [...files.keys()].sort()) {
    const bytes = files.get(key);
    inventory.files[key] = hash(bytes);
    const target = path.join(output, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
    checks.push(`${inventory.files[key]}  ${key.startsWith("runtime/") ? key.slice(8) : `/opt/pi-web-ui/${key.slice(8)}`}`);
  }
  await writeFile(path.join(output, "runtime/inventory.sha256"), `${checks.join("\n")}\n`, { flag: "wx", mode: 0o644 });
  await writeFile(path.join(output, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Staged ${files.size} verified image inputs; no image build or deployment performed.`);
}

try {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--root", "--output"].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error("Use --output NEW_DIRECTORY [--root RELEASE_ROOT]");
    options.set(args[i], path.resolve(args[i + 1]));
  }
  if (!options.has("--output")) throw new Error("--output NEW_DIRECTORY required");
  await stage(options.get("--root") ?? defaultRoot, options.get("--output"));
} catch (error) {
  console.error(`terminal-image: ${error instanceof Error ? error.message : "staging failed"}`);
  process.exitCode = 1;
}
