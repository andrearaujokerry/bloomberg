/**
 * Statistics (ANAL-07) — WORKPLAN §WP-02 L515, ARCHITECTURE L174-175, TESTING §7.8.
 *
 * Simple and log returns, volatility, correlation, beta, OLS regression, maximum drawdown with its
 * dates, Sharpe, Sortino and information ratio.
 *
 * **Every result carries the `Conventions` object it was computed under** (ANAL-07). That is the
 * whole point of this module's shape: "volatility" is not a number, it is a number plus the answer
 * to five questions — simple or log returns? sample or population variance? how many periods in a
 * year? annualised by √t or not at all? which risk-free rate? Two screens quoting `volAnnualised`
 * can only disagree if one of them dropped the conventions on the floor, and they cannot, because
 * the conventions travel inside the result.
 *
 * The convention set pinned by TESTING §7.8 and echoed by default:
 *
 *  - `returns: 'simple'` — arithmetic returns, not log returns.
 *  - `ddof: 1` — **sample** standard deviation, `n − 1` degrees of freedom. `ddof: 0` (population)
 *    is available but must be asked for: a silent ddof change is the classic volatility bug, so
 *    the branch is a parameter, never a default, and the value used is echoed back.
 *  - `annualisation: 252` trading days per year.
 *  - `volAnnualisation: 'sqrt-time'` — periodic σ × √252.
 *  - `meanAnnualisation: 'arithmetic'` — mean per period × 252, *not* `(1+mean)^252 − 1`.
 *  - `riskFree: 0.02` annual **simple** rate, so the per-period risk-free is `riskFree / 252` and
 *    excess return is `mean − riskFree/252` (annualised: `mean × 252 − riskFree`).
 *
 * Units: every rate and return in this module is a **decimal fraction** (0.01 = 1 %), never a
 * percent. TESTING §7.8's table is quoted in percent; the values here are those divided by 100.
 *
 * No clock and no `Date`: a date is an opaque `YYYY-MM-DD` string carried alongside a series and
 * handed back by `maxDrawdown` (ARCHITECTURE L49, and the packages/core ban on `Date`).
 */

import type { Conventions, ReturnBasis } from '../engine.js';
import { defineEngine } from '../engine.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conventions (ANAL-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How a periodic mean becomes an annual figure. */
export type MeanAnnualisation = 'arithmetic' | 'geometric';

/** How a periodic standard deviation becomes an annual figure. */
export type VolAnnualisation = 'sqrt-time' | 'none';

/** What Sortino's downside deviation measures shortfalls against. */
export type DownsideTarget = 'risk-free' | 'zero';

/**
 * The statistics convention set. Every field is required once resolved — an unstated convention is
 * exactly the ambiguity this module exists to remove — so callers pass a `Partial` and
 * `resolveStatsConventions` fills the TESTING §7.8 defaults in.
 */
export interface StatsConventions extends Conventions {
  /** `'simple'` (arithmetic) or `'log'` (continuously compounded) returns. */
  readonly returns: ReturnBasis;
  /** Periods per year: 252 trading days, 12 months, 52 weeks, 4 quarters. */
  readonly annualisation: number;
  /** Human-readable name of the period the series is sampled at. */
  readonly annualisationBasis: string;
  /** `'arithmetic'`: annual mean = periodic mean × `annualisation`. */
  readonly meanAnnualisation: MeanAnnualisation;
  /** `'sqrt-time'`: annual σ = periodic σ × √`annualisation`. */
  readonly volAnnualisation: VolAnnualisation;
  /** Degrees of freedom subtracted in a variance: 1 = sample (`n−1`), 0 = population (`n`). */
  readonly ddof: 0 | 1;
  /** Annual **simple** risk-free rate, decimal (0.02 = 2.000 %). */
  readonly riskFree: number;
  /** Spelled-out excess-return formula, carried so a screen can print it. */
  readonly excessReturn: string;
  /** Sortino's shortfall target. */
  readonly downsideTarget: DownsideTarget;
  /** Drawdown is measured on a compounded equity curve seeded at 1.0. */
  readonly drawdownBasis: string;
}

/**
 * The TESTING §7.8 convention set, and this module's default: simple returns, sample (`n−1`)
 * standard deviation, 252 trading days, √252 volatility annualisation, arithmetic mean
 * annualisation, 2.000 % annual simple risk-free rate.
 */
export const DEFAULT_STATS_CONVENTIONS: StatsConventions = Object.freeze({
  returns: 'simple',
  annualisation: 252,
  annualisationBasis: 'trading-days',
  meanAnnualisation: 'arithmetic',
  volAnnualisation: 'sqrt-time',
  ddof: 1,
  riskFree: 0.02,
  excessReturn: 'mean - riskFree / annualisation',
  downsideTarget: 'risk-free',
  drawdownBasis: 'compounded-from-1.0',
} satisfies StatsConventions);

