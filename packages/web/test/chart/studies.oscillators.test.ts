// packages/web/test/chart/studies.oscillators.test.ts — the thirteen sub-pane studies against an
// independent reference, hand-computed closed forms, and their own bounds (CLIENT.md §11.6, CHRT-04,
// QA-01).
//
// **What makes these goldens worth having.** A golden produced by the code it checks records what the
// code does, not what the study is, and would go on passing after the day somebody replaced Wilder's
// smoothing with a simple mean. Every number in `fixtures/golden/analytics/studies/*.json` was
// therefore computed by a **separate reference implementation** — a throwaway script in another
// language, written from the conventions §11.6 states and from nothing in `oscillators.ts` — over the
// raw bars of the fixture. Agreement between two implementations that never saw each other is
// evidence; agreement between a file and its own output is not.
//
// Three further layers, because an independent reference can still be independently wrong:
//
//   1. **Closed forms, arithmetic by hand** (`describe('hand-computed closed forms')`). At its first
//      defined slot a Wilder study has no recursion yet — RSI reduces to `100·ΣG/(ΣG+ΣL)` and ATR to
//      the plain mean of fourteen true ranges — and Williams %R, momentum, OBV and ROC are closed
//      forms at every slot. Those are worked out below from the raw numbers, with the workings, so a
//      reader can check them without running anything. This is where the seed convention is pinned:
//      the no-seed recursive form of RSI gives a visibly different number at slot 14.
//   2. **Bounds over all 1255 bars.** RSI and the stochastic live in 0..100, Williams %R in −100..0,
//      ADX and ±DI at or above zero. A bound broken anywhere in the series is a convention error — a
//      swapped numerator, a lost sign, a range measured against the wrong extreme — and this cannot
//      pass vacuously, because the same assertions also require the series to have finite values.
//   3. **`update()` against `compute()`.** §11.5's incremental path exists to keep a tick off the
//      whole-series code path, so nothing else would notice if it drifted. Both cases the stream
//      produces are checked: a forming bar overwriting the last slot, and a finalised bar appending a
//      new one.
//
// **The fixture, and a stated deviation from §11.6.** §11.6 says study goldens come from
// `yahoo-chart-AAPL-max-1d.json`. That capture is **quarterly** (169 bars; docs/TESTING.md L748), so
// `RSI(14)` computed on it would be a 14-*quarter* RSI presented as the daily study the table
// defines, and every golden would encode a period nobody reading the table would expect. The daily
// capture — `yahoo-chart-events.json`, 1255 daily bars of AAPL — is used instead. The deviation is
// recorded here, in the `source` field of each golden, and in the module under test's header.
//
// jsdom's global `URL` is not the one `fileURLToPath` accepts, so paths are resolved with `dirname`
// — the same reason `test/no-direct-io.test.ts` and `test/chart/types.test.ts` give.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { STUDY_IDS } from '../../src/chart/studies/types.js';
import type { StudyDef, StudyInput, StudyOutput } from '../../src/chart/studies/types.js';
import {
  oscillatorStudies,
  trueRange,
  volumeDirection,
  wilderAverage,
} from '../../src/chart/studies/oscillators.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture and goldens
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `packages/web/test/chart/` → `packages/web/` → the monorepo root. */
const WEB_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(WEB_ROOT));
const GOLDEN_DIR = join(REPO_ROOT, 'fixtures', 'golden', 'analytics', 'studies');
const FIXTURE = join(REPO_ROOT, 'fixtures', 'providers', 'normalised', 'yahoo-chart-events.json');

interface FixtureBar {
  barTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const bars = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { bars: FixtureBar[] }).bars;

/** The whole daily capture as a `StudyInput`. Every study below sees exactly these 1255 bars. */
const input: StudyInput = {
  x: Float64Array.from(bars, (b) => b.barTs),
  open: Float64Array.from(bars, (b) => b.open),
  high: Float64Array.from(bars, (b) => b.high),
  low: Float64Array.from(bars, (b) => b.low),
  close: Float64Array.from(bars, (b) => b.close),
  volume: Float64Array.from(bars, (b) => b.volume),
};

/** One line's or histogram's digest in a golden: enough to pin every slot, not 1255 numbers. */
interface Digest {
  id: string;
  firstDefinedIndex: number;
  finiteCount: number;
  sumFinite: number;
  min: number;
  max: number;
  samples: { i: number; y: number }[];
}

interface Golden {
  id: string;
  source: string;
  fixture: string;
  bars: number;
  params: Record<string, number>;
  lines: Digest[];
  histogram?: Digest;
  levels?: number[];
  tol: { abs: number; rel: number };
}

const golden = (id: string): Golden =>
  JSON.parse(readFileSync(join(GOLDEN_DIR, `${id}.json`), 'utf8')) as Golden;

/**
 * Compare to a golden with an absolute floor and a relative term.
 *
 * Two implementations of the same arithmetic in the same order on the same doubles agree bit for bit
 * except through `Math.log` (HVOL), whose last bit is a platform's libm choice. The relative term
 * covers a few of those; it is far too tight to hide a convention error, which moves a study by whole
 * units and not by `1e-11` of one.
 */
function expectClose(actual: number, expected: number, tol: { abs: number; rel: number }): void {
  const limit = Math.max(tol.abs, tol.rel * Math.abs(expected));
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(limit);
}

/** Every output column of a study, keyed by id — the lines plus the histogram if it has one. */
function columns(out: StudyOutput): Map<string, Float64Array> {
  const map = new Map<string, Float64Array>(out.lines.map((line) => [line.id, line.y]));
  if (out.histogram !== undefined) map.set(out.histogram.id, out.histogram.y);
  return map;
}

