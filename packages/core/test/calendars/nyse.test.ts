/**
 * REF-06 — the rule-generated calendars (WORKPLAN L550): Juneteenth from 2022 only, NYSE early
 * closes, and `combine()` unioning holidays, plus the spot-checks that pin the observance rules:
 * Thanksgiving 2026, Good Friday (NYSE closed, SIFMA open) and New Year's Day observed when
 * 1 January falls on a Sunday.
 */

import { describe, expect, it } from 'vitest';

import type { Calendar } from '../../src/calendars/calendar.js';
import {
  CALENDAR_IDS,
  addBusinessDays,
  adjust,
  combine,
  dayOfWeek,
  datesInRange,
  getCalendar,
  isBusinessDay,
  registeredCalendars,
} from '../../src/calendars/calendar.js';
import {
  NYSE_AD_HOC_CLOSURES,
  NYSE_EARLY_CLOSE_TIME,
  THANKSGIVING_EARLY_CLOSE_FIRST_YEAR,
  XCBO,
  XNAS,
  XNYS,
} from '../../src/calendars/nyse.js';
import { SIFMA, SIFMA_EARLY_CLOSE_TIME } from '../../src/calendars/sifma.js';
import { JUNETEENTH_FIRST_YEAR, USGOVT } from '../../src/calendars/usgovt.js';
import { FX_USD } from '../../src/calendars/fx.js';
import { TARGET2, XLON } from '../../src/calendars/target2.js';
import { WEEKEND } from '../../src/calendars/weekend.js';

const SEED_FROM = 1990;
const SEED_TO = 2040;

describe('calendar ids match the calendars.calendar_id list verbatim', () => {
  // CONTRACTS L110, verbatim:
  const CONTRACT_LIST = "'XNYS','XNAS','XCBO','SIFMA','USGOVT','FX_USD','TARGET2','XLON','WEEKEND'";

  it('CALENDAR_IDS is the seeded list, in order', () => {
    const fromContract = CONTRACT_LIST.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    expect([...CALENDAR_IDS]).toEqual(fromContract);
  });

  it('every id resolves to a registered calendar reporting that id', () => {
    const all = [XNYS, XNAS, XCBO, SIFMA, USGOVT, FX_USD, TARGET2, XLON, WEEKEND];
    expect(all.map((c) => c.id)).toEqual([...CALENDAR_IDS]);
    for (const id of CALENDAR_IDS) expect(getCalendar(id).id).toBe(id);
    expect(registeredCalendars().map((c) => c.id).sort()).toEqual([...CALENDAR_IDS].sort());
  });

  it('exposes calendar_sessions rows keyed 0 = Sunday … 6 = Saturday', () => {
    const sessions = XNYS.sessions();
    expect(sessions.map((s) => s.weekday)).toEqual([1, 2, 3, 4, 5]);
    expect(sessions[0]?.openTime).toBe('09:30');
    expect(sessions[0]?.closeTime).toBe('16:00');
    expect(sessions[0]?.preOpen).toBe('04:00');
    expect(sessions[0]?.postClose).toBe('20:00');
  });
});

describe('Juneteenth is a holiday from 2022 only', () => {
  const juneteenthsIn = (cal: Calendar, year: number): string[] =>
    cal
      .holidays(year, year)
      .filter((h) => h.kind === 'closed' && h.name.startsWith('Juneteenth'))
      .map((h) => h.day);

  it('never appears before 2022 on any US calendar', () => {
    for (let y = SEED_FROM; y < JUNETEENTH_FIRST_YEAR; y++) {
      expect(juneteenthsIn(XNYS, y), `XNYS ${String(y)}`).toEqual([]);
      expect(juneteenthsIn(SIFMA, y), `SIFMA ${String(y)}`).toEqual([]);
      expect(juneteenthsIn(USGOVT, y), `USGOVT ${String(y)}`).toEqual([]);
    }
    // The federal one-off of Friday 18 June 2021 is deliberately not modelled: one rule, every
    // calendar, from 2022.
    expect(XNYS.isBusinessDay('2021-06-18')).toBe(true);
    expect(USGOVT.isBusinessDay('2021-06-18')).toBe(true);
    expect(XNYS.isBusinessDay('2020-06-19')).toBe(true);
  });

  it('appears exactly once a year from 2022 through 2040', () => {
    for (let y = JUNETEENTH_FIRST_YEAR; y <= SEED_TO; y++) {
      expect(juneteenthsIn(XNYS, y), `XNYS ${String(y)}`).toHaveLength(1);
      expect(juneteenthsIn(SIFMA, y), `SIFMA ${String(y)}`).toHaveLength(1);
      expect(juneteenthsIn(USGOVT, y), `USGOVT ${String(y)}`).toHaveLength(1);
    }
  });

  it('observes 19 June 2022 (a Sunday) on Monday 20 June 2022', () => {
    expect(dayOfWeek('2022-06-19')).toBe(0);
    expect(XNYS.isHoliday('2022-06-20')).toBe(true);
    expect(XNYS.holidayName('2022-06-20')).toBe('Juneteenth');
    expect(XNYS.isBusinessDay('2022-06-20')).toBe(false);
  });

  it('closes on the day itself when 19 June is a weekday', () => {
    expect(dayOfWeek('2023-06-19')).toBe(1);
    expect(XNYS.isHoliday('2023-06-19')).toBe(true);
    expect(XNYS.isHoliday('2026-06-19')).toBe(true);
  });
});

