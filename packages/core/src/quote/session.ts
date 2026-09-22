/**
 * Session state (FEED-06) — `sessionState(calendar, nowMs, hasPrePost)` over the `session_state`
 * enum `pre | open | auction | halted | closed | post | unknown`.
 *
 * Inputs are an instant (epoch ms UTC) and a {@link SessionCalendar}: a small adapter over
 * `core/calendars` that answers, for a local date, whether it trades and at what local times
 * (pre-open, open, close — the early-close time on a shortened day — and post-close). The phases of
 * a trading day, in local wall-clock minutes:
 *
 *   [00:00, preOpen)                      closed
 *   [preOpen, open)                       pre      (closed when the subject has no pre/post session)
 *   [open, open + openingAuction)         auction  (0 min by default: the opening print is the open)
 *   [open + openingAuction, close − closingAuction)   open
 *   [close − closingAuction, close)       auction  (the closing-auction imbalance window: 10 min on
 *                                                  the US equity/option calendars, 15:50-16:00 ET,
 *                                                  12:50-13:00 on an early close; 0 elsewhere)
 *   [close, postClose)                    post     (closed when the subject has no pre/post session)
 *   [postClose, 24:00)                    closed
 *
 * Weekends and full closures are `closed` all day. `halted` is a venue signal carried by the feed
 * (`NormalisedUpdate.session`), never inferred from a calendar, so this function never returns it.
 * `unknown` is returned when the calendar has no session template at all (the `WEEKEND` calendar) or
 * when its time zone is not one this module can convert — never a guess.
 *
 * **Time zone rule.** `packages/core` is pure and has no `Intl` dependency on this path; the local
 * wall clock is computed from a documented offset table ({@link utcOffsetMinutes}):
 *
 *   - US zones (`America/New_York` −05:00, `America/Chicago` −06:00, `America/Los_Angeles` −08:00):
 *     daylight time (+1 h) from the second Sunday of March at 02:00 local standard time to the first
 *     Sunday of November at 02:00 local daylight time (the Energy Policy Act rule, 2007 onwards);
 *     from 1987 to 2006 the first Sunday of April to the last Sunday of October.
 *   - EU zones (`Europe/London` +00:00, `Europe/Frankfurt` / `Europe/Paris` / `Europe/Berlin` /
 *     `Europe/Brussels` +01:00): summer time from the last Sunday of March 01:00 UTC to the last
 *     Sunday of October 01:00 UTC (the harmonised EU rule, 1996 onwards, applied to every year).
 *   - `UTC` / `Etc/UTC`: no offset.
 *
 * The offset in force at `nowMs` is used to read the local date and minute; no session boundary
 * sits inside a transition hour (02:00-03:00 local), so comparing local minutes is exact.
 */

import type { Calendar, IsoDate, LocalTime } from '../calendars/calendar.js';
import {
  SUNDAY,
  dayOfWeek,
  fromEpochDay,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
  parseIsoDate,
  toEpochDay,
} from '../calendars/calendar.js';
import type { SessionState } from '../types/quote.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1440;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Time zones
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ZoneRule {
  /** Standard offset from UTC in minutes (east positive). */
  readonly standardMinutes: number;
  readonly dst: 'us' | 'eu' | 'none';
}

const ZONES: Readonly<Record<string, ZoneRule>> = {
  UTC: { standardMinutes: 0, dst: 'none' },
  'Etc/UTC': { standardMinutes: 0, dst: 'none' },
  'America/New_York': { standardMinutes: -300, dst: 'us' },
  'America/Chicago': { standardMinutes: -360, dst: 'us' },
  'America/Los_Angeles': { standardMinutes: -480, dst: 'us' },
  'Europe/London': { standardMinutes: 0, dst: 'eu' },
  'Europe/Frankfurt': { standardMinutes: 60, dst: 'eu' },
  'Europe/Berlin': { standardMinutes: 60, dst: 'eu' },
  'Europe/Paris': { standardMinutes: 60, dst: 'eu' },
  'Europe/Brussels': { standardMinutes: 60, dst: 'eu' },
};

