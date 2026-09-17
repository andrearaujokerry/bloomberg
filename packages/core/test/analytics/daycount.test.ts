/**
 * TESTING §7.4 — accrued interest across day counts (ANAL-01).
 *
 * One stated coupon period, five conventions. Face 100, annual coupon rate 5.000 %, semiannual.
 * Previous coupon 2026-02-15, next coupon 2026-08-15, settlement 2026-05-31. 2026 is not a leap
 * year; actual days 2026-02-15 → 2026-05-31 = 105 (day-of-year 151 − 46), actual days in the coupon
 * period = 181 (227 − 46).
 *
 * Every expected number below is transcribed from the TESTING §7.4 table and is **normative**: it is
 * never replaced by what the implementation happens to produce. The documented tolerance is 1e-9.
 */

import { describe, expect, it } from 'vitest';

import { dayOfYear, daysBetween } from '../../src/calendars/calendar.js';
import {
  ACT_360,
  ACT_365F,
  ACT_ACT_ICMA,
  ACT_ACT_ISDA,
  DAY_COUNT_IDS,
  THIRTY_360_US,
  THIRTY_E_360,
  accruedInterest,
  dayCount,
  isDayCountId,
} from '../../src/daycount/conventions.js';
import type { DayCountConvention, PeriodContext } from '../../src/daycount/conventions.js';

/** The documented tolerance of every §7.4 assertion. */
const TOL = 1e-9;

function expectPinned(actual: number, pinned: number, what: string): void {
  const diff = Math.abs(actual - pinned);
  expect(
    diff,
    `${what}: got ${actual.toPrecision(17)}, TESTING §7.4 pins ${String(pinned)} (diff ${diff.toExponential(3)})`,
  ).toBeLessThanOrEqual(TOL);
}

// ── The §7.4 case ────────────────────────────────────────────────────────────────────────────
const PREVIOUS_COUPON = '2026-02-15';
const NEXT_COUPON = '2026-08-15';
const SETTLEMENT = '2026-05-31';
const FACE = 100;
const COUPON_RATE = 0.05; // 5.000 % per annum
const FREQUENCY = 2; // semiannual

const PERIOD: PeriodContext = {
  periodStart: PREVIOUS_COUPON,
  periodEnd: NEXT_COUPON,
  frequency: FREQUENCY,
};

const accrued = (convention: DayCountConvention): number =>
  accruedInterest({
    face: FACE,
    couponRate: COUPON_RATE,
    convention,
    start: PREVIOUS_COUPON,
    end: SETTLEMENT,
    ctx: PERIOD,
  });

describe('TESTING §7.4 — the stated coupon period', () => {
  it('has the pinned actual day counts: 105 accrued, 181 in the period', () => {
    // day-of-year 151 − 46 = 105, and 227 − 46 = 181.
    expect(dayOfYear(SETTLEMENT)).toBe(151);
    expect(dayOfYear(PREVIOUS_COUPON)).toBe(46);
    expect(dayOfYear(NEXT_COUPON)).toBe(227);
    expect(daysBetween(PREVIOUS_COUPON, SETTLEMENT)).toBe(105);
    expect(daysBetween(PREVIOUS_COUPON, NEXT_COUPON)).toBe(181);
  });
});

