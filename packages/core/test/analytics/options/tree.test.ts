// packages/core/test/analytics/options/tree.test.ts — WP-02 (WORKPLAN L544):
// "CRR → BSM convergence for European; American put ≥ European put".
//
// The two things a lattice has to prove:
//
//   1. **It converges to the closed form.** CRR's European error is O(1/n) with a parity
//      oscillation, so the test asserts the *rate*, not a single lucky tolerance: over even step
//      counts 50…3200 the error times n is constant to within half a percent (−1.9946 → −1.9996),
//      which is what O(1/n) means, and the error halves every time n doubles. The oscillation
//      itself is pinned too — an odd step count lands on the other side of the true price — and
//      `crrAveraged` is shown to cancel it.
//   2. **American exercise is worth something and never worth less than European.** That
//      comparison is made on the *same lattice*, where it is a structural identity
//      (`max(continuation, intrinsic) ≥ continuation` at every node) and the tolerance is
//      therefore exactly zero, not an epsilon.
//
// The lattice shares no code with `bsm.ts` — no erfc, no d1 — so its agreement with the closed
// form is an independent confirmation (ANAL-09), which is the role TESTING §7.2 assertion 8 gives
// it.

import { describe, expect, it } from 'vitest';

import { bsm } from '../../../src/analytics/options/bsm.js';
import {
  DEFAULT_TRINOMIAL_LAMBDA,
  crr,
  crrAveraged,
  treeEngine,
  trinomial,
  type TreeInputs,
} from '../../../src/analytics/options/tree.js';

const EUROPEAN_CALL: TreeInputs = {
  S: 100,
  K: 100,
  r: 0.05,
  q: 0,
  sigma: 0.2,
  T: 1,
  steps: 100,
  type: 'call',
  exercise: 'european',
};

const EXACT = bsm({ S: 100, K: 100, r: 0.05, q: 0, sigma: 0.2, T: 1 });

/** Even step counts only: the parity oscillation is pinned separately, below. */
const EVEN_STEPS = [50, 100, 200, 400, 800, 1600, 3200] as const;

describe('CRR binomial → BSM convergence (European)', () => {
  it('converges at O(1/n): the error times n is constant and the error halves with n', () => {
    const errors = EVEN_STEPS.map((steps) => crr({ ...EUROPEAN_CALL, steps }).price - EXACT.call);
    for (const [i, steps] of EVEN_STEPS.entries()) {
      const err = errors[i] ?? NaN;
      // Every even-n price sits just below the closed form, by very nearly 2/n.
      expect(err).toBeLessThan(0);
      expect(
        Math.abs(err * steps + 1.9985) <= 0.006,
        `n=${String(steps)}: error*n = ${(err * steps).toFixed(5)}, expected ≈ −1.9985`,
      ).toBe(true);
    }
    for (let i = 1; i < errors.length; i += 1) {
      const previous = Math.abs(errors[i - 1] ?? NaN);
      const current = Math.abs(errors[i] ?? NaN);
      expect(current).toBeLessThan(previous);
      // Doubling n halves the error, to within 0.5 %.
      expect(Math.abs(previous / current - 2)).toBeLessThan(0.005);
    }
    expect(Math.abs(errors[errors.length - 1] ?? NaN)).toBeLessThan(1e-3);
  });

  it('reaches the closed form within 5e-3 at 5 000 steps (TESTING §7.2 assertion 8 envelope)', () => {
    const lattice = crr({ ...EUROPEAN_CALL, steps: 5000 });
    expect(Math.abs(lattice.price - EXACT.call)).toBeLessThanOrEqual(5e-3);
    // And the pinned price itself, at the same envelope.
    expect(Math.abs(lattice.price - 10.450584)).toBeLessThanOrEqual(5e-3);
  });

  it('oscillates with the parity of the step count, and the average cancels it', () => {
    const even = crr({ ...EUROPEAN_CALL, steps: 1000 }).price - EXACT.call;
    const odd = crr({ ...EUROPEAN_CALL, steps: 1001 }).price - EXACT.call;
    expect(even).toBeLessThan(0);
    expect(odd).toBeGreaterThan(0);
    // The two straddle the true price, so their average is far closer than either.
    const averaged = Math.abs(crrAveraged({ ...EUROPEAN_CALL, steps: 1000 }) - EXACT.call);
    expect(averaged).toBeLessThan(Math.abs(even) / 10);
    expect(averaged).toBeLessThan(2e-4);
  });

  it('prices the put too, and reproduces put-call parity on the lattice itself', () => {
    const steps = 501;
    const call = crr({ ...EUROPEAN_CALL, steps }).price;
    const put = crr({ ...EUROPEAN_CALL, steps, type: 'put' }).price;
    const parity = 100 * Math.exp(-0 * 1) - 100 * Math.exp(-0.05 * 1);
    // The lattice's own expectation of S_T is exactly S·e^{(r−q)T}, so parity is exact to
    // accumulated round-off — a much tighter statement than convergence to BSM.
    expect(Math.abs(call - put - parity)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(put - EXACT.put)).toBeLessThan(5e-3);
  });

  it('delivers lattice greeks that agree with the closed form', () => {
    const lattice = crr({ ...EUROPEAN_CALL, steps: 2000 });
    expect(Math.abs(lattice.delta - EXACT.deltaCall)).toBeLessThan(1e-4);
    expect(Math.abs(lattice.gamma - EXACT.gamma)).toBeLessThan(1e-5);
    // Theta comes off two steps of the lattice, so it inherits the O(dt) error of the grid.
    expect(Math.abs(lattice.theta - EXACT.thetaCall)).toBeLessThan(5e-3);
  });
});

