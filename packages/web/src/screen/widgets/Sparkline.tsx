// packages/web/src/screen/widgets/Sparkline.tsx — the `custom#Sparkline` component (CHRT-01,
// CLIENT.md §11 L134 "inline mini line — same renderer, no axes"; DES `rate`, ECO, EE).
//
// Three screens emit this node and until now none of them drew anything: `widgets.tsx` registered
// `Sparkline` nowhere, so `Custom.tsx` painted `data-pending="Sparkline"` in the box where a series
// belongs. This file fills it, and the two decisions that shaped it are both DATA-10's.
//
// ## Why this node draws a shape and prints no number
//
// The node's props carry no provenance. `DES/Screen.tsx` maps `p.history` — whose rows DO each carry
// a `provIdx` — down to `{ t, v }` and drops it; `ECO` passes `series0.chart` and `EE`
// `payload.sparkline`, and neither payload type has a per-point index to pass. So there is no honest
// value for a `ChartSeries.provIdx`, which is why `widgets.tsx` left this component unwritten rather
// than synthesising one, and that reasoning was right about the *numbers* and wrong about the
// *picture*: DATA-10 forbids a drawn NUMBER whose source cannot be named. It does not forbid showing
// the shape of a series whose numbers are printed, and cited, in the blocks beside it — DES's
// kv#latest / kv#averages, ECO's kv#release and grid#vintages, EE's grid#history all print those
// values with their own `provIdx`.
//
// So this component prints no number at all. No y axis, no tick labels, no crosshair readout, no
// first/last annotation, and no `data-prov-idx`: `ScreenRenderer`'s `Ctrl+I` already answers
// `openProvenance(provIdxOfFocus() ?? -2)`, so a focused sparkline reports "the focused element
// cites no provenance" — which is exactly true — without the attribute, and without putting a
// phantom field into the `help_tickets` screen-state harvest (`TicketDialog.tsx#collectScreenState`
// reads every `[data-prov-idx]` it finds). When a screen one day passes provenance with its points,
// the branch to add is one attribute; it is deliberately not written on speculation, because a
// branch no payload reaches is a branch no test can honestly exercise.
//
// ## Why there is no second renderer here, and no axes either
//
// The ink is WP-14's. `SERIES_DRAWS.line` is the same function that draws GP's price line — with the
// `NaN`-breaks-the-path rule that makes a `v: null` a gap instead of a line drawn through it, the
// single-visible-point stamp, and `style.width`/`dashed` — and `chart/scales.ts`'s `slotScale` and
// `linearScale` are the mappings the engine was written with. Nothing about a mark or a scale is
// reimplemented below; what this file owns is a canvas, a domain and a `SeriesScales`.
//
// `Renderer` itself is NOT used, and that is measured rather than assumed. A `Renderer` draws a
// series only through a declared axis — `renderer.ts#axisRenderFor` is
// `this.axes.get(series.yAxis) ?? firstAxisOf(pane)` and `buildAxes` only builds what
// `layers.ts#computeLayout` put in `pane.yAxes`, which `axisIdsOfPane` derives from
// `ChartSpec.yAxes`. So a spec with `yAxes: []` draws NOTHING, and a spec with one axis takes an
// `axisGutterPx` gutter (≈ 8 characters) plus an `xAxisHeightPx` strip and prints tick labels in
// them. Those labels are numbers off this payload — the numbers this node may not print. A
// sparkline with axis chrome is therefore not a smaller chart, it is the DATA-10 problem again, and
// suppressing the chrome is not something a host can ask the renderer for today (§11.1 exposes
// `setSpec`, `setState`, `applyStream`, `resize`, `frame`, `hitTest`, `layout`). Hence the layer
// below it.
//
// ## Keyboard (TERM-06)
//
// The host is a tab stop, because `ScreenRenderer#focusNode` focuses a node that is focusable itself
// or the one tab stop inside it, and `initialFocus`/`Tab` must be able to land here. The canvas is
// `aria-hidden` — it is pixels — and the accessible name carries what the picture carries: how many
// points, over how many gaps, and which way it ends. It quotes no value, for the reason above.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { linearScale, slotScale } from '../../chart/scales.js';
import { SERIES_DRAWS } from '../../chart/series.js';
import type { ChartFonts, ChartSeries, SeriesPaint, SeriesScales, Viewport } from '../../chart/types.js';
import { readToken } from '../../theme/colours.js';
import { MONO_ADVANCE_EM, WEIGHT, canvasFont, densityMetrics } from '../../theme/type.js';
import type { CustomComponentProps } from './registry.js';