/** Overrides accepted by every entry point; anything omitted comes from the §7.8 defaults. */
export type StatsConventionOverrides = Partial<StatsConventions>;

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Merge caller overrides onto {@link DEFAULT_STATS_CONVENTIONS} and validate the result, so that
 * an impossible convention (`ddof: 2`, `annualisation: 0`) fails at the call, not three screens
 * later inside a square root.
 */
export function resolveStatsConventions(overrides?: StatsConventionOverrides): StatsConventions {
  const merged: StatsConventions = { ...DEFAULT_STATS_CONVENTIONS, ...(overrides ?? {}) };

  if (merged.returns !== 'simple' && merged.returns !== 'log') {
    throw new RangeError(
      `stats: conventions.returns must be 'simple' or 'log', got '${String(merged.returns)}'`,
    );
  }
  if (!isFiniteNumber(merged.annualisation) || merged.annualisation <= 0) {
    throw new RangeError(
      `stats: conventions.annualisation must be a positive number of periods per year, got ${String(merged.annualisation)}`,
    );
  }
  if (merged.ddof !== 0 && merged.ddof !== 1) {
    throw new RangeError(
      `stats: conventions.ddof must be 0 (population) or 1 (sample), got ${String(merged.ddof)}`,
    );
  }
  if (!isFiniteNumber(merged.riskFree)) {
    throw new RangeError(
      `stats: conventions.riskFree must be a finite annual decimal rate, got ${String(merged.riskFree)}`,
    );
  }
  if (merged.meanAnnualisation !== 'arithmetic' && merged.meanAnnualisation !== 'geometric') {
    throw new RangeError(
      `stats: conventions.meanAnnualisation must be 'arithmetic' or 'geometric', got '${String(merged.meanAnnualisation)}'`,
    );
  }
  if (merged.volAnnualisation !== 'sqrt-time' && merged.volAnnualisation !== 'none') {
    throw new RangeError(
      `stats: conventions.volAnnualisation must be 'sqrt-time' or 'none', got '${String(merged.volAnnualisation)}'`,
    );
  }
  if (merged.downsideTarget !== 'risk-free' && merged.downsideTarget !== 'zero') {
    throw new RangeError(
      `stats: conventions.downsideTarget must be 'risk-free' or 'zero', got '${String(merged.downsideTarget)}'`,
    );
  }
  return Object.freeze(merged);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Numeric primitives — every convention is an explicit argument, so these cannot disagree either
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A typed `Array.isArray` — the bare call narrows a `readonly number[]` parameter to `any[]`,
 * which would make every subsequent index an `any`.
 */
function isNumberArray(xs: unknown): xs is readonly number[] {
  return Array.isArray(xs);
}

function requireSeries(label: string, xs: readonly number[], minLength: number): void {
  if (!isNumberArray(xs)) {
    throw new TypeError(`stats: ${label} must be an array of finite numbers`);
  }
  if (xs.length < minLength) {
    throw new RangeError(
      `stats: ${label} needs at least ${minLength} observations, got ${xs.length}`,
    );
  }
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    if (!isFiniteNumber(x)) {
      throw new RangeError(`stats: ${label}[${i}] must be a finite number, got ${String(x)}`);
    }
  }
}

function requireSameLength(
  aLabel: string,
  a: readonly number[],
  bLabel: string,
  b: readonly number[],
): void {
  if (a.length !== b.length) {
    throw new RangeError(
      `stats: ${aLabel} (${a.length}) and ${bLabel} (${b.length}) must have the same length`,
    );
  }
}

/** Arithmetic mean. */
export function meanOf(xs: readonly number[]): number {
  requireSeries('series', xs, 1);
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/** Σ(x − x̄)² — the raw sum of squared deviations, before any degrees-of-freedom division. */
export function sumSquaredDeviations(xs: readonly number[], m?: number): number {
  const centre = m ?? meanOf(xs);
  let total = 0;
  for (const x of xs) {
    const d = x - centre;
    total += d * d;
  }
  return total;
}

/** Variance with an explicit `ddof`: 1 = sample (`n−1`), 0 = population (`n`). */
export function varianceOf(xs: readonly number[], ddof: 0 | 1): number {
  requireSeries('series', xs, ddof + 1);
  return sumSquaredDeviations(xs) / (xs.length - ddof);
}

/** Standard deviation with an explicit `ddof`. */
export function stdevOf(xs: readonly number[], ddof: 0 | 1): number {
  return Math.sqrt(varianceOf(xs, ddof));
}

/** Covariance with an explicit `ddof`, the same convention as {@link varianceOf}. */
export function covarianceOf(a: readonly number[], b: readonly number[], ddof: 0 | 1): number {
  requireSeries('a', a, ddof + 1);
  requireSeries('b', b, ddof + 1);
  requireSameLength('a', a, 'b', b);
  const ma = meanOf(a);
  const mb = meanOf(b);
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += (a[i]! - ma) * (b[i]! - mb);
  }
  return total / (a.length - ddof);
}