describe('NYSE early closes are 13:00 sessions, not closures', () => {
  it('the day after Thanksgiving 2026 (Friday 27 November) closes at 13:00', () => {
    expect(XNYS.isHoliday('2026-11-26')).toBe(true); // Thanksgiving itself
    expect(XNYS.holidayName('2026-11-26')).toBe('Thanksgiving Day');
    const early = XNYS.earlyClose('2026-11-27');
    expect(early?.kind).toBe('early_close');
    expect(early?.closeTime).toBe(NYSE_EARLY_CLOSE_TIME);
    expect(early?.closeTime).toBe('13:00');
    // An early close is still a business day: settlement and accrual do not skip it.
    expect(XNYS.isBusinessDay('2026-11-27')).toBe(true);
    expect(XNYS.isHoliday('2026-11-27')).toBe(false);
  });

  it('did not close early the day after Thanksgiving before 1992', () => {
    // The 13:00 half-session began in 1992. 1990-11-23 and 1991-11-29 were full trading days, so
    // the rule is gated the way MLK and Juneteenth are.
    expect(THANKSGIVING_EARLY_CLOSE_FIRST_YEAR).toBe(1992);
    expect(XNYS.earlyClose('1990-11-23')).toBeUndefined();
    expect(XNYS.earlyClose('1991-11-29')).toBeUndefined();
    expect(XNYS.isBusinessDay('1990-11-23')).toBe(true);
    expect(XNYS.isBusinessDay('1991-11-29')).toBe(true);
    // …and from 1992 it is there every year.
    expect(XNYS.earlyClose('1992-11-27')?.name).toBe('Day after Thanksgiving');
    expect(XNYS.earlyClose('1993-11-26')?.name).toBe('Day after Thanksgiving');
  });

  it('closes early on Christmas Eve when 24 December is a weekday session', () => {
    expect(dayOfWeek('2026-12-24')).toBe(4); // Thursday
    expect(XNYS.earlyClose('2026-12-24')?.name).toBe('Christmas Eve');
    expect(XNYS.isBusinessDay('2026-12-24')).toBe(true);
    expect(XNYS.isHoliday('2026-12-25')).toBe(true);

    // 24 December 2021 was a Friday: it is the *observed Christmas closure*, so a full closure
    // beats the early-close rule on the same day.
    expect(dayOfWeek('2021-12-24')).toBe(5);
    expect(XNYS.isHoliday('2021-12-24')).toBe(true);
    expect(XNYS.earlyClose('2021-12-24')).toBeUndefined();

    // 24 December 2023 was a Sunday: no session at all.
    expect(XNYS.earlyClose('2023-12-24')).toBeUndefined();
    expect(XNYS.earlyClose('2023-12-22')).toBeUndefined();
  });

  it('applies the 3 July rule only when 3 and 4 July are both weekdays', () => {
    // 2025: 4 July is a Friday, so Thursday 3 July is a 13:00 session.
    expect(dayOfWeek('2025-07-04')).toBe(5);
    expect(XNYS.earlyClose('2025-07-03')?.closeTime).toBe('13:00');
    expect(XNYS.isHoliday('2025-07-04')).toBe(true);

    // 2026: 4 July is a Saturday, so Friday 3 July is the observed closure — not an early close.
    expect(dayOfWeek('2026-07-04')).toBe(6);
    expect(XNYS.isHoliday('2026-07-03')).toBe(true);
    expect(XNYS.holidayName('2026-07-03')).toBe('Independence Day');
    expect(XNYS.earlyClose('2026-07-03')).toBeUndefined();
    expect(XNYS.earlyClose('2026-07-02')).toBeUndefined();

    // 2022: 4 July is a Monday, so 3 July is a Sunday and nothing is shortened.
    expect(dayOfWeek('2022-07-04')).toBe(1);
    expect(XNYS.isHoliday('2022-07-04')).toBe(true);
    expect(XNYS.earlyClose('2022-07-01')).toBeUndefined();

    // 2021: 4 July is a Sunday, observed Monday 5 July; Friday 2 July is a full session.
    expect(XNYS.isHoliday('2021-07-05')).toBe(true);
    expect(XNYS.earlyClose('2021-07-02')).toBeUndefined();
  });

  it('gives Nasdaq and Cboe the same schedule as the NYSE', () => {
    for (const day of datesInRange('2026-01-01', '2026-12-31')) {
      expect(XNAS.isBusinessDay(day), `XNAS ${day}`).toBe(XNYS.isBusinessDay(day));
      expect(XCBO.isBusinessDay(day), `XCBO ${day}`).toBe(XNYS.isBusinessDay(day));
      expect(XNAS.earlyClose(day)?.closeTime).toBe(XNYS.earlyClose(day)?.closeTime);
    }
    // They differ only in the session template: Cboe index options run to 16:15.
    expect(XCBO.sessions()[0]?.closeTime).toBe('16:15');
  });
});

