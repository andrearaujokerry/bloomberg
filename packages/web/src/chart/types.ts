// packages/web/src/chart/types.ts — the shapes every other file in `chart/**` compiles against
// (CLIENT.md §11.1, §11.3, §11.5, §11.8; CHRT-01..07).
//
// The chart engine is written by several hands across renderer.ts, scales.ts, layers.ts, series.ts,
// streaming.ts, events.ts, annotations.ts and studies/**, and all of them draw on the same two
// canvases. Every shape those files pass to each other is declared here, once, so that no two of
// them can arrive at the same seam with different ideas about it. There is no runtime behaviour in
// this file beyond three frozen name tables; nothing here is on a frame path.
//
// `ChartSpec`, `ChartSeries` and `SeriesType` are NOT declared here. They live in
// `screen/types.ts` (WP-01), which is where the 38 screen manifests already build them, and they
// are re-exported below so that `chart/**` has one import to remember. FUNCTIONS.md calls the home
// of `ChartSpec` `chart/spec.ts`; that line is stale, the type shipped in the screen manifest
// types, and a second copy here would be a shape that compiles against none of the six screens
// that actually produce one (GP, GIP, GC, CRVF, OMON, OVML).
//
// **Units.** Every pixel in this file is a CSS pixel. `ChartCanvas` sizes its backing stores by
// `devicePixelRatio` and scales the context by it once, so layout arithmetic, `PaneLayout` rects
// and the scale functions are all dpr-independent — which is also what lets a pixel golden taken at
// dpr 1 mean something about a retina panel. The one place the ratio still shows through is a
// hairline, and `SeriesScales.hairline` carries it so no draw function has to know the ratio.

import type { ChartSeries, ChartSpec, SeriesType } from '../screen/types.js';
import type { ColourToken } from '../theme/colours.js';

/**
 * The manifest types, re-exported — the same declarations, not copies. `chart/**` imports its spec
 * types from here; `screen/types.ts` remains the only place they are written down.
 */
export type { ChartSeries, ChartSpec, SeriesType } from '../screen/types.js';

/**
 * A series' `x`, `y` or study-input column as a spec may supply it.
 *
 * `ChartSeries.x`/`y` are `Float64Array | number[]` because the screens build both: GP copies the
 * payload's typed arrays through, while OVML maps its greeks profile with `Array.prototype.map`.
 * Nothing in the engine may assume one of the two — a draw function reads by index and a study
 * copies into a `Float64Array` first.
 */
export type SeriesData = Float64Array | number[];

/**
 * The colour a series or a study line asks for (`ChartSeries.style.color`, §11.3).
 *
 * Derived rather than restated: `'auto'` resolves to the palette index, `'up'|'down'|'neutral'` to
 * the §12.2 semantic tokens, and a `#rrggbb` literal is a user overlay. A study line uses the same
 * union, so `studies/types.ts` imports this instead of declaring a second one that could drift.
 */
export type SeriesColour = NonNullable<NonNullable<ChartSeries['style']>['color']>;

/**
 * Every `SeriesType`, in the order §11.3 tabulates them.
 *
 * The table below is a `satisfies Record<SeriesType, SeriesType>`, which is the point of it: adding
 * a thirteenth member to the union in `screen/types.ts` is then a compile error here and in
 * `series.ts`'s `SeriesDrawTable`, rather than a type that silently draws nothing on a trader's
 * screen. CHRT-01 is "every member of the union draws", and this is how that is enforced at build
 * time instead of hoped for at review time.
 */
const SERIES_TYPE_TABLE = {
  line: 'line',
  area: 'area',
  mountain: 'mountain',
  candle: 'candle',
  ohlc: 'ohlc',
  bar: 'bar',
  step: 'step',
  scatter: 'scatter',
  tick: 'tick',
  pnf: 'pnf',
  profile: 'profile',
  heatmap: 'heatmap',
} as const satisfies Record<SeriesType, SeriesType>;

export const SERIES_TYPES: readonly SeriesType[] = Object.freeze(Object.values(SERIES_TYPE_TABLE));

/* -------------------------------------------------------------------------------------------- */
/* Viewport, state and focus (§11.1)                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * The visible slot range, in `TradingDayIndex` units (§11.2).
 *
 * Slots, not timestamps: nights, weekends and holidays are compressed away, so the x-axis is
 * slot-linear and a pan is integer arithmetic. The bounds are fractional because a zoom around the
 * crosshair lands between two bars, and rounding the viewport there would make repeated zoom in /
 * zoom out drift off the bar it was anchored to.
 */
