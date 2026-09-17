/**
 * Street-convention bond price ↔ yield, accrued, clean and dirty price, and the yield solver
 * (ANAL-01, TESTING §7.3 and §7.5, ARCHITECTURE L160).
 *
 * ## The price formula
 *
 * With `f` coupons a year, a yield `y` quoted on that same `f`-per-year bond basis, and `w` the
 * part of the current coupon period still to run (in period units — 1 when settlement is on a
 * coupon date, → 0 the day before the next coupon):
 *
 * ```
 *   dirty = Σ  cashflowₖ × (1 + y/f)^−(w + k − 1)        k = 1 … n remaining flows
 *   clean = dirty − accrued
 * ```
 *
 * `w` comes from the schedule's day count (`ACT/ACT` ICMA for a Treasury), so an odd first or last
 * coupon discounts over its true quasi-period distance, not a nominal one. Settling on a coupon
 * date makes `w = 1`, the exponents the whole numbers 1 … n and accrued exactly 0 — which is the
 * configuration TESTING §7.3 pins, so the case isolates the discounting.
 *
 * `lastPeriodSimple` switches the final stub to money-market (simple) discounting, the street
 * convention for a bond inside its last coupon period. It is **off** by default: every pinned case
 * discounts compound throughout, and a convention that silently changes the formula near maturity
 * would make the golden files depend on the calendar distance to maturity.
 *
 * ## The solver (TESTING §7.5)
 *
 * Newton from a seed, with a bracket guard over `[−0.99, 10.0]` (−99 % to 1 000 %), falling back to
 * bisection whenever an iterate leaves the bracket, produces a non-finite price, or fails to reduce
 * `|f|`. When `f` has no sign change on the bracket the solver returns
 * `{ ok: false, reason: 'NO_ROOT_IN_BRACKET' }` — it never diverges, returns `NaN` or throws.
 * `method` records which path ran; that is what the tests assert on.
 */

import type { IsoDate } from '../../calendars/calendar.js';
import type { Conventions } from '../engine.js';
import { defineEngine } from '../engine.js';
import type { BondTerms, CouponFrequency } from './cashflows.js';
import {
  accrued as accruedInterest,
  bondConventions,
  periodFractionRemaining,
  remainingCashflows,
} from './cashflows.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Discounting kernel
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One remaining cashflow, with the distance it is discounted over. */
export interface DiscountedFlow {
  /** Unadjusted coupon/maturity date. */
  readonly date: IsoDate;
  /** Amount per face. */
  readonly amount: number;
  /** Distance from settlement in **coupon periods** — the exponent `w + k − 1`. */
  readonly periods: number;
  /** The same distance in years (`periods / frequency`), for durations and key-rate tenors. */
  readonly years: number;
}

/** Options that change the shape of the discounting. */
export interface PricingOptions {
  /**
   * Discount the **final** cashflow at simple interest when it is the only one left — the street
   * convention inside the last coupon period. Off by default; see the module note.
   */
  readonly lastPeriodSimple?: boolean;
}

/**
 * The remaining cashflows of `terms` at `settlement`, each carrying its discounting distance.
 * Yield-independent, so a solver or a finite-difference reprice builds it once.
 */
export function discountedFlows(terms: BondTerms, settlement: IsoDate): DiscountedFlow[] {
  const flows = remainingCashflows(terms, settlement);
  const w = periodFractionRemaining(terms, settlement);
  return flows.map((flow, k) => {
    const periods = w + k;
    return { date: flow.date, amount: flow.amount, periods, years: periods / terms.frequency };
  });
}

function base(y: number, frequency: number): number {
  return 1 + y / frequency;
}

/**
 * Present value of `flows` at yield `y` on an `frequency`-per-year bond basis. Returns `NaN` for a
 * yield at or below `−frequency` (a non-positive discount base), which the solver treats as a
 * failed step rather than a crash.
 */
