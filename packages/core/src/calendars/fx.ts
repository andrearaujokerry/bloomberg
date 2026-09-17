/**
 * `FX_USD` — the USD currency (settlement) calendar, and the FX spot-date rule.
 *
 * A currency calendar answers one question: can USD settle on this day? That is the Fedwire
 * schedule, which is the US federal holiday list (`usgovt.ts`) under federal observance — a
 * Saturday holiday *is* taken on the preceding Friday here, including New Year's Day, because
 * Fedwire is closed on 31 December when 1 January falls on a Saturday. Unlike the equity calendars,
 * `FX_USD` has no Good Friday closure: the dollar settles on Good Friday.
 *
 * **Spot rule.** FX spot is T+2 for almost every pair (T+1 for USDCAD, USDTRY, USDPHP, USDRUB —
 * `fx_terms.spot_lag`, CONTRACTS L100). The market convention this module implements:
 *
 *   1. count `lag` business days forward from the trade date on the **USD** calendar — a USD holiday
 *      inside the window extends the lag, because the dollar leg cannot settle then;
 *   2. then roll the candidate forward until it is a business day on **every** calendar involved
 *      (both currencies plus USD), which is exactly {@link combine}'s union of holidays.
 *
 * Step 1 is skipped for the USD leg of a non-USD cross only in the exotic conventions the terminal
 * does not carry, so it is applied unconditionally here.
 */

import type { Calendar, CalendarHoliday, IsoDate } from './calendar.js';
import {
  addBusinessDays,
  combine,
  makeRuleCalendar,
  nextBusinessDay,
  registerCalendar,
  weekdaySessions,
} from './calendar.js';
import { usFederalHolidays } from './usgovt.js';

/** The USD settlement holidays of `year` — the Fedwire schedule. */
export function usdSettlementHolidays(year: number): CalendarHoliday[] {
  return usFederalHolidays(year);
}

/**
 * `FX_USD` — USD settlement calendar, `kind = 'currency'` (CONTRACTS L110). FX trades around the
 * clock from the Sunday 17:00 ET open to the Friday 17:00 ET close, so the weekday session template
 * is a full day.
 */
export const FX_USD: Calendar = registerCalendar(
  makeRuleCalendar({
    id: 'FX_USD',
    name: 'US dollar settlement',
    tz: 'America/New_York',
    kind: 'currency',
    rule: usdSettlementHolidays,
    sessions: weekdaySessions({ open: '00:00', close: '24:00' }),
  }),
);

/** The default FX spot lag in business days. */
export const DEFAULT_FX_SPOT_LAG = 2;

/** Currency pairs that settle T+1 against the US dollar (`fx_terms.spot_lag`). */
export const T1_SPOT_CURRENCIES: readonly string[] = ['CAD', 'TRY', 'PHP', 'RUB'];

/** The spot lag for a pair, in business days. */
export function fxSpotLag(baseCcy: string, quoteCcy: string): number {
  const other = baseCcy === 'USD' ? quoteCcy : baseCcy;
  if (baseCcy === 'USD' || quoteCcy === 'USD') {
    return T1_SPOT_CURRENCIES.includes(other) ? 1 : DEFAULT_FX_SPOT_LAG;
  }
  return DEFAULT_FX_SPOT_LAG;
}

/** Inputs to {@link fxSpotDate}. */
export interface FxSpotSpec {
  /** Business days to count forward on the USD calendar. Defaults to 2. */
  readonly lag?: number;
  /** The USD calendar. Defaults to {@link FX_USD}. */
  readonly usd?: Calendar;
  /** Calendars of the two currency legs (omit for a USD-only trade). */
  readonly legs?: readonly Calendar[];
}

/**
 * The FX spot value date for a trade on `tradeDate`: `lag` USD business days forward, then rolled
 * forward to the first day that is a business day on every leg calendar as well.
 */
export function fxSpotDate(tradeDate: IsoDate, spec: FxSpotSpec = {}): IsoDate {
  const usd = spec.usd ?? FX_USD;
  const lag = spec.lag ?? DEFAULT_FX_SPOT_LAG;
  if (!Number.isInteger(lag) || lag < 0) {
    throw new RangeError(`fxSpotDate: lag must be a non-negative integer, got ${String(lag)}`);
  }
  const afterLag = addBusinessDays(usd, tradeDate, lag);
  const legs = spec.legs ?? [];
  if (legs.length === 0) return afterLag;
  const settlement = combine([usd, ...legs]);
  return settlement.isBusinessDay(afterLag) ? afterLag : nextBusinessDay(settlement, afterLag);
}
