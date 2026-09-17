/**
 * Bond coupon schedules and cashflows (ANAL-01, ARCHITECTURE L162).
 *
 * The schedule is generated **backwards from maturity** — the market convention, and the only one
 * that keeps a 15 Aug / 15 Feb note on the 15th and an end-of-month note on the last day of the
 * month — in steps of `12 / frequency` months, stopping at the dated date (or at the stated first
 * coupon date, when there is an odd first coupon).
 *
 * Three date roles are kept apart, because conflating them is the classic accrual bug:
 *
 * - **accrual dates** (`accrualStart`, `accrualEnd`) are the *unadjusted* period boundaries. Every
 *   day count, accrued-interest and discount-exponent calculation uses these. US Treasuries accrue
 *   on unadjusted dates: a coupon due on a Saturday still ends its accrual period on the Saturday.
 * - **payment dates** are the accrual end rolled to a business day under the schedule's calendar
 *   and `govt_terms.business_day_conv` (`daycount/businessDay.ts`). Cash moves on these.
 * - **quasi-coupon dates** are the notional regular coupon dates an irregular period is measured
 *   against. They exist only for odd first/last coupons, and ICMA ACT/ACT is defined in terms of
 *   them.
 *
 * Odd coupons follow the ICMA rule: the irregular period is cut at its quasi-coupon dates and each
 * piece is measured against the length of *its own* quasi-period. A **short** odd period is a
 * fraction of the single quasi-period that ends on the odd coupon date; a **long** odd period is
 * one or more whole quasi-periods plus a leading fraction. The pieces sum to exactly the odd coupon
 * on its coupon date — that is the point of the rule. Under any other day count the period's own
 * year fraction is used directly.
 *
 * `Date` is not imported: every date here is an ISO `YYYY-MM-DD` string.
 */

import type { BusinessDayConvention, Calendar, IsoDate } from '../../calendars/calendar.js';
import {
  addMonths,
  compareDates,
  endOfMonth,
  isEndOfMonth,
  maxDate,
  minDate,
} from '../../calendars/calendar.js';
import type { DayCountConvention, DayCountId, PeriodContext } from '../../daycount/conventions.js';
import { dayCount } from '../../daycount/conventions.js';
import { adjustDate } from '../../daycount/businessDay.js';
import type { Conventions } from '../engine.js';

/** Coupon payments per year. The `govt_terms.coupon_freq` values. */
export type CouponFrequency = 1 | 2 | 4 | 6 | 12;

/** The `govt_terms` row an analytic needs, in engine units (rates as decimal fractions). */
export interface BondTerms {
  /** Face (par) amount. Defaults to 100 — a price per 100 face. */
  readonly face?: number;
  /** Redemption amount per `face`. Defaults to `face` (par redemption). */
  readonly redemption?: number;
  /** Annual coupon rate as a **decimal fraction**: 0.0425 for a 4.250 % coupon. */
  readonly couponRate: number;
  /** Payments per year (`govt_terms.coupon_freq`). */
  readonly frequency: CouponFrequency;
  /** Dated date — interest starts accruing here (`govt_terms.dated_date`). */
  readonly datedDate: IsoDate;
  readonly maturity: IsoDate;
  /** First coupon date, when it is not one regular period after the dated date (odd first coupon). */
  readonly firstCouponDate?: IsoDate;
  /**
   * Last *regular* coupon date before maturity, when the final period is irregular (odd last
   * coupon). The schedule is generated backwards from this date and maturity is appended.
   */
  readonly penultimateCouponDate?: IsoDate;
  /** `govt_terms.day_count`. Defaults to `'ACT/ACT'` — ICMA, the Treasury note convention. */
  readonly dayCount?: DayCountId;
  /** `govt_terms.business_day_conv`, applied to **payment** dates only. Defaults to `'following'`. */
  readonly businessDayConvention?: BusinessDayConvention;
  /** Calendar payment dates roll on. Without one, payment date = accrual end (no roll). */
  readonly calendar?: Calendar;
  /**
   * Force the end-of-month rule on or off. By default it is on exactly when the schedule's anchor
   * (the penultimate coupon date, else maturity) is the last day of its month.
   */
  readonly endOfMonthRule?: boolean;
}

