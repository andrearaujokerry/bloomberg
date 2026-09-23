// packages/web/src/screens/GP/Screen.tsx — Price Graph (FUNCTIONS_TIER1 §GP "Screen").
//
// `screenKind:'custom'`: the body is a toolbar of chips, the chart itself and a statistics strip.
// The chart is a `custom` node carrying a `ChartSpec` in its props, because WP-13's `PriceChart`
// owns crosshair, panning, studies and annotation drawing — all of which need their own key
// handling (§1.5 "a `custom` node receives focus and its own key handling").
//
// Pure: this file builds the `ChartSpec` from the payload and returns it as data. No canvas, no
// DOM, no IO.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type {
  Badge,
  ChartSeries,
  ChartSpec,
  Cell,
  FunctionScreen,
  Node,
  ScreenSpec,
} from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
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

type Params = ParamsOf<'GP'>;
type Payload = PayloadOf<'GP'>;
type Series = Payload['primary'];

/** The range chips, in the order `R` cycles them (§GP Keyboard `cycle-range`). */
const RANGES = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'MAX'] as const;

/** A series unit decides which axis format the chart draws (`unitFmt` of the §GP listing). */
function unitFmt(unit: Series['unit']): Cell['fmt'] {
  switch (unit) {
    case 'price':
    case 'index':
      return 'px';
    case 'yield':
    case 'pct':
    case 'rate':
      return 'pct';
  }
}

function toSeries(
  s: Series,
  id: string,
  type: ChartSeries['type'],
  pane: string,
  yAxis: string,
): ChartSeries {
  const out: ChartSeries = {
    id,
    label: s.label,
    type,
    pane,
    yAxis,
    x: s.t,
    y: s.c,
    provIdx: s.provIdx,
    currency: s.currency,
    calendarId: s.calendarId,
    style: { color: 'auto' },
  };
  if (s.o !== null && s.h !== null && s.l !== null) {
    out.ohlc = {
      o: Float64Array.from(s.o),
      h: Float64Array.from(s.h),
      l: Float64Array.from(s.l),
      c: Float64Array.from(s.c),
    };
  }
  if (s.v !== null) out.volume = Float64Array.from(s.v);
  if (s.live !== null) out.live = s.live;
  return out;
}

/** §GP "`ChartSpec` built by `screens/GP/spec.ts`" — the listing, built from the payload. */
export function gpChartSpec(p: Payload, params: Params): ChartSpec {
  const primary = p.primary;
  const intraday = primary.periodicity === '1m' || primary.periodicity === '5m';
  const volumePane = params.volume && primary.v !== null;
  const subStudies = params.studies.filter((s) => s.pane === 'sub');

  const yAxes: ChartSpec['yAxes'] = [
    {
      id: 'y',
      side: 'right',
      scale: params.logScale ? 'log' : 'linear',
      fmt: unitFmt(primary.unit),
      normalise: params.normalise,
      ...(p.primary.instrument === null ? {} : { decimals: p.primary.instrument.priceDecimals }),
    },
  ];
  const overlayAxis = new Map<number, string>();
  p.overlays.forEach((o, i) => {
    const sameScale = o.unit === primary.unit && o.currency === primary.currency;
    if (sameScale) {
      overlayAxis.set(i, 'y');
      return;
    }
    const id = `y${String(i)}`;
    overlayAxis.set(i, id);
    yAxes.push({
      id,
      side: 'left',
      scale: 'linear',
      fmt: unitFmt(o.unit),
      normalise: params.normalise,
    });
  });
  if (volumePane) yAxes.push({ id: 'vol', side: 'left', scale: 'linear', fmt: 'int' });

  const panes: ChartSpec['panes'] = [{ id: 'main', height: volumePane ? 0.72 : 1 }];
  if (volumePane) panes.push({ id: 'vol', height: 0.13, title: 'Volume' });
  subStudies.forEach((_s, i) => {
    panes.push({ id: `st${String(i)}`, height: 0.15 / Math.max(1, subStudies.length) });
  });

  const series: ChartSeries[] = [toSeries(primary, 'p', params.type, 'main', 'y')];
  p.overlays.forEach((o, i) => {
    series.push(toSeries(o, `o${String(i)}`, 'line', 'main', overlayAxis.get(i) ?? 'y'));
  });
  if (volumePane && primary.v !== null) {
    series.push({
      id: 'v',
      label: 'Volume',
      type: 'bar',
      pane: 'vol',
      yAxis: 'vol',
      x: primary.t,
      y: primary.v,
      provIdx: primary.provIdx,
    });
  }

  let subIndex = -1;
  const studies = params.studies.map((s) => {
    if (s.pane === 'sub') subIndex += 1;
    return {
      id: s.id,
      params: s.params,
      pane: s.pane === 'main' ? 'main' : `st${String(subIndex)}`,
      inputSeriesId: 'p',
    };
  });

  const spec: ChartSpec = {
    kind: intraday ? 'intraday' : 'price',
    xAxis: {
      type: 'time',
      tz: primary.tz,
      calendarId: primary.calendarId,
      ...(primary.sessions === null ? {} : { sessions: primary.sessions }),
    },
    yAxes,
    panes,
    series,
    studies,
    events: p.events.map((e) => ({
      t: e.t,
      kind: e.kind,
      label: e.label,
      command: e.command,
      provIdx: e.provIdx,
    })),
    annotations: p.annotations.map((a) => ({
      annotationId: a.annotationId,
      kind: a.kind,
      anchors: a.anchors,
      editable: a.editable,
      ...(a.label === null ? {} : { label: a.label }),
    })),
    reference: p.reference.map((r) => ({ yAxis: 'y', v: r.v, label: r.label })),
    crosshair: true,
    logScale: params.logScale,
  };
  return spec;
}