/** IANA zone names {@link utcOffsetMinutes} can convert. */
export const SUPPORTED_ZONES: readonly string[] = Object.keys(ZONES);

/** UTC instant of `date` at local midnight for a zone whose offset is `offsetMinutes`. */
function localMidnightUtc(date: IsoDate, offsetMinutes: number): number {
  return toEpochDay(date) * MS_PER_DAY - offsetMinutes * MS_PER_MINUTE;
}

/** `[start, end)` of daylight time in UTC ms for `year`, or `undefined` when the zone has none. */
function dstWindowUtc(rule: ZoneRule, year: number): readonly [number, number] | undefined {
  if (rule.dst === 'us') {
    if (year < 1987) return undefined;
    const start = year >= 2007 ? nthWeekdayOfMonth(year, 3, SUNDAY, 2) : nthWeekdayOfMonth(year, 4, SUNDAY, 1);
    const end = year >= 2007 ? nthWeekdayOfMonth(year, 11, SUNDAY, 1) : lastWeekdayOfMonth(year, 10, SUNDAY);
    // 02:00 standard time → 02:00 daylight time (= 01:00 standard).
    const startUtc = localMidnightUtc(start, rule.standardMinutes) + 120 * MS_PER_MINUTE;
    const endUtc = localMidnightUtc(end, rule.standardMinutes + 60) + 120 * MS_PER_MINUTE;
    return [startUtc, endUtc];
  }
  if (rule.dst === 'eu') {
    const start = lastWeekdayOfMonth(year, 3, SUNDAY);
    const end = lastWeekdayOfMonth(year, 10, SUNDAY);
    // Both transitions are at 01:00 UTC regardless of the zone's standard offset.
    return [toEpochDay(start) * MS_PER_DAY + 60 * MS_PER_MINUTE, toEpochDay(end) * MS_PER_DAY + 60 * MS_PER_MINUTE];
  }
  return undefined;
}

/**
 * Offset from UTC in minutes (east positive) in force at `utcMs` for `tz`, or `undefined` for a
 * zone outside {@link SUPPORTED_ZONES}.
 */
export function utcOffsetMinutes(tz: string, utcMs: number): number | undefined {
  const rule = ZONES[tz];
  if (rule === undefined) return undefined;
  if (rule.dst === 'none') return rule.standardMinutes;
  // The UTC year is the local year at every transition instant, which is all the window needs.
  const year = parseIsoDate(fromEpochDay(Math.floor(utcMs / MS_PER_DAY))).year;
  const window = dstWindowUtc(rule, year);
  if (window === undefined) return rule.standardMinutes;
  const [start, end] = window;
  return utcMs >= start && utcMs < end ? rule.standardMinutes + 60 : rule.standardMinutes;
}

/** The local calendar date and minute of day at `utcMs` in `tz`; `undefined` for an unsupported zone. */
export function localClock(tz: string, utcMs: number): { date: IsoDate; minuteOfDay: number } | undefined {
  const offset = utcOffsetMinutes(tz, utcMs);
  if (offset === undefined) return undefined;
  const localMs = utcMs + offset * MS_PER_MINUTE;
  const epochDay = Math.floor(localMs / MS_PER_DAY);
  const minuteOfDay = Math.floor((localMs - epochDay * MS_PER_DAY) / MS_PER_MINUTE);
  return { date: fromEpochDay(epochDay), minuteOfDay };
}

/** Epoch ms of local `time` ('HH:MM', '24:00' allowed) on local `date` in `tz`; `undefined` for an unsupported zone. */
export function localTimeToUtc(tz: string, date: IsoDate, time: LocalTime): number | undefined {
  const rule = ZONES[tz];
  if (rule === undefined) return undefined;
  const standardGuess = localMidnightUtc(date, rule.standardMinutes) + localMinutes(time) * MS_PER_MINUTE;
  // Re-read the offset at the guessed instant: correct everywhere outside the transition hour.
  const offset = utcOffsetMinutes(tz, standardGuess) ?? rule.standardMinutes;
  return localMidnightUtc(date, offset) + localMinutes(time) * MS_PER_MINUTE;
}

