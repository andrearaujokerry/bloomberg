/**
 * SHA-256 (FIPS 180-4), dependency-free, synchronous, pure TypeScript — WORKPLAN §1.6 / §18.
 *
 * `packages/core` has `zod` as its only dependency, no `@types/node`, `lib:["ES2022"]` with no DOM,
 * and an ESLint zone that forbids `node:*`. So `node:crypto` is banned and untyped here, and
 * `globalThis.crypto.subtle` needs DOM/Node lib types and is async. ANAL-08's
 * `inputsHash = sha256Hex(canonicalJson(inputs))` must be the same function on every side — that is
 * what makes `vol_surfaces.inputs_hash`, `curve_builds.inputs_hash` and `fin_statements.inputs_hash`
 * comparable across processes — so the implementation lives here.
 *
 * Verified against the FIPS 180-4 / NIST vectors in `core/test/hash/sha256.test.ts`.
 */

/** FIPS 180-4 §4.2.2: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = '0123456789abcdef';

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * UTF-8 encode without `TextEncoder` (a Node/DOM global that is out of scope here).
 * Unpaired surrogates become U+FFFD, matching the WHATWG encoding standard.
 */
export function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }

    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** The 32 raw digest bytes. */
export function sha256(input: string | Uint8Array): Uint8Array {
  const msg = typeof input === 'string' ? utf8Bytes(input) : input;
  const len = msg.length;

  // Pad: message ‖ 0x80 ‖ 0x00* ‖ 64-bit big-endian bit length, to a multiple of 64 bytes.
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(msg);
  buf[len] = 0x80;

  const bitsHi = Math.floor(len / 0x20000000); // (len * 8) / 2^32
  const bitsLo = (len * 8) >>> 0;
  const end = blocks * 64;
  buf[end - 8] = (bitsHi >>> 24) & 0xff;
  buf[end - 7] = (bitsHi >>> 16) & 0xff;
  buf[end - 6] = (bitsHi >>> 8) & 0xff;
  buf[end - 5] = bitsHi & 0xff;
  buf[end - 4] = (bitsLo >>> 24) & 0xff;
  buf[end - 3] = (bitsLo >>> 16) & 0xff;
  buf[end - 2] = (bitsLo >>> 8) & 0xff;
  buf[end - 1] = bitsLo & 0xff;

  // FIPS 180-4 §5.3.3: fractional parts of the square roots of the first 8 primes.
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let b = 0; b < blocks; b++) {
    const base = b * 64;
    for (let t = 0; t < 16; t++) {
      const o = base + t * 4;
      w[t] =
        (((buf[o] ?? 0) << 24) |
          ((buf[o + 1] ?? 0) << 16) |
          ((buf[o + 2] ?? 0) << 8) |
          (buf[o + 3] ?? 0)) >>>
        0;
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15] ?? 0;
      const y = w[t - 2] ?? 0;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b1 = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + (K[t] ?? 0) + (w[t] ?? 0)) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b1) ^ (a & c) ^ (b1 & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b1;
      b1 = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b1) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    const v = words[i] ?? 0;
    digest[i * 4] = (v >>> 24) & 0xff;
    digest[i * 4 + 1] = (v >>> 16) & 0xff;
    digest[i * 4 + 2] = (v >>> 8) & 0xff;
    digest[i * 4 + 3] = v & 0xff;
  }
  return digest;
}

/**
 * Lowercase hex SHA-256 of a UTF-8 string or a byte array. 64 characters, so it fits
 * `char(64)` columns (`inputs_hash`, `query_sql_hash`, `request_key`).
 */
export function sha256Hex(input: string | Uint8Array): string {
  const d = sha256(input);
  let out = '';
  for (const byte of d) {
    out += HEX[(byte >>> 4) & 0x0f] ?? '0';
    out += HEX[byte & 0x0f] ?? '0';
  }
  return out;
}
