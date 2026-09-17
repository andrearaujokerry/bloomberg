/**
 * Day-count conventions (ANAL-01, TESTING §7.4).
 *
 * {@link DAY_COUNT_IDS} is the `govt_terms.day_count` CHECK list, verbatim and in order
 * (CONTRACTS L75):
 *
 * ```
 * day_count text CHECK (day_count IN ('ACT/ACT','ACT/360','ACT/365F','30/360','30E/360','ACT/ACT-ISDA'))
 * ```
 *
 * `'ACT/ACT'` is the **bond** ACT/ACT — ACT/ACT ICMA — which needs the coupon frequency and the
 * enclosing coupon period, so it is built by the {@link ACT_ACT_ICMA} factory rather than being a
 * constant. Treasury note and bond accrual (`govt_terms.day_count = 'ACT/ACT'`) is
 * `ACT_ACT_ICMA(coupon_freq)` (WORKPLAN L520). `'ACT/ACT-ISDA'` is the *other* ACT/ACT — the one
 * that splits the interval at the year boundary and divides each part by the length of its own year
 * — and is a constant because it needs no period.
 *
 * Every convention exposes the same three calls: `days` (the numerator), `yearFraction`, and
 * `measure`, which returns both plus the effective denominator.
 */

import type { IsoDate } from '../calendars/calendar.js';
import {
  compareDates,
  daysBetween,
  formatIsoDate,
  isLeapYear,
  maxDate,
  minDate,
  parseIsoDate,
} from '../calendars/calendar.js';

/**
 * The six `govt_terms.day_count` strings, verbatim from the CHECK constraint (CONTRACTS L75).
 * Order matters: the test in `packages/core/test/analytics/daycount.test.ts` compares this array
 * element by element against the constraint text.
 */
export const DAY_COUNT_IDS = [
  'ACT/ACT',
  'ACT/360',
  'ACT/365F',
  '30/360',
  '30E/360',
  'ACT/ACT-ISDA',
] as const;

/** One of the six `govt_terms.day_count` values. */
export type DayCountId = (typeof DAY_COUNT_IDS)[number];

/** True when `value` is one of the six day-count strings. */
export function isDayCountId(value: unknown): value is DayCountId {
  return typeof value === 'string' && (DAY_COUNT_IDS as readonly string[]).includes(value);
}

/**
 * The enclosing coupon period. Only ACT/ACT ICMA reads it; every other convention ignores it, so a
 * caller that does not know the schedule can leave it out.
 */
export interface PeriodContext {
  /** Start of the coupon period the interval sits in. Defaults to the interval's own start. */
  readonly periodStart?: IsoDate;
  /** End of that coupon period — the next coupon date. Required by ACT/ACT ICMA. */
  readonly periodEnd?: IsoDate;
  /** Coupon frequency in periods per year. Overrides the frequency baked into the convention. */
  readonly frequency?: number;
}

/** A day count and the year fraction it produces. */
export interface DayCountMeasure {
  /** The numerator: the convention's count of days in `[start, end)`. */
  readonly days: number;
  /**
   * The effective denominator, so that `yearFraction === days / denominator`. For ACT/ACT ISDA over
   * a year boundary this is a blended value rather than 365 or 366.
   */
  readonly denominator: number;
  readonly yearFraction: number;
}

/** A day-count convention. Pure: the same interval always measures the same. */
export interface DayCountConvention {
  /** The `govt_terms.day_count` string this convention implements. */
  readonly id: DayCountId;
  /** Human-readable name for the `Conventions` object echoed in engine outputs (ANAL-07). */
  readonly name: string;
  /** The numerator — the convention's day count over `[start, end)`. */
  days(start: IsoDate, end: IsoDate, ctx?: PeriodContext): number;
  /** The year fraction of `[start, end)`. */
  yearFraction(start: IsoDate, end: IsoDate, ctx?: PeriodContext): number;
  /** Numerator, denominator and year fraction in one call. */
  measure(start: IsoDate, end: IsoDate, ctx?: PeriodContext): DayCountMeasure;
}

