// packages/web/src/chart/renderer.ts — the frame (CLIENT.md §11.1, §11.2, §11.5; CHRT-01..07).
//
// Two stacked canvases and one rule about them, which is the whole design (§11.1):
//
//   * the **base** canvas holds everything that is a function of the data — grid, axes, series,
//     studies, events, annotations, reference lines, legend — and is redrawn only when data, range,
//     size, pane layout or options change. Its context is created with `{ alpha: false }`, so every
//     frame that touches it begins by painting the background.
//   * the **overlay** canvas holds everything that is a function of the pointer or the keyboard —
//     crosshair, readout, forming bar, draw-mode preview, focus rings — and is redrawn per
//     interaction frame.
//
// A crosshair move is the common case: a trader sweeping the chart generates one `setState` per
// mouse-move or per `ArrowLeft`, and redrawing ten years of daily bars for each of them is how a
// chart misses its 4 ms base-redraw budget (§16.1) while appearing to work. So `setState` classifies
// its patch — `view`, `spec` and `collapsedPanes` dirty the base; `crosshair`, `focus` and
// `drawMode` dirty only the overlay — and `frame()` redraws what is dirty and nothing else. That
// classification is the load-bearing part of this file and `test/chart/renderer.test.ts` counts draw
// operations on the base context to prove it, because a renderer that quietly redrew everything
// would look identical on screen.
//
// **What lives elsewhere and why.** `series.ts` owns the twelve marks and `layers.ts` the geometry
// and the furniture; this file owns what is dirty, what the scales are, and the clip. Three seams
// reach modules that are WP-14's other hands: the study registry (`studies/index.ts`), the
// annotation painter (`annotations.ts`) and the downsampler (`downsample.ts`). The first two arrive
// through `setPlugins` — an additive method, not a change to the §11.1 constructor — and the
// renderer draws correctly without them rather than pretending they are here. The third is imported
// directly and is now wired on both sides of a frame (`reduced`): §11.4's reduction feeds the draw
// AND the axis domain scan, so a million-point line costs O(pixels) in both, and a streamed bar
// invalidates only the last pixel column. Before that the loops were O(points) and a million points
// cost 338 ms a frame against §16.1's 16 — the one CHRT-02 claim the file did not make good on.
//
// **Slots, not timestamps.** `setSpec` builds the union of every series' `x` values, sorted and
// deduplicated, and rebases each series onto it (§11.2 `TradingDayIndex`). Nights, weekends and
// holidays therefore never reach a draw function, two securities with different calendars align by
// timestamp, and a pan is integer arithmetic. `scales.ts` (WP-14's other hand) is where §11.2's
// `TenorScale` log-ish spacing and the zoom-dependent tick thinning belong; until it lands the tenor
// and category axes are slot-linear here, which is correct spacing for the curve nodes the six real
// screens build (they are already ordered) but not the log-ish tenor spacing §11.2 describes. What a
// slot is CALLED on each of the four axis kinds is `layers.ts#xLabeller`, shared with both readouts:
// a day count, a strike and a spot price are not instants, and running them through a date formatter
// is how every curve chart came to announce `1970-01-01`.

import { seriesToken } from '../theme/colours.js';
import {
  axisLabel,
  computeLayout,
  drawGridlines,
  drawLegend,
  drawPaneTitle,
  drawXAxis,
  drawYAxis,
  EVENT_GLYPH,
  fillBackground,
  legendRects,
  logDecadeTicks,
  niceTicks,
  studyAxisId,
  xLabeller,
  xTickStride,
} from './layers.js';
import type { LegendEntry, XLabeller, XTick, YTick } from './layers.js';
import {
  DEFAULT_CACHE_ENTRIES,
  DownsampleCache,
  SCATTER_COLUMN_CAP,
  shouldReduce,
} from './downsample.js';
import { followOnAppend } from './streaming.js';
import type { ReduceRequest } from './downsample.js';
import { SERIES_DRAWS } from './series.js';
import { GAP, TradingDayIndex } from './tradingDayIndex.js';
import { studyNeedsMet } from './studies/needs.js';
import type { StudyColumns } from './studies/needs.js';
import type { StudyDef, StudyOutput } from './studies/types.js';
import type {
  ChartFocus,
  ChartFonts,
  ChartSeries,
  ChartSpec,
  ChartState,
  ChartTheme,
  DrawMode,
  Hit,
  PaneLayout,
  Rect,
  SeriesData,
  SeriesPaint,
  SeriesScales,
  StreamPatch,
  Viewport,
} from './types.js';

export type { ChartFocus, ChartState, Viewport } from './types.js';

/**
 * The modules this renderer draws *through* rather than *for* — WP-14's other hands.
 *
 * Optional because the renderer is complete without them and must say so by drawing correctly: a
 * spec with studies and no registry draws its price panes and leaves the study panes empty, which is
 * a visibly missing study rather than a wrong number. `ChartCanvas` supplies both once
 * `studies/index.ts` and `annotations.ts` land.
 */
export interface RendererPlugins {
  /** `studies/index.ts`'s registry: `Record<StudyId, StudyDef>` (§11.6). */
  readonly studies?: Readonly<Record<string, StudyDef>>;
  /**
   * `annotations.ts`'s painter, handed the pane it draws in and the two mappings it needs.
   *
   * The shapes are CHRT-05's and their maths is that module's (fib levels, the OLS channel through
   * `core/analytics/stats#olsRegression`); what this renderer owns is *where* `{ t, v }` lands, so
   * that is what it passes in.
   */
  readonly annotations?: AnnotationPainter;
}

/** How `annotations.ts` is called for one pane: data coordinates in, ink out (§11.8). */
export type AnnotationPainter = (
  ctx: CanvasRenderingContext2D,
  pane: PaneLayout,
  map: { xOfTs(t: number): number; yOfValue(v: number): number },
  annotations: NonNullable<ChartSpec['annotations']>,
  selected: number | null,
) => void;

/** The empty chart a renderer holds before `setSpec` — a real spec, so nothing has to be nullable. */
const EMPTY_SPEC: ChartSpec = Object.freeze({
  kind: 'price' as const,
  xAxis: { type: 'time' as const },
  yAxes: [],
  panes: [{ id: 'main', height: 1 }],
  series: [],
  crosshair: false,
});

/** Headroom above and below the data, so the extremes are not drawn on the frame. */
const DOMAIN_PAD = 0.03;

/** §11.5: a value leaving the axis range forces a full redraw "at most once per second". */
const RANGE_REDRAW_MIN_MS = 1000;

/** What M4 emits per pixel column — first, min, max, last (§11.4). Below this it removes nothing. */
const M4_POINTS_PER_COLUMN = 4;

/** What the bar reduction emits per pixel column: one range candle (§11.4). */
const BARS_PER_COLUMN = 1;

/**
 * How much smaller a reduction must be than its input to be worth running: four times.
 *
 * A quarter is not a tuning knob, it is the point at which the pass pays for itself. Reducing costs a
 * walk over every visible slot plus a buffer allocation per series per frame, and returns marks the
 * draw then walks again; below a factor of four the two walks cost more than the one they replace, and
 * the allocation is pure garbage. See `Renderer.reduced` for the measurement.
 */
const WORTH_REDUCING_FACTOR = 4;

/** Whether a reduction that emits `perColumn` marks per pixel column would meaningfully reduce. */
function worthReducing(visible: number, columns: number, perColumn: number): boolean {
  return visible > WORTH_REDUCING_FACTOR * perColumn * columns;
}

/** How many slots the streaming clip covers — §11.5's "the last two slots". */
const STREAM_CLIP_SLOTS = 2;

/* -------------------------------------------------------------------------------------------- */
/* Growable columns (§11.5)                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * One data column, over-allocated so a streaming append does not copy.
 *
 * §11.5 asks for capacity doubling and a `Float64Array` copy only when the capacity runs out, and the
 * reason is the append budget (< 2 ms): a `b1m:` subject appends a bar a minute per series, and
 * reallocating a ten-year daily array each time would make the cheapest event in the system the most
 * expensive. `used` is the logical length; the views handed to a draw function are `subarray(0, used)`
 * so nothing can read the slack.
 */
interface Column {
  buf: Float64Array;
  used: number;
}

function column(from: SeriesData | undefined, length: number): Column | undefined {
  if (from === undefined) return undefined;
  const buf = new Float64Array(Math.max(length, 1));
  for (let i = 0; i < length; i += 1) buf[i] = from[i] ?? Number.NaN;
  return { buf, used: length };
}

function push(col: Column, value: number): void {
  if (col.used >= col.buf.length) {
    const grown = new Float64Array(Math.max(4, col.buf.length * 2));
    grown.set(col.buf);
    col.buf = grown;
  }
  col.buf[col.used] = value;
  col.used += 1;
}

function setLast(col: Column, value: number): void {
  if (col.used > 0) col.buf[col.used - 1] = value;
}

/** One series, rebased onto the slot index and ready to draw. */
interface Resolved {
  /** The spec's own series: labels, `provIdx`, `style`, `live`. Never mutated. */
  readonly spec: ChartSeries;
  /** What a `SeriesDraw` is handed: `x` holds slots, every column a `Float64Array` view. */
  readonly drawable: ChartSeries;
  readonly slots: Column;
  readonly ys: Column;
  readonly o: Column | undefined;
  readonly h: Column | undefined;
  readonly l: Column | undefined;
  readonly c: Column | undefined;
  readonly v: Column | undefined;
  /** The timestamp of the last bar `IS_FINAL` froze; a repeat of it is not redrawn (§11.5). */
  frozenTs: number;
  /** Palette index for `style.color: 'auto'`. */
  readonly paletteIndex: number;
}

/** A study, computed. */
interface ResolvedStudy {
  readonly paneId: string;
  readonly def: StudyDef;
  readonly params: Record<string, number>;
  readonly input: Resolved;
  out: StudyOutput;
}

/** One y-axis as this frame will draw it. */
interface AxisRender {
  readonly axisId: string;
  readonly lo: number;
  readonly hi: number;
  readonly scale: 'linear' | 'log';
  readonly fmt: ChartSpec['yAxes'][number]['fmt'];
  readonly decimals: number | undefined;
  /**
   * The axis's own `normalise` mapping and its inverse (§11.2).
   *
   * On the axis rather than per series because `normalise` is declared per axis while a rebasing is
   * per series: the reference rules, the annotations and every pixel → value read need one agreed
   * unit for the axis, and `lo`/`hi` above are expressed in it.
   */
  readonly norm: Normaliser;
}

/**
 * A value mapping and its inverse — `identity`, `pct` or `base100` (§11.2).
 *
 * Both directions, always, because the engine reads pixels as well as writing them: CHRT-05's
 * anchors are data coordinates and `hitTest` is where a pixel becomes one.
 */
