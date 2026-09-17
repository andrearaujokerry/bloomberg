// packages/core/test/analytics/curve.bootstrap.test.ts — WP-02 (WORKPLAN L503-506, L540),
// TESTING §7.7: "bootstrapped curve reprices its own inputs to zero error; `nodes` shape matches
// `curve_builds.nodes`".
//
// Every number asserted here comes from `fixtures/golden/analytics/curve/bootstrap.json`, whose
// cases are §7.7's four plus the bills case WORKPLAN L503 asks for. The pinned values are either
// §7.7's own (the par quote set, 100.000000000000, 1e-10, the 1.025⁻ᵏ closed forms, 5.000000 %,
// the 1e-6 separation at t = 4) or closed forms of a published convention (a bill's 1 − d·days/360,
// SOFR's 1/(1 + r·τ)). None of them was produced by the engine under test.
//
// One discrepancy is recorded rather than papered over: §7.7's table renders `1.025⁻²⁰` as
// `0.610270940`, but 1.025⁻²⁰ is 0.6102709428588309 — the printed decimal is wrong by 2.86e-9 in
// its last two digits, which is 2,860× the 1e-12 the same row demands. The assertion below pins the
// **expression** at 1e-12 and the **printed decimal** at the 5e-9 its typo forces, so neither half
// of the pin is quietly dropped. See `notesForIntegrator`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SIFMA } from '../../src/calendars/sifma.js';
import { adjustDate } from '../../src/daycount/businessDay.js';
import type {
  BillQuote,
  CurveBuildOutputs,
  OisBootstrapInputs,
  OisScheduleConventions,
  ParBootstrapInputs,
  ParQuote,
} from '../../src/analytics/curve/bootstrap.js';
import {
  bootstrapOisCurve,
  bootstrapParCurve,
  impliedParRate,
  oisParRate,
  oisPv,
  oisScheduleOf,
  parBondPrice,
  parScheduleOf,
} from '../../src/analytics/curve/bootstrap.js';
import { CURVE_NODE_KEYS, isCurveNode } from '../../src/analytics/curve/curve.js';
import { INTERPOLATION_NAMES } from '../../src/analytics/curve/interp.js';
import type { EngineResult, InterpolationName } from '../../src/analytics/engine.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden file
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface GoldenCase {
  readonly id: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly inputs: Record<string, unknown>;
  readonly valuationTs: string;
  readonly expected: Record<string, number | string | boolean>;
  readonly tol: Record<string, number>;
  readonly source: string;
}

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../fixtures/golden/analytics/curve/bootstrap.json', import.meta.url),
    ),
    'utf8',
  ),
) as GoldenCase[];

function goldenCase(id: string): GoldenCase {
  const found = GOLDEN.find((c) => c.id === id);
  if (found === undefined) throw new Error(`golden case ${id} is missing from bootstrap.json`);
  return found;
}

function pinned(kase: GoldenCase, key: string): { value: number; tol: number } {
  const value = kase.expected[key];
  const tol = kase.tol[key];
  if (typeof value !== 'number') throw new Error(`${kase.id}.expected.${key} is not a number`);
  if (typeof tol !== 'number') throw new Error(`${kase.id}.tol.${key} is missing`);
  return { value, tol };
}

/** Assert `actual` against the golden pin, and report the achieved error when it fails. */
function expectPinned(kase: GoldenCase, key: string, actual: number): number {
  const { value, tol } = pinned(kase, key);
  const error = Math.abs(actual - value);
  if (!(error <= tol)) {
    throw new Error(
      `${kase.id}.${key}: got ${String(actual)}, pinned ${String(value)}, |Δ| = ${String(error)} > ${String(tol)}`,
    );
  }
  expect(error).toBeLessThanOrEqual(tol);
  return error;
}

function parInputsOf(kase: GoldenCase): ParBootstrapInputs {
  return kase.inputs as unknown as ParBootstrapInputs;
}

function quotesOf(kase: GoldenCase): ParQuote[] {
  return (kase.inputs.parQuotes as ParQuote[] | undefined) ?? [];
}

function build(inputs: ParBootstrapInputs, valuationTs: string): EngineResult<
  ParBootstrapInputs,
  CurveBuildOutputs
