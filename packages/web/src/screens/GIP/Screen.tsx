// packages/web/src/screens/GIP/Screen.tsx — Intraday Price Graph (FUNCTIONS_TIER1 §GIP "Screen").
//
// One statistics row of live cells, the intraday chart, and a chip strip that says what the chart
// is showing and how delayed it is. The chart is a `custom` node so WP-13's `PriceChart` can own
// the crosshair and the forming-bar append (CHRT-02); this file only describes it.

import type { ParamsOf, PayloadOf } from '@terminal/core';

import type { Badge, ChartSeries, ChartSpec, FunctionScreen, Node, ScreenSpec } from '../../screen/types.js';
import { stack } from '../../screen/types.js';
import {
  blankCell,
  cell,
  entitlementBadges,
  footer,
  kvRow,
  stalenessBadges,
  unavailableBadges,
} from '../shared/quoteHeader.js';

type Params = ParamsOf<'GIP'>;
type Payload = PayloadOf<'GIP'>;

/** §GIP's `ChartSpec` listing, built from the payload. */
export function gipChartSpec(p: Payload, params: Params): ChartSpec {
  const series: ChartSeries[] = [
    {
      id: 'p',
      label: p.instrument.display,
      type: 'candle',
      pane: 'main',
      yAxis: 'y',
      x: p.bars.t,
      y: p.bars.c,
      ohlc: {
        o: Float64Array.from(p.bars.o),
        h: Float64Array.from(p.bars.h),
        l: Float64Array.from(p.bars.l),
        c: Float64Array.from(p.bars.c),
      },
      volume: Float64Array.from(p.bars.v),
      provIdx: p.bars.provIdx,
      currency: p.instrument.currency,
      calendarId: p.calendarId,
      live: { subject: `b1m:${String(p.instrument.instrumentId)}`, field: 'PX_LAST', mode: 'append-forming-bar' },
    },
  ];
  if (p.vwap !== null) {
    series.push({
      id: 'vwap',
      label: 'VWAP',
      type: 'line',
      pane: 'main',
      yAxis: 'y',
      x: p.bars.t,
      y: p.vwap,
      provIdx: p.bars.provIdx,
      style: { color: 'neutral', dashed: true },
    });
  }
  if (params.volume) {
    series.push({
      id: 'v',
      label: 'Volume',
      type: 'bar',
      pane: 'vol',
      yAxis: 'vol',
      x: p.bars.t,
      y: p.bars.v,
      provIdx: p.bars.provIdx,
    });
  }

  const panes: ChartSpec['panes'] = [{ id: 'main', height: params.volume ? 0.78 : 1 }];
  if (params.volume) panes.push({ id: 'vol', height: 0.22, title: 'Volume' });

  const prevClose = p.prevClose.v;
  return {
    kind: 'intraday',
    xAxis: {
      type: 'time',
      tz: p.tz,
      calendarId: p.calendarId,
      sessions: p.sessions.map((s) => ({ start: s.start, end: s.end, kind: s.kind })),
    },
    yAxes: [
      { id: 'y', side: 'right', scale: 'linear', fmt: 'px', decimals: p.instrument.priceDecimals },
      { id: 'vol', side: 'left', scale: 'linear', fmt: 'int' },
    ],
    panes,
    series,
    reference:
      params.prevClose && typeof prevClose === 'number'
        ? [{ yAxis: 'y', v: prevClose, label: 'prev close' }]
        : [],
    crosshair: true,
  };
}

