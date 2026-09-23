// packages/web/src/screens/HP/Screen.tsx — Historical Price Table (FUNCTIONS_TIER1 §HP "Screen").
//
// A toolbar of the parameters that decide what the numbers mean (range, periodicity, adjustment
// basis, currency, order), the paged grid itself, and the window summary. Two variants share the
// shape: `price` over bars, `series` over observations with their vintage and status.
//
// §0.4 rule 6: when the current session is open, HP says so in the footer rather than showing a
// half-formed bar — the open session appears after the close, and GIP is where you watch it.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  FunctionScreen,
  GridColumn,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'HP'>;
type Payload = PayloadOf<'HP'>;

const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'MAX'] as const;
const PERIODICITIES = ['D', 'W', 'M', 'Q', 'Y'] as const;

/** `date` is frozen; every other column comes from the payload with the dictionary's rendering. */
function columnsOf(p: Payload): GridColumn[] {
  const columns: GridColumn[] = [
    { id: 'date', label: 'Date', fmt: 'date', align: 'left', sortable: false },
  ];
  for (const c of p.columns) {
    const col: GridColumn = {
      id: c.id,
      label: c.label,
      fieldId: c.id,
      fmt: c.fmt,
      align: 'right',
      sortable: false,
    };
    if (c.decimals !== null) col.decimals = c.decimals;
    columns.push(col);
  }
  if (p.variant === 'price') {
    columns.push({ id: 'adjFactor', label: 'Adj', fmt: 'px', decimals: 6, align: 'right' });
  } else {
    columns.push({ id: 'status', label: 'Status', fmt: 'text', align: 'left' });
    columns.push({ id: 'vintageAt', label: 'Vintage', fmt: 'datetime', align: 'left' });
  }
  return columns;
}

/**
 * `date ± 3 months` for the `Enter` command, computed from the row's own date string. `Date.UTC`
 * reads no clock, so the screen stays a pure function of its props.
 */
export function shiftMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map((part) => Number(part));
  if (y === undefined || m === undefined || d === undefined) return isoDate;
  const shifted = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(d, lastDay));
  return shifted.toISOString().slice(0, 10);
}

function rowsOf(p: Payload): GridRow[] {
  const provIdx = p.provIdx[0] ?? -1;
  const valueCells = (v: (number | null)[]): GridRow['cells'] => {
    const cells: GridRow['cells'] = {};
    p.columns.forEach((c, i) => {
      const opts = c.decimals === null ? {} : { decimals: c.decimals };
      cells[c.id] = numCell(c.id, v[i] ?? null, provIdx, { fmt: c.fmt, ...opts });
    });
    return cells;
  };
  const command = (date: string): string =>
    `GP CUSTOM ${shiftMonths(date, -3)} ${shiftMonths(date, 3)}`;

  if (p.variant === 'price') {
    return p.rows.map((r) => ({
      id: r.date,
      cells: {
        date: textCell(r.date, { fmt: 'date' }),
        ...valueCells(r.v),
        adjFactor: countCell(r.adjFactor, 'px', 6),
      },
      command: command(r.date),
      tone: 'normal' as const,
    }));
  }
  return p.rows.map((r) => ({
    id: r.date,
    cells: {
      date: textCell(r.date, { fmt: 'date' }),
      ...valueCells(r.v),
      status: textCell(r.status),
      vintageAt: textCell(r.vintageAt, { fmt: 'datetime' }),
    },
    command: command(r.date),
    tone: 'normal' as const,
  }));
}

function toolbar(p: Payload | undefined, params: Params, meta: Parameters<typeof footer>[0]): Node {
  const items: Badge[] = RANGES.map((r) => ({
    text: r,
    tone: r === params.range ? ('ok' as const) : ('info' as const),
  }));
  for (const per of PERIODICITIES) {
    items.push({ text: per, tone: per === params.periodicity ? 'ok' : 'info' });
  }
  items.push({ text: `adjust ${params.adjust}`, tone: 'info' });
  items.push({ text: `order ${params.order}`, tone: 'info' });
  if (p?.variant === 'price') {
    items.push({ text: p.currency, tone: 'info' });
    if (p.converted !== null) {
      items.push({
        text: `converted ${p.converted.from}→${p.converted.to}`,
        tone: 'warn',
        title: 'Prices were converted; the source currency is in the CSV header.',
      });
    }
    if (p.sessionOpen) {
      items.push({
        text: 'session open',
        tone: 'warn',
        title: 'The current session appears after the close; see GIP.',
      });
    }
  }
  for (const adj of meta?.adjustments ?? []) {
    items.push({
      text: `${adj.kind} before ${adj.beforeDate} ×${String(adj.priceFactor)}`,
      tone: 'info',
      title: 'REF-09 adjustment step',
    });
  }
  items.push(...unavailableBadges(meta), ...entitlementBadges(meta), ...stalenessBadges(meta));
  return { kind: 'badges', id: 'toolbar', items };
}

