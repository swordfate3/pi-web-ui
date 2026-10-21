import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("root service worker never intercepts proxied sessions, APIs or another app", () => {
  const handlers = new Map<string, (event: unknown) => void>();
  let intercepted = 0;
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    URL,
    Response,
    self: {
      location: { origin: "https://web.example" },
      addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    },
    fetch: () => Promise.resolve(new Response("ok", { status: 503 })),
    caches: {},
  });
  for (const route of [
    "/s/session/",
    "/s/session/assets/a.js",
    "/api/export/a",
    "/ws",
    "/another-app/",
    "/terminal/",
    "/terminal/app.js",
    "/terminal.js",
    "/terminal.css",
  ]) {
    handlers.get("fetch")?.({
      request: { url: `https://web.example${route}`, method: "GET" },
      respondWith: () => intercepted++,
    });
  }
  handlers.get("fetch")?.({
    request: { url: "https://other.example/assets/a.js", method: "GET" },
    respondWith: () => intercepted++,
  });
  assert.equal(intercepted, 0);
  handlers.get("fetch")?.({
    request: { url: "https://web.example/assets/a.js", method: "GET" },
    respondWith: () => intercepted++,
  });
  assert.equal(intercepted, 1);
});
