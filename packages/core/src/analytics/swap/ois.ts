/**
 * `swap/ois.ts` — the SOFR OIS swap engine (WORKPLAN L507-508, ARCHITECTURE L166-167).
 *
 * > SOFR OIS: annual fixed vs daily-compounded float, ACT/360, T+2, modified following, SIFMA;
 * > PV, par rate, DV01, annuity (SWPM).
 *
 * This is the analytic behind the SWPM screen: hand it a discount curve and a set of terms and it
 * returns both legs' cashflows, the net present value, the fixed rate that would make that value
 * zero, the annuity those two are related by, and the two DV01s a swap desk quotes.
 *
 * **Conventions, all four of them from L507.**
 *
 *  - *ACT/360* — every accrual and every point on the discount-curve time axis is
 *    `actual days / 360`, the money-market convention SOFR itself is published on.
 *  - *T+2* — the swap starts on the second **SIFMA** business day after the curve date, exactly the
 *    spot rule the OIS bootstrap uses, so a swap priced here on a curve built by
 *    `curve/bootstrap.ts` reprices that curve's own quotes to their quoted par rate.
 *  - *modified following* — each annual roll date is the unadjusted anniversary of the effective
 *    date rolled forward to the next business day, unless that would leave the month, in which case
 *    it rolls backwards instead.
 *  - *SIFMA* — the US bond-market calendar. `2027-12-24` is Christmas Day observed and therefore
 *    **not** a business day, so the first anniversary of a swap starting 2026-12-24 pays on
 *    2027-12-27 (`test/analytics/swap/ois.test.ts` pins that roll).
 *
 * **The float leg is compounded daily, for real.** The market convention is that each annual float
 * period pays `Π(1 + r_d·τ_d) − 1`, the product running over the business days of the period, with
 * a weekend or holiday rate accruing over the whole `τ_d` until the next business day. This module
 * builds that product day by day out of the curve's implied overnight forwards
 * `r_d = (df(d)/df(d⁺) − 1)/τ_d`, rather than jumping straight to the telescoped closed form
 * `df(start)/df(end)`. The two agree to floating-point rounding — the test asserts they do — but
 * computing the product is what makes the per-day `observations` count, the compounded rate and the
 * cashflow table on a SWPM blotter real numbers rather than a caption.
 *
 * **Sign convention.** `payReceive: 'pay'` is a payer swap — pay fixed, receive float — so its PV is
 * `floatLegPv − fixedLegPv` and it gains when rates rise. `'receive'` negates the whole thing.
 * `dv01` is always reported as the positive magnitude `notional · annuity · 1bp`, the SWPM number;
 * `curveDv01` is signed, because a parallel curve shift moves a payer and a receiver in opposite
 * directions.
 *
 * Purity: no `Date`, no clock, no IO (ARCHITECTURE L49). Every date is an ISO `'YYYY-MM-DD'`
 * string and the valuation instant arrives as `defineEngine`'s `valuationTs`.
 */

import type { Calendar, IsoDate } from '../../calendars/calendar.js';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  getCalendar,
  minDate,
} from '../../calendars/calendar.js';
import { SIFMA } from '../../calendars/sifma.js';
import { parseTenor, tenorInMonths } from '../../calendars/tenor.js';
import type { BusinessDayConvention } from '../../daycount/businessDay.js';
import {
  adjustDate,
  businessDayConvention,
  nextBusinessDay,
  settlementDate,
} from '../../daycount/businessDay.js';
import type { Curve } from '../curve/curve.js';
import { makeCurve } from '../curve/curve.js';
import type { DfPoint } from '../curve/interp.js';
import { interpolationName } from '../curve/interp.js';
import type { Conventions, InterpolationName } from '../engine.js';
import { defineEngine } from '../engine.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Defaults — WORKPLAN L507's conventions, in one place
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Fixed-leg payments per year: annual. */
export const OIS_FIXED_FREQUENCY = 1;
/** Business days from the curve date to the effective date: T+2. */
export const OIS_SETTLEMENT_DAYS = 2;
/** The roll convention every date of the schedule is adjusted under. */
export const OIS_BUSINESS_DAY_CONVENTION: BusinessDayConvention = 'modified_following';
/** The `calendars.calendar_id` the schedule rolls on. */
export const OIS_CALENDAR_ID = 'SIFMA';
/** The ACT/360 denominator both legs accrue on. */
export const OIS_DAY_COUNT_BASIS = 360;
/** Default notional when the caller does not state one — SWPM's own default ticket size. */
export const OIS_DEFAULT_NOTIONAL = 10_000_000;
/** One basis point, as a decimal rate. */
export const ONE_BASIS_POINT = 1e-4;

