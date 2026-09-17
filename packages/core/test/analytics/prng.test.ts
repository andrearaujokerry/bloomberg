// packages/core/test/analytics/prng.test.ts — WP-02 (WORKPLAN L490, L545 "seeded runs are
// bit-identical"), the determinism half of TESTING §7.11.
//
// The Monte Carlo engine's reproducibility rests entirely on this generator: `Math.random` is a
// banned property in `packages/core/src/**` (QA-02), so `options/mc.ts` draws from `makePrng`, and a
// price it produced last week must come back identical this week. The contract this file pins is
// therefore stronger than "it looks random":
//
//   1. the seed → state derivation is `sha256Hex('xoshiro128**:' + seed)`, checked against an
//      independent `node:crypto` SHA-256 (test files are outside the core tsconfig and outside every
//      ESLint boundary zone, so `node:crypto` is legal here);
//   2. the uint32 stream is the reference xoshiro128** stream, re-derived here with an independent
//      BigInt transcription of Blackman & Vigna's C code — the JS implementation uses `Math.imul`
//      and uint32 shifts, a completely different arithmetic path, so agreement over thousands of
//      draws is a real cross-check rather than a tautology;
//   3. the checked-in literal sequences: any future edit that changes a single bit fails here.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { makePrng, prngFromState, prngStateForSeed } from '../../src/analytics/prng.js';

// ---------------------------------------------------------------------------------------------
// Pinned sequences — the "bit-identical forever" contract
// ---------------------------------------------------------------------------------------------

/** `makePrng(42)`: the first eight raw draws. */
const SEED_42_UINT32 = [
  3544145829, 1070992761, 1896181240, 1326277344, 547560806, 2145414502, 1196061847, 1147294115,
];

/** `makePrng(42)`: the first six uniforms — each exactly `SEED_42_UINT32[i] / 2**32`. */
const SEED_42_UNIFORM = [
  0.8251857545692474, 0.24935993389226496, 0.44148909859359264, 0.30879800766706467,
  0.12748893490061164, 0.49951823940500617,
];

/** `makePrng(42)`: the first six standard normals (Box-Muller, paired variate cached). */
const SEED_42_NORMAL = [
  0.0024930733759864045, 0.6199091114517338, -0.4617468944886644, 1.1924737764036974,
  -2.0296338737335007, 0.006143702420162016,
];

/** A string seed of the shape Monte Carlo actually uses (`<engine>.<case>.<batch>`). */
const SEED_AAPL_UINT32 = [
  329608338, 484773470, 3800301958, 3256387332, 2374884599, 3097734609, 4268551777, 716557972,
];

const SEED_AAPL_NORMAL = [
  1.7196248120160835, 1.4756282579686926, 0.025435548154093185, -0.4940443931671683,
  -0.19559029108858753, -1.070856959240065,
];

const SEED_42_STATE = { s0: 4256320204, s1: 2986959751, s2: 2303388788, s3: 2794250740 };

/** `makePrng(42).jump()` — the reference 2⁶⁴-step jump. */
const SEED_42_AFTER_JUMP = { s0: 3728009155, s1: 2526405285, s2: 1729093399, s3: 1006263110 };
const SEED_42_AFTER_JUMP_UINT32 = [745243832, 3727880879, 220901531, 1580014151];

/** `makePrng('resample').nextInt(10)` ×12 — the historical-VaR resampling path. */
const RESAMPLE_INT10 = [0, 4, 8, 2, 6, 1, 2, 3, 6, 9, 4, 1];

const take = <T>(n: number, f: () => T): T[] => Array.from({ length: n }, () => f());

// ---------------------------------------------------------------------------------------------
// 1. A seeded run reproduces the checked-in sequence exactly
// ---------------------------------------------------------------------------------------------

