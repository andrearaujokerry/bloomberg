// packages/web/src/screen/widgets/KeyValue.tsx — the label/value block every quote header is made of.
//
// One tab stop for the node, arrows between rows inside it, `Enter` on a row whose cell carries a
// `command`. Each row advertises its provenance index on `data-prov-idx`, which is what `Ctrl+I`
// reads off the focused element (DATA-10): a row may cite its own index (`row.provIdx`) or inherit
// the one on its value.

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';

import type { Node } from '../types.js';
import { CellView } from './CellView.js';
import { useScreenActions } from './registry.js';
import { rovingKey, useRoving } from './roving.js';

export interface KeyValueProps {
  node: Extract<Node, { kind: 'kv' }>;
}

export function KeyValue({ node }: KeyValueProps): ReactElement {
  const actions = useScreenActions();
  const roving = useRoving(node.rows.length);
  const columns = node.columns ?? 1;

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, i: number): void => {
    if (rovingKey(e.key, roving, node.rows.length)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      const command = node.rows[i]?.value.command;
      if (command === undefined) return;
      e.preventDefault();
      if (e.shiftKey) actions.navigateNext(command);
      else actions.navigate(command);
    }
  };

  // An empty node is still exactly one tab stop. Without this the node drops out of the Tab order
  // the moment its payload has nothing in it — which is precisely when a user is most likely to go
  // looking for it — and `ctx.focus(id)` would silently fail to reach it.
  const isEmpty = node.rows.length === 0;

  return (
    <div
      className="kv"
      data-node-id={node.id}
      role="table"
      aria-label={node.title ?? `Values ${node.id}`}
      {...(isEmpty ? { tabIndex: 0 } : {})}
    >
      {node.title === undefined ? null : (
        <div className="kv__title" aria-hidden="true">
          {node.title}
        </div>
      )}
      {isEmpty ? <p className="widget__empty">No values.</p> : null}
      <div className="kv__rows" style={{ columns: String(columns) }}>
        {node.rows.map((row, i) => {
          const provIdx = row.provIdx ?? row.value.provIdx;
          return (
            <div
              key={`${row.label}:${String(i)}`}
              className="kv__row"
              role="row"
              tabIndex={roving.tabIndex(i)}
              ref={roving.register(i)}
              data-prov-idx={provIdx}
              {...(row.value.command === undefined
                ? {}
                : { 'data-command': row.value.command, 'aria-keyshortcuts': 'Enter' })}
              onFocus={() => {
                roving.set(i);
              }}
              onKeyDown={(e) => {
                onKeyDown(e, i);
              }}
            >
              <span className="kv__label" role="rowheader">
                {row.label}
              </span>
              <span className="kv__value" role="cell">
                <CellView cell={row.value} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