function summary(p: Payload): Node {
  const provIdx = p.provIdx[0] ?? -1;
  if (p.variant === 'price') {
    const s = p.summary;
    return {
      kind: 'kv',
      id: 'summary',
      columns: 3,
      rows: [
        kvRow('First', numCell('PX_LAST', s.first, provIdx)),
        kvRow('Last', numCell('PX_LAST', s.last, provIdx)),
        kvRow('Price return', numCell('RET_1Y', s.priceReturnPct, provIdx, { fmt: 'pct', decimals: 2 })),
        kvRow('High', numCell('PX_HIGH', s.high, provIdx)),
        kvRow('High date', textCell(s.highDate, { fmt: 'date' })),
        kvRow('Total return', numCell('RET_1Y', s.totalReturnPct, provIdx, { fmt: 'pct', decimals: 2 })),
        kvRow('Low', numCell('PX_LOW', s.low, provIdx)),
        kvRow('Low date', textCell(s.lowDate, { fmt: 'date' })),
        kvRow('Avg volume', numCell('VOLUME_AVG_30D', s.avgVolume, provIdx)),
        kvRow('Bars', countCell(s.bars)),
        kvRow('From', textCell(s.firstDate, { fmt: 'date' })),
        kvRow('To', textCell(s.lastDate, { fmt: 'date' })),
      ],
    };
  }
  const s = p.summary;
  return {
    kind: 'kv',
    id: 'summary',
    columns: 3,
    rows: [
      kvRow('First', numCell('ECO_VALUE', s.first, provIdx)),
      kvRow('Last', numCell('ECO_VALUE', s.last, provIdx)),
      kvRow('Change', numCell('CHG_NET_1D', s.changeAbs, provIdx)),
      kvRow('High', numCell('PX_HIGH', s.high, provIdx)),
      kvRow('High date', textCell(s.highDate, { fmt: 'date' })),
      kvRow('Change %', numCell('CHG_PCT_1D', s.changePct, provIdx, { fmt: 'pct', decimals: 2 })),
      kvRow('Low', numCell('PX_LOW', s.low, provIdx)),
      kvRow('Low date', textCell(s.lowDate, { fmt: 'date' })),
      kvRow('Observations', countCell(s.observations)),
    ],
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = payload?.instrument.display ?? instrument?.display ?? '—';
  const name = payload?.instrument.name ?? instrument?.name ?? '';
  const currency =
    payload === undefined
      ? (params.currency ?? '')
      : payload.variant === 'price'
        ? payload.currency
        : payload.series.units;
  const title = `HP · ${display} · ${name}`;
  const subtitle = `${params.range} · ${params.periodicity} · ${params.adjust} · ${currency}`;

  if (payload === undefined) {
    // Skeleton: the toolbar from the params, the grid header and ten muted rows.
    const grid: Node = {
      kind: 'grid',
      id: 'rows',
      frozenColumns: 1,
      columns: [
        { id: 'date', label: 'Date', fmt: 'date', align: 'left' },
        ...params.fields.map(
          (f): GridColumn => ({ id: f, label: f, fieldId: f, align: 'right' }),
        ),
      ],
      rows: Array.from({ length: 10 }, (_v, i) => ({
        id: `skeleton:${String(i)}`,
        cells: { date: textCell(null) },
        tone: 'muted' as const,
      })),
      emptyText: 'loading…',
    };
    return {
      title,
      subtitle,
      body: stack('col', [toolbar(undefined, params, meta), grid, { kind: 'text', id: 'summary', text: '…', tone: 'muted' }], [0.07, 0.83, 0.1]),
      footer: footer(undefined),
      initialFocus: 'rows',
    } satisfies ScreenSpec;
  }

  const grid: Node = {
    kind: 'grid',
    id: 'rows',
    frozenColumns: 1,
    columns: columnsOf(payload),
    rows: rowsOf(payload),
    sort: { col: 'date', dir: params.order },
    selectable: true,
    emptyText:
      meta?.unavailable[0]?.detail ?? 'No observations in this window.',
    ...(meta?.page === undefined
      ? {}
      : { page: { index: meta.page.index, count: meta.page.count } }),
  };

  const notes: string[] = [];
  if (payload.variant === 'price' && payload.sessionOpen) {
    notes.push('Session open — the current session appears after the close; see GIP');
  }
  if (payload.variant === 'series') notes.push(`knownAt=${payload.knownAt}`);

  return {
    title,
    subtitle,
    body: stack('col', [toolbar(payload, params, meta), grid, summary(payload)], [0.07, 0.83, 0.1]),
    footer: footer(meta, notes),
    initialFocus: 'rows',
  } satisfies ScreenSpec;
};

export default Screen;
