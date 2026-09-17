/**
 * Tenors — `'1D'`, `'2W'`, `'3M'`, `'10Y'` — and the date arithmetic that goes with them.
 *
 * Tenors are how curve pillars, swap schedules and bill terms are named everywhere in the terminal
 * (`curve_builds.nodes`, `govt_terms.term_label`, the SWPM and YAS inputs). This module parses them,
 * orders them and moves dates by them; it builds on the date layer in `calendar.ts` and is never
 * imported by it, so the calendar package stays acyclic.
 *
 * Month arithmetic clamps to the end of the target month (31 January + 1M = 28 February) and the
 * optional end-of-month rule promotes a start date that is already the last day of its month to the
 * last day of the result month (28 February + 1M = 31 March) — the two conventions bond and swap
 * schedules pick between.
 */

import type { Calendar, IsoDate } from './calendar.js';
import {
  addDays,
  addMonths,
  adjust,
  endOfMonth,
  isEndOfMonth,
} from './calendar.js';
import type { BusinessDayConvention } from './calendar.js';

/** The four tenor units: day, week, month, year. */
export type TenorUnit = 'D' | 'W' | 'M' | 'Y';

/** A parsed tenor: a signed integer count of a unit. */
export interface Tenor {
  readonly n: number;
  readonly unit: TenorUnit;
}

const TENOR_RE = /^\s*(-?\d{1,4})\s*([DWMY])\s*$/i;

/** Aliases the market writes instead of a number+unit. */
const TENOR_ALIASES = new Map<string, Tenor>([
  ['ON', { n: 1, unit: 'D' }], // overnight
  ['TN', { n: 2, unit: 'D' }], // tom-next
  ['SN', { n: 3, unit: 'D' }], // spot-next
  ['SW', { n: 1, unit: 'W' }], // spot-week
]);

/** Parse a tenor, returning `undefined` rather than throwing on a malformed input. */
export function tryParseTenor(text: string): Tenor | undefined {
  const alias = TENOR_ALIASES.get(text.trim().toUpperCase());
  if (alias !== undefined) return alias;
  const m = TENOR_RE.exec(text);
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = (m[2]!).toUpperCase() as TenorUnit;
  if (!Number.isInteger(n)) return undefined;
  return { n, unit };
}

/** Parse `'3M'`, `'10Y'`, `'13W'`, `'1D'` or an alias (`'ON'`, `'TN'`, `'SN'`, `'SW'`). */
export function parseTenor(text: string): Tenor {
  const t = tryParseTenor(text);
  if (t === undefined) throw new RangeError(`parseTenor: not a tenor: ${JSON.stringify(text)}`);
  return t;
}

/** Canonical string form, `'3M'`. */
export function formatTenor(tenor: Tenor): string {
  return `${String(tenor.n)}${tenor.unit}`;
}

/** True when `value` parses as a tenor. */
export function isTenor(value: unknown): value is string {
  return typeof value === 'string' && tryParseTenor(value) !== undefined;
}

/** Whole months in a tenor. Throws for day and week tenors, which are not a whole number of months. */
export function tenorInMonths(tenor: Tenor): number {
  if (tenor.unit === 'M') return tenor.n;
  if (tenor.unit === 'Y') return tenor.n * 12;
  throw new RangeError(`tenorInMonths: ${formatTenor(tenor)} is not a whole number of months`);
}

/**
 * Approximate length in years (30/360-style: a month is 1/12, a week 7/365, a day 1/365). For
 * **ordering and pillar labelling only** — never for discounting, which uses the real day count.
 */
export function tenorInYearsApprox(tenor: Tenor): number {
  switch (tenor.unit) {
    case 'D':
      return tenor.n / 365;
    case 'W':
      return (tenor.n * 7) / 365;
    case 'M':
      return tenor.n / 12;
    case 'Y':
      return tenor.n;
  }
}

/** Ascending comparator by {@link tenorInYearsApprox}. */
export function compareTenors(a: Tenor, b: Tenor): number {
  const d = tenorInYearsApprox(a) - tenorInYearsApprox(b);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/** A copy of `tenors` in ascending order. */
export function sortTenors(tenors: readonly Tenor[]): Tenor[] {
  return [...tenors].sort(compareTenors);
}

/** Options for {@link addTenor}. */
export interface AddTenorOptions {
  /**
   * When the start date is the last day of its month, land on the last day of the result month
   * (28 February 2026 + 1M = 31 March 2026). Applies to month and year tenors only.
   */
  readonly endOfMonth?: boolean;
}

/**
 * `date` plus `tenor`. Day and week tenors are exact calendar arithmetic; month and year tenors
 * clamp into the target month, and honour the optional end-of-month rule.
 */
export function addTenor(date: IsoDate, tenor: Tenor, options: AddTenorOptions = {}): IsoDate {
  switch (tenor.unit) {
    case 'D':
      return addDays(date, tenor.n);
    case 'W':
      return addDays(date, tenor.n * 7);
    case 'M':
    case 'Y': {
      const months = tenor.unit === 'Y' ? tenor.n * 12 : tenor.n;
      const moved = addMonths(date, months);
      return options.endOfMonth === true && isEndOfMonth(date) ? endOfMonth(moved) : moved;
    }
  }
}

/** `date` plus `tenor`, then rolled to a business day under `bdc` (WORKPLAN L500). */
export function addTenorAdjusted(
  cal: Calendar,
  date: IsoDate,
  tenor: Tenor,
  bdc: BusinessDayConvention,
  options: AddTenorOptions = {},
): IsoDate {
  return adjust(cal, addTenor(date, tenor, options), bdc);
}

/** `addTenor` taking the tenor in string form: `shiftBy('2026-09-15', '3M')`. */
export function shiftBy(date: IsoDate, tenor: string, options: AddTenorOptions = {}): IsoDate {
  return addTenor(date, parseTenor(tenor), options);
}
