/** Rebuild clean development baselines, check/apply once, verify every final byte. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [sourceRoot, option] = process.argv.slice(2);
if (!sourceRoot || option && option !== "--keep") throw new Error("Usage: node integrations/verify-adapter-release.mjs <development-source-copies-root> [--keep]");
const dir = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(dir, "check-adapter.mjs");
const manifest = JSON.parse(readFileSync(path.join(dir, "adapters/manifest.json"), "utf8"));
const root = mkdtempSync(path.join(tmpdir(), "pi-adapter-release-"));
try {
  for (const source of manifest.sources) {
    const destination = path.join(root, source.id);
    mkdirSync(destination);
    execFileSync("git", ["checkout-index", "--all", `--prefix=${destination}${path.sep}`], {
      cwd: path.resolve(sourceRoot, source.id), stdio: "pipe",
    });
    for (const args of [[], ["--apply"]]) execFileSync(process.execPath, [checker, source.id, destination, ...args], { stdio: "pipe" });
  }
  console.log(JSON.stringify({ adapters: manifest.sources.length, exactPostimages: true, ...(option === "--keep" ? { root } : { cleaned: true }) }));
} finally {
  if (option !== "--keep") rmSync(root, { recursive: true, force: true });
}
