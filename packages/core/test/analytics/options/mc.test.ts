// packages/core/test/analytics/options/mc.test.ts — WP-02 (WORKPLAN L545):
// "seeded runs are bit-identical; antithetic + control variate inside the documented standard
// error of BSM" (TESTING §7.2 assertion 8).
//
// Two independent claims are tested here, and they fail for different reasons:
//
//   - **Determinism.** `Math.random` is banned in `packages/core/src/**` (QA-02); the simulation
//     draws from the seeded xoshiro128** generator, so the same inputs must produce the *identical
//     double*, not a nearby one. That is asserted with `toBe` — an equality that a single changed
//     draw, a reordered accumulation or an extra `normal()` call would break. The literal price is
//     pinned as well, so a future refactor that silently changes the stream is caught even when
//     both runs inside one process still agree with each other.
//   - **Accuracy.** The estimator has to land inside its own error bar. TESTING §7.2 asks for
//     1 000 000 antithetic paths with a control variate on `S_T` at `seed = 20260102` to reproduce
//     the closed form within 2e-2. §7.2 calls 2e-2 "≈3 standard errors"; it is not — the controlled
//     standard error is 2.74e-3, so 2e-2 is ≈7.3 SE, and even the uncontrolled 1.04e-2 makes it only
//     ≈1.9 SE. 2e-2 is a loose absolute guard, not a 3-sigma band; `bsm.crosscheck.test.ts` asserts
//     that arithmetic explicitly so the wrong parenthetical cannot be re-used. This configuration
//     does far better than
//     that — the controlled standard error is 2.74e-3, and the price sits 0.24 of one standard
//     error from BSM — so both the absolute envelope and the sharper "within 3 of its own standard
//     errors" statement are asserted.

import { describe, expect, it } from 'vitest';

import { bsm } from '../../../src/analytics/options/bsm.js';
import { mcEngine, monteCarlo, type McInputs } from '../../../src/analytics/options/mc.js';

const TERMS = { S: 100, K: 100, r: 0.05, q: 0, sigma: 0.2, T: 1 };
const EXACT = bsm(TERMS);

/** TESTING §7.2 assertion 8's configuration. */
const PINNED: McInputs = { ...TERMS, type: 'call', paths: 1_000_000, seed: 20260102 };

describe('seeded determinism (QA-02)', () => {
  it('produces bit-identical results from the same seed', () => {
    const a = monteCarlo({ ...PINNED, paths: 200_000 });
    const b = monteCarlo({ ...PINNED, paths: 200_000 });
    expect(a.price).toBe(b.price);
    expect(a.priceUncontrolled).toBe(b.priceUncontrolled);
    expect(a.stdError).toBe(b.stdError);
    expect(a.beta).toBe(b.beta);
    expect(a.ci95Low).toBe(b.ci95Low);
  });

  it('pins the sequence: seed 20260102 over 1 000 000 antithetic paths', () => {
    const run = monteCarlo(PINNED);
    // A regression pin on the stream, not a value TESTING pins. It is asserted to 1e-12 rather
    // than with `toBe` because the last bit of a transcendental (`Math.exp` in the lognormal
    // step) belongs to the host libm; the xoshiro draws themselves are exact integer arithmetic
    // and identical everywhere, which is why two runs above compare with `toBe`.
    expect(run.price).toBeCloseTo(10.449929127857928, 12);
    expect(run.priceUncontrolled).toBeCloseTo(10.441086080186388, 12);
    expect(run.samples).toBe(500_000);
    expect(run.paths).toBe(1_000_000);
    expect(run.seed).toBe(20260102);
  });

  it('gives a different answer for a different seed, and both are inside the error bar', () => {
    const a = monteCarlo({ ...PINNED, paths: 200_000 });
    const b = monteCarlo({ ...PINNED, paths: 200_000, seed: 'a-different-seed' });
    expect(a.price).not.toBe(b.price);
    expect(Math.abs(a.price - EXACT.call)).toBeLessThan(3 * a.stdError);
    expect(Math.abs(b.price - EXACT.call)).toBeLessThan(3 * b.stdError);
  });
});

