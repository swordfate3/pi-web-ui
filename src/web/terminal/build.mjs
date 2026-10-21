import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const output = new URL("../../../dist/terminal/", import.meta.url);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [new URL("app.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: new URL("app.js", output).pathname,
  logLevel: "warning",
});
await copyFile(new URL("index.html", import.meta.url), new URL("index.html", output));
