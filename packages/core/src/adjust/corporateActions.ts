/**
 * Corporate-action adjustment (REF-09, DATA_MODEL §6.1, TESTING §7.9).
 *
 * Stored bars are ALWAYS unadjusted (ARCHITECTURE §4.3); the policy is applied on read. This module
 * is the single implementation: `server/src/data/historical.ts` loads unadjusted bars over
 * `[start − 1 session, end]` and `corporate_actions` as-of `asOf`, calls `adjustmentFactors`, and
 * applies the returned `FactorStep[]` with `applyAdjustment` (reporting them in `meta.adjustments`).
 *
 * The three-argument form is the correct one (WORKPLAN L518-528): the cash-dividend factor is
 * `1 − amount / closeBeforeEx`, where `closeBeforeEx` is the **unadjusted** close of the last
 * session strictly before the ex-date (CRSP / Yahoo convention), which cannot be derived from
 * `corporate_actions` rows alone — hence `closes`.
 *
 * Pure and synchronous: no clock, no IO. Dates are ISO `YYYY-MM-DD` strings (or ISO-8601 instants
 * for intraday bars) and compare lexicographically, which is why nothing here touches `Date`.
 */

import type { AdjustPolicy, Bar } from '../types/bars.js';

/** `corporate_actions.ca_type` (CONTRACTS L22), verbatim. */
export type CaType =
  | 'cash_dividend'
  | 'special_dividend'
  | 'stock_dividend'
  | 'split'
  | 'reverse_split'
  | 'spinoff'
  | 'merger'
  | 'tender'
  | 'rights'
  | 'call'
  | 'conversion'
  | 'name_change'
  | 'ticker_change'
  | 'delisting'
  | 'capital_return';

/** `corporate_actions.status` (CONTRACTS L23), verbatim. */
export type CaStatus = 'estimated' | 'announced' | 'confirmed' | 'paid' | 'cancelled';

/** The `corporate_actions` columns the adjustment needs (DATA_MODEL §6.1 L1011). */
export interface CaForAdjust {
  caType: CaType;
  status: CaStatus;
  /** `corporate_actions.ex_date`, `YYYY-MM-DD`. */
  exDate: string;
  /** cash per share, quote currency (`amount`) — dividends, capital return. */
  amount?: number;
  /** 4:1 → `ratioNew = 4`, `ratioOld = 1`; 1:10 reverse → `1` / `10`; 5 % stock dividend → `105` / `100`. */
  ratioNew?: number;
  ratioOld?: number;
}

/**
 * One cumulative-factor step. It applies to bars dated **strictly before** `beforeDate` (the
 * ex-date); steps compose from latest to earliest (DATA_MODEL §6.1 L1014).
 */
export interface FactorStep {
  beforeDate: string;
  priceFactor: number;
  volumeFactor: number;
  kind: 'split' | 'dividend' | 'capital_return';
}

/** The cumulative factors in force on one date, i.e. the product of every step after it. */
export interface DateFactors {
  date: string;
  priceFactor: number;
  volumeFactor: number;
}

/** One point of the total-return index. */
export interface TotalReturnPoint {
  date: string;
  value: number;
}

/**
 * `estimated` is CACS display only and `cancelled` never happened; `announced`, `confirmed` and
 * `paid` all adjust (DATA_MODEL §6.1 L1020, TESTING §7.9 status gating).
 */
const APPLIED_STATUS: ReadonlySet<CaStatus> = new Set<CaStatus>([
  'announced',
  'confirmed',
  'paid',
]);

/** Ratio-driven actions: adjust prices under `price` and `total_return` alike. */
const RATIO_TYPES: ReadonlySet<CaType> = new Set<CaType>([
  'split',
  'reverse_split',
  'stock_dividend',
  'rights',
]);

/** Cash-driven actions: adjust prices under `total_return` only. */
const CASH_TYPES: ReadonlySet<CaType> = new Set<CaType>([
  'cash_dividend',
  'special_dividend',
  'capital_return',
]);

function isFinitePositive(x: number | undefined): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/**
 * The unadjusted close of the last session strictly before `exDate`.
 *
 * `closes` need not be sorted. Throws when the caller did not supply it: WP-04's read path loads
 * `[start − 1 session, end]` precisely so that this close exists for the first action in the window
 * (DATA_MODEL §6.1), and silently dropping the dividend would return a wrong total-return series.
 */
