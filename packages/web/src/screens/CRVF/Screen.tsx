// packages/web/src/screens/CRVF/Screen.tsx — Curve Construction (FUNCTIONS_TIER3 §CRVF "Screen").
//
// How a curve is *made*: the published inputs of one curve date, the bootstrapped nodes they imply,
// the build that produced them (method, interpolation, engine name@version, inputs hash, build id)
// and up to three earlier dates overlaid with their basis-point changes.
//
// `screenKind: 'custom'` — the curve plot is a `custom#chart` node carrying a `CurveChart`
// component and a fully-specified `ChartSpec`. This file **declares** that spec and draws nothing:
// the canvas, the axes and the crosshair are WP-12's renderer. What is decided here is what the
// chart is of — which series exist, which points they carry, which provenance entry each cites —
// because that is a data question and the screen is the only place that can answer it.
//
// Two honesty rules the nodes carry:
//
//   * **A tenor with no value is a gap, never a line.** `null` becomes `NaN` in the series, which
//     §1.5 defines as a break; the renderer must not join across it.
//   * **A proxied input says so on its own row.** `SOFR_OIS` term points are built from SOFR
//     averages, bills and UST par yields, so `inputs[].proxy` drives both a row flag and the
//     permanent `PROXY_CURVE` badge — the caveat travels with the number, not with the screen.
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
  kvRow,
  numCell,
  stalenessBadges,
  textCell,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'CRVF'>;
type Payload = PayloadOf<'CRVF'>;
type InputRow = Payload['inputs'][number];
type CurveNode = Payload['nodes'][number];

/** The published curve quotes the dictionary names by tenor (`CRV_10Y` …). */
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

/**
 * The dictionary field a published input is a value of.
 *
 * A bill curve quotes a discount rate and a money-market yield, not a par yield, so the quote type
 * decides first; a standard tenor of a par/CMT curve is its own `CRV_*` id; anything else falls
 * back to `CURVE_PAR`, which is what a par quote at a non-standard tenor is.
 */
function inputField(quoteType: string, tenor: string): FieldId {
  if (quoteType === 'discount_rate') return 'DISC_RATE';
  if (quoteType === 'investment_yield') return 'MM_YIELD';
  if (quoteType === 'fixing') return 'RATE';
  return CRV_TENOR_FIELDS[tenor] ?? 'CURVE_PAR';
}

/** `null` is a gap in a series, not a zero (§1.5 "NaN = gap"). */
const gap = (v: number | null): number => v ?? Number.NaN;

/** The `ChartSpec` the `CurveChart` component renders; this file builds it and draws nothing. */
export function crvfChartSpec(p: Payload, outputs: readonly Params['outputs'][number][]): ChartSpec {
  const days = p.nodes.map((n) => n.days);
  const series: ChartSeries[] = [];
  const line = (
    id: string,
    label: string,
    type: ChartSeries['type'],
    yAxis: string,
    y: number[],
    provIdx: number,
    style?: ChartSeries['style'],
  ): void => {
    const s: ChartSeries = { id, label, type, pane: 'main', yAxis, x: days, y, provIdx };
    if (style !== undefined) s.style = style;
    series.push(s);
  };

  if (outputs.includes('par')) line('par', 'Par %', 'line', 'y', p.nodes.map((n) => gap(n.par)), p.curve.provIdx);
  if (outputs.includes('zero')) {
    line('zero', 'Zero %', 'line', 'y', p.nodes.map((n) => gap(n.zero)), p.curve.provIdx, { dashed: true });
  }
  if (outputs.includes('fwd3m')) {
    line('fwd3m', 'Fwd 3M %', 'step', 'y', p.nodes.map((n) => gap(n.fwd3m)), p.curve.provIdx);
  }
  if (outputs.includes('fwd1y')) {
    line('fwd1y', 'Fwd 1Y %', 'step', 'y', p.nodes.map((n) => gap(n.fwd1y)), p.curve.provIdx);
  }
  if (outputs.includes('df')) {
    line('df', 'DF', 'line', 'df', p.nodes.map((n) => gap(n.df)), p.curve.provIdx);
  }
  for (const cmp of p.compare) {
    series.push({
      id: `cmp:${cmp.date}`,
      label: `par ${cmp.date}`,
      type: 'line',
      pane: 'main',
      yAxis: 'y',
      x: cmp.nodes.map((n) => Math.round(n.t * 365)),
      y: cmp.nodes.map((n) => gap(n.par)),
      provIdx: cmp.provIdx,
      style: { color: 'neutral', dashed: true },
    });
  }
  if (outputs.includes('input')) {
    series.push({
      id: 'inputs',
      label: 'Published inputs',
      type: 'scatter',
      pane: 'main',
      yAxis: 'y',
      x: p.inputs.map((i) => i.tenorDays),
      y: p.inputs.map((i) => (typeof i.value.v === 'number' ? i.value.v : Number.NaN)),
      provIdx: p.curve.provIdx,
    });
  }

  return {
    kind: 'curve',
    xAxis: { type: 'tenor' },
    yAxes: [
      { id: 'y', side: 'left', scale: 'linear', fmt: 'pct', decimals: 3 },
      { id: 'df', side: 'right', scale: 'linear', fmt: 'px', decimals: 4 },
    ],
    panes: [{ id: 'main', height: 1 }],
    series,
    crosshair: true,
    reference: [],
  };
}

