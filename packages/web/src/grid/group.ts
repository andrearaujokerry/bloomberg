// packages/web/src/grid/group.ts — `groupBy` → header rows with a count and a per-column aggregate
// (CLIENT.md §10.3 L710-716, §5.3 `G`).
//
// Grouping is an ordering question, not an arithmetic one, with one arithmetic corner: a group
// header shows an aggregate per column, and CLIENT.md §10.3 fixes which — `sum` for `int|shares|
// ccy`, `avg` for `pct|bp`, and NOTHING for `px|text|date`. The last one is the interesting rule and
// it is a rule about meaning, not about types: the average of ten share prices is a number, it is
// arithmetically valid, and it means nothing at all. A header that printed `AVG 218.44` over a
// price column would be read as a level, and there is no level there — the prices belong to ten
// different securities with ten different scales. So the cell is left blank, which says the only
// true thing available: this column does not aggregate.
//
// The same reasoning caps what else is here. A weighted average, a portfolio-level return or a
// duration-weighted yield are all things a group header could in principle show; none of them can
// be computed from the column alone, because the weights are elsewhere. Those belong to the
// function that built the payload (`packages/core`), which has the positions. A grid never invents
// a statistic it cannot justify from what it was handed.

import type { FieldValue } from '@terminal/core';
import { toNumber } from '@terminal/core';

import type { GridColumn, GridRow } from '../screen/types.js';
import type { LiveValueLookup } from './sort.js';
import { sortKeyOf } from './sort.js';

/* -------------------------------------------------------------------------------------------- */
/* Which columns can be grouped, and the `G` cycle                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * Whether a column can carry the grouping.
 *
 * CLIENT.md §5.3 says `G` cycles over "the columns marked `groupable`", but `GridColumn`
 * (FUNCTIONS.md §1.5, and the contract WP-12's renderer already calls through) has no such member,
 * and inventing one here would put a second `GridColumn` in the codebase for the sake of one flag.
 * So the property is derived, and the derivation is the same judgement the flag would have encoded:
 *
 *   * a **live** column is never groupable — its values change on the wire, and a grouping that
 *     re-partitions the grid every tick is a grid nobody can read;
 *   * a **quantity** column (`px|pct|bp|int|ccy|shares`) is never groupable — grouping by a
 *     continuous number yields one group per row, which is the ungrouped grid with twice as many
 *     rows in it;
 *   * everything else — `text`, `date`, `datetime`, and a column with no `fmt` at all, which is how
 *     a screen spells a key or category column — is groupable.
 *
 * A screen that wants a different set expresses it the way the contract already allows: by putting
 * the grouping in `GridRow.group`, which {@link groupKeyOf} prefers over any column.
 */
export function isGroupable(column: GridColumn): boolean {
  if (column.live === true) return false;
  switch (column.fmt) {
    case 'px':
    case 'pct':
    case 'bp':
    case 'int':
    case 'ccy':
    case 'shares':
      return false;
    default:
      return true;
  }
}

export function groupableColumns(columns: readonly GridColumn[]): GridColumn[] {
  return columns.filter(isGroupable);
}

/**
 * `G` — cycle `groupBy` over the groupable columns and back to ungrouped (CLIENT.md §5.3).
 *
 * The `null` at the end of the cycle is not padding: grouping is a view the user has to be able to
 * leave, and a cycle with no exit means pressing one key by accident costs a re-run of the screen.
 */
export function nextGroupBy(
  current: string | null,
  columns: readonly GridColumn[],
): string | null {
  const groupable = groupableColumns(columns);
  if (groupable.length === 0) return null;
  if (current === null) return groupable[0]?.id ?? null;
  const at = groupable.findIndex((c) => c.id === current);
  if (at === -1) return groupable[0]?.id ?? null;
  // …last groupable column → ungrouped.
  return at + 1 >= groupable.length ? null : (groupable[at + 1]?.id ?? null);
}

/* -------------------------------------------------------------------------------------------- */
/* Group keys                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** What a header prints for rows that have no value in the grouping column. */
export const UNGROUPED_KEY = '(none)';

/**
 * The group a row belongs to: `row.group` when the payload stated one, else the grouping column's
 * value rendered as a key (CLIENT.md §10.3).
 *
 * `row.group` wins because it is the screen's own answer — CACS groups by corporate-action type,
 * PORT by sector — and the column's value is a fallback for the grids that did not say.
 */
