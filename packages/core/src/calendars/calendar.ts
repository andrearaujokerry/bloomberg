/**
 * Calendars, part 1: the date utility layer and the `Calendar` contract (REF-06).
 *
 * `packages/core` is pure and clock-free: `Date`, `new Date()` and `Date.now` are banned globals in
 * `packages/core/src/**` (ARCHITECTURE L49, L120). Every date in this layer is therefore an **ISO
 * date string** `'YYYY-MM-DD'` — the exact shape of a Postgres `date` column — and all arithmetic
 * goes through a proleptic-Gregorian epoch-day conversion (Howard Hinnant's `days_from_civil` /
 * `civil_from_days`), which is exact for every year in and far outside the 1990-2040 window.
 *
 * Calendars are **rule generators**, not tables (WORKPLAN L493-497): every holiday is derived from a
 * rule for the requested year, memoised per year. WP-15's `seed/universe.ts` materialises
 * `calendars`, `calendar_sessions` and the ≈1,300 `calendar_holidays` rows by walking
 * `Calendar.holidays(fromYear, toYear)` over `CALENDAR_SEED_YEARS`, so the generator output *is* the
 * contract and `Calendar.id` must be one of `CALENDAR_IDS` verbatim.
 *
 * Nothing here imports `tenor.ts`: tenor arithmetic builds on this module, never the other way
 * round, so the calendar layer stays acyclic.
 */

/** A calendar date as `'YYYY-MM-DD'`. The wire and storage form of every date in the system. */
export type IsoDate = string;

/** A wall-clock time of day as `'HH:MM'`, local to the calendar's `tz`. */
export type LocalTime = string;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Date utility layer — ISO date strings in, ISO date strings out, no Date object anywhere.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^(-?\d{4,6})-(\d{2})-(\d{2})$/;

/** The calendar fields of an ISO date. `month` is 1-12, `day` is 1-31. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Proleptic-Gregorian leap-year test. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Number of days in `month` (1-12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`daysInMonth: month out of range: ${String(month)}`);
  }
  if (month === 2 && isLeapYear(year)) return 29;
  // `month - 1` is in [0, 11] and MONTH_LENGTHS has 12 entries, so the lookup is total; the `?? 0`
  // only satisfies noUncheckedIndexedAccess.
  return MONTH_LENGTHS[month - 1] ?? 0;
}

/** Zero-pad an integer to `width` digits (non-negative inputs only). */
function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/** Format calendar fields as an ISO date. Throws when the fields are not a real date. */
export function formatIsoDate(year: number, month: number, day: number): IsoDate {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new RangeError(`formatIsoDate: non-integer field in ${year}-${month}-${day}`);
  }
  if (month < 1 || month > 12) throw new RangeError(`formatIsoDate: bad month ${String(month)}`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`formatIsoDate: bad day ${String(day)} for ${String(year)}-${pad(month, 2)}`);
  }
  const y = year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
  return `${y}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Split an ISO date into calendar fields. Throws on anything that is not a real `'YYYY-MM-DD'`. */
export function parseIsoDate(date: IsoDate): CivilDate {
  const m = ISO_DATE_RE.exec(date);
  if (m === null) throw new RangeError(`parseIsoDate: not an ISO date: ${JSON.stringify(date)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`parseIsoDate: not a real calendar date: ${date}`);
  }
  return { year, month, day };
}

/** True when `value` is a syntactically valid, real ISO calendar date. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Days since the Unix epoch (1970-01-01 = 0), proleptic Gregorian.
 * Hinnant, "chrono-Compatible Low-Level Date Algorithms" — exact for every year.
 */
export function toEpochDay(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Inverse of {@link toEpochDay}. */
export function fromEpochDay(epochDay: number): IsoDate {
  if (!Number.isInteger(epochDay)) {
    throw new RangeError(`fromEpochDay: not an integer: ${String(epochDay)}`);
  }
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  ); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const month = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return formatIsoDate(month <= 2 ? y + 1 : y, month, day);
}

/**
 * Day of week, **0 = Sunday … 6 = Saturday** — the encoding of `calendar_sessions.weekday`
 * (CONTRACTS L112: "weekday smallint CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday").
 */
export function dayOfWeek(date: IsoDate): number {
  // 1970-01-01 (epoch day 0) was a Thursday = 4.
  return (((toEpochDay(date) + 4) % 7) + 7) % 7;
}

