// packages/core/test/analytics/bond.risk.test.ts — WP-02 (WORKPLAN L502, L538), the TESTING §7.3
// risk table and its finite-difference cross-checks (ANAL-01).
//
// TESTING §7.3, case `bond.discount.2y` (coupon 5.000 % semiannual, 4 remaining periods,
// settlement on a coupon date, yield 6.000 %):
//
//   macaulayDuration  1.927236 years   1e-6
//   modifiedDuration  1.871103         1e-6   (= Macaulay / 1.03)
//   dv01              0.018363         1e-6   (per 100 face per bp)
//   convexity         4.484914         1e-6   (d²P/dy² ÷ P, on the semiannual-bond-basis yield)
//
// and the three cross-checks §7.3 states with their reasons:
//
//   - DV01 from the analytic modified duration equals `(P(y − 1bp) − P(y + 1bp)) / 2` within
//     `5e-9` — the truncation error is O(h²·P‴) ≈ 1e-10;
//   - convexity equals the second central difference with `h = 1 bp` within `1e-5`;
//   - the sum of key-rate durations (2y node only, here) equals the modified duration within
//     `1e-9`. Here it holds to 5e-16, because the key-rate durations are differentiated rather
//     than bumped and the tent weights sum to exactly 1 at every cashflow time.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { BondTerms } from '../../src/analytics/bond/cashflows.js';
import type { BondEngineInputs } from '../../src/analytics/bond/price.js';
import {
  cleanPriceFromYield,
  discountedFlows,
  priceFromYield,
} from '../../src/analytics/bond/price.js';
import {
  DEFAULT_KEY_RATE_TENORS,
  bondRisk,
  bondRiskEngine,
  convexity,
  dv01,
  keyRateDurations,
  keyRateDurationsFiniteDifference,
  keyRateWeights,
  macaulayDuration,
  modifiedDuration,
} from '../../src/analytics/bond/risk.js';

/** TESTING §7.3 `bond.discount.2y`. */
const TERMS: BondTerms = {
  face: 100,
  couponRate: 0.05,
  frequency: 2,
  datedDate: '2026-08-15',
  maturity: '2028-08-15',
  dayCount: 'ACT/ACT',
};
const SETTLEMENT = '2026-08-15';
const Y = 0.06;
const BP = 1e-4;

const risk = bondRisk(TERMS, SETTLEMENT, Y, [2]);
const price = (y: number): number => cleanPriceFromYield(TERMS, SETTLEMENT, y);

describe('TESTING §7.3 — the risk table for bond.discount.2y', () => {
  it('macaulayDuration = 1.927236 years', () => {
    expect(Math.abs(risk.macaulayDuration - 1.927236)).toBeLessThanOrEqual(1e-6);
  });

  it('modifiedDuration = 1.871103 = Macaulay / 1.03', () => {
    expect(Math.abs(risk.modifiedDuration - 1.871103)).toBeLessThanOrEqual(1e-6);
    expect(risk.modifiedDuration).toBeCloseTo(risk.macaulayDuration / 1.03, 15);
  });

  it('dv01 = 0.018363 per 100 face per basis point', () => {
    expect(Math.abs(risk.dv01 - 0.018363)).toBeLessThanOrEqual(1e-6);
    expect(risk.dv01PerMillion).toBeCloseTo(risk.dv01 * 10_000, 9);
  });

  it('convexity = 4.484914', () => {
    expect(Math.abs(risk.convexity - 4.484914)).toBeLessThanOrEqual(1e-6);
  });

  it('prices at 98.141451 with zero accrued, the price the table is built on', () => {
    expect(Math.abs(risk.cleanPrice - 98.141451)).toBeLessThanOrEqual(1e-6);
    expect(risk.accrued).toBe(0);
    expect(risk.dirtyPrice).toBe(risk.cleanPrice);
  });

  it('is the weighted average time of the discounted cashflows', () => {
    // The definition, restated from the flows themselves rather than from the module.
    const flows = discountedFlows(TERMS, SETTLEMENT);
    let pv = 0;
    let weighted = 0;
    for (const f of flows) {
      const df = Math.pow(1 + Y / 2, -f.periods);
      pv += f.amount * df;
      weighted += f.years * f.amount * df;
    }
    expect(weighted / pv).toBeCloseTo(risk.macaulayDuration, 15);
    expect(pv).toBeCloseTo(risk.dirtyPrice, 12);
  });
});

