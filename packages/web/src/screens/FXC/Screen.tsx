// packages/web/src/screens/FXC/Screen.tsx — FX Cross Matrix (FUNCTIONS_TIER2.md §FXC "Screen").
//
// A 10 × 10 matrix of indicative mids, a pair monitor under it, and — in ECB mode — the fixing
// against the live quote.
//
// The matrix is a `custom#matrix` node, NOT a chart: §FXC is explicit that it builds no `ChartSpec`
// (§7.2 rule 8 does not apply). Its props carry one `Cell` per matrix cell so the renderer gets the
// same value/state/provenance triple it gets everywhere else, plus the derivation of a cross and
// BOTH of its legs' provenance indices — a cross that cited one leg would be lying about where half
// the number came from.
//
// Pure: no DOM, no state, no IO.

import type { MonitorColumn, ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, Cell, FunctionScreen, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import { monitorColumns, monitorRows } from '../QM/Screen.js';
import {
  computedCell,
  countCell,
  entitlementBadges,
  footer,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'FXC'>;
type Payload = PayloadOf<'FXC'>;
type FxcCell = Payload['matrix'][number][number];

/** One matrix cell as the renderer receives it: the value, its derivation and every leg it cites. */
export interface MatrixCell {
  base: string;
  quote: string;
  kind: FxcCell['kind'];
  value: Cell;
  chgPct: Cell;
  key: string | null;
  subject: string | null;
  via: string | null;
  derivation: string | null;
  legProvIdx: number[];
  legSourceIds: string[];
  command: string | null;
}

function matrixCell(c: FxcCell): MatrixCell {
  return {
    base: c.base,
    quote: c.quote,
    kind: c.kind,
    // An FX rate has no dictionary field of its own on a cross (it is `EURUSD × USDJPY`, not
    // `PX_LAST` of anything), so the whole matrix is cited at block level through `provIdx` and
    // `legProvIdx` rather than by naming a field per cell.
    value: computedCell(c.rate, 'px', c.decimals),
    chgPct: computedCell(c.chgPct1d, 'pct', 2),
    key: c.key,
    subject: c.subject,
    via: c.via,
    derivation: c.derivation,
    legProvIdx: c.legProvIdx,
    legSourceIds: c.legSourceIds,
    command: c.key === null ? null : `${c.key} DES`,
  };
}

function ecbTable(p: Payload): Node {
  return {
    kind: 'table',
    id: 'ecbCompare',
    caption: `ECB reference fixing${p.rateDate === null ? '' : ` ${p.rateDate}`} vs live`,
    columns: [
      { id: 'pair', label: 'Pair', type: 'string' },
      { id: 'live', label: 'Live', type: 'number', decimals: 5 },
      { id: 'ecb', label: 'ECB fixing', type: 'number', decimals: 5 },
      { id: 'diff', label: 'Diff %', type: 'number', decimals: 3 },
    ],
    rows: (p.ecbCompare ?? []).map((r) => [
      textCell(`${r.base}${r.quote}`),
      countCell(r.live, 'px', 5),
      countCell(r.ecb, 'px', 5),
      countCell(r.diffPct, 'pct', 3),
    ]),
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    const ccys = params.ccys;
    return {
      title: 'FXC · FX Cross Matrix',
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'badges',
          id: 'caveat',
          items: [
            { text: 'INDICATIVE_MID_ONLY', tone: 'warn' },
            { text: 'NO_FX_DEPTH_SOURCE', tone: 'warn' },
            { text: 'CROSSES_DERIVED_VIA_USD', tone: 'info' },
          ],
        },
        {
          kind: 'custom',
          id: 'matrix',
          component: 'Composer',
          props: {
            ccys,
            rows: ccys.map((base) =>
              ccys.map((quote) => ({
                base,
                quote,
                kind: base === quote ? 'unity' : 'direct',
                value: { v: null, st: 'blank', provIdx: -1, fmt: 'px' },
                chgPct: { v: null, st: 'blank', provIdx: -1, fmt: 'pct' },
                key: null,
                subject: null,
                via: null,
                derivation: null,
                legProvIdx: [],
                legSourceIds: [],
                command: null,
              })),
            ),
          },
        },
        {
          kind: 'grid',
          id: 'pairs',
          columns: [
            { id: 'key', label: 'Pair', align: 'left' },
            { id: 'PX_LAST', label: 'Last', align: 'right' },
          ],
          rows: Array.from({ length: 9 }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { key: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'matrix',
    } satisfies ScreenSpec;
  }

  const caveats: Badge[] = [
    { text: 'INDICATIVE_MID_ONLY', tone: 'warn', title: 'Yahoo indicative mids, 15 minutes delayed; there is no tradable quote here.' },
    { text: 'NO_FX_DEPTH_SOURCE', tone: 'warn', title: 'No bid/ask depth source in the wedge.' },
    { text: 'CROSSES_DERIVED_VIA_USD', tone: 'info', title: 'A non-USD cross is the product of its two USD legs; both legs are cited.' },
  ];
  if (payload.missing.length > 0) {
    caveats.push({
      text: `NO_SEEDED_PAIR ${payload.missing.join(', ')}`,
      tone: 'warn',
      title: 'These currencies have no seeded USD pair, so their row and column are blank rather than guessed.',
    });
  }
  for (const note of payload.notes) {
    if (caveats.some((c) => c.text === note)) continue;
    caveats.push({ text: note, tone: 'warn' });
  }
  caveats.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));

  const matrix: Node = {
    kind: 'custom',
    id: 'matrix',
    // `Composer` is the only §1.5 `custom` component that is a keyboard-driven editor grid rather
    // than a chart; the matrix takes it because §FXC gives the node its own arrow-key handling and
    // explicitly says it is not a `ChartSpec`. WP-12 renders it.
    component: 'Composer',
    props: {
      ccys: payload.ccys,
      quote: payload.quote,
      rateDate: payload.rateDate,
      transpose: params.transpose,
      rows: payload.matrix.map((row) => row.map(matrixCell)),
    },
  };

  const pairColumns: MonitorColumn[] = payload.pairColumns;
  const pairs: Node = {
    kind: 'grid',
    id: 'pairs',
    columns: monitorColumns(pairColumns),
    rows: monitorRows(payload.pairs, pairColumns, 'none'),
    frozenColumns: 2,
    selectable: true,
    live: { subjectOf: (row: GridRow): string | null => row.subject ?? null },
    emptyText: 'No direct pairs seeded.',
  };

  const children: Node[] = [
    { kind: 'badges', id: 'caveat', items: caveats },
    {
      kind: 'tabs',
      id: 'quote',
      active: payload.quote,
      tabs: [
        {
          id: 'live',
          label: 'LIVE',
          key: '1',
          body:
            payload.quote === 'live'
              ? matrix
              : { kind: 'text' as const, id: 'tab-live', text: 'Press 1 for live indicative mids.', tone: 'muted' as const },
        },
        {
          id: 'ecb',
          label: `ECB${payload.rateDate === null ? '' : ` ${payload.rateDate}`}`,
          key: '2',
          body:
            payload.quote === 'ecb'
              ? matrix
              : { kind: 'text' as const, id: 'tab-ecb', text: 'Press 2 for the ECB reference fixing.', tone: 'muted' as const },
        },
      ],
    },
    pairs,
  ];
  if (payload.ecbCompare !== null) children.push(ecbTable(payload));

  return {
    title: 'FXC · FX Cross Matrix',
    subtitle:
      payload.quote === 'ecb'
        ? `ECB reference · ${payload.rateDate ?? '—'} · ${String(payload.ccys.length)} currencies`
        : `live (indicative mid, 15-min delayed) · ${String(payload.ccys.length)} currencies`,
    body: stack('col', children),
    footer: footer(meta, payload.notes),
    initialFocus: 'matrix',
  } satisfies ScreenSpec;
};

export default Screen;
