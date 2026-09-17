/**
 * `XNYS`, `XNAS`, `XCBO` — the US equity and equity-option trading calendars, rule-generated
 * 1990-2040 (WORKPLAN L493-497). The three venues have shared a holiday and early-close schedule
 * throughout the covered window, so one rule generates all three; they differ only in identity and
 * in the session template (`calendar_sessions`).
 *
 * **Holidays** (NYSE Rule 7.2): New Year's Day, Martin Luther King Jr. Day, Washington's Birthday,
 * Good Friday, Memorial Day, Juneteenth (**2022 onwards only**), Independence Day, Labor Day,
 * Thanksgiving Day, Christmas Day. The exchange does *not* observe Columbus Day or Veterans Day —
 * that is the difference from `USGOVT` and `SIFMA`.
 *
 * **Observance**: a holiday on a Saturday is taken on the preceding Friday, one on a Sunday on the
 * following Monday — *except* New Year's Day, which is simply not observed when 1 January falls on
 * a Saturday (31 December 2021 and 31 December 2010 were full trading days).
 *
 * **Early closes** — 13:00 ET (`calendar_holidays.close_time`), three rules:
 *   1. the Friday after Thanksgiving, from 1992 onwards
 *      ({@link THANKSGIVING_EARLY_CLOSE_FIRST_YEAR}). The exchange traded a full session on the day
 *      after Thanksgiving before then — 1990-11-23 and 1991-11-29 were full days;
 *   2. 3 July, when both 3 and 4 July are weekdays (so 4 July falls Tue-Fri). When 4 July is a
 *      Saturday, 3 July is the observed *closure*, not an early close; when it is a Sunday or a
 *      Monday, 3 July is a weekend day and no session is shortened;
 *   3. 24 December, when it falls Monday-Thursday. A Friday 24 December is the observed Christmas
 *      closure and is filtered out by rule 1 of {@link makeRuleCalendar} (a `closed` day always
 *      beats an `early_close` on the same date).
 *
 * **Unscheduled closures** 1990-2040 are a short literal table ({@link NYSE_AD_HOC_CLOSURES}); they
 * are historical fact, not a rule, and the only non-derivable rows in the generator.
 */

import type { Calendar, CalendarHoliday, IsoDate } from './calendar.js';
import {
  FRIDAY,
  MONDAY,
  SATURDAY,
  SUNDAY,
  THURSDAY,
  US_MARKET_OBSERVANCE,
  US_MARKET_OBSERVANCE_NO_SATURDAY,
  addDays,
  dayOfWeek,
  formatIsoDate,
  goodFriday,
  lastWeekdayOfMonth,
  makeRuleCalendar,
  nthWeekdayOfMonth,
  observed,
  registerCalendar,
  weekdaySessions,
} from './calendar.js';
import { JUNETEENTH_FIRST_YEAR, MLK_FIRST_YEAR } from './usgovt.js';

/** `calendar_holidays.close_time` on every NYSE/Nasdaq/Cboe early close (DATA_MODEL L807). */
export const NYSE_EARLY_CLOSE_TIME = '13:00';

/**
 * First year the NYSE closed early on the Friday after Thanksgiving. The 13:00 half-session began in
 * 1992; 1990-11-23 and 1991-11-29 were full trading days, so the rule must be gated the same way
 * {@link MLK_FIRST_YEAR} and {@link JUNETEENTH_FIRST_YEAR} gate their holidays.
 */
export const THANKSGIVING_EARLY_CLOSE_FIRST_YEAR = 1992;

/**
 * Unscheduled full-day closures on the US equity markets inside the 1990-2040 window. Not derivable
 * from any rule — funerals, two storms and the 2001 attacks.
 */
export const NYSE_AD_HOC_CLOSURES: readonly CalendarHoliday[] = [
  { day: '1994-04-27', name: 'Funeral of Richard Nixon', kind: 'closed' },
  { day: '1996-01-08', name: "Blizzard of '96", kind: 'closed' },
  { day: '2001-09-11', name: 'September 11 attacks', kind: 'closed' },
  { day: '2001-09-12', name: 'September 11 attacks', kind: 'closed' },
  { day: '2001-09-13', name: 'September 11 attacks', kind: 'closed' },
  { day: '2001-09-14', name: 'September 11 attacks', kind: 'closed' },
  { day: '2004-06-11', name: 'Funeral of Ronald Reagan', kind: 'closed' },
  { day: '2007-01-02', name: 'Funeral of Gerald Ford', kind: 'closed' },
  { day: '2012-10-29', name: 'Hurricane Sandy', kind: 'closed' },
  { day: '2012-10-30', name: 'Hurricane Sandy', kind: 'closed' },
  { day: '2018-12-05', name: 'Funeral of George H. W. Bush', kind: 'closed' },
  { day: '2025-01-09', name: 'Funeral of Jimmy Carter', kind: 'closed' },
];

