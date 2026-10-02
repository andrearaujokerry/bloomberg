// packages/web/test/chart/scales.test.ts — the chart's geometry, on the path that draws it.
//
// WORKPLAN's WP-14 acceptance row for this file is "log/percent/indexed scales, session-gap
// collapsing, axis tick selection at three zoom levels" (L1485), and each clause has a `describe`
// below.
//
// ## What changed here, because the previous version of this file was the problem
//
// It used to test `src/chart/scales.ts`, a 761-line module **no source file imported**. The renderer
// built its axes from its own private copy (`buildAxes`/`padded`/`scalesFor`/`normaliserFor`) and took
// its tick values from a third copy in `layers.ts`, so 29 green assertions here said nothing about any
// pixel the terminal ever drew — and both axis defects WP-14's audit found were in the copy that
// draws, neither of them in the copy under test. The file said so in its own header, which made it
// honest and left it useless.
//
// The duplication is gone (`src/chart/scales.ts`' header records which implementation survived each
// piece of geometry, and why), and so is the reason for a second kind of assertion. Everything below
// is now about code the product executes:
//
//   * `TradingDayIndex` — unchanged, and always was the drawn module.
//   * `linearScale` / `logScale` / `slotScale` — the two mappings `renderer.ts#scalesFor` and
//     `screen/widgets/Sparkline.tsx` both place every mark through.
//   * `layers.ts`' `niceTicks`, `logDecadeTicks`, `xTickStride`, `xLabeller`, `tenorLabel`,
//     `targetYTickCount` — the tick values and labels the gutters and the x strip are drawn from.
//   * **`Renderer` itself**, for the axis behaviour that only exists once a domain has been built from
//     data: the y domain, the per-series rebasing, the log axis, and the labels the gutter prints.
//     Those are asserted through the published surface — `layout()`, `hitTest()`, `setState()` — and
//     through the TEXT the renderer actually paints, captured off the 2-D context. A label asserted
//     that way cannot be green while the gutter is blank.
//
// ## What this file RECORDS rather than fixes
//
// The renderer's x axis is slot-linear for every `xAxis.type`, including `tenor`. §11.2 asks for
// log-ish spacing there, so on GC, CRVF, OMON and OVML a curve's shape is wrong: the last suite
// measures the size of that on the committed CRVF payload, on the renderer, and states the assertion
// as the record of a known deviation. The tenor LABELS are correct and drawn (`layers.ts#xLabeller`
// → `tenorLabel`), which is the half that was fixed; the spacing is the half that was not.
//
// ## Data and environment
//
// The data is the replay store's, not invented: `yahoo-chart-events.json` (1 255 daily AAPL bars,
// Sep 2021 → Sep 2026) for the daily axis and `yahoo-chart-SPX-5d-5m.json` (376 five-minute bars
// across five trading days, 2026-09-09 → 2026-09-15) for the intraday one. That matters most for the
// session-gap clause: a weekend and four overnight closes are things a fixture has and a hand-built
// array of consecutive integers does not, and collapsing them is the whole behaviour under test. No
// network, no database — the files are read from disk, which is what a `web` test may do (TESTING.md
// §2.1: the boundary rules scope to `packages/*/src/**`).
//
// jsdom notes (TESTING.md §2.2): `getBoundingClientRect` returns zeros and `ResizeObserver` never
// fires, so every size is set explicitly through `Renderer.resize`, and `frame(now)` is called
// directly rather than through the frame pump — what is under test is what one frame draws. The 2-D
// context is the `canvas` package's, the same one `renderer.test.ts`' pixel goldens need.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localClock } from '@terminal/core';
import { describe, expect, it } from 'vitest';

import {
  axisLabel,
  logDecadeTicks,
  niceTicks,
  targetYTickCount,
  tenorLabel,
  xLabeller,
  xTickStride,
  Y_TICK_TARGET,
} from '../../src/chart/layers.js';
import { Renderer } from '../../src/chart/renderer.js';
import type { RendererPlugins } from '../../src/chart/renderer.js';
import { linearScale, logScale, slotScale } from '../../src/chart/scales.js';
import { studies as studyRegistry } from '../../src/chart/studies/index.js';
import { GAP, TradingDayIndex } from '../../src/chart/tradingDayIndex.js';
import type {
  ChartFonts,
  ChartSeries,
  ChartSpec,
  ChartTheme,
  PaneLayout,
  Rect,
  Viewport,
} from '../../src/chart/types.js';
import { COLOUR_TOKENS } from '../../src/theme/colours.js';
import type { ColourToken } from '../../src/theme/colours.js';
import { crvfChartSpec } from '../../src/screens/CRVF/Screen.js';

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

/* ── the renderer, and the text it paints ───────────────────────────────────────────────────── */

/**
 * `renderer.test.ts`' measurement theme and fonts, repeated rather than imported.
 *
 * That file is a `describe`-level module with 2 000 lines of pixel-golden machinery around it, and
 * importing a constant out of a test file makes one suite's failure the other's too. The only
 * property this file needs of the theme is that the labels are drawn in a colour at all, and
 * `digitPx` is what `measureText('0')` reports for 11 px monospace under node-canvas — the same
 * number, because `xTickStride`'s arithmetic is in character widths and a different one would thin a
 * different number of ticks.
 */
const THEME: ChartTheme = {
  name: 'dark',
  colour: (() => {
    const colour = Object.fromEntries(COLOUR_TOKENS.map((t) => [t, '#303030'])) as Record<
      ColourToken,
      string
    >;
    colour['--c-bg'] = '#0b0b0b';
    colour['--c-bg-panel'] = '#141414';
    colour['--c-grid-line'] = '#2a2a2a';
    colour['--c-axis'] = '#4a4a4a';
    colour['--c-label'] = '#9a9a9a';
    colour['--c-series-1'] = '#3b82f6';
    colour['--c-series-2'] = '#22c55e';
    return colour;
  })(),
};

const FONTS: ChartFonts = {
  axis: '11px monospace',
  label: '11px monospace',
  readout: '11px monospace',
  lineHeightPx: 13,
  digitPx: 6.623046875,
};

const WIDTH = 900;
const HEIGHT = 400;

interface PaintedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

interface Painted {
  readonly renderer: Renderer;
  /** Every `fillText` call of every frame so far, base canvas and overlay, in order. */
  readonly painted: PaintedText[];
  /** `layout()` again after a `setState`, so a test never reads a stale rect. */
  panes(): PaneLayout[];
  /** The labels drawn inside one pane's y-axis gutter — what the price scale actually says. */
  yLabels(paneId?: string): string[];
  /** The labels drawn inside the shared x-axis strip. */
  xLabels(): string[];
  /** Re-render after a viewport change, clearing the capture so `yLabels()` is this frame's. */
  repaint(view: Viewport): void;
}

function inside(rect: Rect, p: PaintedText): boolean {
  return p.x >= rect.x - 1 && p.x <= rect.x + rect.w + 1 && p.y >= rect.y - 1 && p.y <= rect.y + rect.h + 1;
}

