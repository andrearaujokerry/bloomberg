// packages/web/test/chart/downsample.test.ts — that the reduction reduces, and that it lies about
// nothing while doing it.
//
// M4 is the classic place for a test that cannot fail. "The reduced series is shorter" passes for
// every wrong implementation that throws points away, and "the reduced series looks like the
// original" passes for a pass-through that threw nothing away. So both halves are asserted here
// against each other: the output is bounded at four points per pixel column (a pass-through fails
// that), and every column's minimum and maximum survive with their own slots (a stride decimation
// fails that — the test computes one and shows it losing a spike the reduction keeps).
//
// The data is `yahoo-chart-events.json` — 1 255 real daily AAPL bars — plus one tiled 1 M-point
// series for CHRT-02's budget shape. Real closes matter here: a synthetic ramp has its minimum and
// maximum at the ends of every column, which is the one case where "keep first and last" is
// indistinguishable from M4.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DownsampleCache,
  POINTS_PER_PIXEL_TRIGGER,
  SCATTER_COLUMN_CAP,
  capColumns,
  m4,
  reduceBars,
  shouldReduce,
} from '../../src/chart/downsample.js';
import type { ReduceRequest } from '../../src/chart/downsample.js';
import { TradingDayIndex } from '../../src/chart/tradingDayIndex.js';
import type { Viewport } from '../../src/chart/types.js';

const WEB_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(WEB_ROOT));

