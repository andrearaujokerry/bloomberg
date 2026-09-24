// packages/web/src/screen/widgets/Table.tsx — the small static table.
//
// Not a grid: a `table` node is a handful of rows the screen already has in memory, with no live
// subjects, no virtualisation and no sort. It is drawn here in full, because there is nothing to
// delegate and nothing about it that WP-13 would do differently.
//
// Focus roves over *cells* rather than rows, in two dimensions, because `Ctrl+I` is a per-cell
// question: two columns of one row can come from two different sources.

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { Cell, Node } from '../types.js';
import { CellView } from './CellView.js';
import { useScreenActions } from './registry.js';
import { useRoving } from './roving.js';

export interface TableProps {
  node: Extract<Node, { kind: 'table' }>;
}

/**
 * What a row that is shorter than the header renders in the columns it does not reach.
 *
 * Not an empty box. An empty box in a numeric column says nothing — it is indistinguishable from a
 * value that is genuinely blank, it cannot be focused, and `Ctrl+I` cannot be pressed on it. A real
 * blank cell says the one true thing about it: there is no value here, it is not attributed, and it
 * is reachable like every other cell.
 */
const MISSING_CELL: Cell = { v: null, st: 'blank', provIdx: -1 };

export function Table({ node }: TableProps): ReactElement {
  const actions = useScreenActions();
  const width = Math.max(node.columns.length, 1);
  const cellCount = node.rows.length * width;
  const roving = useRoving(cellCount);
  const isEmpty = node.rows.length === 0;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, index: number): void => {
    const row = Math.floor(index / width);
    const col = index % width;
    const lastRow = node.rows.length - 1;
    if (e.key === 'ArrowRight' && col < width - 1) {
      e.preventDefault();
      roving.move(index + 1);
    } else if (e.key === 'ArrowLeft' && col > 0) {
      e.preventDefault();
      roving.move(index - 1);
    } else if (e.key === 'ArrowDown' && row < lastRow) {
      e.preventDefault();
      roving.move(index + width);
    } else if (e.key === 'ArrowUp' && row > 0) {
      e.preventDefault();
      roving.move(index - width);
    } else if (e.key === 'Home') {
      e.preventDefault();
      roving.move(row * width);
    } else if (e.key === 'End') {
      e.preventDefault();
      roving.move(row * width + width - 1);
    } else if (e.key === 'Enter') {
      const command = node.rows[row]?.[col]?.command;
      if (command === undefined) return;
      e.preventDefault();
      if (e.shiftKey) actions.navigateNext(command);
      else actions.navigate(command);
    }
  };

  return (
    <div
      className="table"
      data-node-id={node.id}
      role="table"
      aria-label={node.caption ?? `Table ${node.id}`}
      aria-rowcount={isEmpty ? 0 : node.rows.length + 1}
      aria-colcount={width}
      {...(isEmpty ? { tabIndex: 0 } : {})}
    >
      {node.caption === undefined ? null : (
        <div className="table__caption" aria-hidden="true">
          {node.caption}
        </div>
      )}
      {isEmpty ? <p className="widget__empty">{`No rows in ${node.caption ?? node.id}.`}</p> : null}
      {isEmpty ? null : (
        <div className="table__head" role="rowgroup">
          <div className="table__row" role="row">
            {node.columns.map((column) => (
              <span key={column.id} className="table__th" role="columnheader">
                {column.label}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="table__body" role="rowgroup">
        {node.rows.map((row, ri) => (
          <div key={`row:${String(ri)}`} className="table__row" role="row">
            {node.columns.map((column, ci) => {
              const cell = row[ci] ?? MISSING_CELL;
              const index = ri * width + ci;
              return (
                <span
                  key={column.id}
                  className="table__td"
                  role="cell"
                  tabIndex={roving.tabIndex(index)}
                  ref={roving.register(index)}
                  data-prov-idx={cell.provIdx}
                  {...(cell.command === undefined
                    ? {}
                    : { 'data-command': cell.command, 'aria-keyshortcuts': 'Enter' })}
                  onFocus={() => {
                    roving.set(index);
                  }}
                  onKeyDown={(e) => {
                    onKeyDown(e, index);
                  }}
                >
                  <CellView cell={cell} label={column.label} />
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
