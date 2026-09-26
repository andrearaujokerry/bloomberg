// packages/web/src/chart/series.ts — the twelve marks (CLIENT.md §11.3, CHRT-01).
//
// One draw function per `SeriesType`, collected in `SERIES_DRAWS`, which is a
// `Record<SeriesType, SeriesDraw>` and not a `Partial` of one: CHRT-01 is "every member of the union
// draws", and a `Record` makes a missing member a build failure rather than a blank pane on a
// trader's screen (`types.ts`'s note on `SeriesDrawTable`).
//
// The division of labour with `renderer.ts` is the one `types.ts` fixes, and nothing here crosses
// it. A draw function is handed a context that is already positioned, scaled and clipped to the
// pane, and a `SeriesScales` whose every field is a fact resolved once for the frame — the paint,
// the fonts, the hairline width, the tick quantum. So there is no theme lookup, no
// `getComputedStyle`, no DOM and no dirty-region arithmetic in this file; it puts ink down.
//
// **The x values in `series.x` are slots, not timestamps.** The renderer rebases every series onto
// the `TradingDayIndex` before it calls a draw function, which is what makes `scales.x(slot)` the
// only x mapping any of these need and what collapses nights, weekends and holidays for all twelve
// at once (§11.2). Two consequences are visible below: `pnf` builds its own category axis of columns
// because a P&F column is not a slot, and `profile` counts 30-minute TPO periods in slots
// (`TPO_PERIOD_SLOTS`), which is exact for the one-minute bars GIP streams and is the one place the
// lost bar interval still shows — noted where it is used.
//
// The visible-point loops are `O(points)`, not `O(pixels)`: they test every point against the
// viewport rather than binary-searching into it. That is deliberate and it is not the CHRT-02 claim
// being quietly dropped — `downsample.ts` (§11.4) is what reduces a million-point series to one
// column per pixel before it reaches here, and a draw function that also tried to be the
// downsampler would be two answers to the same question.

import type {
  ChartSeries,
  SeriesData,
  SeriesDraw,
  SeriesDrawTable,
  SeriesScales,
  Viewport,
} from './types.js';

/* -------------------------------------------------------------------------------------------- */
/* Shared primitives                                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * One element of a spec column, as a number.
 *
 * `ChartSeries.x`/`y` are `Float64Array | number[]` (the screens build both) and
 * `noUncheckedIndexedAccess` types every element as possibly `undefined`. A missing element is a gap,
 * which is what `NaN` already means throughout the engine (§11.2), so the two collapse here rather
 * than at twelve call sites.
 */
const at = (column: SeriesData, i: number): number => column[i] ?? Number.NaN;

/**
 * The index range whose points can affect the plot: the visible points, widened by one either side.
 *
 * Widened because a polyline has to enter and leave the plot. Without the neighbours, a view showing
 * the middle of a series would draw a line that starts at the first visible bar instead of at the
 * edge of the pane, and the eye reads that as data beginning there.
 */
function indexRange(x: SeriesData, view: Viewport): [number, number] {
  const n = x.length;
  let from = -1;
  let to = -1;
  for (let i = 0; i < n; i += 1) {
    const slot = at(x, i);
    if (slot >= view.slot0 && slot <= view.slot1) {
      if (from < 0) from = i;
      to = i;
    }
  }
  if (from < 0) return [0, -1];
  return [Math.max(0, from - 1), Math.min(n - 1, to + 1)];
}

/** `style.width` and `style.dashed` applied to the stroke (§11.3 "width/dash from `style`"). */
function applyStroke(ctx: CanvasRenderingContext2D, scales: SeriesScales, series: ChartSeries): void {
  ctx.strokeStyle = scales.paint.line;
  ctx.lineWidth = series.style?.width ?? Math.max(scales.hairline, 1);
  ctx.setLineDash(series.style?.dashed === true ? [3, 3] : []);
}

