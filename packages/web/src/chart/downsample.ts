// packages/web/src/chart/downsample.ts — how a million points become a few hundred columns of ink.
//
// CLIENT.md §11.4, CHRT-02. A canvas 900 px wide has 900 columns of pixels, and a ten-year daily
// chart has 2 500 points: stroking all of them means 1 600 `lineTo` calls that land on a pixel some
// other call already painted. At CHRT-02's million-point budget it means a frame that misses by two
// orders of magnitude. So when there are more than two points per pixel column, each column is
// reduced to the few points that decide what that column looks like, and the draw stays O(pixels).
//
// **M4, not "every nth point"** (§11.4). Decimation by stride is the reduction that ships in most
// charts and it is the one a trader notices: a spike that lasted one bar sits between two kept
// points and vanishes, so a chart of a flash crash draws as a calm afternoon. M4 keeps, per column,
// the **first, the minimum, the maximum and the last** — at most four points where a column might
// have had thousands — and because the minimum and maximum of every column survive, the silhouette
// of the reduced line is pixel-identical to the silhouette of the full one. That property is what
// `downsample.test.ts` asserts, and it is the whole reason this file is not a one-liner.
//
// Bars reduce the same way but into a bar: the column shows a range candle (first open, highest
// high, lowest low, last close), which is exactly what a weekly candle is. Scatter and tick cap at
// eight points per column, because a column that has already drawn eight 3 px squares cannot show a
// ninth, and the extremes are kept first so the cap never clips the shape.
//
// **Gaps survive, below one pixel they do not.** A column with no finite point emits a single `NaN`,
// which breaks the line where the hole is. A column that holds both a gap and data emits its
// extremes and no break: the break would be less than a pixel wide — invisible — and buying it would
// cost the column's high and low, which are not.
//
// **The cache** is keyed by `(seriesId, slot0, slot1, width)` (§11.4) with an LRU bound, because a
// drag pans through a new key every frame and an unbounded cache of typed arrays is a leak with a
// nice name. `invalidateLastColumn` is the streaming path: the forming bar rewrites the last slot
// several times a second (§11.5) while nothing to its left changes, so only the final column is
// recomputed, in place, over the same buffers. An append that adds a slot and drags the viewport
// with it is a different key and a fresh reduction — the right answer, since every column moved.

import type { SeriesData, Viewport } from './types.js';
import type { TradingDayIndex } from './tradingDayIndex.js';
import { GAP } from './tradingDayIndex.js';

/** §11.4: reduce once the visible points exceed this many per pixel of plot width. */
export const POINTS_PER_PIXEL_TRIGGER = 2;

/** §11.4: `scatter` and `tick` keep at most this many points per column. */
export const SCATTER_COLUMN_CAP = 8;

/** M4 keeps first, min, max and last. */
const M4_PER_COLUMN = 4;

/**
 * Slots scanned by every reduction since the module loaded (§11.4).
 *
 * The cost of a reduction is the number of slots it walks, and `chart.bench.ts` asserts the three
 * properties that decide whether a chart gets slower the longer it stays open: a repeated viewport
 * must scan NOTHING (the cache hit), a pan must be ONE pass and not a multiple of the series, and
 * `invalidateLastColumn` must scan one column rather than the chart. Those used to be measured by
 * spying on `TradingDayIndex#indexAt`, which counted a slot because the scan happened to look one
 * up per point — so hoisting that lookup out of the loop silently zeroed the instrument while every
 * property it guarded still held. A counter the reduction owns cannot be invalidated by changing
 * how a slot is read, which is the point of putting it here.
 *
 * It is incremented from the scan BOUNDS rather than per iteration, so it costs nothing on a
 * million-point path: each loop below visits `to - from + 1` slots exactly once, and a path that
 * scanned the same range twice would report twice, which is the regression the bench looks for.
 */
let slotsScannedTotal = 0;

/** Slots scanned so far. Tests read the DELTA across a call; nothing in the product reads it. */
export function slotsScanned(): number {
  return slotsScannedTotal;
}

/** `Float64Array[i]` is `number | undefined` under `noUncheckedIndexedAccess`; absent is a gap. */
function at(xs: SeriesData, i: number): number {
  return xs[i] ?? Number.NaN;
}

/**
 * Is the series dense enough to be worth reducing? (§11.4)
 *
 * Below the threshold the full series is drawn, because reduction is not free and four points per
 * column is more points than the column had. The comparison is strict so that exactly two points
 * per pixel — a chart that fits — is drawn whole.
 */
