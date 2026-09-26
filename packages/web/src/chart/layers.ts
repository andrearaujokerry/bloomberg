// packages/web/src/chart/layers.ts — where everything is, and the furniture drawn around the ink
// (CLIENT.md §11.1, §11.2; CHRT-01, CHRT-03, CHRT-06).
//
// Two jobs, split from `renderer.ts` because they are the two that can be checked without a canvas
// and without data:
//
//   1. `computeLayout` — the pure geometry. Pane bands from `ChartSpec.panes[].height` fractions,
//      the y-axis gutters (up to four render, two a side, 6 ch each), the shared x-axis strip, the
//      CHRT-06 event band, and the plot rect that is left over. It returns `PaneLayout[]`, which is
//      the engine's only published account of where anything is, because jsdom does not lay out: a
//      test cannot measure a canvas, so every assertion about a pane height or an axis gutter is an
//      assertion about these rects (TESTING.md §2.2).
//   2. The furniture draws — gridlines, axis labels, pane titles, the legend. They are here rather
//      than in `renderer.ts` for the same reason the series draws are in `series.ts`: the renderer
//      decides *what is dirty* and *what the scales are*, and the files either side of it put ink
//      down. Nothing in this file reads the DOM, measures text or asks for the current theme; it is
//      handed the resolved `ChartTheme` and `ChartFonts` (§16.1 — a chart that flushes layout per
//      frame has no frame budget left).
//
// Axis labels go through `formatValue` — the one formatter, in `packages/core/src/fields/format.ts`
// (ARCHITECTURE §15). An axis tick that read `1,234.50` while the grid cell above it read `1234.5`
// would be two formatters, and the point of `web/src/format/index.ts` is that there is one.
//
// **Tick *values* here, tick *selection* in `scales.ts`.** `niceTicks` picks the 1/2/5 decade steps
// a linear gridline set needs, and `logDecadeTicks` the decade marks of a log axis, because a
// gridline cannot be drawn without them. The zoom-dependent label thinning that CLIENT §11.2 tests
// at three zoom levels belongs to `scales.ts` (WP-14's other hand); when it lands, the renderer
// passes its ticks in and these two keep serving the gridline case.

import { formatValue } from '../format/index.js';
import type { ChartFonts, ChartSpec, ChartTheme, PaneLayout, Rect, YAxisLayout } from './types.js';

/* -------------------------------------------------------------------------------------------- */
/* Geometry constants (§11.2)                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** A y-axis gutter is 6 characters wide — §11.2's "offset by 6 ch each", as a width. */
export const AXIS_GUTTER_CH = 6;

/**
 * Two gutters a side render; a third axis on that side shares the outermost one (§11.2).
 *
 * "More are legal but share the outermost" is the spec's own resolution, and it is a layout rule
 * rather than a validation rule: a spec with five axes draws, and the fifth's labels land in the
 * fourth's gutter. `computeLayout` therefore never rejects a spec — a chart that refused to draw
 * because a screen asked for a third left axis would be a worse answer than a shared gutter.
 */
export const MAX_GUTTERS_PER_SIDE = 2;

/** The width of one axis gutter in CSS px, at the current density. */
export function axisGutterPx(fonts: ChartFonts): number {
  return Math.round(AXIS_GUTTER_CH * fonts.digitPx);
}

/** The x-axis strip: one row of labels plus the tick marks above them. */
export function xAxisHeightPx(fonts: ChartFonts): number {
  return Math.round(fonts.lineHeightPx + 4);
}

/** A pane's title bar, and so also the whole height of a collapsed pane (§11.9 `Space`). */
export function paneTitleHeightPx(fonts: ChartFonts): number {
  return Math.round(fonts.lineHeightPx + 2);
}

/** CHRT-06's marker band is one row high (§11.7). */
export function eventBandHeightPx(fonts: ChartFonts): number {
  return Math.round(fonts.lineHeightPx);
}

/* -------------------------------------------------------------------------------------------- */
/* Layout                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** Everything `computeLayout` needs that is not in the spec. */
export interface LayoutInput {
  readonly spec: ChartSpec;
  /** Canvas size in CSS px (never device px — see the units note in `types.ts`). */
  readonly width: number;
  readonly height: number;
  readonly fonts: ChartFonts;
  /** `ChartState.collapsedPanes` (§11.9). */
  readonly collapsedPanes: ReadonlySet<string>;
  /** False when `E` has hidden the CHRT-06 band, or when the spec carries no events. */
  readonly eventBand: boolean;
}

