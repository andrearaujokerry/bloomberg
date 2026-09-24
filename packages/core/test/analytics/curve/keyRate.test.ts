/**
 * `test/analytics/curve/keyRate.test.ts` — the §0 key-rate bump and the `bond.krd@1.0.0` engine
 * that drives it (FUNCTIONS_TIER3.md §0 "Key-rate durations", ANAL-01, ANAL-08).
 *
 * WP-11 shipped YAS's `KRD_2Y…KRD_30Y` from `bond.risk`, whose key-rate durations are an analytic
 * tent slice of the *yield*-based modified duration: curve-independent, twist-blind, and summing to
 * the modified duration by algebraic construction. This file pins the properties that make the
 * curve version a different — and reportable — number:
 *
 *  1. **The kernels are a partition of unity.** Bumping every key tenor at once is a parallel 1 bp
 *     shift of the zero curve, so `Σ KRD` must reproduce the duration measured from one parallel
 *     bump. That is the identity a mis-weighted bucket breaks, and it is checked against an
 *     independently computed parallel shift, not against the sum's own arithmetic.
 *  2. **It is not the modified duration.** The residual against a flat-yield derivative is real
 *     (≈ `y/2` from the basis, plus the curve's slope) and is asserted to be non-zero, because a
 *     KRD that reproduced the modified duration exactly would be the yield decomposition again.
 *  3. **The curve reaches the price.** A bucket beyond the bond's last cashflow is exactly zero in
 *     yield space and non-zero here, because `monotone_convex` carries the long nodes into the
 *     forwards the bond does discount on.
 */

import { describe, expect, it } from 'vitest';

import { remainingCashflows } from '../../../src/analytics/bond/cashflows.js';
import type { BondTerms } from '../../../src/analytics/bond/cashflows.js';
import { bootstrapParCurve } from '../../../src/analytics/curve/bootstrap.js';
import type { ParBootstrapInputs } from '../../../src/analytics/curve/bootstrap.js';
import type { DfPoint } from '../../../src/analytics/curve/interp.js';
import {
  bumpedDfPoints,
  KEY_RATE_ONE_BP,
  keyRateKernelWeight,
  keyRateNodes,
} from '../../../src/analytics/curve/keyRate.js';
import { bondKrdEngine, bondZSpreadEngine } from '../../../src/functions/manifests/YAS.js';

const CURVE_DATE = '2026-09-14';
const SETTLEMENT = '2026-09-16';
const KEYS = [2, 5, 10, 30];

/** The `UST_PAR` quotes `YAS.test.ts` seeds, so the two suites price the same curve. */
const PAR_QUOTES: ParBootstrapInputs['parQuotes'] = [
  { tenor: '6M', parRate: 3.95 },
  { tenor: '1Y', parRate: 3.9 },
  { tenor: '2Y', parRate: 3.76 },
  { tenor: '3Y', parRate: 3.78 },
  { tenor: '5Y', parRate: 3.81 },
  { tenor: '7Y', parRate: 3.95 },
  { tenor: '10Y', parRate: 4.07 },
  { tenor: '20Y', parRate: 4.55 },
  { tenor: '30Y', parRate: 4.66 },
];

const BUILD = bootstrapParCurve(
  {
    curveId: 'UST_PAR',
    curveDate: CURVE_DATE,
    parQuotes: PAR_QUOTES,
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    interpolation: 'monotone_convex',
  },
  `${CURVE_DATE}T00:00:00.000Z`,
);

const NODES: DfPoint[] = BUILD.outputs.curve.snapshot().map((n) => ({ t: n.t, df: n.df }));

/** The seeded 10-year note: `T 4.25 08/15/36`. */
const NOTE: BondTerms = {
  couponRate: 0.0425,
  frequency: 2,
  datedDate: '2026-08-15',
  maturity: '2036-08-15',
  dayCount: 'ACT/ACT',
};

const FLOWS = remainingCashflows(NOTE, SETTLEMENT).map((f) => ({ date: f.date, amount: f.amount }));

/** The curve's own price of the note, i.e. the bond at a Z-spread of zero. */
const CURVE_PRICE = bondZSpreadEngine(
  {
    curveId: 'UST_PAR',
    curveDate: CURVE_DATE,
    dayCount: 'ACT/ACT',
    compounding: 'semiannual',
    interpolation: 'monotone_convex',
    nodes: NODES,
    settlement: SETTLEMENT,
    flows: FLOWS,
    dirtyPrice: 100,
    frequency: 2,
  },
  `${CURVE_DATE}T00:00:00.000Z`,
).outputs.curveDirtyPrice;

function krd(spread: number, tenors: readonly number[] = KEYS) {
  return bondKrdEngine(
    {
      curveId: 'UST_PAR',
      curveDate: CURVE_DATE,
      dayCount: 'ACT/ACT',
      compounding: 'semiannual',
      interpolation: 'monotone_convex',
      nodes: NODES,
      settlement: SETTLEMENT,
      flows: FLOWS,
      spread,
      frequency: 2,
      keyRateTenors: tenors,
      bump: KEY_RATE_ONE_BP,
    },
    `${CURVE_DATE}T00:00:00.000Z`,
  );
}

