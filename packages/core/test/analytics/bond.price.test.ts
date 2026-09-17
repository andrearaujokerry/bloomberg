// packages/core/test/analytics/bond.price.test.ts — WP-02 (WORKPLAN L501, L537), the TESTING §7.3
// pin set for street-convention bond price ↔ yield, plus the accrued-interest pair and the seven
// on-the-run round trips (ANAL-01).
//
// TESTING §7.3's street convention: semiannual compounding, ACT/ACT ICMA accrual, settlement on a
// coupon date so accrued is zero and the case isolates the discounting.
//
// The seven on-the-run notes and bonds are checked in at
// `fixtures/golden/analytics/bond/onthe-run.json` with `source: 'treasury.yieldcurve capture +
// treasuries seed'`, so the case runs without the seed and without the replay store (WORKPLAN
// L474-478). Their provenance, term by term:
//
//   - **yields** — the 2026-09-01 Treasury par curve row of the `treasury.yieldcurve` capture:
//     2Y 4.39, 3Y 4.46, 5Y 4.55, 7Y 4.66, 10Y 4.79, 20Y 5.27, 30Y 5.27;
//   - **10Y** `T 4.25 08/15/36` — coupon, maturity and dated date from the curated seed
//     (`fixtures/seed/treasuries.json`; CUSIP 91282CLM6), and the same note TESTING §7.3 pins as
//     `bond.par.roundtrip`;
//   - **2Y** 3.750 % maturing 2028-09-30 (CUSIP 91282CLV6) and **30Y** 4.750 % maturing
//     2056-08-15 (CUSIP 912810UF3) — from the same curated seed;
//   - **3Y, 5Y, 7Y, 20Y** — curated: the standard Treasury auction cycle (mid-month for the 3Y and
//     the 10/20/30Y, month-end for the 2/5/7Y) with the coupon set to the nearest eighth at or
//     below the par yield, which is how an auction sets one. DATA_MODEL §21.1 q2 records that no
//     recorded fixture carries note and bond terms, so these are curated by hand by construction.
//
// Every expected clean price in that file is re-derived here from the closed-form annuity
// `(c/f)(1 − vⁿ)/(y/f) + 100 vⁿ`, which shares no code with the engine, so the golden numbers are
// audited rather than merely replayed.

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { BondTerms } from '../../src/analytics/bond/cashflows.js';
import {
  accrued as accrualOf,
  cashflows,
  couponDates,
  couponSchedule,
  nextCouponDate,
  periodFractionRemaining,
  previousCouponDate,
} from '../../src/analytics/bond/cashflows.js';
import type { BondEngineInputs } from '../../src/analytics/bond/price.js';
import {
  accrued,
  bondPriceEngine,
  cleanPriceFromYield,
  dirtyPriceFromYield,
  discountedFlows,
  priceFromYield,
  yieldFromPrice,
} from '../../src/analytics/bond/price.js';

/** TESTING §7.3 `bond.par.roundtrip`: the on-the-run 10-year, T 4.25 08/15/36. */
const PAR_10Y: BondTerms = {
  face: 100,
  couponRate: 0.0425,
  frequency: 2,
  datedDate: '2026-08-15',
  maturity: '2036-08-15',
  dayCount: 'ACT/ACT',
};

/** TESTING §7.3 `bond.discount.2y` / `bond.premium.short`: 5 % coupon, 4 remaining periods. */
const SHORT_5PCT: BondTerms = {
  face: 100,
  couponRate: 0.05,
  frequency: 2,
  datedDate: '2026-08-15',
  maturity: '2028-08-15',
  dayCount: 'ACT/ACT',
};

const COUPON_DATE = '2026-08-15';

/**
 * The street price of a bond settling **on** a coupon date, written as the textbook annuity. No
 * engine code is involved, so this is an independent check of `priceFromYield`.
 */
function closedFormPrice(couponRate: number, y: number, n: number, frequency = 2): number {
  const periodRate = y / frequency;
  const v = Math.pow(1 + periodRate, -n);
  const coupon = (100 * couponRate) / frequency;
  return coupon * ((1 - v) / periodRate) + 100 * v;
}

