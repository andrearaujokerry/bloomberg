// packages/web/src/chart/annotations.ts — the seven annotation kinds, in data coordinates
// (CLIENT.md §11.8, CHRT-05).
//
// ## Why every anchor is `{ t, v }` and never a pixel
//
// An annotation is a statement about the market — this trendline connects the March low to the
// September low — and a statement about the market does not move when the user zooms. So an anchor is
// an instant and a value, and pixels are computed from it on every frame through the
// `TradingDayIndex` and the series' y-axis. The opposite arrangement is the one bug this file exists
// to make impossible: an annotation stored in pixel space looks perfect until the first zoom, at
// which point the trendline is attached to two dates that are not the ones the user drew it between,
// and nothing on screen says so. `annotations.test.ts` asserts the round trip (zoom, pan, zoom back)
// for exactly that reason, and it is CHRT-05's named acceptance row.
//
// Every function here is therefore a pure projection: `(annotation, slots, scales) → pixels`.
// Nothing in this file mutates an annotation, and nothing caches a pixel.
//
// ## Serialisation, and where it departs from the SQL comment
//
// `chart_annotations` (migration 0012 L113) is the persisted form: `kind` is a CHECK over the same
// seven literals `DrawMode` carries, and `anchors` is jsonb. Its column comment says
// "`[{t: epoch_ms, v: number}]` (regression: `{t0, t1, stdev}`)", but the only API that writes the
// table is `sdk.workspace.annotations.create/update`, whose body schema
// (`sdk/wire/rest/workspaces.ts#ChartAnnotationInput`) declares
// `anchors: z.array(z.object({ t, v }))` with no variant. A client that emitted `{t0, t1, stdev}`
// would be rejected by its own SDK before Postgres ever saw the row — `Ctrl+S` would fail on the one
// kind that most needs persisting.
//
// So {@link serialiseAnnotation} emits `[{t, v}, {t, v}]` for a `regression_channel` too, which is
// what the ChartSpec already carries and what the wire accepts, and puts the fitted σ in `style`
// (jsonb, free-form, `DEFAULT '{}'`). Nothing is lost: the channel is a function of the two anchors
// and the closes between them, so the band is recomputed on load, and the persisted σ is kept so
// that a SHARED annotation shows the width its author saw even if the reader's series is adjusted
// differently (§11.8: shared annotations are drawn with the owner's name and `editable:false`).
// The stale variant in the SQL comment is a documentation defect and is reported, not patched here.

import { olsRegression } from '@terminal/core/analytics/stats/index';
import type {
  ChartAnnotation as ChartAnnotationRecord,
  ChartAnnotationInput,
} from '@terminal/sdk/wire/rest/workspaces';

import { DRAW_MODE_ANCHORS } from './types.js';
import type { ChartSpec, Hit, Rect, SeriesData, SeriesScales } from './types.js';

/** One entry of `ChartSpec.annotations[]`. Derived, so the spec stays the single declaration. */
export type ChartAnnotation = NonNullable<ChartSpec['annotations']>[number];

/** `{ t, v }` — an instant and a value on the series' own axis. */
export type AnnotationAnchor = ChartAnnotation['anchors'][number];

/** A point in CSS px, relative to the canvas origin. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The slice of {@link SeriesScales} an annotation's geometry needs.
 *
 * A `Pick` of the real type rather than a fresh interface: the renderer hands over the same object it
 * hands a `SeriesDraw`, so the two cannot drift, and a test builds five members instead of fourteen.
 */
export type AnnotationScales = Pick<SeriesScales, 'plot' | 'x' | 'y' | 'slotAt' | 'valueAt'>;