> {
  return bootstrapParCurve(inputs, valuationTs);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §7.7 — curve.par.selfconsistency
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.par.selfconsistency (TESTING §7.7) — the round-trip requirement', () => {
  const kase = goldenCase('curve.par.selfconsistency');
  const inputs = parInputsOf(kase);
  const result = build(inputs, kase.valuationTs);
  const outputs = result.outputs;
  const curve = outputs.curve;

  it('runs through defineEngine and carries its identity (ANAL-08)', () => {
    expect(result.engine.name).toBe(kase.engine);
    expect(result.engine.version).toBe(kase.engineVersion);
    expect(result.valuationTs).toBe(kase.valuationTs);
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outputs.method).toBe('bills+par_bootstrap');
    expect(outputs.interpolation).toBe('log_linear_df');
  });

  it('reprices every input tenor to a clean 100.000000000000', () => {
    let worst = 0;
    for (const quote of quotesOf(kase)) {
      const schedule = parScheduleOf(inputs.curveDate, quote.tenor, inputs.frequency);
      const price = parBondPrice(curve, schedule, quote.parRate / 100);
      worst = Math.max(worst, expectPinned(kase, `price@${quote.tenor}`, price));
    }
    // §7.7 checks this at every node, not just the last; the worst of the six is reported so a
    // regression that stays inside 1e-10 is still visible in the test output.
    expect(worst).toBeLessThanOrEqual(1e-10);
  });

  it('re-implies every input par rate to 1e-10 percent', () => {
    for (const quote of quotesOf(kase)) {
      const schedule = parScheduleOf(inputs.curveDate, quote.tenor, inputs.frequency);
      expectPinned(kase, `parRate@${quote.tenor}`, impliedParRate(curve, schedule) * 100);
    }
  });

  it('has df(0) = 1 exactly and strictly decreasing discount factors', () => {
    expect(curve.df(0)).toBe(1);
    expect(pinned(kase, 'dfAtZero').value).toBe(1);
    let previous = 1;
    for (let t = 0.05; t <= 10 + 1e-12; t += 0.05) {
      const df = curve.df(t);
      expect(df).toBeLessThan(previous);
      previous = df;
    }
  });

  it('keeps zero(t) and fwd(t1,t2) mutually consistent to 1e-12', () => {
    // §7.7: df(t2)/df(t1) = exp(−fwd·(t2 − t1)) for the continuous accessor.
    for (const [t1, t2] of [
      [0, 0.5],
      [0.5, 1],
      [1, 2],
      [2, 3.25],
      [3.25, 7],
      [7, 10],
    ] as const) {
      const fwd = curve.fwd(t1, t2, 'continuous');
      const ratio = curve.df(t2) / curve.df(t1);
      expect(Math.abs(ratio - Math.exp(-fwd * (t2 - t1)))).toBeLessThan(1e-12);
    }
    // And the zero accessor is the same statement over [0, t]: df(t) = (1 + z/2)^(-2t) on the
    // curve's own semiannual compounding.
    for (const t of [0.25, 1, 2.5, 6, 10]) {
      const z = curve.zero(t);
      expect(Math.abs(curve.df(t) - Math.pow(1 + z / 2, -2 * t))).toBeLessThan(1e-14);
      expect(Math.abs(curve.zero(t, 'continuous') - -Math.log(curve.df(t)) / t)).toBeLessThan(1e-14);
    }
  });

  it('has one node per input', () => {
    expectPinned(kase, 'nodeCount', outputs.nodes.length);
    expect(outputs.nodes).toHaveLength(quotesOf(kase).length);
  });

  it('has a stable inputsHash that moves when an input moves (ANAL-08)', () => {
    const again = build(inputs, kase.valuationTs);
    expect(again.inputsHash).toBe(result.inputsHash);
    // Key order is irrelevant — canonical JSON sorts — so a re-ordered input object is the same
    // build and must de-duplicate in `curve_builds`.
    const reordered: ParBootstrapInputs = {
      interpolation: inputs.interpolation,
      compounding: inputs.compounding,
      dayCount: inputs.dayCount,
      frequency: inputs.frequency,
      parQuotes: inputs.parQuotes,
      curveDate: inputs.curveDate,
      curveId: inputs.curveId,
    };
    expect(build(reordered, kase.valuationTs).inputsHash).toBe(result.inputsHash);

    const bumped: ParBootstrapInputs = {
      ...inputs,
      parQuotes: inputs.parQuotes.map((q, i) =>
        i === 3 ? { tenor: q.tenor, parRate: q.parRate + 1e-8 } : q,
      ),
    };
    expect(build(bumped, kase.valuationTs).inputsHash).not.toBe(result.inputsHash);
    const reInterpolated: ParBootstrapInputs = { ...inputs, interpolation: 'monotone_convex' };
    expect(build(reInterpolated, kase.valuationTs).inputsHash).not.toBe(result.inputsHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The nodes shape — curve_builds.nodes
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('snapshot() is exactly curve_builds.nodes (DATA_MODEL L1515)', () => {
  const kase = goldenCase('curve.par.selfconsistency');
  const result = build(parInputsOf(kase), kase.valuationTs);
  const curve = result.outputs.curve;
  const nodes = result.outputs.nodes;

  it('is [{t, df, zero, fwd}] — those four keys, no more, no fewer', () => {
    expect(CURVE_NODE_KEYS).toEqual(['t', 'df', 'zero', 'fwd']);
    for (const node of nodes) {
      expect(Object.keys(node).sort()).toEqual([...CURVE_NODE_KEYS].sort());
      expect(isCurveNode(node)).toBe(true);
    }
    expect(isCurveNode({ t: 1, df: 0.96, zero: 0.04 })).toBe(false);
    expect(isCurveNode({ t: 1, df: 0.96, zero: 0.04, fwd: 0.04, extra: 1 })).toBe(false);
  });

  it('survives the jsonb round trip unchanged', () => {
    const round = JSON.parse(JSON.stringify(nodes)) as unknown[];
    expect(round).toEqual(nodes.map((n) => ({ t: n.t, df: n.df, zero: n.zero, fwd: n.fwd })));
    for (const node of round) expect(isCurveNode(node)).toBe(true);
  });

  it('agrees with the accessors it was taken from', () => {
    let previous = 0;
    for (const node of nodes) {
      expect(node.df).toBe(curve.df(node.t));
      expect(node.zero).toBe(curve.zero(node.t));
      expect(node.fwd).toBe(curve.fwd(previous, node.t));
      // The node rates are decimals on the curve's own compounding (semiannual bond basis).
      expect(Math.abs(node.df - Math.pow(1 + node.zero / 2, -2 * node.t))).toBeLessThan(1e-14);
      previous = node.t;
    }
    expect(nodes.map((n) => n.t)).toEqual([...nodes.map((n) => n.t)].sort((a, b) => a - b));
  });

  it('carries the conventions the build ran under (ANAL-07)', () => {
    expect(result.outputs.conventions).toMatchObject({
      dayCount: 'ACT/ACT',
      compounding: 'semiannual',
      interpolation: 'log_linear_df',
      frequency: 2,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §7.7 — curve.flat.analytic
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.flat.analytic (TESTING §7.7) — the closed-form anchor', () => {
  const kase = goldenCase('curve.flat.analytic');
  const inputs = parInputsOf(kase);
  const result = build(inputs, kase.valuationTs);
  const curve = result.outputs.curve;

  it('produces 1.025⁻¹, 1.025⁻², 1.025⁻⁴ and 1.025⁻²⁰ at 0.5, 1, 2 and 10 years', () => {
    expectPinned(kase, 'df@0.5', curve.df(0.5));
    expectPinned(kase, 'df@1', curve.df(1));
    expectPinned(kase, 'df@2', curve.df(2));
    expectPinned(kase, 'df@10', curve.df(10));
    // The golden values are the closed forms themselves, not a transcription of them.
    expect(pinned(kase, 'df@0.5').value).toBe(Math.pow(1.025, -1));
    expect(pinned(kase, 'df@1').value).toBe(Math.pow(1.025, -2));
    expect(pinned(kase, 'df@2').value).toBe(Math.pow(1.025, -4));
    expect(pinned(kase, 'df@10').value).toBe(Math.pow(1.025, -20));
  });

  it("matches §7.7's printed decimals, and records the one that is a typo", () => {
    expect(curve.df(0.5).toFixed(9)).toBe('0.975609756');
    expect(curve.df(1).toFixed(9)).toBe('0.951814396');
    expect(curve.df(2).toFixed(9)).toBe('0.905950645');
    // §7.7 prints 0.610270940 for 1.025⁻²⁰. The closed form is 0.610270943.
    expectPinned(kase, 'df@10.printed', curve.df(10));
    expect(curve.df(10).toFixed(9)).toBe('0.610270943');
    expect(Math.abs(Math.pow(1.025, -20) - 0.61027094)).toBeGreaterThan(1e-12);
    expect(Math.abs(Math.pow(1.025, -20) - 0.61027094)).toBeLessThan(5e-9);
  });

  it('is flat at 5.000000 % on the zero curve for every t', () => {
    const { value: flat, tol } = pinned(kase, 'zeroPercent');
    for (let t = 0.05; t <= 10 + 1e-12; t += 0.05) {
      expect(Math.abs(curve.zero(t) * 100 - flat)).toBeLessThanOrEqual(tol);
    }
    // …and on every node forward, which is the same statement about the shape between nodes.
    for (const node of result.outputs.nodes) {
      expectPinned(kase, 'fwdPercent', node.fwd * 100);
      expectPinned(kase, 'zeroPercent', node.zero * 100);
    }
    expectPinned(kase, 'nodeCount', result.outputs.nodes.length);
  });

  it('is flat under all three interpolations — a flat curve has one interpolant', () => {
    for (const interpolation of INTERPOLATION_NAMES) {
      const alt = build({ ...inputs, interpolation }, kase.valuationTs).outputs.curve;
      expect(Math.abs(alt.df(0.5) - Math.pow(1.025, -1))).toBeLessThan(1e-12);
      expect(Math.abs(alt.df(10) - Math.pow(1.025, -20))).toBeLessThan(1e-12);
      for (let t = 0.25; t <= 10; t += 0.25) {
        expect(Math.abs(alt.zero(t) * 100 - 5)).toBeLessThan(1e-10);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §7.7 — curve.interpolation.monotone
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.interpolation.monotone (TESTING §7.7) — the interpolation may not move a node', () => {
  const kase = goldenCase('curve.interpolation.monotone');
  const inputs = parInputsOf(kase);
  const quotes = quotesOf(kase);

  const built = new Map<InterpolationName, CurveBuildOutputs>();
  for (const interpolation of INTERPOLATION_NAMES) {
    built.set(interpolation, build({ ...inputs, interpolation }, kase.valuationTs).outputs);
  }

  for (const interpolation of INTERPOLATION_NAMES) {
    it(`${interpolation} still reprices every input to 1e-10`, () => {
      const outputs = built.get(interpolation);
      expect(outputs).toBeDefined();
      if (outputs === undefined) return;
      expect(outputs.interpolation).toBe(interpolation);
      for (const quote of quotes) {
        const schedule = parScheduleOf(inputs.curveDate, quote.tenor, inputs.frequency);
        expectPinned(kase, `price@${quote.tenor}`, parBondPrice(outputs.curve, schedule, quote.parRate / 100));
        const implied = impliedParRate(outputs.curve, schedule) * 100;
        expect(Math.abs(implied - quote.parRate)).toBeLessThanOrEqual(1e-10);
      }
      expect(outputs.maxResidual).toBeLessThanOrEqual(1e-10);
    });
  }

  it('makes monotone_convex converge: the sweep is what keeps its nodes exact', () => {
    // `log_linear_df` and `linear_zero` are local, so the sequential pass is already the answer;
    // `monotone_convex` is not, and the Gauss-Seidel sweeps are what make the claim above true.
    expect(built.get('log_linear_df')?.sweeps).toBe(0);
    expect(built.get('linear_zero')?.sweeps).toBe(0);
    expect(built.get('monotone_convex')?.sweeps).toBeGreaterThan(0);
  });

  it('separates the three interpolations at t = 4 by more than 1e-6', () => {
    const { value: threshold } = pinned(kase, 'minimumSeparationAtT4');
    expect(threshold).toBe(1e-6);
    const dfs = INTERPOLATION_NAMES.map((name) => built.get(name)?.curve.df(4) ?? Number.NaN);
    for (let i = 0; i < dfs.length; i += 1) {
      for (let j = i + 1; j < dfs.length; j += 1) {
        expect(Math.abs((dfs[i] ?? 0) - (dfs[j] ?? 0))).toBeGreaterThan(threshold);
      }
    }
    expect(kase.expected.repricesUnderEveryInterpolation).toBe(true);
  });

  it('solves node values that stay within 1e-3 of each other', () => {
    // The flip side of the separation. The three builds do *not* share node values — each reprices
    // the same bond through a different interior shape, which moves the solved node by ~7e-6 in df
    // — but they may not diverge: a node that moved by a basis point would mean one of the three
    // interpolations was repricing a different instrument.
    const reference = built.get('log_linear_df');
    expect(reference).toBeDefined();
    if (reference === undefined) return;
    const ceiling = pinned(kase, 'nodeDiscountFactorsAgreeWithin').value;
    expect(ceiling).toBe(1e-3);
    for (const node of reference.nodes) {
      for (const interpolation of INTERPOLATION_NAMES) {
        const other = built.get(interpolation)?.curve.df(node.t) ?? Number.NaN;
        expect(Math.abs(other - node.df)).toBeLessThan(ceiling);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bills + par coupons (WORKPLAN L503)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.bills.par — bills plus par coupon bonds to discount factors', () => {
  const kase = goldenCase('curve.bills.par');
  const inputs = parInputsOf(kase);
  const result = build(inputs, kase.valuationTs);
  const curve = result.outputs.curve;
  const bills = (kase.inputs.bills as BillQuote[] | undefined) ?? [];

  it('takes each bill discount factor straight from its quoted price', () => {
    for (const bill of bills) {
      const closedForm = 1 - (bill.discountRate / 100) * (bill.days / 360);
      const node = result.outputs.nodes.find(
        (n) => Math.abs(n.df - closedForm) < 1e-15,
      );
      expect(node, `no node for the ${bill.tenor} bill`).toBeDefined();
      expectPinned(kase, `df@${bill.tenor}`, node?.df ?? Number.NaN);
      expect(closedForm).toBe(pinned(kase, `df@${bill.tenor}`).value);
    }
  });

  it('still reprices every par bond to 100 with the bills in the curve', () => {
    for (const quote of quotesOf(kase)) {
      const schedule = parScheduleOf(inputs.curveDate, quote.tenor, inputs.frequency);
      expectPinned(kase, `price@${quote.tenor}`, parBondPrice(curve, schedule, quote.parRate / 100));
    }
    expectPinned(kase, 'parRate@10Y', impliedParRate(curve, parScheduleOf(inputs.curveDate, '10Y', 2)) * 100);
  });

  it('has one node per instrument, ascending, with the bills at the short end', () => {
    expectPinned(kase, 'nodeCount', result.outputs.nodes.length);
    expect(result.outputs.nodes).toHaveLength(bills.length + quotesOf(kase).length);
    const times = result.outputs.nodes.map((n) => n.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeLessThan(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §7.7 — curve.ois.bootstrap
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('curve.ois.bootstrap (TESTING §7.7) — SOFR fixings + par OIS', () => {
  const kase = goldenCase('curve.ois.bootstrap');
  const inputs = kase.inputs as unknown as OisBootstrapInputs;
  const result = bootstrapOisCurve(inputs, kase.valuationTs);
  const curve = result.outputs.curve;
  const quotes = inputs.quotes;
  const conventions: OisScheduleConventions = {
    fixedFrequency: 1,
    settlementDays: 2,
    businessDayConvention: 'modified_following',
    calendar: SIFMA,
  };

  it('runs through defineEngine as the ois_bootstrap method', () => {
    expect(result.engine.name).toBe('curve.ois.bootstrap');
    expect(result.engine.version).toBe(kase.engineVersion);
    expect(result.outputs.method).toBe('ois_bootstrap');
    expect(result.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bootstrapOisCurve(inputs, kase.valuationTs).inputsHash).toBe(result.inputsHash);
    expect(result.outputs.conventions).toMatchObject({
      dayCount: 'ACT/360',
      businessDayConvention: 'modified_following',
      calendar: 'SIFMA',
      settlementDays: 2,
    });
  });

  it('anchors the overnight node on the latest fixing, 1/(1 + r·τ) ACT/360', () => {
    expectPinned(kase, 'overnightTau', 1 / 360);
    const node = result.outputs.nodes[0];
    expect(node).toBeDefined();
    if (node === undefined) return;
    expectPinned(kase, 'overnightTau', node.t);
    expectPinned(kase, 'overnightDf', node.df);
    // The fixing used is the one effective on the curve date (4.33 %), not the first in the list.
    expect(node.df).toBe(1 / (1 + 0.0433 * (1 / 360)));
    expect(curve.df(0)).toBe(1);
    expectPinned(kase, 'dfAtZero', curve.df(0));
  });

  it('prices every par OIS to zero PV and re-implies its quote to 1e-10 percent', () => {
    for (const quote of quotes) {
      const schedule = oisScheduleOf(inputs.curveDate, quote.tenor, conventions);
      expectPinned(kase, `pv@${quote.tenor}`, oisPv(curve, schedule, quote.parRate / 100));
      expectPinned(kase, `parRate@${quote.tenor}`, oisParRate(curve, schedule) * 100);
    }
    expectPinned(kase, 'nodeCount', result.outputs.nodes.length);
  });

  it('rolls T+2, modified following, SIFMA (WORKPLAN L507)', () => {
    const schedule = oisScheduleOf(inputs.curveDate, '10Y', conventions);
    // 2026-09-15 is a Tuesday; T+2 on SIFMA is Thursday 2026-09-17.
    expect(schedule.start).toBe('2026-09-17');
    expect(SIFMA.isBusinessDay(schedule.start)).toBe(true);
    expect(schedule.payments).toHaveLength(10);
    let previous = schedule.start;
    for (const payment of schedule.payments) {
      expect(SIFMA.isBusinessDay(payment.date)).toBe(true);
      // Each payment is the unadjusted anniversary rolled modified following, never a free choice.
      expect(payment.date).toBe(adjustDate(SIFMA, payment.date, 'modified_following'));
      expect(payment.date > previous).toBe(true);
      expect(payment.accrual).toBeGreaterThan(360 / 360 - 0.02);
      expect(payment.accrual).toBeLessThan(370 / 360);
      previous = payment.date;
    }
  });

  it('keeps the OIS nodes in curve_builds shape and strictly discounting', () => {
    let previousDf = 1;
    let previousT = 0;
    for (const node of result.outputs.nodes) {
      expect(isCurveNode(node)).toBe(true);
      expect(node.t).toBeGreaterThan(previousT);
      expect(node.df).toBeLessThan(previousDf);
      // The OIS curve quotes continuously, so a node's zero is −ln df / t.
      expect(Math.abs(node.zero - -Math.log(node.df) / node.t)).toBeLessThan(1e-14);
      previousT = node.t;
      previousDf = node.df;
    }
  });

  it('rejects a fixing set that cannot anchor the overnight node', () => {
    expect(() =>
      bootstrapOisCurve(
        { ...inputs, fixings: [{ date: '2026-09-16', rate: 4.33 }] },
        kase.valuationTs,
      ),
    ).toThrow(/no SOFR fixing dated on or before/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The golden file itself
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('fixtures/golden/analytics/curve/bootstrap.json', () => {
  it('has the §7.1 record shape and the §7.7 case ids', () => {
    expect(GOLDEN.map((c) => c.id)).toEqual([
      'curve.par.selfconsistency',
      'curve.flat.analytic',
      'curve.interpolation.monotone',
      'curve.bills.par',
      'curve.ois.bootstrap',
    ]);
    for (const kase of GOLDEN) {
      expect(['curve.bootstrap', 'curve.ois.bootstrap']).toContain(kase.engine);
      expect(kase.engineVersion).toBe('1.0.0');
      expect(kase.valuationTs).toBe('2026-09-15T20:00:00Z');
      expect(kase.source.length).toBeGreaterThan(40);
      for (const key of Object.keys(kase.tol)) {
        expect(Object.keys(kase.expected)).toContain(key);
      }
      expect(kase.inputs.curveDate).toBe('2026-09-15');
    }
  });

  it("carries §7.7's own par quote set verbatim", () => {
    const quotes = quotesOf(goldenCase('curve.par.selfconsistency'));
    expect(quotes).toEqual([
      { tenor: '1Y', parRate: 4.0 },
      { tenor: '2Y', parRate: 4.2 },
      { tenor: '3Y', parRate: 4.35 },
      { tenor: '5Y', parRate: 4.55 },
      { tenor: '7Y', parRate: 4.7 },
      { tenor: '10Y', parRate: 4.85 },
    ]);
    // §7.7's UST_PAR row: kind 'par', ACT/ACT, semiannual, log_linear_df.
    const inputs = goldenCase('curve.par.selfconsistency').inputs;
    expect(inputs.dayCount).toBe('ACT/ACT');
    expect(inputs.compounding).toBe('semiannual');
    expect(inputs.interpolation).toBe('log_linear_df');
    expect(inputs.curveId).toBe('UST_PAR');
  });
});