interface Normaliser {
  to(value: number): number;
  from(unit: number): number;
}

/* -------------------------------------------------------------------------------------------- */
/* Colour                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** `#rgb`, `#rrggbb`, `rgb()` and `rgba()` → channels; anything else is passed through untouched. */
function channels(colour: string): [number, number, number] | null {
  const text = colour.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex?.[1] !== undefined) {
    const body = hex[1];
    const wide = body.length === 6;
    const part = (i: number): number =>
      wide
        ? Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
        : Number.parseInt(`${body[i] ?? '0'}${body[i] ?? '0'}`, 16);
    return [part(0), part(1), part(2)];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb?.[1] !== undefined) {
    const parts = rgb[1].split(/[,/\s]+/).filter((p) => p !== '');
    const n = (i: number): number => Number.parseFloat(parts[i] ?? '0');
    return [n(0), n(1), n(2)];
  }
  return null;
}

/**
 * The same colour at a given alpha — `area`'s 0.18 fill and `mountain`'s gradient (§11.3).
 *
 * A colour that cannot be parsed is returned as it came rather than replaced with a guess: an
 * unparseable token means `tokens.css` said something this function does not understand, and an area
 * that draws opaque is a visible bug someone fixes, where a silently black fill is not.
 */
function withAlpha(colour: string, alpha: number): string {
  const rgb = channels(colour);
  if (rgb === null) return colour;
  return `rgba(${String(rgb[0])}, ${String(rgb[1])}, ${String(rgb[2])}, ${String(alpha)})`;
}

/** Linear interpolation between two colours, for the `heatmap` sequential ramp (§11.3). */
function mix(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  if (a === null || b === null) return to;
  const clamped = Math.min(1, Math.max(0, t));
  const channel = (i: 0 | 1 | 2): number => Math.round(a[i] + (b[i] - a[i]) * clamped);
  return `rgb(${String(channel(0))}, ${String(channel(1))}, ${String(channel(2))})`;
}

/* -------------------------------------------------------------------------------------------- */
/* The renderer                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * The chart engine's frame (§11.1).
 *
 * The public surface is §11.1's listing exactly — `setSpec`, `setState`, `applyStream`, `resize`,
 * `frame`, `hitTest`, `layout` — plus `setPlugins` and `focusProvIdx`. The second of those is DATA-10:
 * provenance on a chart is per series, so the element that holds focus must carry the `provIdx` of
 * the series the crosshair or the keyboard is on, and it must change as that moves. `ChartCanvas`
 * cannot work that out from the spec — it does not know where the crosshair is — so the renderer
 * answers it.
 */
export class Renderer {
  private readonly baseCtx: CanvasRenderingContext2D | null;
  private readonly overlayCtx: CanvasRenderingContext2D | null;
  private readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private theme: ChartTheme;
  private fonts: ChartFonts;
  private dpr: number;
  private width: number;
  private height: number;

  private spec: ChartSpec = EMPTY_SPEC;
  private view: Viewport = { slot0: 0, slot1: 0 };
  private crosshair: ChartState['crosshair'] = null;
  private focus: ChartFocus = { kind: 'plot' };
  private drawMode: DrawMode | null = null;
  private collapsedPanes: ReadonlySet<string> = new Set<string>();
  private selectedAnnotation: number | null = null;
  private eventBandVisible = true;

  /**
   * The slot axis (§11.2) — `tradingDayIndex.ts`'s, not a second copy.
   *
   * That file owns the union of every series' x, the per-series slot tables, the session windows and
   * the right-edge `append` that §11.5's forming bar needs. Building a private index here would have
   * put two answers to "which slot is this timestamp" in one package, and the one the renderer used
   * would be the one with no session segments and no `breaksBefore` — which is how an intraday line
   * ends up drawn straight across a collapsed night.
   */
  private index = TradingDayIndex.fromSpec(EMPTY_SPEC);
  /**
   * §11.4's reduction cache — the CHRT-02 claim, wired (`downsample.ts`).
   *
   * Nothing called `downsample.ts` before, so a million-point line went through the O(points) loops
   * in `series.ts` at 338 ms a frame against §16.1's 16 ms, and the bench row that certified the
   * budget did the reduction in the test body and handed the renderer 4 920 points — it measured its
   * own harness. The cache is keyed by `(seriesId, view, width)`, which is exactly what a frame has
   * to hand, and is CLEARED by `setSpec`: the key says nothing about the contents of the columns, and
   * a new spec for the same series id at the same viewport would otherwise draw the old data.
   */
  private reducer = new DownsampleCache();
  private resolved: Resolved[] = [];
  private bySeriesId = new Map<string, Resolved>();
  private studies: ResolvedStudy[] = [];
  /** Studies the spec asked for that this series cannot feed — see {@link skippedStudies}. */
  private skipped: { id: string; needs: readonly string[]; error?: string }[] = [];
  private plugins: RendererPlugins = {};

  /**
   * How a slot is labelled on this spec's x axis, and its compact form for the axis strip (§11.2).
   *
   * Built once per spec in `setSpec` rather than per label, because the tenor/strike decision reads
   * the axis's extremes: see `layers.ts#xLabeller`, which is the ONE answer all three readers of an x
   * label now share (the strip, the canvas readout and `ChartCanvas`'s DOM readout).
   */
  private xLabel: XLabeller = xLabeller(EMPTY_SPEC, Number.NaN, Number.NaN);
  private xTickLabel: XLabeller = xLabeller(EMPTY_SPEC, Number.NaN, Number.NaN, true);

  private panes: PaneLayout[] = [];
  private axes = new Map<string, AxisRender>();
  private legends = new Map<string, { entries: LegendEntry[]; rects: Rect[] }>();

  private baseDirty = true;
  private overlayDirty = true;
  private lastSlotDirty = false;
  private rangePending = false;
  private lastRangeRedrawMs = Number.NEGATIVE_INFINITY;

  constructor(
    base: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    opts: { dpr: number; theme: ChartTheme; fonts: ChartFonts },
  ) {
    this.base = base;
    this.overlay = overlay;
    this.dpr = opts.dpr > 0 ? opts.dpr : 1;
    this.theme = opts.theme;
    this.fonts = opts.fonts;
    // `{ alpha: false }` on the base only (§11.1): an opaque canvas lets the compositor skip blending
    // the largest surface on the screen. The overlay must stay transparent — it is the crosshair over
    // the chart, not instead of it.
    this.baseCtx = base.getContext('2d', { alpha: false });
    this.overlayCtx = overlay.getContext('2d');
    this.width = base.width / this.dpr;
    this.height = base.height / this.dpr;
  }

  /** `studies/index.ts` and `annotations.ts`, once they exist (see `RendererPlugins`). */
  setPlugins(plugins: RendererPlugins): void {
    this.plugins = plugins;
    this.computeStudies();
    this.baseDirty = true;
  }

  /** The palette and the fonts, re-read once per theme or density change (§11.1, §16.1). */
  setTheme(theme: ChartTheme, fonts: ChartFonts): void {
    this.theme = theme;
    this.fonts = fonts;
    this.baseDirty = true;
    this.overlayDirty = true;
  }

  /**
   * A new spec: rebuild the slot index, rebase every series onto it, recompute the studies (§11.1).
   *
   * The viewport resets to the whole series because a new spec is a new chart — a different range, a
   * different security, a different periodicity — and keeping the old slot bounds would show slots
   * 900-1000 of a series that now has 300 points.
   */
  setSpec(spec: ChartSpec): void {
    this.spec = spec;
    // A fresh cache, sized to the chart. `DownsampleCache`'s bound is ENTRIES and one viewport of an
    // N-series chart is N entries, so the number of viewports a chart can remember — which is what
    // makes a pan back and forth, or a zoom in and out, free the second time — falls as series are
    // added unless the bound scales with them. Replacing the cache rather than clearing it is also how
    // the stale-contents hazard is closed: the key names a series id, a viewport and a width, none of
    // which changes when the columns behind them are replaced by a new payload.
    this.reducer = new DownsampleCache(DEFAULT_CACHE_ENTRIES * Math.max(1, spec.series.length));
    this.buildSlotIndex();
    const last = this.index.length - 1;
    this.xLabel = xLabeller(spec, this.index.valueAt(0), this.index.valueAt(Math.max(0, last)));
    this.xTickLabel = xLabeller(
      spec,
      this.index.valueAt(0),
      this.index.valueAt(Math.max(0, last)),
      true,
    );
    this.resolveSeries();
    this.computeStudies();
    this.view = { slot0: 0, slot1: Math.max(0, last) };
    this.crosshair = null;
    this.baseDirty = true;
    this.overlayDirty = true;
    this.lastSlotDirty = false;
  }

  /**
   * Patch the state, and dirty exactly what the patch can have changed (§11.1).
   *
   * `in` rather than `!== undefined`: with `exactOptionalPropertyTypes` an absent key of a
   * `Partial<ChartState>` means "leave it alone" while an explicit `undefined` does not occur, and
   * `crosshair: null` is a real instruction — hide the readout — that a truthiness test would drop
   * (`types.ts`'s note on `ChartState`).
   */
  setState(patch: Partial<ChartState>): void {
    if ('spec' in patch && patch.spec !== undefined) {
      this.setSpec(patch.spec);
      return;
    }
    if ('view' in patch && patch.view !== undefined) {
      this.view = this.clampView(patch.view);
      this.baseDirty = true;
      this.overlayDirty = true;
    }
    if ('collapsedPanes' in patch && patch.collapsedPanes !== undefined) {
      this.collapsedPanes = patch.collapsedPanes;
      this.baseDirty = true;
      this.overlayDirty = true;
    }
    if ('crosshair' in patch) {
      this.crosshair = patch.crosshair ?? null;
      this.overlayDirty = true;
    }
    if ('focus' in patch && patch.focus !== undefined) {
      this.focus = patch.focus;
      this.overlayDirty = true;
    }
    if ('drawMode' in patch) {
      this.drawMode = patch.drawMode ?? null;
      this.overlayDirty = true;
    }
  }

  /** `E` (§11.7) — the event band is layout, so hiding it moves the plot rect and dirties the base. */
  setEventBandVisible(visible: boolean): void {
    this.eventBandVisible = visible;
    this.baseDirty = true;
  }

  /** The selected annotation (`ArrowUp/Down`, §11.8); overlay-only, like every other selection. */
  setSelectedAnnotation(index: number | null): void {
    this.selectedAnnotation = index;
    this.overlayDirty = true;
  }