describe('trinomial lattice', () => {
  it('converges to BSM, smoothly and about three times faster than CRR at equal n', () => {
    for (const steps of EVEN_STEPS) {
      const triError = Math.abs(trinomial({ ...EUROPEAN_CALL, steps }).price - EXACT.call);
      const crrError = Math.abs(crr({ ...EUROPEAN_CALL, steps }).price - EXACT.call);
      expect(triError).toBeLessThan(crrError);
      expect(triError * steps).toBeGreaterThan(0.6);
      expect(triError * steps).toBeLessThan(0.64);
    }
  });

  it('does not oscillate with the parity of n, unlike CRR', () => {
    for (const steps of [400, 401, 402, 403]) {
      const error = trinomial({ ...EUROPEAN_CALL, steps }).price - EXACT.call;
      // Same sign at every step count: the centre column always sits on S₀.
      expect(error).toBeLessThan(0);
      expect(Math.abs(error)).toBeLessThan(4e-3);
    }
  });

  it('uses a valid probability distribution with pMid = 1/3 at the default lambda', () => {
    const lattice = trinomial({ ...EUROPEAN_CALL, steps: 500 });
    expect(lattice.pUp + lattice.pMid + lattice.pDown).toBeCloseTo(1, 15);
    expect(lattice.pUp).toBeGreaterThan(0);
    expect(lattice.pDown).toBeGreaterThan(0);
    expect(lattice.pMid).toBeCloseTo(1 / 3, 15);
    expect(DEFAULT_TRINOMIAL_LAMBDA).toBeCloseTo(Math.sqrt(1.5), 15);
    expect(lattice.up * lattice.down).toBeCloseTo(1, 15);
  });

  it('reproduces put-call parity and the closed-form greeks', () => {
    const steps = 600;
    const call = trinomial({ ...EUROPEAN_CALL, steps });
    const put = trinomial({ ...EUROPEAN_CALL, steps, type: 'put' });
    // Parity holds against the lattice's *own* forward, not the continuous one: Kamrad-Ritchken
    // matches the first two moments of the log to O(dt^{3/2}), so the discrete E[S_T] is
    // 105.126961 against the continuous 105.127110. C − P = e^{−rT}(E_lattice[S_T] − K) is
    // therefore the exact statement (1e-9), and the gap to the continuous parity (1.4e-4) is the
    // lattice's own convergence error, not a pricing bug.
    const growthPerStep = call.pUp * call.up + call.pMid + call.pDown * call.down;
    const latticeForward = 100 * Math.pow(growthPerStep, steps);
    expect(Math.abs(latticeForward - 100 * Math.exp(0.05))).toBeLessThan(1e-3);
    const parity = Math.exp(-0.05) * (latticeForward - 100);
    expect(Math.abs(call.price - put.price - parity)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(call.price - put.price - (100 - 100 * Math.exp(-0.05)))).toBeLessThan(1e-3);
    expect(Math.abs(call.delta - EXACT.deltaCall)).toBeLessThan(1e-4);
    // The trinomial reads its gamma off the step-1 nodes, which are λ = √1.5 times further apart
    // than CRR's step-2 nodes at the same step count, so the second difference is taken over a
    // wider grid and converges with a larger constant: 1.1e-5 at 600 steps, 3.4e-6 at 2 000.
    expect(Math.abs(call.gamma - EXACT.gamma)).toBeLessThan(5e-5);
    expect(Math.abs(trinomial({ ...EUROPEAN_CALL, steps: 2000 }).gamma - EXACT.gamma)).toBeLessThan(
      5e-6,
    );
  });
});

