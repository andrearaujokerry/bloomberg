// packages/core/test/analytics/vol/surface.test.ts — WP-02 (WORKPLAN L546):
// "SVI fit on the AAPL chain slice transcribed into fixtures/golden/analytics/vol/aapl-slice.json
//  (source: 'cboe-options') has no calendar or butterfly arbitrage; rmse recorded; the fit result
//  has exactly the vol_surfaces.svi shape. The fit over the *replayed* chain is WP-11's."
//
// What this file proves, in the order the pipeline produces it:
//
//   1. **The forward comes out of the quotes, not out of a dividend guess.** The parity regression
//      over the fourteen two-sided strikes recovers the forward the chain was quoted on to under a
//      cent, and the discount factor it implies matches `e^{-rT}` to 1e-4 relative — the precision
//      a penny-rounded mid leaves, not the regression's. The parity identity
//      `C - P = e^{-rT}(F - K)` is then re-checked strike by strike, straight from the golden
//      file's own bids and asks — arithmetic that touches none of the fitting code.
//   2. **The fit reproduces the chain.** Every quote is repriced from the fitted smile and lands
//      inside its own bid/ask, which is the only tolerance a market maker recognises. `rmse` is
//      recorded, and independently recomputed from the per-quote residuals.
//   3. **No butterfly and no calendar arbitrage.** Gatheral's `g(k) >= 0` on each slice, its
//      analytic derivatives cross-checked against central differences of `w(k)`; the discrete
//      convexity of the model's *and* the market's call prices; and total variance non-decreasing
//      from the October slice to the December one at every log-moneyness they share.
//   4. **The stored shape is exactly `vol_surfaces.svi`.** Seven keys — `{a,b,rho,m,sigma,rmse,n}`
//      (CONTRACTS L183) — all finite, all jsonb-representable, with no diagnostics smuggled in.
//   5. **It is deterministic.** Same quotes, same parameters, same `inputsHash` (ANAL-08): the
//      optimiser is a fixed multi-start simplex with no PRNG anywhere.
//
// The golden file is self-contained by WORKPLAN L471-482: the chain's levels are transcribed into
// it and `source` names the capture. Nothing here opens `fixtures/providers/raw/` or the replay
// store.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { black76Price } from '../../../src/analytics/options/bsm.js';
import {
  VOL_SURFACE_CONVENTIONS,
  butterflyCheck,
  calendarCheck,
  fitSviSlice,
  forwardByParity,
  sviCurvature,
  sviG,
  sviImpliedVol,
  sviSlope,
  sviTotalVariance,
  volSurface,
  volSurfaceEngine,
  type ChainQuote,
  type SviShape,
  type VolSurfaceInputs,
} from '../../../src/analytics/vol/surface.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden case
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: VolSurfaceInputs;
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN_PATH = fileURLToPath(
  new URL('../../../../../fixtures/golden/analytics/vol/aapl-slice.json', import.meta.url),
);
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenCase[];

const CASE = GOLDEN[0];
if (CASE === undefined) throw new Error('aapl-slice.json is empty');

/** The surface, fitted once: every assertion below reads this one run. */
const RESULT = volSurfaceEngine(CASE.inputs, CASE.valuationTs);
const SURFACE = RESULT.outputs;

const FRONT = SURFACE.slices[0];
const BACK = SURFACE.slices[1];
if (FRONT === undefined || BACK === undefined) throw new Error('expected two fitted slices');

/** The `vol_surfaces.svi` key set, sorted (CONTRACTS L183: `{a,b,rho,m,sigma,rmse,n}`). */
const SVI_KEYS = ['a', 'b', 'm', 'n', 'rho', 'rmse', 'sigma'] as const;

function quotesOf(expiryIndex: number): readonly ChainQuote[] {
  const expiry = CASE?.inputs.expiries[expiryIndex];
  if (expiry === undefined) throw new Error(`no expiry ${expiryIndex} in the golden case`);
  return expiry.quotes;
}

