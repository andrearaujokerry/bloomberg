// packages/core/test/analytics/bond.solver.test.ts — WP-02 (WORKPLAN L539), the TESTING §7.5 pin
// set for the yield solver: Newton with a bracket guard over [−0.99, 10.0], falling back to
// bisection whenever an iterate leaves the bracket, produces a non-finite price, or fails to
// reduce |f|. `outputs.method` records which path ran — that is what these tests assert on.
//
//   solver.newton      bond.discount.2y cashflows, target 98.141451, y0 = 0.05 (the coupon)
//                      → y = 0.060000000000, method 'newton', iterations ≤ 4, final |Δy| < 1e-12
//   solver.bisection   same, y0 = 9.5 → first Newton step y₁ ≈ −1111.4, outside the bracket, so
//                      the guard fires → y = 0.060000000000, method 'bisection', iterations ≤ 60,
//                      |f(y)| < 1e-10
//   solver.noRoot      same, target 0.005 → no sign change on the bracket (P(10.0) = 0.576775,
//                      exactly 0.5767746913580247; §7.5 prints the truncated 0.576774),
//                      so { ok: false, reason: 'NO_ROOT_IN_BRACKET' }: no divergence, no NaN, no
//                      throw
//   solver.determinism solver.newton twice → identical y bit-for-bit and identical inputsHash
//
// One arithmetic note, in the spirit of TESTING §7.2's assertion-7 note. The pinned target price
// 98.141451 is the exact price P(6 %) = 98.14145079859480 **rounded to six decimals**, so it sits
// 2.01e-7 above the true price; with dP/dy = −183.63 per unit of yield the root of the *rounded*
// target is 0.05999999890322 — 1.10e-9 below 6 %, a thousand times the pinned 1e-12. The 1e-12 pin
// is therefore asserted on the identity fed the engine's own unrounded price (where it holds to
// 1.6e-16), and the rounded literal is asserted at the tolerance its own rounding permits, stated
// with its reason as TESTING §7.1 requires. Nothing is bent to fit: method, iteration counts, the
// final |Δy|, the first Newton iterate and the no-root behaviour are all asserted exactly as §7.5
// pins them.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { BondTerms } from '../../src/analytics/bond/cashflows.js';
import type { BondEngineInputs } from '../../src/analytics/bond/price.js';
import {
  YIELD_BRACKET_HIGH,
  YIELD_BRACKET_LOW,
  bondYieldEngine,
  cleanPriceFromYield,
  discountedFlows,
  presentValue,
  presentValueDerivative,
  priceFromYield,
  solveRoot,
  yieldFromPrice,
} from '../../src/analytics/bond/price.js';

/** TESTING §7.5 runs on the TESTING §7.3 `bond.discount.2y` cashflows. */
const TERMS: BondTerms = {
  face: 100,
  couponRate: 0.05,
  frequency: 2,
  datedDate: '2026-08-15',
  maturity: '2028-08-15',
  dayCount: 'ACT/ACT',
};
const SETTLEMENT = '2026-08-15';
const VALUATION_TS = '2026-08-15T00:00:00Z';
const TARGET = 98.141451;
const EXACT_TARGET = cleanPriceFromYield(TERMS, SETTLEMENT, 0.06);