/** Which side of the fixed leg the position is on. */
export type PayReceive = 'pay' | 'receive';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Schedule
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The rolling rules a schedule is generated under. */
export interface OisSwapConventions {
  /** Fixed-leg payments per year. The float leg shares these periods (USD SOFR OIS convention). */
  readonly fixedFrequency: number;
  /** Business days from the curve date to the effective date. */
  readonly settlementDays: number;
  readonly businessDayConvention: BusinessDayConvention;
  readonly calendar: Calendar;
  /** Business days between a period end and its payment. 0 by default; 2 on a lagged ticket. */
  readonly paymentLagDays: number;
}

/** One accrual period — one fixed payment and, over the same dates, one float payment. */
export interface OisSwapPeriod {
  /** 1-based period number. */
  readonly index: number;
  /** Adjusted start of the accrual period (the effective date for the first one). */
  readonly accrualStart: IsoDate;
  /** Adjusted end of the accrual period. */
  readonly accrualEnd: IsoDate;
  /** The anniversary before adjustment — what `accrualEnd` would be under `none`. */
  readonly unadjustedEnd: IsoDate;
  /** `accrualEnd` rolled on by `paymentLagDays` business days. Equal to `accrualEnd` when the lag is 0. */
  readonly paymentDate: IsoDate;
  /** Actual days in `[accrualStart, accrualEnd)`. */
  readonly days: number;
  /** `days / 360`. */
  readonly accrual: number;
  /** ACT/360 year fraction from the curve date to `paymentDate` — the discounting time. */
  readonly t: number;
}

/** A generated OIS schedule. */
export interface OisSwapSchedule {
  /** The curve date the time axis is measured from. */
  readonly curveDate: IsoDate;
  /** T+2 spot, or the caller's explicit override. */
  readonly effectiveDate: IsoDate;
  /** The last period's adjusted end. */
  readonly maturityDate: IsoDate;
  /** ACT/360 year fraction from the curve date to the effective date. */
  readonly effectiveTime: number;
  /** ACT/360 year fraction from the curve date to the maturity date. */
  readonly maturityTime: number;
  readonly periods: readonly OisSwapPeriod[];
  readonly conventions: OisSwapConventions;
}

/** How the schedule's end is specified: a tenor from the effective date, or an explicit maturity. */
export interface OisSwapTerm {
  /** `'1Y'`, `'18M'`, `'10Y'` — a whole number of fixed periods. */
  readonly tenor?: string;
  /** An explicit unadjusted maturity, used in preference to `tenor` when both are given. */
  readonly maturityDate?: IsoDate;
  /** An explicit effective date; T+2 spot from the curve date when omitted. */
  readonly effectiveDate?: IsoDate;
}

/** ACT/360 year fraction — the one day-count this engine uses, inlined to keep it obvious. */
function act360(from: IsoDate, to: IsoDate): number {
  return daysBetween(from, to) / OIS_DAY_COUNT_BASIS;
}

/**
 * Resolve a calendar id to a calendar. `SIFMA` is answered without touching the registry so the
 * default path works whether or not the caller has imported the calendar modules.
 */
function resolveCalendar(id: string | undefined): Calendar {
  if (id === undefined || id === SIFMA.id) return SIFMA;
  return getCalendar(id);
}

/**
 * Generate the schedule of a SOFR OIS.
 *
 * Roll dates are the unadjusted `k × 12/frequency`-month anniversaries of the effective date, each
 * adjusted under the business-day convention; an accrual period runs from one *adjusted* date to
 * the next, which is what makes the fixed leg of a swap priced here identical to the fixed leg the
 * OIS bootstrap solved its nodes against.
 */