describe('TESTING §7.3 — the finite-difference cross-checks', () => {
  it('DV01 equals the central difference (P(y − 1bp) − P(y + 1bp)) / 2 within 5e-9', () => {
    const central = (price(Y - BP) - price(Y + BP)) / 2;
    expect(Math.abs(risk.dv01 - central)).toBeLessThanOrEqual(5e-9);
  });

  it('modified duration equals −(1/P) dP/dy by central difference within 5e-8', () => {
    // The same comparison as the DV01 one, divided through by P × 1bp = 9.8e-3: §7.3's 5e-9 in
    // price units is 5e-7 in duration units, and the observed gap is 2.2e-8.
    const slope = (price(Y + BP) - price(Y - BP)) / (2 * BP);
    expect(Math.abs(risk.modifiedDuration - -slope / risk.dirtyPrice)).toBeLessThanOrEqual(5e-8);
  });

  it('convexity equals the second central difference with h = 1bp within 1e-5', () => {
    const second = (price(Y + BP) - 2 * price(Y) + price(Y - BP)) / (BP * BP);
    expect(Math.abs(risk.convexity - second / risk.dirtyPrice)).toBeLessThanOrEqual(1e-5);
  });

  it('a 1bp reprice is predicted by duration and convexity to within 1e-9', () => {
    const exact = price(Y + BP) - price(Y);
    const predicted =
      -risk.modifiedDuration * risk.dirtyPrice * BP +
      0.5 * risk.convexity * risk.dirtyPrice * BP * BP;
    expect(Math.abs(exact - predicted)).toBeLessThanOrEqual(1e-9);
  });
});

