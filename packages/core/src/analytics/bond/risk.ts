/**
 * Bond risk: Macaulay and modified duration, convexity, DV01 and key-rate durations
 * (ANAL-01, TESTING §7.3, ARCHITECTURE L161).
 *
 * Everything is analytic — differentiated, not bumped — so the finite-difference reprices in
 * `bond.risk.test.ts` are an independent check rather than a restatement of the same arithmetic.
 * With `b = 1 + y/f`, `tⱼ` the time to flow `j` in years and `nⱼ = f·tⱼ` in periods:
 *
 * ```
 *   P       = Σ aⱼ b^−nⱼ                               (dirty price)
 *   Macaulay= Σ tⱼ aⱼ b^−nⱼ / P                        (years)
 *   Modified= Macaulay / b                             (TESTING §7.3: 1.927236 / 1.03 = 1.871103)
 *   dP/dy   = −Σ tⱼ aⱼ b^−nⱼ⁻¹  = −Modified × P
 *   DV01    = Modified × P × 1e−4                      (price change per basis point)
 *   Convexity = (d²P/dy²)/P = Σ tⱼ(tⱼ + 1/f) aⱼ b^−nⱼ⁻² / P
 * ```
 *
 * Both derivatives are taken with respect to the **annual yield quoted on the bond's own
 * compounding basis** (semiannual for a Treasury) — the convention TESTING §7.3 pins:
 * `convexity = 4.484914` for the 2-year 5 % discount bond at 6 %.
 *
 * **Key-rate durations** (ANAL-01) shift one node of a piecewise-linear "tent" over the key tenors
 * and measure the price response. Because the tent weights of all nodes sum to 1 at *every*
 * cashflow time, a simultaneous shift of every node is a parallel shift, so
 * `Σᵢ KRDᵢ = modified duration` — exactly, not to within a finite-difference truncation error,
 * because each KRD is computed analytically. That is the TESTING §7.3 assertion at `1e-9`.
 */

import type { IsoDate } from '../../calendars/calendar.js';
import type { Conventions } from '../engine.js';
import { defineEngine } from '../engine.js';
import type { BondTerms } from './cashflows.js';
import { accrued as accruedInterest, bondConventions } from './cashflows.js';
import type { BondEngineInputs, DiscountedFlow, PricingOptions } from './price.js';
import {
  discountedFlows,
  presentValue,
  presentValueDerivative,
  presentValueSecondDerivative,
  termsFromInputs,
} from './price.js';

/** The key-rate grid a Treasury desk quotes: the constant-maturity nodes of the par curve. */
export const DEFAULT_KEY_RATE_TENORS: readonly number[] = Object.freeze([
  0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30,
]);

/** One basis point, the unit DV01 and the key-rate bumps are quoted in. */
export const ONE_BASIS_POINT = 1e-4;

/** A key-rate duration: the node it belongs to, and the duration attributed to it. */
export interface KeyRateDuration {
  /** Node tenor in years. */
  readonly tenor: number;
  /** Duration contribution, in years — the same unit as modified duration. */
  readonly duration: number;
  /** Price change per basis point of a shift at this node alone, per 100 face. */
  readonly dv01: number;
}

/** Every risk number of one bond at one yield. */
export interface BondRisk {
  readonly cleanPrice: number;
  readonly dirtyPrice: number;
  readonly accrued: number;
  readonly yield: number;
  /** Years, on the bond's own compounding basis. */
  readonly macaulayDuration: number;
  /** `macaulayDuration / (1 + y/f)`. */
  readonly modifiedDuration: number;
  /** `(d²P/dy²)/P`, w.r.t. the annual yield on the bond's compounding basis. */
  readonly convexity: number;
  /** Price change per 100 face per basis point: `modified × dirty × 1e−4`. */
  readonly dv01: number;
  /** DV01 per million of face. */
  readonly dv01PerMillion: number;
  /** The analytic key-rate durations, one per node. */
  readonly keyRateDurations: readonly KeyRateDuration[];
  /** `Σ keyRateDurations` — equals {@link modifiedDuration} (TESTING §7.3). */
  readonly keyRateDurationSum: number;
  readonly conventions: Conventions;
}

