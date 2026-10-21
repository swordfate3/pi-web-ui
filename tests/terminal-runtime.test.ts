import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createSourceInventory } from "../scripts/web-dist.mjs";

const source = new URL("../runtime/terminal/protocol.ts", import.meta.url);

test("private runtime framing rejects unbounded and invalid UTF-8 before dispatch", async () => {
  assert.ok(existsSync(source), "bounded runtime protocol must exist");
  const { JsonLines } = await import("../runtime/terminal/protocol.ts");
  const frames: unknown[] = [];
  const parser = new JsonLines((value: unknown) => frames.push(value));
  parser.push(Buffer.from('{"v":'));
  parser.push(Buffer.from('1}\n{"v":2}\n'));
  assert.deepEqual(frames, [{ v: 1 }, { v: 2 }]);
  assert.throws(() => new JsonLines(() => {}).push(Buffer.alloc(65_537, 32)));
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from(`{"x":"${"a".repeat(65_528)}"}\n`)));
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])));
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from("[]\n")));
});

test("runtime control sources participate in the immutable distribution inventory", async () => {
  const inventory = await createSourceInventory();
  for (const name of ["broker.ts", "protocol.ts", "supervisor.py", "client.py", "build.mjs"]) {
    assert.ok(
      inventory.files.some((entry: { path: string }) => entry.path === `runtime/terminal/${name}`),
      `runtime source ${name} must be verified`,
    );
  }
});

test("private first frames never admit command, path, or local-control fields", async () => {
  assert.ok(existsSync(source), "closed runtime protocol must exist");
  const { firstFrame } = await import("../runtime/terminal/protocol.ts");
  assert.deepEqual(firstFrame({ v: 1, op: "status", runId: "a".repeat(32) }), {
    v: 1,
    op: "status",
    runId: "a".repeat(32),
  });
  for (const extra of [{ argv: ["sh"] }, { path: "/tmp/other" }, { op: "local-yield" }, { token: "provider-secret" }]) {
    assert.throws(() => firstFrame({ v: 1, op: "status", runId: "a".repeat(32), ...extra }));
  }
});