/** One coupon period of a schedule. */
export interface CouponPeriod {
  /** 1-based position in the schedule. */
  readonly index: number;
  /** Unadjusted start of accrual. */
  readonly accrualStart: IsoDate;
  /** Unadjusted end of accrual — the coupon date. */
  readonly accrualEnd: IsoDate;
  /** {@link accrualEnd} rolled to a business day; where the cash actually moves. */
  readonly paymentDate: IsoDate;
  /** False for an odd first or odd last period. */
  readonly regular: boolean;
  /**
   * The quasi-coupon boundaries of this period, ascending. For a regular period exactly
   * `[accrualStart, accrualEnd]`; for an odd one the notional coupon dates stepped back from
   * `accrualEnd`, the first of which is on or **before** `accrualStart`.
   */
  readonly quasiBoundaries: readonly IsoDate[];
  /** Start of the quasi-coupon period the coupon date belongs to. */
  readonly quasiStart: IsoDate;
  /** End of that quasi-coupon period — the coupon date itself. */
  readonly quasiEnd: IsoDate;
  /** Year fraction of the whole period on the schedule's day count. */
  readonly yearFraction: number;
  /** Length of the period in **coupon-period units** (1 for a regular period). */
  readonly periodUnits: number;
  /** The coupon paid at the end of this period, per `face`. */
  readonly couponAmount: number;
}

/** One dated cashflow. */
export interface Cashflow {
  /** The unadjusted coupon/maturity date — what discounting counts periods to. */
  readonly date: IsoDate;
  /** The business-day-rolled date the cash moves on. */
  readonly paymentDate: IsoDate;
  /** Coupon component. */
  readonly interest: number;
  /** Redemption component; non-zero only on the last flow. */
  readonly principal: number;
  /** `interest + principal`. */
  readonly amount: number;
  /** 1-based index of the coupon period this flow ends. */
  readonly periodIndex: number;
}

/** What {@link accrued} returns. */
export interface AccrualResult {
  /** Accrued interest per `face`. Zero on a coupon date. */
  readonly accrued: number;
  /** The period settlement falls in. */
  readonly period: CouponPeriod;
  /** Day-count numerator from the period start to settlement. */
  readonly days: number;
  /** Day-count numerator of the quasi-coupon period settlement sits in. */
  readonly periodDays: number;
  /** Elapsed part of the period in **coupon-period units**: 0 on a coupon date. */
  readonly elapsedUnits: number;
  /** Year fraction from the period start to settlement, on the schedule's day count. */
  readonly yearFraction: number;
}

/** Default day count for a US Treasury note or bond: ACT/ACT ICMA. */
export const DEFAULT_BOND_DAY_COUNT: DayCountId = 'ACT/ACT';

/** Default business-day convention for Treasury coupon payments (FUNCTIONS_TIER3: `following`). */
export const DEFAULT_BOND_BDC: BusinessDayConvention = 'following';

/** Face amount every helper falls back to: a price per 100. */
export const DEFAULT_FACE = 100;

/** Guard against a runaway schedule loop: 4 000 periods is 1 000 years of quarterly coupons. */
const MAX_PERIODS = 4000;

/** Resolve `terms.face`. */
export function faceOf(terms: BondTerms): number {
  const face = terms.face ?? DEFAULT_FACE;
  if (!Number.isFinite(face) || face <= 0) {
    throw new RangeError(`bond: face must be positive, got ${String(face)}`);
  }
  return face;
}

/** Resolve `terms.redemption`, defaulting to par. */
export function redemptionOf(terms: BondTerms): number {
  const redemption = terms.redemption ?? faceOf(terms);
  if (!Number.isFinite(redemption) || redemption < 0) {
    throw new RangeError(`bond: redemption must be non-negative, got ${String(redemption)}`);
  }
  return redemption;
}

/** Months between coupons. */
export function monthsPerPeriod(frequency: CouponFrequency): number {
  const months = 12 / frequency;
  if (!Number.isInteger(months) || months <= 0) {
    throw new RangeError(`bond: frequency ${String(frequency)} does not divide 12 months`);
  }
  return months;
}

/** The day-count convention a schedule measures on (ICMA is parameterised by the frequency). */
export function conventionOf(terms: BondTerms): DayCountConvention {
  return dayCount(terms.dayCount ?? DEFAULT_BOND_DAY_COUNT, terms.frequency);
}

/** True when the schedule measures on ICMA ACT/ACT, the convention with quasi-coupon periods. */
function isIcma(terms: BondTerms): boolean {
  return (terms.dayCount ?? DEFAULT_BOND_DAY_COUNT) === 'ACT/ACT';
}

/** The `Conventions` object every bond output echoes (ANAL-07). */
export function bondConventions(terms: BondTerms): Conventions {
  const compounding =
    terms.frequency === 1
      ? 'annual'
      : terms.frequency === 2
        ? 'semiannual'
        : terms.frequency === 4
          ? 'quarterly'
          : 'simple';
  return Object.freeze({
    dayCount: terms.dayCount ?? DEFAULT_BOND_DAY_COUNT,
    compounding,
    frequency: terms.frequency,
    businessDayConvention: terms.businessDayConvention ?? DEFAULT_BOND_BDC,
    ...(terms.calendar === undefined ? {} : { calendar: terms.calendar.id }),
    currency: 'USD',
  } as const);
}

