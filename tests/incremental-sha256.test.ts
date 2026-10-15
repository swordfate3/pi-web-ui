import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { IncrementalSha256, sha256BitLengthWords, sha256Hex } from "../src/web/src/core/incremental-sha256";

const expected = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("matches standard SHA-256 vectors", () => {
  assert.equal(sha256Hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(
    sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("incremental updates match Node crypto for arbitrary boundaries", () => {
  const bytes = Uint8Array.from({ length: 8193 }, (_, index) => (index * 37 + 11) % 256);
  const hash = new IncrementalSha256();
  let offset = 0;
  for (const size of [1, 63, 64, 65, 255, 256, 257, 4093, 2, 512, 4096, 2048]) {
    const end = Math.min(bytes.length, offset + size);
    hash.update(bytes.subarray(offset, end));
    offset = end;
  }
  if (offset < bytes.length) hash.update(bytes.subarray(offset));
  assert.equal(hash.digest(), expected(bytes));
});

test("SHA-256 padding uses two-word 64-bit bit lengths without signed shifts", () => {
  assert.deepEqual(sha256BitLengthWords(0, 0), [0, 0]);
  assert.deepEqual(sha256BitLengthWords(0, 512 * 1024 * 1024), [1, 0]);
  assert.deepEqual(sha256BitLengthWords(2, 0), [16, 0]);
  assert.deepEqual(sha256BitLengthWords(0x20000000, 0), [0, 0]);
});