/** `kv#stats` — one row of live cells; the crosshair replaces them with the bar under it. */
function statsRow(p: Payload | undefined): Node {
  if (p === undefined) {
    return {
      kind: 'kv',
      id: 'stats',
      columns: 3,
      rows: [
        kvRow('Last', blankCell('PX_LAST')),
        kvRow('Chg', blankCell('CHG_NET_1D')),
        kvRow('Chg %', blankCell('CHG_PCT_1D')),
        kvRow('Open', blankCell('PX_OPEN')),
        kvRow('High', blankCell('PX_HIGH')),
        kvRow('Low', blankCell('PX_LOW')),
        kvRow('VWAP', blankCell('VWAP')),
        kvRow('Volume', blankCell('PX_VOLUME')),
        kvRow('Session', blankCell('SESSION_STATE')),
      ],
    };
  }
  const d = { decimals: p.instrument.priceDecimals };
  return {
    kind: 'kv',
    id: 'stats',
    columns: 3,
    rows: [
      kvRow('Last', cell('PX_LAST', p.stats.last, d)),
      kvRow('Chg', cell('CHG_NET_1D', p.stats.chgNet, { ...d, signed: true })),
      kvRow('Chg %', cell('CHG_PCT_1D', p.stats.chgPct, { signed: true })),
      kvRow('Open', cell('PX_OPEN', p.stats.open, d)),
      kvRow('High', cell('PX_HIGH', p.stats.high, d)),
      kvRow('Low', cell('PX_LOW', p.stats.low, d)),
      kvRow('VWAP', cell('VWAP', p.stats.vwapNow, d)),
      kvRow('Volume', cell('PX_VOLUME', p.stats.volume)),
      kvRow('% of avg vol 30d', cell('VOLUME_AVG_30D', p.stats.pctOfAvgVolume30d, { fmt: 'pct', decimals: 1 })),
      kvRow('Session', cell('SESSION_STATE', p.stats.sessionState)),
      kvRow('Prev close', cell('PX_CLOSE_1D', p.prevClose, d)),
    ],
  };
}

function toolbar(p: Payload | undefined, params: Params, meta: Parameters<typeof footer>[0]): Node {
  const items: Badge[] = (['1', '2', '5'] as const).map((d) => ({
    text: `${d}D`,
    tone: d === params.days ? ('ok' as const) : ('info' as const),
  }));
  items.push({ text: p?.interval ?? params.interval, tone: 'info', title: 'press I to toggle 1m/5m' });
  items.push({ text: params.session, tone: 'info', title: 'press X to toggle regular/extended' });
  items.push({
    text: `VWAP ${params.vwap ? 'on' : 'off'}`,
    tone: p?.vwap === null ? 'blocked' : 'info',
    title: p?.vwap === null ? 'no VWAP for this window' : 'press V to toggle',
  });
  items.push({ text: `prev close ${params.prevClose ? 'on' : 'off'}`, tone: 'info' });
  items.push({ text: `volume ${params.volume ? 'on' : 'off'}`, tone: 'info' });
  if (p !== undefined) {
    items.push({
      text: `${p.sourceLine.sourceId} · ${String(p.sourceLine.intrinsicDelayMin)} min`,
      tone: 'info',
      title: p.sourceLine.providerSymbol,
    });
  }
  items.push(...unavailableBadges(meta), ...entitlementBadges(meta), ...stalenessBadges(meta));
  return { kind: 'badges', id: 'toolbar', items };
}

export const Screen: FunctionScreen<Params, Payload> = ({ payload, params, instrument, meta }) => {
  const display = payload?.instrument.display ?? instrument?.display ?? '—';
  const name = payload?.instrument.name ?? instrument?.name ?? '';
  const title = `GIP · ${display} · ${name}`;
  const subtitle = `${payload?.days ?? params.days}D · ${payload?.interval ?? params.interval} · ${params.session} · ${payload?.tz ?? '—'}`;

  const chart: Node =
    payload === undefined
      ? { kind: 'custom', id: 'chart', component: 'PriceChart', props: { spec: null, title } }
      : {
          kind: 'custom',
          id: 'chart',
          component: 'PriceChart',
          props: { spec: gipChartSpec(payload, params) },
        };

  return {
    title,
    subtitle,
    body: stack('col', [statsRow(payload), chart, toolbar(payload, params, meta)], [0.08, 0.8, 0.12]),
    footer: footer(meta),
    initialFocus: 'chart',
  } satisfies ScreenSpec;
};

export default Screen;
