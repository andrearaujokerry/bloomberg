/**
 * packages/web/test/chart/renderer.test.ts — WP-14's acceptance row: "golden-pixel snapshots
 * (canvas → PNG hash) for each `SeriesType` on a fixed dataset" (WORKPLAN L1483, CLIENT.md §11.1-11.3,
 * CHRT-01..03, DATA-10).
 *
 * **A pixel golden of a renderer that draws nothing passes forever.** That is the failure mode this
 * file is built against, because a blank canvas hashes stably, a golden records the blank hash
 * happily, and the suite stays green while every chart on the terminal is empty. One hash per series
 * type is not a test of anything; four independent properties over those hashes is:
 *
 *   (a) **not blank** — each of the twelve hashes differs from a canvas of the same size holding
 *       nothing but the background, and that background hash is computed here rather than written
 *       down, so it cannot drift out of agreement with the theme. On its own this one is weak, and
 *       measurably so: stubbing all twelve draw functions still passes it, because the gridlines and
 *       the axis labels are not blank. That is why (b), (c) and (d) exist — with all twelve stubbed,
 *       each of those three fails, and so do all seven real-screen cases.
 *   (b) **all twelve distinct from each other** — a `series.ts` whose draw functions all returned
 *       immediately would produce twelve *identical* hashes, which is the single cheapest way to
 *       catch a stub. Candle and ohlc over the same bars must not be the same bytes; nor line and
 *       step, nor area and mountain.
 *   (c) **deterministic and sensitive** — the same spec rendered twice is byte-identical (node-canvas
 *       3.2.3 at dpr 1 is, which is what makes a byte golden legitimate here rather than a fuzzy
 *       compare), and the same spec with ONE close changed by 5 % is not. A draw function that ignored
 *       its data would pass (a) and (b) and fails this.
 *   (d) **a real quantity of ink** — the *chromatic* pixel count, which is what the theme below is
 *       shaped for: every furniture token is a neutral grey and every series colour is saturated, so
 *       a pixel whose channels disagree is series ink and nothing else. Gridlines, axis labels, pane
 *       titles and the legend text contribute exactly zero to it. A one-pixel dot that satisfied (a)
 *       scores 1 against a floor of 200, and a stub scores 0.
 *
 * Together those cannot be satisfied by a blank canvas, by a stub, by a draw function that ignores
 * its data, or by a renderer that draws one mark and stops. The recorded hashes in
 * `fixtures/golden/chart/series-hashes.json` then do the job a golden is actually good at: telling
 * whoever changes a draw function that they changed it, and by how much ink.
 *
 * **The dataset** is on disk and no test here reaches the network (FEED-08, QA-02). Ten of the twelve
 * types share 120 daily bars of `yahoo-chart-events.json`; `profile` needs intraday bars and takes
 * them from `yahoo-chart-AAPL-1d-1m.json`; `heatmap` needs a category × category grid, which no bar
 * series is, and gets one built from the same closes. Both deviations are stated where they are made.
 *
 * **And the six real screens.** A renderer tested only on specs this file invented is the WP-12
 * mistake repeated, so the last suite renders what `gpChartSpec`, `gipChartSpec`, `gcChartSpec`,
 * `crvfChartSpec`, `omonSmileSpec` and `ovmlProfileSpec` actually produce from the committed payload
 * goldens, and asserts each draws ink without throwing.
 *
 * jsdom notes (TESTING.md §2.2): `getBoundingClientRect` returns zeros and `ResizeObserver` never
 * fires, so every size here is set explicitly through `Renderer.resize`; `frame(now)` is called
 * directly rather than through the frame pump, because what is under test is what one frame draws.
 * `fileURLToPath` is fed `dirname` rather than a `new URL`, for the reason `no-direct-io.test.ts`
 * gives: jsdom's global `URL` is not the one Node's helper accepts.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifests } from '@terminal/core';
import type { FunctionCode, ParamsOf, PayloadOf } from '@terminal/core';
import { describe, expect, it, vi } from 'vitest';

import { computeLayout, axisGutterPx, xAxisHeightPx, paneTitleHeightPx } from '../../src/chart/layers.js';
import { Renderer } from '../../src/chart/renderer.js';
import { pnfBoxSize, pnfColumns, profileTpo, SERIES_DRAWS } from '../../src/chart/series.js';
import type {
  ChartFonts,
  ChartSeries,
  ChartSpec,
  ChartTheme,
  PaneLayout,
  SeriesType,
} from '../../src/chart/types.js';
import { SERIES_TYPES } from '../../src/chart/types.js';
import { defaultParams, studies } from '../../src/chart/studies/index.js';
import { STUDY_IDS } from '../../src/chart/studies/types.js';
import type { StudyDef, StudyId } from '../../src/chart/studies/types.js';
import { COLOUR_TOKENS } from '../../src/theme/colours.js';
import type { ColourToken } from '../../src/theme/colours.js';
import { gpChartSpec } from '../../src/screens/GP/Screen.js';
import { gipChartSpec } from '../../src/screens/GIP/Screen.js';
import { gcChartSpec } from '../../src/screens/GC/Screen.js';
import { crvfChartSpec } from '../../src/screens/CRVF/Screen.js';
import { omonSmileSpec } from '../../src/screens/OMON/Screen.js';
import { ovmlProfileSpec } from '../../src/screens/OVML/Screen.js';

/* ── paths and fixtures ─────────────────────────────────────────────────────────────────────── */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = dirname(dirname(TEST_DIR));
const REPO_ROOT = dirname(dirname(WEB_ROOT));
const NORMALISED = join(REPO_ROOT, 'fixtures', 'providers', 'normalised');
const PAYLOADS = join(REPO_ROOT, 'fixtures', 'golden', 'functions');
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'chart');
const GOLDEN_FILE = join(GOLDEN_DIR, 'series-hashes.json');

interface NormalisedBar {
  barTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Bars {
  t: number[];
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

/**
 * `count` bars of a normalised capture.
 *
 * **Which capture, and why not the one CLIENT.md names.** §11.6 sends the *study* goldens to
 * `yahoo-chart-AAPL-max-1d.json`, and that capture came back at `dataGranularity: 3mo` — 169
 * QUARTERLY bars, recorded as a bad capture in TESTING.md L748 and WORKPLAN §18.14. A "daily" chart
 * golden computed on quarterly bars would be a picture of something this renderer never draws, so the
 * daily cases here use `yahoo-chart-events.json` (1 255 genuine daily bars, 20 dividends) and the
 * intraday case uses `yahoo-chart-AAPL-1d-1m.json` (316 one-minute bars). Stated, not silent.
 */
function loadBars(file: string, count: number): Bars {
  const raw = JSON.parse(readFileSync(join(NORMALISED, file), 'utf8')) as { bars: NormalisedBar[] };
  const bars = raw.bars.slice(0, count);
  expect(bars.length, `${file} has fewer than ${String(count)} bars`).toBe(count);
  return {
    t: bars.map((b) => b.barTs),
    o: Float64Array.from(bars, (b) => b.open),
    h: Float64Array.from(bars, (b) => b.high),
    l: Float64Array.from(bars, (b) => b.low),
    c: Float64Array.from(bars, (b) => b.close),
    v: Float64Array.from(bars, (b) => b.volume),
  };
}

const DAILY = loadBars('yahoo-chart-events.json', 120);
const INTRADAY = loadBars('yahoo-chart-AAPL-1d-1m.json', 240);

function payload<C extends FunctionCode>(name: string): PayloadOf<C> {
  return JSON.parse(readFileSync(join(PAYLOADS, name), 'utf8')) as PayloadOf<C>;
}

function defaults<C extends FunctionCode>(code: C): ParamsOf<C> {
  return manifests[code].params.parse({}) as ParamsOf<C>;
}

/* ── the test theme and fonts ───────────────────────────────────────────────────────────────── */

/**
 * A theme built for measurement, and the reason assertion (d) is precise.
 *
 * Every furniture token is a neutral grey (`r === g === b`) and every series/semantic token is
 * saturated, so "a pixel whose channels disagree by more than 20" means "a series drew here" — the
 * grid, the axis rules, the labels, the pane titles and the legend text are all excluded by
 * construction rather than by a rect that hopes to miss them. Antialiasing preserves the property:
 * a grey blended with a grey background is still grey.
 *
 * `--c-flat` is chromatic here although a shipped dark theme would grey it, because `bar` draws a
 * series with no direction in `neutral` (§11.3) and a grey volume histogram would be invisible to the
 * ink count while being perfectly visible on screen — the measurement must not decide that the
 * commonest bar series in the product draws nothing.
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
    colour['--c-value'] = '#e8e8e8';
    colour['--c-muted'] = '#7a7a7a';
    colour['--c-up'] = '#16a34a';
    colour['--c-down'] = '#dc2626';
    colour['--c-flat'] = '#9a7bd0';
    colour['--c-crosshair'] = '#d0a000';
    colour['--c-focus'] = '#e0b000';
    colour['--c-series-1'] = '#3b82f6';
    colour['--c-series-2'] = '#22c55e';
    colour['--c-series-3'] = '#ef4444';
    colour['--c-series-4'] = '#eab308';
    colour['--c-series-5'] = '#a855f7';
    colour['--c-series-6'] = '#06b6d4';
    return colour;
  })(),
};

/** 11 px monospace: `digitPx` is what `measureText('0')` reports for it under node-canvas. */
const FONTS: ChartFonts = {
  axis: '11px monospace',
  label: '11px monospace',
  readout: '11px monospace',
  lineHeightPx: 13,
  digitPx: 6.623046875,
};

const WIDTH = 480;
const HEIGHT = 320;
const DPR = 1;

/* ── canvas helpers ─────────────────────────────────────────────────────────────────────────── */

interface Mounted {
  readonly renderer: Renderer;
  readonly base: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
}

function mount(
  spec: ChartSpec,
  opts: { width?: number; height?: number; plugins?: Parameters<Renderer['setPlugins']>[0] } = {},
): Mounted {
  const base = document.createElement('canvas');
  const overlay = document.createElement('canvas');
  const renderer = new Renderer(base, overlay, { dpr: DPR, theme: THEME, fonts: FONTS });
  renderer.resize(opts.width ?? WIDTH, opts.height ?? HEIGHT, DPR);
  if (opts.plugins !== undefined) renderer.setPlugins(opts.plugins);
  renderer.setSpec(spec);
  renderer.frame(0);
  return { renderer, base, overlay };
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error(
      'no 2-D context: the `canvas` package did not build, and every pixel golden in this file ' +
        'needs one (WORKPLAN L1483 — the fallback is Playwright, not a skip).',
    );
  }
  return ctx;
}

function hashOf(canvas: HTMLCanvasElement): string {
  return createHash('sha256').update(canvas.toDataURL()).digest('hex');
}

function pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return context(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Pixels whose channels disagree — series ink, by the construction of `THEME` (see (d) above). */
function chromaticPixels(data: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 20) n += 1;
  }
  return n;
}

