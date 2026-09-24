// packages/web/src/format/index.ts — the web package's window onto THE formatter.
//
// There is one formatter in this system and it lives in `packages/core/src/fields/format.ts`
// (WORKPLAN §WP-12, ARCHITECTURE §15, API.md §7). This file re-exports it and adds the two
// `ScreenSpec`-shaped adapters the widgets need — "render this `Cell`", "render this cell under
// this `GridColumn`" — and nothing else. It contains no number formatting of its own.
//
// Why the rule is worth a file that is mostly re-exports: a number that reads `1,234.50` on the
// screen and `1234.5000` in the CSV, or `+0.42%` in a grid and `0.42` in the HELP overlay, is the
// bug this prevents. Every surface calls the same function, so they cannot drift. The CSV is the
// one deliberate exception and it lives in core too (`core/functions/csv.ts` emits full stored
// precision, FUNCTIONS.md §1.6 rule 2) — an exception made once, in the shared package, rather
// than a second formatter here.
//
// If a widget needs a rendering core cannot produce, the fix is a change in core, not a helper
// here. Nothing in this package computes a percentage, a spread, a ratio, an adjusted price or a
// statistic either: those are core's, and the web package imports them.

import { format, formatAs } from '@terminal/core';
import type { FieldFormat, FieldId, FormatOptions } from '@terminal/core';

import type { Cell, GridColumn } from '../screen/types.js';

export {
  format,
  formatAs,
  formatOf,
  decimalsOf,
  toNumber,
  isoDateFromEpochMs,
  isoDateTimeFromEpochMs,
} from '@terminal/core';
export type { FieldFormat, FormatOptions } from '@terminal/core';

/** What a blank cell prints (TERM-12, CLIENT §12.1). Core's own default, named for widgets. */
export const BLANK = '—';

/** What an `na` cell prints — "not applicable" is a middle dot, not an em dash (CLIENT §12.1). */
export const NOT_APPLICABLE = '·';

/**
 * Context a cell cannot carry but its rendering needs: the instrument's price decimals and
 * currency, the user's locale, and the blank glyph when it is not the default.
 */
export type CellFormatContext = Pick<
  FormatOptions,
  'priceDecimals' | 'currency' | 'locale' | 'blank' | 'compact' | 'signed'
>;

/**
 * An unknown field id. Core documents this path: a field the dictionary has not caught up with
 * falls back to `opts.fmt` and then to the shape of the value, which is exactly what a `Cell`
 * without a `fieldId` needs. Inference stays in core; this is the call into it.
 */
const UNKNOWN_FIELD: FieldId = '';

/**
 * Render one `Cell` (FUNCTIONS §1.5).
 *
 * Precedence is the contract's: `Cell.fmt` beats the field's unit, `Cell.decimals` beats the
 * dictionary, and the call-site context supplies what neither knows.
 *
 * **The state decides what is printed; the value never overrides it.** `blank` prints the blank
 * glyph and `na` prints its own glyph whatever `v` holds, because both states are assertions about
 * the field rather than about the number: `blank` says the value was denied or is unknown
 * (ENTL-05 — a payload that left a last-known price beside `st: 'blank'` would otherwise leak the
 * exact number the entitlement decision withheld), and `na` says the field does not apply to this
 * instrument at all, which a printed number would contradict. The two rules are symmetric on
 * purpose, and they live here rather than in `CellView` so that every caller of the single
 * formatter gets them — including WP-13's grid, which formats through `formatGridCell` and never
 * goes near `CellView`. The `ReasonCode` travels beside the glyph as a badge, not as text.
 */
export function formatCell(cell: Cell, ctx: CellFormatContext = {}): string {
  if (cell.st === 'blank') return ctx.blank ?? BLANK;
  if (cell.st === 'na') return NOT_APPLICABLE;

  const opts: FormatOptions = { ...ctx };
  if (cell.fmt !== undefined) opts.fmt = cell.fmt;
  if (cell.decimals !== undefined) opts.decimals = cell.decimals;

  return format(cell.fieldId ?? UNKNOWN_FIELD, cell.v, opts);
}

/**
 * Render a cell under its column. A `GridColumn` carries `fieldId`, `fmt` and `decimals` for the
 * whole column; the cell's own values win where it sets them, so one odd row can print differently
 * without the column having to.
 */
export function formatGridCell(
  column: GridColumn,
  cell: Cell,
  ctx: CellFormatContext = {},
): string {
  const merged: Cell = { ...cell };
  if (merged.fieldId === undefined && column.fieldId !== undefined) merged.fieldId = column.fieldId;
  if (merged.fmt === undefined && column.fmt !== undefined) merged.fmt = column.fmt;
  if (merged.decimals === undefined && column.decimals !== undefined) {
    merged.decimals = column.decimals;
  }
  return formatCell(merged, ctx);
}

/** Render a bare value with an explicit rendering — axis ticks, legends, tooltips. */
export function formatValue(
  fmt: FieldFormat,
  value: number | string | boolean | null,
  ctx: CellFormatContext & { decimals?: number } = {},
): string {
  return formatAs(fmt, value, ctx);
}
