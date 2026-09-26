// packages/web/src/chart/scales.ts — data coordinates to pixels, and the numbers a human would label.
//
// CLIENT.md §11.2, CHRT-03. Four scales, because the engine draws four kinds of x axis (slot-linear
// time, tenor, category, and a y axis that is linear or logarithmic) and every one of them has to
// answer the same three questions: where does this value sit, what value sits at this pixel, and
// which round numbers should carry labels.
//
// **The third question is the one that makes a chart readable.** Dividing the range into ten equal
// parts is trivial and produces `147.3182, 149.9364, …`, which nobody can read a level off. Ticks
// here land on the numbers a person would have chosen — 1, 2, 2.5, 5 and 10 times a power of ten on
// a value axis; decades and their 1/2/5 multiples on a log axis; the tenor ladder on a curve; and on
// a time axis the *first slot of a period* (the first bar of the month, the first bar of the
// session), because that is what a date label on a collapsed axis can truthfully mean. Density is
// enforced in pixels against the measured character width rather than hoped for: a label is only
// emitted when it clears the previous one, so an axis cannot overprint itself at any zoom.
//
// **Normalisation is per series, not per axis** (§11.2). `normalise: 'pct' | 'base100'` rebases
// every series on the axis to its own first *visible* point, so the value → pixel mapping depends on
// which series is being drawn and the whole axis is recomputed on a pan: at slot 0 the axis reads
// 0% and after panning right it reads 0% at the new left edge, with every series crossing zero
// there. That recomputation is the feature — a "% change" axis that kept yesterday's base would
// answer a question the trader is no longer asking — and it is why `yAxisScale` takes the viewport.
//
// Formatting is not done here. Every number a user reads goes through the one formatter
// (`format/index.ts` → `core/fields/format.ts`), including these labels: an axis that rendered
// `1234.5` beside a grid that rendered `1,234.50` for the same field is the drift that file exists
// to prevent. Time labels are the exception the formatter does not cover — there is no field format
// for "the month abbreviation in the exchange's time zone" — and they are built here from core's
// `localClock`, which is also what the session logic and the server use, so an axis cannot disagree
// with the session shading beside it about when Tuesday started.

import { formatValue } from '../format/index.js';
import { isoDateFromEpochMs, localClock } from '@terminal/core';
import type { FieldFormat } from '@terminal/core';

import type { ChartSeries, ChartSpec, Rect, Viewport } from './types.js';
import { GAP } from './tradingDayIndex.js';
import type { TradingDayIndex } from './tradingDayIndex.js';

/* -------------------------------------------------------------------------------------------- */
/* Ticks                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * One axis tick: where it goes, what it says, and whether it is a major.
 *
 * `value` is in the axis' own units — a value on a y axis, a **slot** on a time or category axis,
 * days on a tenor axis — and never a pixel, so a tick survives a resize and a test can assert
 * against it without a canvas. `major` carries the emphasis the renderer draws with: a full
 * gridline and a brighter label for a year boundary or a decade, a tick mark alone otherwise.
 */
export interface Tick {
  readonly value: number;
  readonly label: string;
  readonly major: boolean;
}

/** How a value axis' tick labels are rendered: the field format and, when fixed, the decimals. */
export interface LabelSpec {
  readonly fmt: FieldFormat;
  readonly decimals?: number;
}

/** The steps a person picks: 1, 2, 2.5, 5, 10 times a power of ten. */
const STEP_LADDER = [1, 2, 2.5, 5, 10] as const;

/**
 * The smallest ladder step that is at least `raw`.
 *
 * Rounding *up* rather than to the nearest rung is deliberate: `raw` is the span divided by the
 * number of labels that fit, so a smaller step means more labels than fit, which is the one outcome
 * that must not happen. Overshooting produces one fewer label than ideal and always fits.
 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  for (const rung of STEP_LADDER) {
    if (normalised <= rung * (1 + 1e-9)) return rung * magnitude;
  }
  return 10 * magnitude;
}

/**
 * The fewest decimals at which every one of `values` prints exactly.
 *
 * Derived from the ticks rather than from the step, because a 2.5-rung step needs one more decimal
 * than `-log10(step)` suggests and a mis-guessed count prints `2.5, 5, 7.5` as `3, 5, 8` — three
 * labels, two of them wrong, on an axis a position is read off.
 */