/** Annualisation factor applied to a periodic standard deviation (√252 by default). */
export function volAnnualisationFactor(conventions: StatsConventions): number {
  return conventions.volAnnualisation === 'sqrt-time' ? Math.sqrt(conventions.annualisation) : 1;
}

/**
 * A periodic mean annualised under the stated convention: `× annualisation` (arithmetic, the
 * §7.8 default) or `(1 + mean)^annualisation − 1` (geometric).
 */
export function annualiseMean(meanPeriod: number, conventions: StatsConventions): number {
  return conventions.meanAnnualisation === 'geometric'
    ? Math.pow(1 + meanPeriod, conventions.annualisation) - 1
    : meanPeriod * conventions.annualisation;
}

/** The per-period risk-free rate: the annual simple rate divided by the periods in a year. */
export function periodRiskFree(conventions: StatsConventions): number {
  return conventions.riskFree / conventions.annualisation;
}

/** One period's growth factor under the return basis: `1 + r` (simple) or `e^r` (log). */
function growthFactor(r: number, conventions: StatsConventions): number {
  return conventions.returns === 'log' ? Math.exp(r) : 1 + r;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Returns
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A computed return series and the conventions that produced it (ANAL-07). */
export interface ReturnsResult {
  /** `n − 1` returns for `n` prices. */
  readonly values: readonly number[];
  /** The date each return was realised on (the *later* of the two prices), when dates were given. */
  readonly dates: readonly string[] | null;
  readonly conventions: StatsConventions;
}

function returnsFromPrices(
  prices: readonly number[],
  basis: ReturnBasis,
  overrides: StatsConventionOverrides | undefined,
  dates: readonly string[] | undefined,
): ReturnsResult {
  const conventions = resolveStatsConventions({ ...(overrides ?? {}), returns: basis });
  requireSeries('prices', prices, 2);
  if (dates !== undefined && dates.length !== prices.length) {
    throw new RangeError(
      `stats: dates (${dates.length}) must have one entry per price (${prices.length})`,
    );
  }
  const values: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1]!;
    const curr = prices[i]!;
    if (prev <= 0 || curr <= 0) {
      throw new RangeError(
        `stats: prices must be strictly positive to form returns (index ${i - 1} or ${i})`,
      );
    }
    values.push(basis === 'log' ? Math.log(curr / prev) : curr / prev - 1);
  }
  return Object.freeze({
    values: Object.freeze(values),
    dates: dates === undefined ? null : Object.freeze(dates.slice(1)),
    conventions,
  });
}

/**
 * Simple (arithmetic) returns: `r_i = P_i / P_{i-1} − 1`.
 * The result's conventions always report `returns: 'simple'`, whatever the caller passed.
 */
export function simpleReturns(
  prices: readonly number[],
  conventions?: StatsConventionOverrides,
  dates?: readonly string[],
): ReturnsResult {
  return returnsFromPrices(prices, 'simple', conventions, dates);
}

/**
 * Log (continuously compounded) returns: `r_i = ln(P_i / P_{i-1})`.
 * The result's conventions always report `returns: 'log'`.
 */
export function logReturns(
  prices: readonly number[],
  conventions?: StatsConventionOverrides,
  dates?: readonly string[],
): ReturnsResult {
  return returnsFromPrices(prices, 'log', conventions, dates);
}

