import assert from "node:assert/strict";
import test from "node:test";
import {
  isGifSignature,
  isPngSignature,
  isWebpSignature,
  validateWhaleImage,
} from "../src/web/src/core/whale-assets.ts";

const validOnePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWJiYGD4DwAAAP//cGajQwAAAAZJREFUAwABDgEC81VxbAAAAABJRU5ErkJggg==",
  "base64",
);
const validWebpHeader = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP", "binary");

test("PNG signature validator accepts PNG magic bytes and rejects truncation or corruption", () => {
  assert.equal(isPngSignature(new Uint8Array(validOnePixelPng.subarray(0, 12))), true);
  assert.equal(isPngSignature(new Uint8Array(validOnePixelPng.subarray(0, 7))), false);
  const corrupted = new Uint8Array(validOnePixelPng.subarray(0, 12));
  corrupted[0] = 0;
  assert.equal(isPngSignature(corrupted), false);
});

test("WebP signature validator requires RIFF and WEBP markers at their fixed offsets", () => {
  assert.equal(isWebpSignature(new Uint8Array(validWebpHeader)), true);
  assert.equal(isWebpSignature(new Uint8Array(validWebpHeader.subarray(0, 11))), false);
  const corruptedRiff = new Uint8Array(validWebpHeader);
  corruptedRiff[0] = 0;
  assert.equal(isWebpSignature(corruptedRiff), false);
  const corruptedType = new Uint8Array(validWebpHeader);
  corruptedType[8] = 0;
  assert.equal(isWebpSignature(corruptedType), false);
});

test("GIF signature accepts only complete GIF87a or GIF89a magic", () => {
  for (const magic of ["GIF87a", "GIF89a"]) assert.equal(isGifSignature(Buffer.from(magic)), true);
  for (const magic of ["GIF89", "GIF88a", "gif89a", "GIF89b", "<svg/>"])
    assert.equal(isGifSignature(Buffer.from(magic)), false);
  assert.equal(isGifSignature(validOnePixelPng), false);
  assert.equal(isGifSignature(validWebpHeader), false);
});

test("GIF validation fences MIME, logical dimensions, bytes and decode failure without mutating originals", async (t) => {
  const originals = ["createImageBitmap", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  let decodes = 0;
  let closed = 0;
  const gif = Buffer.from([...Buffer.from("GIF89a"), 16, 0, 16, 0, 0, 0]);
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => {
      decodes++;
      return { width: 16, height: 16, close: () => closed++ };
    },
  });
  const pngPreview = new Blob([validOnePixelPng], { type: "image/png" });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toBlob: (callback: (blob: Blob) => void) => callback(pngPreview),
      }),
    },
  });
  const original = new Blob([gif], { type: "image/gif" });
  const accepted = await validateWhaleImage(original);
  assert.equal(accepted.mimeType, "image/gif");
  assert.equal(accepted.preview.type, "image/png");
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), gif);
  assert.equal(closed, 1);
  for (const [blob, error] of [
    [new Blob([gif], { type: "image/png" }), "mime-mismatch"],
    [new Blob(["GIF89"], { type: "image/gif" }), "invalid-signature"],
    [new Blob(["<svg/>"], { type: "image/gif" }), "invalid-signature"],
    [new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/gif" }), "file-too-large"],
    [
      new Blob([Buffer.from([...Buffer.from("GIF89a"), 1, 8, 1, 0, 0, 0])], { type: "image/gif" }),
      "invalid-dimensions",
    ],
    [
      new Blob([Buffer.from([...Buffer.from("GIF89a"), 0, 0, 1, 0, 0, 0])], { type: "image/gif" }),
      "invalid-dimensions",
    ],
  ] as const)
    await assert.rejects(validateWhaleImage(blob), { message: error });
  assert.equal(decodes, 1, "unsafe headers never reach the decoder");
  let scaledCanvas: { width: number; height: number } | undefined;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toBlob: (callback: (blob: Blob) => void) => callback(pngPreview),
        };
        scaledCanvas = canvas;
        return canvas;
      },
    },
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ width: 2048, height: 1024, close: () => closed++ }),
  });
  await validateWhaleImage(original);
  assert.equal(scaledCanvas?.width, 512);
  assert.equal(scaledCanvas?.height, 256);
  assert.equal(closed, 2);
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ width: 2049, height: 16, close: () => closed++ }),
  });
  await assert.rejects(validateWhaleImage(original), { message: "invalid-dimensions" });
  assert.equal(closed, 3, "invalid decoded bitmaps are closed too");
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => {
      throw new Error("corrupt GIF");
    },
  });
  await assert.rejects(validateWhaleImage(original), { message: "decode-failed" });
});

test("decode deadline rejects stalled validation and releases a bitmap that finishes late", async (t) => {
  const originalDecoder = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const originalTimer = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let timeout: (() => void) | undefined;
  let finish: ((bitmap: ImageBitmap) => void) | undefined;
  let closed = false;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: () =>
      new Promise<ImageBitmap>((resolve) => {
        finish = resolve;
      }),
  });
  globalThis.setTimeout = ((callback: () => void) => {
    timeout = callback;
    return 123;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  t.after(() => {
    globalThis.setTimeout = originalTimer;
    globalThis.clearTimeout = originalClear;
    if (originalDecoder) Object.defineProperty(globalThis, "createImageBitmap", originalDecoder);
    else Reflect.deleteProperty(globalThis, "createImageBitmap");
  });
  const attempt = validateWhaleImage(new Blob([validOnePixelPng], { type: "image/png" }));
  for (let i = 0; i < 20 && !finish; i++) await Promise.resolve();
  assert.ok(timeout);
  assert.ok(finish);
  timeout();
  await assert.rejects(attempt, { message: "decode-failed" });
  finish({
    width: 1,
    height: 1,
    close: () => {
      closed = true;
    },
  } as ImageBitmap);
  for (let i = 0; i < 10 && !closed; i++) await Promise.resolve();
  assert.equal(closed, true, "timed-out decodes never leak a late ImageBitmap");
});

test("PNG and WebP validators do not mistake each other's signatures", () => {
  assert.equal(isPngSignature(new Uint8Array(validWebpHeader)), false);
  assert.equal(isWebpSignature(new Uint8Array(validOnePixelPng.subarray(0, 12))), false);
});