/** `ChartSpec.panes` with the fallback single pane a spec may leave implicit. */
function panesOf(spec: ChartSpec): readonly { id: string; height: number; title?: string }[] {
  return spec.panes.length > 0 ? spec.panes : [{ id: 'main', height: 1 }];
}

/**
 * The y-axis ids a pane draws a gutter for, in `ChartSpec.yAxes` order.
 *
 * Derived from the series in the pane rather than from the axis list, because an axis is a property
 * of the series that name it: GP builds one `vol` axis for the volume pane and one `y` for the price
 * pane, and drawing both gutters on both panes would put a volume scale beside a price chart. A
 * study pane holds no series, so it gets the synthetic axis named below.
 */
function axisIdsOfPane(spec: ChartSpec, paneId: string): string[] {
  const ids: string[] = [];
  for (const axis of spec.yAxes) {
    if (spec.series.some((s) => s.pane === paneId && s.yAxis === axis.id)) ids.push(axis.id);
  }
  return ids;
}

/**
 * The axis id a study-only pane labels its values on.
 *
 * A `sub` study adds a pane with its own y-axis (§11.6), and `ChartSpec.yAxes` has no entry for it —
 * the study's `yFmt` is the format and its own outputs are the domain. Naming it `<paneId>:y` keeps
 * it distinguishable from any axis a screen declared, so a spec that later declares a real axis for
 * that pane wins without a collision.
 */
export function studyAxisId(paneId: string): string {
  return `${paneId}:y`;
}

/** Whether any study draws into this pane, which is what earns a study-only pane its gutter. */
function paneHasStudy(spec: ChartSpec, paneId: string): boolean {
  return (spec.studies ?? []).some((s) => s.pane === paneId);
}

/** The gutter rects for one pane band, and the plot width left between them. */
function guttersOf(
  spec: ChartSpec,
  paneId: string,
  band: Rect,
  fonts: ChartFonts,
): { axes: YAxisLayout[]; x: number; w: number } {
  const gutter = axisGutterPx(fonts);
  const declared = axisIdsOfPane(spec, paneId);
  const sides = new Map<string, 'left' | 'right'>();
  for (const axis of spec.yAxes) sides.set(axis.id, axis.side);

  const ids = declared.length > 0 || !paneHasStudy(spec, paneId) ? declared : [studyAxisId(paneId)];
  if (declared.length === 0 && paneHasStudy(spec, paneId)) sides.set(studyAxisId(paneId), 'right');

  let leftCount = 0;
  let rightCount = 0;
  const axes: YAxisLayout[] = [];
  for (const id of ids) {
    const side = sides.get(id) ?? 'right';
    // The third axis on a side shares the outermost gutter: its slot index is clamped, so its rect
    // is the same rect, and its labels overprint there rather than eating the plot (§11.2).
    const slot = side === 'left' ? leftCount : rightCount;
    const clamped = Math.min(slot, MAX_GUTTERS_PER_SIDE - 1);
    if (side === 'left') leftCount += 1;
    else rightCount += 1;
    const x = side === 'left' ? band.x + clamped * gutter : band.x + band.w - (clamped + 1) * gutter;
    axes.push({ axisId: id, side, rect: { x, y: band.y, w: gutter, h: band.h } });
  }

  const left = Math.min(leftCount, MAX_GUTTERS_PER_SIDE) * gutter;
  const right = Math.min(rightCount, MAX_GUTTERS_PER_SIDE) * gutter;
  const w = Math.max(0, band.w - left - right);
  return { axes, x: band.x + left, w };
}

/**
 * Pane rects, axis gutters, plot rects, the x-axis strip and the event band (§11.1 `layout()`).
 *
 * The vertical arithmetic in one place: collapsed panes take a title bar and nothing else, the
 * remaining height is divided by the uncollapsed panes' `height` fractions **renormalised over the
 * uncollapsed ones**, and the x-axis strip comes off the bottom pane that is still open. The
 * fractions are renormalised rather than trusted to sum to 1 because the specs the six real screens
 * build do not sum to 1 — GP with a volume pane and two studies sums to 0.85 — and a layout that
 * left the difference as empty canvas would leave a grey band under the chart on the screen most
 * used (`screens/GP/Screen.tsx`).
 */