/**
 * The polyline path for `[from, to]`, in `step-after` or straight form; `true` when it has a segment.
 *
 * `NaN` breaks the path rather than being skipped over: a series with a missing day is two lines with
 * a hole, not one line drawn through the hole, and drawing through it would invent a price that was
 * never printed (§11.2 "a series without a point at a slot is drawn with a gap").
 */
function buildPath(
  ctx: CanvasRenderingContext2D,
  scales: SeriesScales,
  series: ChartSeries,
  from: number,
  to: number,
  step: boolean,
): boolean {
  ctx.beginPath();
  let open = false;
  let drew = false;
  let prevPx = 0;
  let prevPy = 0;
  for (let i = from; i <= to; i += 1) {
    const v = at(series.y, i);
    if (!Number.isFinite(v)) {
      open = false;
      continue;
    }
    const px = scales.x(at(series.x, i));
    const py = scales.y(v);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      open = false;
      continue;
    }
    if (!open) {
      ctx.moveTo(px, py);
      open = true;
    } else if (step) {
      // step-after: the previous value holds until this x, then jumps. Rates and econ vintages are
      // step functions of time — a value is in force until it is replaced — and a sloped line
      // between two prints would show a rate that was never quoted (§11.3 `step`).
      ctx.lineTo(px, prevPy);
      ctx.lineTo(px, py);
      drew = true;
    } else {
      ctx.lineTo(px, py);
      drew = true;
    }
    prevPx = px;
    prevPy = py;
  }
  // A single visible point is still something a trader must be able to see (a curve with one node, a
  // new listing's first print), so it is stamped rather than dropped.
  if (!drew && open) {
    ctx.lineTo(prevPx + Math.max(scales.hairline, 1), prevPy);
    drew = true;
  }
  return drew;
}

/** `line`, and the spine of `area`/`mountain`. */
const drawLine: SeriesDraw = (ctx, scales, view, series) => {
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  ctx.save();
  applyStroke(ctx, scales, series);
  if (buildPath(ctx, scales, series, from, to, false)) ctx.stroke();
  ctx.restore();
};

/** `step` — the same path, `step-after` (§11.3). */
const drawStep: SeriesDraw = (ctx, scales, view, series) => {
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  ctx.save();
  applyStroke(ctx, scales, series);
  if (buildPath(ctx, scales, series, from, to, true)) ctx.stroke();
  ctx.restore();
};

/**
 * The fill under a line, closed down to the axis baseline.
 *
 * Built as its own path so the gaps stay gaps: a fill that closed across a hole would shade an area
 * under prices that do not exist. Each run of finite points is filled separately.
 */
function fillUnder(
  ctx: CanvasRenderingContext2D,
  scales: SeriesScales,
  series: ChartSeries,
  from: number,
  to: number,
  paint: string | CanvasGradient,
): void {
  ctx.fillStyle = paint;
  let runStart = -1;
  const flush = (end: number): void => {
    if (runStart < 0 || end <= runStart) {
      runStart = -1;
      return;
    }
    ctx.beginPath();
    ctx.moveTo(scales.x(at(series.x, runStart)), scales.baselinePx);
    for (let i = runStart; i <= end; i += 1) {
      ctx.lineTo(scales.x(at(series.x, i)), scales.y(at(series.y, i)));
    }
    ctx.lineTo(scales.x(at(series.x, end)), scales.baselinePx);
    ctx.closePath();
    ctx.fill();
    runStart = -1;
  };
  for (let i = from; i <= to; i += 1) {
    if (Number.isFinite(at(series.y, i))) {
      if (runStart < 0) runStart = i;
      continue;
    }
    flush(i - 1);
  }
  flush(to);
}

/** `area` — the line plus a flat fill at alpha 0.18 (§11.3). */
const drawArea: SeriesDraw = (ctx, scales, view, series) => {
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  ctx.save();
  ctx.setLineDash([]);
  fillUnder(ctx, scales, series, from, to, scales.paint.fill);
  ctx.restore();
  drawLine(ctx, scales, view, series);
};