/** Weekday constants for {@link dayOfWeek}. */
export const SUNDAY = 0;
export const MONDAY = 1;
export const TUESDAY = 2;
export const WEDNESDAY = 3;
export const THURSDAY = 4;
export const FRIDAY = 5;
export const SATURDAY = 6;

/** 1-based day of the year (1 on 1 January). */
export function dayOfYear(date: IsoDate): number {
  const { year } = parseIsoDate(date);
  return toEpochDay(date) - toEpochDay(formatIsoDate(year, 1, 1)) + 1;
}

/** `date` shifted by `days` calendar days (negative shifts backwards). */
export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days)) throw new RangeError(`addDays: non-integer days ${String(days)}`);
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * `date` shifted by `months` calendar months, clamping the day to the end of the target month —
 * 2026-01-31 + 1M = 2026-02-28. This is the schedule-generation rule used by bond and swap
 * schedules; the end-of-month roll is applied separately by the caller.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  if (!Number.isInteger(months)) throw new RangeError(`addMonths: non-integer ${String(months)}`);
  const { year, month, day } = parseIsoDate(date);
  const total = year * 12 + (month - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return formatIsoDate(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

/** `date` shifted by whole years, clamping 29 February to 28 February in a non-leap year. */
export function addYears(date: IsoDate, years: number): IsoDate {
  return addMonths(date, years * 12);
}

/** Last day of `date`'s month. */
export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(date);
  return formatIsoDate(year, month, daysInMonth(year, month));
}

/** First day of `date`'s month. */
export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(date);
  return formatIsoDate(year, month, 1);
}

/** True when `date` is the last day of its month. */
export function isEndOfMonth(date: IsoDate): boolean {
  const { year, month, day } = parseIsoDate(date);
  return day === daysInMonth(year, month);
}

/** Signed count of calendar days from `from` to `to` (`to − from`). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** `-1 | 0 | 1` ordering of two ISO dates. Lexicographic order agrees, but this validates too. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  const d = toEpochDay(a) - toEpochDay(b);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/** The earlier of two dates. */
export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareDates(a, b) <= 0 ? a : b;
}

/** The later of two dates. */
export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return compareDates(a, b) >= 0 ? a : b;
}

/** Every calendar date in `[from, to]`, inclusive. */
export function datesInRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  const last = toEpochDay(to);
  for (let d = toEpochDay(from); d <= last; d++) out.push(fromEpochDay(d));
  return out;
}

/**
 * The `n`-th `weekday` of a month (n ≥ 1): `nthWeekdayOfMonth(2026, 11, THURSDAY, 4)` is
 * Thanksgiving 2026.
 */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): IsoDate {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`nthWeekdayOfMonth: bad n ${String(n)}`);
  const first = formatIsoDate(year, month, 1);
  const shift = (((weekday - dayOfWeek(first)) % 7) + 7) % 7;
  const day = 1 + shift + (n - 1) * 7;
  if (day > daysInMonth(year, month)) {
    throw new RangeError(`nthWeekdayOfMonth: ${String(year)}-${pad(month, 2)} has no ${String(n)}th weekday ${String(weekday)}`);
  }
  return formatIsoDate(year, month, day);
}

/** The last `weekday` of a month: `lastWeekdayOfMonth(2026, 5, MONDAY)` is Memorial Day 2026. */
export function lastWeekdayOfMonth(year: number, month: number, weekday: number): IsoDate {
  const last = formatIsoDate(year, month, daysInMonth(year, month));
  const back = (((dayOfWeek(last) - weekday) % 7) + 7) % 7;
  return addDays(last, -back);
}

/**
 * Easter Sunday in the Gregorian calendar (the "anonymous Gregorian" / Meeus-Jones-Butcher
 * algorithm). Good Friday, Easter Monday and — through them — the NYSE, SIFMA, TARGET2 and XLON
 * moveable feasts are all derived from this.
 */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatIsoDate(year, month, day);
}

/** Good Friday = Easter Sunday − 2 days. */
export function goodFriday(year: number): IsoDate {
  return addDays(easterSunday(year), -2);
}

/** Easter Monday = Easter Sunday + 1 day. */
export function easterMonday(year: number): IsoDate {
  return addDays(easterSunday(year), 1);
}