export function computeLayout(input: LayoutInput): PaneLayout[] {
  const { spec, fonts } = input;
  const panes = panesOf(spec);
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const titleH = paneTitleHeightPx(fonts);
  const xAxisH = xAxisHeightPx(fonts);

  const collapsed = panes.map((p) => input.collapsedPanes.has(p.id));
  const openIdx = panes.map((_p, i) => i).filter((i) => collapsed[i] !== true);
  const closedCount = panes.length - openIdx.length;
  const openHeight = Math.max(0, height - closedCount * titleH);
  const fracSum = openIdx.reduce((sum, i) => sum + Math.max(0, panes[i]?.height ?? 0), 0);
  // Every fraction zero (or one pane at height 0) still has to draw: fall back to equal shares.
  const share = (i: number): number =>
    fracSum > 0 ? Math.max(0, panes[i]?.height ?? 0) / fracSum : 1 / Math.max(1, openIdx.length);

  const lastOpen = openIdx.length > 0 ? openIdx[openIdx.length - 1] : undefined;
  const mainId = panes[0]?.id ?? 'main';
  const bandH = openIdx.map((i) => Math.round(openHeight * share(i)));

  const out: PaneLayout[] = [];
  let y = 0;
  panes.forEach((pane, i) => {
    const isCollapsed = collapsed[i] === true;
    const h = isCollapsed ? titleH : (bandH[openIdx.indexOf(i)] ?? 0);
    const band: Rect = { x: 0, y, w: width, h };
    y += h;

    const hasTitle = pane.title !== undefined;
    const top = band.y + (hasTitle ? titleH : 0);
    const gutters = guttersOf(spec, pane.id, band, fonts);
    const wantsXAxis = !isCollapsed && i === lastOpen;
    const wantsBand = !isCollapsed && input.eventBand && pane.id === mainId;
    const bottomTrim = (wantsXAxis ? xAxisH : 0) + (wantsBand ? eventBandHeightPx(fonts) : 0);
    const plotH = isCollapsed ? 0 : Math.max(0, band.y + band.h - top - bottomTrim);
    const plot: Rect = { x: gutters.x, y: top, w: gutters.w, h: plotH };

    out.push({
      paneId: pane.id,
      index: i,
      ...(pane.title === undefined ? {} : { title: pane.title }),
      rect: band,
      plot,
      yAxes: gutters.axes,
      ...(wantsXAxis
        ? { xAxis: { x: plot.x, y: band.y + band.h - xAxisH, w: plot.w, h: xAxisH } }
        : {}),
      ...(wantsBand
        ? {
            eventBand: {
              x: plot.x,
              y: plot.y + plot.h,
              w: plot.w,
              h: eventBandHeightPx(fonts),
            },
          }
        : {}),
      collapsed: isCollapsed,
    });
  });
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* Ticks                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * The 1/2/5-decade tick values inside `[lo, hi]`, about `target` of them.
 *
 * Gridlines need values, not pixels, because the label beside the line is the value formatted
 * (`axisLabel`) and a "pretty" pixel position with an ugly value is the wrong way round: a trader
 * reads the level off the label. A degenerate domain (all values equal, a single point, an empty
 * series) returns the one value rather than an empty set, so the axis still says what it is showing.
 */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi <= lo) return [lo];
  const rough = (hi - lo) / Math.max(1, target);
  const decade = 10 ** Math.floor(Math.log10(rough));
  const mantissa = rough / decade;
  const step = (mantissa <= 1 ? 1 : mantissa <= 2 ? 2 : mantissa <= 5 ? 5 : 10) * decade;
  const first = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  // The loop is bounded by `target * 4` and not by the domain: a pathological domain (1e300 wide,
  // or a step that rounds to zero) must not spin here on a frame path.
  for (let v = first, n = 0; v <= hi + step * 1e-9 && n < target * 4; v += step, n += 1) {
    ticks.push(Number(v.toFixed(12)));
  }
  return ticks.length > 0 ? ticks : [lo];
}

/** Decade marks for a log axis (§11.2 `scale: 'log'`); the 1/2/5 steps of a decade are not drawn. */
export function logDecadeTicks(lo: number, hi: number, target = 5): number[] {
  if (!(lo > 0) || !(hi > lo)) return lo > 0 ? [lo] : [];
  const from = Math.ceil(Math.log10(lo));
  const to = Math.floor(Math.log10(hi));
  const decades: number[] = [];
  for (let e = from; e <= to; e += 1) decades.push(10 ** e);
  if (decades.length >= 2) return decades;
  // Inside one decade a log axis has no decade marks at all, and an axis with no labels is not an
  // axis. The 1/2/5 steps of the linear picker are the right answer there and are already correct in
  // log space, because they are values.
  return niceTicks(lo, hi, target);
}

