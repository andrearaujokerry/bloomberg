// packages/web/src/grid/sort.ts — comparators per `fmt`, and the live re-sort gate (CLIENT.md
// §10.3 L706-720).
//
// Two jobs, and they are not the same job. Sorting a payload is a pure ordering of rows the screen
// already has. Sorting a LIVE column is an ordering of numbers that are changing underneath the
// ordering, which is a different problem with a rule attached.
//
// ## What a row that changes its sort key mid-tick does
//
// It stays where it is, and its number changes in place. The order is re-evaluated at most once
// every `liveSortThrottleMs` (1 000 ms by default), and only when the grid is idle.
//
// This is a decision, not an accident, and the alternative is worse in a way that is easy to miss
// in a test and impossible to miss in use. A grid sorted by `CHG_PCT_1D` over 200 names receives a
// delta every few milliseconds; re-sorting on each one makes every row a moving target. The row
// under the cursor is not the row that was under the cursor when the key was pressed, `Enter` opens
// the wrong security, and the cell the eye is tracking has moved twice since it was read. A trader
// cannot point at a screen that reorders itself sixty times a second, and cannot read one either.
//
// So the tick path and the order path are deliberately decoupled:
//
//   * **Values are never delayed.** `cellRegistry` writes the new number into the cell the moment
//     the delta lands. Throttling the ORDER is not throttling the DATA — nothing on screen is ever
//     older than the last frame.
//   * **The order lags by at most one throttle interval**, and the grid says so: `sortBadge()`
//     returns `SORT LIVE` while a live column is sorted and re-sorting is armed, so the footer
//     states that the order is periodic rather than continuous. A grid that silently reorders and a
//     grid that silently does not are indistinguishable without it.
//   * **A re-sort never runs under the user's hands.** {@link LiveSortGate.hold} is set while a key
//     is held in the grid (CLIENT.md §10.3: "only when no key is held down in the grid"), so
//     `ArrowDown` held for a second walks a stable list rather than a shuffling one.
//   * **`Shift+S` freezes it outright** (`SORT FROZEN` in the footer), for the case where even a
//     one-second reshuffle is one too many — reading a ranking aloud, or comparing two panels.
//   * **Identity survives a re-sort.** The caller re-focuses by `row.id`, never by index, which is
//     why {@link sortRows} returns the rows themselves rather than a permutation of positions.
//
// Nothing here formats and nothing here computes a financial quantity: a comparator reads a value
// and returns −1, 0 or 1. `toNumber` is core's (the same coercion the formatter uses), so a string
// `'330.27'` in a `px` column and the number `330.27` sort as the same thing — which they are.

import { toNumber } from '@terminal/core';
import type { FieldId, FieldValue } from '@terminal/core';

import type { Cell, GridColumn, GridRow } from '../screen/types.js';

/* -------------------------------------------------------------------------------------------- */
/* Sort state                                                                                     */
/* -------------------------------------------------------------------------------------------- */

export type SortDir = 'asc' | 'desc';

/** What `LiveGridProps.sort` carries; `null` is "no sort", which is a state `S` cycles through. */
export interface SortState {
  col: string;
  dir: SortDir;
}

/**
 * `S` on the focused column: **asc → desc → none** (CLIENT.md §5.3).
 *
 * Pressing it on a different column restarts the cycle at `asc` for that column rather than
 * inheriting the previous column's direction, which is what makes the third state reachable: a
 * cycle that carried the direction over would never return to "none" while the user was moving
 * between columns.
 */
export function cycleSort(current: SortState | null, colId: string): SortState | null {
  if (current?.col !== colId) return { col: colId, dir: 'asc' };
  if (current.dir === 'asc') return { col: colId, dir: 'desc' };
  return null;
}

/** `aria-sort` for a column header (WAI-ARIA grid pattern; asserted by the keyboard acceptance). */
export function ariaSort(
  sort: SortState | null,
  colId: string,
): 'ascending' | 'descending' | 'none' {
  if (sort?.col !== colId) return 'none';
  return sort.dir === 'asc' ? 'ascending' : 'descending';
}

/** Is this column sortable? A column says `sortable: false` to opt out; the default is yes. */
export function isSortable(column: GridColumn): boolean {
  return column.sortable !== false;
}

/* -------------------------------------------------------------------------------------------- */
/* Comparators                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * The three orderings a column can have (CLIENT.md §10.3): numeric for the quantity formats, ISO
 * string order for the date formats — an ISO-8601 string sorts correctly as text, which is the
 * whole point of the format — and `localeCompare` for text.
 */
export type ComparatorKind = 'numeric' | 'iso' | 'text';

export function comparatorKindOf(column: GridColumn): ComparatorKind {
  switch (column.fmt) {
    case 'px':
    case 'pct':
    case 'bp':
    case 'int':
    case 'ccy':
    case 'shares':
      return 'numeric';
    case 'date':
    case 'datetime':
      return 'iso';
    case 'text':
      return 'text';
    default:
      // No `fmt` on the column: infer per value at compare time (`compareValues` handles a mixed
      // column by falling back to text), because a column the screen did not type is usually the
      // key column, whose values are tickers.
      return 'text';
  }
}

