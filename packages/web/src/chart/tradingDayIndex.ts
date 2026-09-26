// packages/web/src/chart/tradingDayIndex.ts — the x axis, as slots rather than as time.
//
// CLIENT.md §11.2, CHRT-03. A price chart's x axis is not a time axis: the night between Friday's
// close and Monday's open is four fifths of the week and would be four fifths of the canvas, so
// every terminal draws bars at equal spacing and labels them with their dates. That is what this
// file computes. The union of every series' `x` values is sorted and deduplicated into **slots**
// `0..n-1`, and from that point on the whole engine — scales, downsampling, the crosshair, hit
// testing, annotation anchors — speaks in slots. Nights, weekends and holidays are not compressed
// by a rule about calendars; they simply never become slots, because no bar carries their
// timestamps.
//
// The union, not an intersection, is what makes CHRT-03's "two securities with different calendars
// align by timestamp" true. A US holiday on which the LSE traded is a slot: the LSE series has a
// point there and the US series has a gap (`GAP`), which a line draws through as `NaN` rather than
// by shifting every later point of the other series one bar to the left. Intersection alignment is
// a server option (API.md §4) and deliberately not done here — dropping the day would silently
// change the London series a trader is reading.
//
// Two lookup tables per series rather than one, both `Int32Array`:
//
//   * `slot → point index` is what a draw loop and a crosshair readout need, O(1) per slot, once
//     per frame per visible slot. Its cost is 4 bytes per slot per series — 5 MB for CHRT-02's
//     million-point budget across five series, which is the trade this engine wants: the
//     alternative is a binary search per slot per frame inside the loop that has to stay O(pixels).
//   * `point index → slot` is what streaming and study outputs need, because they are indexed by
//     the series' own arrays and have to find the slot a result belongs to.
//
// Construction is O(m log n) with a binary search per point rather than O(m) through a `Map`: a
// `Map` keyed by a million timestamps costs tens of megabytes and a rehash, for a lookup that
// happens once per `setSpec` and never in a frame. The searched array is the sorted union, so the
// search is exact and a miss means the point's `x` was not finite.

import type { ChartSpec, SeriesData } from './types.js';

/** `indexAt` / `slotOfPoint` for a slot a series has no point at (§11.2: drawn as a gap). */
export const GAP = -1;

/** One session window as `ChartSpec.xAxis.sessions` states it: epoch-ms bounds and its kind. */
export type SessionWindow = NonNullable<ChartSpec['xAxis']['sessions']>[number];

/** A series as the index needs it: an id to key the tables by, and the x column. */
export interface IndexedSeries {
  readonly id: string;
  readonly x: SeriesData;
}

/**
 * A maximal run of slots inside one session window (§11.2).
 *
 * `window` is the index of the window in the (start-sorted) session list, and it is what makes a
 * segment boundary a *line break* rather than a colour change: two consecutive regular sessions on
 * two different days have the same `kind` and different `window`, and a line drawn straight from
 * Monday's 16:00 close to Tuesday's 09:30 open across a collapsed night is the artefact §11.2 asks
 * to be broken. Both bounds are inclusive slots.
 */
export interface SessionSegment {
  readonly slot0: number;
  readonly slot1: number;
  readonly kind: SessionWindow['kind'];
  readonly window: number;
}

/** No session window contains this slot — an out-of-hours print, or a spec with no sessions. */
const NO_WINDOW = -1;

/**
 * `Float64Array[i]` and `number[][i]` are `number | undefined` under `noUncheckedIndexedAccess`,
 * and an out-of-range read really is absent. `NaN` is this engine's word for "no value here"
 * (`ChartSeries.y` documents it), so reading one out is the honest coercion rather than a `0` that
 * would draw at the axis baseline.
 */
function at(xs: SeriesData, i: number): number {
  return xs[i] ?? Number.NaN;
}

/**
 * The sorted, deduplicated union of every series' finite x values.
 *
 * Non-finite x values are dropped rather than becoming slots: a `NaN` x is not a position on any
 * axis, and one admitted to the union would sort to the end and add a slot no series can ever have
 * a point at. A `NaN` *y* is entirely different and is preserved — that is a gap at a real slot.
 */