/** Pixels that are not the background colour — the weaker "something was drawn" measure. */
function nonBackgroundPixels(data: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs((data[i] ?? 0) - 0x0b) > 6 || Math.abs((data[i + 1] ?? 0) - 0x0b) > 6) n += 1;
  }
  return n;
}

function differingPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n += 1;
  }
  return n;
}

/**
 * Series ink: chromatic pixels inside a pane's plot, **below the legend block**.
 *
 * The exclusion is not tidiness. A legend swatch is drawn in its series' colour, so it is chromatic
 * ink that exists whether or not the series drew anything — and that is not hypothetical: stubbing all
 * twelve draw functions left CRVF's six swatches scoring 144 px, which passed a 100 px floor on a
 * canvas with no data on it at all. Measuring below the legend is what makes this count mean "a series
 * drew", which is the only thing it is used to assert.
 */
function seriesInk(canvas: HTMLCanvasElement, pane: PaneLayout, legendRows: number): number {
  const legendH = legendRows * FONTS.lineHeightPx + 4;
  const y = Math.floor(pane.plot.y + legendH);
  const h = Math.floor(pane.plot.y + pane.plot.h - y);
  if (h <= 0 || pane.plot.w <= 0) return 0;
  return chromaticPixels(
    context(canvas).getImageData(Math.floor(pane.plot.x), y, Math.floor(pane.plot.w), h).data,
  );
}

/** The hash of a canvas of the same size holding nothing but the background — assertion (a). */
function blankHash(): string {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * DPR;
  canvas.height = HEIGHT * DPR;
  const ctx = context(canvas);
  ctx.fillStyle = THEME.colour['--c-bg'];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return hashOf(canvas);
}

/**
 * Counts the *path* calls on one context — the work a draw does, not the pixels it lands.
 *
 * The distinction is what makes §11.5's last-slot redraw testable at all. A clip that narrows the
 * pixels but still walks every bar of the series produces a picture identical to a full redraw, so no
 * pixel comparison can tell the two apart; the operation count can, and the budget (< 2 ms per append)
 * is a claim about work.
 */
function countPathOps(ctx: CanvasRenderingContext2D): { get(): number } {
  const spies = [
    vi.spyOn(ctx, 'moveTo'),
    vi.spyOn(ctx, 'lineTo'),
    vi.spyOn(ctx, 'fillRect'),
    vi.spyOn(ctx, 'strokeRect'),
    vi.spyOn(ctx, 'fillText'),
    vi.spyOn(ctx, 'arc'),
  ];
  return { get: () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
}

/** The context calls that put ink on a canvas; anything else cannot change a pixel. */
const INK_CALLS = ['stroke', 'fill', 'fillRect', 'strokeRect', 'fillText', 'clearRect'] as const;

/**
 * Counts the ink-producing calls on one context, for the dirty-tracking assertions.
 *
 * `vi.spyOn` without a mock implementation calls through, so the drawing still happens and the pixel
 * comparisons beside these counts stay meaningful — the spy is a counter, not a stub.
 */
function countOps(ctx: CanvasRenderingContext2D): { get(): number } {
  const spies = [
    vi.spyOn(ctx, 'stroke'),
    vi.spyOn(ctx, 'fill'),
    vi.spyOn(ctx, 'fillRect'),
    vi.spyOn(ctx, 'strokeRect'),
    vi.spyOn(ctx, 'fillText'),
    vi.spyOn(ctx, 'clearRect'),
  ];
  expect(spies).toHaveLength(INK_CALLS.length);
  return { get: () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0) };
}

/* ── the twelve specs ───────────────────────────────────────────────────────────────────────── */

const AXES: ChartSpec['yAxes'] = [
  { id: 'y', side: 'right', scale: 'linear', fmt: 'px', decimals: 2 },
];

function barSeries(type: SeriesType, bars: Bars): ChartSeries {
  const series: ChartSeries = {
    id: 'p',
    label: 'AAPL US Equity',
    type,
    pane: 'main',
    yAxis: 'y',
    x: bars.t,
    y: bars.c,
    provIdx: 0,
    style: { color: 'auto' },
  };
  // `candle`, `ohlc` and `pnf`'s box size read the bar; `bar` and `tick` read the size. Spread
  // conditionally: with `exactOptionalPropertyTypes` a present-but-undefined `ohlc` is not the same
  // type as an absent one, and the draw functions branch on absence.
  if (type === 'candle' || type === 'ohlc' || type === 'pnf' || type === 'profile') {
    return { ...series, ohlc: { o: bars.o, h: bars.h, l: bars.l, c: bars.c } };
  }
  if (type === 'bar' || type === 'tick') return { ...series, volume: bars.v };
  return series;
}

/**
 * The spec for one series type over the fixed dataset.
 *
 * Ten types are the same 120 daily bars with the same axis, which is what makes assertion (b) mean
 * something: the only difference between the `candle` render and the `ohlc` render is the draw
 * function. Two cannot be:
 *   * `profile` buckets 30-minute TPO periods out of intraday bars (§11.3), so it takes 240
 *     one-minute bars and a `kind: 'intraday'` spec;
 *   * `heatmap` is category × category with the value in `volume` (§11.3), which no bar series is, so
 *     it gets a 12 × 8 grid built from the same closes — deterministic, and derived from the fixture
 *     rather than invented.
 */
function specFor(type: SeriesType): ChartSpec {
  if (type === 'profile') {
    return {
      kind: 'intraday',
      xAxis: { type: 'time', tz: 'America/New_York' },
      yAxes: AXES,
      panes: [{ id: 'main', height: 1 }],
      series: [barSeries('profile', INTRADAY)],
      crosshair: true,
    };
  }
  if (type === 'heatmap') {
    const cols = 12;
    const rows = 8;
    const x: number[] = [];
    const y: number[] = [];
    const value = new Float64Array(cols * rows);
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) {
        const i = c * rows + r;
        x.push(c);
        y.push(r);
        value[i] = DAILY.c[i] ?? 0;
      }
    }
    return {
      kind: 'surface',
      xAxis: { type: 'category', categories: Array.from({ length: cols }, (_v, i) => `C${String(i)}`) },
      yAxes: [{ id: 'y', side: 'left', scale: 'linear', fmt: 'int', decimals: 0 }],
      panes: [{ id: 'main', height: 1 }],
      series: [
        {
          id: 'surface',
          label: 'IV surface',
          type: 'heatmap',
          pane: 'main',
          yAxis: 'y',
          x,
          y,
          volume: value,
          provIdx: 0,
          style: { color: 'auto' },
        },
      ],
      crosshair: true,
    };
  }
  return {
    kind: 'price',
    xAxis: { type: 'time', tz: 'America/New_York', calendarId: 'XNYS' },
    yAxes: AXES,
    panes: [{ id: 'main', height: 1 }],
    series: [barSeries(type, DAILY)],
    crosshair: true,
  };
}