describe('American exercise', () => {
  const AMERICAN_GRID = [
    { S: 100, K: 100, r: 0.05, q: 0, sigma: 0.2, T: 1 },
    { S: 100, K: 130, r: 0.05, q: 0, sigma: 0.2, T: 1 },
    { S: 100, K: 90, r: 0.05, q: 0, sigma: 0.35, T: 2 },
    { S: 100, K: 110, r: 0.08, q: 0.03, sigma: 0.15, T: 0.5 },
    { S: 100, K: 100, r: 0.01, q: 0.06, sigma: 0.25, T: 3 },
  ] as const;

  it('an American put is never worth less than the European put — on both lattices, exactly', () => {
    for (const terms of AMERICAN_GRID) {
      for (const method of ['crr', 'trinomial'] as const) {
        const price = method === 'crr' ? crr : trinomial;
        const shared = { ...terms, steps: 400, type: 'put' as const };
        const european = price({ ...shared, exercise: 'european' }).price;
        const american = price({ ...shared, exercise: 'american' }).price;
        // Structural, not numerical: the American roll-back takes max(continuation, intrinsic) at
        // every node, so the tolerance is zero.
        expect(
          american >= european,
          `${method} K=${String(terms.K)}: American put ${String(american)} < European ${String(european)}`,
        ).toBe(true);
        // And never below its own immediate exercise value.
        expect(american).toBeGreaterThanOrEqual(Math.max(terms.K - terms.S, 0));
      }
    }
  });

  it('the American premium is strictly positive for an in-the-money put', () => {
    const terms = {
      S: 100,
      K: 130,
      r: 0.05,
      q: 0,
      sigma: 0.2,
      T: 1,
      steps: 800,
      type: 'put' as const,
    };
    const european = crr({ ...terms, exercise: 'european' });
    const american = crr({ ...terms, exercise: 'american' });
    expect(american.price).toBeGreaterThan(european.price + 1);
    expect(american.earlyExercise).toBe(true);
    expect(european.earlyExercise).toBe(false);
    // Deep enough in the money, immediate exercise is optimal and the price is the intrinsic.
    const deep = crr({ ...terms, S: 50, exercise: 'american' });
    expect(deep.price).toBe(80);
  });

  it('an American call on a non-dividend-paying stock is the European call, to the bit', () => {
    const terms = { ...EUROPEAN_CALL, steps: 800 };
    const european = crr(terms);
    const american = crr({ ...terms, exercise: 'american' });
    // The classic no-early-exercise result: with q = 0 the continuation value dominates the
    // intrinsic at every node, so the two roll-backs produce the identical double.
    expect(american.price).toBe(european.price);
    expect(american.earlyExercise).toBe(false);
  });

  it('a dividend yield above the rate makes early exercise of the call optimal', () => {
    const terms = { ...EUROPEAN_CALL, q: 0.08, steps: 800, exercise: 'american' as const };
    const american = crr(terms);
    const european = crr({ ...terms, exercise: 'european' });
    expect(american.earlyExercise).toBe(true);
    expect(american.price).toBeGreaterThan(european.price);
    // The European leg still matches the closed form with the same yield.
    const closed = bsm({ S: 100, K: 100, r: 0.05, q: 0.08, sigma: 0.2, T: 1 });
    expect(Math.abs(european.price - closed.call)).toBeLessThan(5e-3);
  });

  it('both lattices agree on the American put to within their discretisation error', () => {
    const terms = { S: 100, K: 110, r: 0.05, q: 0, sigma: 0.3, T: 1, type: 'put' as const };
    const binomial = crr({ ...terms, steps: 1500, exercise: 'american' }).price;
    const tri = trinomial({ ...terms, steps: 1500, exercise: 'american' }).price;
    expect(Math.abs(binomial - tri)).toBeLessThan(5e-3);
  });
});

