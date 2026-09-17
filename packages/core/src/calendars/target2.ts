/**
 * The two European calendars: `TARGET2` (the euro payment system) and `XLON` (London).
 *
 * `TARGET2` is the settlement calendar for every EUR cash flow. Its holiday list is tiny and, since
 * the system's launch, completely stable: 1 January, Good Friday, Easter Monday, 1 May (Labour Day),
 * 25 December and 26 December. TARGET2 applies **no weekend observance at all** — a holiday that
 * falls on a Saturday or Sunday is simply lost, never moved to a weekday. The rules are extrapolated
 * back over the whole 1990-2040 window (TARGET itself opened on 1 January 1999); the two
 * transitional closures of 31 December 1999-2001 are not modelled.
 *
 * `XLON` is the London Stock Exchange calendar: England & Wales bank holidays with the statutory
 * "substitute day" rule — a bank holiday on a weekend is taken on the next weekday, and Boxing Day
 * steps over the substituted Christmas Day, except when 25 December is a Sunday, where Boxing Day
 * keeps Monday 26 December and Christmas Day's substitute steps over *it* — plus the royal one-offs,
 * which are law rather than
 * rule ({@link XLON_AD_HOC_CLOSURES}), and the 12:30 half-days on Christmas Eve and New Year's Eve.
 */

import type { Calendar, CalendarHoliday, IsoDate } from './calendar.js';
import {
  MONDAY,
  SUNDAY,
  addDays,
  dayOfWeek,
  easterMonday,
  formatIsoDate,
  goodFriday,
  isWeekendDay,
  lastWeekdayOfMonth,
  makeRuleCalendar,
  nthWeekdayOfMonth,
  registerCalendar,
  weekdaySessions,
} from './calendar.js';

// ─────────────────────────────────────────────────────────────────────────────── TARGET2 ─────

/** The TARGET2 closing days of `year`. */
export function target2Holidays(year: number): CalendarHoliday[] {
  return [
    { day: formatIsoDate(year, 1, 1), name: "New Year's Day", kind: 'closed' },
    { day: goodFriday(year), name: 'Good Friday', kind: 'closed' },
    { day: easterMonday(year), name: 'Easter Monday', kind: 'closed' },
    { day: formatIsoDate(year, 5, 1), name: 'Labour Day', kind: 'closed' },
    { day: formatIsoDate(year, 12, 25), name: 'Christmas Day', kind: 'closed' },
    { day: formatIsoDate(year, 12, 26), name: 'Boxing Day', kind: 'closed' },
  ];
}

/** `TARGET2` — the euro payment-system calendar (CONTRACTS L110). */
export const TARGET2: Calendar = registerCalendar(
  makeRuleCalendar({
    id: 'TARGET2',
    name: 'TARGET2 (euro) settlement',
    tz: 'Europe/Frankfurt',
    kind: 'settlement',
    rule: target2Holidays,
    sessions: weekdaySessions({ open: '07:00', close: '18:00' }),
  }),
);

// ────────────────────────────────────────────────────────────────────────────────── XLON ─────

/** `calendar_holidays.close_time` on an LSE half-day. */
export const XLON_EARLY_CLOSE_TIME = '12:30';

/** One-off London closures granted by royal proclamation inside the covered window. */
export const XLON_AD_HOC_CLOSURES: readonly CalendarHoliday[] = [
  { day: '1999-12-31', name: 'Millennium Eve', kind: 'closed' },
  { day: '2002-06-03', name: 'Golden Jubilee bank holiday', kind: 'closed' },
  { day: '2002-06-04', name: "Queen's Golden Jubilee", kind: 'closed' },
  { day: '2011-04-29', name: 'Royal Wedding', kind: 'closed' },
  { day: '2012-06-04', name: 'Diamond Jubilee bank holiday', kind: 'closed' },
  { day: '2012-06-05', name: "Queen's Diamond Jubilee", kind: 'closed' },
  { day: '2022-06-02', name: 'Spring bank holiday (Platinum Jubilee)', kind: 'closed' },
  { day: '2022-06-03', name: "Queen's Platinum Jubilee", kind: 'closed' },
  { day: '2022-09-19', name: 'State Funeral of Queen Elizabeth II', kind: 'closed' },
  { day: '2023-05-08', name: 'Coronation of King Charles III', kind: 'closed' },
];