interface FixtureBar {
  barTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const DAILY = (
  JSON.parse(
    readFileSync(
      join(REPO_ROOT, 'fixtures', 'providers', 'normalised', 'yahoo-chart-events.json'),
      'utf8',
    ),
  ) as { bars: FixtureBar[] }
).bars;

const X = DAILY.map((b) => b.barTs);
const CLOSES = DAILY.map((b) => b.close);
const OHLC = {
  o: Float64Array.from(DAILY, (b) => b.open),
  h: Float64Array.from(DAILY, (b) => b.high),
  l: Float64Array.from(DAILY, (b) => b.low),
  c: Float64Array.from(DAILY, (b) => b.close),
};

const index = new TradingDayIndex([{ id: 'p', x: X }]);
const FULL: Viewport = { slot0: 0, slot1: index.length - 1 };

function request(width: number, view: Viewport = FULL, seriesId = 'p'): ReduceRequest {
  return { seriesId, index, view, width };
}

/** The pixel column a slot belongs to — the same arithmetic `downsample.ts` plans with. */
function columnOf(view: Viewport, width: number, slot: number): number {
  const columns = Math.max(1, Math.floor(width));
  const span = view.slot1 - view.slot0 + 1;
  return Math.min(columns - 1, Math.max(0, Math.floor(((slot - view.slot0) / span) * columns)));
}

/** Column → the minimum and maximum of the full data in it, computed independently of the module. */
function columnExtremes(
  view: Viewport,
  width: number,
  ys: readonly number[],
): Map<number, { min: number; max: number }> {
  const out = new Map<number, { min: number; max: number }>();
  for (let slot = Math.ceil(view.slot0); slot <= Math.floor(view.slot1); slot += 1) {
    const y = ys[slot];
    if (y === undefined || !Number.isFinite(y)) continue;
    const col = columnOf(view, width, slot);
    const seen = out.get(col);
    if (seen === undefined) out.set(col, { min: y, max: y });
    else {
      seen.min = Math.min(seen.min, y);
      seen.max = Math.max(seen.max, y);
    }
  }
  return out;
}

describe('shouldReduce (CLIENT.md §11.4)', () => {
  it('reduces only above two points per pixel of plot width', () => {
    expect(POINTS_PER_PIXEL_TRIGGER).toBe(2);
    // The fixture's own numbers: 1 255 daily bars are drawn whole in a 900 px pane and reduced in a
    // 300 px sparkline.
    expect(shouldReduce(DAILY.length, 900)).toBe(false);
    expect(shouldReduce(DAILY.length, 300)).toBe(true);
    // Exactly two per pixel is drawn whole: the threshold is the point at which reduction starts to
    // remove something, and at 2:1 M4 would emit more points than it was given.
    expect(shouldReduce(600, 300)).toBe(false);
    expect(shouldReduce(601, 300)).toBe(true);
  });
});

describe('M4 (CLIENT.md §11.4, CHRT-02)', () => {
  const WIDTH = 120;
  const reduced = m4(request(WIDTH), CLOSES);

  it('actually reduces: at most four points per pixel column', () => {
    expect(reduced.length).toBeLessThanOrEqual(4 * WIDTH);
    expect(reduced.length).toBeLessThan(DAILY.length);
    // 1 255 bars into 120 columns is a tenth of the work; a pass-through fails both bounds.
    expect(reduced.length / DAILY.length).toBeLessThan(0.4);

    const perColumn = new Map<number, number>();
    for (let i = 0; i < reduced.length; i += 1) {
      const col = columnOf(FULL, WIDTH, reduced.slot[i] ?? 0);
      perColumn.set(col, (perColumn.get(col) ?? 0) + 1);
    }
    for (const [, n] of perColumn) expect(n).toBeLessThanOrEqual(4);
  });

  it('preserves every column’s minimum and maximum, at their own slots', () => {
    const expected = columnExtremes(FULL, WIDTH, CLOSES);
    const got = new Map<number, { min: number; max: number; minSlot: number; maxSlot: number }>();
    for (let i = 0; i < reduced.length; i += 1) {
      const slot = reduced.slot[i] ?? 0;
      const y = reduced.y[i] ?? Number.NaN;
      if (!Number.isFinite(y)) continue;
      const col = columnOf(FULL, WIDTH, slot);
      const seen = got.get(col);
      if (seen === undefined) got.set(col, { min: y, max: y, minSlot: slot, maxSlot: slot });
      else {
        if (y < seen.min) {
          seen.min = y;
          seen.minSlot = slot;
        }
        if (y > seen.max) {
          seen.max = y;
          seen.maxSlot = slot;
        }
      }
    }
    expect(got.size).toBe(expected.size);
    for (const [col, want] of expected) {
      const have = got.get(col);
      expect(have, `column ${String(col)} lost its data`).toBeDefined();
      expect(have?.min).toBe(want.min);
      expect(have?.max).toBe(want.max);
      // The extreme keeps its own slot, not the column's first: a spike drawn a pixel to the left of
      // where it happened is a spike at the wrong time.
      expect(CLOSES[have?.minSlot ?? -1]).toBe(want.min);
      expect(CLOSES[have?.maxSlot ?? -1]).toBe(want.max);
    }
    expect(Math.min(...reduced.y)).toBe(Math.min(...CLOSES));
    expect(Math.max(...reduced.y)).toBe(Math.max(...CLOSES));
  });

  it('keeps a one-bar spike that stride decimation loses', () => {
    // The reason §11.4 specifies M4 rather than "every nth point". A single-bar move is inserted
    // into the real closes and both reductions are asked for it.
    const spiked = [...CLOSES];
    const spikeSlot = 777;
    const spike = Math.max(...CLOSES) * 2;
    spiked[spikeSlot] = spike;

    const m4Out = m4(request(WIDTH), spiked);
    expect(Math.max(...m4Out.y)).toBe(spike);

    const stride = Math.ceil(spiked.length / WIDTH);
    const decimated = spiked.filter((_v, i) => i % stride === 0);
    expect(Math.max(...decimated)).toBeLessThan(spike);
  });

  it('emits slots in order, so the polyline never doubles back', () => {
    for (let i = 1; i < reduced.length; i += 1) {
      expect(reduced.slot[i]).toBeGreaterThan(reduced.slot[i - 1] ?? -1);
    }
  });

  it('breaks the line at a gap of at least a column, and not at a sub-pixel one', () => {
    // A hole 40 bars wide is more than one column of a 120-column plot, so it must survive as a
    // break; a hole of one bar inside a ten-bar column must not, because the break would be
    // invisible and would cost that column its high and low.
    const holed = [...CLOSES];
    for (let i = 400; i < 440; i += 1) holed[i] = Number.NaN;
    holed[900] = Number.NaN;

    const out = m4(request(WIDTH), holed);
    const nanSlots: number[] = [];
    for (let i = 0; i < out.length; i += 1) {
      if (!Number.isFinite(out.y[i] ?? Number.NaN)) nanSlots.push(out.slot[i] ?? -1);
    }
    expect(nanSlots.length).toBeGreaterThan(0);
    for (const slot of nanSlots) expect(slot).toBeGreaterThanOrEqual(400);
    for (const slot of nanSlots) expect(slot).toBeLessThan(440);

    const column900 = columnOf(FULL, WIDTH, 900);
    const extremes = columnExtremes(FULL, WIDTH, holed).get(column900);
    let sawColumn900 = false;
    for (let i = 0; i < out.length; i += 1) {
      if (columnOf(FULL, WIDTH, out.slot[i] ?? 0) !== column900) continue;
      sawColumn900 = true;
      expect(Number.isFinite(out.y[i] ?? Number.NaN)).toBe(true);
    }
    expect(sawColumn900).toBe(true);
    expect(extremes).toBeDefined();
  });

  it('passes a sparse viewport through unchanged', () => {
    // Fewer points than columns: every slot is its own column, so the reduction is the identity and
    // the draw sees exactly the bars the payload carried.
    const view: Viewport = { slot0: 1200, slot1: 1254 };
    const out = m4(request(600, view), CLOSES);
    expect(out.length).toBe(55);
    for (let i = 0; i < out.length; i += 1) {
      expect(out.slot[i]).toBe(1200 + i);
      expect(out.y[i]).toBe(CLOSES[1200 + i]);
    }
  });

  it('holds a million points to four points per column (CHRT-02)', () => {
    // The budget's shape, not its timing (`chart.bench.ts` owns the clock): a series two orders of
    // magnitude past the fixture must still reduce to the plot's width, or the frame is O(points).
    const tiles = 800;
    const big = new Float64Array(DAILY.length * tiles);
    const bigX = new Float64Array(big.length);
    const step = 60_000;
    for (let t = 0; t < tiles; t += 1) {
      for (let i = 0; i < DAILY.length; i += 1) {
        const at = t * DAILY.length + i;
        big[at] = (CLOSES[i] ?? 0) + t * 0.01;
        bigX[at] = at * step;
      }
    }
    const bigIndex = new TradingDayIndex([{ id: 'b', x: bigX }]);
    expect(bigIndex.length).toBe(1_004_000);
    const view: Viewport = { slot0: 0, slot1: bigIndex.length - 1 };
    const out = m4({ seriesId: 'b', index: bigIndex, view, width: 900 }, big);
    expect(out.length).toBeLessThanOrEqual(4 * 900);
    // Spread-free: `Math.min(...aMillionPoints)` overflows the call stack.
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of big) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    let outLo = Number.POSITIVE_INFINITY;
    let outHi = Number.NEGATIVE_INFINITY;
    for (const v of out.y) {
      outLo = Math.min(outLo, v);
      outHi = Math.max(outHi, v);
    }
    expect(outLo).toBe(lo);
    expect(outHi).toBe(hi);
  });
});

