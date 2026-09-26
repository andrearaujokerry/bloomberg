// packages/web/src/chart/studies/trend.ts — the nine main-pane studies (CLIENT.md §11.6, CHRT-04).
//
// `SMA EMA WMA BB DONCHIAN KELTNER PSAR ICHIMOKU VWAP`: the nine rows of §11.6's registry table
// whose `Pane` column says `main`. They are one file because they are one family — every one of them
// is drawn on the price pane's own y-axis, in the instrument's own currency, over the same input
// columns, and none of them adds a pane. The thirteen `sub` studies (their own axis, their own
// scale, their own `levels`) are another file's; `studies/index.ts` — also another file's — joins the
// two into the `Record<StudyId, StudyDef>` the study picker (`S`) types over.
//
// ## Two conventions this file is built on, both from `studies/types.ts`
//
// **A study's output is as long as its input, with `NaN` before it has an answer.** A 20-period
// average has no value at index 0..18 and says so with `NaN`, not with a zero and not with a shorter
// array offset by 19. This is not a formatting preference: an off-by-one in the leading gap shifts
// every value one bar towards the present, which on a chart is lookahead — a line that knew today's
// close yesterday — and it is invisible to the eye at any zoom level. `studies.test.ts` asserts the
// first finite index of every line of all nine studies for exactly that reason.
//
// **Maths that is not display-only comes from `core/analytics/stats` (API-05).** `BB` calls
// `stdevOf`, because the standard deviation under the chart and the standard deviation in a `GP` or
// `PORT` payload have to be the same number computed the same way; a second implementation here
// would be a second answer. The per-study note below each definition says which core function the
// study leans on, or that it needs none — the arithmetic of a moving average is display-only and
// core has no moving-average family to defer to.
//
// ## Where this file deliberately departs from a doc
//
//  - **§11.6 says study goldens are computed from `yahoo-chart-AAPL-max-1d.json`.** That capture is
//    QUARTERLY (TESTING.md L748), so a "daily" `SMA(20)` over it would be a five-year average
//    labelled as a one-month one. The goldens in `fixtures/golden/analytics/studies/` are computed
//    from `yahoo-chart-events.json` (1,255 daily bars) instead, and `VWAP` — intraday only — from
//    `yahoo-chart-AAPL-1d-1m.json` (316 one-minute bars). The deviation is recorded in each golden
//    file's `note` and in `studies.test.ts`.
//  - **`PSAR` is "a scatter line" in §11.6 and this returns a line.** `StudyLine` carries no mark
//    field, so there is no way for a study to ask for dots; a parabolic SAR drawn as a connected
//    polyline is wrong (its value jumps across the price on every reversal), so this marks it
//    `dashed` as the nearest signal the type can express. Giving `StudyLine.style` a `mark` is a
//    `studies/types.ts` change, which is not this file's to make.
//  - **`ICHIMOKU`'s cloud has no future half.** Both senkou spans are plotted `kijun` slots into the
//    future, and there are no slots past the last one: `TradingDayIndex` is the union of the series'
//    own timestamps (§11.2), so a slot no bar occupies does not exist. The spans still reach the last
//    slot — drawn from the bars 26 back — but the values derived from the last 26 bars, which would
//    be plotted beyond it, are dropped rather than projected onto invented slots.

import { stdevOf } from '@terminal/core/analytics/stats/index';

import { trueRange, wilderAverage } from './oscillators.js';
import type { StudyDef, StudyId, StudyInput, StudyLine, StudyOutput } from './types.js';

/* -------------------------------------------------------------------------------------------- */
/* Shared plumbing                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** The nine ids of this file, as a subset of the twenty-two — so a typo is a compile error. */
export type TrendStudyId = Extract<
  StudyId,
  'SMA' | 'EMA' | 'WMA' | 'BB' | 'DONCHIAN' | 'KELTNER' | 'PSAR' | 'ICHIMOKU' | 'VWAP'
>;

/**
 * A study line's array, every slot `NaN` until something fills it.
 *
 * `Float64Array` zero-fills, and a zero in a study output draws a line at the bottom of the price
 * pane for the study's warm-up window. Filling with `NaN` first means a slot a study never reaches
 * is a gap by default rather than by remembering to write one.
 */
function gapped(len: number): Float64Array {
  const y = new Float64Array(len);
  y.fill(Number.NaN);
  return y;
}

/**
 * Read an integer parameter, clamped to the bounds the `StudyDef` publishes.
 *
 * The bounds are not a suggestion to the picker: a params blob reaches a study from three places
 * that are not the picker — a persisted `layout.chart.studies` default written by an older build, a
 * frame's `params` in a shared workspace, and a screen manifest's own study list — and any of them
 * can carry an `n` this version of the study cannot honour. `n = 0` is a division by zero, `n = -5`
 * is a loop that never runs, and `n = 10_000_000` on a 1,255-bar series is a study that computes
 * nothing for a second. Clamping here means the bound stated in `params` is the bound enforced,
 * rather than the bound hoped for.
 */
function intParam(params: Record<string, number>, name: string, def: Def): number {
  const raw = params[name];
  const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : def.default;
  return Math.min(def.max, Math.max(def.min, v));
}

/** As {@link intParam}, for the parameters that are genuinely fractional (`k`, `af`, `max`). */
function numParam(params: Record<string, number>, name: string, def: Def): number {
  const raw = params[name];
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : def.default;
  return Math.min(def.max, Math.max(def.min, v));
}