/** A study's declared defaults as a params record — what `compute` is called with below. */
function defaults(def: StudyDef): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.name, p.default]));
}

const study = (id: string): StudyDef => {
  const def = oscillatorStudies[id];
  if (def === undefined) throw new Error(`no such study: ${id}`);
  return def;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Registry shape
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The parameter defaults §11.6's table gives, transcribed. `test/chart/types.test.ts` already checks
 * the *ids* against CLIENT.md by reading the document; the defaults are asserted as literals here
 * because the numbers are the study — a `fast` of 10 instead of 12 is a different MACD, and it is the
 * kind of edit that looks like a tidy-up in a diff.
 */
const EXPECTED_PARAMS: Record<string, Record<string, number>> = {
  VOL: { n: 20 },
  RSI: { n: 14 },
  MACD: { fast: 12, slow: 26, signal: 9 },
  STOCH: { k: 14, d: 3, smooth: 3 },
  ATR: { n: 14 },
  ADX: { n: 14 },
  CCI: { n: 20 },
  WILLR: { n: 14 },
  ROC: { n: 12 },
  MOM: { n: 10 },
  OBV: {},
  STDDEV: { n: 20 },
  HVOL: { n: 30 },
};

/** The reference levels §11.6 gives; a study absent from this map declares none. */
const EXPECTED_LEVELS: Record<string, number[]> = {
  RSI: [30, 70],
  STOCH: [20, 80],
  CCI: [-100, 100],
  WILLR: [-20, -80],
  ROC: [0],
  MOM: [0],
};

const IDS = Object.keys(EXPECTED_PARAMS);

describe('the sub-pane study registry', () => {
  it('exports exactly the thirteen sub-pane studies §11.6 tabulates', () => {
    expect(Object.keys(oscillatorStudies).sort()).toEqual([...IDS].sort());
  });

  it.each(IDS)('%s is registered under its own id, in a sub pane, with a known id', (id) => {
    const def = study(id);
    expect(def.id).toBe(id);
    expect(def.pane).toBe('sub');
    // `STUDY_IDS` is the twenty-two of the initial registry; a study whose id is not one of them
    // would be a pane the picker cannot offer and `studies/index.ts` cannot type.
    expect(STUDY_IDS as readonly string[]).toContain(id);
  });

  it.each(IDS)('%s declares §11.6’s parameter defaults', (id) => {
    expect(defaults(study(id))).toEqual(EXPECTED_PARAMS[id]);
  });

  it.each(IDS)('%s declares §11.6’s reference levels', (id) => {
    const out = study(id).compute(input, defaults(study(id)));
    expect(out.levels ?? null).toEqual(EXPECTED_LEVELS[id] ?? null);
  });

  it.each(IDS)('%s gives every parameter a range that contains its default', (id) => {
    for (const p of study(id).params) {
      expect(p.min).toBeLessThanOrEqual(p.default);
      expect(p.max).toBeGreaterThanOrEqual(p.default);
      expect(p.step).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Goldens
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('against the independent reference goldens', () => {
  it.each(IDS)('%s golden is the daily capture and this study’s parameters', (id) => {
    const g = golden(id);
    expect(g.id).toBe(id);
    expect(g.bars).toBe(bars.length);
    expect(g.bars).toBe(1255);
    expect(g.fixture).toBe('fixtures/providers/normalised/yahoo-chart-events.json');
    // The golden was computed with the defaults the study declares, so a default changed without the
    // golden being recomputed fails here with a legible reason rather than as 1255 wrong numbers.
    expect(g.params).toEqual(EXPECTED_PARAMS[id]);
  });

  it.each(IDS)('%s matches the reference at every digested point', (id) => {
    const def = study(id);
    const out = def.compute(input, defaults(def));
    const actual = columns(out);
    const g = golden(id);
    const digests = g.histogram === undefined ? g.lines : [...g.lines, g.histogram];
    expect(digests.length).toBeGreaterThan(0);

    for (const digest of digests) {
      const y = actual.get(digest.id);
      expect(y, `${id}: no output column ${digest.id}`).toBeDefined();
      if (y === undefined) continue;
      expect(y.length).toBe(bars.length);

      // Where the study starts. An off-by-one warm-up is the classic study bug: it shifts every
      // value by a slot and still draws a plausible line.
      const firstDefined = y.findIndex((v) => !Number.isNaN(v));
      expect(firstDefined, `${id}.${digest.id} first defined slot`).toBe(digest.firstDefinedIndex);
      for (let i = 0; i < digest.firstDefinedIndex; i += 1) {
        expect(Number.isNaN(y[i]!), `${id}.${digest.id} slot ${String(i)}`).toBe(true);
      }

      // Every finite slot, not only the sampled ones: the count, the running total and the two
      // extremes together mean a single wrong interior value cannot slip between samples.
      let finite = 0;
      let sum = 0;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (const v of y) {
        if (Number.isNaN(v)) continue;
        finite += 1;
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      expect(finite, `${id}.${digest.id} finite count`).toBe(digest.finiteCount);
      expectClose(sum, digest.sumFinite, g.tol);
      expectClose(min, digest.min, g.tol);
      expectClose(max, digest.max, g.tol);

      expect(digest.samples.length).toBeGreaterThan(0);
      for (const sample of digest.samples) {
        const value = y[sample.i]!;
        expect(Number.isFinite(value), `${id}.${digest.id} slot ${String(sample.i)}`).toBe(true);
        expectClose(value, sample.y, g.tol);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Closed forms, worked by hand from the raw bars
// ─────────────────────────────────────────────────────────────────────────────────────────────

const C = input.close;
const H = input.high!;
const L = input.low!;
const V = input.volume!;

describe('hand-computed closed forms', () => {
  /**
   * RSI's first value needs no recursion, and that is what makes it checkable on paper.
   *
   * With the Wilder **seed** — the simple mean of the first `n` changes — slot 14 is
   * `100 − 100/(1 + (ΣG/14)/(ΣL/14))`, and the two `/14`s cancel: `RSI₁₄ = 100·ΣG/(ΣG + ΣL)`. Over
   * closes 0..14 of this capture the seven up-days total 8.020 and the seven down-days 15.940, so
   * `RSI₁₄ = 100 × 8.02 / 23.96 = 33.4725`. The sums are recomputed below from the exact doubles so
   * the assertion is not limited by two-decimal prices, but 33.47 is the number to check on paper.
   *
   * This is the assertion that pins the seed. Running Wilder's recurrence from the first change with
   * no seed — the other thing people mean by "Wilder RSI" — gives 30.86 at this slot, not 33.47.
   */
  it('RSI at slot 14 is 100·ΣG/(ΣG+ΣL) over the first fourteen changes', () => {
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= 14; i += 1) {
      const change = C[i]! - C[i - 1]!;
      if (change > 0) gains += change;
      else losses -= change;
    }
    // The raw sums, to two decimals: 8.02 up against 15.94 down.
    expect(gains).toBeCloseTo(8.02, 2);
    expect(losses).toBeCloseTo(15.94, 2);

    const out = study('RSI').compute(input, { n: 14 });
    const y = columns(out).get('RSI.rsi')!;
    expect(y[14]!).toBeCloseTo((100 * gains) / (gains + losses), 12);
    expect(y[14]!).toBeCloseTo(33.4724, 3);
    // A simple mean of the last fourteen changes would give this same number only by coincidence;
    // slot 15 is where the two smoothings part company, and Wilder's is 36.03.
    expect(y[15]!).toBeCloseTo(36.0314, 3);
  });

  /**
   * ATR's first value is the plain mean of the first fourteen true ranges, so it can be worked out
   * from the bars with a calculator. The fourteen true ranges of this capture sum to 41.54 — note
   * that eight of the fourteen are set by a **previous-close** term rather than by the bar's own
   * `high − low`, which is exactly the part a reimplementation drops — giving `41.54/14 = 2.9671`.
   */
  it('ATR at slot 14 is the mean of the first fourteen true ranges', () => {
    const tr = trueRange(H, L, C);
    expect(Number.isNaN(tr[0]!)).toBe(true);
    let sum = 0;
    for (let i = 1; i <= 14; i += 1) sum += tr[i]!;
    expect(sum).toBeCloseTo(41.54, 2);

    // Slot 1: high 148.97, low 147.22, previous close 149.03. The bar's own range is 1.75, but the
    // gap down from the previous close makes |low − prevClose| = 1.81 the true range.
    expect(tr[1]!).toBeCloseTo(1.81, 2);
    expect(H[1]! - L[1]!).toBeCloseTo(1.75, 2);

    const out = study('ATR').compute(input, { n: 14 });
    const y = columns(out).get('ATR.atr')!;
    expect(Number.isNaN(y[13]!)).toBe(true);
    expect(y[14]!).toBeCloseTo(sum / 14, 12);
    expect(y[14]!).toBeCloseTo(2.96714, 5);
  });

  /**
   * Williams %R is a closed form at every slot, so slot 13 is three raw numbers: the highest high of
   * bars 0..13 is 149.44 (bar 0), the lowest low 138.27 (bar 13), the close 139.14 →
   * `−100 × (149.44 − 139.14) / (149.44 − 138.27) = −92.21`.
   */
  it('WILLR at slot 13 is −100·(hh − close)/(hh − ll) over the first fourteen bars', () => {
    let hh = Number.NEGATIVE_INFINITY;
    let ll = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 13; i += 1) {
      hh = Math.max(hh, H[i]!);
      ll = Math.min(ll, L[i]!);
    }
    expect(hh).toBeCloseTo(149.44, 2);
    expect(ll).toBeCloseTo(138.27, 2);

    const y = columns(study('WILLR').compute(input, { n: 14 })).get('WILLR.willr')!;
    expect(y[13]!).toBeCloseTo((-100 * (hh - C[13]!)) / (hh - ll), 12);
    expect(y[13]!).toBeCloseTo(-92.2113, 4);
  });

  /**
   * The stochastic and Williams %R measure the same thing from opposite ends of the range, so with
   * no smoothing (`smooth = 1`, `d = 1`) they must satisfy `%R = %K − 100` at every slot, exactly.
   *
   * That identity is worth asserting because neither study can be right on its own if it fails: a
   * flipped numerator in either one breaks it, and it holds for all 1242 defined slots rather than at
   * a sampled point. It also pins the raw %K closed form — `100·(close − ll)/(hh − ll)` — against a
   * number already checked by hand above.
   */
  it('raw %K and Williams %R are the same range read from opposite ends', () => {
    const k = columns(study('STOCH').compute(input, { k: 14, d: 1, smooth: 1 })).get('STOCH.k')!;
    const r = columns(study('WILLR').compute(input, { n: 14 })).get('WILLR.willr')!;
    let checked = 0;
    for (let i = 13; i < bars.length; i += 1) {
      expect(k[i]!).toBeCloseTo(r[i]! + 100, 10);
      checked += 1;
    }
    expect(checked).toBe(bars.length - 13);
  });

  /** `MOM(10)` at slot 10 is `close₁₀ − close₀` = 142.83 − 149.03 = −6.20. Nothing else. */
  it('MOM at slot 10 is close₁₀ − close₀', () => {
    const y = columns(study('MOM').compute(input, { n: 10 })).get('MOM.mom')!;
    expect(Number.isNaN(y[9]!)).toBe(true);
    expect(y[10]!).toBe(C[10]! - C[0]!);
    expect(y[10]!).toBeCloseTo(-6.2, 4);
  });

  /** `ROC(12)` at slot 12 is `100 × (close₁₂/close₀ − 1)` = 100 × (142.65/149.03 − 1) = −4.281 %. */
  it('ROC at slot 12 is a percentage of close₀, in percent points', () => {
    const y = columns(study('ROC').compute(input, { n: 12 })).get('ROC.roc')!;
    expect(Number.isNaN(y[11]!)).toBe(true);
    expect(y[12]!).toBeCloseTo(100 * (C[12]! / C[0]! - 1), 12);
    // Percent points, not a fraction: `yFmt: 'pct'` appends `%` without scaling, so a value of 0.043
    // here would render as "0.04 %" for a 4.3 % fall.
    expect(y[12]!).toBeCloseTo(-4.281, 3);
    expect(study('ROC').yFmt).toBe('pct');
  });

  /**
   * OBV's first three slots are arithmetic anyone can check: slot 0 is the origin 0; bar 1 closed
   * down, so slot 1 is `−68,034,100`; bar 2 closed down again, so slot 2 is
   * `−(68,034,100 + 129,868,800) = −197,902,900`.
   */
  it('OBV starts at zero and subtracts the volume of a down day', () => {
    const y = columns(study('OBV').compute(input, {})).get('OBV.obv')!;
    expect(y[0]!).toBe(0);
    expect(C[1]!).toBeLessThan(C[0]!);
    expect(y[1]!).toBe(-V[1]!);
    expect(y[1]!).toBe(-68_034_100);
    expect(y[2]!).toBe(-(V[1]! + V[2]!));
    expect(y[2]!).toBe(-197_902_900);
  });

  /**
   * CCI with `n = 2` is `±200/3` exactly, whatever the prices are, and that is a closed form for the
   * one part of CCI that is pure convention.
   *
   * Over two bars the mean absolute deviation of the typical price from its own mean is `|Δtp|/2`, so
   * `CCI = (tp₂ − mean)/(0.015 · |Δtp|/2) = ±(1/0.015) · (1/2)/(1/2)`… which is `±66.666…`. The value
   * therefore tests Lambert's 0.015 constant and the divisor's `/n` directly: with sample standard
   * deviation in place of mean absolute deviation the same two bars give ±94.28, and with the
   * constant dropped, ±1.
   */
  it('CCI over a two-bar window is ±200/3, which pins the 0.015 constant', () => {
    const y = columns(study('CCI').compute(input, { n: 2 })).get('CCI.cci')!;
    let seen = 0;
    for (let i = 1; i < bars.length; i += 1) {
      const v = y[i]!;
      expect(Number.isFinite(v)).toBe(true);
      // Six decimals, not twelve: when two consecutive typical prices are nearly equal, `tp − mean`
      // and the mean absolute deviation are both tiny and their ratio loses digits to cancellation —
      // observed at 1e-10 over this capture. The constant being tested is 0.015, and ±66.666667
      // separates it from the ±94.28 a sample standard deviation would give by eight orders of
      // magnitude more than this tolerance.
      expect(Math.abs(v)).toBeCloseTo(200 / 3, 6);
      seen += 1;
    }
    expect(seen).toBe(bars.length - 1);
  });

  /**
   * MACD's signal line is an EMA of the MACD line **seeded with the simple mean of its first nine
   * points**, so its first value, at slot 33, is exactly that mean — computable from the MACD line
   * the same call returned.
   *
   * This is the assertion that pins the EMA seed, which is otherwise invisible: an EMA run
   * recursively from the first close with no seed would make the MACD line finite from slot 0 and the
   * signal from slot 8, and would differ from these numbers for hundreds of bars.
   */
  it('MACD warms up at slow − 1 and its signal seeds on a simple mean', () => {
    const out = study('MACD').compute(input, { fast: 12, slow: 26, signal: 9 });
    const cols = columns(out);
    const macd = cols.get('MACD.macd')!;
    const signal = cols.get('MACD.signal')!;
    const hist = cols.get('MACD.hist')!;

    expect(Number.isNaN(macd[24]!)).toBe(true);
    expect(Number.isFinite(macd[25]!)).toBe(true);
    expect(Number.isNaN(signal[32]!)).toBe(true);

    let seed = 0;
    for (let i = 25; i <= 33; i += 1) seed += macd[i]!;
    expect(signal[33]!).toBeCloseTo(seed / 9, 12);

    // The histogram is the distance between the lines, at every slot, not the MACD line as bars.
    let checked = 0;
    for (let i = 33; i < bars.length; i += 1) {
      expect(hist[i]!).toBeCloseTo(macd[i]! - signal[i]!, 12);
      checked += 1;
    }
    expect(checked).toBe(bars.length - 33);
  });

  /**
   * ADX's two smoothings show up as its warm-up: ±DI from slot `n` (one Wilder average over true
   * range, seeded at slot 1) and ADX itself from slot `2n − 1` = 27 (a second Wilder average over DX,
   * whose own first value is at slot `n`). A study that stopped after the first smoothing would
   * report ADX from slot 14.
   */
  it('ADX warms up at 2n − 1 while ±DI warm up at n', () => {
    const cols = columns(study('ADX').compute(input, { n: 14 }));
    const adx = cols.get('ADX.adx')!;
    const plus = cols.get('ADX.plusDI')!;
    const minus = cols.get('ADX.minusDI')!;
    expect(Number.isNaN(plus[13]!)).toBe(true);
    expect(Number.isFinite(plus[14]!)).toBe(true);
    expect(Number.isFinite(minus[14]!)).toBe(true);
    expect(Number.isNaN(adx[26]!)).toBe(true);
    expect(Number.isFinite(adx[27]!)).toBe(true);

    // ADX's first value is the mean of the first fourteen DX values, the Wilder seed again. DX is
    // recomputed here from ±DI, which the study returned, so the relation between the two panes is
    // the assertion rather than the numbers.
    let seed = 0;
    for (let i = 14; i <= 27; i += 1) {
      const p = plus[i]!;
      const m = minus[i]!;
      seed += (100 * Math.abs(p - m)) / (p + m);
    }
    expect(adx[27]!).toBeCloseTo(seed / 14, 9);
  });

  /**
   * ADX's true-range smoothing is ATR's: the same `wilderAverage` of the same `trueRange`, exported
   * from the module so `KELTNER` cannot end up with a third one. `+DI + −DI ≤ 100` follows from that
   * shared denominator whenever directional movement cannot exceed true range, which is the
   * invariant this checks over the whole series.
   */
  it('ADX shares ATR’s Wilder-smoothed true range', () => {
    const atr = columns(study('ATR').compute(input, { n: 14 })).get('ATR.atr')!;
    const direct = wilderAverage(trueRange(H, L, C), 14, 1);
    for (let i = 0; i < bars.length; i += 1) {
      if (Number.isNaN(atr[i]!)) {
        expect(Number.isNaN(direct[i]!)).toBe(true);
      } else {
        expect(direct[i]!).toBe(atr[i]!);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bounds, over all 1255 bars
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Assert every finite slot of `y` lies in `[lo, hi]`, and that there were finite slots to check. */
function expectBounded(label: string, y: Float64Array, lo: number, hi: number): void {
  let checked = 0;
  for (let i = 0; i < y.length; i += 1) {
    const v = y[i]!;
    if (Number.isNaN(v)) continue;
    expect(Number.isFinite(v), `${label} slot ${String(i)} is ${String(v)}`).toBe(true);
    expect(v, `${label} slot ${String(i)}`).toBeGreaterThanOrEqual(lo);
    expect(v, `${label} slot ${String(i)}`).toBeLessThanOrEqual(hi);
    checked += 1;
  }
  // The bound cannot be satisfied by an empty series: a study that returned nothing fails here.
  expect(checked, `${label} had no finite values`).toBeGreaterThan(1000);
}

describe('the bounded studies stay inside their bounds across all 1255 bars', () => {
  it('RSI is in 0..100', () => {
    expectBounded('RSI', columns(study('RSI').compute(input, { n: 14 })).get('RSI.rsi')!, 0, 100);
  });

  it('the stochastic %K and %D are in 0..100', () => {
    const cols = columns(study('STOCH').compute(input, { k: 14, d: 3, smooth: 3 }));
    expectBounded('STOCH.k', cols.get('STOCH.k')!, 0, 100);
    expectBounded('STOCH.d', cols.get('STOCH.d')!, 0, 100);
  });

  it('Williams %R is in −100..0', () => {
    expectBounded(
      'WILLR',
      columns(study('WILLR').compute(input, { n: 14 })).get('WILLR.willr')!,
      -100,
      0,
    );
  });

  it('ADX and ±DI are at or above zero, and the DI pair cannot exceed 100', () => {
    const cols = columns(study('ADX').compute(input, { n: 14 }));
    expectBounded('ADX', cols.get('ADX.adx')!, 0, 100);
    expectBounded('ADX.plusDI', cols.get('ADX.plusDI')!, 0, 100);
    expectBounded('ADX.minusDI', cols.get('ADX.minusDI')!, 0, 100);
    const plus = cols.get('ADX.plusDI')!;
    const minus = cols.get('ADX.minusDI')!;
    for (let i = 14; i < bars.length; i += 1) {
      expect(plus[i]! + minus[i]!).toBeLessThanOrEqual(100.000000001);
    }
  });

  it('ATR, STDDEV, HVOL and the volume histogram are non-negative', () => {
    // A dispersion or a range that came out negative is a subtraction the wrong way round; none of
    // the four has an upper bound worth asserting, so the ceiling here is only a sanity rail.
    expectBounded('ATR', columns(study('ATR').compute(input, { n: 14 })).get('ATR.atr')!, 0, 1e6);
    expectBounded(
      'STDDEV',
      columns(study('STDDEV').compute(input, { n: 20 })).get('STDDEV.stdev')!,
      0,
      1e6,
    );
    expectBounded(
      'HVOL',
      columns(study('HVOL').compute(input, { n: 30 })).get('HVOL.hvol')!,
      0,
      1e4,
    );
    expectBounded(
      'VOL.volume',
      columns(study('VOL').compute(input, { n: 20 })).get('VOL.volume')!,
      0,
      1e12,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The series that does not move, and the series with a hole in it
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Two inputs the 1255-bar capture cannot supply, and both of them are ordinary market data.
 *
 * **A flat series.** Every assertion above is either a golden over AAPL's five years or a bound, and
 * a bound is satisfied by a wrong answer at the top of the range as happily as by a right one in the
 * middle: `RSI` returned exactly 100 — maximum overbought — for two hundred unchanged closes, and
 * `RSI is in 0..100` passed on it. A flat stretch is not a curiosity. GP charts `unit:'rate'` and
 * `unit:'yield'` series through this same engine (`GP.govt.json` is one) and
 * `fixtures/providers/normalised/nyfed-effr.json` is ten captured EFFR fixings all equal to 3.63 —
 * a target rate does not move between FOMC meetings, which is thirty to forty trading days at a time.
 *
 * **A series with gaps.** §11.2 aligns two calendars by the union of their timestamps, so a series
 * that did not trade on a slot is `NaN` there and a second security added to a chart begins with a
 * run of them. `wilderAverage` used to return its whole column of gaps when any value in the seed
 * window was `NaN`, so one absent bar emptied the ATR and ADX panes for every slot afterwards.
 *
 * Neither case is in any golden, because a golden is a digest of the daily capture and the capture is
 * 1255 complete bars that move every day. They are constructed here instead, and the expected numbers
 * are closed forms — 50, zero, and the plain mean of fourteen true ranges — not recorded output.
 */
describe('a series that never moves, and a series with a hole in it', () => {
  const FLAT_BARS = 200;

  /** `FLAT_BARS` bars at exactly 100.00: open = high = low = close, every day. */
  const flat: StudyInput = {
    x: Float64Array.from({ length: FLAT_BARS }, (_, i) => Date.UTC(2026, 0, 1) + i * 86_400_000),
    open: new Float64Array(FLAT_BARS).fill(100),
    high: new Float64Array(FLAT_BARS).fill(100),
    low: new Float64Array(FLAT_BARS).fill(100),
    close: new Float64Array(FLAT_BARS).fill(100),
    volume: new Float64Array(FLAT_BARS).fill(1_000_000),
  };

  /** Every finite slot of `y`, as `[index, value]` — the shape the counts below are asserted on. */
  function finite(y: Float64Array): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < y.length; i += 1) if (Number.isFinite(y[i]!)) out.push([i, y[i]!]);
    return out;
  }

  it('RSI reads 50 on a flat series, not 100', () => {
    const y = columns(study('RSI').compute(flat, { n: 14 })).get('RSI.rsi')!;
    const defined = finite(y);
    // Wilder's seed puts the first value at slot `n`, so 200 − 14 of them.
    expect(defined.length).toBe(FLAT_BARS - 14);
    expect(defined[0]![0]).toBe(14);
    // `avgGain === avgLoss === 0`: `RS = 0/0` has no value, and the only path that reaches it has the
    // two averages equal, where `RS = 1` and RSI is 50 — the midline the 30/70 levels are read
    // against. Testing the divisor first answered 100 at every one of these slots.
    for (const [i, v] of defined) expect(v, `RSI slot ${String(i)}`).toBe(50);
  });

  it('RSI still pins to 100 and 0 when the moves really are one-sided', () => {
    // The 50 above must not have been bought by collapsing the unbounded cases into the midpoint, so
    // both of them are asserted on series that have no losses and no gains at all.
    const rising = Float64Array.from({ length: 40 }, (_, i) => 100 + i);
    const falling = Float64Array.from({ length: 40 }, (_, i) => 200 - i);
    const up = columns(study('RSI').compute({ x: flat.x, close: rising }, { n: 14 })).get(
      'RSI.rsi',
    )!;
    const down = columns(study('RSI').compute({ x: flat.x, close: falling }, { n: 14 })).get(
      'RSI.rsi',
    )!;
    expect(up[14]!).toBe(100);
    expect(up[39]!).toBe(100);
    expect(down[14]!).toBe(0);
    expect(down[39]!).toBe(0);
  });

  it('ADX draws zero on a flat series instead of drawing nothing', () => {
    const cols = columns(study('ADX').compute(flat, { n: 14 }));
    const plus = finite(cols.get('ADX.plusDI')!);
    const minus = finite(cols.get('ADX.minusDI')!);
    const adx = finite(cols.get('ADX.adx')!);
    // ±DI from slot `n`, ADX from `2n − 1` — the warm-up §11.6 describes, and the whole series after
    // it. Before the zero-true-range branch these three counts were 0, 0 and 0: `dx` was left `NaN`
    // wherever smoothed true range was 0, and the second Wilder average refused any series whose seed
    // window contained one, so a flat opening fortnight blanked the pane for all 200 bars.
    expect(plus.length).toBe(FLAT_BARS - 14);
    expect(minus.length).toBe(FLAT_BARS - 14);
    expect(adx.length).toBe(FLAT_BARS - 27);
    expect(adx[0]![0]).toBe(27);
    // Zero is forced, not chosen: true range is non-negative, so a zero average of it means every bar
    // had `high === low === prevClose`, which makes both directional movements exactly zero.
    for (const [i, v] of plus) expect(v, `+DI slot ${String(i)}`).toBe(0);
    for (const [i, v] of minus) expect(v, `−DI slot ${String(i)}`).toBe(0);
    for (const [i, v] of adx) expect(v, `ADX slot ${String(i)}`).toBe(0);
  });

  it('ATR resumes after a gap rather than giving up on the series', () => {
    // A rising series missing its first five bars and its 41st — one security's calendar against
    // another's, and one halted day.
    const length = 60;
    const absent = (i: number): boolean => i < 5 || i === 40;
    const mid = (i: number): number => 100 + i * 0.5;
    const gapped: StudyInput = {
      x: Float64Array.from({ length }, (_, i) => Date.UTC(2026, 0, 1) + i * 86_400_000),
      high: Float64Array.from({ length }, (_, i) => (absent(i) ? Number.NaN : mid(i) + 1)),
      low: Float64Array.from({ length }, (_, i) => (absent(i) ? Number.NaN : mid(i) - 1)),
      close: Float64Array.from({ length }, (_, i) => (absent(i) ? Number.NaN : mid(i))),
    };
    const tr = trueRange(gapped.high!, gapped.low!, gapped.close);
    // True range spans the previous close, so an absent bar takes the next one with it: gaps at
    // 0..5 and at 40..41, and every other slot finite.
    expect(finite(tr).map(([i]) => i)[0]).toBe(6);
    expect(Number.isNaN(tr[41]!)).toBe(true);
    expect(Number.isNaN(tr[42]!)).toBe(false);

    const y = columns(study('ATR').compute(gapped, { n: 14 })).get('ATR.atr')!;
    const defined = finite(y);
    // Two runs, each warmed up on its own 14 clean true ranges: 19..39 and 55..59. This whole column
    // was empty before — the five missing bars at the head returned the entire series as gaps.
    expect(defined.map(([i]) => i)).toEqual([
      ...Array.from({ length: 21 }, (_, k) => 19 + k),
      55, 56, 57, 58, 59,
    ]);
    // The first value of each run is the plain mean of the fourteen true ranges that seeded it —
    // every bar here spans `mid ± 1` and gaps up 0.5, so every true range is exactly 2.0.
    let seed = 0;
    for (let j = 6; j <= 19; j += 1) seed += tr[j]!;
    expect(y[19]!).toBeCloseTo(seed / 14, 12);
    expect(y[19]!).toBeCloseTo(2, 12);
    // The recurrence is not carried across the hole: slot 55 is a fresh seed of `tr[42..55]`, not the
    // slot-39 average continued. Those two differ whenever the true ranges do, and asserting the seed
    // is what pins which of the two this is.
    let second = 0;
    for (let j = 42; j <= 55; j += 1) second += tr[j]!;
    expect(y[55]!).toBeCloseTo(second / 14, 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// API-05: the maths core owns is core's
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('API-05: STDDEV and HVOL compute through core/analytics/stats', () => {
  const SOURCE = readFileSync(join(WEB_ROOT, 'src', 'chart', 'studies', 'oscillators.ts'), 'utf8');

  /**
   * A source-text assertion, deliberately. Asserting that `HVOL` equals
   * `volatility(logReturns(w)).volAnnualised × 100` by calling those same functions in the test would
   * pass just as well against a hand-rolled copy of them, which is the thing API-05 forbids: the
   * chart and the API must not be able to disagree about one security's annualised volatility. What
   * has to be true is that the import exists and the arithmetic is not duplicated here, and that is a
   * property of the file, so the file is what is read.
   */
  it('imports stdevOf, logReturns and volatility from core', () => {
    expect(SOURCE).toMatch(
      /import \{ logReturns, stdevOf, volatility \} from '@terminal\/core\/analytics\/stats\/index'/,
    );
    expect(SOURCE).toMatch(/stdevOf\(window, 0\)/);
    expect(SOURCE).toMatch(/logReturns\(window\)/);
    expect(SOURCE).toMatch(/volatility\(returns\.values\)\.volAnnualised/);
  });

  it('takes no square root of its own', () => {
    // There is no `Math.sqrt` in `oscillators.ts`, and there must not be: the only two studies here
    // that need one are STDDEV and HVOL, and both get it from core. A square root appearing in this
    // file would be a dispersion or an annualisation growing beside core's — the disagreement about
    // one security's volatility that API-05 exists to prevent.
    expect(SOURCE).not.toMatch(/Math\.sqrt\(/);
  });

  it('HVOL is annualised in percent points, as its yFmt says', () => {
    const def = study('HVOL');
    expect(def.yFmt).toBe('pct');
    const y = columns(def.compute(input, { n: 30 })).get('HVOL.hvol')!;
    // AAPL's 30-day annualised vol over this capture sits in the tens of percent. A decimal fraction
    // would put every value under 1, which `yFmt: 'pct'` would render as "0.22 %".
    expect(y[30]!).toBeGreaterThan(5);
    expect(y[30]!).toBeLessThan(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Missing columns, and clamped parameters
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('inputs a study cannot compute over', () => {
  const closeOnly: StudyInput = { x: input.x, close: input.close };
  const noVolume: StudyInput = {
    x: input.x,
    close: input.close,
    high: input.high!,
    low: input.low!,
  };

  it.each(['STOCH', 'ATR', 'ADX', 'CCI', 'WILLR'])(
    '%s throws rather than drawing a blank pane when the input has no high/low',
    (id) => {
      const def = study(id);
      expect(def.needs).toContain('ohlc');
      expect(() => def.compute(closeOnly, defaults(def))).toThrow(/needs 'ohlc'/);
    },
  );

  it.each(['VOL', 'OBV'])('%s throws when the input has no volume', (id) => {
    const def = study(id);
    expect(def.needs).toContain('volume');
    expect(() => def.compute(noVolume, defaults(def))).toThrow(/needs 'volume'/);
  });

  it.each(['RSI', 'MACD', 'ROC', 'MOM', 'STDDEV', 'HVOL'])('%s computes on closes alone', (id) => {
    const def = study(id);
    expect(def.needs).toEqual(['close']);
    const out = def.compute(closeOnly, defaults(def));
    expect(out.lines.length).toBeGreaterThan(0);
    expect(out.lines[0]?.y.length).toBe(bars.length);
  });

  /**
   * A persisted parameter set from an older build can carry a window this formula is not defined for.
   * Clamping to the declared minimum draws the nearest study; not clamping draws a pane of `NaN` with
   * nothing on screen to say why.
   */
  it('a zero or NaN window falls back to the declared minimum, not to gaps', () => {
    const def = study('RSI');
    const window = def.params.find((p) => p.name === 'n');
    expect(window).toBeDefined();
    const min = window?.min ?? 0;
    expect(min).toBe(2);
    const clamped = columns(def.compute(input, { n: 0 })).get('RSI.rsi')!;
    const atMin = columns(def.compute(input, { n: min })).get('RSI.rsi')!;
    expect(Number.isFinite(clamped[min]!)).toBe(true);
    expect(clamped[400]!).toBe(atMin[400]!);

    const missing = columns(def.compute(input, {})).get('RSI.rsi')!;
    const atDefault = columns(def.compute(input, { n: 14 })).get('RSI.rsi')!;
    expect(missing[400]!).toBe(atDefault[400]!);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The direction channel VOL's histogram is coloured by
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('volumeDirection', () => {
  /**
   * §11.6 wants VOL's histogram direction-coloured and `StudyOutput.histogram` has no colour channel,
   * so the direction is exported as a function for the renderer to call (see the module header). It
   * must agree with the close direction the candle bodies use, at every slot, and it must actually
   * vary — an all-zero array would satisfy "agrees with itself".
   */
  it('is the close direction at every slot, and slot 0 has no predecessor', () => {
    const dir = volumeDirection(C);
    expect(dir.length).toBe(bars.length);
    expect(dir[0]!).toBe(0);
    let up = 0;
    let down = 0;
    for (let i = 1; i < bars.length; i += 1) {
      const prev = C[i - 1]!;
      const curr = C[i]!;
      const expected = curr > prev ? 1 : curr < prev ? -1 : 0;
      expect(dir[i]!).toBe(expected);
      if (expected === 1) up += 1;
      if (expected === -1) down += 1;
    }
    expect(up).toBeGreaterThan(400);
    expect(down).toBeGreaterThan(400);
    expect(up + down).toBeLessThanOrEqual(bars.length - 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §11.5 — the incremental last-slot update
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The studies that declare an `update`; the rest recompute the last window (§11.5). */
const INCREMENTAL = ['VOL', 'STOCH', 'CCI', 'WILLR', 'ROC', 'MOM', 'OBV', 'STDDEV', 'HVOL'];

/** A `StudyInput` holding the first `count` slots — the series as it was one bar ago. */
function truncated(count: number): StudyInput {
  return {
    x: input.x.slice(0, count),
    open: input.open!.slice(0, count),
    high: H.slice(0, count),
    low: L.slice(0, count),
    close: C.slice(0, count),
    volume: V.slice(0, count),
  };
}

describe('update() agrees with compute() at the last slot', () => {
  it('the studies with no honest recurrence declare no update', () => {
    // RSI, MACD, ATR and ADX carry recurrence state their output does not contain, so §11.5's
    // fallback — recompute the last window — is the only correct incremental form. An `update` that
    // appeared on one of them would be one that guessed.
    // `update` is read as `'update' in def` rather than compared as a value: the typed-lint rule
    // against unbound methods is right that pulling a method off its object is a mistake waiting to
    // happen, and what this test wants to know is whether the study declares one at all.
    for (const id of ['RSI', 'MACD', 'ATR', 'ADX']) {
      expect(Object.hasOwn(study(id), 'update'), `${id}.update`).toBe(false);
    }
    for (const id of INCREMENTAL) {
      expect(Object.hasOwn(study(id), 'update'), `${id}.update`).toBe(true);
    }
    expect([...INCREMENTAL, 'RSI', 'MACD', 'ATR', 'ADX'].sort()).toEqual([...IDS].sort());
  });

  it.each(INCREMENTAL)('%s: a forming bar overwriting the last slot', (id) => {
    const def = study(id);
    const params = defaults(def);
    const last = bars.length - 1;
    const expected = def.compute(input, params);

    // The state the renderer holds a tick earlier: the same output with the last slot stale. Writing
    // a wrong number there is what makes this test able to fail — `update` has to overwrite it.
    const stale = def.compute(input, params);
    for (const y of columns(stale).values()) y[last] = -12345.678;

    const patched = def.update!(stale, input, params, last);
    const after = columns(patched);
    for (const [key, want] of columns(expected)) {
      const got = after.get(key)!;
      expect(got.length).toBe(bars.length);
      expect(got[last]!, `${id}.${key} at the forming slot`).toBeCloseTo(want[last]!, 9);
    }
  });

  it.each(INCREMENTAL)('%s: a finalised bar appending a new slot', (id) => {
    const def = study(id);
    const params = defaults(def);
    const last = bars.length - 1;
    const expected = def.compute(input, params);

    // Yesterday's output: computed over 1254 slots, so every array is one short of the input the
    // stream now carries. `update` has to grow them (§11.5 capacity growth) and fill the new slot.
    const before = def.compute(truncated(last), params);
    for (const y of columns(before).values()) expect(y.length).toBe(last);

    const patched = def.update!(before, input, params, last);
    const after = columns(patched);
    for (const [key, want] of columns(expected)) {
      const got = after.get(key)!;
      expect(got.length, `${id}.${key} grew`).toBe(bars.length);
      expect(got[last]!, `${id}.${key} at the appended slot`).toBeCloseTo(want[last]!, 9);
      // The slots before the new one are untouched, which is the whole point of an in-place update.
      expect(got[last - 1]!).toBe(want[last - 1]!);
    }
  });
});