/**
 * The `TradingDayIndex`, as the two questions an annotation asks of it.
 *
 * Declared as a port and not imported, for the reason `wsBridge.ts` declares `CellRegistryPort`: the
 * seam is the subset this file is allowed to use, and `tradingDayIndex.ts` belongs to the scales.
 *
 * **The member names are `TradingDayIndex.nearestSlot` and `TradingDayIndex.valueAt`, and the
 * mismatch in the second is deliberate.** The adapter is
 * `{ nearestSlot: (t) => index.nearestSlot(t), tsAt: (slot) => index.valueAt(slot) }`. It must be
 * written by hand, because a port this class satisfied structurally would let a reader wire
 * `index.slotOf` in by accident — and that method answers `-1` for any timestamp that is not exactly
 * a bar, which would project every anchor drawn on a weekly chart and reopened on a daily one off the
 * left edge of the plot. `nearestSlot` is the one the index's own comment nominates for §11.8.
 */
export interface AnnotationSlots {
  /** The slot nearest a timestamp — a bar's slot, clamped into the axis. */
  nearestSlot(t: number): number;
  /** The timestamp at a slot (`TradingDayIndex.valueAt`). */
  tsAt(slot: number): number;
}

/**
 * Everything a projection reads. All four members are required and `closes` is nullable rather than
 * optional, because "this pane has no close column" is a fact the projection is told: it is the
 * difference between a `regression_channel` that cannot be fitted and one nobody asked for.
 */
export interface AnnotationContext {
  readonly slots: AnnotationSlots;
  readonly scales: AnnotationScales;
  /**
   * The close column of the series the annotation is anchored to, indexed BY SLOT — needed by
   * `regression_channel` and by nothing else.
   *
   * Index-by-slot holds because the `TradingDayIndex` is built from the union of the series' `x`
   * values (§11.2), so for the price series a chart is anchored to, slot `i` is close `i`. A
   * multi-calendar overlay breaks that, and aligning it is a server option (§11.2) rather than
   * something this file guesses at.
   */
  readonly closes: SeriesData | null;
  /** `Shift+X` on a selected trendline: extend it to the right edge of the plot (§11.8). */
  readonly extendRight: boolean;
}

/* -------------------------------------------------------------------------------------------- */
/* Anchors                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * An anchor, in pixels.
 *
 * Through `nearestSlot`, so that an anchor whose `t` is not a bar on THIS axis still draws: a
 * trendline drawn on a weekly chart and reopened on a daily one, or a shared annotation from an
 * author with a different calendar, lands on the nearest bar rather than vanishing off the left edge.
 */
export function anchorPoint(
  anchor: AnnotationAnchor,
  slots: AnnotationSlots,
  scales: AnnotationScales,
): Point {
  return { x: scales.x(slots.nearestSlot(anchor.t)), y: scales.y(anchor.v) };
}

/**
 * The anchor a pixel names — what `Enter` in draw mode places (§11.8).
 *
 * The slot is ROUNDED and the timestamp read back from the index, so a placed anchor is always the
 * instant of a real bar. That is what makes the round trip exact and the persisted `t` an honest
 * `epoch_ms`: an anchor at 61 % of the way between Tuesday and Wednesday has no meaning a reader
 * could act on, and on reload `nearestSlot` would round it anyway — to whichever neighbour the next
 * zoom's arithmetic happened to favour.
 *
 * The value is NOT rounded. A trendline drawn by eye through a gap between two closes is drawn
 * exactly where the eye put it, and the y-axis quantum is a display decision (`SeriesScales.tick`),
 * not a constraint on where a line may pass.
 */
export function anchorAt(
  px: number,
  py: number,
  slots: AnnotationSlots,
  scales: AnnotationScales,
): AnnotationAnchor {
  return { t: slots.tsAt(Math.round(scales.slotAt(px))), v: scales.valueAt(py) };
}

/* -------------------------------------------------------------------------------------------- */
/* Fibonacci (§11.8)                                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * The seven retracement levels §11.8 names, as percentages: 0 23.6 38.2 50 61.8 78.6 100.
 *
 * Percentages and not fractions because that is how they are labelled on the chart and how §11.8
 * writes them; dividing by 100 once inside {@link fibLevels} is cheaper than every reader of this
 * table remembering which form it is in.
 */
