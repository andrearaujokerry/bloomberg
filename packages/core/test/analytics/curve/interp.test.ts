// packages/core/test/analytics/curve/interp.test.ts — WP-02 (WORKPLAN L504-506, L541):
// "monotone-convex preserves monotonicity and positivity of forwards on a stressed input".
//
// The three interpolators are the `curves.default_interpolation` values (CONTRACTS L217):
// `linear_zero | log_linear_df | monotone_convex`. What this file guards:
//
//   1. **Node exactness.** Every rule reproduces the discount factor it was handed at every node,
//      to 1e-15. TESTING §7.7 states the rule the other way round — "interpolation may change
//      values *between* nodes, never *at* them" — and for `monotone_convex` that is a real claim,
//      not a tautology: the method interpolates the *forward*, and only the zero-integral property
//      of its shape function g brings the discount factor back to the node value at x = 1.
//   2. **Positivity.** On the stressed alternating-forward set (5.25 %, 0.10 %, 6.00 %, 0.05 %,
//      4.50 %, 8.00 %, 0.10 %, 3.00 % — the set a cubic spline through the zeros sends negative),
//      the interpolated instantaneous forward stays above min(f^disc)/2 and the discount factor
//      stays strictly decreasing, on a 0.005-year grid, i.e. ~2,000 sample points.
//   3. **Monotonicity.** Over increasing discrete forwards the interpolated forward never turns
//      back on itself. The end conditions deliberately undershoot at t = 0 and overshoot at t = T,
//      so the assertion is monotonicity and the guaranteed [0, 3·max] bound, never the data range.
//
// Every expected number in `fixtures/golden/analytics/curve/interp.json` is a closed form
// (exp(-Σ f dt)) or a bound the published method guarantees; none of them came out of this code.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { InterpolationName } from '../../../src/analytics/engine.js';
import type { DfPoint, Interpolator } from '../../../src/analytics/curve/interp.js';
import {
  INTERPOLATION_NAMES,
  isInterpolationName,
  interpolationName,
  linearZero,
  logLinearDf,
  makeInterpolator,
  monotoneConvex,
} from '../../../src/analytics/curve/interp.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden file
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface GoldenCase {
  readonly id: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly inputs: Record<string, unknown>;
  readonly valuationTs: string;
  readonly expected: Record<string, number | string | boolean>;
  readonly tol: Record<string, number>;
  readonly source: string;
}

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../fixtures/golden/analytics/curve/interp.json', import.meta.url)),
    'utf8',
  ),
) as GoldenCase[];

function goldenCase(id: string): GoldenCase {
  const found = GOLDEN.find((c) => c.id === id);
  if (found === undefined) throw new Error(`golden case ${id} is missing from interp.json`);
  return found;
}

function numbers(source: unknown, what: string): number[] {
  if (!Array.isArray(source)) throw new Error(`${what} must be an array`);
  return source.map((v) => {
    if (typeof v !== 'number') throw new Error(`${what} must hold numbers`);
    return v;
  });
}

/** `[{t, df}]` from a case's `times` + piecewise-constant continuous `forwards`. */
function pointsOf(kase: GoldenCase): DfPoint[] {
  const times = numbers(kase.inputs.times, `${kase.id}.times`);
  const forwards = numbers(kase.inputs.forwards, `${kase.id}.forwards`);
  expect(forwards).toHaveLength(times.length);
  const points: DfPoint[] = [];
  let y = 0;
  let previous = 0;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i] ?? 0;
    y += (forwards[i] ?? 0) * (t - previous);
    previous = t;
    points.push({ t, df: Math.exp(-y) });
  }
  return points;
}

function expectedNumber(kase: GoldenCase, key: string): number {
  const value = kase.expected[key];
  if (typeof value !== 'number') throw new Error(`${kase.id}.expected.${key} is not a number`);
  return value;
}