function validateTerms(terms: BondTerms): void {
  if (!Number.isFinite(terms.couponRate)) {
    throw new RangeError(`bond: couponRate must be finite, got ${String(terms.couponRate)}`);
  }
  if (compareDates(terms.datedDate, terms.maturity) >= 0) {
    throw new RangeError(
      `bond: datedDate ${terms.datedDate} is not before maturity ${terms.maturity}`,
    );
  }
  const first = terms.firstCouponDate;
  if (first !== undefined && compareDates(first, terms.datedDate) <= 0) {
    throw new RangeError(
      `bond: firstCouponDate ${first} is not after datedDate ${terms.datedDate}`,
    );
  }
  if (first !== undefined && compareDates(first, terms.maturity) > 0) {
    throw new RangeError(`bond: firstCouponDate ${first} is after maturity ${terms.maturity}`);
  }
  const penult = terms.penultimateCouponDate;
  if (penult !== undefined && compareDates(penult, terms.maturity) >= 0) {
    throw new RangeError(
      `bond: penultimateCouponDate ${penult} is not before maturity ${terms.maturity}`,
    );
  }
  if (penult !== undefined && compareDates(penult, terms.datedDate) <= 0) {
    throw new RangeError(
      `bond: penultimateCouponDate ${penult} is not after datedDate ${terms.datedDate}`,
    );
  }
}

/** Whether the end-of-month rule applies to a schedule anchored on `anchor`. */
function endOfMonthRuleOf(terms: BondTerms, anchor: IsoDate): boolean {
  return terms.endOfMonthRule ?? isEndOfMonth(anchor);
}

/** The schedule's stepping anchor: the penultimate coupon date when there is one, else maturity. */
function anchorOf(terms: BondTerms): IsoDate {
  return terms.penultimateCouponDate ?? terms.maturity;
}

/**
 * `anchor` shifted back `k` whole periods, honouring the end-of-month rule. Every date is computed
 * from the anchor rather than from its predecessor, so a 31st never drifts to a 30th and stays
 * there.
 */
function shiftFromAnchor(anchor: IsoDate, k: number, months: number, eom: boolean): IsoDate {
  const shifted = addMonths(anchor, -k * months);
  return eom ? endOfMonth(shifted) : shifted;
}

/**
 * The unadjusted accrual boundaries of a schedule, ascending:
 * `[datedDate, coupon₁, …, couponₙ₋₁, maturity]`. Coupon period `i` is `[dates[i], dates[i + 1])`.
 */
export function couponDates(terms: BondTerms): IsoDate[] {
  validateTerms(terms);
  const months = monthsPerPeriod(terms.frequency);
  const anchor = anchorOf(terms);
  const stop = terms.firstCouponDate ?? terms.datedDate;
  const eom = endOfMonthRuleOf(terms, anchor);

  const generated: IsoDate[] = [];
  for (let k = 0; ; k++) {
    if (k > MAX_PERIODS) throw new RangeError('bond: coupon schedule did not terminate');
    const d = shiftFromAnchor(anchor, k, months, eom);
    if (compareDates(d, stop) <= 0) break;
    generated.push(d);
  }
  generated.reverse();

  const dates: IsoDate[] = [terms.datedDate];
  const push = (d: IsoDate): void => {
    const last = dates[dates.length - 1];
    if (last !== undefined && compareDates(d, last) > 0) dates.push(d);
  };
  if (terms.firstCouponDate !== undefined) push(terms.firstCouponDate);
  for (const d of generated) push(d);
  push(terms.maturity);
  return dates;
}

/**
 * Quasi-coupon boundaries of the period `[accrualStart, accrualEnd)`, ascending. The first entry is
 * on or before `accrualStart`; the last is `accrualEnd`. A regular period yields exactly two.
 */
function quasiBoundariesOf(
  accrualStart: IsoDate,
  accrualEnd: IsoDate,
  months: number,
  eom: boolean,
): IsoDate[] {
  const descending: IsoDate[] = [accrualEnd];
  for (let k = 1; ; k++) {
    if (k > MAX_PERIODS) throw new RangeError('bond: quasi-coupon walk did not terminate');
    const lower = shiftFromAnchor(accrualEnd, k, months, eom);
    descending.push(lower);
    if (compareDates(lower, accrualStart) <= 0) break;
  }
  return descending.reverse();
}