/**
 * `null` and blank sort **last in both directions** (CLIENT.md §10.3).
 *
 * Not "smallest": a descending sort by `CHG_PCT_1D` puts the biggest gainer first, and a name whose
 * price is withheld is not the biggest loser — it is a name with no answer. Sinking it in both
 * directions keeps the rows that have an answer at the top of whichever end the user is reading,
 * which is where they are looking.
 */
function isBlank(value: FieldValue | undefined): boolean {
  return value === null || value === undefined || value === '';
}

/** Compare two present values under `kind`. Neither argument is blank. */
function compareKind(a: FieldValue, b: FieldValue, kind: ComparatorKind): number {
  if (kind === 'numeric') {
    const na = toNumber(a);
    const nb = toNumber(b);
    if (na === null && nb === null) return 0;
    // A non-numeric value in a numeric column ('n/a', 'HALTED') is not a number and sorts with the
    // blanks rather than as zero, which would place it in the middle of the prices.
    if (na === null) return 1;
    if (nb === null) return -1;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (kind === 'iso') {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Compare two cell values under `kind`, applying the direction and the blanks-last rule.
 *
 * `dir` is applied here rather than by the caller reversing the array: reversing a stable sort is
 * not stable (it reverses the ties too), and it would float the blanks to the top.
 */
export function compareValues(
  a: FieldValue | undefined,
  b: FieldValue | undefined,
  kind: ComparatorKind,
  dir: SortDir,
): number {
  const blankA = isBlank(a);
  const blankB = isBlank(b);
  if (blankA && blankB) return 0;
  if (blankA) return 1;
  if (blankB) return -1;
  const cmp = compareKind(a as FieldValue, b as FieldValue, kind);
  return dir === 'asc' ? cmp : -cmp;
}

/* -------------------------------------------------------------------------------------------- */
/* Sort keys                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * The live value of one `(subject, field)`, or `undefined` when no frame has arrived for it.
 *
 * The shape is `QuoteCache.value(subject, field)` and `cellRegistry`'s own lookup, so the grid can
 * hand either in without an adapter. Sorting reads the SAME numbers the cells show — a sort that
 * read the payload while the cells showed live values would order the screen by numbers that are no
 * longer on it.
 */
export type LiveValueLookup = (subject: string, field: FieldId) => FieldValue | undefined;

/** The subject/field a cell is live on, from the cell's own `live` or the row's subject. */
function liveRefOf(
  row: GridRow,
  column: GridColumn,
  cell: Cell | undefined,
): { subject: string; field: FieldId } | null {
  const live = cell?.live;
  if (live !== undefined) return { subject: live.subject, field: live.field };
  const field = cell?.fieldId ?? column.fieldId;
  if (row.subject === undefined || field === undefined) return null;
  return { subject: row.subject, field };
}

/**
 * The value this row sorts by in this column: the live value when the column is live and a frame
 * has arrived, else the payload cell's.
 */
export function sortKeyOf(
  row: GridRow,
  column: GridColumn,
  live?: LiveValueLookup,
): FieldValue | undefined {
  const cell: Cell | undefined = row.cells[column.id];
  if (live !== undefined && column.live === true) {
    const ref = liveRefOf(row, column, cell);
    if (ref !== null) {
      const value = live(ref.subject, ref.field);
      if (value !== undefined) return value;
    }
  }
  return cell?.v;
}

/* -------------------------------------------------------------------------------------------- */
/* The sort                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * Sort `rows` by `sort`, **stably**: ties keep the payload's order, and a re-sort of an already
 * sorted list never permutes rows whose keys did not change.
 *
 * Stability is not a nicety here. The payload's order is itself meaningful — an index's members
 * arrive by weight, a news list by time — so ties fall back to the screen's own ranking rather than
 * to whatever the engine's sort does with equal keys. And under live re-sorting, an unstable
 * comparator would shuffle every row that shares a value with another (a whole column of `0.00%`
 * before the open) on every tick, which is exactly the churn the throttle exists to prevent.
 *
 * `Array.prototype.sort` has been required to be stable since ES2019, but the index tiebreak is
 * written out anyway: it is what makes the intent readable, and it costs one comparison.
 *
 * Returns a NEW array; `rows` is never mutated (the payload is the screen's, not the grid's).
 */
export function sortRows(
  rows: readonly GridRow[],
  sort: SortState | null,
  columns: readonly GridColumn[],
  live?: LiveValueLookup,
): GridRow[] {
  if (sort === null) return [...rows];
  const column = columns.find((c) => c.id === sort.col);
  if (column === undefined || !isSortable(column)) return [...rows];
  const kind = comparatorKindOf(column);

  const decorated = rows.map((row, index) => ({
    row,
    index,
    key: sortKeyOf(row, column, live),
  }));
  decorated.sort((a, b) => {
    const cmp = compareValues(a.key, b.key, kind, sort.dir);
    return cmp !== 0 ? cmp : a.index - b.index;
  });
  return decorated.map((d) => d.row);
}

/** True when the current sort is over a column whose values arrive on the wire. */
export function sortsALiveColumn(
  sort: SortState | null,
  columns: readonly GridColumn[],
): boolean {
  if (sort === null) return false;
  return columns.find((c) => c.id === sort.col)?.live === true;
}

/* -------------------------------------------------------------------------------------------- */
/* The live re-sort gate                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** `LiveGridProps.liveSortThrottleMs` default (CLIENT.md §10.3). */
export const LIVE_SORT_THROTTLE_MS = 1_000;

export interface LiveSortGateOptions {
  /** Default {@link LIVE_SORT_THROTTLE_MS}. */
  throttleMs?: number | undefined;
  /** Where "now" comes from. A test passes a counter; the grid passes `performance.now`. */
  now: () => number;
}

/**
 * The decision "may the order change right now?", kept in one object so the answer cannot be
 * assembled differently in two places.
 *
 * The gate holds no rows and performs no sort: `LiveGrid` calls {@link LiveSortGate.take} on its
 * animation frame, and re-runs {@link sortRows} only when it says yes. Keeping it separate from the
 * sort is what lets the acceptance test assert the policy (it lagged, it froze, it did not move
 * under a held key) without rendering anything.
 */
export class LiveSortGate {
  readonly #throttleMs: number;
  readonly #now: () => number;
  #dirty = false;
  #frozen = false;
  #held = 0;
  #lastSortAt: number | null = null;

  constructor(options: LiveSortGateOptions) {
    this.#throttleMs = Math.max(0, options.throttleMs ?? LIVE_SORT_THROTTLE_MS);
    this.#now = options.now;
  }

  /** A live value in the sorted column changed: the order is now potentially wrong. */
  markDirty(): void {
    this.#dirty = true;
  }

  /** True when a delta has landed on the sorted column since the last re-sort. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** `Shift+S` — the footer's `SORT FROZEN`. */
  toggleFreeze(): boolean {
    this.#frozen = !this.#frozen;
    return this.#frozen;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  setFrozen(frozen: boolean): void {
    this.#frozen = frozen;
  }

  /**
   * A key is down in the grid (`keydown` → true, `keyup` / `blur` → false). Counted rather than
   * flagged, because two keys can be held at once and the second `keyup` must not unlock the grid
   * while the first key is still down.
   */
  setHeld(held: boolean): void {
    this.#held = held ? this.#held + 1 : Math.max(0, this.#held - 1);
  }

  /** Force the held count back to zero — what a `blur` does, since no `keyup` will arrive. */
  releaseHeld(): void {
    this.#held = 0;
  }

  get held(): boolean {
    return this.#held > 0;
  }

  /** The last time the order was re-evaluated, or `null` before the first one. */
  get lastSortAt(): number | null {
    return this.#lastSortAt;
  }

  /** Milliseconds until the throttle would allow a re-sort; 0 when it already does. */
  msUntilDue(now: number = this.#now()): number {
    if (this.#lastSortAt === null) return 0;
    return Math.max(0, this.#throttleMs - (now - this.#lastSortAt));
  }

  /** May the order change now? Does not consume the permission. */
  due(now: number = this.#now()): boolean {
    if (!this.#dirty || this.#frozen || this.held) return false;
    return this.msUntilDue(now) === 0;
  }

  /**
   * Consume the permission: `true` means the caller must re-sort now, and the throttle restarts.
   * Called once per animation frame by the grid, so the sort runs at most once per interval however
   * many deltas arrived in it.
   */
  take(now: number = this.#now()): boolean {
    if (!this.due(now)) return false;
    this.#dirty = false;
    this.#lastSortAt = now;
    return true;
  }

  /** The order was just re-evaluated for another reason (a new payload, a sort key change). */
  reset(now: number = this.#now()): void {
    this.#dirty = false;
    this.#lastSortAt = now;
  }
}

/**
 * What the footer says about the order (CLIENT.md §10.3: the `SORT FROZEN` badge).
 *
 * `null` when the sort is over a payload column, because a static order needs no explanation — the
 * badge is about the one case where what the user sees is a decision the grid made: the rows are
 * ordered by numbers that keep changing, and the order is periodic.
 */
export function sortBadge(
  sort: SortState | null,
  columns: readonly GridColumn[],
  gate: Pick<LiveSortGate, 'frozen'>,
): 'SORT FROZEN' | 'SORT LIVE' | null {
  if (!sortsALiveColumn(sort, columns)) return null;
  return gate.frozen ? 'SORT FROZEN' : 'SORT LIVE';
}