function decimalsFor(values: readonly number[]): number {
  for (let d = 0; d <= 8; d += 1) {
    let ok = true;
    for (const v of values) {
      if (Math.abs(v - Number(v.toFixed(d))) > Math.abs(v) * 1e-12 + 1e-12) {
        ok = false;
        break;
      }
    }
    if (ok) return d;
  }
  return 8;
}

/** Multiples of a ladder step inside `[lo, hi]`, at most `target`-ish of them. */
function linearTickValues(lo: number, hi: number, target: number): number[] {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0 || target < 1) return [];
  const step = niceStep(span / target);
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  const out: number[] = [];
  for (let k = first; k <= last; k += 1) {
    // Multiplied rather than accumulated: adding `step` repeatedly accumulates float error and a
    // tick that should be 0.30 arrives as 0.30000000000000004, which then needs 17 decimals.
    out.push(k * step);
  }
  return out;
}

/**
 * Where a log axis' labels go, chosen by how many decades it spans.
 *
 * Three regimes, because one rule cannot serve them. A 1950-to-2025 equity chart spans two decades
 * and wants 10/20/50/100; a broad one spans four and wants the decades alone; and a log-scaled
 * three-month view spans a twentieth of a decade, where the only readable labels are the same round
 * numbers a linear axis would pick. Emitting decade multiples in that last case yields one tick, or
 * none, on a full-height axis.
 */
function logTickValues(lo: number, hi: number, target: number): number[] {
  const decades = Math.log10(hi / lo);
  if (decades < 0.7) return linearTickValues(lo, hi, target);

  const multipliers = decades >= 3 ? [1] : decades >= 1.5 ? [1, 2, 5] : [1, 2, 3, 5];
  const out: number[] = [];
  const firstExp = Math.floor(Math.log10(lo));
  const lastExp = Math.ceil(Math.log10(hi));
  for (let e = firstExp; e <= lastExp; e += 1) {
    for (const m of multipliers) {
      const v = m * 10 ** e;
      if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v);
    }
  }
  return thin(out, target);
}

