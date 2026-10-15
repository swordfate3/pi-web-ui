import assert from "node:assert/strict";
import test from "node:test";
import {
  clampWhalePosition,
  placeWhaleCard,
  readWhalePosition,
  WHALE_POSITION_STORAGE_KEY,
  writeWhalePosition,
} from "../src/web/src/core/whale-pet.ts";

test("clamps pet position within a viewport and honors non-zero viewport offsets", () => {
  const viewport = { left: 20, top: 30, width: 400, height: 300 };
  const size = { width: 100, height: 80 };
  assert.deepEqual(clampWhalePosition({ x: 500, y: -40 }, viewport, size), { x: 308, y: 42 });
  assert.deepEqual(clampWhalePosition({ x: Number.NaN, y: Infinity }, viewport, size), { x: 32, y: 42 });
  assert.deepEqual(clampWhalePosition({ x: 50, y: 60 }, viewport, { width: 500, height: 400 }), { x: 32, y: 42 });
});

test("places the card near the pet, flips when the preferred side does not fit, and clamps edges", () => {
  const viewport = { left: 0, top: 0, width: 360, height: 640 };
  const card = { width: 300, height: 240 };
  assert.deepEqual(placeWhaleCard({ left: 280, top: 500, right: 320, bottom: 540 }, card, viewport), { x: 48, y: 248 });
  assert.deepEqual(placeWhaleCard({ left: 10, top: 20, right: 50, bottom: 60 }, card, viewport), { x: 12, y: 72 });
});

test("reads only finite non-negative coordinates from storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const getStorage = () => storage;

  assert.equal(readWhalePosition(getStorage), null);
  values.set(WHALE_POSITION_STORAGE_KEY, "{not json");
  assert.equal(readWhalePosition(getStorage), null);
  values.set(WHALE_POSITION_STORAGE_KEY, JSON.stringify({ x: -1, y: 10 }));
  assert.equal(readWhalePosition(getStorage), null);
  values.set(WHALE_POSITION_STORAGE_KEY, JSON.stringify({ x: 10, y: Infinity }));
  assert.equal(readWhalePosition(getStorage), null);
  values.set(WHALE_POSITION_STORAGE_KEY, JSON.stringify({ x: 10, y: 20, token: "never persisted" }));
  assert.deepEqual(readWhalePosition(getStorage), { x: 10, y: 20 });
});

test("storage access and writes fail safely when browser storage is unavailable", () => {
  assert.equal(
    readWhalePosition(() => {
      throw new Error("blocked");
    }),
    null,
  );
  assert.equal(
    readWhalePosition(() => null),
    null,
  );
  assert.equal(
    writeWhalePosition(
      () => {
        throw new Error("blocked");
      },
      { x: 10, y: 20 },
    ),
    false,
  );
  assert.equal(
    writeWhalePosition(() => null, { x: 10, y: 20 }),
    false,
  );
  assert.equal(
    writeWhalePosition(() => null, { x: -1, y: 20 }),
    false,
  );
});
