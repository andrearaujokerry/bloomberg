// packages/core/test/hash/sha256.test.ts — WP-01 acceptance test (WORKPLAN §1.11).
//
// `core/src/hash/sha256.ts` is a hand-written FIPS 180-4 implementation: `packages/core` has no
// `@types/node`, no DOM lib and an ESLint zone that forbids `node:*`, so it cannot delegate to
// `node:crypto` or to `crypto.subtle`. That makes it the one piece of core whose correctness rests
// entirely on this file.
//
// It matters beyond hashing: ANAL-08 defines `inputsHash = sha256Hex(canonicalJson(inputs))`, and
// `vol_surfaces.inputs_hash`, `curve_builds.inputs_hash` and `fin_statements.inputs_hash` are only
// comparable across processes if every process computes the same 64 hex characters.
//
// What is asserted:
//   1. the published NIST / FIPS 180-4 vectors, including the empty string;
//   2. every message length from 0 to 200 bytes, which walks the padding logic across the
//      one-block / two-block boundaries (55, 56, 63, 64, 119, 120 bytes);
//   3. UTF-8 encoding of non-ASCII text, astral-plane characters and lone surrogates;
//   4. agreement with `node:crypto` — allowed here because a test file is outside the core
//      package's tsconfig (`include: ["src/**/*.ts"]`) and outside every ESLint boundary zone.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256, sha256Hex, utf8Bytes } from '../../src/hash/sha256.js';

/** `node:crypto` reference digest, for the cross-check cases. */
const ref = (input: string | Uint8Array): string =>
  createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input))
    .digest('hex');

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------------------------
// 1. Published vectors
// ---------------------------------------------------------------------------------------------

/**
 * FIPS 180-4 Appendix B / the NIST CSRC "SHA-256 Examples" and NESSIE test vectors.
 * Every digest below is quoted from the published document, not produced by this codebase.
 */
const NIST_VECTORS: readonly {
  readonly name: string;
  readonly input: string;
  readonly digest: string;
}[] = [
  {
    // The canonical empty-string digest (NIST CSRC, "SHA-256 of the empty message").
    name: 'the empty string',
    input: '',
    digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    // FIPS 180-4 Appendix B.1 — one-block message, 24 bits.
    name: "FIPS 180-4 B.1 'abc'",
    input: 'abc',
    digest: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  {
    // FIPS 180-4 Appendix B.2 — two-block message, 448 bits (the 56-byte padding edge).
    name: 'FIPS 180-4 B.2 448-bit message',
    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    digest: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  },
  {
    // NIST CSRC "SHA-256 Examples" — 896-bit message (the 120-byte padding edge).
    name: 'NIST 896-bit message',
    input:
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    digest: 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  },
  {
    // The widely published pangram vector.
    name: 'the pangram',
    input: 'The quick brown fox jumps over the lazy dog',
    digest: 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
  },
  {
    // A single changed character must change the digest completely (avalanche).
    name: 'the pangram with a full stop',
    input: 'The quick brown fox jumps over the lazy dog.',
    digest: 'ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c',
  },
];

describe('sha256 — NIST / FIPS 180-4 vectors', () => {
  for (const vector of NIST_VECTORS) {
    it(`matches the published digest for ${vector.name}`, () => {
      expect(sha256Hex(vector.input)).toBe(vector.digest);
    });
  }

  it('hashes the empty string to e3b0c442… from a zero-length byte array too', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the NIST 1,000,000 × "a" vector', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('every published vector is exactly 64 lowercase hex characters', () => {
    for (const vector of NIST_VECTORS) {
      expect(vector.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256Hex(vector.input)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Padding: every length across the block boundaries
// ---------------------------------------------------------------------------------------------

describe('sha256 — padding', () => {
  it('agrees with node:crypto for every message length 0..200 bytes', () => {
    // Deterministic filler (no Math.random — QA-02): a 16-bit LCG over the byte range.
    const filler = new Uint8Array(200);
    let state = 0x2f6e;
    for (let i = 0; i < filler.length; i++) {
      state = (state * 1103 + 12345) & 0xffff;
      filler[i] = state & 0xff;
    }

    const mismatches: number[] = [];
    for (let len = 0; len <= 200; len++) {
      const slice = filler.slice(0, len);
      if (hex(sha256(slice)) !== ref(slice)) mismatches.push(len);
    }
    expect(mismatches).toEqual([]);
  });

  it.each([55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128])(
    'pads a %i-byte message the way FIPS 180-4 §5.1.1 requires',
    (len) => {
      const message = 'a'.repeat(len);
      expect(sha256Hex(message)).toBe(ref(message));
    },
  );

  it('produces 32 raw bytes whose hex form is sha256Hex', () => {
    const digest = sha256('abc');
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(32);
    expect(hex(digest)).toBe(sha256Hex('abc'));
  });

  it('hashes a string and its UTF-8 bytes identically', () => {
    for (const text of ['', 'abc', 'PX_LAST', 'AAPL US Equity', 'é', '😀']) {
      expect(sha256Hex(text)).toBe(sha256Hex(utf8Bytes(text)));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. UTF-8 encoding (there is no TextEncoder in core's lib set)
// ---------------------------------------------------------------------------------------------

describe('utf8Bytes', () => {
  it.each([
    ['ASCII', 'abc', [0x61, 0x62, 0x63]],
    ['2-byte', 'é', [0xc3, 0xa9]],
    ['3-byte', '€', [0xe2, 0x82, 0xac]],
    ['4-byte (astral)', '😀', [0xf0, 0x9f, 0x98, 0x80]],
  ])('encodes %s correctly', (_name, text, bytes) => {
    expect([...utf8Bytes(text)]).toEqual(bytes);
  });

  it('agrees with Buffer for mixed text', () => {
    const text = 'Δημόσιο 国債 4.25% 08/15/36 — “Govt” 😀';
    expect([...utf8Bytes(text)]).toEqual([...Buffer.from(text, 'utf8')]);
    expect(sha256Hex(text)).toBe(ref(text));
  });

  it('replaces a lone surrogate with U+FFFD, as the WHATWG encoding standard does', () => {
    const highOnly = '\uD83D';
    const lowOnly = '\uDE00';
    expect([...utf8Bytes(highOnly)]).toEqual([0xef, 0xbf, 0xbd]);
    expect([...utf8Bytes(lowOnly)]).toEqual([0xef, 0xbf, 0xbd]);
    // Same replacement Node performs, so the digests agree.
    expect(sha256Hex(highOnly)).toBe(ref(highOnly));
    expect(sha256Hex(lowOnly)).toBe(ref(lowOnly));
  });

  it('does not split a valid surrogate pair', () => {
    expect([...utf8Bytes('😀')]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Determinism — what ANAL-08 actually relies on
// ---------------------------------------------------------------------------------------------

describe('sha256Hex — determinism (ANAL-08 inputsHash)', () => {
  it('is stable across calls and fits a char(64) column', () => {
    const payload = '{"curveId":"SOFR_OIS","quotes":[1.0,2.5],"valuationDate":"2026-09-15"}';
    const first = sha256Hex(payload);
    expect(sha256Hex(payload)).toBe(first);
    expect(first).toHaveLength(64);
    expect(first).toBe(ref(payload));
  });

  it('separates inputs that differ only in key order', () => {
    const a = '{"a":1,"b":2}';
    const b = '{"b":2,"a":1}';
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});