export function shouldReduce(visiblePoints: number, widthPx: number): boolean {
  return visiblePoints > POINTS_PER_PIXEL_TRIGGER * widthPx;
}

/** What identifies a reduction: a series, a viewport and a width (§11.4's cache key). */
export interface ReduceRequest {
  readonly seriesId: string;
  readonly index: TradingDayIndex;
  readonly view: Viewport;
  /** The plot width in CSS pixels. */
  readonly width: number;
}

/**
 * A reduced line: parallel slot and value columns, `length` of them, `NaN` where a gap survives.
 *
 * The arrays are **views over buffers the reduction owns**, not copies. A draw function reads them
 * inside the frame it asked for them and that is all they are for; a caller that wants to keep one
 * across a `DownsampleCache.invalidateLastColumn` — which rewrites the tail of those same buffers in
 * place, which is the point of it — must `slice`. Copying here instead would allocate a megabyte per
 * series per frame to defend against a mistake no frame path makes.
 */
export interface ReducedPoints {
  readonly length: number;
  readonly slot: Float64Array;
  readonly y: Float64Array;
}

/** A reduced bar series: one range candle per column. */
export interface ReducedBars {
  readonly length: number;
  readonly slot: Float64Array;
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
}

/** The four columns a candle or OHLC series reduces from. */
export interface BarSource {
  readonly o: SeriesData;
  readonly h: SeriesData;
  readonly l: SeriesData;
  readonly c: SeriesData;
}

/** The pixel columns of a viewport, and which one a slot falls in. */
interface ColumnPlan {
  readonly columns: number;
  readonly from: number;
  readonly to: number;
  col(slot: number): number;
}

function planOf(req: ReduceRequest): ColumnPlan {
  const columns = Math.max(1, Math.floor(req.width));
  const span = Math.max(req.view.slot1 - req.view.slot0 + 1, 1e-9);
  const from = Math.max(0, Math.ceil(req.view.slot0));
  const to = Math.min(req.index.length - 1, Math.floor(req.view.slot1));
  return {
    columns,
    from,
    to,
    col: (slot) =>
      Math.min(columns - 1, Math.max(0, Math.floor(((slot - req.view.slot0) / span) * columns))),
  };
}

/** Where a reduction's final column starts, so the streaming path can rewrite only that. */
interface Tail {
  readonly length: number;
  readonly lastColumnStart: number;
  readonly lastColumnSlot0: number;
}

/* -------------------------------------------------------------------------------------------- */
/* M4                                                                                             */
/* -------------------------------------------------------------------------------------------- */

interface PointBuffers {
  readonly slot: Float64Array;
  readonly y: Float64Array;
}

function pointBuffers(columns: number, perColumn: number): PointBuffers {
  // One spare column's worth of slack: `invalidateLastColumn` rewrites the final column in place,
  // and a forming bar that turns a one-point column into a four-point one must not reallocate.
  const capacity = columns * perColumn + perColumn;
  return { slot: new Float64Array(capacity), y: new Float64Array(capacity) };
}

/**
 * M4 over `[from, to]`, written into `out` at `writeAt` (§11.4).
 *
 * The range and the write offset are parameters rather than fixtures of the whole viewport because
 * the same loop serves both callers: a full reduction runs it over the viewport at offset 0, and
 * `invalidateLastColumn` runs it over the final column alone at that column's own offset. One
 * implementation means the incremental path cannot disagree with the full one about what the last
 * column contains — a class of bug that shows up as a chart whose right-hand edge is subtly wrong
 * until something forces a full redraw.
 */