/** Maundy (Holy) Thursday = Easter Sunday − 3 days. */
export function maundyThursday(year: number): IsoDate {
  return addDays(easterSunday(year), -3);
}

/** How a calendar moves a holiday that lands on a weekend. */
export interface ObservanceRule {
  /** What to do when the holiday falls on a Saturday. */
  readonly saturday: 'previous-friday' | 'none';
  /** What to do when the holiday falls on a Sunday. */
  readonly sunday: 'next-monday' | 'none';
}

/**
 * US market observance (NYSE Rule 7.2, and SIFMA's recommendation): a Saturday holiday is taken on
 * the preceding Friday, a Sunday holiday on the following Monday.
 */
export const US_MARKET_OBSERVANCE: ObservanceRule = {
  saturday: 'previous-friday',
  sunday: 'next-monday',
};

/**
 * US market observance with the New Year's Day exception: when 1 January falls on a Saturday the
 * exchange does **not** close on 31 December of the previous year (31 December 2021 and
 * 31 December 2010 were both full trading days).
 */
export const US_MARKET_OBSERVANCE_NO_SATURDAY: ObservanceRule = {
  saturday: 'none',
  sunday: 'next-monday',
};

/** Holidays that do not move at all — TARGET2 never shifts a weekend holiday. */
export const NO_OBSERVANCE: ObservanceRule = { saturday: 'none', sunday: 'none' };

/**
 * Apply an observance rule to a fixed-date holiday. Returns `undefined` when the rule drops the
 * holiday entirely (a Saturday holiday under `saturday: 'none'`).
 */
