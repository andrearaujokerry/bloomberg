/**
 * `test/integration/portfolio/analytics.test.ts` — PORT-03 … PORT-06 (WORKPLAN WP-10 acceptance
 * row: "attribution sums to active return; VaR and tracking error against a golden portfolio").
 *
 * The portfolio is `fixtures/golden/portfolio/demo-long.json`: five lines in two sectors and two
 * currencies, a 126-session return series for the book and for its benchmark, and an `expected`
 * block computed by an implementation of the documented formulas that does **not** call
 * `core/analytics`. Every number below is therefore checked twice — against that committed block,
 * and against a recomputation written out inline here — so a passing run is a statement about the
 * engines rather than about itself. The fixture pins the numbers so a later refactor that changes
 * one has to say so.
 *
 * Two things this file deliberately does *not* do:
 *
 *  * **It does not re-derive the identity it is testing.** `allocation + selection + interaction`
 *    must equal the active return for *any* input, so that is asserted as an identity over the
 *    engine's own output (with `residual` as the engine's own report of the floating-point gap) —
 *    not against a spot value that would pass for one portfolio and hide a sign error in another.
 *  * **It does not mock the positions.** The book is written through the real
 *    `PUT /portfolios/:id/positions` path and read back through `data/portfolio.ts`, so the
 *    analytics run over rows that survived a round trip through Postgres `numeric`, which is where
 *    a quantity silently becomes a string.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  alignReturns,
  attributionOf,
  datedSimpleReturns,
  exposureOf,
  riskOf,
  simpleReturns,
  valueHoldings,
  weightedReturnSeries,
  type DatedReturns,
  type ValuedHolding,
} from '../../../src/portfolio/service.js';
import { readPositions } from '../../../src/data/portfolio.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { call, newActor, newEquity, newFirm, type Actor } from './helpers.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden portfolio
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface GoldenHolding {
  identifier: string;
  sector: string | null;
  assetClass: string;
  quantity: number;
  costPrice: number | null;
  price: number | null;
  currency: string;
  fxRate: number;
  isCash?: boolean;
}

interface Golden {
  asOfDate: string;
  valuationTs: string;
  baseCurrency: string;
  holdings: GoldenHolding[];
  attribution: {
    portfolio: { segment: string; weight: number; return: number }[];
    benchmark: { segment: string; weight: number; return: number }[];
  };
  series: { portfolio: number[]; benchmark: number[] };
  expected: Record<string, number>;
}

const GOLDEN: Golden = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../../fixtures/golden/portfolio/demo-long.json', import.meta.url),
    ),
    'utf8',
  ),
) as Golden;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Independent statistics — the second opinion every assertion below is checked against
// ─────────────────────────────────────────────────────────────────────────────────────────────

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation (`ddof = 1`), the ANAL-07 convention. */
const stdev = (xs: readonly number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** The type-7 (linear) quantile `percentileOf` documents; `p` is a fraction. */
const percentile = (xs: readonly number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const h = p * (s.length - 1);
  const lo = Math.floor(h);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
};

/** `Φ⁻¹(0.95)` and `Φ⁻¹(0.99)` to double precision — the two the spec names. */
const Z95 = 1.6448536269514722;
const Z99 = 2.3263478740408408;

const ANNUALISATION = Math.sqrt(252);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t: TestDb = withTxDb();
const clock = testClock();

let harness: TestApp;
let app: FastifyInstance;
let pm: Actor;
let portfolioId: number;
/** The golden holdings, each bound to an instrument this test seeded. */
let holdings: ValuedHolding[];

beforeEach(async () => {
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;

  const firmId = await newFirm(t, 'Analytics Desk');
  pm = await newActor(t, firmId, 'PM');

  // Bind each golden line to a real instrument, so the book is one the master knows.
  const bound: { golden: GoldenHolding; key: string; instrumentId: number | null }[] = [];
  for (const golden of GOLDEN.holdings) {
    if (golden.isCash === true) {
      bound.push({ golden, key: golden.currency, instrumentId: null });
      continue;
    }
    const equity = await newEquity(t, golden.sector ?? 'Unclassified');
    bound.push({ golden, key: equity.key, instrumentId: equity.instrumentId });
  }

  const created = await call(app, pm, 'POST', '/portfolios', {
    name: `Golden Long ${String(Date.parse(GOLDEN.asOfDate))}`,
    baseCurrency: GOLDEN.baseCurrency,
  });
  expect(created.statusCode, created.payload).toBe(201);
  portfolioId = created.json<{ portfolioId: number }>().portfolioId;

  const written = await call(app, pm, 'PUT', `/portfolios/${String(portfolioId)}/positions`, {
    asOfDate: GOLDEN.asOfDate,
    positions: bound.map((b) => ({
      identifier: b.key,
      quantity: b.golden.quantity,
      ...(b.golden.costPrice === null ? {} : { costPrice: b.golden.costPrice }),
      ...(b.golden.isCash === true
        ? { isCash: true, cashCurrency: b.golden.currency }
        : { costCurrency: b.golden.currency }),
    })),
  });
  expect(written.statusCode, written.payload).toBe(200);

  // Read the book back out of Postgres and price it from the fixture, exactly as the PORT resolver
  // will price it from the plant: nothing below sees the numbers that went in.
  const at = { validAt: new Date(clock.now()), knownAt: new Date(clock.now()) };
  const stored = await readPositions(t.db, at, { firmId, userId: pm.userId }, portfolioId);
  const byKey = new Map(bound.map((b) => [b.key, b.golden]));
  holdings = stored.map((position): ValuedHolding => {
    const golden = byKey.get(position.identifier);
    if (golden === undefined) throw new Error(`unbound position ${position.identifier}`);
    return {
      key: position.identifier,
      instrumentId: position.instrument?.instrumentId ?? null,
      assetClass: golden.isCash === true ? 'cash' : 'equity',
      sector: golden.sector,
      currency: golden.currency,
      quantity: position.quantity,
      price: golden.price,
      costPrice: position.costPrice,
      fxRate: golden.fxRate,
      isCash: position.isCash,
    };
  });
  expect(holdings).toHaveLength(GOLDEN.holdings.length);
});

afterEach(async () => {
  await harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Valuation and exposure (PORT-02, PORT-03)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('valuation and exposure', () => {
  it('values the book in its base currency and agrees with the exposure engine', () => {
    const valuation = valueHoldings(holdings, GOLDEN.baseCurrency);

    expect(valuation.unpricedKeys).toEqual([]);
    expect(valuation.pricedWeight).toBe(1);
    // Two gross figures, because they answer two questions. `grossMv` is §PORT step 5's
    // `Σ|marketValue|` over the whole book — the one base every weight is taken against, cash
    // included — and `grossSecuritiesMv` is market *exposure*, which by convention excludes cash
    // and is what the exposure engine reports.
    expect(valuation.grossSecuritiesMv).toBeCloseTo(GOLDEN.expected.portfolioValue!, 6);
    expect(valuation.grossMv).toBeCloseTo(GOLDEN.expected.portfolioValue! + 50_000, 6);
    expect(valuation.grossMv).toBeCloseTo(404_400, 6);
    // Long 250 000 + 60 000 + 26 400, short −18 000, cash 50 000.
    expect(valuation.longMv).toBeCloseTo(336_400, 6);
    expect(valuation.shortMv).toBeCloseTo(-18_000, 6);
    expect(valuation.cash).toBeCloseTo(50_000, 6);
    expect(valuation.netMv).toBeCloseTo(368_400, 6);

    const { outputs, engine } = exposureOf(holdings, {
      baseCurrency: GOLDEN.baseCurrency,
      valuationTs: GOLDEN.valuationTs,
    });
    expect(engine.name).toBe('portfolio/exposure');
    expect(engine.version).toBe('1.0.0');
    expect(engine.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    expect(outputs.grossExposure).toBeCloseTo(valuation.grossSecuritiesMv, 6);
    expect(outputs.netAssetValue).toBeCloseTo(valuation.netMv, 6);
    expect(outputs.cash).toBeCloseTo(valuation.cash, 6);
    // Gross weights sum to 1 over the non-cash book — the invariant the weight column depends on.
    expect(outputs.bySector.grossWeightSum).toBeCloseTo(1, 12);

    const bucket = (key: string) => {
      const found = outputs.bySector.buckets.find((b) => b.key === key);
      expect(found, `sector bucket ${key}`).toBeDefined();
      return found!;
    };
    // Gross, so the short adds to its sector rather than cancelling the long beside it.
    expect(bucket('Information Technology').grossMarketValue).toBeCloseTo(268_000, 6);
    expect(bucket('Information Technology').marketValue).toBeCloseTo(232_000, 6);
    expect(bucket('Health Care').grossMarketValue).toBeCloseTo(86_400, 6);
    // Cash is a position for NAV and is excluded from gross exposure by convention, so it is the
    // signed market value that carries it.
    expect(bucket('Cash').marketValue).toBeCloseTo(50_000, 6);
    expect(bucket('Cash').grossMarketValue).toBe(0);
  });

  it('excludes an unpriced line from the totals and says so, rather than valuing it at zero', () => {
    // The biggest line — 1 000 shares at 250, cost 180 — loses its price.
    const biggest = holdings.find((h) => h.price === 250)!;
    const broken = holdings.map((h) => (h.key === biggest.key ? { ...h, price: null } : h));
    const valuation = valueHoldings(broken, GOLDEN.baseCurrency);

    expect(valuation.unpricedKeys).toEqual([biggest.key]);
    const row = valuation.rows.find((r) => r.key === biggest.key)!;
    expect(row.marketValue).toBeNull();
    expect(row.reason).toBe('PRICE_MISSING');
    expect(valuation.grossSecuritiesMv).toBeCloseTo(104_400, 6);
    expect(valuation.grossMv).toBeCloseTo(154_400, 6);
    // The line still counts against `pricedWeight` at its cost (1 000 × 180), so the screen is
    // warned rather than flattered. Cash is stated at par and counts as priced.
    expect(valuation.pricedWeight).toBeCloseTo(154_400 / (154_400 + 180_000), 12);
  });

  it('marks a holding whose FX pair is missing, and never converts at 1', () => {
    const noFx = holdings.map((h) => (h.currency === 'EUR' ? { ...h, fxRate: null } : h));
    const valuation = valueHoldings(noFx, GOLDEN.baseCurrency);
    const row = valuation.rows.find((r) => r.reason !== null);
    expect(row?.reason).toBe('FX_MISSING');
    expect(row?.marketValue).toBeNull();
    expect(valuation.grossSecuritiesMv).toBeCloseTo(328_000, 6);
    expect(valuation.grossMv).toBeCloseTo(378_000, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Attribution (PORT-03)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Brinson–Fachler attribution (PORT-03)', () => {
  const run = () =>
    attributionOf({
      portfolio: GOLDEN.attribution.portfolio.map((s) => ({
        segment: s.segment,
        weight: s.weight,
        return: s.return,
      })),
      benchmark: GOLDEN.attribution.benchmark.map((s) => ({
        segment: s.segment,
        weight: s.weight,
        return: s.return,
      })),
      valuationTs: GOLDEN.valuationTs,
    });

  it('decomposes the active return, and the three terms sum to it', () => {
    const { outputs, engine } = run();

    expect(engine.name).toBe('portfolio/attribution');
    expect(engine.version).toBe('1.0.0');

    // The identity, asserted as an identity: whatever the inputs, the parts add up to the whole.
    expect(outputs.allocation + outputs.selection + outputs.interaction).toBeCloseTo(
      outputs.activeReturn,
      12,
    );
    expect(outputs.total).toBeCloseTo(outputs.activeReturn, 12);
    expect(Math.abs(outputs.residual)).toBeLessThan(1e-12);

    // And the active return itself is what the two books' returns say it is — computed here, not
    // taken from the engine.
    const rP = GOLDEN.attribution.portfolio.reduce((a, s) => a + s.weight * s.return, 0);
    const rB = GOLDEN.attribution.benchmark.reduce((a, s) => a + s.weight * s.return, 0);
    expect(outputs.portfolioReturn).toBeCloseTo(rP, 12);
    expect(outputs.benchmarkReturn).toBeCloseTo(rB, 12);
    expect(outputs.activeReturn).toBeCloseTo(rP - rB, 12);
  });

  it('sums each segment’s three terms to that segment’s total, and the segments to the whole', () => {
    const { outputs } = run();

    // Five segments: three held, two benchmark-only, each present on both sides with a zero where
    // it is unheld.
    expect(outputs.segments.map((s) => s.segment)).toEqual([
      'Energy',
      'Financials',
      'Health Care',
      'Information Technology',
    ]);

    for (const segment of outputs.segments) {
      expect(
        segment.allocation + segment.selection + segment.interaction,
        `segment ${segment.segment}`,
      ).toBeCloseTo(segment.total, 12);
    }
    expect(outputs.segments.reduce((a, s) => a + s.total, 0)).toBeCloseTo(outputs.activeReturn, 12);

    // An off-benchmark sector carries the portfolio's whole weight as active weight, and an unheld
    // benchmark sector a negative one — never a null.
    const financials = outputs.segments.find((s) => s.segment === 'Financials');
    expect(financials?.benchmarkWeight).toBe(0);
    expect(financials?.activeWeight).toBeCloseTo(0.1, 12);
    const energy = outputs.segments.find((s) => s.segment === 'Energy');
    expect(energy?.portfolioWeight).toBe(0);
    expect(energy?.activeWeight).toBeCloseTo(-0.25, 12);
  });

  it('is reproducible: two runs at the same asOf carry the same inputsHash (ANAL-08)', () => {
    expect(run().engine.inputsHash).toBe(run().engine.inputsHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Risk: tracking error, VaR, backtest and scenarios (PORT-04, PORT-05, PORT-06)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('ex-post risk and VaR against the golden portfolio (PORT-04, PORT-06)', () => {
  const portfolioValue = GOLDEN.expected.portfolioValue!;

  const run = (confidence: 0.95 | 0.99 = 0.95) =>
    riskOf({
      returns: GOLDEN.series.portfolio,
      benchmark: GOLDEN.series.benchmark,
      portfolioValue,
      backtestWindow: 60,
      varConfidence: confidence,
      valuationTs: GOLDEN.valuationTs,
    });

  it('reports the volatility and tracking error the series imply', () => {
    const { outputs, engine } = run();
    const active = GOLDEN.series.portfolio.map((r, i) => r - GOLDEN.series.benchmark[i]!);

    expect(engine.name).toBe('portfolio/risk');
    expect(outputs.n).toBe(GOLDEN.expected.sessions);

    expect(outputs.meanPeriod).toBeCloseTo(mean(GOLDEN.series.portfolio), 15);
    expect(outputs.meanPeriod).toBeCloseTo(GOLDEN.expected.meanPeriod!, 15);
    expect(outputs.stdevPeriod).toBeCloseTo(stdev(GOLDEN.series.portfolio), 15);
    expect(outputs.stdevPeriod).toBeCloseTo(GOLDEN.expected.stdevPeriod!, 15);
    expect(outputs.volAnnualised * 100).toBeCloseTo(GOLDEN.expected.volAnnualisedPct!, 10);

    // PORT-04: tracking error is the annualised dispersion of the active return.
    expect(outputs.trackingErrorPeriod).toBeCloseTo(stdev(active), 15);
    expect(outputs.trackingErrorAnnualised).toBeCloseTo(stdev(active) * ANNUALISATION, 14);
    expect(outputs.trackingErrorAnnualised! * 100).toBeCloseTo(
      GOLDEN.expected.trackingErrorAnnualisedPct!,
      10,
    );
    expect(outputs.activeMeanPeriod).toBeCloseTo(GOLDEN.expected.activeMeanPeriod!, 15);
  });

  it('takes historical VaR from the 5th percentile of the realised series', () => {
    const { outputs } = run();
    const q05 = percentile(GOLDEN.series.portfolio, 0.05);

    expect(outputs.historicalQuantileReturn).toBeCloseTo(q05, 15);
    expect(outputs.historicalQuantileReturn).toBeCloseTo(
      GOLDEN.expected.historicalQuantileReturn!,
      15,
    );
    // The reported figure is a positive loss magnitude.
    expect(outputs.historicalVarReturn).toBeCloseTo(-q05, 15);
    expect(outputs.historicalVarAmount).toBeCloseTo(-q05 * portfolioValue, 8);
    expect(outputs.historicalVarAmount).toBeCloseTo(GOLDEN.expected.historicalVarAmount!, 8);

    // Expected shortfall is the mean of that tail, not the quantile again.
    const tail = GOLDEN.series.portfolio.filter((r) => r <= q05);
    expect(outputs.expectedShortfallReturn).toBeCloseTo(-mean(tail), 15);
    expect(outputs.expectedShortfallReturn).toBeCloseTo(
      GOLDEN.expected.expectedShortfallReturn!,
      15,
    );
    expect(outputs.expectedShortfallReturn!).toBeGreaterThan(outputs.historicalVarReturn);
  });

  it('takes parametric VaR from z × the daily volatility, at both confidences', () => {
    const sigma = stdev(GOLDEN.series.portfolio);

    const at95 = run(0.95).outputs;
    expect(at95.varConfidence).toBe(0.95);
    expect(at95.varZScore).toBeCloseTo(Z95, 12);
    expect(at95.parametricVarReturn).toBeCloseTo(Z95 * sigma, 15);
    expect(at95.parametricVarReturn).toBeCloseTo(GOLDEN.expected.parametricVarReturn95!, 15);

    const at99 = run(0.99).outputs;
    expect(at99.varConfidence).toBe(0.99);
    expect(at99.varZScore).toBeCloseTo(Z99, 12);
    expect(at99.parametricVarReturn).toBeCloseTo(Z99 * sigma, 15);
    expect(at99.parametricVarReturn).toBeCloseTo(GOLDEN.expected.parametricVarReturn99!, 15);

    // A 99 % loss is a bigger loss than a 95 % one, by both methods.
    expect(at99.parametricVarReturn).toBeGreaterThan(at95.parametricVarReturn);
    expect(at99.historicalVarReturn).toBeGreaterThan(at95.historicalVarReturn);
  });

  it('backtests the VaR: expected exceptions are sessions × (1 − confidence)', () => {
    const { outputs } = run();
    const sessions = GOLDEN.series.portfolio.length - 60;

    expect(outputs.backtestSessions).toBe(sessions);
    expect(outputs.backtestExpectedExceptions).toBeCloseTo(sessions * 0.05, 12);
    expect(outputs.backtestExceptions).toBeGreaterThanOrEqual(0);
    expect(outputs.backtestExceptions!).toBeLessThanOrEqual(sessions);
    expect(outputs.backtestExceptionRate).toBeCloseTo(outputs.backtestExceptions! / sessions, 12);
  });

  it('reports no Monte-Carlo VaR at all, rather than a number nobody computed', () => {
    expect(run().outputs.monteCarloVarReturn).toBeNull();
    expect(run().outputs.conventions.monteCarloVar).toContain('VAR_MC_NOT_IN_V1');
    expect(run().outputs.conventions.factorModel).toContain('NO_FACTOR_MODEL');
  });

  it('is reproducible: the same inputs at the same asOf give the same inputsHash (ANAL-08)', () => {
    expect(run().engine.inputsHash).toBe(run().engine.inputsHash);
    expect(run(0.99).engine.inputsHash).not.toBe(run(0.95).engine.inputsHash);
  });
});

describe('scenario shocks over the golden book (PORT-05)', () => {
  it('prices an equity shock through beta and leaves cash alone', () => {
    const valuation = valueHoldings(holdings, GOLDEN.baseCurrency);
    const byKey = new Map(valuation.rows.map((r) => [r.key, r.marketValue]));

    const { outputs } = riskOf({
      returns: GOLDEN.series.portfolio,
      portfolioValue: GOLDEN.expected.portfolioValue!,
      holdings: holdings.map((h) => ({
        instrumentId: h.key,
        assetClass: h.isCash ? ('cash' as const) : ('equity' as const),
        currency: h.currency,
        marketValue: byKey.get(h.key) ?? 0,
      })),
      scenarios: ['EQUITY_DOWN_10'],
      varConfidence: 0.95,
      valuationTs: GOLDEN.valuationTs,
    });

    const scenario = outputs.scenarios[0]!;
    // Σ beta × −0.10 × marketValue over the equity lines; beta defaults to 1, cash to 0.
    const equityMv = holdings
      .filter((h) => !h.isCash)
      .reduce((a, h) => a + (byKey.get(h.key) ?? 0), 0);
    expect(scenario.id).toBe('EQUITY_DOWN_10');
    expect(scenario.pnl).toBeCloseTo(-0.1 * equityMv, 8);
    expect(scenario.pnl).toBeCloseTo(-31_840, 8);
    expect(scenario.unpricedInstrumentIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The series builders the risk view feeds from
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('return series construction', () => {
  it('turns a close series into simple returns and refuses to invent one', () => {
    expect(simpleReturns([100, 110, 99])).toEqual([0.10000000000000009, -0.09999999999999998]);
    expect(simpleReturns([100])).toEqual([]);
  });

  it('dates every return with the session it was realised in', () => {
    const dates = ['2026-09-09', '2026-09-10', '2026-09-11'];
    expect(datedSimpleReturns(dates, [100, 110, 99])).toEqual({
      dates: ['2026-09-10', '2026-09-11'],
      returns: [0.10000000000000009, -0.09999999999999998],
    });
    // A pair the arithmetic cannot use drops the date with the return, so the two stay in step.
    expect(datedSimpleReturns(dates, [0, 110, 99])).toEqual({
      dates: ['2026-09-11'],
      returns: [-0.09999999999999998],
    });
  });

  it('weights holdings by date and drops a session any of them is missing', () => {
    const weights = new Map([
      ['A', 0.6],
      ['B', 0.4],
    ]);
    const series = new Map<string, DatedReturns>([
      ['A', { dates: ['2026-09-09', '2026-09-10', '2026-09-11'], returns: [0.01, 0.02, 0.03] }],
      ['B', { dates: ['2026-09-10', '2026-09-11'], returns: [-0.01, 0.005] }],
    ]);
    // 09-09 is dropped (B has no return for it); the rest pair by date, never by index.
    expect(weightedReturnSeries(weights, series)).toEqual({
      dates: ['2026-09-10', '2026-09-11'],
      returns: [0.6 * 0.02 + 0.4 * -0.01, 0.6 * 0.03 + 0.4 * 0.005],
    });
    expect(weightedReturnSeries(weights, new Map())).toEqual({ dates: [], returns: [] });
  });

  it('pairs a short-history holding with the right dates, not with the oldest ones', () => {
    // Two positions that exactly offset over their common window. Aligning by index instead of by
    // date paired A's first three sessions with B's, and returned [0.045, 0.090, 0.135] — a series
    // that never happened, and from which vol, tracking error, beta, VaR and its backtest were all
    // then computed.
    const days = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const weights = new Map([
      ['A', 0.5],
      ['B', 0.5],
    ]);
    const series = new Map<string, DatedReturns>([
      ['A', { dates: days, returns: [0.1, 0.2, 0.3, 0.01, 0.02, 0.03] }],
      ['B', { dates: ['d4', 'd5', 'd6'], returns: [-0.01, -0.02, -0.03] }],
    ]);
    const out = weightedReturnSeries(weights, series);
    expect(out.dates).toEqual(['d4', 'd5', 'd6']);
    for (const r of out.returns) expect(r).toBeCloseTo(0, 12);
  });

  it('does not take equal lengths for equal dates — two exchange calendars', () => {
    // Same number of sessions, one of them a different day: only the two shared dates survive.
    const weights = new Map([
      ['NY', 0.5],
      ['LN', 0.5],
    ]);
    const series = new Map<string, DatedReturns>([
      ['NY', { dates: ['2026-09-07', '2026-09-08', '2026-09-09'], returns: [0.01, 0.02, 0.03] }],
      ['LN', { dates: ['2026-09-08', '2026-09-09', '2026-09-10'], returns: [0.04, 0.05, 0.06] }],
    ]);
    expect(weightedReturnSeries(weights, series)).toEqual({
      dates: ['2026-09-08', '2026-09-09'],
      returns: [0.5 * 0.02 + 0.5 * 0.04, 0.5 * 0.03 + 0.5 * 0.05],
    });
  });

  it('intersects a pair of series by date before any statistic of the two is taken', () => {
    const port: DatedReturns = { dates: ['d1', 'd2', 'd4'], returns: [0.01, 0.02, 0.04] };
    const bench: DatedReturns = { dates: ['d2', 'd3', 'd4'], returns: [0.2, 0.3, 0.4] };
    expect(alignReturns(port, bench)).toEqual({
      dates: ['d2', 'd4'],
      a: [0.02, 0.04],
      b: [0.2, 0.4],
    });
  });
});