/** The same spec with one close moved 5 % — assertion (c)'s sensitivity half. */
function perturbed(type: SeriesType): ChartSpec {
  const spec = specFor(type);
  const series = spec.series[0];
  expect(series).toBeDefined();
  if (series === undefined) return spec;
  if (type === 'heatmap') {
    const value = Float64Array.from(series.volume ?? new Float64Array(0));
    value[30] = (value[30] ?? 0) * 1.05;
    return { ...spec, series: [{ ...series, volume: value }] };
  }
  const y = Float64Array.from(series.y);
  const index = Math.min(60, y.length - 1);
  y[index] = (y[index] ?? 0) * 1.05;
  const next: ChartSeries = { ...series, y };
  if (series.ohlc !== undefined) {
    const c = Float64Array.from(series.ohlc.c);
    const h = Float64Array.from(series.ohlc.h);
    c[index] = (c[index] ?? 0) * 1.05;
    h[index] = Math.max(h[index] ?? 0, c[index] ?? 0);
    next.ohlc = { o: series.ohlc.o, h, l: series.ohlc.l, c };
  }
  return { ...spec, series: [next] };
}

/* ── the golden index ───────────────────────────────────────────────────────────────────────── */

interface GoldenCase {
  hash: string;
  chromaticPx: number;
}

interface GoldenIndex {
  note: string;
  canvas: { width: number; height: number; dpr: number };
  recordedWith: { canvas: string; platform: string };
  cases: Record<string, GoldenCase>;
}

function canvasVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'node_modules', 'canvas', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGolden(): GoldenIndex | null {
  return existsSync(GOLDEN_FILE)
    ? (JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as GoldenIndex)
    : null;
}

/* ── suites ─────────────────────────────────────────────────────────────────────────────────── */

describe('Renderer.layout — pane bands, axis gutters, the x strip and the event band (§11.1)', () => {
  const spec: ChartSpec = {
    kind: 'price',
    xAxis: { type: 'time' },
    yAxes: [
      { id: 'y', side: 'right', scale: 'linear', fmt: 'px', decimals: 2 },
      { id: 'left1', side: 'left', scale: 'linear', fmt: 'pct' },
      { id: 'left2', side: 'left', scale: 'linear', fmt: 'pct' },
      { id: 'left3', side: 'left', scale: 'linear', fmt: 'pct' },
      { id: 'vol', side: 'left', scale: 'linear', fmt: 'int' },
    ],
    panes: [
      { id: 'main', height: 0.72 },
      { id: 'vol', height: 0.13, title: 'Volume' },
    ],
    series: [
      { id: 'p', label: 'P', type: 'line', pane: 'main', yAxis: 'y', x: [1], y: [1], provIdx: 0 },
      { id: 'a', label: 'A', type: 'line', pane: 'main', yAxis: 'left1', x: [1], y: [1], provIdx: 1 },
      { id: 'b', label: 'B', type: 'line', pane: 'main', yAxis: 'left2', x: [1], y: [1], provIdx: 1 },
      { id: 'c', label: 'C', type: 'line', pane: 'main', yAxis: 'left3', x: [1], y: [1], provIdx: 1 },
      { id: 'v', label: 'V', type: 'bar', pane: 'vol', yAxis: 'vol', x: [1], y: [1], provIdx: 0 },
    ],
    events: [{ t: 1, kind: 'dividend', label: 'D', command: 'CACS', provIdx: 2 }],
    crosshair: true,
  };

  it('renormalises height fractions that do not sum to 1 (GP with a volume pane sums to 0.85)', () => {
    const panes = computeLayout({
      spec,
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
      collapsedPanes: new Set(),
      eventBand: true,
    });
    expect(panes).toHaveLength(2);
    const total = panes.reduce((sum, p) => sum + p.rect.h, 0);
    // Every pixel of the canvas is assigned: the spec's 0.72 + 0.13 must not leave a grey band.
    expect(Math.abs(total - HEIGHT)).toBeLessThanOrEqual(1);
    const main = panes[0];
    const vol = panes[1];
    expect(main?.rect.h).toBeGreaterThan((vol?.rect.h ?? 0) * 4);
  });

  it('renders at most two gutters a side; the third left axis shares the outermost (§11.2)', () => {
    const panes = computeLayout({
      spec,
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
      collapsedPanes: new Set(),
      eventBand: true,
    });
    const main = panes[0];
    expect(main).toBeDefined();
    const left = (main?.yAxes ?? []).filter((a) => a.side === 'left');
    expect(left).toHaveLength(3);
    const xs = new Set(left.map((a) => a.rect.x));
    expect(xs.size).toBe(2);
    // The plot is inset by two gutters on the left and one on the right, not by three on the left.
    expect(main?.plot.x).toBe(2 * axisGutterPx(FONTS));
    expect(main?.plot.w).toBe(WIDTH - 3 * axisGutterPx(FONTS));
  });

  it('puts the x-axis strip on the bottom open pane and the event band on the main pane', () => {
    const panes = computeLayout({
      spec,
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
      collapsedPanes: new Set(),
      eventBand: true,
    });
    expect(panes[0]?.xAxis).toBeUndefined();
    expect(panes[1]?.xAxis).toBeDefined();
    expect(panes[0]?.eventBand).toBeDefined();
    expect(panes[1]?.eventBand).toBeUndefined();
    // The band and the strip come out of the plot, so nothing is drawn over them.
    expect((panes[0]?.plot.y ?? 0) + (panes[0]?.plot.h ?? 0)).toBe(panes[0]?.eventBand?.y);
  });

  it('gives a collapsed pane its title bar and nothing else, and the rest of the height to the others', () => {
    const open = computeLayout({
      spec,
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
      collapsedPanes: new Set(),
      eventBand: false,
    });
    const closed = computeLayout({
      spec,
      width: WIDTH,
      height: HEIGHT,
      fonts: FONTS,
      collapsedPanes: new Set(['vol']),
      eventBand: false,
    });
    expect(closed[1]?.collapsed).toBe(true);
    expect(closed[1]?.rect.h).toBe(paneTitleHeightPx(FONTS));
    expect(closed[1]?.plot.h).toBe(0);
    expect(closed[0]?.plot.h ?? 0).toBeGreaterThan(open[0]?.plot.h ?? 0);
    // The x-axis strip moves up to the pane that is still open.
    expect(closed[0]?.xAxis?.h).toBe(xAxisHeightPx(FONTS));
  });
});

