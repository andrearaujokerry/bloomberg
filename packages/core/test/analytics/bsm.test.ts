// packages/core/test/analytics/bsm.test.ts — WP-02 (WORKPLAN L509, L543), the complete
// TESTING §7.2 pin set for Black-Scholes-Merton (ANAL-03).
//
// Everything pinned in TESTING §7.2 is asserted here: the price table, the intermediates, the
// seven layered assertions (parity, delta bounds, gamma and vega shape, theta/rho signs, the
// numerical-derivative cross-check and the implied-vol round trip), and the three tail cases
// (`bsm.deep.itm.call`, `bsm.zero.vol`, `bsm.expiry`). The golden files in
// `fixtures/golden/analytics/bsm/` are replayed at the end so the checked-in records are proved
// to match the engine here too, and not only in WP-02's `golden.test.ts` driver.
//
// Two tolerance subtleties TESTING §7.2 calls out explicitly, and this file honours:
//
//   - the pinned prices are *rounded to six decimals*, so they are asserted at the table's own
//     `1e-6`, never tighter. `call = 10.450584` is 4.28e-7 away from the exact 10.4505835722;
//   - the implied-vol round trip is fed the engine's **own unrounded** price (assertion 7). Fed
//     the rounded literal it returns 0.2000000114 — 1.14e-8 off — so a `1e-8` tolerance on the
//     literal is unsatisfiable by a correct implementation; the literal round trip is asserted at
//     `1e-7`, exactly as §7.2 prescribes.

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BSM_CONVENTIONS,
  black76,
  bsm,
  bsmEngine,
  bsmPrice,
  erfc,
  impliedVol,
  normalCdf,
  normalPdf,
  type BsmInputs,
  type OptionType,
} from '../../src/analytics/options/bsm.js';

// ---------------------------------------------------------------------------------------------
// The case: TESTING §7.2 `bsm.atm.1y`
// ---------------------------------------------------------------------------------------------

const BASE: BsmInputs = { S: 100, K: 100, r: 0.05, q: 0, sigma: 0.2, T: 1 };
const VALUATION_TS = '2026-01-02T00:00:00Z';

/** The engine's own unrounded outputs — the subject of every assertion below. */
const OUT = bsm(BASE);

/** Reprice with one input overridden: the finite-difference helper of assertion 6. */
function price(overrides: Partial<BsmInputs>, type: OptionType): number {
  return bsmPrice({ ...BASE, ...overrides }, type);
}

