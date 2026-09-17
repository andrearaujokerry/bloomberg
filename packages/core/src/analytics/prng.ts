/**
 * The seeded PRNG every stochastic analytic draws from — WORKPLAN §WP-02 L490, ARCHITECTURE L158,
 * L170 (`options/mc.ts` "Monte Carlo antithetic + control variate, seeded").
 *
 * xoshiro128\*\* (Blackman & Vigna, 2018): four 32-bit words of state, a `*5 <<<7 *9` scrambler,
 * period 2¹²⁸−1, and — the reason it is in `packages/core` at all — arithmetic that is exactly
 * representable in JavaScript. Every step is `Math.imul`, a shift and an XOR on uint32 lanes, so the
 * sequence is bit-identical on every engine, every platform and every release: `Math.random` is a
 * banned property in this package precisely because a Monte Carlo price that cannot be reproduced is
 * not a price (QA-02, TESTING §7.11).
 *
 * Determinism rules this file must never break:
 *
 *  - the seed → state derivation is `sha256Hex('xoshiro128**:' + seed)`, using core's own
 *    hand-written SHA-256. The domain-separation prefix and the hex slicing are part of the
 *    contract: changing either changes every seeded sequence in the system;
 *  - `next()` is the top 32 bits divided by 2³², so it lies in [0, 1) — never 1;
 *  - `normal()` is Box-Muller with the second variate cached, and the cache is part of the state,
 *    so `clone()` really does branch an identical stream;
 *  - nothing here reads a clock, `Math.random`, or any ambient state.
 *
 * `clone()` is what antithetic sampling needs: draw the path, clone the generator before the draw,
 * and the antithetic twin consumes the *same* uniforms with the sign flipped. `jump()` is the
 * reference 2⁶⁴-step jump, for handing independent sub-streams to independent batches of paths.
 */

import { sha256Hex } from '../hash/sha256.js';

/** A 32-bit left rotation on the uint32 lane. */
function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

const TWO_32 = 4294967296;

/** The reference xoshiro128** jump polynomial: 2⁶⁴ calls to `nextUint32` in one step. */
const JUMP = [0x8764000b, 0xf542d2d3, 0x6fa035c3, 0x77f2db5b] as const;

/** A generator's complete state: the four words plus the cached Box-Muller variate. */
export interface PrngState {
  readonly s0: number;
  readonly s1: number;
  readonly s2: number;
  readonly s3: number;
  /** The unconsumed second Box-Muller variate, or `null` when there is none. */
  readonly spare: number | null;
}

/** The generator interface Monte Carlo code depends on. */
export interface Prng {
  /** Uniform in [0, 1), 32-bit resolution. */
  next(): number;
  /** The raw uint32 draw. */
  nextUint32(): number;
  /** Uniform integer in [0, maxExclusive), unbiased (rejection sampling). */
  nextInt(maxExclusive: number): number;
  /** Standard normal N(0, 1) by Box-Muller, with the paired variate cached. */
  normal(): number;
  /** An independent generator starting from this one's exact current state. */
  clone(): Prng;
  /** Advance by 2⁶⁴ draws — an independent sub-stream for a parallel batch. */
  jump(): void;
  /** The current state, for checkpointing or for `prngFromState`. */
  state(): PrngState;
}

class Xoshiro128StarStar implements Prng {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;
  #spare: number | null;