/**
 * Mount a spec, draw one frame, and keep every string the renderer painted.
 *
 * The capture is the point of this harness. `Renderer` has no accessor for its ticks — `yTicksOf` and
 * `xTicksOf` are private, and adding a public one for a test would be the "harness that pre-parsed
 * what the product path does not" from this build's catalogue of tests that cannot fail. Patching
 * `fillText` on the context the renderer was handed observes exactly what a reader sees in the gutter,
 * through `layers.ts#drawYAxis`, `drawXAxis` and `axisLabel`, with nothing re-implemented.
 */
function paint(
  spec: ChartSpec,
  opts: { width?: number; height?: number; plugins?: RendererPlugins } = {},
): Painted {
  const base = document.createElement('canvas');
  const overlay = document.createElement('canvas');
  const painted: PaintedText[] = [];
  for (const canvas of [base, overlay]) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      throw new Error(
        'no 2-D context: the `canvas` package did not build, and the axis-label assertions in this ' +
          'file need one (same dependency as renderer.test.ts’ pixel goldens).',
      );
    }
    const real = ctx.fillText.bind(ctx);
    ctx.fillText = (text: string, x: number, y: number): void => {
      painted.push({ text, x, y });
      real(text, x, y);
    };
  }
  const renderer = new Renderer(base, overlay, { dpr: 1, theme: THEME, fonts: FONTS });
  renderer.resize(opts.width ?? WIDTH, opts.height ?? HEIGHT, 1);
  // Before `setSpec`, because `setPlugins` recomputes the studies of whatever spec is already held and
  // there is none yet; `ChartCanvas` calls them in this order for the same reason.
  if (opts.plugins !== undefined) renderer.setPlugins(opts.plugins);
  renderer.setSpec(spec);
  renderer.frame(0);

  const panes = (): PaneLayout[] => renderer.layout();
  const paneOf = (paneId: string | undefined): PaneLayout => {
    const found = paneId === undefined ? panes()[0] : panes().find((p) => p.paneId === paneId);
    if (found === undefined) throw new Error(`no pane ${String(paneId)} in this layout`);
    return found;
  };
  return {
    renderer,
    painted,
    panes,
    yLabels: (paneId) => {
      const pane = paneOf(paneId);
      return painted.filter((p) => pane.yAxes.some((a) => inside(a.rect, p))).map((p) => p.text);
    },
    xLabels: () => {
      const strip = panes().find((p) => p.xAxis !== undefined)?.xAxis;
      if (strip === undefined) return [];
      return painted.filter((p) => inside(strip, p)).map((p) => p.text);
    },
    repaint: (view) => {
      painted.length = 0;
      renderer.setState({ view });
      renderer.frame(16);
    },
  };
}

/** A one-pane price spec over the daily fixture — the shape `gpChartSpec` produces, minimised. */
function priceSpec(overrides: {
  normalise?: 'none' | 'pct' | 'base100';
  scale?: 'linear' | 'log';
  fmt?: ChartSpec['yAxes'][number]['fmt'];
  decimals?: number;
  series?: ChartSeries[];
  reference?: ChartSpec['reference'];
  volumePane?: boolean;
} = {}): ChartSpec {
  const yAxes: ChartSpec['yAxes'] = [
    {
      id: 'y',
      side: 'right',
      scale: overrides.scale ?? 'linear',
      fmt: overrides.fmt ?? 'px',
      ...(overrides.decimals === undefined ? {} : { decimals: overrides.decimals }),
      normalise: overrides.normalise ?? 'none',
    },
  ];
  const panes: ChartSpec['panes'] = [{ id: 'main', height: overrides.volumePane === true ? 0.72 : 1 }];
  const series: ChartSeries[] = overrides.series ?? [dailySeries];
  if (overrides.volumePane === true) {
    // Exactly what `screens/GP/Screen.tsx` adds when `V` is on: a 13 %-tall pane, an `int` axis on the
    // left, and a `bar` series whose domain therefore includes zero (§11.3).
    yAxes.push({ id: 'vol', side: 'left', scale: 'linear', fmt: 'int' });
    panes.push({ id: 'vol', height: 0.13, title: 'Volume' });
    series.push({
      id: 'v',
      label: 'Volume',
      type: 'bar',
      pane: 'vol',
      yAxis: 'vol',
      x: DAILY.map((b) => b.barTs),
      y: DAILY.map((b) => b.volume),
      provIdx: 0,
    });
  }
  return {
    kind: 'price',
    xAxis: { type: 'time', tz: NY },
    yAxes,
    panes,
    series,
    ...(overrides.reference === undefined ? {} : { reference: overrides.reference }),
    crosshair: true,
  };
}

/**
 * The y domain the renderer built, in the series' own data coordinates.
 *
 * Read through `hitTest`, which is the published inverse: `valueAt(plot.y)` is the top of the domain
 * and `valueAt(plot.y + plot.h)` the bottom (`renderer.ts#scalesFor` — `1 - (py - plot.y) / plot.h`).
 * Reading it this way rather than from a private field is what makes these assertions about the
 * crosshair, the annotation anchors and `M` as well as about the axis: all four go through this one
 * inverse, which is the fix WP-14's audit asked for.
 */
