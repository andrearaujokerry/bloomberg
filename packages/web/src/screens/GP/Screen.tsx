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

// The other three ladders the keymap cycles, in `GpParams`' own enum order so that the spelling the
// manifest validates and the spelling this screen sends are the same list. `CUSTOM` is in `GpRange`
// and not in `RANGES` on purpose — see `cycle`.
const CHART_TYPES = [
  'line',
  'area',
  'mountain',
  'candle',
  'ohlc',
  'bar',
  'step',
  'pnf',
  'profile',
  'heatmap',
  'tick',
] as const;
const ADJUST_POLICIES = ['unadjusted', 'price', 'total_return'] as const;
const NORMALISATIONS = ['none', 'pct', 'base100'] as const;

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

/* -------------------------------------------------------------------------------------------- */
/* The keymap's own actions (§GP Keyboard)                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * The next value after `current` in `values`, wrapping; `values[0]` when `current` is not in them.
 *
 * The fallback is the case that matters: `range: 'CUSTOM'` is a legal param and is deliberately NOT
 * in `RANGES`, because a custom window is defined by its dates and there is nothing to cycle to.
 * Pressing `R` on one lands on the first fixed range rather than doing nothing.
 */
function cycle<T extends string>(values: readonly T[], current: string): T {
  const at = values.indexOf(current as T);
  const next = values[(at + 1) % values.length];
  // `values` is a non-empty literal tuple at every call site; the fallback is for the index type.
  return next ?? values[0]!;
}

function nextRange(current: string): (typeof RANGES)[number] {
  return cycle(RANGES, current);
}

/**
 * The periodicities `P` offers, which is not all six (§GP step 1).
 *
 * `server/src/functions/GP/resolve.ts#planWindow` CLAMPS an intraday periodicity to `'D'` on a range
 * longer than five days rather than refusing it, so cycling the full list would spend two presses
 * doing nothing visible on a 1Y chart — the same class of lie as a key that is not wired, one step
 * quieter. Offered instead: the daily family always, plus the intraday pair when the window is one
 * the store actually holds minute bars for.
 */
function periodicityChoices(params: Params, p: Payload | undefined): readonly Params['periodicity'][] {
  const intraday =
    params.range === '1D' ||
    params.range === '5D' ||
    (params.range === 'CUSTOM' && spanDays(p) !== null && (spanDays(p) ?? 0) <= 5);
  return intraday
    ? (['auto', '1m', '5m', 'D', 'W', 'M'] as const)
    : (['auto', 'D', 'W', 'M'] as const);
}

/** The payload's own window span in days, or `null` before the first payload lands. */
function spanDays(p: Payload | undefined): number | null {
  if (p === undefined) return null;
  const ms = Date.parse(`${p.window.end}T00:00:00Z`) - Date.parse(`${p.window.start}T00:00:00Z`);
  return Number.isFinite(ms) ? ms / 86_400_000 : null;
}

/** Every event kind on, or every one off — §GP's `E` is one toggle over the whole set. */
function toggledEvents(events: Params['events']): Params['events'] {
  const anyOn = Object.values(events).some((v) => v === true);
  const out = { ...events };
  for (const key of Object.keys(out) as (keyof Params['events'])[]) out[key] = !anyOn;
  return out;
}

/**
 * `ScreenSpec.actions` for GP — the keys `manifest.keymap` declares, as handlers.
 *
 * WIRED HERE: every binding that is a param change, because `setParams` re-runs the function with the
 * patch and that is the whole of what these keys mean (§11.9 "the round trip"). `cycle-range` is the
 * one this file titled its chips after and the one that had no handler at all.
 *
 * DELIBERATELY NOT HERE, and still answered by the footer hint:
 *
 *   * `custom-range`, `add-overlay`, `set-currency`, `add-study` — each needs `ctx.prompt`, and
 *     `App.tsx`'s prompt resolves `null` because `PromptDialog` is unwritten. A handler that always
 *     cancelled would be a key that looks wired and is not, which is worse than the hint.
 *   * `crosshair-*`, `pan-*`, `zoom-*`, `draw-mode`, `delete-annotation` — `when: 'chart'`, owned by
 *     the chart node at the element (`chart/ChartCanvas.tsx`), which is where the crosshair state is.
 *   * `save-annotations` — there is no annotation mutation endpoint in this build.
 */
