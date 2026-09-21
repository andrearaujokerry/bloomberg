/**
 * Calendars: database rows ⇄ `@terminal/core` `Calendar` objects — WORKPLAN WP-04 L694,
 * DATA_MODEL §5, CONTRACTS §1.2 L783-811, REF-06.
 *
 * WP-02's generators are the source of truth for the *rules* (`nyseHolidays`, `sifmaHolidays`,
 * `usFederalHolidays`, `target2Holidays`, `xlonHolidays`, `usdSettlementHolidays`). This module
 * does two things and neither of them is "decide when a market is shut":
 *
 *  1. **materialise** — write a rule calendar's sessions and its 1990-2040 holidays into
 *     `calendars` / `calendar_sessions` / `calendar_holidays`, so SQL can answer "is 2026-07-03 a
 *     business day" in a join instead of pulling a year of days into the process;
 *  2. **read back** — turn those rows into a `Calendar` again, so `daycount`, the bond analytics
 *     and the settlement-date arithmetic all run against *the rows the database holds*.
 *
 * The round trip is the point. If the analytics layer used the generator while a screen queried
 * `calendar_holidays`, a stale seed would show a closed market on a chart and an open one in a
 * settlement date, and nothing would fail — which is why {@link diffCalendars} exists and why
 * {@link readCalendar} never falls back to the generator when a row is missing.
 *
 * Neither `calendar_holidays` nor `calendar_sessions` is bitemporal (CONTRACTS §1.2): a holiday is
 * a fact about a day, keyed `(calendar_id, day)`, and a re-materialisation of the same rules is an
 * idempotent upsert rather than a new version. `calendar_holidays` carries the
 * `calendar_holidays_bump` trigger, so every write bumps `config_version` and the clients that
 * cache a calendar know to re-fetch it.
 *
 * ## Ad-hoc closures are never deleted
 *
 * Materialising a range upserts the rule's days and leaves every other row in that range alone.
 * A closure data ops added by hand (an unscheduled market closure) has no marker distinguishing
 * it from a rule day, so deleting "rows the rule did not produce" would silently erase it. The
 * generators already carry the historical one-offs they know about (`NYSE_AD_HOC_CLOSURES`,
 * `XLON_AD_HOC_CLOSURES`); anything later is the database's own knowledge and stays.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import {
  makeRuleCalendar,
  type Calendar,
  type CalendarHoliday,
  type CalendarKind,
  type CalendarSession,
  type IsoDate,
  type LocalTime,
} from '@terminal/core/calendars/calendar';

import type { Tx } from '../db/client.js';
import { calendarHolidays, calendars, calendarSessions } from '../db/schema/calendars.js';

/** `calendars.source_id` for a rule-generated calendar (CONTRACTS §1.2 L783). */
export const CALENDAR_SOURCE_ID = 'internal.derived';

/** `calendars.kind` CHECK — the same five values as core's `CalendarKind`. */
const CALENDAR_KINDS: readonly CalendarKind[] = [
  'exchange',
  'settlement',
  'currency',
  'government',
  'weekend',
];

/** The rows of one calendar, as the three tables hold them. */
export interface CalendarRows {
  calendarId: string;
  name: string;
  tz: string;
  kind: CalendarKind;
  sourceId: string;
  sessions: readonly CalendarSession[];
  holidays: readonly CalendarHoliday[];
}

/** How many rows a materialisation touched. */
export interface MaterialiseResult {
  calendarId: string;
  sessions: number;
  holidays: number;
  fromYear: number;
  toYear: number;
}

/** Thrown when the database holds a calendar this module cannot turn into a `Calendar`. */
export class CalendarRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarRowError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Local time normalisation
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Postgres `time` reads back as `HH:MM:SS`; core writes `LocalTime` as `HH:MM` (`'13:00'` is
 * `NYSE_EARLY_CLOSE_TIME`). Trim a zero seconds field so a materialise/read round trip compares
 * equal, and keep the seconds when there are any — a 13:00:30 close would be data, not noise.
 */
