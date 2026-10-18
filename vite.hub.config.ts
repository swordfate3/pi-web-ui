import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";

// Ship JavaScript: Node intentionally does not strip TypeScript inside node_modules.
export default defineConfig(async () => {
  const root = import.meta.dirname;
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== "@kkkiio/pi-web-ui" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("Invalid Hub package metadata");
  }
  // Native dynamic import keeps this Node-only ESM helper out of Vite's CJS config bundle.
  const { createSourceInventory } = await import(pathToFileURL(path.join(root, "scripts/web-dist.mjs")).href);
  const source = await createSourceInventory(root);
  return {
    // Embed identity from source, not the previous output manifest (which would be stale/circular).
    define: {
      __PI_WEB_HUB_METADATA__: JSON.stringify({ version: manifest.version, build: source.sha256 }),
    },
    publicDir: false,
    build: {
      ssr: path.resolve(import.meta.dirname, "bin/pi-web-hub.mjs"),
      outDir: "dist/hub",
      emptyOutDir: true,
      target: "node22",
      minify: false,
      rolldownOptions: {
        external: [/^node:/, "ws"],
        output: { format: "esm", entryFileNames: "pi-web-hub.mjs", codeSplitting: false },
      },
    },
  };
});