export function observed(date: IsoDate, rule: ObservanceRule): IsoDate | undefined {
  const dow = dayOfWeek(date);
  if (dow === SATURDAY) return rule.saturday === 'previous-friday' ? addDays(date, -1) : undefined;
  if (dow === SUNDAY) return rule.sunday === 'next-monday' ? addDays(date, 1) : undefined;
  return date;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The Calendar contract.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The nine seeded calendars, verbatim from `calendars.calendar_id`
 * (CONTRACTS L110 / DATA_MODEL §5). WP-15 seeds exactly these ids.
 */
export const CALENDAR_IDS = [
  'XNYS',
  'XNAS',
  'XCBO',
  'SIFMA',
  'USGOVT',
  'FX_USD',
  'TARGET2',
  'XLON',
  'WEEKEND',
] as const;

/** One of the nine seeded `calendars.calendar_id` values. */
export type CalendarId = (typeof CALENDAR_IDS)[number];

/** `calendars.kind` CHECK (CONTRACTS L110). */
export type CalendarKind = 'exchange' | 'settlement' | 'currency' | 'government' | 'weekend';

/** True when `value` is one of the nine seeded calendar ids. */
export function isCalendarId(value: unknown): value is CalendarId {
  return typeof value === 'string' && (CALENDAR_IDS as readonly string[]).includes(value);
}

/** The year range the generators are the contract over (WORKPLAN L493-494). */
export const CALENDAR_SEED_YEARS = { from: 1990, to: 2040 } as const;

/**
 * One `calendar_holidays` row: a full closure (`closed`) or a shortened session (`early_close`,
 * whose `closeTime` is `calendar_holidays.close_time` — 13:00 on NYSE early closes, 14:00 SIFMA).
 */
export interface CalendarHoliday {
  readonly day: IsoDate;
  readonly name: string;
  readonly kind: 'closed' | 'early_close';
  readonly closeTime?: LocalTime;
}

/** One `calendar_sessions` row: the regular weekly session template, local to the calendar's `tz`. */
export interface CalendarSession {
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
  readonly preOpen: LocalTime | null;
  readonly openTime: LocalTime | null;
  readonly closeTime: LocalTime | null;
  readonly postClose: LocalTime | null;
}

/**
 * A rule-generated calendar (REF-06). Implementations are pure and memoised: the same query always
 * returns the same answer, which is what lets WP-15 seed from them and the server cache them.
 */
export interface Calendar {
  /** `calendars.calendar_id`. One of {@link CALENDAR_IDS} for a seeded calendar; a `'A+B'` join for {@link combine}. */
  readonly id: string;
  /** `calendars.name`. */
  readonly name: string;
  /** IANA zone of the calendar's local times, `calendars.tz`. */
  readonly tz: string;
  /** `calendars.kind`. */
  readonly kind: CalendarKind;
  /** Saturday or Sunday (every calendar here uses the Sat/Sun weekend). */
  isWeekend(date: IsoDate): boolean;
  /** A full closure. Early closes are **not** holidays — they are business days. */
  isHoliday(date: IsoDate): boolean;
  /** Not a weekend and not a holiday. */
  isBusinessDay(date: IsoDate): boolean;
  /** The holiday name when `date` is a full closure, else `undefined`. */
  holidayName(date: IsoDate): string | undefined;
  /** The `early_close` row when `date` is a shortened session, else `undefined`. */
  earlyClose(date: IsoDate): CalendarHoliday | undefined;
  /** Every `closed` and `early_close` row in `[fromYear, toYear]`, ascending by day. */
  holidays(fromYear: number, toYear: number): CalendarHoliday[];
  /** The `calendar_sessions` template. */
  sessions(): readonly CalendarSession[];
}

/**
 * The rule a calendar is built from: every holiday and early close whose *rule* belongs to `year`.
 * A rule may legitimately return a day in the neighbouring year (a federal New Year's Day observed
 * on 31 December); {@link makeRuleCalendar} evaluates `year-1 … year+1` and re-buckets by the day's
 * own year, so such a rule is written naturally.
 */
export type HolidayRule = (year: number) => CalendarHoliday[];

/** Definition passed to {@link makeRuleCalendar}. */
export interface RuleCalendarSpec {
  readonly id: string;
  readonly name: string;
  readonly tz: string;
  readonly kind: CalendarKind;
  readonly rule: HolidayRule;
  readonly sessions?: readonly CalendarSession[];
}

/** The standard Monday-Friday session template used by the US equity/option calendars. */
export function weekdaySessions(session: {
  preOpen?: LocalTime;
  open: LocalTime;
  close: LocalTime;
  postClose?: LocalTime;
}): readonly CalendarSession[] {
  const out: CalendarSession[] = [];
  for (let weekday = MONDAY; weekday <= FRIDAY; weekday++) {
    out.push({
      weekday,
      preOpen: session.preOpen ?? null,
      openTime: session.open,
      closeTime: session.close,
      postClose: session.postClose ?? null,
    });
  }
  return out;
}

/** True for Saturday and Sunday. */
export function isWeekendDay(date: IsoDate): boolean {
  const dow = dayOfWeek(date);
  return dow === SATURDAY || dow === SUNDAY;
}

/**
 * Build a memoised {@link Calendar} from a per-year holiday rule.
 *
 * Deduplication is deliberate and total: if a rule emits the same day twice (Christmas Day observed
 * on the day Boxing Day is also observed, say) the first `closed` entry wins, and an `early_close`
 * never survives on a day that is also `closed` — an exchange that is shut is not open until 13:00.
 */
export function makeRuleCalendar(spec: RuleCalendarSpec): Calendar {
  const cache = new Map<number, Map<IsoDate, CalendarHoliday>>();

  const indexFor = (year: number): Map<IsoDate, CalendarHoliday> => {
    const hit = cache.get(year);
    if (hit !== undefined) return hit;

    const closed = new Map<IsoDate, CalendarHoliday>();
    const early = new Map<IsoDate, CalendarHoliday>();
    for (let y = year - 1; y <= year + 1; y++) {
      for (const h of spec.rule(y)) {
        if (parseIsoDate(h.day).year !== year) continue;
        // A holiday that lands on a weekend is not a session at all; recording it would double-count
        // the closure and inflate the seeded calendar_holidays row count.
        if (isWeekendDay(h.day)) continue;
        const bucket = h.kind === 'closed' ? closed : early;
        if (!bucket.has(h.day)) bucket.set(h.day, h);
      }
    }
    const index = new Map<IsoDate, CalendarHoliday>(closed);
    for (const [day, h] of early) if (!index.has(day)) index.set(day, h);
    cache.set(year, index);
    return index;
  };

  const entry = (date: IsoDate): CalendarHoliday | undefined =>
    indexFor(parseIsoDate(date).year).get(date);

  const sessions = spec.sessions ?? [];

  return {
    id: spec.id,
    name: spec.name,
    tz: spec.tz,
    kind: spec.kind,
    isWeekend: (date) => isWeekendDay(date),
    isHoliday: (date) => !isWeekendDay(date) && entry(date)?.kind === 'closed',
    isBusinessDay(date) {
      return !isWeekendDay(date) && entry(date)?.kind !== 'closed';
    },
    holidayName(date) {
      const e = entry(date);
      return e?.kind === 'closed' ? e.name : undefined;
    },
    earlyClose(date) {
      if (isWeekendDay(date)) return undefined;
      const e = entry(date);
      return e?.kind === 'early_close' ? e : undefined;
    },
    holidays(fromYear, toYear) {
      const out: CalendarHoliday[] = [];
      for (let y = fromYear; y <= toYear; y++) out.push(...indexFor(y).values());
      return out.sort((a, b) => compareDates(a.day, b.day));
    },
    sessions: () => sessions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. Business-day arithmetic and the business-day conventions.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `govt_terms.business_day_conv` CHECK (CONTRACTS L75, WORKPLAN L500). Re-exported from
 * `daycount/businessDay.ts`, which is the contract-facing module for the schedule layer.
 */
export const BUSINESS_DAY_CONVENTIONS = [
  'following',
  'modified_following',
  'preceding',
  'none',
] as const;

/** One of the four `govt_terms.business_day_conv` values. */
export type BusinessDayConvention = (typeof BUSINESS_DAY_CONVENTIONS)[number];

/** True when `value` is one of the four business-day conventions. */
export function isBusinessDayConvention(value: unknown): value is BusinessDayConvention {
  return typeof value === 'string' && (BUSINESS_DAY_CONVENTIONS as readonly string[]).includes(value);
}

/** A calendar can never have more than this many consecutive non-business days. */
const MAX_ROLL = 400;

/** Not a weekend and not a holiday on `cal`. */
export function isBusinessDay(cal: Calendar, date: IsoDate): boolean {
  return cal.isBusinessDay(date);
}

/** The next business day strictly after `date`. */
export function nextBusinessDay(cal: Calendar, date: IsoDate): IsoDate {
  let d = addDays(date, 1);
  for (let i = 0; i < MAX_ROLL; i++) {
    if (cal.isBusinessDay(d)) return d;
    d = addDays(d, 1);
  }
  throw new RangeError(`nextBusinessDay: no business day within ${String(MAX_ROLL)} days of ${date} on ${cal.id}`);
}

/** The last business day strictly before `date`. */
export function previousBusinessDay(cal: Calendar, date: IsoDate): IsoDate {
  let d = addDays(date, -1);
  for (let i = 0; i < MAX_ROLL; i++) {
    if (cal.isBusinessDay(d)) return d;
    d = addDays(d, -1);
  }
  throw new RangeError(`previousBusinessDay: no business day within ${String(MAX_ROLL)} days of ${date} on ${cal.id}`);
}

/**
 * Roll `date` to a business day under a business-day convention.
 *
 * - `following` — first business day on or after `date`.
 * - `modified_following` — as `following`, unless that crosses into the next **month**, in which
 *   case roll backwards instead. The convention Treasury notes and SOFR OIS settle on.
 * - `preceding` — last business day on or before `date`.
 * - `none` — the date is returned untouched, even when it is a Sunday.
 */
export function adjust(cal: Calendar, date: IsoDate, bdc: BusinessDayConvention): IsoDate {
  if (bdc === 'none') return date;
  if (cal.isBusinessDay(date)) return date;
  if (bdc === 'preceding') return previousBusinessDay(cal, date);
  const forward = nextBusinessDay(cal, date);
  if (bdc === 'following') return forward;
  // modified_following
  return parseIsoDate(forward).month === parseIsoDate(date).month
    ? forward
    : previousBusinessDay(cal, date);
}

/**
 * Move `n` business days from `date`. `n = 0` returns the first business day on or after `date`
 * (the `following` roll), which is what a T+0 settlement rule means; `n > 0` steps forward,
 * `n < 0` backwards.
 */
export function addBusinessDays(cal: Calendar, date: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n)) throw new RangeError(`addBusinessDays: non-integer n ${String(n)}`);
  if (n === 0) return adjust(cal, date, 'following');
  let d = date;
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    d = addDays(d, step);
    if (cal.isBusinessDay(d)) remaining--;
  }
  return d;
}