describe('TESTING §7.3 — bond.par.roundtrip (10y 4.250 %, dated and settling 2026-08-15)', () => {
  it('yieldFromPrice(100.000000) = 4.250000 % to 1e-10 (the par identity)', () => {
    const solved = yieldFromPrice(PAR_10Y, COUPON_DATE, 100);
    expect(solved.ok).toBe(true);
    expect(Math.abs(solved.yieldPercent - 4.25)).toBeLessThanOrEqual(1e-10);
  });

  it('priceFromYield(4.250000 %) = 100.000000 to 1e-10', () => {
    const p = priceFromYield(PAR_10Y, COUPON_DATE, 0.0425);
    expect(Math.abs(p.cleanPrice - 100)).toBeLessThanOrEqual(1e-10);
    expect(p.periodsRemaining).toBe(20);
    expect(p.firstPeriodFraction).toBe(1);
  });

  it('accrued = 0.000000 exactly on the coupon date', () => {
    expect(accrued(PAR_10Y, COUPON_DATE)).toBe(0);
    expect(priceFromYield(PAR_10Y, COUPON_DATE, 0.0425).dirtyPrice).toBe(
      priceFromYield(PAR_10Y, COUPON_DATE, 0.0425).cleanPrice,
    );
  });

  for (const p of [95, 98.5, 100, 101.25, 110]) {
    it(`round-trips priceFromYield(yieldFromPrice(${String(p)})) to 1e-10`, () => {
      const solved = yieldFromPrice(PAR_10Y, COUPON_DATE, p);
      expect(solved.ok).toBe(true);
      const back = cleanPriceFromYield(PAR_10Y, COUPON_DATE, solved.yield);
      expect(Math.abs(back - p)).toBeLessThanOrEqual(1e-10);
    });
  }

  it('price and yield move in opposite directions', () => {
    const lo = cleanPriceFromYield(PAR_10Y, COUPON_DATE, 0.04);
    const hi = cleanPriceFromYield(PAR_10Y, COUPON_DATE, 0.05);
    expect(lo).toBeGreaterThan(100);
    expect(hi).toBeLessThan(100);
  });
});

describe('TESTING §7.3 — bond.discount.2y (5 % coupon, 4 periods, yield 6 %)', () => {
  const priced = priceFromYield(SHORT_5PCT, COUPON_DATE, 0.06);

  it('cleanPrice = 98.141451 per 100 (tolerance 1e-6)', () => {
    expect(Math.abs(priced.cleanPrice - 98.141451)).toBeLessThanOrEqual(1e-6);
  });

  it('matches the arithmetic TESTING §7.3 spells out', () => {
    const v = 1 / 1.03;
    expect(Math.abs(v * v - 0.942595909)).toBeLessThanOrEqual(5e-10);
    expect(Math.abs(Math.pow(v, 3) - 0.915141659)).toBeLessThanOrEqual(5e-10);
    expect(Math.abs(Math.pow(v, 4) - 0.888487048)).toBeLessThanOrEqual(5e-10);
    const annuity = (1 - Math.pow(v, 4)) / 0.03;
    // §7.3 prints the annuity as 3.71709839. Exact rational arithmetic gives
    //   (1 − 1.03⁻⁴)/0.03 = 3.7170984028103744,
    // so the printed intermediate is 1.3e-9 low — a display truncation in the doc, not an engine
    // error. The exact value is what is asserted tightly; the doc's digits are kept as a looser
    // cross-check so the two cannot silently diverge. The *pinned* price 98.141451 below is
    // unaffected and is asserted at the table's own 1e-6.
    // 1e-13: `v = 1/1.03` then `v⁴` accumulates a few ulps more rounding than `Math.pow(1.03, -4)`,
    // so the two spellings of the same quantity differ at 7.5e-15, well inside this bound.
    expect(Math.abs(annuity - 3.7170984028103744)).toBeLessThanOrEqual(1e-13);
    expect(Math.abs(annuity - 3.71709839)).toBeLessThanOrEqual(5e-8);
    const price = 2.5 * annuity + 100 * Math.pow(v, 4);
    expect(Math.abs(priced.cleanPrice - price)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(priced.cleanPrice - closedFormPrice(0.05, 0.06, 4))).toBeLessThanOrEqual(1e-12);
  });

  it('yieldFromPrice(98.141451) = 6.000000 %', () => {
    // The pinned target is the exact price rounded to six decimals; dP/dy = −183.63, so the root of
    // the rounded target sits 1.10e-9 below 6 % in decimal (1.10e-7 in percent). Fed the engine's
    // own unrounded price the identity is exact — asserted directly underneath.
    const solved = yieldFromPrice(SHORT_5PCT, COUPON_DATE, 98.141451);
    expect(solved.ok).toBe(true);
    expect(Math.abs(solved.yieldPercent - 6)).toBeLessThanOrEqual(2e-7);
    const exact = yieldFromPrice(SHORT_5PCT, COUPON_DATE, priced.cleanPrice);
    expect(Math.abs(exact.yieldPercent - 6)).toBeLessThanOrEqual(1e-12);
  });

  it('accrued is zero and the cashflows are 2.5, 2.5, 2.5, 102.5', () => {
    expect(priced.accrued).toBe(0);
    expect(cashflows(SHORT_5PCT).map((c) => c.amount)).toEqual([2.5, 2.5, 2.5, 102.5]);
    expect(discountedFlows(SHORT_5PCT, COUPON_DATE).map((f) => f.periods)).toEqual([1, 2, 3, 4]);
    expect(discountedFlows(SHORT_5PCT, COUPON_DATE).map((f) => f.years)).toEqual([0.5, 1, 1.5, 2]);
  });
});

