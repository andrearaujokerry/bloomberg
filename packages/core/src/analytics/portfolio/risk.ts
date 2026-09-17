/**
 * Portfolio risk — ex-post tracking error (PORT-04), historical and parametric VaR (PORT-06) and
 * scenario shocks (PORT-05). WORKPLAN L516-517, ARCHITECTURE L178, FUNCTIONS_TIER2 L1449-1450
 * (`portfolio/risk@1.0.0`).
 *
 * Every convention that could be argued about is named in the returned `Conventions` object
 * (ANAL-07), because each of these three numbers has a folk definition that differs from the next
 * desk's by more than the number itself:
 *
 *   - **tracking error** is the *ex-post* dispersion of `portfolio − benchmark` per period,
 *     `ddof = 1` by default, annualised by `×√252` — the stats module's own conventions, reused
 *     rather than re-stated (TESTING §7.8).
 *   - **historical VaR** is the `(100 − confidence)`-th percentile of the realised return series
 *     (FUNCTIONS_TIER2 L1449), by the linear (type-7) percentile by default, reported as a
 *     **positive loss**.
 *   - **parametric VaR** is `z(confidence) × σ` with a **zero** mean assumption, normal returns,
 *     one-period horizon — again exactly FUNCTIONS_TIER2 L1449, with the mean-adjusted variant
 *     available behind a convention flag rather than silently chosen.
 *
 * Monte-Carlo VaR is deliberately absent (`VAR_MC_NOT_IN_V1`, FUNCTIONS_TIER2 L1449) and there is
 * no factor model (`NO_FACTOR_MODEL`, TRACEABILITY PORT-04) — the ex-post statistics here are the
 * documented partial implementation, not a stand-in for one.
 *
 * Pure: no clock, no IO, no `Date`.
 */

import { defineEngine } from '../engine.js';
import { normalCdf, normalPdf } from '../options/bsm.js';
import type { StatsConventionOverrides, StatsConventions } from '../stats/index.js';
import {
  annualiseMean,
  meanOf,
  resolveStatsConventions,
  stdevOf,
  volAnnualisationFactor,
} from '../stats/index.js';

import type { PortfolioAssetClass } from './exposure.js';
import { compensatedSum } from './exposure.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conventions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How the historical percentile is taken.
 *
 *   - `linear` — the type-7 percentile (`h = p·(n−1)`, linear interpolation between the two
 *     bracketing order statistics). The Excel `PERCENTILE.INC` / NumPy / R default.
 *   - `nearest-rank` — the `⌈p·n⌉`-th order statistic. No interpolation, so the answer is always
 *     an actually observed return; the classic historical-simulation choice.
 */
export type PercentileMethod = 'linear' | 'nearest-rank';

/** Overrides accepted by every entry point in this module. */
export interface PortfolioRiskConventionOverrides extends StatsConventionOverrides {
  readonly percentileMethod?: PercentileMethod;
  /** Include the sample mean in parametric VaR (`z·σ − μ`). Default `false` (zero-mean). */
  readonly parametricMeanAdjusted?: boolean;
  /** Confidence level as a decimal fraction, `0.95` = 95 %. */
  readonly varConfidence?: number;
  /** VaR horizon in periods; `√h` scaling on the parametric figure. Default 1. */
  readonly varHorizonPeriods?: number;
  readonly baseCurrency?: string;
}

/** The risk convention set, echoed in the outputs (ANAL-07). */
export interface PortfolioRiskConventions extends StatsConventions {
  readonly percentileMethod: PercentileMethod;
  readonly parametricMeanAdjusted: boolean;
  readonly varConfidence: number;
  readonly varHorizonPeriods: number;
  readonly baseCurrency: string;
  readonly trackingErrorBasis: string;
  readonly historicalVarBasis: string;
  readonly parametricVarBasis: string;
  readonly varSign: string;
  readonly expectedShortfallBasis: string;
  readonly varBacktestBasis: string;
  readonly monteCarloVar: string;
  readonly factorModel: string;
  readonly dv01Sign: string;
  readonly equityShockBasis: string;
  readonly fxShockBasis: string;
  readonly scenarioBasis: string;
}