/**
 * How many slots apart x labels may be before they touch.
 *
 * `digitPx` is the whole of the text measurement this file does: the axis font is monospace with
 * tabular figures (§12.3), so one advance width times the label length is the exact width of every
 * label, and `measureText` per tick would make the axis cost scale with its tick count for an answer
 * that cannot differ.
 */
export function xTickStride(slotPx: number, labelChars: number, fonts: ChartFonts): number {
  const needed = (labelChars + 2) * fonts.digitPx;
  return Math.max(1, Math.ceil(needed / Math.max(0.0001, slotPx)));
}

/** One tick value rendered through THE formatter (`core/fields/format.ts`). */
export function axisLabel(fmt: ChartSpec['yAxes'][number]['fmt'], v: number, decimals?: number): string {
  return formatValue(fmt ?? 'px', v, decimals === undefined ? {} : { decimals });
}

/* -------------------------------------------------------------------------------------------- */
/* The x label — one answer, three axis types (§11.2)                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * A tenor expressed as traders write it: `182` days is `6M`, `1826` is `5Y` (§11.2).
 *
 * Arithmetic rather than a lookup in `scales.ts`'s `TENOR_LADDER`, and the difference is what each is
 * for. The ladder exists to CHOOSE which rungs get an axis tick, so it only has to name the rungs; a
 * readout has to name whatever node the crosshair is standing on, and the curve payloads carry nodes
 * that are not rungs (`CRVF.default.json` holds both 1095 and 1096 days). A lookup would answer
 * nothing for those, and the number of days is not what the grid beside the chart calls them. On the
 * rungs the two agree, which is the property that matters: 30→1M, 91→3M, 182→6M, 365→1Y, 1826→5Y,
 * 3652→10Y, 10957→30Y.
 */
export function tenorLabel(days: number): string {
  if (!Number.isFinite(days)) return '';
  const d = Math.round(days);
  if (d <= 0) return 'SPOT';
  if (d < 7) return `${String(d)}D`;
  if (d < 28) return `${String(Math.round(d / 7))}W`;
  if (d < 350) return `${String(Math.round(d / 30.44))}M`;
  const years = d / 365.25;
  // A whole number of years for every rung of the ladder, one decimal for a node between two of
  // them: `1826` is `5Y` and not `5.0Y`, and `1300` is `3.6Y` rather than a `4Y` that is not true.
  const whole = Math.round(years);
  return Math.abs(years - whole) < 0.05 ? `${String(whole)}Y` : `${years.toFixed(1)}Y`;
}

/**
 * How one slot of an x axis is labelled — the engine's ONE answer, for every reader (§11.2, §11.9).
 *
 * There are three readers of this and they were three implementations: the x-axis strip
 * (`renderer.ts#xTicksOf`), the on-canvas crosshair readout (`Renderer.drawReadout`) and the DOM
 * readout the screen reader cites (`ChartCanvas.paintFurniture`). The last two both ran the slot's x
 * value through a DATE formatter unconditionally, so every curve chart in the product — GC, CRVF,
 * OMON, OVML — announced `1970-01-01T00:00:01.826Z` at the 5Y node: the value is a day count, a
 * strike or a spot price, and only `xAxis.type: 'time'` carries an instant. A readout that misnames
 * what the number is is worse than one that omits it, so the branch lives here and all three call it.
 *
 * `tenor` is two axes wearing one name, because `ChartSpec.xAxis` has no fourth type: GC and CRVF put
 * DAYS on it while OMON's smile puts STRIKES and OVML's profile puts SPOT PRICES (all four declare
 * `kind: 'curve'`, so the spec kind does not separate them either). They are told apart the way
 * `scales.ts` already tells them apart — by how much of a range the axis spans, since a curve runs
 * from a week to thirty years and a strike band never spans 24× — and `6M` printed under a strike of
 * 182 would be a false label rather than merely an unhelpful one.
 */
export type XLabeller = (slot: number, t: number) => string;

/** A tenor domain spans at least this ratio in `1 + x`; below it the axis is not days (§11.2). */
export const TENOR_DOMAIN_RATIO = 24;