describe('spot-checked observance rules', () => {
  it('Thanksgiving 2026 is Thursday 26 November (the fourth Thursday)', () => {
    expect(dayOfWeek('2026-11-26')).toBe(4);
    expect(XNYS.isHoliday('2026-11-26')).toBe(true);
    expect(SIFMA.isHoliday('2026-11-26')).toBe(true);
    expect(USGOVT.isHoliday('2026-11-26')).toBe(true);
    // Not the last Thursday: 2026 has five, and 26 November is the fourth.
    expect(XNYS.isBusinessDay('2026-11-19')).toBe(true);
  });

  it('Good Friday closes the NYSE and SIFMA, but not the Fedwire calendars', () => {
    // Easter Sunday 2026 is 5 April, so Good Friday is 3 April.
    expect(XNYS.isHoliday('2026-04-03')).toBe(true);
    expect(XNYS.holidayName('2026-04-03')).toBe('Good Friday');
    // SIFMA's published recommendation for a normal year is a FULL close, not the 12:00 session
    // (that is the exception for years when the Employment Situation report lands that morning).
    expect(SIFMA.isHoliday('2026-04-03')).toBe(true);
    expect(SIFMA.holidayName('2026-04-03')).toBe('Good Friday');
    expect(SIFMA.isBusinessDay('2026-04-03')).toBe(false);
    expect(SIFMA.earlyClose('2026-04-03')).toBeUndefined();
    // …and the same holds in 2025, where Good Friday is 18 April.
    expect(XNYS.isHoliday('2025-04-18')).toBe(true);
    expect(SIFMA.isHoliday('2025-04-18')).toBe(true);
    // Fedwire Securities stays open: USGOVT and FX_USD do not observe it.
    expect(USGOVT.isBusinessDay('2026-04-03')).toBe(true);
    expect(FX_USD.isBusinessDay('2026-04-03')).toBe(true);
  });

  it('rolls Easter-week settlement on SIFMA past Good Friday and Easter Monday', () => {
    // Good Friday 2026 is 3 April; the next SIFMA business day is Monday 6 April (Easter Monday is
    // not a US holiday). T+1 from Thursday 2 April therefore lands on 6 April, not 3 April, and T+2
    // on 7 April. This is the settlement consequence of the closure, pinned so it cannot regress.
    expect(addBusinessDays(SIFMA, '2026-04-02', 1)).toBe('2026-04-06');
    expect(addBusinessDays(SIFMA, '2026-04-02', 2)).toBe('2026-04-07');
    // Modified following on the closed day itself rolls forward within April.
    expect(adjust(SIFMA, '2026-04-03', 'following')).toBe('2026-04-06');
    expect(adjust(SIFMA, '2026-04-03', 'modified_following')).toBe('2026-04-06');
    expect(adjust(SIFMA, '2026-04-03', 'preceding')).toBe('2026-04-02');
    // USGOVT, which keeps the wire open, still settles on the Friday.
    expect(addBusinessDays(USGOVT, '2026-04-02', 1)).toBe('2026-04-03');
  });

  it("observes New Year's Day on the Monday when 1 January is a Sunday", () => {
    expect(dayOfWeek('2023-01-01')).toBe(0);
    expect(XNYS.isHoliday('2023-01-02')).toBe(true);
    expect(XNYS.holidayName('2023-01-02')).toBe("New Year's Day");
    expect(XNYS.isBusinessDay('2022-12-30')).toBe(true);
  });

  it("does not observe New Year's Day at all when 1 January is a Saturday", () => {
    // NYSE Rule 7.2's one exception: 31 December 2021 and 31 December 2032 are full sessions.
    expect(dayOfWeek('2022-01-01')).toBe(6);
    expect(XNYS.isBusinessDay('2021-12-31')).toBe(true);
    expect(XNYS.isBusinessDay('2022-01-03')).toBe(true);
    expect(dayOfWeek('2033-01-01')).toBe(6);
    expect(XNYS.isBusinessDay('2032-12-31')).toBe(true);
    // The federal calendar does observe it: 31 December 2021 was a federal holiday.
    expect(USGOVT.isHoliday('2021-12-31')).toBe(true);
    expect(FX_USD.isHoliday('2021-12-31')).toBe(true);
  });

  it('keeps the NYSE open on Columbus Day and Veterans Day, unlike SIFMA and USGOVT', () => {
    expect(XNYS.isBusinessDay('2026-10-12')).toBe(true);
    expect(XNYS.isBusinessDay('2026-11-11')).toBe(true);
    expect(SIFMA.isHoliday('2026-10-12')).toBe(true);
    expect(SIFMA.isHoliday('2026-11-11')).toBe(true);
    expect(USGOVT.isHoliday('2026-10-12')).toBe(true);
  });

  it('emits between 8 and 13 closures a year across the seeded window', () => {
    // 8 in a year that loses New Year's Day to a Saturday and predates Juneteenth; 13 in 2001,
    // where the four-session closure after the September 11 attacks sits on top of the ten rules.
    for (let y = SEED_FROM; y <= SEED_TO; y++) {
      const closed = XNYS.holidays(y, y).filter((h) => h.kind === 'closed');
      expect(closed.length, `XNYS ${String(y)}`).toBeGreaterThanOrEqual(8);
      expect(closed.length, `XNYS ${String(y)}`).toBeLessThanOrEqual(13);
      // No holiday is ever emitted on a weekend: the seeded rows are sessions that did not happen.
      for (const h of XNYS.holidays(y, y)) {
        expect(dayOfWeek(h.day), `${h.day} ${h.name}`).toBeGreaterThan(0);
        expect(dayOfWeek(h.day), `${h.day} ${h.name}`).toBeLessThan(6);
      }
    }
    expect(XNYS.holidays(2026, 2026).filter((h) => h.kind === 'closed')).toHaveLength(10);
    expect(XNYS.holidays(2026, 2026).filter((h) => h.kind === 'early_close')).toHaveLength(2);
  });

  it('is memoised: the same query is answered identically every time', () => {
    expect(XNYS.holidays(2026, 2026)).toEqual(XNYS.holidays(2026, 2026));
    expect(XNYS.holidays(1990, 2040)).toHaveLength(XNYS.holidays(1990, 2040).length);
  });
});

