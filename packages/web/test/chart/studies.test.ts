// packages/web/test/chart/studies.test.ts — the nine main-pane studies (WORKPLAN §WP-14 acceptance
// row "each study against a hand-computed series; multi-pane layout"; CLIENT.md §11.6, CHRT-04).
//
// Five things are checked here, and they are five because a study can be wrong in five unrelated
// ways:
//
//  1. **The registry against the specification.** The ids, names, panes and parameter defaults are
//     parsed out of CLIENT.md §11.6's own table and compared. A default transcribed from a document
//     is right on the day it is typed; this is what keeps it right afterwards.
//  2. **The numbers against an independent implementation.** The goldens in
//     `fixtures/golden/analytics/studies/` were produced by a Python reference written from the
//     study definitions, not by `trend.ts` (each file says so in `producedBy`). A golden generated
//     by the module it judges can only catch tomorrow's regression; one written twice, in two
//     languages, catches today's bug — and it did not have to be believed either, because…
//  3. **…a handful of points are hand-derived here, in literals, with the arithmetic in the
//     comment.** Six of the nine carry at least one such point. Somebody with the fixture and a
//     calculator can check those lines without running anything.
//  4. **The leading-gap convention, exactly.** A 20-period average has no value at slots 0..18. An
//     off-by-one there shifts every value one bar towards the present, which is lookahead — a line
//     that knew today's close yesterday — and no eye catches it at any zoom. So the first and last
//     finite slot of all nineteen lines are asserted as literals, and, stronger, perturbing a
//     *future* bar is asserted not to move any study's value at an earlier slot.
//  5. **The pane and band contract.** All nine are `main`-pane studies: they overlay the price axis
//     and add no pane, which is the half of "multi-pane layout" this file is responsible for (the
//     stacked `sub` panes belong to the sub-pane studies' own file). A band naming a line id that
//     the study does not emit would be a renderer crash, so the band edges are resolved too.
//
// **Two deviations from §11.6, recorded in the goldens and repeated here.** §11.6 says study goldens
// come from `yahoo-chart-AAPL-max-1d.json`; that capture is QUARTERLY (docs/TESTING.md L748), so a
// 20-period study over it would be a five-year average labelled as a one-month one. The daily
// goldens use `yahoo-chart-events.json` (1,255 daily bars) instead. `VWAP` is intraday only and uses
// `yahoo-chart-AAPL-1d-1m.json` (316 one-minute bars); over daily bars a session VWAP degenerates to
// each bar's own typical price and would test nothing.
//
// No clock, no timers and no frame pump: studies are pure array arithmetic, so nothing here waits
// (TESTING.md §2.2). `node:fs` in a test is expected — tests are outside the package's tsconfig and
// may read the repository (WORKPLAN §1.2) — and paths are resolved through `dirname` rather than
// jsdom's `URL`, for the reason `test/no-direct-io.test.ts` gives.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { trendStudies } from '../../src/chart/studies/trend.js';
import type { StudyDef, StudyInput, StudyOutput } from '../../src/chart/studies/types.js';

/** `packages/web/test/chart/` → `packages/web/` → the monorepo root. */
const WEB_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(WEB_ROOT));

const CLIENT_MD = readFileSync(join(REPO_ROOT, 'docs', 'CLIENT.md'), 'utf8');

/* -------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                       */
/* -------------------------------------------------------------------------------------------- */

interface FixtureBar {
  barTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function loadBars(file: string): FixtureBar[] {
  const path = join(REPO_ROOT, 'fixtures', 'providers', 'normalised', file);
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { bars: FixtureBar[] };
  return doc.bars;
}

/** Every column, as the renderer will hand them over: one `Float64Array` per field. */
function toInput(bars: readonly FixtureBar[]): StudyInput {
  return {
    x: Float64Array.from(bars.map((b) => b.barTs)),
    close: Float64Array.from(bars.map((b) => b.close)),
    open: Float64Array.from(bars.map((b) => b.open)),
    high: Float64Array.from(bars.map((b) => b.high)),
    low: Float64Array.from(bars.map((b) => b.low)),
    volume: Float64Array.from(bars.map((b) => b.volume)),
  };
}

const DAILY_BARS = loadBars('yahoo-chart-events.json');
const INTRADAY_BARS = loadBars('yahoo-chart-AAPL-1d-1m.json');
const DAILY = toInput(DAILY_BARS);
const INTRADAY = toInput(INTRADAY_BARS);

/** `VWAP` is the one intraday study (§11.6); the other eight are golden-tested on daily bars. */
const INTRADAY_ONLY = new Set(['VWAP']);

function inputFor(id: string): StudyInput {
  return INTRADAY_ONLY.has(id) ? INTRADAY : DAILY;
}

/** Every parameter at its published default — what a study gets when `S` adds it with `Enter`. */
function defaults(study: StudyDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of study.params) out[p.name] = p.default;
  return out;
}

function lineOf(out: StudyOutput, id: string): Float64Array {
  const line = out.lines.find((l) => l.id === id);
  if (line === undefined)
    throw new Error(`no line '${id}' in [${out.lines.map((l) => l.id).join(', ')}]`);
  return line.y;
}

const STUDY_IDS_HERE = Object.keys(trendStudies);

/* -------------------------------------------------------------------------------------------- */
/* 1. The registry against CLIENT.md §11.6                                                        */
/* -------------------------------------------------------------------------------------------- */

interface DocRow {
  id: string;
  name: string;
  pane: string;
  params: Record<string, number>;
  outputs: string;
}

/**
 * §11.6's registry table, parsed.
 *
 * The parameter cell is read from its backticked runs (`\`n=20, k=2\``, and for VWAP
 * `\`anchor=0\` (0 = session)` — the prose after the backticks is the doc explaining itself and is
 * not a parameter). Parsing rather than restating is the point: a default changed in the document
 * and not in the code fails here.
 */