/**
 * ICMA year fraction of `[from, to)` cut at the quasi-coupon boundaries, each piece measured
 * against the length of its own quasi-period. Outside `[boundaries[0], last]` the intersection is
 * empty and contributes nothing.
 */
function icmaYearFraction(
  from: IsoDate,
  to: IsoDate,
  boundaries: readonly IsoDate[],
  frequency: CouponFrequency,
  convention: DayCountConvention,
): number {
  let yearFraction = 0;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const periodStart = boundaries[i]!;
    const periodEnd = boundaries[i + 1]!;
    const lo = maxDate(from, periodStart);
    const hi = minDate(to, periodEnd);
    if (compareDates(lo, hi) >= 0) continue;
    const ctx: PeriodContext = { periodStart, periodEnd, frequency };
    yearFraction += convention.yearFraction(lo, hi, ctx);
  }
  return yearFraction;
}

/**
 * Year fraction of `[from, to)` inside the coupon period `period`, on the schedule's convention.
 * ICMA cuts at quasi-coupon dates; every other convention measures the interval directly.
 */
function yearFractionIn(
  terms: BondTerms,
  period: CouponPeriod,
  convention: DayCountConvention,
  from: IsoDate,
  to: IsoDate,
): number {
  if (isIcma(terms)) {
    return icmaYearFraction(from, to, period.quasiBoundaries, terms.frequency, convention);
  }
  return convention.yearFraction(from, to, {
    periodStart: period.accrualStart,
    periodEnd: period.accrualEnd,
    frequency: terms.frequency,
  });
}

/**
 * The coupon schedule: one {@link CouponPeriod} per accrual period, with the coupon each period
 * pays. Regular periods pay `face × rate / frequency` exactly; odd periods pay
 * `face × rate ×` the period's year fraction under the ICMA quasi-coupon rule.
 */
export function couponSchedule(terms: BondTerms): CouponPeriod[] {
  const dates = couponDates(terms);
  const face = faceOf(terms);
  const months = monthsPerPeriod(terms.frequency);
  const eom = endOfMonthRuleOf(terms, anchorOf(terms));
  const convention = conventionOf(terms);
  const icma = isIcma(terms);
  const regularCoupon = (face * terms.couponRate) / terms.frequency;

  const periods: CouponPeriod[] = [];
  for (let i = 0; i + 1 < dates.length; i++) {
    const accrualStart = dates[i]!;
    const accrualEnd = dates[i + 1]!;
    // A period is regular when its start is exactly one period before its end under the schedule's
    // own stepping rule.
    const impliedStart = shiftFromAnchor(accrualEnd, 1, months, eom);
    const regular = compareDates(impliedStart, accrualStart) === 0;
    const quasiBoundaries = regular
      ? [accrualStart, accrualEnd]
      : quasiBoundariesOf(accrualStart, accrualEnd, months, eom);
    const quasiStart = quasiBoundaries[quasiBoundaries.length - 2]!;

    const yearFraction = regular
      ? convention.yearFraction(accrualStart, accrualEnd, {
          periodStart: accrualStart,
          periodEnd: accrualEnd,
          frequency: terms.frequency,
        })
      : icma
        ? icmaYearFraction(accrualStart, accrualEnd, quasiBoundaries, terms.frequency, convention)
        : convention.yearFraction(accrualStart, accrualEnd);

    const paymentDate =
      terms.calendar === undefined
        ? accrualEnd
        : adjustDate(
            terms.calendar,
            accrualEnd,
            terms.businessDayConvention ?? DEFAULT_BOND_BDC,
            terms.endOfMonthRule ?? false,
          );

    periods.push({
      index: i + 1,
      accrualStart,
      accrualEnd,
      paymentDate,
      regular,
      quasiBoundaries,
      quasiStart,
      quasiEnd: accrualEnd,
      yearFraction,
      periodUnits: yearFraction * terms.frequency,
      couponAmount: regular ? regularCoupon : face * terms.couponRate * yearFraction,
    });
  }
  return periods;
}

/** Every cashflow of the bond: one per coupon period, with the redemption on the last. */
export function cashflows(terms: BondTerms): Cashflow[] {
  const periods = couponSchedule(terms);
  const redemption = redemptionOf(terms);
  return periods.map((p, idx) => {
    const principal = idx === periods.length - 1 ? redemption : 0;
    return {
      date: p.accrualEnd,
      paymentDate: p.paymentDate,
      interest: p.couponAmount,
      principal,
      amount: p.couponAmount + principal,
      periodIndex: p.index,
    };
  });
}

