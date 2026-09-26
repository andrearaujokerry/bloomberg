// packages/web/src/chart/studies/oscillators.ts — the thirteen sub-pane studies (CLIENT.md §11.6,
// CHRT-04).
//
// `VOL RSI MACD STOCH ATR ADX CCI WILLR ROC MOM OBV STDDEV HVOL`: every study in §11.6's table whose
// `pane` is `sub`, which is to say every one that gets its own linked pane under the price rather
// than drawing on the price's own axis. The nine `main` studies are their own file; `studies/index.ts`
// joins both into the registry the study picker (`S`) types over, and is deliberately not written
// here — a registry assembled by whoever adds the last study is a registry nobody has to merge.
//
// **Why these thirteen are in one file.** They are the same shape of arithmetic — a window over one
// or four columns, reduced to one number per slot — and eight of the thirteen share four kernels
// (`simpleMovingAverage`, `wilderAverage`, `trueRange`, `rollingExtreme`). Split across thirteen
// files those kernels would either be copied thirteen times or live in a fourteenth file that exists
// only to be imported, and a reader checking that ADX and ATR agree about true range would have to
// open three files to find out. They are here, once, with the studies that use them.
//
// **The conventions, stated, because a wrong one is invisible.** A study computed with the wrong
// smoothing still draws a line of roughly the right shape in roughly the right place; nothing on
// screen says it is wrong, and a trader who compares the terminal's RSI(14) against any other
// terminal's is the error report. So each study below says which convention it implements and the
// comments name the alternative it is not. The three that are most often got wrong:
//
//   * **RSI** uses **Wilder** smoothing, not a simple mean of the last `n` changes. Wilder's
//     recurrence is `avg_t = (avg_{t-1}·(n−1) + x_t) / n`, which is an EMA with `α = 1/n` rather than
//     the `2/(n+1)` of a charting EMA. It also needs a seed, and the seed is where two
//     implementations of "Wilder" diverge: this one seeds with the **simple mean of the first `n`
//     changes** (Wilder's own presentation) and emits its first value at index `n`. The alternative —
//     running the recurrence from the first change with no seed — converges to the same numbers but
//     differs for hundreds of bars, so the choice is stated rather than implied.
//   * **ATR** is the **Wilder average of true range**, and true range spans the **previous close**:
//     `max(high − low, |high − prevClose|, |low − prevClose|)`. Dropping the previous close (using
//     the bar's own range alone) understates every gap, which is exactly the volatility ATR exists to
//     measure. True range is therefore undefined at index 0 and ATR's first value is at index `n`.
//   * **ADX** is two smoothings deep. First directional movement per bar (`+DM`, `−DM` — only the
//     larger of the two moves counts, and only when it is positive), then a Wilder average of `+DM`,
//     `−DM` and true range giving `+DI`/`−DI` from index `n`, then `DX` from those, then a **second**
//     Wilder average of `DX` giving ADX from index `2n − 1`. Stopping after the first smoothing
//     yields a plausible-looking line that is DX, not ADX, and is far noisier than any ADX.
//
// **MACD**'s histogram is `macd − signal` — the distance between the two lines, not the MACD line
// itself. Both EMAs are seeded with the simple mean of their first `n` closes, so the MACD line
// begins at `slow − 1` and the signal, an EMA of the MACD line, at `slow + signal − 2`.
//
// **What is imported, not reimplemented** (API-05). `STDDEV` calls `stdevOf` and `HVOL` calls
// `logReturns` and `volatility` from `core/analytics/stats`, the same functions the API's `VOL_30D`
// and the stats engine serve. A second annualised volatility here would mean the number under the
// chart and the number in the payload could disagree about the same security over the same window,
// and nobody could tell which was right. The cost is a `readonly number[]` copy of the window per
// slot, because core speaks arrays and a `StudyInput` column is a `Float64Array`; for a 30-point
// window that is the correct trade.
//
// **Units.** `HVOL` and `ROC` carry `yFmt: 'pct'`, and a `pct` value in this codebase is in **percent
// points** — `core/fields/format.ts` appends `%` without scaling, and `VOL_30D`'s dictionary entry
// gives `× 100` in its derivation. So `HVOL` multiplies core's decimal-fraction `volAnnualised` by
// 100 and `ROC` is `100 · (P_t/P_{t−n} − 1)`. §11.6 tabulates `yFmt` only for `HVOL`; `ROC` is given
// the same because the price axis' format is the one thing a rate of change is not.
//
// **Complexity.** Every window is summed explicitly over its `n` points rather than carried as a
// rolling sum. A rolling sum is O(1) per slot but accumulates floating-point drift over a long
// series, and these numbers are golden-tested to 1e-9 against an independent implementation; with
// `n ≤ 30` the explicit sum is O(30·points), which is under a millisecond for the 1255-bar daily
// series and bounded even at the §16 million-point budget. Determinism first.

import { logReturns, stdevOf, volatility } from '@terminal/core/analytics/stats/index';

import type { StudyDef, StudyInput, StudyOutput } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Column access
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `high`, `low` and `close` columns of a study whose `needs` includes `'ohlc'`.
 *
 * This throws rather than returning an all-`NaN` pane. `StudyDef.needs` is a declaration the caller
 * checks *before* it builds a `StudyInput` (`studies/types.ts`), so a missing column here is not bad
 * market data — it is the registry and the caller disagreeing about what this study requires, and a
 * blank pane with no message is the version of that bug that survives to production. The message
 * names the study and the column so the fix is the one-line `needs` edit it always is.
 */