export const FIB_RATIOS: readonly number[] = Object.freeze([0, 23.6, 38.2, 50, 61.8, 78.6, 100]);

/** One drawn retracement: its label, its value on the axis, and its y. */
export interface FibLevel {
  readonly ratio: number;
  readonly v: number;
  readonly y: number;
}

/**
 * The seven levels between two anchors, `from` at 0 % and `to` at 100 %.
 *
 * Direction is preserved rather than normalised: a fib drawn downward from a high to a low has its
 * 0 % at the high, which is the convention every terminal uses and the only one under which "the
 * 61.8 % retracement" names the price a trader means.
 */
export function fibLevels(
  from: AnnotationAnchor,
  to: AnnotationAnchor,
  scales: AnnotationScales,
): FibLevel[] {
  const span = to.v - from.v;
  return FIB_RATIOS.map((ratio) => {
    const v = from.v + (span * ratio) / 100;
    return { ratio, v, y: scales.y(v) };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Regression channel (§11.8)                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** How many residual standard errors the channel's edges sit at — §11.8's "± 2σ". */
export const REGRESSION_SIGMAS = 2;

/** An OLS fit of the closes between two anchors, in slot space. */
export interface RegressionFit {
  readonly slot0: number;
  readonly slot1: number;
  /** Points used — `n` of `olsRegression`, after `NaN` closes were skipped. */
  readonly n: number;
  /** Value per SLOT, not per millisecond. */
  readonly slope: number;
  readonly intercept: number;
  /** Residual standard error `s = √(SSE/(n−2))` — `OlsResult.residualStdErr`. */
  readonly stdev: number;
  readonly sigmas: number;
}

/**
 * Fit the closes between two anchors, or `null` when they cannot be fitted.
 *
 * **The regression is on SLOT, not on timestamp.** The x-axis is slot-linear with nights and
 * weekends compressed away (§11.2), so a channel fitted against epoch ms would be drawn as a
 * straight line through a space it is not straight in: its mid-line would leave the fitted values
 * wherever a holiday fell. Fitting in the space the thing is drawn in is the only way the drawn line
 * is the fit.
 *
 * **The maths is `olsRegression` from `core/analytics/stats`, called and not reproduced** (API-05).
 * The same function serves the stats engine the API exposes, so the channel under the chart and a
 * regression in a payload cannot disagree about the same window. `stdev` is its `residualStdErr`,
 * which is `√(SSE/(n−2))` — the residual dof of a two-parameter fit, not a series' `ddof`.
 *
 * `null` is returned below three usable closes. `olsRegression` requires `n ≥ 3` and throws a
 * `RangeError` otherwise; a two-bar channel is not a regression, and refusing here is what keeps
 * that throw off the frame path rather than wrapping it in a `try` that would also swallow a real
 * defect. Consecutive integer slots always have non-zero variance, so the other `RangeError` that
 * function can raise is unreachable from here.
 */
export function regressionFit(
  from: AnnotationAnchor,
  to: AnnotationAnchor,
  ctx: AnnotationContext,
  sigmas: number = REGRESSION_SIGMAS,
): RegressionFit | null {
  const closes = ctx.closes;
  if (closes === null) return null;
  const a = Math.round(ctx.slots.nearestSlot(from.t));
  const b = Math.round(ctx.slots.nearestSlot(to.t));
  const slot0 = Math.max(0, Math.min(a, b));
  const slot1 = Math.min(closes.length - 1, Math.max(a, b));
  if (slot1 <= slot0) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let slot = slot0; slot <= slot1; slot += 1) {
    const close = closes[slot];
    if (close === undefined || !Number.isFinite(close)) continue;
    xs.push(slot);
    ys.push(close);
  }
  if (xs.length < 3) return null;

  const ols = olsRegression(xs, ys);
  return {
    slot0,
    slot1,
    n: ols.n,
    slope: ols.slope,
    intercept: ols.intercept,
    stdev: ols.residualStdErr,
    sigmas,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Geometry                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** A drawn line, as its two endpoints. */
export type Segment = readonly [Point, Point];

/**
 * One annotation's pixels — what the layer draws and what {@link hitTestAnnotations} measures.
 *
 * Discriminated by `kind` on the same seven literals as `DrawMode`, so a draw function cannot be
 * written for a kind the database would reject.
 */
export type AnnotationGeometry =
  | { readonly kind: 'trendline'; readonly line: Segment }
  | { readonly kind: 'hline'; readonly line: Segment; readonly v: number }
  | { readonly kind: 'vline'; readonly line: Segment; readonly t: number }
  | { readonly kind: 'fib'; readonly x0: number; readonly x1: number; readonly levels: readonly FibLevel[] }
  | { readonly kind: 'text'; readonly at: Point; readonly label: string }
  | {
      readonly kind: 'regression_channel';
      readonly mid: Segment;
      readonly upper: Segment;
      readonly lower: Segment;
      readonly fit: RegressionFit;
    }
  | { readonly kind: 'rect'; readonly rect: Rect };

function rectOf(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/**
 * Extend a segment to the right edge of the plot, keeping its slope (`Shift+X`, §11.8).
 *
 * A vertical pair is returned untouched: there is no right edge for a line of infinite slope to
 * reach, and computing one would divide by zero.
 */
function extendToRightEdge(a: Point, b: Point, plot: Rect): Segment {
  const right = plot.x + plot.w;
  if (b.x === a.x || b.x >= right) return [a, b];
  const slope = (b.y - a.y) / (b.x - a.x);
  return [a, { x: right, y: a.y + slope * (right - a.x) }];
}

/**
 * One annotation's geometry, or `null` when it has nothing to draw yet.
 *
 * `null` for an annotation with fewer anchors than its kind takes — the counts come from
 * `DRAW_MODE_ANCHORS` in `types.ts` rather than from a second table here, which is what stops a
 * one-anchor `fib` being drawn as a flat line through a single close — and for a
 * `regression_channel` whose window cannot be fitted. A half-drawn shape in draw mode is the draw
 * preview's business (`ChartCanvas` draws it on the overlay from the crosshair), not this function's.
 */
export function projectAnnotation(
  annotation: ChartAnnotation,
  ctx: AnnotationContext,
): AnnotationGeometry | null {
  const { slots, scales } = ctx;
  const anchors = annotation.anchors;
  if (anchors.length < DRAW_MODE_ANCHORS[annotation.kind]) return null;
  const first = anchors[0];
  if (first === undefined) return null;
  const a = anchorPoint(first, slots, scales);
  const plot = scales.plot;

  switch (annotation.kind) {
    case 'hline':
      return { kind: 'hline', v: first.v, line: [{ x: plot.x, y: a.y }, { x: plot.x + plot.w, y: a.y }] };
    case 'vline':
      return { kind: 'vline', t: first.t, line: [{ x: a.x, y: plot.y }, { x: a.x, y: plot.y + plot.h }] };
    case 'text':
      return { kind: 'text', at: a, label: annotation.label ?? '' };
    default:
      break;
  }

  const second = anchors[1];
  if (second === undefined) return null;
  const b = anchorPoint(second, slots, scales);

  switch (annotation.kind) {
    case 'trendline':
      return { kind: 'trendline', line: ctx.extendRight ? extendToRightEdge(a, b, plot) : [a, b] };
    case 'rect':
      return { kind: 'rect', rect: rectOf(a, b) };
    case 'fib':
      return {
        kind: 'fib',
        x0: Math.min(a.x, b.x),
        x1: Math.max(a.x, b.x),
        levels: fibLevels(first, second, scales),
      };
    case 'regression_channel': {
      const fit = regressionFit(first, second, ctx);
      if (fit === null) return null;
      const at = (slot: number, offset: number): Point => ({
        x: scales.x(slot),
        y: scales.y(fit.intercept + fit.slope * slot + offset),
      });
      const band = fit.sigmas * fit.stdev;
      return {
        kind: 'regression_channel',
        mid: [at(fit.slot0, 0), at(fit.slot1, 0)],
        upper: [at(fit.slot0, band), at(fit.slot1, band)],
        lower: [at(fit.slot0, -band), at(fit.slot1, -band)],
        fit,
      };
    }
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Hit testing                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** How near a pointer must come, in CSS px. One character of the mono font is about this wide. */
export const ANNOTATION_HIT_PX = 6;

/** Distance from a point to a segment, in pixels. */
function distanceToSegment(px: number, py: number, [a, b]: Segment): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - a.x, py - a.y);
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSq));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** Distance to the nearest point of a rect's BORDER — zero on the border, positive inside. */
function distanceToRectBorder(px: number, py: number, r: Rect): number {
  const corners: Point[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 4; i += 1) {
    const from = corners[i]!;
    const to = corners[(i + 1) % 4]!;
    best = Math.min(best, distanceToSegment(px, py, [from, to]));
  }
  return best;
}

/** Distance from a pointer to a projected shape's body. */
function distanceToGeometry(px: number, py: number, geometry: AnnotationGeometry): number {
  switch (geometry.kind) {
    case 'trendline':
    case 'hline':
    case 'vline':
      return distanceToSegment(px, py, geometry.line);
    case 'rect':
      // The BORDER, not the interior: a filled rect drawn over six months of price would swallow
      // every click meant for the series underneath it.
      return distanceToRectBorder(px, py, geometry.rect);
    case 'text':
      return Math.hypot(px - geometry.at.x, py - geometry.at.y);
    case 'fib': {
      if (px < geometry.x0 - ANNOTATION_HIT_PX || px > geometry.x1 + ANNOTATION_HIT_PX) {
        return Number.POSITIVE_INFINITY;
      }
      let best = Number.POSITIVE_INFINITY;
      for (const level of geometry.levels) best = Math.min(best, Math.abs(py - level.y));
      return best;
    }
    case 'regression_channel':
      return Math.min(
        distanceToSegment(px, py, geometry.mid),
        distanceToSegment(px, py, geometry.upper),
        distanceToSegment(px, py, geometry.lower),
      );
  }
}

/**
 * The annotation under a pointer, as a `Hit` — `Renderer.hitTest`'s annotation case.
 *
 * An ANCHOR is preferred over a body, and across all annotations rather than within one: a pointer
 * inside the tolerance of two shapes at once is on whichever anchor is nearest, because the next act
 * after grabbing an anchor is `M` (drag it) and the next act after selecting a body is `Delete`. Give
 * the body priority and a trendline's endpoint sitting on a rect's edge becomes ungrabbable.
 *
 * Later annotations win ties, which is z-order: the spec lists them in the order they were created
 * and the layer draws them in that order, so the one on top is the one the click gets.
 */
export function hitTestAnnotations(
  annotations: readonly ChartAnnotation[],
  ctx: AnnotationContext,
  px: number,
  py: number,
  tolerance: number = ANNOTATION_HIT_PX,
): Hit | null {
  let anchorHit: Hit | null = null;
  let anchorBest = tolerance;
  let bodyHit: Hit | null = null;
  let bodyBest = tolerance;

  for (const [index, annotation] of annotations.entries()) {
    for (const [anchor, coords] of annotation.anchors.entries()) {
      const point = anchorPoint(coords, ctx.slots, ctx.scales);
      const distance = Math.hypot(px - point.x, py - point.y);
      if (distance <= anchorBest) {
        anchorBest = distance;
        anchorHit = { kind: 'annotation', index, anchor };
      }
    }
    const geometry = projectAnnotation(annotation, ctx);
    if (geometry === null) continue;
    const distance = distanceToGeometry(px, py, geometry);
    if (distance <= bodyBest) {
      bodyBest = distance;
      bodyHit = { kind: 'annotation', index, anchor: null };
    }
  }
  return anchorHit ?? bodyHit;
}

/* -------------------------------------------------------------------------------------------- */
/* Persistence (§11.8, CHRT-05)                                                                   */
/* -------------------------------------------------------------------------------------------- */

export interface SerialiseOptions {
  readonly instrumentId: number;
  readonly sharedScope: ChartAnnotationInput['sharedScope'];
  readonly sharedUserIds: readonly number[];
  /** `chart_annotations.style` — colour, width, dash, whatever the draw layer put there. */
  readonly style: Readonly<Record<string, unknown>>;
  /** The fit, for a `regression_channel`; `null` for every other kind. See the file header. */
  readonly fit: RegressionFit | null;
}

/**
 * One annotation as `sdk.workspace.annotations.create/update` takes it (API.md §5.7).
 *
 * `t` is rounded to an integer millisecond because that is what the column's contract says
 * (`anchors jsonb -- [{t: epoch_ms, …}]`) and jsonb would store a fractional one without complaint.
 * A fractional `t` matches no bar, so on reload `nearestSlot` would round it to a neighbour and the
 * annotation would come back one bar from where it was drawn — the same silent drift storing pixels
 * would cause, arriving by a different route. {@link anchorAt} already snaps to a bar, so this
 * rounding is a guarantee about anything else that built an anchor, not a repair of this file's own
 * arithmetic.
 *
 * `label` becomes `null` rather than being omitted: the column is nullable and the wire schema
 * declares `string | null`, so "no label" is a value on this side of the boundary even though it is
 * an absent optional on the spec side (`exactOptionalPropertyTypes`).
 */
export function serialiseAnnotation(
  annotation: ChartAnnotation,
  options: SerialiseOptions,
): ChartAnnotationInput {
  const style: Record<string, unknown> = { ...options.style };
  if (annotation.kind === 'regression_channel' && options.fit !== null) {
    style.stdev = options.fit.stdev;
    style.sigmas = options.fit.sigmas;
  }
  return {
    instrumentId: options.instrumentId,
    kind: annotation.kind,
    anchors: annotation.anchors.map((anchor) => ({ t: Math.round(anchor.t), v: anchor.v })),
    style,
    label: annotation.label ?? null,
    sharedScope: options.sharedScope,
    sharedUserIds: [...options.sharedUserIds],
  };
}

/**
 * A persisted row back into the spec's shape, or `null` when it cannot be drawn.
 *
 * `editable` is a parameter because the record does not carry it: §11.8 says an annotation shared by
 * someone else draws dashed with the owner's name and `editable:false`, and only the caller knows
 * who the session user is (`ownerUserId` vs the session). Deciding it here from a field this
 * function cannot see is how a reader ends up able to drag an anchor on somebody else's line.
 *
 * `null` for a row whose anchors are not `{t, v}` pairs. That includes the legacy
 * `{t0, t1, stdev}` variant the SQL column comment describes: it carries no value coordinate, so it
 * cannot be rehydrated at all, and drawing it with `v = 0` would put a channel along the bottom of
 * the pane. Refusing is the only honest answer. (No writer in this build produces that shape — see
 * the file header.)
 */
export function annotationFromRecord(
  record: ChartAnnotationRecord,
  editable: boolean,
): ChartAnnotation | null {
  const anchors: AnnotationAnchor[] = [];
  for (const anchor of record.anchors) {
    if (!Number.isFinite(anchor.t) || !Number.isFinite(anchor.v)) return null;
    anchors.push({ t: anchor.t, v: anchor.v });
  }
  if (anchors.length < DRAW_MODE_ANCHORS[record.kind]) return null;
  return {
    annotationId: record.annotationId,
    kind: record.kind,
    anchors,
    editable,
    ...(record.label === null ? {} : { label: record.label }),
  };
}