export function oisSwapSchedule(
  curveDate: IsoDate,
  term: OisSwapTerm,
  conventions: OisSwapConventions,
): OisSwapSchedule {
  const { fixedFrequency, calendar, businessDayConvention: bdc, paymentLagDays } = conventions;
  if (!Number.isInteger(fixedFrequency) || fixedFrequency < 1 || 12 % fixedFrequency !== 0) {
    throw new RangeError(
      `oisSwapSchedule: fixedFrequency must be a whole number of months per period, got ${String(fixedFrequency)}`,
    );
  }
  if (!Number.isInteger(paymentLagDays) || paymentLagDays < 0) {
    throw new RangeError(`oisSwapSchedule: paymentLagDays must be ≥ 0, got ${String(paymentLagDays)}`);
  }
  const monthsPerPeriod = 12 / fixedFrequency;

  const effectiveDate =
    term.effectiveDate ?? settlementDate(calendar, curveDate, conventions.settlementDays);
  if (compareDates(effectiveDate, curveDate) < 0) {
    throw new RangeError(
      `oisSwapSchedule: effectiveDate ${effectiveDate} is before the curve date ${curveDate}; ` +
        'this engine values spot- and forward-starting swaps, a swap already accruing needs its ' +
        'published fixings and is not in scope (WORKPLAN L507)',
    );
  }

  // How many periods, and what unadjusted anniversary ends each of them.
  const unadjustedEnds: IsoDate[] = [];
  if (term.maturityDate !== undefined) {
    const months = monthsBetweenSchedule(effectiveDate, term.maturityDate, monthsPerPeriod);
    for (let k = 1; k <= months / monthsPerPeriod; k += 1) {
      unadjustedEnds.push(addMonths(effectiveDate, k * monthsPerPeriod));
    }
    // The last roll is the caller's own maturity, even when the day-of-month was clamped on the way.
    unadjustedEnds[unadjustedEnds.length - 1] = term.maturityDate;
  } else {
    if (term.tenor === undefined) {
      throw new RangeError('oisSwapSchedule: one of tenor or maturityDate is required');
    }
    const months = tenorInMonths(parseTenor(term.tenor));
    if (months <= 0 || months % monthsPerPeriod !== 0) {
      throw new RangeError(
        `oisSwapSchedule: ${term.tenor} is not a whole number of ` +
          `${String(fixedFrequency)}/yr fixed periods`,
      );
    }
    for (let k = 1; k <= months / monthsPerPeriod; k += 1) {
      unadjustedEnds.push(addMonths(effectiveDate, k * monthsPerPeriod));
    }
  }

  const periods: OisSwapPeriod[] = [];
  let accrualStart = effectiveDate;
  for (let i = 0; i < unadjustedEnds.length; i += 1) {
    const unadjustedEnd = unadjustedEnds[i];
    if (unadjustedEnd === undefined) throw new RangeError('oisSwapSchedule: missing roll date');
    const accrualEnd = adjustDate(calendar, unadjustedEnd, bdc);
    if (compareDates(accrualEnd, accrualStart) <= 0) {
      throw new RangeError(
        `oisSwapSchedule: period ${String(i + 1)} ends ${accrualEnd} on or before it starts ${accrualStart}`,
      );
    }
    const paymentDate =
      paymentLagDays === 0 ? accrualEnd : businessDaysAfter(calendar, accrualEnd, paymentLagDays);
    const days = daysBetween(accrualStart, accrualEnd);
    periods.push({
      index: i + 1,
      accrualStart,
      accrualEnd,
      unadjustedEnd,
      paymentDate,
      days,
      accrual: days / OIS_DAY_COUNT_BASIS,
      t: act360(curveDate, paymentDate),
    });
    accrualStart = accrualEnd;
  }

  const last = periods[periods.length - 1];
  if (last === undefined) throw new RangeError('oisSwapSchedule: the schedule has no periods');

  return Object.freeze({
    curveDate,
    effectiveDate,
    maturityDate: last.accrualEnd,
    effectiveTime: act360(curveDate, effectiveDate),
    maturityTime: act360(curveDate, last.accrualEnd),
    periods: Object.freeze(periods),
    conventions,
  });
}

/** `n` business days strictly after `date` (the payment lag). */
function businessDaysAfter(cal: Calendar, date: IsoDate, n: number): IsoDate {
  let d = date;
  for (let i = 0; i < n; i += 1) d = nextBusinessDay(cal, d);
  return d;
}