export function toLocalTime(value: string | null): LocalTime | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.endsWith(':00') && trimmed.length === 8 ? trimmed.slice(0, 5) : trimmed;
}

/** `LocalTime` → the `HH:MM:SS` Postgres stores. */
function toSqlTime(value: LocalTime | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
}

function asCalendarKind(value: string, calendarId: string): CalendarKind {
  const kind = CALENDAR_KINDS.find((k) => k === value);
  if (kind === undefined) {
    throw new CalendarRowError(
      `calendars.kind '${value}' on '${calendarId}' is not one of ${CALENDAR_KINDS.join(', ')} — ` +
        'the CHECK constraint of CONTRACTS §1.2 L783 and core CalendarKind disagree',
    );
  }
  return kind;
}

function asHolidayKind(value: string, calendarId: string, day: string): 'closed' | 'early_close' {
  if (value === 'closed' || value === 'early_close') return value;
  throw new CalendarRowError(
    `calendar_holidays.kind '${value}' on ('${calendarId}', ${day}) is neither 'closed' nor ` +
      "'early_close'",
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rule calendar → rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The rows a `Calendar` would be stored as over `[fromYear, toYear]`. */
export function calendarRows(
  cal: Calendar,
  fromYear: number,
  toYear: number,
  sourceId: string = CALENDAR_SOURCE_ID,
): CalendarRows {
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    throw new RangeError(
      `calendarRows(${cal.id}): [${fromYear}, ${toYear}] is not a non-empty year range`,
    );
  }
  return {
    calendarId: cal.id,
    name: cal.name,
    tz: cal.tz,
    kind: cal.kind,
    sourceId,
    sessions: cal.sessions(),
    holidays: cal.holidays(fromYear, toYear),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows → Calendar
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build a `Calendar` whose holidays are exactly `rows.holidays`.
 *
 * `makeRuleCalendar` supplies the memoised lookups, the weekend rule and the
 * `closed`-beats-`early_close` precedence, so a database-backed calendar and a rule calendar are
 * the same object to every caller — `isBusinessDay`, `earlyClose` and `combine` included. The
 * "rule" here is a lookup into the loaded rows, bucketed by the day's own year.
 *
 * A day outside the loaded range answers "business day", exactly as a rule calendar answers for a
 * year its rule does not cover. {@link readCalendar}'s default range is the 1990-2040 the seed
 * writes, and a caller asking beyond it must widen the range rather than trust the answer.
 */
export function calendarFromRows(rows: CalendarRows): Calendar {
  const byYear = new Map<number, CalendarHoliday[]>();
  for (const holiday of rows.holidays) {
    const year = Number(holiday.day.slice(0, 4));
    const bucket = byYear.get(year);
    if (bucket === undefined) byYear.set(year, [holiday]);
    else bucket.push(holiday);
  }
  return makeRuleCalendar({
    id: rows.calendarId,
    name: rows.name,
    tz: rows.tz,
    kind: rows.kind,
    sessions: rows.sessions,
    rule: (year) => byYear.get(year) ?? [],
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Postgres caps a statement at 65535 bound parameters; 500 five-column rows is nowhere near it. */
const INSERT_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Write one calendar's header, weekly session template and `[fromYear, toYear]` holidays.
 *
 * Every statement is an upsert keyed on the table's primary key, so running this twice writes the
 * same rows and changes nothing — `db:seed` and a calendar refresh are both idempotent. Session
 * rows for weekdays the template no longer covers ARE removed (the template is total over the
 * week and a stale Saturday session would open a market that is shut); holiday rows are never
 * removed, see the module note.
 */
export async function materialiseCalendar(
  tx: Tx,
  cal: Calendar,
  opts: { fromYear: number; toYear: number; sourceId?: string },
): Promise<MaterialiseResult> {
  const rows = calendarRows(cal, opts.fromYear, opts.toYear, opts.sourceId ?? CALENDAR_SOURCE_ID);

  await tx
    .insert(calendars)
    .values({
      calendarId: rows.calendarId,
      name: rows.name,
      tz: rows.tz,
      kind: rows.kind,
      sourceId: rows.sourceId,
    })
    .onConflictDoUpdate({
      target: calendars.calendarId,
      set: {
        name: sql`excluded.name`,
        tz: sql`excluded.tz`,
        kind: sql`excluded.kind`,
        sourceId: sql`excluded.source_id`,
      },
    });

  const sessionValues = rows.sessions.map((s) => ({
    calendarId: rows.calendarId,
    weekday: s.weekday,
    preOpen: toSqlTime(s.preOpen),
    // `open_time`/`close_time` are NOT NULL: a session row exists because the market opens.
    openTime: requireTime(rows.calendarId, s, 'openTime'),
    closeTime: requireTime(rows.calendarId, s, 'closeTime'),
    postClose: toSqlTime(s.postClose),
  }));

  if (sessionValues.length > 0) {
    await tx
      .insert(calendarSessions)
      .values(sessionValues)
      .onConflictDoUpdate({
        target: [calendarSessions.calendarId, calendarSessions.weekday],
        set: {
          preOpen: sql`excluded.pre_open`,
          openTime: sql`excluded.open_time`,
          closeTime: sql`excluded.close_time`,
          postClose: sql`excluded.post_close`,
        },
      });
  }
  await tx.delete(calendarSessions).where(
    and(
      eq(calendarSessions.calendarId, rows.calendarId),
      sessionValues.length === 0
        ? sql`true`
        : sql`${calendarSessions.weekday} <> ALL (${sql.param(sessionValues.map((s) => s.weekday))}::smallint[])`,
    ),
  );

  const holidayValues = rows.holidays.map((h) => ({
    calendarId: rows.calendarId,
    day: h.day,
    name: h.name,
    kind: h.kind,
    closeTime: toSqlTime(h.closeTime ?? null),
  }));
  for (const batch of chunk(holidayValues, INSERT_CHUNK)) {
    await tx
      .insert(calendarHolidays)
      .values(batch)
      .onConflictDoUpdate({
        target: [calendarHolidays.calendarId, calendarHolidays.day],
        set: {
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          closeTime: sql`excluded.close_time`,
        },
      });
  }

  return {
    calendarId: rows.calendarId,
    sessions: sessionValues.length,
    holidays: holidayValues.length,
    fromYear: opts.fromYear,
    toYear: opts.toYear,
  };
}

function requireTime(
  calendarId: string,
  session: CalendarSession,
  field: 'openTime' | 'closeTime',
): string {
  const value = toSqlTime(session[field]);
  if (value === null) {
    throw new CalendarRowError(
      `calendar_sessions.${field === 'openTime' ? 'open_time' : 'close_time'} is NOT NULL, but ` +
        `calendar '${calendarId}' weekday ${session.weekday} has none — a session row means the ` +
        'market opens that weekday; omit the row instead',
    );
  }
  return value;
}

/**
 * Add or correct closures the rules do not carry — an unscheduled market closure, a late-announced
 * early close. Data ops' write path (REF-06), and the only writer besides
 * {@link materialiseCalendar}.
 */
export async function upsertHolidays(
  tx: Tx,
  calendarId: string,
  holidays: readonly CalendarHoliday[],
): Promise<number> {
  if (holidays.length === 0) return 0;
  for (const batch of chunk([...holidays], INSERT_CHUNK)) {
    await tx
      .insert(calendarHolidays)
      .values(
        batch.map((h) => ({
          calendarId,
          day: h.day,
          name: h.name,
          kind: h.kind,
          closeTime: toSqlTime(h.closeTime ?? null),
        })),
      )
      .onConflictDoUpdate({
        target: [calendarHolidays.calendarId, calendarHolidays.day],
        set: {
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          closeTime: sql`excluded.close_time`,
        },
      });
  }
  return holidays.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The year window a read loads. Defaults to core's `CALENDAR_SEED_YEARS`. */
export interface CalendarRange {
  fromYear: number;
  toYear: number;
}

/** 1990-2040 — WORKPLAN L493-494, core `CALENDAR_SEED_YEARS`. */
export const DEFAULT_CALENDAR_RANGE: CalendarRange = Object.freeze({
  fromYear: 1990,
  toYear: 2040,
});

/** The three tables' rows for one calendar, or `null` when `calendars` has no such id. */
export async function readCalendarRows(
  tx: Tx,
  calendarId: string,
  range: CalendarRange = DEFAULT_CALENDAR_RANGE,
): Promise<CalendarRows | null> {
  const rows = await readCalendarRowsMany(tx, [calendarId], range);
  return rows.get(calendarId) ?? null;
}

/** The same read for several calendars in three round trips rather than `3 × n`. */
export async function readCalendarRowsMany(
  tx: Tx,
  calendarIds: readonly string[],
  range: CalendarRange = DEFAULT_CALENDAR_RANGE,
): Promise<Map<string, CalendarRows>> {
  const out = new Map<string, CalendarRows>();
  if (calendarIds.length === 0) return out;
  const ids = [...new Set(calendarIds)];

  const headers = await tx.select().from(calendars).where(inArray(calendars.calendarId, ids));
  if (headers.length === 0) return out;
  const found = headers.map((h) => h.calendarId);

  const sessionRows = await tx
    .select()
    .from(calendarSessions)
    .where(inArray(calendarSessions.calendarId, found))
    .orderBy(calendarSessions.calendarId, calendarSessions.weekday);

  const holidayRows = await tx
    .select()
    .from(calendarHolidays)
    .where(
      and(
        inArray(calendarHolidays.calendarId, found),
        gte(calendarHolidays.day, `${String(range.fromYear).padStart(4, '0')}-01-01`),
        lte(calendarHolidays.day, `${String(range.toYear).padStart(4, '0')}-12-31`),
      ),
    )
    .orderBy(calendarHolidays.calendarId, calendarHolidays.day);

  const sessionsById = new Map<string, CalendarSession[]>();
  for (const s of sessionRows) {
    const bucket = sessionsById.get(s.calendarId) ?? [];
    bucket.push({
      weekday: s.weekday,
      preOpen: toLocalTime(s.preOpen),
      openTime: toLocalTime(s.openTime),
      closeTime: toLocalTime(s.closeTime),
      postClose: toLocalTime(s.postClose),
    });
    sessionsById.set(s.calendarId, bucket);
  }

  const holidaysById = new Map<string, CalendarHoliday[]>();
  for (const h of holidayRows) {
    const bucket = holidaysById.get(h.calendarId) ?? [];
    const closeTime = toLocalTime(h.closeTime);
    bucket.push({
      day: h.day,
      name: h.name,
      kind: asHolidayKind(h.kind, h.calendarId, h.day),
      ...(closeTime === null ? {} : { closeTime }),
    });
    holidaysById.set(h.calendarId, bucket);
  }

  for (const header of headers) {
    out.set(header.calendarId, {
      calendarId: header.calendarId,
      name: header.name,
      tz: header.tz,
      kind: asCalendarKind(header.kind, header.calendarId),
      sourceId: header.sourceId,
      sessions: sessionsById.get(header.calendarId) ?? [],
      holidays: holidaysById.get(header.calendarId) ?? [],
    });
  }
  return out;
}

/**
 * The database's calendar as a core `Calendar`, or `null` when `calendars` has no such id.
 *
 * Deliberately **not** a fallback to `getCalendar(id)`: a missing row means the seed did not run
 * or ran against another database, and answering from the generator would hide that behind
 * correct-looking holidays.
 */
export async function readCalendar(
  tx: Tx,
  calendarId: string,
  range: CalendarRange = DEFAULT_CALENDAR_RANGE,
): Promise<Calendar | null> {
  const rows = await readCalendarRows(tx, calendarId, range);
  return rows === null ? null : calendarFromRows(rows);
}

/**
 * Calendars by id, loaded once per repository and kept.
 *
 * A calendar is immutable for the life of a request — `calendar_holidays_bump` is what tells a
 * long-lived process to build a new repository — and the analytics layer asks `isBusinessDay`
 * thousands of times while walking a coupon schedule, which must not become thousands of queries.
 */
export class CalendarRepository {
  readonly #cache = new Map<string, Calendar | null>();

  constructor(
    private readonly tx: Tx,
    private readonly range: CalendarRange = DEFAULT_CALENDAR_RANGE,
  ) {}

  /** The calendar, or `null` when the database has no row for `calendarId`. */
  async get(calendarId: string): Promise<Calendar | null> {
    const hit = this.#cache.get(calendarId);
    if (hit !== undefined) return hit;
    const cal = await readCalendar(this.tx, calendarId, this.range);
    this.#cache.set(calendarId, cal);
    return cal;
  }

  /** The calendar, throwing when it is absent — for the call sites that cannot proceed without. */
  async require(calendarId: string): Promise<Calendar> {
    const cal = await this.get(calendarId);
    if (cal === null) {
      throw new CalendarRowError(
        `no calendar '${calendarId}' in the database — run the calendar materialisation ` +
          '(WP-15 seed/calendars.ts) before reading terms that reference it',
      );
    }
    return cal;
  }

  /** Several at once, in one set of queries; ids with no row are absent from the map. */
  async getMany(calendarIds: readonly string[]): Promise<Map<string, Calendar>> {
    const missing = calendarIds.filter((id) => !this.#cache.has(id));
    if (missing.length > 0) {
      const loaded = await readCalendarRowsMany(this.tx, missing, this.range);
      for (const id of missing) {
        const rows = loaded.get(id);
        this.#cache.set(id, rows === undefined ? null : calendarFromRows(rows));
      }
    }
    const out = new Map<string, Calendar>();
    for (const id of calendarIds) {
      const cal = this.#cache.get(id);
      if (cal !== undefined && cal !== null) out.set(id, cal);
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Agreement between the rules and the rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One day on which two calendars disagree. */
export interface CalendarDifference {
  day: IsoDate;
  /** The entry the first calendar holds, `null` when it treats the day as a full session. */
  left: CalendarHoliday | null;
  right: CalendarHoliday | null;
}

/**
 * Every day in `[fromYear, toYear]` on which `left` and `right` disagree — the check that the
 * materialised rows still say what WP-02's generators say.
 *
 * Compares `kind`, `closeTime` and the set of days; the holiday *name* is not compared, because a
 * data-ops correction to a name ("Juneteenth National Independence Day") is not a disagreement
 * about whether the market is open.
 */
export function diffCalendars(
  left: Calendar,
  right: Calendar,
  fromYear: number,
  toYear: number,
): CalendarDifference[] {
  const index = (cal: Calendar): Map<IsoDate, CalendarHoliday> =>
    new Map(cal.holidays(fromYear, toYear).map((h) => [h.day, h]));
  const a = index(left);
  const b = index(right);
  const days = [...new Set([...a.keys(), ...b.keys()])].sort();

  const out: CalendarDifference[] = [];
  for (const day of days) {
    const l = a.get(day) ?? null;
    const r = b.get(day) ?? null;
    const same =
      l !== null &&
      r !== null &&
      l.kind === r.kind &&
      (l.closeTime ?? null) === (r.closeTime ?? null);
    if (!same) out.push({ day, left: l, right: r });
  }
  return out;
}