  /**
   * One live update (§11.5, CHRT-02).
   *
   * Three things are decided here and each of them is a budget. A forming bar whose timestamp equals
   * the last slot's overwrites that slot in place — no array grows, no slot is added, and the dirty
   * region is the last two slots rather than the canvas. A bar that `IS_FINAL` has already frozen is
   * dropped without dirtying anything, because redrawing a bar that cannot change again is work with
   * no output. And a value that leaves the current axis range cannot be drawn inside it, so that (and
   * only that) escalates to a full redraw — rate-limited to once a second, because a fast market
   * would otherwise turn every tick into a whole-canvas repaint.
   */
  applyStream(patch: StreamPatch): void {
    const series = this.bySeriesId.get(patch.seriesId);
    if (series === undefined) return;

    if (patch.mode === 'replace-last') {
      // `y` and nothing else (§11.5: "`replace-last` updates the last `y` and the legend value"). The
      // `ohlc` columns are deliberately untouched: a `q:` last price is not a bar — it has no open —
      // and folding it into `c` would leave a candle whose close disagreed with its own high until
      // the next `b1m:` frame, which is a body drawn outside its own wick. A candle series binds
      // `append-forming-bar`; `replace-last` is for the line.
      setLast(series.ys, patch.y);
      this.reducer.invalidateLastColumn(patch.seriesId);
      this.refreshViews(series);
      this.noteValue(series, patch.y);
      this.lastSlotDirty = true;
      this.overlayDirty = true;
      return;
    }

    const bar = patch.bar;
    if (series.frozenTs === bar.t) return;
    const lastSlot = series.slots.used > 0 ? (series.slots.buf[series.slots.used - 1] ?? -1) : -1;
    const lastTs = lastSlot >= 0 ? this.index.valueAt(lastSlot) : Number.NaN;

    if (lastTs === bar.t) {
      setLast(series.ys, bar.c);
      if (series.o !== undefined) setLast(series.o, bar.o);
      if (series.h !== undefined) setLast(series.h, bar.h);
      if (series.l !== undefined) setLast(series.l, bar.l);
      if (series.c !== undefined) setLast(series.c, bar.c);
      if (series.v !== undefined) setLast(series.v, bar.v);
    } else {
      // A forming bar that is neither the last slot nor after it is a stream out of order, and the
      // slot axis every binary search in `tradingDayIndex.ts` depends on must stay sorted — that file
      // throws on an out-of-order `append` for exactly that reason. Dropping it here keeps the axis
      // intact and keeps a defect in the feed from becoming an exception inside a WebSocket delta
      // handler; naming the refusal (`StreamRefusal`, `streaming.ts`) belongs with whoever owns the
      // stream taxonomy, and this renderer is not it.
      if (Number.isFinite(lastTs) && bar.t < lastTs) return;
      const slot = this.appendSlot(bar.t);
      push(series.slots, slot);
      push(series.ys, bar.c);
      if (series.o !== undefined) push(series.o, bar.o);
      if (series.h !== undefined) push(series.h, bar.h);
      if (series.l !== undefined) push(series.l, bar.l);
      if (series.c !== undefined) push(series.c, bar.c);
      if (series.v !== undefined) push(series.v, bar.v);
      // The arrays are this renderer's and the slot tables are the index's, which is why `append` and
      // `setPoint` are two calls (`tradingDayIndex.ts#setPoint`): without the second, the new bar has
      // a slot on the axis and no point at it, and every study input and crosshair readout would read
      // a gap where the forming bar is.
      this.index.setPoint(series.spec.id, slot, series.slots.used - 1);
      this.followRightEdge(slot);
    }
    if (bar.final) series.frozenTs = bar.t;
    // §11.4/§11.5: a forming bar rewrites the last slot, so only the last pixel column of every
    // cached reduction of this series changes — 4 slots of work instead of re-reducing the viewport.
    this.reducer.invalidateLastColumn(patch.seriesId);
    this.refreshViews(series);
    this.noteValue(series, bar.h);
    this.noteValue(series, bar.l);
    this.updateStudiesFor(series);
    this.lastSlotDirty = true;
    this.overlayDirty = true;
  }

  /** New CSS size and/or device-pixel ratio (§11.1, TERM-10). */
  resize(w: number, h: number, dpr: number): void {
    this.width = Math.max(0, w);
    this.height = Math.max(0, h);
    this.dpr = dpr > 0 ? dpr : 1;
    for (const canvas of [this.base, this.overlay]) {
      canvas.width = Math.max(1, Math.round(this.width * this.dpr));
      canvas.height = Math.max(1, Math.round(this.height * this.dpr));
    }
    this.baseDirty = true;
    this.overlayDirty = true;
  }

  /**
   * The rAF callback: redraw what is dirty (§11.1).
   *
   * Order matters. A full base redraw subsumes a last-slot one, so the flags are consumed
   * most-general-first; and the overlay is redrawn after the base because the crosshair sits over it
   * and a base redraw does not clear it.
   */
  frame(now: number): void {
    if (this.baseDirty) {
      this.drawBase();
      this.baseDirty = false;
      this.lastSlotDirty = false;
      this.rangePending = false;
      this.lastRangeRedrawMs = now;
    } else if (this.rangePending && now - this.lastRangeRedrawMs >= RANGE_REDRAW_MIN_MS) {
      this.drawBase();
      this.rangePending = false;
      this.lastSlotDirty = false;
      this.lastRangeRedrawMs = now;
    } else if (this.lastSlotDirty) {
      this.drawBase(this.streamClip());
      this.lastSlotDirty = false;
    }
    if (this.overlayDirty) {
      this.drawOverlay();
      this.overlayDirty = false;
    }
  }

  /** Pane rects, axis rects, the x-axis strip and the event band (§11.1; TESTING.md §2.2). */
  layout(): PaneLayout[] {
    return computeLayout({
      spec: this.spec,
      width: this.width,
      height: this.height,
      fonts: this.fonts,
      collapsedPanes: this.collapsedPanes,
      eventBand: this.eventBandVisible && (this.spec.events ?? []).length > 0,
    });
  }

  /**
   * What is under a pointer, in data coordinates (§11.1).
   *
   * Legend, axis and event band are tested before the plot, because all three sit inside or beside it
   * and the innermost thing the eye is pointing at is the one it means. `annotation` precedes `plot`
   * for the same reason: a click near an anchor is a grab, not a crosshair move.
   */
  hitTest(px: number, py: number): Hit | null {
    const panes = this.layout();
    this.rebuildLegends(panes);
    for (const pane of panes) {
      if (py < pane.rect.y || py > pane.rect.y + pane.rect.h) continue;
      if (pane.collapsed) return { kind: 'pane', paneId: pane.paneId };

      const legend = this.legends.get(pane.paneId);
      if (legend !== undefined) {
        const index = legend.rects.findIndex((r) => inside(r, px, py));
        const entry = index < 0 ? undefined : legend.entries[index];
        if (entry !== undefined) {
          return { kind: 'legend', paneId: pane.paneId, seriesId: entry.seriesId };
        }
      }
      for (const axis of pane.yAxes) {
        if (inside(axis.rect, px, py)) {
          return { kind: 'axis', paneId: pane.paneId, axisId: axis.axisId };
        }
      }
      const band = pane.eventBand;
      if (band !== undefined && inside(band, px, py)) {
        const slot = Math.round(this.slotAtPx(pane, px));
        const index = (this.spec.events ?? []).findIndex((e) => this.slotOfTs(e.t) === slot);
        if (index >= 0) return { kind: 'event', index, slot };
      }
      const anchor = this.annotationAt(pane, px, py);
      if (anchor !== null) return anchor;
      if (inside(pane.plot, px, py)) {
        const nearest = this.nearestSeries(pane, px, py);
        const axis = nearest === null ? this.firstAxisOf(pane) : this.axisRenderFor(pane, nearest);
        return {
          kind: 'plot',
          paneId: pane.paneId,
          slot: this.slotAtPx(pane, px),
          value: axis === undefined ? Number.NaN : this.valueAt(pane, axis, py, nearest),
          seriesId: nearest?.spec.id ?? null,
        };
      }
      return { kind: 'pane', paneId: pane.paneId };
    }
    return null;
  }

  /**
   * The `provIdx` the focused element must carry — DATA-10, and it is not optional.
   *
   * Provenance on a chart is per series (`widgets/registry.ts`): the crosshair standing on one series
   * of three means `Ctrl+I` opens that series' source, and the attribute has to move with it. The
   * answers that are not a series index are deliberate:
   *   * a focused event marker cites the event's own `provIdx` (§11.7's `Ctrl+I` on a marker);
   *   * a focused annotation answers `-2` — an annotation is drawn by a user, so it cites no source,
   *     and citing the series under it would attribute a hand-drawn line to a data vendor;
   *   * with no crosshair and no focus, the chart answers `-2` unless every series agrees on one
   *     index, which is the same rule `widgets/Chart.tsx` applies for the same reason: naming series
   *     zero for a canvas drawn from three sources is a false attribution, not a missing one.
   */
  focusProvIdx(): number {
    if (this.focus.kind === 'event') {
      return this.spec.events?.[this.focus.index]?.provIdx ?? -2;
    }
    if (this.focus.kind === 'annotation') return -2;
    if (this.focus.kind === 'legend') {
      return this.bySeriesId.get(this.focus.seriesId)?.spec.provIdx ?? -2;
    }
    if (this.crosshair !== null) {
      const series = this.bySeriesId.get(this.crosshair.seriesId);
      if (series !== undefined) return series.spec.provIdx;
    }
    const distinct = new Set(this.spec.series.map((s) => s.provIdx));
    return distinct.size === 1 ? ([...distinct][0] ?? -2) : -2;
  }

  /**
   * The studies this spec named that the input series cannot feed (§11.6).
   *
   * Surfaced rather than swallowed. A study that is skipped draws nothing, and a pane that is empty
   * for a reason the user cannot see is the same defect as a wrong number: `ChartCanvas` lists these
   * in the DOM beside the studies that did compute, so "ATR needs a bar and this is a yield series"
   * is readable instead of being a blank rectangle.
   */
  skippedStudies(): readonly { id: string; needs: readonly string[]; error?: string }[] {
    return this.skipped;
  }

  /** The current state, for `ChartCanvas`'s readout and for tests that assert what a key did. */
  state(): ChartState {
    return {
      spec: this.spec,
      view: this.view,
      crosshair: this.crosshair,
      focus: this.focus,
      drawMode: this.drawMode,
      collapsedPanes: new Set(this.collapsedPanes),
    };
  }

  /**
   * The value of one series at one slot, or `NaN` when it has no point there (readout, legend).
   *
   * The slot → point lookup is the index's `indexAt`, not a search of this renderer's own columns:
   * `tradingDayIndex.ts` already keeps that table per series, and asking it is what keeps the table
   * honest after a streaming append — a bar appended without the matching `setPoint` shows up here
   * immediately as a gap rather than silently later, in whichever other holder of the same index
   * (`downsample.ts`, `scales.ts`'s `yAxisScale`) reads it next.
   */
  valueOfSeriesAtSlot(seriesId: string, slot: number): number {
    const series = this.bySeriesId.get(seriesId);
    if (series === undefined) return Number.NaN;
    const point = this.index.indexAt(seriesId, Math.round(slot));
    return point === GAP ? Number.NaN : (series.ys.buf[point] ?? Number.NaN);
  }

