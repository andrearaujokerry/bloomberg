// packages/web/src/screens/EE/Screen.tsx — Earnings (FUNCTIONS_TIER2.md §EE "Screen").
//
// EE is the screen built out of what the wedge actually has: SEC actuals, their filing provenance
// and a next expected report date derived from the issuer's own filing cadence. There is no
// estimates provider, so the `estimate` and `surprise` columns are **unavailable with a reason**,
// never blank and never zero (BRIEF §2).
//
// One forced departure from the ASCII layout, stated here rather than hidden: §1.5's `Cell` has no
// tooltip field, so "`—` with tooltip `NO_ESTIMATES_SOURCE`" is rendered as an em dash in the cell
// with the reason carried by three things the reader can actually see — the column label, the
// `badges#reason` chip (whose `title` is the full detail string) and a footer note. Nothing about
// the column is blank-without-a-reason.
//
// Pure: no DOM, no state, no IO.

import { getField } from '@terminal/core';
import type { FieldId, ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, FunctionScreen, GridColumn, GridRow, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  EM_DASH,
  countCell,
  entitlementBadges,
  footer,
  kvRow,
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'EE'>;
type Payload = PayloadOf<'EE'>;
type HistoryRow = Payload['history'][number];

/** `NO_ESTIMATES_SOURCE` as the screen names it — one string, used by the column and the badge. */
const NO_ESTIMATES = 'NO_ESTIMATES_SOURCE';
const NO_ESTIMATES_DETAIL =
  'NO_ESTIMATES_SOURCE: no consensus-estimates provider in the wedge (BRIEF §2). The column is shown, empty and explained, rather than dropped.';

/**
 * The dictionary field the metric's `actual` column is a value of. `REVENUE` is the payload's own
 * id for the line the dictionary calls `SALES_REV_TURN`; the other three are dictionary ids.
 */
function metricField(metric: Payload['metric']): FieldId | null {
  const id = metric === 'REVENUE' ? 'SALES_REV_TURN' : metric;
  return getField(id) === undefined ? null : id;
}

function nextBlock(p: Payload): Node {
  const next = p.next;
  const unitFmt = p.unit === 'per_share' ? ('px' as const) : ('ccy' as const);
  const field = metricField(p.metric);
  const last = p.history[0] ?? null;

  const rows = [
    kvRow('Next expected', textCell(next?.expectedDate ?? null, { fmt: 'date' })),
    kvRow(
      'Window',
      textCell(next === null ? null : `${next.window[0]} … ${next.window[1]}`),
    ),
    kvRow('Basis', textCell(next?.basis ?? null)),
    kvRow('Confidence', countCell(next?.confidence ?? null, 'pct', 2)),
    kvRow(
      `Last actual (${p.metric})`,
      field === null
        ? countCell(last?.actual ?? null, unitFmt, 2)
        : numCell(field, last?.actual ?? null, last?.provIdx ?? -1, { fmt: unitFmt, decimals: 2 }),
    ),
    kvRow(
      'TTM',
      field === null
        ? countCell(p.ttm.value, unitFmt, 2)
        : numCell(field, p.ttm.value, last?.provIdx ?? -1, { fmt: unitFmt, decimals: 2 }),
    ),
    kvRow(`Consensus (${NO_ESTIMATES})`, textCell(EM_DASH)),
  ];

  return { kind: 'kv', id: 'next', title: 'Next report', columns: 2, rows };
}

function historyGrid(p: Payload): Node {
  const unitFmt = p.unit === 'per_share' ? ('px' as const) : ('ccy' as const);
  const field = metricField(p.metric);

  const columns: GridColumn[] = [
    { id: 'periodEnd', label: 'Period end', align: 'left', fmt: 'date' },
    { id: 'fp', label: 'FY/FP', align: 'left' },
    {
      id: 'actual',
      label: `Actual (${p.metric})`,
      align: 'right',
      fmt: unitFmt,
      decimals: 2,
      ...(field === null ? {} : { fieldId: field }),
    },
    { id: 'yoy', label: 'YoY %', align: 'right', fmt: 'pct', decimals: 2 },
    { id: 'qoq', label: 'QoQ %', align: 'right', fmt: 'pct', decimals: 2 },
    // The reason rides the column label: `Cell` has no tooltip and the column may never be blank
    // without saying why (BRIEF §2).
    { id: 'estimate', label: `Estimate — ${NO_ESTIMATES}`, align: 'right' },
    { id: 'surprise', label: `Surprise % — ${NO_ESTIMATES}`, align: 'right' },
    { id: 'reported', label: 'Reported', align: 'left', fmt: 'datetime' },
    { id: 'timing', label: 'Timing', align: 'left' },
    { id: 'filed', label: 'Filed', align: 'left', fmt: 'date' },
    { id: 'form', label: 'Form', align: 'left' },
  ];

  const rows: GridRow[] = p.history.map((r: HistoryRow) => ({
    id: `ee:${r.periodEnd}`,
    cells: {
      periodEnd: textCell(r.periodEnd, { fmt: 'date' }),
      fp: textCell(
        r.fiscalYear === null ? (r.fiscalPeriod ?? null) : `${String(r.fiscalYear)} ${r.fiscalPeriod ?? ''}`.trim(),
      ),
      actual:
        field === null
          ? countCell(r.actual, unitFmt, 2)
          : numCell(field, r.actual, r.provIdx, { fmt: unitFmt, decimals: 2 }),
      yoy: countCell(r.yoyPct, 'pct', 2),
      qoq: countCell(r.qoqPct, 'pct', 2),
      estimate: textCell(EM_DASH),
      surprise: textCell(EM_DASH),
      reported: textCell(r.reportedAt, { fmt: 'datetime' }),
      timing: textCell(r.reportTiming),
      filed: textCell(r.filedAt.slice(0, 10), { fmt: 'date' }),
      form: textCell(r.form),
    },
    tone: 'normal' as const,
  }));

  return {
    kind: 'grid',
    id: 'history',
    columns,
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No SEC actuals stored for this issuer at this knownAt.',
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = instrument?.display ?? 'security';

  if (payload === undefined) {
    return {
      title: `EE · ${display}`,
      subtitle: 'loading…',
      body: stack('col', [
        {
          kind: 'kv',
          id: 'next',
          title: 'Next report',
          columns: 2,
          rows: [
            kvRow('Next expected', textCell(null)),
            kvRow('Window', textCell(null)),
            kvRow('Basis', textCell(null)),
            kvRow('Confidence', textCell(null)),
          ],
        },
        {
          kind: 'grid',
          id: 'history',
          columns: [
            { id: 'periodEnd', label: 'Period end', align: 'left' },
            { id: 'actual', label: 'Actual', align: 'right' },
          ],
          rows: Array.from({ length: params.periods }, (_v, i) => ({
            id: `skeleton:${String(i)}`,
            cells: { periodEnd: textCell(null) },
            tone: 'muted' as const,
          })),
          emptyText: 'loading…',
        },
      ]),
      footer: footer(undefined),
      initialFocus: 'history',
    } satisfies ScreenSpec;
  }

  const reasons: Badge[] = [
    { text: `ESTIMATES UNAVAILABLE · ${NO_ESTIMATES}`, tone: 'warn', title: NO_ESTIMATES_DETAIL },
    ...entitlementBadges(meta),
    ...unavailableBadges(meta),
    ...stalenessBadges(meta),
  ];

  const spark: Node = {
    kind: 'custom',
    id: 'spark',
    component: 'Sparkline',
    props: { points: payload.sparkline, fmt: payload.unit === 'per_share' ? 'px' : 'ccy' },
  };

  return {
    title: `EE · ${display} · ${payload.issuer.name} · Earnings (SEC actuals)`,
    subtitle: `${payload.metric} · ${String(payload.history.length)} periods · knownAt ${payload.knownAt.slice(0, 10)}`,
    body: stack(
      'col',
      [
        nextBlock(payload),
        { kind: 'badges', id: 'reason', items: reasons },
        spark,
        historyGrid(payload),
      ],
      [0.2, 0.06, 0.14, 0.6],
    ),
    footer: footer(meta, [NO_ESTIMATES_DETAIL]),
    initialFocus: 'history',
  } satisfies ScreenSpec;
};

export default Screen;