function shapeOf(slice: {
  svi: { a: number; b: number; rho: number; m: number; sigma: number };
}): SviShape {
  return {
    a: slice.svi.a,
    b: slice.svi.b,
    rho: slice.svi.rho,
    m: slice.svi.m,
    sigma: slice.svi.sigma,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden record itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('fixtures/golden/analytics/vol/aapl-slice.json', () => {
  it('is the WORKPLAN L546 record: cboe-options, two expiries, 28 two-sided strikes', () => {
    expect(CASE.id).toBe('vol.surface.aapl.2026-09-15');
    expect(CASE.engine).toBe('vol.surface');
    expect(CASE.engineVersion).toBe(volSurfaceEngine.version);
    expect(CASE.source.startsWith('cboe-options')).toBe(true);
    expect(Object.keys(CASE.tol).sort()).toEqual(Object.keys(CASE.expected).sort());

    expect(CASE.inputs.underlying).toBe('AAPL');
    expect(CASE.inputs.asOf).toBe('2026-09-15');
    expect(CASE.inputs.expiries.map((e) => e.expiry)).toEqual(['2026-10-16', '2026-12-18']);
    for (const expiry of CASE.inputs.expiries) {
      expect(expiry.quotes).toHaveLength(14);
      expect(expiry.quotes.map((q) => q.strike)).toEqual([
        200, 205, 210, 215, 220, 225, 230, 235, 240, 245, 250, 255, 260, 265,
      ]);
      for (const q of expiry.quotes) {
        // Two-sided, positively priced, ask above bid: a usable snapshot at every strike.
        expect(q.callAsk).toBeGreaterThan(q.callBid);
        expect(q.putAsk).toBeGreaterThan(q.putBid);
        expect(q.callBid).toBeGreaterThan(0);
        expect(q.putBid).toBeGreaterThan(0);
        expect(q.callIv).toBeGreaterThan(0);
        expect(q.putIv).toBeGreaterThan(0);
      }
    }
  });

  it('matches every pinned expectation within its stated tolerance', () => {
    const outputs = SURFACE as unknown as Record<string, number | string | boolean>;
    for (const [key, expected] of Object.entries(CASE.expected)) {
      const actual = outputs[key];
      const tol = CASE.tol[key] ?? 0;
      if (typeof expected === 'number') {
        expect(typeof actual, `${key} is a number`).toBe('number');
        expect(
          Math.abs((actual as number) - expected),
          `${key} within ${String(tol)}`,
        ).toBeLessThanOrEqual(tol);
      } else {
        expect(actual, key).toBe(expected);
      }
    }
  });

  it('runs through defineEngine with a stable char(64) inputsHash (ANAL-08)', () => {
    expect(RESULT.engine).toEqual({ name: 'vol.surface', version: '1.0.0' });
    expect(RESULT.valuationTs).toBe(CASE.valuationTs);
    expect(RESULT.inputsHash).toMatch(/^[0-9a-f]{64}$/);

    // Re-run with the keys in a different order: the hash is over canonical JSON, so it is the
    // same 64 characters, and the fit is bit-identical because nothing in it is random.
    const again = volSurfaceEngine(
      {
        expiries: CASE.inputs.expiries,
        dividendYield: CASE.inputs.dividendYield,
        rate: CASE.inputs.rate,
        spot: CASE.inputs.spot,
        asOf: CASE.inputs.asOf,
        underlying: CASE.inputs.underlying,
        ...(CASE.inputs.ivSource === undefined ? {} : { ivSource: CASE.inputs.ivSource }),
      },
      CASE.valuationTs,
    );
    expect(again.inputsHash).toBe(RESULT.inputsHash);
    expect(again.outputs.slices[0]?.svi).toEqual(FRONT.svi);
    expect(again.outputs.slices[1]?.svi).toEqual(BACK.svi);

    // A different chain is a different hash.
    const bumped = volSurfaceEngine(
      { ...CASE.inputs, spot: CASE.inputs.spot + 0.01 },
      CASE.valuationTs,
    );
    expect(bumped.inputsHash).not.toBe(RESULT.inputsHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. Forward by put-call parity
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('forward by put-call parity', () => {
  it('recovers the chain forward from the quotes alone, on both expiries', () => {
    for (const slice of [FRONT, BACK]) {
      const detail = slice.forwardDetail;
      expect(detail.method).toBe('parity_regression');
      expect(detail.strikesUsed).toBe(14);
      // C - P is exactly linear in K under parity, so the regression is a perfect fit up to the
      // penny rounding of the quotes.
      expect(detail.regressionR2).not.toBeNull();
      expect(detail.regressionR2 ?? 0).toBeGreaterThan(0.999999);
      // The slope is -e^{-rT}: the market's own discount factor.
      const df = Math.exp(-CASE.inputs.rate * slice.T);
      expect(detail.discountFactor).toBeCloseTo(df, 15);
      // 1e-4 relative, and that is the *quotes'* precision, not the regression's: the mids carry
      // half a cent of rounding each, and a slope fitted across a 65-point strike range turns
      // that into ~4.5e-5 of discount factor. A tighter bound would be asserting that a penny
      // does not exist.
      expect(Math.abs((detail.impliedDiscountFactor ?? 0) / df - 1)).toBeLessThan(1e-4);
      // Three independent routes to the same forward, all inside a cent of each other.
      expect(Math.abs((detail.regressionForward ?? 0) - detail.carryForward)).toBeLessThan(0.01);
      expect(Math.abs((detail.atmParityForward ?? 0) - detail.carryForward)).toBeLessThan(0.02);
      // The dividend yield the forward implies is the one the chain was quoted with.
      expect(detail.impliedDividendYield).toBeCloseTo(CASE.inputs.dividendYield, 3);
    }
  });

  it('satisfies C - P = e^{-rT}(F - K) at every strike of the golden chain', () => {
    // Recomputed from the raw bids and asks in the fixture: this touches no fitting code.
    for (const [i, slice] of [FRONT, BACK].entries()) {
      const df = Math.exp(-CASE.inputs.rate * slice.T);
      for (const q of quotesOf(i)) {
        const callMid = (q.callBid + q.callAsk) / 2;
        const putMid = (q.putBid + q.putAsk) / 2;
        const parity = df * (slice.forward - q.strike);
        // A penny of rounding on each side of each mid: half a cent per leg, one cent together.
        expect(Math.abs(callMid - putMid - parity), `parity at K=${String(q.strike)}`).toBeLessThan(
          0.011,
        );
      }
    }
  });

  it('falls back to single-strike parity, then to carry, as quotes disappear', () => {
    const T = FRONT.T;
    const quotes = quotesOf(0);
    // Two two-sided strikes: too few to regress, so the CBOE min-|C-P| rule is used.
    const twoStrikes = forwardByParity(quotes.slice(6, 8), 232.5, 0.0412, 0.0044, T);
    expect(twoStrikes.method).toBe('parity_atm');
    expect(twoStrikes.forward).toBeCloseTo(FRONT.forward, 1);
    // No two-sided market at all: the carry forward is the only thing left.
    const none = forwardByParity([], 232.5, 0.0412, 0.0044, T);
    expect(none.method).toBe('carry');
    expect(none.forward).toBeCloseTo(232.5 * Math.exp((0.0412 - 0.0044) * T), 12);
    expect(none.strikesUsed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The fit
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SVI slice fit', () => {
  it('returns exactly the vol_surfaces.svi shape: {a,b,rho,m,sigma,rmse,n}', () => {
    for (const slice of SURFACE.slices) {
      // Exactly seven keys — no diagnostics inside the jsonb the column stores.
      expect(Object.keys(slice.svi).sort()).toEqual([...SVI_KEYS]);
      for (const key of SVI_KEYS) {
        const value = slice.svi[key];
        expect(typeof value, `svi.${key} is a number`).toBe('number');
        expect(Number.isFinite(value), `svi.${key} is finite`).toBe(true);
      }
      // jsonb round trip: what goes into the column comes back identical.
      expect(JSON.parse(JSON.stringify(slice.svi)) as unknown).toEqual(slice.svi);
    }
  });

  it('respects every SVI no-arbitrage parameter constraint', () => {
    for (const slice of SURFACE.slices) {
      const { a, b, rho, m, sigma } = slice.svi;
      expect(b).toBeGreaterThanOrEqual(0);
      expect(Math.abs(rho)).toBeLessThan(1);
      expect(sigma).toBeGreaterThan(0);
      expect(Math.abs(m)).toBeLessThan(1);
      // min w = a + b*sigma*sqrt(1-rho^2) > 0: total variance is positive everywhere.
      expect(a + b * sigma * Math.sqrt(1 - rho * rho)).toBeGreaterThan(0);
      // Roger Lee's slope bound: b*T*(1+|rho|) <= 4.
      expect(b * slice.T * (1 + Math.abs(rho))).toBeLessThanOrEqual(4);
    }
  });

  it('records rmse, and rmse is the RMS of the per-quote vol residuals', () => {
    for (const slice of SURFACE.slices) {
      expect(slice.svi.n).toBe(14);
      expect(slice.points).toHaveLength(14);
      expect(slice.skipped).toHaveLength(0);

      // Independent recomputation from the reported residuals.
      const sse = slice.points.reduce((s, p) => s + p.residual * p.residual, 0);
      expect(slice.svi.rmse).toBeCloseTo(Math.sqrt(sse / slice.points.length), 15);
      // And from the raw market/model vols, not from `residual`.
      const sse2 = slice.points.reduce((s, p) => {
        const d = sviImpliedVol(shapeOf(slice), p.logMoneyness, slice.T) - p.marketIv;
        return s + d * d;
      }, 0);
      expect(slice.svi.rmse).toBeCloseTo(Math.sqrt(sse2 / slice.points.length), 15);

      expect(slice.svi.rmse).toBeGreaterThan(0);
      // The quotes carry half a cent of rounding; on the smallest vega on the slice that is a few
      // basis points of vol, so a fit worse than 50 bp of vol would mean the model missed, not
      // that the data is noisy.
      expect(slice.svi.rmse).toBeLessThan(0.005);
      expect(slice.maxAbsResidual).toBeLessThan(0.01);
    }
  });

  it('reprices every quote inside its own bid/ask', () => {
    for (const [i, slice] of [FRONT, BACK].entries()) {
      for (const q of quotesOf(i)) {
        const k = Math.log(q.strike / slice.forward);
        const sigma = sviImpliedVol(shapeOf(slice), k, slice.T);
        const type = q.strike >= slice.forward ? 'call' : 'put';
        const bid = type === 'call' ? q.callBid : q.putBid;
        const ask = type === 'call' ? q.callAsk : q.putAsk;
        const model = black76Price(
          { F: slice.forward, K: q.strike, r: CASE.inputs.rate, sigma, T: slice.T },
          type,
        );
        expect(model, `model >= bid at K=${String(q.strike)}`).toBeGreaterThanOrEqual(bid - 1e-9);
        expect(model, `model <= ask at K=${String(q.strike)}`).toBeLessThanOrEqual(ask + 1e-9);
      }
    }
  });

  it('agrees with the vendor implied vols quoted in the chain', () => {
    // The smile is inverted from mid prices; the golden file also carries the vendor's own IV
    // column. They are two routes to the same number and must agree to a vol basis point or two.
    for (const [i, slice] of [FRONT, BACK].entries()) {
      const quotes = quotesOf(i);
      for (const point of slice.points) {
        const q = quotes.find((x) => x.strike === point.strike);
        expect(q, `quote at K=${String(point.strike)}`).toBeDefined();
        const quoted = point.optionType === 'call' ? q?.callIv : q?.putIv;
        expect(
          Math.abs((quoted ?? 0) - point.marketIv),
          `IV at K=${String(point.strike)}`,
        ).toBeLessThan(0.002);
      }
      // The ATM strike is the listed strike nearest the forward.
      expect(slice.atmStrike).toBe(235);
    }
  });

  it('fits the out-of-the-money side of each strike', () => {
    for (const slice of SURFACE.slices) {
      for (const p of slice.points) {
        expect(p.optionType).toBe(p.strike >= slice.forward ? 'call' : 'put');
        expect(p.weight).toBeGreaterThan(0);
        expect(p.totalVariance).toBeCloseTo(p.marketIv * p.marketIv * slice.T, 15);
      }
      // Weights are normalised to mean 1, so the arbitrage penalty's scale is notional-free.
      const meanWeight = slice.points.reduce((s, p) => s + p.weight, 0) / slice.points.length;
      expect(meanWeight).toBeCloseTo(1, 12);
    }
  });

  it('refuses a slice it cannot fit', () => {
    const points = [
      { k: -0.1, iv: 0.3, weight: 1 },
      { k: 0, iv: 0.26, weight: 1 },
      { k: 0.1, iv: 0.24, weight: 1 },
    ];
    expect(() => fitSviSlice(points, 0.25)).toThrow(/at least 5 usable quotes/);
    expect(() => fitSviSlice([...points, ...points], 0)).toThrow(/T must be positive/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. Arbitrage
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('butterfly arbitrage', () => {
  it('finds none on either slice: g(k) > 0 everywhere on the grid', () => {
    expect(SURFACE.butterflyArbitrage).toBe(false);
    expect(SURFACE.minButterflyG).toBeGreaterThan(0);
    for (const slice of SURFACE.slices) {
      expect(slice.butterfly.arbitrageFree).toBe(true);
      expect(slice.butterfly.gridPoints).toBe(121);
      expect(slice.butterfly.minG).toBeGreaterThan(0);
      // The model's call curve is convex in the strike, and so is the quoted one — the same
      // condition stated in prices instead of in the density.
      expect(slice.butterfly.minModelConvexity ?? -1).toBeGreaterThan(0);
      expect(slice.butterfly.minMarketConvexity ?? -1).toBeGreaterThan(0);
    }
  });

  it('computes g from derivatives that match finite differences of w (ANAL-09)', () => {
    // The analytic w' and w'' feeding g are cross-checked against central differences of w
    // itself: a sign or factor slip in either derivative cannot survive this.
    const h = 1e-5;
    for (const slice of SURFACE.slices) {
      const p = shapeOf(slice);
      for (let k = -0.4; k <= 0.4 + 1e-12; k += 0.05) {
        const fd1 = (sviTotalVariance(p, k + h) - sviTotalVariance(p, k - h)) / (2 * h);
        const fd2 =
          (sviTotalVariance(p, k + h) - 2 * sviTotalVariance(p, k) + sviTotalVariance(p, k - h)) /
          (h * h);
        expect(sviSlope(p, k)).toBeCloseTo(fd1, 8);
        expect(sviCurvature(p, k)).toBeCloseTo(fd2, 4);
        expect(sviG(p, k)).toBeGreaterThan(0);
      }
    }
  });

  it('flags a slice whose density goes negative', () => {
    // A deliberately arbitrageable slice: a huge b with a wide |rho| bends the call curve the
    // wrong way. The checker must say so rather than quietly pass it.
    const bad: SviShape = { a: 0.02, b: 1.6, rho: -0.95, m: 0.0, sigma: 0.05 };
    const strikes = quotesOf(0).map((q) => q.strike);
    const mids = quotesOf(0).map((q) => (q.callBid + q.callAsk) / 2);
    const check = butterflyCheck(bad, 0.5, 233.23, 0.0412, strikes, mids);
    expect(check.arbitrageFree).toBe(false);
    expect(check.minG).toBeLessThan(0);
  });
});

describe('calendar arbitrage', () => {
  it('finds none: total variance rises from October to December at every shared k', () => {
    expect(SURFACE.calendarArbitrage).toBe(false);
    expect(SURFACE.calendar.arbitrageFree).toBe(true);
    expect(SURFACE.calendar.pairsChecked).toBe(1);
    expect(SURFACE.calendar.minGap).toBeGreaterThan(0);
    expect(SURFACE.minCalendarGap).toBe(SURFACE.calendar.minGap);
    expect(SURFACE.calendar.expiryAtMinGap).toBe('2026-12-18');

    // Independent sweep over the shared strike range, straight from the two fitted slices.
    const front = shapeOf(FRONT);
    const back = shapeOf(BACK);
    for (let k = -0.15; k <= 0.15 + 1e-12; k += 0.01) {
      expect(sviTotalVariance(back, k)).toBeGreaterThan(sviTotalVariance(front, k));
    }
    // And the same statement in the quotes: the December vol is above the October vol at the
    // common strikes, so the calendar spread the surface prices is the one the chain shows.
    for (const strike of [220, 235, 250]) {
      const fq = quotesOf(0).find((q) => q.strike === strike);
      const bq = quotesOf(1).find((q) => q.strike === strike);
      const fv = (fq?.callIv ?? 0) ** 2 * FRONT.T;
      const bv = (bq?.callIv ?? 0) ** 2 * BACK.T;
      expect(bv).toBeGreaterThan(fv);
    }
  });

  it('is vacuously satisfied by a one-expiry surface, and flags an inverted pair', () => {
    const single = calendarCheck([
      { expiry: '2026-10-16', T: FRONT.T, svi: shapeOf(FRONT), kMin: -0.15, kMax: 0.13 },
    ]);
    expect(single.pairsChecked).toBe(0);
    expect(single.arbitrageFree).toBe(true);
    expect(single.kAtMinGap).toBeNull();

    // Swap the maturities: the short slice now carries more total variance than the long one.
    const inverted = calendarCheck([
      { expiry: '2026-10-16', T: FRONT.T, svi: shapeOf(BACK), kMin: -0.15, kMax: 0.13 },
      { expiry: '2026-12-18', T: BACK.T, svi: shapeOf(FRONT), kMin: -0.15, kMax: 0.13 },
    ]);
    expect(inverted.arbitrageFree).toBe(false);
    expect(inverted.minGap).toBeLessThan(0);
    expect(inverted.expiryAtMinGap).toBe('2026-12-18');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The surface object
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('surface outputs', () => {
  it('echoes its conventions (ANAL-07) and summarises front and back', () => {
    expect(SURFACE.conventions).toBe(VOL_SURFACE_CONVENTIONS);
    expect(SURFACE.conventions.model).toBe('svi_raw');
    expect(SURFACE.conventions.dayCount).toBe('ACT/365F');
    expect(SURFACE.conventions.moneyness).toBe('log_strike_over_forward');
    expect(SURFACE.conventions.rmseUnit).toBe('implied_vol_decimal');

    expect(SURFACE.underlying).toBe('AAPL');
    expect(SURFACE.asOf).toBe('2026-09-15');
    expect(SURFACE.nSlices).toBe(2);
    expect(SURFACE.nQuotes).toBe(28);
    expect(SURFACE.arbitrageFree).toBe(true);
    expect(SURFACE.maxRmse).toBe(Math.max(FRONT.svi.rmse, BACK.svi.rmse));

    // ACT/365F from 2026-09-15: 31 days to 16 October, 94 to 18 December.
    expect(FRONT.days).toBe(31);
    expect(BACK.days).toBe(94);
    expect(FRONT.T).toBeCloseTo(31 / 365, 15);
    expect(BACK.T).toBeCloseTo(94 / 365, 15);

    expect(SURFACE.frontExpiry).toBe(FRONT.expiry);
    expect(SURFACE.frontForward).toBe(FRONT.forward);
    expect(SURFACE.frontAtmIv).toBe(FRONT.atmIv);
    expect(SURFACE.frontRmse).toBe(FRONT.svi.rmse);
    expect(SURFACE.backExpiry).toBe(BACK.expiry);
    expect(SURFACE.backForward).toBe(BACK.forward);
    expect(SURFACE.backAtmIv).toBe(BACK.atmIv);
    expect(SURFACE.backRmse).toBe(BACK.svi.rmse);

    // atm_iv is the fitted vol at k = 0, i.e. at the forward itself.
    for (const slice of SURFACE.slices) {
      expect(slice.atmIv).toBeCloseTo(sviImpliedVol(shapeOf(slice), 0, slice.T), 15);
      expect(slice.atmIv).toBeGreaterThan(0.2);
      expect(slice.atmIv).toBeLessThan(0.35);
    }
    // The term structure is upward sloping on this chain.
    expect(BACK.atmIv).toBeGreaterThan(FRONT.atmIv);
  });

  it('rejects a chain it cannot build a surface from', () => {
    expect(() => volSurface({ ...CASE.inputs, expiries: [] })).toThrow(/no expiries/);
    expect(() => volSurface({ ...CASE.inputs, spot: 0 })).toThrow(/spot must be positive/);
    expect(() =>
      volSurface({
        ...CASE.inputs,
        asOf: '2026-12-31',
        expiries: [{ expiry: '2026-10-16', quotes: quotesOf(0) }],
      }),
    ).toThrow(/is not after asOf/);
  });

  it('fits a single-expiry chain the same way, with no calendar pair to check', () => {
    const one = volSurface({
      ...CASE.inputs,
      expiries: [{ expiry: '2026-10-16', quotes: quotesOf(0) }],
    });
    expect(one.nSlices).toBe(1);
    expect(one.calendar.pairsChecked).toBe(0);
    expect(one.arbitrageFree).toBe(true);
    expect(one.frontExpiry).toBe(one.backExpiry);
    expect(one.slices[0]?.svi).toEqual(FRONT.svi);
  });
});