/** `badges#toolbar` — the range chips, then the params that change what the chart means. */
function toolbar(p: Payload | undefined, params: Params, meta: Parameters<typeof footer>[0]): Node {
  const items: Badge[] = RANGES.map((r) => ({
    text: r,
    tone: r === params.range ? ('ok' as const) : ('info' as const),
    title: r === params.range ? 'active range' : `press R to cycle to ${r}`,
  }));
  items.push({ text: `type ${params.type}`, tone: 'info' });
  items.push({ text: `adjust ${params.adjust}`, tone: 'info' });
  items.push({ text: `normalise ${params.normalise}`, tone: 'info' });
  items.push({ text: `currency ${params.currency ?? p?.primary.currency ?? '—'}`, tone: 'info' });
  items.push({ text: params.logScale ? 'log' : 'linear', tone: 'info' });
  for (const o of p?.overlays ?? []) {
    items.push({ text: `${o.label} ×`, tone: 'ok', title: 'press X to remove the last overlay' });
  }
  for (const s of params.studies) {
    items.push({ text: s.id, tone: 'ok', title: 'press Shift+S to remove the last study' });
  }
  items.push(...unavailableBadges(meta), ...entitlementBadges(meta), ...stalenessBadges(meta));
  return { kind: 'badges', id: 'toolbar', items };
}

/** `kv#footerStats` — last, change, window high/low, bar count, adjustment count, event count. */
function footerStats(p: Payload): Node {
  const closes = p.primary.c.filter((v) => Number.isFinite(v));
  const high = closes.length === 0 ? null : Math.max(...closes);
  const low = closes.length === 0 ? null : Math.min(...closes);
  const decimals = p.primary.instrument?.priceDecimals;
  const opts = decimals === undefined ? {} : { decimals };
  return {
    kind: 'kv',
    id: 'footerStats',
    columns: 3,
    rows: [
      kvRow('Last', cell('PX_LAST', p.last, opts)),
      kvRow('Window', textCell(`${p.window.start} → ${p.window.end}`)),
      kvRow('High', numCell('PX_HIGH', high, p.primary.provIdx, opts)),
      kvRow('Low', numCell('PX_LOW', low, p.primary.provIdx, opts)),
      kvRow('Bars', countCell(p.window.bars)),
      kvRow('Adjustments', countCell(p.adjustments.length)),
      kvRow('Events', countCell(p.events.length)),
      kvRow('Periodicity', textCell(p.window.periodicity)),
      kvRow(
        'Converted',
        textCell(
          p.primary.converted === null
            ? null
            : `${p.primary.converted.from} → ${p.primary.converted.to}`,
        ),
      ),
    ],
  };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = payload?.primary.key ?? instrument?.display ?? '—';
  const name = payload?.primary.label ?? instrument?.name ?? '';
  const title = `GP · ${display} · ${name}`;
  const subtitle = `${params.range} · ${payload?.window.periodicity ?? params.periodicity} · ${params.adjust}`;

  if (payload === undefined) {
    // Skeleton: the toolbar from the params and an empty chart frame — never a fake series.
    return {
      title,
      subtitle,
      body: stack(
        'col',
        [
          toolbar(undefined, params, meta),
          { kind: 'custom', id: 'chart', component: 'PriceChart', props: { spec: null, title } },
          { kind: 'text', id: 'footerStats', text: 'loading…', tone: 'muted' },
        ],
        [0.06, 0.88, 0.06],
      ),
      footer: footer(undefined),
      initialFocus: 'chart',
    } satisfies ScreenSpec;
  }

  return {
    title,
    subtitle,
    body: stack(
      'col',
      [
        toolbar(payload, params, meta),
        {
          kind: 'custom',
          id: 'chart',
          component: 'PriceChart',
          props: { spec: gpChartSpec(payload, params) },
        },
        footerStats(payload),
      ],
      [0.06, 0.88, 0.06],
    ),
    footer: footer(meta),
    initialFocus: 'chart',
  } satisfies ScreenSpec;
};

export default Screen;
