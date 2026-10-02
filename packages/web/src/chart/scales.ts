// packages/web/src/chart/scales.ts — the two mappings every chart in the product draws through.
//
// CLIENT.md §11.2, CHRT-03. A value to a position on an axis, and a slot to a position across one.
// That is the whole of this file, and the small size is the point of it.
//
// ## What it used to be, because deleting 600 lines deserves a reason
//
// WP-14 shipped the chart's geometry THREE times. This module was the first and the fullest —
// `yAxisScale`, `tenorScale`, `categoryScale`, `niceStep`, `timeTicks`, a per-series normaliser and a
// tick picker with a 2.5 rung — and the renderer was wired to neither of the others' authors' copies
// but to its own: `renderer.ts` grew `buildAxes`/`padded`/`scalesFor`/`normaliserFor`, and `layers.ts`
// a third set of tick and label maths. So `test/chart/scales.test.ts` ran 29 green assertions about
// geometry no pixel was ever drawn with, while both axis defects WP-14's audit found were in the copy
// that draws — and were not in this one.
//
// That was closed in the direction the measurements pointed, not the direction that preserved the
// most code:
//
//   * **`yAxisScale` could not be wired, and the reason is a frame budget.** It scans its domain
//     through `TradingDayIndex.indexAt(seriesId, slot)` once per visible slot per series, over the
//     RAW `ChartSeries` arrays. The renderer scans the M4-reduced columns instead — one minimum and
//     one maximum per pixel column, which `renderer.ts#buildAxes` records as the same two numbers for
//     170 ms less per frame on a million-point series (§16.1's 16 ms budget is the whole reason that
//     reduction exists). And it takes `ChartSeries` + `TradingDayIndex`, where the renderer holds
//     `Resolved` ring buffers. "Wire it in" therefore meant rewriting its body against a different
//     representation and giving back a measured frame budget: not reuse, and not a trade worth making.
//   * **The tick pickers collapsed onto `layers.ts`.** `niceTicks` and `logDecadeTicks` are what the
//     gridlines and the axis labels are actually drawn from, so they are the survivors. The 2.5 rung
//     that `niceStep` had and `niceTicks` does not is a real improvement and is deliberately NOT
//     adopted here: it moves every y tick on every committed chart golden, which is a decision to
//     take on its own and not inside a deduplication.
//   * **`tenorScale` and `categoryScale` went with the rest.** The renderer's x axis is slot-linear
//     for every `xAxis.type`, so a curve's shape is wrong on GC, CRVF, OMON and OVML — see the
//     measurement in `test/chart/scales.test.ts`, which now takes it on the renderer rather than on a
//     module that does not draw. Keeping an unplugged tenor axis next to the slot-linear one that
//     draws is what made that defect invisible for a package and a half; the defect is recorded, the
//     second implementation is not.
//
// What is left is what two callers really use, which is why it is still a module and not inlined:
// `renderer.ts#scalesFor` (every pane of every chart) and `screen/widgets/Sparkline.tsx`
// (DES, ECO, EE — a canvas with no axes, which still has to place a point).
//
// ## Two forms of one mapping, and why both are published
//
// `unitScale` is the arithmetic: domain → `0..1` and back. `renderer.ts` holds one per axis per frame
// on `AxisRender.unit` and composes it with its own plot rect as `plot.y + plot.h * (1 - u)`, which is
// the exact expression every committed pixel golden in `test/chart/renderer.test.ts` was taken through
// — algebraically equal to `project`, not equal in the last bit of a float, and a renderer is not the
// place to spend a golden to tidy an association. `linearScale`/`logScale` are that same scale plus a
// pixel range, for a caller that just wants a coordinate (`Sparkline`). Not two implementations: the
// second is built from the first, and `scales.test.ts` asserts the two forms agree to nine places so
// the pair cannot drift apart again.
//
// Building the unit scale once per axis rather than once per call is a frame budget, not a style: the
// renderer evaluates `unit()` for every tick, every reference rule, every study point and every
// crosshair read, and the log branch has two `Math.log10`s. Measured on `chart.bench.ts`' base redraw
// over five alternating runs, round-5 p95 minimum: 0.824 ms with the arithmetic rebuilt per call (as
// `renderer.ts` did when it owned it) against 0.574 ms hoisted, on a 4 ms budget.
//
// Formatting is not done here and never was. Every number a user reads goes through the one formatter
// (`format/index.ts` → `core/fields/format.ts`) by way of `layers.ts#axisLabel`: an axis that rendered
// `1234.5` beside a grid that rendered `1,234.50` for the same field is the drift that file exists to
// prevent.