function nodesGrid(p: Payload, outputs: readonly Params['outputs'][number][]): Node {
  const inputs = new Map<string, InputRow>(p.inputs.map((row) => [row.tenor, row]));
  const changes = new Map(p.changes.map((c) => [c.tenor, c]));

  const columns: GridColumn[] = [
    { id: 'tenor', label: 'Tenor', align: 'left', sortable: true },
    { id: 'days', label: 'Days', align: 'right', fmt: 'int' },
  ];
  if (outputs.includes('input')) {
    columns.push(
      { id: 'quoteType', label: 'Quote', align: 'left' },
      { id: 'input', label: 'Input %', align: 'right', fmt: 'pct', decimals: 4 },
    );
  }
  if (outputs.includes('par')) columns.push({ id: 'par', label: 'Par %', align: 'right', fieldId: 'CURVE_PAR', fmt: 'pct', decimals: 4 });
  if (outputs.includes('zero')) columns.push({ id: 'zero', label: 'Zero %', align: 'right', fieldId: 'CURVE_ZERO', fmt: 'pct', decimals: 4 });
  if (outputs.includes('df')) columns.push({ id: 'df', label: 'DF', align: 'right', fieldId: 'CURVE_DF', fmt: 'px', decimals: 8 });
  if (outputs.includes('fwd3m')) columns.push({ id: 'fwd3m', label: 'Fwd 3M %', align: 'right', fieldId: 'CURVE_FWD_3M', fmt: 'pct', decimals: 4 });
  if (outputs.includes('fwd1y')) columns.push({ id: 'fwd1y', label: 'Fwd 1Y %', align: 'right', fmt: 'pct', decimals: 4 });
  columns.push({ id: 'proxy', label: 'Proxy', align: 'left' });
  p.compare.forEach((cmp, j) => {
    columns.push(
      { id: `cmp${String(j)}`, label: `par ${cmp.date}`, align: 'right', fmt: 'pct', decimals: 4 },
      { id: `chg${String(j)}`, label: `Δbp ${cmp.date}`, align: 'right', fmt: 'bp', decimals: 1 },
    );
  });

  const rows: GridRow[] = p.nodes.map((n: CurveNode): GridRow => {
    const input = inputs.get(n.tenor);
    const change = changes.get(n.tenor);
    const cells: Record<string, Cell> = {
      tenor: textCell(n.tenor),
      days: countCell(n.days),
      proxy: textCell(input?.proxy === true ? `proxy of ${input.proxyOf ?? 'derived inputs'}` : ''),
    };
    if (outputs.includes('input')) {
      cells.quoteType = textCell(input?.quoteType ?? null);
      cells.input =
        input === undefined
          ? textCell(null)
          : cell(inputField(input.quoteType, input.tenor), input.value, { fmt: 'pct', decimals: 4 });
    }
    if (outputs.includes('par')) cells.par = numCell('CURVE_PAR', n.par, p.curve.provIdx, { fmt: 'pct', decimals: 4 });
    if (outputs.includes('zero')) cells.zero = numCell('CURVE_ZERO', n.zero, p.curve.provIdx, { fmt: 'pct', decimals: 4 });
    if (outputs.includes('df')) cells.df = numCell('CURVE_DF', n.df, p.curve.provIdx, { fmt: 'px', decimals: 8 });
    if (outputs.includes('fwd3m')) {
      cells.fwd3m = numCell('CURVE_FWD_3M', n.fwd3m, p.curve.provIdx, { fmt: 'pct', decimals: 4 });
    }
    if (outputs.includes('fwd1y')) {
      // The dictionary carries no one-year forward id; the number is the build's, cited to it.
      cells.fwd1y = computedCell(
        n.fwd1y === null ? { v: null, st: 'na', provIdx: -1 } : { v: n.fwd1y, st: 'closed', provIdx: p.curve.provIdx },
        'pct',
        4,
      );
    }
    p.compare.forEach((cmp, j) => {
      const par = cmp.nodes.find((c) => c.tenor === n.tenor)?.par ?? null;
      cells[`cmp${String(j)}`] = numCell('CURVE_PAR', par, cmp.provIdx, { fmt: 'pct', decimals: 4 });
      const bp = change?.vsCompare.find((v) => v.date === cmp.date)?.parBp ?? null;
      cells[`chg${String(j)}`] = computedCell(
        bp === null ? { v: null, st: 'na', provIdx: -1 } : { v: bp, st: 'closed', provIdx: cmp.provIdx },
        'bp',
        1,
      );
    });

    const row: GridRow = { id: `node:${n.tenor}`, cells, tone: n.isInput ? 'normal' : 'muted' };
    if (input !== undefined && input.instrument !== null) row.command = `${input.instrument.key} YAS`;
    return row;
  });

  return {
    kind: 'grid',
    id: 'nodes',
    columns,
    rows,
    frozenColumns: 2,
    selectable: true,
    onShiftEnter: (row: GridRow): string | null => row.command ?? null,
    emptyText: 'Nothing was bootstrapped: the published tenors of this curve carry no term structure.',
  };
}