/** `mountain` — the Bloomberg mountain: the same fill, graded from the line's hue to transparent. */
const drawMountain: SeriesDraw = (ctx, scales, view, series) => {
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  ctx.save();
  ctx.setLineDash([]);
  const gradient = ctx.createLinearGradient(0, scales.plot.y, 0, scales.baselinePx);
  gradient.addColorStop(0, scales.paint.fill);
  gradient.addColorStop(1, scales.paint.fillTo);
  fillUnder(ctx, scales, series, from, to, gradient);
  ctx.restore();
  drawLine(ctx, scales, view, series);
};

/** The width of one bar or candle body, leaving a gap between neighbours. */
function bodyWidth(scales: SeriesScales): number {
  return Math.max(1, Math.min(scales.slotPx * 0.7, 24));
}

/**
 * `candle` — body and wicks; in light theme an up candle is hollow (§11.3).
 *
 * Hollow up-candles are not decoration: on paper and on a light screen a filled light-green body and
 * a filled red body have similar weight, and the outline is what makes direction readable at a glance
 * at one pixel per bar. `SeriesPaint.hollowUp` carries the decision so this function never asks the
 * document which theme is current (`types.ts`, §16.1).
 */
const drawCandle: SeriesDraw = (ctx, scales, view, series) => {
  const ohlc = series.ohlc;
  if (ohlc === undefined) return;
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  const w = bodyWidth(scales);
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = Math.max(scales.hairline, 1);
  for (let i = from; i <= to; i += 1) {
    const o = at(ohlc.o, i);
    const h = at(ohlc.h, i);
    const l = at(ohlc.l, i);
    const c = at(ohlc.c, i);
    if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
    const x = scales.x(at(series.x, i));
    const up = c >= o;
    const colour = up ? scales.paint.up : scales.paint.down;
    ctx.strokeStyle = colour;
    ctx.fillStyle = colour;
    if (Number.isFinite(h) && Number.isFinite(l)) {
      ctx.beginPath();
      const wx = Math.round(x) + 0.5;
      ctx.moveTo(wx, scales.y(h));
      ctx.lineTo(wx, scales.y(l));
      ctx.stroke();
    }
    const yo = scales.y(o);
    const yc = scales.y(c);
    const top = Math.min(yo, yc);
    // A doji (open === close) has no body height; it still has to be a mark, so it is a one-pixel rule.
    const height = Math.max(Math.abs(yc - yo), Math.max(scales.hairline, 1));
    if (up && scales.paint.hollowUp) {
      ctx.strokeRect(Math.round(x - w / 2) + 0.5, Math.round(top) + 0.5, w, height);
    } else {
      ctx.fillRect(x - w / 2, top, w, height);
    }
  }
  ctx.restore();
};

/** `ohlc` — tick bars: the vertical range, open as a left tick, close as a right tick (§11.3). */
const drawOhlc: SeriesDraw = (ctx, scales, view, series) => {
  const ohlc = series.ohlc;
  if (ohlc === undefined) return;
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  const tickLen = Math.max(1, Math.min(scales.slotPx * 0.4, 10));
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = Math.max(scales.hairline, 1);
  for (let i = from; i <= to; i += 1) {
    const o = at(ohlc.o, i);
    const h = at(ohlc.h, i);
    const l = at(ohlc.l, i);
    const c = at(ohlc.c, i);
    const x = Math.round(scales.x(at(series.x, i))) + 0.5;
    ctx.strokeStyle = c >= o ? scales.paint.up : scales.paint.down;
    ctx.beginPath();
    if (Number.isFinite(h) && Number.isFinite(l)) {
      ctx.moveTo(x, scales.y(h));
      ctx.lineTo(x, scales.y(l));
    }
    if (Number.isFinite(o)) {
      const yo = Math.round(scales.y(o)) + 0.5;
      ctx.moveTo(x - tickLen, yo);
      ctx.lineTo(x, yo);
    }
    if (Number.isFinite(c)) {
      const yc = Math.round(scales.y(c)) + 0.5;
      ctx.moveTo(x, yc);
      ctx.lineTo(x + tickLen, yc);
    }
    ctx.stroke();
  }
  ctx.restore();
};