function docRows(): Map<string, DocRow> {
  const start = CLIENT_MD.indexOf('### 11.6 Studies');
  expect(start, 'CLIENT.md has no §11.6').toBeGreaterThan(-1);
  const rest = CLIENT_MD.slice(start);
  const end = rest.indexOf('\n### ');
  const section = end === -1 ? rest : rest.slice(0, end);

  const rows = new Map<string, DocRow>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    // `| \`SMA\` | Simple moving average | main | \`n=20\` | 1 line |` splits to 7 with two empties.
    if (cells.length !== 7) continue;
    const id = /^`([A-Z]+)`$/.exec(cells[1] ?? '')?.[1];
    if (id === undefined) continue;
    const params: Record<string, number> = {};
    for (const run of (cells[4] ?? '').matchAll(/`([^`]+)`/g)) {
      for (const pair of (run[1] ?? '').split(',')) {
        const m = /^\s*([a-z]+)\s*=\s*(-?[\d.]+)\s*$/.exec(pair);
        if (m !== null) params[m[1] ?? ''] = Number(m[2]);
      }
    }
    rows.set(id, {
      id,
      name: cells[2] ?? '',
      pane: cells[3] ?? '',
      params,
      outputs: cells[5] ?? '',
    });
  }
  return rows;
}

const DOC = docRows();

describe('the registry fragment, against CLIENT.md §11.6', () => {
  it('is exactly the nine studies §11.6 puts on the main pane', () => {
    const mainInDoc = [...DOC.values()].filter((r) => r.pane === 'main').map((r) => r.id);
    // Nine of the twenty-two, in the document's own order. If §11.6 ever moves a study between
    // panes, this fails here rather than by drawing RSI on top of the price.
    expect(mainInDoc).toEqual([
      'SMA',
      'EMA',
      'WMA',
      'BB',
      'DONCHIAN',
      'KELTNER',
      'PSAR',
      'ICHIMOKU',
      'VWAP',
    ]);
    expect(STUDY_IDS_HERE).toEqual(mainInDoc);
  });

  it.each(STUDY_IDS_HERE)('%s matches its documented name, pane and parameter defaults', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    const row = DOC.get(id);
    expect(row, `§11.6 has no row for ${id}`).toBeDefined();
    if (row === undefined) return;

    expect(study.id).toBe(id);
    expect(study.name.toLowerCase()).toBe(row.name.toLowerCase());
    expect(study.pane).toBe('main');
    expect(defaults(study)).toEqual(row.params);
    // Every study here is in price units, so the pane's axis formats them as prices (§11.6 `yFmt`).
    expect(study.yFmt).toBe('px');
  });

  it.each(STUDY_IDS_HERE)('%s publishes usable parameter bounds', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    for (const p of study.params) {
      expect(p.label.length, `${id}.${p.name} needs a picker label`).toBeGreaterThan(0);
      expect(p.min).toBeLessThan(p.max);
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
      expect(p.step).toBeGreaterThan(0);
      // A step larger than the range would give the picker's number field no reachable value.
      expect(p.step).toBeLessThanOrEqual(p.max - p.min);
    }
  });

  it.each(STUDY_IDS_HERE)('%s draws a band exactly when §11.6 says it does', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    const row = DOC.get(id);
    const out = study.compute(inputFor(id), defaults(study));
    const docSaysBand = /band|cloud/.test(row?.outputs ?? '');
    expect(out.bands !== undefined, `${id}: §11.6 outputs = "${row?.outputs ?? ''}"`).toBe(
      docSaysBand,
    );
    for (const band of out.bands ?? []) {
      // A band naming a line the study does not emit is a renderer crash rather than a missing fill.
      expect(out.lines.map((l) => l.id)).toContain(band.upper);
      expect(out.lines.map((l) => l.id)).toContain(band.lower);
      expect(band.alpha).toBeGreaterThan(0);
      expect(band.alpha).toBeLessThan(1);
    }
  });

  it('adds no pane and no sub-pane furniture — the "multi-pane layout" half that is ours', () => {
    for (const id of STUDY_IDS_HERE) {
      const study = trendStudies[id as keyof typeof trendStudies];
      const out = study.compute(inputFor(id), defaults(study));
      // `pane: 'main'` is what makes a study overlay the price axis instead of adding a linked pane
      // (§11.6). `histogram` and `levels` are sub-pane furniture: a histogram needs its own zero
      // baseline and `levels` are the horizontal references a sub-pane study is read against, and
      // drawing either on the price pane would put an RSI-shaped line through a price chart.
      expect(study.pane).toBe('main');
      expect(out.histogram).toBeUndefined();
      expect(out.levels).toBeUndefined();
      expect(out.lines.length).toBeGreaterThan(0);
      for (const line of out.lines) {
        expect(line.label.length, `${id}.${line.id} needs a legend label`).toBeGreaterThan(0);
        expect(line.y.length).toBe(inputFor(id).close.length);
      }
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 2. Hand-derived points                                                                         */
/* -------------------------------------------------------------------------------------------- */

/**
 * Points computed by hand from the raw fixture, asserted as literals.
 *
 * The derivations are in the comments and use only the fixture's own numbers, so they can be checked
 * with a calculator and without this repository. `toBeCloseTo(x, 8)` rather than `toBe`: the same
 * arithmetic in a different order differs in the last bit or two of a double, and a study that
 * summed its window the other way round is not wrong. Eight decimals on a ~$150 price is a
 * millionth of a cent — far tighter than any error that could be a bug and looser than the bit noise.
 */
describe('hand-derived points from yahoo-chart-events.json', () => {
  const closes = DAILY_BARS.map((b) => b.close);
  const highs = DAILY_BARS.map((b) => b.high);
  const lows = DAILY_BARS.map((b) => b.low);

  it('the fixture is the capture these numbers were derived from', () => {
    // If the capture is ever re-recorded, every literal below is void — so they are anchored to the
    // bar count and to the first two closes rather than trusting the file name.
    expect(DAILY_BARS.length).toBe(1255);
    expect(closes[0]).toBeCloseTo(149.02999877929688, 10);
    expect(closes[1]).toBeCloseTo(148.7899932861328, 10);
    expect(INTRADAY_BARS.length).toBe(316);
  });

  it('SMA(20): the mean of the first twenty closes, at slot 19', () => {
    // Σ closes[0..19] = 2876.8699645996094 (add the twenty numbers in the fixture in order);
    // ÷ 20 = 143.84349822998047. Slot 19 and not slot 20: nineteen closes are not yet twenty.
    const y = lineOf(trendStudies.SMA.compute(DAILY, { n: 20 }), 'sma');
    expect(y[19]).toBeCloseTo(143.84349822998047, 8);
    // Σ closes[1..20] = 2868.749969482422; ÷ 20 = 143.4374984741211 — the window has moved one bar.
    expect(y[20]).toBeCloseTo(143.4374984741211, 8);
  });

  it('EMA(20): seeded with SMA(20) at slot 19, then one recurrence step', () => {
    // k = 2/(20+1) = 0.09523809523809523. Slot 19 is the seed, so it equals SMA(20) exactly.
    // Slot 20 = closes[20]·k + seed·(1−k) = 140.91000366210938 × 0.095238095…
    //                                     + 143.84349822998047 × 0.904761904… = 143.56411779494513.
    const y = lineOf(trendStudies.EMA.compute(DAILY, { n: 20 }), 'ema');
    expect(y[19]).toBeCloseTo(143.84349822998047, 8);
    expect(y[20]).toBeCloseTo(143.56411779494513, 8);
  });

  it('WMA(20): weights 1…20 oldest to newest over 210', () => {
    // Σ closes[i]·(i+1) for i = 0..19 = 29991.309539794922; the weights sum to 20·21/2 = 210;
    // 29991.309539794922 ÷ 210 = 142.81575971330915. It sits below SMA(20) at the same slot
    // (143.84349822998047) because this window was falling and WMA leans on the recent end.
    const y = lineOf(trendStudies.WMA.compute(DAILY, { n: 20 }), 'wma');
    expect(y[19]).toBeCloseTo(142.81575971330915, 8);
  });

  it('BB(20, 2): population σ of the same twenty closes, which is core `stdevOf(w, 0)`', () => {
    // mean = 143.84349822998047 (above). Σ(x − mean)² over the twenty closes = 134.3934247305151.
    // POPULATION σ divides by n: √(134.3934247305151 / 20) = 2.592232866955775.
    //   upper = mean + 2σ = 149.027963963892
    //   lower = mean − 2σ = 138.65903249606893
    // The sample σ (n−1) would be √(134.3934247305151/19) = 2.65957480506026, giving an upper of
    // 149.1626478401 — 13½ cents wider, and entirely plausible-looking. That is why `BB` passes
    // `ddof: 0` to core's `stdevOf` explicitly instead of taking a default (API-05).
    const out = trendStudies.BB.compute(DAILY, { n: 20, k: 2 });
    expect(lineOf(out, 'mid')[19]).toBeCloseTo(143.84349822998047, 8);
    expect(lineOf(out, 'upper')[19]).toBeCloseTo(149.027963963892, 8);
    expect(lineOf(out, 'lower')[19]).toBeCloseTo(138.65903249606893, 8);
    // And not the sample-σ band, which is the mistake this study is most likely to ship with.
    expect(lineOf(out, 'upper')[19]).not.toBeCloseTo(149.1626478401, 4);
  });

  it('DONCHIAN(20): the highest high and lowest low of bars 0..19, inclusive of the current bar', () => {
    // max highs[0..19] = 149.44000244140625 (bar 0's high); min lows[0..19] = 138.27000427246094
    // (bar 13's low); mid = their average = 143.8550033569336.
    expect(Math.max(...highs.slice(0, 20))).toBeCloseTo(149.44000244140625, 10);
    expect(Math.min(...lows.slice(0, 20))).toBeCloseTo(138.27000427246094, 10);
    const out = trendStudies.DONCHIAN.compute(DAILY, { n: 20 });
    expect(lineOf(out, 'upper')[19]).toBeCloseTo(149.44000244140625, 8);
    expect(lineOf(out, 'lower')[19]).toBeCloseTo(138.27000427246094, 8);
    expect(lineOf(out, 'mid')[19]).toBeCloseTo(143.8550033569336, 8);
  });

  it('PSAR: opens short, because close[1] < close[0], and stops at the higher of the two highs', () => {
    // closes[0] = 149.02999877929688, closes[1] = 148.7899932861328 → falling → the first trend is
    // short → the first stop is above the price: max(highs[0], highs[1]) = 149.44000244140625, at
    // slot 1. Slot 0 has no value at all: one bar cannot say which way the trend points.
    const y = lineOf(trendStudies.PSAR.compute(DAILY, { af: 0.02, max: 0.2 }), 'psar');
    expect(Number.isNaN(y[0] ?? Number.NaN)).toBe(true);
    expect(y[1]).toBeCloseTo(149.44000244140625, 8);
  });

  it('ICHIMOKU: tenkan is a range midpoint, and chikou is the close shifted 26 slots back', () => {
    // tenkan[8] = (max highs[0..8] + min lows[0..8]) / 2 = 145.3550033569336 — a midpoint of the
    // range, not a mean of closes, which is what distinguishes Ichimoku's lines from a moving
    // average and is the detail an implementation most often gets wrong.
    const out = trendStudies.ICHIMOKU.compute(DAILY, { tenkan: 9, kijun: 26, senkou: 52 });
    expect(lineOf(out, 'tenkan')[8]).toBeCloseTo(145.3550033569336, 8);
    // chikou[0] = closes[26] = 149.47999572753906. The lagging span is the one line that is allowed
    // to know the future, because it is drawn behind: it carries no leading gap and ends 26 slots
    // early. Asserted over the whole series, because the shift is the study.
    const chikou = lineOf(out, 'chikou');
    expect(chikou[0]).toBeCloseTo(149.47999572753906, 8);
    const shifted: number[] = [];
    for (let i = 0; i < closes.length - 26; i += 1) shifted.push(closes[i + 26] ?? Number.NaN);
    const got = Array.from(chikou.subarray(0, closes.length - 26));
    expect(got).toEqual(shifted);
  });

  it('VWAP: typical price weighted by volume, from the first bar of the session', () => {
    // Intraday bar 0: h 331.1300048828125, l 328.3500061035156, c 331.0299987792969, v 1,296,997.
    //   typical = (h + l + c)/3 = 330.1700032552083, and with one bar accumulated VWAP = typical.
    // Intraday bar 1: typical = 330.73000081380206, v = 205,009.
    //   VWAP[1] = (330.1700032552083×1,296,997 + 330.73000081380206×205,009) ÷ 1,502,006
    //           = 330.2464373969426 — between the two typical prices and much nearer the first,
    //   which is what volume weighting means and what an unweighted mean (330.4500020345052)
    //   would not give.
    const y = lineOf(trendStudies.VWAP.compute(INTRADAY, { anchor: 0 }), 'vwap');
    expect(y[0]).toBeCloseTo(330.1700032552083, 8);
    expect(y[1]).toBeCloseTo(330.2464373969426, 8);
    expect(y[1]).not.toBeCloseTo(330.4500020345052, 4);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 3. The goldens                                                                                 */
/* -------------------------------------------------------------------------------------------- */

interface GoldenLine {
  id: string;
  label: string;
  firstDefinedIndex: number;
  lastDefinedIndex: number;
  finiteCount: number;
  sumFinite: number;
  min: number;
  max: number;
  y: (number | null)[];
}

interface Golden {
  id: string;
  producedBy: string;
  fixture: string;
  bars: number;
  params: Record<string, number>;
  tol: { abs: number; rel: number };
  lines: GoldenLine[];
  bands?: { upper: string; lower: string; alpha: number }[];
}

function golden(id: string): Golden {
  const path = join(REPO_ROOT, 'fixtures', 'golden', 'analytics', 'studies', `${id}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Golden;
}

