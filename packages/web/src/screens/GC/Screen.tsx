// packages/web/src/screens/GC/Screen.tsx — Benchmark Curve Chart (FUNCTIONS_TIER3 §GC "Screen").
//
// The time view of the curves CRVF constructs: one date against up to four earlier ones with the
// basis-point change at every tenor and the slope spreads, or selected tenors and those spreads as
// daily series over a range.
//
// `screenKind: 'custom'` — the plot is a `custom#chart` node carrying a `CurveChart` component and
// a `ChartSpec` this file builds. Nothing is drawn here; what is decided here is which series
// exist, what they carry and which provenance entry each cites. The renderer is WP-12's.
//
// The rule that shapes both modes: **a missing observation is a gap, never a joined line.** §1.5
// defines `NaN` in a series as a break, so a tenor with no stored value on a comparison date, and a
// day with no observation in a history series, both become `NaN` — the chart shows a hole where
// the data has one, and the grid shows an em dash in the same place.
//
// Pure: no DOM, no state, no IO.

import type { FieldId, ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  Cell,
  ChartSeries,
  ChartSpec,
  FunctionScreen,
  GridColumn,
  GridRow,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  computedCell,
  cell,
  countCell,
  entitlementBadges,
  footer,
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'GC'>;
type Payload = PayloadOf<'GC'>;
type Snapshot = Payload['snapshots'][number];
type Change = Payload['changes'][number];
type SpreadRow = Payload['spreads'][number];

const CRV_TENOR_FIELDS: Readonly<Record<string, FieldId>> = {
  '1M': 'CRV_1M',
  '2M': 'CRV_2M',
  '3M': 'CRV_3M',
  '6M': 'CRV_6M',
  '1Y': 'CRV_1Y',
  '2Y': 'CRV_2Y',
  '3Y': 'CRV_3Y',
  '5Y': 'CRV_5Y',
  '7Y': 'CRV_7Y',
  '10Y': 'CRV_10Y',
  '20Y': 'CRV_20Y',
  '30Y': 'CRV_30Y',
};

/** The dictionary field a curve quote at `tenor` is a value of. */
const tenorField = (tenor: string): FieldId => CRV_TENOR_FIELDS[tenor] ?? 'CURVE_PAR';

/** An ISO date at midnight UTC, the x value of a daily observation. A pure conversion. */
const epochOf = (d: string): number => Date.parse(`${d}T00:00:00Z`);

const numberOf = (c: Cell | { v: unknown }): number =>
  typeof c.v === 'number' ? c.v : Number.NaN;

/** The `ChartSpec` the `CurveChart` component renders in each mode; built here, drawn by WP-12. */
export function gcChartSpec(p: Payload): ChartSpec {
  if (p.mode === 'curve') {
    const series: ChartSeries[] = p.snapshots.map((s: Snapshot, i): ChartSeries => ({
      id: s.id,
      label: s.label,
      type: 'line',
      pane: 'main',
      yAxis: 'y',
      x: s.points.map((pt) => pt.tenorDays),
      y: s.points.map((pt) => numberOf(pt.value)),
      provIdx: s.provIdx,
      style: { color: i === 0 ? 'auto' : 'neutral', dashed: i > 0 },
    }));
    const first = p.snapshots[0];
    if (first !== undefined) {
      series.push({
        id: 'inputs',
        label: `${first.label} points`,
        type: 'scatter',
        pane: 'main',
        yAxis: 'y',
        x: first.points.map((pt) => pt.tenorDays),
        y: first.points.map((pt) => numberOf(pt.value)),
        provIdx: first.provIdx,
      });
    }
    return {
      kind: 'curve',
      xAxis: { type: 'tenor' },
      yAxes: [{ id: 'y', side: 'left', scale: 'linear', fmt: 'pct', decimals: 3 }],
      panes: [{ id: 'main', height: 1 }],
      series,
      crosshair: true,
      reference: [],
    };
  }

  const history = p.history;
  const series: ChartSeries[] = (history?.series ?? []).map((s): ChartSeries => ({
    id: `tenor:${s.tenor}`,
    label: `${s.tenor} (${s.seriesCode ?? s.source})`,
    type: 'line',
    pane: 'main',
    yAxis: 'y',
    x: s.obs.map((o) => epochOf(o.d)),
    y: s.obs.map((o) => o.v ?? Number.NaN),
    provIdx: s.provIdx,
  }));
  for (const s of history?.spreadSeries ?? []) {
    series.push({
      id: `spread:${s.id}`,
      label: s.label,
      type: 'line',
      pane: 'spread',
      yAxis: 'bp',
      x: s.obs.map((o) => epochOf(o.d)),
      y: s.obs.map((o) => o.v ?? Number.NaN),
      provIdx: p.curve.provIdx,
    });
  }
  return {
    kind: 'price',
    xAxis: { type: 'time', tz: 'America/New_York', calendarId: 'SIFMA' },
    yAxes: [
      { id: 'y', side: 'left', scale: 'linear', fmt: 'pct', decimals: 3 },
      { id: 'bp', side: 'right', scale: 'linear', fmt: 'bp', decimals: 1 },
    ],
    panes: [
      { id: 'main', height: 0.7 },
      { id: 'spread', height: 0.3, title: 'Spread (bp)' },
    ],
    series,
    crosshair: true,
  };
}

function changesGrid(p: Payload): Node {
  const compares = p.snapshots.slice(1);
  const columns: GridColumn[] = [
    { id: 'tenor', label: 'Tenor', align: 'left', sortable: true },
    { id: 'days', label: 'Days', align: 'right', fmt: 'int' },
    { id: 'current', label: p.snapshots[0]?.label ?? p.curve.date, align: 'right', fmt: 'pct', decimals: 3 },
  ];
  for (const s of compares) {
    columns.push(
      { id: `v:${s.id}`, label: s.label, align: 'right', fmt: 'pct', decimals: 3 },
      { id: `bp:${s.id}`, label: `Δbp ${s.label}`, align: 'right', fmt: 'bp', decimals: 1 },
    );
  }

  const pointOf = (snapshot: Snapshot, tenor: string): number | null => {
    const point = snapshot.points.find((pt) => pt.tenor === tenor);
    return point !== undefined && typeof point.value.v === 'number' ? point.value.v : null;
  };

  const rows: GridRow[] = p.changes.map((c: Change): GridRow => {
    const cells: Record<string, Cell> = {
      tenor: textCell(c.tenor),
      days: countCell(c.tenorDays),
      current: cell(tenorField(c.tenor), c.current, { fmt: 'pct', decimals: 3 }),
    };
    for (const s of compares) {
      cells[`v:${s.id}`] = numCell(tenorField(c.tenor), pointOf(s, c.tenor), s.provIdx, {
        fmt: 'pct',
        decimals: 3,
      });
      const vs = c.vs.find((v) => v.id === s.id);
      cells[`bp:${s.id}`] =
        vs === undefined
          ? computedCell({ v: null, st: 'na', provIdx: -1 }, 'bp', 1)
          : computedCell(vs.bp, 'bp', 1);
    }
    return { id: `chg:${c.tenor}`, cells };
  });

  return {
    kind: 'grid',
    id: 'changes',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    emptyText: 'No tenor is published on both this date and any comparison date.',
  };
}

function spreadsTable(p: Payload): Node {
  const compares = p.snapshots.slice(1);
  return {
    kind: 'table',
    id: 'spreads',
    caption: 'Slope spreads (long − short), basis points',
    columns: [
      { id: 'spread', label: 'Spread', type: 'string' },
      { id: 'legs', label: 'Legs', type: 'string' },
      { id: 'current', label: 'Current', type: 'number', decimals: 1 },
      ...compares.map((s) => ({ id: `bp:${s.id}`, label: `Δ vs ${s.label}`, type: 'number' as const, decimals: 1 })),
    ],
    rows: p.spreads.map((s: SpreadRow): Cell[] => [
      textCell(s.id),
      textCell(`${s.legs[1]} − ${s.legs[0]}`),
      cell('SPREAD', s.current, { fmt: 'bp', decimals: 1, signed: true }),
      ...compares.map((c): Cell => {
        const vs = s.vs.find((v) => v.id === c.id);
        return vs === undefined
          ? computedCell({ v: null, st: 'na', provIdx: -1 }, 'bp', 1)
          : computedCell(vs.bp, 'bp', 1);
      }),
    ]),
  };
}

function seriesGrid(p: Payload): Node {
  const rows: GridRow[] = (p.history?.series ?? []).map((s): GridRow => {
    const last = s.obs.length === 0 ? null : (s.obs[s.obs.length - 1]?.v ?? null);
    const first = s.obs.length === 0 ? null : (s.obs[0]?.v ?? null);
    const rangeBp = last === null || first === null ? null : (last - first) * 100;
    return {
      id: `series:${s.tenor}`,
      cells: {
        tenor: textCell(s.tenor),
        source: textCell(s.source),
        seriesCode: textCell(s.seriesCode),
        first: textCell(s.coverage.first, { fmt: 'date' }),
        last: textCell(s.coverage.last, { fmt: 'date' }),
        n: countCell(s.coverage.n),
        lastValue: numCell('ECO_VALUE', last, s.provIdx, { fmt: 'pct', decimals: 3 }),
        rangeBp: computedCell(
          rangeBp === null ? { v: null, st: 'na', provIdx: -1 } : { v: rangeBp, st: 'closed', provIdx: s.provIdx },
          'bp',
          1,
        ),
      },
      tone: s.truncated ? 'muted' : 'normal',
    };
  });

  return {
    kind: 'grid',
    id: 'series',
    columns: [
      { id: 'tenor', label: 'Tenor', align: 'left' },
      { id: 'source', label: 'Source', align: 'left' },
      { id: 'seriesCode', label: 'Series', align: 'left' },
      { id: 'first', label: 'First', align: 'left', fmt: 'date' },
      { id: 'last', label: 'Last', align: 'left', fmt: 'date' },
      { id: 'n', label: 'n', align: 'right', fmt: 'int' },
      { id: 'lastValue', label: 'Last %', align: 'right', fieldId: 'ECO_VALUE', fmt: 'pct', decimals: 3 },
      { id: 'rangeBp', label: 'Δ range bp', align: 'right', fmt: 'bp', decimals: 1 },
    ],
    rows,
    frozenColumns: 1,
    selectable: true,
    emptyText: 'No tenor of this curve has a stored long-history series.',
  };
}

function gapsText(p: Payload): Node {
  const truncated = (p.history?.series ?? []).filter((s) => s.truncated);
  const lines = truncated.map(
    (s) =>
      `${s.seriesCode ?? s.tenor} stored from ${s.coverage.first ?? '—'}; requested from ${p.history?.from ?? '—'}`,
  );
  return {
    kind: 'text',
    id: 'gaps',
    tone: lines.length === 0 ? 'muted' : 'warn',
    text:
      lines.length === 0
        ? 'Every requested tenor has a stored series covering the whole range.'
        : lines.join(' · '),
  };
}

function caveatBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = p.caveats.map((c) => ({
    text: c,
    tone: 'warn' as const,
    title:
      c === 'CURVE_DATES_ONLY'
        ? 'This build stores a handful of curve dates, so a relative comparison resolves to the earliest stored date or is dropped with a reason.'
        : c === 'NO_LONG_HISTORY_FOR_TENOR'
          ? 'A requested tenor has no stored long-history series; it is left blank rather than interpolated.'
          : c,
  }));
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

const sizesFor = (view: Params['view']): number[] =>
  view === 'chart' ? [1, 0] : view === 'table' ? [0, 1] : [0.58, 0.42];

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: `GC · ${params.curveId}`,
      subtitle: 'loading…',
      body: stack(
        'col',
        [
          { kind: 'badges', id: 'caveats', items: [] },
          {
            kind: 'custom',
            id: 'chart',
            component: 'CurveChart',
            props: {
              spec: {
                kind: 'curve',
                xAxis: { type: 'tenor' },
                yAxes: [{ id: 'y', side: 'left', scale: 'linear', fmt: 'pct', decimals: 3 }],
                panes: [{ id: 'main', height: 1 }],
                series: [],
                crosshair: true,
              } satisfies ChartSpec,
            },
          },
          {
            kind: 'grid',
            id: 'changes',
            columns: [{ id: 'tenor', label: 'Tenor', align: 'left' }],
            rows: Array.from({ length: 11 }, (_v, i) => ({
              id: `gc-skeleton:${String(i)}`,
              cells: { tenor: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.08, 0.5, 0.42],
      ),
      footer: footer(undefined),
      initialFocus: 'chart',
    } satisfies ScreenSpec;
  }

  const lower: Node =
    payload.mode === 'curve'
      ? stack('col', [changesGrid(payload), spreadsTable(payload)], [0.66, 0.34])
      : stack('col', [seriesGrid(payload), gapsText(payload)], [0.8, 0.2]);

  const title =
    payload.mode === 'curve'
      ? `GC · ${payload.curve.id} · ${payload.curve.name} · ${payload.curve.date}`
      : `GC · ${payload.curve.id} · ${payload.curve.name} · ${payload.history?.range ?? params.range} to ${payload.curve.date}`;

  const subtitle =
    payload.mode === 'curve'
      ? `compare ${payload.snapshots.slice(1).map((s) => s.label).join(', ') || 'none'} · ${payload.curve.kind} · ${payload.curve.dayCount} ${payload.curve.compounding}`
      : `${payload.history?.from ?? '—'} → ${payload.history?.to ?? '—'} · tenors ${params.tenors.join(',')} · spreads ${params.spreads.join(',') || 'none'}`;

  return {
    title,
    subtitle,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'caveats', items: caveatBadges(payload, meta) },
        stack(
          'col',
          [
            { kind: 'custom', id: 'chart', component: 'CurveChart', props: { spec: gcChartSpec(payload) } },
            lower,
          ],
          sizesFor(params.view),
        ),
      ],
      [0.08, 0.92],
    ),
    footer: footer(meta, payload.caveats),
    initialFocus: 'chart',
  } satisfies ScreenSpec;
};

export default Screen;