describe('combine() unions holidays (REF-06)', () => {
  const union = combine([XNYS, SIFMA]);

  it('is closed on a day that is closed on either calendar', () => {
    // Good Friday comes from the NYSE side …
    expect(union.isHoliday('2026-04-03')).toBe(true);
    expect(union.isBusinessDay('2026-04-03')).toBe(false);
    // … Columbus Day and Veterans Day from the SIFMA side.
    expect(union.isHoliday('2026-10-12')).toBe(true);
    expect(union.isHoliday('2026-11-11')).toBe(true);
    // Shared holidays appear once, naming both sources.
    expect(union.holidayName('2026-11-26')).toContain('Thanksgiving Day (XNYS)');
    expect(union.holidayName('2026-11-26')).toContain('Thanksgiving Day (SIFMA)');
  });

  it('is a business day only where every input calendar is', () => {
    for (const day of datesInRange('2026-01-01', '2026-12-31')) {
      expect(union.isBusinessDay(day), day).toBe(XNYS.isBusinessDay(day) && SIFMA.isBusinessDay(day));
    }
  });

  it('unions early closes too, and the earliest close wins', () => {
    // 27 November 2026 is 13:00 on the NYSE and 14:00 on SIFMA.
    expect(XNYS.earlyClose('2026-11-27')?.closeTime).toBe(NYSE_EARLY_CLOSE_TIME);
    expect(SIFMA.earlyClose('2026-11-27')?.closeTime).toBe(SIFMA_EARLY_CLOSE_TIME);
    expect(union.earlyClose('2026-11-27')?.closeTime).toBe('13:00');
    // An early close on one side only still surfaces: 31 December 2026 is SIFMA's.
    expect(XNYS.earlyClose('2026-12-31')).toBeUndefined();
    expect(union.earlyClose('2026-12-31')?.closeTime).toBe(SIFMA_EARLY_CLOSE_TIME);
    // A full closure always beats an early close on the same day.
    expect(union.earlyClose('2026-04-03')).toBeUndefined();
  });

  it('takes WEEKEND as its identity element and is order-independent', () => {
    const withWeekend = combine([XNYS, WEEKEND]);
    const reversed = combine([SIFMA, XNYS]);
    for (const day of datesInRange('2026-01-01', '2026-12-31')) {
      expect(withWeekend.isBusinessDay(day), day).toBe(XNYS.isBusinessDay(day));
      expect(reversed.isBusinessDay(day), day).toBe(union.isBusinessDay(day));
    }
  });

  it('builds a cross-currency settlement calendar from FX_USD and TARGET2', () => {
    const settlement = combine([FX_USD, TARGET2], { id: 'FX_USD+TARGET2', kind: 'currency' });
    expect(settlement.id).toBe('FX_USD+TARGET2');
    expect(settlement.kind).toBe('currency');
    // 1 May 2026 is a TARGET2 holiday and a normal US business day …
    expect(dayOfWeek('2026-05-01')).toBe(5);
    expect(FX_USD.isBusinessDay('2026-05-01')).toBe(true);
    expect(settlement.isBusinessDay('2026-05-01')).toBe(false);
    // … and 3 July 2026 (observed Independence Day) is the mirror image.
    expect(TARGET2.isBusinessDay('2026-07-03')).toBe(true);
    expect(settlement.isBusinessDay('2026-07-03')).toBe(false);
  });

  it('rejects an empty calendar list', () => {
    expect(() => combine([])).toThrow(/at least one calendar/);
  });
});