function ohlcOf(id: string, input: StudyInput): { high: Float64Array; low: Float64Array } {
  const { high, low } = input;
  if (high === undefined || low === undefined) {
    throw new RangeError(
      `chart study ${id}: needs 'ohlc' — the input has no ${high === undefined ? 'high' : 'low'} ` +
        `column. Check StudyDef.needs at the call site before building the StudyInput.`,
    );
  }
  return { high, low };
}

/** The `volume` column of a study whose `needs` includes `'volume'`; throws for the same reason. */
function volumeOf(id: string, input: StudyInput): Float64Array {
  const { volume } = input;
  if (volume === undefined) {
    throw new RangeError(
      `chart study ${id}: needs 'volume' — the input has no volume column. Check StudyDef.needs ` +
        `at the call site before building the StudyInput.`,
    );
  }
  return volume;
}

/**
 * One integer parameter, floored at the smallest window the formula is defined for.
 *
 * The picker's form enforces `min`/`max` on the way in, but a study's parameters also arrive from
 * `layout.chart.studies` and from a frame's persisted params (§11.6), written by an older build whose
 * bounds may have been different. An `n` of 0 or a `NaN` would produce a pane of `NaN` with nothing
 * to explain it, so a missing value takes the default and a too-small one takes `min` — the study
 * still draws. The declared **maximum** is deliberately *not* enforced here: a 500-period average of
 * a 300-bar series is all gaps, which is a legible answer, whereas silently substituting 200 for the
 * number the trader typed is not.
 */
function windowOf(
  params: Record<string, number>,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = params[name];
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.trunc(raw));
}