/**
 * `bar` — vertical bars from the baseline (volume, econ).
 *
 * §11.3 colours a bar "by `dir` of the paired series or neutral". The `SeriesDraw` seam is handed one
 * series, so the pairing is only available when the series carries its own `ohlc` (then the bar is
 * coloured by that bar's own direction, which is what a volume series with bars does); otherwise the
 * bar is neutral, which is the spec's own second option. Colouring GP's volume pane by the price
 * pane's direction needs the pair named on the resolved series, and that is a field `ChartSpec` does
 * not have — a change to the spec type, not a guess here.
 */
const drawBar: SeriesDraw = (ctx, scales, view, series) => {
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  const w = bodyWidth(scales);
  const ohlc = series.ohlc;
  ctx.save();
  ctx.setLineDash([]);
  for (let i = from; i <= to; i += 1) {
    const v = at(series.y, i);
    if (!Number.isFinite(v)) continue;
    const x = scales.x(at(series.x, i));
    const y = scales.y(v);
    if (ohlc === undefined) {
      ctx.fillStyle = scales.paint.neutral;
    } else {
      ctx.fillStyle = at(ohlc.c, i) >= at(ohlc.o, i) ? scales.paint.up : scales.paint.down;
    }
    const top = Math.min(y, scales.baselinePx);
    const height = Math.max(Math.abs(scales.baselinePx - y), Math.max(scales.hairline, 1));
    ctx.fillRect(x - w / 2, top, w, height);
  }
  ctx.restore();
};

/** The side of a `scatter` square, in CSS px (§11.3 "3 px squares"). */
export const SCATTER_PX = 3;

/** `scatter` — 3 px squares: event studies, curve input points, the OMON smile. */
const drawScatter: SeriesDraw = (ctx, scales, view, series) => {
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = scales.paint.line;
  const half = SCATTER_PX / 2;
  for (let i = from; i <= to; i += 1) {
    const v = at(series.y, i);
    if (!Number.isFinite(v)) continue;
    const x = scales.x(at(series.x, i));
    const y = scales.y(v);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    ctx.fillRect(Math.round(x - half), Math.round(y - half), SCATTER_PX, SCATTER_PX);
  }
  ctx.restore();
};

/** The largest dot a `tick` print draws, in CSS px radius. */
const TICK_DOT_MAX_PX = 3;

/**
 * `tick` — last-trade prints as a step line with size-scaled dots (Q/GIP tick mode, §11.3).
 *
 * A print holds until the next one, so the line is `step-after` like `step`; the dot area carries the
 * size, because a 100-share print and a 50 000-share print at the same price are not the same event
 * and a plain line makes them identical. The scale is the visible maximum, so zooming into a quiet
 * stretch keeps the sizes readable instead of collapsing them all to one pixel.
 */
