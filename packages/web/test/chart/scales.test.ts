// packages/web/test/chart/scales.test.ts — the chart's geometry, against real bars.
//
// WORKPLAN's WP-14 acceptance row for this file is "log/percent/indexed scales, session-gap
// collapsing, axis tick selection at three zoom levels", and each clause has a `describe` below.
//
// The data is the replay store's, not invented: `yahoo-chart-events.json` (1 255 daily AAPL bars,
// Sep 2021 → Sep 2026) for the daily axis and `yahoo-chart-SPX-5d-5m.json` (376 five-minute bars
// across five trading days, 2026-09-09 → 2026-09-15) for the intraday one. That matters most for the
// session-gap clause: a weekend and four overnight closes are things a fixture has and a hand-built
// array of consecutive integers does not, and collapsing them is the whole behaviour under test. No
// network, no database — the files are read from disk, which is what a `web` test may do (TESTING.md
// §2.1: the boundary rules scope to `packages/*/src/**`).
//
// Nothing here waits on a frame: these three modules are pure arithmetic and hold no canvas, so the
// manual frame pump (TESTING.md §2.2) is not involved.
//
// ## What this file does NOT yet prove, stated because its title would otherwise overclaim
//
// `src/chart/scales.ts` is not on the drawn path. `grep -rn 'chart/scales' packages/web/src` finds
// the module itself and two comments in `renderer.ts`, and no import: the renderer builds its axes
// with a second, private implementation (`buildAxes`, `padded`, `scalesFor`, `normaliserFor`) and
// takes its tick values from a third in `layers.ts` (`niceTicks`, `logDecadeTicks`, `xTickStride`).
// So everything below is true of `scales.ts` and says nothing about the pixels a chart puts on
// screen, and the WORKPLAN acceptance row named above is **not** met by this file alone. Two
// consequences are visible on real screens: the renderer's x axis is slot-linear on
// `xAxis.type: 'tenor'`, so GC, CRVF, OMON and OVML draw a curve whose shape is wrong, and its tenor
// labels are raw day counts where the grid beside them says `30Y`. The last test in this file
// measures both against the committed CRVF payload, so the size of the error is on the record here
// even while the wiring that fixes it is not.
//
// Closing that seam means `renderer.ts` calling `yAxisScale` for its y axes, `tenorScale` and
// `categoryScale` for the two non-time x axes, `slotScale` for the time one and `timeTicks` for the
// x strip, and deleting the private copies — one file, and not this one. The wiring is owned by
// whoever owns `renderer.ts`; this note exists so that nobody reads a green run here as evidence
// that a curve is drawn with the geometry §11.2 specifies.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localClock } from '@terminal/core';
import { describe, expect, it } from 'vitest';

import {
  categoryScale,
  linearScale,
  logScale,
  slotScale,
  targetYTickCount,
  tenorScale,
  timeTicks,
  yAxisScale,
} from '../../src/chart/scales.js';
import { GAP, TradingDayIndex } from '../../src/chart/tradingDayIndex.js';
import type { ChartSeries, ChartSpec, Viewport } from '../../src/chart/types.js';

/** `packages/web/test/chart/` → `packages/web/` → the monorepo root (as `types.test.ts` does it). */
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