/** Convert a simple return series to log, or a log series to simple, under a stated basis. */
export function toBasis(
  values: readonly number[],
  from: ReturnBasis,
  to: ReturnBasis,
  conventions?: StatsConventionOverrides,
): ReturnsResult {
  requireSeries('values', values, 1);
  const resolved = resolveStatsConventions({ ...(conventions ?? {}), returns: to });
  if (from === to) {
    return Object.freeze({
      values: Object.freeze([...values]),
      dates: null,
      conventions: resolved,
    });
  }
  const out = values.map((r) => (to === 'log' ? Math.log(1 + r) : Math.exp(r) - 1));
  return Object.freeze({ values: Object.freeze(out), dates: null, conventions: resolved });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Volatility
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Volatility and its inputs, with the conventions that define what "volatility" meant. */
export interface VolatilityResult {
  readonly n: number;
  /** Mean return **per period** (per trading day at `annualisation: 252`). */
  readonly meanPeriod: number;
  /** §7.8's name for {@link meanPeriod}. Identical value. */
  readonly meanDaily: number;
  /** Standard deviation per period under `conventions.ddof`. */
  readonly stdevPeriod: number;
  /** §7.8's name for {@link stdevPeriod}. Identical value. */
  readonly stdevDaily: number;
  /** Variance per period under `conventions.ddof`. */
  readonly variancePeriod: number;
  /** `stdevPeriod × √annualisation` under `volAnnualisation: 'sqrt-time'`. */
  readonly volAnnualised: number;
  /** `meanPeriod × annualisation` under `meanAnnualisation: 'arithmetic'`. */
  readonly returnAnnualised: number;
  readonly conventions: StatsConventions;
}

/**
 * Volatility of a return series.
 *
 * The annualisation convention is stated, not implied: the returned `conventions` carry
 * `annualisation: 252`, `annualisationBasis: 'trading-days'`, `volAnnualisation: 'sqrt-time'` and
 * `meanAnnualisation: 'arithmetic'`, so `volAnnualised = stdevPeriod × √252` and
 * `returnAnnualised = meanPeriod × 252` are readable off the result itself.
 */
export function volatility(
  returns: readonly number[],
  conventions?: StatsConventionOverrides,
): VolatilityResult {
  const conv = resolveStatsConventions(conventions);
  requireSeries('returns', returns, conv.ddof + 1);
  const n = returns.length;
  const meanPeriod = meanOf(returns);
  const variancePeriod = sumSquaredDeviations(returns, meanPeriod) / (n - conv.ddof);
  const stdevPeriod = Math.sqrt(variancePeriod);
  return Object.freeze({
    n,
    meanPeriod,
    meanDaily: meanPeriod,
    stdevPeriod,
    stdevDaily: stdevPeriod,
    variancePeriod,
    volAnnualised: stdevPeriod * volAnnualisationFactor(conv),
    returnAnnualised: annualiseMean(meanPeriod, conv),
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Correlation and beta
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Pearson correlation with its covariance and the conventions used. */
export interface CorrelationResult {
  readonly n: number;
  readonly correlation: number;
  readonly covariance: number;
  readonly stdevA: number;
  readonly stdevB: number;
  readonly conventions: StatsConventions;
}

/**
 * Pearson correlation. `ddof` cancels between the covariance and the two standard deviations, so
 * the number is the same for sample and population — it is echoed anyway, because the covariance
 * reported alongside it is not.
 */
export function correlation(
  a: readonly number[],
  b: readonly number[],
  conventions?: StatsConventionOverrides,
): CorrelationResult {
  const conv = resolveStatsConventions(conventions);
  requireSeries('a', a, conv.ddof + 1);
  requireSeries('b', b, conv.ddof + 1);
  requireSameLength('a', a, 'b', b);
  const cov = covarianceOf(a, b, conv.ddof);
  const sa = stdevOf(a, conv.ddof);
  const sb = stdevOf(b, conv.ddof);
  if (sa === 0 || sb === 0) {
    throw new RangeError('stats: correlation is undefined when a series has zero variance');
  }
  return Object.freeze({
    n: a.length,
    correlation: cov / (sa * sb),
    covariance: cov,
    stdevA: sa,
    stdevB: sb,
    conventions: conv,
  });
}

/** Beta against a benchmark, with the alpha and fit that come with it. */
export interface BetaResult {
  readonly n: number;
  /** `cov(asset, benchmark) / var(benchmark)` — identical to the OLS slope. */
  readonly beta: number;
  /** Intercept of asset-on-benchmark **per period**. */
  readonly alphaPeriod: number;
  /** `alphaPeriod` annualised under `meanAnnualisation`. */
  readonly alphaAnnualised: number;
  readonly correlation: number;
  readonly covariance: number;
  readonly benchmarkVariance: number;
  /** `correlation²` — the fit of the single-factor regression. */
  readonly rSquared: number;
  readonly conventions: StatsConventions;
}

/**
 * Beta of `asset` against `benchmark`: the closed form `cov/var`, which is exactly the OLS slope
 * of `asset ~ benchmark` ({@link olsRegression}). `conventions.betaBenchmark`/`betaWindow` may be
 * passed through to name the benchmark and the window in the echoed conventions.
 */
export function beta(
  asset: readonly number[],
  benchmark: readonly number[],
  conventions?: StatsConventionOverrides,
): BetaResult {
  const conv = resolveStatsConventions(conventions);
  requireSeries('asset', asset, conv.ddof + 1);
  requireSeries('benchmark', benchmark, conv.ddof + 1);
  requireSameLength('asset', asset, 'benchmark', benchmark);
  const cov = covarianceOf(asset, benchmark, conv.ddof);
  const varB = varianceOf(benchmark, conv.ddof);
  if (varB === 0) {
    throw new RangeError('stats: beta is undefined against a benchmark with zero variance');
  }
  const b = cov / varB;
  const alphaPeriod = meanOf(asset) - b * meanOf(benchmark);
  const varA = varianceOf(asset, conv.ddof);
  const corr = varA === 0 ? 0 : cov / Math.sqrt(varA * varB);
  return Object.freeze({
    n: asset.length,
    beta: b,
    alphaPeriod,
    alphaAnnualised: annualiseMean(alphaPeriod, conv),
    correlation: corr,
    covariance: cov,
    benchmarkVariance: varB,
    rSquared: corr * corr,
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// OLS regression
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Univariate OLS `y = intercept + slope·x + ε` with the usual textbook standard errors. */
export interface OlsResult {
  readonly n: number;
  readonly slope: number;
  readonly intercept: number;
  /** Coefficient of determination, `1 − SSE/SST`. */
  readonly rSquared: number;
  /** `√(s² / Sxx)`. */
  readonly slopeStdErr: number;
  /** `√(s² · (1/n + x̄²/Sxx))`. */
  readonly interceptStdErr: number;
  /** Residual standard error `s = √(SSE/(n−2))`. */
  readonly residualStdErr: number;
  /** Σ(y − ŷ)². */
  readonly sumSquaredResiduals: number;
  /** Σ(y − ȳ)². */
  readonly totalSumSquares: number;
  /** Residuals in input order. */
  readonly residuals: readonly number[];
  readonly conventions: StatsConventions;
}

/**
 * Ordinary least squares of `y` on `x`.
 *
 * Standard errors use `n − 2` residual degrees of freedom (two estimated parameters), which is the
 * regression's own convention and is independent of `conventions.ddof` — `ddof` governs variances
 * of a *series*, not the residual dof of a fit. `n ≥ 3` is therefore required.
 */
export function olsRegression(
  x: readonly number[],
  y: readonly number[],
  conventions?: StatsConventionOverrides,
): OlsResult {
  const conv = resolveStatsConventions(conventions);
  requireSeries('x', x, 3);
  requireSeries('y', y, 3);
  requireSameLength('x', x, 'y', y);

  const n = x.length;
  const mx = meanOf(x);
  const my = meanOf(y);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) {
    throw new RangeError('stats: OLS is undefined when x has zero variance');
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  const residuals: number[] = [];
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const e = y[i]! - (intercept + slope * x[i]!);
    residuals.push(e);
    sse += e * e;
  }
  const s2 = sse / (n - 2);
  const rSquared = syy === 0 ? 1 : 1 - sse / syy;

  return Object.freeze({
    n,
    slope,
    intercept,
    rSquared,
    slopeStdErr: Math.sqrt(s2 / sxx),
    interceptStdErr: Math.sqrt(s2 * (1 / n + (mx * mx) / sxx)),
    residualStdErr: Math.sqrt(s2),
    sumSquaredResiduals: sse,
    totalSumSquares: syy,
    residuals: Object.freeze(residuals),
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Drawdown
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Maximum drawdown with the dates that bracket it. */
export interface DrawdownResult {
  /** The deepest peak-to-trough fall as a **negative** decimal (−0.0125 = −1.25 %); 0 if none. */
  readonly maxDrawdown: number;
  /** Index into the return series of the peak, or −1 for the pre-series start level of 1.0. */
  readonly peakIndex: number;
  /** Index into the return series of the trough, or −1 when there is no drawdown. */
  readonly troughIndex: number;
  /** Date of the peak, `null` when the peak is the pre-series start or no dates were given. */
  readonly peakDate: string | null;
  /** Date of the trough, `null` when there is no drawdown or no dates were given. */
  readonly troughDate: string | null;
  /** First date the equity curve regained the peak, `null` if it never did. */
  readonly recoveryDate: string | null;
  /** Equity-curve level at the peak (curve seeded at 1.0). */
  readonly peakLevel: number;
  /** Equity-curve level at the trough. */
  readonly troughLevel: number;
  /** Periods from peak to trough. */
  readonly drawdownPeriods: number;
  /** The compounded equity curve itself, `n + 1` points, starting at 1.0. */
  readonly equityCurve: readonly number[];
  readonly conventions: StatsConventions;
}

/**
 * Maximum drawdown of the compounded equity curve, which starts at 1.0 *before* the first return
 * (`drawdownBasis: 'compounded-from-1.0'`). Each period multiplies the curve by `1 + r`
 * (`returns: 'simple'`) or `e^r` (`returns: 'log'`).
 *
 * `dates[i]` is the date return `i` was realised on, so the trough date is the date of the return
 * that completed the fall; a peak at index −1 is the start level and has no date.
 */
export function maxDrawdown(
  returns: readonly number[],
  dates?: readonly string[],
  conventions?: StatsConventionOverrides,
): DrawdownResult {
  const conv = resolveStatsConventions(conventions);
  requireSeries('returns', returns, 1);
  if (dates !== undefined && dates.length !== returns.length) {
    throw new RangeError(
      `stats: dates (${dates.length}) must have one entry per return (${returns.length})`,
    );
  }
  const dateAt = (i: number): string | null => {
    if (dates === undefined || i < 0) return null;
    return dates[i] ?? null;
  };

  const curve: number[] = [1];
  let level = 1;
  let peakLevel = 1;
  let peakIndex = -1;
  let worst = 0;
  let worstPeakIndex = -1;
  let worstPeakLevel = 1;
  let worstTroughIndex = -1;
  let worstTroughLevel = 1;

  for (let i = 0; i < returns.length; i += 1) {
    level *= growthFactor(returns[i]!, conv);
    curve.push(level);
    if (level > peakLevel) {
      peakLevel = level;
      peakIndex = i;
      continue;
    }
    const dd = level / peakLevel - 1;
    if (dd < worst) {
      worst = dd;
      worstPeakIndex = peakIndex;
      worstPeakLevel = peakLevel;
      worstTroughIndex = i;
      worstTroughLevel = level;
    }
  }

  // The level after return `i` is `curve[i + 1]`; recovery is the first date the curve is back at
  // or above the peak it fell from.
  let recoveryDate: string | null = null;
  if (worstTroughIndex >= 0) {
    for (let i = worstTroughIndex + 1; i < returns.length; i += 1) {
      const lv = curve[i + 1];
      if (lv !== undefined && lv >= worstPeakLevel) {
        recoveryDate = dateAt(i);
        break;
      }
    }
  }

  const noDrawdown = worstTroughIndex < 0;
  return Object.freeze({
    maxDrawdown: worst,
    peakIndex: worstPeakIndex,
    troughIndex: worstTroughIndex,
    peakDate: dateAt(worstPeakIndex),
    troughDate: dateAt(worstTroughIndex),
    recoveryDate,
    peakLevel: noDrawdown ? peakLevel : worstPeakLevel,
    troughLevel: noDrawdown ? peakLevel : worstTroughLevel,
    drawdownPeriods: noDrawdown ? 0 : worstTroughIndex - worstPeakIndex,
    equityCurve: Object.freeze(curve),
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Risk-adjusted ratios
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Sharpe ratio and every intermediate the §7.8 arithmetic names. */
export interface SharpeResult {
  readonly n: number;
  readonly meanPeriod: number;
  readonly meanDaily: number;
  readonly stdevPeriod: number;
  readonly stdevDaily: number;
  /** `riskFree / annualisation`. */
  readonly riskFreePeriod: number;
  /** `meanPeriod − riskFreePeriod`. */
  readonly excessPeriod: number;
  /** `meanPeriod × annualisation`. */
  readonly returnAnnualised: number;
  /** `returnAnnualised − riskFree`. */
  readonly excessAnnualised: number;
  /** `stdevPeriod × √annualisation`. */
  readonly volAnnualised: number;
  /** `excessAnnualised / volAnnualised` — identical to `excessPeriod/stdevPeriod × √annualisation`. */
  readonly sharpe: number;
  readonly conventions: StatsConventions;
}

/**
 * Sharpe ratio `= (mean × 252 − rf) / (σ × √252)` under the §7.8 conventions.
 *
 * Both halves are annualised under the *stated* convention (arithmetic mean, √t volatility), so the
 * ratio is the annualised one; dividing the periodic excess by the periodic σ and multiplying by
 * √252 gives the same number, which is why the periodic intermediates are returned too.
 */
export function sharpeRatio(
  returns: readonly number[],
  conventions?: StatsConventionOverrides,
): SharpeResult {
  const conv = resolveStatsConventions(conventions);
  const vol = volatility(returns, conv);
  if (vol.volAnnualised === 0) {
    throw new RangeError('stats: Sharpe is undefined for a series with zero volatility');
  }
  const rfPeriod = periodRiskFree(conv);
  const excessAnnualised = vol.returnAnnualised - conv.riskFree;
  return Object.freeze({
    n: vol.n,
    meanPeriod: vol.meanPeriod,
    meanDaily: vol.meanPeriod,
    stdevPeriod: vol.stdevPeriod,
    stdevDaily: vol.stdevPeriod,
    riskFreePeriod: rfPeriod,
    excessPeriod: vol.meanPeriod - rfPeriod,
    returnAnnualised: vol.returnAnnualised,
    excessAnnualised,
    volAnnualised: vol.volAnnualised,
    sharpe: excessAnnualised / vol.volAnnualised,
    conventions: conv,
  });
}

/** Sortino ratio: excess return over downside deviation. */
export interface SortinoResult {
  readonly n: number;
  readonly meanPeriod: number;
  /** The per-period shortfall target: `riskFree/annualisation`, or 0 under `downsideTarget: 'zero'`. */
  readonly targetPeriod: number;
  /** How many observations fell below the target. */
  readonly downsideCount: number;
  /** `√(Σ min(r − target, 0)² / (n − ddof))` — the same ddof as every other dispersion here. */
  readonly downsideDeviationPeriod: number;
  /** Downside deviation × √annualisation. */
  readonly downsideDeviationAnnualised: number;
  readonly returnAnnualised: number;
  readonly excessAnnualised: number;
  readonly sortino: number;
  readonly conventions: StatsConventions;
}

/**
 * Sortino ratio `= (mean × 252 − target × 252) / (downside deviation × √252)`.
 *
 * The downside deviation sums squared shortfalls below the target over **all** `n − ddof` degrees
 * of freedom (upside periods contribute zero, they are not dropped from the denominator) — the
 * standard definition, and the one echoed by `conventions.ddof` + `conventions.downsideTarget`.
 */
export function sortinoRatio(
  returns: readonly number[],
  conventions?: StatsConventionOverrides,
): SortinoResult {
  const conv = resolveStatsConventions(conventions);
  requireSeries('returns', returns, conv.ddof + 1);
  const n = returns.length;
  const target = conv.downsideTarget === 'zero' ? 0 : periodRiskFree(conv);
  let shortfall = 0;
  let downsideCount = 0;
  for (const r of returns) {
    const d = r - target;
    if (d < 0) {
      shortfall += d * d;
      downsideCount += 1;
    }
  }
  const ddPeriod = Math.sqrt(shortfall / (n - conv.ddof));
  if (ddPeriod === 0) {
    throw new RangeError('stats: Sortino is undefined for a series with no downside deviation');
  }
  const meanPeriod = meanOf(returns);
  const returnAnnualised = annualiseMean(meanPeriod, conv);
  const excessAnnualised = returnAnnualised - annualiseMean(target, conv);
  const ddAnnualised = ddPeriod * volAnnualisationFactor(conv);
  return Object.freeze({
    n,
    meanPeriod,
    targetPeriod: target,
    downsideCount,
    downsideDeviationPeriod: ddPeriod,
    downsideDeviationAnnualised: ddAnnualised,
    returnAnnualised,
    excessAnnualised,
    sortino: excessAnnualised / ddAnnualised,
    conventions: conv,
  });
}

/** Information ratio: active return over tracking error. */
export interface InformationRatioResult {
  readonly n: number;
  /** Mean active return per period, `mean(portfolio − benchmark)`. */
  readonly activeMeanPeriod: number;
  /** Active return annualised under `meanAnnualisation`. */
  readonly activeReturnAnnualised: number;
  /** σ of the active return per period under `conventions.ddof`. */
  readonly trackingErrorPeriod: number;
  /** Tracking error × √annualisation. */
  readonly trackingErrorAnnualised: number;
  readonly informationRatio: number;
  readonly conventions: StatsConventions;
}

/**
 * Information ratio `= annualised active return / annualised tracking error`, where the active
 * return is the plain difference `portfolio − benchmark` per period (ex-post tracking error, the
 * same dispersion convention as everything else in this module).
 */
export function informationRatio(
  portfolio: readonly number[],
  benchmark: readonly number[],
  conventions?: StatsConventionOverrides,
): InformationRatioResult {
  const conv = resolveStatsConventions(conventions);
  requireSeries('portfolio', portfolio, conv.ddof + 1);
  requireSeries('benchmark', benchmark, conv.ddof + 1);
  requireSameLength('portfolio', portfolio, 'benchmark', benchmark);
  const active = portfolio.map((r, i) => r - benchmark[i]!);
  const activeMeanPeriod = meanOf(active);
  const tePeriod = stdevOf(active, conv.ddof);
  if (tePeriod === 0) {
    throw new RangeError('stats: information ratio is undefined when tracking error is zero');
  }
  const teAnnualised = tePeriod * volAnnualisationFactor(conv);
  return Object.freeze({
    n: active.length,
    activeMeanPeriod,
    activeReturnAnnualised: annualiseMean(activeMeanPeriod, conv),
    trackingErrorPeriod: tePeriod,
    trackingErrorAnnualised: teAnnualised,
    informationRatio: annualiseMean(activeMeanPeriod, conv) / teAnnualised,
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine (ANAL-08): one flat summary over a series, optionally against a benchmark
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The declared input set of the `stats` engine (ANAL-08). A type alias, not an interface, so it
 * satisfies `EngineInputs = Readonly<Record<string, unknown>>`.
 */
export type StatsEngineInputs = {
  /** The return series, decimal fractions, one per period. */
  readonly returns: readonly number[];
  /** Optional `YYYY-MM-DD` date per return, used for the drawdown dates. */
  readonly dates?: readonly string[];
  /** Optional benchmark return series, aligned with `returns`, enabling beta/OLS/IR. */
  readonly benchmark?: readonly number[];
  /** Convention overrides; anything omitted is the §7.8 default. */
  readonly conventions?: StatsConventionOverrides;
};

/**
 * Everything §7.8 names, flat, so a golden case can pin any key by name; plus the echoed
 * `conventions` (ANAL-07). Benchmark-derived keys are `null` when no benchmark was supplied.
 */
export interface StatsSummary {
  readonly n: number;
  readonly meanDaily: number;
  readonly meanPeriod: number;
  readonly stdevDaily: number;
  readonly stdevPeriod: number;
  readonly variancePeriod: number;
  readonly volAnnualised: number;
  readonly returnAnnualised: number;
  readonly riskFreePeriod: number;
  readonly excessAnnualised: number;
  readonly sharpe: number;
  readonly sortino: number;
  readonly downsideDeviationAnnualised: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownPeakDate: string | null;
  readonly maxDrawdownTroughDate: string | null;
  readonly maxDrawdownRecoveryDate: string | null;
  readonly cumulativeReturn: number;
  readonly beta: number | null;
  readonly alphaAnnualised: number | null;
  readonly correlation: number | null;
  readonly rSquared: number | null;
  readonly olsSlope: number | null;
  readonly olsIntercept: number | null;
  readonly olsSlopeStdErr: number | null;
  readonly olsInterceptStdErr: number | null;
  readonly trackingErrorAnnualised: number | null;
  readonly informationRatio: number | null;
  readonly conventions: StatsConventions;
}

/** Compute the full §7.8 statistic set over one series (and optionally against a benchmark). */
export function statsSummary(inputs: StatsEngineInputs): StatsSummary {
  const conv = resolveStatsConventions(inputs.conventions);
  const returns = inputs.returns;
  requireSeries('returns', returns, conv.ddof + 1);

  const vol = volatility(returns, conv);
  const sharpe = sharpeRatio(returns, conv);
  const sortino = sortinoRatio(returns, conv);
  const dd = maxDrawdown(returns, inputs.dates, conv);
  const curveEnd = dd.equityCurve[dd.equityCurve.length - 1] ?? 1;

  const bench = inputs.benchmark;
  const hasBench = bench !== undefined;
  const b = hasBench ? beta(returns, bench, conv) : null;
  const ols = hasBench ? olsRegression(bench, returns, conv) : null;
  const ir = hasBench ? informationRatio(returns, bench, conv) : null;

  return Object.freeze({
    n: vol.n,
    meanDaily: vol.meanPeriod,
    meanPeriod: vol.meanPeriod,
    stdevDaily: vol.stdevPeriod,
    stdevPeriod: vol.stdevPeriod,
    variancePeriod: vol.variancePeriod,
    volAnnualised: vol.volAnnualised,
    returnAnnualised: vol.returnAnnualised,
    riskFreePeriod: sharpe.riskFreePeriod,
    excessAnnualised: sharpe.excessAnnualised,
    sharpe: sharpe.sharpe,
    sortino: sortino.sortino,
    downsideDeviationAnnualised: sortino.downsideDeviationAnnualised,
    maxDrawdown: dd.maxDrawdown,
    maxDrawdownPeakDate: dd.peakDate,
    maxDrawdownTroughDate: dd.troughDate,
    maxDrawdownRecoveryDate: dd.recoveryDate,
    cumulativeReturn: curveEnd - 1,
    beta: b === null ? null : b.beta,
    alphaAnnualised: b === null ? null : b.alphaAnnualised,
    correlation: b === null ? null : b.correlation,
    rSquared: ols === null ? null : ols.rSquared,
    olsSlope: ols === null ? null : ols.slope,
    olsIntercept: ols === null ? null : ols.intercept,
    olsSlopeStdErr: ols === null ? null : ols.slopeStdErr,
    olsInterceptStdErr: ols === null ? null : ols.interceptStdErr,
    trackingErrorAnnualised: ir === null ? null : ir.trackingErrorAnnualised,
    informationRatio: ir === null ? null : ir.informationRatio,
    conventions: conv,
  });
}

/**
 * The `stats` engine (ANAL-08): `statsSummary` wrapped in `defineEngine`, so a result carries its
 * inputs, the engine identity and the `char(64)` `inputsHash`. This is the name a golden case in
 * `fixtures/golden/analytics/stats/*.json` dispatches on.
 */
export const statsEngine = defineEngine<StatsEngineInputs, StatsSummary>(
  'stats',
  '1.0.0',
  (inputs) => statsSummary(inputs),
);