describe('TESTING §7.5 — solver.newton (y0 = 0.05, the coupon)', () => {
  const solved = yieldFromPrice(TERMS, SETTLEMENT, TARGET, { y0: 0.05 });

  it('converges by Newton in at most 4 iterations with a final |Δy| < 1e-12', () => {
    expect(solved.ok).toBe(true);
    expect(solved.method).toBe('newton');
    expect(solved.iterations).toBeLessThanOrEqual(4);
    expect(solved.lastStep).toBeLessThan(1e-12);
    expect(solved.fallbackReason).toBeNull();
  });

  it('lands on 6 % — exactly, when fed the unrounded price', () => {
    const exact = yieldFromPrice(TERMS, SETTLEMENT, EXACT_TARGET, { y0: 0.05 });
    expect(Math.abs(exact.yield - 0.06)).toBeLessThanOrEqual(1e-12);
    expect(exact.method).toBe('newton');
    expect(exact.iterations).toBeLessThanOrEqual(4);
    // …and to within the rounding of the pinned literal, when fed that.
    expect(Math.abs(solved.yield - 0.06)).toBeLessThanOrEqual(2e-9);
    expect(Math.abs(EXACT_TARGET - TARGET)).toBeLessThanOrEqual(5e-7);
  });

  it('converges from a 2 % seed as well as from the coupon', () => {
    const fromTwo = yieldFromPrice(TERMS, SETTLEMENT, TARGET, { y0: 0.02 });
    expect(fromTwo.method).toBe('newton');
    expect(fromTwo.ok).toBe(true);
    expect(fromTwo.iterations).toBeLessThanOrEqual(6);
    expect(Math.abs(fromTwo.yield - solved.yield)).toBeLessThanOrEqual(1e-12);
  });

  it('reprices its own answer to the target', () => {
    expect(Math.abs(cleanPriceFromYield(TERMS, SETTLEMENT, solved.yield) - TARGET)).toBeLessThan(
      1e-10,
    );
    expect(Math.abs(solved.residual)).toBeLessThan(1e-10);
  });
});

describe('TESTING §7.5 — solver.bisection (y0 = 9.5, the Newton overshoot)', () => {
  const solved = yieldFromPrice(TERMS, SETTLEMENT, TARGET, { y0: 9.5 });

  it('takes a first Newton step of about −1111.4, outside the bracket', () => {
    // f(9.5) = P(9.5) − 98.141451 = −97.524135 and f'(9.5) = −0.0870027, so
    // y₁ = 9.5 − (−97.524135)/(−0.0870027) ≈ −1111.4.
    const flows = discountedFlows(TERMS, SETTLEMENT);
    const f = presentValue(flows, 9.5, 2) - TARGET;
    const df = presentValueDerivative(flows, 9.5, 2);
    expect(f).toBeCloseTo(-97.524135, 5);
    expect(df).toBeCloseTo(-0.0870027, 6);
    expect(9.5 - f / df).toBeCloseTo(-1111.4, 1);
    expect(solved.firstNewtonStep).toBeCloseTo(-1111.4, 1);
    expect(solved.firstNewtonStep).toBeLessThan(YIELD_BRACKET_LOW);
  });

  it('falls back to bisection and converges in at most 60 iterations', () => {
    expect(solved.ok).toBe(true);
    expect(solved.method).toBe('bisection');
    expect(solved.newtonIterations).toBe(1);
    expect(solved.iterations).toBeLessThanOrEqual(60);
    expect(solved.fallbackReason).toContain('left the bracket');
    expect(Math.abs(solved.residual)).toBeLessThan(1e-10);
  });

  it('reaches the same root as Newton, to well inside 1e-10', () => {
    const newton = yieldFromPrice(TERMS, SETTLEMENT, TARGET, { y0: 0.05 });
    expect(Math.abs(solved.yield - newton.yield)).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(solved.yield - 0.06)).toBeLessThanOrEqual(2e-9);
  });

  it('takes the fallback on a second cashflow set that overshoots too', () => {
    // A 30-year zero: the price surface is far more convex, so a seed near the top of the bracket
    // throws Newton straight out of it.
    const zero: BondTerms = {
      face: 100,
      couponRate: 0,
      frequency: 2,
      datedDate: '2026-08-15',
      maturity: '2056-08-15',
    };
    const target = cleanPriceFromYield(zero, '2026-08-15', 0.05);
    const solvedZero = yieldFromPrice(zero, '2026-08-15', target, { y0: 9.0 });
    expect(solvedZero.method).toBe('bisection');
    expect(solvedZero.ok).toBe(true);
    expect(solvedZero.iterations).toBeLessThanOrEqual(60);
    expect(Math.abs(solvedZero.yield - 0.05)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(solvedZero.residual)).toBeLessThan(1e-10);
    // And from a sane seed the same bond solves by Newton — the fallback is the seed's fault.
    const byNewton = yieldFromPrice(zero, '2026-08-15', target, { y0: 0.04 });
    expect(byNewton.method).toBe('newton');
    expect(Math.abs(byNewton.yield - solvedZero.yield)).toBeLessThanOrEqual(1e-10);
  });
});