import type { Rect, Viewport } from './types.js';

/* -------------------------------------------------------------------------------------------- */
/* The value axis: linear and log                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The normalised half of a value axis: domain → `0..1` and back, with no pixel range.
 *
 * This is what `renderer.ts` holds — one per axis per frame, on `AxisRender` — because a renderer owns
 * its own rect arithmetic and composes `plot.y + plot.h * (1 - u)` itself, which is the exact
 * expression every committed pixel golden in `test/chart/renderer.test.ts` was taken through.
 *
 * It is also where the two formulas live, so {@link linearScale} and {@link logScale} are this plus a
 * range rather than a second copy of the arithmetic. And it is **built once per axis**, not per call:
 * the renderer evaluates `unit()` for every tick, every reference rule, every study point and every
 * crosshair read of every frame, and the log branch has two `Math.log10`s that belong outside that
 * loop — this file's predecessor in `renderer.ts#scalesFor` recomputed both on every single call.
 */
export interface UnitScale {
  readonly kind: 'linear' | 'log';
  readonly domain: readonly [number, number];
  /** Value → `0..1` across the domain. */
  unit(v: number): number;
  /** `0..1` → value: the inverse of {@link UnitScale.unit}. */
  value(u: number): number;
}

/**
 * A value → position mapping with an inverse, in both the normalised and the pixel form.
 *
 * `range` is `[pxAtDomain0, pxAtDomain1]` and for a y axis it is *descending* in the canvas' own
 * terms (`[plot.y + plot.h, plot.y]`), because the domain minimum belongs at the bottom. Keeping that
 * in the range rather than in the projection is what lets one implementation serve a y axis and, if a
 * pane ever wants one, an inverted axis.
 */
export interface ValueScale extends UnitScale {
  readonly range: readonly [number, number];
  /** Value → pixel, `unit` composed with `range`. */
  project(v: number): number;
  /** Pixel → value, the inverse of {@link ValueScale.project}. */
  invert(px: number): number;
}

/**
 * The `0..1` mapping of one axis, linear or logarithmic (§11.2).
 *
 * `log` forces the domain positive. A log axis has nothing to say about zero or a negative value, and
 * the caller that can produce one (`renderer.ts#padded`, over a spread series that crossed zero)
 * chooses `linear` instead rather than asking this scale to invent a position — so the clamp below is a
 * backstop, not a path the renderer takes. Base ten rather than natural, because that is the base
 * `renderer.ts#scalesFor` evaluated when it owned this arithmetic: the ratio is base-independent, so
 * that is a statement about which float the committed goldens hold and not about the geometry.
 */
export function unitScale(kind: 'linear' | 'log', domain: readonly [number, number]): UnitScale {
  if (kind === 'log') {
    const hi = Math.max(domain[1], Number.MIN_VALUE);
    // A decade below the top is the floor for a domain whose bottom is not positive: six orders of
    // magnitude of empty axis is not a chart, and clamping is visible where a silent `NaN` is not.
    const lo = domain[0] > 0 ? Math.min(domain[0], hi) : hi / 10;
    const l0 = Math.log10(lo);
    const l1 = Math.log10(hi);
    const span = l1 - l0 || 1;
    return {
      kind: 'log',
      domain: [lo, hi],
      unit: (v) => (Math.log10(v) - l0) / span,
      value: (u) => 10 ** (l0 + u * (l1 - l0)),
    };
  }
  const [lo, hi] = widened(domain[0], domain[1]);
  return {
    kind: 'linear',
    domain: [lo, hi],
    // No `|| 1` guard on the span, unlike the log branch: `widened` has already made `hi > lo` on
    // every path, so the division cannot be by zero. `renderer.ts#scalesFor` carried one before this
    // delegation and it was unreachable for the same reason — `padded` never hands out a flat domain.
    unit: (v) => (v - lo) / (hi - lo),
    value: (u) => lo + u * (hi - lo),
  };
}