describe('TESTING §7.2 — the pin table (S=K=100, r=0.05, q=0, sigma=0.20, T=1)', () => {
  it('pins d1 and d2 to 1e-12', () => {
    expect(OUT.d1).toBeCloseTo(0.35, 12);
    expect(OUT.d2).toBeCloseTo(0.15, 12);
    expect(Math.abs(OUT.d1 - 0.35)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(OUT.d2 - 0.15)).toBeLessThanOrEqual(1e-12);
  });

  it('pins the intermediates N(d1), N(d2), e^{-rT} and phi(d1)', () => {
    // TESTING §7.2 L397-398, each at the precision it is printed to.
    expect(Math.abs(OUT.nd1 - 0.6368306512)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(OUT.nd2 - 0.5596176923)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(OUT.discountFactor - 0.9512294245)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(OUT.pdfD1 - 0.3752403)).toBeLessThanOrEqual(1e-7);
    // The CDF is the engine's own, and it agrees with the standalone helper bit for bit.
    expect(OUT.nd1).toBe(normalCdf(OUT.d1));
    expect(OUT.pdfD1).toBe(normalPdf(OUT.d1));
  });

  it('pins the call at 10.450584 and the put at 5.573526 (1e-6)', () => {
    expect(Math.abs(OUT.call - 10.450584)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(OUT.put - 5.573526)).toBeLessThanOrEqual(1e-6);
    // The unrounded values TESTING §7.2 assertion 7 quotes, to ten decimals.
    expect(OUT.call).toBeCloseTo(10.4505835722, 10);
    expect(OUT.put).toBeCloseTo(5.5735260223, 10);
  });

  it('pins every greek in the table (1e-6, in the table’s own units)', () => {
    const pins: readonly (readonly [string, number, number])[] = [
      ['deltaCall', OUT.deltaCall, 0.636831],
      ['deltaPut', OUT.deltaPut, -0.363169],
      ['gamma', OUT.gamma, 0.018762],
      ['vega', OUT.vega, 37.524035],
      ['vegaPerVolPoint', OUT.vegaPerVolPoint, 0.37524],
      ['thetaCall', OUT.thetaCall, -6.414028],
      ['thetaCallPerDay', OUT.thetaCallPerDay, -0.017573],
      ['thetaPut', OUT.thetaPut, -1.657881],
      ['rhoCall', OUT.rhoCall, 53.232481],
      ['rhoCallPer100Bp', OUT.rhoCallPer100Bp, 0.532325],
      ['rhoPut', OUT.rhoPut, -41.89046],
    ];
    for (const [name, actual, expected] of pins) {
      const diff = Math.abs(actual - expected);
      expect(
        diff <= 1e-6,
        `${name}: got ${String(actual)}, TESTING §7.2 pins ${String(expected)} (diff ${diff.toExponential(3)})`,
      ).toBe(true);
    }
  });

  it('echoes its conventions (ANAL-07)', () => {
    expect(OUT.conventions).toBe(BSM_CONVENTIONS);
    expect(OUT.conventions.model).toBe('black_scholes_merton');
    expect(OUT.conventions.dayCount).toBe('ACT/365F');
    expect(OUT.conventions.compounding).toBe('continuous');
    expect(OUT.conventions.thetaUnit).toBe('per_year');
  });
});