describe('TESTING §7.3 — bond.premium.short (5 % coupon, 4 periods, yield 4 %)', () => {
  const priced = priceFromYield(SHORT_5PCT, COUPON_DATE, 0.04);

  it('price = 101.903864 (tolerance 1e-6)', () => {
    expect(Math.abs(priced.cleanPrice - 101.903864)).toBeLessThanOrEqual(1e-6);
  });

  it('matches 2.5 × (1 − 1.02⁻⁴)/0.02 + 100 × 1.02⁻⁴ term by term', () => {
    const v4 = Math.pow(1.02, -4);
    expect(Math.abs(v4 - 0.923845426)).toBeLessThanOrEqual(5e-10);
    const annuity = (1 - v4) / 0.02;
    // As in bond.discount.2y, §7.3's printed intermediates carry a last-place error while the
    // pinned price 101.903864 is exact. Exact values, re-derived here:
    //   (1 − 1.02⁻⁴)/0.02 = 3.8077286986742953   (§7.3 prints 3.807728710, 1.1e-8 high)
    //   2.5 × annuity     = 9.5193217466857387   (§7.3 prints 9.519321774,  2.7e-8 high)
    //   100 × 1.02⁻⁴      = 92.384542602651408   (§7.3 prints 92.384542576, 2.7e-8 low)
    //   sum               = 101.90386434933714   (§7.3's 101.903864 — correct)
    // The exact values are asserted tightly; the doc's digits at the 5e-8 they are printed to.
    expect(Math.abs(annuity - 3.8077286986742953)).toBeLessThanOrEqual(1e-15);
    expect(Math.abs(2.5 * annuity - 9.5193217466857387)).toBeLessThanOrEqual(1e-14);
    expect(Math.abs(100 * v4 - 92.384542602651408)).toBeLessThanOrEqual(1e-13);
    expect(Math.abs(annuity - 3.80772871)).toBeLessThanOrEqual(5e-8);
    expect(Math.abs(2.5 * annuity - 9.519321774)).toBeLessThanOrEqual(5e-8);
    expect(Math.abs(100 * v4 - 92.384542576)).toBeLessThanOrEqual(5e-8);
    expect(Math.abs(priced.cleanPrice - (2.5 * annuity + 100 * v4))).toBeLessThanOrEqual(1e-12);
  });

  it('price > 100 ⇔ yield < coupon', () => {
    expect(priced.cleanPrice).toBeGreaterThan(100);
    expect(priced.yield).toBeLessThan(SHORT_5PCT.couponRate);
    const atCoupon = cleanPriceFromYield(SHORT_5PCT, COUPON_DATE, 0.05);
    expect(Math.abs(atCoupon - 100)).toBeLessThanOrEqual(1e-12);
    const above = cleanPriceFromYield(SHORT_5PCT, COUPON_DATE, 0.06);
    expect(above).toBeLessThan(100);
  });
});