function closeBeforeEx(
  closes: readonly { date: string; close: number }[],
  exDate: string,
): number {
  let bestDate: string | undefined;
  let bestClose = Number.NaN;
  for (const row of closes) {
    if (row.date >= exDate) continue;
    if (bestDate === undefined || row.date > bestDate) {
      bestDate = row.date;
      bestClose = row.close;
    }
  }
  if (bestDate === undefined) {
    throw new RangeError(
      `adjustmentFactors: no close before ex-date ${exDate}; load bars from [start - 1 session] (DATA_MODEL §6.1)`,
    );
  }
  if (!Number.isFinite(bestClose) || bestClose <= 0) {
    throw new RangeError(
      `adjustmentFactors: close before ex-date ${exDate} is ${String(bestClose)}; must be a positive number`,
    );
  }
  return bestClose;
}

/**
 * Per-action price/volume factors for one policy, ascending by `beforeDate`.
 *
 *  - `unadjusted` → always `[]` (REF-09: the stored series is returned untouched).
 *  - split / reverse_split / stock_dividend / rights → `priceFactor = ratioOld / ratioNew`
 *    (2:1 → 0.50), `volumeFactor = 1 / priceFactor` (→ 2). Applied under `price` and `total_return`.
 *  - cash_dividend / special_dividend / capital_return → `priceFactor = 1 − amount / closeBeforeEx`
 *    (TESTING §7.9: `1 − 0.50/50.00 = 0.99`), `volumeFactor = 1`. Applied under `total_return` only.
 *  - every other `ca_type` (spinoff, merger, tender, …) carries no price factor here.
 */
export function adjustmentFactors(
  actions: readonly CaForAdjust[],
  closes: readonly { date: string; close: number }[],
  policy: AdjustPolicy,
): FactorStep[] {
  if (policy === 'unadjusted') return [];

  const steps: FactorStep[] = [];
  for (const action of actions) {
    if (!APPLIED_STATUS.has(action.status)) continue;

    if (RATIO_TYPES.has(action.caType)) {
      const { ratioNew, ratioOld } = action;
      if (!isFinitePositive(ratioNew) || !isFinitePositive(ratioOld)) {
        throw new RangeError(
          `adjustmentFactors: ${action.caType} on ${action.exDate} needs positive ratioNew/ratioOld`,
        );
      }
      const priceFactor = ratioOld / ratioNew;
      steps.push({
        beforeDate: action.exDate,
        priceFactor,
        volumeFactor: 1 / priceFactor,
        kind: 'split',
      });
      continue;
    }

    if (CASH_TYPES.has(action.caType) && policy === 'total_return') {
      const { amount } = action;
      if (!isFinitePositive(amount)) {
        throw new RangeError(
          `adjustmentFactors: ${action.caType} on ${action.exDate} needs a positive amount`,
        );
      }
      const priorClose = closeBeforeEx(closes, action.exDate);
      if (amount >= priorClose) {
        throw new RangeError(
          `adjustmentFactors: ${action.caType} on ${action.exDate} pays ${amount} against a prior close of ${priorClose}`,
        );
      }
      steps.push({
        beforeDate: action.exDate,
        priceFactor: 1 - amount / priorClose,
        volumeFactor: 1,
        kind: action.caType === 'capital_return' ? 'capital_return' : 'dividend',
      });
    }
  }

  steps.sort((a, b) => (a.beforeDate < b.beforeDate ? -1 : a.beforeDate > b.beforeDate ? 1 : 0));
  return steps;
}

/**
 * Suffix products of a `beforeDate`-ascending step list: `price[i]` / `volume[i]` are the cumulative
 * factors carried by a bar dated strictly before `steps[i].beforeDate` — i.e. the product of steps
 * `i..k-1`, composed latest-to-earliest.
 */
function suffixProducts(steps: readonly FactorStep[]): { price: number[]; volume: number[] } {
  const k = steps.length;
  const price = new Array<number>(k + 1).fill(1);
  const volume = new Array<number>(k + 1).fill(1);
  for (let i = k - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    price[i] = step.priceFactor * (price[i + 1]!);
    volume[i] = step.volumeFactor * (volume[i + 1]!);
  }
  return { price, volume };
}

/** First index whose `beforeDate` is strictly greater than `date` (binary search). */
function firstStepAfter(steps: readonly FactorStep[], date: string): number {
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]!).beforeDate <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The cumulative price/volume factors in force on each of `dates` — the "per-date cumulative
 * factors" of WORKPLAN L518. `steps` must be the output of `adjustmentFactors` (ascending by
 * `beforeDate`); `dates` may be in any order.
 */
export function cumulativeFactors(
  dates: readonly string[],
  steps: readonly FactorStep[],
): DateFactors[] {
  const { price, volume } = suffixProducts(steps);
  return dates.map((date) => {
    const i = firstStepAfter(steps, date);
    return {
      date,
      priceFactor: price[i]!,
      volumeFactor: volume[i]!,
    };
  });
}