/** Business days in `[from, to)` — the count `addBusinessDays(cal, from, k)` inverts. */
export function businessDaysBetween(cal: Calendar, from: IsoDate, to: IsoDate): number {
  const sign = compareDates(from, to) <= 0 ? 1 : -1;
  const lo = sign === 1 ? from : to;
  const hi = sign === 1 ? to : from;
  let count = 0;
  for (let d = toEpochDay(lo); d < toEpochDay(hi); d++) {
    if (cal.isBusinessDay(fromEpochDay(d))) count++;
  }
  return count * sign;
}

/** Every business day in `[from, to]`, inclusive. */
export function businessDaysInRange(cal: Calendar, from: IsoDate, to: IsoDate): IsoDate[] {
  return datesInRange(from, to).filter((d) => cal.isBusinessDay(d));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. combine() — the union of holidays (REF-06, DATA_MODEL L953).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Optional overrides for the identity of a combined calendar. */
export interface CombineOptions {
  readonly id?: string;
  readonly name?: string;
  readonly tz?: string;
  readonly kind?: CalendarKind;
}

/**
 * Union of holidays (REF-06): a day is a business day on the combined calendar only when it is a
 * business day on **every** input calendar. This is how every analytic builds an FX or settlement
 * calendar — `combine([FX_USD, TARGET2])` is the EURUSD settlement calendar, `combine([SIFMA,
 * USGOVT])` the Treasury settlement calendar (DATA_MODEL L953).
 *
 * Early closes union too, and the earliest close wins: a day that is an early close on one
 * calendar and a full session on another is an early close on the union. A day that is a full
 * closure anywhere is `closed`, never `early_close`.
 */
export function combine(cals: readonly Calendar[], options: CombineOptions = {}): Calendar {
  if (cals.length === 0) throw new RangeError('combine: at least one calendar is required');
  const first = cals[0]!;
  if (cals.length === 1 && options.id === undefined) return first;

  const id = options.id ?? cals.map((c) => c.id).join('+');
  const name = options.name ?? `Union of ${cals.map((c) => c.id).join(', ')}`;

  return makeRuleCalendar({
    id,
    name,
    tz: options.tz ?? first.tz,
    kind: options.kind ?? 'settlement',
    sessions: first.sessions(),
    rule: (year) => {
      const closed = new Map<IsoDate, CalendarHoliday>();
      const early = new Map<IsoDate, CalendarHoliday>();
      for (const cal of cals) {
        for (const h of cal.holidays(year, year)) {
          if (h.kind === 'closed') {
            const prior = closed.get(h.day);
            closed.set(
              h.day,
              prior === undefined
                ? { day: h.day, name: `${h.name} (${cal.id})`, kind: 'closed' }
                : { day: h.day, name: `${prior.name} / ${h.name} (${cal.id})`, kind: 'closed' },
            );
          } else {
            const prior = early.get(h.day);
            const closeTime = h.closeTime;
            const take =
              prior?.closeTime === undefined ||
              (closeTime !== undefined && closeTime < prior.closeTime);
            if (take) {
              early.set(h.day, {
                day: h.day,
                name: `${h.name} (${cal.id})`,
                kind: 'early_close',
                ...(closeTime === undefined ? {} : { closeTime }),
              });
            }
          }
        }
      }
      const out = [...closed.values()];
      for (const [day, h] of early) if (!closed.has(day)) out.push(h);
      return out.sort((a, b) => compareDates(a.day, b.day));
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. Registry — REF-06's `GET /calendars/:calendarId` resolves through this.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, Calendar>();

/**
 * Register a calendar under its id. Each concrete calendar module self-registers on import, so
 * importing `calendars/nyse.js` makes `XNYS`, `XNAS` and `XCBO` resolvable by id.
 */
export function registerCalendar(cal: Calendar): Calendar {
  REGISTRY.set(cal.id, cal);
  return cal;
}

/** Look up a registered calendar, or `undefined` when its module has not been imported. */
export function findCalendar(id: string): Calendar | undefined {
  return REGISTRY.get(id);
}

/** Look up a registered calendar, throwing when it is unknown. */
export function getCalendar(id: string): Calendar {
  const cal = REGISTRY.get(id);
  if (cal === undefined) throw new RangeError(`getCalendar: unknown calendar_id ${JSON.stringify(id)}`);
  return cal;
}

/** Every registered calendar, ascending by id. */
export function registeredCalendars(): Calendar[] {
  return [...REGISTRY.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
