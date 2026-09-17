/**
 * `SIFMA` — the US fixed-income (bond market) calendar: the SIFMA recommended holiday schedule plus
 * the recommended early closes, rule-generated 1990-2040.
 *
 * **Holidays.** SIFMA follows the full US federal list (`usgovt.ts`) — including **Columbus Day and
 * Veterans Day, which the NYSE does not observe** — under *market* observance: a Saturday holiday
 * moves to the preceding Friday, a Sunday holiday to the following Monday, except New Year's Day,
 * which is not observed at all when 1 January falls on a Saturday.
 *
 * **Good Friday is a full closure on this calendar**, matching SIFMA's published recommendation for
 * a normal year. The shortened 12:00 ET session is the *exception* SIFMA recommends only in the
 * years when the Employment Situation report is released on Good Friday morning (2021 and 2023 were
 * such years; 2022, 2026 and 2027 are not), and a release calendar is not something this rule
 * generator has, so the default — the closure — is what it emits. That matters because SIFMA is the
 * calendar Treasury and SOFR OIS schedules roll on (WORKPLAN L507): every T+1/T+2 settlement and
 * every modified-following roll around Easter must skip Good Friday.
 *
 * Fedwire Securities *is* open that day. A caller that needs the wire-open behaviour rather than the
 * market-closed one asks `USGOVT` or `FX_USD`, neither of which observes Good Friday.
 *
 * **Recommended early closes** — 14:00 ET (`calendar_holidays.close_time`, DATA_MODEL L807):
 *   - the Friday before Memorial Day;
 *   - the last business day before the observed Independence Day (3 July in a normal year, 2 July
 *     when 4 July falls on a Saturday or Sunday);
 *   - the Friday after Thanksgiving;
 *   - the last business day before the observed Christmas Day;
 *   - the last business day of the year.
 */

import type { Calendar, CalendarHoliday, IsoDate } from './calendar.js';
import {
  MONDAY,
  addDays,
  formatIsoDate,
  goodFriday,
  isWeekendDay,
  lastWeekdayOfMonth,
  makeRuleCalendar,
  observed,
  registerCalendar,
  US_MARKET_OBSERVANCE,
  US_MARKET_OBSERVANCE_NO_SATURDAY,
  weekdaySessions,
} from './calendar.js';
import { usFederalHolidayDates } from './usgovt.js';

/** `calendar_holidays.close_time` on a SIFMA recommended early close. */
export const SIFMA_EARLY_CLOSE_TIME = '14:00';

/**
 * The shortened Good Friday session SIFMA recommends *instead of* the closure in the years when the
 * Employment Situation report is released that morning. The generator has no release calendar, so it
 * emits the normal-year closure; this constant records the exception's close time for a caller that
 * knows a given year is one of those years.
 */
export const SIFMA_GOOD_FRIDAY_CLOSE_TIME = '12:00';

/**
 * The observed SIFMA full closures of `year` — the federal list under market observance, plus Good
 * Friday, which SIFMA recommends closed but the federal list does not contain.
 */
export function sifmaClosures(year: number): CalendarHoliday[] {
  const out: CalendarHoliday[] = [];
  for (const h of usFederalHolidayDates(year)) {
    const rule =
      h.name === "New Year's Day" ? US_MARKET_OBSERVANCE_NO_SATURDAY : US_MARKET_OBSERVANCE;
    const day = h.fixed ? observed(h.day, rule) : h.day;
    if (day === undefined) continue;
    out.push({ day, name: h.name, kind: 'closed' });
  }
  out.push({ day: goodFriday(year), name: 'Good Friday', kind: 'closed' });
  return out;
}

/** Closure days of `year − 1 … year + 1`, for walking backwards over a holiday run. */
function closureSet(year: number): Set<IsoDate> {
  const set = new Set<IsoDate>();
  for (let y = year - 1; y <= year + 1; y++) {
    for (const h of sifmaClosures(y)) set.add(h.day);
  }
  return set;
}

/** The last business day strictly before `day`, using a pre-computed closure set. */
function previousOpenDay(day: IsoDate, closed: Set<IsoDate>): IsoDate {
  let d = addDays(day, -1);
  for (let i = 0; i < 20; i++) {
    if (!isWeekendDay(d) && !closed.has(d)) return d;
    d = addDays(d, -1);
  }
  throw new RangeError(`sifma: no open day within 20 days before ${day}`);
}

/** The SIFMA recommended early closes of `year`. */
export function sifmaEarlyCloses(year: number): CalendarHoliday[] {
  const closed = closureSet(year);
  const out: CalendarHoliday[] = [];
  const push = (day: IsoDate, name: string, closeTime = SIFMA_EARLY_CLOSE_TIME): void => {
    if (isWeekendDay(day) || closed.has(day)) return;
    out.push({ day, name, kind: 'early_close', closeTime });
  };

  // Good Friday is a closure, not an early close (see the module header), so it is not pushed here;
  // `push` would drop it anyway, since `closed` now contains it.

  // The Friday before Memorial Day (Memorial Day is always the last Monday of May).
  push(addDays(lastWeekdayOfMonth(year, 5, MONDAY), -3), 'Friday before Memorial Day');

  // The last business day before the observed Independence Day.
  const july4 = observed(formatIsoDate(year, 7, 4), US_MARKET_OBSERVANCE);
  if (july4 !== undefined) push(previousOpenDay(july4, closed), 'Day before Independence Day');

  // The Friday after Thanksgiving.
  const thanksgiving = usFederalHolidayDates(year).find((h) => h.name === 'Thanksgiving Day');
  if (thanksgiving !== undefined) push(addDays(thanksgiving.day, 1), 'Day after Thanksgiving');

  // The last business day before the observed Christmas Day.
  const christmas = observed(formatIsoDate(year, 12, 25), US_MARKET_OBSERVANCE);
  if (christmas !== undefined) push(previousOpenDay(christmas, closed), 'Christmas Eve');

  // The last business day of the year.
  let yearEnd = formatIsoDate(year, 12, 31);
  while (isWeekendDay(yearEnd) || closed.has(yearEnd)) yearEnd = addDays(yearEnd, -1);
  push(yearEnd, "New Year's Eve");

  return out;
}

/** Every SIFMA `calendar_holidays` row of `year`. */
export function sifmaHolidays(year: number): CalendarHoliday[] {
  return [...sifmaClosures(year), ...sifmaEarlyCloses(year)];
}

/**
 * `SIFMA` — US bond-market calendar, `kind = 'settlement'`, 08:00-17:00 ET (CONTRACTS L110).
 * This is the calendar Treasury and SOFR OIS schedules roll on (WORKPLAN L507).
 */
export const SIFMA: Calendar = registerCalendar(
  makeRuleCalendar({
    id: 'SIFMA',
    name: 'SIFMA US fixed income',
    tz: 'America/New_York',
    kind: 'settlement',
    rule: sifmaHolidays,
    sessions: weekdaySessions({ open: '08:00', close: '17:00' }),
  }),
);
