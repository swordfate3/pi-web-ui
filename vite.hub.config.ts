import path from "node:path";
import { defineConfig } from "vite";

// Ship JavaScript: Node intentionally does not strip TypeScript inside node_modules.
export default defineConfig({
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
});