describe('bars reduce to a range candle per column (CLIENT.md §11.4)', () => {
  const WIDTH = 100;
  const out = reduceBars(request(WIDTH), OHLC);

  it('is one candle per column, not one per bar', () => {
    expect(out.length).toBeLessThanOrEqual(WIDTH);
    expect(out.length).toBeLessThan(DAILY.length);
  });

  it('takes the first open, the highest high, the lowest low and the last close', () => {
    for (let i = 0; i < out.length; i += 1) {
      const col = columnOf(FULL, WIDTH, out.slot[i] ?? 0);
      let o = Number.NaN;
      let h = Number.NEGATIVE_INFINITY;
      let l = Number.POSITIVE_INFINITY;
      let c = Number.NaN;
      for (let slot = 0; slot < DAILY.length; slot += 1) {
        if (columnOf(FULL, WIDTH, slot) !== col) continue;
        const bar = DAILY[slot];
        if (bar === undefined) continue;
        if (!Number.isFinite(o)) o = bar.open;
        h = Math.max(h, bar.high);
        l = Math.min(l, bar.low);
        c = bar.close;
      }
      expect(out.o[i]).toBe(o);
      expect(out.h[i]).toBe(h);
      expect(out.l[i]).toBe(l);
      expect(out.c[i]).toBe(c);
      // The column's range contains every bar in it: a candle that clipped a wick would misstate
      // the high of a whole week.
      expect(out.h[i]).toBeGreaterThanOrEqual(out.o[i] ?? 0);
      expect(out.l[i]).toBeLessThanOrEqual(out.c[i] ?? 0);
    }
  });
});

describe('scatter and tick cap at eight per column (CLIENT.md §11.4)', () => {
  const WIDTH = 60;
  const out = capColumns(request(WIDTH), CLOSES);

  it('caps the column and keeps its extremes', () => {
    expect(SCATTER_COLUMN_CAP).toBe(8);
    const perColumn = new Map<number, number[]>();
    for (let i = 0; i < out.length; i += 1) {
      const col = columnOf(FULL, WIDTH, out.slot[i] ?? 0);
      const list = perColumn.get(col) ?? [];
      list.push(out.y[i] ?? Number.NaN);
      perColumn.set(col, list);
    }
    const expected = columnExtremes(FULL, WIDTH, CLOSES);
    expect(perColumn.size).toBe(expected.size);
    for (const [col, want] of expected) {
      const got = perColumn.get(col) ?? [];
      // Twenty bars land in each column of a 60-column plot: the cap is doing work here.
      expect(got.length).toBeLessThanOrEqual(8);
      expect(got.length).toBeGreaterThan(1);
      expect(Math.min(...got)).toBe(want.min);
      expect(Math.max(...got)).toBe(want.max);
    }
  });

  it('respects a smaller cap', () => {
    const four = capColumns(request(WIDTH), CLOSES, 4);
    const perColumn = new Map<number, number>();
    for (let i = 0; i < four.length; i += 1) {
      const col = columnOf(FULL, WIDTH, four.slot[i] ?? 0);
      perColumn.set(col, (perColumn.get(col) ?? 0) + 1);
    }
    for (const [, n] of perColumn) expect(n).toBeLessThanOrEqual(4);
    expect(four.length).toBeLessThan(out.length);
  });
});