/**
 * The labeller for one spec, built once per spec from the x extremes of its slot index.
 *
 * `compact` is the x-axis STRIP, which has one row of monospace under a plot and thins its ticks by
 * label width: an intraday tick reads `14:31` there where the readout reads the whole instant. It is
 * the only difference between the two, and it is a parameter rather than a second function so that a
 * change of axis type cannot reach one reader and miss the other.
 */
export function xLabeller(
  spec: ChartSpec,
  firstX: number,
  lastX: number,
  compact = false,
): XLabeller {
  const axis = spec.xAxis;
  if (axis.type === 'category') {
    const categories = axis.categories ?? [];
    return (slot) => categories[slot] ?? String(slot);
  }
  if (axis.type === 'tenor') {
    const ladder =
      Number.isFinite(firstX) &&
      Number.isFinite(lastX) &&
      1 + Math.max(firstX, lastX) >= TENOR_DOMAIN_RATIO * (1 + Math.max(0, Math.min(firstX, lastX)));
    // Not a ladder: the number is a strike or a spot, so it is printed as the number it is. `px`
    // rather than `int` because a strike of 352.5 exists and rounding it would name a contract that
    // does not.
    return ladder ? (_slot, t) => tenorLabel(t) : (_slot, t) => axisLabel('px', t);
  }
  if (spec.kind === 'intraday') {
    // `slice(11, 16)` is the time part of the ISO datetime the one formatter produces: §11.2 wants a
    // time of day on an intraday strip, and `core/fields/format.ts` has no time-of-day rendering —
    // adding one here would be a second formatter in the system that CLIENT §12 exists to prevent.
    return compact
      ? (_slot, t) => axisLabel('datetime', t).slice(11, 16)
      : (_slot, t) => axisLabel('datetime', t);
  }
  return (_slot, t) => axisLabel('date', t);
}

/* -------------------------------------------------------------------------------------------- */
/* Furniture draws                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** A y tick, positioned. */
export interface YTick {
  readonly v: number;
  readonly py: number;
  readonly label: string;
}

/** An x tick, positioned. */
export interface XTick {
  readonly slot: number;
  readonly px: number;
  readonly label: string;
}

/** The base canvas is opaque (`alpha: false`), so every frame starts by painting the background. */
export function fillBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: ChartTheme,
): void {
  ctx.fillStyle = theme.colour['--c-bg'];
  ctx.fillRect(0, 0, width, height);
}

/** Horizontal and vertical gridlines inside one plot rect. */
export function drawGridlines(
  ctx: CanvasRenderingContext2D,
  plot: Rect,
  xs: readonly number[],
  ys: readonly number[],
  theme: ChartTheme,
  hairline: number,
): void {
  if (plot.w <= 0 || plot.h <= 0) return;
  ctx.save();
  ctx.strokeStyle = theme.colour['--c-grid-line'];
  ctx.lineWidth = hairline;
  ctx.beginPath();
  for (const py of ys) {
    // The half-pixel offset is what makes a 1 px line one pixel: a stroke is centred on the path,
    // so an integer y spreads it over two rows at half intensity and the grid reads as a smudge.
    const y = Math.round(py) + 0.5;
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
  }
  for (const px of xs) {
    const x = Math.round(px) + 0.5;
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
  }
  ctx.stroke();
  ctx.restore();
}

/** One y-axis gutter: the axis rule and its labels, right-aligned on a left axis and vice versa. */
export function drawYAxis(
  ctx: CanvasRenderingContext2D,
  axis: YAxisLayout,
  plot: Rect,
  ticks: readonly YTick[],
  theme: ChartTheme,
  fonts: ChartFonts,
): void {
  if (axis.rect.w <= 0) return;
  ctx.save();
  ctx.font = fonts.axis;
  ctx.fillStyle = theme.colour['--c-label'];
  ctx.textBaseline = 'middle';
  ctx.textAlign = axis.side === 'left' ? 'right' : 'left';
  const x = axis.side === 'left' ? axis.rect.x + axis.rect.w - 2 : axis.rect.x + 2;
  for (const tick of ticks) {
    if (tick.py < plot.y - 1 || tick.py > plot.y + plot.h + 1) continue;
    ctx.fillText(tick.label, x, tick.py);
  }
  ctx.strokeStyle = theme.colour['--c-axis'];
  ctx.lineWidth = 1;
  ctx.beginPath();
  const rule = axis.side === 'left' ? axis.rect.x + axis.rect.w - 0.5 : axis.rect.x + 0.5;
  ctx.moveTo(rule, plot.y);
  ctx.lineTo(rule, plot.y + plot.h);
  ctx.stroke();
  ctx.restore();
}