/* ---------------------------------------------------------------------------------------------- */
/* The props the three screens pass                                                                 */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One point as a screen supplies it.
 *
 * `t` is epoch milliseconds from ECO and EE (`{ t: number; v: number | null }` in both payload
 * types) and an ISO date STRING from DES, which maps `h.effectiveDate` straight through. Both are
 * accepted, because the alternative is one of the three screens drawing nothing.
 */
export interface SparklinePointInput {
  t?: unknown;
  v?: unknown;
}

/** A point ready to draw: `v` is `NaN` for a gap, which is what the engine means by one (§11.2). */
export interface SparklinePoint {
  readonly t: number;
  readonly v: number;
}

export interface SparklineData {
  /** `props.label` when the screen passed one (DES does); it names the series, never a value. */
  readonly label: string | null;
  /** Oldest → newest, sorted below when every `t` parses. */
  readonly points: readonly SparklinePoint[];
  /** Points whose `v` is `null`/not finite — a gap in the line, and worth stating in the name. */
  readonly gaps: number;
}

/** `null` from a `t` this node cannot order by; the number of ms otherwise. */
function timeOf(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * `{ points, label }` out of a `custom` node's `props`, which FUNCTIONS §1.5 types `unknown`.
 *
 * `null` means "this is not a sparkline's props" — a shape no screen produces — and the component
 * then says so rather than drawing an empty box that looks like a series with no data. An empty
 * `points` array is NOT that case: ECO passes `series0?.chart ?? []` for a release with no series,
 * which is an ordinary state of the screen.
 */
export function sparklineDataOf(props: unknown): SparklineData | null {
  if (typeof props !== 'object' || props === null) return null;
  const bag = props as { points?: unknown; label?: unknown };
  if (!Array.isArray(bag.points)) return null;

  const raw: { t: number | null; v: number; at: number }[] = [];
  let gaps = 0;
  (bag.points as SparklinePointInput[]).forEach((point, index) => {
    if (typeof point !== 'object' || point === null) {
      gaps += 1;
      return;
    }
    const v = typeof point.v === 'number' && Number.isFinite(point.v) ? point.v : Number.NaN;
    if (Number.isNaN(v)) gaps += 1;
    raw.push({ t: timeOf(point.t), v, at: index });
  });

  // Sorted by `t` only when every point has one, and stably (`at` breaks ties), so a screen that
  // hands its history back newest-first is drawn in time order rather than mirrored. All three call
  // sites document oldest → newest; DES's `p.history` order is the resolver's, not the screen's, so
  // this is the cheap guard rather than a trust exercise. With any `t` unparsable the input order is
  // kept untouched, because a partial sort would interleave the two orders.
  const ordered = raw.every((p) => p.t !== null)
    ? [...raw].sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || a.at - b.at)
    : raw;

  return {
    label: typeof bag.label === 'string' && bag.label !== '' ? bag.label : null,
    points: ordered.map((p) => ({ t: p.t ?? p.at, v: p.v })),
    gaps,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* The draw                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What the ink needs that the data does not carry: the box, the ratio and the colour.
 *
 * `colour` is a resolved CSS colour and not a token, for the reason `ChartCanvas` states at length:
 * an unresolved custom property computes to `''`, and assigning `''` to `strokeStyle` is silently
 * ignored — the previous stroke stays — so a sparkline drawn before the stylesheet is in the
 * document would draw in whatever colour was set last instead of failing visibly.
 */
export interface SparklineDrawOptions {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly colour: string;
  readonly fonts: ChartFonts;
}

/** `--c-series-1`'s dark value, for the pre-stylesheet case above (`theme/tokens.css`). */
export const SPARK_FALLBACK_COLOUR = '#4da3ff';

/**
 * Every member of `SeriesPaint` filled from the one colour this node draws in.
 *
 * `SERIES_DRAWS.line` reads `paint.line` and nothing else; the other members exist for the eleven
 * marks that are not a line (candle bodies, the `bar` direction, `heatmap`'s ramp). They are filled
 * with the same colour rather than with a second palette invented here, because a sparkline that
 * grew a second mark should take the renderer's `paintFor` with it rather than keep a private
 * palette that has drifted.
 */
function paintOf(colour: string): SeriesPaint {
  return {
    line: colour,
    fill: colour,
    fillTo: colour,
    up: colour,
    down: colour,
    neutral: colour,
    muted: colour,
    hollowUp: false,
    ramp: () => colour,
  };
}

/**
 * Draw the line, and report how many points carried a value.
 *
 * Exported because it is the whole of the behaviour and a component test should be able to call it
 * with a box of its own: jsdom does not lay out, so a test that went through the effect would be
 * measuring a zero-sized host (TESTING §2.2).
 *
 * The geometry is the engine's: `slotScale` over one slot per point — which is what
 * `TradingDayIndex` reduces a single series to anyway, session gaps collapsed (§11.2) — and
 * `linearScale` over the finite values, whose `widened()` already handles the flat series and the
 * single point. One CSS pixel of inset top and bottom keeps a stroke at the domain's own extreme
 * from being clipped in half by the plot rect.
 */
export function drawSparkline(
  canvas: HTMLCanvasElement,
  data: SparklineData,
  opts: SparklineDrawOptions,
): number {
  const dpr = opts.dpr > 0 ? opts.dpr : 1;
  const width = Math.max(0, Math.floor(opts.width));
  const height = Math.max(0, Math.floor(opts.height));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx === null || width === 0 || height === 0) return 0;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const finite = data.points.filter((p) => Number.isFinite(p.v));
  if (finite.length === 0) return 0;

  const inset = 1;
  const plot = { x: 0, y: inset, w: width, h: Math.max(1, height - inset * 2) };
  const view: Viewport = { slot0: 0, slot1: Math.max(0, data.points.length - 1) };
  // `slotScale` centres a slot in its own band, which is what gives a candle body room against the
  // axis gutter (§11.2). A line has no body and this box has no gutter, so half a band at each end
  // would be dead space — 12 % of the width on EE's eight periods. The rect is widened by exactly
  // half a band so that the first and last point land on the edges of the box: with `pad = w /
  // (2(n-1))` the band becomes `w / (n-1)` and `x(0) = plot.x`, `x(n-1) = plot.x + w`. A single point
  // takes `pad = 0` and is centred, which is the only place it can honestly go.
  const pad = data.points.length > 1 ? plot.w / (2 * (data.points.length - 1)) : 0;
  const x = slotScale(view, { x: plot.x - pad, w: plot.w + pad * 2 });
  // Scanned rather than spread: `Math.min(...points)` throws a RangeError on an argument list of a
  // few hundred thousand, and nothing bounds how long a screen's series is — ECO's `chart` is one
  // observation per release period and DES's is one per session.
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const point of finite) {
    if (point.v < lo) lo = point.v;
    if (point.v > hi) hi = point.v;
  }
  const y = linearScale([lo, hi], [plot.y + plot.h, plot.y]);

  const series: ChartSeries = {
    id: 'spark',
    label: data.label ?? 'series',
    type: 'line',
    pane: 'spark',
    yAxis: 'spark:y',
    x: data.points.map((_p, i) => i),
    y: data.points.map((p) => p.v),
    // A series type requires one, and this is the one honest value: `-2` is the convention
    // `screen/widgets/Chart.tsx` and `ScreenRenderer`'s provenance panel already share for "this
    // element cites no provenance" (DATA-10). It is never read from here — nothing on this canvas
    // is attributable, which is why nothing on it is a number.
    provIdx: -2,
    style: { width: 1.5 },
  };

  const scales: SeriesScales = {
    plot,
    x: (slot) => x.x(slot),
    y: (value) => y.project(value),
    yUnit: (value) => y.project(value),
    slotAt: (px) => x.slotAt(px),
    valueAt: (py) => y.invert(py),
    slotPx: x.slotPx,
    baselinePx: plot.y + plot.h,
    tick: 0.01,
    hairline: 1 / dpr,
    paint: paintOf(opts.colour),
    fonts: opts.fonts,
  };

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y - inset, plot.w, plot.h + inset * 2);
  ctx.clip();
  SERIES_DRAWS.line(ctx, scales, view, series);
  ctx.restore();
  return finite.length;
}