function sortedTenors(tenors: readonly number[]): number[] {
  const unique = [...new Set(tenors)].sort((a, b) => a - b);
  if (unique.length === 0) throw new RangeError('bond.risk: at least one key-rate tenor is needed');
  for (const t of unique) {
    if (!Number.isFinite(t) || t <= 0) {
      throw new RangeError(`bond.risk: key-rate tenor must be positive, got ${String(t)}`);
    }
  }
  return unique;
}

/**
 * Piecewise-linear "tent" weights of the key-rate nodes at time `t`. Flat before the first node and
 * after the last, so the weights always sum to exactly 1 — the property that makes the key-rate
 * durations add up to the modified duration.
 */
export function keyRateWeights(t: number, tenors: readonly number[]): number[] {
  const nodes = sortedTenors(tenors);
  const weights = nodes.map(() => 0);
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  if (nodes.length === 1 || t <= first) {
    weights[0] = 1;
    return weights;
  }
  if (t >= last) {
    weights[nodes.length - 1] = 1;
    return weights;
  }
  for (let i = 0; i + 1 < nodes.length; i++) {
    const lo = nodes[i]!;
    const hi = nodes[i + 1]!;
    if (t >= lo && t <= hi) {
      const upper = (t - lo) / (hi - lo);
      weights[i] = 1 - upper;
      weights[i + 1] = upper;
      return weights;
    }
  }
  /* c8 ignore next 2 */
  throw new RangeError(`bond.risk: no key-rate bucket contains t = ${String(t)}`);
}

/** Macaulay duration in years from the discounted flows. */
export function macaulayDuration(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
): number {
  const b = 1 + y / frequency;
  let pv = 0;
  let weighted = 0;
  for (const flow of flows) {
    const df = Math.pow(b, -flow.periods);
    pv += flow.amount * df;
    weighted += flow.years * flow.amount * df;
  }
  return weighted / pv;
}

/** Modified duration: Macaulay discounted one period. */
export function modifiedDuration(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
): number {
  return macaulayDuration(flows, y, frequency) / (1 + y / frequency);
}

/** Convexity: the second derivative of price w.r.t. yield, divided by price. */
export function convexity(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
  options: PricingOptions = {},
): number {
  const pv = presentValue(flows, y, frequency, options);
  return presentValueSecondDerivative(flows, y, frequency, options) / pv;
}

/**
 * DV01 per 100 face: the price fall for a one-basis-point rise in yield, `−dP/dy × 1e−4`. Positive
 * for a conventional bond.
 */
export function dv01(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
  options: PricingOptions = {},
): number {
  return -presentValueDerivative(flows, y, frequency, options) * ONE_BASIS_POINT;
}

/**
 * Analytic key-rate durations. Node `i` contributes
 * `(1/P) Σⱼ wᵢ(tⱼ) tⱼ aⱼ b^−nⱼ⁻¹`, the part of the price sensitivity the tent at node `i` claims.
 */
export function keyRateDurations(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
  tenors: readonly number[] = DEFAULT_KEY_RATE_TENORS,
): KeyRateDuration[] {
  const nodes = sortedTenors(tenors);
  const b = 1 + y / frequency;
  let pv = 0;
  const sens = nodes.map(() => 0);
  for (const flow of flows) {
    pv += flow.amount * Math.pow(b, -flow.periods);
    const contribution = flow.years * flow.amount * Math.pow(b, -flow.periods - 1);
    const weights = keyRateWeights(flow.years, nodes);
    for (let i = 0; i < nodes.length; i++) {
      sens[i] = sens[i]! + weights[i]! * contribution;
    }
  }
  return nodes.map((tenor, i) => {
    const duration = sens[i]! / pv;
    return { tenor, duration, dv01: duration * pv * ONE_BASIS_POINT };
  });
}

