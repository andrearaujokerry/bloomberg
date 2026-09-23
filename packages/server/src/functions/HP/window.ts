/**
 * `functions/HP/window.ts` — the `[start, end]` window HP reads, and the paging over its rows.
 *
 * Two things live here rather than in `resolve.ts` because both variants need them and because
 * both are worth reading on their own:
 *
 *  - **The end of the window is the last *completed* session.** HP never shows the session in
 *    progress (§HP Live: that is what makes the CSV equal the screen), so the default end is the
 *    last business day of the instrument's calendar on or before the as-of date, stepped back once
 *    more when the plant says that session is still open. Without a calendar there is no way to
 *    know which days were sessions at all; the window then ends at the as-of date and the caller
 *    records `NO_SOURCE` with the venue's name, rather than silently pretending a Sunday was one.
 *  - **Paging is over the ordered rows of the whole window.** The service returns the window in
 *    one partition-pruned scan (≤ 10 y × 252 = 2 520 rows), so a page turn is a slice, not a
 *    second query, and `summary` — computed over the window — is identical on every page.
 */

import { addDays, addMonths, addYears } from '@terminal/core/calendars/calendar';

import type { Calendar, IsoDate } from '@terminal/core/calendars/calendar';

/** The ranges HP and the series variant share. */
export type WindowRange =
  | '1M'
  | '3M'
  | '6M'
  | 'YTD'
  | '1Y'
  | '2Y'
  | '5Y'
  | '10Y'
  | 'MAX'
  | 'CUSTOM';

export interface WindowInput {
  range: WindowRange;
  start?: string | undefined;
  end?: string | undefined;
  /** `YYYY-MM-DD` of `ctx.asOf.validAt`. */
  asOfDate: IsoDate;
  calendar: Calendar | null;
  /** `plant.snapshot('q:<id>')?.session === 'open'`. */
  sessionOpen: boolean;
  /** `instruments.first_trade_date`, the natural floor of `MAX`. */
  firstTradeDate?: string | undefined;
}

export interface WindowResult {
  start: IsoDate;
  end: IsoDate;
}

/** The most recent business day on or before `date`; `date` itself when there is no calendar. */
export function lastBusinessDay(calendar: Calendar | null, date: IsoDate): IsoDate {
  if (calendar === null) return date;
  let cursor = date;
  // 10 days is more than any run of closures in the seeded calendars (Christmas through New Year
  // is at most four), and a bounded loop cannot spin on a malformed calendar.
  for (let i = 0; i < 10; i += 1) {
    if (calendar.isBusinessDay(cursor)) return cursor;
    cursor = addDays(cursor, -1);
  }
  return cursor;
}

/**
 * The window a range names. `CUSTOM` without a `start` is the caller's problem (§HP resolver step
 * 1 answers `400 VALIDATION_FAILED` on `fnParams`), so it is reported rather than guessed.
 */
export function resolveWindow(input: WindowInput): WindowResult | { error: 'CUSTOM_NEEDS_START' } {
  const defaultEnd = defaultWindowEnd(input);
  const end = input.end ?? defaultEnd;

  if (input.range === 'CUSTOM') {
    if (input.start === undefined) return { error: 'CUSTOM_NEEDS_START' };
    return { start: input.start, end };
  }

  return { start: startOf(input.range, end, input.firstTradeDate), end };
}

/** The last completed session on or before the as-of date. */
export function defaultWindowEnd(
  input: Pick<WindowInput, 'asOfDate' | 'calendar' | 'sessionOpen'>,
): IsoDate {
  const last = lastBusinessDay(input.calendar, input.asOfDate);
  if (!input.sessionOpen) return last;
  // The session on `last` has not closed, so the last *completed* one is the business day before.
  return lastBusinessDay(input.calendar, addDays(last, -1));
}

function startOf(range: Exclude<WindowRange, 'CUSTOM'>, end: IsoDate, firstTrade?: string): IsoDate {
  switch (range) {
    case '1M':
      return addMonths(end, -1);
    case '3M':
      return addMonths(end, -3);
    case '6M':
      return addMonths(end, -6);
    case 'YTD':
      return `${end.slice(0, 4)}-01-01`;
    case '1Y':
      return addYears(end, -1);
    case '2Y':
      return addYears(end, -2);
    case '5Y':
      return addYears(end, -5);
    case '10Y':
      return addYears(end, -10);
    case 'MAX':
      return firstTrade ?? '1970-01-01';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paging
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PageSlice<Row> {
  rows: Row[];
  index: number;
  count: number;
  cursor: string | null;
}

/** `base64url(JSON.stringify({ date }))` — §HP resolver step 4. */
export function encodeHpCursor(date: string): string {
  return Buffer.from(JSON.stringify({ date }), 'utf8').toString('base64url');
}

export function decodeHpCursor(cursor: string): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const date: unknown = (parsed as { date?: unknown }).date;
    return typeof date === 'string' ? date : null;
  } catch {
    return null;
  }
}

/**
 * The page of `rows` a cursor names.
 *
 * The cursor holds the **last date of the page that produced it**, so a forward turn starts at the
 * row after it and a backward turn ends at the row before it. Encoding a position instead would
 * mean a row inserted between two page turns silently shifts the window; a date cannot.
 */
export function pageOf<Row extends { date: string }>(
  rows: readonly Row[],
  page: { cursor: string | null; direction: 'fwd' | 'back' } | undefined,
  pageSize: number,
): PageSlice<Row> {
  const count = Math.max(1, Math.ceil(rows.length / pageSize));
  const cursorDate = page?.cursor === null || page?.cursor === undefined ? null : decodeHpCursor(page.cursor);

  let from = 0;
  if (cursorDate !== null) {
    const at = rows.findIndex((row) => row.date === cursorDate);
    if (at >= 0) {
      from = page?.direction === 'back' ? Math.max(0, at - pageSize * 2 + 1) : at + 1;
    }
  }
  if (from >= rows.length) from = Math.max(0, (count - 1) * pageSize);

  const slice = rows.slice(from, from + pageSize);
  const lastRow = slice.at(-1);
  return {
    rows: [...slice],
    index: Math.floor(from / pageSize),
    count,
    cursor: lastRow === undefined || from + pageSize >= rows.length ? null : encodeHpCursor(lastRow.date),
  };
}