/** A column of `length` gaps. `NaN` before a study has enough points to have an answer (§11.6). */
function gaps(length: number): Float64Array {
  return new Float64Array(length).fill(Number.NaN);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Kernels shared by the studies below
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `src[i]`, or `NaN` when `i` is outside it — the studies index one slot behind at every edge. */
function at(src: Float64Array, i: number): number {
  return i >= 0 && i < src.length ? src[i]! : Number.NaN;
}

/** Simple mean of `src[i-n+1..i]`, or `NaN` if the window is short or contains a gap. */
function windowMean(src: Float64Array, i: number, n: number): number {
  if (i < n - 1) return Number.NaN;
  let total = 0;
  for (let j = i - n + 1; j <= i; j += 1) {
    const v = src[j]!;
    if (Number.isNaN(v)) return Number.NaN;
    total += v;
  }
  return total / n;
}

/** `windowMean` at every slot: the simple moving average, gapped for the first `n − 1` slots. */
function simpleMovingAverage(src: Float64Array, n: number): Float64Array {
  const out = gaps(src.length);
  for (let i = n - 1; i < src.length; i += 1) out[i] = windowMean(src, i, n);
  return out;
}

/**
 * Exponential moving average with `α = 2/(n+1)`, seeded with the simple mean of the first `n`
 * available points — the charting convention, and the one MACD is defined against here.
 *
 * "First `n` available" and not "first `n`" because the signal line is an EMA of the MACD line, whose
 * leading slots are gaps; the seed starts at the first finite point and the output is gapped before
 * `start + n − 1`.
 */
function exponentialMovingAverage(src: Float64Array, n: number): Float64Array {
  const out = gaps(src.length);
  let start = 0;
  while (start < src.length && Number.isNaN(src[start]!)) start += 1;
  if (start + n > src.length) return out;
  let seed = 0;
  for (let j = start; j < start + n; j += 1) seed += src[j]!;
  let prev = seed / n;
  out[start + n - 1] = prev;
  const alpha = 2 / (n + 1);
  for (let i = start + n; i < src.length; i += 1) {
    prev += alpha * (src[i]! - prev);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's average of `src`, starting from `first`: the simple mean of `src[first..first+n-1]`, then
 * `avg_t = (avg_{t-1}·(n−1) + x_t) / n`. The first output is at `first + n − 1`.
 *
 * Exported because `KELTNER` (a `main` study, another file) is built on the same ATR this file
 * computes, and two Wilder averages that disagree by a seed would make the channel and the ATR pane
 * describe different volatilities on the same screen.
 *
 * Wilder's original presentation keeps a running *sum* (`S_t = S_{t-1} − S_{t-1}/n + x_t`) rather
 * than an average. The two are the same series scaled by `n` — the sum form is seeded with the sum of
 * the first `n`, which is `n ×` this seed, and the recurrences differ by the same factor — so `+DI`,
 * a ratio of two of them, is identical either way. The average form is used because ATR is a price
 * and a sum of fourteen true ranges is not.
 *
 * **A gap ends a run; it does not end the series.** `src` is gapped wherever the study has no answer
 * yet (slot 0 of `trueRange`) and wherever the *input* had none — §11.2 aligns two calendars by the
 * union of their timestamps, so a series that does not trade on a slot is `NaN` there, and a second
 * security on the same chart starts with a stretch of them. This used to return the whole column of
 * gaps when any value in the seed window was `NaN`, which drew an empty ATR or ADX pane for a series
 * that has fourteen clean bars a fortnight later: one absent bar suppressed five years of study.
 * Now each maximal run of finite values is seeded and followed on its own, so the output is gapped
 * exactly where the input is (plus the `n − 1` slots each seed consumes) and nowhere else.
 *
 * The recurrence is deliberately **not** carried across a gap. `avg_t` claims to be the average of
 * `n` observations; continuing it over a slot where there was no observation would put a number on
 * the pane that is the average of thirteen true ranges labelled as fourteen. Re-seeding after the
 * gap costs `n − 1` slots of warm-up and states what it knows.
 */
export function wilderAverage(src: Float64Array, n: number, first: number): Float64Array {
  const out = gaps(src.length);
  let start = Math.max(first, 0);
  while (start + n <= src.length) {
    // Walk the candidate seed window. A `NaN` at `start + filled` cannot be inside any window that
    // begins at or before it, so the next candidate begins one slot past the gap rather than one
    // slot past `start` — that is what keeps this linear over a series of alternating gaps.
    let seed = 0;
    let filled = 0;
    while (filled < n && !Number.isNaN(src[start + filled]!)) {
      seed += src[start + filled]!;
      filled += 1;
    }
    if (filled < n) {
      start += filled + 1;
      continue;
    }
    let avg = seed / n;
    out[start + n - 1] = avg;
    let i = start + n;
    for (; i < src.length; i += 1) {
      const v = src[i]!;
      if (Number.isNaN(v)) break;
      avg = (avg * (n - 1) + v) / n;
      out[i] = avg;
    }
    start = i + 1;
  }
  return out;
}

/**
 * True range per bar: `max(high − low, |high − prevClose|, |low − prevClose|)`, gapped at index 0.
 *
 * Exported for the same reason as `wilderAverage`: `KELTNER` and `PSAR` both need it, and the
 * previous-close terms are precisely the part an independent reimplementation leaves out.
 */
export function trueRange(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
): Float64Array {
  const out = gaps(close.length);
  for (let i = 1; i < close.length; i += 1) {
    const prevClose = close[i - 1]!;
    const h = high[i]!;
    const l = low[i]!;
    out[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  }
  return out;
}

/** Highest `high` over `src[i-n+1..i]`; `NaN` before the window is full. */
function rollingExtreme(src: Float64Array, i: number, n: number, kind: 'high' | 'low'): number {
  if (i < n - 1) return Number.NaN;
  let best = src[i - n + 1]!;
  for (let j = i - n + 2; j <= i; j += 1) {
    const v = src[j]!;
    if (kind === 'high' ? v > best : v < best) best = v;
  }
  return best;
}

/**
 * The per-bar close direction, `+1 | 0 | −1`, for every slot (slot 0 is `0` — it has no predecessor).
 *
 * §11.6 asks for VOL's histogram to be **direction-coloured**, and `StudyOutput.histogram` is
 * `{ id, y }` with no colour channel: a volume is unsigned, so the sign of `y` — which is what
 * colours MACD's histogram — says nothing about whether the day was up or down. Rather than smuggle
 * the direction into `y` as a negative volume (which would draw bars below the baseline) or invent a
 * field on a type three other files already compile against, the direction is exported as a function
 * the renderer calls for a `VOL` pane. That keeps one definition of "an up day" — the same
 * `close > prevClose` the candle bodies use — instead of two that can drift apart.
 */
export function volumeDirection(close: Float64Array): Float64Array {
  const out = new Float64Array(close.length);
  for (let i = 1; i < close.length; i += 1) {
    const prev = close[i - 1]!;
    const curr = close[i]!;
    out[i] = curr > prev ? 1 : curr < prev ? -1 : 0;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Incremental update (§11.5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A `Float64Array` of at least `length`, reusing `y` when it is already long enough. */
function grown(y: Float64Array, length: number): Float64Array {
  if (y.length >= length) return y;
  const next = gaps(length);
  next.set(y, 0);
  return next;
}

/**
 * Write one slot's freshly computed values into a previous `StudyOutput` and return it.
 *
 * This is what §11.5 means by the forming bar updating **in place**: a tick changes exactly one slot,
 * and rebuilding thirteen `Float64Array`s per tick for a chart that redraws a two-slot clip rect
 * would put the whole series on the frame path. The arrays are therefore mutated at `lastIndex` and
 * the same object handed back, which is safe because a `StudyOutput` belongs to the renderer that
 * asked for it. Appending a slot grows the arrays instead (the stream has moved past the old last
 * slot, so `prev` is short by one); `values` is keyed by line id, and a line absent from it keeps
 * whatever it had.
 */
function patchLast(
  prev: StudyOutput,
  lastIndex: number,
  values: Readonly<Record<string, number>>,
): StudyOutput {
  const lines = prev.lines.map((line) => {
    const value = values[line.id];
    if (value === undefined) return line;
    const y = grown(line.y, lastIndex + 1);
    y[lastIndex] = value;
    return y === line.y ? line : { ...line, y };
  });
  const histogram = prev.histogram;
  if (histogram === undefined) return { ...prev, lines };
  const value = values[histogram.id];
  if (value === undefined) return { ...prev, lines };
  const y = grown(histogram.y, lastIndex + 1);
  y[lastIndex] = value;
  return { ...prev, lines, histogram: { ...histogram, y } };
}

/** The value a line held at `index`, or `NaN` — the base an OBV-style recurrence continues from. */
function previousValue(prev: StudyOutput, id: string, index: number): number {
  const line = prev.lines.find((candidate) => candidate.id === id);
  return line === undefined ? Number.NaN : at(line.y, index);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VOL — volume histogram with a moving average (§11.6, n = 20)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const VOL: StudyDef = {
  id: 'VOL',
  name: 'Volume with MA',
  pane: 'sub',
  params: [{ name: 'n', label: 'MA periods', default: 20, min: 1, max: 200, step: 1 }],
  // `close` as well as `volume`: the histogram is direction-coloured and the direction is the
  // close's, not the volume's (see `volumeDirection`).
  needs: ['close', 'volume'],
  yFmt: 'int',
  compute(input, params) {
    const volume = volumeOf('VOL', input);
    const n = windowOf(params, 'n', 20, 1);
    return {
      histogram: { id: 'VOL.volume', y: Float64Array.from(volume) },
      lines: [
        {
          id: 'VOL.ma',
          label: `MA(${String(n)})`,
          y: simpleMovingAverage(volume, n),
          style: { color: 'neutral', width: 1 },
        },
      ],
    };
  },
  update(prev, input, params, lastIndex) {
    const volume = volumeOf('VOL', input);
    const n = windowOf(params, 'n', 20, 1);
    return patchLast(prev, lastIndex, {
      'VOL.volume': at(volume, lastIndex),
      'VOL.ma': windowMean(volume, lastIndex, n),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RSI — Wilder's relative strength index (§11.6, n = 14, levels 30/70)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `100 − 100/(1 + avgGain/avgLoss)` on Wilder-smoothed gains and losses, seeded with the simple mean
 * of the first `n` changes (see this file's header for why the seed is stated).
 *
 * `avgLoss === 0` with a positive `avgGain` is not a division to guard against with an epsilon: `n`
 * consecutive non-falling closes mean relative strength is unbounded and RSI is exactly 100, which is
 * the value a reader expects to see pinned at the top of the pane. Its mirror, `avgGain === 0` with a
 * positive `avgLoss`, gives `RS = 0` and RSI 0 by arithmetic and needs no branch either.
 *
 * **Both zero is the case that does need one, and it is the one a divisor test gets wrong.** Testing
 * `avgLoss === 0` first answered 100 — maximum overbought — for a series that never moved at all,
 * which is not an edge case a chart engine can wave away: a policy rate is flat between FOMC
 * meetings (`fixtures/providers/normalised/nyfed-effr.json` is ten captured EFFR fixings all equal to
 * 3.63), and GP charts `unit:'rate'` and `unit:'yield'` series through this same engine, so thirty
 * unchanged closes are ordinary data rather than a synthetic curiosity. The answer here is **50**:
 * `RS = 0/0` has no value, but every path that reaches it has `avgGain === avgLoss`, and along that
 * path `RS = 1` and RSI is 50 for any size of move. 50 is also the midline the 30/70 levels are read
 * against, so a flat stretch draws where "neither" belongs instead of where "extreme" does.
 */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function relativeStrengthIndex(close: Float64Array, n: number): Float64Array {
  const out = gaps(close.length);
  if (close.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i += 1) {
    const change = close[i]! - close[i - 1]!;
    if (change > 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  out[n] = rsiFrom(avgGain, avgLoss);
  for (let i = n + 1; i < close.length; i += 1) {
    const change = close[i]! - close[i - 1]!;
    avgGain = (avgGain * (n - 1) + (change > 0 ? change : 0)) / n;
    avgLoss = (avgLoss * (n - 1) + (change < 0 ? -change : 0)) / n;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

const RSI: StudyDef = {
  id: 'RSI',
  name: 'Relative strength index',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 14, min: 2, max: 200, step: 1 }],
  needs: ['close'],
  yFmt: 'ratio',
  compute(input, params) {
    const n = windowOf(params, 'n', 14, 2);
    return {
      lines: [
        {
          id: 'RSI.rsi',
          label: `RSI(${String(n)})`,
          y: relativeStrengthIndex(input.close, n),
          style: { color: 'auto', width: 1 },
        },
      ],
      levels: [30, 70],
    };
  },
  // No `update`. Wilder's recurrence carries `avgGain`/`avgLoss`, and neither is in the output — RSI
  // alone gives their *ratio* and not their levels, so the next value cannot be recovered from
  // `prev`. §11.5's fallback (recompute the last window) is honest; a fabricated `update` would not
  // be, and would be wrong by a little for the rest of the session.
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MACD — moving average convergence/divergence (§11.6, 12/26/9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const MACD: StudyDef = {
  id: 'MACD',
  name: 'MACD',
  pane: 'sub',
  params: [
    { name: 'fast', label: 'Fast EMA', default: 12, min: 2, max: 200, step: 1 },
    { name: 'slow', label: 'Slow EMA', default: 26, min: 3, max: 400, step: 1 },
    { name: 'signal', label: 'Signal EMA', default: 9, min: 2, max: 200, step: 1 },
  ],
  needs: ['close'],
  yFmt: 'px',
  compute(input, params) {
    const fast = windowOf(params, 'fast', 12, 2);
    const slow = windowOf(params, 'slow', 26, 3);
    const signalN = windowOf(params, 'signal', 9, 2);
    const emaFast = exponentialMovingAverage(input.close, fast);
    const emaSlow = exponentialMovingAverage(input.close, slow);
    const macd = gaps(input.close.length);
    for (let i = 0; i < macd.length; i += 1) macd[i] = emaFast[i]! - emaSlow[i]!;
    const signal = exponentialMovingAverage(macd, signalN);
    // The histogram is `macd − signal`: the *distance between the two lines*, which is what crossing
    // zero means "the lines crossed". It is not the MACD line drawn as bars.
    const histogram = gaps(macd.length);
    for (let i = 0; i < histogram.length; i += 1) {
      histogram[i] = macd[i]! - signal[i]!;
    }
    return {
      lines: [
        {
          id: 'MACD.macd',
          label: `MACD(${String(fast)},${String(slow)})`,
          y: macd,
          style: { color: 'auto', width: 1 },
        },
        {
          id: 'MACD.signal',
          label: `Signal(${String(signalN)})`,
          y: signal,
          style: { color: 'neutral', width: 1 },
        },
      ],
      histogram: { id: 'MACD.hist', y: histogram },
    };
  },
  // No `update`: the recurrence's state is the two EMAs, and the output carries only their
  // difference. See RSI.
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// STOCH — stochastic %K/%D (§11.6, k = 14, d = 3, smooth = 3, levels 20/80)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Raw %K: `100 · (close − lowest low) / (highest high − lowest low)` over `k` bars.
 *
 * A zero range — `k` bars whose high and low are all one price, which is a halted or unquoted
 * instrument rather than a calculation error — returns 50 rather than dividing. 50 is the midpoint,
 * the honest reading of "the close is nowhere in particular within a range of nothing", and it keeps
 * the series inside the 0..100 the pane's levels are drawn against.
 */
function rawStochastic(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  k: number,
  i: number,
): number {
  const hh = rollingExtreme(high, i, k, 'high');
  const ll = rollingExtreme(low, i, k, 'low');
  if (Number.isNaN(hh) || Number.isNaN(ll)) return Number.NaN;
  const range = hh - ll;
  return range === 0 ? 50 : (100 * (close[i]! - ll)) / range;
}

const STOCH: StudyDef = {
  id: 'STOCH',
  name: 'Stochastic %K/%D',
  pane: 'sub',
  params: [
    { name: 'k', label: '%K periods', default: 14, min: 2, max: 200, step: 1 },
    { name: 'd', label: '%D periods', default: 3, min: 1, max: 100, step: 1 },
    { name: 'smooth', label: '%K smoothing', default: 3, min: 1, max: 100, step: 1 },
  ],
  needs: ['ohlc'],
  yFmt: 'ratio',
  compute(input, params) {
    const { high, low } = ohlcOf('STOCH', input);
    const k = windowOf(params, 'k', 14, 2);
    const d = windowOf(params, 'd', 3, 1);
    const smooth = windowOf(params, 'smooth', 3, 1);
    const raw = gaps(input.close.length);
    for (let i = k - 1; i < raw.length; i += 1)
      raw[i] = rawStochastic(high, low, input.close, k, i);
    // The drawn %K is the *slow* stochastic: raw %K smoothed over `smooth` periods. `smooth = 1` is
    // the fast stochastic, which is why the parameter's minimum is 1 and not 2.
    const percentK = simpleMovingAverage(raw, smooth);
    const percentD = simpleMovingAverage(percentK, d);
    return {
      lines: [
        { id: 'STOCH.k', label: '%K', y: percentK, style: { color: 'auto', width: 1 } },
        {
          id: 'STOCH.d',
          label: '%D',
          y: percentD,
          style: { color: 'neutral', width: 1, dashed: true },
        },
      ],
      levels: [20, 80],
    };
  },
  // %K and %D at the last slot depend only on the last `k + smooth + d` bars of the input, so the
  // incremental form recomputes that bounded window rather than needing state the output dropped.
  update(prev, input, params, lastIndex) {
    const { high, low } = ohlcOf('STOCH', input);
    const k = windowOf(params, 'k', 14, 2);
    const d = windowOf(params, 'd', 3, 1);
    const smooth = windowOf(params, 'smooth', 3, 1);
    const kWindow = new Float64Array(smooth + d - 1);
    for (let j = 0; j < kWindow.length; j += 1) {
      const i = lastIndex - (kWindow.length - 1 - j);
      kWindow[j] = i < 0 ? Number.NaN : rawStochastic(high, low, input.close, k, i);
    }
    const smoothed = simpleMovingAverage(kWindow, smooth);
    return patchLast(prev, lastIndex, {
      'STOCH.k': at(smoothed, smoothed.length - 1),
      'STOCH.d': windowMean(smoothed, smoothed.length - 1, d),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ATR — average true range (§11.6, n = 14)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ATR: StudyDef = {
  id: 'ATR',
  name: 'Average true range',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 14, min: 2, max: 200, step: 1 }],
  needs: ['ohlc'],
  yFmt: 'px',
  compute(input, params) {
    const { high, low } = ohlcOf('ATR', input);
    const n = windowOf(params, 'n', 14, 2);
    // True range is undefined at slot 0 (no previous close), so the Wilder average is seeded from
    // slot 1 and the first ATR lands at slot `n`, not `n − 1`.
    const atr = wilderAverage(trueRange(high, low, input.close), n, 1);
    return {
      lines: [
        {
          id: 'ATR.atr',
          label: `ATR(${String(n)})`,
          y: atr,
          style: { color: 'auto', width: 1 },
        },
      ],
    };
  },
  // No `update`: Wilder's average is a recurrence on itself, and while `prev` does carry the previous
  // ATR, a forming bar *overwrites* the last slot rather than appending — so the value at
  // `lastIndex − 1` is the right base only on an append, and a study cannot tell the two apart from
  // its arguments. Recomputing the window is correct in both cases.
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ADX — average directional index with ±DI (§11.6, n = 14)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ADX: StudyDef = {
  id: 'ADX',
  name: 'Average directional index',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 14, min: 2, max: 200, step: 1 }],
  needs: ['ohlc'],
  yFmt: 'ratio',
  compute(input, params) {
    const { high, low } = ohlcOf('ADX', input);
    const n = windowOf(params, 'n', 14, 2);
    const length = input.close.length;
    // Directional movement: only the larger of the two edges counts, and only when it is positive.
    // An inside bar (both edges move inward) contributes zero to both, which is the point — a bar
    // that extended neither side of the range carries no direction.
    const plusDM = gaps(length);
    const minusDM = gaps(length);
    for (let i = 1; i < length; i += 1) {
      const up = high[i]! - high[i - 1]!;
      const down = low[i - 1]! - low[i]!;
      plusDM[i] = up > down && up > 0 ? up : 0;
      minusDM[i] = down > up && down > 0 ? down : 0;
    }
    // First smoothing. The true-range average here is ATR itself — the same `wilderAverage` of the
    // same `trueRange` — so the ADX pane and the ATR pane cannot disagree about volatility.
    const smoothedTR = wilderAverage(trueRange(high, low, input.close), n, 1);
    const smoothedPlus = wilderAverage(plusDM, n, 1);
    const smoothedMinus = wilderAverage(minusDM, n, 1);
    const plusDI = gaps(length);
    const minusDI = gaps(length);
    const dx = gaps(length);
    for (let i = 0; i < length; i += 1) {
      const tr = smoothedTR[i]!;
      const up = smoothedPlus[i]!;
      const down = smoothedMinus[i]!;
      // A gap in any of the three is a slot the study has no answer for, and stays a gap.
      if (Number.isNaN(tr) || Number.isNaN(up) || Number.isNaN(down)) continue;
      // Zero smoothed true range is a *value*, not a gap, and treating it as one used to empty the
      // whole pane rather than the stretch that caused it: `dx` was left `NaN` at those slots and the
      // second Wilder average refused any series with a `NaN` in its seed window, so a flat opening
      // fortnight (a halted name, or a policy rate between FOMC meetings) suppressed ADX and ±DI for
      // every slot afterwards. Zero is also the arithmetically forced answer rather than a
      // convention: true range is non-negative, so a zero Wilder average of it means every bar from
      // the seed to here had `high === low === prevClose`, which makes both directional movements
      // exactly zero too — `0/0` reached only along the path where the numerators vanish first. No
      // directional movement is ADX 0 and ±DI 0, and that is what the pane should say.
      if (tr === 0) {
        plusDI[i] = 0;
        minusDI[i] = 0;
        dx[i] = 0;
        continue;
      }
      const pdi = (100 * up) / tr;
      const mdi = (100 * down) / tr;
      plusDI[i] = pdi;
      minusDI[i] = mdi;
      const total = pdi + mdi;
      dx[i] = total === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / total;
    }
    // Second smoothing. `DX` first exists at slot `n`, so ADX first exists at `2n − 1` — the long
    // warm-up is the study, not a bug in it.
    const adx = wilderAverage(dx, n, n);
    return {
      lines: [
        { id: 'ADX.adx', label: `ADX(${String(n)})`, y: adx, style: { color: 'auto', width: 1 } },
        { id: 'ADX.plusDI', label: '+DI', y: plusDI, style: { color: 'up', width: 1 } },
        { id: 'ADX.minusDI', label: '−DI', y: minusDI, style: { color: 'down', width: 1 } },
      ],
    };
  },
  // No `update`: two nested Wilder recurrences, neither of whose state is in the output. See ATR.
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CCI — commodity channel index (§11.6, n = 20, levels ±100)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `(typicalPrice − SMA) / (0.015 · meanAbsoluteDeviation)` over `n` bars.
 *
 * Two details that are easy to get wrong and invisible once wrong. The denominator is the **mean
 * absolute deviation** of the typical price from its own mean, not its standard deviation — Lambert's
 * constant 0.015 exists to put roughly 70..80 % of readings inside ±100 *given* mean absolute
 * deviation, and substituting σ rescales the whole study so that the ±100 levels stop meaning
 * anything. And the typical price is `(high + low + close)/3`, not the close.
 */
function commodityChannelIndex(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  n: number,
  i: number,
): number {
  if (i < n - 1) return Number.NaN;
  let total = 0;
  for (let j = i - n + 1; j <= i; j += 1) {
    total += (high[j]! + low[j]! + close[j]!) / 3;
  }
  const mean = total / n;
  let deviation = 0;
  for (let j = i - n + 1; j <= i; j += 1) {
    const tp = (high[j]! + low[j]! + close[j]!) / 3;
    deviation += Math.abs(tp - mean);
  }
  const mad = deviation / n;
  if (mad === 0) return 0;
  const typical = (high[i]! + low[i]! + close[i]!) / 3;
  return (typical - mean) / (0.015 * mad);
}

const CCI: StudyDef = {
  id: 'CCI',
  name: 'Commodity channel index',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 20, min: 2, max: 200, step: 1 }],
  needs: ['ohlc'],
  yFmt: 'ratio',
  compute(input, params) {
    const { high, low } = ohlcOf('CCI', input);
    const n = windowOf(params, 'n', 20, 2);
    const out = gaps(input.close.length);
    for (let i = n - 1; i < out.length; i += 1) {
      out[i] = commodityChannelIndex(high, low, input.close, n, i);
    }
    return {
      lines: [
        { id: 'CCI.cci', label: `CCI(${String(n)})`, y: out, style: { color: 'auto', width: 1 } },
      ],
      levels: [-100, 100],
    };
  },
  update(prev, input, params, lastIndex) {
    const { high, low } = ohlcOf('CCI', input);
    const n = windowOf(params, 'n', 20, 2);
    return patchLast(prev, lastIndex, {
      'CCI.cci': commodityChannelIndex(high, low, input.close, n, lastIndex),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WILLR — Williams %R (§11.6, n = 14, levels −20/−80)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `−100 · (highest high − close) / (highest high − lowest low)` over `n` bars: 0 at the top of the
 * range, −100 at the bottom. The sign is the study — a positive Williams %R is a sign error, and it
 * is why the test asserts the whole series stays inside −100..0 rather than sampling it.
 */
function williamsPercentR(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  n: number,
  i: number,
): number {
  const hh = rollingExtreme(high, i, n, 'high');
  const ll = rollingExtreme(low, i, n, 'low');
  if (Number.isNaN(hh) || Number.isNaN(ll)) return Number.NaN;
  const range = hh - ll;
  // A range of nothing: the midpoint, for the reason `rawStochastic` gives, on this study's scale.
  return range === 0 ? -50 : (-100 * (hh - close[i]!)) / range;
}

const WILLR: StudyDef = {
  id: 'WILLR',
  name: 'Williams %R',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 14, min: 2, max: 200, step: 1 }],
  needs: ['ohlc'],
  yFmt: 'ratio',
  compute(input, params) {
    const { high, low } = ohlcOf('WILLR', input);
    const n = windowOf(params, 'n', 14, 2);
    const out = gaps(input.close.length);
    for (let i = n - 1; i < out.length; i += 1)
      out[i] = williamsPercentR(high, low, input.close, n, i);
    return {
      lines: [
        {
          id: 'WILLR.willr',
          label: `%R(${String(n)})`,
          y: out,
          style: { color: 'auto', width: 1 },
        },
      ],
      levels: [-20, -80],
    };
  },
  update(prev, input, params, lastIndex) {
    const { high, low } = ohlcOf('WILLR', input);
    const n = windowOf(params, 'n', 14, 2);
    return patchLast(prev, lastIndex, {
      'WILLR.willr': williamsPercentR(high, low, input.close, n, lastIndex),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ROC and MOM — rate of change (§11.6, n = 12) and momentum (n = 10), both against level 0
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `100 · (P_t/P_{t−n} − 1)` — in percent points, which is what `yFmt: 'pct'` renders (see header). */
function rateOfChange(close: Float64Array, n: number, i: number): number {
  if (i < n) return Number.NaN;
  const base = close[i - n]!;
  // A zero base is not a 0 % change, but the alternative is ±Infinity in a pane that has to scale to
  // fit it, and a price of exactly zero is a data fault rather than a market event. Flat is the
  // reading that leaves the rest of the pane legible.
  return base === 0 ? 0 : 100 * (close[i]! / base - 1);
}

const ROC: StudyDef = {
  id: 'ROC',
  name: 'Rate of change',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 12, min: 1, max: 400, step: 1 }],
  needs: ['close'],
  yFmt: 'pct',
  compute(input, params) {
    const n = windowOf(params, 'n', 12, 1);
    const out = gaps(input.close.length);
    for (let i = n; i < out.length; i += 1) out[i] = rateOfChange(input.close, n, i);
    return {
      lines: [
        { id: 'ROC.roc', label: `ROC(${String(n)})`, y: out, style: { color: 'auto', width: 1 } },
      ],
      levels: [0],
    };
  },
  update(prev, input, params, lastIndex) {
    const n = windowOf(params, 'n', 12, 1);
    return patchLast(prev, lastIndex, { 'ROC.roc': rateOfChange(input.close, n, lastIndex) });
  },
};

const MOM: StudyDef = {
  id: 'MOM',
  name: 'Momentum',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 10, min: 1, max: 400, step: 1 }],
  needs: ['close'],
  // A price *difference*, so the price format: momentum of 13.33 is 13.33 dollars of it, and the
  // pane's decimals should be the instrument's.
  yFmt: 'px',
  compute(input, params) {
    const n = windowOf(params, 'n', 10, 1);
    const out = gaps(input.close.length);
    for (let i = n; i < out.length; i += 1) {
      out[i] = input.close[i]! - input.close[i - n]!;
    }
    return {
      lines: [
        { id: 'MOM.mom', label: `MOM(${String(n)})`, y: out, style: { color: 'auto', width: 1 } },
      ],
      levels: [0],
    };
  },
  update(prev, input, params, lastIndex) {
    const n = windowOf(params, 'n', 10, 1);
    const value =
      lastIndex < n ? Number.NaN : input.close[lastIndex]! - input.close[lastIndex - n]!;
    return patchLast(prev, lastIndex, { 'MOM.mom': value });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// OBV — on-balance volume (§11.6, no parameters)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const OBV: StudyDef = {
  id: 'OBV',
  name: 'On-balance volume',
  pane: 'sub',
  params: [],
  needs: ['close', 'volume'],
  yFmt: 'int',
  compute(input) {
    const volume = volumeOf('OBV', input);
    const out = gaps(input.close.length);
    if (out.length === 0) return { lines: [] };
    // Slot 0 is the origin, 0, not the first bar's volume: OBV is a cumulative *signed* flow and the
    // first bar has no previous close to have a sign against. The level is arbitrary anyway — only
    // the slope and the divergences are read — but starting at 0 makes the axis mean "volume flow
    // since the left edge of the window" rather than a number nobody can place.
    out[0] = 0;
    for (let i = 1; i < out.length; i += 1) {
      const prev = input.close[i - 1]!;
      const curr = input.close[i]!;
      const signed = curr > prev ? volume[i]! : curr < prev ? -volume[i]! : 0;
      out[i] = out[i - 1]! + signed;
    }
    return {
      lines: [{ id: 'OBV.obv', label: 'OBV', y: out, style: { color: 'auto', width: 1 } }],
    };
  },
  // The one true recurrence whose state *is* its output: OBV at `lastIndex` is OBV at `lastIndex − 1`
  // plus the signed volume of the last bar, and the base is read from the previous slot rather than
  // the last one, so a forming bar that is overwritten ten times in a minute stays correct.
  update(prev, input, _params, lastIndex) {
    const volume = volumeOf('OBV', input);
    if (lastIndex === 0) return patchLast(prev, lastIndex, { 'OBV.obv': 0 });
    const base = previousValue(prev, 'OBV.obv', lastIndex - 1);
    const previousClose = input.close[lastIndex - 1]!;
    const currentClose = input.close[lastIndex]!;
    const signed =
      currentClose > previousClose
        ? volume[lastIndex]!
        : currentClose < previousClose
          ? -volume[lastIndex]!
          : 0;
    return patchLast(prev, lastIndex, { 'OBV.obv': base + signed });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// STDDEV — rolling standard deviation (§11.6, n = 20), through core
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `stdevOf` over the closes in `[i-n+1, i]`, population (`ddof: 0`).
 *
 * The arithmetic is core's, not this file's (API-05, and this file's header). `stdevOf` requires the
 * degrees of freedom to be stated, which is the whole reason to call it: **population** is the
 * charting convention — it is what Bollinger bands are drawn with, so the STDDEV pane and the `BB`
 * overlay report the same dispersion of the same window — while the stats engine's own default is
 * `ddof: 1` because a sample estimate is what an annualised volatility wants. Two different answers
 * to two different questions, and the only dangerous version is the one where the choice is implicit.
 */
function rollingStdev(close: Float64Array, n: number, i: number): number {
  if (i < n - 1) return Number.NaN;
  const window: number[] = [];
  for (let j = i - n + 1; j <= i; j += 1) window.push(close[j]!);
  return stdevOf(window, 0);
}

const STDDEV: StudyDef = {
  id: 'STDDEV',
  name: 'Rolling standard deviation',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 20, min: 2, max: 400, step: 1 }],
  needs: ['close'],
  yFmt: 'px',
  compute(input, params) {
    const n = windowOf(params, 'n', 20, 2);
    const out = gaps(input.close.length);
    for (let i = n - 1; i < out.length; i += 1) out[i] = rollingStdev(input.close, n, i);
    return {
      lines: [
        {
          id: 'STDDEV.stdev',
          label: `StdDev(${String(n)})`,
          y: out,
          style: { color: 'auto', width: 1 },
        },
      ],
    };
  },
  update(prev, input, params, lastIndex) {
    const n = windowOf(params, 'n', 20, 2);
    return patchLast(prev, lastIndex, {
      'STDDEV.stdev': rollingStdev(input.close, n, lastIndex),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HVOL — historical volatility (§11.6, n = 30, annualised log returns), through core
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Annualised volatility of the last `n` log returns, in percent points.
 *
 * `logReturns` then `volatility`, both from `core/analytics/stats` — the same pair the API serves
 * `VOL_90D` from — under core's stated conventions (`ddof: 1`, 252 periods, σ·√252). This is the
 * API-05 case that matters most on this file: HVOL is a number a trader compares against the
 * terminal's own `VOL_30D` field, and two implementations of "annualised vol" would differ in the
 * fourth digit for reasons nobody could reconstruct.
 *
 * The one convention HVOL does *not* share with `VOL_30D` is the return basis: §11.6 specifies **log**
 * returns for the study, while the field's derivation is simple returns. That is a real difference of
 * definition rather than a disagreement, and it is why the label says HVOL rather than VOL.
 *
 * `n + 1` prices make `n` returns, so the first value is at slot `n`. Non-positive prices are
 * screened before the call: `logReturns` rejects them with a `RangeError` (a log of a negative price
 * is not a return), and a chart must not take the panel down over one bad bar in a capture — the slot
 * becomes a gap, which is what the renderer already knows how to not draw.
 */
function historicalVolatility(close: Float64Array, n: number, i: number): number {
  if (i < n) return Number.NaN;
  const window: number[] = [];
  for (let j = i - n; j <= i; j += 1) {
    const price = close[j]!;
    if (!Number.isFinite(price) || price <= 0) return Number.NaN;
    window.push(price);
  }
  const returns = logReturns(window);
  return volatility(returns.values).volAnnualised * 100;
}

const HVOL: StudyDef = {
  id: 'HVOL',
  name: 'Historical volatility',
  pane: 'sub',
  params: [{ name: 'n', label: 'Periods', default: 30, min: 2, max: 400, step: 1 }],
  needs: ['close'],
  yFmt: 'pct',
  compute(input, params) {
    const n = windowOf(params, 'n', 30, 2);
    const out = gaps(input.close.length);
    for (let i = n; i < out.length; i += 1) out[i] = historicalVolatility(input.close, n, i);
    return {
      lines: [
        {
          id: 'HVOL.hvol',
          label: `HVOL(${String(n)})`,
          y: out,
          style: { color: 'auto', width: 1 },
        },
      ],
    };
  },
  update(prev, input, params, lastIndex) {
    const n = windowOf(params, 'n', 30, 2);
    return patchLast(prev, lastIndex, {
      'HVOL.hvol': historicalVolatility(input.close, n, lastIndex),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The thirteen
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The sub-pane studies, keyed by the id `studies/index.ts` registers them under.
 *
 * Not a `Record<StudyId, StudyDef>`: these are thirteen of the twenty-two, and the nine `main`
 * studies complete the registry. The key and the `StudyDef.id` are asserted equal by the test, so a
 * copy-paste that leaves `ATR`'s id on a new study cannot reach the picker.
 */
export const oscillatorStudies: Readonly<Record<string, StudyDef>> = Object.freeze({
  VOL,
  RSI,
  MACD,
  STOCH,
  ATR,
  ADX,
  CCI,
  WILLR,
  ROC,
  MOM,
  OBV,
  STDDEV,
  HVOL,
});