/**
 * Key-rate durations by **finite difference**: shift node `i` by `±bump` with the tent weights,
 * reprice, and take the central difference. Exported so a test can check the analytic numbers
 * against an independent method (TESTING §7.3); the analytic form is what the engine reports.
 */
export function keyRateDurationsFiniteDifference(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
  tenors: readonly number[] = DEFAULT_KEY_RATE_TENORS,
  bump: number = ONE_BASIS_POINT,
): KeyRateDuration[] {
  const nodes = sortedTenors(tenors);
  const priceWithShift = (node: number, delta: number): number => {
    let pv = 0;
    for (const flow of flows) {
      const w = keyRateWeights(flow.years, nodes)[node]!;
      const shifted = y + delta * w;
      pv += flow.amount * Math.pow(1 + shifted / frequency, -flow.periods);
    }
    return pv;
  };
  const base = presentValue(flows, y, frequency);
  return nodes.map((tenor, i) => {
    const up = priceWithShift(i, bump);
    const down = priceWithShift(i, -bump);
    const duration = (down - up) / (2 * bump * base);
    return { tenor, duration, dv01: duration * base * ONE_BASIS_POINT };
  });
}

/** Every risk number of `terms` at `settlement` and yield `y`. */
export function bondRisk(
  terms: BondTerms,
  settlement: IsoDate,
  yieldValue: number,
  tenors: readonly number[] = DEFAULT_KEY_RATE_TENORS,
  options: PricingOptions = {},
): BondRisk {
  if (!Number.isFinite(yieldValue)) {
    throw new RangeError(`bond.risk: yield must be finite, got ${String(yieldValue)}`);
  }
  const flows = discountedFlows(terms, settlement);
  if (flows.length === 0) {
    throw new RangeError(`bond.risk: no cashflows remain at settlement ${settlement}`);
  }
  const acc = accruedInterest(terms, settlement).accrued;
  const dirty = presentValue(flows, yieldValue, terms.frequency, options);
  const macaulay = macaulayDuration(flows, yieldValue, terms.frequency);
  const modified = macaulay / (1 + yieldValue / terms.frequency);
  const krd = keyRateDurations(flows, yieldValue, terms.frequency, tenors);
  const dollarDuration = modified * dirty * ONE_BASIS_POINT;
  return {
    cleanPrice: dirty - acc,
    dirtyPrice: dirty,
    accrued: acc,
    yield: yieldValue,
    macaulayDuration: macaulay,
    modifiedDuration: modified,
    convexity: convexity(flows, yieldValue, terms.frequency, options),
    dv01: dollarDuration,
    dv01PerMillion: dollarDuration * 10_000,
    keyRateDurations: krd,
    keyRateDurationSum: krd.reduce((sum, k) => sum + k.duration, 0),
    conventions: bondConventions(terms),
  };
}

/** The `bond.risk` engine's declared input set: the bond, its settlement, its yield, the nodes. */
export type BondRiskInputs = BondEngineInputs & {
  /** Key-rate nodes in years. Defaults to {@link DEFAULT_KEY_RATE_TENORS}. */
  readonly keyRateTenors?: readonly number[];
};

/** `bond.risk@1.0.0` — duration, convexity, DV01 and key-rate durations (ANAL-01). */
export const bondRiskEngine = defineEngine<BondRiskInputs, BondRisk>('bond.risk', '1.0.0', (i) => {
  if (i.yield === undefined) {
    throw new RangeError("bond.risk: input 'yield' is required");
  }
  return bondRisk(
    termsFromInputs(i),
    i.settlement,
    i.yield,
    i.keyRateTenors ?? DEFAULT_KEY_RATE_TENORS,
    i.lastPeriodSimple === undefined ? {} : { lastPeriodSimple: i.lastPeriodSimple },
  );
});