export interface Viewport {
  slot0: number;
  slot1: number;
}

/**
 * What the keyboard and the mouse may focus inside the chart region (§11.1, §11.9).
 *
 * Five members, because five things answer a key: the plot itself (crosshair movement), an event
 * marker (`Ctrl+ArrowLeft/Right`, `Enter` to run `event.command`), an annotation (`ArrowUp/Down`
 * cycles, `Delete` removes), a legend entry (`ArrowUp/Down` cycles the crosshair's series) and a
 * pane (`Alt+ArrowUp/Down`, `Space` to collapse). `Ctrl+I` reads the provenance of whichever series
 * the focus implies, which is why `ChartCanvas` must keep `data-prov-idx` in step with this
 * (`screen/widgets/registry.ts`, DATA-10).
 */
export type ChartFocus =
  | { kind: 'plot' }
  | { kind: 'event'; index: number }
  | { kind: 'annotation'; index: number }
  | { kind: 'legend'; seriesId: string }
  | { kind: 'pane'; paneId: string };

/**
 * Everything the renderer draws from, and the whole of what `setState` patches (§11.1).
 *
 * `crosshair` and `drawMode` are nullable rather than optional: "no crosshair" is a state the
 * renderer is told about and clears the overlay for, and with `exactOptionalPropertyTypes` an
 * absent optional key in a `Partial<ChartState>` patch means "leave it alone". The distinction is
 * load-bearing — `setState({ crosshair: null })` hides the readout, `setState({})` does not.
 */
export interface ChartState {
  spec: ChartSpec;
  view: Viewport;
  crosshair: { slot: number; seriesId: string } | null;
  focus: ChartFocus;
  drawMode: DrawMode | null;
  /** Pane ids collapsed to their title bar (`Space`, §11.9). */
  collapsedPanes: Set<string>;
}

/* -------------------------------------------------------------------------------------------- */
/* Draw mode (§11.8, CHRT-05)                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The annotation kind being drawn, and so also the set of kinds that exist.
 *
 * Derived from `ChartSpec.annotations[].kind` on purpose. Those seven strings are a CHECK
 * constraint in the database (`chart_annotations.kind`, migration 0012), and an eighth kind
 * invented in the client would be accepted by the draw mode, rejected by Postgres on `Ctrl+S`, and
 * lost. One union, checked by the compiler, is how CHRT-05's "exact CHECK values" stays true.
 */
export type DrawMode = NonNullable<ChartSpec['annotations']>[number]['kind'];

const DRAW_MODE_TABLE = {
  trendline: 'trendline',
  hline: 'hline',
  vline: 'vline',
  fib: 'fib',
  text: 'text',
  regression_channel: 'regression_channel',
  rect: 'rect',
} as const satisfies Record<DrawMode, DrawMode>;

/** The seven kinds in the order the draw-mode footer lists them (§11.8). */
export const DRAW_MODES: readonly DrawMode[] = Object.freeze(Object.values(DRAW_MODE_TABLE));

/** The footer's own words for them: `TREND HLINE VLINE FIB TEXT REGR RECT` (§11.8). */
export const DRAW_MODE_LABEL: Readonly<Record<DrawMode, string>> = Object.freeze({
  trendline: 'TREND',
  hline: 'HLINE',
  vline: 'VLINE',
  fib: 'FIB',
  text: 'TEXT',
  regression_channel: 'REGR',
  rect: 'RECT',
});

/**
 * How many anchors a kind takes before it is complete (§11.8).
 *
 * `annotations.ts` needs this to know when `Enter` finishes a shape and `keyboard.ts` needs it to
 * label the prompt; both reading it from here is what stops a two-anchor `fib` from being saved
 * with one anchor by whichever of them guessed.
 */
export const DRAW_MODE_ANCHORS: Readonly<Record<DrawMode, 1 | 2>> = Object.freeze({
  trendline: 2,
  hline: 1,
  vline: 1,
  fib: 2,
  text: 1,
  regression_channel: 2,
  rect: 2,
});