function bars(file: string): FixtureBar[] {
  const path = join(REPO_ROOT, 'fixtures', 'providers', 'normalised', `${file}.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bars: FixtureBar[] };
  return parsed.bars;
}

const DAILY = bars('yahoo-chart-events');
const INTRADAY = bars('yahoo-chart-SPX-5d-5m');
const NY = 'America/New_York';

/**
 * A price series shaped exactly as `screens/GP/Screen.tsx#toSeries` builds one — `x` = timestamps,
 * `y` = closes, `ohlc` as `Float64Array`s — so what is tested is the shape the product path produces
 * rather than a convenient one.
 */
function priceSeries(id: string, rows: readonly FixtureBar[], yAxis = 'y'): ChartSeries {
  return {
    id,
    label: id,
    type: 'candle',
    pane: 'main',
    yAxis,
    x: rows.map((b) => b.barTs),
    y: rows.map((b) => b.close),
    ohlc: {
      o: Float64Array.from(rows, (b) => b.open),
      h: Float64Array.from(rows, (b) => b.high),
      l: Float64Array.from(rows, (b) => b.low),
      c: Float64Array.from(rows, (b) => b.close),
    },
    provIdx: 0,
    style: { color: 'auto' },
  };
}

const dailySeries = priceSeries('p', DAILY);
const dailyIndex = new TradingDayIndex([{ id: 'p', x: dailySeries.x }]);

const MS_PER_DAY = 86_400_000;

/** The local trading date of an instant in New York, via core's own zone table. */
function nyDate(t: number): string {
  return localClock(NY, t)?.date ?? '';
}

/** One session window per trading day of the intraday fixture, as `GIP` passes them. */
function intradaySessions(): NonNullable<ChartSpec['xAxis']['sessions']> {
  const byDay = new Map<string, { start: number; end: number }>();
  for (const b of INTRADAY) {
    const day = nyDate(b.barTs);
    const seen = byDay.get(day);
    if (seen === undefined) byDay.set(day, { start: b.barTs, end: b.barTs });
    else seen.end = b.barTs;
  }
  return [...byDay.values()].map((w) => ({ start: w.start, end: w.end, kind: 'regular' as const }));
}

describe('TradingDayIndex — session-gap collapsing (CLIENT.md §11.2, CHRT-03)', () => {
  it('maps the 1 255 daily bars onto contiguous slots, so weekends occupy no width', () => {
    expect(dailyIndex.length).toBe(DAILY.length);

    // The axis is slot-linear, so the pixel distance between Friday and Monday is one slot — the
    // same as between Monday and Tuesday — while the *timestamps* three days apart are still there
    // to label it with. That is the collapse, stated as the two facts it consists of.
    let weekendGaps = 0;
    for (let slot = 1; slot < dailyIndex.length; slot += 1) {
      const dt = dailyIndex.valueAt(slot) - dailyIndex.valueAt(slot - 1);
      expect(dt).toBeGreaterThan(0);
      if (dt >= 3 * MS_PER_DAY) weekendGaps += 1;
    }
    expect(weekendGaps).toBeGreaterThan(200); // ~52 weekends a year over five years

    const scale = slotScale({ slot0: 0, slot1: dailyIndex.length - 1 }, { x: 0, w: 1255 });
    const fridayToMonday = Math.abs(scale.x(1) - scale.x(0));
    const midWeek = Math.abs(scale.x(3) - scale.x(2));
    expect(fridayToMonday).toBeCloseTo(midWeek, 10);
  });

  it('aligns two calendars by timestamp and leaves the missing days as gaps, not as a shift', () => {
    // A second security that did not trade on 40 of the first's days and traded on one the first
    // missed — a US holiday on which London was open. CHRT-03's union alignment must keep every date
    // of both, so the London series reads the same after alignment as before it.
    const skipped = new Set([5, 6, 7, 40, 41, 300, 301, 302, 900]);
    const other = DAILY.filter((_b, i) => !skipped.has(i));
    // 2021-11-25 is Thanksgiving: the fixture jumps from the 24th to the 26th, so it is a real
    // holiday the other venue traded through. The extra timestamp is that day at the same hour.
    expect(DAILY[51]!.barTs - DAILY[50]!.barTs).toBe(2 * MS_PER_DAY);
    const extraTs = DAILY[50]!.barTs + MS_PER_DAY;
    const otherX = [...other.map((b) => b.barTs), extraTs].sort((a, b) => a - b);

    const index = new TradingDayIndex([
      { id: 'us', x: dailySeries.x },
      { id: 'uk', x: otherX },
    ]);

    expect(index.length).toBe(DAILY.length + 1);
    for (const i of skipped) {
      const slot = index.slotOf(DAILY[i]!.barTs);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(index.indexAt('us', slot)).toBe(i);
      expect(index.indexAt('uk', slot)).toBe(GAP); // a gap, drawn as NaN — not a one-slot shift
    }
    const extraSlot = index.slotOf(extraTs);
    expect(index.indexAt('us', extraSlot)).toBe(GAP);
    expect(index.indexAt('uk', extraSlot)).toBeGreaterThanOrEqual(0);

    // Every UK point still sits at its own timestamp: alignment moved nothing.
    for (let i = 0; i < otherX.length; i += 1) {
      expect(index.valueAt(index.slotOfPoint('uk', i))).toBe(otherX[i]);
    }
  });

  it('breaks the line at every session boundary of the five-day intraday fixture', () => {
    const series = priceSeries('spx', INTRADAY);
    const sessions = intradaySessions();
    expect(sessions).toHaveLength(5);

    const index = new TradingDayIndex([{ id: 'spx', x: series.x }], sessions);
    expect(index.length).toBe(INTRADAY.length);
    expect(index.segments()).toHaveLength(5);
    expect(index.segments().every((s) => s.kind === 'regular')).toBe(true);

    const breaks: number[] = [];
    for (let slot = 0; slot < index.length; slot += 1) {
      if (index.breaksBefore(slot)) breaks.push(slot);
    }
    // Four breaks for five sessions, each at the first bar of a day — including the one across the
    // weekend, where a straight segment would otherwise cross 64 hours of closed market.
    expect(breaks).toHaveLength(4);
    for (const slot of breaks) {
      expect(nyDate(index.valueAt(slot))).not.toBe(nyDate(index.valueAt(slot - 1)));
    }
    expect(index.segments().map((s) => s.slot0)).toEqual([0, ...breaks]);
  });

  it('does not break a daily axis, where the collapsed weekend is meant to be crossed', () => {
    for (let slot = 0; slot < dailyIndex.length; slot += 1) {
      expect(dailyIndex.breaksBefore(slot)).toBe(false);
    }
    expect(dailyIndex.segments()).toHaveLength(0);
    expect(dailyIndex.sessionAt(10)).toBeNull();
  });

  it('marks pre and post sessions from the spec windows', () => {
    // The fixture captures regular-hours bars only, so the pre/post path is exercised against a
    // three-window day built from the same instants: 09:00 pre, 09:30 regular, 16:00 post.
    const day = INTRADAY.slice(0, 20);
    const t0 = day[0]!.barTs;
    const index = new TradingDayIndex([{ id: 's', x: day.map((b) => b.barTs) }], [
      { start: t0 - 1800_000, end: t0 - 1, kind: 'pre' },
      { start: t0, end: t0 + 4 * 300_000, kind: 'regular' },
      { start: t0 + 5 * 300_000, end: t0 + 19 * 300_000, kind: 'post' },
    ]);
    expect(index.sessionAt(0)).toBe('regular');
    expect(index.sessionAt(4)).toBe('regular');
    expect(index.sessionAt(5)).toBe('post');
    expect(index.breaksBefore(5)).toBe(true);
    expect(index.segments().map((s) => s.kind)).toEqual(['regular', 'post']);
  });

  it('appends a slot only at the right edge (§11.5), and rejects an out-of-order stream', () => {
    const index = new TradingDayIndex([{ id: 's', x: [1000, 2000, 3000] }]);
    const slot = index.append(4000);
    expect(slot).toBe(3);
    expect(index.length).toBe(4);
    expect(index.indexAt('s', 3)).toBe(GAP);
    index.setPoint('s', 3, 3);
    expect(index.indexAt('s', 3)).toBe(3);
    expect(index.slotOfPoint('s', 3)).toBe(3);
    expect(() => index.append(3500)).toThrow(/not after the last slot/);
    expect(() => index.append(4000)).toThrow(/not after the last slot/);
  });
});

describe('LinearScale and LogScale (CLIENT.md §11.2)', () => {
  const range = [400, 0] as const; // a 400 px pane: the domain minimum at the bottom

  it('projects and inverts a linear axis, and puts the minimum at the bottom', () => {
    const s = linearScale([100, 200], range);
    expect(s.project(100)).toBeCloseTo(400, 9);
    expect(s.project(200)).toBeCloseTo(0, 9);
    expect(s.project(150)).toBeCloseTo(200, 9);
    expect(s.invert(200)).toBeCloseTo(150, 9);
  });

  it('gives a log axis equal pixels for equal ratios — which a linear axis does not', () => {
    const s = logScale([50, 400], range);
    const a = s.project(50) - s.project(100);
    const b = s.project(100) - s.project(200);
    const c = s.project(200) - s.project(400);
    expect(b).toBeCloseTo(a, 9);
    expect(c).toBeCloseTo(a, 9);

    // The contrast is the assertion: on a linear axis the same three doublings are 1:2:4, so this
    // test fails if `logScale` is ever quietly wired to linear arithmetic.
    const lin = linearScale([50, 400], range);
    expect(lin.project(100) - lin.project(200)).not.toBeCloseTo(
      lin.project(200) - lin.project(400),
      3,
    );
  });

  it('labels a log axis with decades when it spans several, and 1/2/5 when it spans two', () => {
    expect(logScale([8, 30_000], range).ticks(6).map((t) => t.value)).toEqual([
      10, 100, 1000, 10_000,
    ]);
    expect(logScale([9, 400], range).ticks(8).map((t) => t.value)).toEqual([10, 20, 50, 100, 200]);
  });

  it('labels a log axis a real five-year price chart spans with the round numbers a reader wants', () => {
    // AAPL's five years in the fixture run from about 110 to 280 — four tenths of a decade. Decade
    // multiples would put one label on the whole axis, so §11.2's third regime applies and the
    // labels are the same round numbers a linear axis would choose. Asserted because it is a
    // deliberate design decision, not an accident of the data.
    const closes = DAILY.map((b) => b.close);
    const s = logScale([Math.min(...closes), Math.max(...closes)], range);
    const values = s.ticks(6).map((t) => t.value);
    expect(values.length).toBeGreaterThanOrEqual(4);
    const steps = values.slice(1).map((v, i) => v - (values[i] ?? 0));
    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    expect(values.every((v) => Number.isInteger(v / 25) || Number.isInteger(v / 20))).toBe(true);
  });

  it('picks tick values a human would pick, and never more than were asked for', () => {
    for (const [lo, hi] of [
      [0, 1],
      [147.3182, 149.9364],
      [-0.0034, 0.0112],
      [1_250_000, 4_900_000],
    ] as const) {
      const ticks = linearScale([lo, hi], range).ticks(5);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(7);
      const step = (ticks[1]?.value ?? 0) - (ticks[0]?.value ?? 0);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 2.5, 5, 10].some((r) => Math.abs(mantissa - r) < 1e-9)).toBe(true);
      // Every label must print its own value exactly: a 2.5-step axis labelled at 0 decimals reads
      // "3, 5, 8" for 2.5, 5, 7.5.
      for (const t of ticks) {
        expect(Number(t.label.replace(/[,%]/g, ''))).toBeCloseTo(t.value, 9);
      }
    }
  });

  it('widens a flat domain instead of dividing by a zero span', () => {
    const s = linearScale([3.5, 3.5], range);
    expect(s.domain[0]).toBeLessThan(3.5);
    expect(s.domain[1]).toBeGreaterThan(3.5);
    expect(Number.isFinite(s.project(3.5))).toBe(true);
  });

  it('targetYTickCount thins with the pane height', () => {
    expect(targetYTickCount(400, 14)).toBe(11);
    expect(targetYTickCount(60, 14)).toBe(2);
    expect(targetYTickCount(0, 14)).toBe(2);
  });
});

