/**
 * FEED-06 — `sessionState` over pre/open/auction/closed/post on the NYSE calendar, across the
 * 13:00 early close on the day after Thanksgiving 2026 (Friday 27 November, EST) and a regular
 * September day (EDT), on virtual instants. Also pins the documented DST rule the local wall clock
 * is read with, since `packages/core` converts time zones itself.
 */

import { describe, expect, it } from 'vitest';

import { XNYS } from '../../src/calendars/nyse.js';
import { FX_USD } from '../../src/calendars/fx.js';
import { makeRuleCalendar } from '../../src/calendars/calendar.js';
import {
  EXCHANGE_CLOSING_AUCTION_MINUTES,
  localClock,
  localMinutes,
  localTimeToUtc,
  phaseAt,
  sessionCalendar,
  sessionState,
  utcOffsetMinutes,
} from '../../src/quote/session.js';
import type { SessionCalendar } from '../../src/quote/session.js';

/** Epoch ms of a New York wall-clock time; `offsetH` is −4 (EDT) or −5 (EST). */
const ny = (date: string, hhmm: string, offsetH: number): number => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hh - offsetH,
    mm,
  );
};

const EST = -5;
const EDT = -4;
const nyse = sessionCalendar(XNYS);

describe('sessionCalendar(XNYS)', () => {
  it('reads the early close and the template', () => {
    expect(nyse.tz).toBe('America/New_York');
    expect(nyse.closingAuctionMinutes).toBe(EXCHANGE_CLOSING_AUCTION_MINUTES);
    expect(nyse.openingAuctionMinutes).toBe(0);
    expect(nyse.isTradingDay('2026-11-27')).toBe(true);
    expect(nyse.closeTime('2026-11-27')).toBe('13:00');
    expect(nyse.closeTime('2026-09-15')).toBe('16:00');
    expect(nyse.sessionDay('2026-11-27')).toEqual({
      kind: 'trading',
      times: { preOpen: '04:00', open: '09:30', close: '13:00', postClose: '17:00', earlyClose: true },
    });
    expect(nyse.isTradingDay('2026-11-26')).toBe(false); // Thanksgiving
    expect(nyse.isTradingDay('2026-11-28')).toBe(false); // Saturday
    expect(nyse.closeTime('2026-11-26')).toBeUndefined();
  });
});

describe('sessionState — NYSE early close, Friday 27 November 2026 (EST)', () => {
  const D = '2026-11-27';
  const at = (hhmm: string): number => ny(D, hhmm, EST);

  it('walks closed → pre → open → auction → post → closed with a pre/post session', () => {
    expect(sessionState(nyse, at('03:59'), true)).toBe('closed');
    expect(sessionState(nyse, at('04:00'), true)).toBe('pre');
    expect(sessionState(nyse, at('09:29'), true)).toBe('pre');
    expect(sessionState(nyse, at('09:30'), true)).toBe('open');
    expect(sessionState(nyse, at('12:49'), true)).toBe('open');
    expect(sessionState(nyse, at('12:50'), true)).toBe('auction');
    expect(sessionState(nyse, at('12:59'), true)).toBe('auction');
    expect(sessionState(nyse, at('13:00'), true)).toBe('post');
    expect(sessionState(nyse, at('15:59'), true)).toBe('post'); // no 15:50 auction on an early close
    // Extended hours end four hours after the early close (17:00 ET), not at the template's 20:00.
    expect(sessionState(nyse, at('16:59'), true)).toBe('post');
    expect(sessionState(nyse, at('17:00'), true)).toBe('closed');
    expect(sessionState(nyse, at('17:01'), true)).toBe('closed');
    expect(sessionState(nyse, at('19:59'), true)).toBe('closed');
    expect(sessionState(nyse, at('20:00'), true)).toBe('closed');
    expect(sessionState(nyse, at('23:59'), true)).toBe('closed');
  });

  it('reports closed instead of pre/post for a subject without an extended session', () => {
    expect(sessionState(nyse, at('04:00'), false)).toBe('closed');
    expect(sessionState(nyse, at('09:29'), false)).toBe('closed');
    expect(sessionState(nyse, at('09:30'), false)).toBe('open');
    expect(sessionState(nyse, at('12:55'), false)).toBe('auction');
    expect(sessionState(nyse, at('13:00'), false)).toBe('closed');
    expect(sessionState(nyse, at('16:00'), false)).toBe('closed');
  });
});