function m4Into(
  req: ReduceRequest,
  plan: ColumnPlan,
  ys: SeriesData,
  out: PointBuffers,
  from: number,
  to: number,
  writeAt: number,
): Tail {
  let n = writeAt;
  let column = -1;
  let columnFirstSlot = from;
  let lastColumnStart = writeAt;
  let lastColumnSlot0 = from;

  let sawFinite = false;
  let firstSlot = 0;
  let firstY = 0;
  let lastSlot = 0;
  let lastY = 0;
  let minSlot = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxSlot = 0;
  let maxY = Number.NEGATIVE_INFINITY;

  const emit = (slot: number, y: number): void => {
    // Deduplicated by slot: in a sparse column the first point is often also the minimum and the
    // last, and emitting it three times costs three `lineTo` calls that draw nothing.
    if (n > writeAt && out.slot[n - 1] === slot) return;
    out.slot[n] = slot;
    out.y[n] = y;
    n += 1;
  };

  const flush = (): void => {
    if (!sawFinite) {
      emit(columnFirstSlot, Number.NaN);
      return;
    }
    emit(firstSlot, firstY);
    // Minimum and maximum in slot order, which is what keeps the reduced polyline monotone in x;
    // emitting them low-then-high regardless would add a backwards segment to every column.
    if (minSlot <= maxSlot) {
      emit(minSlot, minY);
      emit(maxSlot, maxY);
    } else {
      emit(maxSlot, maxY);
      emit(minSlot, minY);
    }
    emit(lastSlot, lastY);
  };

  // `indexBySlot` once, not `indexAt` per point (§11.4). Both read the same `Int32Array`, but
  // `indexAt` reaches it through a `Map.get` and a bounds check on EVERY point, and this is the
  // cold path CLIENT.md §16 budgets: the reduction a viewport has not cached yet. At a million
  // points that per-point indirection is the difference between a first frame that draws and one
  // that stalls; hoisting the table changes no result, only how often the same lookup is paid for.
  const bySlot = req.index.indexBySlot(req.seriesId);

  slotsScannedTotal += Math.max(0, to - from + 1);

  for (let slot = from; slot <= to; slot += 1) {
    const c = plan.col(slot);
    if (c !== column) {
      if (column !== -1) flush();
      column = c;
      lastColumnStart = n;
      lastColumnSlot0 = slot;
      columnFirstSlot = slot;
      sawFinite = false;
      minY = Number.POSITIVE_INFINITY;
      maxY = Number.NEGATIVE_INFINITY;
    }
    const i = bySlot === undefined ? GAP : (bySlot[slot] ?? GAP);
    const y = i === GAP ? Number.NaN : at(ys, i);
    if (!Number.isFinite(y)) continue;
    if (!sawFinite) {
      sawFinite = true;
      firstSlot = slot;
      firstY = y;
    }
    lastSlot = slot;
    lastY = y;
    if (y < minY) {
      minY = y;
      minSlot = slot;
    }
    if (y > maxY) {
      maxY = y;
      maxSlot = slot;
    }
  }
  if (column !== -1) flush();
  return { length: n, lastColumnStart, lastColumnSlot0 };
}

function pointsView(buffers: PointBuffers, length: number): ReducedPoints {
  return { length, slot: buffers.slot.subarray(0, length), y: buffers.y.subarray(0, length) };
}

/** M4 over a whole viewport: first, min, max and last per pixel column (§11.4). */
export function m4(req: ReduceRequest, ys: SeriesData): ReducedPoints {
  const plan = planOf(req);
  const buffers = pointBuffers(plan.columns, M4_PER_COLUMN);
  const tail = m4Into(req, plan, ys, buffers, plan.from, plan.to, 0);
  return pointsView(buffers, tail.length);
}

/* -------------------------------------------------------------------------------------------- */
/* Bars                                                                                          */
/* -------------------------------------------------------------------------------------------- */

interface BarBuffers {
  readonly slot: Float64Array;
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
}

function barBuffers(columns: number): BarBuffers {
  const capacity = columns + 1;
  return {
    slot: new Float64Array(capacity),
    o: new Float64Array(capacity),
    h: new Float64Array(capacity),
    l: new Float64Array(capacity),
    c: new Float64Array(capacity),
  };
}