describe('yAxisScale — percent and base-100 normalisation (CLIENT.md §11.2, CHRT-03)', () => {
  const range = [300, 0] as const;
  const axis = (normalise: 'none' | 'pct' | 'base100'): ChartSpec['yAxes'][number] => ({
    id: 'y',
    side: 'right',
    scale: 'linear',
    fmt: 'px',
    decimals: 2,
    normalise,
  });
  const build = (normalise: 'none' | 'pct' | 'base100', view: Viewport) =>
    yAxisScale({
      axis: axis(normalise),
      series: [dailySeries],
      index: dailyIndex,
      view,
      range,
    });

  it('a plain axis covers the visible highs and lows, wicks included', () => {
    const view: Viewport = { slot0: 0, slot1: 99 };
    const s = build('none', view);
    const highs = DAILY.slice(0, 100).map((b) => b.high);
    const lows = DAILY.slice(0, 100).map((b) => b.low);
    expect(s.domain[1]).toBeGreaterThanOrEqual(Math.max(...highs));
    expect(s.domain[0]).toBeLessThanOrEqual(Math.min(...lows));
    // The closes alone would clip: the highest high of the window is above the highest close.
    expect(Math.max(...highs)).toBeGreaterThan(Math.max(...DAILY.slice(0, 100).map((b) => b.close)));
  });

  it("rebases 'pct' to the first visible point, and recomputes it on a pan", () => {
    const left: Viewport = { slot0: 0, slot1: 99 };
    const right: Viewport = { slot0: 100, slot1: 199 };
    const a = build('pct', left);
    const b = build('pct', right);

    const c0 = DAILY[0]!.close;
    const c100 = DAILY[100]!.close;
    expect(a.baseOf('p')).toBe(c0);
    expect(b.baseOf('p')).toBe(c100);
    expect(a.normalised('p', c0)).toBeCloseTo(0, 12);
    expect(b.normalised('p', c100)).toBeCloseTo(0, 12);
    expect(a.normalised('p', c100)).toBeCloseTo((c100 / c0 - 1) * 100, 9);

    // The pan is the interesting case: the SAME raw price lands on a different pixel after it,
    // because zero moved to the new left edge. A normalisation computed once from the series' first
    // point — the easy mistake — gives the same pixel twice and fails here.
    expect(b.y('p', c100)).not.toBeCloseTo(a.y('p', c100), 3);
    expect(a.normalised('p', c100)).not.toBeCloseTo(b.normalised('p', c100), 6);

    // Zero is in view on both, because both windows contain their own base.
    for (const s of [a, b]) {
      expect(s.domain[0]).toBeLessThanOrEqual(0);
      expect(s.domain[1]).toBeGreaterThanOrEqual(0);
      expect(s.ticks(6).some((t) => t.label.endsWith('%'))).toBe(true);
    }
  });

  it("rebases 'base100' so the first visible point reads 100", () => {
    const s = build('base100', { slot0: 500, slot1: 599 });
    expect(s.baseOf('p')).toBe(DAILY[500]!.close);
    expect(s.normalised('p', DAILY[500]!.close)).toBeCloseTo(100, 12);
    expect(s.normalised('p', DAILY[500]!.close * 1.1)).toBeCloseTo(110, 9);
    // Not labelled with the price format: a base-100 index of a yield curve would read "10,000%".
    expect(s.ticks(5).every((t) => !t.label.endsWith('%'))).toBe(true);
  });

  it('rebases every series on the axis, each to its own first visible point', () => {
    const overlay = priceSeries('o', INTRADAY);
    const index = new TradingDayIndex([
      { id: 'p', x: dailySeries.x },
      { id: 'o', x: overlay.x },
    ]);
    const view: Viewport = { slot0: 0, slot1: index.length - 1 };
    const s = yAxisScale({
      axis: axis('pct'),
      series: [dailySeries, overlay],
      index,
      view,
      range,
    });
    expect(s.baseOf('p')).toBe(DAILY[0]!.close);
    expect(s.baseOf('o')).toBe(INTRADAY[0]!.close);
    // AAPL near 150 and the S&P near 7 650 share one axis once both read zero at the left edge —
    // which is what normalisation is for (§11.2).
    expect(s.normalised('p', DAILY[0]!.close)).toBeCloseTo(0, 12);
    expect(s.normalised('o', INTRADAY[0]!.close)).toBeCloseTo(0, 12);
  });

  it('refuses a log axis where the values may be negative, and says so in `kind`', () => {
    // `normalise: 'pct'` centres a series on zero, and `log` cannot place a negative number. A
    // silently empty pane would be worse than a linear axis, so the axis reports what it built.
    const s = yAxisScale({
      axis: { id: 'y', side: 'right', scale: 'log', fmt: 'px', normalise: 'pct' },
      series: [dailySeries],
      index: dailyIndex,
      view: { slot0: 0, slot1: 99 },
      range,
    });
    expect(s.kind).toBe('linear');

    const plain = yAxisScale({
      axis: { id: 'y', side: 'right', scale: 'log', fmt: 'px' },
      series: [dailySeries],
      index: dailyIndex,
      view: { slot0: 0, slot1: 99 },
      range,
    });
    expect(plain.kind).toBe('log');
  });

  it('draws an honest empty pane when nothing finite is in view', () => {
    const s = yAxisScale({
      axis: axis('none'),
      series: [dailySeries],
      index: dailyIndex,
      view: { slot0: 5000, slot1: 5100 },
      range,
    });
    expect(s.domain).toEqual([0, 1]);
    expect(s.ticks(4).length).toBeGreaterThan(0);
  });
});