/**
 * The coupon period `settlement` falls in: `accrualStart ≤ settlement < accrualEnd`. Settling **on**
 * a coupon date puts settlement at the start of the *next* period, which is why accrued is exactly
 * zero there (TESTING §7.3).
 */
export function periodOf(terms: BondTerms, settlement: IsoDate): CouponPeriod {
  const periods = couponSchedule(terms);
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError('bond: schedule has no coupon periods');
  }
  if (compareDates(settlement, first.accrualStart) < 0) {
    throw new RangeError(
      `bond: settlement ${settlement} is before the dated date ${first.accrualStart}`,
    );
  }
  if (compareDates(settlement, last.accrualEnd) >= 0) {
    throw new RangeError(
      `bond: settlement ${settlement} is on or after maturity ${last.accrualEnd}`,
    );
  }
  for (const p of periods) {
    if (compareDates(settlement, p.accrualEnd) < 0) return p;
  }
  /* c8 ignore next 2 */
  throw new RangeError(`bond: no coupon period contains ${settlement}`);
}

/**
 * Cashflows still owed to the buyer: every flow whose **accrual end** is strictly after settlement.
 * A coupon dated exactly on the settlement date belongs to the seller.
 */
export function remainingCashflows(terms: BondTerms, settlement: IsoDate): Cashflow[] {
  return cashflows(terms).filter((c) => compareDates(c.date, settlement) > 0);
}

/**
 * Accrued interest at settlement (ANAL-01, TESTING §7.4). Exactly zero on a coupon date; on the day
 * before one it is the whole coupon less one day of it.
 *
 * Regular ICMA period: `coupon × days(periodStart → settlement) / periodDays`. Odd period: the ICMA
 * quasi-period sum, so accrual reaches exactly the odd coupon on the coupon date.
 */
export function accrued(terms: BondTerms, settlement: IsoDate): AccrualResult {
  const period = periodOf(terms, settlement);
  const convention = conventionOf(terms);
  const face = faceOf(terms);
  const yearFraction = yearFractionIn(terms, period, convention, period.accrualStart, settlement);

  // Reporting detail: the day count of the elapsed part, and of the quasi-period settlement is in.
  const containing = containingQuasiPeriod(period, settlement);
  const ctx: PeriodContext = {
    periodStart: containing.periodStart,
    periodEnd: containing.periodEnd,
    frequency: terms.frequency,
  };
  const elapsed = convention.measure(period.accrualStart, settlement, ctx);
  const whole = convention.measure(containing.periodStart, containing.periodEnd, ctx);

  return {
    accrued: face * terms.couponRate * yearFraction,
    period,
    days: elapsed.days,
    periodDays: whole.days,
    elapsedUnits: yearFraction * terms.frequency,
    yearFraction,
  };
}

/** The quasi-coupon period of `period` that contains `settlement` (the last one if beyond it). */
function containingQuasiPeriod(
  period: CouponPeriod,
  settlement: IsoDate,
): { periodStart: IsoDate; periodEnd: IsoDate } {
  const b = period.quasiBoundaries;
  for (let i = 0; i + 1 < b.length; i++) {
    const periodStart = b[i]!;
    const periodEnd = b[i + 1]!;
    if (compareDates(settlement, periodEnd) < 0) return { periodStart, periodEnd };
  }
  return {
    periodStart: b[b.length - 2]!,
    periodEnd: b[b.length - 1]!,
  };
}

/**
 * The part of the **current** coupon period still to run, in coupon-period units: 1 when settlement
 * is on a coupon date, → 0 the day before the next one. This is the `w` of the street price
 * formula, where the first cashflow is discounted `w` periods, the second `1 + w`, and so on. For
 * an odd period it can exceed 1 (a long first coupon), which is exactly right: the odd coupon is
 * more than one period away.
 */
export function periodFractionRemaining(terms: BondTerms, settlement: IsoDate): number {
  const period = periodOf(terms, settlement);
  const convention = conventionOf(terms);
  return yearFractionIn(terms, period, convention, settlement, period.accrualEnd) * terms.frequency;
}

/** Number of cashflows still outstanding at settlement. */
export function periodsRemaining(terms: BondTerms, settlement: IsoDate): number {
  return remainingCashflows(terms, settlement).length;
}

/** The coupon date immediately before (or on) `settlement` — the start of the current period. */
export function previousCouponDate(terms: BondTerms, settlement: IsoDate): IsoDate {
  return periodOf(terms, settlement).accrualStart;
}

/** The next coupon date strictly after `settlement`. */
export function nextCouponDate(terms: BondTerms, settlement: IsoDate): IsoDate {
  return periodOf(terms, settlement).accrualEnd;
}