/* -------------------------------------------------------------------------------------------- */
/* Hit testing (§11.1)                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * What is under a pointer — `Renderer.hitTest(px, py)`.
 *
 * Reported in data coordinates (slot, value, index), never in pixels: the caller's next act is to
 * move the crosshair, focus a marker or select an annotation, and every one of those is expressed
 * in the same coordinates the keyboard uses. That is TERM-06's requirement stated as a type — the
 * mouse path and the key path reach the same function with the same argument, so a click cannot do
 * something a key cannot.
 *
 * The first five members line up one-to-one with `ChartFocus`, so a click maps to a focus without a
 * translation table. `axis` is the sixth and has no focus member: a drag on an axis rescales it,
 * but the axis never holds keyboard focus.
 */
export type Hit =
  | {
      kind: 'plot';
      paneId: string;
      slot: number;
      /** The value at `py` on `seriesId`'s y-axis, so a drawn anchor lands where the eye is. */
      value: number;
      /** The nearest series in the pane, or `null` when the pane holds none. */
      seriesId: string | null;
    }
  | { kind: 'event'; index: number; slot: number }
  | {
      kind: 'annotation';
      index: number;
      /** The anchor grabbed, or `null` when the body of the shape was hit rather than an anchor. */
      anchor: number | null;
    }
  | { kind: 'legend'; paneId: string; seriesId: string }
  | { kind: 'pane'; paneId: string }
  | { kind: 'axis'; paneId: string; axisId: string };

/* -------------------------------------------------------------------------------------------- */
/* Streaming (§11.5, CHRT-02)                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * One update applied to a live series — `Renderer.applyStream` (§11.5).
 *
 * The two members are the two subjects a `ChartSeries.live` binding can name. `b1m:<id>` delivers a
 * forming one-minute bar and becomes `append-forming-bar`; `q:<id>` delivers a last price and
 * becomes `replace-last`. The shapes differ because the consequences differ: a forming bar may
 * either overwrite the last slot or add one (and `final` freezes it, after which the same bar
 * arriving again is not redrawn), whereas a last price only ever rewrites the last `y` and the
 * legend value. Collapsing them into one patch shape would lose exactly the distinction the
 * last-slot redraw is built on.
 */
export type StreamPatch =
  | {
      seriesId: string;
      mode: 'append-forming-bar';
      /** `BAR_TS, OPEN, HIGH, LOW, CLOSE, VOLUME, IS_FINAL` off the `b1m:` subject. */
      bar: { t: number; o: number; h: number; l: number; c: number; v: number; final: boolean };
    }
  | { seriesId: string; mode: 'replace-last'; t: number; y: number };

/* -------------------------------------------------------------------------------------------- */
/* Layout (§11.1 `Renderer.layout()`)                                                             */
/* -------------------------------------------------------------------------------------------- */

/** A rectangle in CSS pixels, relative to the canvas origin. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One rendered y-axis gutter: which axis of `ChartSpec.yAxes` it is, and where its labels go. */
export interface YAxisLayout {
  /** `ChartSpec.yAxes[].id`, which `ChartSeries.yAxis` names. */
  readonly axisId: string;
  readonly side: 'left' | 'right';
  /** The gutter. Up to 4 axes render, offset by 6 ch each (§11.2). */
  readonly rect: Rect;
}

/**
 * One pane's geometry, as `Renderer.layout()` returns it.
 *
 * This is the engine's only published account of where anything is, and it exists as a return value
 * rather than as private state for two reasons. The legend is DOM — real focusable elements, so the
 * keyboard and a screen reader can reach a series — and it has to be positioned over the pane it
 * belongs to. And a test in jsdom cannot measure a canvas: jsdom does not lay out, so every
 * assertion about pane heights, axis gutters or the event band is an assertion about these rects
 * (TESTING.md §2.2).
 *
 * `xAxis` and `eventBand` are optional in the strict sense — `layout()` omits the key rather than
 * setting it to `undefined`, because with `exactOptionalPropertyTypes` those are different types
 * and only the first means "this pane does not draw one".
 */
