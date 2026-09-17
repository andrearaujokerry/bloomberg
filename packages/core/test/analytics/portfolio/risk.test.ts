// packages/core/test/analytics/portfolio/risk.test.ts — WP-02 (WORKPLAN L516-517):
// ex-post tracking error (PORT-04), historical and parametric VaR (PORT-06) and scenario shocks
// (PORT-05), each against a hand-checked series or a hand-computed book.
//
// The return series is TESTING §7.8's, so its mean and standard deviation are the values §7.8
// already pins and this file re-uses them as literals rather than deriving anything from the
// implementation:
//
//   portfolio, %:  +1.00, −0.50, +0.75, +0.25, −1.25, +2.00, −0.75, +0.50, +1.50, −1.00
//   benchmark, %:  +0.80, −0.20, +0.60, +0.40, −1.00, +1.60, −0.40, +0.20, +1.20, −0.80
//                  (the `stats.beta.10` benchmark)
//
// Tracking error, worked in full:
//   active, %:     +0.20, −0.30, +0.15, −0.15, −0.25, +0.40, −0.35, +0.30, +0.30, −0.20
//   Σa = 0.10 %, mean = 0.01 %/day
//   deviations:    +0.19, −0.31, +0.14, −0.16, −0.26, +0.39, −0.36, +0.29, +0.29, −0.21
//   Σd² = 0.7390 %²; sample variance = 0.7390/9 = 0.082111111 %²
//   TE daily = √0.082111111 = 0.286550 %; × √252 (= 15.874507866) = 4.548846 %
//   active annualised = 0.01 × 252 = 2.52 %; IR = 2.52 / 4.548846 = 0.553987
//
// VaR, on the sorted portfolio series  −1.25, −1.00, −0.75, −0.50, 0.25, 0.50, 0.75, 1.00, 1.50, 2.00:
//   historical, type-7, 95 %: h = 0.05 × 9 = 0.45 → −1.25 + 0.45 × 0.25 = −1.1375 % → VaR 1.1375 %
//   historical, type-7, 80 %: h = 0.20 × 9 = 1.80 → −1.00 + 0.80 × 0.25 = −0.80 %  → VaR 0.80 %
//   historical, nearest-rank, 80 %: ⌈0.20 × 10⌉ = 2 → −1.00 %                      → VaR 1.00 %
//   parametric 95 %: z(0.95) × σ = 1.6448536269514722 × 1.099242163 % = 1.808092 %
//
// Scenarios, on a hand-computed four-line book (NAV 10,000,000 USD):
//   UST_PARALLEL_UP_100 → −3,200 × 100                              = −320,000
//   UST_STEEPEN_50      → −(300×−25 + 400×0 + 2,500×25 + 0×25)      = −55,000
//   EQUITY_DOWN_10      → 3,000,000×1.20×−0.10 + 2,000,000×0.90×−0.10 = −540,000
//   USD_UP_5            → 2,000,000 × (1/1.05 − 1)                  = −95,238.095238

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { exposure, exposureEngine } from '../../../src/analytics/portfolio/exposure.js';
import type {
  ExposureConventionOverrides,
  Position,
} from '../../../src/analytics/portfolio/exposure.js';
import {
  DEFAULT_PORTFOLIO_RISK_CONVENTIONS,
  NAMED_SCENARIOS,
  applyScenario,
  historicalVar,
  normalQuantile,
  parametricVar,
  percentileOf,
  portfolioRisk,
  portfolioRiskEngine,
  scenarioAnalysis,
  trackingError,
  varBacktest,
} from '../../../src/analytics/portfolio/risk.js';
import type {
  PortfolioRiskConventionOverrides,
  RiskHolding,
} from '../../../src/analytics/portfolio/risk.js';

// ---------------------------------------------------------------------------------------------
// The series and the hand-checked numbers
// ---------------------------------------------------------------------------------------------

const SERIES_PCT = [1.0, -0.5, 0.75, 0.25, -1.25, 2.0, -0.75, 0.5, 1.5, -1.0] as const;
const BENCH_PCT = [0.8, -0.2, 0.6, 0.4, -1.0, 1.6, -0.4, 0.2, 1.2, -0.8] as const;
const SERIES = SERIES_PCT.map((r) => r / 100);
const BENCH = BENCH_PCT.map((r) => r / 100);

const VALUATION_TS = '2026-01-10T21:00:00Z';
const PORTFOLIO_VALUE = 10_000_000;

/**
 * The hand arithmetic, restated as literals. `sumSqDevActivePct` and `sumSqDevPct` are the two
 * Σd² figures worked out in the header; everything below is derived from *those*, by the test,
 * never from the module under test.
 */
const HAND = {
  sumSqDevActivePct: 0.739, // %²  — Σ of the ten squared active deviations
  activeMeanPct: 0.01, // %/day
  sqrt252: Math.sqrt(252),
  /** TESTING §7.8's own Σd² for the portfolio series. */
  sumSqDevPct: 10.875, // %²
  /** Published standard-normal quantiles, not computed here. */
  z80: 0.8416212335729143,
  z95: 1.6448536269514722,
  z975: 1.959963984540054,
  z99: 2.3263478740408408,
} as const;