describe('TESTING §7.5 — solver.noRoot (target 0.005)', () => {
  it('P(10.0) = 0.576775, above the target, so there is no sign change', () => {
    const p10 = priceFromYield(TERMS, SETTLEMENT, YIELD_BRACKET_HIGH).cleanPrice;
    // Closed form at y = 10.0 (1000 %): the semiannual rate is 5, v = 1/6, so
    //   P = 2.5·(1 − 6⁻⁴)/5 + 100·6⁻⁴ = 0.4996141975308642 + 0.0771604938271605
    //     = 0.5767746913580247,
    // which rounds to 0.576775 at six decimals. §7.5 prints 0.576774, a truncation sitting 6.9e-7
    // from the true value — inside the stated 1e-6 with only 1.4× headroom. The exact closed form
    // is asserted here at 1e-12; the §7.5 literal is kept as the looser 1e-6 cross-check it is.
    const exact = (2.5 * (1 - Math.pow(6, -4))) / 5 + 100 * Math.pow(6, -4);
    expect(exact).toBeCloseTo(0.5767746913580247, 15);
    expect(Math.abs(p10 - exact)).toBeLessThanOrEqual(1e-12);
    expect(Number(p10.toFixed(6))).toBe(0.576775);
    expect(Math.abs(p10 - 0.576774)).toBeLessThanOrEqual(1e-6);
    expect(p10).toBeGreaterThan(0.005);
    expect(YIELD_BRACKET_HIGH).toBe(10.0);
    expect(YIELD_BRACKET_LOW).toBe(-0.99);
  });

  it('returns { ok: false, reason: NO_ROOT_IN_BRACKET } — no throw, no NaN root, no divergence', () => {
    const solved = yieldFromPrice(TERMS, SETTLEMENT, 0.005, { y0: 0.05 });
    expect(solved.ok).toBe(false);
    expect(solved.reason).toBe('NO_ROOT_IN_BRACKET');
    expect(solved.method).toBeNull();
    expect(Number.isNaN(solved.yield)).toBe(true);
  });

  it('reports the same for a target above the low end of the bracket', () => {
    // P(−0.99) is astronomically large, so a target above it has no root either.
    const huge = yieldFromPrice(TERMS, SETTLEMENT, 1e30, { y0: 0.05 });
    expect(huge.ok).toBe(false);
    expect(huge.reason).toBe('NO_ROOT_IN_BRACKET');
  });

  it('the bare root finder reports the bracket values it rejected', () => {
    const result = solveRoot((y) => y * y + 1, { y0: 0.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('NO_ROOT_IN_BRACKET');
      expect(result.fLo).toBeGreaterThan(0);
      expect(result.fHi).toBeGreaterThan(0);
    }
  });
});

describe('TESTING §7.5 — solver.determinism (ANAL-08)', () => {
  const inputs: BondEngineInputs = {
    face: 100,
    couponRate: 0.05,
    frequency: 2,
    datedDate: '2026-08-15',
    maturity: '2028-08-15',
    settlement: SETTLEMENT,
    dayCount: 'ACT/ACT',
    cleanPrice: TARGET,
    y0: 0.05,
  };

  it('two runs give an identical yield bit-for-bit and an identical inputsHash', () => {
    const a = bondYieldEngine(inputs, VALUATION_TS);
    const b = bondYieldEngine(inputs, VALUATION_TS);
    expect(b.outputs.yield).toBe(a.outputs.yield);
    expect(b.outputs.iterations).toBe(a.outputs.iterations);
    expect(b.inputsHash).toBe(a.inputsHash);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different seed changes the hash, but not the root beyond 1e-10', () => {
    const a = bondYieldEngine(inputs, VALUATION_TS);
    const c = bondYieldEngine({ ...inputs, y0: 9.5 }, VALUATION_TS);
    expect(c.inputsHash).not.toBe(a.inputsHash);
    expect(c.outputs.method).toBe('bisection');
    expect(Math.abs(c.outputs.yield - a.outputs.yield)).toBeLessThanOrEqual(1e-10);
  });
});

describe('the bare root finder', () => {
  it('uses a numerical derivative when none is supplied', () => {
    const result = solveRoot((y) => (1 + y) * (1 + y) - 2, { y0: 0.1, lo: -0.99, hi: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('newton');
      expect(Math.abs(result.y - (Math.SQRT2 - 1))).toBeLessThanOrEqual(1e-10);
    }
  });

  it('bisects when the seed makes Newton leave the bracket', () => {
    const result = solveRoot((y) => 1 / (1 + y) - 0.5, { y0: 9.9, lo: -0.99, hi: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Math.abs(result.y - 1)).toBeLessThanOrEqual(1e-10);
    }
  });

  it('accepts a seed that is already the root', () => {
    const result = solveRoot((y) => y - 0.04, { y0: 0.04 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.y).toBe(0.04);
      expect(result.iterations).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The checked-in golden (QA-01)
// ---------------------------------------------------------------------------------------------

interface GoldenCase {
  id: string;
  engine: string;
  engineVersion: string;
  inputs: BondEngineInputs;
  valuationTs: string;
  expected: Record<string, number | string | boolean>;
  tol: Record<string, number>;
  source: string;
}

const GOLDEN = new URL('../../../../fixtures/golden/analytics/bond/solver.json', import.meta.url);

describe('fixtures/golden/analytics/bond/solver.json', () => {
  const cases = JSON.parse(readFileSync(GOLDEN, 'utf8')) as GoldenCase[];

  it('checks in the four §7.5 cases', () => {
    expect(cases.map((c) => c.id)).toEqual([
      'solver.newton',
      'solver.newton.exact',
      'solver.bisection',
      'solver.noRoot',
    ]);
  });

  for (const golden of cases) {
    it(`replays ${golden.id}`, () => {
      expect(golden.engine).toBe('bond.yield');
      expect(golden.engineVersion).toBe(bondYieldEngine.version);
      expect(golden.source.length).toBeGreaterThan(0);
      const result = bondYieldEngine(golden.inputs, golden.valuationTs);
      const outputs = result.outputs as unknown as Record<string, number | string | boolean>;
      for (const [key, expected] of Object.entries(golden.expected)) {
        const actual = outputs[key];
        if (typeof expected === 'string' || typeof expected === 'boolean') {
          expect(actual, `${golden.id}.${key}`).toBe(expected);
          continue;
        }
        const tol = golden.tol[key];
        expect(tol, `${golden.id}: no tolerance for '${key}'`).toBeTypeOf('number');
        expect(actual, `${golden.id}: engine has no output '${key}'`).toBeTypeOf('number');
        const diff = Math.abs((actual as number) - expected);
        expect(
          diff <= (tol ?? 0),
          `${golden.id}.${key}: got ${String(actual)}, expected ${String(expected)} — ` +
            `diff ${diff.toExponential(3)} > tol ${String(tol)}`,
        ).toBe(true);
      }
      expect(bondYieldEngine(golden.inputs, golden.valuationTs).inputsHash).toBe(result.inputsHash);
    });
  }

  it('the two convergent cases agree with each other to 1e-10 (ANAL-09)', () => {
    const newton = cases.find((c) => c.id === 'solver.newton')?.inputs;
    const bisection = cases.find((c) => c.id === 'solver.bisection')?.inputs;
    if (newton === undefined || bisection === undefined) {
      throw new Error('solver.json is missing solver.newton or solver.bisection');
    }
    const a = bondYieldEngine(newton, VALUATION_TS).outputs;
    const b = bondYieldEngine(bisection, VALUATION_TS).outputs;
    expect(a.method).toBe('newton');
    expect(b.method).toBe('bisection');
    expect(Math.abs(a.yield - b.yield)).toBeLessThanOrEqual(1e-10);
  });
});