  /**
   * Every study line and histogram at one slot, labelled and formatted through its own `yFmt`.
   *
   * Public because there are two readouts and one of them is DOM: `ChartCanvas` writes this into the
   * element the host cites through `aria-describedby`, which is the only place a screen reader can
   * find a study value at all. One method, so the pixels and the text cannot disagree (§11.6, §11.9).
   */
  studyRowsAt(slot: number): StudyRow[] {
    const whole = Math.round(slot);
    const out: StudyRow[] = [];
    for (const study of this.studies) {
      const at = this.index.indexAt(study.input.spec.id, whole);
      const fmt = studyValueFormat(study.def);
      const axis = this.axes.get(study.input.spec.yAxis);
      const render = (v: number): string =>
        fmt === undefined
          ? axisLabel(axis?.fmt, v, axis?.decimals)
          : axisLabel(fmt.fmt, v, fmt.decimals);
      const columns = [
        ...study.out.lines.map((line) => ({ id: line.id, label: line.label, y: line.y })),
        ...(study.out.histogram === undefined
          ? []
          : [
              {
                id: study.out.histogram.id,
                label: `${study.def.id} ${study.out.histogram.id}`,
                y: study.out.histogram.y,
              },
            ]),
      ];
      for (const column of columns) {
        const value = at === GAP ? Number.NaN : (column.y[at] ?? Number.NaN);
        out.push({
          studyId: study.def.id,
          id: column.id,
          label: column.label,
          text: render(value),
          value,
        });
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Spec resolution                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Rebuild the slot axis from the spec (§11.2).
   *
   * The union of every series' x, not the intersection: two securities with different holiday
   * calendars both draw every day either of them traded, and the one that did not trade has a gap
   * there. `TradingDayIndex` is where that is implemented and tested (`test/chart/scales.test.ts`);
   * §11.11 records intersection alignment as a server option, not a client one.
   */
  private buildSlotIndex(): void {
    this.index = TradingDayIndex.fromSpec(this.spec);
  }

  /** Every series rebased onto the slot index, with its own copy of every column it carries. */
  private resolveSeries(): void {
    this.resolved = [];
    this.bySeriesId = new Map<string, Resolved>();
    this.spec.series.forEach((series, paletteIndex) => {
      const n = Math.min(series.x.length, series.y.length);
      const slots: Column = { buf: new Float64Array(Math.max(n, 1)), used: n };
      for (let i = 0; i < n; i += 1) {
        // `GAP` (-1) is the index's word for "this point has no slot" (a non-finite x); `NaN` is the
        // engine's, and it is what every draw function already skips.
        const slot = this.index.slotOfPoint(series.id, i);
        slots.buf[i] = slot === GAP ? Number.NaN : slot;
      }
      const ys = column(series.y, n) ?? { buf: new Float64Array(1), used: 0 };
      const o = column(series.ohlc?.o, n);
      const h = column(series.ohlc?.h, n);
      const l = column(series.ohlc?.l, n);
      const c = column(series.ohlc?.c, n);
      const v = column(series.volume, n);
      const drawable: ChartSeries = {
        ...series,
        x: slots.buf.subarray(0, n),
        y: ys.buf.subarray(0, n),
      };
      const resolved: Resolved = {
        spec: series,
        drawable,
        slots,
        ys,
        o,
        h,
        l,
        c,
        v,
        frozenTs: Number.NaN,
        paletteIndex,
      };
      this.refreshViews(resolved);
      this.resolved.push(resolved);
      this.bySeriesId.set(series.id, resolved);
    });
  }

  /**
   * Re-point the drawable views at the live part of each column.
   *
   * `subarray` is a view, not a copy, so this is four object allocations and no data movement — the
   * price of letting a draw function trust `series.y.length` after an append (§11.5).
   */
  private refreshViews(series: Resolved): void {
    const n = series.slots.used;
    series.drawable.x = series.slots.buf.subarray(0, n);
    series.drawable.y = series.ys.buf.subarray(0, n);
    if (series.o !== undefined && series.h !== undefined && series.l !== undefined && series.c !== undefined) {
      series.drawable.ohlc = {
        o: series.o.buf.subarray(0, n),
        h: series.h.buf.subarray(0, n),
        l: series.l.buf.subarray(0, n),
        c: series.c.buf.subarray(0, n),
      };
    }
    if (series.v !== undefined) series.drawable.volume = series.v.buf.subarray(0, n);
  }

  /** A new timestamp at the right-hand end of the slot index (a forming bar's first appearance). */
  private appendSlot(t: number): number {
    const existing = this.index.slotOf(t);
    return existing === GAP ? this.index.append(t) : existing;
  }

  /**
   * Auto-follow (§11.5): a viewport whose right edge was the last slot keeps it.
   *
   * `streaming.ts#followOnAppend`, not a third copy of the rule — it is a pure function of the
   * viewport, the last slot before the append and how many slots were added, and this renderer has
   * all three. It also answers the fractional case this method used to get wrong: a view that reached
   * the right edge through a chain of zooms lands a hair short of the last slot, and rounding it to
   * the new slot would silently reset a trader's zoom on the next tick.
   */
  private followRightEdge(newSlot: number): void {
    this.view = followOnAppend(this.view, newSlot - 1, 1);
  }

  /** A streamed value outside the drawn range needs the axis rebuilt, which is a full redraw (§11.5). */
  private noteValue(series: Resolved, value: number): void {
    if (!Number.isFinite(value)) return;
    const axis = this.axes.get(series.spec.yAxis);
    if (axis === undefined) return;
    if (value < axis.lo || value > axis.hi) this.rangePending = true;
  }

  /** The clip for a streaming redraw: the last two slots of the plot, full height (§11.5). */
  private streamClip(): Rect {
    const panes = this.layout();
    const first = panes[0];
    if (first === undefined) return { x: 0, y: 0, w: this.width, h: this.height };
    const slotPx = this.slotPxOf(first.plot);
    const right = first.plot.x + first.plot.w;
    const w = Math.min(first.plot.w, slotPx * (STREAM_CLIP_SLOTS + 1));
    return { x: right - w, y: 0, w, h: this.height };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Studies (§11.6)                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  private computeStudies(): void {
    this.studies = [];
    this.skipped = [];
    const registry = this.plugins.studies;
    if (registry === undefined) return;
    for (const entry of this.spec.studies ?? []) {
      const def = registry[entry.id];
      const input = this.bySeriesId.get(entry.inputSeriesId);
      if (def === undefined || input === undefined) continue;
      // `needs`, before `compute` and not after (§11.6, `studies/needs.ts`). Twelve of the
      // twenty-two throw on a series with no bar or no volume, and they are right to: a line of
      // `NaN` reads as broken maths. But the throw came out of `setSpec`, so one `ATR` in a
      // persisted study list turned a govt or rate GP chart into a dead screen. A skipped study is
      // an empty pane, which is a visibly missing study; a thrown one is no chart at all.
      if (!studyNeedsMet(def, columnsOf(input))) {
        this.skipped.push({ id: entry.id, needs: def.needs });
        continue;
      }
      // `needs` covers a MISSING COLUMN. It does not cover bad values inside a column that is
      // present, and `ChartSeries.y` documents `NaN` as a legal gap — a series that did not trade on
      // a slot, which §11.2 makes ordinary the moment a second calendar is on the chart. Measured on
      // one 120-bar series with a single gap: `BB` and `STDDEV` throw a `RangeError` out of
      // `core/analytics/stats`, which validates its input and is right to. That throw arrives here,
      // inside `setSpec`, and takes the whole chart down — the same dead screen the `needs` guard
      // above was added to prevent, reached through a different door.
      //
      // So the call is guarded rather than the individual studies patched: a study is third-party
      // code as far as the renderer is concerned (`setPlugins` takes any registry), and ONE of them
      // failing must cost its own pane and nothing else. The failure is recorded, not swallowed —
      // `skippedStudies()` is what the picker and the studies list read, so a study that could not
      // be computed says so on screen instead of leaving an unexplained empty pane.
      let out;
      try {
        out = def.compute(this.studyInput(input), entry.params);
      } catch (err) {
        this.skipped.push({
          id: entry.id,
          needs: def.needs,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.studies.push({
        paneId: entry.pane,
        def,
        params: entry.params,
        input,
        out,
      });
    }
  }

  /**
   * A `StudyInput` over one resolved series (§11.6).
   *
   * `x` carries timestamps and not slots, because §11.6 says so and because `VWAP` has to see where a
   * session begins; the slot index is what turns one back into the other. The optional columns are
   * spread conditionally — with `exactOptionalPropertyTypes` an absent column is absent, and a study
   * that declared `needs: ['volume']` reads it, so handing it `undefined` under a present key would
   * be a crash rather than a skip.
   */
  private studyInput(series: Resolved): {
    x: Float64Array;
    close: Float64Array;
    open?: Float64Array;
    high?: Float64Array;
    low?: Float64Array;
    volume?: Float64Array;
  } {
    const n = series.slots.used;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const slot = series.slots.buf[i] ?? Number.NaN;
      x[i] = this.index.valueAt(slot);
    }
    return {
      x,
      close: series.ys.buf.subarray(0, n),
      ...(series.o === undefined ? {} : { open: series.o.buf.subarray(0, n) }),
      ...(series.h === undefined ? {} : { high: series.h.buf.subarray(0, n) }),
      ...(series.l === undefined ? {} : { low: series.l.buf.subarray(0, n) }),
      ...(series.v === undefined ? {} : { volume: series.v.buf.subarray(0, n) }),
    };
  }

  /**
   * The last slot's study values after a stream patch (§11.5, §11.6).
   *
   * `update()` when the study has one, a full `compute()` when it does not. The fallback is a whole
   * recompute rather than a partial one because a study without an incremental form has not told
   * anyone how many points its last value depends on, and guessing a window there would produce a
   * number that differs from the same study's own full recompute — which is the one thing a study
   * must never do.
   */
  private updateStudiesFor(series: Resolved): void {
    for (const study of this.studies) {
      if (study.input !== series) continue;
      const input = this.studyInput(series);
      study.out =
        study.def.update === undefined
          ? study.def.compute(input, study.params)
          : study.def.update(study.out, input, study.params, series.slots.used - 1);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Scales                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  private clampView(view: Viewport): Viewport {
    const last = Math.max(0, this.index.length - 1);
    const slot0 = Math.min(Math.max(0, view.slot0), last);
    const slot1 = Math.min(Math.max(slot0, view.slot1), last);
    return { slot0, slot1 };
  }

  private slotPxOf(plot: Rect): number {
    const span = Math.max(1, this.view.slot1 - this.view.slot0 + 1);
    return plot.w / span;
  }

  private slotAtPx(pane: PaneLayout, px: number): number {
    const slotPx = this.slotPxOf(pane.plot);
    return slotPx <= 0 ? this.view.slot0 : this.view.slot0 + (px - pane.plot.x) / slotPx - 0.5;
  }

  /** The slot whose timestamp is nearest `t` — how an event or an annotation anchor lands (§11.7). */
  private slotOfTs(t: number): number {
    return this.index.nearestSlot(t);
  }

  /**
   * The per-series normalisation of §11.2, **and its inverse**: `pct` and `base100` rebase on the
   * first *visible* point.
   *
   * Recomputed per frame rather than cached with the spec, because "first visible" changes on every
   * pan: that is what makes a normalised comparison chart mean "since the left edge of what I am
   * looking at" rather than "since whenever the payload happened to start".
   *
   * **A pair, not a function, and that is a fix rather than a refactor.** `y` normalised and
   * `valueAt` did not invert, so every pixel → value read was in the wrong unit the moment `N` was
   * pressed: an anchor placed on a `base100` GP chart persisted `111.17` into
   * `chart_annotations.anchors[].v` where the price was `330.18`, and because the base is the first
   * VISIBLE point it then drifted on every pan (five bars left moved the same anchor 1.98 %).
   * CHRT-05 says an annotation is anchored in DATA coordinates, so the inverse has to exist and has
   * to be applied — {@link SeriesScales.valueAt} is the engine's only published inverse and
   * `hitTest`, `M` and the draw-mode anchor placement all read through it.
   */
  private normaliserFor(series: Resolved, mode: 'none' | 'pct' | 'base100'): Normaliser {
    if (mode === 'none') return IDENTITY_NORM;
    const base = this.normaliseBaseOf(series);
    if (!Number.isFinite(base)) return IDENTITY_NORM;
    return mode === 'pct'
      ? { to: (v) => (v / base - 1) * 100, from: (u) => (u / 100 + 1) * base }
      : { to: (v) => (v / base) * 100, from: (u) => (u / 100) * base };
  }

  /** The first visible, finite, non-zero value of a series — §11.2's rebasing point. */
  private normaliseBaseOf(series: Resolved): number {
    for (let i = 0; i < series.slots.used; i += 1) {
      const slot = series.slots.buf[i] ?? Number.NaN;
      if (slot < this.view.slot0 || slot > this.view.slot1) continue;
      const v = series.ys.buf[i] ?? Number.NaN;
      if (Number.isFinite(v) && v !== 0) return v;
    }
    return Number.NaN;
  }

  private axisSpecOf(axisId: string): ChartSpec['yAxes'][number] | undefined {
    return this.spec.yAxes.find((a) => a.id === axisId);
  }

  /**
   * Which axis a study in this pane draws on (§11.6: "`main` studies draw on the price pane's axis").
   *
   * One method, asked by both the domain builder and the draw pass, because they disagreed: the
   * domain loop tested `axis.axisId === studyAxisId(pane.paneId)` — an id that exists only for a pane
   * with NO declared axis — while `drawStudies` fell back to the pane's first axis. So the nine
   * overlay studies were drawn on the price axis and excluded from it, and a Bollinger band that left
   * the visible price range was clipped away by the plot rect: on 1 255 daily bars at slots 600..660
   * the visible price ran to 191.86 while BB's upper reached 196.39, and the ±2σ the study exists to
   * show was simply not on screen.
   */
  private studyAxisOf(pane: PaneLayout): string {
    return pane.yAxes.some((a) => a.axisId === studyAxisId(pane.paneId))
      ? studyAxisId(pane.paneId)
      : (pane.yAxes[0]?.axisId ?? '');
  }

  /**
   * How a study pane's axis labels itself, from the study's own `yFmt` (§11.6).
   *
   * A sub pane's axis id is `<paneId>:y` and `ChartSpec.yAxes` has no entry for it, so `fmt` and
   * `decimals` were both `undefined` and every study pane printed two decimals of a price: `HVOL`
   * read `20.00` for 20 % annualised with nothing saying so, `VOL` read `300,000,000.00` share
   * counts, `RSI` read `39.90` where the indicator is an integer-scaled oscillator. All twenty-two
   * studies declare `yFmt` and §11.6 documents it as "how the pane's axis labels its values"; this is
   * the reader it never had.
   */
  private studyAxisFormat(pane: PaneLayout): StudyFormat | undefined {
    for (const study of this.studies) {
      if (study.paneId !== pane.paneId) continue;
      return studyValueFormat(study.def);
    }
    return undefined;
  }

  /** Every axis this frame draws, with the domain its own series (or study) imply. */
  private buildAxes(panes: readonly PaneLayout[]): void {
    this.axes = new Map<string, AxisRender>();
    for (const pane of panes) {
      for (const axis of pane.yAxes) {
        if (this.axes.has(axis.axisId)) continue;
        const spec = this.axisSpecOf(axis.axisId);
        const mode = spec?.normalise ?? 'none';
        // The AXIS's own normaliser: the first series on it. `normalise` is a property of the axis
        // (§11.2) while a rebasing is a property of a series, and everything drawn on the axis that
        // is not a series — a `reference[]` rule, an annotation anchor, a pixel → value read — needs
        // one agreed unit. Without it `reference` was noted RAW into a normalised domain: GP's prev
        // close of 330 widened a pct axis to 0…334 for a series spanning 0…2.4, and the default
        // two-security comparison chart — the entire purpose of CHRT-03 normalisation — drew both
        // securities as flat lines on the axis floor.
        const anchor = this.resolved.find((s) => s.spec.yAxis === axis.axisId);
        const axisNorm = anchor === undefined ? IDENTITY_NORM : this.normaliserFor(anchor, mode);

        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        const note = (v: number): void => {
          if (!Number.isFinite(v)) return;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        };
        for (const series of this.resolved) {
          if (series.spec.pane !== pane.paneId || series.spec.yAxis !== axis.axisId) continue;
          const norm = this.normaliserFor(series, mode);
          // A bar grows from the baseline, so zero is part of its domain whether the data reaches it
          // or not: volume bars drawn from a floor of the smallest visible volume would all look the
          // same height (§11.3 `bar`).
          if (series.spec.type === 'bar') note(0);
          // Over the same columns the draw will use — reduced when §11.4 says so, whole otherwise —
          // and the domain is IDENTICAL either way, which is what makes this legitimate rather than
          // an approximation: M4 keeps the minimum and the maximum of every pixel column, and the bar
          // reduction keeps each column's highest high and lowest low. A scan of the full million
          // points cost 170 ms of every frame and produced the same two numbers.
          const columns = this.reduced(series, this.view, pane.plot.w);
          const ohlc = columns.ohlc;
          const n = Math.min(columns.x.length, columns.y.length);
          for (let i = 0; i < n; i += 1) {
            const slot = columns.x[i] ?? Number.NaN;
            if (slot < this.view.slot0 || slot > this.view.slot1) continue;
            note(norm.to(columns.y[i] ?? Number.NaN));
            if (ohlc !== undefined) {
              note(norm.to(ohlc.h[i] ?? Number.NaN));
              note(norm.to(ohlc.l[i] ?? Number.NaN));
            }
          }
        }
        for (const study of this.studies) {
          if (study.paneId !== pane.paneId || this.studyAxisOf(pane) !== axis.axisId) continue;
          // **In the viewport, exactly as the series loop is.** This loop had no view filter, so
          // every sub-pane axis was frozen at the whole series' extremes and labelled numbers that
          // were not on screen: an ATR(14) pane over ten years read `4 6 8 10` at every zoom while
          // the visible ATR was 2.82..3.74 — the study occupied 9 % of its own pane and sat below
          // the lowest label. The price pane retracked correctly over the same pans, which is how
          // the asymmetry was visible.
          const sNorm = this.normaliserFor(study.input, mode);
          const slots = study.input.slots;
          for (let i = 0; i < slots.used; i += 1) {
            const slot = slots.buf[i] ?? Number.NaN;
            if (slot < this.view.slot0 || slot > this.view.slot1) continue;
            for (const line of study.out.lines) note(sNorm.to(line.y[i] ?? Number.NaN));
            const histogram = study.out.histogram;
            if (histogram !== undefined) note(sNorm.to(histogram.y[i] ?? Number.NaN));
          }
          // `levels` are unconditional: 30/70, ±100 and 0 are the pane's printed reference lines, so
          // they are on screen whether or not the indicator reached them this viewport.
          for (const v of study.out.levels ?? []) note(sNorm.to(v));
        }
        for (const ref of this.spec.reference ?? []) {
          if (ref.yAxis === axis.axisId) note(axisNorm.to(ref.v));
        }
        const override =
          axis.axisId === studyAxisId(pane.paneId) ? this.studyAxisFormat(pane) : undefined;
        this.axes.set(axis.axisId, this.padded(axis.axisId, lo, hi, spec, axisNorm, override));
      }
    }
  }

  private padded(
    axisId: string,
    lo: number,
    hi: number,
    spec: ChartSpec['yAxes'][number] | undefined,
    norm: Normaliser,
    override: { fmt: ChartSpec['yAxes'][number]['fmt']; decimals: number } | undefined,
  ): AxisRender {
    let low = lo;
    let high = hi;
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      low = 0;
      high = 1;
    } else if (high === low) {
      // A flat series is not a bug and must still be visible: a one-unit band around it puts the line
      // in the middle of the pane instead of dividing by a zero span.
      low -= 0.5;
      high += 0.5;
    } else {
      const pad = (high - low) * DOMAIN_PAD;
      low -= pad;
      high += pad;
    }
    const scale = spec?.scale === 'log' ? 'log' : 'linear';
    // A log axis cannot show zero or a negative, and a spec may still ask for one (a spread series
    // that crossed zero). Falling back to linear draws the data; refusing would draw nothing.
    const usable = scale === 'log' && low > 0 ? 'log' : 'linear';
    return {
      axisId,
      lo: low,
      hi: high,
      scale: usable,
      fmt: override?.fmt ?? spec?.fmt,
      decimals: override?.decimals ?? spec?.decimals,
      norm,
    };
  }

  /** The scales one series draws through, for one pane, for this frame (`SeriesScales`). */
  private scalesFor(pane: PaneLayout, series: Resolved | null, axis: AxisRender): SeriesScales {
    const plot = pane.plot;
    const slotPx = this.slotPxOf(plot);
    const spec = this.axisSpecOf(axis.axisId);
    // A series is placed by its OWN rebasing (two securities on one pct axis both start at zero,
    // which is what a comparison chart is); everything else on the axis — the reference rules, the
    // annotations, the crosshair's pixel → value — is placed by the axis's one base.
    const norm = series === null ? axis.norm : this.normaliserFor(series, spec?.normalise ?? 'none');
    const toUnit =
      axis.scale === 'log'
        ? (v: number) => {
            const lo = Math.log10(axis.lo);
            const hi = Math.log10(axis.hi);
            return (Math.log10(v) - lo) / (hi - lo || 1);
          }
        : (v: number) => (v - axis.lo) / (axis.hi - axis.lo || 1);
    const fromUnit =
      axis.scale === 'log'
        ? (u: number) => 10 ** (Math.log10(axis.lo) + u * (Math.log10(axis.hi) - Math.log10(axis.lo)))
        : (u: number) => axis.lo + u * (axis.hi - axis.lo);
    // `yUnit` takes a value that is ALREADY in the axis's own units and `y` takes one in the series'
    // data coordinates. The two are the same function only while `normalise` is `none`, and keeping
    // them apart is what lets an axis tick (a number read off the domain) and a price (a number read
    // off the payload) both land in the right place.
    const yUnit = (v: number): number => plot.y + plot.h * (1 - toUnit(v));
    const y = (value: number): number => yUnit(norm.to(value));
    const decimals = axis.decimals ?? 2;
    const zeroInside = axis.lo <= 0 && axis.hi >= 0 && axis.scale === 'linear';
    return {
      plot,
      x: (slot: number) => plot.x + (slot - this.view.slot0 + 0.5) * slotPx,
      y,
      yUnit,
      slotAt: (px: number) => this.slotAtPx(pane, px),
      valueAt: (py: number) => norm.from(fromUnit(1 - (py - plot.y) / (plot.h || 1))),
      slotPx,
      baselinePx: zeroInside ? yUnit(0) : plot.y + plot.h,
      tick: 10 ** -decimals,
      hairline: 1 / this.dpr,
      paint: this.paintFor(series),
      fonts: this.fonts,
    };
  }

  /** `style.color` resolved once per series per frame (`SeriesPaint`, §11.3, §12.2). */
  private paintFor(series: Resolved | null): SeriesPaint {
    const colour = this.theme.colour;
    const requested = series?.spec.style?.color ?? 'auto';
    const line =
      requested === 'auto'
        ? colour[seriesToken(series?.paletteIndex ?? 0)]
        : requested === 'up'
          ? colour['--c-up']
          : requested === 'down'
            ? colour['--c-down']
            : requested === 'neutral'
              ? colour['--c-flat']
              : requested;
    return {
      line,
      fill: withAlpha(line, 0.18),
      fillTo: withAlpha(line, 0),
      up: colour['--c-up'],
      down: colour['--c-down'],
      neutral: colour['--c-flat'],
      muted: colour['--c-muted'],
      // Light theme draws up candles hollow (§11.3) — a decision about the theme, taken once here so
      // that no draw function has to ask the document which theme is current.
      hollowUp: this.theme.name === 'light',
      ramp: (t: number) => mix(colour['--c-bg-panel'], line, t),
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The base canvas                                                                            */
  /* ---------------------------------------------------------------------------------------- */

  private drawBase(clip?: Rect): void {
    const ctx = this.baseCtx;
    if (ctx === null) return;
    const panes = this.layout();
    this.panes = panes;
    this.buildAxes(panes);
    this.rebuildLegends(panes);

    // The streaming redraw narrows the *view handed to the draw functions* as well as clipping the
    // context, and those are two different savings. The clip stops pixels landing outside the last
    // slots; the narrowed view stops the work — a draw function bounded to three slots issues three
    // path segments instead of one per bar of a ten-year series. A clip alone would produce the same
    // picture at the same cost, which is §11.5's budget (append < 2 ms) missed while looking correct,
    // and `test/chart/renderer.test.ts` counts path operations rather than pixels for exactly that
    // reason. What is skipped with it — the axis gutters, the x strip, the pane titles and the legend —
    // is skipped because all of it lies outside a right-edge clip by construction, so drawing it would
    // be work with no output. The gridlines, the reference lines and the event band are NOT skipped:
    // they cross the clip, and the background repaint below has just erased them there.
    const streaming = clip !== undefined;
    const view: Viewport = streaming
      ? {
          slot0: Math.max(this.view.slot0, this.view.slot1 - STREAM_CLIP_SLOTS),
          slot1: this.view.slot1,
        }
      : this.view;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    if (clip !== undefined) {
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
      ctx.fillStyle = this.theme.colour['--c-bg'];
      ctx.fillRect(clip.x, clip.y, clip.w, clip.h);
    } else {
      fillBackground(ctx, this.width, this.height, this.theme);
    }

    for (const pane of panes) {
      if (!streaming) drawPaneTitle(ctx, pane, this.theme, this.fonts);
      if (pane.collapsed || pane.plot.w <= 0 || pane.plot.h <= 0) continue;
      const first = this.firstAxisOf(pane);
      const yTicks = first === undefined ? [] : this.yTicksOf(pane, first);
      const xTicks = streaming ? [] : this.xTicksOf(pane);
      drawGridlines(
        ctx,
        pane.plot,
        xTicks.map((t) => t.px),
        yTicks.map((t) => t.py),
        this.theme,
        1 / this.dpr,
      );
      if (!streaming) {
        for (const axis of pane.yAxes) {
          const render = this.axes.get(axis.axisId);
          if (render === undefined) continue;
          drawYAxis(ctx, axis, pane.plot, this.yTicksOf(pane, render), this.theme, this.fonts);
        }
        const strip = pane.xAxis;
        if (strip !== undefined) drawXAxis(ctx, strip, xTicks, this.theme, this.fonts);
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(pane.plot.x, pane.plot.y, pane.plot.w, pane.plot.h);
      ctx.clip();
      this.drawReference(ctx, pane);
      for (const series of this.resolved) {
        if (series.spec.pane !== pane.paneId) continue;
        const axis = this.axisRenderFor(pane, series);
        if (axis === undefined) continue;
        const scales = this.scalesFor(pane, series, axis);
        const drawable = this.reduced(series, view, pane.plot.w);
        SERIES_DRAWS[series.spec.type](ctx, scales, view, drawable);
      }
      this.drawStudies(ctx, pane, view);
      ctx.restore();

      this.drawEvents(ctx, pane);
      const annotations = this.spec.annotations ?? [];
      const painter = this.plugins.annotations;
      if (painter !== undefined && annotations.length > 0 && first !== undefined) {
        const scales = this.scalesFor(pane, null, first);
        painter(
          ctx,
          pane,
          { xOfTs: (t) => scales.x(this.slotOfTs(t)), yOfValue: (v) => scales.y(v) },
          annotations,
          this.selectedAnnotation,
        );
      }
      const legend = this.legends.get(pane.paneId);
      if (legend !== undefined && !streaming) {
        drawLegend(ctx, legend.rects, legend.entries, this.theme, this.fonts);
      }
    }
    ctx.restore();
  }

  private firstAxisOf(pane: PaneLayout): AxisRender | undefined {
    const first = pane.yAxes[0];
    return first === undefined ? undefined : this.axes.get(first.axisId);
  }

  private axisRenderFor(pane: PaneLayout, series: Resolved): AxisRender | undefined {
    return this.axes.get(series.spec.yAxis) ?? this.firstAxisOf(pane);
  }

  private yTicksOf(pane: PaneLayout, axis: AxisRender): YTick[] {
    const scales = this.scalesFor(pane, null, axis);
    const values =
      axis.scale === 'log' ? logDecadeTicks(axis.lo, axis.hi) : niceTicks(axis.lo, axis.hi);
    // `yUnit`, not `y`: a tick is a number read off `axis.lo..axis.hi`, which is already in the
    // axis's normalised units, and running it through the axis normaliser again would place a
    // `base100` axis's own labels somewhere else on the axis.
    return values.map((v) => ({
      v,
      py: scales.yUnit(v),
      label: axisLabel(axis.fmt, v, axis.decimals),
    }));
  }

  /**
   * The x ticks: evenly spaced slots, thinned so the labels cannot touch (§11.2).
   *
   * The label itself comes from `layers.ts#xLabeller`, which is where the four axis kinds are decided
   * for every reader at once — this strip, the canvas readout and the DOM readout. It used to be
   * decided here and the two readouts each guessed separately, which is how a curve chart came to
   * announce `1970-01-01` at every node.
   */
  private xTicksOf(pane: PaneLayout): XTick[] {
    const n = this.index.length;
    if (n === 0 || pane.plot.w <= 0) return [];
    const scales = this.scalesFor(pane, null, this.firstAxisOf(pane) ?? FALLBACK_AXIS);
    const label = (slot: number): string => this.xTickLabel(slot, this.index.valueAt(slot));
    const sample = label(Math.floor((this.view.slot0 + this.view.slot1) / 2));
    const stride = xTickStride(this.slotPxOf(pane.plot), sample.length, this.fonts);
    const ticks: XTick[] = [];
    const from = Math.ceil(this.view.slot0);
    for (let slot = from; slot <= this.view.slot1 && slot < n; slot += stride) {
      ticks.push({ slot, px: scales.x(slot), label: label(slot) });
    }
    return ticks;
  }

  /** `reference[]`: prev close, par rate, strike — a dashed rule with its label (§1.5, CHRT-03). */
  private drawReference(ctx: CanvasRenderingContext2D, pane: PaneLayout): void {
    const refs = this.spec.reference ?? [];
    if (refs.length === 0) return;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1 / this.dpr;
    ctx.strokeStyle = this.theme.colour['--c-muted'];
    ctx.fillStyle = this.theme.colour['--c-muted'];
    ctx.font = this.fonts.label;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    for (const ref of refs) {
      const axis = this.axes.get(ref.yAxis);
      if (axis === undefined) continue;
      if (!pane.yAxes.some((a) => a.axisId === ref.yAxis)) continue;
      const y = this.scalesFor(pane, null, axis).y(ref.v);
      if (!Number.isFinite(y)) continue;
      ctx.beginPath();
      ctx.moveTo(pane.plot.x, Math.round(y) + 0.5);
      ctx.lineTo(pane.plot.x + pane.plot.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(ref.label, pane.plot.x + 3, y - 1);
    }
    ctx.restore();
  }

  /**
   * The columns one series is drawn from this frame: reduced to one mark per pixel column, or whole
   * (§11.4, CHRT-02).
   *
   * Reduction runs only above §11.4's threshold (`visible points > 2 × plot width`), because below it
   * four points per column is more points than the column had. Which reduction depends on the mark:
   * M4 for the polylines, the min/max/first/last range candle for `candle`/`ohlc`, the capped column
   * for `scatter`.
   *
   * Five types are deliberately NOT reduced, and the reason is the same for each: the reduction
   * publishes a slot column and a value column, and these five read a column it does not publish.
   * `bar` and `tick` colour and size their marks from `volume`; `pnf`, `profile` and `heatmap` build
   * their own axes out of the raw series (P&F columns, 30-minute TPO periods, category cells), so
   * reducing the input would change what the picture MEANS rather than how much of it is drawn. A
   * volume-carrying reduction is the way to close the first two and it belongs in `downsample.ts`.
   */
  private reduced(series: Resolved, view: Viewport, widthPx: number): ChartSeries {
    const type = series.spec.type;
    if (widthPx <= 0) return series.drawable;
    // The visible-point count as an upper bound — the viewport's span, capped by the series' length —
    // and not a scan for the exact figure. A scan is O(points) and would cost, per series per frame,
    // the very walk over a million points that this reduction exists to avoid. The bound is only
    // loose for a series that is sparse inside the viewport, and there the answer is a reduction that
    // was not strictly needed rather than a wrong picture.
    const visible = Math.min(series.slots.used, Math.floor(view.slot1 - view.slot0) + 1);
    if (!shouldReduce(visible, widthPx)) return series.drawable;
    const req: ReduceRequest = { seriesId: series.spec.id, index: this.index, view, width: widthPx };
    // §11.4's trigger says when a reduction is ALLOWED (more than two points a pixel); `worthReducing`
    // says when it pays for itself. Each reduction has its own yield per pixel column — M4 up to four
    // points, the bar reduction one range candle, the capped column eight — and a pass that hands back
    // most of what it was given has still walked every visible slot and allocated a buffer per series
    // per frame. It is not hypothetical, and it is not free: 2 510 daily bars in a 1 240 px plot is 2.02
    // points per pixel, a whisker over the trigger, where M4 returns 2 496 of the 2 510 and the bar
    // reduction halves 2 510 candles nobody was waiting for. Measured over the acceptance row's own
    // pan-and-zoom sweep, reducing there left the p95 unchanged and spiked the last round to 7.6 ms
    // through garbage collection alone; declining it holds every round at 3.0-3.3 ms.
    const columns = Math.max(1, Math.floor(widthPx));

    if (type === 'candle' || type === 'ohlc') {
      if (!worthReducing(visible, columns, BARS_PER_COLUMN)) return series.drawable;
      const ohlc = series.drawable.ohlc;
      if (ohlc === undefined) return series.drawable;
      const bars = this.reducer.bars(req, ohlc);
      return dropColumns(series.drawable, bars.slot, bars.c, {
        o: bars.o,
        h: bars.h,
        l: bars.l,
        c: bars.c,
      });
    }
    if (type === 'scatter') {
      if (!worthReducing(visible, columns, SCATTER_COLUMN_CAP)) return series.drawable;
      const capped = this.reducer.capColumns(req, series.drawable.y);
      return dropColumns(series.drawable, capped.slot, capped.y, undefined);
    }
    if (type === 'line' || type === 'area' || type === 'mountain' || type === 'step') {
      if (!worthReducing(visible, columns, M4_POINTS_PER_COLUMN)) return series.drawable;
      const points = this.reducer.m4(req, series.drawable.y);
      return dropColumns(series.drawable, points.slot, points.y, undefined);
    }
    return series.drawable;
  }

  /** Study lines, bands, histograms and levels in one pane (§11.6). */
  private drawStudies(ctx: CanvasRenderingContext2D, pane: PaneLayout, view: Viewport): void {
    for (const study of this.studies) {
      if (study.paneId !== pane.paneId) continue;
      const axis = this.axes.get(this.studyAxisOf(pane));
      if (axis === undefined) continue;
      // Scaled through the study's INPUT SERIES, not through `null`. A study's values are in its
      // input's data coordinates — an SMA is a price — so on a normalised price axis an overlay
      // placed with the identity mapping lands off the pane entirely (an SMA at 330 on an axis
      // running 0…2.4). It is the same rebasing the series itself is drawn with, so the overlay and
      // the line it averages cannot come apart.
      const scales = this.scalesFor(pane, study.input, axis);
      const slots = study.input.slots;
      const lineOf = (id: string): Float64Array | undefined =>
        study.out.lines.find((l) => l.id === id)?.y;

      for (const band of study.out.bands ?? []) {
        const upper = lineOf(band.upper);
        const lower = lineOf(band.lower);
        if (upper === undefined || lower === undefined) continue;
        ctx.save();
        ctx.fillStyle = withAlpha(this.theme.colour[seriesToken(study.input.paletteIndex)], band.alpha);
        ctx.beginPath();
        let open = false;
        for (let i = 0; i < slots.used; i += 1) {
          const v = upper[i] ?? Number.NaN;
          if (!Number.isFinite(v)) continue;
          const px = scales.x(slots.buf[i] ?? Number.NaN);
          if (open) ctx.lineTo(px, scales.y(v));
          else {
            ctx.moveTo(px, scales.y(v));
            open = true;
          }
        }
        for (let i = slots.used - 1; i >= 0; i -= 1) {
          const v = lower[i] ?? Number.NaN;
          if (!Number.isFinite(v)) continue;
          ctx.lineTo(scales.x(slots.buf[i] ?? Number.NaN), scales.y(v));
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      const histogram = study.out.histogram;
      if (histogram !== undefined) {
        ctx.save();
        const w = Math.max(1, scales.slotPx * 0.7);
        for (let i = 0; i < slots.used; i += 1) {
          const v = histogram.y[i] ?? Number.NaN;
          if (!Number.isFinite(v) || !inView(slots.buf[i], view)) continue;
          const px = scales.x(slots.buf[i] ?? Number.NaN);
          const py = scales.y(v);
          ctx.fillStyle = v >= 0 ? this.theme.colour['--c-up'] : this.theme.colour['--c-down'];
          ctx.fillRect(px - w / 2, Math.min(py, scales.baselinePx), w, Math.max(1, Math.abs(scales.baselinePx - py)));
        }
        ctx.restore();
      }

      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = this.theme.colour['--c-grid-line'];
      ctx.lineWidth = 1 / this.dpr;
      ctx.beginPath();
      for (const level of study.out.levels ?? []) {
        const py = Math.round(scales.y(level)) + 0.5;
        ctx.moveTo(pane.plot.x, py);
        ctx.lineTo(pane.plot.x + pane.plot.w, py);
      }
      ctx.stroke();
      ctx.restore();

      study.out.lines.forEach((line, index) => {
        ctx.save();
        const requested = line.style.color;
        ctx.strokeStyle =
          requested === 'auto'
            ? this.theme.colour[seriesToken(study.input.paletteIndex + index + 1)]
            : requested === 'up'
              ? this.theme.colour['--c-up']
              : requested === 'down'
                ? this.theme.colour['--c-down']
                : requested === 'neutral'
                  ? this.theme.colour['--c-flat']
                  : requested;
        ctx.lineWidth = line.style.width ?? Math.max(1 / this.dpr, 1);
        ctx.setLineDash(line.style.dashed === true ? [3, 3] : []);
        ctx.beginPath();
        let open = false;
        for (let i = 0; i < slots.used; i += 1) {
          const v = line.y[i] ?? Number.NaN;
          if (!Number.isFinite(v) || !inView(slots.buf[i], view)) {
            open = false;
            continue;
          }
          const px = scales.x(slots.buf[i] ?? Number.NaN);
          const py = scales.y(v);
          if (open) ctx.lineTo(px, py);
          else {
            ctx.moveTo(px, py);
            open = true;
          }
        }
        ctx.stroke();
        ctx.restore();
      });
    }
  }

  /** CHRT-06's marker band: one glyph per event at its slot, stacked when several share one (§11.7). */
  private drawEvents(ctx: CanvasRenderingContext2D, pane: PaneLayout): void {
    const band = pane.eventBand;
    const events = this.spec.events ?? [];
    if (band === undefined || events.length === 0) return;
    const scales = this.scalesFor(pane, null, this.firstAxisOf(pane) ?? FALLBACK_AXIS);
    const perSlot = new Map<number, number>();
    ctx.save();
    ctx.font = this.fonts.label;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    events.forEach((event, index) => {
      const slot = this.slotOfTs(event.t);
      if (slot < this.view.slot0 || slot > this.view.slot1) return;
      const stacked = perSlot.get(slot) ?? 0;
      perSlot.set(slot, stacked + 1);
      const x = scales.x(slot) + stacked * this.fonts.digitPx;
      const focused = this.focus.kind === 'event' && this.focus.index === index;
      ctx.fillStyle = focused ? this.theme.colour['--c-focus'] : this.theme.colour['--c-label'];
      ctx.fillText(EVENT_GLYPH[event.kind], x, band.y + band.h / 2);
    });
    ctx.restore();
  }

  private rebuildLegends(panes: readonly PaneLayout[]): void {
    this.legends = new Map<string, { entries: LegendEntry[]; rects: Rect[] }>();
    for (const pane of panes) {
      if (pane.collapsed) continue;
      const entries: LegendEntry[] = this.resolved
        .filter((s) => s.spec.pane === pane.paneId)
        .map((s) => ({
          seriesId: s.spec.id,
          label: s.spec.label,
          colour: this.paintFor(s).line,
        }));
      if (entries.length === 0) continue;
      this.legends.set(pane.paneId, { entries, rects: legendRects(pane, entries, this.fonts) });
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* The overlay canvas                                                                         */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Crosshair, readout, focus ring and draw-mode preview (§11.1, §11.9).
   *
   * Cleared and redrawn whole every interaction frame, which is cheap because it is a handful of lines
   * and one text block — and is the reason the base does not have to be touched when the crosshair
   * moves. The crosshair spans every pane: the panes share one x-scale and one viewport (§11.6), so a
   * vertical rule that stopped at the price pane would break the link a trader reads them with.
   */
  private drawOverlay(): void {
    const ctx = this.overlayCtx;
    if (ctx === null) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const panes = this.panes.length > 0 ? this.panes : this.layout();
    if (this.axes.size === 0) this.buildAxes(panes);

    if (this.crosshair !== null) {
      const slot = this.crosshair.slot;
      const host = panes.find((p) => !p.collapsed && p.plot.h > 0);
      if (host !== undefined && slot >= this.view.slot0 && slot <= this.view.slot1) {
        const x = Math.round(this.scalesFor(host, null, this.firstAxisOf(host) ?? FALLBACK_AXIS).x(slot)) + 0.5;
        ctx.save();
        ctx.strokeStyle = this.theme.colour['--c-crosshair'];
        ctx.lineWidth = 1 / this.dpr;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (const pane of panes) {
          if (pane.collapsed || pane.plot.h <= 0) continue;
          ctx.moveTo(x, pane.plot.y);
          ctx.lineTo(x, pane.plot.y + pane.plot.h);
        }
        const series = this.bySeriesId.get(this.crosshair.seriesId);
        const pane = series === undefined ? undefined : panes.find((p) => p.paneId === series.spec.pane);
        if (series !== undefined && pane !== undefined) {
          const axis = this.axisRenderFor(pane, series);
          const value = this.valueOfSeriesAtSlot(series.spec.id, slot);
          if (axis !== undefined && Number.isFinite(value)) {
            const y = Math.round(this.scalesFor(pane, series, axis).y(value)) + 0.5;
            ctx.moveTo(pane.plot.x, y);
            ctx.lineTo(pane.plot.x + pane.plot.w, y);
          }
        }
        ctx.stroke();
        ctx.restore();
        this.drawReadout(ctx, host, slot);
      }
    }

    this.drawFocusRing(ctx, panes);

    if (this.drawMode !== null) {
      ctx.save();
      ctx.font = this.fonts.label;
      ctx.fillStyle = this.theme.colour['--c-focus'];
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(`DRAW ${this.drawMode.toUpperCase()}`, 4, 2);
      ctx.restore();
    }
  }

  /**
   * The readout: every series' AND every study's value at the crosshair slot (§11.9).
   *
   * Values, not a tooltip on the nearest point: `ArrowLeft/Right` moves the crosshair a slot at a
   * time and the readout is how a trader reads a level off the chart, so every series has to answer at
   * that slot — including the ones with a gap there, which say so with the blank glyph the formatter
   * already uses for a missing value.
   *
   * §11.9's first row says "every series/**study** value at the slot", and the studies were missing:
   * a chart whose whole purpose was an RSI sub pane could not be made to say what the RSI was. Both
   * canvases are `aria-hidden` and the DOM study list carried the id with no value, so thirteen
   * sub-pane studies existed only as pixels — the WP-12 defect shape, a value visible only where
   * nothing reads it. {@link studyRowsAt} is shared with `ChartCanvas`'s DOM readout so the two
   * cannot say different things.
   *
   * **Gap (§11.9, stated):** the rows are drawn in one colour, where §11.9 asks for each value "with
   * its `st` colour". A `ValueState` is a property of a live SUBJECT, and this renderer is never handed
   * one — `streaming.ts` carries the verdict to `ChartCanvas`, which writes it onto the DOM legend as
   * `data-st` (§12.1). Colouring a row here would mean the renderer keeping a second copy of the
   * staleness state, which is the duplication that produced the defect §12.1 exists to prevent; the
   * honest fix is a `setValueStates` on this class, and it is recorded rather than guessed at.
   */
  private drawReadout(ctx: CanvasRenderingContext2D, pane: PaneLayout, slot: number): void {
    const rows: string[] = [];
    const whole = Math.round(slot);
    const ts = this.index.valueAt(whole);
    if (Number.isFinite(ts)) rows.push(this.xLabel(whole, ts));
    for (const series of this.resolved) {
      const axis = this.axes.get(series.spec.yAxis);
      const value = this.valueOfSeriesAtSlot(series.spec.id, whole);
      rows.push(`${series.spec.label} ${axisLabel(axis?.fmt, value, axis?.decimals)}`);
    }
    for (const row of this.studyRowsAt(whole)) rows.push(`${row.label} ${row.text}`);
    if (rows.length === 0) return;
    const widest = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const w = Math.round((widest + 1) * this.fonts.digitPx);
    const h = Math.round(rows.length * this.fonts.lineHeightPx + 4);
    const x = Math.min(pane.plot.x + pane.plot.w - w - 2, pane.plot.x + pane.plot.w / 2 + 8);
    const y = pane.plot.y + 2;
    ctx.save();
    ctx.fillStyle = withAlpha(this.theme.colour['--c-bg-panel'], 0.9);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = this.theme.colour['--c-grid-line'];
    ctx.lineWidth = 1 / this.dpr;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, w, h);
    ctx.font = this.fonts.readout;
    ctx.fillStyle = this.theme.colour['--c-value'];
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    rows.forEach((row, i) => {
      ctx.fillText(row, x + 2, y + 2 + i * this.fonts.lineHeightPx);
    });
    ctx.restore();
  }

  /** The focus ring — the only thing on the canvas that says where the keyboard is (TERM-06). */
  private drawFocusRing(ctx: CanvasRenderingContext2D, panes: readonly PaneLayout[]): void {
    const focus = this.focus;
    let rect: Rect | undefined;
    if (focus.kind === 'pane') {
      rect = panes.find((p) => p.paneId === focus.paneId)?.rect;
    } else if (focus.kind === 'legend') {
      for (const pane of panes) {
        const legend = this.legends.get(pane.paneId);
        if (legend === undefined) continue;
        const index = legend.entries.findIndex((e) => e.seriesId === focus.seriesId);
        if (index >= 0) {
          rect = legend.rects[index];
          break;
        }
      }
    }
    if (rect === undefined) return;
    ctx.save();
    ctx.strokeStyle = this.theme.colour['--c-focus'];
    ctx.lineWidth = Math.max(1, 1 / this.dpr);
    ctx.setLineDash([]);
    ctx.strokeRect(Math.round(rect.x) + 0.5, Math.round(rect.y) + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
    ctx.restore();
  }

  private focusSeriesId(): string | null {
    return this.focus.kind === 'legend' ? this.focus.seriesId : (this.crosshair?.seriesId ?? null);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Hit-test helpers                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  private nearestSeries(pane: PaneLayout, px: number, py: number): Resolved | null {
    const slot = Math.round(this.slotAtPx(pane, px));
    let best: Resolved | null = null;
    let bestDy = Number.POSITIVE_INFINITY;
    for (const series of this.resolved) {
      if (series.spec.pane !== pane.paneId) continue;
      const axis = this.axisRenderFor(pane, series);
      if (axis === undefined) continue;
      const value = this.valueOfSeriesAtSlot(series.spec.id, slot);
      if (!Number.isFinite(value)) continue;
      const dy = Math.abs(this.scalesFor(pane, series, axis).y(value) - py);
      if (dy < bestDy) {
        bestDy = dy;
        best = series;
      }
    }
    return best;
  }

  private valueAt(pane: PaneLayout, axis: AxisRender, py: number, series: Resolved | null): number {
    return this.scalesFor(pane, series, axis).valueAt(py);
  }

  /** How close to an anchor a pointer counts as grabbing it, in CSS px (§11.8 `M` moves an anchor). */
  private static readonly ANCHOR_GRAB_PX = 5;

  private annotationAt(pane: PaneLayout, px: number, py: number): Hit | null {
    const annotations = this.spec.annotations ?? [];
    if (annotations.length === 0) return null;
    const axis = this.firstAxisOf(pane);
    if (axis === undefined) return null;
    const scales = this.scalesFor(pane, null, axis);
    for (let index = 0; index < annotations.length; index += 1) {
      const anchors = annotations[index]?.anchors ?? [];
      for (let a = 0; a < anchors.length; a += 1) {
        const anchor = anchors[a];
        if (anchor === undefined) continue;
        const ax = scales.x(this.slotOfTs(anchor.t));
        const ay = scales.y(anchor.v);
        if (Math.hypot(ax - px, ay - py) <= Renderer.ANCHOR_GRAB_PX) {
          return { kind: 'annotation', index, anchor: a };
        }
      }
    }
    return null;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Small helpers                                                                                  */
/* -------------------------------------------------------------------------------------------- */

const identity = (v: number): number => v;

/**
 * One series' spec with REDUCED columns and the unreduced ones removed (§11.4).
 *
 * The removal is the point. A reduced `x` holds one slot per pixel column while `volume` would still
 * hold one element per bar, and a draw function that read both by the same index would colour a mark
 * from another day's volume — a wrong number rather than a coarse picture. So the columns that were
 * not reduced are dropped, and a draw function that needs one is a draw function this reduction is
 * not offered to (see `Renderer.reduced`).
 */
function dropColumns(
  from: ChartSeries,
  x: Float64Array,
  y: Float64Array,
  ohlc: { o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array } | undefined,
): ChartSeries {
  const out: ChartSeries = { ...from, x, y };
  delete out.ohlc;
  delete out.volume;
  if (ohlc !== undefined) out.ohlc = ohlc;
  return out;
}

/**
 * One study output column at one slot, formatted — what both readouts print (§11.6, §11.9).
 *
 * `studyId` as well as the line's own `id`, because the DOM list groups by study while the readout
 * lists every line: MACD is one entry in the list and three rows in the readout.
 */
export interface StudyRow {
  readonly studyId: string;
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly value: number;
}

/** A `fmt`/`decimals` pair, as a study's `yFmt` resolves to one (§11.6). */
interface StudyFormat {
  readonly fmt: ChartSpec['yAxes'][number]['fmt'];
  readonly decimals: number;
}

/**
 * `StudyDef.yFmt` as the one formatter's arguments (§11.6).
 *
 * `undefined` means "the price axis' own rendering", which is what `yFmt: 'px'` asks for and what an
 * absent `yFmt` means — a moving average is a price and is labelled like the prices under it.
 */
function studyValueFormat(def: StudyDef): StudyFormat | undefined {
  switch (def.yFmt) {
    case 'pct':
      return { fmt: 'pct', decimals: 2 };
    case 'int':
      return { fmt: 'int', decimals: 0 };
    case 'ratio':
      // 0-1 dp: an oscillator's labels are 20/40/60/80 and its readout value is 39.9. Two decimals
      // of a ratio is precision the indicator does not have.
      return { fmt: 'px', decimals: 1 };
    case 'px':
    case undefined:
      return undefined;
  }
}

/**
 * Which columns one resolved series can offer a study (`studies/needs.ts`).
 *
 * `ohlc` demands all four, not any one of them: `PSAR` reads high and low, `STOCH` reads both plus
 * the close, and `ICHIMOKU` reads the whole bar, so a series carrying a high and no low satisfies
 * none of them. `resolveSeries` only ever builds the four together, which makes this total rather
 * than optimistic.
 */
function columnsOf(series: Resolved): StudyColumns {
  return {
    close: series.ys.used > 0,
    ohlc:
      series.o !== undefined && series.h !== undefined && series.l !== undefined && series.c !== undefined,
    volume: series.v !== undefined,
  };
}

/** No normalisation: `to` and `from` are both the value (§11.2 `normalise: 'none'`). */
const IDENTITY_NORM: Normaliser = Object.freeze({ to: identity, from: identity });

/** The axis a pane with no declared axis still needs to position an x tick or an event glyph. */
const FALLBACK_AXIS: AxisRender = Object.freeze({
  axisId: '',
  lo: 0,
  hi: 1,
  scale: 'linear' as const,
  fmt: undefined,
  decimals: undefined,
  norm: IDENTITY_NORM,
});

/** Whether a slot is inside the view a draw pass was given (widened by one, as a polyline needs). */
function inView(slot: number | undefined, view: Viewport): boolean {
  return slot !== undefined && slot >= view.slot0 - 1 && slot <= view.slot1 + 1;
}

function inside(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