const FIXED_RISK_CONVENTIONS = {
  trackingErrorBasis:
    'ex-post: stdev(portfolio − benchmark) per period under ddof, annualised by × √annualisation',
  historicalVarBasis:
    'the (1 − confidence) quantile of the realised return series (FUNCTIONS_TIER2 L1449)',
  parametricVarBasis:
    'z(confidence) × stdev × √horizon, normal returns, one-period i.i.d. (FUNCTIONS_TIER2 L1449)',
  varSign:
    'varReturn is a positive loss magnitude: varReturn = −quantileReturn; a negative varReturn means the quantile is a gain',
  expectedShortfallBasis:
    'mean of the returns at or below the historical quantile (historical CVaR)',
  varBacktestBasis:
    'rolling: VaR for session t is estimated from the preceding `window` sessions; an exception is return[t] < −VaR[t]; expected = sessions × (1 − confidence)',
  monteCarloVar: 'not computed: VAR_MC_NOT_IN_V1 (FUNCTIONS_TIER2 L1449, PORT-06 gap)',
  factorModel:
    'none: NO_FACTOR_MODEL — no licensable multi-factor risk model in this wedge (PORT-04 gap)',
  dv01Sign:
    'dv01 is positive for a long conventional bond — the base-currency value lost per +1bp yield rise (bond/risk.ts); P&L = −dv01 × shiftBp',
  equityShockBasis:
    'P&L = marketValue × beta × shockPct; beta defaults to 1 for equity/etf/index, 0 otherwise',
  fxShockBasis:
    'baseAppreciationPct is the appreciation of the base currency; a non-base holding reprices by 1/(1 + p) − 1 (exact, not the linear approximation)',
  scenarioBasis:
    'instantaneous, first-order: DV01 and beta sensitivities held constant, no convexity, no cross-effects, no time decay',
} as const;

/** The default risk conventions: TESTING §7.8 statistics, 95 % VaR, type-7 percentile, USD. */
export const DEFAULT_PORTFOLIO_RISK_CONVENTIONS: PortfolioRiskConventions = Object.freeze({
  ...resolveStatsConventions(),
  percentileMethod: 'linear',
  parametricMeanAdjusted: false,
  varConfidence: 0.95,
  varHorizonPeriods: 1,
  baseCurrency: 'USD',
  ...FIXED_RISK_CONVENTIONS,
} satisfies PortfolioRiskConventions);

/** Merge overrides onto {@link DEFAULT_PORTFOLIO_RISK_CONVENTIONS} and validate. */
export function resolvePortfolioRiskConventions(
  overrides?: PortfolioRiskConventionOverrides,
): PortfolioRiskConventions {
  const stats = resolveStatsConventions(overrides);
  const percentileMethod =
    overrides?.percentileMethod ?? DEFAULT_PORTFOLIO_RISK_CONVENTIONS.percentileMethod;
  if (percentileMethod !== 'linear' && percentileMethod !== 'nearest-rank') {
    throw new RangeError(
      `risk: conventions.percentileMethod must be 'linear' or 'nearest-rank', got '${String(percentileMethod)}'`,
    );
  }
  const varConfidence =
    overrides?.varConfidence ?? DEFAULT_PORTFOLIO_RISK_CONVENTIONS.varConfidence;
  if (!Number.isFinite(varConfidence) || varConfidence <= 0 || varConfidence >= 1) {
    throw new RangeError(
      `risk: conventions.varConfidence must be a decimal fraction strictly between 0 and 1 (0.95 = 95 %), got ${String(varConfidence)}`,
    );
  }
  const varHorizonPeriods =
    overrides?.varHorizonPeriods ?? DEFAULT_PORTFOLIO_RISK_CONVENTIONS.varHorizonPeriods;
  if (!Number.isFinite(varHorizonPeriods) || varHorizonPeriods <= 0) {
    throw new RangeError(
      `risk: conventions.varHorizonPeriods must be a positive number of periods, got ${String(varHorizonPeriods)}`,
    );
  }
  const baseCurrency = overrides?.baseCurrency ?? DEFAULT_PORTFOLIO_RISK_CONVENTIONS.baseCurrency;
  if (typeof baseCurrency !== 'string' || baseCurrency.length === 0) {
    throw new RangeError('risk: conventions.baseCurrency must be a non-empty ISO 4217 code');
  }
  return Object.freeze({
    ...stats,
    percentileMethod,
    parametricMeanAdjusted:
      overrides?.parametricMeanAdjusted ??
      DEFAULT_PORTFOLIO_RISK_CONVENTIONS.parametricMeanAdjusted,
    varConfidence,
    varHorizonPeriods,
    baseCurrency,
    ...FIXED_RISK_CONVENTIONS,
  } satisfies PortfolioRiskConventions);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The normal quantile
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
] as const;
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
] as const;

const P_LOW = 0.02425;