/** The shared x-axis strip: the rule and one row of labels, centred on their ticks. */
export function drawXAxis(
  ctx: CanvasRenderingContext2D,
  strip: Rect,
  ticks: readonly XTick[],
  theme: ChartTheme,
  fonts: ChartFonts,
): void {
  if (strip.w <= 0 || strip.h <= 0) return;
  ctx.save();
  ctx.strokeStyle = theme.colour['--c-axis'];
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(strip.x, strip.y + 0.5);
  ctx.lineTo(strip.x + strip.w, strip.y + 0.5);
  ctx.stroke();
  ctx.font = fonts.axis;
  ctx.fillStyle = theme.colour['--c-label'];
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const tick of ticks) {
    const half = (tick.label.length * fonts.digitPx) / 2;
    // A label that would overhang the strip is clamped rather than dropped: the leftmost and
    // rightmost ticks are the two a trader reads first (the range of the chart).
    const x = Math.min(Math.max(tick.px, strip.x + half), strip.x + strip.w - half);
    ctx.fillText(tick.label, x, strip.y + 2);
  }
  ctx.restore();
}

/** A pane's title bar — the label and the rule under it (`ChartSpec.panes[].title`). */
export function drawPaneTitle(
  ctx: CanvasRenderingContext2D,
  pane: PaneLayout,
  theme: ChartTheme,
  fonts: ChartFonts,
): void {
  if (pane.title === undefined || pane.rect.w <= 0) return;
  ctx.save();
  ctx.font = fonts.label;
  ctx.fillStyle = theme.colour['--c-label'];
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const prefix = pane.collapsed ? '▸ ' : '';
  ctx.fillText(`${prefix}${pane.title}`, pane.plot.x + 2, pane.rect.y + 1);
  ctx.strokeStyle = theme.colour['--c-grid-line'];
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pane.rect.x, pane.rect.y + 0.5);
  ctx.lineTo(pane.rect.x + pane.rect.w, pane.rect.y + 0.5);
  ctx.stroke();
  ctx.restore();
}

/** One legend entry: what it says, the swatch colour, and the series it stands for. */
export interface LegendEntry {
  readonly seriesId: string;
  readonly label: string;
  readonly colour: string;
}

/**
 * The legend rects for one pane, stacked down the top-left of the plot.
 *
 * Returned as rects, not drawn only, because the legend is also DOM: `ChartCanvas` puts a real
 * focusable element over each rect so the keyboard and a screen reader can reach a series
 * (`types.ts`'s note on `PaneLayout`), and `hitTest` answers `{ kind: 'legend' }` from the same
 * rects. One arithmetic, three consumers.
 */
export function legendRects(
  pane: PaneLayout,
  entries: readonly LegendEntry[],
  fonts: ChartFonts,
): Rect[] {
  const rowH = Math.round(fonts.lineHeightPx);
  const out: Rect[] = [];
  entries.forEach((entry, i) => {
    const w = Math.min(
      Math.max(0, pane.plot.w - 4),
      Math.round((entry.label.length + 3) * fonts.digitPx),
    );
    out.push({ x: pane.plot.x + 2, y: pane.plot.y + 2 + i * rowH, w, h: rowH });
  });
  return out;
}

/** The legend itself: a swatch and the series label per row. */
export function drawLegend(
  ctx: CanvasRenderingContext2D,
  rects: readonly Rect[],
  entries: readonly LegendEntry[],
  theme: ChartTheme,
  fonts: ChartFonts,
): void {
  ctx.save();
  ctx.font = fonts.label;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  entries.forEach((entry, i) => {
    const rect = rects[i];
    if (rect === undefined || rect.w <= 0) return;
    const mid = rect.y + rect.h / 2;
    ctx.fillStyle = entry.colour;
    ctx.fillRect(rect.x, mid - 1.5, Math.min(8, rect.w), 3);
    ctx.fillStyle = theme.colour['--c-label'];
    ctx.fillText(entry.label, rect.x + 11, mid);
  });
  ctx.restore();
}

/** The glyph each CHRT-06 marker kind draws in the event band (§11.7). */
export const EVENT_GLYPH: Readonly<
  Record<NonNullable<ChartSpec['events']>[number]['kind'], string>
> = Object.freeze({
  earnings: 'E',
  dividend: 'D',
  split: 'S',
  news: 'N',
  filing: 'F',
  index_add: '+',
  index_drop: '−',
  fomc: '●',
});
