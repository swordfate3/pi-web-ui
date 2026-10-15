import assert from "node:assert/strict";
import test from "node:test";
import { isPngSignature, isWebpSignature } from "../src/web/src/core/whale-assets.ts";

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

test("PNG and WebP validators do not mistake each other's signatures", () => {
  assert.equal(isPngSignature(new Uint8Array(validWebpHeader)), false);
  assert.equal(isWebpSignature(new Uint8Array(validOnePixelPng.subarray(0, 12))), false);
});