describe('goldens: the nine studies against an independent reference', () => {
  it.each(STUDY_IDS_HERE)('%s reproduces its golden series point for point', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    const g = golden(id);
    const input = inputFor(id);

    expect(g.id).toBe(id);
    expect(g.bars).toBe(input.close.length);
    // The golden's parameters are the ones asserted against §11.6 above, so a golden recorded under
    // different parameters than the study's defaults cannot slip past unnoticed.
    expect(g.params).toEqual(defaults(study));
    expect(g.fixture).toContain(
      INTRADAY_ONLY.has(id) ? 'yahoo-chart-AAPL-1d-1m.json' : 'yahoo-chart-events.json',
    );

    const out = study.compute(input, g.params);
    expect(out.lines.map((l) => l.id)).toEqual(g.lines.map((l) => l.id));

    // One assertion per line rather than per point: 1,255 × 5 `expect` calls would dominate the
    // suite's runtime and report the same fact. Every mismatch is collected with its index and
    // magnitude, so a failure names the slot instead of just the study.
    for (const gl of g.lines) {
      const y = lineOf(out, gl.id);
      const problems: string[] = [];
      let finite = 0;
      let sum = 0;
      for (let i = 0; i < gl.y.length; i += 1) {
        const want = gl.y[i] ?? null;
        const got = y[i] ?? Number.NaN;
        if (want === null) {
          if (!Number.isNaN(got))
            problems.push(`[${String(i)}] expected a gap, got ${String(got)}`);
          continue;
        }
        if (Number.isNaN(got)) {
          problems.push(`[${String(i)}] expected ${String(want)}, got a gap`);
          continue;
        }
        finite += 1;
        sum += got;
        const slack = g.tol.abs + g.tol.rel * Math.abs(want);
        if (Math.abs(got - want) > slack) {
          problems.push(
            `[${String(i)}] ${String(got)} vs ${String(want)} (Δ${String(got - want)})`,
          );
        }
      }
      expect(problems.slice(0, 5), `${id}.${gl.id}: ${String(problems.length)} mismatches`).toEqual(
        [],
      );
      expect(finite).toBe(gl.finiteCount);
      // The sum is a second, independent grip on the same series: a sign flip or a shifted window
      // that happened to land inside the per-point tolerance cannot also preserve the total.
      expect(sum).toBeCloseTo(gl.sumFinite, 6);
    }
  });

  it('every golden was produced by something other than the code it judges', () => {
    // The point of the goldens is that they are a second opinion. If one is ever regenerated from
    // `trend.ts` — the easy thing to do when a study changes — it stops being evidence, and this is
    // the line that notices.
    for (const id of STUDY_IDS_HERE) {
      const g = golden(id);
      expect(g.producedBy, `${id}.json`).toMatch(/independent reference implementation/i);
      expect(g.producedBy).not.toMatch(/trend\.ts$/);
      expect(g.tol.abs).toBeLessThanOrEqual(1e-9);
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 4. The leading gap, and no lookahead                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * The first and last slot of every line that carries a value, as literals.
 *
 * Derived by hand from the parameters, not copied from a run:
 *  - a window of `n` ends its warm-up at slot `n − 1`: 20 → 19, 9 → 8, 26 → 25, 52 → 51;
 *  - `PSAR` needs two bars to know the trend, so slot 1;
 *  - `KELTNER`'s edges need both `EMA(20)` (slot 19) and Wilder `ATR(10)` (slot 10), so slot 19;
 *  - `ICHIMOKU`'s senkou spans are plotted 26 slots forward: A from 25 + 26 = 51, B from 51 + 26 =
 *    77, and both still reach the last slot (1,254), drawn from the bars 26 slots behind it. What is
 *    lost is the other end: the values computed from the last 26 bars would be plotted at slots
 *    1,255..1,280, and no slot exists past the last bar (§11.2), so the cloud's future half is a
 *    stated gap. This table asserts the drawn range, which is the thing a reader can check;
 *  - `chikou` is the close plotted 26 slots back: no leading gap at all, last value at 1,228;
 *  - `VWAP` starts at slot 0, because one bar of a session already has a volume-weighted price.
 */
const GAPS: Record<string, Record<string, [number, number]>> = {
  SMA: { sma: [19, 1254] },
  EMA: { ema: [19, 1254] },
  WMA: { wma: [19, 1254] },
  BB: { mid: [19, 1254], upper: [19, 1254], lower: [19, 1254] },
  DONCHIAN: { upper: [19, 1254], lower: [19, 1254], mid: [19, 1254] },
  KELTNER: { mid: [19, 1254], upper: [19, 1254], lower: [19, 1254] },
  PSAR: { psar: [1, 1254] },
  ICHIMOKU: {
    tenkan: [8, 1254],
    kijun: [25, 1254],
    senkouA: [51, 1254],
    senkouB: [77, 1254],
    chikou: [0, 1228],
  },
  VWAP: { vwap: [0, 315] },
};

describe('the leading-gap convention', () => {
  it.each(STUDY_IDS_HERE)('%s begins and ends exactly where its window says', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    const out = study.compute(inputFor(id), defaults(study));
    const expected = GAPS[id] ?? {};
    expect(Object.keys(expected)).toEqual(out.lines.map((l) => l.id));

    for (const [lineId, [first, last]] of Object.entries(expected)) {
      const y = lineOf(out, lineId);
      const where = `${id}.${lineId}`;
      expect(
        Number.isFinite(y[first] ?? Number.NaN),
        `${where} has no value at ${String(first)}`,
      ).toBe(true);
      if (first > 0) {
        // The slot before the first value must be a gap. `NaN` and not 0: a zero would draw the
        // study at the bottom of the price pane through its whole warm-up.
        expect(
          Number.isNaN(y[first - 1] ?? Number.NaN),
          `${where} has a value at ${String(first - 1)}`,
        ).toBe(true);
      }
      expect(
        Number.isFinite(y[last] ?? Number.NaN),
        `${where} has no value at ${String(last)}`,
      ).toBe(true);
      if (last + 1 < y.length) {
        expect(
          Number.isNaN(y[last + 1] ?? Number.NaN),
          `${where} has a value at ${String(last + 1)}`,
        ).toBe(true);
      }
    }
  });

  /**
   * Nothing a study draws at slot `i` may depend on a bar after `i`.
   *
   * The index assertions above catch a gap of the wrong length; they do not catch a study that reads
   * `close[i + 1]` and still starts in the right place. This does: one bar far to the right of the
   * slot under inspection is moved by $10 — close, high and low together — and every value at the
   * earlier slot must be bit-identical. That is CHRT-04's honesty condition stated as a test, and it
   * is the one bug in a study that a chart cannot show you.
   *
   * `chikou` is excluded and asserted separately: it is the close plotted 26 slots *back*, so
   * depending on a later bar is its definition.
   */
  it.each(STUDY_IDS_HERE)('%s at an earlier slot cannot see a later bar', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    const input = inputFor(id);
    const at = INTRADAY_ONLY.has(id) ? 100 : 600;
    const perturbAt = INTRADAY_ONLY.has(id) ? 300 : 900;

    const bumped: StudyInput = {
      ...input,
      close: input.close.slice(),
      high: (input.high ?? input.close).slice(),
      low: (input.low ?? input.close).slice(),
    };
    bumped.close[perturbAt] = (input.close[perturbAt] ?? 0) + 10;
    if (bumped.high !== undefined) bumped.high[perturbAt] = (input.high?.[perturbAt] ?? 0) + 10;
    if (bumped.low !== undefined) bumped.low[perturbAt] = (input.low?.[perturbAt] ?? 0) + 10;

    const before = study.compute(input, defaults(study));
    const after = study.compute(bumped, defaults(study));
    for (const line of before.lines) {
      if (line.id === 'chikou') continue;
      const a = line.y[at] ?? Number.NaN;
      const b = lineOf(after, line.id)[at] ?? Number.NaN;
      expect(b, `${id}.${line.id}[${String(at)}] moved when bar ${String(perturbAt)} did`).toBe(a);
    }
  });

  it('…and the perturbation the previous test relies on really does move things', () => {
    // Without this, the no-lookahead test above would pass just as happily against a harness that
    // perturbed nothing at all. Only the lines whose window certainly contains the moved bar are
    // listed: a $10 bump to bar 600 must move any average over it, and must raise a 20-bar high.
    const bumped: StudyInput = {
      ...DAILY,
      close: DAILY.close.slice(),
      high: (DAILY.high ?? DAILY.close).slice(),
      low: (DAILY.low ?? DAILY.close).slice(),
    };
    const i = 600;
    bumped.close[i] = (DAILY.close[i] ?? 0) + 10;
    if (bumped.high !== undefined) bumped.high[i] = (DAILY.high?.[i] ?? 0) + 10;
    if (bumped.low !== undefined) bumped.low[i] = (DAILY.low?.[i] ?? 0) + 10;

    const moved: [string, string][] = [
      ['SMA', 'sma'],
      ['EMA', 'ema'],
      ['WMA', 'wma'],
      ['BB', 'mid'],
      ['KELTNER', 'mid'],
      ['DONCHIAN', 'upper'],
    ];
    for (const [id, lineId] of moved) {
      const study = trendStudies[id as keyof typeof trendStudies];
      const a = lineOf(study.compute(DAILY, defaults(study)), lineId)[i] ?? Number.NaN;
      const b = lineOf(study.compute(bumped, defaults(study)), lineId)[i] ?? Number.NaN;
      expect(b, `${id}.${lineId}[600] ignored a $10 move in bar 600`).not.toBe(a);
    }
    // And the forward-shifted spans move when the bar 26 slots earlier moves, which is the same
    // dependency stated from the other end.
    const ichi = trendStudies.ICHIMOKU;
    const shiftBumped: StudyInput = {
      ...DAILY,
      close: DAILY.close.slice(),
      high: (DAILY.high ?? DAILY.close).slice(),
      low: (DAILY.low ?? DAILY.close).slice(),
    };
    if (shiftBumped.high !== undefined) shiftBumped.high[574] = (DAILY.high?.[574] ?? 0) + 10;
    const base = ichi.compute(DAILY, defaults(ichi));
    const after = ichi.compute(shiftBumped, defaults(ichi));
    expect(lineOf(after, 'senkouA')[600]).not.toBe(lineOf(base, 'senkouA')[600]);
    expect(lineOf(after, 'senkouB')[600]).not.toBe(lineOf(base, 'senkouB')[600]);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 5. Parameters: bounds, clamping and absence                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('parameters', () => {
  const series = (id: keyof typeof trendStudies, params: Record<string, number>, lineId: string) =>
    Array.from(lineOf(trendStudies[id].compute(inputFor(id), params), lineId));

  it('an absent parameter falls back to the published default', () => {
    // A frame's persisted params may predate a parameter, and a screen manifest may add a study
    // without naming one. Neither may produce a line of `NaN`.
    expect(series('SMA', {}, 'sma')).toEqual(series('SMA', { n: 20 }, 'sma'));
    expect(series('BB', { n: 20 }, 'upper')).toEqual(series('BB', { n: 20, k: 2 }, 'upper'));
  });

  it('a parameter below its minimum is clamped to the minimum, not divided by', () => {
    // `n = 0` is a division by zero and `n = -5` is a loop that never runs. Both clamp to `min` = 2,
    // which is a study the user can see is wrong, rather than an empty pane they cannot explain.
    expect(series('SMA', { n: 0 }, 'sma')).toEqual(series('SMA', { n: 2 }, 'sma'));
    expect(series('SMA', { n: -5 }, 'sma')).toEqual(series('SMA', { n: 2 }, 'sma'));
    expect(series('BB', { n: 20, k: -1 }, 'upper')).toEqual(
      series('BB', { n: 20, k: 0.1 }, 'upper'),
    );
  });

  it('a parameter above its maximum is clamped to the maximum', () => {
    // `n = 10_000_000` over 1,255 bars is a study that computes nothing, slowly.
    expect(series('SMA', { n: 10_000_000 }, 'sma')).toEqual(series('SMA', { n: 400 }, 'sma'));
    expect(series('BB', { n: 20, k: 99 }, 'upper')).toEqual(series('BB', { n: 20, k: 5 }, 'upper'));
  });

  it('a non-finite parameter is treated as absent, not as a bound', () => {
    // `NaN` and `Infinity` both mean "this is not a window length", and the honest answer to both is
    // the published default — clamping `Infinity` to `max` would silently draw a 400-period average
    // for a study the user thinks is on its default, which is worse than obviously wrong.
    expect(series('SMA', { n: Number.NaN }, 'sma')).toEqual(series('SMA', { n: 20 }, 'sma'));
    expect(series('SMA', { n: Number.POSITIVE_INFINITY }, 'sma')).toEqual(
      series('SMA', { n: 20 }, 'sma'),
    );
    expect(series('BB', { n: 20, k: Number.NaN }, 'upper')).toEqual(
      series('BB', { n: 20, k: 2 }, 'upper'),
    );
  });

  it('a shorter window starts earlier — the clamp is not just returning the default', () => {
    // Guards the three tests above: if `intParam` ignored its argument entirely they would all pass.
    const short = lineOf(trendStudies.SMA.compute(DAILY, { n: 5 }), 'sma');
    expect(Number.isFinite(short[4] ?? Number.NaN)).toBe(true);
    expect(Number.isNaN(short[3] ?? Number.NaN)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 6. `needs`, enforced                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('`needs`', () => {
  const closeOnly: StudyInput = { x: DAILY.x, close: DAILY.close };
  const noVolume: StudyInput = {
    x: INTRADAY.x,
    close: INTRADAY.close,
    high: INTRADAY.high ?? INTRADAY.close,
    low: INTRADAY.low ?? INTRADAY.close,
  };

  it.each(STUDY_IDS_HERE)('%s declares what it reads', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    expect(study.needs.length).toBeGreaterThan(0);
    for (const need of study.needs) expect(['close', 'ohlc', 'volume']).toContain(need);
  });

  it('a study needing ohlc throws a named error on a close-only series', () => {
    // An index or a line series carries no high/low. The alternative to a throw is `input.high!`,
    // which is a `TypeError` inside a `frame()` callback — a blank chart and a stack trace with no
    // study name in it.
    for (const id of ['DONCHIAN', 'KELTNER', 'PSAR', 'ICHIMOKU', 'VWAP'] as const) {
      const study = trendStudies[id];
      expect(study.needs).toContain('ohlc');
      expect(() => study.compute(closeOnly, defaults(study))).toThrow(
        new RegExp(`^${id}: needs ohlc`),
      );
    }
  });

  it('VWAP throws on a series with no volume, and is the only study that needs it', () => {
    expect(() => trendStudies.VWAP.compute(noVolume, { anchor: 0 })).toThrow(/^VWAP: needs volume/);
    const needVolume = STUDY_IDS_HERE.filter((id) =>
      trendStudies[id as keyof typeof trendStudies].needs.includes('volume'),
    );
    expect(needVolume).toEqual(['VWAP']);
  });

  it('the close-only studies are happy on a close-only series', () => {
    // The converse: `needs: ['close']` must mean it, or the guard above is just a way of refusing
    // to draw an overlay on a line series.
    for (const id of ['SMA', 'EMA', 'WMA', 'BB'] as const) {
      const study = trendStudies[id];
      const out = study.compute(closeOnly, defaults(study));
      expect(Number.isFinite(lineOf(out, out.lines[0]?.id ?? '')[19] ?? Number.NaN)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 7. VWAP's session anchor                                                                       */
/* -------------------------------------------------------------------------------------------- */

describe('VWAP: the session anchor (§11.6 `anchor=0`)', () => {
  // Two sessions of real bars: the capture is one UTC day, so a second session is the same 316 bars
  // shifted forward exactly 24 hours. Real bars rather than invented ones — a hand-built series with
  // round numbers can make a reset look right that no payload would ever produce.
  const twoSessions: StudyInput = {
    x: Float64Array.from([
      ...INTRADAY_BARS.map((b) => b.barTs),
      ...INTRADAY_BARS.map((b) => b.barTs + 86_400_000),
    ]),
    close: Float64Array.from([...INTRADAY.close, ...INTRADAY.close]),
    high: Float64Array.from([...(INTRADAY.high ?? []), ...(INTRADAY.high ?? [])]),
    low: Float64Array.from([...(INTRADAY.low ?? []), ...(INTRADAY.low ?? [])]),
    volume: Float64Array.from([...(INTRADAY.volume ?? []), ...(INTRADAY.volume ?? [])]),
  };
  const n = INTRADAY_BARS.length;
  const firstBar = INTRADAY_BARS[0];
  const typical0 = ((firstBar?.high ?? 0) + (firstBar?.low ?? 0) + (firstBar?.close ?? 0)) / 3;

  it('resets at the session boundary: the first bar of day two is its own typical price', () => {
    const y = lineOf(trendStudies.VWAP.compute(twoSessions, { anchor: 0 }), 'vwap');
    // Slot `n` is the first bar of the second session. With the accumulators reset, its VWAP is its
    // own typical price — the same number slot 0 carries.
    expect(y[n]).toBeCloseTo(typical0, 8);
    expect(y[n]).toBeCloseTo(y[0] ?? Number.NaN, 8);
    // And the day-one series is untouched by the extra day: a session VWAP is a session's business.
    const oneDay = lineOf(trendStudies.VWAP.compute(INTRADAY, { anchor: 0 }), 'vwap');
    expect(Array.from(y.subarray(0, n))).toEqual(Array.from(oneDay));
  });

  it('anchor = 1 never resets, so day two carries day one forward', () => {
    const anchored = lineOf(trendStudies.VWAP.compute(twoSessions, { anchor: 1 }), 'vwap');
    const session = lineOf(trendStudies.VWAP.compute(twoSessions, { anchor: 0 }), 'vwap');
    // Up to the boundary the two are the same series — there has been nothing to reset yet.
    expect(Array.from(anchored.subarray(0, n))).toEqual(Array.from(session.subarray(0, n)));
    // At the boundary they part. The expected value is computed here from the raw bars — Σ(typical ×
    // volume) over all n + 1 of them, over Σvolume — rather than by asking the study, so this is an
    // assertion about the arithmetic and not a restatement of it.
    let pv = 0;
    let vol = 0;
    for (const b of [...INTRADAY_BARS, ...INTRADAY_BARS.slice(0, 1)]) {
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vol += b.volume;
    }
    expect(anchored[n]).toBeCloseTo(pv / vol, 8);
    // And it is not the reset answer: a session anchor would give the new bar's own typical price.
    expect(anchored[n]).not.toBeCloseTo(typical0, 4);
  });

  it('every slot of both anchors has a value, because these bars all carry volume', () => {
    // The gap case is real — a zero-volume opening print has no volume-weighted price — but it is
    // not this fixture's case, and asserting "no gaps" here is what would notice if the session
    // detection started slicing the series into one-bar sessions.
    const y = lineOf(trendStudies.VWAP.compute(twoSessions, { anchor: 0 }), 'vwap');
    expect(Array.from(y).filter((v) => Number.isNaN(v)).length).toBe(0);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* 8. `update()` — the incremental last-slot form (§11.5)                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * Which of the nine offer an incremental form, and why the other four do not.
 *
 * `SMA`, `EMA` and `WMA` have one because their value at a slot is a function of that slot's window
 * (`EMA`'s of the previous output value, in constant time). `BB` and `DONCHIAN` recompute the one
 * slot's window, which is what §11.5 asks of a study with no recurrence.
 *
 * `KELTNER`, `PSAR`, `ICHIMOKU` and `VWAP` carry state that a `StudyOutput` does not: Wilder's ATR
 * recurrence, the SAR's trend/extreme/acceleration triple, the forward-shifted cloud (a new bar
 * writes 26 slots ahead of the last one, so the slot that changes is not the last slot) and the
 * session's running Σpv and Σv. Each declares no `update`, and §11.5 says what the caller does then:
 * recompute the last window. This asserts the partition rather than leaving it to be discovered.
 */
const HAS_UPDATE: Record<string, boolean> = {
  SMA: true,
  EMA: true,
  WMA: true,
  BB: true,
  DONCHIAN: true,
  KELTNER: false,
  PSAR: false,
  ICHIMOKU: false,
  VWAP: false,
};

describe('update(): the streaming last-slot form', () => {
  it.each(STUDY_IDS_HERE)('%s offers an incremental form exactly when it has one', (id) => {
    const study = trendStudies[id as keyof typeof trendStudies];
    expect(typeof study.update === 'function').toBe(HAS_UPDATE[id]);
  });

  /** The first `count` daily bars as a `StudyInput` — a series as it stood `count` bars ago. */
  function prefix(count: number): StudyInput {
    return toInput(DAILY_BARS.slice(0, count));
  }

  const incremental = STUDY_IDS_HERE.filter((id) => HAS_UPDATE[id] === true);

  it.each(incremental)('%s: a forming bar that moves gives what a full recompute gives', (id) => {
    // The `b1m:` subject re-delivers the same minute with a new close several times before
    // `IS_FINAL` (§11.5). The last slot is overwritten in place and `update` is called for it.
    const study = trendStudies[id as keyof typeof trendStudies];
    const params = defaults(study);
    const last = 59;
    const settled = prefix(60);
    const prev = study.compute(settled, params);

    const moving: StudyInput = {
      ...settled,
      close: settled.close.slice(),
      high: (settled.high ?? settled.close).slice(),
      low: (settled.low ?? settled.close).slice(),
    };
    // The forming bar prints $3 higher than it last did, taking the high with it.
    moving.close[last] = (settled.close[last] ?? 0) + 3;
    if (moving.high !== undefined) moving.high[last] = (settled.high?.[last] ?? 0) + 3;

    const updated = study.update?.(prev, moving, params, last);
    expect(updated).toBeDefined();
    const fresh = study.compute(moving, params);
    for (const line of fresh.lines) {
      const got = lineOf(updated ?? fresh, line.id);
      // Every slot, not only the last: an `update` that widened or reallocated wrongly would move
      // history, and history is what the trader has been looking at for the last hour.
      expect(Array.from(got), `${id}.${line.id}`).toEqual(Array.from(line.y));
    }
    // The band metadata has to survive the round trip, or the fill disappears on the first tick.
    expect(updated?.bands).toEqual(fresh.bands);
  });

  it.each(incremental)('%s: an appended slot grows the output and matches a recompute', (id) => {
    // The first tick of a new minute adds a slot (§11.5): the input is one longer than the arrays
    // the previous output holds.
    const study = trendStudies[id as keyof typeof trendStudies];
    const params = defaults(study);
    const prev = study.compute(prefix(59), params);
    const grown = prefix(60);
    const updated = study.update?.(prev, grown, params, 59);
    const fresh = study.compute(grown, params);
    for (const line of fresh.lines) {
      const got = lineOf(updated ?? fresh, line.id);
      expect(got.length, `${id}.${line.id} length`).toBe(60);
      expect(Array.from(got), `${id}.${line.id}`).toEqual(Array.from(line.y));
    }
  });

  it.each(incremental)(
    '%s: update falls back to a full compute when handed a foreign output',
    (id) => {
      // `update` is handed whatever the caller kept — and on a study change, a parameter change or the
      // first tick after a re-fetch, that is not a previous output of this study. It must not read a
      // line that is not there.
      const study = trendStudies[id as keyof typeof trendStudies];
      const params = defaults(study);
      const input = prefix(60);
      const foreign: StudyOutput = {
        lines: [{ id: 'not-mine', label: 'x', y: new Float64Array(3), style: { color: 'auto' } }],
      };
      const out = study.update?.(foreign, input, params, 59);
      const fresh = study.compute(input, params);
      for (const line of fresh.lines) {
        expect(Array.from(lineOf(out ?? fresh, line.id)), `${id}.${line.id}`).toEqual(
          Array.from(line.y),
        );
      }
    },
  );

  it('EMA.update is the constant-time one, and still agrees at the seed edge', () => {
    // `EMA`'s recurrence needs the previous output value; at a slot where that value is still inside
    // the warm-up there is nothing to carry forward, so it recomputes. Slot 19 is the seed itself —
    // the first slot with a value — and slot 18 is inside the gap.
    const params = { n: 20 };
    const at19 = trendStudies.EMA.compute(prefix(20), params);
    const rebuilt = trendStudies.EMA.update?.(
      trendStudies.EMA.compute(prefix(19), params),
      prefix(20),
      params,
      19,
    );
    expect(Array.from(lineOf(rebuilt ?? at19, 'ema'))).toEqual(Array.from(lineOf(at19, 'ema')));
  });
});

describe('KELTNER and ATR share one Wilder ATR, so they agree across a gap', () => {
  /**
   * A series with a hole in it, which §11.2 makes ordinary: two securities on one chart align by the
   * union of their timestamps, so the one that did not trade on a slot is `NaN` there.
   */
  function gappedBars(len: number, holeAt: number): StudyInput {
    const x = new Float64Array(len);
    const close = new Float64Array(len);
    const high = new Float64Array(len);
    const low = new Float64Array(len);
    for (let i = 0; i < len; i += 1) {
      x[i] = 1_600_000_000_000 + i * 86_400_000;
      const base = 100 + i * 0.5;
      close[i] = base;
      high[i] = base + 1.5;
      low[i] = base - 1.5;
    }
    close[holeAt] = Number.NaN;
    high[holeAt] = Number.NaN;
    low[holeAt] = Number.NaN;
    return { x, close, high, low };
  }

  it('draws a Keltner band again after the hole, rather than stopping at it', () => {
    // KELTNER used to keep its own copy of Wilder's ATR, and that copy carried the recurrence
    // straight through a `NaN`: `prev = (prev * (n - 1) + NaN) / n` is `NaN`, and every later slot
    // inherited it. So one absent bar removed the band for the REST of the chart — silently, because
    // a band that is not drawn looks like a band that has not warmed up yet. The shared kernel
    // re-seeds after a gap instead, which is why this can now pass.
    const input = gappedBars(80, 40);
    const out = trendStudies.KELTNER.compute(input, { n: 20, atr: 10, k: 2 });
    const upper = lineOf(out, 'upper');

    const afterHole = Array.from(upper.subarray(41)).filter((v) => Number.isFinite(v));
    expect(afterHole.length).toBeGreaterThan(0);

    // And the band is still a band: upper above mid above lower, at the last slot.
    const mid = lineOf(out, 'mid');
    const lower = lineOf(out, 'lower');
    const last = 79;
    expect(Number.isFinite(upper[last]!)).toBe(true);
    expect(upper[last]!).toBeGreaterThan(mid[last]!);
    expect(mid[last]!).toBeGreaterThan(lower[last]!);
  });

  it('puts its band exactly k ATRs from the mid, using the same ATR the ATR pane would draw', () => {
    // The point of sharing the kernel is that the two studies cannot drift apart. This asserts the
    // arithmetic relation rather than the identity of the function, so it keeps its meaning if the
    // kernel moves again: (upper - mid) must be exactly k * ATR, and symmetric about the mid.
    const input = gappedBars(80, 40);
    const k = 2;
    const out = trendStudies.KELTNER.compute(input, { n: 20, atr: 10, k });
    const upper = lineOf(out, 'upper');
    const mid = lineOf(out, 'mid');
    const lower = lineOf(out, 'lower');
    const last = 79;
    const halfWidth = upper[last]! - mid[last]!;
    expect(halfWidth).toBeGreaterThan(0);
    expect(mid[last]! - lower[last]!).toBeCloseTo(halfWidth, 12);
    // Hand-derived, so it pins the arithmetic and not just its self-consistency. The bars are
    // `high = base + 1.5`, `low = base - 1.5`, `close = base`, with `base` drifting +0.5 a day, so
    // at every slot past the first the three true-range terms are
    //     high - low                 = 3.0
    //     |high_i - close_{i-1}|     = |0.5 + 1.5| = 2.0
    //     |low_i  - close_{i-1}|     = |0.5 - 1.5| = 1.0
    // and the bar's own width wins the max. True range is therefore 3.0 at every slot, so Wilder's
    // average of it is 3.0 however it is seeded, and the half-width is `k * 3.0 = 6.0` — reached
    // again after the hole only because the kernel re-seeds.
    expect(halfWidth).toBeCloseTo(k * 3.0, 9);
  });
});