/** One row of `StudyDef.params` — named so the bounds can be declared once and read once. */
type Def = StudyDef['params'][number];

function def(name: string, label: string, d: number, min: number, max: number, step: number): Def {
  return { name, label, default: d, min, max, step };
}

/**
 * The window lengths studies share, declared beside their bounds.
 *
 * Every default here is §11.6's, and `studies.test.ts` parses that table out of CLIENT.md and
 * compares — a transcription of somebody else's number is worth exactly as much as the check that
 * it still matches. The upper bounds are this file's own: 400 bars is longer than any conventional
 * average and short enough that a clamped nonsense value still computes in microseconds.
 */
const P = {
  n20: def('n', 'Periods', 20, 2, 400, 1),
  bbK: def('k', 'Std devs', 2, 0.1, 5, 0.1),
  keltnerAtr: def('atr', 'ATR periods', 10, 2, 200, 1),
  keltnerK: def('k', 'ATR multiple', 2, 0.1, 5, 0.1),
  psarAf: def('af', 'Acceleration', 0.02, 0.001, 0.2, 0.001),
  psarMax: def('max', 'Max acceleration', 0.2, 0.01, 1, 0.01),
  tenkan: def('tenkan', 'Tenkan', 9, 1, 100, 1),
  kijun: def('kijun', 'Kijun', 26, 2, 200, 1),
  senkou: def('senkou', 'Senkou B', 52, 2, 400, 1),
  vwapAnchor: def('anchor', 'Anchor', 0, 0, 1, 1),
} as const;

/**
 * The columns a study was promised by its `needs`, checked rather than assumed.
 *
 * `StudyDef.needs` is a declaration and the caller is supposed to honour it, but "supposed to" is
 * how `input.high!` becomes a `TypeError` in a `frame()` callback on the one instrument whose
 * payload carried no volume. A named throw at the call is a bug report; `NaN` pixels are not.
 */
function require3(
  id: string,
  input: StudyInput,
): {
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
} {
  const { high, low, close } = input;
  if (high === undefined || low === undefined) {
    throw new Error(`${id}: needs ohlc — this series carried no high/low column`);
  }
  return { high, low, close };
}

function requireVolume(id: string, input: StudyInput): Float64Array {
  const { volume } = input;
  if (volume === undefined) {
    throw new Error(`${id}: needs volume — this series carried no volume column`);
  }
  return volume;
}

/**
 * Widen `y` to `len`, preserving what is already in it and gapping the rest.
 *
 * This is the allocation `update()` exists to avoid, and it happens on one tick in sixty: a forming
 * bar that overwrites the last slot needs no new room, and only the first tick of a new minute grows
 * the arrays. Growth is exact rather than doubling because a study's output length is the input's
 * length, and the input is the series' typed arrays, which the renderer has already doubled (§11.5)
 * — doubling again here would put the study's arrays permanently out of step with the series'.
 */
function widen(y: Float64Array, len: number): Float64Array {
  if (y.length >= len) return y;
  const next = gapped(len);
  next.set(y);
  return next;
}

/**
 * The line of `prev` with this id, or `null` when `prev` is not a previous output of this study.
 *
 * `update()` is handed whatever the caller kept, and a caller that switched studies, changed a
 * parameter or is on its first tick has nothing useful to hand over. Every `update()` below checks
 * and falls back to a full `compute()`, which is correct at any cost and is the cost of a few
 * hundred microseconds once.
 */
function lineOf(prev: StudyOutput, id: string): StudyLine | null {
  return prev.lines.find((l) => l.id === id) ?? null;
}

/**
 * Sum of `src[from..to]` inclusive, computed fresh.
 *
 * Fresh rather than rolling, in both `compute()` and `update()`. A rolling sum is O(1) per slot and
 * this is O(n), but a rolling sum over 1,255 bars accumulates its own subtraction error, so the
 * value at slot 1,000 would depend on the 981 slots that had been added and removed before it and a
 * golden would not reproduce from a different starting slot. O(n × window) on 1,255 bars is
 * ~25,000 additions for a 20-period average: below the noise of one frame (§16.1), and the numbers
 * are the same whether the study computed the whole series or one slot of it — which is what makes
 * the `update()` tests in `studies.test.ts` able to compare the two at all.
 */
function windowSum(src: Float64Array, from: number, to: number): number {
  let total = 0;
  for (let i = from; i <= to; i += 1) total += src[i] ?? Number.NaN;
  return total;
}

/** Highest of `src[from..to]` inclusive; `NaN` if any slot in the window is a gap. */
function windowMax(src: Float64Array, from: number, to: number): number {
  let best = -Infinity;
  for (let i = from; i <= to; i += 1) {
    const v = src[i] ?? Number.NaN;
    if (Number.isNaN(v)) return Number.NaN;
    if (v > best) best = v;
  }
  return best;
}

/** Lowest of `src[from..to]` inclusive; `NaN` if any slot in the window is a gap. */
function windowMin(src: Float64Array, from: number, to: number): number {
  let best = Infinity;
  for (let i = from; i <= to; i += 1) {
    const v = src[i] ?? Number.NaN;
    if (Number.isNaN(v)) return Number.NaN;
    if (v < best) best = v;
  }
  return best;
}