describe('pixel goldens: every SeriesType draws, distinctly, from the data (CHRT-01)', () => {
  const rendered = new Map<
    SeriesType,
    { hash: string; data: Uint8ClampedArray; ink: number; seriesInk: number }
  >();

  for (const type of SERIES_TYPES) {
    const mounted = mount(specFor(type));
    const data = pixels(mounted.base);
    const pane = mounted.renderer.layout()[0];
    rendered.set(type, {
      hash: hashOf(mounted.base),
      data,
      ink: chromaticPixels(data),
      seriesInk: pane === undefined ? 0 : seriesInk(mounted.base, pane, 1),
    });
  }

  it('(a) none of the twelve is a blank canvas', () => {
    const blank = blankHash();
    for (const type of SERIES_TYPES) {
      expect(rendered.get(type)?.hash, `${type} rendered nothing but the background`).not.toBe(blank);
    }
  });

  it('(b) all twelve hashes are distinct from each other', () => {
    const hashes = SERIES_TYPES.map((t) => rendered.get(t)?.hash ?? t);
    expect(new Set(hashes).size).toBe(SERIES_TYPES.length);
    // Named explicitly because these are the pairs a stub or a copy-paste would collapse.
    expect(rendered.get('candle')?.hash).not.toBe(rendered.get('ohlc')?.hash);
    expect(rendered.get('line')?.hash).not.toBe(rendered.get('step')?.hash);
    expect(rendered.get('area')?.hash).not.toBe(rendered.get('mountain')?.hash);
    expect(rendered.get('line')?.hash).not.toBe(rendered.get('area')?.hash);
    expect(rendered.get('scatter')?.hash).not.toBe(rendered.get('tick')?.hash);
  });

  it('(c) the same spec is byte-identical twice, and one changed close is not', () => {
    for (const type of SERIES_TYPES) {
      const again = mount(specFor(type));
      expect(hashOf(again.base), `${type} is not deterministic`).toBe(rendered.get(type)?.hash);
      const changed = mount(perturbed(type));
      expect(hashOf(changed.base), `${type} ignores its data`).not.toBe(rendered.get(type)?.hash);
    }
  });

  it('(d) each type puts a real quantity of series ink on the canvas', () => {
    const plotPx = WIDTH * HEIGHT;
    for (const type of SERIES_TYPES) {
      const entry = rendered.get(type);
      expect(entry, type).toBeDefined();
      if (entry === undefined) continue;
      // 200 chromatic pixels is two orders of magnitude above a dot and well below the thinnest real
      // series (a 120-point polyline inside the plot is ~2 900). A stub scores 0 — the furniture is
      // all grey and the legend swatches are outside the measured region.
      expect(entry.seriesInk, `${type} drew ${String(entry.seriesInk)} series px`).toBeGreaterThan(200);
      expect(nonBackgroundPixels(entry.data) / plotPx, type).toBeGreaterThan(0.01);
    }
  });

  it('matches the recorded hashes and ink counts in fixtures/golden/chart', () => {
    const golden = readGolden();
    const cases: Record<string, GoldenCase> = {};
    for (const type of SERIES_TYPES) {
      const entry = rendered.get(type);
      cases[type] = { hash: entry?.hash ?? '', chromaticPx: entry?.ink ?? 0 };
    }
    if (golden === null) {
      // Recorded, then failed on purpose: a golden that writes itself and passes is not a golden.
      mkdirSync(GOLDEN_DIR, { recursive: true });
      const index: GoldenIndex = {
        note:
          'WP-14 / CHRT-01. One PNG (sha256 of the base canvas dataURL) and one chromatic-pixel count ' +
          'per SeriesType, drawn by packages/web/test/chart/renderer.test.ts over 120 daily bars of ' +
          'fixtures/providers/normalised/yahoo-chart-events.json (profile: 240 one-minute bars of ' +
          'yahoo-chart-AAPL-1d-1m.json; heatmap: a 12x8 grid of the same closes). Bytes come from ' +
          'node-canvas at devicePixelRatio 1, which is byte-stable for identical drawings; a cairo or ' +
          'node-canvas upgrade legitimately moves every hash and is re-recorded by deleting this file.',
        canvas: { width: WIDTH, height: HEIGHT, dpr: DPR },
        recordedWith: { canvas: canvasVersion(), platform: process.platform },
        cases,
      };
      writeFileSync(GOLDEN_FILE, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
      throw new Error(
        `no golden existed: recorded ${String(SERIES_TYPES.length)} cases to ${GOLDEN_FILE}. ` +
          'Review the diff and re-run — this failure is the recording, not a pass.',
      );
    }
    expect(golden.canvas).toEqual({ width: WIDTH, height: HEIGHT, dpr: DPR });
    expect(
      cases,
      `pixel goldens moved. Recorded with node-canvas ${golden.recordedWith.canvas} on ` +
        `${golden.recordedWith.platform}; running node-canvas ${canvasVersion()} on ${process.platform}. ` +
        'Check the renderer change before re-recording.',
    ).toEqual(golden.cases);
  });
});

describe('dirty tracking: the base is not redrawn for a crosshair move (§11.1)', () => {
  it('a crosshair-only setState draws on the overlay and not once on the base', () => {
    const { renderer, base, overlay } = mount(specFor('candle'));
    const before = pixels(base);
    const baseOps = countOps(context(base));
    const overlayOps = countOps(context(overlay));

    renderer.setState({ crosshair: { slot: 40, seriesId: 'p' } });
    renderer.frame(16);

    expect(baseOps.get(), 'a crosshair move redrew the base').toBe(0);
    expect(overlayOps.get(), 'a crosshair move drew nothing at all').toBeGreaterThan(0);
    // And the base pixels are untouched, which is the same claim made without a spy.
    expect(differingPixels(before, pixels(base))).toBe(0);
  });

  it('a view change does redraw the base', () => {
    const { renderer, base } = mount(specFor('candle'));
    const before = pixels(base);
    const baseOps = countOps(context(base));

    renderer.setState({ view: { slot0: 20, slot1: 80 } });
    renderer.frame(16);

    expect(baseOps.get()).toBeGreaterThan(0);
    expect(differingPixels(before, pixels(base))).toBeGreaterThan(0);
  });

  it('a frame with nothing dirty draws nothing on either canvas', () => {
    const { renderer, base, overlay } = mount(specFor('line'));
    const baseOps = countOps(context(base));
    const overlayOps = countOps(context(overlay));
    renderer.frame(32);
    expect(baseOps.get()).toBe(0);
    expect(overlayOps.get()).toBe(0);
  });
});

describe('streaming: the forming bar updates in place (§11.5, CHRT-02)', () => {
  function liveSpec(): ChartSpec {
    const spec = specFor('candle');
    const series = spec.series[0];
    if (series === undefined) return spec;
    return {
      ...spec,
      series: [{ ...series, live: { subject: 'b1m:AAPL', field: 'PX_LAST', mode: 'append-forming-bar' } }],
    };
  }

  it('overwrites the last slot when the bar timestamp is the last one, without adding a slot', () => {
    const { renderer } = mount(liveSpec());
    const last = DAILY.t[DAILY.t.length - 1] ?? 0;
    const lastSlot = renderer.state().view.slot1;
    renderer.applyStream({
      seriesId: 'p',
      mode: 'append-forming-bar',
      bar: { t: last, o: 100, h: 111, l: 99, c: 110, v: 1000, final: false },
    });
    expect(renderer.state().view.slot1, 'an in-place update added a slot').toBe(lastSlot);
    expect(renderer.valueOfSeriesAtSlot('p', lastSlot)).toBe(110);
  });

  it('appends a slot for a new timestamp and auto-follows the right edge', () => {
    const { renderer } = mount(liveSpec());
    const lastSlot = renderer.state().view.slot1;
    const nextTs = (DAILY.t[DAILY.t.length - 1] ?? 0) + 86_400_000;
    renderer.applyStream({
      seriesId: 'p',
      mode: 'append-forming-bar',
      bar: { t: nextTs, o: 100, h: 112, l: 99, c: 108, v: 10, final: false },
    });
    expect(renderer.state().view.slot1).toBe(lastSlot + 1);
    expect(renderer.valueOfSeriesAtSlot('p', lastSlot + 1)).toBe(108);
  });

  it('redraws only the last slots: the left of the canvas is untouched, the right edge changes', () => {
    const { renderer, base } = mount(liveSpec());
    const pane = renderer.layout()[0];
    expect(pane).toBeDefined();
    if (pane === undefined) return;
    const before = context(base).getImageData(0, 0, Math.floor(base.width / 2), base.height).data;
    // The forming bar is moved inside the drawn range on purpose: a bar outside it would be clipped
    // away, and a clipped bar would make this assertion pass or fail for the wrong reason (a value
    // that leaves the range is §11.5's other path, the once-a-second full redraw).
    const lastClose = DAILY.c[DAILY.c.length - 1] ?? 0;
    renderer.applyStream({
      seriesId: 'p',
      mode: 'append-forming-bar',
      bar: {
        t: DAILY.t[DAILY.t.length - 1] ?? 0,
        o: lastClose,
        h: lastClose * 1.005,
        l: lastClose * 0.995,
        c: lastClose * 1.004,
        v: 10,
        final: false,
      },
    });
    renderer.frame(16);
    const afterLeft = context(base).getImageData(0, 0, Math.floor(base.width / 2), base.height).data;
    // The right edge of the PLOT, not of the canvas: the y-axis gutter is 6 ch of grey furniture.
    const stripW = 12;
    const afterRight = context(base).getImageData(
      Math.floor(pane.plot.x + pane.plot.w - stripW),
      Math.floor(pane.plot.y),
      stripW,
      Math.floor(pane.plot.h),
    ).data;
    expect(differingPixels(before, afterLeft), 'a stream patch repainted the whole base').toBe(0);
    expect(chromaticPixels(afterRight), 'the forming bar was not drawn at the right edge').toBeGreaterThan(0);
  });

  it('drops a forming bar that arrives before the last slot rather than unsorting the axis', () => {
    const { renderer } = mount(liveSpec());
    const lastSlot = renderer.state().view.slot1;
    const before = renderer.valueOfSeriesAtSlot('p', lastSlot);
    // `TradingDayIndex.append` throws on an out-of-order timestamp, by design — every binary search
    // in the engine depends on the axis being sorted. The renderer must therefore refuse the patch
    // rather than let that exception out of a WebSocket delta handler (§11.5).
    expect(() => {
      renderer.applyStream({
        seriesId: 'p',
        mode: 'append-forming-bar',
        bar: { t: (DAILY.t[10] ?? 0) + 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 1, final: false },
      });
    }).not.toThrow();
    expect(renderer.state().view.slot1, 'an out-of-order bar added a slot').toBe(lastSlot);
    expect(renderer.valueOfSeriesAtSlot('p', lastSlot)).toBe(before);
  });

  it('ignores a patch for a series the spec does not have', () => {
    const { renderer } = mount(liveSpec());
    const lastSlot = renderer.state().view.slot1;
    renderer.applyStream({ seriesId: 'nope', mode: 'replace-last', t: 0, y: 1 });
    expect(renderer.state().view.slot1).toBe(lastSlot);
  });

  it('draws far less than a full redraw: the work is bounded by the clip, not just the pixels', () => {
    const { renderer, base } = mount(liveSpec());
    const path = countPathOps(context(base));
    renderer.setState({ view: { slot0: 0, slot1: 119 } });
    renderer.frame(16);
    const full = path.get();
    const before = path.get();
    const lastClose = DAILY.c[DAILY.c.length - 1] ?? 0;
    renderer.applyStream({
      seriesId: 'p',
      mode: 'append-forming-bar',
      bar: {
        t: DAILY.t[DAILY.t.length - 1] ?? 0,
        o: lastClose,
        h: lastClose * 1.005,
        l: lastClose * 0.995,
        c: lastClose * 1.004,
        v: 10,
        final: false,
      },
    });
    renderer.frame(32);
    const streamed = path.get() - before;
    expect(full, 'a full redraw of 120 candles should be hundreds of path ops').toBeGreaterThan(300);
    expect(streamed, 'the forming bar drew nothing').toBeGreaterThan(0);
    // A quarter is a generous ceiling: the observed ratio is about 1:20. A clip that narrowed only the
    // pixels would score 1:1 here and pass every pixel assertion in this file.
    expect(streamed, `${String(streamed)} path ops vs ${String(full)} for a full redraw`).toBeLessThan(
      full / 4,
    );
  });

  it('does not redraw a bar that IS_FINAL already froze, and does not change its value', () => {
    const { renderer, base } = mount(liveSpec());
    const last = DAILY.t[DAILY.t.length - 1] ?? 0;
    const lastSlot = renderer.state().view.slot1;
    renderer.applyStream({
      seriesId: 'p',
      mode: 'append-forming-bar',
      bar: { t: last, o: 100, h: 111, l: 99, c: 110, v: 1000, final: true },
    });
    renderer.frame(16);
    const baseOps = countOps(context(base));
    renderer.applyStream({
      seriesId: 'p',
      mode: 'append-forming-bar',
      bar: { t: last, o: 100, h: 111, l: 99, c: 999, v: 1000, final: true },
    });
    renderer.frame(32);
    expect(baseOps.get(), 'a finalised bar was redrawn').toBe(0);
    expect(renderer.valueOfSeriesAtSlot('p', lastSlot), 'a frozen bar was overwritten').toBe(110);
  });

  it('replace-last rewrites the last value from a q: subject', () => {
    const { renderer } = mount(specFor('line'));
    const lastSlot = renderer.state().view.slot1;
    renderer.applyStream({ seriesId: 'p', mode: 'replace-last', t: 0, y: 123.5 });
    expect(renderer.valueOfSeriesAtSlot('p', lastSlot)).toBe(123.5);
  });
});

describe('DATA-10: the focusable element cites the series the crosshair is on', () => {
  const spec: ChartSpec = {
    kind: 'price',
    xAxis: { type: 'time' },
    yAxes: AXES,
    panes: [{ id: 'main', height: 1 }],
    series: [
      { ...barSeries('line', DAILY), id: 'a', provIdx: 3 },
      { ...barSeries('line', DAILY), id: 'b', provIdx: 7 },
    ],
    events: [{ t: DAILY.t[10] ?? 0, kind: 'dividend', label: 'D 0.24', command: 'CACS', provIdx: 11 }],
    annotations: [
      { annotationId: 5, kind: 'hline', anchors: [{ t: DAILY.t[5] ?? 0, v: 150 }], editable: true },
    ],
    crosshair: true,
  };

  it('answers -2 with no crosshair when the series disagree, and each series index in turn', () => {
    const { renderer } = mount(spec);
    // Two sources, no crosshair: naming series zero would be a false attribution, so -2 (the same rule
    // `widgets/Chart.tsx` applies to the placeholder).
    expect(renderer.focusProvIdx()).toBe(-2);
    renderer.setState({ crosshair: { slot: 10, seriesId: 'a' } });
    expect(renderer.focusProvIdx()).toBe(3);
    renderer.setState({ crosshair: { slot: 10, seriesId: 'b' } });
    expect(renderer.focusProvIdx()).toBe(7);
  });

  it('follows the legend focus, cites the event marker, and cites nothing for an annotation', () => {
    const { renderer } = mount(spec);
    renderer.setState({ focus: { kind: 'legend', seriesId: 'b' } });
    expect(renderer.focusProvIdx()).toBe(7);
    renderer.setState({ focus: { kind: 'event', index: 0 } });
    expect(renderer.focusProvIdx()).toBe(11);
    // A hand-drawn annotation cites no vendor: -2, not the series under it (§11.8, DATA-10).
    renderer.setState({ focus: { kind: 'annotation', index: 0 } });
    expect(renderer.focusProvIdx()).toBe(-2);
  });

  it('answers the one shared index when every series agrees', () => {
    const { renderer } = mount({
      ...spec,
      series: spec.series.map((s) => ({ ...s, provIdx: 4 })),
    });
    expect(renderer.focusProvIdx()).toBe(4);
  });
});

describe('hitTest answers in data coordinates (§11.1)', () => {
  it('reports the slot, the value and the nearest series inside the plot', () => {
    const spec = specFor('line');
    const { renderer } = mount(spec);
    const pane = renderer.layout()[0];
    expect(pane).toBeDefined();
    if (pane === undefined) return;
    const midX = pane.plot.x + pane.plot.w / 2;
    const hit = renderer.hitTest(midX, pane.plot.y + pane.plot.h / 2);
    expect(hit?.kind).toBe('plot');
    if (hit?.kind !== 'plot') return;
    expect(hit.paneId).toBe('main');
    expect(hit.seriesId).toBe('p');
    expect(hit.slot).toBeGreaterThan(50);
    expect(hit.slot).toBeLessThan(70);
    // The value is the price at that height, so it must be inside the data's own range.
    const lo = Math.min(...DAILY.l);
    const hi = Math.max(...DAILY.h);
    expect(hit.value).toBeGreaterThan(lo * 0.9);
    expect(hit.value).toBeLessThan(hi * 1.1);
  });

  it('reports the axis gutter, and the legend over the plot', () => {
    const { renderer } = mount(specFor('line'));
    const pane = renderer.layout()[0];
    if (pane === undefined) return;
    const axis = pane.yAxes[0];
    expect(axis).toBeDefined();
    if (axis === undefined) return;
    const axisHit = renderer.hitTest(axis.rect.x + 2, axis.rect.y + 20);
    expect(axisHit).toEqual({ kind: 'axis', paneId: 'main', axisId: 'y' });
    const legendHit = renderer.hitTest(pane.plot.x + 4, pane.plot.y + 6);
    expect(legendHit).toEqual({ kind: 'legend', paneId: 'main', seriesId: 'p' });
  });

  it('returns null outside every pane', () => {
    const { renderer } = mount(specFor('line'));
    expect(renderer.hitTest(10, HEIGHT + 50)).toBeNull();
  });
});

describe('studies draw into their own linked pane (§11.6)', () => {
  /**
   * A hand-built `StudyDef`, because `studies/index.ts` is WP-14's other hand and does not exist yet.
   *
   * What this proves is the renderer's half of the seam — that a `sub` study gets a pane, that the
   * pane gets a y-axis of its own scaled to the study's values, and that the line is drawn there — not
   * that any real study computes the right numbers. The 22 studies are golden-tested against
   * `fixtures/golden/analytics/studies/<id>.json` by `test/chart/studies.test.ts` (§11.6), which is
   * where the maths belongs.
   */
  const doubler: StudyDef = {
    id: 'X2',
    name: 'Twice the close',
    pane: 'sub',
    params: [],
    needs: ['close'],
    compute: (input) => ({
      lines: [
        {
          id: 'x2',
          label: 'x2',
          y: Float64Array.from(input.close, (c) => c * 2),
          style: { color: 'auto' },
        },
      ],
    }),
  };

  it('draws the study line in its pane and leaves the price pane taller', () => {
    const base = specFor('line');
    const spec: ChartSpec = {
      ...base,
      panes: [
        { id: 'main', height: 0.8 },
        { id: 'st0', height: 0.2, title: 'X2' },
      ],
      studies: [{ id: 'X2', params: {}, pane: 'st0', inputSeriesId: 'p' }],
    };
    const without = mount(spec);
    const withStudy = mount(spec, { plugins: { studies: { X2: doubler } } });

    const panes = withStudy.renderer.layout();
    expect(panes).toHaveLength(2);
    expect(panes[1]?.yAxes.map((a) => a.axisId)).toEqual(['st0:y']);
    expect(panes[0]?.plot.h ?? 0).toBeGreaterThan(panes[1]?.plot.h ?? 0);

    // The study pane is empty without a registry and inked with one: the plugin seam is load-bearing,
    // and a renderer that silently drew nothing either way would pass a weaker assertion.
    const paneRect = panes[1];
    if (paneRect === undefined) return;
    const region = (canvas: HTMLCanvasElement): number =>
      chromaticPixels(
        context(canvas).getImageData(
          Math.floor(paneRect.plot.x),
          Math.floor(paneRect.plot.y),
          Math.max(1, Math.floor(paneRect.plot.w)),
          Math.max(1, Math.floor(paneRect.plot.h)),
        ).data,
      );
    expect(region(without.base)).toBe(0);
    expect(region(withStudy.base)).toBeGreaterThan(100);
  });
});

describe('pure geometry the goldens cannot pin down', () => {
  it('pnfColumns alternates direction and reverses one box inside the previous extreme (§11.3)', () => {
    const box = pnfBoxSize(barSeries('pnf', DAILY), 0.01);
    expect(box).toBeGreaterThan(0);
    const columns = pnfColumns(DAILY.c, box);
    expect(columns.length).toBeGreaterThan(1);
    for (let i = 1; i < columns.length; i += 1) {
      const prev = columns[i - 1];
      const cur = columns[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.dir, 'two columns in a row went the same way').not.toBe(prev.dir);
      expect(cur.hiBox).toBeGreaterThanOrEqual(cur.loBox);
      // A reversal starts one box back from the extreme it reversed off, never at it.
      if (cur.dir === -1) expect(cur.hiBox).toBe(prev.hiBox - 1);
      else expect(cur.loBox).toBe(prev.loBox + 1);
    }
  });

  it('pnfColumns is empty for a non-positive box size and a flat series', () => {
    expect(pnfColumns(DAILY.c, 0)).toEqual([]);
    expect(pnfColumns(Float64Array.from({ length: 50 }, () => 100), 1)).toHaveLength(1);
  });

  it('profileTpo puts the POC inside the value area and the value area inside the range (§11.3)', () => {
    const { renderer } = mount(specFor('profile'));
    const pane = renderer.layout()[0];
    if (pane === undefined) return;
    // The scales a draw function is handed are private to the renderer, so this rebuilds the same
    // geometry rather than reaching into it: what is under test is the TPO arithmetic.
    const series = barSeries('profile', INTRADAY);
    const scales = {
      plot: pane.plot,
      x: (slot: number) => pane.plot.x + slot,
      y: (v: number) => pane.plot.y + pane.plot.h * (1 - (v - 320) / 20),
      slotAt: (px: number) => px - pane.plot.x,
      valueAt: (py: number) => py,
      slotPx: 1,
      baselinePx: pane.plot.y + pane.plot.h,
      tick: 0.01,
      hairline: 1,
      paint: {
        line: '#3b82f6',
        fill: '#3b82f6',
        fillTo: '#3b82f6',
        up: '#16a34a',
        down: '#dc2626',
        neutral: '#9a7bd0',
        muted: '#7a7a7a',
        hollowUp: false,
        ramp: () => '#3b82f6',
      },
      fonts: FONTS,
    };
    const profile = profileTpo({ ...series, x: Float64Array.from(series.x, (_v, i) => i) }, scales, {
      slot0: 0,
      slot1: 239,
    });
    expect(profile.rows.length).toBeGreaterThan(3);
    expect(profile.pocIndex).toBeGreaterThanOrEqual(0);
    const poc = profile.rows[profile.pocIndex];
    expect(poc).toBeDefined();
    expect(poc?.count).toBe(Math.max(...profile.rows.map((r) => r.count)));
    expect(profile.valueArea.lo).toBeLessThanOrEqual(poc?.loV ?? 0);
    expect(profile.valueArea.hi).toBeGreaterThanOrEqual(poc?.hiV ?? 0);
    const lo = Math.min(...INTRADAY.l);
    const hi = Math.max(...INTRADAY.h);
    expect(profile.valueArea.lo).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(profile.valueArea.hi).toBeLessThanOrEqual(hi + 1e-9);
    // One letter per period per row: the busiest row cannot hold more periods than the window has.
    const periods = Math.ceil(240 / 30);
    for (const row of profile.rows) expect(row.count).toBeLessThanOrEqual(periods);
  });

  it('every SeriesType has a draw function (CHRT-01, enforced by the compiler and here)', () => {
    for (const type of SERIES_TYPES) expect(typeof SERIES_DRAWS[type]).toBe('function');
    expect(Object.keys(SERIES_DRAWS)).toHaveLength(12);
  });
});

describe('the six screens that build a real ChartSpec render (WORKPLAN §WP-14 depends on WP-09..11)', () => {
  /** Each case: the screen's own spec builder over its committed payload golden. */
  const cases: readonly { name: string; spec: () => ChartSpec }[] = [
    {
      name: 'GP (equity, daily)',
      spec: () => gpChartSpec(payload<'GP'>('GP.equity.json'), defaults('GP')),
    },
    {
      name: 'GIP (intraday)',
      spec: () => gipChartSpec(payload<'GIP'>('GIP.intraday.json'), defaults('GIP')),
    },
    { name: 'GC (curve)', spec: () => gcChartSpec(payload<'GC'>('GC.default.json')) },
    { name: 'GC (history)', spec: () => gcChartSpec(payload<'GC'>('GC.default.history.json')) },
    {
      name: 'CRVF',
      spec: () => {
        const params = defaults('CRVF');
        return crvfChartSpec(payload<'CRVF'>('CRVF.default.json'), params.outputs);
      },
    },
    { name: 'OMON (smile)', spec: () => omonSmileSpec(payload<'OMON'>('OMON.underlying.json')) },
    { name: 'OVML (greeks)', spec: () => ovmlProfileSpec(payload<'OVML'>('OVML.contract.json')) },
  ];

  for (const entry of cases) {
    it(`${entry.name} draws ink without throwing`, () => {
      const spec = entry.spec();
      expect(spec.series.length, `${entry.name} built a spec with no series`).toBeGreaterThan(0);
      const { renderer, base, overlay } = mount(spec);
      const pane = renderer.layout()[0];
      expect(pane, `${entry.name} produced no pane`).toBeDefined();
      if (pane === undefined) return;
      const rows = spec.series.filter((s) => s.pane === pane.paneId).length;
      const ink = seriesInk(base, pane, rows);
      expect(ink, `${entry.name} drew ${String(ink)} series px in its main pane`).toBeGreaterThan(100);

      // And the interaction path over a real spec: a crosshair on the first series, one frame, no throw.
      const first = spec.series[0];
      if (first !== undefined) {
        renderer.setState({ crosshair: { slot: renderer.state().view.slot1 / 2, seriesId: first.id } });
        renderer.frame(16);
        expect(renderer.focusProvIdx()).toBe(first.provIdx);
        expect(chromaticPixels(pixels(overlay))).toBeGreaterThan(0);
      }
    });
  }
});

/* ============================================================================================== */
/* The axis, the studies and the readout — what the goldens cannot see                            */
/* ============================================================================================== */

/**
 * Everything below is about NUMBERS the chart states, not about pixels it lands, and a pixel golden
 * cannot see any of it: a frozen axis, a mislabelled readout and a clipped band all hash perfectly
 * stably. Each suite drives the real study registry (`studies/index.ts`) over the same daily fixture
 * the goldens use, and each reads its answer back through a PUBLISHED surface — `hitTest` for a
 * domain, the recorded `fillText` calls for a label, `studyRowsAt` for a readout row — so nothing
 * here asserts against a private field.
 */

/** The daily fixture as a spec with `count` bars, a candle series and an optional study list. */
function dailySpec(
  count: number,
  studyEntries: NonNullable<ChartSpec['studies']> = [],
  options: { normalise?: 'none' | 'pct' | 'base100'; reference?: number } = {},
): ChartSpec {
  const bars = loadBars('yahoo-chart-events.json', count);
  const panes: ChartSpec['panes'] = [{ id: 'main', height: 1 }];
  for (const entry of studyEntries) {
    if (entry.pane !== 'main' && !panes.some((p) => p.id === entry.pane)) {
      panes.push({ id: entry.pane, height: 0.25, title: entry.id });
    }
  }
  const axis: ChartSpec['yAxes'][number] = {
    id: 'y',
    side: 'right',
    scale: 'linear',
    fmt: 'px',
    decimals: 2,
    ...(options.normalise === undefined ? {} : { normalise: options.normalise }),
  };
  return {
    kind: 'price',
    xAxis: { type: 'time', tz: 'America/New_York', calendarId: 'XNYS' },
    yAxes: [axis],
    panes,
    // A candle series WITH its volume column, which is what `gpChartSpec` builds and what the twelve
    // studies that declare `needs: ['ohlc']` or `['volume']` are offered in the product.
    series: [{ ...barSeries('candle', bars), volume: bars.v }],
    ...(studyEntries.length === 0 ? {} : { studies: studyEntries }),
    ...(options.reference === undefined
      ? {}
      : { reference: [{ yAxis: 'y', v: options.reference, label: 'prev close' }] }),
    crosshair: true,
  };
}

/**
 * The value domain of a pane, read through `hitTest` — the engine's own published inverse.
 *
 * Top and bottom pixel of the plot, which `valueAt` maps back to the axis' high and low. Reading the
 * domain this way rather than from a private field is what makes these assertions tests of the
 * product: `hitTest` is what places an annotation anchor and what the crosshair reports, so a domain
 * these two disagree about is a defect either way round.
 */
function domainOf(renderer: Renderer, paneIndex: number): { lo: number; hi: number } {
  const pane = renderer.layout()[paneIndex];
  if (pane === undefined) throw new Error(`no pane ${String(paneIndex)}`);
  const px = pane.plot.x + pane.plot.w / 2;
  const top = renderer.hitTest(px, pane.plot.y + 0.5);
  const bottom = renderer.hitTest(px, pane.plot.y + pane.plot.h - 0.5);
  if (top?.kind !== 'plot' || bottom?.kind !== 'plot') throw new Error('the pane did not hit-test');
  return { lo: bottom.value, hi: top.value };
}

/** Every string the base or overlay canvas was asked to draw — axis labels, titles, readout rows. */
function captureTexts(canvas: HTMLCanvasElement): { get(): string[] } {
  const spy = vi.spyOn(context(canvas), 'fillText');
  return { get: () => spy.mock.calls.map((call) => String(call[0])) };
}

describe('a study the series cannot feed is skipped, not thrown (§11.6, studies/needs.ts)', () => {
  /** GP draws yields and rates through this engine, and a yield series has no bar and no volume. */
  function closeOnlySpec(studyId: string): ChartSpec {
    const bars = loadBars('yahoo-chart-events.json', 120);
    return {
      kind: 'price',
      xAxis: { type: 'time' },
      yAxes: AXES,
      panes: [
        { id: 'main', height: 0.75 },
        { id: studyId, height: 0.25, title: studyId },
      ],
      series: [
        {
          id: 'p',
          label: 'T 10Y Govt',
          type: 'line',
          pane: 'main',
          yAxis: 'y',
          x: bars.t,
          y: bars.c,
          provIdx: 0,
          style: { color: 'auto' },
        },
      ],
      studies: [{ id: studyId, params: defaultParams(studies[studyId as StudyId]), pane: studyId, inputSeriesId: 'p' }],
      crosshair: true,
    };
  }

  it('mounts every one of the twenty-two on a close-only series without throwing', () => {
    // One keystroke reaches this: the `S` picker offered all twenty-two whatever the series carried,
    // and a persisted `layout.chart.studies` holding `ATR` meant a govt GP chart threw a `RangeError`
    // out of `setSpec` on mount. Twelve of the twenty-two need a bar or a volume column.
    const skipped: string[] = [];
    for (const id of STUDY_IDS) {
      const spec = closeOnlySpec(id);
      const { renderer } = mount(spec, { plugins: { studies } });
      const list = renderer.skippedStudies();
      if (list.length > 0) skipped.push(id);
      // Either it computed or it was recorded as skipped — never silently absent.
      const rows = renderer.studyRowsAt(100);
      expect(list.length > 0 || rows.length > 0, `${id} neither computed nor reported a skip`).toBe(true);
    }
    // The twelve §11.6 declares `needs: ['ohlc']` or `['volume']` for, and not one more.
    expect(skipped.sort()).toEqual(
      [
        'ADX',
        'ATR',
        'CCI',
        'DONCHIAN',
        'ICHIMOKU',
        'KELTNER',
        'OBV',
        'PSAR',
        'STOCH',
        'VOL',
        'VWAP',
        'WILLR',
      ].sort(),
    );
  });

  it('survives a study that THROWS on the data, not just one whose column is missing', () => {
    // `needs` answers a missing COLUMN. It does not answer bad values inside a column that is
    // present, and `ChartSeries.y` documents `NaN` as a legal gap — §11.2 makes one ordinary as soon
    // as a second calendar is on the chart. Measured on one 120-bar series with a single gap: `BB`
    // and `STDDEV` throw a `RangeError` out of `core/analytics/stats`, which validates its input and
    // is right to. That throw lands inside `setSpec` and takes the whole chart with it — the same
    // dead screen the `needs` guard prevents, through a different door.
    const spec = dailySpec(120, [
      { id: 'BOOM', params: {}, pane: 'BOOM', inputSeriesId: 'p' },
      { id: 'SMA', params: { n: 20 }, pane: 'main', inputSeriesId: 'p' },
    ]);
    const exploding = {
      id: 'BOOM',
      name: 'Throws',
      pane: 'sub' as const,
      params: [],
      needs: ['close' as const],
      compute: (): never => {
        throw new RangeError('stats: series[19] must be a finite number');
      },
    };

    const { renderer } = mount(spec, {
      plugins: { studies: { ...studies, BOOM: exploding } },
    });

    // The chart lives, the failure is named, and the OTHER study on the same chart still drew — a
    // guard that swallowed the whole study list would pass the first assertion and fail this one.
    const skipped = renderer.skippedStudies();
    expect(skipped.map((e) => e.id)).toEqual(['BOOM']);
    expect(skipped[0]?.error).toContain('finite number');
    expect(renderer.studyRowsAt(100).length).toBeGreaterThan(0);
  });

  it('names what the skipped study needed, and computes the same study once the bar is there', () => {
    const { renderer } = mount(closeOnlySpec('ATR'), { plugins: { studies } });
    expect(renderer.skippedStudies()).toEqual([{ id: 'ATR', needs: ['ohlc'] }]);
    expect(renderer.studyRowsAt(100)).toEqual([]);

    // The same study, the same parameters, a series that carries the bar: it computes. Without this
    // half, a `computeStudies` that skipped EVERYTHING would pass the test above.
    const withBars = dailySpec(120, [{ id: 'ATR', params: { n: 14 }, pane: 'ATR', inputSeriesId: 'p' }]);
    const bars = mount(withBars, { plugins: { studies } });
    expect(bars.renderer.skippedStudies()).toEqual([]);
    const rows = bars.renderer.studyRowsAt(100);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBeGreaterThan(0);
  });
});

describe('a study pane’s axis tracks the viewport and its own yFmt (§11.6)', () => {
  it('retracks the sub-pane domain on a pan, instead of freezing at the ten-year extremes', () => {
    const spec = dailySpec(400, [{ id: 'ATR', params: { n: 14 }, pane: 'ATR', inputSeriesId: 'p' }]);
    const { renderer } = mount(spec, { plugins: { studies }, width: 900, height: 600 });

    /** The ATR values actually on screen for a viewport, from the study's own output. */
    const visible = (slot0: number, slot1: number): { lo: number; hi: number } => {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let slot = slot0; slot <= slot1; slot += 1) {
        const row = renderer.studyRowsAt(slot)[0];
        const v = row?.value ?? Number.NaN;
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return { lo, hi };
    };

    const windows: [number, number][] = [
      [0, 399],
      [120, 180],
      [330, 399],
    ];
    const domains = windows.map(([slot0, slot1]) => {
      renderer.setState({ view: { slot0, slot1 } });
      renderer.frame(0);
      return { view: [slot0, slot1] as const, on: visible(slot0, slot1), axis: domainOf(renderer, 1) };
    });

    for (const { view, on, axis } of domains) {
      const span = axis.hi - axis.lo;
      expect(Number.isFinite(on.lo), `no ATR on screen for ${String(view)}`).toBe(true);
      // The axis contains what is on screen...
      expect(axis.lo, `${String(view)} axis floor`).toBeLessThanOrEqual(on.lo);
      expect(axis.hi, `${String(view)} axis ceiling`).toBeGreaterThanOrEqual(on.hi);
      // ...and is not several times larger than it. The frozen axis put the visible ATR in 9 % of the
      // pane; `DOMAIN_PAD` is 3 % a side, so a correct axis is within a quarter of the visible span.
      expect(span, `${String(view)} axis span ${String(span)} vs visible ${String(on.hi - on.lo)}`)
        .toBeLessThan((on.hi - on.lo) * 1.25 + 1e-9);
    }
    // And the three windows are genuinely different domains: an axis that ignored the viewport would
    // make these three identical, which is exactly what it did.
    const spans = domains.map((d) => `${d.axis.lo.toFixed(3)}..${d.axis.hi.toFixed(3)}`);
    expect(new Set(spans).size).toBe(3);
  });

  it('labels a sub pane through the study’s yFmt: % for HVOL, whole shares for VOL, 1 dp for RSI', () => {
    const cases: { id: StudyId; expect: RegExp; reject: RegExp }[] = [
      // §11.6: HVOL is annualised volatility in per cent (`yFmt: 'pct'`) — a label reading `20.00`
      // with no sign says nothing about what 20 means.
      { id: 'HVOL', expect: /^[\d,]+\.\d\d%$/, reject: /%/ },
      // VOL is a share count (`yFmt: 'int'`): `100,000,000.00` shares is two decimals of nonsense.
      { id: 'VOL', expect: /^[\d,]+$/, reject: /\.\d\d$/ },
      // RSI is an oscillator (`yFmt: 'ratio'`): one decimal, not a price's two.
      { id: 'RSI', expect: /^\d+\.\d$/, reject: /^\d+\.\d\d$/ },
    ];
    for (const entry of cases) {
      const spec = dailySpec(200, [
        { id: entry.id, params: defaultParams(studies[entry.id]), pane: entry.id, inputSeriesId: 'p' },
      ]);
      const base = document.createElement('canvas');
      const overlay = document.createElement('canvas');
      const renderer = new Renderer(base, overlay, { dpr: DPR, theme: THEME, fonts: FONTS });
      renderer.resize(900, 600, DPR);
      renderer.setPlugins({ studies });
      renderer.setSpec(spec);
      const texts = captureTexts(base);
      renderer.frame(0);
      const drawn = texts.get();
      expect(drawn.length, `${entry.id} drew no text at all`).toBeGreaterThan(4);
      expect(
        drawn.some((text) => entry.expect.test(text)),
        `${entry.id}: no label matched ${String(entry.expect)} among ${drawn.join(' ')}`,
      ).toBe(true);
      // ...and the two-decimal price format the pane used to fall back to is not what its own labels
      // are in. Asserted as "not every numeric label looks like a price", because the PRICE pane in the
      // same frame legitimately draws prices: what is being checked is that the study pane's labels
      // are not all of them.
      const numeric = drawn.filter((text) => /^[+-]?[\d,]+(\.\d+)?%?$/.test(text));
      expect(numeric.some((text) => entry.expect.test(text))).toBe(true);
      expect(numeric.every((text) => entry.reject.test(text))).toBe(false);
      vi.restoreAllMocks();
    }
  });
});

describe('a main-pane study belongs to the price axis it is drawn on (§11.6)', () => {
  it('widens the price domain for a Bollinger band that leaves the visible range', () => {
    const entries = [{ id: 'BB', params: { n: 20, k: 2 }, pane: 'main', inputSeriesId: 'p' }];
    const spec = dailySpec(200, entries);
    const withBand = mount(spec, { plugins: { studies }, width: 900, height: 600 });
    const without = mount(dailySpec(200), { width: 900, height: 600 });

    // A window where the band provably leaves the bars: the upper band of a 20-period, 2σ Bollinger
    // after a sharp move sits above every high in the window.
    const view = { slot0: 150, slot1: 199 };
    withBand.renderer.setState({ view });
    withBand.renderer.frame(0);
    without.renderer.setState({ view });
    without.renderer.frame(0);

    let bandHi = Number.NEGATIVE_INFINITY;
    for (let slot = view.slot0; slot <= view.slot1; slot += 1) {
      for (const row of withBand.renderer.studyRowsAt(slot)) {
        if (Number.isFinite(row.value) && row.value > bandHi) bandHi = row.value;
      }
    }
    const bars = domainOf(without.renderer, 0);
    expect(bandHi).toBeGreaterThan(bars.hi);

    const withIt = domainOf(withBand.renderer, 0);
    // The whole band is inside the plot rect instead of being clipped away by it.
    expect(withIt.hi).toBeGreaterThanOrEqual(bandHi);
    expect(withIt.hi).toBeGreaterThan(bars.hi);
  });
});

describe('normalisation is one unit per axis (§11.2, CHRT-03, CHRT-05)', () => {
  it('normalises the reference line onto the axis instead of destroying the domain with it', () => {
    const bars = loadBars('yahoo-chart-events.json', 120);
    const prevClose = bars.c[0] ?? 0;
    const raw = mount(dailySpec(120, [], { reference: prevClose }), { width: 900, height: 600 });
    const pct = mount(dailySpec(120, [], { normalise: 'pct', reference: prevClose }), {
      width: 900,
      height: 600,
    });

    // Unnormalised, the axis is in prices and the reference is one of them.
    const rawDomain = domainOf(raw.renderer, 0);
    expect(rawDomain.lo).toBeLessThan(prevClose);
    expect(rawDomain.hi).toBeGreaterThan(prevClose);

    // Normalised, the SERIES spans a few per cent — and the axis must too. The raw reference noted
    // into a pct domain gave GP an axis of 0…334 for a series spanning 0…2.4, so both securities of
    // the default comparison chart drew as flat lines on the floor of the pane.
    const pctDomain = domainOf(pct.renderer, 0);
    // `valueAt` answers in DATA coordinates, so the domain comes back in prices either way; what the
    // reference used to do is widen it to include zero and every price between.
    expect(pctDomain.hi - pctDomain.lo).toBeLessThan((rawDomain.hi - rawDomain.lo) * 3);
    expect(pctDomain.lo).toBeGreaterThan(prevClose * 0.5);
  });

  it('round-trips an anchor through the painter and hitTest under pct and base100, across a pan', () => {
    // CHRT-05: an annotation is anchored in DATA coordinates. `y` applied the normaliser and
    // `valueAt` did not, so one press of `N` made every pixel read answer in the axis's unit: an
    // anchor placed where the last bar was drawn persisted `111.17` for a price of `330.18`, and
    // because the base is the first VISIBLE point it then drifted on every pan.
    for (const normalise of ['none', 'pct', 'base100'] as const) {
      const bars = loadBars('yahoo-chart-events.json', 120);
      const lastClose = bars.c[119] ?? 0;
      const spec: ChartSpec = {
        ...dailySpec(120, [], { normalise }),
        annotations: [
          {
            annotationId: null,
            kind: 'hline',
            anchors: [{ t: bars.t[119] ?? 0, v: lastClose }],
            editable: true,
          },
        ],
      };
      let map: { xOfTs(t: number): number; yOfValue(v: number): number } | null = null;
      const { renderer } = mount(spec, {
        width: 900,
        height: 600,
        plugins: {
          annotations: (_ctx, _pane, m) => {
            map = m;
          },
        },
      });

      const check = (label: string): void => {
        renderer.frame(0);
        const placed = map;
        if (placed === null) throw new Error('the annotation painter was never called');
        const py = placed.yOfValue(lastClose);
        const pane = renderer.layout()[0];
        if (pane === undefined) throw new Error('no pane');
        // The anchor is ON SCREEN — the base-100 chart drew it nowhere at all — and the pixel it is
        // drawn at reads back as the price it was anchored to.
        expect(py, `${normalise} ${label}: anchor outside the plot`).toBeGreaterThanOrEqual(pane.plot.y);
        expect(py).toBeLessThanOrEqual(pane.plot.y + pane.plot.h);
        const hit = renderer.hitTest(pane.plot.x + pane.plot.w / 2, py);
        expect(hit?.kind).toBe('plot');
        if (hit?.kind !== 'plot') return;
        expect(hit.value, `${normalise} ${label}: pixel → value`).toBeCloseTo(lastClose, 4);
      };

      check('full view');
      // The pan that moved the base: `pct`/`base100` rebase on the first visible point, so this is a
      // different base and the same anchor must still read the same price.
      renderer.setState({ view: { slot0: 5, slot1: 119 } });
      check('after a five-bar pan');
    }
  });
});

describe('the crosshair readout says what the numbers are (§11.9)', () => {
  it('lists every study line at the slot, formatted through its own yFmt', () => {
    const spec = dailySpec(200, [
      { id: 'RSI', params: { n: 14 }, pane: 'RSI', inputSeriesId: 'p' },
      { id: 'MACD', params: { fast: 12, slow: 26, signal: 9 }, pane: 'MACD', inputSeriesId: 'p' },
    ]);
    const base = document.createElement('canvas');
    const overlay = document.createElement('canvas');
    const renderer = new Renderer(base, overlay, { dpr: DPR, theme: THEME, fonts: FONTS });
    renderer.resize(900, 600, DPR);
    renderer.setPlugins({ studies });
    renderer.setSpec(spec);
    renderer.frame(0);

    const rows = renderer.studyRowsAt(150);
    // RSI's one line, MACD's two lines and its histogram: four rows, each with a label and a number.
    expect(rows.map((row) => row.studyId)).toEqual(['RSI', 'MACD', 'MACD', 'MACD']);
    for (const row of rows) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(Number.isFinite(row.value), `${row.label} has no value`).toBe(true);
      expect(row.text).not.toBe('');
    }
    const rsi = rows[0];
    if (rsi === undefined) throw new Error('no RSI row');
    expect(rsi.value).toBeGreaterThan(0);
    expect(rsi.value).toBeLessThan(100);
    expect(rsi.text).toBe(rsi.value.toFixed(1));

    // And they reach the drawn overlay, which is where §11.9 puts them: the readout used to list the
    // series only, so the number a sub pane was added FOR could not be read off the chart.
    const texts = captureTexts(overlay);
    renderer.setState({ crosshair: { slot: 150, seriesId: 'p' } });
    renderer.frame(16);
    const drawn = texts.get();
    expect(drawn.some((text) => text.includes(rsi.text))).toBe(true);
    expect(drawn.filter((text) => text.includes('MACD')).length).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });

  it('names a curve’s x by its tenor and never as a 1970 date (§11.2)', () => {
    const spec = crvfChartSpec(payload<'CRVF'>('CRVF.default.json'), defaults('CRVF').outputs);
    const base = document.createElement('canvas');
    const overlay = document.createElement('canvas');
    const renderer = new Renderer(base, overlay, { dpr: DPR, theme: THEME, fonts: FONTS });
    renderer.resize(900, 600, DPR);
    renderer.setSpec(spec);
    const series = spec.series[0];
    if (series === undefined) throw new Error('CRVF built no series');

    const texts = captureTexts(overlay);
    const slot = Math.round(renderer.state().view.slot1 / 2);
    renderer.setState({ crosshair: { slot, seriesId: series.id } });
    renderer.frame(0);
    const drawn = texts.get();
    expect(drawn.length).toBeGreaterThan(0);
    // `new Date(1826).toISOString()` is `1970-01-01T00:00:01.826Z`: the x of a curve is a DAY COUNT,
    // and every slot of every curve chart in the product announced the same 1970 date.
    expect(drawn.filter((text) => text.startsWith('1970-'))).toEqual([]);
    expect(
      drawn.some((text) => /^\d+(D|W|M|Y)$/.test(text)),
      `no tenor label among ${drawn.join(' | ')}`,
    ).toBe(true);
    vi.restoreAllMocks();
  });
});
