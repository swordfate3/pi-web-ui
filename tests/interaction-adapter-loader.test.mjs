import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url));

for (const [id, source] of [["mcp", "web-interactions.ts"], ["agents", "src/web-interactions.ts"]]) {
  for (const present of [true, false]) {
  test(`${id} Jiti import ${present ? "loads the installed public API" : "keeps absent optional API unavailable"} without a test resolver`, async (t) => {
    const temp = mkdtempSync(path.join(tmpdir(), "interaction-jiti-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const patch = readFileSync(path.join(root, "integrations/adapters", `${id}.patch`), "utf8");
    const section = patch.split(`diff --git a/${source} b/${source}\n`)[1]?.split("\ndiff --git ")[0];
    assert.ok(section, "distributed adapter source exists");
    const text = section.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
    const loader = text.match(/async function importPublicInteractions\(\): Promise<PublicInteractionModule \| undefined> \{[\s\S]*?\n\}/)?.[0];
    assert.ok(loader, "exercise the actual distributed import implementation");
    mkdirSync(path.join(temp, "node_modules/@kkkiio"), { recursive: true });
    if (present) symlinkSync(root, path.join(temp, "node_modules/@kkkiio/pi-web-ui"));
    const file = path.join(temp, "adapter.ts");
    writeFileSync(file, `type PublicInteractionModule = Record<string, unknown>;\nexport ${loader}\n`);
    const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
    const module = await jiti.import(file);
    const api = await module.importPublicInteractions();
    if (present) {
      assert.equal(typeof api?.createInteractionClient, "function");
      assert.equal(typeof api?.registerInteractionPanel, "function");
    } else assert.equal(api, undefined);
  });
  }
}
