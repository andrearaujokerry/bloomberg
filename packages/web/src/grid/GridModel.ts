// packages/web/src/grid/GridModel.ts — rows, sort and group to one flat array. Pure.
//
// CLIENT.md §10.3. `buildVisible` is the only place the grid decides what order things are in and
// where the group headers go; `LiveGrid` renders the array it returns and `virtualiser.ts` slices
// it. Keeping it pure is what lets the 1 000-row acceptance case be tested without a DOM, and what
// lets a live re-sort be "call this again and diff" rather than a mutation of whatever React
// happened to be holding.
//
// **It decides nothing itself.** The comparators are `sort.ts`'s and the buckets and aggregates are
// `group.ts`'s; this file is the composition — sort first, then group, so that "one header per
// distinct key in sort order" falls out rather than being a third rule — plus the flattening into
// `VisibleRow[]` and the index arithmetic the virtualiser and `aria-rowindex` read. A second
// comparator here would be a second answer to "which row is first", and there would be no way to
// tell from the screen which one had won.

import type { Cell, GridColumn, GridRow } from '../screen/types.js';
import { groupRows } from './group.js';
import { sortRows } from './sort.js';
import type { LiveValueLookup, SortState } from './sort.js';
import type { VisibleRow } from './types.js';

export type { LiveValueLookup, SortState } from './sort.js';

export interface BuildOptions {
  columns: readonly GridColumn[];
  sort?: SortState | null | undefined;
  groupBy?: string | null | undefined;
  /** Group keys the user has collapsed. Their rows are not in the result at all. */
  collapsed?: ReadonlySet<string> | undefined;
  /**
   * Live values, for a live re-sort and live aggregates (CLIENT.md §10.3). When absent the
   * payload's own cells decide — which is the right answer for a static grid and the starting
   * answer for a live one.
   */
  liveValues?: LiveValueLookup | undefined;
}

/** A cell that a row does not have. Blank: there is no value here, and it is not attributed. */
const MISSING: Cell = { v: null, st: 'blank', provIdx: -1 };

/**
 * The cell a row shows in a column, or a blank one.
 *
 * Not `undefined`, and not an empty box. An empty box in a numeric column says nothing — it cannot
 * be told from a value that is genuinely blank, it cannot be focused, and `Ctrl+I` cannot be
 * pressed on it. A real blank cell says the one true thing about it.
 */
export function cellOf(row: GridRow, columnId: string): Cell {
  return row.cells[columnId] ?? MISSING;
}

/**
 * The flat visible model (CLIENT.md §10.3).
 *
 * Ungrouped: the sorted rows. Grouped: one header per distinct key, in the order the sorted rows
 * first present it, followed by that group's rows — unless the group is collapsed, in which case
 * the header stands alone and its rows are absent from the model entirely. That absence is also
 * what releases their `essential` flag (§10.3): `virtualiser.ts` reads the subjects of the model,
 * so a row that is not in it cannot be essential, and there is no second rule saying so.
 */
export function buildVisible(rows: readonly GridRow[], options: BuildOptions): VisibleRow[] {
  const { columns, sort, groupBy, collapsed, liveValues } = options;
  const sorted = sortRows(rows, sort ?? null, columns, liveValues);

  if (groupBy === null || groupBy === undefined || groupBy === '') {
    return sorted.map((row, index) => ({ kind: 'row', row, index }));
  }

  const out: VisibleRow[] = [];
  for (const block of groupRows(sorted, groupBy, columns, liveValues)) {
    const isCollapsed = collapsed?.has(block.key) ?? false;
    out.push({
      kind: 'group',
      key: block.key,
      count: block.count,
      agg: block.agg,
      collapsed: isCollapsed,
      index: out.length,
    });
    if (isCollapsed) continue;
    for (const row of block.rows) out.push({ kind: 'row', row, index: out.length });
  }
  return out;
}

/** The index of a row in the flat model, or -1. What `focusRow`/`scrollToRow` resolve through. */
export function indexOfRow(visible: readonly VisibleRow[], rowId: string): number {
  return visible.findIndex((entry) => entry.kind === 'row' && entry.row.id === rowId);
}

/** How many payload rows the model holds, ignoring group headers. */
export function rowCount(visible: readonly VisibleRow[]): number {
  let n = 0;
  for (const entry of visible) if (entry.kind === 'row') n += 1;
  return n;
}

/** Every group key in the model, so a collapsed set can be pruned when the payload changes. */
export function groupKeysOf(visible: readonly VisibleRow[]): string[] {
  const keys: string[] = [];
  for (const entry of visible) if (entry.kind === 'group') keys.push(entry.key);
  return keys;
}