/** Years whose Spring bank holiday was moved to June for a jubilee (the moved days are ad hoc). */
const SPRING_BANK_MOVED = new Set([2002, 2012, 2022]);

/** Years whose Early May bank holiday was moved to 8 May for a VE Day anniversary. */
const EARLY_MAY_MOVED = new Map<number, IsoDate>([
  [1995, '1995-05-08'],
  [2020, '2020-05-08'],
]);

/** Roll a fixed-date bank holiday forward to the next weekday (the statutory substitute day). */
function substituteDay(day: IsoDate, taken: Set<IsoDate>): IsoDate {
  let d = day;
  while (isWeekendDay(d) || taken.has(d)) d = addDays(d, 1);
  return d;
}

/** The England & Wales bank holidays observed by the LSE in `year`. */
export function xlonClosures(year: number): CalendarHoliday[] {
  const out: CalendarHoliday[] = [];
  const taken = new Set<IsoDate>();
  const push = (day: IsoDate, name: string): void => {
    out.push({ day, name, kind: 'closed' });
    taken.add(day);
  };

  push(substituteDay(formatIsoDate(year, 1, 1), taken), "New Year's Day");
  push(goodFriday(year), 'Good Friday');
  push(easterMonday(year), 'Easter Monday');
  push(EARLY_MAY_MOVED.get(year) ?? nthWeekdayOfMonth(year, 5, MONDAY, 1), 'Early May bank holiday');
  if (!SPRING_BANK_MOVED.has(year)) {
    push(lastWeekdayOfMonth(year, 5, MONDAY), 'Spring bank holiday');
  }
  push(lastWeekdayOfMonth(year, 8, MONDAY), 'Summer bank holiday');
  // Christmas Day first, then Boxing Day stepping over it — *except* when 25 December is a Sunday.
  // Then 26 December is already a weekday, so Boxing Day is simply Monday the 26th and it is
  // Christmas Day's substitute that steps over it, to Tuesday the 27th. Placing Christmas first in
  // that year would name Monday "Christmas Day" and Tuesday "Boxing Day", which is backwards
  // (2022: Boxing Day = Mon 26 Dec, Christmas Day substitute = Tue 27 Dec).
  const dec25 = formatIsoDate(year, 12, 25);
  const dec26 = formatIsoDate(year, 12, 26);
  if (dayOfWeek(dec25) === SUNDAY) {
    push(substituteDay(dec26, taken), 'Boxing Day');
    push(substituteDay(dec25, taken), 'Christmas Day');
  } else {
    push(substituteDay(dec25, taken), 'Christmas Day');
    push(substituteDay(dec26, taken), 'Boxing Day');
  }

  for (const c of XLON_AD_HOC_CLOSURES) {
    if (c.day.startsWith(`${String(year)}-`)) out.push(c);
  }
  return out;
}

/** The LSE 12:30 half-days of `year`: Christmas Eve and New Year's Eve when they are sessions. */
export function xlonEarlyCloses(year: number): CalendarHoliday[] {
  const closed = new Set(xlonClosures(year).map((h) => h.day));
  const out: CalendarHoliday[] = [];
  for (const [day, name] of [
    [formatIsoDate(year, 12, 24), 'Christmas Eve'],
    [formatIsoDate(year, 12, 31), "New Year's Eve"],
  ] as const) {
    if (!isWeekendDay(day) && !closed.has(day)) {
      out.push({ day, name, kind: 'early_close', closeTime: XLON_EARLY_CLOSE_TIME });
    }
  }
  return out;
}

/** Every LSE `calendar_holidays` row of `year`. */
export function xlonHolidays(year: number): CalendarHoliday[] {
  return [...xlonClosures(year), ...xlonEarlyCloses(year)];
}

/** `XLON` — London Stock Exchange, 08:00-16:30 London time (CONTRACTS L110, L118). */
export const XLON: Calendar = registerCalendar(
  makeRuleCalendar({
    id: 'XLON',
    name: 'London Stock Exchange',
    tz: 'Europe/London',
    kind: 'exchange',
    rule: xlonHolidays,
    sessions: weekdaySessions({ open: '08:00', close: '16:30' }),
  }),
);