/** TE per day, as a decimal fraction, from the hand arithmetic alone. */
const TE_DAILY = Math.sqrt(HAND.sumSqDevActivePct / 9) / 100;
/** σ per day, as a decimal fraction, from §7.8's Σd² alone. */
const SIGMA_DAILY = Math.sqrt(HAND.sumSqDevPct / 9) / 100;

function within(actual: number, expected: number, tol: number, label: string): void {
  const diff = Math.abs(actual - expected);
  expect(diff <= tol, `${label}: |${actual} − ${expected}| = ${diff} exceeds ${tol}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// 1. Ex-post tracking error (PORT-04)
// ---------------------------------------------------------------------------------------------

describe('ex-post tracking error on the hand-checked series (PORT-04)', () => {
  const te = trackingError(SERIES, BENCH);

  it('takes the active return series as portfolio − benchmark', () => {
    const expectedActivePct = [0.2, -0.3, 0.15, -0.15, -0.25, 0.4, -0.35, 0.3, 0.3, -0.2];
    expect(te.activeReturns).toHaveLength(10);
    te.activeReturns.forEach((a, i) => {
      within(a * 100, expectedActivePct[i]!, 1e-12, `active[${i}] %`);
    });
  });

  it('reproduces the hand-computed daily and annualised tracking error', () => {
    within(te.activeMeanPeriod * 100, HAND.activeMeanPct, 1e-14, 'active mean %');
    within(te.trackingErrorPeriod, TE_DAILY, 1e-15, 'TE daily');
    within(te.trackingErrorPeriod * 100, 0.28655, 1e-5, 'TE daily % (0.286550)');
    within(te.trackingErrorAnnualised, TE_DAILY * HAND.sqrt252, 1e-15, 'TE annualised');
    within(te.trackingErrorAnnualised * 100, 4.548846, 1e-6, 'TE annualised % (4.548846)');
  });

  it('reproduces the hand-computed active return and information ratio', () => {
    within(te.activeReturnAnnualised * 100, 2.52, 1e-13, 'active annualised % (2.52)');
    within(te.informationRatio ?? Number.NaN, 0.553987, 1e-6, 'information ratio');
    within(
      te.informationRatio ?? Number.NaN,
      (HAND.activeMeanPct * 252) / 100 / (TE_DAILY * HAND.sqrt252),
      1e-15,
      'information ratio vs the hand chain',
    );
  });

  it('honours ddof: the population tracking error is √(0.7390/10), and only on request', () => {
    const population = trackingError(SERIES, BENCH, { ddof: 0 });
    within(population.trackingErrorPeriod, Math.sqrt(0.739 / 10) / 100, 1e-15, 'population TE');
    expect(population.trackingErrorPeriod).not.toBe(te.trackingErrorPeriod);
    expect(population.conventions.ddof).toBe(0);
    expect(te.conventions.ddof).toBe(1);
  });

  it('reports a null information ratio rather than throwing when the book tracks exactly', () => {
    const flat = trackingError(SERIES, SERIES);
    expect(flat.trackingErrorPeriod).toBe(0);
    expect(flat.trackingErrorAnnualised).toBe(0);
    expect(flat.informationRatio).toBeNull();
  });

  it('refuses misaligned series', () => {
    expect(() => trackingError(SERIES, BENCH.slice(1))).toThrow(/same length/);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The normal quantile and the percentile conventions
// ---------------------------------------------------------------------------------------------

describe('normalQuantile matches the published standard-normal quantiles', () => {
  it.each([
    [0.8, HAND.z80],
    [0.95, HAND.z95],
    [0.975, HAND.z975],
    [0.99, HAND.z99],
  ])('Φ⁻¹(%s)', (p, z) => {
    within(normalQuantile(p), z, 1e-12, `z(${p})`);
  });

  it('is antisymmetric and rejects a p outside (0, 1)', () => {
    within(normalQuantile(0.5), 0, 1e-15, 'z(0.5)');
    within(normalQuantile(0.05), -HAND.z95, 1e-12, 'z(0.05)');
    expect(() => normalQuantile(0)).toThrow(/0 < p < 1/);
    expect(() => normalQuantile(1)).toThrow(/0 < p < 1/);
  });
});

describe('percentileOf pins both conventions on the sorted §7.8 series', () => {
  it('type-7 linear interpolation', () => {
    within(percentileOf(SERIES, 0.05) * 100, -1.1375, 1e-12, 'p05 linear %');
    within(percentileOf(SERIES, 0.1) * 100, -1.025, 1e-12, 'p10 linear %');
    within(percentileOf(SERIES, 0.2) * 100, -0.8, 1e-12, 'p20 linear %');
    within(percentileOf(SERIES, 0) * 100, -1.25, 1e-14, 'min');
    within(percentileOf(SERIES, 1) * 100, 2.0, 1e-14, 'max');
  });

  it('nearest rank returns an actually observed return', () => {
    within(percentileOf(SERIES, 0.05, 'nearest-rank') * 100, -1.25, 1e-14, 'p05 nearest %');
    within(percentileOf(SERIES, 0.2, 'nearest-rank') * 100, -1.0, 1e-14, 'p20 nearest %');
    for (const p of [0.05, 0.2, 0.5, 0.9]) {
      expect(SERIES).toContain(percentileOf(SERIES, p, 'nearest-rank'));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. VaR (PORT-06)
// ---------------------------------------------------------------------------------------------

describe('historical VaR on the hand-checked series (PORT-06)', () => {
  it('is the (1 − confidence) percentile, reported as a positive loss', () => {
    const v = historicalVar(SERIES, undefined, PORTFOLIO_VALUE);
    expect(v.method).toBe('historical');
    expect(v.confidence).toBe(0.95);
    within(v.quantileReturn * 100, -1.1375, 1e-12, 'quantile %');
    within(v.varReturn * 100, 1.1375, 1e-12, 'VaR %');
    within(v.varAmount, 113_750, 1e-8, 'VaR amount');
    expect(v.zScore).toBeNull();
  });

  it('reports the historical expected shortfall of the same tail', () => {
    const v95 = historicalVar(SERIES, undefined, PORTFOLIO_VALUE);
    expect(v95.tailCount).toBe(1); // only −1.25 % is at or below −1.1375 %
    within(v95.expectedShortfallReturn ?? Number.NaN, 0.0125, 1e-15, 'ES 95 %');
    within(v95.expectedShortfallAmount ?? Number.NaN, 125_000, 1e-8, 'ES 95 % amount');

    const v80 = historicalVar(SERIES, { varConfidence: 0.8 }, PORTFOLIO_VALUE);
    expect(v80.tailCount).toBe(2); // −1.25 % and −1.00 %
    within(v80.expectedShortfallReturn ?? Number.NaN, 0.01125, 1e-15, 'ES 80 %');
  });

  it('the percentile convention is never silent: linear 0.80 % vs nearest-rank 1.00 %', () => {
    const linear = historicalVar(SERIES, { varConfidence: 0.8, percentileMethod: 'linear' });
    const nearest = historicalVar(SERIES, {
      varConfidence: 0.8,
      percentileMethod: 'nearest-rank',
    });
    within(linear.varReturn * 100, 0.8, 1e-12, 'linear 80 % VaR');
    within(nearest.varReturn * 100, 1.0, 1e-14, 'nearest-rank 80 % VaR');
    expect(linear.conventions.percentileMethod).toBe('linear');
    expect(nearest.conventions.percentileMethod).toBe('nearest-rank');
  });

  it('a series that never lost money reports a negative VaR rather than pretending', () => {
    const v = historicalVar([0.01, 0.02, 0.03, 0.04], { varConfidence: 0.95 });
    expect(v.varReturn).toBeLessThan(0);
  });
});

describe('parametric VaR on the hand-checked series (PORT-06)', () => {
  it('is z(confidence) × σ with the §7.8 σ', () => {
    const v = parametricVar(SERIES, undefined, PORTFOLIO_VALUE);
    expect(v.method).toBe('parametric');
    within(v.zScore ?? Number.NaN, HAND.z95, 1e-12, 'z(0.95)');
    within(v.varReturn, HAND.z95 * SIGMA_DAILY, 1e-15, 'VaR vs the hand chain');
    within(v.varReturn * 100, 1.808092, 1e-6, 'VaR % (1.808092)');
    within(v.varAmount, 180_809.245902, 1e-6, 'VaR amount');
  });

  it('scales by √horizon and takes the mean out only when asked', () => {
    const one = parametricVar(SERIES);
    const four = parametricVar(SERIES, { varHorizonPeriods: 4 });
    within(four.varReturn, one.varReturn * 2, 1e-15, '4-day VaR = 2 × 1-day VaR');

    const adjusted = parametricVar(SERIES, { parametricMeanAdjusted: true });
    within(adjusted.varReturn, one.varReturn - 0.0025, 1e-15, 'mean-adjusted VaR');
    expect(one.conventions.parametricMeanAdjusted).toBe(false);
    expect(adjusted.conventions.parametricMeanAdjusted).toBe(true);
  });

  it('99 % parametric VaR is 2.557220 %', () => {
    const v = parametricVar(SERIES, { varConfidence: 0.99 });
    within(v.varReturn, HAND.z99 * SIGMA_DAILY, 1e-15, '99 % VaR vs the hand chain');
    within(v.varReturn * 100, 2.55722, 1e-5, '99 % VaR %');
  });

  it('rejects a confidence outside (0, 1)', () => {
    expect(() => parametricVar(SERIES, { varConfidence: 95 })).toThrow(/decimal fraction/);
    expect(() => parametricVar(SERIES, { varConfidence: 0 })).toThrow(/decimal fraction/);
  });
});

describe('VaR exception backtesting (PORT-06)', () => {
  /**
   * Five quiet days then one crash, repeated: with a five-day rolling window the crash days are
   * exceptions and the quiet days are not, which is countable by hand.
   */
  const SERIES_WITH_CRASHES = [
    0.001,
    0.002,
    -0.001,
    0.0015,
    -0.0005, // window 0-4, no session tested
    -0.05,
    0.001,
    0.002,
    -0.001,
    0.0015, // index 5 is a crash → exception
    -0.05,
    0.001,
    0.002,
    -0.001,
    0.0015, // index 10 is a crash → exception
  ];

  it('counts an exception whenever the return breaches the VaR estimated from the prior window', () => {
    const b = varBacktest(SERIES_WITH_CRASHES, 5, 'historical', { varConfidence: 0.95 });
    expect(b.window).toBe(5);
    expect(b.sessions).toBe(10); // 15 returns − a 5-session warm-up
    expect(b.exceptionIndices).toEqual([5, 10]);
    expect(b.exceptions).toBe(2);
    within(b.expectedExceptions, 10 * 0.05, 1e-15, 'expected exceptions');
    within(b.exceptionRate ?? Number.NaN, 0.2, 1e-15, 'exception rate');
  });

  it('the parametric branch backtests the same way', () => {
    const b = varBacktest(SERIES_WITH_CRASHES, 5, 'parametric', { varConfidence: 0.95 });
    expect(b.method).toBe('parametric');
    expect(b.exceptionIndices).toContain(5);
    expect(b.sessions).toBe(10);
  });

  it('rejects a window shorter than the sample the variance needs', () => {
    expect(() => varBacktest(SERIES, 1)).toThrow(/window must be an integer/);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Exposure: the book the scenarios run on (cash, shorts and weights that sum)
// ---------------------------------------------------------------------------------------------

const BOOK: readonly Position[] = [
  {
    instrumentId: 'AAPL',
    assetClass: 'equity',
    sector: 'Information Technology',
    currency: 'USD',
    quantity: 12_000,
    price: 250,
  },
  {
    instrumentId: 'SAP',
    assetClass: 'equity',
    sector: 'Information Technology',
    currency: 'EUR',
    quantity: 10_000,
    price: 160,
    fxRate: 1.25,
  },
  {
    instrumentId: 'TSLA',
    assetClass: 'equity',
    sector: 'Consumer Discretionary',
    currency: 'USD',
    quantity: -5_000,
    price: 200,
  },
  { instrumentId: 'UST_10Y', assetClass: 'govt', currency: 'USD', marketValue: 4_000_000 },
  { instrumentId: 'CASH_USD', assetClass: 'cash', currency: 'USD', marketValue: 2_000_000 },
];

describe('exposure aggregation with cash and a short', () => {
  const e = exposure(BOOK);

  it('values each line in the base currency, FX included', () => {
    const mv = Object.fromEntries(e.positions.map((p) => [p.instrumentId, p.marketValue]));
    expect(mv.AAPL).toBe(3_000_000); // 12,000 × 250
    expect(mv.SAP).toBe(2_000_000); // 10,000 × 160 EUR × 1.25
    expect(mv.TSLA).toBe(-1_000_000); // −5,000 × 200, a short
    expect(mv.UST_10Y).toBe(4_000_000);
    expect(mv.CASH_USD).toBe(2_000_000);
  });

  it('separates net asset value, gross exposure and cash', () => {
    expect(e.netAssetValue).toBe(10_000_000);
    expect(e.longExposure).toBe(9_000_000);
    expect(e.shortExposure).toBe(-1_000_000);
    expect(e.netExposure).toBe(8_000_000);
    expect(e.grossExposure).toBe(10_000_000); // cash excluded by convention
    expect(e.cash).toBe(2_000_000);
    expect(e.cashWeight).toBe(0.2);
    expect(e.netLeverage).toBe(0.8);
    expect(e.grossLeverage).toBe(1);
    expect(e.longCount).toBe(3);
    expect(e.shortCount).toBe(1);
  });

  it('gives the short a negative net weight and a positive gross weight', () => {
    const tsla = e.positions.find((p) => p.instrumentId === 'TSLA');
    expect(tsla?.isShort).toBe(true);
    expect(tsla?.netWeight).toBe(-0.1);
    expect(tsla?.grossWeight).toBe(0.1);
    const cash = e.positions.find((p) => p.instrumentId === 'CASH_USD');
    expect(cash?.isCash).toBe(true);
    expect(cash?.netWeight).toBe(0.2);
    expect(cash?.grossWeight).toBe(0); // cash carries no market exposure
  });

  it('weights sum correctly on every dimension', () => {
    for (const b of [e.bySector, e.byAssetClass, e.byCurrency]) {
      expect(b.netWeightSum).toBe(1);
      expect(b.grossWeightSum).toBe(1);
    }
    expect(e.positions.reduce((a, p) => a + p.netWeight, 0)).toBe(1);
  });

  it('buckets by sector, with cash and the unclassified govt line in their own buckets', () => {
    expect(e.bySector.buckets.map((b) => b.key)).toEqual([
      'Cash',
      'Consumer Discretionary',
      'Information Technology',
      'Unclassified',
    ]);
    const tech = e.bySector.buckets.find((b) => b.key === 'Information Technology');
    expect(tech?.marketValue).toBe(5_000_000);
    expect(tech?.netWeight).toBe(0.5);
    expect(tech?.positions).toBe(2);
    const cons = e.bySector.buckets.find((b) => b.key === 'Consumer Discretionary');
    expect(cons?.marketValue).toBe(-1_000_000);
    expect(cons?.longMarketValue).toBe(0);
    expect(cons?.shortMarketValue).toBe(-1_000_000);
    expect(cons?.grossMarketValue).toBe(1_000_000);
    expect(cons?.netWeight).toBe(-0.1);
    expect(cons?.grossWeight).toBe(0.1);
  });

  it('buckets by asset class and by currency', () => {
    expect(e.byAssetClass.buckets.map((b) => b.key)).toEqual(['cash', 'equity', 'govt']);
    expect(e.byAssetClass.buckets.find((b) => b.key === 'equity')?.marketValue).toBe(4_000_000);
    expect(e.byCurrency.buckets.map((b) => b.key)).toEqual(['EUR', 'USD']);
    expect(e.byCurrency.buckets.find((b) => b.key === 'EUR')?.netWeight).toBe(0.2);
    expect(e.byCurrency.buckets.find((b) => b.key === 'USD')?.netWeight).toBe(0.8);
  });

  it('echoes its conventions (ANAL-07) and refuses a zero-NAV book', () => {
    expect(e.conventions.baseCurrency).toBe('USD');
    expect(e.conventions.cashExcludedFromGross).toBe(true);
    expect(e.conventions.netWeightBasis).toContain('netAssetValue');
    expect(e.conventions.shortTreatment).toContain('negative');
    expect(() =>
      exposure([
        { instrumentId: 'A', assetClass: 'equity', currency: 'USD', marketValue: 100 },
        { instrumentId: 'B', assetClass: 'equity', currency: 'USD', marketValue: -100 },
      ]),
    ).toThrow(/net asset value is exactly zero/);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Scenario shocks (PORT-05)
// ---------------------------------------------------------------------------------------------

const HOLDINGS: readonly RiskHolding[] = [
  {
    instrumentId: 'UST_10Y',
    assetClass: 'govt',
    currency: 'USD',
    marketValue: 4_000_000,
    dv01: 3_200,
    keyRateDv01: { '2Y': 300, '5Y': 400, '10Y': 2_500, '30Y': 0 },
  },
  {
    instrumentId: 'AAPL',
    assetClass: 'equity',
    currency: 'USD',
    marketValue: 3_000_000,
    beta: 1.2,
  },
  { instrumentId: 'SAP', assetClass: 'equity', currency: 'EUR', marketValue: 2_000_000, beta: 0.9 },
  { instrumentId: 'CASH_USD', assetClass: 'cash', currency: 'USD', marketValue: 1_000_000 },
];

describe('scenario shocks move the book by the hand-computed amount (PORT-05)', () => {
  it('a parallel curve shift moves the book by −dv01 × bp and leaves equities alone', () => {
    const s = applyScenario(HOLDINGS, 'UST_PARALLEL_UP_100');
    expect(s.id).toBe('UST_PARALLEL_UP_100');
    expect(s.pnl).toBe(-320_000);
    expect(s.netAssetValue).toBe(10_000_000);
    within(s.pnlPct ?? Number.NaN, -0.032, 1e-15, 'parallel P&L %');
    const byId = Object.fromEntries(s.byHolding.map((h) => [h.instrumentId, h.pnl]));
    expect(byId.UST_10Y).toBe(-320_000);
    expect(byId.AAPL).toBe(0);
    expect(byId.SAP).toBe(0);
    expect(byId.CASH_USD).toBe(0);
    expect(s.unpricedInstrumentIds).toEqual([]);
  });

  it('a rally is the exact mirror of the sell-off', () => {
    expect(applyScenario(HOLDINGS, 'UST_PARALLEL_DN_100').pnl).toBe(320_000);
  });

  it('a non-parallel (steepener) shift uses the key-rate DV01s, sign by sign', () => {
    const s = applyScenario(HOLDINGS, 'UST_STEEPEN_50');
    // −(300 × −25 + 400 × 0 + 2,500 × +25 + 0 × +25) = −(−7,500 + 62,500) = −55,000
    expect(s.pnl).toBe(-55_000);
    expect(s.byHolding.find((h) => h.instrumentId === 'UST_10Y')?.pnl).toBe(-55_000);
    // The short end rallying is a gain; the long end selling off is a bigger loss.
    expect(s.pnl).toBeGreaterThan(applyScenario(HOLDINGS, 'UST_PARALLEL_UP_100').pnl);
  });

  it('an equity shock travels through beta and leaves bonds and cash alone', () => {
    const s = applyScenario(HOLDINGS, 'EQUITY_DOWN_10');
    const byId = Object.fromEntries(s.byHolding.map((h) => [h.instrumentId, h.pnl]));
    expect(byId.AAPL).toBe(-360_000); // 3,000,000 × 1.20 × −0.10
    expect(byId.SAP).toBe(-180_000); // 2,000,000 × 0.90 × −0.10
    expect(byId.UST_10Y).toBe(0);
    expect(byId.CASH_USD).toBe(0);
    expect(s.pnl).toBe(-540_000);
    // The 20 % shock is exactly twice the 10 % shock — the model is linear in the shock.
    expect(applyScenario(HOLDINGS, 'EQUITY_DOWN_20').pnl).toBe(-1_080_000);
  });

  it('an FX move reprices only the non-base-currency holdings, exactly', () => {
    const s = applyScenario(HOLDINGS, 'USD_UP_5');
    within(s.pnl, 2_000_000 * (1 / 1.05 - 1), 1e-15, 'USD_UP_5 P&L');
    // 2,000,000 × (1/1.05 − 1) = 2,000,000 × (−0.05/1.05) = −2,000,000/21 = −95,238.0952380952…
    within(s.pnl, -2_000_000 / 21, 1e-6, 'USD_UP_5 P&L vs the hand value');
    const byId = Object.fromEntries(s.byHolding.map((h) => [h.instrumentId, h.pnl]));
    expect(byId.SAP).toBe(s.pnl);
    expect(byId.AAPL).toBe(0);
    expect(byId.CASH_USD).toBe(0);
    // A dollar sell-off is a gain on the EUR line, and not the mirror image — 1/(1−p) ≠ 2 − 1/(1+p).
    const down = applyScenario(HOLDINGS, 'USD_DN_5');
    within(down.pnl, 2_000_000 * (1 / 0.95 - 1), 1e-15, 'USD_DN_5 P&L');
    expect(down.pnl).toBeGreaterThan(0);
  });

  it('with EUR as the base currency the same move hits the USD lines instead', () => {
    const conventions: PortfolioRiskConventionOverrides = { baseCurrency: 'EUR' };
    const s = applyScenario(HOLDINGS, 'USD_UP_5', conventions);
    const byId = Object.fromEntries(s.byHolding.map((h) => [h.instrumentId, h.pnl]));
    expect(byId.SAP).toBe(0);
    within(byId.AAPL ?? Number.NaN, 3_000_000 * (1 / 1.05 - 1), 1e-15, 'AAPL under EUR base');
    within(byId.CASH_USD ?? Number.NaN, 1_000_000 * (1 / 1.05 - 1), 1e-15, 'cash under EUR base');
  });

  it('a multi-leg scenario is the sum of its legs', () => {
    const combined = applyScenario(HOLDINGS, {
      id: 'RATES_AND_EQUITY',
      description: 'curve +100bp and equities −10 % together',
      shocks: [
        { kind: 'curveParallel', shiftBp: 100 },
        { kind: 'equity', shockPct: -0.1 },
      ],
    });
    expect(combined.pnl).toBe(-320_000 + -540_000);
    expect(combined.byHolding.find((h) => h.instrumentId === 'UST_10Y')?.pnl).toBe(-320_000);
  });

  it('flags a rate-sensitive holding whose sensitivity is missing instead of scoring it zero', () => {
    const missing: readonly RiskHolding[] = [
      { instrumentId: 'UST_2Y', assetClass: 'govt', currency: 'USD', marketValue: 1_000_000 },
      { instrumentId: 'AAPL', assetClass: 'equity', currency: 'USD', marketValue: 1_000_000 },
    ];
    const s = applyScenario(missing, 'UST_PARALLEL_UP_100');
    expect(s.pnl).toBe(0);
    expect(s.unpricedInstrumentIds).toEqual(['UST_2Y']); // the equity is legitimately unaffected
  });

  it('falls back to the sum of the key-rate DV01s for a parallel shift with no aggregate DV01', () => {
    const krOnly: readonly RiskHolding[] = [
      {
        instrumentId: 'UST_10Y',
        assetClass: 'govt',
        currency: 'USD',
        marketValue: 4_000_000,
        keyRateDv01: { '2Y': 300, '5Y': 400, '10Y': 2_500, '30Y': 0 },
      },
    ];
    expect(applyScenario(krOnly, 'UST_PARALLEL_UP_100').pnl).toBe(-320_000);
    expect(applyScenario(krOnly, 'UST_PARALLEL_UP_100').unpricedInstrumentIds).toEqual([]);
  });

  it('defaults beta to 1 for equity-like classes and 0 elsewhere', () => {
    const noBeta: readonly RiskHolding[] = [
      { instrumentId: 'SPY', assetClass: 'etf', currency: 'USD', marketValue: 1_000_000 },
      { instrumentId: 'BTC', assetClass: 'crypto', currency: 'USD', marketValue: 1_000_000 },
    ];
    const s = applyScenario(noBeta, 'EQUITY_DOWN_10');
    const byId = Object.fromEntries(s.byHolding.map((h) => [h.instrumentId, h.pnl]));
    expect(byId.SPY).toBe(-100_000);
    expect(byId.BTC).toBe(0);
  });

  it('names an unknown scenario rather than returning zero', () => {
    expect(() => applyScenario(HOLDINGS, 'NOT_A_SCENARIO')).toThrow(/unknown scenario/);
    expect(Object.keys(NAMED_SCENARIOS)).toEqual([
      'UST_PARALLEL_UP_100',
      'UST_PARALLEL_DN_100',
      'UST_STEEPEN_50',
      'EQUITY_DOWN_10',
      'EQUITY_DOWN_20',
      'USD_UP_5',
      'USD_DN_5',
    ]);
  });

  it('scenarioAnalysis runs the whole list over the same book', () => {
    const all = scenarioAnalysis(HOLDINGS, [
      'UST_PARALLEL_UP_100',
      'UST_STEEPEN_50',
      'EQUITY_DOWN_10',
      'USD_UP_5',
    ]);
    expect(all.map((s) => s.id)).toEqual([
      'UST_PARALLEL_UP_100',
      'UST_STEEPEN_50',
      'EQUITY_DOWN_10',
      'USD_UP_5',
    ]);
    within(
      all.reduce((a, s) => a + s.pnl, 0),
      -1_010_238.095238095,
      1e-6,
      'total scenario P&L',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Conventions are stated (ANAL-07)
// ---------------------------------------------------------------------------------------------

describe('every convention is stated in the returned Conventions object (ANAL-07)', () => {
  const conv = portfolioRisk({ returns: SERIES, benchmark: BENCH }).conventions;

  it('carries the statistics conventions of TESTING §7.8', () => {
    expect(conv.returns).toBe('simple');
    expect(conv.annualisation).toBe(252);
    expect(conv.ddof).toBe(1);
    expect(conv.riskFree).toBe(0.02);
    expect(conv.volAnnualisation).toBe('sqrt-time');
  });

  it('carries the VaR and scenario conventions', () => {
    expect(conv.varConfidence).toBe(0.95);
    expect(conv.percentileMethod).toBe('linear');
    expect(conv.parametricMeanAdjusted).toBe(false);
    expect(conv.varHorizonPeriods).toBe(1);
    expect(conv.baseCurrency).toBe('USD');
    expect(conv.trackingErrorBasis).toContain('ex-post');
    expect(conv.historicalVarBasis).toContain('quantile');
    expect(conv.parametricVarBasis).toContain('z(confidence)');
    expect(conv.varSign).toContain('positive loss magnitude');
    expect(conv.varBacktestBasis).toContain('exception');
    expect(conv.dv01Sign).toContain('+1bp');
    expect(conv.equityShockBasis).toContain('beta');
    expect(conv.fxShockBasis).toContain('1/(1 + p) − 1');
    expect(conv.scenarioBasis).toContain('first-order');
  });

  it('states the two documented gaps rather than leaving them blank', () => {
    expect(conv.monteCarloVar).toContain('VAR_MC_NOT_IN_V1');
    expect(conv.factorModel).toContain('NO_FACTOR_MODEL');
    expect(portfolioRisk({ returns: SERIES }).monteCarloVarReturn).toBeNull();
  });

  it('is frozen, and the defaults are the documented ones', () => {
    expect(Object.isFrozen(conv)).toBe(true);
    expect(DEFAULT_PORTFOLIO_RISK_CONVENTIONS.varConfidence).toBe(0.95);
    expect(DEFAULT_PORTFOLIO_RISK_CONVENTIONS.percentileMethod).toBe('linear');
  });
});

// ---------------------------------------------------------------------------------------------
// 7. The engines and the golden files
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: {
    returns?: number[];
    benchmark?: number[];
    positions?: Position[];
    portfolioValue?: number;
    holdings?: RiskHolding[];
    scenarios?: string[];
    conventions?: PortfolioRiskConventionOverrides & ExposureConventionOverrides;
  };
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

const goldenAt = (name: string): GoldenCase[] =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../../../fixtures/golden/analytics/portfolio/${name}.json`, import.meta.url),
      ),
      'utf8',
    ),
  ) as GoldenCase[];

