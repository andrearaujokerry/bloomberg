// packages/core/test/analytics/bsm.crosscheck.test.ts — WP-02, TESTING §7.2 assertion 8.
//
// ANAL-09 asks for "two independent implementations" of the option price. TESTING §7.2 assertion 8
// names *this* file as the one that discharges it, so this is where the two cross-checks live as a
// pair. Each is also asserted in its own engine's test — the CRR envelope in `options/tree.test.ts`
// and the Monte Carlo envelope in `options/mc.test.ts`, alongside the convergence-rate and
// determinism assertions that belong with those engines. Nothing is skipped in either place: the
// point here is that §7.2 assertion 8 is discharged by one named file that states both claims
// together, rather than by two facts a reader has to go and find.
//
// The two implementations share no code with `bsm.ts`: the lattice has no erfc and no d1, and the
// simulation draws from the seeded xoshiro128** stream. Agreement is therefore evidence, not a
// tautology.
//
// ── On the 2e-2 Monte Carlo bound ────────────────────────────────────────────────────────────
// TESTING §7.2 describes 2e-2 as "≈ 3 standard errors". It is not, and the arithmetic is asserted
// below so the mistake cannot propagate into someone's re-derivation of a tolerance:
//
//   controlled standard error at 1e6 antithetic paths ≈ 2.74e-3  →  2e-2 ≈ 7.3 SE
//   uncontrolled standard error                       ≈ 1.04e-2  →  2e-2 ≈ 1.9 SE
//   observed error                                    ≈ −6.5e-4  →  −0.24 SE
//
// So 2e-2 is a loose absolute guard, roughly seven standard errors of the control-variate
// estimator, not a 3-sigma band on either estimator. The sharper "within 3 of its own standard
// errors" claim is asserted separately, which is the check that would actually catch a broken
// estimator.

import { describe, expect, it } from 'vitest';

import { bsm } from '../../src/analytics/options/bsm.js';
import { crr, type TreeInputs } from '../../src/analytics/options/tree.js';
import { monteCarlo, type McInputs } from '../../src/analytics/options/mc.js';

/** The TESTING §7.2 synthetic case: S = K = 100, r = 5 %, q = 0, σ = 20 %, T = 1. */
const TERMS = { S: 100, K: 100, r: 0.05, q: 0, sigma: 0.2, T: 1 } as const;

/** The closed form, unrounded — the subject both cross-checks are measured against. */
const EXACT = bsm(TERMS);

/** The price TESTING §7.2 pins to six decimals. */
const PINNED_CALL = 10.450584;

const CRR_5000: TreeInputs = { ...TERMS, steps: 5000, type: 'call', exercise: 'european' };

/** TESTING §7.2 assertion 8's simulation configuration. */
const MC_PINNED: McInputs = { ...TERMS, type: 'call', paths: 1_000_000, seed: 20260102 };

describe('TESTING §7.2 assertion 8 — two independent implementations (ANAL-09)', () => {
  it('CRR binomial at 5 000 steps reproduces the closed form within 5e-3', () => {
    const lattice = crr(CRR_5000);
    expect(Math.abs(lattice.price - EXACT.call)).toBeLessThanOrEqual(5e-3);
    // …and the §7.2 pinned literal, at the same envelope.
    expect(Math.abs(lattice.price - PINNED_CALL)).toBeLessThanOrEqual(5e-3);
    // CRR's European error is O(1/n) and lands below the closed form at an even step count, so the
    // envelope is not accidentally satisfied by a sign flip.
    expect(lattice.price).toBeLessThan(EXACT.call);
  });

  it('seeded antithetic + control-variate Monte Carlo over 1 000 000 paths lands within 2e-2', () => {
    const run = monteCarlo(MC_PINNED);
    const error = Math.abs(run.price - EXACT.call);
    expect(error).toBeLessThanOrEqual(2e-2);
    expect(Math.abs(run.price - PINNED_CALL)).toBeLessThanOrEqual(2e-2);
    // The sharper claim: inside three of its *own* standard errors.
    expect(error).toBeLessThanOrEqual(3 * run.stdError);
    expect(run.ci95Low).toBeLessThan(EXACT.call);
    expect(run.ci95High).toBeGreaterThan(EXACT.call);
  });

  it('states what 2e-2 is in standard errors — it is ≈7 SE, not the ≈3 SE §7.2 calls it', () => {
    const run = monteCarlo(MC_PINNED);
    // Control-variate standard error ≈ 2.74e-3.
    expect(run.stdError).toBeGreaterThan(2.5e-3);
    expect(run.stdError).toBeLessThan(3.0e-3);
    expect(2e-2 / run.stdError).toBeGreaterThan(6.5);
    expect(2e-2 / run.stdError).toBeLessThan(8);
    // Even the *uncontrolled* estimator, whose standard error is ≈1.04e-2, makes 2e-2 under 2 SE,
    // so "≈3 standard errors" does not describe either estimator.
    expect(run.stdErrorUncontrolled).toBeGreaterThan(9e-3);
    expect(run.stdErrorUncontrolled).toBeLessThan(1.2e-2);
    expect(2e-2 / run.stdErrorUncontrolled).toBeLessThan(2.5);
    // The control variate is what buys the factor of ~3.8 in precision.
    expect(run.stdErrorUncontrolled / run.stdError).toBeGreaterThan(3);
    // The observed error is a quarter of one controlled standard error.
    expect(Math.abs(run.price - EXACT.call) / run.stdError).toBeLessThan(0.5);
  });

  it('the two independent implementations agree with each other, not only with BSM', () => {
    const lattice = crr(CRR_5000);
    const run = monteCarlo(MC_PINNED);
    // Neither shares a line of code with the other; the envelope is the sum of the two above.
    expect(Math.abs(lattice.price - run.price)).toBeLessThanOrEqual(5e-3 + 2e-2);
  });
});