function buildKv(p: Payload): Node {
  const e = p.build.engine;
  return {
    kind: 'kv',
    id: 'build',
    title: 'Build',
    columns: 3,
    rows: [
      kvRow('Curve', textCell(`${p.curve.id} · ${p.curve.name}`)),
      kvRow('Date', textCell(p.curve.date, { fmt: 'date' })),
      kvRow('Requested', textCell(p.curve.requestedDate, { fmt: 'date' })),
      kvRow('Method', textCell(p.build.method)),
      kvRow('Interpolation', textCell(p.build.interpolation)),
      kvRow('Engine', textCell(e === null ? null : `${e.name}@${e.version}`)),
      kvRow('Inputs hash', textCell(e === null ? null : e.inputsHash.slice(0, 8))),
      kvRow('Build id', textCell(p.build.buildId < 0 ? null : String(p.build.buildId))),
      kvRow('Cached', textCell(p.build.cached ? 'yes (curve_builds)' : 'no (bootstrapped now)')),
      kvRow('Day count', textCell(p.curve.dayCount)),
      kvRow('Compounding', textCell(p.curve.compounding)),
      kvRow('Source', textCell(p.curve.sourceId)),
    ],
  };
}

function caveatBadges(p: Payload, meta: Parameters<typeof footer>[0]): Badge[] {
  const badges: Badge[] = p.build.caveats.map((c) => ({
    text: c,
    tone: 'warn' as const,
    title:
      c === 'PROXY_CURVE'
        ? 'SOFR OIS term points are proxied (SOFR averages, bills, UST par); no OIS swap or futures source (BRIEF §2).'
        : c,
  }));
  if (p.curve.requestedDate !== null && p.curve.requestedDate !== p.curve.date) {
    badges.push({
      text: `SERVED ${p.curve.date}`,
      tone: 'info',
      title: `No curve on ${p.curve.requestedDate}; the previous stored date was served.`,
    });
  }
  badges.push(...entitlementBadges(meta), ...unavailableBadges(meta), ...stalenessBadges(meta));
  return badges;
}

/** `view` drives the split: chart only, table only, or both (§CRVF). */
function sizesFor(view: Params['view']): number[] {
  if (view === 'chart') return [1, 0];
  if (view === 'table') return [0, 1];
  return [0.55, 0.45];
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, meta }) => {
  if (payload === undefined) {
    return {
      title: `CRVF · ${params.curveId}`,
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
            id: 'nodes',
            columns: [{ id: 'tenor', label: 'Tenor', align: 'left' }],
            rows: Array.from({ length: 14 }, (_v, i) => ({
              id: `node-skeleton:${String(i)}`,
              cells: { tenor: textCell(null) },
              tone: 'muted' as const,
            })),
            emptyText: 'loading…',
          },
        ],
        [0.08, 0.5, 0.42],
      ),
      footer: footer(undefined),
      initialFocus: 'nodes',
    } satisfies ScreenSpec;
  }

  const outputs = params.outputs;

  return {
    title: `CRVF · ${payload.curve.id} · ${payload.curve.name} · ${payload.curve.date}`,
    subtitle: `${payload.build.method} · ${payload.build.interpolation} · ${String(payload.inputs.length)} inputs · ${String(payload.nodes.length)} nodes · grid ${params.grid}`,
    body: stack(
      'col',
      [
        { kind: 'badges', id: 'caveats', items: caveatBadges(payload, meta) },
        stack(
          'col',
          [
            { kind: 'custom', id: 'chart', component: 'CurveChart', props: { spec: crvfChartSpec(payload, outputs) } },
            nodesGrid(payload, outputs),
          ],
          sizesFor(params.view),
        ),
        buildKv(payload),
      ],
      [0.08, 0.77, 0.15],
    ),
    footer: footer(meta, payload.build.caveats),
    initialFocus: 'nodes',
  } satisfies ScreenSpec;
};

export default Screen;