describe('accuracy against the closed form', () => {
  it('lands within its own standard error — and inside the 2e-2 TESTING §7.2 quotes', () => {
    const run = monteCarlo(PINNED);
    const error = Math.abs(run.price - EXACT.call);
    expect(error).toBeLessThanOrEqual(2e-2);
    expect(error).toBeLessThanOrEqual(3 * run.stdError);
    // The standard error this configuration actually achieves.
    expect(run.stdError).toBeLessThan(3e-3);
    expect(run.ci95Low).toBeLessThan(EXACT.call);
    expect(run.ci95High).toBeGreaterThan(EXACT.call);
    // And against the rounded price TESTING §7.2 pins, at the same envelope.
    expect(Math.abs(run.price - 10.450584)).toBeLessThanOrEqual(2e-2);
  });

  it('prices the put to the same accuracy, and reproduces put-call parity exactly', () => {
    const call = monteCarlo(PINNED);
    const put = monteCarlo({ ...PINNED, type: 'put' });
    expect(Math.abs(put.price - EXACT.put)).toBeLessThanOrEqual(3 * put.stdError);
    // With the control variate on S_T the two estimators share one corrected mean of S_T, and
    // the payoff difference is (S_T − K) path by path, so parity is exact to accumulated
    // round-off rather than to the Monte Carlo error.
    const parity = TERMS.S - TERMS.K * Math.exp(-TERMS.r * TERMS.T);
    expect(Math.abs(call.price - put.price - parity)).toBeLessThanOrEqual(1e-9);
  });

  it('converges as 1/sqrt(n)', () => {
    const small = monteCarlo({ ...PINNED, paths: 100_000 });
    const large = monteCarlo({ ...PINNED, paths: 1_000_000 });
    // Ten times the paths, sqrt(10) ≈ 3.162 times the precision.
    expect(small.stdError / large.stdError).toBeGreaterThan(2.8);
    expect(small.stdError / large.stdError).toBeLessThan(3.5);
  });

  it('is accurate away from the money and with a dividend yield', () => {
    for (const terms of [
      { S: 100, K: 130, r: 0.05, q: 0.02, sigma: 0.3, T: 2 },
      { S: 100, K: 80, r: 0.03, q: 0.06, sigma: 0.15, T: 0.5 },
    ]) {
      for (const type of ['call', 'put'] as const) {
        const run = monteCarlo({ ...terms, type, paths: 400_000, seed: 20260102 });
        const closed = type === 'call' ? bsm(terms).call : bsm(terms).put;
        expect(
          Math.abs(run.price - closed) <= 3 * run.stdError,
          `K=${String(terms.K)} ${type}: |${String(run.price)} − ${String(closed)}| > 3σ = ${String(3 * run.stdError)}`,
        ).toBe(true);
      }
    }
  });
});

describe('variance reduction', () => {
  it('antithetic and the control variate each cut the standard error', () => {
    const paths = 1_000_000;
    const plain = monteCarlo({ ...PINNED, paths, antithetic: false, control: 'none' });
    const antithetic = monteCarlo({ ...PINNED, paths, antithetic: true, control: 'none' });
    const both = monteCarlo({ ...PINNED, paths });

    expect(antithetic.stdError).toBeLessThan(plain.stdError);
    expect(both.stdError).toBeLessThan(antithetic.stdError);
    // Together they cut the variance by more than an order of magnitude — the same accuracy for
    // a twentieth of the paths.
    const varianceRatio = (plain.stdError / both.stdError) ** 2;
    expect(varianceRatio).toBeGreaterThan(10);

    // Every configuration is still unbiased: each lands inside its own three standard errors.
    for (const run of [plain, antithetic, both]) {
      expect(Math.abs(run.price - EXACT.call)).toBeLessThanOrEqual(3 * run.stdError);
    }
  });

  it('reports the control regression it actually fitted', () => {
    const run = monteCarlo({ ...PINNED, paths: 200_000 });
    expect(run.beta).toBeGreaterThan(0);
    expect(run.controlCorrelation).toBeGreaterThan(0.9);
    expect(run.controlCorrelation).toBeLessThanOrEqual(1);
    expect(run.varianceReduction).toBeGreaterThan(5);
    expect(run.stdError).toBeLessThan(run.stdErrorUncontrolled);
    // Turning the control off leaves the uncontrolled mean untouched, and reports beta = 0.
    const off = monteCarlo({ ...PINNED, paths: 200_000, control: 'none' });
    expect(off.beta).toBe(0);
    expect(off.price).toBe(off.priceUncontrolled);
    expect(off.price).toBe(run.priceUncontrolled);
  });

  it('echoes the conventions it ran under (ANAL-07)', () => {
    const run = monteCarlo({ ...PINNED, paths: 20_000 });
    expect(run.conventions.model).toBe('monte_carlo_gbm_terminal');
    expect(run.conventions.prng).toBe('xoshiro128**');
    expect(run.conventions.antithetic).toBe(true);
    expect(run.conventions.control).toBe('terminal_spot');
    expect(run.conventions.paths).toBe(20_000);
    expect(run.conventions.exercise).toBe('european');
  });
});

describe('input validation', () => {
  it('refuses an odd path count under antithetic sampling', () => {
    expect(() => monteCarlo({ ...PINNED, paths: 999 })).toThrow(/paths must be even/);
    // Without antithetic pairing an odd count is fine.
    expect(monteCarlo({ ...PINNED, paths: 999, antithetic: false }).samples).toBe(999);
  });

  it('refuses degenerate inputs', () => {
    expect(() => monteCarlo({ ...PINNED, paths: 1 })).toThrow(/paths must be an integer/);
    expect(() => monteCarlo({ ...PINNED, S: 0 })).toThrow(/S must be positive/);
    expect(() => monteCarlo({ ...PINNED, sigma: -0.1 })).toThrow(/sigma must not be negative/);
    expect(() => monteCarlo({ ...PINNED, type: 'straddle' as 'call' })).toThrow(/type must be/);
  });
});

describe('the mc engine envelope (ANAL-08)', () => {
  it('hashes the seed into inputsHash, so a re-run with another seed is another computation', () => {
    const inputs: McInputs = { ...PINNED, paths: 20_000 };
    const a = mcEngine(inputs, '2026-01-02T00:00:00Z');
    const b = mcEngine(inputs, '2026-01-02T00:00:00Z');
    expect(a.inputsHash).toBe(b.inputsHash);
    expect(a.outputs.price).toBe(b.outputs.price);
    expect(a.engine).toEqual({ name: 'option.mc', version: '1.0.0' });

    const reseeded = mcEngine({ ...inputs, seed: 7 }, '2026-01-02T00:00:00Z');
    expect(reseeded.inputsHash).not.toBe(a.inputsHash);
    expect(reseeded.outputs.price).not.toBe(a.outputs.price);
  });
});