/** Whole months from `start` to `maturity`, checked to be a whole number of periods. */
function monthsBetweenSchedule(
  start: IsoDate,
  maturity: IsoDate,
  monthsPerPeriod: number,
): number {
  if (compareDates(maturity, start) <= 0) {
    throw new RangeError(`oisSwapSchedule: maturityDate ${maturity} is not after ${start}`);
  }
  // Walk forward in whole periods until the anniversary reaches or passes the requested maturity.
  for (let k = 1; k <= 1200; k += 1) {
    const months = k * monthsPerPeriod;
    const anniversary = addMonths(start, months);
    if (compareDates(anniversary, maturity) >= 0) {
      if (daysBetween(anniversary, maturity) !== 0 && !sameMonth(anniversary, maturity)) {
        throw new RangeError(
          `oisSwapSchedule: maturityDate ${maturity} is not a whole number of periods after ${start}`,
        );
      }
      return months;
    }
  }
  throw new RangeError(`oisSwapSchedule: maturityDate ${maturity} is implausibly far from ${start}`);
}

function sameMonth(a: IsoDate, b: IsoDate): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Daily compounding
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One business day's overnight observation inside a float period. */
export interface OisOvernightObservation {
  /** The business day the rate is observed on. */
  readonly date: IsoDate;
  /** The next business day — the end of the rate's accrual (clamped to the period end). */
  readonly endDate: IsoDate;
  /** Calendar days the observation covers: 1 midweek, 3 over a weekend, more over a holiday. */
  readonly days: number;
  /** The curve's implied overnight simple rate, decimal per annum ACT/360. */
  readonly rate: number;
}

/** The result of compounding a period's overnight rates. */
export interface OisCompoundedRate {
  /** `Π(1 + r_d·τ_d)` over the period's business days. */
  readonly factor: number;
  /** `(factor − 1) / accrual`, decimal per annum ACT/360 — what the float leg pays. */
  readonly rate: number;
  /** How many business-day observations went into the product. */
  readonly observations: number;
}

/**
 * Compound the curve's implied overnight forwards across `[start, end)`.
 *
 * Each business day `d` accrues at the simple rate implied by the discount curve over `[d, d⁺]`,
 * where `d⁺` is the next business day: `r_d = (df(d)/df(d⁺) − 1)/τ_d` with `τ_d = ACT/360`. The
 * product of `(1 + r_d·τ_d)` therefore telescopes to `df(start)/df(end)` — but it is evaluated as a
 * product, because that is the contractual calculation and it is what puts a real observation count
 * on the cashflow.
 */
