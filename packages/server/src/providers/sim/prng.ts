/**
 * The seeded generator behind the deterministic simulated feed — PROVIDERS.a §4.1 (L538-550).
 *
 * Replay proves that yesterday's bytes still produce yesterday's numbers; it cannot produce a
 * market that ticks for an hour. The WebSocket, conflation and backpressure tests need a feed that
 * moves continuously and is identical run to run, or they are flaky by construction.
 *
 * Three functions, exactly as §4.1 declares them:
 *
 * - {@link xoshiro128ss} — xoshiro128**, 128 bits of state, period 2^128 − 1, no allocation per
 *   draw, uniform on `[0, 1)`;
 * - {@link hash32} — FNV-1a 32, for deriving a per-subject seed from a string;
 * - {@link gaussian} — Box–Muller with the second draw cached.
 *
 * **One stream per subject**, seeded `xoshiro128ss(hash32(`${seed}|${subject}`))`, never a shared
 * global. That is what makes the feed composable: adding `q:77` to a scenario does not shift the
 * path of `q:42`, so a test that pins AAPL's tick sequence keeps passing when someone adds MSFT to
 * the fixture.
 *
 * Pure: no clock, no crypto, no global state beyond the per-stream Gaussian cache, which is keyed
 * by the stream itself. Every operation is 32-bit integer arithmetic through `Math.imul` and
 * `>>> 0`, so the sequence is identical on every platform V8 runs on.
 */

/** 2^24 — the number of distinct values {@link xoshiro128ss} returns. */
const UNIT_SCALE = 16_777_216;

/** 32-bit rotate left. */
function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * FNV-1a, 32-bit, over the UTF-16 code units of `text`. Returns an unsigned 32-bit integer.
 *
 * Used only to derive a seed from a subject name; it is not a checksum and nothing depends on its
 * collision behaviour beyond "two different subjects almost never share a stream".
 */
export function hash32(text: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // hash *= 16777619, in 32 bits.
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}

/**
 * SplitMix32 — the seeder. xoshiro needs 128 bits of well-distributed state, and expanding a
 * 32-bit seed by hand (`s0 = seed, s1 = seed + 1, …`) gives neighbouring seeds correlated streams.
 */
export function splitmix32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x9e37_79b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0_aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a_2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

/**
 * xoshiro128** seeded from a 32-bit integer.
 *
 * @returns a function drawing uniformly from `[0, 1)` in steps of 2^-24. The top 24 bits are used
 * because the low bits of a xoshiro word are the weakest, and 24 bits is exactly what a double's
 * mantissa holds without rounding.
 */
export function xoshiro128ss(seed: number): () => number {
  const mix = splitmix32(Number.isFinite(seed) ? seed | 0 : 0);
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();
  // An all-zero state is a fixed point of the generator. It cannot occur from SplitMix32, but the
  // check costs nothing and turns a catastrophic silent failure into an impossible one.
  if ((s0 | s1 | s2 | s3) === 0) s0 = 0x9e37_79b9;

  return () => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return (result >>> 8) / UNIT_SCALE;
  };
}

/** The stream for one subject: `xoshiro128ss(hash32(`${seed}|${subject}`))`, per §4.1. */
export function subjectRng(seed: number, subject: string): () => number {
  return xoshiro128ss(hash32(`${String(seed)}|${subject}`));
}

/**
 * The cached second Box–Muller draw, keyed by the stream that produced it.
 *
 * Box–Muller produces two independent standard normals per pair of uniforms; throwing one away
 * doubles the uniforms consumed and changes the path. The cache is per stream, so interleaving
 * subjects cannot make one subject's draw depend on another's — which is the whole point of one
 * stream per subject. A `WeakMap` keeps it out of the way of the garbage collector.
 */
const gaussianCache = new WeakMap<() => number, number>();

/**
 * A standard normal draw (mean 0, variance 1) from `rng`, Box–Muller, second draw cached.
 *
 * `Math.log` and `Math.cos` are V8's own implementations, identical on every platform for a given
 * V8 build — which is what §4.4 relies on when it says two runs of the same seed are bit-identical.
 */
export function gaussian(rng: () => number): number {
  const cached = gaussianCache.get(rng);
  if (cached !== undefined) {
    gaussianCache.delete(rng);
    return cached;
  }
  // u1 must not be 0: log(0) is -Infinity. The generator can return exactly 0.
  let u1 = rng();
  while (u1 <= 0) u1 = rng();
  const u2 = rng();
  const radius = Math.sqrt(-2 * Math.log(u1));
  const angle = 2 * Math.PI * u2;
  gaussianCache.set(rng, radius * Math.sin(angle));
  return radius * Math.cos(angle);
}

/**
 * An explicitly-stateful Gaussian stream — the same arithmetic as {@link gaussian} with the cache
 * in a closure rather than the `WeakMap`. Preferred when a caller holds the generator anyway.
 */
export function gaussianStream(rng: () => number): () => number {
  let cached: number | null = null;
  return () => {
    if (cached !== null) {
      const value = cached;
      cached = null;
      return value;
    }
    let u1 = rng();
    while (u1 <= 0) u1 = rng();
    const u2 = rng();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    cached = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/** Uniform on `[lo, hi)`. */
export function uniform(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** A uniform integer in `[lo, hi]`, inclusive. Returns `lo` when the range is empty or unordered. */
export function intBetween(rng: () => number, lo: number, hi: number): number {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return Math.trunc(lo) || 0;
  const span = Math.floor(hi) - Math.ceil(lo) + 1;
  if (span <= 0) return Math.ceil(lo);
  return Math.ceil(lo) + Math.min(span - 1, Math.floor(rng() * span));
}

/** An element of `items`, uniformly. `null` when `items` is empty. */
export function pick<T>(rng: () => number, items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))] ?? null;
}
