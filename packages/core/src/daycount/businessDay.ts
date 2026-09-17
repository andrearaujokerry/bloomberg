/**
 * Business-day conventions — `following | modified_following | preceding | none`, the four values of
 * the `govt_terms.business_day_conv` CHECK (CONTRACTS L75, WORKPLAN L500).
 *
 * The roll itself is implemented once, in `calendars/calendar.ts`, because it is calendar
 * arithmetic; this module is the schedule-facing surface: the contract list, the guards, the
 * mapping from a stored `business_day_conv` string, and the schedule-level helpers that bond
 * cashflows (`analytics/bond/cashflows.ts`) and the SOFR OIS schedule (`analytics/swap/ois.ts`)
 * build on.
 */

import type { BusinessDayConvention, Calendar, IsoDate } from '../calendars/calendar.js';
import {
  BUSINESS_DAY_CONVENTIONS,
  addBusinessDays,
  adjust,
  endOfMonth,
  isBusinessDay,
  isBusinessDayConvention,
  isEndOfMonth,
  nextBusinessDay,
  previousBusinessDay,
} from '../calendars/calendar.js';

export type { BusinessDayConvention } from '../calendars/calendar.js';
export {
  BUSINESS_DAY_CONVENTIONS,
  addBusinessDays,
  adjust,
  isBusinessDay,
  isBusinessDayConvention,
  nextBusinessDay,
  previousBusinessDay,
};

/** The convention every US Treasury and SOFR OIS schedule rolls on. */
export const DEFAULT_BUSINESS_DAY_CONVENTION: BusinessDayConvention = 'modified_following';

/**
 * Resolve a stored `govt_terms.business_day_conv` value, falling back to
 * {@link DEFAULT_BUSINESS_DAY_CONVENTION} for `null`/`undefined` and throwing on anything outside
 * the CHECK list — a bad enum in the database is a bug, not a default.
 */
export function businessDayConvention(
  value: string | null | undefined,
  fallback: BusinessDayConvention = DEFAULT_BUSINESS_DAY_CONVENTION,
): BusinessDayConvention {
  if (value === null || value === undefined) return fallback;
  if (!isBusinessDayConvention(value)) {
    throw new RangeError(
      `businessDayConvention: ${JSON.stringify(value)} is not one of ${BUSINESS_DAY_CONVENTIONS.join(' | ')}`,
    );
  }
  return value;
}

/**
 * Roll a date under `bdc`, honouring the **end-of-month rule**: when `endOfMonthRule` is on and the
 * unadjusted date is the last day of its month, the result is the last *business* day of that
 * month. This is the rule that keeps a schedule anchored on month ends from drifting to the 30th.
 */
export function adjustDate(
  cal: Calendar,
  date: IsoDate,
  bdc: BusinessDayConvention,
  endOfMonthRule = false,
): IsoDate {
  if (endOfMonthRule && bdc !== 'none' && isEndOfMonth(date)) {
    return adjust(cal, endOfMonth(date), 'preceding');
  }
  return adjust(cal, date, bdc);
}

/** Roll every date of a schedule, preserving order. */
export function adjustSchedule(
  cal: Calendar,
  dates: readonly IsoDate[],
  bdc: BusinessDayConvention,
  endOfMonthRule = false,
): IsoDate[] {
  return dates.map((d) => adjustDate(cal, d, bdc, endOfMonthRule));
}

/**
 * The settlement date `settlementDays` business days after `tradeDate` — `govt_terms.settlement_days`
 * (T+1 for US Treasuries, T+2 for the SOFR OIS start).
 */
export function settlementDate(
  cal: Calendar,
  tradeDate: IsoDate,
  settlementDays: number,
): IsoDate {
  return addBusinessDays(cal, tradeDate, settlementDays);
}