/** The observed NYSE full closures of `year`. */
export function nyseClosures(year: number): CalendarHoliday[] {
  const out: CalendarHoliday[] = [];
  const push = (day: IsoDate | undefined, name: string): void => {
    if (day !== undefined) out.push({ day, name, kind: 'closed' });
  };

  // New Year's Day: the one holiday with no Saturday observance.
  push(observed(formatIsoDate(year, 1, 1), US_MARKET_OBSERVANCE_NO_SATURDAY), "New Year's Day");
  if (year >= MLK_FIRST_YEAR) {
    push(nthWeekdayOfMonth(year, 1, MONDAY, 3), 'Martin Luther King, Jr. Day');
  }
  push(nthWeekdayOfMonth(year, 2, MONDAY, 3), "Washington's Birthday");
  push(goodFriday(year), 'Good Friday');
  push(lastWeekdayOfMonth(year, 5, MONDAY), 'Memorial Day');
  if (year >= JUNETEENTH_FIRST_YEAR) {
    push(observed(formatIsoDate(year, 6, 19), US_MARKET_OBSERVANCE), 'Juneteenth');
  }
  push(observed(formatIsoDate(year, 7, 4), US_MARKET_OBSERVANCE), 'Independence Day');
  push(nthWeekdayOfMonth(year, 9, MONDAY, 1), 'Labor Day');
  push(nthWeekdayOfMonth(year, 11, THURSDAY, 4), 'Thanksgiving Day');
  push(observed(formatIsoDate(year, 12, 25), US_MARKET_OBSERVANCE), 'Christmas Day');

  for (const c of NYSE_AD_HOC_CLOSURES) {
    if (c.day.startsWith(`${String(year)}-`)) out.push(c);
  }
  return out;
}

/** The 13:00 ET early closes of `year`. */
export function nyseEarlyCloses(year: number): CalendarHoliday[] {
  const out: CalendarHoliday[] = [];
  const push = (day: IsoDate, name: string): void => {
    out.push({ day, name, kind: 'early_close', closeTime: NYSE_EARLY_CLOSE_TIME });
  };

  // 1. The Friday after Thanksgiving, from 1992 — before that it was a full session.
  if (year >= THANKSGIVING_EARLY_CLOSE_FIRST_YEAR) {
    push(addDays(nthWeekdayOfMonth(year, 11, THURSDAY, 4), 1), 'Day after Thanksgiving');
  }

  // 2. 3 July, when 3 and 4 July are both weekdays.
  const july3 = formatIsoDate(year, 7, 3);
  const july4Dow = dayOfWeek(formatIsoDate(year, 7, 4));
  const july3Dow = dayOfWeek(july3);
  if (
    july3Dow !== SATURDAY &&
    july3Dow !== SUNDAY &&
    july4Dow !== SATURDAY &&
    july4Dow !== SUNDAY
  ) {
    push(july3, 'Day before Independence Day');
  }

  // 3. 24 December, Monday-Thursday. (A Friday 24 December is the observed Christmas closure.)
  const dec24 = formatIsoDate(year, 12, 24);
  if (dayOfWeek(dec24) >= MONDAY && dayOfWeek(dec24) < FRIDAY) push(dec24, 'Christmas Eve');

  return out;
}

/** Every NYSE `calendar_holidays` row of `year`, closures and early closes together. */
export function nyseHolidays(year: number): CalendarHoliday[] {
  return [...nyseClosures(year), ...nyseEarlyCloses(year)];
}

/** Build one of the three US equity/option calendars from the shared NYSE rule. */
export function nyseCalendar(spec: {
  id: string;
  name: string;
  preOpen?: string;
  open: string;
  close: string;
  postClose?: string;
}): Calendar {
  const { id, name, ...session } = spec;
  return makeRuleCalendar({
    id,
    name,
    tz: 'America/New_York',
    kind: 'exchange',
    rule: nyseHolidays,
    sessions: weekdaySessions(session),
  });
}

/** New York Stock Exchange — 09:30-16:00 ET, 04:00 pre-market, 20:00 post-market. */
export const XNYS: Calendar = registerCalendar(
  nyseCalendar({
    id: 'XNYS',
    name: 'New York Stock Exchange',
    preOpen: '04:00',
    open: '09:30',
    close: '16:00',
    postClose: '20:00',
  }),
);

/** Nasdaq — identical schedule to the NYSE. */
export const XNAS: Calendar = registerCalendar(
  nyseCalendar({
    id: 'XNAS',
    name: 'Nasdaq Stock Market',
    preOpen: '04:00',
    open: '09:30',
    close: '16:00',
    postClose: '20:00',
  }),
);

/** Cboe Options Exchange — same holidays; index options run to 16:15 ET. */
export const XCBO: Calendar = registerCalendar(
  nyseCalendar({
    id: 'XCBO',
    name: 'Cboe Options Exchange',
    preOpen: '07:30',
    open: '09:30',
    close: '16:15',
  }),
);