function acklamTail(q: number): number {
  const [c0, c1, c2, c3, c4, c5] = ACKLAM_C;
  const [d0, d1, d2, d3] = ACKLAM_D;
  return (
    (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
    ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
  );
}

/**
 * The inverse standard-normal CDF, `Φ⁻¹(p)` — the `z` of "z(confidence) × dailyVol".
 *
 * Acklam's rational approximation (relative error < 1.15e-9) followed by two Halley refinements
 * against {@link normalCdf}, which takes it to double precision: `Φ⁻¹(0.95) = 1.6448536269514722`,
 * `Φ⁻¹(0.99) = 2.3263478740408408`.
 */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) {
    throw new RangeError(`risk: normalQuantile needs 0 < p < 1, got ${String(p)}`);
  }
  let x: number;
  if (p < P_LOW) {
    x = acklamTail(Math.sqrt(-2 * Math.log(p)));
  } else if (p > 1 - P_LOW) {
    x = -acklamTail(Math.sqrt(-2 * Math.log(1 - p)));
  } else {
    const [a0, a1, a2, a3, a4, a5] = ACKLAM_A;
    const [b0, b1, b2, b3, b4] = ACKLAM_B;
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
      (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1);
  }
  // Halley: e = Φ(x) − p, u = e / φ(x); x ← x − u / (1 + x·u/2).
  for (let i = 0; i < 2; i += 1) {
    const e = normalCdf(x) - p;
    const density = normalPdf(x);
    if (density === 0) break;
    const u = e / density;
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Percentiles
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Assert without narrowing — see the note on `exposure.ts`'s twin. */
function requireArray(label: string, xs: unknown): void {
  if (!Array.isArray(xs)) {
    throw new TypeError(`risk: ${label} must be an array`);
  }
}

function requireReturns(label: string, xs: readonly number[], minLength: number): void {
  requireArray(label, xs);
  if (xs.length < minLength) {
    throw new RangeError(
      `risk: ${label} needs at least ${minLength} observations, got ${xs.length}`,
    );
  }
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new RangeError(`risk: ${label}[${i}] must be a finite number, got ${String(x)}`);
    }
  }
}

/**
 * The `p` quantile of `xs` under the stated {@link PercentileMethod}. `p` is a decimal fraction:
 * the 5th percentile is `p = 0.05`.
 */
export function percentileOf(
  xs: readonly number[],
  p: number,
  method: PercentileMethod = 'linear',
): number {
  requireReturns('series', xs, 1);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`risk: percentile p must be in [0, 1], got ${String(p)}`);
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (method === 'nearest-rank') {
    const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
    return sorted[rank - 1]!;
  }
  const h = p * (n - 1);
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  const frac = h - lo;
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + frac * (b - a);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Ex-post tracking error (PORT-04)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link trackingError} returns. */
export interface TrackingErrorResult {
  readonly n: number;
  /** `mean(portfolio − benchmark)` per period. */
  readonly activeMeanPeriod: number;
  /** The active mean annualised under `meanAnnualisation`. */
  readonly activeReturnAnnualised: number;
  /** `stdev(active, ddof)` per period. */
  readonly trackingErrorPeriod: number;
  /** `trackingErrorPeriod × √annualisation`. */
  readonly trackingErrorAnnualised: number;
  /** `activeReturnAnnualised / trackingErrorAnnualised`; `null` when tracking error is zero. */
  readonly informationRatio: number | null;
  /** The per-period active return series, in input order. */
  readonly activeReturns: readonly number[];
  readonly conventions: PortfolioRiskConventions;
}

/**
 * Ex-post tracking error: the dispersion of the realised active return. Unlike
 * `stats.informationRatio`, a zero tracking error is reported as `informationRatio: null` rather
 * than thrown — an index fund that matched its benchmark exactly is a legitimate portfolio.
 */