describe('axis tick selection at three zoom levels (CLIENT.md §11.2)', () => {
  const WIDTH = 900;
  const DIGIT_PX = 7;
  const GAP_CHARS = 2;

  const ticksFor = (view: Viewport) =>
    timeTicks({ index: dailyIndex, view, width: WIDTH, digitPx: DIGIT_PX, tz: NY });

  /** No two labels may overlap: the gap between them is at least their own width plus two chars. */
  function assertNoCollisions(view: Viewport, ticks: readonly { value: number; label: string }[]) {
    const px = slotScale(view, { x: 0, w: WIDTH });
    const x = (slot: number): number => px.x(slot);
    const widest = Math.max(0, ...ticks.map((t) => t.label.length));
    const need = (widest + GAP_CHARS) * DIGIT_PX;
    for (let i = 1; i < ticks.length; i += 1) {
      expect(x(ticks[i]!.value) - x(ticks[i - 1]!.value)).toBeGreaterThanOrEqual(need);
    }
    expect(x(ticks[ticks.length - 1]?.value ?? 0)).toBeLessThanOrEqual(WIDTH);
  }

  const monthOf = (t: number): string => nyDate(t).slice(0, 7);

  it('zoomed out over five years: every tick is a month boundary, none collide', () => {
    const view: Viewport = { slot0: 0, slot1: dailyIndex.length - 1 };
    const ticks = ticksFor(view);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    for (const t of ticks) {
      // A date label on a collapsed axis can only mean "this bar begins the period it names". Slot
      // 0 is exempt: the first bar of the series has no predecessor to differ from and always
      // carries a label, which is what keeps the left edge of the axis dated.
      if (t.value === 0) continue;
      expect(monthOf(dailyIndex.valueAt(t.value))).not.toBe(
        monthOf(dailyIndex.valueAt(t.value - 1)),
      );
    }
    assertNoCollisions(view, ticks);
  });

  it('zoomed to a quarter: the labels move to week boundaries', () => {
    const view: Viewport = { slot0: dailyIndex.length - 64, slot1: dailyIndex.length - 1 };
    const ticks = ticksFor(view);
    expect(ticks.length).toBeGreaterThanOrEqual(6);
    const weekOf = (slot: number): number =>
      Math.floor(
        Date.UTC(
          Number(nyDate(dailyIndex.valueAt(slot)).slice(0, 4)),
          Number(nyDate(dailyIndex.valueAt(slot)).slice(5, 7)) - 1,
          Number(nyDate(dailyIndex.valueAt(slot)).slice(8, 10)),
        ) /
          86_400_000 /
          7,
      );
    for (const t of ticks) {
      if (t.value === 0) continue;
      expect(weekOf(t.value)).not.toBe(weekOf(t.value - 1));
    }
    assertNoCollisions(view, ticks);
  });

  it('zoomed to a fortnight: every visible bar carries its own date', () => {
    const view: Viewport = { slot0: dailyIndex.length - 10, slot1: dailyIndex.length - 1 };
    const ticks = ticksFor(view);
    // Ten bars across 900 px: the finest granularity fits, so every one of them is labelled. A
    // fixed-count tick selection — ten evenly spaced labels whatever the data — cannot satisfy this
    // and the month-boundary assertion above at the same time.
    expect(ticks).toHaveLength(10);
    expect(ticks.map((t) => t.value)).toEqual([...Array(10).keys()].map((i) => view.slot0 + i));
    assertNoCollisions(view, ticks);
  });

  it('coarsens monotonically as the view widens — the three levels, compared', () => {
    const spacing = (view: Viewport): number => {
      const ticks = ticksFor(view);
      const gaps = ticks.slice(1).map((t, i) => t.value - (ticks[i]?.value ?? 0));
      gaps.sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)] ?? Number.NaN;
    };
    const wide = spacing({ slot0: 0, slot1: dailyIndex.length - 1 });
    const quarter = spacing({ slot0: dailyIndex.length - 64, slot1: dailyIndex.length - 1 });
    const fortnight = spacing({ slot0: dailyIndex.length - 10, slot1: dailyIndex.length - 1 });
    expect(wide).toBeGreaterThan(quarter);
    expect(quarter).toBeGreaterThan(fortnight);
    expect(fortnight).toBe(1);
  });

  it('labels an intraday axis with clock times, and a five-day view with fewer of them', () => {
    const index = new TradingDayIndex([{ id: 'spx', x: INTRADAY.map((b) => b.barTs) }]);
    const oneDay: Viewport = { slot0: 0, slot1: 77 };
    const fiveDays: Viewport = { slot0: 0, slot1: index.length - 1 };
    const of = (view: Viewport) =>
      timeTicks({ index, view, width: WIDTH, digitPx: DIGIT_PX, tz: NY });

    for (const t of of(oneDay)) expect(t.label).toMatch(/^\d{2}:\d{2}$/);
    expect(of(oneDay).length).toBeGreaterThan(of(fiveDays).length);
    // The first tick of the day is the 09:30 open in New York, not 13:30 UTC: the labels go through
    // core's zone table, the same one the session logic uses.
    expect(of(oneDay)[0]?.label).toBe('09:30');
  });

  it('returns nothing rather than overprinting when there is no room at all', () => {
    expect(timeTicks({ index: dailyIndex, view: { slot0: 0, slot1: 10 }, width: 0, digitPx: 7 })).toEqual(
      [],
    );
  });
});