/** Keep every k-th entry so that at most `max` remain, always keeping the first. */
function thin<T>(xs: readonly T[], max: number): T[] {
  if (max < 1) return [];
  if (xs.length <= max) return [...xs];
  const stride = Math.ceil(xs.length / max);
  const out: T[] = [];
  for (let i = 0; i < xs.length; i += stride) {
    const v = xs[i];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* Value scales: linear, log, tenor                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * A value → pixel mapping with an inverse and its own idea of a good tick.
 *
 * `range` is `[pxAtDomain0, pxAtDomain1]` and for a y axis it is *descending* in the canvas' own
 * terms (`[plot.y + plot.h, plot.y]`), because the domain minimum belongs at the bottom. Keeping
 * that in the range rather than in the projection is what lets the same three implementations serve
 * a y axis, a tenor x axis and, if a pane ever wants one, an inverted axis.
 */
export interface ValueScale {
  readonly kind: 'linear' | 'log' | 'tenor';
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  project(v: number): number;
  invert(px: number): number;
  ticks(target: number): Tick[];
}

/** A domain that cannot be projected (zero span, or a flat series) widened just enough to be one. */
function widened(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi > lo) return [lo, hi];
  // A flat series — a rate that has not moved, a single point — would otherwise divide by a zero
  // span and project every value to the same pixel or to Infinity. One per cent of the level (or a
  // hair, at zero) is small enough to look flat and wide enough to be arithmetic.
  const pad = Math.max(Math.abs(hi) * 0.01, 1e-6);
  return [hi - pad, hi + pad];
}

function labelOf(v: number, label: LabelSpec, decimals: number): string {
  return formatValue(label.fmt, v, { decimals: label.decimals ?? decimals });
}

function ticksFrom(values: readonly number[], label: LabelSpec): Tick[] {
  const decimals = decimalsFor(values);
  return values.map((v) => ({ value: v, label: labelOf(v, label, decimals), major: v === 0 }));
}

/** `LinearScale` (§11.2): the y axis of every price, rate and greek pane. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
  label: LabelSpec = { fmt: 'px' },
): ValueScale {
  const [lo, hi] = widened(domain[0], domain[1]);
  const [p0, p1] = range;
  const scalePx = (p1 - p0) / (hi - lo);
  return {
    kind: 'linear',
    domain: [lo, hi],
    range: [p0, p1],
    project: (v) => p0 + (v - lo) * scalePx,
    invert: (px) => lo + (px - p0) / scalePx,
    ticks: (target) => ticksFrom(linearTickValues(lo, hi, target), label),
  };
}

/**
 * `LogScale` (§11.2): equal pixel distance for equal percentage move, which is what makes a
 * ten-year chart of a stock that went from 20 to 200 readable at both ends.
 *
 * The domain is forced positive. A log axis has nothing to say about zero or a negative value, and
 * the caller that can produce one (`yAxisScale`, over a spread series) chooses a linear axis instead
 * rather than asking this scale to invent a position.
 */
export function logScale(
  domain: readonly [number, number],
  range: readonly [number, number],
  label: LabelSpec = { fmt: 'px' },
): ValueScale {
  const hi = Math.max(domain[1], Number.MIN_VALUE);
  // A decade below the top is the floor for a domain whose bottom is not positive: six orders of
  // magnitude of empty axis is not a chart, and clamping is visible where a silent `NaN` is not.
  const lo = domain[0] > 0 ? Math.min(domain[0], hi) : hi / 10;
  const [l0, l1] = [Math.log(lo), Math.log(hi)];
  const [p0, p1] = range;
  const scalePx = l1 > l0 ? (p1 - p0) / (l1 - l0) : 0;
  return {
    kind: 'log',
    domain: [lo, hi],
    range: [p0, p1],
    project: (v) => (v > 0 ? p0 + (Math.log(v) - l0) * scalePx : Number.NaN),
    invert: (px) => (scalePx === 0 ? lo : Math.exp(l0 + (px - p0) / scalePx)),
    ticks: (target) => ticksFrom(logTickValues(lo, hi, target), label),
  };
}

/** The tenor ladder a curve is labelled with (§11.2, `1M…30Y`), in days, with its majors. */
const TENOR_LADDER: readonly { readonly days: number; readonly label: string; readonly major: boolean }[] = [
  { days: 1, label: '1D', major: false },
  { days: 7, label: '1W', major: false },
  { days: 14, label: '2W', major: false },
  { days: 30, label: '1M', major: true },
  { days: 61, label: '2M', major: false },
  { days: 91, label: '3M', major: true },
  { days: 182, label: '6M', major: true },
  { days: 273, label: '9M', major: false },
  { days: 365, label: '1Y', major: true },
  { days: 730, label: '2Y', major: true },
  { days: 1095, label: '3Y', major: false },
  { days: 1826, label: '5Y', major: true },
  { days: 2557, label: '7Y', major: false },
  { days: 3652, label: '10Y', major: true },
  { days: 5478, label: '15Y', major: false },
  { days: 7305, label: '20Y', major: true },
  { days: 10957, label: '30Y', major: true },
];

/**
 * A tenor domain spans at least this ratio in `1 + days`.
 *
 * The test that decides whether an x axis is *labelled* in tenors, and it is a ratio because of what
 * the six chart-building screens actually pass. GC and CRVF set `xAxis.type: 'tenor'` with x in days
 * and span 1D to 30Y (a ratio in the thousands). OMON's smile and OVML's greeks profile set the same
 * axis type with x in **strikes** and **spot prices** — a band around one number, never spanning
 * 24× — because `ChartSpec.xAxis` has no fourth type for "a numeric axis that is not time". Both
 * want the same log-ish geometry (over a 1.7× band it is indistinguishable from linear) and only one
 * of them wants the ladder: `6M` printed under a strike of 182 would be a label that is not merely
 * unhelpful but false. So the spacing is shared and the labelling is decided by the domain.
 */
const TENOR_DOMAIN_RATIO = 24;

/**
 * `TenorScale` (§11.2): x in days, log-ish so that the money-market end of a curve is legible
 * beside the 30-year.
 *
 * `log1p`, not `log`: a curve's first point can be spot (0 days) and `log(0)` is `-Infinity`, which
 * would collapse every other tenor onto the right edge. Over the ladder the two differ by under a
 * per cent of the axis at every rung, so the shape §11.2 asks for is preserved and zero is admitted.
 */
export function tenorScale(
  domain: readonly [number, number],
  range: readonly [number, number],
  label: LabelSpec = { fmt: 'px' },
): ValueScale {
  const [lo, hi] = widened(Math.max(domain[0], 0), Math.max(domain[1], 0));
  const [t0, t1] = [Math.log1p(lo), Math.log1p(hi)];
  const [p0, p1] = range;
  const scalePx = t1 > t0 ? (p1 - p0) / (t1 - t0) : 0;
  const laddered = (1 + hi) / (1 + lo) >= TENOR_DOMAIN_RATIO;
  return {
    kind: 'tenor',
    domain: [lo, hi],
    range: [p0, p1],
    project: (v) => p0 + (Math.log1p(Math.max(v, 0)) - t0) * scalePx,
    invert: (px) => (scalePx === 0 ? lo : Math.expm1(t0 + (px - p0) / scalePx)),
    ticks: (target) => {
      if (!laddered) return ticksFrom(linearTickValues(lo, hi, target), label);
      const inDomain = TENOR_LADDER.filter((t) => t.days >= lo && t.days <= hi);
      const fitted =
        inDomain.length <= target ? inDomain : thin(inDomain.filter((t) => t.major), target);
      return fitted.map((t) => ({ value: t.days, label: t.label, major: t.major }));
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The slot-linear x axis                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Slot ↔ pixel for a viewport, plus the width of one slot (§11.2, `SeriesScales.slotPx`). */
export interface SlotScale {
  readonly slotPx: number;
  x(slot: number): number;
  slotAt(px: number): number;
}

/**
 * The x mapping for a viewport over a plot rect.
 *
 * A slot occupies a band, not a line: the visible span is `slot1 - slot0 + 1` slots and a slot is
 * drawn at the *centre* of its band. That half-slot inset is what gives the first and last candle
 * of a view room for its body instead of clipping half of it against the axis gutter, and it is why
 * the inverse subtracts the same half before dividing — a click in the left half of the first bar
 * must hit that bar, not the one before it.
 */
export function slotScale(view: Viewport, rect: Pick<Rect, 'x' | 'w'>): SlotScale {
  const span = Math.max(view.slot1 - view.slot0 + 1, 1e-9);
  const slotPx = rect.w / span;
  return {
    slotPx,
    x: (slot) => rect.x + (slot - view.slot0 + 0.5) * slotPx,
    slotAt: (px) => view.slot0 + (px - rect.x) / slotPx - 0.5,
  };
}

/** `CategoryScale` (§11.2): equal bands for `bar` and `heatmap` columns. */
export interface CategoryScale {
  readonly count: number;
  readonly bandPx: number;
  /** The centre of band `i`. */
  x(i: number): number;
  /** The band under a pixel, clamped into `0..count-1`; `-1` when there are no bands. */
  indexAt(px: number): number;
  ticks(maxLabels: number): Tick[];
}

export function categoryScale(input: {
  readonly count: number;
  readonly rect: Pick<Rect, 'x' | 'w'>;
  readonly categories?: readonly string[];
}): CategoryScale {
  const count = Math.max(Math.floor(input.count), 0);
  const bandPx = count === 0 ? input.rect.w : input.rect.w / count;
  const { rect, categories } = input;
  return {
    count,
    bandPx,
    x: (i) => rect.x + (i + 0.5) * bandPx,
    indexAt: (px) => {
      if (count === 0) return -1;
      return Math.min(count - 1, Math.max(0, Math.floor((px - rect.x) / bandPx)));
    },
    ticks: (maxLabels) => {
      const all: Tick[] = [];
      for (let i = 0; i < count; i += 1) {
        all.push({ value: i, label: categories?.[i] ?? String(i), major: false });
      }
      return thin(all, maxLabels);
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The y axis: domain from the viewport, normalisation, ticks                                     */
/* -------------------------------------------------------------------------------------------- */

/** One entry of `ChartSpec.yAxes`. */
export type YAxisSpec = ChartSpec['yAxes'][number];

export interface YAxisScaleInput {
  readonly axis: YAxisSpec;
  /** The series drawn on this axis — normally `spec.series.filter(s => s.yAxis === axis.id)`. */
  readonly series: readonly ChartSeries[];
  readonly index: TradingDayIndex;
  readonly view: Viewport;
  /** `[pxAtDomainMin, pxAtDomainMax]`: for a pane that is `[plot.y + plot.h, plot.y]`. */
  readonly range: readonly [number, number];
  /** An explicit domain — an axis drag, or a pane whose scale is pinned. Skips the data scan. */
  readonly domain?: readonly [number, number];
  /** Values that must stay in view though they are not series points: `ChartSpec.reference`. */
  readonly include?: readonly number[];
  /** Fraction of the span left blank above and below. Default 4%. */
  readonly pad?: number;
}

/**
 * A y axis resolved against a viewport: the scale, the per-series rebasing, and the ticks (§11.2).
 *
 * `y(seriesId, v)` is the composition every draw function wants — a raw value off the series'
 * array, straight to a pixel — and it is a two-argument function rather than the one-argument
 * `project` because on a normalised axis the answer depends on which series is asking. `normalised`
 * and `baseOf` are exposed beside it so the crosshair readout can say both what the series printed
 * and what the axis is showing.
 */
export interface YAxisScale {
  readonly axisId: string;
  readonly side: 'left' | 'right';
  readonly kind: 'linear' | 'log';
  readonly normalise: 'none' | 'pct' | 'base100';
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  /** Normalised value → pixel. Identical to `y` when `normalise` is `'none'`. */
  readonly scale: ValueScale;
  baseOf(seriesId: string): number;
  normalised(seriesId: string, v: number): number;
  y(seriesId: string, v: number): number;
  /** Pixel → normalised value (what an annotation anchor placed by the mouse is worth). */
  invert(px: number): number;
  ticks(target: number): Tick[];
}

/** The first visible value of `series` that can serve as a rebasing base (§11.2). */
function firstVisibleBase(
  series: ChartSeries,
  index: TradingDayIndex,
  view: Viewport,
): number {
  const from = Math.max(0, Math.ceil(view.slot0));
  const to = Math.min(index.length - 1, Math.floor(view.slot1));
  let firstFinite = Number.NaN;
  for (let slot = from; slot <= to; slot += 1) {
    const i = index.indexAt(series.id, slot);
    if (i === GAP) continue;
    const v = series.y[i] ?? Number.NaN;
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(firstFinite)) firstFinite = v;
    // Zero cannot be a base — rebasing to it is a division by zero — so the first *non-zero*
    // visible point is taken instead. A series that is zero at the left edge and moves later (a
    // spread that starts flat) then still rebases, off a base a reader can see on the chart,
    // rather than vanishing into `NaN` for the whole viewport.
    if (v !== 0) return v;
  }
  return firstFinite === 0 ? Number.NaN : firstFinite;
}

/** `pct` and `base100` as §11.2 defines them; `none` is the identity. */
function rebase(mode: 'none' | 'pct' | 'base100', v: number, base: number): number {
  if (mode === 'none') return v;
  if (!Number.isFinite(base) || base === 0) return Number.NaN;
  return mode === 'pct' ? (v / base - 1) * 100 : (v / base) * 100;
}

/**
 * What the ticks of a normalised axis are labelled with.
 *
 * A rebased axis is no longer in the field's unit, and keeping the spec's `fmt` would print a
 * base-100 index of a yield curve as `10,000%`. Percent change is a percentage whatever the series
 * was; a base-100 index is a plain number.
 */
function labelSpecFor(axis: YAxisSpec): LabelSpec {
  const normalise = axis.normalise ?? 'none';
  if (normalise === 'pct') return { fmt: 'pct' };
  if (normalise === 'base100') return { fmt: 'px' };
  const fmt = axis.fmt ?? 'px';
  return axis.decimals === undefined ? { fmt } : { fmt, decimals: axis.decimals };
}

export function yAxisScale(input: YAxisScaleInput): YAxisScale {
  const { axis, index, view } = input;
  const normalise = axis.normalise ?? 'none';

  const bases = new Map<string, number>();
  for (const s of input.series) {
    bases.set(s.id, normalise === 'none' ? 1 : firstVisibleBase(s, index, view));
  }
  const baseOf = (seriesId: string): number => bases.get(seriesId) ?? Number.NaN;
  const normalised = (seriesId: string, v: number): number =>
    rebase(normalise, v, baseOf(seriesId));

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  if (input.domain === undefined) {
    const from = Math.max(0, Math.ceil(view.slot0));
    const to = Math.min(index.length - 1, Math.floor(view.slot1));
    for (const s of input.series) {
      const base = baseOf(s.id);
      for (let slot = from; slot <= to; slot += 1) {
        const i = index.indexAt(s.id, slot);
        if (i === GAP) continue;
        // A candle's wick, not its close, decides how tall the pane must be: scanning `y` alone
        // clips the high of every visible bar against the top of the plot.
        const values =
          s.ohlc === undefined
            ? [s.y[i] ?? Number.NaN]
            : [s.ohlc.h[i] ?? Number.NaN, s.ohlc.l[i] ?? Number.NaN];
        for (const raw of values) {
          const v = rebase(normalise, raw, base);
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    for (const raw of input.include ?? []) {
      // A reference line is rebased with the axis, not against a series: `ChartSpec.reference`
      // carries an axis id and no series id, and on a `pct` axis the only base the whole axis
      // agrees on is the first series'. Left raw it would land off the plot and drag the domain.
      const v = normalise === 'none' ? raw : rebase(normalise, raw, baseOf(input.series[0]?.id ?? ''));
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  } else {
    [lo, hi] = [input.domain[0], input.domain[1]];
  }

  // Nothing finite in view: an empty range, a viewport past the end of the data, a wholly blank
  // series. A unit domain draws an honest empty pane with readable ticks rather than `NaN` axes, and
  // it is not padded — there is no data to leave room around, and `0..1` is easier to recognise for
  // what it is than `-0.04..1.04`.
  const empty = !Number.isFinite(lo) || !Number.isFinite(hi);
  if (empty) [lo, hi] = [0, 1];
  const pad = empty ? 0 : (input.pad ?? 0.04) * Math.max(hi - lo, 0);
  const padded: [number, number] = [lo - pad, hi + pad];

  // A log axis is only offered where it means something. `normalise: 'pct'` centres a series on
  // zero and a rebased value is routinely negative, and so is a spread or a greek; `log` there
  // would drop every non-positive point silently. Linear is the honest answer, and `kind` reports
  // which one was built so the toolbar can show `L` as off rather than lying about it.
  const wantsLog = axis.scale === 'log' && normalise !== 'pct' && padded[0] > 0;
  const label = labelSpecFor(axis);
  const scale = wantsLog
    ? logScale(padded, input.range, label)
    : linearScale(padded, input.range, label);

  return {
    axisId: axis.id,
    side: axis.side,
    kind: scale.kind === 'log' ? 'log' : 'linear',
    normalise,
    domain: scale.domain,
    range: scale.range,
    scale,
    baseOf,
    normalised,
    y: (seriesId, v) => scale.project(normalised(seriesId, v)),
    invert: (px) => scale.invert(px),
    ticks: (target) => scale.ticks(target),
  };
}

/**
 * How many y labels a pane of this height should carry.
 *
 * Two and a half line heights apart: closer and the labels touch at `normal` density, further and a
 * tall pane has three gridlines. The renderer and the tests call the same function so that an axis'
 * density is one decision rather than two that drift.
 */
export function targetYTickCount(plotHeightPx: number, lineHeightPx: number): number {
  if (lineHeightPx <= 0) return 2;
  return Math.max(2, Math.floor(plotHeightPx / (lineHeightPx * 2.5)));
}

/* -------------------------------------------------------------------------------------------- */
/* Time ticks                                                                                     */
/* -------------------------------------------------------------------------------------------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The local wall clock of an instant, in the exchange's zone where core knows it. */
interface Clock {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  readonly day: number;
  /** Days since the epoch in local terms — what a week bucket counts. */
  readonly epochDay: number;
  readonly minuteOfDay: number;
}

const MS_PER_DAY = 86_400_000;

function clockAt(tz: string | undefined, t: number): Clock {
  // `localClock` is core's, shared with the session logic and the server, and it returns
  // `undefined` for a zone outside its table. UTC is then the fallback rather than an error: an
  // axis whose labels are an hour out in an unsupported zone is worth more than a chart that
  // refuses to draw one, and `xAxis.tz` comes from a provider payload we do not control.
  const local = tz === undefined ? undefined : localClock(tz, t);
  const iso = local?.date ?? isoDateFromEpochMs(t);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const minuteOfDay =
    local?.minuteOfDay ?? Math.floor((t - Math.floor(t / MS_PER_DAY) * MS_PER_DAY) / 60_000);
  // `Date.UTC` is arithmetic over a civil date, not a clock read: nothing here asks what time it is.
  return { year, month, day, epochDay: Date.UTC(year, month - 1, day) / MS_PER_DAY, minuteOfDay };
}

/** One candidate labelling: how instants are grouped, and what the label for a group says. */
interface Granularity {
  readonly id: string;
  /** Instants in the same period share a bucket number. */
  bucket(c: Clock): number;
  /** The tick's own label; `prev` is the previous kept tick's clock, or `null` for the first. */
  label(c: Clock, prev: Clock | null): string;
  major(c: Clock, prev: Clock | null): boolean;
}

const hhmm = (c: Clock): string =>
  `${String(Math.floor(c.minuteOfDay / 60)).padStart(2, '0')}:${String(c.minuteOfDay % 60).padStart(2, '0')}`;

const monthLabel = (c: Clock, prev: Clock | null): string =>
  prev?.year !== c.year
    ? `${MONTHS[c.month - 1] ?? '???'} ${String(c.year % 100).padStart(2, '0')}`
    : (MONTHS[c.month - 1] ?? '???');

/** Coarsest last: `timeTicks` walks this list and stops at the first labelling that fits. */
const GRANULARITIES: readonly Granularity[] = [
  ...[1, 2, 5, 15, 30].map((n) => ({
    id: `${String(n)}m`,
    bucket: (c: Clock) => c.epochDay * 1440 + Math.floor(c.minuteOfDay / n),
    label: hhmm,
    major: (c: Clock, prev: Clock | null) => prev?.epochDay !== c.epochDay,
  })),
  ...[1, 2, 4].map((n) => ({
    id: `${String(n)}h`,
    bucket: (c: Clock) => c.epochDay * 24 + Math.floor(c.minuteOfDay / (60 * n)),
    label: hhmm,
    major: (c: Clock, prev: Clock | null) => prev?.epochDay !== c.epochDay,
  })),
  {
    id: '1d',
    bucket: (c) => c.epochDay,
    label: (c, prev) =>
      prev?.month !== c.month
        ? `${String(c.day)} ${MONTHS[c.month - 1] ?? '???'}`
        : String(c.day),
    major: (c, prev) => prev?.month !== c.month,
  },
  {
    id: '1w',
    // Thursday-aligned weeks, because epoch day 0 was a Thursday; the alignment does not matter as
    // long as it is consistent — a week tick marks the first bar of a seven-day block either way.
    bucket: (c) => Math.floor(c.epochDay / 7),
    label: (c) => `${String(c.day)} ${MONTHS[c.month - 1] ?? '???'}`,
    major: (c, prev) => prev?.month !== c.month,
  },
  ...[1, 3, 6].map((n) => ({
    id: `${String(n)}mo`,
    bucket: (c: Clock) => Math.floor((c.year * 12 + (c.month - 1)) / n),
    label: monthLabel,
    major: (c: Clock, prev: Clock | null) => prev?.year !== c.year,
  })),
  ...[1, 2, 5, 10].map((n) => ({
    id: `${String(n)}y`,
    bucket: (c: Clock) => Math.floor(c.year / n),
    label: (c: Clock) => String(c.year),
    major: () => true,
  })),
];

export interface TimeTickInput {
  readonly index: TradingDayIndex;
  readonly view: Viewport;
  /** The plot width in CSS pixels. */
  readonly width: number;
  /** `ChartFonts.digitPx` — the mono advance width, so a label's pixels are its characters. */
  readonly digitPx: number;
  /** `ChartSpec.xAxis.tz`. */
  readonly tz?: string;
  /** Blank characters required between two labels. Default 2. */
  readonly gapChars?: number;
}

/**
 * The x axis' labels: the first slot of each period, at the finest period that fits (§11.2).
 *
 * Two rules make this a time axis on a slot-linear canvas. A tick goes where the period *changes*
 * from the previous slot — the first bar of the month, not the 21st bar of the view — because a
 * label on a collapsed axis can only mean "this bar begins the month it names", and because that
 * makes the ticks stable under a pan: the same bars carry the same labels as the view slides, so the
 * axis does not shimmer. The comparison reaches to `slot - 1` even when that slot is off-screen, so
 * a period change at the left edge is not invented by the edge.
 *
 * And the choice of period is made in pixels. Labels are emitted coarsest-fits-first over the
 * ladder above, then filtered once more against the measured pixel gap, so no two labels can
 * overprint at any zoom — which is what "a density that does not collide" has to mean when the
 * spacing between period boundaries is uneven (a session break, a short month, a holiday week).
 */
export function timeTicks(input: TimeTickInput): Tick[] {
  const { index, view, width, digitPx } = input;
  const gapChars = input.gapChars ?? 2;
  const from = Math.max(0, Math.ceil(view.slot0));
  const to = Math.min(index.length - 1, Math.floor(view.slot1));
  if (to < from || width <= 0 || digitPx <= 0) return [];

  const px = slotScale(view, { x: 0, w: width });
  const clocks = new Map<number, Clock>();
  const clockOf = (slot: number): Clock => {
    const seen = clocks.get(slot);
    if (seen !== undefined) return seen;
    const c = clockAt(input.tz, index.valueAt(slot));
    clocks.set(slot, c);
    return c;
  };

  for (const g of GRANULARITIES) {
    const boundaries: number[] = [];
    for (let slot = from; slot <= to; slot += 1) {
      if (slot === 0 || g.bucket(clockOf(slot)) !== g.bucket(clockOf(slot - 1))) {
        boundaries.push(slot);
      }
    }
    if (boundaries.length === 0) continue;

    const ticks: Tick[] = [];
    let prev: Clock | null = null;
    let prevPx = Number.NEGATIVE_INFINITY;
    let widest = 0;
    for (const slot of boundaries) {
      const c = clockOf(slot);
      const label = g.label(c, prev);
      const needPx = (Math.max(widest, label.length) + gapChars) * digitPx;
      if (px.x(slot) - prevPx < needPx) continue;
      ticks.push({ value: slot, label, major: g.major(c, prev) });
      widest = Math.max(widest, label.length);
      prevPx = px.x(slot);
      prev = c;
    }
    // The dropped labels are what disqualifies a granularity: if this period boundary is so dense
    // that the gap filter had to throw any of it away, the next coarser period is the one that
    // actually fits, and its labels fall on boundaries a reader expects rather than on whichever
    // ones happened to survive.
    if (ticks.length === boundaries.length) return ticks;
  }

  // Even 10-year ticks are too dense for this width (a sparkline, or a pane a few pixels wide).
  // The coarsest labelling, thinned, beats no axis at all.
  const coarsest = GRANULARITIES[GRANULARITIES.length - 1];
  if (coarsest === undefined) return [];
  const out: Tick[] = [];
  for (let slot = from; slot <= to; slot += 1) {
    if (slot === 0 || coarsest.bucket(clockOf(slot)) !== coarsest.bucket(clockOf(slot - 1))) {
      out.push({ value: slot, label: coarsest.label(clockOf(slot), null), major: true });
    }
  }
  return thin(out, Math.max(1, Math.floor(width / (6 * digitPx))));
}
