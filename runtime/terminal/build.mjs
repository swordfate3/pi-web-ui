import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";

// esbuild is pinned in package/lock; no installation or source loader at runtime.
if (version !== "0.28.2") throw new Error("Unexpected terminal bundler version");
const destination = new URL("../../dist/runtime/", import.meta.url);
await mkdir(destination, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./broker.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("broker.cjs", destination)),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  legalComments: "eof",
});
for (const name of ["supervisor.py", "client.py"]) {
  await copyFile(new URL(name, import.meta.url), new URL(name, destination));
}