describe('business-day arithmetic over the generated calendars', () => {
  it('rolls under each business-day convention', () => {
    // 4 July 2026 is a Saturday and 3 July the observed closure, so the NYSE is shut 3-5 July.
    expect(adjust(XNYS, '2026-07-04', 'following')).toBe('2026-07-06');
    expect(adjust(XNYS, '2026-07-04', 'preceding')).toBe('2026-07-02');
    expect(adjust(XNYS, '2026-07-04', 'none')).toBe('2026-07-04');
    expect(adjust(XNYS, '2026-07-06', 'following')).toBe('2026-07-06');
  });

  it('modified_following turns back rather than crossing the month end', () => {
    // 31 May 2026 is a Sunday; following would land in June.
    expect(dayOfWeek('2026-05-31')).toBe(0);
    expect(adjust(XNYS, '2026-05-31', 'following')).toBe('2026-06-01');
    expect(adjust(XNYS, '2026-05-31', 'modified_following')).toBe('2026-05-29');
  });

  it('counts business days across a holiday and an early close', () => {
    // Wednesday 25 November 2026 + 2: Thanksgiving is skipped, the 13:00 Friday is not.
    expect(addBusinessDays(XNYS, '2026-11-25', 2)).toBe('2026-11-30');
    expect(addBusinessDays(XNYS, '2026-11-30', -2)).toBe('2026-11-25');
    // n = 0 is the `following` roll: a Saturday settles on the next open day.
    expect(addBusinessDays(XNYS, '2026-07-04', 0)).toBe('2026-07-06');
    expect(isBusinessDay(XNYS, '2026-11-27')).toBe(true);
  });

  it('agrees with the calendar it was asked about', () => {
    expect(isBusinessDay(SIFMA, '2026-04-03')).toBe(false); // SIFMA recommends a full close
    expect(isBusinessDay(USGOVT, '2026-04-03')).toBe(true); // …but Fedwire stays open
    expect(isBusinessDay(XNYS, '2026-04-03')).toBe(false);
    expect(isBusinessDay(XLON, '2026-04-03')).toBe(false); // Good Friday is a UK bank holiday
    expect(isBusinessDay(WEEKEND, '2026-04-03')).toBe(true);
  });
});