describe('TenorScale and CategoryScale (CLIENT.md §11.2)', () => {
  const range = [0, 600] as const;

  it('labels a curve with the tenor ladder and compresses the long end', () => {
    // The domain GC and CRVF pass: `x` is `tenorDays`, 1 day to 30 years.
    const s = tenorScale([1, 10_957], range);
    const labels = s.ticks(10).map((t) => t.label);
    expect(labels).toContain('1M');
    expect(labels).toContain('1Y');
    expect(labels).toContain('30Y');
    const values = s.ticks(10).map((t) => t.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));

    // Log-ish (§11.2): the 1M→1Y stretch gets more pixels than 10Y→30Y, which a linear tenor axis
    // reverses — 11 months against 20 years.
    const shortEnd = s.project(365) - s.project(30);
    const longEnd = s.project(10_957) - s.project(3652);
    expect(shortEnd).toBeGreaterThan(longEnd);
    expect(s.project(1)).toBeCloseTo(range[0], 6);
    expect(s.invert(s.project(730))).toBeCloseTo(730, 6);
    // A curve whose first point is spot (0 days) still projects: `log1p`, not `log`, is why.
    const withSpot = tenorScale([0, 10_957], range);
    expect(withSpot.project(0)).toBeCloseTo(range[0], 6);
    expect(Number.isFinite(withSpot.project(0))).toBe(true);
  });

  it('does not print tenor labels on the strike axis OMON and OVML pass', () => {
    // Both screens set `xAxis.type: 'tenor'` with `x` in strikes (OMON) and spot prices (OVML),
    // because `ChartSpec.xAxis` has no type for "a numeric axis that is not time". A `6M` under the
    // strike 182 would be false, so the ladder is used only where the domain is a tenor domain.
    const strikes = tenorScale([150, 250], range);
    const labels = strikes.ticks(6).map((t) => t.label);
    expect(labels.some((l) => /^\d+[DWMY]$/.test(l))).toBe(false);
    expect(labels.every((l) => Number.isFinite(Number(l.replace(/,/g, ''))))).toBe(true);
    // Monotone and, over a 1.7× band, indistinguishable from linear — which is why sharing the
    // geometry is safe even though sharing the labels is not.
    expect(strikes.project(250)).toBeGreaterThan(strikes.project(150));
  });

  /**
   * The committed CRVF payload, not a hand-picked domain.
   *
   * The test above passes `[1, 10_957]`, which is the ladder's own first and last rung and therefore
   * the friendliest domain a tenor axis can be handed. `fixtures/golden/functions/CRVF.default.json`
   * is what the screen actually charts (`crvfChartSpec` maps `nodes[].days` and, for each comparison
   * curve, `Math.round(t * 365)`), and its union holds 182 365 730 1096 1826 2557 3653 7305 10958 from
   * the live curve plus 1095 1825 2555 3650 7300 10950 from the 2026-09-11 comparison — two tenors a
   * single day apart and a ten-year stretch, in one axis.
   *
   * That union is the whole argument for a tenor scale. Its geometry has to say that 1095 → 1096 is
   * one day and 3653 → 7305 is a decade; a slot-linear x axis — the renderer's — gives the two the
   * same width, which is the one thing a curve chart exists to show. The numbers asserted below are
   * therefore the *ratio* of those two spans on a 600 px axis, which is a property of `log1p` spacing
   * and not of this fixture's rounding, and the tick labels, because `axisLabel('int', 10_958)` is
   * "10,958" where the CRVF grid's own `tenor` column says `30Y`.
   */
  it('gives the real CRVF curve its shape, and its ticks the tenor names the grid uses', () => {
    interface CurvePayload {
      nodes: { days: number; tenor: string }[];
      compare: { nodes: { t: number }[] }[];
    }
    const payload = JSON.parse(
      readFileSync(join(REPO_ROOT, 'fixtures', 'golden', 'functions', 'CRVF.default.json'), 'utf8'),
    ) as CurvePayload;
    const days = [
      ...payload.nodes.map((n) => n.days),
      ...payload.compare.flatMap((c) => c.nodes.map((n) => Math.round(n.t * 365))),
    ].sort((a, b) => a - b);
    // The two tenors a day apart that the union really contains, and the grid label for the long end.
    expect(days).toContain(1095);
    expect(days).toContain(1096);
    expect(payload.nodes.at(-1)!.tenor).toBe('30Y');

    const s = tenorScale([days[0]!, days.at(-1)!], range, { fmt: 'int' });
    const oneDay = s.project(1096) - s.project(1095);
    const tenYears = s.project(7305) - s.project(3653);
    // 1095 → 1096 and 3653 → 7305 are both *adjacent pairs in the union index*, which is why this
    // ratio is the measurement that matters: a slot-linear x axis gives them the same width, exactly
    // 1. Here the day is 0.134 px of a 600 px axis and the decade is 101.6, so the decade is 760×
    // the wider. The bounds are loose enough that only the geometry, not the fixture's rounding,
    // decides them.
    expect(oneDay).toBeGreaterThan(0);
    expect(oneDay).toBeLessThan(0.2);
    expect(tenYears).toBeGreaterThan(90);
    expect(tenYears / oneDay).toBeGreaterThan(500);
    // And the positive form of the same property (§11.2's "log-ish"): equal *ratios* get equal
    // pixels. 365/182 and 7305/3653 are both a doubling of the tenor, and they come out 101.62 px
    // and 101.58 px — half a pixel apart on an axis where the second pair spans ten years and the
    // first spans six months.
    const sixMonthsToAYear = s.project(365) - s.project(182);
    expect(Math.abs(sixMonthsToAYear - tenYears)).toBeLessThan(0.5);
    // Monotone over every node the payload carries, and inside the axis rect.
    const xs = days.map((d) => s.project(d));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(range[0] - 1e-9);
    expect(Math.max(...xs)).toBeLessThanOrEqual(range[1] + 1e-9);

    // The labels are tenor names, not day counts: `6M` and `30Y` appear, `10,958` and `182` do not.
    const labels = s.ticks(8).map((t) => t.label);
    expect(labels).toContain('6M');
    expect(labels).toContain('30Y');
    expect(labels.some((l) => /[\d,]{4,}/.test(l))).toBe(false);
  });

  it('bands a category axis and inverts a pixel back to its band', () => {
    const s = categoryScale({ count: 4, rect: { x: 100, w: 400 }, categories: ['Q1', 'Q2', 'Q3', 'Q4'] });
    expect(s.bandPx).toBe(100);
    expect(s.x(0)).toBe(150);
    expect(s.x(3)).toBe(450);
    expect(s.indexAt(100)).toBe(0);
    expect(s.indexAt(499)).toBe(3);
    expect(s.indexAt(-50)).toBe(0);
    expect(s.indexAt(9999)).toBe(3);
    expect(s.ticks(4).map((t) => t.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(s.ticks(2).map((t) => t.label)).toEqual(['Q1', 'Q3']);
  });
});
