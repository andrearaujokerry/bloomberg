// packages/core/test/analytics/bill.test.ts — WP-02 (WORKPLAN L501, L536), the TESTING §7.6 pin
// set for Treasury bills (ANAL-01).
//
// The point of the file is that **both** branches of the investment-yield definition are
// exercised, on the pair WORKPLAN L536 names: `912797VE4` (CUSIP_4WK, 28 days — the simple branch)
// and `912797WA1` (CUSIP_52WK, 364 days — the quadratic branch), alongside TESTING §7.6's own
// `bill.13wk` (91 days, 4.000 %) and `bill.52wk` (364 days, 4.25 %). `912797WH6` would not do:
// that is CUSIP_17WK, 119 days, on the same side of 182 as the 4-week bill.
//
// The two CUSIP cases' inputs are **transcribed** into
// `fixtures/golden/analytics/bill/discount.json` from the Treasury bill sheet, as WORKPLAN
// L474-478 requires: WP-02 never opens `fixtures/providers/raw/` and never goes through the replay
// store. The sheet's own published coupon-equivalent yields (3.75 for the 4-week, 4.18 for the
// 52-week) are asserted here as a two-decimal cross-check on the transcription.

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BILL_CONVENTIONS,
  BILL_INVESTMENT_YIELD_BRANCH_DAYS,
  bill,
  billEngine,
  discountFromPrice,
  investmentYieldBranch,
  investmentYieldBranchDays,
  investmentYieldFromPrice,
  investmentYieldQuadratic,
  investmentYieldSimple,
  moneyMarketYield,
  priceFromDiscount,
  priceFromInvestmentYield,
  type BillInputs,
} from '../../src/analytics/bill.js';

const VALUATION_TS = '2026-09-01T00:00:00Z';

/**
 * The defining identity of the > 182-day coupon-equivalent yield, solved numerically instead of in
 * closed form: `P × (1 + i/2) × (1 + i (D − ½)) = 100`. TESTING §7.6 requires the quadratic branch
 * be "asserted against a numerical solve of the same definition within 1e-9"; this bisection is
 * that independent solve — it shares no algebra with `investmentYieldQuadratic`.
 */