/**
 * A domain that cannot be projected (zero span, or a flat series) widened just enough to be one.
 *
 * `renderer.ts#padded` has already done this for an axis it builds — a flat axis arrives as `±0.5`
 * around its level and a non-finite one as `0..1` — so for that caller this is the identity. It is
 * here for `Sparkline`, whose domain is the raw minimum and maximum of a payload's points and is
 * routinely a single value (one observation, or a rate that has not moved).
 */
function widened(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi > lo) return [lo, hi];
  // A flat series — a rate that has not moved, a single point — would otherwise divide by a zero
  // span and project every value to the same pixel or to Infinity. One per cent of the level (or a
  // hair, at zero) is small enough to look flat and wide enough to be arithmetic.
  const pad = Math.max(Math.abs(hi) * 0.01, 1e-6);
  return [hi - pad, hi + pad];
}

/**
 * `LinearScale` (§11.2): the y axis of every price, rate and greek pane, composed with a pixel range.
 *
 * `project` is written out rather than `p0 + (p1 - p0) * unit(v)` because this is the form
 * `screen/widgets/Sparkline.tsx` has always projected through, and an algebraically equal expression
 * is not an equal float in the last bit. `scales.test.ts` asserts the two agree to nine places.
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): ValueScale {
  const base = unitScale('linear', domain);
  const [lo, hi] = base.domain;
  const [p0, p1] = range;
  const scalePx = (p1 - p0) / (hi - lo);
  return {
    ...base,
    range: [p0, p1],
    project: (v) => p0 + (v - lo) * scalePx,
    invert: (px) => lo + (px - p0) / scalePx,
  };
}

/**
 * `LogScale` (§11.2): equal pixel distance for equal percentage move, which is what makes a ten-year
 * chart of a stock that went from 20 to 200 readable at both ends.
 */
export function logScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): ValueScale {
  const base = unitScale('log', domain);
  const [p0, p1] = range;
  return {
    ...base,
    range: [p0, p1],
    // `v <= 0` is `NaN`, not a clamp: a non-positive value has no position on a log axis, and
    // `series.ts`' draw functions already break a path on a non-finite coordinate (§11.3), so the
    // point is dropped rather than drawn somewhere it does not belong.
    project: (v) => (v > 0 ? p0 + (p1 - p0) * base.unit(v) : Number.NaN),
    invert: (px) => base.value((px - p0) / (p1 - p0 || 1)),
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
 * drawn at the *centre* of its band. That half-slot inset is what gives the first and last candle of
 * a view room for its body instead of clipping half of it against the axis gutter, and it is why the
 * inverse subtracts the same half before dividing — a click in the left half of the first bar must
 * hit that bar, not the one before it.
 *
 * The span floors at ONE slot, which is `renderer.ts#slotPxOf`'s floor and now the only one: a
 * viewport narrower than a single slot is a zoom past the point where a slot is a band, and giving it
 * the width of one band is the honest answer. A caller with no data at all gets `slotPx = 0` from a
 * zero-width rect and must not invert through it — see `renderer.ts#slotAtPx`, which guards exactly
 * that case because `0` would divide to `±Infinity`.
 */
export function slotScale(view: Viewport, rect: Pick<Rect, 'x' | 'w'>): SlotScale {
  const span = Math.max(view.slot1 - view.slot0 + 1, 1);
  const slotPx = rect.w / span;
  return {
    slotPx,
    x: (slot) => rect.x + (slot - view.slot0 + 0.5) * slotPx,
    slotAt: (px) => view.slot0 + (px - rect.x) / slotPx - 0.5,
  };
}