/** A plain-array copy of `src[from..to]`, for the core functions, which take `readonly number[]`. */
function windowArray(src: Float64Array, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(src[i] ?? Number.NaN);
  return out;
}

/** Simple moving average of `src` at `i` over `n` slots ending at `i`; `NaN` before slot `n-1`. */
function smaAt(src: Float64Array, i: number, n: number): number {
  if (i < n - 1) return Number.NaN;
  return windowSum(src, i - n + 1, i) / n;
}

/**
 * Exponential moving average of `src` over `n`, seeded with the simple average of the first `n`.
 *
 * The seed is a choice and it is the conventional one: the first value lands at slot `n-1`, the same
 * slot `SMA(n)` starts at, so the two lines are comparable at the point they both begin and the
 * study's warm-up gap is the one the user was told about by the parameter. Seeding at slot 0 with
 * `src[0]` — the other common choice — would make the first fifty values of an `EMA(20)` a function
 * of one close, drawn as if they meant something.
 */
function emaSeries(src: Float64Array, n: number): Float64Array {
  const y = gapped(src.length);
  if (src.length < n) return y;
  const k = 2 / (n + 1);

  // A gap ends a run; it does not end the series — the same rule `wilderAverage` states in
  // `oscillators.ts`, and for the same reason. `ChartSeries.y` documents `NaN` as a GAP, so a
  // series that did not trade on a slot is a legal input, not a broken one. The recurrence used to
  // run straight through it: `NaN * k + prev * (1 - k)` is `NaN`, and every later slot inherited it,
  // so ONE absent bar removed the average for the rest of the chart. That was invisible, because a
  // line that stops looks exactly like a line that has not warmed up — and it was worse than
  // invisible on a Keltner channel, whose mid is this function and whose band therefore vanished
  // while the `ATR` pane beside it carried on.
  //
  // So each maximal run of finite values is seeded and followed on its own. The recurrence is
  // deliberately NOT carried across the gap: an EMA claims to be an average weighted over the
  // observations it has seen, and continuing it over a slot where there was no observation would
  // put a number on the pane that no data supports.
  let start = 0;
  while (start + n <= src.length) {
    // A `NaN` at `start + filled` cannot be inside any window beginning at or before it, so the next
    // candidate starts one slot PAST the gap rather than one slot past `start`. That is what keeps
    // this linear over a series of alternating gaps rather than quadratic.
    let seed = 0;
    let filled = 0;
    while (filled < n && Number.isFinite(src[start + filled] ?? Number.NaN)) {
      seed += src[start + filled] ?? Number.NaN;
      filled += 1;
    }
    if (filled < n) {
      start += filled + 1;
      continue;
    }
    // The seed is the mean of the first `n` of the run, which is what the single-run form did.
    let prev = seed / n;
    y[start + n - 1] = prev;
    let i = start + n;
    for (; i < src.length; i += 1) {
      const v = src[i] ?? Number.NaN;
      if (!Number.isFinite(v)) break;
      prev = v * k + prev * (1 - k);
      y[i] = prev;
    }
    start = i + 1;
  }
  return y;
}

/**
 * Carry `prev`'s band, histogram and level metadata onto a fresh line set.
 *
 * Spread conditionally, not `{ bands: prev.bands }`: with `exactOptionalPropertyTypes` an absent
 * `bands` and a `bands: undefined` are different types, and only the first means "this study draws
 * no band" (`studies/types.ts`).
 */