function sortedUnionOfX(series: readonly IndexedSeries[]): Float64Array {
  let total = 0;
  for (const s of series) total += s.x.length;

  const buffer = new Float64Array(total);
  let n = 0;
  for (const s of series) {
    const xs = s.x;
    for (let i = 0; i < xs.length; i += 1) {
      const v = at(xs, i);
      if (Number.isFinite(v)) {
        buffer[n] = v;
        n += 1;
      }
    }
  }

  // `Float64Array.prototype.sort` is numeric by default (it is `Array.prototype.sort` that is
  // lexicographic), so no comparator is passed and none should be: a comparator here would turn a
  // sort of a million timestamps into a million JavaScript calls.
  const filled = buffer.subarray(0, n);
  filled.sort();

  let m = 0;
  for (let i = 0; i < n; i += 1) {
    const v = at(filled, i);
    if (m === 0 || v !== at(filled, m - 1)) {
      filled[m] = v;
      m += 1;
    }
  }
  return filled.slice(0, m);
}

/**
 * The slot holding `x`, or `-1 - insertionPoint` when no slot does.
 *
 * The negative encoding is Java's `Arrays.binarySearch` convention and it is carried here because
 * both answers have a caller: `slotOf` wants "exactly this timestamp or nothing" (an annotation
 * anchor saved against a bar that a later range change dropped must not silently move to its
 * neighbour), while `nearestSlot` wants the insertion point so it can compare the two neighbours.
 */
function searchSlot(values: Float64Array, length: number, x: number): number {
  let lo = 0;
  let hi = length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = at(values, mid);
    if (v === x) return mid;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1 - lo;
}

/** Grow a table to at least `need`, doubling (§11.5's capacity rule), preserving `length` entries. */
function grown(table: Int32Array, length: number, need: number, fill: number): Int32Array {
  if (need <= table.length) return table;
  let capacity = Math.max(table.length, 1);
  while (capacity < need) capacity *= 2;
  const next = new Int32Array(capacity).fill(fill);
  next.set(table.subarray(0, length));
  return next;
}

/**
 * The slot-linear x axis of one chart: the union of its series' x values, and the maps between
 * slots and each series' own indices (§11.2).
 *
 * Built once per `setSpec` and then read every frame. `append` is the one mutation, and it exists
 * because §11.5's forming bar adds a slot on the right edge without anything else about the chart
 * changing — rebuilding the whole index once a minute for one new timestamp would throw away every
 * downsample cache entry (`downsample.ts`) for a redraw that is meant to touch two slots.
 */
export class TradingDayIndex {
  /** Slot → x value (epoch ms on a time axis, days on a tenor axis, index on a category axis). */
  #values: Float64Array;
  #length: number;
  /** Series id → slot → point index (`GAP` where the series has no point). */
  readonly #indexBySlot = new Map<string, Int32Array>();
  /** Series id → point index → slot (`GAP` where the point's x was not finite). */
  readonly #slotByIndex = new Map<string, Int32Array>();
  /** Series id → how many of that series' points the maps describe (its array length). */
  readonly #pointCount = new Map<string, number>();
  /** Session windows, sorted by `start`; empty when the spec states none. */
  readonly #sessions: readonly SessionWindow[];
  /** Slot → index into `#sessions`, or `NO_WINDOW`. */
  #windowBySlot: Int32Array;
  #segments: SessionSegment[];