export function groupKeyOf(row: GridRow, groupBy: string): string {
  if (row.group !== undefined && row.group !== '') return row.group;
  const value: FieldValue | undefined = row.cells[groupBy]?.v;
  if (value === null || value === undefined || value === '') return UNGROUPED_KEY;
  return String(value);
}

/* -------------------------------------------------------------------------------------------- */
/* Aggregates                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** CLIENT.md §10.3: `sum` for `int|shares|ccy`, `avg` for `pct|bp`, none for the rest. */
export type AggKind = 'sum' | 'avg' | 'none';

export function aggKindOf(column: GridColumn): AggKind {
  switch (column.fmt) {
    case 'int':
    case 'shares':
    case 'ccy':
      return 'sum';
    case 'pct':
    case 'bp':
      return 'avg';
    default:
      return 'none';
  }
}

/**
 * Aggregate one column over the rows of one group, or `null` when the column does not aggregate or
 * no row in the group has a number.
 *
 * Blanks are SKIPPED, not counted as zero. A withheld price is not a zero price (ENTL-05), and an
 * average that divided by the blank rows would report a number lower than every value it averaged —
 * a wrong answer that looks like a right one. When every row is blank the answer is `null`, which
 * the header renders as the blank glyph: no values, no aggregate, said plainly.
 */
export function aggregateColumn(
  column: GridColumn,
  rows: readonly GridRow[],
  live?: LiveValueLookup,
): number | null {
  const kind = aggKindOf(column);
  if (kind === 'none') return null;
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const n = toNumber(sortKeyOf(row, column, live));
    if (n === null) continue;
    total += n;
    count += 1;
  }
  if (count === 0) return null;
  return kind === 'sum' ? total : total / count;
}

/* -------------------------------------------------------------------------------------------- */
/* Grouping                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** One group: the header's contents plus the rows it covers, in the order they were handed in. */
export interface GroupBlock {
  key: string;
  count: number;
  /** Per-column aggregate; `null` where the column does not aggregate (CLIENT.md §10.3). */
  agg: Record<string, number | null>;
  rows: GridRow[];
}

/**
 * Partition `rows` into groups, **preserving the order the rows arrived in** — which, because
 * `GridModel` sorts before it groups, is sort order (CLIENT.md §10.3: "one header per distinct key
 * in sort order").
 *
 * Grouping does not re-sort and does not re-order within a group. Sorting is one decision, made
 * once, in `sort.ts`; a second ordering here would silently override it and there would be no way
 * to tell from the screen which one won.
 */
export function groupRows(
  rows: readonly GridRow[],
  groupBy: string,
  columns: readonly GridColumn[],
  live?: LiveValueLookup,
): GroupBlock[] {
  const blocks = new Map<string, GridRow[]>();
  for (const row of rows) {
    const key = groupKeyOf(row, groupBy);
    const bucket = blocks.get(key);
    if (bucket === undefined) blocks.set(key, [row]);
    else bucket.push(row);
  }
  return [...blocks].map(([key, groupRowsIn]) => {
    const agg: Record<string, number | null> = {};
    for (const column of columns) agg[column.id] = aggregateColumn(column, groupRowsIn, live);
    return { key, count: groupRowsIn.length, agg, rows: groupRowsIn };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Collapse                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** `Enter` on a group header collapses or expands it (CLIENT.md §5.3). */
export function toggleCollapsed(
  collapsed: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Every group key, for "collapse all" / "expand all" and for pruning a stale collapsed set. */
export function groupKeys(blocks: readonly GroupBlock[]): string[] {
  return blocks.map((b) => b.key);
}

/**
 * The subjects of the rows hidden by the current collapse (CLIENT.md §10.3: "collapsed groups hide
 * their rows and release their subjects' essential flag").
 *
 * A collapsed group is off-screen exactly as a scrolled-away row is, and BUS-04 sheds
 * non-essential subjects first, so telling the bridge about it is what keeps a slow consumer from
 * shedding a visible row while a hundred collapsed ones stay essential. The result is handed to
 * `rt/wsBridge.setVisible`'s complement, not acted on here — this module performs no IO.
 */
export function collapsedSubjects(
  blocks: readonly GroupBlock[],
  collapsed: ReadonlySet<string>,
  subjectOf: (row: GridRow) => string | null,
): string[] {
  const out = new Set<string>();
  for (const block of blocks) {
    if (!collapsed.has(block.key)) continue;
    for (const row of block.rows) {
      const subject = subjectOf(row);
      if (subject !== null) out.add(subject);
    }
  }
  return [...out];
}