const RISK_GOLDEN = goldenAt('risk');
const EXPOSURE_GOLDEN = goldenAt('exposure');

function assertGolden(c: GoldenCase, outputs: Record<string, unknown>): void {
  for (const [key, expected] of Object.entries(c.expected)) {
    const actual = outputs[key];
    if (typeof expected === 'number') {
      expect(typeof actual, `${c.id}.${key} should be numeric`).toBe('number');
      within(actual as number, expected, c.tol[key] ?? 0, `${c.id}.${key}`);
    } else {
      expect(actual, `${c.id}.${key}`).toBe(expected);
    }
  }
}

describe('portfolio/risk engine (ANAL-08) and fixtures/golden/analytics/portfolio/risk.json', () => {
  it('runs through defineEngine with a stable inputsHash', () => {
    const a = portfolioRiskEngine({ returns: SERIES, benchmark: BENCH }, VALUATION_TS);
    const b = portfolioRiskEngine({ benchmark: BENCH, returns: SERIES }, VALUATION_TS);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.inputsHash).toBe(a.inputsHash); // key order is irrelevant
    expect(portfolioRiskEngine({ returns: SERIES }, VALUATION_TS).inputsHash).not.toBe(
      a.inputsHash,
    );
    expect(a.engine).toEqual({ name: 'portfolio/risk', version: '1.0.0' });
    expect(a.valuationTs).toBe(VALUATION_TS);
  });

  it('covers the golden file', () => {
    expect(RISK_GOLDEN.map((c) => c.id)).toEqual([
      'portfolio.risk.te.var.10',
      'portfolio.risk.var.linear.80',
      'portfolio.risk.var.nearestRank.80',
      'portfolio.risk.scenarios',
    ]);
    for (const c of RISK_GOLDEN) {
      expect(c.engine).toBe('portfolio/risk');
      expect(c.engineVersion).toBe(portfolioRiskEngine.version);
      expect(c.source.length).toBeGreaterThan(0);
      expect(Object.keys(c.tol).sort()).toEqual(Object.keys(c.expected).sort());
      expect(c.inputs.returns).toEqual(SERIES); // every case runs on the §7.8 series
    }
    expect(RISK_GOLDEN[0]?.inputs.benchmark).toEqual(BENCH);
  });

  it.each(RISK_GOLDEN.map((c) => [c.id, c] as const))('golden case %s', (_id, c) => {
    const result = portfolioRiskEngine(
      {
        returns: c.inputs.returns ?? [],
        ...(c.inputs.benchmark === undefined ? {} : { benchmark: c.inputs.benchmark }),
        ...(c.inputs.portfolioValue === undefined
          ? {}
          : { portfolioValue: c.inputs.portfolioValue }),
        ...(c.inputs.holdings === undefined ? {} : { holdings: c.inputs.holdings }),
        ...(c.inputs.scenarios === undefined ? {} : { scenarios: c.inputs.scenarios }),
        ...(c.inputs.conventions === undefined ? {} : { conventions: c.inputs.conventions }),
      },
      c.valuationTs,
    );
    assertGolden(c, result.outputs as unknown as Record<string, unknown>);
    for (const [key, value] of Object.entries(c.inputs.conventions ?? {})) {
      expect(result.outputs.conventions[key], `${c.id} conventions.${key}`).toBe(value);
    }
  });

  it('the scenario golden also pins each individual scenario P&L', () => {
    const c = RISK_GOLDEN[3]!;
    const outputs = portfolioRiskEngine(
      {
        returns: c.inputs.returns ?? [],
        holdings: c.inputs.holdings ?? [],
        scenarios: c.inputs.scenarios ?? [],
      },
      c.valuationTs,
    ).outputs;
    const pnl = Object.fromEntries(outputs.scenarios.map((s) => [s.id, s.pnl]));
    expect(pnl.UST_PARALLEL_UP_100).toBe(-320_000);
    expect(pnl.UST_STEEPEN_50).toBe(-55_000);
    expect(pnl.EQUITY_DOWN_10).toBe(-540_000);
    within(pnl.USD_UP_5 ?? Number.NaN, -2_000_000 / 21, 1e-6, 'USD_UP_5'); // −2,000,000/21
    expect(outputs.scenarioWorstId).toBe('EQUITY_DOWN_10');
  });
});

describe('portfolio/exposure engine and fixtures/golden/analytics/portfolio/exposure.json', () => {
  it('covers the golden file', () => {
    expect(EXPOSURE_GOLDEN.map((c) => c.id)).toEqual(['portfolio.exposure.longShortCash']);
    for (const c of EXPOSURE_GOLDEN) {
      expect(c.engine).toBe('portfolio/exposure');
      expect(c.engineVersion).toBe(exposureEngine.version);
      expect(Object.keys(c.tol).sort()).toEqual(Object.keys(c.expected).sort());
      expect(Object.values(c.tol).every((t) => t === 0)).toBe(true);
    }
    expect(EXPOSURE_GOLDEN[0]?.inputs.positions).toEqual(BOOK);
  });

  it.each(EXPOSURE_GOLDEN.map((c) => [c.id, c] as const))('golden case %s', (_id, c) => {
    const result = exposureEngine(
      {
        positions: c.inputs.positions ?? [],
        ...(c.inputs.conventions === undefined ? {} : { conventions: c.inputs.conventions }),
      },
      c.valuationTs,
    );
    assertGolden(c, result.outputs as unknown as Record<string, unknown>);
    expect(result.engine).toEqual({ name: 'portfolio/exposure', version: '1.0.0' });
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