describe('TESTING §7.4 — year fraction and accrued per 100, five conventions', () => {
  it('ACT_360 — 105 / 360 → 0.291666667, accrued 1.458333333', () => {
    const m = ACT_360.measure(PREVIOUS_COUPON, SETTLEMENT, PERIOD);
    expect(m.days).toBe(105);
    expect(m.denominator).toBe(360);
    expectPinned(m.yearFraction, 0.291666667, 'ACT_360 year fraction');
    expectPinned(accrued(ACT_360), 1.458333333, 'ACT_360 accrued per 100');
  });

  it('ACT_ACT_ISDA — 105 / 365, no year split → 0.287671233, accrued 1.438356164', () => {
    const m = ACT_ACT_ISDA.measure(PREVIOUS_COUPON, SETTLEMENT, PERIOD);
    expect(m.days).toBe(105);
    expectPinned(m.denominator, 365, 'ACT_ACT_ISDA effective denominator');
    expectPinned(m.yearFraction, 0.287671233, 'ACT_ACT_ISDA year fraction');
    expectPinned(accrued(ACT_ACT_ISDA), 1.438356164, 'ACT_ACT_ISDA accrued per 100');
  });

  it('THIRTY_360_US — 106 / 360 (the D2 = 31 → 30 rule does not fire) → 0.294444444, accrued 1.472222222', () => {
    const m = THIRTY_360_US.measure(PREVIOUS_COUPON, SETTLEMENT, PERIOD);
    // 30 × (5 − 2) + (31 − 15) = 106: D1 is 15, neither 30 nor 31, so D2 stays 31.
    expect(m.days).toBe(106);
    expect(m.denominator).toBe(360);
    expectPinned(m.yearFraction, 0.294444444, 'THIRTY_360_US year fraction');
    expectPinned(accrued(THIRTY_360_US), 1.472222222, 'THIRTY_360_US accrued per 100');
  });

  it('THIRTY_E_360 — 105 / 360 (D2 = 31 → 30 unconditionally) → 0.291666667, accrued 1.458333333', () => {
    const m = THIRTY_E_360.measure(PREVIOUS_COUPON, SETTLEMENT, PERIOD);
    // 90 + (30 − 15) = 105.
    expect(m.days).toBe(105);
    expect(m.denominator).toBe(360);
    expectPinned(m.yearFraction, 0.291666667, 'THIRTY_E_360 year fraction');
    expectPinned(accrued(THIRTY_E_360), 1.458333333, 'THIRTY_E_360 accrued per 100');
  });

  it('ACT_ACT_ICMA(2) — 105 / 181 of a 2.5 coupon → 0.290055249, accrued 1.450276243', () => {
    const icma = ACT_ACT_ICMA(FREQUENCY);
    const m = icma.measure(PREVIOUS_COUPON, SETTLEMENT, PERIOD);
    expect(m.days).toBe(105);
    expect(m.denominator).toBe(181 * FREQUENCY);
    expectPinned(m.yearFraction, 0.290055249, 'ACT_ACT_ICMA(2) year fraction');
    expectPinned(accrued(icma), 1.450276243, 'ACT_ACT_ICMA(2) accrued per 100');
    // The same number read the other way round: 105/181 of the 2.500 half-year coupon.
    expectPinned(accrued(icma), (105 / 181) * 2.5, 'ACT_ACT_ICMA(2) accrued as a fraction of 2.5');
  });

  it('THIRTY_360_US ≠ THIRTY_E_360 for this date pair — the point of settling on the 31st', () => {
    expect(THIRTY_360_US.days(PREVIOUS_COUPON, SETTLEMENT)).toBe(106);
    expect(THIRTY_E_360.days(PREVIOUS_COUPON, SETTLEMENT)).toBe(105);
    expect(accrued(THIRTY_360_US)).not.toBe(accrued(THIRTY_E_360));
    expectPinned(
      accrued(THIRTY_360_US) - accrued(THIRTY_E_360),
      1.472222222 - 1.458333333,
      'THIRTY_360_US − THIRTY_E_360',
    );
  });
});

describe('TESTING §7.4 — the ACT/ACT ISDA branches', () => {
  it('splits at the year boundary: 2026-11-15 → 2027-02-15 = 47/365 + 45/365 = 0.252054795', () => {
    const m = ACT_ACT_ISDA.measure('2026-11-15', '2027-02-15');
    expect(m.days).toBe(92);
    expectPinned(m.yearFraction, 0.252054795, 'ACT_ACT_ISDA split year fraction');
    // The real decomposition: 2026-11-15 → 2027-01-01 is 15 (rest of November) + 31 (December)
    // = 47 days, and 2027-01-01 → 2027-02-15 is 31 (January) + 14 = 45 days. 47 + 45 = 92.
    // §7.4's prose says "46/365 + 46/365", which is wrong; the *sum* it pins (0.252054795) is
    // right, because both 2026 and 2027 are non-leap so the two parts share a 365 denominator and
    // any split summing to 92 gives the same year fraction. Asserted as the true split.
    expect(daysBetween('2026-11-15', '2027-01-01')).toBe(47);
    expect(daysBetween('2027-01-01', '2027-02-15')).toBe(45);
    expectPinned(m.yearFraction, 47 / 365 + 45 / 365, 'ACT_ACT_ISDA split, 47 + 45 over 365');
    expectPinned(m.yearFraction, 92 / 365, 'ACT_ACT_ISDA split, 92/365');
  });

  it('uses 366 in a leap year: 2028-02-15 → 2028-05-31 = 106/366 = 0.289617486', () => {
    const m = ACT_ACT_ISDA.measure('2028-02-15', '2028-05-31');
    expect(m.days).toBe(106);
    expectPinned(m.denominator, 366, 'ACT_ACT_ISDA leap denominator');
    expectPinned(m.yearFraction, 0.289617486, 'ACT_ACT_ISDA leap year fraction');
  });

  it('ACT_365F differs from ACT_ACT_ISDA exactly on the leap branch', () => {
    // Same answer when no leap year is involved …
    expectPinned(
      ACT_365F.yearFraction(PREVIOUS_COUPON, SETTLEMENT),
      ACT_ACT_ISDA.yearFraction(PREVIOUS_COUPON, SETTLEMENT),
      'ACT_365F vs ACT_ACT_ISDA, non-leap',
    );
    expectPinned(ACT_365F.yearFraction(PREVIOUS_COUPON, SETTLEMENT), 105 / 365, 'ACT_365F, 105/365');
    // … and the fixed 365 denominator when there is.
    expectPinned(ACT_365F.yearFraction('2028-02-15', '2028-05-31'), 106 / 365, 'ACT_365F, 106/365');
    expect(ACT_365F.yearFraction('2028-02-15', '2028-05-31')).not.toBe(
      ACT_ACT_ISDA.yearFraction('2028-02-15', '2028-05-31'),
    );
  });
});