describe('sessionState — regular day, Tuesday 15 September 2026 (EDT)', () => {
  const D = '2026-09-15';
  const at = (hhmm: string): number => ny(D, hhmm, EDT);

  it('opens at 09:30, enters the closing auction at 15:50 and posts at 16:00', () => {
    expect(sessionState(nyse, at('09:29'), true)).toBe('pre');
    expect(sessionState(nyse, at('09:30'), true)).toBe('open');
    expect(sessionState(nyse, at('14:41'), true)).toBe('open'); // the AAPL capture, 18:41 UTC
    expect(sessionState(nyse, at('15:49'), true)).toBe('open');
    expect(sessionState(nyse, at('15:50'), true)).toBe('auction');
    expect(sessionState(nyse, at('16:00'), true)).toBe('post');
    expect(sessionState(nyse, at('20:00'), true)).toBe('closed');
  });

  it('the AAPL fixture capture instant (1789497688000) is open', () => {
    expect(sessionState(nyse, 1_789_497_688_000, true)).toBe('open');
  });
});

describe('sessionState — holidays, weekends and unknowns', () => {
  it('is closed all day on Thanksgiving and on the weekend', () => {
    expect(sessionState(nyse, ny('2026-11-26', '12:00', EST), true)).toBe('closed');
    expect(sessionState(nyse, ny('2026-11-26', '09:30', EST), false)).toBe('closed');
    expect(sessionState(nyse, ny('2026-11-28', '12:00', EST), true)).toBe('closed');
    expect(sessionState(nyse, ny('2026-11-29', '12:00', EST), true)).toBe('closed');
    expect(sessionState(nyse, ny('2026-07-03', '12:00', EDT), true)).toBe('closed'); // observed 4 July
  });

  it('never returns halted (a venue signal) and returns unknown only when it cannot know', () => {
    // A calendar with no session template (rule-only, no `sessions`) cannot place an instant in a phase.
    const noTemplate = makeRuleCalendar({ id: 'TEST_NO_SESSIONS', name: 'no sessions', tz: 'UTC', kind: 'weekend', rule: () => [] });
    expect(sessionCalendar(noTemplate).sessionDay('2026-09-15')).toEqual({ kind: 'unknown' });
    expect(sessionState(sessionCalendar(noTemplate), ny('2026-09-15', '12:00', EDT), true)).toBe('unknown');
    const martian: SessionCalendar = { ...nyse, tz: 'Mars/Olympus_Mons' };
    expect(sessionState(martian, ny('2026-09-15', '12:00', EDT), true)).toBe('unknown');
  });

  it('FX trades round the clock on weekdays and has no auction', () => {
    const fx = sessionCalendar(FX_USD);
    expect(fx.closingAuctionMinutes).toBe(0);
    expect(sessionState(fx, ny('2026-09-15', '00:00', EDT), false)).toBe('open');
    expect(sessionState(fx, ny('2026-09-15', '23:59', EDT), false)).toBe('open');
    expect(sessionState(fx, ny('2026-09-19', '12:00', EDT), false)).toBe('closed'); // Saturday
  });
});