  constructor(state: PrngState) {
    this.#s0 = state.s0 >>> 0;
    this.#s1 = state.s1 >>> 0;
    this.#s2 = state.s2 >>> 0;
    this.#s3 = state.s3 >>> 0;
    this.#spare = state.spare;
    if ((this.#s0 | this.#s1 | this.#s2 | this.#s3) === 0) {
      // The all-zero state is xoshiro's single fixed point: it emits zeros forever.
      throw new RangeError('makePrng: the xoshiro128** state must not be all zero');
    }
  }

  nextUint32(): number {
    let s0 = this.#s0;
    let s1 = this.#s1;
    let s2 = this.#s2;
    let s3 = this.#s3;

    const result = Math.imul(rotl32(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;

    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl32(s3, 11);

    this.#s0 = s0;
    this.#s1 = s1;
    this.#s2 = s2;
    this.#s3 = s3;
    return result;
  }

  next(): number {
    return this.nextUint32() / TWO_32;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > TWO_32) {
      throw new RangeError(
        `nextInt: maxExclusive must be an integer in [1, 2^32], got ${String(maxExclusive)}`,
      );
    }
    if (maxExclusive === TWO_32) return this.nextUint32();
    // Reject the ragged tail so every residue class is equally likely.
    const limit = TWO_32 - (TWO_32 % maxExclusive);
    let x = this.nextUint32();
    while (x >= limit) x = this.nextUint32();
    return x % maxExclusive;
  }

  normal(): number {
    const cached = this.#spare;
    if (cached !== null) {
      this.#spare = null;
      return cached;
    }
    // Box-Muller needs u1 ∈ (0, 1]: log(0) is −∞. `next()` can return exactly 0, so redraw.
    let u1 = this.next();
    while (u1 === 0) u1 = this.next();
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    this.#spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  }

  clone(): Prng {
    return new Xoshiro128StarStar(this.state());
  }

  jump(): void {
    let j0 = 0;
    let j1 = 0;
    let j2 = 0;
    let j3 = 0;
    for (const word of JUMP) {
      for (let bit = 0; bit < 32; bit += 1) {
        if ((word & (1 << bit)) !== 0) {
          j0 = (j0 ^ this.#s0) >>> 0;
          j1 = (j1 ^ this.#s1) >>> 0;
          j2 = (j2 ^ this.#s2) >>> 0;
          j3 = (j3 ^ this.#s3) >>> 0;
        }
        this.nextUint32();
      }
    }
    this.#s0 = j0;
    this.#s1 = j1;
    this.#s2 = j2;
    this.#s3 = j3;
    // The jumped stream is a different stream: a half-consumed normal pair does not belong to it.
    this.#spare = null;
  }

  state(): PrngState {
    return Object.freeze({
      s0: this.#s0,
      s1: this.#s1,
      s2: this.#s2,
      s3: this.#s3,
      spare: this.#spare,
    });
  }
}

/**
 * The seed's canonical text form. A number seed is its shortest round-trip decimal (`String`), so
 * `makePrng(42)` and `makePrng('42')` are deliberately the same stream — one seed, one sequence.
 */
function seedText(seed: number | string): string {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new RangeError('makePrng: a numeric seed must be finite');
    return String(seed === 0 ? 0 : seed); // normalise -0 → '0'
  }
  return seed;
}

/**
 * Derive the four state words from the seed.
 *
 * SHA-256 rather than SplitMix32 on purpose: `sha256Hex` is already the notarised, test-vectored
 * primitive in this package (`core/src/hash/sha256.ts`), it decorrelates adjacent seeds (0, 1, 2 …
 * are the seeds people actually use) and it makes the derivation reproducible from the seed string
 * alone, in any language, forever.
 */
export function prngStateForSeed(seed: number | string): PrngState {
  const hex = sha256Hex(`xoshiro128**:${seedText(seed)}`);
  const word = (i: number): number => Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  const s0 = word(0);
  const s1 = word(1);
  const s2 = word(2);
  const s3 = word(3);
  if ((s0 | s1 | s2 | s3) === 0) {
    // Unreachable for any real seed (it needs 128 leading zero bits of SHA-256), but the all-zero
    // state is the one state the generator cannot escape, so it is handled rather than assumed.
    return Object.freeze({
      s0: 0x9e3779b9,
      s1: 0x243f6a88,
      s2: 0xb7e15162,
      s3: 0x85ebca6b,
      spare: null,
    });
  }
  return Object.freeze({ s0, s1, s2, s3, spare: null });
}

/**
 * A seeded xoshiro128\*\* generator. The same seed yields the same sequence in every process, on
 * every machine and in every release (ANAL-08's determinism guarantee, extended to Monte Carlo).
 */
export function makePrng(seed: number | string): Prng {
  return new Xoshiro128StarStar(prngStateForSeed(seed));
}

/** Resume a generator from a checkpointed `state()` — the other half of `clone()`. */
export function prngFromState(state: PrngState): Prng {
  return new Xoshiro128StarStar(state);
}