export interface PaneLayout {
  /** `ChartSpec.panes[].id`; `'main'` is the price pane, a `sub` study's pane is its study id. */
  readonly paneId: string;
  /** Index in `ChartSpec.panes`, so a test can say "the second pane" without a lookup. */
  readonly index: number;
  readonly title?: string;
  /** The whole band this pane occupies: `plot` plus its axis gutters and any x-axis strip. */
  readonly rect: Rect;
  /** Where series are clipped and drawn — the only rect a `SeriesDraw` may paint in. */
  readonly plot: Rect;
  readonly yAxes: readonly YAxisLayout[];
  /** The shared x-axis strip, present on exactly one pane: the bottom uncollapsed one. */
  readonly xAxis?: Rect;
  /** CHRT-06's one-row marker band at the bottom of the main pane; absent when `E` hid it. */
  readonly eventBand?: Rect;
  /** True when `ChartState.collapsedPanes` holds `paneId`: title bar only, `plot.h` is 0. */
  readonly collapsed: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Theme and fonts (§11.1 constructor, §12.2, §12.3)                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * The resolved palette the renderer was constructed with.
 *
 * A canvas cannot use a CSS custom property: `ctx.strokeStyle` is a string. So the tokens are read
 * once per theme change with `theme/colours.ts#readTokens` and handed over resolved — never read
 * inside `frame()`, because `getComputedStyle` flushes layout and a chart that flushes layout per
 * frame has no frame budget left (§16.1).
 *
 * `name` is here because one drawing rule depends on the theme itself and not on any token: light
 * theme draws up candles hollow (§11.3). A draw function cannot ask the document which theme is
 * current without reaching the DOM mid-frame, so it is told.
 */
export interface ChartTheme {
  readonly name: 'dark' | 'light';
  /** Every `tokens.css` custom property, computed. */
  readonly colour: Readonly<Record<ColourToken, string>>;
}

/**
 * Canvas `font` shorthands and the two metrics the layout needs, at the current density (§12.3).
 *
 * The metrics are measured once, with the fonts, and not per draw. An axis gutter's width is
 * "longest label in characters × `digitPx`", and the font is monospace with tabular figures, so one
 * advance width is the truth for every glyph in it — measuring each label with `measureText` would
 * make an axis draw scale with its tick count for an answer that cannot differ.
 */
export interface ChartFonts {
  /** Axis tick labels: 400 weight at the density's `fontPx`. */
  readonly axis: string;
  /** Pane titles, legend entries and study labels: 500 weight. */
  readonly label: string;
  /** The crosshair readout: 500 weight, the value column tabular. */
  readonly readout: string;
  /** Line height in CSS px — the event band's row height and the readout's line spacing. */
  readonly lineHeightPx: number;
  /** Advance width of one character of the mono font, in CSS px. */
  readonly digitPx: number;
}

/* -------------------------------------------------------------------------------------------- */
/* The renderer ↔ series seam                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The colours one series draws in, resolved.
 *
 * `ChartSeries.style.color` is a request (`'auto'`, a semantic name, or a literal) and this is the
 * answer, so the resolution happens once in the renderer rather than once per series per frame in
 * twelve draw functions that would each have to agree on what `'auto'` means.
 */
export interface SeriesPaint {
  /** The stroke: the resolved `style.color`, or the palette colour for `'auto'`. */
  readonly line: string;
  /** `area`'s fill and `mountain`'s gradient stop 0 — `line` at alpha 0.18 (§11.3). */
  readonly fill: string;
  /** `mountain`'s gradient stop 1, the same hue at alpha 0. */
  readonly fillTo: string;
  /** `--c-up` / `--c-down`: candle bodies, `bar` colouring by `dir`, the volume histogram. */
  readonly up: string;
  readonly down: string;
  readonly neutral: string;
  /** `--c-muted`: pnf glyphs, market-profile TPO letters, the value-area outline. */
  readonly muted: string;
  /** Light theme draws up candles as an outline rather than a filled body (§11.3). */
  readonly hollowUp: boolean;
  /**
   * The sequential scale `heatmap` cells are coloured on, sampled at `t` in 0..1 (§11.3).
   *
   * A function rather than a ramp of stops because the renderer owns the domain: the OMON smile
   * surface and the OVML scenario grid normalise their values before a cell is drawn, and the draw
   * function should be handed the scale, not asked to reinvent it per surface.
   */
  ramp(t: number): string;
}

/**
 * Everything resolved for one series in one pane for one frame: the scales, the rect they map into,
 * and the paint.
 *
 * It is one object rather than eight parameters because it is built once per series per frame and
 * every field is a fact a draw function must not go looking for itself. Nothing in here may be
 * derived from the DOM or from `getComputedStyle` during a frame (§16.1), which is the reason the
 * paint, the fonts and the hairline width arrive pre-computed instead of being read.
 */
export interface SeriesScales {
  /** The pane's plot rect; a draw function clips to it and paints nowhere else. */
  readonly plot: Rect;
  /** Slot (fractional) → CSS px x. Slot-linear: session gaps are already collapsed (§11.2). */
  x(slot: number): number;
  /** Value → CSS px y on this series' own `yAxis`, after `normalise` (§11.2). */
  y(value: number): number;
  /**
   * A value ALREADY in the axis's units → CSS px y: the axis's own ticks and its zero baseline.
   *
   * The distinction only bites under `normalise` (§11.2), and it bit: `y` rebases a data value onto
   * the axis, so a number that came OFF the axis — a tick at `100` on a `base100` axis, the zero a
   * `bar` grows from — would be rebased a second time and drawn somewhere it does not belong. A draw
   * function wants `y` for anything out of the payload and this for anything out of the domain.
   */
  yUnit(value: number): number;
  /** CSS px x → slot: the `pnf` column and `profile` bucket geometry work back from pixels. */
  slotAt(px: number): number;
  /**
   * CSS px y → value, in the series' DATA coordinates: the exact inverse of {@link y} (§11.2).
   *
   * "Exact inverse" is the contract and it was not met: `y` applied the normaliser and this did not,
   * so on a normalised axis every pixel read answered in the axis's unit instead of the payload's.
   * CHRT-05 anchors an annotation in data coordinates and `Renderer.hitTest` is where a pointer
   * becomes one, so the pair has to round-trip or an anchor is persisted in whatever unit the axis
   * happened to be in when it was placed — and drifts when the base is recomputed on the next pan.
   */
  valueAt(py: number): number;
  /** Width of one slot in CSS px — candle bodies, bar widths, the downsampling column width. */
  readonly slotPx: number;
  /** The y of the axis baseline: where `area` fills to and `bar` grows from. */
  readonly baselinePx: number;
  /**
   * The y-axis quantum, `10 ** -decimals`.
   *
   * `pnf` rounds its default box size (`ATR(14)/2`, §11.3) to a tick, and no field of `ChartSpec`
   * carries an instrument tick size — the axis' `decimals` is the only tick information a spec
   * has, so it is resolved here and named for what it is used for.
   */
  readonly tick: number;
  /** The `lineWidth` that lands on exactly one device pixel, whatever the ratio. */
  readonly hairline: number;
  readonly paint: SeriesPaint;
  /** For the two types that draw text: `pnf`'s X/O glyphs and `profile`'s TPO letters. */
  readonly fonts: ChartFonts;
}

/**
 * **The seam between `renderer.ts` and `series.ts`.** One series type's draw function.
 *
 * `renderer.ts` owns the frame: it decides what is dirty, sets up the canvas, resolves the scales
 * and the paint, applies the clip, and calls one of these per visible series. `series.ts` owns the
 * marks: given a context already positioned and a series already resolved, put ink on it. Neither
 * side reaches across — a draw function does not know about dirty regions, the viewport's history
 * or the DOM, and the renderer does not know what a candle looks like.
 *
 * The signature is fixed here because two agents write the two sides of it, and every one of the
 * twelve `SeriesType`s is served by these four arguments: `line`/`area`/`mountain`/`step`/`scatter`
 * read `series.x` and `series.y`; `candle`/`ohlc` read `series.ohlc`; `bar`/`tick` read
 * `series.volume`; `pnf` and `profile` compute their own geometry from the closes and the intraday
 * bars with `scales.slotAt` / `scales.valueAt` / `scales.tick`; `heatmap` reads `series.volume` as
 * the cell value and colours it with `scales.paint.ramp`. `view` is passed separately from the
 * scales because a draw function needs the slot bounds to skip the points outside them — that loop
 * bound is what keeps a draw O(pixels) rather than O(points) on a million-point series (CHRT-02).
 *
 * Returns nothing: the ink is the result, and a draw function that needed to report something back
 * would be doing work that belongs in the renderer.
 */
export type SeriesDraw = (
  ctx: CanvasRenderingContext2D,
  scales: SeriesScales,
  view: Viewport,
  series: ChartSeries,
) => void;

/**
 * The twelve draw functions, one per type — what `series.ts` exports and `renderer.ts` indexes.
 *
 * A `Record` rather than a `Partial<Record>` or a `switch`: CHRT-01 requires every member of the
 * union to draw, and this is the declaration that makes a missing one a build failure instead of a
 * blank pane.
 */
export type SeriesDrawTable = Record<SeriesType, SeriesDraw>;
