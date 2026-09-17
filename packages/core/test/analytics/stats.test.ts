// packages/core/test/analytics/stats.test.ts — WP-02 (WORKPLAN L515, L548), TESTING §7.8:
// "every statistic against a hand-checked series; `Conventions` echoed in outputs" (ANAL-07).
//
// Every number pinned in TESTING §7.8 appears in this file as a literal, in the unit §7.8 quotes it
// in (percent), with §7.8's tolerance. The module works in decimal fractions, so the assertions
// scale the engine's output by 100 and compare to the pinned percent — never the other way round,
// and never a value re-derived from the implementation.
//
// §7.8's series, in percent:
//     +1.00, −0.50, +0.75, +0.25, −1.25, +2.00, −0.75, +0.50, +1.50, −1.00
// and its arithmetic, which this file re-checks step by step:
//     Σr = 2.50 %, mean = 0.25 %/day; Σd² = 10.875 %²; sample variance = 10.875/9 = 1.208333333 %²;
//     daily σ = 1.099242 %; √252 = 15.874507866; annualised mean 63.00 %; excess 61.00 %.
//
// The three things this file is really guarding:
//   1. the pinned numbers themselves;
//   2. the ddof branch — §7.8: the population σ is 1.042833 % and "the engine must not return it
//      unless Conventions.ddof = 0 is passed", because a silent ddof change is the classic vol bug;
//   3. ANAL-07 — every result echoes the conventions it was computed under, so two screens cannot
//      disagree about what "volatility" meant.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STATS_CONVENTIONS,
  beta,
  correlation,
  covarianceOf,
  informationRatio,
  logReturns,
  maxDrawdown,
  meanOf,
  olsRegression,
  resolveStatsConventions,
  sharpeRatio,
  simpleReturns,
  sortinoRatio,
  statsEngine,
  statsSummary,
  stdevOf,
  sumSquaredDeviations,
  varianceOf,
  volatility,
} from '../../src/analytics/stats/index.js';
import type { StatsConventions } from '../../src/analytics/stats/index.js';

// ---------------------------------------------------------------------------------------------
// The §7.8 series and its pinned values
// ---------------------------------------------------------------------------------------------

/** TESTING §7.8, in percent, exactly as written. */
const SERIES_PCT = [1.0, -0.5, 0.75, 0.25, -1.25, 2.0, -0.75, 0.5, 1.5, -1.0] as const;

/** The same series in decimal fractions, which is the unit `stats/index.ts` works in. */
const SERIES = SERIES_PCT.map((r) => r / 100);

/**
 * The ten returns are dated as consecutive calendar days from 2026-01-01, the mapping that makes
 * the fifth return (−1.25 %) fall on 2026-01-05 — the date §7.8 names for the max drawdown.
 */
const DATES = [
  '2026-01-01',
  '2026-01-02',
  '2026-01-03',
  '2026-01-04',
  '2026-01-05',
  '2026-01-06',
  '2026-01-07',
  '2026-01-08',
  '2026-01-09',
  '2026-01-10',
] as const;

/** The fixed benchmark series of `stats.beta.10`, in percent, then in decimals. */
const BENCH_PCT = [0.8, -0.2, 0.6, 0.4, -1.0, 1.6, -0.4, 0.2, 1.2, -0.8] as const;
const BENCH = BENCH_PCT.map((r) => r / 100);

const VALUATION_TS = '2026-01-10T21:00:00Z';

/** §7.8's pinned table, percent and tolerance, verbatim. */
const PIN = {
  meanDailyPct: 0.25, // 0.250000 %   tol 1e-12
  meanDailyTol: 1e-12,
  stdevDailyPct: 1.099242, // 1.099242 %   tol 1e-6 (percent)
  stdevDailyTol: 1e-6,
  volAnnualisedPct: 17.449928, // 17.449928 %  tol 1e-6 (percent)
  volAnnualisedTol: 1e-6,
  returnAnnualisedPct: 63.0, // 63.000000 %  tol 1e-12
  returnAnnualisedTol: 1e-12,
  excessAnnualisedPct: 61.0, // 61.000000 %  tol 1e-12
  excessAnnualisedTol: 1e-12,
  sharpe: 3.495716, // 3.495716     tol 1e-6
  sharpeTol: 1e-6,
  maxDrawdownPct: -1.25, // −1.250000 %  tol 1e-9
  maxDrawdownTol: 1e-9,
  populationStdevPct: 1.042833, // companion: √(10.875/10)
  populationStdevTol: 1e-6,
  sqrt252: 15.874507866, // √252, as stated in §7.8
} as const;