function domainOf(p: Painted, paneId = 'main'): { lo: number; hi: number } {
  const pane = p.panes().find((x) => x.paneId === paneId);
  if (pane === undefined) throw new Error(`no pane ${paneId}`);
  const mid = pane.plot.x + pane.plot.w / 2;
  const top = p.renderer.hitTest(mid, pane.plot.y + 0.5);
  const bottom = p.renderer.hitTest(mid, pane.plot.y + pane.plot.h - 0.5);
  if (top?.kind !== 'plot' || bottom?.kind !== 'plot') {
    throw new Error(`hitTest did not land in the plot: ${JSON.stringify([top, bottom])}`);
  }
  return { lo: bottom.value, hi: top.value };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────── */

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

describe('linearScale and logScale — the mappings every chart draws through (§11.2)', () => {
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

  it('the pixel form and the unit form of one scale agree — they are TWO READERS, not two scales', () => {
    // `Sparkline` asks for pixels (`project`/`invert`); `renderer.ts#scalesFor` composes the unit form
    // with its own plot rect, because `plot.y + plot.h * (1 - u)` is the association every committed
    // hash in `renderer.test.ts` was taken through. Algebraically identical, so this is the assertion
    // that keeps them from becoming the two implementations this file used to be about.
    for (const s of [linearScale([147.31, 149.93], range), logScale([50, 400], range)]) {
      const [p0, p1] = s.range;
      for (const v of [s.domain[0], s.domain[1], (s.domain[0] + s.domain[1]) / 2]) {
        expect(s.project(v)).toBeCloseTo(p0 + (p1 - p0) * s.unit(v), 9);
      }
      for (const u of [0, 0.25, 0.5, 1]) {
        expect(s.value(u)).toBeCloseTo(s.invert(p0 + (p1 - p0) * u), 9);
        expect(s.unit(s.value(u))).toBeCloseTo(u, 9);
      }
    }
  });

  it('widens a flat domain instead of dividing by a zero span', () => {
    // `Sparkline`'s domain is the raw minimum and maximum of a payload's points and is routinely one
    // value (a single observation, a rate that has not moved). `renderer.ts#padded` has already
    // widened by the time a scale is built there, so this is the Sparkline path.
    const s = linearScale([3.5, 3.5], range);
    expect(s.domain[0]).toBeLessThan(3.5);
    expect(s.domain[1]).toBeGreaterThan(3.5);
    expect(Number.isFinite(s.project(3.5))).toBe(true);
    expect(Number.isFinite(s.unit(3.5))).toBe(true);
  });

  it('a non-positive value has no position on a log axis, and is not clamped to one', () => {
    const s = logScale([10, 1000], range);
    expect(Number.isNaN(s.project(0))).toBe(true);
    expect(Number.isNaN(s.project(-5))).toBe(true);
    // `series.ts` breaks a path on a non-finite coordinate (§11.3), so the point is dropped. A clamp
    // would draw it on the axis floor, which reads as a real value at a price it never traded at.
    expect(s.project(10)).toBeCloseTo(400, 9);
  });

  it('a slot occupies a band, and the span floors at one slot', () => {
    const s = slotScale({ slot0: 10, slot1: 19 }, { x: 100, w: 500 });
    expect(s.slotPx).toBe(50);
    expect(s.x(10)).toBe(125); // half a band in from the left edge: room for a candle body
    expect(s.x(19)).toBe(575);
    expect(s.slotAt(125)).toBeCloseTo(10, 9);
    // A click in the left half of the first bar hits that bar, not the one before it.
    expect(Math.round(s.slotAt(105))).toBe(10);
    // Zoomed past a single slot: one band wide, which is `renderer.ts#slotPxOf`'s own floor and now
    // the only one in the package.
    expect(slotScale({ slot0: 3, slot1: 3 }, { x: 0, w: 80 }).slotPx).toBe(80);
    expect(slotScale({ slot0: 3, slot1: 2.5 }, { x: 0, w: 80 }).slotPx).toBe(80);
  });
});

describe('the y axis the renderer builds from data (CLIENT.md §11.2, CHRT-03)', () => {
  it('covers the visible highs and lows, wicks included — not just the closes', () => {
    const p = paint(priceSpec());
    p.repaint({ slot0: 0, slot1: 99 });
    const { lo, hi } = domainOf(p);
    const window = DAILY.slice(0, 100);
    const highs = window.map((b) => b.high);
    const lows = window.map((b) => b.low);
    expect(hi).toBeGreaterThanOrEqual(Math.max(...highs));
    expect(lo).toBeLessThanOrEqual(Math.min(...lows));
    // The closes alone would clip: the highest high of the window is above the highest close.
    expect(Math.max(...highs)).toBeGreaterThan(Math.max(...window.map((b) => b.close)));
  });

  it('retracks the viewport: the domain of a later window is not the whole series’', () => {
    const p = paint(priceSpec());
    p.repaint({ slot0: 0, slot1: 99 });
    const early = domainOf(p);
    p.repaint({ slot0: 1100, slot1: 1199 });
    const late = domainOf(p);
    expect(late.lo).toBeGreaterThan(early.hi);
    const window = DAILY.slice(1100, 1200);
    expect(late.hi).toBeGreaterThanOrEqual(Math.max(...window.map((b) => b.high)));
    expect(late.lo).toBeLessThanOrEqual(Math.min(...window.map((b) => b.low)));
  });

  it("labels a 'pct' axis in percent, and rebases it on every pan (§11.2)", () => {
    const p = paint(priceSpec({ normalise: 'pct', decimals: 2 }));

    // The labels are the assertion, because they are what a reader sees and because the unit is the
    // half of this that was broken: `screens/GP/Screen.tsx` declares `fmt: unitFmt(primary.unit)`
    // whatever `normalise` is, so before `renderer.ts#rebasedLabel` a percent axis was labelled with
    // the price format and `N` on an equity chart printed "-4.23" for −4.23 %.
    p.repaint({ slot0: 0, slot1: 99 });
    const early = p.yLabels();
    expect(early.length).toBeGreaterThanOrEqual(2);
    for (const label of early) expect(label).toMatch(/%$/);
    // Zero is on the axis because the base is the first bar in view, by construction.
    expect(early.map((l) => Number(l.replace(/[,%]/g, '')))).toContain(0);

    // And the base MOVED. A normalisation computed once from the series' first point — the easy
    // mistake, and what `scales.test.ts` used to assert against a module that did not draw — would
    // put the whole 2026 window hundreds of per cent above zero and zero would be off the axis.
    p.repaint({ slot0: 1100, slot1: 1199 });
    const late = p.yLabels();
    for (const label of late) expect(label).toMatch(/%$/);
    expect(late.map((l) => Number(l.replace(/[,%]/g, '')))).toContain(0);
    const span = (labels: string[]): number => {
      const values = labels.map((l) => Number(l.replace(/[,%]/g, '')));
      return Math.max(...values) - Math.min(...values);
    };
    // Both windows read a few per cent either side of zero, which is only possible if each rebased
    // on its own left edge: the raw price rose from ~148 to ~330 between them.
    expect(span(early)).toBeLessThan(60);
    expect(span(late)).toBeLessThan(60);

    // `hitTest` still answers in DATA coordinates — the CHRT-05 property that made the inverse
    // necessary. The base price of the late window is inside the domain the axis is showing.
    const base = DAILY[1100]!.close;
    const { lo, hi } = domainOf(p);
    expect(base).toBeGreaterThanOrEqual(lo);
    expect(base).toBeLessThanOrEqual(hi);
    expect(hi).toBeGreaterThan(300); // a price, not a percentage
  });

  it("labels a 'base100' axis as a plain index, with the first visible point at 100", () => {
    const p = paint(priceSpec({ normalise: 'base100', fmt: 'pct', decimals: 4 }));
    p.repaint({ slot0: 500, slot1: 599 });
    const labels = p.yLabels();
    expect(labels.length).toBeGreaterThanOrEqual(2);
    // `fmt: 'pct'` is what a yield axis declares, and a base-100 index of a yield curve printed
    // through it reads "11,000%". Neither the percent sign nor the instrument's four decimals
    // survive a rebasing to an index.
    for (const label of labels) expect(label).not.toMatch(/%/);
    const values = labels.map((l) => Number(l.replace(/,/g, '')));
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.min(...values)).toBeLessThanOrEqual(100);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(100);

    const base = DAILY[500]!.close;
    const { lo, hi } = domainOf(p);
    expect(base).toBeGreaterThanOrEqual(lo);
    expect(base).toBeLessThanOrEqual(hi);
  });

  it('rebases every series on the axis to its OWN first visible point, which is what a comparison chart is', () => {
    // AAPL near 150 and the S&P near 7 650 on one axis. With `normalise: 'none'` the whole AAPL
    // series is a flat line on the floor; rebased, both start at zero and both are readable — the
    // entire purpose of CHRT-03 normalisation.
    const spx = priceSeries('o', INTRADAY);
    const both = [dailySeries, spx];
    const plain = paint(priceSpec({ series: both }));
    const pct = paint(priceSpec({ normalise: 'pct', series: both }));
    // The WHOLE union, because the five-minute capture sits in the last week of the five daily years:
    // a window of the first 400 slots holds AAPL alone, and an axis with one series on it would say
    // nothing about rebasing two.
    const union = new TradingDayIndex(both.map((series) => ({ id: series.id, x: series.x })));
    const view: Viewport = { slot0: 0, slot1: union.length - 1 };
    plain.repaint(view);
    pct.repaint(view);

    const plainDomain = domainOf(plain);
    // Unrebased, one axis has to hold both levels at once. The span is asserted rather than the
    // ratio, because §11.2's 4 % padding is a fraction of the SPAN: over 7 500 points of span it is
    // 300, which carries `lo` to −178 and makes a ratio meaningless.
    const span = plainDomain.hi - plainDomain.lo;
    expect(span).toBeGreaterThan(5_000);
    // AAPL's whole five years then occupy under a twentieth of the pane: the flat line on the floor
    // that normalisation exists to fix.
    const closes = DAILY.map((b) => b.close);
    expect((Math.max(...closes) - Math.min(...closes)) / span).toBeLessThan(0.05);

    // Rebased, the axis is in per cent and both series start at zero: the pane now holds a span of a
    // couple of hundred points of percentage instead of seven and a half thousand points of price.
    // AAPL more than doubled over the five years, so the top label is above 100 % and that is correct.
    const labels = pct.yLabels().map((l) => Number(l.replace(/[,%]/g, '')));
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels).toContain(0);
    const pctSpan = Math.max(...labels) - Math.min(...labels);
    expect(pctSpan).toBeLessThan(400);
    expect(pctSpan).toBeLessThan(span / 10);
    for (const label of pct.yLabels()) expect(label).toMatch(/%$/);
  });

  it('a log axis is drawn in log space and labelled with decades, and refuses to be one where it cannot', () => {
    const p = paint(priceSpec({ scale: 'log' }));
    p.repaint({ slot0: 0, slot1: dailyIndex.length - 1 });

    // THE GEOMETRY, through the published inverse: the value at the middle of the plot is the
    // GEOMETRIC mean of the domain on a log axis and the arithmetic mean on a linear one. Over
    // AAPL's five years (about 125 to 340) those are ~206 and ~233 — far enough apart that this
    // cannot pass against linear arithmetic.
    const pane = p.panes()[0]!;
    const mid = p.renderer.hitTest(pane.plot.x + pane.plot.w / 2, pane.plot.y + pane.plot.h / 2);
    expect(mid?.kind).toBe('plot');
    const { lo, hi } = domainOf(p);
    const geometric = Math.sqrt(lo * hi);
    const arithmetic = (lo + hi) / 2;
    expect(mid?.kind === 'plot' ? mid.value : Number.NaN).toBeCloseTo(geometric, 6);
    expect(Math.abs(arithmetic - geometric)).toBeGreaterThan(10);

    // A `pct` axis is centred on zero and a rebased value is routinely negative, so `log` there would
    // drop every non-positive point silently. The renderer builds linear instead — and the proof is
    // that the middle of the plot is the arithmetic mean again.
    const rebased = paint(priceSpec({ scale: 'log', normalise: 'pct' }));
    rebased.repaint({ slot0: 0, slot1: dailyIndex.length - 1 });
    const rpane = rebased.panes()[0]!;
    const rmid = rebased.renderer.hitTest(
      rpane.plot.x + rpane.plot.w / 2,
      rpane.plot.y + rpane.plot.h / 2,
    );
    const r = domainOf(rebased);
    expect(rmid?.kind === 'plot' ? rmid.value : Number.NaN).toBeCloseTo((r.lo + r.hi) / 2, 4);
  });

  it('keeps a `reference` rule inside the domain it is drawn on (§1.5, CHRT-03)', () => {
    // GP's prev close, par rate and strike. A reference noted RAW into a normalised domain widened a
    // pct axis to 0…334 for a series spanning 0…2.4 — both securities of a comparison chart then drew
    // as flat lines on the floor. The rule has to be rebased with the axis, and it has to be in view.
    const prevClose = DAILY[99]!.close;
    const p = paint(
      priceSpec({
        normalise: 'pct',
        reference: [{ yAxis: 'y', v: prevClose, label: 'Prev close' }],
      }),
    );
    p.repaint({ slot0: 0, slot1: 99 });
    const { lo, hi } = domainOf(p);
    expect(prevClose).toBeGreaterThanOrEqual(lo);
    expect(prevClose).toBeLessThanOrEqual(hi);
    const labels = p.yLabels().map((l) => Number(l.replace(/[,%]/g, '')));
    // Still a few per cent either side of zero: the reference did not drag the axis to the raw level.
    expect(Math.max(...labels.map(Math.abs))).toBeLessThan(60);
  });

  it('draws an honest empty pane when nothing finite is in view', () => {
    const p = paint(priceSpec());
    // Past the end of the data. `clampView` pins the viewport to the last slot, so the domain is the
    // last bar's own range rather than a `NaN` axis — and the gutter still says what it is showing.
    p.repaint({ slot0: 5000, slot1: 5100 });
    const labels = p.yLabels();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(Number(label.replace(/,/g, ''))).not.toBeNaN();
    const { lo, hi } = domainOf(p);
    expect(Number.isFinite(lo)).toBe(true);
    expect(Number.isFinite(hi)).toBe(true);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('y tick selection and labelling on the path that draws (layers.ts)', () => {
  it('picks the values a human would pick, and never more than were asked for', () => {
    for (const [lo, hi] of [
      [0, 1],
      [147.3182, 149.9364],
      [-0.0034, 0.0112],
      [1_250_000, 4_900_000],
    ] as const) {
      const ticks = niceTicks(lo, hi, 5);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(7);
      const step = (ticks[1] ?? 0) - (ticks[0] ?? 0);
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      // 1/2/5/10 and NOT 2.5: the unplugged module had a 2.5 rung and this one does not, which is
      // recorded in `scales.ts`' header as a deliberate non-adoption — it would move every y tick of
      // every committed chart golden. Asserted so that nobody adds it without regenerating those.
      expect([1, 2, 5, 10].some((r) => Math.abs(mantissa - r) < 1e-9)).toBe(true);
      for (const t of ticks) expect(t).toBeGreaterThanOrEqual(lo);
      for (const t of ticks) expect(t).toBeLessThanOrEqual(hi + step * 1e-9);
    }
  });

  it('says what it is showing rather than nothing, on a degenerate domain', () => {
    // A gridline cannot be drawn without a value, and an axis with no labels is not an axis.
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
    expect(logDecadeTicks(0, 100)).toEqual([]);
    expect(logDecadeTicks(100, 100)).toEqual([100]);
  });

  it('marks a log axis with decades across several, and with round numbers inside one', () => {
    expect(logDecadeTicks(8, 30_000)).toEqual([10, 100, 1000, 10_000]);
    // Inside one decade there are no decade marks at all, so the linear picker is used — which is
    // correct in log space because these are VALUES, and the alternative is an axis with one label.
    // AAPL's five years in the fixture span about 125 to 340: four tenths of a decade.
    const closes = DAILY.map((b) => b.close);
    const ticks = logDecadeTicks(Math.min(...closes), Math.max(...closes), 5);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    const steps = ticks.slice(1).map((v, i) => v - (ticks[i] ?? 0));
    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
  });

  it('every label the gutter prints parses back to the tick it is on', () => {
    // The property `decimalsFor` existed for in the deleted module, asserted where it matters: on a
    // real axis, through `axisLabel` and the one formatter. A 2.5-rung step labelled at 0 decimals
    // reads "3, 5, 8" for 2.5, 5, 7.5 — three labels, two of them wrong, on an axis a level is read
    // off. It holds here because the drawn ladder has no 2.5 rung and prices carry two decimals.
    const p = paint(priceSpec({ decimals: 2 }));
    p.repaint({ slot0: 1100, slot1: 1199 });
    const labels = p.yLabels();
    expect(labels.length).toBeGreaterThanOrEqual(2);
    const { lo, hi } = domainOf(p);
    for (const label of labels) {
      const v = Number(label.replace(/,/g, ''));
      expect(v, `"${label}" is not a number`).not.toBeNaN();
      expect(axisLabel('px', v, 2)).toBe(label); // round-trips through the formatter
      expect(v).toBeGreaterThanOrEqual(lo - 1);
      expect(v).toBeLessThanOrEqual(hi + 1);
    }
  });

  it('thins the labels a short pane cannot fit, and only those (§11.2)', () => {
    expect(targetYTickCount(400, 13)).toBe(12);
    expect(targetYTickCount(60, 13)).toBe(2);
    expect(targetYTickCount(0, 13)).toBe(2);
    expect(targetYTickCount(400, 0)).toBe(2);

    // Measured on the renderer, over the GP layout that actually contains a short pane: a 72 %
    // price pane and a 13 % volume pane in a 400 px canvas, which leaves the volume gutter about
    // 35 px of plot. `layers.ts#drawYAxis` prints every tick it is handed inside the plot band and
    // thins nothing, so before the ceiling the volume axis printed SIX `int` labels into those 35 px —
    // seven pixels apart at a 13 px line height, drawn through each other.
    const p = paint(priceSpec({ decimals: 2, volumePane: true }));
    p.repaint({ slot0: 1100, slot1: 1199 });
    const panes = p.panes();
    expect(panes.map((q) => q.paneId)).toEqual(['main', 'vol']);

    for (const pane of panes) {
      const ys = p.painted
        .filter((t) => pane.yAxes.some((a) => inside(a.rect, t)))
        .map((t) => t.y)
        .sort((a, b) => a - b);
      expect(ys.length, `no y labels on ${pane.paneId}`).toBeGreaterThanOrEqual(2);
      expect(ys.length).toBeLessThanOrEqual(Y_TICK_TARGET + 1);
      for (let i = 1; i < ys.length; i += 1) {
        const gap = (ys[i] ?? 0) - (ys[i - 1] ?? 0);
        expect(
          gap,
          `two ${pane.paneId} labels ${String(gap)} px apart in a ${String(pane.plot.h)} px plot`,
        ).toBeGreaterThanOrEqual(FONTS.lineHeightPx);
      }
    }

    // And the ceiling only ever bites where it must: the 261 px price pane, whose own ceiling is 8 and
    // whose target is therefore the unchanged 5, keeps more labels than the 35 px volume pane.
    const countIn = (pane: PaneLayout): number =>
      p.painted.filter((t) => pane.yAxes.some((a) => inside(a.rect, t))).length;
    expect(panes[0]!.plot.h).toBeGreaterThan(200);
    expect(panes[1]!.plot.h).toBeLessThan(60);
    expect(targetYTickCount(panes[0]!.plot.h, FONTS.lineHeightPx)).toBeGreaterThan(Y_TICK_TARGET);
    expect(countIn(panes[0]!)).toBeGreaterThan(countIn(panes[1]!));
  });
});

/**
 * The case the ceiling was WRITTEN for, which nothing drew until now.
 *
 * `layers.ts#targetYTickCount`'s own note cites "a `sub` study pane 16 px tall — three studies in `sub`
 * take `0.15 / 3` of the canvas each (§11.6)", and that layout appeared in no golden and no spec: the
 * thirteen series goldens in `fixtures/golden/chart/series-hashes.json` are single-pane, and the
 * ceiling's other assertion above is made on GP's VOLUME pane. A volume pane and a study pane are not
 * the same pane — a study pane's axis is built from a study's OUTPUT and labelled from the study's own
 * `yFmt` (`renderer.ts#studyAxisOf`, `studyFmtOf`), not from a series — so the ceiling reaching one was
 * an inference. This draws it.
 *
 * Built as `screens/GP/Screen.tsx#gpChartSpec` builds it (L123-131, L147-156): one `main` pane at 0.72
 * with the volume pane on, each `sub` study its own pane of `0.15 / subStudies.length`, the study
 * entries pointing at `st0`/`st1`/`st2` and `inputSeriesId: 'p'`. The registry is the shipped one, so
 * the studies really compute and the panes really have a domain — without it `renderer.ts` leaves the
 * study panes empty (its `RendererPlugins` note says so) and this would assert over blank gutters.
 *
 * ## What drawing it found, which is why the geometry is pinned and not only the tick count
 *
 * Measured on this layout in a 900 × 400 canvas at a 13 px line height, when this suite was written:
 *
 *     main y=0   h=288    5 labels
 *     vol  y=303 h=37     2 labels
 *     st0  y=340 h=20     1 label
 *     st1  y=360 h=20     1 label
 *     st2  y=380 h=3      1 label
 *
 * `st2`'s plot was **three pixels tall**, because the bottom pane paid for the whole x strip:
 * `computeLayout` shared the full canvas height out by the fractions and only then trimmed
 * `xAxisHeightPx(fonts)` — 17 px here — off whichever pane was last, so a 20 px band became a 3 px
 * plot. GP's fractions sum to exactly 1.00 (0.72 + 0.13 + 3 × 0.05) and reserve nothing for the strip,
 * which was half of it; the other half was that the strip is shared furniture and one pane was charged
 * for all of it.
 *
 * **That is fixed, and this is the test that said so.** The assertion below was written bounded ABOVE —
 * `toBeLessThan(8)` — precisely so that a fix would arrive here as a failure with the new geometry in
 * it rather than as a silent improvement, and that is how it arrived. `xAxisHeightPx` now comes out of
 * the height the fractions divide and is given back to the last open pane's band, so the three study
 * panes are within a pixel of one another and the assertion compares the bottom one to its sibling
 * instead of to a literal.
 *
 * No committed pixel hash moved, and that is a property rather than luck: for a single open pane the
 * new arithmetic is the old arithmetic (`openHeight = H − strip`, band `= openHeight + strip = H`,
 * plot `= band − strip`), and `fixtures/golden/chart/series-hashes.json`'s twelve cases are all single
 * pane. The suite in `renderer.test.ts` that renders the six real multi-pane screens asserts ink and
 * no throw, not pixels, and is unaffected. `assertSinglePaneUnchanged` below pins the identity.
 */
describe('a study sub-pane is 16 px tall, and its axis says so (§11.6, §11.2)', () => {
  const SUB_STUDIES = ['RSI', 'MACD', 'ROC'] as const;

  /** GP with the volume pane and three `sub` studies — the layout `targetYTickCount`'s note cites. */
  function studySpec(): ChartSpec {
    const base = priceSpec({ decimals: 2, volumePane: true });
    const panes = [...base.panes];
    // No y axis per study pane, which is `gpChartSpec`'s own shape and not an oversight here:
    // `renderer.ts#studyAxisOf` gives a study pane the pane's first axis and rebuilds its domain from
    // the study's output, so the axis list stays the price spec's.
    SUB_STUDIES.forEach((_id, i) => {
      panes.push({ id: `st${String(i)}`, height: 0.15 / SUB_STUDIES.length });
    });
    return {
      ...base,
      panes,
      studies: SUB_STUDIES.map((id, i) => ({
        id,
        params: {},
        pane: `st${String(i)}`,
        inputSeriesId: 'p',
      })),
    };
  }

  const plugins: RendererPlugins = { studies: studyRegistry };

  it('gives each one a domain of its own, and the bottom one the same band as its siblings', () => {
    const p = paint(studySpec(), { plugins });
    const panes = p.panes();
    expect(panes.map((q) => q.paneId)).toEqual(['main', 'vol', 'st0', 'st1', 'st2']);

    // The two full-height study panes are the 16-20 px band the ceiling's note is about, measured
    // rather than restated from the fraction.
    for (const pane of panes.slice(2, 4)) {
      expect(pane.plot.h, `${pane.paneId} plot height`).toBeGreaterThan(12);
      expect(pane.plot.h, `${pane.paneId} plot height`).toBeLessThan(26);
    }
    /**
     * AND THE BOTTOM ONE, which was three pixels tall and is now its siblings' height.
     *
     * This was the assertion that recorded the defect: `toBeLessThan(8)`, bounded above so that a fix
     * to who pays for the x strip would show up here as a failure. It did. `computeLayout` now takes
     * `xAxisHeightPx` out of the height the fractions divide and gives it back to the last open pane's
     * BAND, so the strip is shared furniture paid for in proportion and every plot is its own fraction
     * of what is left. The three study panes are within a pixel of each other, which is what equal
     * fractions are supposed to mean.
     *
     * Asserted against its siblings rather than as a literal, because the quantity that was wrong was
     * the RELATIONSHIP: a literal would pass again the moment a font metric moved it back.
     */
    const bottom = panes[4];
    const sibling = panes[3];
    expect(bottom).toBeDefined();
    expect(sibling).toBeDefined();
    if (bottom === undefined || sibling === undefined) return;
    expect(
      Math.abs(bottom.plot.h - sibling.plot.h),
      'the bottom study pane is no longer charged for the whole x strip',
    ).toBeLessThanOrEqual(1);
    expect(bottom.plot.h, 'and it is a pane a study can be read in').toBeGreaterThan(12);
    expect(bottom.xAxis, 'and it is still the pane that carries the strip').toBeDefined();
    // The strip sits below that pane's plot, inside its band — not over it.
    expect(bottom.xAxis?.y).toBeGreaterThanOrEqual(bottom.plot.y + bottom.plot.h);
    // And no pixel of the canvas is unassigned, which is the invariant the reservation must not break.
    const total = panes.reduce((sum, q) => sum + q.rect.h, 0);
    expect(Math.abs(total - 400)).toBeLessThanOrEqual(1);

    // Three panes, three domains: RSI is bounded 0-100, MACD is a price difference and ROC a
    // percentage either side of zero, so three identical domains would mean no study output reached an
    // axis — which is what would make every assertion below vacuous.
    const domains = panes.slice(2, 4).map((pane) => domainOf(p, pane.paneId));
    for (const d of domains) expect(d.hi, JSON.stringify(d)).toBeGreaterThan(d.lo);
    expect(new Set(domains.map((d) => `${d.lo.toFixed(4)}:${d.hi.toFixed(4)}`)).size).toBe(2);
  });

  /**
   * THE REASON NO COMMITTED PIXEL HASH MOVED, as an assertion rather than as a paragraph.
   *
   * Reserving the strip before the fractions is an IDENTITY for a single open pane — `openHeight` loses
   * the strip, the one band gets it straight back, and `plotH` trims it off again — so every one of
   * `series-hashes.json`'s twelve single-pane cases draws into the same rect it always did. If a later
   * change to this arithmetic breaks that identity, this fails here with the geometry in hand instead of
   * as twelve hash mismatches in another file.
   */
  it('leaves a single-pane chart’s plot rect exactly where it was', () => {
    const one = paint({ ...priceSpec({ decimals: 2 }), panes: [{ id: 'main', height: 1 }] });
    const main = one.panes()[0];
    expect(main).toBeDefined();
    if (main === undefined) return;
    // The canvas is 400 px tall and the strip is `xAxisHeightPx(fonts)`; the plot is the rest of it.
    expect(main.rect.h).toBe(400);
    expect(main.plot.y).toBe(0);
    expect(main.plot.h).toBe(400 - (main.xAxis?.h ?? 0));
    expect(main.xAxis?.y).toBe(main.plot.h);
  });

  it('prints at most two labels in each, and never two that touch', () => {
    // THE ASSERTION. `layers.ts#drawYAxis` thins nothing — it prints every tick handed to it that lands
    // in the plot band — so without the ceiling `niceTicks(lo, hi, 5)` hands a 20 px pane five values
    // and they are drawn through one another at a 13 px line height. `targetYTickCount(20, 13)` is 2.
    // Measured by reverting the `Math.min` in `renderer.ts#yTicksOf` to a bare `Y_TICK_TARGET`: `st0`
    // then draws FIVE labels in its 20 px, which is what makes this assertion red the other way round
    // (and the volume suite above red too, at 10.5 px between two labels).
    const p = paint(studySpec(), { plugins });
    for (const pane of p.panes().slice(2)) {
      expect(targetYTickCount(pane.plot.h, FONTS.lineHeightPx), pane.paneId).toBe(2);
      const ys = p.painted
        .filter((t) => pane.yAxes.some((a) => inside(a.rect, t)))
        .map((t) => t.y)
        .sort((a, b) => a - b);
      expect(ys.length, `${pane.paneId} drew no label at all`).toBeGreaterThanOrEqual(1);
      expect(
        ys.length,
        `${pane.paneId} drew ${String(ys.length)} labels in ${String(pane.plot.h)} px`,
      ).toBeLessThanOrEqual(2);
      for (let i = 1; i < ys.length; i += 1) {
        const gap = (ys[i] ?? 0) - (ys[i - 1] ?? 0);
        expect(
          gap,
          `two ${pane.paneId} labels ${String(gap)} px apart in a ${String(pane.plot.h)} px plot`,
        ).toBeGreaterThanOrEqual(FONTS.lineHeightPx);
      }
    }
  });

  it('and the price pane above them keeps every label it had', () => {
    // The other direction, so that "the ceiling only removes labels that collided" is a measurement and
    // not a claim: the same five-pane layout still gives `main` its full `Y_TICK_TARGET` worth, which is
    // what makes the two assertions above about SHORT panes rather than about a renderer that had
    // stopped labelling anything.
    const p = paint(studySpec(), { plugins });
    const main = p.panes()[0];
    expect(main).toBeDefined();
    if (main === undefined) return;
    expect(targetYTickCount(main.plot.h, FONTS.lineHeightPx)).toBeGreaterThanOrEqual(Y_TICK_TARGET);
    const labels = p.yLabels('main');
    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(labels.length).toBeLessThanOrEqual(Y_TICK_TARGET + 1);
  });
});

describe('x axis tick selection at three zoom levels (CLIENT.md §11.2)', () => {
  /** The spec the x-strip assertions are made against: the whole daily fixture on a time axis. */
  const spec = priceSpec();

  /** The gap in slots between consecutive drawn x labels, as the strip actually printed them. */
  function strideOf(p: Painted): number[] {
    const strip = p.panes().find((x) => x.xAxis !== undefined)?.xAxis;
    if (strip === undefined) return [];
    const xs = p.painted
      .filter((t) => inside(strip, t))
      .map((t) => t.x)
      .sort((a, b) => a - b);
    return xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
  }

  const monthOf = (t: number): string => nyDate(t).slice(0, 7);

  it('zoomed out over five years: the strip prints dates, coarsely, without overprinting', () => {
    const p = paint(spec);
    p.repaint({ slot0: 0, slot1: dailyIndex.length - 1 });
    const labels = p.xLabels();
    expect(labels.length).toBeGreaterThanOrEqual(4);
    for (const label of labels) expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The widest label is ten characters, and `xTickStride` reserves two more: no two labels of the
    // strip may be closer than that, which is the collision rule stated in pixels.
    //
    // The FIRST and LAST gaps are excluded, and that is `drawXAxis`' documented clamp rather than a
    // tolerance: a label that would overhang the strip is pulled inside it, because the leftmost and
    // rightmost ticks are the two a trader reads first. Measured here, the first tick moves 32.8 px
    // right and its gap closes from 79.7 px to 46.9. Every interior gap is the stride itself.
    const gaps = strideOf(p);
    const interior = gaps.slice(1, -1);
    expect(interior.length, 'too few labels to have an interior gap').toBeGreaterThanOrEqual(2);
    const need = (10 + 2) * FONTS.digitPx;
    for (const gap of interior) expect(gap).toBeGreaterThanOrEqual(need - 1);
  });

  it('coarsens monotonically as the view widens — the three levels, compared', () => {
    const median = (xs: number[]): number => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
    };
    const slotsBetweenLabels = (view: Viewport): number => {
      const p = paint(spec);
      p.repaint(view);
      const slotPx = slotScale(view, p.panes()[0]!.plot).slotPx;
      return median(strideOf(p)) / slotPx;
    };
    const wide = slotsBetweenLabels({ slot0: 0, slot1: dailyIndex.length - 1 });
    const quarter = slotsBetweenLabels({ slot0: dailyIndex.length - 64, slot1: dailyIndex.length - 1 });
    const fortnight = slotsBetweenLabels({ slot0: dailyIndex.length - 10, slot1: dailyIndex.length - 1 });
    expect(wide).toBeGreaterThan(quarter);
    expect(quarter).toBeGreaterThan(fortnight);
    // At a fortnight on a 900 px strip every visible bar carries its own date: the finest granularity
    // fits. A fixed label count — ten evenly spaced labels whatever the zoom — cannot satisfy this
    // and the coarsening above at the same time.
    expect(fortnight).toBeCloseTo(1, 6);
  });

  it('every drawn date is the date of the bar under it, in the exchange’s zone', () => {
    const p = paint(spec);
    const view: Viewport = { slot0: dailyIndex.length - 10, slot1: dailyIndex.length - 1 };
    p.repaint(view);
    const x = slotScale(view, p.panes()[0]!.plot);
    const strip = p.panes().find((q) => q.xAxis !== undefined)?.xAxis;
    expect(strip).not.toBeUndefined();
    const drawn = p.painted.filter((t) => strip !== undefined && inside(strip, t));
    expect(drawn.length).toBe(10);
    for (const label of drawn) {
      const slot = Math.round(x.slotAt(label.x));
      // `nyDate` is core's zone table — the same one the session shading and the server use, so an
      // axis cannot disagree with the candle above it about which day it is.
      expect(label.text).toBe(nyDate(dailyIndex.valueAt(slot)));
      expect(monthOf(dailyIndex.valueAt(slot))).toBe(label.text.slice(0, 7));
    }
  });

  it('labels an intraday strip with clock times in the exchange’s zone, and thins them over five days', () => {
    const intradaySpec: ChartSpec = {
      ...priceSpec({ series: [priceSeries('spx', INTRADAY)] }),
      kind: 'intraday',
      xAxis: { type: 'time', tz: NY, sessions: intradaySessions() },
    };
    const oneDay = paint(intradaySpec);
    oneDay.repaint({ slot0: 0, slot1: 77 });
    const times = oneDay.xLabels();
    expect(times.length).toBeGreaterThan(2);
    for (const label of times) expect(label).toMatch(/^\d{2}:\d{2}$/);
    // 09:30 in New York, not 13:30 UTC.
    expect(times[0]).toBe('09:30');

    // Over five sessions the strip coarsens in SLOTS, not in label count: `xTickStride` reserves the
    // same character width whatever the zoom, so a full strip stays full and the gap between labelled
    // bars widens. Measured here: one labelled bar in 5 over one session, one in 21 over five.
    const fiveDays = paint(intradaySpec);
    const wide: Viewport = { slot0: 0, slot1: INTRADAY.length - 1 };
    fiveDays.repaint(wide);
    const strideIn = (p: Painted, view: Viewport): number => {
      const strip = p.panes().find((q) => q.xAxis !== undefined)?.xAxis;
      if (strip === undefined) return Number.NaN;
      const xs = p.painted
        .filter((t) => inside(strip, t))
        .map((t) => t.x)
        .sort((a, b) => a - b);
      const gaps = xs.slice(1, -1).map((x, i) => x - (xs[i + 1 - 1] ?? 0));
      const slotPx = slotScale(view, p.panes()[0]!.plot).slotPx;
      return Math.min(...gaps) / slotPx;
    };
    for (const label of fiveDays.xLabels()) expect(label).toMatch(/^\d{2}:\d{2}$/);
    expect(strideIn(fiveDays, wide)).toBeGreaterThan(strideIn(oneDay, { slot0: 0, slot1: 77 }));
    // RECORDED, and it is the `toMatch` loop above that records it: over five sessions EVERY label is
    // a clock time and nothing on the strip names a day, so a reader cannot tell the Friday from the
    // Monday. §11.2's "first slot of a period" would label the session boundaries; the drawn path
    // thins by pixel only. An x-strip change, and not one to make inside a deduplication.
    expect(fiveDays.xLabels().some((l) => /\d{4}-\d{2}-\d{2}/.test(l))).toBe(false);
  });

  it('reserves room per label rather than hoping — `xTickStride` in characters', () => {
    // The stride is the one place the axis cost is bounded: `measureText` per tick would make the
    // axis scale with its tick count for an answer that cannot differ, because the axis font is
    // monospace with tabular figures (§12.3).
    expect(xTickStride(60, 10, FONTS)).toBe(2); // 12 chars ≈ 79 px needed, 60 px a slot
    expect(xTickStride(1, 10, FONTS)).toBe(80);
    expect(xTickStride(0, 10, FONTS)).toBeGreaterThan(1_000);
    expect(xTickStride(500, 5, FONTS)).toBe(1); // never zero: a stride of 0 is an infinite loop
  });
});

describe('the tenor x axis: the labels are right and the spacing is a known deviation (§11.2)', () => {
  /**
   * The committed CRVF payload, not a hand-picked domain.
   *
   * `fixtures/golden/functions/CRVF.default.json` is what the screen actually charts
   * (`crvfChartSpec` maps `nodes[].days` and, for each comparison curve, `Math.round(t * 365)`), and
   * its union holds 182 365 730 1096 1826 2557 3653 7305 10958 from the live curve plus 1095 1825
   * 2555 3650 7300 10950 from the 2026-09-11 comparison — two tenors a single day apart and a
   * ten-year stretch, in one axis. That union is the whole argument for a tenor scale, and it is the
   * measurement below.
   */
  function crvfPayload(): unknown {
    return JSON.parse(
      readFileSync(join(REPO_ROOT, 'fixtures', 'golden', 'functions', 'CRVF.default.json'), 'utf8'),
    );
  }

  it('names each node the way the grid beside it does — `30Y`, not `10,958`', () => {
    // `layers.ts#xLabeller` → `tenorLabel`, which is on the drawn path and is shared by the strip,
    // the canvas readout and `ChartCanvas`' DOM readout. Before it existed all three ran a day count
    // through a DATE formatter and every curve chart in the product announced `1970-01-01`.
    for (const [days, name] of [
      [30, '1M'],
      [91, '3M'],
      [182, '6M'],
      [365, '1Y'],
      [1826, '5Y'],
      [3652, '10Y'],
      [10_957, '30Y'],
      [0, 'SPOT'],
    ] as const) {
      expect(tenorLabel(days)).toBe(name);
    }
    // A node between two rungs is named honestly rather than rounded onto one: 1 300 days is 3.6
    // years, not the `4Y` a ladder lookup would have had to call it or the nothing it would answer.
    expect(tenorLabel(1300)).toBe('3.6Y');
    expect(tenorLabel(1096)).toBe('3Y');

    const payload = crvfPayload() as { nodes: { days: number; tenor: string }[] };
    expect(payload.nodes.at(-1)!.tenor).toBe('30Y');
    // The names the chart draws are the names the grid prints, node for node.
    for (const node of payload.nodes) expect(tenorLabel(node.days)).toBe(node.tenor);
  });

  it('strikes are not tenors: the ladder is chosen by the domain, not by the axis type', () => {
    // GC and CRVF put DAYS on `xAxis.type: 'tenor'` while OMON's smile puts STRIKES and OVML's
    // profile puts SPOT PRICES, because `ChartSpec.xAxis` has no fourth type. `6M` printed under a
    // strike of 182 would be a false label rather than merely an unhelpful one.
    const curve: ChartSpec = { ...priceSpec(), kind: 'curve', xAxis: { type: 'tenor' } };
    const asTenor = xLabeller(curve, 1, 10_957);
    const asStrike = xLabeller(curve, 150, 250);
    expect(asTenor(0, 365)).toBe('1Y');
    expect(asStrike(0, 182)).not.toMatch(/^\d+[DWMY]$/);
    // `px` and not `int`, because a strike of 352.5 exists and rounding it names a contract that
    // does not.
    expect(asStrike(0, 352.5)).toBe('352.50');
  });

  it('KNOWN DEVIATION: the renderer spaces curve nodes equally, where §11.2 asks for log-ish', () => {
    // THIS ASSERTION RECORDS A DEFECT AND MUST BE INVERTED WHEN IT IS FIXED. `renderer.ts#scalesFor`
    // builds its x mapping with `slotScale` for every `xAxis.type`, so a curve's nodes are drawn in
    // the right ORDER at the wrong WIDTHS: on GC, CRVF, OMON and OVML the axis says that 1 095 days →
    // 1 096 days (one day) and 3 653 days → 7 305 days (a decade) are the same distance, which is the
    // one thing a curve chart exists to show. WP-14 shipped a `tenorScale` for exactly this and never
    // imported it; the module is gone and the deviation is measured here, on the renderer, where it
    // can be seen. Closing it is an x-axis change to `renderer.ts` — `slotScaleOf`, `xTicksOf`,
    // `hitTest` and the annotation anchors all read the slot mapping — and is deliberate work.
    const payload = crvfPayload();
    const spec = crvfChartSpec(payload as Parameters<typeof crvfChartSpec>[0], ['par']);
    const p = paint(spec);
    const pane = p.panes()[0]!;
    const index = new TradingDayIndex(spec.series.map((s) => ({ id: s.id, x: s.x })));
    const view: Viewport = { slot0: 0, slot1: index.length - 1 };
    p.repaint(view);
    const x = slotScale(view, pane.plot);

    // The union the payload really carries, measured rather than assumed: sixteen slots, the live
    // curve's `nodes[].days` interleaved with the 2026-09-11 comparison's `Math.round(t * 365)`. Most
    // rungs land a day or a few apart (182 beside 183, 1095 beside 1096, 7300 beside 7305) and one
    // adjacent pair is three and a half thousand days wide (3653 → 7300). Both extremes in one axis is
    // the whole argument for a tenor scale.
    const days: number[] = [];
    for (let slot = 0; slot < index.length; slot += 1) days.push(index.valueAt(slot));
    expect(days.length).toBe(16);
    expect(days).toContain(1095);
    expect(days).toContain(1096);

    const pxGap: number[] = [];
    const dayGap: number[] = [];
    for (let slot = 1; slot < index.length; slot += 1) {
      pxGap.push(x.x(slot) - x.x(slot - 1));
      dayGap.push((days[slot] ?? 0) - (days[slot - 1] ?? 0));
    }
    // EVERY adjacent pair is the same number of pixels apart, whatever it is in days. That is the
    // deviation, stated exactly: one slot each.
    for (const gap of pxGap) expect(gap).toBeCloseTo(x.slotPx, 9);
    expect(Math.min(...dayGap)).toBe(1);
    expect(Math.max(...dayGap)).toBeGreaterThan(3_000);
    expect(Math.max(...pxGap) / Math.min(...pxGap)).toBeCloseTo(1, 9);

    // What §11.2 asks for, for the size of the error: `log1p` spacing over the same domain gives the
    // widest adjacent pair (3 653 → 7 300 days) 127 times the width of the narrowest (182 → 183), where
    // slot-linear gives them exactly the same width. The bound is loose enough that only the geometry,
    // not this payload's rounding, decides it.
    const logish = linearScale(
      [Math.log1p(days[0] ?? 0), Math.log1p(days.at(-1) ?? 1)],
      [pane.plot.x, pane.plot.x + pane.plot.w],
    );
    const wanted = (a: number, b: number): number =>
      logish.project(Math.log1p(b)) - logish.project(Math.log1p(a));
    const widest = dayGap.indexOf(Math.max(...dayGap));
    const narrowest = dayGap.indexOf(1);
    const ratio =
      wanted(days[widest] ?? 0, days[widest + 1] ?? 0) /
      wanted(days[narrowest] ?? 0, days[narrowest + 1] ?? 0);
    expect(ratio).toBeGreaterThan(100);
  });
});