/* ---------------------------------------------------------------------------------------------- */
/* Presentation                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const HOST: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 0,
  height: '100%',
  // The focus ring is the shell's; a canvas cannot show one, so the host carries it.
  outlineOffset: '-1px',
};

const CANVAS: CSSProperties = { position: 'absolute', inset: 0, display: 'block' };

const NOTE: CSSProperties = { margin: 0, padding: '0 1ch', color: 'var(--c-muted)' };

/** Which way the series ends — the one thing the picture says that a name can say too. */
export function sparklineTrend(points: readonly SparklinePoint[]): 'rising' | 'falling' | 'flat' {
  const finite = points.filter((p) => Number.isFinite(p.v));
  const first = finite[0]?.v;
  const last = finite[finite.length - 1]?.v;
  if (first === undefined || last === undefined || first === last) return 'flat';
  return last > first ? 'rising' : 'falling';
}

/**
 * The accessible name: what the ink shows, with no value in it.
 *
 * The canvas is `aria-hidden`, so this sentence is the whole of the screen-reader's parity with a
 * sighted reader — and a sighted reader of this node reads a shape, not a level. Where the levels
 * are is stated, because "no value is printed here" on its own would read as a defect.
 */
export function sparklineName(id: string, data: SparklineData): string {
  const n = data.points.length;
  if (n === 0) return `Sparkline ${id} — no points to plot`;
  const gaps = data.gaps === 0 ? '' : `, ${String(data.gaps)} with no value`;
  return (
    `Sparkline ${data.label ?? id} — ${String(n)} point${n === 1 ? '' : 's'}, oldest to newest` +
    `${gaps}, ${sparklineTrend(data.points)}. No number is printed on it and it cites no source; ` +
    `the values are printed with their provenance in the blocks beside it.`
  );
}