/** Build a convention from a single `measure` implementation. */
function convention(
  id: DayCountId,
  name: string,
  measure: (start: IsoDate, end: IsoDate, ctx?: PeriodContext) => DayCountMeasure,
): DayCountConvention {
  return {
    id,
    name,
    measure,
    days: (start, end, ctx) => measure(start, end, ctx).days,
    yearFraction: (start, end, ctx) => measure(start, end, ctx).yearFraction,
  };
}

/** Actual days over a fixed denominator. */
function fixedDenominator(id: DayCountId, name: string, denominator: number): DayCountConvention {
  return convention(id, name, (start, end) => {
    const days = daysBetween(start, end);
    return { days, denominator, yearFraction: days / denominator };
  });
}

/**
 * `ACT/360` — actual days over 360. The money-market convention: Treasury bills, SOFR, the floating
 * leg of a SOFR OIS.
 */
export const ACT_360: DayCountConvention = fixedDenominator('ACT/360', 'Actual/360', 360);

/** `ACT/365F` — actual days over a fixed 365, leap years included. */
export const ACT_365F: DayCountConvention = fixedDenominator(
  'ACT/365F',
  'Actual/365 (Fixed)',
  365,
);

/**
 * `ACT/ACT-ISDA` — actual days, split at each 1 January and each part divided by the length of its
 * own year (365 or 366). TESTING §7.4: 2026-02-15 → 2026-05-31 is 105/365 = 0.287671233 with no
 * split; 2026-11-15 → 2027-02-15 is the split branch, 0.252054795; 2028-02-15 → 2028-05-31 is the
 * leap branch, 106/366 = 0.289617486.
 */
export const ACT_ACT_ISDA: DayCountConvention = convention(
  'ACT/ACT-ISDA',
  'Actual/Actual (ISDA)',
  (start, end) => {
    const days = daysBetween(start, end);
    if (days === 0) {
      const y = parseIsoDate(start).year;
      return { days: 0, denominator: isLeapYear(y) ? 366 : 365, yearFraction: 0 };
    }
    const backwards = days < 0;
    const lo = backwards ? end : start;
    const hi = backwards ? start : end;
    let yearFraction = 0;
    for (let y = parseIsoDate(lo).year; y <= parseIsoDate(hi).year; y++) {
      const yearStart = formatIsoDate(y, 1, 1);
      const yearEnd = formatIsoDate(y + 1, 1, 1);
      const from = maxDate(lo, yearStart);
      const to = minDate(hi, yearEnd);
      if (compareDates(from, to) >= 0) continue;
      yearFraction += daysBetween(from, to) / (isLeapYear(y) ? 366 : 365);
    }
    if (backwards) yearFraction = -yearFraction;
    return { days, denominator: days / yearFraction, yearFraction };
  },
);

/** Shared 30/360 arithmetic. `european` selects 30E/360's unconditional D2 = 31 → 30 rule. */
function thirty360Days(start: IsoDate, end: IsoDate, european: boolean): number {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  let d1 = a.day;
  let d2 = b.day;
  if (d1 === 31) d1 = 30;
  if (european) {
    if (d2 === 31) d2 = 30;
  } else if (d2 === 31 && d1 === 30) {
    // US/bond basis: D2 = 31 collapses to 30 only when D1 is already 30 (or was a 31 that became
    // one). TESTING §7.4 turns on exactly this: D1 = 15 on 2026-02-15, so the rule does NOT fire
    // and 2026-02-15 → 2026-05-31 counts 106 days, not 105.
    d2 = 30;
  }
  return 360 * (b.year - a.year) + 30 * (b.month - a.month) + (d2 - d1);
}

/**
 * `30/360` — the US / bond-basis 30/360 (ISDA 2006 4.16(f)): D1 = 31 → 30, and D2 = 31 → 30 only
 * when D1 is 30. The February end-of-month refinement of the NASD variant is deliberately not
 * applied; `govt_terms` carries the bond-basis convention.
 */