export function presentValue(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
  options: PricingOptions = {},
): number {
  const b = base(y, frequency);
  if (!(b > 0) || !Number.isFinite(b)) return NaN;
  if (options.lastPeriodSimple && flows.length === 1) {
    const only = flows[0]!;
    const growth = 1 + (y / frequency) * only.periods;
    return growth > 0 ? only.amount / growth : NaN;
  }
  let pv = 0;
  for (const flow of flows) pv += flow.amount * Math.pow(b, -flow.periods);
  return pv;
}

/** `dP/dy` — the analytic first derivative of {@link presentValue} with respect to the yield. */
export function presentValueDerivative(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
  options: PricingOptions = {},
): number {
  const b = base(y, frequency);
  if (!(b > 0) || !Number.isFinite(b)) return NaN;
  if (options.lastPeriodSimple && flows.length === 1) {
    const only = flows[0]!;
    const growth = 1 + (y / frequency) * only.periods;
    return growth > 0 ? (-only.amount * (only.periods / frequency)) / (growth * growth) : NaN;
  }
  let d = 0;
  for (const flow of flows) {
    d += flow.amount * (-flow.periods / frequency) * Math.pow(b, -flow.periods - 1);
  }
  return d;
}

/** `d²P/dy²` — the analytic second derivative, the basis of convexity (TESTING §7.3). */
export function presentValueSecondDerivative(
  flows: readonly DiscountedFlow[],
  y: number,
  frequency: number,
  options: PricingOptions = {},
): number {
  const b = base(y, frequency);
  if (!(b > 0) || !Number.isFinite(b)) return NaN;
  if (options.lastPeriodSimple && flows.length === 1) {
    const only = flows[0]!;
    const growth = 1 + (y / frequency) * only.periods;
    const t = only.periods / frequency;
    return growth > 0 ? (2 * only.amount * t * t) / (growth * growth * growth) : NaN;
  }
  let d2 = 0;
  for (const flow of flows) {
    d2 +=
      flow.amount *
      ((flow.periods * (flow.periods + 1)) / (frequency * frequency)) *
      Math.pow(b, -flow.periods - 2);
  }
  return d2;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Price from yield
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Everything one pricing of one bond produces. */
export interface BondPricing {
  /** Quoted price per 100 face, ex accrued. */
  readonly cleanPrice: number;
  /** Invoice price per 100 face: clean + accrued. */
  readonly dirtyPrice: number;
  /** Accrued interest per 100 face at settlement. */
  readonly accrued: number;
  /** The yield the price was computed at (decimal fraction). */
  readonly yield: number;
  /** The same in percent — the unit a screen quotes. */
  readonly yieldPercent: number;
  readonly settlement: IsoDate;
  /** Cashflows still outstanding. */
  readonly periodsRemaining: number;
  /** `w`: the part of the current coupon period still to run, in period units. */
  readonly firstPeriodFraction: number;
  /** The coupon period settlement sits in. */
  readonly accrualStart: IsoDate;
  readonly accrualEnd: IsoDate;
  readonly conventions: Conventions;
}

/** Street-convention price from yield (TESTING §7.3). */
export function priceFromYield(
  terms: BondTerms,
  settlement: IsoDate,
  yieldValue: number,
  options: PricingOptions = {},
): BondPricing {
  if (!Number.isFinite(yieldValue)) {
    throw new RangeError(`bond.price: yield must be finite, got ${String(yieldValue)}`);
  }
  const flows = discountedFlows(terms, settlement);
  if (flows.length === 0) {
    throw new RangeError(`bond.price: no cashflows remain at settlement ${settlement}`);
  }
  const acc = accruedInterest(terms, settlement);
  const dirty = presentValue(flows, yieldValue, terms.frequency, options);
  const first = flows[0]!;
  return {
    cleanPrice: dirty - acc.accrued,
    dirtyPrice: dirty,
    accrued: acc.accrued,
    yield: yieldValue,
    yieldPercent: yieldValue * 100,
    settlement,
    periodsRemaining: flows.length,
    firstPeriodFraction: first.periods,
    accrualStart: acc.period.accrualStart,
    accrualEnd: acc.period.accrualEnd,
    conventions: bondConventions(terms),
  };
}

/** Clean price only — the shape a solver's objective wants. */
export function cleanPriceFromYield(
  terms: BondTerms,
  settlement: IsoDate,
  yieldValue: number,
  options: PricingOptions = {},
): number {
  return priceFromYield(terms, settlement, yieldValue, options).cleanPrice;
}

/** Dirty (invoice) price only. */
export function dirtyPriceFromYield(
  terms: BondTerms,
  settlement: IsoDate,
  yieldValue: number,
  options: PricingOptions = {},
): number {
  return priceFromYield(terms, settlement, yieldValue, options).dirtyPrice;
}

/** Accrued interest per 100 face at settlement (0 on a coupon date). */
export function accrued(terms: BondTerms, settlement: IsoDate): number {
  return accruedInterest(terms, settlement).accrued;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The yield solver (TESTING §7.5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Low end of the yield bracket: −99 %. */
export const YIELD_BRACKET_LOW = -0.99;

/** High end of the yield bracket: 1 000 %. */
export const YIELD_BRACKET_HIGH = 10.0;

/** Default Newton seed: 5 %, the middle of any plausible coupon. */
export const DEFAULT_YIELD_SEED = 0.05;

/** Which root-finding path produced a solution. */
export type SolverMethod = 'newton' | 'bisection';

/** Why a solve failed. */
export type SolverFailure = 'NO_ROOT_IN_BRACKET' | 'NOT_CONVERGED';

/** Knobs of {@link solveRoot}. All have defaults that match TESTING §7.5. */
export interface SolveOptions {
  /** Newton seed. */
  readonly y0?: number;
  /** Bracket, `[lo, hi]`. */
  readonly lo?: number;
  readonly hi?: number;
  /** Convergence criterion on the Newton step, and the bisection interval. */
  readonly yTol?: number;
  /** Bisection stops when the interval is this wide; tighter than `yTol` so `|f|` lands near zero. */
  readonly bisectionTol?: number;
  readonly maxNewtonIterations?: number;
  readonly maxBisectionIterations?: number;
  /** Analytic `f'`. Without it Newton uses a central difference with step `1e-7`. */
  readonly derivative?: (y: number) => number;
}

/** A converged solve. */
export interface SolveSuccess {
  readonly ok: true;
  readonly y: number;
  /** The path that produced `y`. */
  readonly method: SolverMethod;
  /** Iterations of the path that produced `y` (Newton steps, or bisection halvings). */
  readonly iterations: number;
  /** Newton steps taken before the guard fired, when it did. */
  readonly newtonIterations: number;
  /** `|Δy|` of the final accepted step. */
  readonly lastStep: number;
  /** `f(y)` at the answer. */
  readonly residual: number;
  /** The first Newton iterate from the seed — the number TESTING §7.5 pins at ≈ −1111.4. */
  readonly firstNewtonStep: number;
  /** Why Newton was abandoned, when it was. */
  readonly fallbackReason: string | null;
}

/** A solve that produced no root. */
export interface SolveFailureResult {
  readonly ok: false;
  readonly reason: SolverFailure;
  /** `f` at each end of the bracket, so a caller can see why there is no sign change. */
  readonly fLo: number;
  readonly fHi: number;
  readonly firstNewtonStep: number;
}

/** What {@link solveRoot} returns. */
export type SolveResult = SolveSuccess | SolveFailureResult;

const DEFAULT_Y_TOL = 1e-12;
const DEFAULT_BISECTION_TOL = 1e-14;
const DEFAULT_MAX_NEWTON = 50;
const DEFAULT_MAX_BISECTION = 60;
const FD_STEP = 1e-7;

/**
 * Newton with a bracket guard, falling back to bisection (TESTING §7.5).
 *
 * `f` must be continuous and monotone enough on `[lo, hi]` to bracket a root by sign change; for a
 * bond price that is guaranteed, since price is strictly decreasing in yield.
 */
export function solveRoot(f: (y: number) => number, options: SolveOptions = {}): SolveResult {
  const lo = options.lo ?? YIELD_BRACKET_LOW;
  const hi = options.hi ?? YIELD_BRACKET_HIGH;
  const yTol = options.yTol ?? DEFAULT_Y_TOL;
  const bisTol = options.bisectionTol ?? DEFAULT_BISECTION_TOL;
  const maxNewton = options.maxNewtonIterations ?? DEFAULT_MAX_NEWTON;
  const maxBisection = options.maxBisectionIterations ?? DEFAULT_MAX_BISECTION;
  const seed = options.y0 ?? DEFAULT_YIELD_SEED;
  const derivative =
    options.derivative ?? ((y: number) => (f(y + FD_STEP) - f(y - FD_STEP)) / (2 * FD_STEP));

  const fLo = f(lo);
  const fHi = f(hi);
  let firstNewtonStep = Number.NaN;

  // ── Newton ────────────────────────────────────────────────────────────────────────────────
  let y = seed;
  let fy = f(y);
  let newtonIterations = 0;
  let fallbackReason: string | null = null;

  if (!Number.isFinite(fy)) {
    fallbackReason = `f(${String(seed)}) is not finite`;
  } else if (fy === 0) {
    return {
      ok: true,
      y,
      method: 'newton',
      iterations: 0,
      newtonIterations: 0,
      lastStep: 0,
      residual: 0,
      firstNewtonStep: y,
      fallbackReason: null,
    };
  }

  while (fallbackReason === null && newtonIterations < maxNewton) {
    const slope = derivative(y);
    if (!Number.isFinite(slope) || slope === 0) {
      fallbackReason = `f'(${y.toPrecision(6)}) is zero or not finite`;
      break;
    }
    const next = y - fy / slope;
    newtonIterations += 1;
    if (newtonIterations === 1) firstNewtonStep = next;
    if (!Number.isFinite(next)) {
      fallbackReason = 'Newton iterate is not finite';
      break;
    }
    if (next < lo || next > hi) {
      fallbackReason = `Newton iterate ${next.toPrecision(8)} left the bracket [${String(lo)}, ${String(hi)}]`;
      break;
    }
    const step = Math.abs(next - y);
    const fNext = f(next);
    if (step <= yTol) {
      return {
        ok: true,
        y: next,
        method: 'newton',
        iterations: newtonIterations,
        newtonIterations,
        lastStep: step,
        residual: Number.isFinite(fNext) ? fNext : fy,
        firstNewtonStep,
        fallbackReason: null,
      };
    }
    if (!Number.isFinite(fNext)) {
      fallbackReason = 'Newton iterate produced a non-finite value';
      break;
    }
    if (Math.abs(fNext) >= Math.abs(fy)) {
      fallbackReason = `Newton failed to reduce |f| (${Math.abs(fNext).toExponential(3)} >= ${Math.abs(fy).toExponential(3)})`;
      break;
    }
    y = next;
    fy = fNext;
  }
  fallbackReason ??= `Newton did not converge in ${String(maxNewton)} iterations`;

  // ── Bisection fallback ────────────────────────────────────────────────────────────────────
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo === 0 || fHi === 0 || fLo * fHi > 0) {
    if (fLo === 0) {
      return {
        ok: true,
        y: lo,
        method: 'bisection',
        iterations: 0,
        newtonIterations,
        lastStep: 0,
        residual: 0,
        firstNewtonStep,
        fallbackReason,
      };
    }
    if (fHi === 0) {
      return {
        ok: true,
        y: hi,
        method: 'bisection',
        iterations: 0,
        newtonIterations,
        lastStep: 0,
        residual: 0,
        firstNewtonStep,
        fallbackReason,
      };
    }
    return { ok: false, reason: 'NO_ROOT_IN_BRACKET', fLo, fHi, firstNewtonStep };
  }

  let a = lo;
  let b = hi;
  let fa = fLo;
  let mid = (a + b) / 2;
  let fMid = Number.NaN;
  let iterations = 0;
  let width = Number.POSITIVE_INFINITY;
  while (iterations < maxBisection) {
    mid = (a + b) / 2;
    fMid = f(mid);
    iterations += 1;
    width = (b - a) / 2;
    if (fMid === 0 || width <= bisTol || mid === a || mid === b) break;
    if (Number.isFinite(fMid) && fa * fMid < 0) {
      b = mid;
    } else {
      a = mid;
      fa = fMid;
    }
  }
  if (!Number.isFinite(fMid)) {
    return { ok: false, reason: 'NOT_CONVERGED', fLo, fHi, firstNewtonStep };
  }
  return {
    ok: true,
    y: mid,
    method: 'bisection',
    iterations,
    newtonIterations,
    lastStep: width,
    residual: fMid,
    firstNewtonStep,
    fallbackReason,
  };
}

/** A solved yield, with everything the pinned assertions of TESTING §7.5 read. */
export interface YieldSolution {
  readonly ok: boolean;
  readonly reason: SolverFailure | null;
  /** Yield as a decimal fraction (`NaN` when `ok` is false). */
  readonly yield: number;
  /** The same in percent. */
  readonly yieldPercent: number;
  readonly method: SolverMethod | null;
  readonly iterations: number;
  readonly newtonIterations: number;
  readonly lastStep: number;
  /** `price(y) − target`, in price units. */
  readonly residual: number;
  /** The first Newton iterate from the seed (TESTING §7.5 pins ≈ −1111.4 for `y0 = 9.5`). */
  readonly firstNewtonStep: number;
  readonly fallbackReason: string | null;
  /** The clean price asked for. */
  readonly targetCleanPrice: number;
  readonly accrued: number;
  readonly dirtyPrice: number;
  readonly conventions: Conventions;
}

/**
 * Yield from a clean price (TESTING §7.3, §7.5). The objective is
 * `f(y) = cleanPrice(y) − target`, whose analytic derivative is the PV derivative — accrued does
 * not depend on the yield — so Newton needs no numerical differentiation.
 */
export function yieldFromPrice(
  terms: BondTerms,
  settlement: IsoDate,
  targetCleanPrice: number,
  options: SolveOptions & PricingOptions = {},
): YieldSolution {
  if (!Number.isFinite(targetCleanPrice)) {
    throw new RangeError(
      `bond.yield: target price must be finite, got ${String(targetCleanPrice)}`,
    );
  }
  const flows = discountedFlows(terms, settlement);
  if (flows.length === 0) {
    throw new RangeError(`bond.yield: no cashflows remain at settlement ${settlement}`);
  }
  const acc = accruedInterest(terms, settlement).accrued;
  const pricing: PricingOptions =
    options.lastPeriodSimple === undefined ? {} : { lastPeriodSimple: options.lastPeriodSimple };
  const f = (y: number): number =>
    presentValue(flows, y, terms.frequency, pricing) - acc - targetCleanPrice;
  const df = (y: number): number => presentValueDerivative(flows, y, terms.frequency, pricing);

  const solveOptions: SolveOptions = { ...options, derivative: options.derivative ?? df };
  const result = solveRoot(f, solveOptions);
  const conventions = bondConventions(terms);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      yield: Number.NaN,
      yieldPercent: Number.NaN,
      method: null,
      iterations: 0,
      newtonIterations: 0,
      lastStep: Number.NaN,
      residual: Number.NaN,
      firstNewtonStep: result.firstNewtonStep,
      fallbackReason: null,
      targetCleanPrice,
      accrued: acc,
      dirtyPrice: targetCleanPrice + acc,
      conventions,
    };
  }
  return {
    ok: true,
    reason: null,
    yield: result.y,
    yieldPercent: result.y * 100,
    method: result.method,
    iterations: result.iterations,
    newtonIterations: result.newtonIterations,
    lastStep: result.lastStep,
    residual: result.residual,
    firstNewtonStep: result.firstNewtonStep,
    fallbackReason: result.fallbackReason,
    targetCleanPrice,
    accrued: acc,
    dirtyPrice: targetCleanPrice + acc,
    conventions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engines (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The declared input set of the bond engines: the `govt_terms` row in engine units, the settlement
 * date, and one of a yield (`bond.price`) or a clean price (`bond.yield`).
 */
export type BondEngineInputs = {
  readonly face?: number;
  readonly redemption?: number;
  /** Annual coupon rate as a decimal fraction. */
  readonly couponRate: number;
  readonly frequency: CouponFrequency;
  readonly datedDate: IsoDate;
  readonly maturity: IsoDate;
  readonly firstCouponDate?: IsoDate;
  readonly penultimateCouponDate?: IsoDate;
  readonly dayCount?: BondTerms['dayCount'];
  readonly businessDayConvention?: BondTerms['businessDayConvention'];
  readonly endOfMonthRule?: boolean;
  readonly settlement: IsoDate;
  /** `bond.price` only: the yield to price at, as a decimal fraction. */
  readonly yield?: number;
  /** `bond.yield` only: the clean price to solve from. */
  readonly cleanPrice?: number;
  /** `bond.yield` only: the Newton seed. */
  readonly y0?: number;
  readonly lastPeriodSimple?: boolean;
};

/**
 * Rebuild {@link BondTerms} from an engine input record. A `Calendar` is not a JSON value, so the
 * engines price on unadjusted dates (Treasury accrual is unadjusted anyway); a caller that needs
 * rolled payment dates uses {@link priceFromYield} directly with `terms.calendar` set.
 */
export function termsFromInputs(i: BondEngineInputs): BondTerms {
  return {
    couponRate: i.couponRate,
    frequency: i.frequency,
    datedDate: i.datedDate,
    maturity: i.maturity,
    ...(i.face === undefined ? {} : { face: i.face }),
    ...(i.redemption === undefined ? {} : { redemption: i.redemption }),
    ...(i.firstCouponDate === undefined ? {} : { firstCouponDate: i.firstCouponDate }),
    ...(i.penultimateCouponDate === undefined
      ? {}
      : { penultimateCouponDate: i.penultimateCouponDate }),
    ...(i.dayCount === undefined ? {} : { dayCount: i.dayCount }),
    ...(i.businessDayConvention === undefined
      ? {}
      : { businessDayConvention: i.businessDayConvention }),
    ...(i.endOfMonthRule === undefined ? {} : { endOfMonthRule: i.endOfMonthRule }),
  };
}

function pricingOptionsFromInputs(i: BondEngineInputs): PricingOptions {
  return i.lastPeriodSimple === undefined ? {} : { lastPeriodSimple: i.lastPeriodSimple };
}

/** `bond.price@1.0.0` — clean and dirty price, and accrued, from a yield. */
export const bondPriceEngine = defineEngine<BondEngineInputs, BondPricing>(
  'bond.price',
  '1.0.0',
  (i) => {
    if (i.yield === undefined) {
      throw new RangeError("bond.price: input 'yield' is required");
    }
    return priceFromYield(termsFromInputs(i), i.settlement, i.yield, pricingOptionsFromInputs(i));
  },
);

/** `bond.yield@1.0.0` — the street yield of a clean price, and the solver path that found it. */
export const bondYieldEngine = defineEngine<BondEngineInputs, YieldSolution>(
  'bond.yield',
  '1.0.0',
  (i) => {
    if (i.cleanPrice === undefined) {
      throw new RangeError("bond.yield: input 'cleanPrice' is required");
    }
    const options: SolveOptions & PricingOptions = {
      ...(i.y0 === undefined ? {} : { y0: i.y0 }),
      ...pricingOptionsFromInputs(i),
    };
    return yieldFromPrice(termsFromInputs(i), i.settlement, i.cleanPrice, options);
  },
);
