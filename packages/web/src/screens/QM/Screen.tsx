// packages/web/src/screens/QM/Screen.tsx — Quote Monitor (FUNCTIONS_TIER1 §QM "Screen").
//
// One grid, filling the panel: two frozen columns (security and name) and one live cell per
// requested field. Every cell carries its own state, reason and provenance index, so the renderer
// can flash it, grey it or blank it with a reason without the screen knowing where it came from.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  blankCell,
  cell,
  computedCell,
  entitlementBadges,
  footer,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'QM'>;
type Payload = PayloadOf<'QM'>;

/** `key` and `name` are frozen; everything after them is a monitor column (§QM "Screen"). */
export function monitorColumns(columns: Payload['columns']): GridColumn[] {
  const out: GridColumn[] = [
    { id: 'key', label: 'Security', align: 'left', sortable: true },
    { id: 'name', label: 'Name', align: 'left', sortable: true },
  ];
  for (const c of columns) {
    const col: GridColumn = {
      id: c.id,
      label: c.label,
      fmt: c.fmt,
      align: c.fmt === 'text' || c.fmt === 'date' || c.fmt === 'datetime' ? 'left' : 'right',
      sortable: true,
      live: true,
    };
    if (c.fieldId !== undefined) col.fieldId = c.fieldId;
    if (c.decimals !== undefined) col.decimals = c.decimals;
    out.push(col);
  }
  return out;
}

/** One grid row per monitor row; a column with no cell is pending, not denied (§0.4 rule 1). */
export function monitorRows(
  rows: readonly Payload['rows'][number][],
  columns: Payload['columns'],
  groupBy: string,
): GridRow[] {
  return rows.map((r) => {
    const cells: GridRow['cells'] = {
      key: textCell(r.key, { command: `${r.key} DES` }),
      name: textCell(r.name),
    };
    for (const c of columns) {
      const vc = r.cells[c.id];
      const opts = c.decimals === undefined ? { fmt: c.fmt } : { fmt: c.fmt, decimals: c.decimals };
      if (vc === undefined) {
        cells[c.id] = c.fieldId === undefined ? blankCell() : blankCell(c.fieldId);
        continue;
      }
      cells[c.id] =
        c.fieldId === undefined
          ? computedCell(vc, c.fmt, c.decimals)
          : cell(c.fieldId, vc, {
              ...opts,
              signed: c.id.startsWith('CHG_') || c.id.startsWith('RET_'),
            });
    }
    const row: GridRow = {
      id: `row:${String(r.instrumentId)}`,
      cells,
      subject: r.subject,
      instrumentId: r.instrumentId,
      command: `${r.key} DES`,
    };
    if (groupBy === 'GICS_SECTOR_NAME') row.group = r.gicsSector ?? 'Unclassified';
    else if (groupBy === 'EXCH_CODE') row.group = r.exchCode;
    else if (groupBy === 'MARKET_SECTOR_DES') row.group = r.marketSector;
    return row;
  });
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    // Skeleton: the header from `params.columns` and eight muted rows.
    return {
      title: 'QM · Quote Monitor',
      subtitle: 'loading…',
      body: {
        kind: 'grid',
        id: 'rows',
        frozenColumns: 2,
        columns: [
          { id: 'key', label: 'Security', align: 'left' },
          { id: 'name', label: 'Name', align: 'left' },
          ...params.columns.map((f): GridColumn => ({ id: f, label: f, fieldId: f, align: 'right', live: true })),
        ],
        rows: Array.from({ length: 8 }, (_v, i) => ({
          id: `skeleton:${String(i)}`,
          cells: { key: textCell(null), name: textCell(null) },
          tone: 'muted' as const,
        })),
        emptyText: 'loading…',
      },
      footer: footer(undefined),
      initialFocus: 'rows',
    } satisfies ScreenSpec;
  }

  const grid: Node = {
    kind: 'grid',
    id: 'rows',
    frozenColumns: 2,
    columns: monitorColumns(payload.columns),
    rows: monitorRows(payload.rows, payload.columns, payload.groupBy),
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText:
      payload.source.kind === 'keys'
        ? 'No rows — Insert adds a security'
        : (meta?.unavailable[0]?.detail ?? 'No rows in this universe.'),
    ...(payload.sort === null ? {} : { sort: payload.sort }),
    ...(payload.groupBy === 'none' ? {} : { groupBy: payload.groupBy }),
  };

  const chips: Badge[] = [
    ...payload.skipped.map((s) => ({
      text: `${s.ref}: ${s.reason}`,
      tone: 'warn' as const,
      title: 'Skipped while resolving the universe.',
    })),
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  const body: Node =
    chips.length === 0
      ? grid
      : stack('col', [{ kind: 'badges', id: 'notes', items: chips }, grid], [0.06, 0.94]);

  return {
    title: `QM · ${payload.title}`,
    subtitle: `${String(payload.counts.rows)} rows · live ${String(payload.counts.live)} · pending ${String(payload.counts.pending)} · stale ${String(payload.counts.stale)}`,
    body,
    footer: footer(meta),
    initialFocus: 'rows',
  } satisfies ScreenSpec;
};

export default Screen;
