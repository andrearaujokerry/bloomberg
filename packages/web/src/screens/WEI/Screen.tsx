// packages/web/src/screens/WEI/Screen.tsx — World Equity Indices (FUNCTIONS_TIER1 §WEI "Screen").
//
// Three regional grids, each a monitor over the indices of that region, under a chip row that
// accounts for everything the grids cannot show.
//
// WEI is where the two "absent" states have to stay distinguishable, because most of the board is
// one or the other outside its own trading hours:
//   * **pending** — the index is seeded and nothing has been polled yet: `…`, no reason.
//   * **unknown session** — the venue has no seeded calendar: the session chip is grey and carries
//     `NO_CALENDAR_FOR_VENUE`, and the period returns beside it are null with their reason, never
//     quietly computed on raw calendar days (§0.6).

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { monitorColumns } from '../QM/Screen.js';
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

type Params = ParamsOf<'WEI'>;
type Payload = PayloadOf<'WEI'>;
type Region = Payload['regions'][number];

/** `grid#americas`, `grid#emea`, `grid#apac` — the node id of a region's grid. */
export function regionId(region: Region['region']): string {
  return region.toLowerCase();
}

function columnsOf(p: Payload): GridColumn[] {
  const base = monitorColumns(p.columns);
  // `code` replaces `key` as the first frozen column, and `ccy` joins it (§WEI `frozenColumns: 3`).
  const columns: GridColumn[] = [
    { id: 'key', label: 'Code', align: 'left', sortable: true },
    { id: 'name', label: 'Name', align: 'left', sortable: true },
    { id: 'ccy', label: 'Ccy', align: 'left' },
    ...base.slice(2),
  ];
  columns.push({ id: 'session', label: 'Session', align: 'left' });
  columns.push({ id: 'local', label: 'Local', align: 'left' });
  return columns;
}

function rowsOf(p: Payload, region: Region): GridRow[] {
  return region.rows.map((r) => {
    const cells: GridRow['cells'] = {
      key: textCell(r.code, { command: `${r.key} DES` }),
      name: textCell(
        r.methodology === 'volatility' ? `${r.name} · volatility` : r.name,
      ),
      ccy: textCell(r.calcCurrency, { fieldId: 'CRNCY' }),
      session: textCell(r.sessionState, {
        fieldId: 'SESSION_STATE',
      }),
      local: textCell(r.localTime),
    };
    for (const c of p.columns) {
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
    return {
      id: `wei:${r.code}`,
      cells,
      subject: r.subject,
      instrumentId: r.instrumentId,
      command: `${r.key} DES`,
      tone: r.sessionSource === 'none' ? ('muted' as const) : ('normal' as const),
    };
  });
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    // Skeleton: the three region headers and thirteen muted rows with `…` cells.
    const children: Node[] = [];
    for (const region of params.regions) {
      children.push({ kind: 'text', id: `region-${region.toLowerCase()}`, text: region.toUpperCase() });
      children.push({
        kind: 'grid',
        id: region.toLowerCase(),
        columns: [
          { id: 'key', label: 'Code', align: 'left' },
          { id: 'name', label: 'Name', align: 'left' },
          ...params.columns.map((f): GridColumn => ({ id: f, label: f, fieldId: f, align: 'right', live: true })),
        ],
        rows: Array.from({ length: 5 }, (_v, i) => ({
          id: `skeleton:${region}:${String(i)}`,
          cells: { key: textCell(null) },
          tone: 'muted' as const,
        })),
        emptyText: 'loading…',
      });
    }
    return {
      title: 'WEI · World Equity Indices',
      subtitle: 'loading…',
      body: stack('col', [{ kind: 'badges', id: 'notes', items: [] }, ...children]),
      footer: footer(undefined),
      initialFocus: (params.regions[0] ?? 'Americas').toLowerCase(),
    } satisfies ScreenSpec;
  }

  const columns = columnsOf(payload);
  const children: Node[] = [];
  for (const region of payload.regions) {
    children.push({
      kind: 'text',
      id: `region-${regionId(region.region)}`,
      text: region.label.toUpperCase(),
    });
    children.push({
      kind: 'grid',
      id: regionId(region.region),
      columns,
      rows: rowsOf(payload, region),
      frozenColumns: 3,
      selectable: true,
      live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
      emptyText: 'No indices seeded for this region.',
      ...(payload.sort === null ? {} : { sort: payload.sort }),
    });
  }

  const notes: Badge[] = [];
  if (payload.counts.pending > 0) {
    notes.push({
      text: `${String(payload.counts.pending)} indices pending — no recorded quote`,
      tone: 'info',
      title: 'Seeded, never polled: the cell is pending, not denied (§0.4 rule 1).',
    });
  }
  const noCalendar = payload.regions
    .flatMap((r) => r.rows)
    .filter((r) => r.calendarId === null || r.sessionSource === 'none');
  if (noCalendar.length > 0) {
    notes.push({
      text: `${String(noCalendar.length)} venues without a seeded calendar`,
      tone: 'warn',
      title: `NO_CALENDAR_FOR_VENUE — ${noCalendar.map((r) => r.mic ?? r.code).join(', ')}`,
    });
  }
  for (const s of payload.skipped) {
    notes.push({ text: `${s.code}: ${s.reason}`, tone: 'warn' });
  }
  notes.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  const conventions = payload.conventions;
  const subtitle =
    payload.view === 'levels'
      ? `${String(payload.counts.rows)} rows · live ${String(payload.counts.live)} · pending ${String(payload.counts.pending)} · levels · local currency`
      : `${String(payload.counts.rows)} rows · live ${String(payload.counts.live)} · pending ${String(payload.counts.pending)} · returns: ${conventions.returns}, ${conventions.priceBasis}, adjust ${conventions.adjust}, ${String(conventions.annualisation)}d (ANAL-07)`;

  return {
    title: 'WEI · World Equity Indices',
    subtitle,
    body: stack('col', [{ kind: 'badges', id: 'notes', items: notes }, ...children]),
    footer: footer(meta),
    initialFocus: regionId(payload.regions[0]?.region ?? 'Americas'),
  } satisfies ScreenSpec;
};

export default Screen;