const drawTick: SeriesDraw = (ctx, scales, view, series) => {
  const [from, to] = indexRange(series.x, view);
  if (to < from) return;
  drawStep(ctx, scales, view, series);
  const volume = series.volume;
  if (volume === undefined) return;
  let peak = 0;
  for (let i = from; i <= to; i += 1) {
    const v = at(volume, i);
    if (Number.isFinite(v) && v > peak) peak = v;
  }
  if (peak <= 0) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = scales.paint.line;
  for (let i = from; i <= to; i += 1) {
    const y = at(series.y, i);
    const size = at(volume, i);
    if (!Number.isFinite(y) || !Number.isFinite(size) || size <= 0) continue;
    // Area, not radius, carries the size: a radius proportional to volume exaggerates a large print
    // by its square, which is the classic bubble-chart lie.
    const r = Math.max(1, Math.sqrt(size / peak) * TICK_DOT_MAX_PX);
    ctx.beginPath();
    ctx.arc(scales.x(at(series.x, i)), scales.y(y), r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

/* -------------------------------------------------------------------------------------------- */
/* Point and figure (§11.3 `pnf`)                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** §11.3's reversal default: three boxes against the column starts a new one. */
export const PNF_REVERSAL = 3;

/** How many true ranges the default box size averages (§11.3 `ATR(14)/2`). */
export const PNF_ATR_WINDOW = 14;

/**
 * One point-and-figure column: a direction and the inclusive band of boxes it fills.
 *
 * Box **indices**, not prices, because that is what the algorithm compares: a column extends when the
 * close reaches the next whole box and reverses after three whole boxes against it, and doing that
 * arithmetic in prices accumulates rounding until a column gains or loses a box.
 */
export interface PnfColumn {
  readonly dir: 1 | -1;
  readonly loBox: number;
  readonly hiBox: number;
}

/**
 * The columns of a point-and-figure chart from a close series (§11.3, `series.ts#pnfColumns`).
 *
 * Close-only construction, which is the convention a close series admits: a column extends while the
 * close makes a new box in its direction, and reverses when the close retraces `reversal` boxes,
 * whereupon the new column starts one box back from the old column's extreme. Time is gone by
 * construction — a quiet month adds no column — which is the whole point of the chart type and the
 * reason it is drawn on a category axis of columns rather than on the slot axis.
 *
 * **No reference implementation.** §11.3 records this as a gap: the columns are not golden-tested
 * against another vendor's P&F, so what is asserted is the algorithm's own invariants (direction
 * alternates, every column is at least one box, a reversal starts one box inside the previous
 * extreme) rather than agreement with a number from elsewhere.
 */
export function pnfColumns(
  closes: SeriesData,
  boxSize: number,
  reversal: number = PNF_REVERSAL,
): PnfColumn[] {
  const out: PnfColumn[] = [];
  if (!(boxSize > 0)) return out;
  const step = Math.max(1, Math.floor(reversal));
  let dir: 1 | -1 | 0 = 0;
  let lo = Number.NaN;
  let hi = Number.NaN;
  const push = (): void => {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    out.push({ dir: dir === -1 ? -1 : 1, loBox: lo, hiBox: hi });
  };
  for (let i = 0; i < closes.length; i += 1) {
    const price = at(closes, i);
    if (!Number.isFinite(price)) continue;
    const box = Math.floor(price / boxSize);
    if (!Number.isFinite(lo)) {
      lo = box;
      hi = box;
      continue;
    }
    if (dir === 1) {
      if (box > hi) hi = box;
      else if (box <= hi - step) {
        push();
        dir = -1;
        lo = box;
        hi = hi - 1;
      }
      continue;
    }
    if (dir === -1) {
      if (box < lo) lo = box;
      else if (box >= lo + step) {
        push();
        dir = 1;
        hi = box;
        lo = lo + 1;
      }
      continue;
    }
    if (box > hi) {
      dir = 1;
      hi = box;
    } else if (box < lo) {
      dir = -1;
      lo = box;
    }
  }
  push();
  return out;
}

/**
 * The default P&F box size: the mean true range over `PNF_ATR_WINDOW` bars, halved and rounded to a
 * tick (§11.3 `ATR(14)/2`).
 *
 * The true range is computed here rather than imported because `studies/ATR.ts` is the *study* — it
 * produces a `Float64Array` per slot for a sub pane, and a box size is one scalar over the whole
 * series. When that study lands, the honest arrangement is for the renderer to pass its last value in
 * and for this function to become the fallback for a series with no `ohlc`; the definition below is
 * the same true range (`max(h−l, |h−prevClose|, |l−prevClose|)`) so the two cannot disagree about
 * what a range is. A series without `ohlc` falls back to mean absolute close-to-close change, which
 * is the only range a close series has.
 */
export function pnfBoxSize(series: ChartSeries, tick: number): number {
  const quantum = tick > 0 ? tick : 0.01;
  const ohlc = series.ohlc;
  const n = ohlc?.c.length ?? series.y.length;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, n - PNF_ATR_WINDOW); i < n; i += 1) {
    let range: number;
    if (ohlc === undefined) {
      range = Math.abs(at(series.y, i) - at(series.y, i - 1));
    } else {
      const prev = at(ohlc.c, i - 1);
      range = Math.max(
        at(ohlc.h, i) - at(ohlc.l, i),
        Math.abs(at(ohlc.h, i) - prev),
        Math.abs(at(ohlc.l, i) - prev),
      );
    }
    if (Number.isFinite(range)) {
      sum += range;
      count += 1;
    }
  }
  const half = count > 0 ? sum / count / 2 : quantum;
  return Math.max(quantum, Math.round(half / quantum) * quantum);
}

/**
 * `pnf` — X/O glyphs on a category axis of columns (§11.3).
 *
 * The columns are laid across the plot rect directly instead of through `scales.x`, because a P&F
 * column is not a slot: the x-axis of a P&F chart is the column ordinal, and mapping it onto the time
 * axis would put the columns wherever the calendar happened to leave room. `scales.y` is still the
 * price axis, so the boxes line up with the y labels and a level can be read off.
 */
const drawPnf: SeriesDraw = (ctx, scales, _view, series) => {
  const box = pnfBoxSize(series, scales.tick);
  const columns = pnfColumns(series.y, box);
  if (columns.length === 0 || scales.plot.w <= 0) return;
  const colW = Math.max(2, Math.min(scales.plot.w / columns.length, 12));
  const boxPx = Math.abs(scales.y(box) - scales.y(0)) || Math.max(2, colW);
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = Math.max(scales.hairline, 1);
  columns.forEach((column, index) => {
    const cx = scales.plot.x + (index + 0.5) * colW;
    if (cx > scales.plot.x + scales.plot.w) return;
    ctx.strokeStyle = column.dir === 1 ? scales.paint.up : scales.paint.down;
    for (let b = column.loBox; b <= column.hiBox; b += 1) {
      const top = scales.y((b + 1) * box);
      const height = Math.max(2, boxPx);
      const inset = Math.min(colW, height) * 0.2;
      ctx.beginPath();
      if (column.dir === 1) {
        ctx.moveTo(cx - colW / 2 + inset, top + inset);
        ctx.lineTo(cx + colW / 2 - inset, top + height - inset);
        ctx.moveTo(cx + colW / 2 - inset, top + inset);
        ctx.lineTo(cx - colW / 2 + inset, top + height - inset);
      } else {
        ctx.ellipse(
          cx,
          top + height / 2,
          Math.max(1, colW / 2 - inset),
          Math.max(1, height / 2 - inset),
          0,
          0,
          Math.PI * 2,
        );
      }
      ctx.stroke();
    }
  });
  ctx.restore();
};

/* -------------------------------------------------------------------------------------------- */
/* Market profile (§11.3 `profile`)                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * The TPO period, in slots.
 *
 * §11.3's periods are 30 minutes, and the resolved series carries slots rather than timestamps, so
 * the period is 30 slots — exact for the one-minute bars GIP's `b1m:` subject streams, which is the
 * case §11.3 ships (`TYPE=PROFILE` on 1-/5-day ranges). A five-minute series would need six, and the
 * bar interval is not on the `SeriesDraw` seam; the fix is the interval on the resolved series rather
 * than a guess from the data here, and it is recorded as such.
 */
export const TPO_PERIOD_SLOTS = 30;

/** The share of TPOs inside the value area — the market-profile convention (§11.3). */
export const VALUE_AREA_SHARE = 0.7;

/** One price row of a market profile: its value band, the periods that traded in it, and the count. */
export interface ProfileRow {
  readonly loV: number;
  readonly hiV: number;
  readonly letters: string;
  readonly count: number;
}

/** A market profile: rows bottom-up, the point of control, and the value area (§11.3). */
export interface ProfileResult {
  readonly rows: ProfileRow[];
  /** Index into `rows` of the row with the most TPOs; `-1` when there are none. */
  readonly pocIndex: number;
  readonly valueArea: { readonly lo: number; readonly hi: number };
}

/**
 * The TPO letters, the POC and the value area of the visible intraday bars (§11.3).
 *
 * One letter per period per price row — a period that traded through a row leaves one mark there
 * however many of its bars did, which is what a TPO counts. Row height comes from the text line
 * height, because a row that cannot fit its letters is not a row a trader can read.
 */
export function profileTpo(
  series: ChartSeries,
  scales: SeriesScales,
  view: Viewport,
  slotsPerPeriod: number = TPO_PERIOD_SLOTS,
): ProfileResult {
  const ohlc = series.ohlc;
  const empty: ProfileResult = { rows: [], pocIndex: -1, valueArea: { lo: Number.NaN, hi: Number.NaN } };
  if (ohlc === undefined || scales.plot.h <= 0) return empty;
  const [from, to] = indexRange(series.x, view);
  if (to < from) return empty;

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = from; i <= to; i += 1) {
    const l = at(ohlc.l, i);
    const h = at(ohlc.h, i);
    if (Number.isFinite(l) && l < lo) lo = l;
    if (Number.isFinite(h) && h > hi) hi = h;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return empty;

  const rowCount = Math.max(1, Math.floor(scales.plot.h / Math.max(6, scales.fonts.lineHeightPx)));
  const bandV = (hi - lo) / rowCount;
  const marks: Set<number>[] = Array.from({ length: rowCount }, () => new Set<number>());
  const base = Math.floor(view.slot0);
  for (let i = from; i <= to; i += 1) {
    const l = at(ohlc.l, i);
    const h = at(ohlc.h, i);
    if (!Number.isFinite(l) || !Number.isFinite(h)) continue;
    const period = Math.max(0, Math.floor((at(series.x, i) - base) / Math.max(1, slotsPerPeriod)));
    const fromRow = Math.max(0, Math.floor((l - lo) / bandV));
    const toRow = Math.min(rowCount - 1, Math.floor((h - lo) / bandV));
    for (let r = fromRow; r <= toRow; r += 1) marks[r]?.add(period);
  }

  const rows: ProfileRow[] = marks.map((set, r) => ({
    loV: lo + r * bandV,
    hiV: lo + (r + 1) * bandV,
    letters: [...set]
      .sort((a, b) => a - b)
      .map((p) => String.fromCharCode(65 + (p % 26)))
      .join(''),
    count: set.size,
  }));

  let pocIndex = -1;
  let best = 0;
  let total = 0;
  rows.forEach((row, r) => {
    total += row.count;
    if (row.count > best) {
      best = row.count;
      pocIndex = r;
    }
  });
  if (pocIndex < 0) return { rows, pocIndex, valueArea: { lo: Number.NaN, hi: Number.NaN } };

  // The value area grows outwards from the POC, always taking the fuller of the two neighbours, until
  // it holds 70 % of the TPOs — the standard construction, and the reason it is not simply a quantile
  // of price: it is a quantile of *time spent*.
  let below = pocIndex;
  let above = pocIndex;
  let held = rows[pocIndex]?.count ?? 0;
  const target = total * VALUE_AREA_SHARE;
  while (held < target && (below > 0 || above < rows.length - 1)) {
    const next = rows[below - 1]?.count ?? -1;
    const prev = rows[above + 1]?.count ?? -1;
    if (next >= prev && below > 0) {
      below -= 1;
      held += rows[below]?.count ?? 0;
    } else if (above < rows.length - 1) {
      above += 1;
      held += rows[above]?.count ?? 0;
    } else break;
  }
  return {
    rows,
    pocIndex,
    valueArea: { lo: rows[below]?.loV ?? lo, hi: rows[above]?.hiV ?? hi },
  };
}

/** `profile` — the TPO letters, the POC rule and the value-area bounds (§11.3). */
const drawProfile: SeriesDraw = (ctx, scales, view, series) => {
  const profile = profileTpo(series, scales, view);
  if (profile.rows.length === 0) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = scales.fonts.label;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = scales.paint.muted;
  for (const row of profile.rows) {
    if (row.letters === '') continue;
    const y = (scales.y(row.loV) + scales.y(row.hiV)) / 2;
    ctx.fillText(row.letters, scales.plot.x + 2, y);
  }
  const poc = profile.rows[profile.pocIndex];
  if (poc !== undefined) {
    ctx.strokeStyle = scales.paint.line;
    ctx.lineWidth = Math.max(scales.hairline, 1);
    const y = Math.round((scales.y(poc.loV) + scales.y(poc.hiV)) / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(scales.plot.x, y);
    ctx.lineTo(scales.plot.x + scales.plot.w, y);
    ctx.stroke();
  }
  if (Number.isFinite(profile.valueArea.lo) && Number.isFinite(profile.valueArea.hi)) {
    ctx.strokeStyle = scales.paint.muted;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    for (const v of [profile.valueArea.lo, profile.valueArea.hi]) {
      const y = Math.round(scales.y(v)) + 0.5;
      ctx.moveTo(scales.plot.x, y);
      ctx.lineTo(scales.plot.x + scales.plot.w, y);
    }
    ctx.stroke();
  }
  ctx.restore();
};

/* -------------------------------------------------------------------------------------------- */
/* Heatmap (§11.3 `heatmap`)                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * `heatmap` — category × category cells on a sequential scale (§11.3).
 *
 * `x` is the column index, `y` is the row index and `volume` is the value, which is the contract
 * §11.3 fixes for the OMON smile surface and the OVML scenario grid. The cell colour is
 * `paint.ramp(t)` with `t` the value's position between the visible minimum and maximum: the domain
 * is computed here because `ChartSpec` has no field for a heatmap's value range, so the alternative
 * is not "the spec's domain" but "no domain at all". A degenerate range (one value, or all equal)
 * colours every cell at the middle of the ramp rather than at an end, because an extreme colour on a
 * flat surface would read as an extreme value.
 */
const drawHeatmap: SeriesDraw = (ctx, scales, view, series) => {
  const values = series.volume;
  if (values === undefined) return;
  const n = Math.min(series.x.length, series.y.length, values.length);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    const slot = at(series.x, i);
    if (slot < view.slot0 || slot > view.slot1) continue;
    const v = at(values, i);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return;
  const span = hi - lo;
  ctx.save();
  ctx.setLineDash([]);
  for (let i = 0; i < n; i += 1) {
    const slot = at(series.x, i);
    if (slot < view.slot0 || slot > view.slot1) continue;
    const row = at(series.y, i);
    const v = at(values, i);
    if (!Number.isFinite(row) || !Number.isFinite(v)) continue;
    const x = scales.x(slot) - scales.slotPx / 2;
    const y0 = scales.y(row);
    const y1 = scales.y(row + 1);
    const top = Math.min(y0, y1);
    const height = Math.max(1, Math.abs(y1 - y0));
    ctx.fillStyle = scales.paint.ramp(span > 0 ? (v - lo) / span : 0.5);
    ctx.fillRect(x, top, Math.max(1, scales.slotPx), height);
  }
  ctx.restore();
};

/* -------------------------------------------------------------------------------------------- */
/* The table (§11.3, CHRT-01)                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The twelve draw functions, in the order §11.3 tabulates them.
 *
 * `renderer.ts` indexes this by `ChartSeries.type` and calls one per visible series per frame. A
 * thirteenth `SeriesType` added to the union in `screen/types.ts` fails to compile here, which is the
 * point (`types.ts`'s note on `SeriesDrawTable`).
 */
export const SERIES_DRAWS: SeriesDrawTable = Object.freeze({
  line: drawLine,
  area: drawArea,
  mountain: drawMountain,
  candle: drawCandle,
  ohlc: drawOhlc,
  bar: drawBar,
  step: drawStep,
  scatter: drawScatter,
  tick: drawTick,
  pnf: drawPnf,
  profile: drawProfile,
  heatmap: drawHeatmap,
});
