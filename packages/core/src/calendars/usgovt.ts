/**
 * `USGOVT` — the US federal holiday calendar (5 U.S.C. §6103), rule-generated.
 *
 * This is the base list the other US calendars specialise:
 *   - NYSE (`nyse.ts`) drops Columbus Day and Veterans Day and adds Good Friday.
 *   - SIFMA (`sifma.ts`) keeps the full federal list (the bond market observes Columbus Day and
 *     Veterans Day) and layers recommended early closes on top.
 *   - `FX_USD` (`fx.ts`) is the USD settlement/Fedwire calendar, which is the federal list.
 *
 * **Juneteenth is emitted from 2022 only** (`JUNETEENTH_FIRST_YEAR`), the rule WORKPLAN L494 and
 * TRACEABILITY REF-06 pin for every calendar in this package. The federal holiday was in fact
 * signed into law on 17 June 2021 and first observed on Friday 18 June 2021; that one-off is
 * deliberately **not** modelled, because the seeded `calendar_holidays` rows must agree with the
 * single rule the whole system tests against.
 *
 * Federal observance differs from market observance in one place: a Saturday holiday is observed on
 * the preceding Friday **including New Year's Day**, so 31 December 2021 was a federal holiday while
 * the NYSE traded a full session.
 */

import type { Calendar, CalendarHoliday, IsoDate } from './calendar.js';
import {
  MONDAY,
  THURSDAY,
  US_MARKET_OBSERVANCE,
  formatIsoDate,
  lastWeekdayOfMonth,
  makeRuleCalendar,
  nthWeekdayOfMonth,
  observed,
  registerCalendar,
} from './calendar.js';

/** The first year Juneteenth is a holiday on every calendar in this package (WORKPLAN L494). */
export const JUNETEENTH_FIRST_YEAR = 2022;

/** Martin Luther King Jr. Day has been a federal holiday since 1986; before that it is not emitted. */
export const MLK_FIRST_YEAR = 1986;

/** A fixed- or floating-date US holiday before weekend observance is applied. */
export interface UsHolidayDate {
  readonly day: IsoDate;
  readonly name: string;
  /** Fixed-date holidays move to the nearest weekday; floating (n-th Monday) ones never do. */
  readonly fixed: boolean;
}

/**
 * The unobserved US federal holiday dates for `year`, in calendar order. Callers apply their own
 * observance rule — the market calendars use {@link US_MARKET_OBSERVANCE_NO_SATURDAY} for New
 * Year's Day, the federal calendar uses {@link US_MARKET_OBSERVANCE} throughout.
 */
export function usFederalHolidayDates(year: number): UsHolidayDate[] {
  const out: UsHolidayDate[] = [
    { day: formatIsoDate(year, 1, 1), name: "New Year's Day", fixed: true },
  ];
  if (year >= MLK_FIRST_YEAR) {
    out.push({
      day: nthWeekdayOfMonth(year, 1, MONDAY, 3),
      name: 'Martin Luther King, Jr. Day',
      fixed: false,
    });
  }
  out.push(
    { day: nthWeekdayOfMonth(year, 2, MONDAY, 3), name: "Washington's Birthday", fixed: false },
    { day: lastWeekdayOfMonth(year, 5, MONDAY), name: 'Memorial Day', fixed: false },
  );
  if (year >= JUNETEENTH_FIRST_YEAR) {
    out.push({
      day: formatIsoDate(year, 6, 19),
      name: 'Juneteenth National Independence Day',
      fixed: true,
    });
  }
  out.push(
    { day: formatIsoDate(year, 7, 4), name: 'Independence Day', fixed: true },
    { day: nthWeekdayOfMonth(year, 9, MONDAY, 1), name: 'Labor Day', fixed: false },
    { day: nthWeekdayOfMonth(year, 10, MONDAY, 2), name: 'Columbus Day', fixed: false },
    { day: formatIsoDate(year, 11, 11), name: 'Veterans Day', fixed: true },
    { day: nthWeekdayOfMonth(year, 11, THURSDAY, 4), name: 'Thanksgiving Day', fixed: false },
    { day: formatIsoDate(year, 12, 25), name: 'Christmas Day', fixed: true },
  );
  return out;
}

/** The observed federal holidays of `year` as `calendar_holidays` rows. */
export function usFederalHolidays(year: number): CalendarHoliday[] {
  const out: CalendarHoliday[] = [];
  for (const h of usFederalHolidayDates(year)) {
    const day = h.fixed ? observed(h.day, US_MARKET_OBSERVANCE) : h.day;
    if (day === undefined) continue;
    out.push({ day, name: h.name, kind: 'closed' });
  }
  return out;
}

/**
 * `USGOVT` — US federal holidays, 0 early closes. `kind = 'government'`, `tz = America/New_York`
 * (CONTRACTS L110).
 */
export const USGOVT: Calendar = registerCalendar(
  makeRuleCalendar({
    id: 'USGOVT',
    name: 'United States federal holidays',
    tz: 'America/New_York',
    kind: 'government',
    rule: usFederalHolidays,
  }),
);