describe('NYSE unscheduled closures inside the 1990-2040 window', () => {
  it('lists the twelve historical closures, in ascending date order, all full closures', () => {
    expect(NYSE_AD_HOC_CLOSURES.map((c) => c.day)).toEqual([
      '1994-04-27', // Funeral of Richard Nixon
      '1996-01-08', // Blizzard of '96
      '2001-09-11',
      '2001-09-12',
      '2001-09-13',
      '2001-09-14',
      '2004-06-11', // Funeral of Ronald Reagan
      '2007-01-02', // Funeral of Gerald Ford
      '2012-10-29', // Hurricane Sandy
      '2012-10-30',
      '2018-12-05', // Funeral of George H. W. Bush
      '2025-01-09', // Funeral of Jimmy Carter
    ]);
    for (const closure of NYSE_AD_HOC_CLOSURES) expect(closure.kind).toBe('closed');
  });

  it("closes XNYS, XNAS and XCBO all day for the Blizzard of '96", () => {
    // Monday 8 January 1996: the NYSE and Nasdaq did not open. It is inside the generator window,
    // so WP-15 would otherwise seed a session row for a day the exchange never traded.
    expect(dayOfWeek('1996-01-08')).toBe(1);
    for (const cal of [XNYS, XNAS, XCBO]) {
      expect(cal.isHoliday('1996-01-08')).toBe(true);
      expect(cal.isBusinessDay('1996-01-08')).toBe(false);
      expect(cal.holidayName('1996-01-08')).toBe("Blizzard of '96");
    }
    // The surrounding sessions did trade.
    expect(XNYS.isBusinessDay('1996-01-05')).toBe(true);
    expect(XNYS.isBusinessDay('1996-01-09')).toBe(true);
    // …and it is not a SIFMA or federal closure: only the equity venues shut.
    expect(SIFMA.isHoliday('1996-01-08')).toBe(false);
    expect(USGOVT.isHoliday('1996-01-08')).toBe(false);
  });
});

describe('XLON — the Christmas/Boxing Day substitute days', () => {
  it('names Boxing Day the Monday and Christmas Day the Tuesday when 25 December is a Sunday', () => {
    // 25 December 2022 was a Sunday. Statutorily Boxing Day IS Monday 26 December — it needs no
    // substitute — and it is the Christmas Day substitute that rolls past it to Tuesday 27th.
    expect(dayOfWeek('2022-12-25')).toBe(0);
    expect(XLON.isHoliday('2022-12-26')).toBe(true);
    expect(XLON.isHoliday('2022-12-27')).toBe(true);
    expect(XLON.holidayName('2022-12-26')).toBe('Boxing Day');
    expect(XLON.holidayName('2022-12-27')).toBe('Christmas Day');
    // 2033 is the next such year (25 December 2033 is a Sunday).
    expect(dayOfWeek('2033-12-25')).toBe(0);
    expect(XLON.holidayName('2033-12-26')).toBe('Boxing Day');
    expect(XLON.holidayName('2033-12-27')).toBe('Christmas Day');
  });

  it('keeps the ordinary order in every other year', () => {
    // Saturday 25 December 2021: Christmas substitute Monday 27th, Boxing Day substitute Tuesday 28th.
    expect(dayOfWeek('2021-12-25')).toBe(6);
    expect(XLON.holidayName('2021-12-27')).toBe('Christmas Day');
    expect(XLON.holidayName('2021-12-28')).toBe('Boxing Day');
    // Friday 25 December 2020: Christmas on the day, Boxing Day substitute Monday 28th.
    expect(dayOfWeek('2020-12-25')).toBe(5);
    expect(XLON.holidayName('2020-12-25')).toBe('Christmas Day');
    expect(XLON.holidayName('2020-12-28')).toBe('Boxing Day');
    // Monday 25 December 2023: both fall on weekdays, no substitution at all.
    expect(dayOfWeek('2023-12-25')).toBe(1);
    expect(XLON.holidayName('2023-12-25')).toBe('Christmas Day');
    expect(XLON.holidayName('2023-12-26')).toBe('Boxing Day');
  });

  it('closes both days in every year of the window, whatever they are called', () => {
    for (let y = 1990; y <= 2040; y++) {
      const names = XLON.holidays(y, y)
        .filter((h) => h.name === 'Christmas Day' || h.name === 'Boxing Day')
        .map((h) => h.name)
        .sort();
      expect(names, `XLON ${String(y)}`).toEqual(['Boxing Day', 'Christmas Day']);
    }
  });
});