describe('TESTING §7.3 — accrued on a coupon date and the day before', () => {
  /** The same note, dated a period earlier so the day before its coupon is inside a full period. */
  const NOTE: BondTerms = {
    face: 100,
    couponRate: 0.0425,
    frequency: 2,
    datedDate: '2026-02-15',
    maturity: '2036-08-15',
    dayCount: 'ACT/ACT',
  };

  it('is exactly zero on the coupon date, because settlement starts the next period', () => {
    expect(accrued(NOTE, '2026-08-15')).toBe(0);
    const a = accrualOf(NOTE, '2026-08-15');
    expect(a.days).toBe(0);
    expect(a.period.accrualStart).toBe('2026-08-15');
    expect(a.period.accrualEnd).toBe('2027-02-15');
    expect(periodFractionRemaining(NOTE, '2026-08-15')).toBe(1);
  });

  it('is the whole coupon less one day the day before: 4.25 × 180/362 = 2.113259668508287', () => {
    const a = accrualOf(NOTE, '2026-08-14');
    expect(a.days).toBe(180);
    expect(a.periodDays).toBe(181);
    // ACT/ACT ICMA: 180 / (181 × 2) of a year (TESTING §7.4's convention).
    expect(a.yearFraction).toBeCloseTo(180 / 362, 15);
    expect(a.accrued).toBeCloseTo((4.25 * 180) / 362, 12);
    // The same number seen from the coupon: one day short of the whole 2.125.
    expect(a.accrued).toBeCloseTo(2.125 * (180 / 181), 12);
    expect(a.accrued).toBeLessThan(2.125);
  });

  it('the day-before dirty price exceeds the coupon-date dirty price by the accrued', () => {
    const before = priceFromYield(NOTE, '2026-08-14', 0.0479);
    expect(before.dirtyPrice - before.cleanPrice).toBeCloseTo(before.accrued, 12);
    expect(before.periodsRemaining).toBe(21);
    expect(dirtyPriceFromYield(NOTE, '2026-08-14', 0.0479)).toBe(before.dirtyPrice);
  });

  it('accrual is monotone through a period and resets at each coupon', () => {
    const dates = ['2026-02-15', '2026-04-01', '2026-06-01', '2026-08-14'];
    const values = dates.map((d) => accrued(NOTE, d));
    expect(values[0]).toBe(0);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
    expect(accrued(NOTE, '2026-08-15')).toBe(0);
  });
});