describe('TESTING §7.2 — the seven layered assertions', () => {
  it('1. put-call parity holds to 1e-12', () => {
    const forwardPv = BASE.S * Math.exp(-BASE.q * BASE.T) - BASE.K * Math.exp(-BASE.r * BASE.T);
    expect(forwardPv).toBeCloseTo(4.8770575499, 10);
    expect(Math.abs(OUT.call - OUT.put - forwardPv)).toBeLessThanOrEqual(1e-12);
  });

  it('2. delta signs and bounds; deltaCall - deltaPut = 1 when q = 0', () => {
    expect(OUT.deltaCall).toBeGreaterThan(0);
    expect(OUT.deltaCall).toBeLessThan(1);
    expect(OUT.deltaPut).toBeGreaterThan(-1);
    expect(OUT.deltaPut).toBeLessThan(0);
    expect(Math.abs(OUT.deltaCall - OUT.deltaPut - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('3. gamma is positive, identical for call and put, and below its analytic maximum', () => {
    expect(OUT.gamma).toBeGreaterThan(0);
    // C - P is linear in S, so the two gammas are the same number: one field, and the finite
    // differences of the two separate price functions agree.
    const h = 0.01;
    const gammaFromCall =
      (price({ S: BASE.S + h }, 'call') -
        2 * price({}, 'call') +
        price({ S: BASE.S - h }, 'call')) /
      (h * h);
    const gammaFromPut =
      (price({ S: BASE.S + h }, 'put') - 2 * price({}, 'put') + price({ S: BASE.S - h }, 'put')) /
      (h * h);
    // Analytically the two gammas are one number: C − P is linear in S, so the second derivative
    // of the difference is exactly zero and `bsm()` exposes a single `gamma` field. That identity
    // is asserted at machine precision against its closed form…
    const closedFormGamma =
      (Math.exp(-BASE.q * BASE.T) * normalPdf(OUT.d1)) / (BASE.S * BASE.sigma * Math.sqrt(BASE.T));
    expect(Math.abs(OUT.gamma - closedFormGamma)).toBeLessThanOrEqual(1e-15);
    // …while the two *finite differences* agree only to the round-off floor of a second
    // difference at h = 0.01, which is ~4·eps·V/h² ≈ 9e-12 for the call and rather more once the
    // two price scales differ; 1e-8 is that floor with room, still four orders under the greek.
    expect(Math.abs(gammaFromCall - gammaFromPut)).toBeLessThanOrEqual(1e-8);
    const gammaMax = 1 / (BASE.S * BASE.sigma * Math.sqrt(2 * Math.PI * BASE.T));
    expect(gammaMax).toBeCloseTo(0.0199471, 7);
    expect(OUT.gamma).toBeLessThan(gammaMax);
  });

  it('4. vega is positive, identical for call and put, and below its maximum over sigma', () => {
    expect(OUT.vega).toBeGreaterThan(0);
    const h = 1e-5;
    const vegaFromCall =
      (price({ sigma: BASE.sigma + h }, 'call') - price({ sigma: BASE.sigma - h }, 'call')) /
      (2 * h);
    const vegaFromPut =
      (price({ sigma: BASE.sigma + h }, 'put') - price({ sigma: BASE.sigma - h }, 'put')) / (2 * h);
    // Both finite differences approximate the same analytic vega; they differ only by the
    // round-off of two different price scales, far below the 1e-6 the table is pinned at.
    expect(Math.abs(vegaFromCall - vegaFromPut)).toBeLessThanOrEqual(1e-8);
    const vegaMax = BASE.S * Math.sqrt(BASE.T / (2 * Math.PI));
    expect(vegaMax).toBeCloseTo(39.894228, 6);
    expect(OUT.vega).toBeLessThan(vegaMax);
  });

  it('5. theta and rho signs; rhoCall - rhoPut = K*T*e^{-rT} = 95.122942', () => {
    expect(OUT.thetaCall).toBeLessThan(OUT.thetaPut);
    expect(OUT.thetaPut).toBeLessThan(0);
    expect(OUT.rhoCall).toBeGreaterThan(0);
    expect(OUT.rhoPut).toBeLessThan(0);
    const spread = BASE.K * BASE.T * Math.exp(-BASE.r * BASE.T);
    expect(Math.abs(spread - 95.122942)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(OUT.rhoCall - OUT.rhoPut - spread)).toBeLessThanOrEqual(1e-6);
  });

  it('6. central differences reproduce every greek within 1e-6 (ANAL-09)', () => {
    const hS = 1e-4;
    const fdDeltaCall =
      (price({ S: BASE.S + hS }, 'call') - price({ S: BASE.S - hS }, 'call')) / (2 * hS);
    const fdDeltaPut =
      (price({ S: BASE.S + hS }, 'put') - price({ S: BASE.S - hS }, 'put')) / (2 * hS);
    expect(Math.abs(fdDeltaCall - OUT.deltaCall)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(fdDeltaPut - OUT.deltaPut)).toBeLessThanOrEqual(1e-6);

    const hG = 0.01;
    const fdGamma =
      (price({ S: BASE.S + hG }, 'call') -
        2 * price({}, 'call') +
        price({ S: BASE.S - hG }, 'call')) /
      (hG * hG);
    expect(Math.abs(fdGamma - OUT.gamma)).toBeLessThanOrEqual(1e-6);

    const hV = 1e-5;
    const fdVega =
      (price({ sigma: BASE.sigma + hV }, 'call') - price({ sigma: BASE.sigma - hV }, 'call')) /
      (2 * hV);
    expect(Math.abs(fdVega - OUT.vega)).toBeLessThanOrEqual(1e-6);

    const hR = 1e-6;
    const fdRhoCall =
      (price({ r: BASE.r + hR }, 'call') - price({ r: BASE.r - hR }, 'call')) / (2 * hR);
    const fdRhoPut =
      (price({ r: BASE.r + hR }, 'put') - price({ r: BASE.r - hR }, 'put')) / (2 * hR);
    expect(Math.abs(fdRhoCall - OUT.rhoCall)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(fdRhoPut - OUT.rhoPut)).toBeLessThanOrEqual(1e-6);

    // Beyond the table: theta (= -dV/dT), the dual delta (dV/dK), vanna and volga, each against
    // its own central difference. Same method, same 1e-6 guard against a sign or scaling slip.
    const hT = 1e-5;
    const fdThetaCall =
      -(price({ T: BASE.T + hT }, 'call') - price({ T: BASE.T - hT }, 'call')) / (2 * hT);
    const fdThetaPut =
      -(price({ T: BASE.T + hT }, 'put') - price({ T: BASE.T - hT }, 'put')) / (2 * hT);
    expect(Math.abs(fdThetaCall - OUT.thetaCall)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(fdThetaPut - OUT.thetaPut)).toBeLessThanOrEqual(1e-6);

    const hK = 1e-4;
    const fdDualCall =
      (price({ K: BASE.K + hK }, 'call') - price({ K: BASE.K - hK }, 'call')) / (2 * hK);
    const fdDualPut =
      (price({ K: BASE.K + hK }, 'put') - price({ K: BASE.K - hK }, 'put')) / (2 * hK);
    expect(Math.abs(fdDualCall - OUT.dualDeltaCall)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(fdDualPut - OUT.dualDeltaPut)).toBeLessThanOrEqual(1e-6);

    const hs = 1e-3;
    const hv = 1e-4;
    const fdVanna =
      (price({ S: BASE.S + hs, sigma: BASE.sigma + hv }, 'call') -
        price({ S: BASE.S + hs, sigma: BASE.sigma - hv }, 'call') -
        price({ S: BASE.S - hs, sigma: BASE.sigma + hv }, 'call') +
        price({ S: BASE.S - hs, sigma: BASE.sigma - hv }, 'call')) /
      (4 * hs * hv);
    expect(Math.abs(fdVanna - OUT.vanna)).toBeLessThanOrEqual(1e-6);

    // Volga is a second difference in sigma, and sigma is where the price is most curved: the
    // O(h^2) truncation carries a fourth derivative of ~3.4e3, so h = 1e-4 (truncation ~3e-6,
    // round-off floor 4*eps*V/h^2 ~ 9e-7) is near the optimum and 1e-5 is the honest bound.
    const hVolga = 1e-4;
    const fdVolga =
      (price({ sigma: BASE.sigma + hVolga }, 'call') -
        2 * price({}, 'call') +
        price({ sigma: BASE.sigma - hVolga }, 'call')) /
      (hVolga * hVolga);
    expect(Math.abs(fdVolga - OUT.volga)).toBeLessThanOrEqual(1e-5);
  });

  it('7. implied-vol round trip on the engine’s own unrounded price (Brent + Newton)', () => {
    const noSigma = { S: BASE.S, K: BASE.K, r: BASE.r, q: BASE.q, T: BASE.T };

    const call = impliedVol(OUT.call, noSigma, 'call');
    expect(call.reason).toBeNull();
    expect(call.sigma).not.toBeNull();
    expect(Math.abs((call.sigma ?? NaN) - 0.2)).toBeLessThanOrEqual(1e-8);
    expect(call.iterations).toBeLessThanOrEqual(12);

    const put = impliedVol(OUT.put, noSigma, 'put');
    expect(put.reason).toBeNull();
    expect(Math.abs((put.sigma ?? NaN) - 0.2)).toBeLessThanOrEqual(1e-8);
    expect(put.iterations).toBeLessThanOrEqual(12);

    // The same round trip started from the *pinned literal* gets the 1e-7 tolerance §7.2
    // prescribes, and lands where §7.2 says it lands: 0.2000000114, i.e. 1.14e-8 off.
    const fromLiteral = impliedVol(10.450584, noSigma, 'call');
    expect(Math.abs((fromLiteral.sigma ?? NaN) - 0.2)).toBeLessThanOrEqual(1e-7);
    expect(fromLiteral.sigma ?? NaN).toBeCloseTo(0.2000000114, 10);
    const putFromLiteral = impliedVol(5.573526, noSigma, 'put');
    expect(Math.abs((putFromLiteral.sigma ?? NaN) - 0.2)).toBeLessThanOrEqual(1e-7);

    // A price below the intrinsic bound: null, a reason, no throw, no negative vol.
    const intrinsic = BASE.S - BASE.K * Math.exp(-BASE.r * BASE.T);
    expect(intrinsic).toBeCloseTo(4.877058, 6);
    const below = impliedVol(4.0, noSigma, 'call');
    expect(below.sigma).toBeNull();
    expect(below.reason).toBe('NO_ARBITRAGE_BOUND');
    expect(below.converged).toBe(false);
  });
});

describe('implied vol beyond the pinned case', () => {
  it('round-trips across strikes, vols, maturities and both payoffs', () => {
    const inputs = { S: 100, r: 0.05, q: 0.02 };
    let worstWellConditioned = 0;
    let worstIterations = 0;
    let checked = 0;
    for (const K of [60, 80, 95, 100, 105, 130, 180]) {
      for (const sigma of [0.05, 0.1, 0.2, 0.45, 0.9, 1.8]) {
        for (const T of [0.05, 0.25, 1, 3]) {
          for (const type of ['call', 'put'] as const) {
            const target = bsmPrice({ ...inputs, K, sigma, T }, type);
            const dfR = Math.exp(-inputs.r * T);
            const dfQ = Math.exp(-inputs.q * T);
            const bound =
              type === 'call'
                ? Math.max(inputs.S * dfQ - K * dfR, 0)
                : Math.max(K * dfR - inputs.S * dfQ, 0);
            // Skip the cases whose entire time value is below double resolution: the price
            // rounds to the intrinsic bound, and no volatility is recoverable from it.
            if (target - bound <= 1e-11 * Math.max(inputs.S * dfQ, K * dfR)) continue;
            const got = impliedVol(target, { ...inputs, K, T }, type);
            expect(got.reason).toBeNull();
            const error = Math.abs((got.sigma ?? NaN) - sigma);
            // The recoverable vol accuracy is bounded by the price's own resolution divided by
            // vega: a price good to a few ulps pins sigma only to `ulp(price)/vega`. This is the
            // conditioning of the inverse problem, not of the solver, so the bound is stated that
            // way — 1e-9 of solver tolerance plus 32 ulps of price, converted through vega.
            const vega = bsm({ ...inputs, K, sigma, T }).vega;
            const allowed = 1e-9 + (32 * Number.EPSILON * Math.max(target, 1)) / vega;
            expect(
              error <= allowed,
              `K=${String(K)} sigma=${String(sigma)} T=${String(T)} ${type}: vol error ` +
                `${error.toExponential(3)} > ${allowed.toExponential(3)}`,
            ).toBe(true);
            // Where the problem is well conditioned, the flat 1e-8 of TESTING §7.2 holds.
            if (vega > 1) worstWellConditioned = Math.max(worstWellConditioned, error);
            worstIterations = Math.max(worstIterations, got.iterations);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(worstWellConditioned).toBeLessThanOrEqual(1e-8);
    expect(worstIterations).toBeLessThanOrEqual(40);
  });

  it('refuses a price above the upper bound and a degenerate expiry', () => {
    const noSigma = { S: 100, K: 100, r: 0.05, q: 0, T: 1 };
    expect(impliedVol(120, noSigma, 'call').reason).toBe('NO_ARBITRAGE_BOUND');
    expect(impliedVol(10, { ...noSigma, T: 0 }, 'call').reason).toBe('DEGENERATE_INPUT');
    expect(impliedVol(Number.NaN, noSigma, 'call').reason).toBe('DEGENERATE_INPUT');
    // At the intrinsic bound the implied vol is zero, not a failure.
    const atBound = impliedVol(100 - 100 * Math.exp(-0.05), noSigma, 'call');
    expect(atBound.sigma).toBe(0);
    expect(atBound.reason).toBeNull();
  });
});

describe('TESTING §7.2 — the tail cases', () => {
  it('bsm.deep.itm.call: S=100, K=50 stays above intrinsic with delta -> 1', () => {
    const deep = bsm({ ...BASE, K: 50 });
    expect(deep.deltaCall).toBeGreaterThan(0.999);
    expect(deep.gamma).toBeLessThan(1e-4);
    expect(deep.gamma).toBeGreaterThan(0);
    expect(deep.vega).toBeGreaterThan(0);
    const intrinsic = BASE.S - 50 * Math.exp(-BASE.r * BASE.T);
    expect(deep.call - intrinsic).toBeGreaterThanOrEqual(0);
    for (const value of Object.values(deep)) {
      if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('bsm.zero.vol: sigma = 0 collapses to the discounted forward, with no NaN', () => {
    const zero = bsm({ ...BASE, sigma: 0 });
    const closedForm = Math.max(
      BASE.S * Math.exp(-BASE.q * BASE.T) - BASE.K * Math.exp(-BASE.r * BASE.T),
      0,
    );
    // The pinned 4.877058 is this number rounded to six decimals; both forms are asserted.
    expect(Math.abs(zero.call - 4.877058)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(zero.call - closedForm)).toBeLessThanOrEqual(1e-9);
    expect(zero.gamma).toBe(0);
    expect(zero.vega).toBe(0);
    expect(zero.put).toBe(0);
    for (const value of Object.values(zero)) {
      if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('bsm.expiry: T = 0 is the payoff, with greeks 0 and delta in {0, 1}', () => {
    const itm = bsm({ ...BASE, K: 95, T: 0 });
    expect(itm.call).toBe(5);
    expect(itm.put).toBe(0);
    expect(itm.deltaCall).toBe(1);
    expect(itm.deltaPut).toBe(0);
    for (const greek of [
      itm.gamma,
      itm.vega,
      itm.thetaCall,
      itm.thetaPut,
      itm.rhoCall,
      itm.rhoPut,
    ]) {
      expect(greek).toBe(0);
    }
    const otm = bsm({ ...BASE, K: 105, T: 0 });
    expect(otm.call).toBe(0);
    expect(otm.put).toBe(5);
    expect(otm.deltaCall).toBe(0);
    expect(otm.deltaPut).toBe(-1);
    for (const value of [...Object.values(itm), ...Object.values(otm)]) {
      if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false);
    }
  });
});

describe('the normal distribution helpers', () => {
  it('erfc matches its defining identities to double precision', () => {
    expect(erfc(0)).toBe(1);
    expect(normalCdf(0)).toBe(0.5);
    for (const x of [-6, -2.5, -0.3, 0, 0.3, 0.46875, 1, 2.5, 6]) {
      // erfc(-x) = 2 - erfc(x), the reflection the tail branches must preserve.
      expect(Math.abs(erfc(-x) - (2 - erfc(x)))).toBeLessThanOrEqual(1e-15);
      // N(x) + N(-x) = 1.
      expect(Math.abs(normalCdf(x) + normalCdf(-x) - 1)).toBeLessThanOrEqual(1e-15);
    }
    // A published value, to the digits it is published to: N(1.96) = 0.9750021049.
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021049, 10);
    expect(normalCdf(-1.959963984540054)).toBeCloseTo(0.025, 12);
    expect(normalCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalCdf(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalPdf(0)).toBeCloseTo(0.3989422804014327, 15);
  });
});

describe('Black-76', () => {
  it('prices the forward-equivalent option identically to BSM with q = r', () => {
    // A forward whose present value is the spot: F = S*e^{(r-q)T} makes the two models agree.
    const forward = BASE.S * Math.exp((BASE.r - BASE.q) * BASE.T);
    const b76 = black76({ F: forward, K: BASE.K, r: BASE.r, sigma: BASE.sigma, T: BASE.T });
    expect(Math.abs(b76.call - OUT.call)).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(b76.put - OUT.put)).toBeLessThanOrEqual(1e-12);
    // Black-76 parity: C - P = e^{-rT}(F - K).
    const parity = Math.exp(-BASE.r * BASE.T) * (forward - BASE.K);
    expect(Math.abs(b76.call - b76.put - parity)).toBeLessThanOrEqual(1e-12);
    // rho is pure discounting in Black-76.
    expect(Math.abs(b76.rhoCall - -BASE.T * b76.call)).toBeLessThanOrEqual(1e-12);
    expect(b76.conventions.model).toBe('black_76');
  });
});

describe('the bsm engine envelope (ANAL-08)', () => {
  it('wraps the closed form with a stable inputsHash', () => {
    const a = bsmEngine(BASE, VALUATION_TS);
    const b = bsmEngine({ T: 1, sigma: 0.2, q: 0, r: 0.05, K: 100, S: 100 }, VALUATION_TS);
    expect(a.inputsHash).toBe(b.inputsHash);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.engine).toEqual({ name: 'bsm', version: '1.0.0' });
    expect(a.outputs.call).toBe(OUT.call);
    const moved = bsmEngine({ ...BASE, S: 100.01 }, VALUATION_TS);
    expect(moved.inputsHash).not.toBe(a.inputsHash);
  });

  it('reads exactly its declared input set', () => {
    const recorded = bsmEngine(BASE, VALUATION_TS, { recordReads: true });
    expect([...(recorded.inputsRead ?? [])]).toEqual(['K', 'S', 'T', 'q', 'r', 'sigma']);
  });
});

// ---------------------------------------------------------------------------------------------
// The checked-in golden records (QA-01)
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: BsmInputs;
  valuationTs: string;
  expected: Record<string, number>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN_DIR = new URL('../../../../fixtures/golden/analytics/bsm/', import.meta.url);

function loadGolden(): GoldenCase[] {
  const files = readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.flatMap((file) => {
    const text = readFileSync(new URL(file, GOLDEN_DIR), 'utf8');
    return JSON.parse(text) as GoldenCase[];
  });
}

describe('fixtures/golden/analytics/bsm/**', () => {
  const cases = loadGolden();

  it('checks in all four TESTING §7.2 cases', () => {
    expect(cases.map((c) => c.id).sort()).toEqual([
      'bsm.atm.1y',
      'bsm.deep.itm.call',
      'bsm.expiry',
      'bsm.zero.vol',
    ]);
  });

  for (const golden of cases) {
    it(`replays ${golden.id}`, () => {
      expect(golden.engine).toBe('bsm');
      expect(golden.engineVersion).toBe(bsmEngine.version);
      expect(golden.source.length).toBeGreaterThan(0);
      const result = bsmEngine(golden.inputs, golden.valuationTs);
      const outputs = result.outputs as unknown as Record<string, number>;
      for (const [key, expected] of Object.entries(golden.expected)) {
        const tol = golden.tol[key];
        expect(tol, `${golden.id}: no tolerance for '${key}'`).toBeTypeOf('number');
        const actual = outputs[key];
        expect(actual, `${golden.id}: engine has no output '${key}'`).toBeTypeOf('number');
        const diff = Math.abs((actual ?? NaN) - expected);
        expect(
          diff <= (tol ?? 0),
          `${golden.id}.${key}: got ${String(actual)}, expected ${String(expected)} — ` +
            `diff ${diff.toExponential(3)} > tol ${String(tol)}`,
        ).toBe(true);
      }
      // The hash is stable across runs (ANAL-08).
      expect(bsmEngine(golden.inputs, golden.valuationTs).inputsHash).toBe(result.inputsHash);
    });
  }
});