  constructor(series: readonly IndexedSeries[], sessions?: readonly SessionWindow[]) {
    this.#values = sortedUnionOfX(series);
    this.#length = this.#values.length;

    for (const s of series) {
      const slotByIndex = new Int32Array(s.x.length).fill(GAP);
      const indexBySlot = new Int32Array(this.#length).fill(GAP);
      for (let i = 0; i < s.x.length; i += 1) {
        const slot = searchSlot(this.#values, this.#length, at(s.x, i));
        if (slot < 0) continue;
        slotByIndex[i] = slot;
        // A series carrying the same x twice — history that already contains the minute a forming
        // bar is still building, which GIP produces on a reload — resolves to its LAST point. That
        // is the series' own final word on that timestamp; the earlier one is the stale copy.
        indexBySlot[slot] = i;
      }
      this.#indexBySlot.set(s.id, indexBySlot);
      this.#slotByIndex.set(s.id, slotByIndex);
      this.#pointCount.set(s.id, s.x.length);
    }

    // Sorted defensively rather than trusted: the window order decides which window a slot on an
    // overlap lands in, and a payload that listed post before regular would otherwise shade the
    // regular session as post for the whole day.
    this.#sessions = [...(sessions ?? [])].sort((a, b) => a.start - b.start);
    this.#windowBySlot = new Int32Array(this.#length).fill(NO_WINDOW);
    for (let slot = 0; slot < this.#length; slot += 1) {
      this.#windowBySlot[slot] = this.#windowAt(at(this.#values, slot));
    }
    this.#segments = this.#buildSegments();
  }

  /** The index a `ChartSpec` implies: every series' x, and the spec's own session windows. */
  static fromSpec(spec: ChartSpec): TradingDayIndex {
    const series = spec.series.map((s) => ({ id: s.id, x: s.x }));
    return spec.xAxis.sessions === undefined
      ? new TradingDayIndex(series)
      : new TradingDayIndex(series, spec.xAxis.sessions);
  }

  /** How many slots the axis has. */
  get length(): number {
    return this.#length;
  }

  /** Slot → x value; `NaN` outside `0..length-1`. Truncated, never interpolated — see below. */
  valueAt(slot: number): number {
    // A fractional slot has no timestamp. The viewport's bounds are fractional (a zoom anchored on
    // the crosshair lands between bars), and interpolating between slot 4 and slot 5 would invent
    // an instant inside a collapsed weekend and print it on an axis label. Every caller that wants
    // a timestamp wants a bar's timestamp, so the fraction is dropped.
    const i = Math.floor(slot);
    return i >= 0 && i < this.#length ? at(this.#values, i) : Number.NaN;
  }

  /** A read-only view of slot → x, for a tick loop that should not pay for a call per slot. */
  values(): Float64Array {
    return this.#values.subarray(0, this.#length);
  }

  /** The slot whose x is exactly `x`, or `-1`. */
  slotOf(x: number): number {
    const found = searchSlot(this.#values, this.#length, x);
    return found >= 0 ? found : GAP;
  }

  /**
   * The slot closest to `x`, clamped into the axis; `-1` only when the axis is empty.
   *
   * This is what an annotation anchor and a mouse click use (§11.8): `{ t, v }` is stored in data
   * coordinates and `t` need not be a bar — a trendline drawn on a daily chart and reopened on a
   * weekly one has anchors between slots, and it must still draw.
   */
  nearestSlot(x: number): number {
    if (this.#length === 0) return GAP;
    const found = searchSlot(this.#values, this.#length, x);
    if (found >= 0) return found;
    const after = -1 - found;
    if (after <= 0) return 0;
    if (after >= this.#length) return this.#length - 1;
    const before = after - 1;
    return x - at(this.#values, before) <= at(this.#values, after) - x ? before : after;
  }

  /** `seriesId`'s point index at `slot`, or `GAP`. */
  indexAt(seriesId: string, slot: number): number {
    const table = this.#indexBySlot.get(seriesId);
    if (table === undefined || slot < 0 || slot >= this.#length) return GAP;
    return table[slot] ?? GAP;
  }

  /** The slot of `seriesId`'s point `i`, or `GAP` when the point has no finite x. */
  slotOfPoint(seriesId: string, i: number): number {
    return this.#slotByIndex.get(seriesId)?.[i] ?? GAP;
  }

  /** `seriesId`'s whole slot → point index table, for a per-frame loop. `undefined` if unknown. */
  indexBySlot(seriesId: string): Int32Array | undefined {
    const table = this.#indexBySlot.get(seriesId);
    return table === undefined ? undefined : table.subarray(0, this.#length);
  }

  /** The kind of session `slot` falls in, or `null` when no window contains it. */
  sessionAt(slot: number): SessionWindow['kind'] | null {
    if (slot < 0 || slot >= this.#length) return null;
    const w = this.#windowBySlot[slot] ?? NO_WINDOW;
    return w === NO_WINDOW ? null : (this.#sessions[w]?.kind ?? null);
  }

  /**
   * True when a line must be broken *before* `slot`: it starts a different session window than
   * its predecessor (§11.2).
   *
   * A spec with no sessions — every daily chart — answers `false` everywhere, which is right: a
   * weekend on a daily axis is a collapsed gap the line is meant to cross, and breaking there
   * would leave a 5-day chart drawn as five disconnected points.
   */
  breaksBefore(slot: number): boolean {
    if (slot <= 0 || slot >= this.#length) return false;
    return (this.#windowBySlot[slot] ?? NO_WINDOW) !== (this.#windowBySlot[slot - 1] ?? NO_WINDOW);
  }

  /** The session runs, in slot order — what shades pre/post bands and breaks lines (§11.2). */
  segments(): readonly SessionSegment[] {
    return this.#segments;
  }

  /**
   * Add a slot for `x` on the right edge and return it (§11.5's `append-forming-bar`).
   *
   * Right edge only. A timestamp at or before the last slot is not an append: an equal one means
   * the forming bar is still the last slot and `streaming.ts` overwrites the arrays in place, and
   * an earlier one is a stream out of order, which is a defect that must surface here rather than
   * corrupt a sorted axis every binary search in this file depends on.
   */
  append(x: number): number {
    if (!Number.isFinite(x)) {
      throw new RangeError('TradingDayIndex.append: x must be finite');
    }
    if (this.#length > 0 && x <= at(this.#values, this.#length - 1)) {
      throw new RangeError(
        `TradingDayIndex.append: ${String(x)} is not after the last slot ${String(
          at(this.#values, this.#length - 1),
        )} — a forming bar at the last slot is overwritten in place (§11.5)`,
      );
    }

    if (this.#length >= this.#values.length) {
      const next = new Float64Array(Math.max(this.#values.length * 2, 8));
      next.set(this.#values);
      this.#values = next;
    }
    const slot = this.#length;
    this.#values[slot] = x;
    this.#length = slot + 1;

    for (const [id, table] of this.#indexBySlot) {
      this.#indexBySlot.set(id, grown(table, slot, slot + 1, GAP));
    }
    this.#windowBySlot = grown(this.#windowBySlot, slot, slot + 1, NO_WINDOW);
    this.#windowBySlot[slot] = this.#windowAt(x);
    this.#segments = this.#buildSegments();
    return slot;
  }

  /**
   * Record that `seriesId`'s point `i` is the point at `slot` — the other half of an append.
   *
   * `append` adds the slot to the axis; this says which series filled it. They are separate calls
   * because the arrays are `streaming.ts`'s (it is the one that grew them and wrote the bar) while
   * the slot tables are this file's, and a single call would have to reach across that line.
   */
  setPoint(seriesId: string, slot: number, i: number): void {
    const indexBySlot = this.#indexBySlot.get(seriesId);
    const slotByIndex = this.#slotByIndex.get(seriesId);
    if (indexBySlot === undefined || slotByIndex === undefined) {
      throw new RangeError(`TradingDayIndex.setPoint: unknown series '${seriesId}'`);
    }
    if (slot < 0 || slot >= this.#length || i < 0) {
      throw new RangeError(
        `TradingDayIndex.setPoint: slot ${String(slot)} / point ${String(i)} out of range`,
      );
    }
    indexBySlot[slot] = i;
    const count = Math.max(this.#pointCount.get(seriesId) ?? 0, i + 1);
    const grownSlots = grown(slotByIndex, count - 1, count, GAP);
    grownSlots[i] = slot;
    this.#slotByIndex.set(seriesId, grownSlots);
    this.#pointCount.set(seriesId, count);
  }

  /** The index of the first session window containing `t`, or `NO_WINDOW`. */
  #windowAt(t: number): number {
    for (let w = 0; w < this.#sessions.length; w += 1) {
      const win = this.#sessions[w];
      if (win === undefined) continue;
      if (t >= win.start && t <= win.end) return w;
    }
    return NO_WINDOW;
  }

  #buildSegments(): SessionSegment[] {
    const out: SessionSegment[] = [];
    let slot = 0;
    while (slot < this.#length) {
      const w = this.#windowBySlot[slot] ?? NO_WINDOW;
      let end = slot;
      while (end + 1 < this.#length && (this.#windowBySlot[end + 1] ?? NO_WINDOW) === w) end += 1;
      const kind = w === NO_WINDOW ? undefined : this.#sessions[w]?.kind;
      if (kind !== undefined) out.push({ slot0: slot, slot1: end, kind, window: w });
      slot = end + 1;
    }
    return out;
  }
}