describe('schedule generation: regular, end-of-month, odd first and odd last coupons', () => {
  it('generates backwards from maturity and keeps the day of the month', () => {
    expect(couponDates(SHORT_5PCT)).toEqual([
      '2026-08-15',
      '2027-02-15',
      '2027-08-15',
      '2028-02-15',
      '2028-08-15',
    ]);
    expect(previousCouponDate(SHORT_5PCT, '2026-12-01')).toBe('2026-08-15');
    expect(nextCouponDate(SHORT_5PCT, '2026-12-01')).toBe('2027-02-15');
  });

  it('honours the end-of-month rule, including 29 February in a leap year', () => {
    const eom: BondTerms = {
      couponRate: 0.04,
      frequency: 2,
      datedDate: '2026-08-31',
      maturity: '2031-08-31',
    };
    expect(couponDates(eom)).toEqual([
      '2026-08-31',
      '2027-02-28',
      '2027-08-31',
      '2028-02-29',
      '2028-08-31',
      '2029-02-28',
      '2029-08-31',
      '2030-02-28',
      '2030-08-31',
      '2031-02-28',
      '2031-08-31',
    ]);
    expect(couponSchedule(eom).every((p) => p.regular)).toBe(true);
    expect(couponSchedule(eom).every((p) => p.couponAmount === 2)).toBe(true);
  });

  it('pays a long odd first coupon of 2.5 + 2.5 × 31/181 under the ICMA quasi-period rule', () => {
    const longFirst: BondTerms = {
      couponRate: 0.05,
      frequency: 2,
      datedDate: '2026-07-15',
      firstCouponDate: '2027-02-15',
      maturity: '2031-02-15',
    };
    const schedule = couponSchedule(longFirst);
    const first = schedule[0];
    expect(first?.regular).toBe(false);
    expect(first?.accrualStart).toBe('2026-07-15');
    expect(first?.accrualEnd).toBe('2027-02-15');
    // Two quasi-coupon periods: 2026-02-15 → 2026-08-15 → 2027-02-15.
    expect(first?.quasiBoundaries).toEqual(['2026-02-15', '2026-08-15', '2027-02-15']);
    expect(first?.couponAmount).toBeCloseTo(2.5 + (2.5 * 31) / 181, 12);
    expect(first?.periodUnits).toBeCloseTo(1 + 31 / 181, 12);
    expect(schedule.slice(1).every((p) => p.regular && p.couponAmount === 2.5)).toBe(true);
    // Accrual through the odd period reaches the odd coupon exactly one day later.
    const dayBefore = accrualOf(longFirst, '2027-02-14').accrued;
    expect((first?.couponAmount ?? 0) - dayBefore).toBeCloseTo(5 / 368, 12);
  });

  it('pays a short odd first coupon of 2.5 × 62/184', () => {
    const shortFirst: BondTerms = {
      couponRate: 0.05,
      frequency: 2,
      datedDate: '2026-12-15',
      firstCouponDate: '2027-02-15',
      maturity: '2031-02-15',
    };
    const first = couponSchedule(shortFirst)[0];
    expect(first?.regular).toBe(false);
    expect(first?.quasiBoundaries).toEqual(['2026-08-15', '2027-02-15']);
    expect(first?.couponAmount).toBeCloseTo((2.5 * 62) / 184, 12);
    expect(first?.couponAmount).toBeLessThan(2.5);
  });

  it('pays an odd last coupon of 2.5 × 97/184 for a stub to 2030-11-20', () => {
    const oddLast: BondTerms = {
      couponRate: 0.05,
      frequency: 2,
      datedDate: '2026-02-15',
      penultimateCouponDate: '2030-08-15',
      maturity: '2030-11-20',
    };
    const schedule = couponSchedule(oddLast);
    const last = schedule[schedule.length - 1];
    expect(last?.regular).toBe(false);
    expect(last?.accrualStart).toBe('2030-08-15');
    expect(last?.accrualEnd).toBe('2030-11-20');
    expect(last?.couponAmount).toBeCloseTo((2.5 * 97) / 184, 12);
    expect(schedule.slice(0, -1).every((p) => p.regular)).toBe(true);
    const flows = cashflows(oddLast);
    expect(flows[flows.length - 1]?.principal).toBe(100);
    expect(flows[flows.length - 1]?.amount).toBeCloseTo(100 + (2.5 * 97) / 184, 12);
  });

  it('discounts an odd first coupon over its true quasi-period distance', () => {
    const longFirst: BondTerms = {
      couponRate: 0.05,
      frequency: 2,
      datedDate: '2026-07-15',
      firstCouponDate: '2027-02-15',
      maturity: '2031-02-15',
    };
    const flows = discountedFlows(longFirst, '2026-07-15');
    // 31/181 of the first quasi-period is behind us, so the odd coupon is 1 + 31/181 periods away.
    expect(flows[0]?.periods).toBeCloseTo(1 + 31 / 181, 12);
    expect(flows[1]?.periods).toBeCloseTo(2 + 31 / 181, 12);
    const p = priceFromYield(longFirst, '2026-07-15', 0.05);
    // Priced at its own coupon the bond is within a cent of par: the odd first period is a small
    // correction (the extra 31/181 of a coupon is paid, but a period later), not a blunder. The
    // otherwise identical bond with a *regular* first period prices at exactly par.
    const regular: BondTerms = {
      couponRate: 0.05,
      frequency: 2,
      datedDate: '2026-08-15',
      maturity: '2031-02-15',
    };
    expect(Math.abs(cleanPriceFromYield(regular, '2026-08-15', 0.05) - 100)).toBeLessThanOrEqual(
      1e-12,
    );
    expect(Math.abs(p.cleanPrice - 100)).toBeLessThan(0.01);
  });

  it('refuses a settlement outside the bond’s life', () => {
    expect(() => accrued(SHORT_5PCT, '2026-08-14')).toThrow(RangeError);
    expect(() => accrued(SHORT_5PCT, '2028-08-15')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// The seven on-the-run notes and bonds (WORKPLAN L537)
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: BondEngineInputs;
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN_DIR = new URL('../../../../fixtures/golden/analytics/bond/', import.meta.url);

function loadGolden(file: string): GoldenCase[] {
  return JSON.parse(readFileSync(new URL(file, GOLDEN_DIR), 'utf8')) as GoldenCase[];
}

function termsOf(inputs: BondEngineInputs): BondTerms {
  return {
    face: inputs.face ?? 100,
    couponRate: inputs.couponRate,
    frequency: inputs.frequency,
    datedDate: inputs.datedDate,
    maturity: inputs.maturity,
    ...(inputs.dayCount === undefined ? {} : { dayCount: inputs.dayCount }),
  };
}

describe('the seven on-the-run notes and bonds — price ↔ yield round trip to 1e-9', () => {
  const cases = loadGolden('onthe-run.json');

  it('checks in all seven benchmarks with the required source', () => {
    expect(cases.map((c) => c.id)).toEqual([
      'bond.otr.2y',
      'bond.otr.3y',
      'bond.otr.5y',
      'bond.otr.7y',
      'bond.otr.10y',
      'bond.otr.20y',
      'bond.otr.30y',
    ]);
    for (const c of cases) {
      expect(c.source).toBe('treasury.yieldcurve capture + treasuries seed');
      expect(c.engine).toBe('bond.price');
      expect(c.engineVersion).toBe(bondPriceEngine.version);
    }
  });

  for (const golden of cases) {
    const terms = termsOf(golden.inputs);
    const settlement = golden.inputs.settlement;

    it(`${golden.id}: round-trips {95, 98.5, 100, 101.25, 110} to 1e-9`, () => {
      for (const price of [95, 98.5, 100, 101.25, 110]) {
        const solved = yieldFromPrice(terms, settlement, price);
        expect(solved.ok, `${golden.id} @ ${String(price)}`).toBe(true);
        const back = cleanPriceFromYield(terms, settlement, solved.yield);
        expect(
          Math.abs(back - price),
          `${golden.id} @ ${String(price)}: ${String(back)}`,
        ).toBeLessThanOrEqual(1e-9);
      }
    });

    it(`${golden.id}: the golden price equals the closed-form annuity`, () => {
      const y = golden.inputs.yield!;
      const n = golden.expected.periodsRemaining as number;
      const closed = closedFormPrice(golden.inputs.couponRate, y, n);
      expect(Math.abs(closed - (golden.expected.cleanPrice as number))).toBeLessThanOrEqual(
        golden.tol.cleanPrice ?? 1e-6,
      );
      const engine = priceFromYield(terms, settlement, y);
      expect(Math.abs(engine.cleanPrice - closed)).toBeLessThanOrEqual(1e-12);
      expect(engine.accrued).toBe(0);
      expect(engine.periodsRemaining).toBe(n);
    });

    it(`${golden.id}: settles on a coupon date, so accrued is zero and w = 1`, () => {
      expect(accrued(terms, settlement)).toBe(0);
      expect(periodFractionRemaining(terms, settlement)).toBe(1);
    });
  }
});

describe('fixtures/golden/analytics/bond/{accrued,price,onthe-run}.json', () => {
  // `accrued.json` is the file TESTING §7.1's layout listing names for the §7.4 accrued pair; the
  // other §7.3 cases stay in `price.json`, and the seven on-the-run notes in `onthe-run.json`.
  const files = readdirSync(GOLDEN_DIR)
    .filter((f) => f === 'price.json' || f === 'onthe-run.json' || f === 'accrued.json')
    .sort();
  const cases = files.flatMap((f) => loadGolden(f));

  it('reads all three files', () => {
    expect(files).toEqual(['accrued.json', 'onthe-run.json', 'price.json']);
    expect(cases.length).toBe(12);
  });

  for (const golden of cases) {
    it(`replays ${golden.id}`, () => {
      expect(golden.engine).toBe('bond.price');
      expect(golden.engineVersion).toBe(bondPriceEngine.version);
      expect(golden.source.length).toBeGreaterThan(0);
      const result = bondPriceEngine(golden.inputs, golden.valuationTs);
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
      expect(bondPriceEngine(golden.inputs, golden.valuationTs).inputsHash).toBe(result.inputsHash);
      expect(result.outputs.conventions.dayCount).toBe('ACT/ACT');
      expect(result.outputs.conventions.frequency).toBe(2);
      expect(result.outputs.conventions.compounding).toBe('semiannual');
    });
  }
});