/** One range candle per column: first open, highest high, lowest low, last close (§11.4). */
function barsInto(
  req: ReduceRequest,
  plan: ColumnPlan,
  src: BarSource,
  out: BarBuffers,
  from: number,
  to: number,
  writeAt: number,
): Tail {
  let n = writeAt;
  let column = -1;
  let columnFirstSlot = from;
  let lastColumnStart = writeAt;
  let lastColumnSlot0 = from;
  let sawFinite = false;
  let o = Number.NaN;
  let h = Number.NEGATIVE_INFINITY;
  let l = Number.POSITIVE_INFINITY;
  let c = Number.NaN;

  const flush = (): void => {
    out.slot[n] = columnFirstSlot;
    out.o[n] = sawFinite ? o : Number.NaN;
    out.h[n] = sawFinite ? h : Number.NaN;
    out.l[n] = sawFinite ? l : Number.NaN;
    out.c[n] = sawFinite ? c : Number.NaN;
    n += 1;
  };

  // `indexBySlot` once, not `indexAt` per point (§11.4). Both read the same `Int32Array`, but
  // `indexAt` reaches it through a `Map.get` and a bounds check on EVERY point, and this is the
  // cold path CLIENT.md §16 budgets: the reduction a viewport has not cached yet. At a million
  // points that per-point indirection is the difference between a first frame that draws and one
  // that stalls; hoisting the table changes no result, only how often the same lookup is paid for.
  const bySlot = req.index.indexBySlot(req.seriesId);

  slotsScannedTotal += Math.max(0, to - from + 1);

  for (let slot = from; slot <= to; slot += 1) {
    const col = plan.col(slot);
    if (col !== column) {
      if (column !== -1) flush();
      column = col;
      lastColumnStart = n;
      lastColumnSlot0 = slot;
      columnFirstSlot = slot;
      sawFinite = false;
      h = Number.NEGATIVE_INFINITY;
      l = Number.POSITIVE_INFINITY;
    }
    const i = bySlot === undefined ? GAP : (bySlot[slot] ?? GAP);
    if (i === GAP) continue;
    const bh = at(src.h, i);
    const bl = at(src.l, i);
    const bc = at(src.c, i);
    // A bar needs a high, a low and a close to be a bar; the open is allowed to be missing (the
    // first print of a session sometimes is) and then the close stands in for it.
    if (!Number.isFinite(bh) || !Number.isFinite(bl) || !Number.isFinite(bc)) continue;
    const bo = at(src.o, i);
    if (!sawFinite) {
      sawFinite = true;
      o = Number.isFinite(bo) ? bo : bc;
    }
    if (bh > h) h = bh;
    if (bl < l) l = bl;
    c = bc;
  }
  if (column !== -1) flush();
  return { length: n, lastColumnStart, lastColumnSlot0 };
}

function barsView(buffers: BarBuffers, length: number): ReducedBars {
  return {
    length,
    slot: buffers.slot.subarray(0, length),
    o: buffers.o.subarray(0, length),
    h: buffers.h.subarray(0, length),
    l: buffers.l.subarray(0, length),
    c: buffers.c.subarray(0, length),
  };
}

/** Reduce a candle/OHLC/volume series to one range bar per pixel column (§11.4). */
export function reduceBars(req: ReduceRequest, src: BarSource): ReducedBars {
  const plan = planOf(req);
  const buffers = barBuffers(plan.columns);
  const tail = barsInto(req, plan, src, buffers, plan.from, plan.to, 0);
  return barsView(buffers, tail.length);
}

/* -------------------------------------------------------------------------------------------- */
/* Scatter and tick: a capped column                                                              */
/* -------------------------------------------------------------------------------------------- */

/**
 * At most `cap` points per column, extremes first (§11.4).
 *
 * Two passes over the visible slots. The first counts each column's finite points and finds its
 * first, last, minimum and maximum; the second emits those four and then fills the remaining budget
 * with evenly strided points, in slot order. The extremes are chosen before the filler for the
 * reason the cap exists at all: the cap is a drawing limit, and a limit that dropped the high of the
 * column would be a limit that changed the data.
 */
export function capColumns(
  req: ReduceRequest,
  ys: SeriesData,
  cap: number = SCATTER_COLUMN_CAP,
): ReducedPoints {
  const plan = planOf(req);
  const perColumn = Math.max(1, Math.floor(cap));
  const buffers = pointBuffers(plan.columns, perColumn);
  const tail = capInto(req, plan, ys, buffers, plan.from, plan.to, 0, perColumn);
  return pointsView(buffers, tail.length);
}