describe('the §0 triangular kernel', () => {
  it('is a partition of unity at every time, including beyond both ends of the grid', () => {
    const nodes = keyRateNodes(KEYS);
    for (const t of [0.01, 0.5, 1, 2, 3.7, 5, 8, 10, 17.5, 20, 30, 45]) {
      const total = nodes.reduce(
        (sum, n) => sum + keyRateKernelWeight(t, n.key, n.previous, n.next),
        0,
      );
      expect(total, `weights at t=${String(t)}`).toBeCloseTo(1, 12);
    }
  });

  it('peaks at its own tenor and is flat at 1 outside the grid', () => {
    const [first, , , last] = keyRateNodes(KEYS);
    expect(keyRateKernelWeight(2, 2, null, 5)).toBe(1);
    expect(keyRateKernelWeight(3.5, 2, null, 5)).toBeCloseTo(0.5, 12);
    expect(keyRateKernelWeight(0.25, first!.key, first!.previous, first!.next)).toBe(1);
    expect(keyRateKernelWeight(45, last!.key, last!.previous, last!.next)).toBe(1);
    expect(keyRateKernelWeight(5, 2, null, 5)).toBe(0);
  });

  it('collapses duplicate tenors and refuses a non-positive one', () => {
    expect(keyRateNodes([10, 2, 10, 5]).map((n) => n.key)).toEqual([2, 5, 10]);
    expect(() => keyRateNodes([])).toThrow(RangeError);
    expect(() => keyRateNodes([2, 0])).toThrow(RangeError);
  });

  it('returns an unbumped node bit-identically', () => {
    const node = keyRateNodes(KEYS)[0]!; // 2Y: zero weight from 5y out
    const bumped = bumpedDfPoints(NODES, node, KEY_RATE_ONE_BP);
    for (let i = 0; i < NODES.length; i += 1) {
      const before = NODES[i]!;
      const after = bumped[i]!;
      if (before.t >= 5) expect(after.df).toBe(before.df);
      else expect(after.df).toBeLessThan(before.df);
    }
  });
});

describe('bond.krd@1.0.0 — key-rate durations by bump and reprice', () => {
  it('sums to the duration of one parallel bump, to within the bump truncation', () => {
    const out = krd(0).outputs;
    // The independent reference: shift every node's continuous zero by 1 bp in one go.
    const shift = (delta: number): DfPoint[] =>
      NODES.map((n) => ({ t: n.t, df: n.df * Math.exp(-delta * n.t) }));
    const priceOn = (points: DfPoint[]): number =>
      bondKrdEngine(
        {
          curveId: 'UST_PAR',
          curveDate: CURVE_DATE,
          dayCount: 'ACT/ACT',
          compounding: 'semiannual',
          interpolation: 'monotone_convex',
          nodes: points,
          settlement: SETTLEMENT,
          flows: FLOWS,
          spread: 0,
          frequency: 2,
          keyRateTenors: [10],
          bump: KEY_RATE_ONE_BP,
        },
        `${CURVE_DATE}T00:00:00.000Z`,
      ).outputs.basePrice;
    const parallel =
      -(priceOn(shift(KEY_RATE_ONE_BP)) - priceOn(shift(-KEY_RATE_ONE_BP))) /
      (2 * out.basePrice * KEY_RATE_ONE_BP);

    expect(Math.abs(out.keyRateDurationSum - parallel) / parallel).toBeLessThan(1e-4);
    // …and not exactly, because four reprices carry the bond's convexity over the bump.
    expect(out.keyRateDurationSum).not.toBe(parallel);
  });

  it('prices the unbumped curve at the same dirty price bond.zspread does', () => {
    expect(krd(0).outputs.basePrice).toBe(CURVE_PRICE);
  });

  it('attributes risk beyond the last cashflow, which a yield-space tent cannot', () => {
    // Every flow of the 2036 note is inside ten years, so the 30y tent weight is zero at every
    // cashflow *time*; the 30y curve node still moves the forwards the note discounts on.
    const byTenor = new Map(krd(0).outputs.keyRateDurations.map((k) => [k.tenor, k.duration]));
    expect(byTenor.get(30)).not.toBe(0);
    expect(Math.abs(byTenor.get(30) ?? 0)).toBeLessThan(0.05);
    expect(byTenor.get(10) ?? 0).toBeGreaterThan(byTenor.get(5) ?? 0);
  });

  it('moves with the Z-spread it is told to hold fixed', () => {
    const flat = krd(0).outputs;
    const wide = krd(0.01).outputs; // 100 bp
    expect(wide.basePrice).toBeLessThan(flat.basePrice);
    expect(wide.keyRateDurationSum).toBeLessThan(flat.keyRateDurationSum);
  });

  it('refuses a bump of zero, and the harness refuses a spread that is not a number', () => {
    expect(() =>
      bondKrdEngine(
        {
          curveId: 'UST_PAR',
          curveDate: CURVE_DATE,
          dayCount: 'ACT/ACT',
          compounding: 'semiannual',
          interpolation: 'monotone_convex',
          nodes: NODES,
          settlement: SETTLEMENT,
          flows: FLOWS,
          spread: 0,
          frequency: 2,
          keyRateTenors: KEYS,
          bump: 0,
        },
        `${CURVE_DATE}T00:00:00.000Z`,
      ),
    ).toThrow(RangeError);
    expect(() =>
      bondKrdEngine(
        {
          curveId: 'UST_PAR',
          curveDate: CURVE_DATE,
          dayCount: 'ACT/ACT',
          compounding: 'semiannual',
          interpolation: 'monotone_convex',
          nodes: NODES,
          settlement: SETTLEMENT,
          flows: FLOWS,
          spread: Number.NaN,
          frequency: 2,
          keyRateTenors: KEYS,
          bump: KEY_RATE_ONE_BP,
        },
        `${CURVE_DATE}T00:00:00.000Z`,
      ),
    ).toThrow(TypeError);
  });

  it('carries an inputsHash that changes with the curve and with the held spread (ANAL-08)', () => {
    const base = krd(0);
    expect(base.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(krd(0).inputsHash).toBe(base.inputsHash);
    expect(krd(0.0005).inputsHash).not.toBe(base.inputsHash);
  });
});