function investmentYieldByBisection(
  face: number,
  price: number,
  daysToMaturity: number,
  daysInYear = 365,
): number {
  const d = daysToMaturity / daysInYear;
  const g = (i: number): number => price * (1 + i / 2) * (1 + i * (d - 0.5)) - face;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (g(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('TESTING §7.6 — bill.13wk (91 days, 4.000 % discount, the simple branch)', () => {
  const face = 100;
  const daysToMaturity = 91;
  const discountRate = 0.04;
  const out = bill({ face, daysToMaturity, discountRate });

  it('prices from the discount rate: 100 × (1 − 0.04 × 91/360) = 98.988889', () => {
    expect(out.price).toBeCloseTo(98.988889, 6);
    expect(Math.abs(out.price - 98.988889)).toBeLessThanOrEqual(1e-6);
    // The unrounded value, so a future edit that changes the formula is caught before rounding.
    expect(out.price).toBeCloseTo(98.98888888888889, 12);
  });

  it('inverts exactly: discountFromPrice(98.988889) = 4.000000 %', () => {
    const d = discountFromPrice({ face, daysToMaturity, price: 98.988889 });
    expect(Math.abs(d * 100 - 4.0)).toBeLessThanOrEqual(1e-6);
    // Fed the engine's own unrounded price the inverse is exact to 1e-9 percent, as §7.6 pins.
    const exact = discountFromPrice({ face, daysToMaturity, price: out.price });
    expect(Math.abs(exact * 100 - 4.0)).toBeLessThanOrEqual(1e-9);
  });

  it('investment (coupon-equivalent) yield = ((100 − P)/P) × 365/t = 4.096981 %', () => {
    expect(Math.abs(out.investmentYieldPercent - 4.096981)).toBeLessThanOrEqual(1e-6);
    expect(out.branch).toBe('simple');
    // The definition, spelled out independently of the module.
    const byHand = ((100 - out.price) / out.price) * (365 / 91);
    expect(out.investmentYield).toBeCloseTo(byHand, 15);
  });

  it('investmentYield > discountRate', () => {
    expect(out.investmentYield).toBeGreaterThan(out.discountRate);
    expect(out.yieldPickup).toBeGreaterThan(0);
  });
});

describe('TESTING §7.6 — bill.52wk (364 days, 4.25 % discount, the quadratic branch)', () => {
  const face = 100;
  const daysToMaturity = 364;
  const out = bill({ face, daysToMaturity, discountRate: 0.0425 });

  it('takes the > 182-day branch', () => {
    expect(out.branch).toBe('quadratic');
    expect(daysToMaturity).toBeGreaterThan(BILL_INVESTMENT_YIELD_BRANCH_DAYS);
  });

  it('prices from the discount rate: 100 × (1 − 0.0425 × 364/360) = 95.702778', () => {
    expect(Math.abs(out.price - 95.702778)).toBeLessThanOrEqual(1e-6);
  });

  it('the closed form agrees with a numerical solve of the same definition within 1e-9', () => {
    const numeric = investmentYieldByBisection(face, out.price, daysToMaturity);
    expect(Math.abs(out.investmentYield - numeric)).toBeLessThanOrEqual(1e-9);
  });

  it('satisfies the identity it is defined by: P (1 + i/2)(1 + i(D − ½)) = 100', () => {
    const d = daysToMaturity / 365;
    const i = out.investmentYield;
    const grown = out.price * (1 + i / 2) * (1 + i * (d - 0.5));
    expect(Math.abs(grown - 100)).toBeLessThanOrEqual(1e-12);
  });

  it('inverts back to the price in closed form', () => {
    const p = priceFromInvestmentYield({
      face,
      daysToMaturity,
      investmentYield: out.investmentYield,
    });
    expect(Math.abs(p - out.price)).toBeLessThanOrEqual(1e-12);
  });

  it('investmentYield > discountRate', () => {
    expect(out.investmentYield).toBeGreaterThan(out.discountRate);
  });
});

describe('WORKPLAN L536 — the 912797VE4 / 912797WA1 pair, one branch each', () => {
  // Inputs transcribed from the Treasury bill sheet into
  // fixtures/golden/analytics/bill/discount.json (QUOTE_DATE 2026-09-01).
  const fourWeek = { face: 100, daysToMaturity: 28, discountRate: 0.0369 } as const;
  const fiftyTwoWeek = { face: 100, daysToMaturity: 364, discountRate: 0.04 } as const;

  it('912797VE4 (CUSIP_4WK, 28 days) takes the simple branch', () => {
    const out = bill(fourWeek);
    expect(out.branch).toBe('simple');
    expect(out.price).toBeCloseTo(99.713, 12);
    expect(Math.abs(out.investmentYieldPercent - 3.752018)).toBeLessThanOrEqual(1e-6);
    // The sheet publishes ROUND_B1_YIELD_4WK_2 = 3.75; this is that number, unrounded.
    expect(Number(out.investmentYieldPercent.toFixed(2))).toBe(3.75);
    expect(out.investmentYield).toBeGreaterThan(out.discountRate);
  });

  it('912797WA1 (CUSIP_52WK, 364 days) takes the quadratic branch', () => {
    const out = bill(fiftyTwoWeek);
    expect(out.branch).toBe('quadratic');
    expect(Math.abs(out.price - 95.955556)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(out.investmentYieldPercent - 4.182873)).toBeLessThanOrEqual(1e-6);
    // The sheet publishes ROUND_B1_YIELD_52WK_2 = 4.18.
    expect(Number(out.investmentYieldPercent.toFixed(2))).toBe(4.18);
    expect(out.investmentYield).toBeGreaterThan(out.discountRate);
  });

  it('the pair straddles 182 days, so both formulas are covered', () => {
    expect(investmentYieldBranch(fourWeek.daysToMaturity)).toBe('simple');
    expect(investmentYieldBranch(fiftyTwoWeek.daysToMaturity)).toBe('quadratic');
    expect(fourWeek.daysToMaturity).toBeLessThanOrEqual(BILL_INVESTMENT_YIELD_BRANCH_DAYS);
    expect(fiftyTwoWeek.daysToMaturity).toBeGreaterThan(BILL_INVESTMENT_YIELD_BRANCH_DAYS);
  });

  it('the 17-week bill (912797WH6, 119 days) would NOT have covered the second branch', () => {
    expect(investmentYieldBranch(119)).toBe('simple');
  });
});

describe('the 182-day branch point', () => {
  it('182 days is simple and 183 days is quadratic', () => {
    expect(investmentYieldBranch(182)).toBe('simple');
    expect(investmentYieldBranch(183)).toBe('quadratic');
    expect(bill({ daysToMaturity: 182, discountRate: 0.04 }).branch).toBe('simple');
    expect(bill({ daysToMaturity: 183, discountRate: 0.04 }).branch).toBe('quadratic');
  });

  it('the two formulas are continuous across the branch point to under a basis point', () => {
    const price = priceFromDiscount({ face: 100, daysToMaturity: 183, discountRate: 0.04 });
    const simple = investmentYieldSimple({ face: 100, daysToMaturity: 183, price });
    const quadratic = investmentYieldQuadratic({ face: 100, daysToMaturity: 183, price });
    // At exactly half a year the two definitions coincide; one day past it they differ by the
    // half-period compounding term only, which is ~1e-6 of yield here.
    expect(Math.abs(simple - quadratic)).toBeLessThan(1e-4);
    expect(quadratic).toBeLessThan(simple);
  });

  it('the quadratic branch refuses a term at or below half a year', () => {
    expect(() => investmentYieldQuadratic({ face: 100, daysToMaturity: 182, price: 98 })).toThrow(
      RangeError,
    );
  });

  it('moves the branch point to 183 days on the 366-day basis, where the quadratic degenerates', () => {
    // The singularity is at basis/2, not at a hard-coded 182: on a 366-day basis a 183-day term
    // gives 2D − 1 = 2·(183/366) − 1 = 0 exactly, so it must take the simple branch.
    expect(investmentYieldBranchDays(366)).toBe(183);
    expect(investmentYieldBranch(183, 366)).toBe('simple');
    expect(investmentYieldBranch(184, 366)).toBe('quadratic');
    // The 365-day basis is untouched: 182.5 still splits 182 from 183.
    expect(investmentYieldBranchDays(365)).toBe(182.5);
    expect(investmentYieldBranch(182, 365)).toBe('simple');
    expect(investmentYieldBranch(183, 365)).toBe('quadratic');
    expect(investmentYieldBranch(183)).toBe('quadratic');
  });

  it('prices a 183-day leap-spanning bill instead of throwing', () => {
    const out = bill({ face: 100, daysToMaturity: 183, discountRate: 0.04, daysInYear: 366 });
    expect(out.branch).toBe('simple');
    // P = 100(1 − 0.04·183/360) = 97.96666…; i = (100 − P)/P × 366/183 = 2(100 − P)/P, which is
    // exactly the limit of the quadratic root as 2D − 1 → 0.
    const price = 100 * (1 - (0.04 * 183) / 360);
    expect(out.price).toBeCloseTo(price, 12);
    expect(out.investmentYieldPercent).toBeCloseTo((2 * (100 - price) * 100) / price, 9);
    expect(out.investmentYieldPercent).toBeCloseTo(4.151071793, 9);
    // …and it sits between its 182-day and 184-day neighbours, so the branch is continuous: the
    // simple 182, the degenerate 183 and the quadratic 184 rise monotonically with no step.
    const before = bill({ daysToMaturity: 182, discountRate: 0.04, daysInYear: 366 });
    const after = bill({ daysToMaturity: 184, discountRate: 0.04, daysInYear: 366 });
    expect(before.branch).toBe('simple');
    expect(after.branch).toBe('quadratic');
    expect(out.investmentYieldPercent).toBeGreaterThan(before.investmentYieldPercent);
    expect(after.investmentYieldPercent).toBeGreaterThan(out.investmentYieldPercent);
    expect(Math.abs(out.investmentYieldPercent - after.investmentYieldPercent)).toBeLessThan(1e-3);
  });
});

describe('price ↔ discount ↔ yield round trips and guards', () => {
  const cases = [
    { face: 100, daysToMaturity: 28, discountRate: 0.0369 },
    { face: 100, daysToMaturity: 91, discountRate: 0.04 },
    { face: 100, daysToMaturity: 182, discountRate: 0.041 },
    { face: 100, daysToMaturity: 183, discountRate: 0.041 },
    { face: 100, daysToMaturity: 364, discountRate: 0.0425 },
    { face: 1_000_000, daysToMaturity: 364, discountRate: 0.04 },
  ];

  for (const c of cases) {
    it(`round-trips ${String(c.daysToMaturity)}d @ ${String(c.discountRate)}`, () => {
      const price = priceFromDiscount(c);
      const back = discountFromPrice({ ...c, price });
      expect(Math.abs(back - c.discountRate)).toBeLessThanOrEqual(1e-15);

      const i = investmentYieldFromPrice({ ...c, price });
      const backPrice = priceFromInvestmentYield({ ...c, investmentYield: i });
      expect(Math.abs(backPrice - price)).toBeLessThanOrEqual(1e-9 * c.face);
      // The §7.6 invariant, for every case in the file.
      expect(i).toBeGreaterThan(c.discountRate);
      // ACT/360 money-market yield sits between the two.
      const mm = moneyMarketYield({ ...c, price });
      expect(mm).toBeGreaterThan(c.discountRate);
      expect(mm).toBeLessThan(i);
    });
  }

  it('rejects a non-positive term, face or price', () => {
    expect(() => priceFromDiscount({ face: 100, daysToMaturity: 0, discountRate: 0.04 })).toThrow(
      RangeError,
    );
    expect(() => priceFromDiscount({ face: 0, daysToMaturity: 91, discountRate: 0.04 })).toThrow(
      RangeError,
    );
    expect(() => discountFromPrice({ face: 100, daysToMaturity: 91, price: 0 })).toThrow(
      RangeError,
    );
  });

  it('rejects a daysInYear that is neither 365 nor 366', () => {
    expect(() => bill({ daysToMaturity: 91, discountRate: 0.04, daysInYear: 360 })).toThrow(
      RangeError,
    );
  });

  it('honours daysInYear = 366 for a term spanning a 29 February', () => {
    const leap = bill({ daysToMaturity: 364, discountRate: 0.04, daysInYear: 366 });
    const plain = bill({ daysToMaturity: 364, discountRate: 0.04 });
    expect(leap.daysInYear).toBe(366);
    expect(leap.investmentYield).toBeGreaterThan(plain.investmentYield);
  });
});

describe('the bill engine (ANAL-07, ANAL-08)', () => {
  const inputs: BillInputs = { face: 100, daysToMaturity: 91, discountRate: 0.04 };

  it('echoes its conventions', () => {
    const result = billEngine(inputs, VALUATION_TS);
    expect(result.outputs.conventions).toBe(BILL_CONVENTIONS);
    expect(result.outputs.conventions.dayCount).toBe('ACT/360');
    expect(result.outputs.conventions.compounding).toBe('simple');
  });

  it('has a stable inputsHash across runs, and a different one for different inputs', () => {
    const a = billEngine(inputs, VALUATION_TS);
    const b = billEngine(inputs, VALUATION_TS);
    expect(b.inputsHash).toBe(a.inputsHash);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    const c = billEngine({ ...inputs, discountRate: 0.0401 }, VALUATION_TS);
    expect(c.inputsHash).not.toBe(a.inputsHash);
    expect(a.engine).toEqual({ name: 'bill', version: '1.0.0' });
  });
});

// ---------------------------------------------------------------------------------------------
// The checked-in goldens (QA-01)
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: BillInputs;
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN_DIR = new URL('../../../../fixtures/golden/analytics/bill/', import.meta.url);

function loadGolden(): GoldenCase[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((file) => JSON.parse(readFileSync(new URL(file, GOLDEN_DIR), 'utf8')) as GoldenCase[]);
}

describe('fixtures/golden/analytics/bill/**', () => {
  const cases = loadGolden();

  it('checks in the §7.6 pair and the two transcribed CUSIP cases', () => {
    expect(cases.map((c) => c.id).sort()).toEqual([
      'bill.13wk',
      'bill.4wk.912797VE4',
      'bill.52wk',
      'bill.52wk.912797WA1',
    ]);
  });

  for (const golden of cases) {
    it(`replays ${golden.id}`, () => {
      expect(golden.engine).toBe('bill');
      expect(golden.engineVersion).toBe(billEngine.version);
      expect(golden.source.length).toBeGreaterThan(0);
      const result = billEngine(golden.inputs, golden.valuationTs);
      const outputs = result.outputs as unknown as Record<string, number | string>;
      for (const [key, expected] of Object.entries(golden.expected)) {
        const actual = outputs[key];
        if (typeof expected === 'string') {
          expect(actual, `${golden.id}.${key}`).toBe(expected);
          continue;
        }
        const tol = golden.tol[key];
        expect(tol, `${golden.id}: no tolerance for '${key}'`).toBeTypeOf('number');
        expect(actual, `${golden.id}: engine has no output '${key}'`).toBeTypeOf('number');
        const diff = Math.abs((actual as number) - (expected as number));
        expect(
          diff <= (tol ?? 0),
          `${golden.id}.${key}: got ${String(actual)}, expected ${String(expected)} — ` +
            `diff ${diff.toExponential(3)} > tol ${String(tol)}`,
        ).toBe(true);
      }
      expect(billEngine(golden.inputs, golden.valuationTs).inputsHash).toBe(result.inputsHash);
    });
  }

  it('every case satisfies the §7.6 invariant investmentYield > discountRate', () => {
    for (const golden of cases) {
      const out = billEngine(golden.inputs, golden.valuationTs).outputs;
      expect(out.investmentYield, golden.id).toBeGreaterThan(out.discountRate);
    }
  });

  it('covers both sides of 182 days', () => {
    const branches = new Set(cases.map((c) => billEngine(c.inputs, c.valuationTs).outputs.branch));
    expect([...branches].sort()).toEqual(['quadratic', 'simple']);
  });
});