function screenActions(
  params: Params,
  p: Payload | undefined,
  ctx: Parameters<FunctionScreen<Params, Payload>>[0]['ctx'],
  display: string,
): Readonly<Record<string, () => void>> {
  return {
    'cycle-range': () => {
      // Leaving CUSTOM must drop the dates it was pinned to: `planWindow` measures a fixed range back
      // from `params.end ?? today`, so a surviving `end` would silently anchor the new window to the
      // old custom one. Cleared on every cycle, not only when leaving CUSTOM, because they mean
      // nothing to a fixed range either.
      ctx.setParams({ range: nextRange(params.range), start: undefined, end: undefined });
    },
    'cycle-type': () => {
      ctx.setParams({ range: params.range, type: cycle(CHART_TYPES, params.type) });
    },
    'cycle-adjust': () => {
      ctx.setParams({ adjust: cycle(ADJUST_POLICIES, params.adjust) });
    },
    'cycle-normalise': () => {
      ctx.setParams({ normalise: cycle(NORMALISATIONS, params.normalise) });
    },
    'cycle-periodicity': () => {
      const choices = periodicityChoices(params, p);
      ctx.setParams({ periodicity: cycle(choices, params.periodicity) });
    },
    'toggle-log': () => {
      ctx.setParams({ logScale: !params.logScale });
    },
    'toggle-volume': () => {
      ctx.setParams({ volume: !params.volume });
    },
    'toggle-events': () => {
      ctx.setParams({ events: toggledEvents(params.events) });
    },
    'remove-overlay': () => {
      if (params.overlays.length === 0) return;
      ctx.setParams({ overlays: params.overlays.slice(0, -1) });
    },
    'remove-study': () => {
      if (params.studies.length === 0) return;
      ctx.setParams({ studies: params.studies.slice(0, -1) });
    },
    // The two navigations §GP lists, which are commands and not params: GIP is the intraday view of
    // the same security and HP its historical table. `display` is the security as the command line
    // spells it, which is what the parser needs back.
    'open-gip': () => {
      ctx.navigate(`${display} GIP`);
    },
    'open-hp': () => {
      ctx.navigate(`${display} HP ${params.range}`);
    },
  };
}

/** `badges#toolbar` — the range chips, then the params that change what the chart means. */
function toolbar(p: Payload | undefined, params: Params, meta: Parameters<typeof footer>[0]): Node {
  // `R` cycles ONE step, so exactly one chip is where it goes — titling all ten "press R to cycle to
  // <r>" said that any of them was one keypress away. (It said it against a key that did nothing at
  // all until `ScreenSpec.actions` existed; both halves of that are fixed, and this is the half a
  // reader sees.) The chips are badges and badges do not click, so the others carry no title rather
  // than a title promising a path that is not there.
  const next = nextRange(params.range);
  const items: Badge[] = RANGES.map((r) => ({
    text: r,
    tone: r === params.range ? ('ok' as const) : ('info' as const),
    ...(r === params.range
      ? { title: 'active range' }
      : r === next
        ? { title: 'press R to cycle here' }
        : {}),
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

export const Screen: FunctionScreen<Params, Payload> = ({
  payload,
  params,
  instrument,
  meta,
  ctx,
}) => {
  const display = payload?.primary.key ?? instrument?.display ?? '—';
  const name = payload?.primary.label ?? instrument?.name ?? '';
  const title = `GP · ${display} · ${name}`;
  const subtitle = `${params.range} · ${payload?.window.periodicity ?? params.periodicity} · ${params.adjust}`;
  const actions = screenActions(params, payload, ctx, display);

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
      actions,
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
    actions,
  } satisfies ScreenSpec;
};

export default Screen;