export function trackingError(
  portfolio: readonly number[],
  benchmark: readonly number[],
  conventions?: PortfolioRiskConventionOverrides,
): TrackingErrorResult {
  const conv = resolvePortfolioRiskConventions(conventions);
  requireReturns('portfolio', portfolio, conv.ddof + 1);
  requireReturns('benchmark', benchmark, conv.ddof + 1);
  if (portfolio.length !== benchmark.length) {
    throw new RangeError(
      `risk: portfolio (${portfolio.length}) and benchmark (${benchmark.length}) must have the same length`,
    );
  }
  const active = portfolio.map((r, i) => r - benchmark[i]!);
  const activeMeanPeriod = meanOf(active);
  const tePeriod = stdevOf(active, conv.ddof);
  const teAnnualised = tePeriod * volAnnualisationFactor(conv);
  const activeReturnAnnualised = annualiseMean(activeMeanPeriod, conv);
  return Object.freeze({
    n: active.length,
    activeMeanPeriod,
    activeReturnAnnualised,
    trackingErrorPeriod: tePeriod,
    trackingErrorAnnualised: teAnnualised,
    informationRatio: teAnnualised === 0 ? null : activeReturnAnnualised / teAnnualised,
    activeReturns: Object.freeze(active),
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VaR (PORT-06)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What {@link historicalVar} and {@link parametricVar} return. */
export interface VarResult {
  readonly method: 'historical' | 'parametric';
  readonly n: number;
  readonly confidence: number;
  /** The signed return at the quantile; `null` for the parametric method's normal quantile echo. */
  readonly quantileReturn: number;
  /** Positive loss magnitude, as a decimal fraction of portfolio value. */
  readonly varReturn: number;
  /** `varReturn × portfolioValue`, positive. */
  readonly varAmount: number;
  /** Historical CVaR — mean of the tail at or below the quantile. `null` for parametric. */
  readonly expectedShortfallReturn: number | null;
  readonly expectedShortfallAmount: number | null;
  /** Observations in the tail used for the expected shortfall; `null` for parametric. */
  readonly tailCount: number | null;
  /** `Φ⁻¹(confidence)`; `null` for the historical method. */
  readonly zScore: number | null;
  readonly conventions: PortfolioRiskConventions;
}

/**
 * Historical-simulation VaR: the `(1 − confidence)` quantile of the realised return series
 * (FUNCTIONS_TIER2 L1449 "the (100 − confidence)-th percentile of the return series"), plus the
 * historical expected shortfall of the same tail.
 */
export function historicalVar(
  returns: readonly number[],
  conventions?: PortfolioRiskConventionOverrides,
  portfolioValue = 1,
): VarResult {
  const conv = resolvePortfolioRiskConventions(conventions);
  requireReturns('returns', returns, 1);
  if (!Number.isFinite(portfolioValue)) {
    throw new RangeError(
      `risk: portfolioValue must be a finite number, got ${String(portfolioValue)}`,
    );
  }
  const p = 1 - conv.varConfidence;
  const quantileReturn = percentileOf(returns, p, conv.percentileMethod);
  const tail = returns.filter((r) => r <= quantileReturn);
  const esReturn = tail.length === 0 ? null : -(compensatedSum(tail) / tail.length);
  const varReturn = -quantileReturn;
  return Object.freeze({
    method: 'historical',
    n: returns.length,
    confidence: conv.varConfidence,
    quantileReturn,
    varReturn,
    varAmount: varReturn * portfolioValue,
    expectedShortfallReturn: esReturn,
    expectedShortfallAmount: esReturn === null ? null : esReturn * portfolioValue,
    tailCount: tail.length,
    zScore: null,
    conventions: conv,
  });
}

/**
 * Parametric (variance–covariance) VaR: `z(confidence) × σ × √horizon`, zero-mean by default
 * (FUNCTIONS_TIER2 L1449 "`parametric` = z(confidence) × dailyVol"). Set
 * `conventions.parametricMeanAdjusted = true` for `z·σ·√h − μ·h`.
 *
 * Assumptions, all stated in `conventions`: returns are i.i.d. normal, the horizon scales the
 * standard deviation by `√h`, and the distribution is estimated from this very window.
 */
export function parametricVar(
  returns: readonly number[],
  conventions?: PortfolioRiskConventionOverrides,
  portfolioValue = 1,
): VarResult {
  const conv = resolvePortfolioRiskConventions(conventions);
  requireReturns('returns', returns, conv.ddof + 1);
  if (!Number.isFinite(portfolioValue)) {
    throw new RangeError(
      `risk: portfolioValue must be a finite number, got ${String(portfolioValue)}`,
    );
  }
  const mean = meanOf(returns);
  const sigma = stdevOf(returns, conv.ddof);
  const z = normalQuantile(conv.varConfidence);
  const h = conv.varHorizonPeriods;
  const scaled = sigma * Math.sqrt(h);
  const varReturn = z * scaled - (conv.parametricMeanAdjusted ? mean * h : 0);
  return Object.freeze({
    method: 'parametric',
    n: returns.length,
    confidence: conv.varConfidence,
    quantileReturn: -varReturn,
    varReturn,
    varAmount: varReturn * portfolioValue,
    expectedShortfallReturn: null,
    expectedShortfallAmount: null,
    tailCount: null,
    zScore: z,
    conventions: conv,
  });
}

/** What {@link varBacktest} returns. */
export interface VarBacktestResult {
  readonly method: 'historical' | 'parametric';
  readonly window: number;
  /** Sessions actually tested: `returns.length − window`. */
  readonly sessions: number;
  readonly exceptions: number;
  /** `sessions × (1 − confidence)` (FUNCTIONS_TIER2 L1449). */
  readonly expectedExceptions: number;
  /** `exceptions / sessions`; `null` when no session could be tested. */
  readonly exceptionRate: number | null;
  /** 0-based indices into `returns` of the sessions that breached. */
  readonly exceptionIndices: readonly number[];
  readonly conventions: PortfolioRiskConventions;
}

/**
 * Rolling exception backtest (PORT-06 "backtesting of exceptions"): for each session `t ≥ window`,
 * estimate VaR from `returns[t − window … t − 1]` and count `returns[t] < −VaR` as an exception.
 * The VaR for session `t` never sees session `t`, which is the whole point of a backtest.
 */
export function varBacktest(
  returns: readonly number[],
  window: number,
  method: 'historical' | 'parametric' = 'historical',
  conventions?: PortfolioRiskConventionOverrides,
): VarBacktestResult {
  const conv = resolvePortfolioRiskConventions(conventions);
  requireReturns('returns', returns, 1);
  if (!Number.isInteger(window) || window < conv.ddof + 1) {
    throw new RangeError(
      `risk: backtest window must be an integer ≥ ${conv.ddof + 1}, got ${String(window)}`,
    );
  }
  const exceptionIndices: number[] = [];
  let sessions = 0;
  for (let t = window; t < returns.length; t += 1) {
    const sample = returns.slice(t - window, t);
    const v =
      method === 'parametric'
        ? parametricVar(sample, conventions).varReturn
        : historicalVar(sample, conventions).varReturn;
    sessions += 1;
    if (returns[t]! < -v) exceptionIndices.push(t);
  }
  return Object.freeze({
    method,
    window,
    sessions,
    exceptions: exceptionIndices.length,
    expectedExceptions: sessions * (1 - conv.varConfidence),
    exceptionRate: sessions === 0 ? null : exceptionIndices.length / sessions,
    exceptionIndices: Object.freeze(exceptionIndices),
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scenario shocks (PORT-05)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One holding, with the first-order sensitivities a scenario needs. */
export interface RiskHolding {
  readonly instrumentId: string;
  readonly assetClass: PortfolioAssetClass;
  /** ISO 4217 code the position is exposed to; compared against `conventions.baseCurrency`. */
  readonly currency: string;
  /** Base-currency market value, signed (negative for a short). */
  readonly marketValue: number;
  /** Equity beta against the shock factor. Defaults to 1 for equity/etf/index, 0 otherwise. */
  readonly beta?: number;
  /** Base-currency value lost per +1bp parallel yield rise — `bond/risk.ts`'s sign. */
  readonly dv01?: number;
  /** Per-key-rate-tenor DV01, same sign convention; the tenor keys are the caller's labels. */
  readonly keyRateDv01?: Readonly<Record<string, number>>;
}

/** A parallel shift of the whole yield curve. */
export interface CurveParallelShock {
  readonly kind: 'curveParallel';
  /** Basis points; `+100` is a 100bp sell-off. */
  readonly shiftBp: number;
}

/** A non-parallel shift: basis points per key-rate tenor. Tenors absent from the map shift 0. */
export interface CurveKeyRateShock {
  readonly kind: 'curveKeyRate';
  readonly shiftBp: Readonly<Record<string, number>>;
}

/** A broad equity move, transmitted through each holding's beta. */
export interface EquityShock {
  readonly kind: 'equity';
  /** Decimal fraction; `−0.10` is a 10 % sell-off. */
  readonly shockPct: number;
}

/** A move in the base currency against everything else. */
export interface FxShock {
  readonly kind: 'fx';
  /** Decimal fraction; `+0.05` is a 5 % appreciation of the base currency. */
  readonly baseAppreciationPct: number;
  /** Restrict the move to these currencies; omit for every non-base currency. */
  readonly currencies?: readonly string[];
}

/** The shocks a scenario can be built from (PORT-05: curve, equity, FX). */
export type ScenarioShock = CurveParallelShock | CurveKeyRateShock | EquityShock | FxShock;

/** A named scenario: one or more shocks applied together. */
export interface Scenario {
  readonly id: string;
  readonly description: string;
  readonly shocks: readonly ScenarioShock[];
}

/** Per-holding P&L under one scenario. */
export interface HoldingScenarioPnl {
  readonly instrumentId: string;
  readonly pnl: number;
  /** `pnl / |marketValue|`; `null` when the holding has no market value. */
  readonly pnlPct: number | null;
  /**
   * `true` when the scenario should have moved this holding but the sensitivity it needed was
   * absent — a rate-sensitive holding with no `dv01`/`keyRateDv01`. Never silently zero.
   */
  readonly unpriced: boolean;
}

/** What {@link applyScenario} returns. */
export interface ScenarioResult {
  readonly id: string;
  readonly description: string;
  /** Base-currency P&L, signed. */
  readonly pnl: number;
  /** `pnl / netAssetValue`; `null` when NAV is zero. */
  readonly pnlPct: number | null;
  readonly netAssetValue: number;
  readonly byHolding: readonly HoldingScenarioPnl[];
  /** Instruments that needed a sensitivity the input did not carry. */
  readonly unpricedInstrumentIds: readonly string[];
}

/** Asset classes that carry outright yield-curve risk. */
const RATE_SENSITIVE: ReadonlySet<PortfolioAssetClass> = new Set<PortfolioAssetClass>([
  'govt',
  'rate',
]);

/** Asset classes whose default equity beta is 1. */
const EQUITY_LIKE: ReadonlySet<PortfolioAssetClass> = new Set<PortfolioAssetClass>([
  'equity',
  'etf',
  'index',
]);

/**
 * The seven scenarios FUNCTIONS_TIER2 L1450 names. `UST_STEEPEN_50` is spelled out as a
 * pivot-at-5Y 2s10s steepener — the short end down 25bp, the long end up 25bp, so 2s10s widens by
 * the advertised 50bp — because "steepen 50" alone does not determine a shift vector.
 */
export const NAMED_SCENARIOS: Readonly<Record<string, Scenario>> = Object.freeze({
  UST_PARALLEL_UP_100: Object.freeze({
    id: 'UST_PARALLEL_UP_100',
    description: 'UST curve +100bp parallel',
    shocks: Object.freeze([{ kind: 'curveParallel', shiftBp: 100 }] as const),
  }),
  UST_PARALLEL_DN_100: Object.freeze({
    id: 'UST_PARALLEL_DN_100',
    description: 'UST curve −100bp parallel',
    shocks: Object.freeze([{ kind: 'curveParallel', shiftBp: -100 }] as const),
  }),
  UST_STEEPEN_50: Object.freeze({
    id: 'UST_STEEPEN_50',
    description: 'UST 2s10s steepens 50bp: short end −25bp, long end +25bp, pivot at 5Y',
    shocks: Object.freeze([
      {
        kind: 'curveKeyRate',
        shiftBp: Object.freeze({
          '3M': -25,
          '6M': -25,
          '1Y': -25,
          '2Y': -25,
          '3Y': -12.5,
          '5Y': 0,
          '7Y': 12.5,
          '10Y': 25,
          '20Y': 25,
          '30Y': 25,
        }),
      },
    ] as const),
  }),
  EQUITY_DOWN_10: Object.freeze({
    id: 'EQUITY_DOWN_10',
    description: 'Broad equity market −10 %, transmitted through beta',
    shocks: Object.freeze([{ kind: 'equity', shockPct: -0.1 }] as const),
  }),
  EQUITY_DOWN_20: Object.freeze({
    id: 'EQUITY_DOWN_20',
    description: 'Broad equity market −20 %, transmitted through beta',
    shocks: Object.freeze([{ kind: 'equity', shockPct: -0.2 }] as const),
  }),
  USD_UP_5: Object.freeze({
    id: 'USD_UP_5',
    description: 'Base currency +5 % against every other currency',
    shocks: Object.freeze([{ kind: 'fx', baseAppreciationPct: 0.05 }] as const),
  }),
  USD_DN_5: Object.freeze({
    id: 'USD_DN_5',
    description: 'Base currency −5 % against every other currency',
    shocks: Object.freeze([{ kind: 'fx', baseAppreciationPct: -0.05 }] as const),
  }),
});

/** Resolve a scenario name from {@link NAMED_SCENARIOS}, or pass a literal scenario through. */
export function resolveScenario(scenario: Scenario | string): Scenario {
  if (typeof scenario !== 'string') return scenario;
  const named = NAMED_SCENARIOS[scenario];
  if (named === undefined) {
    throw new RangeError(
      `risk: unknown scenario '${scenario}'; known: ${Object.keys(NAMED_SCENARIOS).join(', ')}`,
    );
  }
  return named;
}

/** The effective equity beta of a holding: explicit, else 1 for equity-like, else 0. */
export function effectiveBeta(holding: RiskHolding): number {
  if (holding.beta !== undefined) {
    if (!Number.isFinite(holding.beta)) {
      throw new RangeError(`risk: holding '${holding.instrumentId}' beta must be finite`);
    }
    return holding.beta;
  }
  return EQUITY_LIKE.has(holding.assetClass) ? 1 : 0;
}

function shockPnl(
  shock: ScenarioShock,
  holding: RiskHolding,
  baseCurrency: string,
): { pnl: number; unpriced: boolean } {
  switch (shock.kind) {
    case 'curveParallel': {
      if (holding.dv01 === undefined) {
        const keyRate = holding.keyRateDv01;
        if (keyRate !== undefined) {
          const total = compensatedSum(Object.values(keyRate));
          return { pnl: -total * shock.shiftBp, unpriced: false };
        }
        return { pnl: 0, unpriced: RATE_SENSITIVE.has(holding.assetClass) };
      }
      return { pnl: -holding.dv01 * shock.shiftBp, unpriced: false };
    }
    case 'curveKeyRate': {
      const keyRate = holding.keyRateDv01;
      if (keyRate === undefined) {
        return { pnl: 0, unpriced: RATE_SENSITIVE.has(holding.assetClass) };
      }
      const terms = Object.entries(keyRate).map(([tenor, dv]) => -dv * (shock.shiftBp[tenor] ?? 0));
      return { pnl: compensatedSum(terms), unpriced: false };
    }
    case 'equity': {
      return {
        pnl: holding.marketValue * effectiveBeta(holding) * shock.shockPct,
        unpriced: false,
      };
    }
    case 'fx': {
      const applies =
        holding.currency !== baseCurrency &&
        (shock.currencies === undefined || shock.currencies.includes(holding.currency));
      if (!applies) return { pnl: 0, unpriced: false };
      const p = shock.baseAppreciationPct;
      if (p <= -1) {
        throw new RangeError(
          `risk: fx shock baseAppreciationPct must be > −1 (a base currency cannot lose all its value), got ${String(p)}`,
        );
      }
      return { pnl: holding.marketValue * (1 / (1 + p) - 1), unpriced: false };
    }
    default: {
      const bad = shock as { kind: string };
      throw new RangeError(`risk: unknown scenario shock kind '${String(bad.kind)}'`);
    }
  }
}

/**
 * Reprice a book under one scenario, first order.
 *
 * Curve shocks go through DV01 (`P&L = −dv01 × shiftBp`, so a long bond loses when yields rise);
 * a parallel shock falls back to the sum of the key-rate DV01s when no aggregate `dv01` is given.
 * Equity shocks go through beta. FX shocks reprice every non-base-currency holding by
 * `1/(1 + p) − 1`. Equities are unaffected by curve shocks and bonds by equity shocks *by
 * construction*, which is a modelling choice, not an oversight (FUNCTIONS_TIER2 L1450).
 */
export function applyScenario(
  holdings: readonly RiskHolding[],
  scenario: Scenario | string,
  conventions?: PortfolioRiskConventionOverrides,
): ScenarioResult {
  const conv = resolvePortfolioRiskConventions(conventions);
  const spec = resolveScenario(scenario);
  requireArray('holdings', holdings);
  requireArray(`scenario '${spec.id}' shocks`, spec.shocks);
  if (spec.shocks.length === 0) {
    throw new RangeError(`risk: scenario '${spec.id}' has no shocks`);
  }

  const byHolding: HoldingScenarioPnl[] = holdings.map((h) => {
    if (!Number.isFinite(h.marketValue)) {
      throw new RangeError(`risk: holding '${h.instrumentId}' marketValue must be finite`);
    }
    let unpriced = false;
    const legs: number[] = [];
    for (const shock of spec.shocks) {
      const leg = shockPnl(shock, h, conv.baseCurrency);
      legs.push(leg.pnl);
      if (leg.unpriced) unpriced = true;
    }
    const pnl = compensatedSum(legs);
    return {
      instrumentId: h.instrumentId,
      pnl,
      pnlPct: h.marketValue === 0 ? null : pnl / Math.abs(h.marketValue),
      unpriced,
    };
  });

  const nav = compensatedSum(holdings.map((h) => h.marketValue));
  const pnl = compensatedSum(byHolding.map((h) => h.pnl));
  return Object.freeze({
    id: spec.id,
    description: spec.description,
    pnl,
    pnlPct: nav === 0 ? null : pnl / nav,
    netAssetValue: nav,
    byHolding: Object.freeze(byHolding),
    unpricedInstrumentIds: Object.freeze(
      byHolding.filter((h) => h.unpriced).map((h) => h.instrumentId),
    ),
  });
}

/** Run a list of scenarios over the same book. */
export function scenarioAnalysis(
  holdings: readonly RiskHolding[],
  scenarios: readonly (Scenario | string)[],
  conventions?: PortfolioRiskConventionOverrides,
): ScenarioResult[] {
  return scenarios.map((s) => applyScenario(holdings, s, conventions));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The declared input set of the `portfolio/risk` engine. */
export type PortfolioRiskInputs = {
  /** The portfolio's per-period return series, decimal fractions. */
  readonly returns: readonly number[];
  /** Benchmark returns aligned with `returns`; enables tracking error and the information ratio. */
  readonly benchmark?: readonly number[];
  /** Base-currency portfolio value used to turn a VaR fraction into an amount. Default 1. */
  readonly portfolioValue?: number;
  /** Holdings with their sensitivities; required for scenarios. */
  readonly holdings?: readonly RiskHolding[];
  /** Scenario names from {@link NAMED_SCENARIOS} or literal {@link Scenario}s. */
  readonly scenarios?: readonly (Scenario | string)[];
  /** Rolling VaR backtest window in periods; omit to skip the backtest. */
  readonly backtestWindow?: number;
  readonly conventions?: PortfolioRiskConventionOverrides;
};

/** Everything the `portfolio/risk` engine reports, flat enough for a golden case to pin by key. */
export interface PortfolioRiskSummary {
  readonly n: number;
  readonly meanPeriod: number;
  readonly stdevPeriod: number;
  readonly volAnnualised: number;

  readonly activeMeanPeriod: number | null;
  readonly activeReturnAnnualised: number | null;
  readonly trackingErrorPeriod: number | null;
  readonly trackingErrorAnnualised: number | null;
  readonly informationRatio: number | null;

  readonly varConfidence: number;
  readonly varZScore: number;
  readonly historicalVarReturn: number;
  readonly historicalVarAmount: number;
  readonly historicalQuantileReturn: number;
  readonly expectedShortfallReturn: number | null;
  readonly expectedShortfallAmount: number | null;
  readonly parametricVarReturn: number;
  readonly parametricVarAmount: number;
  /** Always `null`: VAR_MC_NOT_IN_V1 (FUNCTIONS_TIER2 L1449). */
  readonly monteCarloVarReturn: null;

  readonly backtestSessions: number | null;
  readonly backtestExceptions: number | null;
  readonly backtestExpectedExceptions: number | null;
  readonly backtestExceptionRate: number | null;

  readonly netAssetValue: number | null;
  readonly scenarios: readonly ScenarioResult[];
  readonly scenarioWorstId: string | null;
  readonly scenarioWorstPnl: number | null;
  readonly scenarioTotalPnl: number | null;

  readonly conventions: PortfolioRiskConventions;
}

/** Compute the whole risk panel over one return series (and optionally a book and scenarios). */
export function portfolioRisk(inputs: PortfolioRiskInputs): PortfolioRiskSummary {
  const conv = resolvePortfolioRiskConventions(inputs.conventions);
  const returns = inputs.returns;
  requireReturns('returns', returns, conv.ddof + 1);
  const portfolioValue = inputs.portfolioValue ?? 1;

  const meanPeriod = meanOf(returns);
  const stdevPeriod = stdevOf(returns, conv.ddof);
  const te =
    inputs.benchmark === undefined
      ? null
      : trackingError(returns, inputs.benchmark, inputs.conventions);

  const hist = historicalVar(returns, inputs.conventions, portfolioValue);
  const para = parametricVar(returns, inputs.conventions, portfolioValue);
  const back =
    inputs.backtestWindow === undefined
      ? null
      : varBacktest(returns, inputs.backtestWindow, 'historical', inputs.conventions);

  const holdings = inputs.holdings;
  const scenarios =
    holdings === undefined || inputs.scenarios === undefined
      ? []
      : scenarioAnalysis(holdings, inputs.scenarios, inputs.conventions);
  let worst: ScenarioResult | null = null;
  for (const s of scenarios) {
    if (worst === null || s.pnl < worst.pnl) worst = s;
  }

  return Object.freeze({
    n: returns.length,
    meanPeriod,
    stdevPeriod,
    volAnnualised: stdevPeriod * volAnnualisationFactor(conv),

    activeMeanPeriod: te === null ? null : te.activeMeanPeriod,
    activeReturnAnnualised: te === null ? null : te.activeReturnAnnualised,
    trackingErrorPeriod: te === null ? null : te.trackingErrorPeriod,
    trackingErrorAnnualised: te === null ? null : te.trackingErrorAnnualised,
    informationRatio: te === null ? null : te.informationRatio,

    varConfidence: conv.varConfidence,
    varZScore: normalQuantile(conv.varConfidence),
    historicalVarReturn: hist.varReturn,
    historicalVarAmount: hist.varAmount,
    historicalQuantileReturn: hist.quantileReturn,
    expectedShortfallReturn: hist.expectedShortfallReturn,
    expectedShortfallAmount: hist.expectedShortfallAmount,
    parametricVarReturn: para.varReturn,
    parametricVarAmount: para.varAmount,
    monteCarloVarReturn: null,

    backtestSessions: back === null ? null : back.sessions,
    backtestExceptions: back === null ? null : back.exceptions,
    backtestExpectedExceptions: back === null ? null : back.expectedExceptions,
    backtestExceptionRate: back === null ? null : back.exceptionRate,

    netAssetValue:
      holdings === undefined ? null : compensatedSum(holdings.map((h) => h.marketValue)),
    scenarios: Object.freeze(scenarios),
    scenarioWorstId: worst === null ? null : worst.id,
    scenarioWorstPnl: worst === null ? null : worst.pnl,
    scenarioTotalPnl: scenarios.length === 0 ? null : compensatedSum(scenarios.map((s) => s.pnl)),

    conventions: conv,
  });
}

/**
 * `portfolio/risk@1.0.0` (FUNCTIONS_TIER2 L1435, PORT-04/05/06), wrapped in `defineEngine` so a
 * result carries its inputs, the engine identity and the `char(64)` `inputsHash` (ANAL-08).
 */
export const portfolioRiskEngine = defineEngine<PortfolioRiskInputs, PortfolioRiskSummary>(
  'portfolio/risk',
  '1.0.0',
  (inputs) => portfolioRisk(inputs),
);