export function compoundedOvernightRate(
  curve: Curve,
  calendar: Calendar,
  curveDate: IsoDate,
  start: IsoDate,
  end: IsoDate,
  collect?: OisOvernightObservation[],
): OisCompoundedRate {
  if (compareDates(end, start) <= 0) {
    throw new RangeError(`compoundedOvernightRate: ${end} is not after ${start}`);
  }
  let factor = 1;
  let observations = 0;
  let d = start;
  while (compareDates(d, end) < 0) {
    const next = minDate(calendar.isBusinessDay(d) ? nextBusinessDay(calendar, d) : addDays(d, 1), end);
    const days = daysBetween(d, next);
    const tau = days / OIS_DAY_COUNT_BASIS;
    const growth = curve.df(act360(curveDate, d)) / curve.df(act360(curveDate, next));
    const rate = (growth - 1) / tau;
    factor *= growth;
    observations += 1;
    if (collect !== undefined) collect.push({ date: d, endDate: next, days, rate });
    d = next;
  }
  const accrual = act360(start, end);
  return { factor, rate: (factor - 1) / accrual, observations };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cashflows and valuation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One fixed-leg payment, as SWPM renders a row of it. */
export interface OisFixedCashflow {
  readonly index: number;
  readonly accrualStart: IsoDate;
  readonly accrualEnd: IsoDate;
  readonly paymentDate: IsoDate;
  readonly days: number;
  readonly accrual: number;
  /** Discount factor applied to `amount`. */
  readonly df: number;
  /** `notional · fixedRate · accrual`, in currency units. */
  readonly amount: number;
  readonly pv: number;
}

/** One float-leg payment: the daily-compounded SOFR of the period. */
export interface OisFloatCashflow {
  readonly index: number;
  readonly accrualStart: IsoDate;
  readonly accrualEnd: IsoDate;
  readonly paymentDate: IsoDate;
  readonly days: number;
  readonly accrual: number;
  /** Business-day observations compounded into `rate`. */
  readonly observations: number;
  /** The compounded rate, decimal per annum ACT/360. */
  readonly rate: number;
  readonly df: number;
  /** `notional · (Π(1 + r·τ) − 1)`, in currency units. */
  readonly amount: number;
  readonly pv: number;
}

/** What the swap is worth, and everything SWPM shows next to it. */
export interface OisSwapValue {
  readonly effectiveDate: IsoDate;
  readonly maturityDate: IsoDate;
  readonly notional: number;
  readonly payReceive: PayReceive;
  /** The contract's fixed rate, echoed back in **percent**. */
  readonly fixedRate: number;
  /** Net present value in currency units, signed by `payReceive`. */
  readonly pv: number;
  /** PV of the fixed leg (always the positive leg value, unsigned by direction). */
  readonly fixedLegPv: number;
  /** PV of the daily-compounded float leg. */
  readonly floatLegPv: number;
  /** `Σ τᵢ·df(tᵢ)` per unit of notional — the fixed-leg annuity (SWPM's "Annuity"). */
  readonly annuity: number;
  /** The fixed rate that makes `pv` zero, in **percent**. */
  readonly parRate: number;
  /** `notional · annuity · 1bp`: the PV change per basis point on the fixed rate. Positive. */
  readonly dv01: number;
  /** PV change for a +1bp parallel shift of the curve's continuous zero rates. Signed. */
  readonly curveDv01: number;
  readonly fixedLeg: readonly OisFixedCashflow[];
  readonly floatLeg: readonly OisFloatCashflow[];
  readonly conventions: Conventions;
}

/** The economics of the ticket, alongside the schedule. */
export interface OisSwapTicket {
  /** Fixed rate in **percent** (`3.75` is 3.75 %). */
  readonly fixedRate: number;
  readonly notional?: number;
  readonly payReceive?: PayReceive;
}

function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`swap.ois: ${what} must be finite, got ${String(value)}`);
  return value;
}

/**
 * Value a SOFR OIS on `curve`.
 *
 * Exported separately from the engine so a caller that already holds a bootstrapped `Curve` — the
 * bootstrap's own self-consistency check, WIRP, a portfolio reprice — can value a swap without
 * round-tripping the curve through a node array.
 */