/** Minutes since local midnight of an `'HH:MM'` time. `'24:00'` is 1440. */
export function localMinutes(time: LocalTime): number {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (m === null) throw new RangeError(`localMinutes: not an HH:MM time: '${time}'`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 24 || mm > 59 || (hh === 24 && mm !== 0)) {
    throw new RangeError(`localMinutes: out of range: '${time}'`);
  }
  return hh * 60 + mm;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The SessionCalendar adapter
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Local session times of one trading day; `close` is already the early-close time on a shortened
 * day and `postClose` is shortened with it (13:00 close → 17:00 post-close end on NYSE).
 */
export interface SessionTimes {
  readonly preOpen: LocalTime | null;
  readonly open: LocalTime;
  readonly close: LocalTime;
  readonly postClose: LocalTime | null;
  /** `true` on an `early_close` day (`calendar_holidays.close_time`). */
  readonly earlyClose: boolean;
}

export type SessionDay =
  | { readonly kind: 'trading'; readonly times: SessionTimes }
  /** weekend, holiday, or a weekday the template does not trade */
  | { readonly kind: 'closed' }
  /** the calendar has no session template */
  | { readonly kind: 'unknown' };

/**
 * What `sessionState` needs from a calendar. `sessionCalendar()` builds one from a
 * `core/calendars` {@link Calendar}; tests may hand-roll one.
 */
export interface SessionCalendar {
  /** IANA zone of the local times (`calendars.tz`). */
  readonly tz: string;
  /** Minutes after `open` reported as `auction` (the opening auction). */
  readonly openingAuctionMinutes: number;
  /** Minutes before `close` reported as `auction` (the closing-auction imbalance window). */
  readonly closingAuctionMinutes: number;
  /** Trading day, closed day, or unknown, for a local date. */
  sessionDay(date: IsoDate): SessionDay;
  /** `sessionDay(date).kind === 'trading'`. */
  isTradingDay(date: IsoDate): boolean;
  /** The local close (early-close aware) of a trading day; `undefined` otherwise. */
  closeTime(date: IsoDate): LocalTime | undefined;
}

export interface SessionCalendarOptions {
  /** Default 0. */
  openingAuctionMinutes?: number;
  /** Default 10 for `kind: 'exchange'` calendars, 0 otherwise. */
  closingAuctionMinutes?: number;
}

/** The NYSE/Nasdaq/Cboe closing-auction imbalance window: MOC/LOC imbalances publish from 15:50 ET. */
export const EXCHANGE_CLOSING_AUCTION_MINUTES = 10;

/**
 * Longest extended-hours window kept after an early close. US equity venues end extended-hours
 * trading at 17:00 ET on a 13:00 half day — four hours after the close, the same span as the
 * regular day's 16:00 → 20:00 — so the template's own span is carried over, capped here.
 */
export const EARLY_CLOSE_POST_MAX_MINUTES = 240;

/** `'HH:MM'` of `minutes` since local midnight (1440 → `'24:00'`). */
function formatLocalTime(minutes: number): LocalTime {
  const m = Math.min(Math.max(Math.round(minutes), 0), MINUTES_PER_DAY);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * The post-close end of a trading day. On a regular day it is the template's own `postClose`; on an
 * early close the extended session is shortened by the same amount as the regular session, so the
 * post window keeps its span (capped at {@link EARLY_CLOSE_POST_MAX_MINUTES}) measured from the
 * early close — 13:00 close → 17:00 post-close end on NYSE, not the template's 20:00.
 */
function earlyPostClose(
  templateClose: LocalTime,
  templatePostClose: LocalTime | null,
  close: LocalTime,
  isEarly: boolean,
): LocalTime | null {
  if (templatePostClose === null) return null;
  if (!isEarly) return templatePostClose;
  const span = Math.min(
    Math.max(localMinutes(templatePostClose) - localMinutes(templateClose), 0),
    EARLY_CLOSE_POST_MAX_MINUTES,
  );
  return formatLocalTime(localMinutes(close) + span);
}

/** Adapter over a `core/calendars` {@link Calendar}: holidays, early closes and the weekday template. */
export function sessionCalendar(cal: Calendar, opts: SessionCalendarOptions = {}): SessionCalendar {
  const template = cal.sessions();
  const byWeekday = new Map(template.map((s) => [s.weekday, s]));
  const openingAuctionMinutes = opts.openingAuctionMinutes ?? 0;
  const closingAuctionMinutes =
    opts.closingAuctionMinutes ?? (cal.kind === 'exchange' ? EXCHANGE_CLOSING_AUCTION_MINUTES : 0);

  const sessionDay = (date: IsoDate): SessionDay => {
    if (template.length === 0) return { kind: 'unknown' };
    if (!cal.isBusinessDay(date)) return { kind: 'closed' };
    const s = byWeekday.get(dayOfWeek(date));
    if (s?.openTime == null || s.closeTime === null) return { kind: 'closed' };
    const early = cal.earlyClose(date);
    const close = early?.closeTime ?? s.closeTime;
    return {
      kind: 'trading',
      times: {
        preOpen: s.preOpen,
        open: s.openTime,
        close,
        postClose: earlyPostClose(s.closeTime, s.postClose, close, early !== undefined),
        earlyClose: early !== undefined,
      },
    };
  };

  return {
    tz: cal.tz,
    openingAuctionMinutes,
    closingAuctionMinutes,
    sessionDay,
    isTradingDay: (date) => sessionDay(date).kind === 'trading',
    closeTime: (date) => {
      const day = sessionDay(date);
      return day.kind === 'trading' ? day.times.close : undefined;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. sessionState
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The phase of `times` at local `minuteOfDay`. Exported for the phase table's own tests. */
export function phaseAt(
  times: SessionTimes,
  minuteOfDay: number,
  hasPrePost: boolean,
  auction: { opening: number; closing: number },
): SessionState {
  const open = localMinutes(times.open);
  const close = localMinutes(times.close);
  const preOpen = times.preOpen === null ? open : Math.min(localMinutes(times.preOpen), open);
  const postClose = times.postClose === null ? close : Math.max(localMinutes(times.postClose), close);
  const m = Math.min(Math.max(minuteOfDay, 0), MINUTES_PER_DAY);

  if (m < preOpen) return 'closed';
  if (m < open) return hasPrePost ? 'pre' : 'closed';
  const openingEnd = Math.min(open + Math.max(auction.opening, 0), close);
  const closingStart = Math.max(close - Math.max(auction.closing, 0), openingEnd);
  if (m < openingEnd) return 'auction';
  if (m < closingStart) return 'open';
  if (m < close) return 'auction';
  if (m < postClose) return hasPrePost ? 'post' : 'closed';
  return 'closed';
}

/**
 * FEED-06: the session state of a subject on `calendar` at `nowMs`. `hasPrePost` says whether the
 * subject trades an extended session (US equities do; indices and options do not), which turns the
 * pre-open and post-close windows into `pre` / `post` rather than `closed`.
 */
export function sessionState(calendar: SessionCalendar, nowMs: number, hasPrePost: boolean): SessionState {
  const local = localClock(calendar.tz, nowMs);
  if (local === undefined) return 'unknown';
  const day = calendar.sessionDay(local.date);
  if (day.kind === 'unknown') return 'unknown';
  if (day.kind === 'closed') return 'closed';
  return phaseAt(day.times, local.minuteOfDay, hasPrePost, {
    opening: calendar.openingAuctionMinutes,
    closing: calendar.closingAuctionMinutes,
  });
}