/* ---------------------------------------------------------------------------------------------- */
/* The component                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `custom#Sparkline` — DES (`rate`), ECO and EE.
 *
 * The draw happens in a layout effect and is re-run by a `ResizeObserver`, the same shape
 * `ChartCanvas` uses and for the same reason: the host's height comes from `widgets.css`'s
 * `.custom-host` chain, so the first size has to be READ (jsdom never resizes, and in a browser the
 * observer owns every later size).
 *
 * `data` is recomputed whenever the node's props identity changes, which is once per payload for
 * these three screens, and the redraw is one path of at most a few hundred points.
 */
export function Sparkline({ id, props }: CustomComponentProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const data = useMemo(() => sparklineDataOf(props), [props]);
  const [drawn, setDrawn] = useState(0);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null || data === null) return;

    const view = host.ownerDocument.defaultView;
    const metrics = densityMetrics(host.ownerDocument.documentElement.dataset.density);
    const fonts: ChartFonts = {
      axis: canvasFont(metrics),
      label: canvasFont(metrics, WEIGHT.label),
      readout: canvasFont(metrics, WEIGHT.label),
      // `ChartFonts.lineHeightPx` is the event band's row height and the readout's line spacing —
      // neither of which exists here. The density's row height is the honest value for it, and
      // nothing on this canvas reads it: `SERIES_DRAWS.line` never touches `scales.fonts` (only
      // `pnf` and `profile` do, for their glyphs).
      lineHeightPx: metrics.rowPx,
      digitPx: metrics.fontPx * MONO_ADVANCE_EM,
    };
    const token = readToken('--c-series-1', host);

    const measure = (): void => {
      const rect = host.getBoundingClientRect();
      setDrawn(
        drawSparkline(canvas, data, {
          width: rect.width,
          height: rect.height,
          dpr: view?.devicePixelRatio ?? 1,
          colour: token === '' ? SPARK_FALLBACK_COLOUR : token,
          fonts,
        }),
      );
    };

    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [data]);

  if (data === null) {
    // A `custom#Sparkline` whose props are not `{ points }`. No screen produces this, and if one
    // ever does the reader is told which node it was rather than shown an empty pane.
    return (
      <div className="spark spark--unreadable" data-spark-state="unreadable" tabIndex={0} role="group"
        aria-label={`Sparkline ${id} — its props are not a point series`}>
        <p style={NOTE}>{`Sparkline ${id}: nothing is plotted — these props carry no \`points\` array.`}</p>
      </div>
    );
  }

  const state = data.points.length === 0 ? 'empty' : drawn === 0 ? 'unmeasured' : 'drawn';
  return (
    <div
      className="spark"
      style={HOST}
      ref={hostRef}
      tabIndex={0}
      role="img"
      aria-label={sparklineName(id, data)}
      data-spark-state={state}
      data-spark-points={String(data.points.length)}
      data-spark-drawn={String(drawn)}
      // Stated in the DOM as well as in the header: this node attributes nothing, which is why it
      // prints nothing. `Ctrl+I` on it reports exactly that (DATA-10).
      data-spark-cites="none"
    >
      <canvas style={CANVAS} ref={canvasRef} aria-hidden="true" />
      {data.points.length === 0 ? (
        // Visible, not screen-reader-only: an empty box with no words in it reads as a broken
        // component, and `role="img"` already carries the same statement for a screen reader.
        <p style={NOTE}>No history for this series — nothing is plotted.</p>
      ) : null}
    </div>
  );
}

export default Sparkline;