function capInto(
  req: ReduceRequest,
  plan: ColumnPlan,
  ys: SeriesData,
  out: PointBuffers,
  from: number,
  to: number,
  writeAt: number,
  cap: number,
): Tail {
  if (to < from) return { length: writeAt, lastColumnStart: writeAt, lastColumnSlot0: from };
  const first = plan.col(from);
  const width = plan.col(to) - first + 1;

  const count = new Int32Array(width);
  const firstSlot = new Int32Array(width).fill(GAP);
  const lastSlot = new Int32Array(width).fill(GAP);
  const minSlot = new Int32Array(width).fill(GAP);
  const maxSlot = new Int32Array(width).fill(GAP);
  const minY = new Float64Array(width).fill(Number.POSITIVE_INFINITY);
  const maxY = new Float64Array(width).fill(Number.NEGATIVE_INFINITY);

  // `indexBySlot` once, not `indexAt` per point (§11.4). Both read the same `Int32Array`, but
  // `indexAt` reaches it through a `Map.get` and a bounds check on EVERY point, and this is the
  // cold path CLIENT.md §16 budgets: the reduction a viewport has not cached yet. At a million
  // points that per-point indirection is the difference between a first frame that draws and one
  // that stalls; hoisting the table changes no result, only how often the same lookup is paid for.
  const bySlot = req.index.indexBySlot(req.seriesId);

  const valueAt = (slot: number): number => {
    const i = bySlot === undefined ? GAP : (bySlot[slot] ?? GAP);
    return i === GAP ? Number.NaN : at(ys, i);
  };

  slotsScannedTotal += Math.max(0, to - from + 1);

  for (let slot = from; slot <= to; slot += 1) {
    const y = valueAt(slot);
    if (!Number.isFinite(y)) continue;
    const c = plan.col(slot) - first;
    count[c] = (count[c] ?? 0) + 1;
    if ((firstSlot[c] ?? GAP) === GAP) firstSlot[c] = slot;
    lastSlot[c] = slot;
    if (y < (minY[c] ?? Number.POSITIVE_INFINITY)) {
      minY[c] = y;
      minSlot[c] = slot;
    }
    if (y > (maxY[c] ?? Number.NEGATIVE_INFINITY)) {
      maxY[c] = y;
      maxSlot[c] = slot;
    }
  }

  let n = writeAt;
  let lastColumnStart = writeAt;
  let lastColumnSlot0 = from;
  let column = -1;
  let ordinal = 0;
  let extrasLeft = 0;
  let stride = 1;
  const extraBudget = Math.max(0, cap - 4);

  const emit = (slot: number, y: number): void => {
    if (n > writeAt && out.slot[n - 1] === slot) return;
    out.slot[n] = slot;
    out.y[n] = y;
    n += 1;
  };

  slotsScannedTotal += Math.max(0, to - from + 1);

  for (let slot = from; slot <= to; slot += 1) {
    const c = plan.col(slot);
    if (c !== column) {
      column = c;
      lastColumnStart = n;
      lastColumnSlot0 = slot;
      ordinal = 0;
      extrasLeft = extraBudget;
      const total = count[c - first] ?? 0;
      stride = Math.max(1, Math.floor(total / (extraBudget + 1)));
      if (total === 0) emit(slot, Number.NaN);
    }
    const y = valueAt(slot);
    if (!Number.isFinite(y)) continue;
    const c0 = c - first;
    const keepExtreme =
      slot === firstSlot[c0] ||
      slot === lastSlot[c0] ||
      slot === minSlot[c0] ||
      slot === maxSlot[c0];
    if (keepExtreme) {
      emit(slot, y);
    } else if (extrasLeft > 0 && ordinal % stride === 0) {
      emit(slot, y);
      extrasLeft -= 1;
    }
    ordinal += 1;
  }
  return { length: n, lastColumnStart, lastColumnSlot0 };
}

/* -------------------------------------------------------------------------------------------- */
/* The cache                                                                                      */
/* -------------------------------------------------------------------------------------------- */

interface PointEntry {
  readonly kind: 'm4' | 'cap';
  readonly seriesId: string;
  readonly req: ReduceRequest;
  readonly plan: ColumnPlan;
  readonly ys: SeriesData;
  readonly cap: number;
  readonly buffers: PointBuffers;
  tail: Tail;
  result: ReducedPoints;
}

interface BarEntry {
  readonly kind: 'bars';
  readonly seriesId: string;
  readonly req: ReduceRequest;
  readonly plan: ColumnPlan;
  readonly src: BarSource;
  readonly buffers: BarBuffers;
  tail: Tail;
  result: ReducedBars;
}

type Entry = PointEntry | BarEntry;

/** §11.4's cache key. The width is part of it: a resize changes every column boundary. */
function cacheKey(kind: string, req: ReduceRequest): string {
  return `${kind}|${req.seriesId}|${String(req.view.slot0)}|${String(req.view.slot1)}|${String(
    req.width,
  )}`;
}

/** How many reductions are kept. A pan visits a new key per frame; this is the LRU bound. */
export const DEFAULT_CACHE_ENTRIES = 32;