describe('DownsampleCache (CLIENT.md §11.4, §11.5)', () => {
  it('caches by series, viewport and width, and re-reduces when any of them changes', () => {
    const cache = new DownsampleCache();
    const a = cache.m4(request(120), CLOSES);
    const b = cache.m4(request(120), CLOSES);
    expect(b).toBe(a); // the same object: nothing was recomputed
    expect(cache.size).toBe(1);

    expect(cache.m4(request(121), CLOSES)).not.toBe(a); // a resize moves every column boundary
    expect(cache.m4(request(120, { slot0: 1, slot1: 1254 }), CLOSES)).not.toBe(a);
    expect(cache.size).toBe(3);
  });

  it('is bounded: a pan through a thousand viewports does not retain a thousand reductions', () => {
    const cache = new DownsampleCache(8);
    for (let i = 0; i < 200; i += 1) {
      cache.m4(request(120, { slot0: i, slot1: 1000 + i }), CLOSES);
    }
    expect(cache.size).toBe(8);
  });

  it('a stream append invalidates ONLY the last column', () => {
    // §11.5's forming bar: the last slot is rewritten several times a second while nothing to its
    // left changes. The assertion that makes this test able to fail is the second one — an early
    // value is mutated too, and the cached reduction must still show the STALE early value. An
    // implementation that drops the entry and re-reduces the viewport shows the new one and fails.
    const closes = [...CLOSES];
    const WIDTH = 120;
    const cache = new DownsampleCache();
    const before = cache.m4(request(WIDTH), closes);
    const beforeCopy = { slot: before.slot.slice(), y: before.y.slice() };

    const lastColumn = columnOf(FULL, WIDTH, 1254);
    const earlySlot = 30;
    const earlyColumn = columnOf(FULL, WIDTH, earlySlot);
    expect(earlyColumn).toBeLessThan(lastColumn);

    closes[1254] = Math.max(...CLOSES) * 3;
    closes[earlySlot] = Math.min(...CLOSES) / 3;
    cache.invalidateLastColumn('p');
    const after = cache.m4(request(WIDTH), closes);

    let sawNewHigh = false;
    for (let i = 0; i < after.length; i += 1) {
      const col = columnOf(FULL, WIDTH, after.slot[i] ?? 0);
      if (col === lastColumn && after.y[i] === closes[1254]) sawNewHigh = true;
      if (col === earlyColumn) {
        // Untouched: the early column was not recomputed, so the mutated value is not in it.
        expect(after.y[i]).not.toBe(closes[earlySlot]);
      }
    }
    expect(sawNewHigh).toBe(true);

    // And everything before the last column is byte-identical to the previous reduction.
    let firstOfLastColumn = after.length;
    for (let i = 0; i < after.length; i += 1) {
      if (columnOf(FULL, WIDTH, after.slot[i] ?? 0) === lastColumn) {
        firstOfLastColumn = i;
        break;
      }
    }
    expect(firstOfLastColumn).toBeGreaterThan(0);
    expect([...after.slot.subarray(0, firstOfLastColumn)]).toEqual([
      ...beforeCopy.slot.subarray(0, firstOfLastColumn),
    ]);
    expect([...after.y.subarray(0, firstOfLastColumn)]).toEqual([
      ...beforeCopy.y.subarray(0, firstOfLastColumn),
    ]);
  });

  it('invalidates the last column of a bar reduction too', () => {
    const o = Float64Array.from(OHLC.o);
    const h = Float64Array.from(OHLC.h);
    const l = Float64Array.from(OHLC.l);
    const c = Float64Array.from(OHLC.c);
    const cache = new DownsampleCache();
    const before = cache.bars(request(100), { o, h, l, c });
    const lastIndex = before.length - 1;
    const beforeHigh = before.h[lastIndex] ?? Number.NaN;

    h[1254] = beforeHigh * 1.5;
    c[1254] = beforeHigh * 1.4;
    cache.invalidateLastColumn('p');
    const after = cache.bars(request(100), { o, h, l, c });
    expect(after.length).toBe(before.length);
    expect(after.h[lastIndex]).toBe(beforeHigh * 1.5);
    expect(after.c[lastIndex]).toBe(beforeHigh * 1.4);
  });

  it('leaves other series alone', () => {
    const cache = new DownsampleCache();
    const mine = cache.m4(request(120), CLOSES);
    cache.invalidateLastColumn('somebody-else');
    expect(cache.m4(request(120), CLOSES)).toBe(mine);
  });
});