describe('seeded sequences are pinned', () => {
  it('reproduces the uint32 stream for seed 42', () => {
    const g = makePrng(42);
    expect(take(8, () => g.nextUint32())).toStrictEqual(SEED_42_UINT32);
  });

  it('reproduces the uniform stream for seed 42, exactly uint32 / 2^32', () => {
    const g = makePrng(42);
    const drawn = take(6, () => g.next());
    expect(drawn).toStrictEqual(SEED_42_UNIFORM);
    drawn.forEach((u, i) => {
      expect(u).toBe(SEED_42_UINT32[i]! / 2 ** 32);
    });
  });

  it('reproduces the normal stream for seed 42', () => {
    const g = makePrng(42);
    expect(take(6, () => g.normal())).toStrictEqual(SEED_42_NORMAL);
  });

  it('reproduces both streams for a string seed', () => {
    const a = makePrng('aapl.mc.1');
    expect(take(8, () => a.nextUint32())).toStrictEqual(SEED_AAPL_UINT32);
    const b = makePrng('aapl.mc.1');
    expect(take(6, () => b.normal())).toStrictEqual(SEED_AAPL_NORMAL);
  });

  it('reproduces the unbiased integer stream', () => {
    const g = makePrng('resample');
    expect(take(12, () => g.nextInt(10))).toStrictEqual(RESAMPLE_INT10);
  });

  it('gives two generators on the same seed the same 10,000 draws', () => {
    const a = makePrng('mc.batch.0');
    const b = makePrng('mc.batch.0');
    for (let i = 0; i < 10_000; i += 1) expect(b.nextUint32()).toBe(a.nextUint32());
  });

  it('gives different seeds different streams', () => {
    const one = makePrng(1);
    const two = makePrng(2);
    const batch = makePrng('mc.batch.0');
    const first = take(64, () => one.nextUint32());
    const second = take(64, () => two.nextUint32());
    const third = take(64, () => batch.nextUint32());
    expect(second).not.toStrictEqual(first);
    expect(third).not.toStrictEqual(first);
    // 192 draws from three decorrelated streams: a collision would be a 2^-32 coincidence.
    expect(new Set([...first, ...second, ...third]).size).toBe(192);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The derivation is reproducible from first principles, not just from the literals above
// ---------------------------------------------------------------------------------------------

describe('seed derivation', () => {
  it('is sha256("xoshiro128**:" + seed) sliced into four uint32 words', () => {
    for (const seed of [42, 0, 'aapl.mc.1', 'mc.batch.0']) {
      const hex = createHash('sha256')
        .update(`xoshiro128**:${String(seed)}`, 'utf8')
        .digest('hex');
      const expected = {
        s0: Number.parseInt(hex.slice(0, 8), 16),
        s1: Number.parseInt(hex.slice(8, 16), 16),
        s2: Number.parseInt(hex.slice(16, 24), 16),
        s3: Number.parseInt(hex.slice(24, 32), 16),
        spare: null,
      };
      expect(prngStateForSeed(seed)).toStrictEqual(expected);
    }
    expect(prngStateForSeed(42)).toStrictEqual({ ...SEED_42_STATE, spare: null });
  });

  it('treats a numeric seed as its decimal text, so 42 and "42" are one stream', () => {
    expect(prngStateForSeed(42)).toStrictEqual(prngStateForSeed('42'));
    const a = makePrng(42);
    const b = makePrng('42');
    expect(take(16, () => a.nextUint32())).toStrictEqual(take(16, () => b.nextUint32()));
    expect(prngStateForSeed(-0)).toStrictEqual(prngStateForSeed(0));
  });

  it('rejects a non-finite numeric seed', () => {
    expect(() => makePrng(Number.NaN)).toThrow(/finite/);
    expect(() => makePrng(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("refuses the all-zero state, xoshiro's single fixed point", () => {
    expect(() => prngFromState({ s0: 0, s1: 0, s2: 0, s3: 0, spare: null })).toThrow(/all zero/);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The stream is the reference xoshiro128** stream (independent BigInt transcription)
// ---------------------------------------------------------------------------------------------

describe('xoshiro128** reference agreement', () => {
  const MASK = (1n << 32n) - 1n;
  const rotl = (x: bigint, k: bigint): bigint => ((x << k) | (x >> (32n - k))) & MASK;

  /** Blackman & Vigna's C `next()`, transcribed with BigInt masking — no imul, no int32 lanes. */
  function reference(seed: string): () => bigint {
    const hex = createHash('sha256').update(`xoshiro128**:${seed}`, 'utf8').digest('hex');
    const s = [0, 1, 2, 3].map((i) => BigInt(`0x${hex.slice(i * 8, i * 8 + 8)}`)) as [
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    return () => {
      const result = (rotl((s[1] * 5n) & MASK, 7n) * 9n) & MASK;
      const t = (s[1] << 9n) & MASK;
      s[2] = s[2] ^ s[0];
      s[3] = s[3] ^ s[1];
      s[1] = s[1] ^ s[2];
      s[0] = s[0] ^ s[3];
      s[2] = s[2] ^ t;
      s[3] = rotl(s[3], 11n);
      return result;
    };
  }

  it('matches the reference for 5,000 consecutive draws on three seeds', () => {
    for (const seed of ['42', 'aapl.mc.1', 'mc.batch.0']) {
      const ref = reference(seed);
      const g = makePrng(seed === '42' ? 42 : seed);
      for (let i = 0; i < 5_000; i += 1) {
        expect(BigInt(g.nextUint32()), `${seed} draw ${i}`).toBe(ref());
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. clone() — what antithetic sampling branches on
// ---------------------------------------------------------------------------------------------

describe('clone', () => {
  it('continues the identical stream from the branch point', () => {
    const g = makePrng('mc.antithetic');
    take(37, () => g.next());
    const twin = g.clone();
    const a = take(64, () => g.next());
    const b = take(64, () => twin.next());
    expect(b).toStrictEqual(a);
  });

  it('is independent afterwards: draining the clone does not move the parent', () => {
    const g = makePrng(7);
    const twin = g.clone();
    take(1_000, () => twin.nextUint32());
    expect(g.state()).toStrictEqual(prngFromState(prngStateForSeed(7)).state());
    expect(g.nextUint32()).toBe(makePrng(7).nextUint32());
  });

  it('carries the cached Box-Muller variate, so a mid-pair branch is exact', () => {
    const g = makePrng(42);
    expect(g.normal()).toBe(SEED_42_NORMAL[0]);
    expect(g.state().spare).toBe(SEED_42_NORMAL[1]);
    const twin = g.clone();
    expect(twin.normal()).toBe(SEED_42_NORMAL[1]);
    expect(g.normal()).toBe(SEED_42_NORMAL[1]);
    expect(twin.normal()).toBe(SEED_42_NORMAL[2]);
    expect(g.normal()).toBe(SEED_42_NORMAL[2]);
  });

  it('round-trips through state()', () => {
    const g = makePrng('checkpoint');
    take(11, () => g.normal());
    const resumed = prngFromState(g.state());
    expect(take(8, () => resumed.normal())).toStrictEqual(take(8, () => g.normal()));
  });
});

// ---------------------------------------------------------------------------------------------
// 5. jump() — independent sub-streams
// ---------------------------------------------------------------------------------------------

describe('jump', () => {
  it('lands on the pinned state and continues on the pinned stream', () => {
    const g = makePrng(42);
    g.jump();
    expect(g.state()).toStrictEqual({ ...SEED_42_AFTER_JUMP, spare: null });
    expect(take(4, () => g.nextUint32())).toStrictEqual(SEED_42_AFTER_JUMP_UINT32);
  });

  it('moves onto a stream disjoint from the un-jumped one', () => {
    const plain = makePrng(42);
    const jumped = makePrng(42);
    jumped.jump();
    const a = new Set(take(256, () => plain.nextUint32()));
    const b = take(256, () => jumped.nextUint32());
    expect(b.filter((x) => a.has(x))).toHaveLength(0);
  });

  it('drops a half-consumed normal pair, which belongs to the old stream', () => {
    const g = makePrng(42);
    g.normal();
    expect(g.state().spare).not.toBeNull();
    g.jump();
    expect(g.state().spare).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Distributional sanity — the sequence is pinned, but it must also be usable
// ---------------------------------------------------------------------------------------------

describe('distribution', () => {
  it('draws uniforms in [0, 1) with mean 1/2 and variance 1/12', () => {
    const g = makePrng('uniform.sanity');
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    let min = 1;
    let max = 0;
    for (let i = 0; i < n; i += 1) {
      const u = g.next();
      expect(u >= 0 && u < 1).toBe(true);
      sum += u;
      sumSq += u * u;
      if (u < min) min = u;
      if (u > max) max = u;
    }
    const mean = sum / n;
    expect(mean).toBeCloseTo(0.5, 2);
    expect(sumSq / n - mean * mean).toBeCloseTo(1 / 12, 3);
    expect(min).toBeLessThan(0.001);
    expect(max).toBeGreaterThan(0.999);
  });

  it('draws standard normals with mean 0, variance 1 and a plausible tail', () => {
    const g = makePrng('normal.sanity');
    const n = 200_000;
    let sum = 0;
    let sumSq = 0;
    let beyondTwoSigma = 0;
    for (let i = 0; i < n; i += 1) {
      const z = g.normal();
      sum += z;
      sumSq += z * z;
      if (Math.abs(z) > 2) beyondTwoSigma += 1;
    }
    const mean = sum / n;
    // Standard error of the mean is 1/sqrt(200000) ≈ 0.0022, so |mean| < 0.01 is ~4.5 s.e.
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(sumSq / n - mean * mean).toBeCloseTo(1, 2);
    // P(|Z| > 2) = 4.550 %; 200k draws put the s.e. at 0.047 %, so ±0.3 % is ~6 s.e.
    expect((100 * beyondTwoSigma) / n).toBeGreaterThan(4.25);
    expect((100 * beyondTwoSigma) / n).toBeLessThan(4.85);
  });

  it('draws integers inside the requested range only, and validates the bound', () => {
    const g = makePrng('int.sanity');
    const counts = new Array<number>(5).fill(0);
    for (let i = 0; i < 50_000; i += 1) {
      const k = g.nextInt(5);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(5);
      counts[k] = counts[k]! + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(9_000); // 10,000 expected per bucket
    expect(() => g.nextInt(0)).toThrow(/maxExclusive/);
    expect(() => g.nextInt(-1)).toThrow(/maxExclusive/);
    expect(() => g.nextInt(2.5)).toThrow(/maxExclusive/);
    expect(() => g.nextInt(2 ** 32 + 1)).toThrow(/maxExclusive/);
  });
});