describe('degenerate lattices', () => {
  it('T = 0 is the payoff', () => {
    expect(crr({ ...EUROPEAN_CALL, K: 95, T: 0 }).price).toBe(5);
    expect(crr({ ...EUROPEAN_CALL, K: 105, T: 0, type: 'put' }).price).toBe(5);
    expect(trinomial({ ...EUROPEAN_CALL, K: 95, T: 0 }).price).toBe(5);
    expect(crr({ ...EUROPEAN_CALL, K: 95, T: 0 }).delta).toBe(1);
  });

  it('sigma = 0 is the discounted deterministic forward', () => {
    const closed = bsm({ S: 100, K: 100, r: 0.05, q: 0, sigma: 0, T: 1 });
    expect(crr({ ...EUROPEAN_CALL, sigma: 0, steps: 100 }).price).toBeCloseTo(closed.call, 12);
    expect(trinomial({ ...EUROPEAN_CALL, sigma: 0, steps: 100 }).price).toBeCloseTo(
      closed.call,
      12,
    );
    // An American put on a forward that only drifts up is never exercised early here.
    const put = crr({ ...EUROPEAN_CALL, sigma: 0, steps: 100, type: 'put', exercise: 'american' });
    expect(put.price).toBe(0);
  });

  it('refuses a step size the probabilities cannot support', () => {
    const impossible: TreeInputs = {
      S: 100,
      K: 100,
      r: 1,
      q: 0,
      sigma: 0.05,
      T: 1,
      steps: 1,
      type: 'call',
      exercise: 'european',
    };
    expect(() => crr(impossible)).toThrow(/outside \[0, 1\]/);
    expect(() => trinomial(impossible)).toThrow(/not a distribution/);
    expect(() => crr({ ...EUROPEAN_CALL, steps: 0 })).toThrow(/positive integer/);
    expect(() => crr({ ...EUROPEAN_CALL, S: 0 })).toThrow(/S must be positive/);
  });
});

describe('the tree engine envelope (ANAL-08)', () => {
  it('dispatches on method and echoes its conventions', () => {
    const inputs = { ...EUROPEAN_CALL, steps: 200, method: 'crr' as const };
    const result = treeEngine(inputs, '2026-01-02T00:00:00Z');
    expect(result.engine).toEqual({ name: 'option.tree', version: '1.0.0' });
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.outputs.price).toBe(crr({ ...EUROPEAN_CALL, steps: 200 }).price);
    expect(result.outputs.conventions.model).toBe('cox_ross_rubinstein');
    expect(result.outputs.conventions.exercise).toBe('european');
    expect(result.outputs.conventions.steps).toBe(200);

    const tri = treeEngine({ ...inputs, method: 'trinomial' }, '2026-01-02T00:00:00Z');
    expect(tri.outputs.conventions.model).toBe('kamrad_ritchken_trinomial');
    expect(tri.inputsHash).not.toBe(result.inputsHash);
    expect(() =>
      treeEngine({ ...inputs, method: 'jarrow-rudd' as 'crr' }, '2026-01-02T00:00:00Z'),
    ).toThrow(/method must be/);
  });
});