/** Absolute-tolerance assertion; `expect.toBeCloseTo` is decimal-digit based, this is not. */
function within(actual: number, expected: number, tol: number, what: string): void {
  const delta = Math.abs(actual - expected);
  expect(delta <= tol, `${what}: expected ${expected} ± ${tol}, got ${actual} (Δ=${delta})`).toBe(
    true,
  );
}

/** The ANAL-07 assertion, applied to every result this file produces. */
function expectConventionsEchoed(
  conventions: StatsConventions | undefined,
  expected: Partial<StatsConventions>,
): void {
  expect(conventions).toBeDefined();
  const c = conventions!;
  // The full convention set is present, not a subset: an unstated convention is the bug.
  expect(Object.keys(c).sort()).toEqual(Object.keys(DEFAULT_STATS_CONVENTIONS).sort());
  expect(Object.isFrozen(c)).toBe(true);
  for (const [key, value] of Object.entries(expected)) {
    expect(c[key], `conventions.${key}`).toBe(value);
  }
}

// ---------------------------------------------------------------------------------------------
// 1. The arithmetic of §7.8, step by step
// ---------------------------------------------------------------------------------------------

describe('TESTING §7.8 — the stated arithmetic', () => {
  it('Σr = 2.50 %, mean = 0.25 %/day', () => {
    const sum = SERIES_PCT.reduce((a, b) => a + b, 0);
    within(sum, 2.5, 1e-12, 'Σr (percent)');
    within(meanOf(SERIES) * 100, 0.25, 1e-12, 'mean (percent)');
  });

  it('the deviations and Σd² = 10.875 %²', () => {
    const mean = meanOf(SERIES_PCT);
    const deviations = SERIES_PCT.map((r) => r - mean);
    expect(deviations.map((d) => Number(d.toFixed(10)))).toEqual([
      0.75, -0.75, 0.5, 0.0, -1.5, 1.75, -1.0, 0.25, 1.25, -1.25,
    ]);
    within(sumSquaredDeviations(SERIES_PCT), 10.875, 1e-12, 'Σd² (%²)');
  });

  it('sample variance = 10.875/9 = 1.208333333 %², population = 1.0875 %²', () => {
    within(varianceOf(SERIES_PCT, 1), 10.875 / 9, 1e-12, 'sample variance (%²)');
    within(varianceOf(SERIES_PCT, 1), 1.208333333, 1e-9, 'sample variance (%²)');
    within(varianceOf(SERIES_PCT, 0), 1.0875, 1e-12, 'population variance (%²)');
  });

  it('√252 = 15.874507866', () => {
    within(Math.sqrt(252), PIN.sqrt252, 5e-10, '√252');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The pinned table — volatility, Sharpe, drawdown
// ---------------------------------------------------------------------------------------------

describe('TESTING §7.8 — volatility and Sharpe on the fixed series (stats.vol.sharpe.10)', () => {
  const vol = volatility(SERIES);
  const sharpe = sharpeRatio(SERIES);
  const dd = maxDrawdown(SERIES, DATES);

  it('meanDaily = 0.250000 %', () => {
    within(vol.meanDaily * 100, PIN.meanDailyPct, PIN.meanDailyTol, 'meanDaily %');
    within(sharpe.meanDaily * 100, PIN.meanDailyPct, PIN.meanDailyTol, 'sharpe.meanDaily %');
  });

  it('stdevDaily (n−1) = 1.099242 %', () => {
    within(vol.stdevDaily * 100, PIN.stdevDailyPct, PIN.stdevDailyTol, 'stdevDaily %');
    expect(vol.stdevPeriod).toBe(vol.stdevDaily);
  });

  it('volAnnualised = 17.449928 %', () => {
    within(vol.volAnnualised * 100, PIN.volAnnualisedPct, PIN.volAnnualisedTol, 'volAnnualised %');
    // …and it is exactly σ × √252, the stated annualisation convention.
    within(vol.volAnnualised, vol.stdevDaily * Math.sqrt(252), 1e-15, 'σ × √252');
  });

  it('returnAnnualised = 63.000000 % (arithmetic, mean × 252)', () => {
    within(
      vol.returnAnnualised * 100,
      PIN.returnAnnualisedPct,
      PIN.returnAnnualisedTol,
      'returnAnnualised %',
    );
    // Not the geometric annualisation, which on this series is a different number entirely.
    const geometric = (Math.pow(1 + vol.meanDaily, 252) - 1) * 100;
    expect(Math.abs(geometric - PIN.returnAnnualisedPct)).toBeGreaterThan(1);
  });

  it('excessAnnualised = 61.000000 % (rf = 2.000 % annual simple)', () => {
    within(
      sharpe.excessAnnualised * 100,
      PIN.excessAnnualisedPct,
      PIN.excessAnnualisedTol,
      'excessAnnualised %',
    );
    within(sharpe.riskFreePeriod, 0.02 / 252, 1e-18, 'rf per day');
    within(
      sharpe.excessPeriod,
      sharpe.meanDaily - 0.02 / 252,
      1e-18,
      'excessPeriod = mean − rf/252',
    );
  });

  it('sharpe = 3.495716', () => {
    within(sharpe.sharpe, PIN.sharpe, PIN.sharpeTol, 'sharpe');
    within(
      sharpe.sharpe,
      sharpe.excessAnnualised / sharpe.volAnnualised,
      1e-15,
      'sharpe = excessAnnualised / volAnnualised',
    );
    // The periodic form must agree: (mean − rf/252)/σ × √252.
    within(
      sharpe.sharpe,
      ((sharpe.meanDaily - 0.02 / 252) / sharpe.stdevDaily) * Math.sqrt(252),
      1e-12,
      'sharpe (periodic form)',
    );
  });

  it('maxDrawdown = −1.250000 %, the single 2026-01-05 return', () => {
    within(dd.maxDrawdown * 100, PIN.maxDrawdownPct, PIN.maxDrawdownTol, 'maxDrawdown %');
    expect(dd.troughDate).toBe('2026-01-05');
    expect(dd.troughIndex).toBe(4);
    // The fall is from the level reached on 2026-01-04 and is recovered on 2026-01-06.
    expect(dd.peakDate).toBe('2026-01-04');
    expect(dd.peakIndex).toBe(3);
    expect(dd.recoveryDate).toBe('2026-01-06');
    expect(dd.drawdownPeriods).toBe(1);
    // "no consecutive negatives compound deeper": every drawdown is a single-period fall, so the
    // deepest equals the smallest single return.
    within(dd.maxDrawdown, Math.min(...SERIES), 1e-12, 'deepest drawdown = worst single return');
    expect(dd.equityCurve).toHaveLength(SERIES.length + 1);
    expect(dd.equityCurve[0]).toBe(1);
  });

  it('echoes its Conventions in every output (ANAL-07)', () => {
    const expected: Partial<StatsConventions> = {
      returns: 'simple',
      ddof: 1,
      annualisation: 252,
      annualisationBasis: 'trading-days',
      volAnnualisation: 'sqrt-time',
      meanAnnualisation: 'arithmetic',
      riskFree: 0.02,
      excessReturn: 'mean - riskFree / annualisation',
      drawdownBasis: 'compounded-from-1.0',
    };
    expectConventionsEchoed(vol.conventions, expected);
    expectConventionsEchoed(sharpe.conventions, expected);
    expectConventionsEchoed(dd.conventions, expected);
    expectConventionsEchoed(sortinoRatio(SERIES).conventions, expected);
    expectConventionsEchoed(correlation(SERIES, BENCH).conventions, expected);
    expectConventionsEchoed(beta(SERIES, BENCH).conventions, expected);
    expectConventionsEchoed(olsRegression(BENCH, SERIES).conventions, expected);
    expectConventionsEchoed(informationRatio(SERIES, BENCH).conventions, expected);
    expectConventionsEchoed(simpleReturns([100, 101]).conventions, { returns: 'simple' });
    expectConventionsEchoed(logReturns([100, 101]).conventions, { returns: 'log' });
    expectConventionsEchoed(statsSummary({ returns: SERIES }).conventions, expected);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The ddof branch — §7.8's companion assertion
// ---------------------------------------------------------------------------------------------

describe('TESTING §7.8 — the ddof branch is never silent', () => {
  it('population σ = 1.042833 % only when Conventions.ddof = 0 is passed', () => {
    const sample = volatility(SERIES);
    const population = volatility(SERIES, { ddof: 0 });

    within(
      population.stdevDaily * 100,
      PIN.populationStdevPct,
      PIN.populationStdevTol,
      'population stdevDaily %',
    );
    within(population.stdevDaily * 100, Math.sqrt(1.0875), 1e-12, '√(10.875/10)');

    // The default must NOT be the population figure.
    expect(Math.abs(sample.stdevDaily * 100 - PIN.populationStdevPct)).toBeGreaterThan(0.05);
    within(sample.stdevDaily * 100, PIN.stdevDailyPct, PIN.stdevDailyTol, 'sample stdevDaily %');

    // Both results say which branch they took.
    expect(sample.conventions.ddof).toBe(1);
    expect(population.conventions.ddof).toBe(0);
    expect(DEFAULT_STATS_CONVENTIONS.ddof).toBe(1);

    // σ_population = σ_sample × √(9/10).
    within(
      population.stdevDaily,
      sample.stdevDaily * Math.sqrt(9 / 10),
      1e-15,
      'σ_pop = σ_sample √(9/10)',
    );
  });

  it('rejects an impossible convention rather than guessing', () => {
    expect(() => resolveStatsConventions({ ddof: 2 as unknown as 0 })).toThrow(/ddof/);
    expect(() => resolveStatsConventions({ annualisation: 0 })).toThrow(/annualisation/);
    expect(() => resolveStatsConventions({ returns: 'geometric' as unknown as 'log' })).toThrow(
      /returns/,
    );
    expect(() => volatility([0.01])).toThrow(/at least 2/);
    expect(() => volatility([0.01, Number.NaN])).toThrow(/finite/);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Returns: simple and log
// ---------------------------------------------------------------------------------------------

describe('returns', () => {
  /** The price path the §7.8 series generates from 100: P_i = P_{i−1}(1 + r_i). */
  const prices = SERIES.reduce<number[]>(
    (acc, r) => [...acc, acc[acc.length - 1]! * (1 + r)],
    [100],
  );

  it('simple returns are P_i/P_{i−1} − 1 and reproduce the §7.8 series from its price path', () => {
    const r = simpleReturns(prices);
    expect(r.values).toHaveLength(prices.length - 1);
    expect(r.values).toHaveLength(SERIES.length);
    for (let i = 0; i < SERIES.length; i += 1) {
      within(r.values[i]!, SERIES[i]!, 1e-15, `round-trip r${i}`);
    }
    within(r.values[0]!, 0.01, 1e-15, 'r0 = +1.00 %');
    within(r.values[4]!, -0.0125, 1e-15, 'r4 = −1.25 %');
    expect(r.conventions.returns).toBe('simple');
  });

  it('log returns are ln(P_i/P_{i−1}) and telescope to the total log return', () => {
    const r = logReturns(prices);
    const total = r.values.reduce((a, b) => a + b, 0);
    const last = prices[prices.length - 1]!;
    within(total, Math.log(last / prices[0]!), 1e-14, 'Σ log returns');
    within(r.values[0]!, Math.log(1.01), 1e-15, 'log r0');
    expect(r.conventions.returns).toBe('log');
  });

  it('carries the date of the later price and rejects a mismatched date array', () => {
    const r = simpleReturns([100, 101, 102], undefined, ['2026-01-01', '2026-01-02', '2026-01-03']);
    expect(r.dates).toEqual(['2026-01-02', '2026-01-03']);
    expect(() => simpleReturns([100, 101, 102], undefined, ['2026-01-01'])).toThrow(
      /one entry per price/,
    );
    expect(() => simpleReturns([100, 0])).toThrow(/strictly positive/);
  });

  it('log-return volatility annualises under the same convention, with returns: log echoed', () => {
    const logs = SERIES.map((r) => Math.log(1 + r));
    const v = volatility(logs, { returns: 'log' });
    expect(v.conventions.returns).toBe('log');
    within(v.volAnnualised, stdevOf(logs, 1) * Math.sqrt(252), 1e-15, 'log vol annualised');
    // Close to, but deliberately not equal to, the simple-return volatility.
    expect(Math.abs(v.volAnnualised - volatility(SERIES).volAnnualised)).toBeLessThan(0.002);
    expect(v.volAnnualised).not.toBe(volatility(SERIES).volAnnualised);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Correlation, beta, OLS — stats.beta.10
// ---------------------------------------------------------------------------------------------

describe('TESTING §7.8 — beta, OLS, Sortino and IR on the fixed benchmark (stats.beta.10)', () => {
  const b = beta(SERIES, BENCH);
  const ols = olsRegression(BENCH, SERIES);
  const corr = correlation(SERIES, BENCH);

  it('OLS beta equals the closed form cov/var within 1e-12 (§7.8)', () => {
    const closedForm = covarianceOf(SERIES, BENCH, 1) / varianceOf(BENCH, 1);
    within(ols.slope, closedForm, 1e-12, 'OLS slope vs cov/var');
    within(b.beta, closedForm, 1e-12, 'beta vs cov/var');
    within(b.beta, ols.slope, 1e-12, 'beta vs OLS slope');
    // ddof cancels in cov/var: the population form is the same beta.
    within(
      covarianceOf(SERIES, BENCH, 0) / varianceOf(BENCH, 0),
      closedForm,
      1e-12,
      'cov/var is ddof-free',
    );
  });

  it('intercept, r² and the residual identities of an OLS fit', () => {
    within(ols.intercept, meanOf(SERIES) - ols.slope * meanOf(BENCH), 1e-18, 'intercept');
    within(b.alphaPeriod, ols.intercept, 1e-18, 'alpha = OLS intercept');
    within(b.alphaAnnualised, ols.intercept * 252, 1e-15, 'alpha annualised');

    // r² = corr² for a univariate fit.
    within(ols.rSquared, corr.correlation * corr.correlation, 1e-12, 'r² = corr²');
    within(b.rSquared, ols.rSquared, 1e-12, 'beta.rSquared = OLS r²');
    expect(ols.rSquared).toBeGreaterThan(0.97);
    expect(ols.rSquared).toBeLessThanOrEqual(1);

    // The normal equations: residuals sum to zero and are orthogonal to x.
    const sumResid = ols.residuals.reduce((a, r) => a + r, 0);
    within(sumResid, 0, 1e-15, 'Σ residuals');
    const dot = ols.residuals.reduce((a, r, i) => a + r * BENCH[i]!, 0);
    within(dot, 0, 1e-15, 'Σ residual·x');
    within(
      ols.sumSquaredResiduals,
      ols.residuals.reduce((a, r) => a + r * r, 0),
      1e-18,
      'SSE',
    );
    within(
      ols.rSquared,
      1 - ols.sumSquaredResiduals / ols.totalSumSquares,
      1e-15,
      'r² = 1 − SSE/SST',
    );
  });

  it('standard errors use n − 2 residual degrees of freedom', () => {
    within(
      ols.residualStdErr,
      Math.sqrt(ols.sumSquaredResiduals / (SERIES.length - 2)),
      1e-18,
      'residual standard error',
    );
    // se(slope) = s / √Sxx, and √Sxx = σ_x(n−1) × √(n−1): an independent route to the same number.
    within(
      ols.slopeStdErr,
      ols.residualStdErr / (stdevOf(BENCH, 1) * Math.sqrt(BENCH.length - 1)),
      1e-12,
      'se(slope)',
    );
    const sxx = sumSquaredDeviations(BENCH);
    within(
      ols.interceptStdErr,
      ols.residualStdErr * Math.sqrt(1 / BENCH.length + Math.pow(meanOf(BENCH), 2) / sxx),
      1e-15,
      'se(intercept)',
    );
    // A perfect fit has zero standard error and unit r².
    const perfect = olsRegression(
      BENCH,
      BENCH.map((x) => 3 + 2 * x),
    );
    within(perfect.slope, 2, 1e-12, 'perfect slope');
    within(perfect.intercept, 3, 1e-12, 'perfect intercept');
    within(perfect.rSquared, 1, 1e-12, 'perfect r²');
    within(perfect.slopeStdErr, 0, 1e-12, 'perfect se(slope)');
  });

  it('correlation is bounded, symmetric and ddof-free', () => {
    expect(corr.correlation).toBeGreaterThan(0.98);
    expect(corr.correlation).toBeLessThanOrEqual(1);
    within(correlation(BENCH, SERIES).correlation, corr.correlation, 1e-15, 'corr symmetry');
    within(
      correlation(SERIES, BENCH, { ddof: 0 }).correlation,
      corr.correlation,
      1e-12,
      'corr ddof-free',
    );
    within(correlation(SERIES, SERIES).correlation, 1, 1e-12, 'corr(x, x)');
    within(
      correlation(
        SERIES,
        SERIES.map((r) => -r),
      ).correlation,
      -1,
      1e-12,
      'corr(x, −x)',
    );
    within(corr.covariance, covarianceOf(SERIES, BENCH, 1), 1e-18, 'covariance');
  });

  it('beta of a series against itself is 1, and against a scaled copy is the scale', () => {
    within(beta(SERIES, SERIES).beta, 1, 1e-12, 'beta(x, x)');
    within(
      beta(
        SERIES.map((r) => 2 * r),
        SERIES,
      ).beta,
      2,
      1e-12,
      'beta(2x, x)',
    );
    expect(() =>
      beta(
        SERIES,
        SERIES.map(() => 0),
      ),
    ).toThrow(/zero variance/);
  });

  it('Sortino uses the risk-free target and only the downside', () => {
    const sortino = sortinoRatio(SERIES);
    const target = 0.02 / 252;
    expect(sortino.targetPeriod).toBe(target);
    expect(sortino.downsideCount).toBe(4); // −0.50, −1.25, −0.75, −1.00 percent
    const shortfall = SERIES.reduce((a, r) => a + Math.min(r - target, 0) ** 2, 0);
    within(
      sortino.downsideDeviationPeriod,
      Math.sqrt(shortfall / 9),
      1e-15,
      'downside deviation (n−1)',
    );
    within(
      sortino.downsideDeviationAnnualised,
      sortino.downsideDeviationPeriod * Math.sqrt(252),
      1e-15,
      'downside deviation annualised',
    );
    within(sortino.excessAnnualised * 100, PIN.excessAnnualisedPct, 1e-12, 'Sortino excess %');
    within(
      sortino.sortino,
      sortino.excessAnnualised / sortino.downsideDeviationAnnualised,
      1e-15,
      'sortino',
    );
    // Downside deviation ≤ total σ, so Sortino ≥ Sharpe on a series with upside.
    expect(sortino.downsideDeviationPeriod).toBeLessThan(volatility(SERIES).stdevDaily);
    expect(sortino.sortino).toBeGreaterThan(sharpeRatio(SERIES).sharpe);
    // `downsideTarget: 'zero'` is a different, and differently labelled, number.
    const zeroTarget = sortinoRatio(SERIES, { downsideTarget: 'zero' });
    expect(zeroTarget.conventions.downsideTarget).toBe('zero');
    expect(zeroTarget.targetPeriod).toBe(0);
    expect(zeroTarget.sortino).not.toBe(sortino.sortino);
  });

  it('information ratio is active return over ex-post tracking error', () => {
    const ir = informationRatio(SERIES, BENCH);
    const active = SERIES.map((r, i) => r - BENCH[i]!);
    within(ir.activeMeanPeriod, meanOf(active), 1e-18, 'active mean');
    within(ir.trackingErrorPeriod, stdevOf(active, 1), 1e-18, 'tracking error (n−1)');
    within(
      ir.trackingErrorAnnualised,
      stdevOf(active, 1) * Math.sqrt(252),
      1e-15,
      'tracking error annualised',
    );
    within(
      ir.informationRatio,
      (meanOf(active) * 252) / (stdevOf(active, 1) * Math.sqrt(252)),
      1e-12,
      'information ratio',
    );
    // Against itself the active series is identically zero: undefined, not silently infinite.
    expect(() => informationRatio(SERIES, SERIES)).toThrow(/tracking error is zero/);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Drawdown mechanics beyond the pinned case
// ---------------------------------------------------------------------------------------------

describe('maximum drawdown', () => {
  it('compounds consecutive negatives and reports both dates', () => {
    const returns = [0.1, -0.05, -0.05, 0.2];
    const dates = ['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05'];
    const dd = maxDrawdown(returns, dates);
    within(dd.maxDrawdown, 0.95 * 0.95 - 1, 1e-15, 'compounded drawdown');
    expect(dd.peakDate).toBe('2026-02-02');
    expect(dd.troughDate).toBe('2026-02-04');
    expect(dd.recoveryDate).toBe('2026-02-05');
    expect(dd.drawdownPeriods).toBe(2);
  });

  it('a peak before the series has index −1 and no date; a monotone rise has no drawdown', () => {
    const falling = maxDrawdown([-0.02, 0.01], ['2026-03-02', '2026-03-03']);
    expect(falling.peakIndex).toBe(-1);
    expect(falling.peakDate).toBeNull();
    within(falling.maxDrawdown, -0.02, 1e-15, 'first-period drawdown');

    const rising = maxDrawdown([0.01, 0.02, 0.03], ['2026-03-02', '2026-03-03', '2026-03-04']);
    expect(rising.maxDrawdown).toBe(0);
    expect(rising.troughIndex).toBe(-1);
    expect(rising.troughDate).toBeNull();
    expect(rising.recoveryDate).toBeNull();
  });

  it('never recovers → recoveryDate is null; log returns compound with e^r', () => {
    const dd = maxDrawdown([0.05, -0.1, 0.01], ['2026-04-01', '2026-04-02', '2026-04-03']);
    expect(dd.recoveryDate).toBeNull();

    const logDd = maxDrawdown([Math.log(1.05), Math.log(0.9)], undefined, { returns: 'log' });
    within(logDd.maxDrawdown, -0.1, 1e-12, 'log-return drawdown');
    expect(logDd.conventions.returns).toBe('log');
    expect(logDd.peakDate).toBeNull(); // no dates supplied
  });

  it('rejects a date array that does not line up with the returns', () => {
    expect(() => maxDrawdown(SERIES, ['2026-01-01'])).toThrow(/one entry per return/);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. The engine envelope and the golden fixture
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: {
    returns: number[];
    dates?: string[];
    benchmark?: number[];
    conventions?: Record<string, unknown>;
  };
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN_PATH = fileURLToPath(
  new URL('../../../../fixtures/golden/analytics/stats/returns.json', import.meta.url),
);
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenCase[];

describe('stats engine (ANAL-08) and fixtures/golden/analytics/stats/returns.json', () => {
  it('runs the §7.8 series through defineEngine with a stable inputsHash', () => {
    const inputs = { returns: SERIES, dates: [...DATES], benchmark: BENCH } as const;
    const a = statsEngine(inputs, VALUATION_TS);
    const b = statsEngine({ benchmark: BENCH, dates: [...DATES], returns: SERIES }, VALUATION_TS);
    expect(a.inputsHash).toHaveLength(64);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.inputsHash).toBe(a.inputsHash); // key order is irrelevant
    expect(statsEngine({ returns: SERIES }, VALUATION_TS).inputsHash).not.toBe(a.inputsHash);
    expect(a.engine).toEqual({ name: 'stats', version: '1.0.0' });
    expect(a.valuationTs).toBe(VALUATION_TS);
    within(a.outputs.sharpe, PIN.sharpe, PIN.sharpeTol, 'engine sharpe');
    expectConventionsEchoed(a.outputs.conventions, {
      returns: 'simple',
      ddof: 1,
      annualisation: 252,
    });
  });

  it('covers the golden file: three cases, all on the §7.8 series', () => {
    expect(GOLDEN.map((c) => c.id)).toEqual([
      'stats.vol.sharpe.10',
      'stats.vol.population.10',
      'stats.beta.10',
    ]);
    for (const c of GOLDEN) {
      expect(c.engine).toBe('stats');
      expect(c.engineVersion).toBe(statsEngine.version);
      expect(c.inputs.returns).toEqual(SERIES); // the §7.8 series, transcribed
      expect(c.source.length).toBeGreaterThan(0);
      expect(Object.keys(c.tol).sort()).toEqual(Object.keys(c.expected).sort());
    }
  });

  it.each(GOLDEN.map((c) => [c.id, c] as const))('golden case %s', (_id, c) => {
    const result = statsEngine(
      {
        returns: c.inputs.returns,
        ...(c.inputs.dates === undefined ? {} : { dates: c.inputs.dates }),
        ...(c.inputs.benchmark === undefined ? {} : { benchmark: c.inputs.benchmark }),
        ...(c.inputs.conventions === undefined ? {} : { conventions: c.inputs.conventions }),
      },
      c.valuationTs,
    );
    const outputs = result.outputs as unknown as Record<string, unknown>;
    for (const [key, expected] of Object.entries(c.expected)) {
      const actual = outputs[key];
      if (typeof expected === 'number') {
        expect(typeof actual, `${c.id}.${key} should be numeric`).toBe('number');
        within(actual as number, expected, c.tol[key] ?? 0, `${c.id}.${key}`);
      } else {
        expect(actual, `${c.id}.${key}`).toBe(expected);
      }
    }
    // The golden's own conventions are the ones the result reports back (ANAL-07).
    for (const [key, value] of Object.entries(c.inputs.conventions ?? {})) {
      expect(result.outputs.conventions[key], `${c.id} conventions.${key}`).toBe(value);
    }
  });

  it('the golden pins the §7.8 percent table, divided by 100', () => {
    const base = GOLDEN[0]!;
    expect(base.expected.meanDaily).toBe(PIN.meanDailyPct / 100);
    expect(base.expected.returnAnnualised).toBe(PIN.returnAnnualisedPct / 100);
    expect(base.expected.excessAnnualised).toBe(PIN.excessAnnualisedPct / 100);
    expect(base.expected.sharpe).toBe(PIN.sharpe);
    expect(base.expected.maxDrawdown).toBe(PIN.maxDrawdownPct / 100);
    expect(base.expected.stdevDaily).toBe(1.099242e-2);
    expect(base.expected.volAnnualised).toBe(17.449928e-2);
    expect(GOLDEN[1]!.expected.stdevDaily).toBe(1.042833e-2);
    expect(GOLDEN[1]!.inputs.conventions?.ddof).toBe(0);
  });

  it('statsSummary reports null for every benchmark statistic when no benchmark is given', () => {
    const summary = statsSummary({ returns: SERIES, dates: [...DATES] });
    expect(summary.beta).toBeNull();
    expect(summary.correlation).toBeNull();
    expect(summary.rSquared).toBeNull();
    expect(summary.olsSlope).toBeNull();
    expect(summary.informationRatio).toBeNull();
    expect(summary.trackingErrorAnnualised).toBeNull();
    // Π(1 + r) − 1 over the §7.8 series: the compounded total, not the 2.50 % arithmetic sum.
    within(summary.cumulativeReturn, 0.0247288909, 1e-9, 'compounded cumulative return');
    within(
      summary.cumulativeReturn,
      SERIES.reduce((acc, r) => acc * (1 + r), 1) - 1,
      1e-15,
      'cumulative return = Π(1 + r) − 1',
    );
    // …and the whole §7.8 table is present under both the §7.8 and the generic key names.
    expect(summary.meanDaily).toBe(summary.meanPeriod);
    expect(summary.stdevDaily).toBe(summary.stdevPeriod);
  });
});
