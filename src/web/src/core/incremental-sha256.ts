/** Small dependency-free SHA-256 implementation for bounded browser file slices. */
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const rotateRight = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** Encode the low two 32-bit words of a byte count as SHA-256's 64-bit bit length. */
export function sha256BitLengthWords(bytesHigh: number, bytesLow: number): [number, number] {
  return [((bytesHigh << 3) | (bytesLow >>> 29)) >>> 0, (bytesLow << 3) >>> 0];
}

export class IncrementalSha256 {
  private readonly state = new Uint32Array(INITIAL_STATE);
  private readonly buffer = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private bufferLength = 0;
  private bytesLow = 0;
  private bytesHigh = 0;
  private finished = false;

  update(input: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest is already finalized");
    const nextLow = (this.bytesLow + input.length) >>> 0;
    if (nextLow < this.bytesLow) this.bytesHigh = (this.bytesHigh + 1) >>> 0;
    this.bytesHigh = (this.bytesHigh + Math.floor(input.length / 0x1_0000_0000)) >>> 0;
    this.bytesLow = nextLow;

    let offset = 0;
    if (this.bufferLength) {
      const count = Math.min(64 - this.bufferLength, input.length);
      this.buffer.set(input.subarray(0, count), this.bufferLength);
      this.bufferLength += count;
      offset = count;
      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
    while (offset + 64 <= input.length) {
      this.compress(input.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < input.length) {
      this.buffer.set(input.subarray(offset), 0);
      this.bufferLength = input.length - offset;
    }
    return this;
  }

  digest(): string {
    if (this.finished) throw new Error("SHA-256 digest is already finalized");
    this.finished = true;
    const tail = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
    tail.set(this.buffer.subarray(0, this.bufferLength));
    tail[this.bufferLength] = 0x80;
    const [bitHigh, bitLow] = sha256BitLengthWords(this.bytesHigh, this.bytesLow);
    const lengthOffset = tail.length - 8;
    for (let i = 0; i < 4; i++) {
      tail[lengthOffset + i] = bitHigh >>> (24 - i * 8);
      tail[lengthOffset + 4 + i] = bitLow >>> (24 - i * 8);
    }
    for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail.subarray(offset, offset + 64));
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(block: Uint8Array): void {
    const words = this.words;
    for (let i = 0; i < 16; i++) {
      const at = i * 4;
      words[i] = ((block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + sigma0 + words[i - 7] + sigma1) >>> 0;
    }
    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + ROUND_CONSTANTS[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return new IncrementalSha256().update(bytes).digest();
}
