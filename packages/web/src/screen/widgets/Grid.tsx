// packages/web/src/screen/widgets/Grid.tsx — the `grid` node, which WP-12 does not draw.
//
// A `grid` is WP-13's `LiveGrid`: virtualised rows, imperative per-cell updates outside React, flash
// animation, sort, group and column keyboard handling (CLIENT.md §10). Building a second grid here
// would be the worst outcome available — it would look finished, be mistaken for the real one, and
// then be thrown away.
//
// So this widget does exactly two things. It hands `LiveGrid` the props of `LiveGridProps`
// (registry.ts) when one is registered, translating the `ScreenSpec` node into that contract and
// performing the navigation for `onEnter`/`onShiftEnter`. And when none is registered, it renders a
// placeholder that says which component it is waiting for and what it would have been given — the
// column labels and the row count, which are facts about the payload — without drawing a single
// row, because a row drawn here would be a row a trader could read and act on.

import type { ReactElement } from 'react';

import type { Cell, GridColumn, GridRow, Node } from '../types.js';
import { useCellFormat } from './CellView.js';
import type { LiveGridProps } from './registry.js';
import { useScreenActions, useWidgetRegistry } from './registry.js';

export interface GridProps {
  node: Extract<Node, { kind: 'grid' }>;
}

/**
 * The provenance index the placeholder cites (DATA-10).
 *
 * A grid holds most of the numbers on most screens, and every `GridRow` cell already carries a
 * `provIdx`. Without this the placeholder was the one focusable thing on the screen that answered
 * `Ctrl+I` with "the focused element cites no provenance" — a statement about the placeholder
 * rather than about the payload, when the payload had the answer all along.
 *
 * It is the first attributed cell in reading order, which is the best a single node-level answer
 * can be: the honest per-cell answer arrives with WP-13's `LiveGrid`, whose contract in
 * `registry.ts` requires `data-prov-idx` on every cell it draws. `-1` when there are cells but none
 * is attributed yet (pending is a real state), `-2` when there is nothing to cite at all.
 */
function placeholderProvIdx(columns: GridColumn[], rows: GridRow[]): number {
  let sawCell = false;
  for (const row of rows) {
    for (const column of columns) {
      const cell: Cell | undefined = row.cells[column.id];
      if (cell === undefined) continue;
      sawCell = true;
      if (cell.provIdx >= 0) return cell.provIdx;
    }
  }
  return sawCell ? -1 : -2;
}

export function Grid({ node }: GridProps): ReactElement {
  const registry = useWidgetRegistry();
  const actions = useScreenActions();
  const fmt = useCellFormat();
  const LiveGrid = registry.LiveGrid;

  if (LiveGrid !== undefined) {
    // `ScreenSpec` optionals are absent, not null: `exactOptionalPropertyTypes` means each one is
    // spread in only when the screen expressed it.
    const props: LiveGridProps = {
      id: node.id,
      columns: node.columns,
      rows: node.rows,
      ...(node.live === undefined ? {} : { live: node.live }),
      ...(node.sort === undefined ? {} : { sort: node.sort }),
      ...(node.groupBy === undefined ? {} : { groupBy: node.groupBy }),
      ...(node.frozenColumns === undefined ? {} : { frozenColumns: node.frozenColumns }),
      ...(node.selectable === undefined ? {} : { selectable: node.selectable }),
      ...(node.page === undefined ? {} : { page: node.page }),
      ...(node.emptyText === undefined ? {} : { emptyText: node.emptyText }),
      ...(fmt.currency === undefined ? {} : { currency: fmt.currency }),
      ...(fmt.priceDecimals === undefined ? {} : { priceDecimals: fmt.priceDecimals }),
      onEnter: (row: GridRow): string | null => {
        const command = node.onEnter?.(row) ?? row.command ?? null;
        if (command !== null) actions.navigate(command);
        return command;
      },
      onShiftEnter: (row: GridRow): string | null => {
        const command = node.onShiftEnter?.(row) ?? row.command ?? null;
        if (command !== null) actions.navigateNext(command);
        return command;
      },
    };
    return (
      <div className="grid-host" data-node-id={node.id}>
        <LiveGrid {...props} />
      </div>
    );
  }

  const columnLabels = node.columns.map((c) => c.label).join(', ');
  const provIdx = placeholderProvIdx(node.columns, node.rows);
  const liveColumns = node.columns.filter((c) => c.live === true).length;
  const summary = [
    `${String(node.columns.length)} columns`,
    `${String(node.rows.length)} rows`,
    liveColumns === 0 ? 'no live columns' : `${String(liveColumns)} live columns`,
    node.sort === undefined ? 'unsorted' : `sorted by ${node.sort.col} ${node.sort.dir}`,
    node.groupBy === undefined ? 'ungrouped' : `grouped by ${node.groupBy}`,
    node.page === undefined
      ? 'single page'
      : `page ${String(node.page.index + 1)} of ${String(node.page.count)}`,
  ].join(' · ');

  return (
    <div
      className="pending pending--grid"
      data-node-id={node.id}
      data-pending="LiveGrid"
      data-prov-idx={provIdx}
      role="group"
      aria-label={`Grid ${node.id} — waiting for LiveGrid`}
      tabIndex={0}
    >
      <p className="pending__head">{`Grid ${node.id} — waiting for LiveGrid (WP-13)`}</p>
      <p className="pending__body">{summary}</p>
      <p className="pending__body">{`Columns: ${columnLabels}`}</p>
      <p className="pending__note">
        No rows are drawn here. A placeholder that looked like the grid would be read as the grid.
      </p>
    </div>
  );
}