/** Sample an interpolator on `gridStep` from just above 0 to the last node. */
function grid(interpolator: Interpolator, step: number): number[] {
  const last = interpolator.times[interpolator.times.length - 1] ?? 0;
  const points: number[] = [];
  for (let t = 0; t <= last + 1e-12; t += step) points.push(Math.min(t, last));
  return points;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The name list is the CHECK list
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curves.default_interpolation (CONTRACTS L217)', () => {
  it('is exactly the three CHECK values', () => {
    expect([...INTERPOLATION_NAMES]).toEqual([
      'linear_zero',
      'log_linear_df',
      'monotone_convex',
    ]);
  });

  it('accepts only those three strings', () => {
    for (const name of INTERPOLATION_NAMES) expect(isInterpolationName(name)).toBe(true);
    expect(isInterpolationName('cubic_spline')).toBe(false);
    expect(isInterpolationName('LINEAR_ZERO')).toBe(false);
    expect(isInterpolationName(undefined)).toBe(false);
    expect(() => interpolationName('cubic_spline')).toThrow(/not one of/);
    // A null column falls back to the workhorse rather than throwing.
    expect(interpolationName(null)).toBe('log_linear_df');
    expect(interpolationName('monotone_convex')).toBe('monotone_convex');
  });

  it('dispatches each name to its own implementation', () => {
    const points: DfPoint[] = [
      { t: 1, df: 0.96 },
      { t: 2, df: 0.91 },
      { t: 5, df: 0.78 },
    ];
    expect(makeInterpolator('linear_zero', points).name).toBe(linearZero(points).name);
    expect(makeInterpolator('log_linear_df', points).name).toBe(logLinearDf(points).name);
    expect(makeInterpolator('monotone_convex', points).name).toBe(monotoneConvex(points).name);
    // A non-node point must actually differ between the three, or a mis-wired factory would pass
    // every other assertion in this file.
    const dfs = INTERPOLATION_NAMES.map((n) => makeInterpolator(n, points).df(3.5));
    const [a, b, c] = dfs as [number, number, number];
    expect(Math.abs(a - b)).toBeGreaterThan(1e-6);
    expect(Math.abs(a - c)).toBeGreaterThan(1e-6);
    expect(Math.abs(b - c)).toBeGreaterThan(1e-6);
  });

  it('rejects malformed node sets', () => {
    expect(() => monotoneConvex([])).toThrow(/at least one/);
    expect(() =>
      logLinearDf([
        { t: 2, df: 0.9 },
        { t: 1, df: 0.95 },
      ]),
    ).toThrow(/strictly increasing/);
    expect(() => linearZero([{ t: 1, df: 0 }])).toThrow(/non-positive df/);
    expect(() => monotoneConvex([{ t: 0, df: 1 }])).toThrow(/non-positive t/);
    expect(() => logLinearDf([{ t: 1, df: 0.96 }]).df(-1)).toThrow(/non-negative/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// df(0) = 1 and node exactness, for all three rules
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('every interpolation is exact at its own nodes', () => {
  const kase = goldenCase('curve.interp.monotone.stressed');
  const points = pointsOf(kase);

  for (const name of INTERPOLATION_NAMES) {
    it(`${name}: df(0) = 1 and df(tᵢ) = dfᵢ`, () => {
      const interpolator = makeInterpolator(name, points);
      expect(interpolator.df(0)).toBe(1);
      for (const point of points) {
        expect(interpolator.df(point.t)).toBeCloseTo(point.df, 15);
        expect(Math.abs(interpolator.df(point.t) - point.df)).toBeLessThan(1e-15);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Case curve.interp.flat — a flat forward has exactly one interpolant
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.interp.flat (golden)', () => {
  const kase = goldenCase('curve.interp.flat');
  const points = pointsOf(kase);
  const samples = numbers(kase.inputs.sampleTimes, 'sampleTimes');
  const flatForward = expectedNumber(kase, 'forwardEverywhere');

  for (const name of INTERPOLATION_NAMES) {
    it(`${name} reproduces exp(-0.04 t) at every sample`, () => {
      const interpolator = makeInterpolator(name, points);
      for (const t of samples) {
        const expected = expectedNumber(kase, `df@${String(t)}`);
        const tol = kase.tol[`df@${String(t)}`] ?? 1e-15;
        expect(Math.abs(interpolator.df(t) - expected)).toBeLessThanOrEqual(tol);
      }
    });

    it(`${name} holds the instantaneous forward at 4 %`, () => {
      const interpolator = makeInterpolator(name, points);
      for (const t of grid(interpolator, 0.05)) {
        expect(Math.abs(interpolator.forward(t) - flatForward)).toBeLessThanOrEqual(1e-15);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Case curve.interp.monotone.stressed — positivity under alternating forwards
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.interp.monotone.stressed (golden) — monotone convex keeps forwards positive', () => {
  const kase = goldenCase('curve.interp.monotone.stressed');
  const points = pointsOf(kase);
  const step = (kase.inputs.gridStep as number | undefined) ?? 0.005;
  const lower = expectedNumber(kase, 'forwardLowerBound');
  const upper = expectedNumber(kase, 'forwardUpperBound');
  const monotone = monotoneConvex(points);
  const sampled = grid(monotone, step);

  it('the node discount factors are the golden closed forms', () => {
    for (const point of points) {
      const expected = expectedNumber(kase, `df@${String(point.t)}`);
      expect(Math.abs(point.df - expected)).toBeLessThanOrEqual(1e-15);
      expect(Math.abs(monotone.df(point.t) - expected)).toBeLessThanOrEqual(1e-15);
    }
  });

  it('reproduces every interval discrete forward exactly (nodes untouched)', () => {
    const times = numbers(kase.inputs.times, 'times');
    const forwards = numbers(kase.inputs.forwards, 'forwards');
    let previous = 0;
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i] ?? 0;
      const implied = (monotone.y(t) - monotone.y(previous)) / (t - previous);
      expect(Math.abs(implied - (forwards[i] ?? 0))).toBeLessThan(1e-14);
      previous = t;
    }
    expect(kase.expected.nodeDiscreteForwardsReproduced).toBe(true);
  });

  it('keeps the instantaneous forward inside the guaranteed band on ~2,000 grid points', () => {
    expect(sampled.length).toBeGreaterThan(1900);
    let worstLow = Number.POSITIVE_INFINITY;
    let worstHigh = Number.NEGATIVE_INFINITY;
    for (const t of sampled) {
      const f = monotone.forward(t);
      worstLow = Math.min(worstLow, f);
      worstHigh = Math.max(worstHigh, f);
    }
    expect(worstLow).toBeGreaterThanOrEqual(lower);
    expect(worstHigh).toBeLessThanOrEqual(upper);
    expect(kase.expected.forwardsNonNegative).toBe(true);
    expect(worstLow).toBeGreaterThan(0);
  });

  it('keeps the discount factor strictly decreasing', () => {
    let previousDf = 1;
    for (const t of sampled) {
      if (t === 0) continue;
      const df = monotone.df(t);
      expect(df).toBeLessThan(previousDf);
      previousDf = df;
    }
    expect(kase.expected.dfStrictlyDecreasing).toBe(true);
  });

  it('is the interpolation that survives the stress: linear_zero is not', () => {
    // The point of the case. `linear_zero` reads the same nodes and manufactures a negative
    // instantaneous forward out of them, because y = z·t is quadratic between nodes there.
    const linear = linearZero(points);
    const worst = Math.min(...sampled.map((t) => linear.forward(t)));
    expect(worst).toBeLessThan(0);
    // `log_linear_df` cannot go negative (its forward is the discrete forward itself), but it is
    // discontinuous at every node — the trade-off monotone convex exists to remove.
    const logLinear = logLinearDf(points);
    expect(Math.min(...sampled.map((t) => logLinear.forward(t)))).toBeGreaterThan(0);
    expect(Math.abs(logLinear.forward(0.9) - logLinear.forward(1.1))).toBeGreaterThan(0.05);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Case curve.interp.monotone.increasing — monotonicity preservation
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.interp.monotone.increasing (golden) — monotone convex preserves monotonicity', () => {
  const kase = goldenCase('curve.interp.monotone.increasing');
  const points = pointsOf(kase);
  const step = (kase.inputs.gridStep as number | undefined) ?? 0.005;
  const monotone = monotoneConvex(points);
  const sampled = grid(monotone, step);

  it('the node discount factors are the golden closed forms', () => {
    for (const point of points) {
      const expected = expectedNumber(kase, `df@${String(point.t)}`);
      expect(Math.abs(monotone.df(point.t) - expected)).toBeLessThanOrEqual(1e-15);
    }
  });

  it('never lets the instantaneous forward turn back on itself', () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (const t of sampled) {
      const f = monotone.forward(t);
      // A strict >= would be hostage to the last double bit; 1e-15 is ~1e-13 of a 4 % forward.
      expect(f).toBeGreaterThanOrEqual(previous - 1e-15);
      previous = f;
    }
    expect(kase.expected.forwardMonotoneNonDecreasing).toBe(true);
  });

  it('stays inside the guaranteed band and strictly discounts', () => {
    const lower = expectedNumber(kase, 'forwardLowerBound');
    const upper = expectedNumber(kase, 'forwardUpperBound');
    let previousDf = 1;
    for (const t of sampled) {
      const f = monotone.forward(t);
      expect(f).toBeGreaterThanOrEqual(lower);
      expect(f).toBeLessThanOrEqual(upper);
      if (t === 0) continue;
      const df = monotone.df(t);
      expect(df).toBeLessThan(previousDf);
      previousDf = df;
    }
    expect(kase.expected.forwardsNonNegative).toBe(true);
    expect(kase.expected.dfStrictlyDecreasing).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden file itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('fixtures/golden/analytics/curve/interp.json', () => {
  it('every case has the §7.1 record shape', () => {
    expect(GOLDEN.length).toBe(3);
    for (const kase of GOLDEN) {
      expect(kase.id).toMatch(/^curve\.interp\./);
      expect(kase.engine).toBe('curve.interp');
      expect(kase.engineVersion).toBe('1.0.0');
      expect(kase.valuationTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Object.keys(kase.expected).length).toBeGreaterThan(0);
      expect(kase.source.length).toBeGreaterThan(40);
      for (const key of Object.keys(kase.tol)) {
        expect(Object.keys(kase.expected)).toContain(key);
      }
    }
  });

  it('names only interpolations the CHECK list allows', () => {
    for (const kase of GOLDEN) {
      const one = kase.inputs.interpolation;
      if (typeof one === 'string') expect(isInterpolationName(one)).toBe(true);
      const many = kase.inputs.interpolations;
      if (Array.isArray(many)) {
        for (const name of many) expect(isInterpolationName(name)).toBe(true);
        expect(many as InterpolationName[]).toEqual([...INTERPOLATION_NAMES]);
      }
    }
  });
});