describe('TESTING §7.3 — key-rate durations sum to the modified duration', () => {
  it('sums to the modified duration on the 2y node alone within 1e-9', () => {
    expect(risk.keyRateDurations.map((k) => k.tenor)).toEqual([2]);
    expect(Math.abs(risk.keyRateDurationSum - risk.modifiedDuration)).toBeLessThanOrEqual(1e-9);
    // With a single node the whole duration lands on it.
    expect(risk.keyRateDurations[0]?.duration).toBeCloseTo(risk.modifiedDuration, 15);
  });

  it('sums to the modified duration on the full desk grid too', () => {
    const full = bondRisk(TERMS, SETTLEMENT, Y);
    expect(full.keyRateDurations.map((k) => k.tenor)).toEqual([...DEFAULT_KEY_RATE_TENORS]);
    expect(Math.abs(full.keyRateDurationSum - full.modifiedDuration)).toBeLessThanOrEqual(1e-9);
    // Nothing is attributed beyond the bond's own maturity.
    for (const k of full.keyRateDurations) {
      if (k.tenor > 2) expect(k.duration).toBe(0);
      expect(k.duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('agrees with a bumped-curve finite difference within 1e-6', () => {
    const flows = discountedFlows(TERMS, SETTLEMENT);
    const analytic = keyRateDurations(flows, Y, 2, DEFAULT_KEY_RATE_TENORS);
    const bumped = keyRateDurationsFiniteDifference(flows, Y, 2, DEFAULT_KEY_RATE_TENORS);
    for (let i = 0; i < analytic.length; i++) {
      const a = analytic[i];
      const b = bumped[i];
      expect(b?.tenor).toBe(a?.tenor);
      // The bumped variant carries an O(h²) truncation error at h = 1bp; 1e-6 is comfortably
      // above it and far below the 1.87 the durations themselves sum to.
      expect(Math.abs((a?.duration ?? 0) - (b?.duration ?? 0))).toBeLessThanOrEqual(1e-6);
    }
  });

  it('spreads a 10-year note across the 7y and 10y nodes with weights summing to 1', () => {
    const note: BondTerms = {
      face: 100,
      couponRate: 0.0425,
      frequency: 2,
      datedDate: '2026-08-15',
      maturity: '2036-08-15',
    };
    const out = bondRisk(note, '2026-08-15', 0.0479);
    const byTenor = new Map(out.keyRateDurations.map((k) => [k.tenor, k.duration]));
    expect((byTenor.get(10) ?? 0) > (byTenor.get(7) ?? 0)).toBe(true);
    expect((byTenor.get(7) ?? 0) > 0).toBe(true);
    expect(byTenor.get(20)).toBe(0);
    expect(byTenor.get(30)).toBe(0);
    expect(Math.abs(out.keyRateDurationSum - out.modifiedDuration)).toBeLessThanOrEqual(1e-9);
  });

  it('tent weights are a partition of unity at every cashflow time', () => {
    for (const t of [0.1, 0.25, 0.4, 2, 3.7, 9.99, 10, 25, 30, 41]) {
      const w = keyRateWeights(t, DEFAULT_KEY_RATE_TENORS);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
      expect(w.every((x) => x >= 0)).toBe(true);
    }
    expect(keyRateWeights(3, [2, 3, 5])).toEqual([0, 1, 0]);
    expect(keyRateWeights(4, [2, 3, 5])).toEqual([0, 0.5, 0.5]);
  });
});

describe('risk behaves like risk', () => {
  const bonds: [string, BondTerms, number][] = [
    ['2y', TERMS, Y],
    [
      '10y',
      {
        face: 100,
        couponRate: 0.0425,
        frequency: 2,
        datedDate: '2026-08-15',
        maturity: '2036-08-15',
      },
      0.0479,
    ],
    [
      '30y',
      {
        face: 100,
        couponRate: 0.0475,
        frequency: 2,
        datedDate: '2026-08-15',
        maturity: '2056-08-15',
      },
      0.0527,
    ],
  ];

  it('duration and convexity increase with maturity', () => {
    const durations = bonds.map(([, t, y]) => bondRisk(t, '2026-08-15', y).modifiedDuration);
    const convexities = bonds.map(([, t, y]) => bondRisk(t, '2026-08-15', y).convexity);
    expect(durations[0]).toBeLessThan(durations[1]!);
    expect(durations[1]).toBeLessThan(durations[2]!);
    expect(convexities[0]).toBeLessThan(convexities[1]!);
    expect(convexities[1]).toBeLessThan(convexities[2]!);
  });

  it('Macaulay exceeds modified duration, and both are below the maturity', () => {
    for (const [name, terms, y] of bonds) {
      const r = bondRisk(terms, '2026-08-15', y);
      expect(r.macaulayDuration, name).toBeGreaterThan(r.modifiedDuration);
      expect(r.modifiedDuration, name).toBeGreaterThan(0);
      expect(r.convexity, name).toBeGreaterThan(0);
      expect(r.dv01, name).toBeGreaterThan(0);
    }
  });

  it('every DV01 matches its own central difference', () => {
    // §7.3's 5e-9 belongs to the 2-year case (asserted above at that tolerance): the central
    // difference's truncation error is O(h²·P‴), which grows with maturity — 1.5e-12 at 2 years,
    // 1.3e-8 at 10, 1.4e-7 at 30. 5e-7 bounds all three, and relative to each bond's own DV01 the
    // gap never exceeds 5e-6.
    for (const [name, terms, y] of bonds) {
      const r = bondRisk(terms, '2026-08-15', y);
      const central =
        (cleanPriceFromYield(terms, '2026-08-15', y - BP) -
          cleanPriceFromYield(terms, '2026-08-15', y + BP)) /
        2;
      expect(Math.abs(r.dv01 - central), name).toBeLessThanOrEqual(5e-7);
      expect(Math.abs(r.dv01 - central) / r.dv01, name).toBeLessThanOrEqual(5e-6);
    }
  });

  it('the low-level helpers agree with the aggregate', () => {
    const flows = discountedFlows(TERMS, SETTLEMENT);
    expect(macaulayDuration(flows, Y, 2)).toBeCloseTo(risk.macaulayDuration, 15);
    expect(modifiedDuration(flows, Y, 2)).toBeCloseTo(risk.modifiedDuration, 15);
    expect(convexity(flows, Y, 2)).toBeCloseTo(risk.convexity, 15);
    expect(dv01(flows, Y, 2)).toBeCloseTo(risk.dv01, 15);
  });

  it('a zero-coupon bond has Macaulay duration equal to its maturity', () => {
    const zero: BondTerms = {
      face: 100,
      couponRate: 0,
      frequency: 2,
      datedDate: '2026-08-15',
      maturity: '2031-08-15',
    };
    const r = bondRisk(zero, '2026-08-15', 0.05);
    expect(r.macaulayDuration).toBeCloseTo(5, 12);
    expect(r.cleanPrice).toBeCloseTo(100 * Math.pow(1.025, -10), 12);
  });
});

// ---------------------------------------------------------------------------------------------
// The checked-in golden (QA-01)
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: BondEngineInputs & { keyRateTenors?: number[] };
  valuationTs: string;
  expected: Record<string, number>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN = new URL('../../../../fixtures/golden/analytics/bond/risk.json', import.meta.url);

describe('fixtures/golden/analytics/bond/risk.json', () => {
  const cases = JSON.parse(readFileSync(GOLDEN, 'utf8')) as GoldenCase[];

  it('checks in the §7.3 risk case', () => {
    expect(cases.map((c) => c.id)).toEqual(['bond.discount.2y.risk']);
  });

  for (const golden of cases) {
    it(`replays ${golden.id}`, () => {
      expect(golden.engine).toBe('bond.risk');
      expect(golden.engineVersion).toBe(bondRiskEngine.version);
      const result = bondRiskEngine(golden.inputs, golden.valuationTs);
      const outputs = result.outputs as unknown as Record<string, number>;
      for (const [key, expected] of Object.entries(golden.expected)) {
        const tol = golden.tol[key];
        expect(tol, `${golden.id}: no tolerance for '${key}'`).toBeTypeOf('number');
        const actual = outputs[key];
        expect(actual, `${golden.id}: engine has no output '${key}'`).toBeTypeOf('number');
        const diff = Math.abs((actual ?? NaN) - expected);
        expect(
          diff <= (tol ?? 0),
          `${golden.id}.${key}: got ${String(actual)}, expected ${String(expected)} — ` +
            `diff ${diff.toExponential(3)} > tol ${String(tol)}`,
        ).toBe(true);
      }
      expect(bondRiskEngine(golden.inputs, golden.valuationTs).inputsHash).toBe(result.inputsHash);
      expect(result.outputs.conventions.dayCount).toBe('ACT/ACT');
      // The engine reprices its own inputs: the risk case's price is the §7.3 price.
      expect(priceFromYield(TERMS, SETTLEMENT, Y).cleanPrice).toBeCloseTo(
        result.outputs.cleanPrice,
        12,
      );
    });
  }
});