/**
 * Apply cumulative factors to a bar series. Prices are multiplied by the cumulative price factor of
 * every step strictly after the bar, volume by the cumulative volume factor; `null` volume stays
 * `null`. Input bars are never mutated. O(n + k) on an ascending series (the usual case), O(n log k)
 * otherwise.
 */
export function applyAdjustment(bars: readonly Bar[], steps: readonly FactorStep[]): Bar[] {
  if (bars.length === 0) return [];
  if (steps.length === 0) return bars.map((bar) => ({ ...bar }));

  const { price, volume } = suffixProducts(steps);

  let ascending = true;
  for (let i = 1; i < bars.length; i += 1) {
    if ((bars[i - 1]!).date > (bars[i]!).date) {
      ascending = false;
      break;
    }
  }

  // Ascending fast path: the step pointer only ever moves forward, so the whole series costs
  // O(n + k) rather than a binary search per bar.
  let pointer = 0;
  const out: Bar[] = [];
  for (const bar of bars) {
    let index: number;
    if (ascending) {
      while (pointer < steps.length && (steps[pointer]!).beforeDate <= bar.date) {
        pointer += 1;
      }
      index = pointer;
    } else {
      index = firstStepAfter(steps, bar.date);
    }
    const p = price[index]!;
    const v = volume[index]!;
    const adjusted: Bar = {
      ...bar,
      open: bar.open * p,
      high: bar.high * p,
      low: bar.low * p,
      close: bar.close * p,
      volume: bar.volume === null ? null : bar.volume * v,
    };
    if (typeof bar.vwap === 'number') adjusted.vwap = bar.vwap * p;
    if (typeof bar.officialClose === 'number') adjusted.officialClose = bar.officialClose * p;
    out.push(adjusted);
  }
  return out;
}

/**
 * `TR_t = TR_{t−1} × (P_t + D_t) / P_{t−1}` (DATA_MODEL §6.1 L1025), where `P` is the **split**-
 * adjusted close (so a split is a price change of zero, not a −50 % day) and `D_t` the cash paid
 * with an ex-date on that session, carried onto the same split basis. The base is the first
 * unadjusted close unless `base` is given (HP rebases to 1 at the first row of its window).
 *
 * `actions` is the full `corporate_actions` slice: ratio actions set the split basis, cash actions
 * (`cash_dividend`, `special_dividend`, `capital_return`) supply `D_t`. Status gating is the same as
 * `adjustmentFactors`: `cancelled` and `estimated` are ignored. A cash action whose ex-date is not a
 * session in `bars` is credited to the first bar on or after it.
 */
export function totalReturnIndex(
  bars: readonly Bar[],
  actions: readonly CaForAdjust[],
  base?: number,
): TotalReturnPoint[] {
  if (bars.length === 0) return [];

  const ordered = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const closes = ordered.map((bar) => ({ date: bar.date, close: bar.close }));

  // Policy 'price' keeps only the ratio actions, which is exactly the split basis wanted here.
  const splitSteps = adjustmentFactors(actions, closes, 'price');
  const { price } = suffixProducts(splitSteps);
  const adjustedClose = ordered.map(
    (bar) => bar.close * (price[firstStepAfter(splitSteps, bar.date)]!),
  );

  // Cash per session, on the same split basis as the prices it is added to.
  const cash = new Array<number>(ordered.length).fill(0);
  for (const action of actions) {
    if (!APPLIED_STATUS.has(action.status)) continue;
    if (!CASH_TYPES.has(action.caType)) continue;
    const { amount } = action;
    if (!isFinitePositive(amount)) {
      throw new RangeError(
        `totalReturnIndex: ${action.caType} on ${action.exDate} needs a positive amount`,
      );
    }
    const at = ordered.findIndex((bar) => bar.date >= action.exDate);
    if (at <= 0) continue; // before the series, or on its first bar: no prior close to grow from
    const factor = price[firstStepAfter(splitSteps, action.exDate)]!;
    cash[at] = (cash[at]!) + amount * factor;
  }

  const first = ordered[0]!;
  const out: TotalReturnPoint[] = [{ date: first.date, value: base ?? first.close }];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = adjustedClose[i - 1]!;
    if (!Number.isFinite(prev) || prev <= 0) {
      throw new RangeError(
        `totalReturnIndex: non-positive adjusted close ${String(prev)} on ${(ordered[i - 1]!).date}`,
      );
    }
    const value =
      ((out[i - 1]!).value * ((adjustedClose[i]!) + (cash[i]!))) /
      prev;
    out.push({ date: (ordered[i]!).date, value });
  }
  return out;
}