function withMeta(lines: StudyOutput['lines'], prev: StudyOutput): StudyOutput {
  return {
    lines,
    ...(prev.bands === undefined ? {} : { bands: prev.bands }),
    ...(prev.histogram === undefined ? {} : { histogram: prev.histogram }),
    ...(prev.levels === undefined ? {} : { levels: prev.levels }),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The moving averages: SMA, EMA, WMA                                                             */
/* -------------------------------------------------------------------------------------------- */

/**
 * `SMA` — simple moving average, `n = 20` (§11.6). Core function: none.
 *
 * A mean of `n` closes is display-only arithmetic. `core/analytics/stats#meanOf` is the mean of a
 * whole series and carries the stats conventions with it (ANAL-07); a rolling window of a chart
 * series is not a statistic anybody quotes, and importing `meanOf` here would mean 1,255 array
 * copies to reach a one-line sum. `stdevOf` in `BB` is a different matter and is imported: a
 * standard deviation *is* quoted, and its `ddof` is exactly the kind of convention two
 * implementations disagree about.
 *
 * `update` recomputes the one slot's window — 20 additions — which is what §11.5's "incremental
 * last-slot update" means for a study with no recurrence to carry forward.
 */
const SMA: StudyDef = {
  id: 'SMA',
  name: 'Simple moving average',
  pane: 'main',
  params: [P.n20],
  needs: ['close'],
  yFmt: 'px',
  compute(input, params) {
    const n = intParam(params, 'n', P.n20);
    const y = gapped(input.close.length);
    for (let i = n - 1; i < input.close.length; i += 1) y[i] = smaAt(input.close, i, n);
    return { lines: [{ id: 'sma', label: `SMA(${String(n)})`, y, style: { color: 'auto' } }] };
  },
  update(prev, input, params, lastIndex) {
    const n = intParam(params, 'n', P.n20);
    const existing = lineOf(prev, 'sma');
    if (existing === null) return this.compute(input, params);
    const y = widen(existing.y, input.close.length);
    y[lastIndex] = smaAt(input.close, lastIndex, n);
    return withMeta([{ ...existing, y }], prev);
  },
};

/**
 * `EMA` — exponential moving average, `n = 20` (§11.6). Core function: none (see `SMA`).
 *
 * `update` is the one genuinely O(1) incremental form in this file: `y[i] = c[i]·k + y[i−1]·(1−k)`
 * needs only the previous output value, which is in `prev`. It falls back to a full `compute` when
 * `y[lastIndex−1]` is not finite, because at the left edge of a stream the recurrence has no seed
 * yet and there is nothing to be incremental about.
 */
const EMA: StudyDef = {
  id: 'EMA',
  name: 'Exponential moving average',
  pane: 'main',
  params: [P.n20],
  needs: ['close'],
  yFmt: 'px',
  compute(input, params) {
    const n = intParam(params, 'n', P.n20);
    return {
      lines: [
        {
          id: 'ema',
          label: `EMA(${String(n)})`,
          y: emaSeries(input.close, n),
          style: { color: 'auto' },
        },
      ],
    };
  },
  update(prev, input, params, lastIndex) {
    const n = intParam(params, 'n', P.n20);
    const existing = lineOf(prev, 'ema');
    if (existing === null) return this.compute(input, params);
    const y = widen(existing.y, input.close.length);
    const anchor = lastIndex > 0 ? (y[lastIndex - 1] ?? Number.NaN) : Number.NaN;
    if (!Number.isFinite(anchor)) return this.compute(input, params);
    const k = 2 / (n + 1);
    y[lastIndex] = (input.close[lastIndex] ?? Number.NaN) * k + anchor * (1 - k);
    return withMeta([{ ...existing, y }], prev);
  },
};

/**
 * `WMA` — linearly weighted moving average, `n = 20` (§11.6). Core function: none (see `SMA`).
 *
 * Weights 1…n oldest to newest over `n(n+1)/2`, which for `n = 20` is 210 — the convention every
 * terminal means by "weighted moving average", as against the volume weighting `VWAP` does or the
 * exponential weighting `EMA` does. `update` recomputes the one slot, as `SMA`'s does.
 */
const WMA: StudyDef = {
  id: 'WMA',
  name: 'Weighted moving average',
  pane: 'main',
  params: [P.n20],
  needs: ['close'],
  yFmt: 'px',
  compute(input, params) {
    const n = intParam(params, 'n', P.n20);
    const y = gapped(input.close.length);
    for (let i = n - 1; i < input.close.length; i += 1) y[i] = wmaAt(input.close, i, n);
    return { lines: [{ id: 'wma', label: `WMA(${String(n)})`, y, style: { color: 'auto' } }] };
  },
  update(prev, input, params, lastIndex) {
    const n = intParam(params, 'n', P.n20);
    const existing = lineOf(prev, 'wma');
    if (existing === null) return this.compute(input, params);
    const y = widen(existing.y, input.close.length);
    y[lastIndex] = wmaAt(input.close, lastIndex, n);
    return withMeta([{ ...existing, y }], prev);
  },
};

/** `WMA` at one slot: Σ(weight × close) / Σweight, weights 1…n oldest to newest. */
function wmaAt(src: Float64Array, i: number, n: number): number {
  if (i < n - 1) return Number.NaN;
  let num = 0;
  for (let w = 1; w <= n; w += 1) num += (src[i - n + w] ?? Number.NaN) * w;
  return num / ((n * (n + 1)) / 2);
}

/* -------------------------------------------------------------------------------------------- */
/* The channels: BB, DONCHIAN, KELTNER                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * `BB` — Bollinger bands, `n = 20, k = 2` (§11.6). Core function: **`stdevOf`** (`ddof: 0`).
 *
 * The standard deviation is `core/analytics/stats#stdevOf` and not a local sum of squares, which is
 * API-05: the σ a trader reads off the band and the σ in a `PORT` or `HP` payload are the same
 * quantity, and if this file computed its own they could differ by the one thing nobody notices —
 * the degrees of freedom. `stdevOf` takes `ddof` explicitly for exactly that reason, and this passes
 * **0**: Bollinger's bands are the population standard deviation of the `n` closes in the window,
 * which is how Bollinger defined them and how every terminal draws them. (`ddof: 1` would widen an
 * `n = 20` band by a factor of √(20/19) ≈ 1.026 — about 7 cents on a $150 stock, wrong in a way that
 * looks entirely plausible.) The cost is one 20-element copy per slot, which `windowArray` makes,
 * and that copy is the price of one source of truth for the number.
 */
const BB: StudyDef = {
  id: 'BB',
  name: 'Bollinger bands',
  pane: 'main',
  params: [P.n20, P.bbK],
  needs: ['close'],
  yFmt: 'px',
  compute(input, params) {
    const n = intParam(params, 'n', P.n20);
    const k = numParam(params, 'k', P.bbK);
    const len = input.close.length;
    const mid = gapped(len);
    const upper = gapped(len);
    const lower = gapped(len);
    for (let i = n - 1; i < len; i += 1) bbAt(input.close, i, n, k, mid, upper, lower);
    return bbOutput(n, k, mid, upper, lower);
  },
  update(prev, input, params, lastIndex) {
    const n = intParam(params, 'n', P.n20);
    const k = numParam(params, 'k', P.bbK);
    const len = input.close.length;
    const mid = lineOf(prev, 'mid');
    const upper = lineOf(prev, 'upper');
    const lower = lineOf(prev, 'lower');
    if (mid === null || upper === null || lower === null) return this.compute(input, params);
    const m = widen(mid.y, len);
    const u = widen(upper.y, len);
    const l = widen(lower.y, len);
    bbAt(input.close, lastIndex, n, k, m, u, l);
    return bbOutput(n, k, m, u, l);
  },
};

/** One slot of Bollinger, written into the three arrays in place. */
function bbAt(
  close: Float64Array,
  i: number,
  n: number,
  k: number,
  mid: Float64Array,
  upper: Float64Array,
  lower: Float64Array,
): void {
  if (i < n - 1) return;
  const window = windowArray(close, i - n + 1, i);
  const m = windowSum(close, i - n + 1, i) / n;
  // Population σ (`ddof: 0`) — see the note on `BB` for why the degrees of freedom are stated here
  // rather than defaulted, and why the function comes from core at all (API-05).
  const sd = stdevOf(window, 0);
  mid[i] = m;
  upper[i] = m + k * sd;
  lower[i] = m - k * sd;
}

/**
 * Bollinger's three lines and its band.
 *
 * `bands` rather than `fillTo`: the shaded area belongs to neither edge, has its own alpha, and is
 * what §11.6's "mid, upper, lower + band" names (`studies/types.ts`).
 */
function bbOutput(
  n: number,
  k: number,
  mid: Float64Array,
  upper: Float64Array,
  lower: Float64Array,
): StudyOutput {
  const label = `${String(n)}, ${String(k)}σ`;
  return {
    lines: [
      { id: 'mid', label: `BB mid (${label})`, y: mid, style: { color: 'auto' } },
      { id: 'upper', label: 'BB upper', y: upper, style: { color: 'neutral', width: 1 } },
      { id: 'lower', label: 'BB lower', y: lower, style: { color: 'neutral', width: 1 } },
    ],
    bands: [{ upper: 'upper', lower: 'lower', alpha: 0.1 }],
  };
}

/**
 * `DONCHIAN` — Donchian channel, `n = 20` (§11.6). Core function: none.
 *
 * Highest high and lowest low of the last `n` bars **including the current one**, which is the
 * convention a breakout is read against: price touching the upper band is price making an `n`-bar
 * high, now. The exclusive variant (the window ending at `i−1`) draws a channel price spends its
 * time outside of, and the difference is one bar of lookback, not of lookahead.
 *
 * A window extreme has no recurrence — the value leaving the window may be the one that set it — so
 * `update` recomputes the slot's `n` bars, and there is no O(1) form to offer.
 */
const DONCHIAN: StudyDef = {
  id: 'DONCHIAN',
  name: 'Donchian channel',
  pane: 'main',
  params: [P.n20],
  needs: ['ohlc'],
  yFmt: 'px',
  compute(input, params) {
    const n = intParam(params, 'n', P.n20);
    const { high, low } = require3('DONCHIAN', input);
    const len = input.close.length;
    const upper = gapped(len);
    const lower = gapped(len);
    const mid = gapped(len);
    for (let i = n - 1; i < len; i += 1) donchianAt(high, low, i, n, upper, lower, mid);
    return donchianOutput(n, upper, lower, mid);
  },
  update(prev, input, params, lastIndex) {
    const n = intParam(params, 'n', P.n20);
    const { high, low } = require3('DONCHIAN', input);
    const upper = lineOf(prev, 'upper');
    const lower = lineOf(prev, 'lower');
    const mid = lineOf(prev, 'mid');
    if (upper === null || lower === null || mid === null) return this.compute(input, params);
    const len = input.close.length;
    const u = widen(upper.y, len);
    const l = widen(lower.y, len);
    const m = widen(mid.y, len);
    donchianAt(high, low, lastIndex, n, u, l, m);
    return donchianOutput(n, u, l, m);
  },
};

/** One slot of Donchian, written into the three arrays in place. */
function donchianAt(
  high: Float64Array,
  low: Float64Array,
  i: number,
  n: number,
  upper: Float64Array,
  lower: Float64Array,
  mid: Float64Array,
): void {
  if (i < n - 1) return;
  const hi = windowMax(high, i - n + 1, i);
  const lo = windowMin(low, i - n + 1, i);
  upper[i] = hi;
  lower[i] = lo;
  mid[i] = (hi + lo) / 2;
}

function donchianOutput(
  n: number,
  upper: Float64Array,
  lower: Float64Array,
  mid: Float64Array,
): StudyOutput {
  return {
    lines: [
      { id: 'upper', label: `Donchian high (${String(n)})`, y: upper, style: { color: 'up' } },
      { id: 'lower', label: `Donchian low (${String(n)})`, y: lower, style: { color: 'down' } },
      { id: 'mid', label: 'Donchian mid', y: mid, style: { color: 'neutral', dashed: true } },
    ],
    bands: [{ upper: 'upper', lower: 'lower', alpha: 0.08 }],
  };
}

/**
 * `KELTNER` — Keltner channel, `n = 20, atr = 10, k = 2` (§11.6). Core function: none.
 *
 * `EMA(n)` of close for the middle, `± k × ATR(atr)` for the edges. Both halves are local: the EMA
 * is display-only (see `SMA`) and `core/analytics/stats` has no ATR, so the recurrence lives in
 * `oscillators.ts` — one copy, shared with the `ATR` sub-pane study, so the two agree on a gap.
 *
 * **No `update`.** The channel's width at the last slot is Wilder's ATR, whose recurrence carries
 * state — the previous ATR — that is nowhere in a `StudyOutput`. It could be reconstructed as
 * `(upper − mid) / k`, and that is precisely the kind of cleverness that turns a rounding error into
 * a channel that drifts wider every tick for the rest of the session. §11.5 already says what a
 * study without an incremental form gets: the caller recomputes the last window, honestly.
 */
const KELTNER: StudyDef = {
  id: 'KELTNER',
  name: 'Keltner channel',
  pane: 'main',
  params: [P.n20, P.keltnerAtr, P.keltnerK],
  needs: ['ohlc'],
  yFmt: 'px',
  compute(input, params) {
    const n = intParam(params, 'n', P.n20);
    const atrN = intParam(params, 'atr', P.keltnerAtr);
    const k = numParam(params, 'k', P.keltnerK);
    const { high, low, close } = require3('KELTNER', input);
    const len = close.length;
    const mid = emaSeries(close, n);
    // ONE Wilder ATR in the chart engine, not two (§11.6). `oscillators.ts` exports `trueRange`
    // and `wilderAverage` for this call — its own doc says so — and the copy that used to live here
    // differed in the case that matters: it carried the recurrence straight through a `NaN`, so one
    // absent bar blanked Keltner's band for the rest of the chart while the `ATR` pane beside it
    // re-seeded and carried on. Two studies on one screen disagreeing about the same volatility is
    // the thing sharing the kernel exists to prevent. `first = 1` because true range needs a
    // previous close, which puts the seed at slot `atrN` exactly where the local copy put it.
    const atr = wilderAverage(trueRange(high, low, close), atrN, 1);
    const upper = gapped(len);
    const lower = gapped(len);
    for (let i = 0; i < len; i += 1) {
      const m = mid[i] ?? Number.NaN;
      const a = atr[i] ?? Number.NaN;
      if (Number.isNaN(m) || Number.isNaN(a)) continue;
      upper[i] = m + k * a;
      lower[i] = m - k * a;
    }
    return {
      lines: [
        {
          id: 'mid',
          label: `Keltner mid (EMA ${String(n)})`,
          y: mid,
          style: { color: 'auto' },
        },
        {
          id: 'upper',
          label: `Keltner upper (${String(k)}× ATR ${String(atrN)})`,
          y: upper,
          style: { color: 'neutral', width: 1 },
        },
        { id: 'lower', label: 'Keltner lower', y: lower, style: { color: 'neutral', width: 1 } },
      ],
      bands: [{ upper: 'upper', lower: 'lower', alpha: 0.08 }],
    };
  },
};

/* -------------------------------------------------------------------------------------------- */
/* PSAR                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * `PSAR` — parabolic SAR, `af = 0.02, max = 0.2` (§11.6). Core function: none.
 *
 * Wilder's stop-and-reverse, in the form every reference implementation agrees on, stated here
 * because the variants differ in ways a golden cannot tell you about:
 *
 *  1. Slot 0 has no value. The first SAR needs two bars to know which way the trend is pointing, so
 *     the line begins at slot 1 — the leading gap is one bar, not `af`-many.
 *  2. The trend is initialised long when `close[1] ≥ close[0]`. The first SAR is then the lower of
 *     the first two lows (the higher of the two highs when short), and the extreme point is the
 *     higher of the two highs (the lower of the two lows when short).
 *  3. Each slot moves the stop `af × (ep − sar)` towards the extreme point, then clamps it to
 *     **the two prior bars'** extremes — a long stop may not sit above either of the last two lows.
 *     Without that clamp the stop can be inside the current bar's range and reverse on the bar that
 *     created it.
 *  4. A penetration reverses: the trend flips, the new stop is the extreme point of the trend that
 *     just ended, the new extreme point is this bar's own extreme, and the acceleration factor goes
 *     back to `af`. It does not step on the reversal bar.
 *  5. Otherwise a new extreme steps the acceleration factor by `af`, capped at `max`.
 *
 * **No `update`.** The whole of the above is state — trend direction, extreme point, current
 * acceleration factor — and none of it is in a `StudyOutput`. A last-slot update that guessed the
 * state would not merely be imprecise, it could put the stop on the wrong side of the price, which
 * is the one thing this study exists to say. §11.5's window recompute is the honest form.
 */
const PSAR: StudyDef = {
  id: 'PSAR',
  name: 'Parabolic SAR',
  pane: 'main',
  params: [P.psarAf, P.psarMax],
  needs: ['ohlc'],
  yFmt: 'px',
  compute(input, params) {
    const step = numParam(params, 'af', P.psarAf);
    const cap = numParam(params, 'max', P.psarMax);
    const { high, low, close } = require3('PSAR', input);
    const len = close.length;
    const y = gapped(len);
    if (len < 2) return psarOutput(step, cap, y);

    const h = (i: number): number => high[i] ?? Number.NaN;
    const l = (i: number): number => low[i] ?? Number.NaN;

    let long = (close[1] ?? Number.NaN) >= (close[0] ?? Number.NaN);
    let sar = long ? Math.min(l(0), l(1)) : Math.max(h(0), h(1));
    let ep = long ? Math.max(h(0), h(1)) : Math.min(l(0), l(1));
    let af = step;
    y[1] = sar;

    for (let i = 2; i < len; i += 1) {
      let next = sar + af * (ep - sar);
      // Clamp to the two prior bars' extremes (3): a stop inside the current range would reverse on
      // the bar that produced it, which is an artefact of the arithmetic and not a signal.
      if (long) next = Math.min(next, l(i - 1), l(i - 2));
      else next = Math.max(next, h(i - 1), h(i - 2));

      const penetrated = long ? l(i) < next : h(i) > next;
      if (penetrated) {
        // Reverse (4): the stop becomes the extreme of the trend that just ended.
        next = ep;
        long = !long;
        ep = long ? h(i) : l(i);
        af = step;
      } else if (long && h(i) > ep) {
        ep = h(i);
        af = Math.min(af + step, cap);
      } else if (!long && l(i) < ep) {
        ep = l(i);
        af = Math.min(af + step, cap);
      }
      y[i] = next;
      sar = next;
    }
    return psarOutput(step, cap, y);
  },
};

function psarOutput(step: number, cap: number, y: Float64Array): StudyOutput {
  return {
    lines: [
      {
        id: 'psar',
        label: `PSAR(${String(step)}, ${String(cap)})`,
        y,
        // `dashed` stands in for §11.6's "scatter line": `StudyLine` has no mark field, and drawing
        // a stop-and-reverse as a solid polyline would connect the two sides of every reversal.
        style: { color: 'neutral', width: 1, dashed: true },
      },
    ],
  };
}

/* -------------------------------------------------------------------------------------------- */
/* ICHIMOKU                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * `ICHIMOKU` — Ichimoku Kinkō Hyō, `tenkan = 9, kijun = 26, senkou = 52` (§11.6). Core: none.
 *
 * Five lines and the cloud between the two senkou spans, each a midpoint of a window's high/low
 * range rather than an average of closes:
 *
 *  - `tenkan`  (conversion): midpoint of the last 9 bars' range. First value at slot 8.
 *  - `kijun`   (base): midpoint of the last 26. First value at slot 25.
 *  - `senkouA` (leading span A): `(tenkan + kijun) / 2`, **plotted `kijun` slots forward**, so the
 *    first drawn value is at slot 25 + 26 = 51.
 *  - `senkouB` (leading span B): midpoint of the last 52, plotted `kijun` slots forward — first
 *    drawn value at slot 51 + 26 = 77. Both spans run to the last slot; what the shift costs is the
 *    projection past it (see the file header).
 *  - `chikou`  (lagging span): the close, plotted `kijun` slots **back**. It therefore has no
 *    leading gap at all — slot 0 carries the close of slot 26 — and a *trailing* gap of the last 26
 *    slots. That asymmetry is the study, not a bug: the lagging span is the one line that is allowed
 *    to be behind, and drawing it forward-aligned would be the lookahead every other line avoids.
 *
 * The forward shift is where the engine's model runs out: a slot exists only where some series has a
 * point (§11.2's `TradingDayIndex` is the union of timestamps), so there is nowhere to put the
 * projection past the last bar and the last `kijun` values of both spans are dropped. A chart that
 * wanted the cloud's future half would have to extend the index with synthetic session slots, which
 * would change what every other series means by "the last slot" — so the gap is stated instead
 * (§11.11's list of CHRT gaps is where it belongs).
 *
 * **No `update`.** A new bar writes into the *future* half of both senkou spans, so the slots a
 * last-slot update changes are not the last slot. Recomputing the tail is the honest form (§11.5).
 */
const ICHIMOKU: StudyDef = {
  id: 'ICHIMOKU',
  name: 'Ichimoku cloud',
  pane: 'main',
  params: [P.tenkan, P.kijun, P.senkou],
  needs: ['ohlc'],
  yFmt: 'px',
  compute(input, params) {
    const tenkanN = intParam(params, 'tenkan', P.tenkan);
    const kijunN = intParam(params, 'kijun', P.kijun);
    const senkouN = intParam(params, 'senkou', P.senkou);
    const { high, low, close } = require3('ICHIMOKU', input);
    const len = close.length;

    const tenkan = gapped(len);
    const kijun = gapped(len);
    const senkouA = gapped(len);
    const senkouB = gapped(len);
    const chikou = gapped(len);

    const midpoint = (i: number, n: number): number =>
      i < n - 1 ? Number.NaN : (windowMax(high, i - n + 1, i) + windowMin(low, i - n + 1, i)) / 2;

    for (let i = 0; i < len; i += 1) {
      tenkan[i] = midpoint(i, tenkanN);
      kijun[i] = midpoint(i, kijunN);
    }
    for (let i = 0; i < len; i += 1) {
      const forward = i + kijunN;
      if (forward >= len) break;
      const t = tenkan[i] ?? Number.NaN;
      const k = kijun[i] ?? Number.NaN;
      if (!Number.isNaN(t) && !Number.isNaN(k)) senkouA[forward] = (t + k) / 2;
      const b = midpoint(i, senkouN);
      if (!Number.isNaN(b)) senkouB[forward] = b;
    }
    for (let i = kijunN; i < len; i += 1) chikou[i - kijunN] = close[i] ?? Number.NaN;

    return {
      lines: [
        { id: 'tenkan', label: `Tenkan (${String(tenkanN)})`, y: tenkan, style: { color: 'auto' } },
        { id: 'kijun', label: `Kijun (${String(kijunN)})`, y: kijun, style: { color: 'neutral' } },
        { id: 'senkouA', label: 'Senkou A', y: senkouA, style: { color: 'up', width: 1 } },
        {
          id: 'senkouB',
          label: `Senkou B (${String(senkouN)})`,
          y: senkouB,
          style: { color: 'down', width: 1 },
        },
        {
          id: 'chikou',
          label: 'Chikou',
          y: chikou,
          style: { color: 'neutral', width: 1, dashed: true },
        },
      ],
      bands: [{ upper: 'senkouA', lower: 'senkouB', alpha: 0.12 }],
    };
  },
};

/* -------------------------------------------------------------------------------------------- */
/* VWAP                                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * `VWAP` — session volume-weighted average price, `anchor = 0` (§11.6). Core function: none.
 *
 * Typical price `(h + l + c) / 3`, weighted by the bar's volume, accumulated from the start of the
 * session. **This is the server's definition, function for function**: `GIP`'s resolver computes the
 * same series for its payload (`functions/GIP/resolve.ts#vwapOf`) under the engine name
 * `vwap@1.0.0`, and API-05 says the number under the chart and the number in the payload have to
 * agree. `core/analytics/stats` has no `vwap` to defer to — §GIP names one and it does not exist,
 * which the server's resolver records — so the agreement here is by shared definition rather than by
 * shared code, and that is worth saying out loud because it is the weaker of the two.
 *
 * Intraday only, and `needs: ['ohlc', 'volume']`: a daily VWAP is a number that means nothing (the
 * session is the bar), and an index or a currency pair has no volume at all, which is why `GIP`
 * reports VWAP as `NOT_APPLICABLE` for those rather than drawing a flat line at zero.
 *
 * **Sessions are detected by the UTC day of `x`.** `StudyInput` carries timestamps and nothing else
 * — the session bands live on `ChartSpec.xAxis.sessions`, which a study cannot see — so a new
 * session begins where the UTC date changes. That is the same session for every venue whose regular
 * hours do not straddle UTC midnight (New York 13:30–20:00Z, London 08:00–16:30Z, Tokyo 00:00–06:00Z
 * all qualify); Sydney and Wellington do not, and for those the server's series is the one of record.
 * Giving `StudyInput` the session bands would fix it and is a `studies/types.ts` change.
 *
 * `anchor` is `0` for the session reset §11.6 names, and `1` for an anchored VWAP that accumulates
 * from the first bar of the input and never resets — the same arithmetic with the reset switched
 * off, which is what "anchored VWAP" means on every terminal that offers it.
 *
 * **No `update`.** The accumulators — running Σpv and Σv for the session — are not in a
 * `StudyOutput`, and reconstructing Σv from the published average is not possible at all. A forming
 * bar's VWAP therefore recomputes the session, which is at most one day of bars (§11.5).
 */
const VWAP: StudyDef = {
  id: 'VWAP',
  name: 'Session VWAP',
  pane: 'main',
  params: [P.vwapAnchor],
  needs: ['ohlc', 'volume'],
  yFmt: 'px',
  compute(input, params) {
    const anchor = intParam(params, 'anchor', P.vwapAnchor);
    const { high, low, close } = require3('VWAP', input);
    const volume = requireVolume('VWAP', input);
    const len = close.length;
    const y = gapped(len);

    let day = Number.NaN;
    let pv = 0;
    let vol = 0;
    for (let i = 0; i < len; i += 1) {
      const t = input.x[i] ?? Number.NaN;
      const d = Math.floor(t / 86_400_000);
      if (anchor === 0 && d !== day) {
        day = d;
        pv = 0;
        vol = 0;
      }
      const v = volume[i] ?? Number.NaN;
      const typical =
        ((high[i] ?? Number.NaN) + (low[i] ?? Number.NaN) + (close[i] ?? Number.NaN)) / 3;
      if (Number.isNaN(typical) || Number.isNaN(v)) continue;
      pv += typical * v;
      vol += v;
      // Σv = 0 is a real state — an auction print of zero size, a halted first minute — and the
      // truth about it is that there is no volume-weighted price yet, which is a gap, not a zero.
      y[i] = vol === 0 ? Number.NaN : pv / vol;
    }
    return {
      lines: [
        {
          id: 'vwap',
          label: anchor === 0 ? 'VWAP (session)' : 'VWAP (anchored)',
          y,
          style: { color: 'neutral', dashed: true },
        },
      ],
    };
  },
};

/* -------------------------------------------------------------------------------------------- */
/* The registry fragment                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * The nine main-pane studies, by id.
 *
 * `satisfies Record<TrendStudyId, StudyDef>` is the check that matters: a study written and not
 * listed, an id misspelled, or a tenth study added to this file without a place in `STUDY_IDS` is a
 * compile error here rather than a name the study picker offers and cannot resolve. `studies/index.ts`
 * spreads this together with the sub-pane fragment to form the twenty-two.
 *
 * Frozen, as `studies/oscillators.ts` freezes its own fragment: the registry is read by the study
 * picker, by a screen manifest's study list and by a persisted layout default, and none of those has
 * any business adding an entry to it at runtime.
 */
export const trendStudies = Object.freeze({
  SMA,
  EMA,
  WMA,
  BB,
  DONCHIAN,
  KELTNER,
  PSAR,
  ICHIMOKU,
  VWAP,
}) satisfies Record<TrendStudyId, StudyDef>;