export function valueOisSwap(
  curve: Curve,
  schedule: OisSwapSchedule,
  ticket: OisSwapTicket,
): OisSwapValue {
  const notional = requireFinite(ticket.notional ?? OIS_DEFAULT_NOTIONAL, 'notional');
  const payReceive = ticket.payReceive ?? 'pay';
  if (payReceive !== 'pay' && payReceive !== 'receive') {
    throw new RangeError(`swap.ois: payReceive must be 'pay' or 'receive', got ${String(payReceive)}`);
  }
  const fixedRate = requireFinite(ticket.fixedRate, 'fixedRate') / 100;
  const direction = payReceive === 'pay' ? 1 : -1;
  const { calendar } = schedule.conventions;
  const { curveDate } = schedule;

  const fixedLeg: OisFixedCashflow[] = [];
  const floatLeg: OisFloatCashflow[] = [];
  let annuity = 0;
  let fixedLegPv = 0;
  let floatLegPv = 0;
  // d(PV of the payer swap)/ds under df(t) → df(t)·e^{−s·t}; see `curveDv01` below.
  let dFloat = 0;
  let dFixedPerRate = 0;

  for (const period of schedule.periods) {
    const df = curve.df(period.t);
    annuity += period.accrual * df;

    const fixedAmount = notional * fixedRate * period.accrual;
    const fixedPv = fixedAmount * df;
    fixedLegPv += fixedPv;
    fixedLeg.push({
      index: period.index,
      accrualStart: period.accrualStart,
      accrualEnd: period.accrualEnd,
      paymentDate: period.paymentDate,
      days: period.days,
      accrual: period.accrual,
      df,
      amount: fixedAmount,
      pv: fixedPv,
    });

    const compounded = compoundedOvernightRate(
      curve,
      calendar,
      curveDate,
      period.accrualStart,
      period.accrualEnd,
    );
    const floatAmount = notional * (compounded.factor - 1);
    const floatPv = floatAmount * df;
    floatLegPv += floatPv;
    floatLeg.push({
      index: period.index,
      accrualStart: period.accrualStart,
      accrualEnd: period.accrualEnd,
      paymentDate: period.paymentDate,
      days: period.days,
      accrual: period.accrual,
      observations: compounded.observations,
      rate: compounded.rate,
      df,
      amount: floatAmount,
      pv: floatPv,
    });

    // Analytic parallel-shift derivatives. Writing a = t(accrualStart), b = t(accrualEnd),
    // p = t(paymentDate) and G = df(a)/df(b):
    //   float term  = N·(G − 1)·df(p)  →  d/ds = N·[ −(a − b)·G·df(p) − p·(G − 1)·df(p) ]
    //   fixed term  = N·R·τ·df(p)      →  d/ds = −p·N·R·τ·df(p)
    // With no payment lag (p = b) the float sum telescopes to N·[b·df(b) − a·df(a)], the textbook
    // result; the general form above keeps a lagged payment honest.
    const a = act360(curveDate, period.accrualStart);
    const b = act360(curveDate, period.accrualEnd);
    const p = period.t;
    const growth = compounded.factor;
    dFloat += notional * (-(a - b) * growth * df - p * (growth - 1) * df);
    dFixedPerRate += -p * notional * period.accrual * df;
  }

  const pv = direction * (floatLegPv - fixedLegPv);
  if (annuity <= 0) throw new RangeError('swap.ois: non-positive annuity — the schedule is degenerate');
  const parRate = (floatLegPv / (notional * annuity)) * 100;
  const dv01 = notional * annuity * ONE_BASIS_POINT;
  const curveDv01 = direction * (dFloat - fixedRate * dFixedPerRate) * ONE_BASIS_POINT;

  const conventions: Conventions = Object.freeze({
    dayCount: 'ACT/360',
    businessDayConvention: schedule.conventions.businessDayConvention,
    calendar: calendar.id,
    frequency: schedule.conventions.fixedFrequency,
    settlementDays: schedule.conventions.settlementDays,
    compounding: 'simple',
    floatCompounding: 'daily',
    paymentLagDays: schedule.conventions.paymentLagDays,
    currency: 'USD',
    index: 'SOFR',
    interpolation: curve.interpolation,
  });

  return {
    effectiveDate: schedule.effectiveDate,
    maturityDate: schedule.maturityDate,
    notional,
    payReceive,
    fixedRate: ticket.fixedRate,
    pv,
    fixedLegPv,
    floatLegPv,
    annuity,
    parRate,
    dv01,
    curveDv01,
    fixedLeg: Object.freeze(fixedLeg),
    floatLeg: Object.freeze(floatLeg),
    conventions,
  };
}

/** The par rate of `schedule` on `curve`, in **percent** — `valueOisSwap` without the ticket. */
export function oisSwapParRate(curve: Curve, schedule: OisSwapSchedule): number {
  return valueOisSwap(curve, schedule, { fixedRate: 0, notional: 1 }).parRate;
}