describe('the six day-count strings match the govt_terms.day_count CHECK list', () => {
  // CONTRACTS L75, verbatim:
  const CHECK =
    "day_count text CHECK (day_count IN ('ACT/ACT','ACT/360','ACT/365F','30/360','30E/360','ACT/ACT-ISDA'))";

  it('DAY_COUNT_IDS is the CHECK list, in order', () => {
    const inList = /IN \(([^)]*)\)/.exec(CHECK)?.[1];
    expect(inList).toBeDefined();
    const fromCheck = (inList!)
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''));
    expect(fromCheck).toHaveLength(6);
    expect([...DAY_COUNT_IDS]).toEqual(fromCheck);
    for (const id of fromCheck) expect(isDayCountId(id)).toBe(true);
  });

  it('every CHECK string resolves to a convention that reports that same id', () => {
    for (const id of DAY_COUNT_IDS) {
      const dc = dayCount(id, FREQUENCY);
      expect(dc.id).toBe(id);
      expect(typeof dc.name).toBe('string');
    }
  });

  it("'ACT/ACT' is the bond ACT/ACT — ACT_ACT_ICMA(freq) — per WORKPLAN L520", () => {
    const treasury = dayCount('ACT/ACT', FREQUENCY);
    expectPinned(
      accruedInterest({
        face: FACE,
        couponRate: COUPON_RATE,
        convention: treasury,
        start: PREVIOUS_COUPON,
        end: SETTLEMENT,
        ctx: PERIOD,
      }),
      1.450276243,
      "dayCount('ACT/ACT', 2) accrued per 100",
    );
    // It is NOT the ISDA ACT/ACT, which is the separate 'ACT/ACT-ISDA' string.
    expect(treasury.yearFraction(PREVIOUS_COUPON, SETTLEMENT, PERIOD)).not.toBe(
      ACT_ACT_ISDA.yearFraction(PREVIOUS_COUPON, SETTLEMENT, PERIOD),
    );
    expect(isDayCountId('ACT/ACT ICMA')).toBe(false);
  });

  it('rejects an empty or inverted coupon period rather than dividing by zero', () => {
    const icma = ACT_ACT_ICMA(2);
    expect(() =>
      icma.yearFraction(PREVIOUS_COUPON, SETTLEMENT, {
        periodStart: NEXT_COUPON,
        periodEnd: PREVIOUS_COUPON,
      }),
    ).toThrow(/empty or inverted/);
    expect(() => ACT_ACT_ICMA(0)).toThrow(/frequency/);
  });
});

describe('day counts over a whole coupon period', () => {
  it('a full semiannual ACT/ACT ICMA period is exactly half a year', () => {
    const icma = ACT_ACT_ICMA(FREQUENCY);
    expectPinned(
      icma.yearFraction(PREVIOUS_COUPON, NEXT_COUPON, PERIOD),
      0.5,
      'full period ACT/ACT ICMA',
    );
    expectPinned(
      accruedInterest({
        face: FACE,
        couponRate: COUPON_RATE,
        convention: icma,
        start: PREVIOUS_COUPON,
        end: NEXT_COUPON,
        ctx: PERIOD,
      }),
      2.5,
      'full period coupon per 100',
    );
  });

  it('a zero-length interval accrues nothing under every convention', () => {
    for (const id of DAY_COUNT_IDS) {
      const dc = dayCount(id, FREQUENCY);
      expect(dc.yearFraction(SETTLEMENT, SETTLEMENT, PERIOD)).toBe(0);
    }
  });
});