describe('phaseAt — the phase table on its own', () => {
  const times = { preOpen: '04:00', open: '09:30', close: '16:00', postClose: '20:00', earlyClose: false };
  it('supports an opening auction window and clamps degenerate windows', () => {
    const auction = { opening: 5, closing: 10 };
    expect(phaseAt(times, localMinutes('09:30'), true, auction)).toBe('auction');
    expect(phaseAt(times, localMinutes('09:34'), true, auction)).toBe('auction');
    expect(phaseAt(times, localMinutes('09:35'), true, auction)).toBe('open');
    expect(phaseAt(times, localMinutes('15:50'), true, auction)).toBe('auction');
    // Windows larger than the session collapse to auction all session, never to a negative range.
    const huge = { opening: 1000, closing: 1000 };
    expect(phaseAt(times, localMinutes('12:00'), true, huge)).toBe('auction');
    expect(phaseAt(times, localMinutes('16:00'), true, huge)).toBe('post');
  });

  it('treats a missing pre/post as closed either side of the session', () => {
    const bare = { preOpen: null, open: '09:30', close: '16:00', postClose: null, earlyClose: false };
    expect(phaseAt(bare, localMinutes('09:29'), true, { opening: 0, closing: 0 })).toBe('closed');
    expect(phaseAt(bare, localMinutes('09:30'), true, { opening: 0, closing: 0 })).toBe('open');
    expect(phaseAt(bare, localMinutes('16:00'), true, { opening: 0, closing: 0 })).toBe('closed');
  });
});

describe('time zones — the documented DST rule', () => {
  it('America/New_York: EDT from the second Sunday of March 02:00 EST to the first Sunday of November 02:00 EDT', () => {
    // 2026: 8 March and 1 November.
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2026, 2, 8, 6, 59))).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2026, 2, 8, 7, 0))).toBe(-240);
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2026, 10, 1, 5, 59))).toBe(-240);
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2026, 10, 1, 6, 0))).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2026, 0, 15, 12))).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2026, 6, 15, 12))).toBe(-240);
    // Pre-2007 rule: first Sunday of April (2 April 2006) to last Sunday of October (29 October 2006).
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2006, 2, 20, 12))).toBe(-300);
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2006, 3, 2, 7, 0))).toBe(-240);
    expect(utcOffsetMinutes('America/New_York', Date.UTC(2006, 9, 29, 6, 0))).toBe(-300);
  });

  it('Europe/London and Europe/Frankfurt switch at 01:00 UTC on the last Sundays of March and October', () => {
    // 2026: 29 March and 25 October.
    expect(utcOffsetMinutes('Europe/London', Date.UTC(2026, 2, 29, 0, 59))).toBe(0);
    expect(utcOffsetMinutes('Europe/London', Date.UTC(2026, 2, 29, 1, 0))).toBe(60);
    expect(utcOffsetMinutes('Europe/London', Date.UTC(2026, 9, 25, 0, 59))).toBe(60);
    expect(utcOffsetMinutes('Europe/London', Date.UTC(2026, 9, 25, 1, 0))).toBe(0);
    expect(utcOffsetMinutes('Europe/Frankfurt', Date.UTC(2026, 6, 1))).toBe(120);
    expect(utcOffsetMinutes('Europe/Frankfurt', Date.UTC(2026, 0, 1))).toBe(60);
    expect(utcOffsetMinutes('UTC', Date.UTC(2026, 6, 1))).toBe(0);
    expect(utcOffsetMinutes('Mars/Olympus_Mons', Date.UTC(2026, 6, 1))).toBeUndefined();
  });

  it('localClock and localTimeToUtc agree with each other and with the wall clock', () => {
    const t = ny('2026-11-27', '13:00', EST);
    expect(localClock('America/New_York', t)).toEqual({ date: '2026-11-27', minuteOfDay: 13 * 60 });
    expect(localTimeToUtc('America/New_York', '2026-11-27', '13:00')).toBe(t);
    const s = ny('2026-09-15', '20:30', EDT); // 00:30 UTC on the 16th
    expect(localClock('America/New_York', s)).toEqual({ date: '2026-09-15', minuteOfDay: 20 * 60 + 30 });
    expect(localClock('UTC', s)?.date).toBe('2026-09-16');
    expect(localTimeToUtc('America/New_York', '2026-09-15', '20:30')).toBe(s);
    expect(localTimeToUtc('Mars/Olympus_Mons', '2026-09-15', '20:30')).toBeUndefined();
  });

  it('localMinutes accepts 24:00 and rejects malformed times', () => {
    expect(localMinutes('00:00')).toBe(0);
    expect(localMinutes('24:00')).toBe(1440);
    expect(() => localMinutes('24:01')).toThrow(RangeError);
    expect(() => localMinutes('9:30')).toThrow(RangeError);
  });
});