/**
 * The per-viewport reduction cache (§11.4).
 *
 * Bounded, and bounded by *entries* rather than by bytes because every entry is the same order of
 * size: four points per pixel column of one plot. A drag through a thousand frames would otherwise
 * retain a thousand reductions of the same series, none of which will be asked for again.
 */
export class DownsampleCache {
  readonly #entries = new Map<string, Entry>();
  readonly #max: number;

  constructor(maxEntries: number = DEFAULT_CACHE_ENTRIES) {
    this.#max = Math.max(1, Math.floor(maxEntries));
  }

  get size(): number {
    return this.#entries.size;
  }

  /** M4 for this request, from the cache when it is there. */
  m4(req: ReduceRequest, ys: SeriesData): ReducedPoints {
    return this.#points('m4', req, ys, M4_PER_COLUMN);
  }

  /** The capped scatter/tick reduction for this request, from the cache when it is there. */
  capColumns(req: ReduceRequest, ys: SeriesData, cap: number = SCATTER_COLUMN_CAP): ReducedPoints {
    return this.#points('cap', req, ys, Math.max(1, Math.floor(cap)));
  }

  /** The bar reduction for this request, from the cache when it is there. */
  bars(req: ReduceRequest, src: BarSource): ReducedBars {
    const key = cacheKey('bars', req);
    const hit = this.#entries.get(key);
    if (hit?.kind === 'bars') return this.#touch(key, hit).result;

    const plan = planOf(req);
    const buffers = barBuffers(plan.columns);
    const tail = barsInto(req, plan, src, buffers, plan.from, plan.to, 0);
    const entry: BarEntry = {
      kind: 'bars',
      seriesId: req.seriesId,
      req,
      plan,
      src,
      buffers,
      tail,
      result: barsView(buffers, tail.length),
    };
    this.#insert(key, entry);
    return entry.result;
  }

  /**
   * Recompute only the final column of every cached reduction of `seriesId` (§11.4, §11.5).
   *
   * This is the forming-bar path. `b1m:` delivers the same minute several times a second and each
   * arrival rewrites the last slot of the series' arrays in place; nothing to the left of that
   * column changes, so nothing to the left of that column is recomputed. Dropping the entry instead
   * would re-reduce the whole viewport — a million points, once a second, for a rectangle a pixel
   * wide — and re-reducing the whole series is also how an incremental path stops being tested:
   * `downsample.test.ts` mutates an early column as well and asserts the stale value survives, which
   * is the only assertion a full recompute cannot pass.
   */
  invalidateLastColumn(seriesId: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.seriesId !== seriesId) continue;
      const { plan, tail } = entry;
      if (entry.kind === 'bars') {
        const next = barsInto(
          entry.req,
          plan,
          entry.src,
          entry.buffers,
          tail.lastColumnSlot0,
          plan.to,
          tail.lastColumnStart,
        );
        entry.tail = next;
        entry.result = barsView(entry.buffers, next.length);
        continue;
      }
      const next =
        entry.kind === 'm4'
          ? m4Into(
              entry.req,
              plan,
              entry.ys,
              entry.buffers,
              tail.lastColumnSlot0,
              plan.to,
              tail.lastColumnStart,
            )
          : capInto(
              entry.req,
              plan,
              entry.ys,
              entry.buffers,
              tail.lastColumnSlot0,
              plan.to,
              tail.lastColumnStart,
              entry.cap,
            );
      entry.tail = next;
      entry.result = pointsView(entry.buffers, next.length);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  #points(kind: 'm4' | 'cap', req: ReduceRequest, ys: SeriesData, cap: number): ReducedPoints {
    const key = cacheKey(kind, req);
    const hit = this.#entries.get(key);
    if (hit?.kind === kind) return this.#touch(key, hit).result;

    const plan = planOf(req);
    const buffers = pointBuffers(plan.columns, cap);
    const tail =
      kind === 'm4'
        ? m4Into(req, plan, ys, buffers, plan.from, plan.to, 0)
        : capInto(req, plan, ys, buffers, plan.from, plan.to, 0, cap);
    const entry: PointEntry = {
      kind,
      seriesId: req.seriesId,
      req,
      plan,
      ys,
      cap,
      buffers,
      tail,
      result: pointsView(buffers, tail.length),
    };
    this.#insert(key, entry);
    return entry.result;
  }

  /** Move a hit to the end of the insertion order — `Map` order is the LRU list. */
  #touch<T extends Entry>(key: string, entry: T): T {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  #insert(key: string, entry: Entry): void {
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}