/** The annuity `Σ τᵢ·df(tᵢ)` of `schedule` on `curve`, per unit of notional. */
export function oisSwapAnnuity(curve: Curve, schedule: OisSwapSchedule): number {
  let annuity = 0;
  for (const period of schedule.periods) annuity += period.accrual * curve.df(period.t);
  return annuity;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The discount curve, as data: exactly what `curve_builds.nodes` carries, minus the derived keys. */
export interface OisSwapCurveInput {
  /** `curves.curve_id`; `'SOFR_OIS'` by default. */
  readonly curveId?: string;
  /** `curves.default_interpolation`; `'log_linear_df'` by default. */
  readonly interpolation?: InterpolationName;
  /** Knots `{t, df}` ascending in `t`, with `t` on the ACT/360 axis measured from `curveDate`. */
  readonly points: readonly DfPoint[];
}

/** `swap.ois` inputs — a plain JSON record, so a golden case is literally these keys (§7.1). */
export interface OisSwapInputs {
  /** The discounting anchor: `curve_builds.curve_date`, and the date T+2 spot is counted from. */
  readonly curveDate: IsoDate;
  readonly curve: OisSwapCurveInput;
  /** `'5Y'` — a whole number of fixed periods. Ignored when `maturityDate` is given. */
  readonly tenor?: string;
  /** An explicit maturity instead of a tenor. */
  readonly maturityDate?: IsoDate;
  /** An explicit effective date instead of T+2 spot. */
  readonly effectiveDate?: IsoDate;
  /** The contract fixed rate in **percent**. */
  readonly fixedRate: number;
  /** Notional in currency units; 10,000,000 by default. */
  readonly notional?: number;
  /** `'pay'` (pay fixed) by default. */
  readonly payReceive?: PayReceive;
  /** Fixed payments per year; annual by default (WORKPLAN L507). */
  readonly fixedFrequency?: number;
  /** Business days to spot; 2 by default. */
  readonly settlementDays?: number;
  /** `govt_terms.business_day_conv`; modified following by default. */
  readonly businessDayConvention?: BusinessDayConvention;
  /** Settlement calendar id; `'SIFMA'` by default. */
  readonly calendar?: string;
  /** Business days between a period end and its payment; 0 by default. */
  readonly paymentLagDays?: number;
  readonly [key: string]: unknown;
}

/** `swap.ois` outputs: the value, plus the schedule that produced it. */
export interface OisSwapOutputs extends OisSwapValue {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  readonly schedule: OisSwapSchedule;
}

/**
 * Resolve the schedule conventions of an input record, applying WORKPLAN L507's defaults.
 * Exported because a test and the SWPM screen both want the resolved set, not the raw optionals.
 */
export function oisSwapConventionsOf(
  inputs: Pick<
    OisSwapInputs,
    'fixedFrequency' | 'settlementDays' | 'businessDayConvention' | 'calendar' | 'paymentLagDays'
  >,
): OisSwapConventions {
  return {
    fixedFrequency: inputs.fixedFrequency ?? OIS_FIXED_FREQUENCY,
    settlementDays: inputs.settlementDays ?? OIS_SETTLEMENT_DAYS,
    businessDayConvention: businessDayConvention(
      inputs.businessDayConvention ?? OIS_BUSINESS_DAY_CONVENTION,
    ),
    calendar: resolveCalendar(inputs.calendar),
    paymentLagDays: inputs.paymentLagDays ?? 0,
  };
}

/**
 * `swap.ois` — the SWPM engine (WORKPLAN L507-508, L542).
 *
 * Inputs are JSON: the curve arrives as its `{t, df}` knots so a golden case is a literal file and
 * `inputsHash` covers the curve that was used, node for node (ANAL-08).
 */
export const oisSwapEngine = defineEngine<OisSwapInputs, OisSwapOutputs>(
  'swap.ois',
  '1.0.0',
  (inputs) => {
    const conventions = oisSwapConventionsOf(inputs);
    const curveId = inputs.curve.curveId ?? 'SOFR_OIS';
    const curve = makeCurve({
      curveId,
      curveDate: inputs.curveDate,
      dayCount: 'ACT/360',
      compounding: 'continuous',
      interpolation: interpolationName(inputs.curve.interpolation),
      points: inputs.curve.points,
    });
    const term: OisSwapTerm = {
      ...(inputs.tenor === undefined ? {} : { tenor: inputs.tenor }),
      ...(inputs.maturityDate === undefined ? {} : { maturityDate: inputs.maturityDate }),
      ...(inputs.effectiveDate === undefined ? {} : { effectiveDate: inputs.effectiveDate }),
    };
    const schedule = oisSwapSchedule(inputs.curveDate, term, conventions);
    const value = valueOisSwap(curve, schedule, {
      fixedRate: inputs.fixedRate,
      ...(inputs.notional === undefined ? {} : { notional: inputs.notional }),
      ...(inputs.payReceive === undefined ? {} : { payReceive: inputs.payReceive }),
    });
    return { ...value, curveId, curveDate: inputs.curveDate, schedule };
  },
);