export const THIRTY_360_US: DayCountConvention = convention(
  '30/360',
  '30/360 (US, bond basis)',
  (start, end) => {
    const days = thirty360Days(start, end, false);
    return { days, denominator: 360, yearFraction: days / 360 };
  },
);

/** `30E/360` — Eurobond basis: D1 = 31 → 30 and D2 = 31 → 30, both unconditional. */
export const THIRTY_E_360: DayCountConvention = convention(
  '30E/360',
  '30E/360 (Eurobond basis)',
  (start, end) => {
    const days = thirty360Days(start, end, true);
    return { days, denominator: 360, yearFraction: days / 360 };
  },
);

/**
 * `ACT/ACT` ICMA (`'ACT/ACT'` in `govt_terms.day_count`) — the bond convention. The year fraction is
 *
 * ```
 *        days(periodStart → settlement)
 *   ─────────────────────────────────────────
 *   days(periodStart → periodEnd) × frequency
 * ```
 *
 * TESTING §7.4: 105 days into a 181-day semiannual period is 105 / (181 × 2) = 0.290055249 of a
 * year, so accrued on a 5 % note per 100 face is 1.450276243.
 *
 * `periodStart` defaults to the interval's start and `periodEnd` must be supplied either in the
 * context or — for a whole coupon period — implicitly as the interval's own end.
 */
export function ACT_ACT_ICMA(frequency: number): DayCountConvention {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    throw new RangeError(`ACT_ACT_ICMA: frequency must be positive, got ${String(frequency)}`);
  }
  return convention('ACT/ACT', `Actual/Actual (ICMA, ${String(frequency)}/yr)`, (start, end, ctx) => {
    const freq = ctx?.frequency ?? frequency;
    if (!Number.isFinite(freq) || freq <= 0) {
      throw new RangeError(`ACT_ACT_ICMA: frequency must be positive, got ${String(freq)}`);
    }
    const periodStart = ctx?.periodStart ?? start;
    const periodEnd = ctx?.periodEnd ?? end;
    const periodDays = daysBetween(periodStart, periodEnd);
    if (periodDays <= 0) {
      throw new RangeError(
        `ACT_ACT_ICMA: coupon period ${periodStart} → ${periodEnd} is empty or inverted`,
      );
    }
    const days = daysBetween(start, end);
    const denominator = periodDays * freq;
    return { days, denominator, yearFraction: days / denominator };
  });
}

/**
 * Resolve a `govt_terms.day_count` string to a convention. `'ACT/ACT'` needs `frequency`
 * (`govt_terms.coupon_freq`), which defaults to 2 — semiannual, every US Treasury note and bond.
 */
export function dayCount(id: DayCountId, frequency = 2): DayCountConvention {
  switch (id) {
    case 'ACT/ACT':
      return ACT_ACT_ICMA(frequency);
    case 'ACT/360':
      return ACT_360;
    case 'ACT/365F':
      return ACT_365F;
    case '30/360':
      return THIRTY_360_US;
    case '30E/360':
      return THIRTY_E_360;
    case 'ACT/ACT-ISDA':
      return ACT_ACT_ISDA;
  }
}

/** Inputs to {@link accruedInterest}. */
export interface AccruedInterestSpec {
  /** Face (par) amount. Use 100 for a price-per-100 quote. */
  readonly face: number;
  /** Annual coupon rate as a **decimal fraction**: 0.05 for a 5.000 % coupon. */
  readonly couponRate: number;
  readonly convention: DayCountConvention;
  /** Previous coupon date (start of accrual). */
  readonly start: IsoDate;
  /** Settlement date (end of accrual). */
  readonly end: IsoDate;
  /** The enclosing coupon period; required for ACT/ACT ICMA. */
  readonly ctx?: PeriodContext;
}

/**
 * Accrued interest = face × couponRate × yearFraction (ANAL-01, TESTING §7.4).
 *
 * `govt_terms.coupon_rate` is stored in **percent**, so divide it by 100 before passing it here.
 */
export function accruedInterest(spec: AccruedInterestSpec): number {
  const yf = spec.convention.yearFraction(spec.start, spec.end, spec.ctx);
  return spec.face * spec.couponRate * yf;
}
