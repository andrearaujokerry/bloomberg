/**
 * Treasury bills (ANAL-01, TESTING §7.6) — discount rate ↔ price ↔ investment (coupon-equivalent)
 * yield, with **both** branches of the investment-yield definition.
 *
 * A bill has no coupon. It is quoted on a **bank discount** basis over ACT/360 against face:
 *
 * ```
 *   P = F × (1 − d × t/360)            d = discount rate, t = days to maturity
 *   d = (F − P)/F × 360/t              the exact inverse
 * ```
 *
 * The **investment rate** (Treasury's "coupon equivalent", the number printed next to a bill on the
 * daily bill sheet) restates that return on a 365-day, price-based basis so it is comparable with a
 * note yield. Its definition changes at **182 days** — half of a 365-day year — because a bill
 * longer than half a year has to be compared with a *coupon-paying* security that would have made
 * an interest payment in the meantime:
 *
 * - `t ≤ 182` — simple interest on price, ACT/365:
 *
 *   ```
 *     i = (F − P)/P × 365/t
 *   ```
 *
 * - `t > 182` — the bill is compounded semiannually for the first half-year and simple thereafter,
 *   which is the identity the coupon-equivalent yield `i` must satisfy (with `D = t/365`):
 *
 *   ```
 *     F = P × (1 + i/2) × (1 + i × (D − 1/2))
 *   ```
 *
 *   Expanded, that is a quadratic in `i`:
 *
 *   ```
 *     ((D − 1/2)/2) i² + D i + (1 − F/P) = 0
 *   ```
 *
 *   whose positive root is the published closed form (TreasuryDirect, *Formulas for Calculating
 *   Treasury Bill Yields*):
 *
 *   ```
 *            −2D + 2 √( D² − (2D − 1)(1 − F/P) )
 *     i  =  ─────────────────────────────────────
 *                        2D − 1
 *   ```
 *
 * `daysInYear` is 365 for a bill whose term does not contain a 29 February and 366 for one that
 * does; it defaults to 365, which is what every case in TESTING §7.6 uses. Passing 366 substitutes
 * it for 365 everywhere above (`D = t/366`, the simple branch divides by 366), exactly as the
 * Treasury formula sheet prescribes.
 *
 * Nothing here reads a clock: `daysToMaturity` is a parameter (`Date` is banned in this package).
 */

import type { Conventions } from './engine.js';
import { defineEngine } from './engine.js';

/**
 * The branch point of the investment-yield definition, in days, on the default 365-day basis: at or
 * below it the simple formula applies, above it the quadratic one (TESTING §7.6).
 *
 * The true branch point is the basis half-year, `basis / 2` — that is where the quadratic's leading
 * coefficient `(D − ½)/2` vanishes and its closed-form root divides by `2D − 1 = 0`. On the 365-day
 * basis `basis / 2 = 182.5`, so the integer branch point is 182 and this constant states it; on the
 * 366-day basis it is 183, and a 183-day bill stays on the simple branch. Use
 * {@link investmentYieldBranchDays} to get the branch point for a given basis.
 */
export const BILL_INVESTMENT_YIELD_BRANCH_DAYS = 182;

/** Days in the discount-basis year. Bills are quoted ACT/360 against face. */
export const BILL_DISCOUNT_BASIS_DAYS = 360;

/** Default days in the investment-yield year; 366 when the bill's term spans a 29 February. */
export const BILL_INVESTMENT_BASIS_DAYS = 365;

/** Which branch of the investment-yield definition produced a number. */
export type BillYieldBranch = 'simple' | 'quadratic';

/** The conventions every output of this module is computed on (ANAL-07). */
export const BILL_CONVENTIONS: Conventions = Object.freeze({
  dayCount: 'ACT/360',
  compounding: 'simple',
  settlementDays: 1,
  currency: 'USD',
  calendar: 'SIFMA',
  businessDayConvention: 'following',
  discountBasisDays: BILL_DISCOUNT_BASIS_DAYS,
  investmentBasisDays: BILL_INVESTMENT_BASIS_DAYS,
  investmentYieldBranchDays: BILL_INVESTMENT_YIELD_BRANCH_DAYS,
});

/** Shared shape of the price/discount/yield helpers. */
export interface BillSpec {
  /** Face (par) value. 100 for a price per 100 face. */
  readonly face: number;
  /** Calendar days from settlement to maturity. Must be > 0. */
  readonly daysToMaturity: number;
  /** Days in the investment-yield year: 365, or 366 when the term spans a 29 February. */
  readonly daysInYear?: number;
}

/**
 * The bill engine's declared input set. A type alias, not an interface: `defineEngine`'s
 * `I extends EngineInputs` constraint needs the implicit index signature only an alias gets.
 */
export type BillInputs = {
  /** Face (par) value; 100 unless stated. */
  readonly face?: number;
  /** Calendar days from settlement to maturity. */
  readonly daysToMaturity: number;
  /** Bank-discount rate as a decimal fraction: 0.04 for 4.000 %. */
  readonly discountRate: number;
  /** Days in the investment-yield year: 365 (default) or 366. */
  readonly daysInYear?: number;
};

/** Every quoted measure of one bill. */
export interface BillOutputs {
  readonly face: number;
  readonly daysToMaturity: number;
  readonly daysInYear: number;
  /** Bank-discount rate, decimal fraction. */
  readonly discountRate: number;
  /** The same in percent — the unit the Treasury bill sheet and TESTING §7.6 quote. */
  readonly discountRatePercent: number;
  /** Price per `face`. */
  readonly price: number;
  /** `face − price`, the dollar discount. */
  readonly discount: number;
  /** Coupon-equivalent (investment) yield, decimal fraction. */
  readonly investmentYield: number;
  /** The same in percent (TESTING §7.6 pins 4.096981 % on the 91-day 4 % bill). */
  readonly investmentYieldPercent: number;
  /** Which branch of the definition produced {@link investmentYield}. */
  readonly branch: BillYieldBranch;
  /** Simple yield on an ACT/360 money-market basis: `(F − P)/P × 360/t`. */
  readonly moneyMarketYield: number;
  /** `investmentYield − discountRate`, always positive for a positive discount rate. */
  readonly yieldPickup: number;
  readonly conventions: Conventions;
}

function requirePositiveTerm(daysToMaturity: number): void {
  if (!Number.isFinite(daysToMaturity) || daysToMaturity <= 0) {
    throw new RangeError(
      `bill: daysToMaturity must be a positive number of days, got ${String(daysToMaturity)}`,
    );
  }
}

function requirePositiveFace(face: number): void {
  if (!Number.isFinite(face) || face <= 0) {
    throw new RangeError(`bill: face must be positive, got ${String(face)}`);
  }
}

function requirePositivePrice(price: number): void {
  if (!Number.isFinite(price) || price <= 0) {
    throw new RangeError(`bill: price must be positive, got ${String(price)}`);
  }
}

function basisDays(daysInYear: number | undefined): number {
  const basis = daysInYear ?? BILL_INVESTMENT_BASIS_DAYS;
  if (basis !== 365 && basis !== 366) {
    throw new RangeError(`bill: daysInYear must be 365 or 366, got ${String(basis)}`);
  }
  return basis;
}

/**
 * Price from the bank-discount rate: `P = F × (1 − d × t/360)` (TESTING §7.6:
 * `100 × (1 − 0.04 × 91/360) = 98.98888889`).
 */
export function priceFromDiscount(spec: BillSpec & { readonly discountRate: number }): number {
  requirePositiveFace(spec.face);
  requirePositiveTerm(spec.daysToMaturity);
  if (!Number.isFinite(spec.discountRate)) {
    throw new RangeError(`bill: discountRate must be finite, got ${String(spec.discountRate)}`);
  }
  const price =
    spec.face * (1 - (spec.discountRate * spec.daysToMaturity) / BILL_DISCOUNT_BASIS_DAYS);
  if (price <= 0) {
    throw new RangeError(
      `bill: discount rate ${String(spec.discountRate)} over ${String(spec.daysToMaturity)} days ` +
        'prices the bill at or below zero',
    );
  }
  return price;
}

/** The exact inverse of {@link priceFromDiscount}: `d = (F − P)/F × 360/t`. */
export function discountFromPrice(spec: BillSpec & { readonly price: number }): number {
  requirePositiveFace(spec.face);
  requirePositivePrice(spec.price);
  requirePositiveTerm(spec.daysToMaturity);
  return ((spec.face - spec.price) / spec.face) * (BILL_DISCOUNT_BASIS_DAYS / spec.daysToMaturity);
}

/**
 * The branch point in days for a given investment-yield basis: `basis / 2`, the term at which the
 * quadratic degenerates. 182.5 on the 365-day basis, 183 on the 366-day one.
 */
export function investmentYieldBranchDays(daysInYear?: number): number {
  return basisDays(daysInYear) / 2;
}

/**
 * Which branch {@link investmentYieldFromPrice} takes for a term of `daysToMaturity` days on the
 * given basis. The comparison is against the basis half-year rather than a fixed 182 so that a
 * 183-day bill whose term spans a 29 February (`daysInYear = 366`, branch point 183) stays on the
 * simple branch instead of hitting the quadratic's singularity at `2D − 1 = 0`.
 *
 * The two branches meet there: at `t = basis / 2` the quadratic loses its `i²` term and reduces to
 * `D i + (1 − F/P) = 0`, whose root `i = (F − P)/P × basis/t` is exactly the simple branch.
 * On the default 365-day basis the branch point is 182.5, so 182 is simple and 183 quadratic —
 * unchanged from TESTING §7.6.
 */
export function investmentYieldBranch(
  daysToMaturity: number,
  daysInYear?: number,
): BillYieldBranch {
  requirePositiveTerm(daysToMaturity);
  return daysToMaturity <= investmentYieldBranchDays(daysInYear) ? 'simple' : 'quadratic';
}

/**
 * The ≤ 182-day branch: simple interest on price over a 365-day year,
 * `i = (F − P)/P × 365/t` (TESTING §7.6: 4.096981 % on the 91-day 4 % bill).
 */
export function investmentYieldSimple(spec: BillSpec & { readonly price: number }): number {
  requirePositiveFace(spec.face);
  requirePositivePrice(spec.price);
  requirePositiveTerm(spec.daysToMaturity);
  const basis = basisDays(spec.daysInYear);
  return ((spec.face - spec.price) / spec.price) * (basis / spec.daysToMaturity);
}

/**
 * The above-half-year branch (`t > basis/2`: 182 days on the 365-day basis, 183 on the 366-day one):
 * the positive root of
 * `((D − ½)/2) i² + D i + (1 − F/P) = 0`, `D = t/basis` — the coupon-equivalent yield that makes
 * `P × (1 + i/2) × (1 + i (D − ½)) = F`.
 *
 * Computed from the published closed form. The discriminant is `D² − (2D − 1)(1 − F/P)`; for a bill
 * (`P < F`, so `1 − F/P < 0`) and `t > basis/2` (so `2D − 1 > 0`) it is strictly larger than `D²` and
 * the square root is always real.
 */
export function investmentYieldQuadratic(spec: BillSpec & { readonly price: number }): number {
  requirePositiveFace(spec.face);
  requirePositivePrice(spec.price);
  requirePositiveTerm(spec.daysToMaturity);
  const basis = basisDays(spec.daysInYear);
  const d = spec.daysToMaturity / basis;
  const twoDMinus1 = 2 * d - 1;
  if (twoDMinus1 <= 0) {
    throw new RangeError(
      `bill: the quadratic investment-yield branch needs t > ${String(basis / 2)} days, got ` +
        `${String(spec.daysToMaturity)}`,
    );
  }
  const c = 1 - spec.face / spec.price;
  const disc = d * d - twoDMinus1 * c;
  if (disc < 0) {
    throw new RangeError('bill: investment-yield discriminant is negative — price out of range');
  }
  return (-2 * d + 2 * Math.sqrt(disc)) / twoDMinus1;
}

/**
 * Coupon-equivalent (investment) yield from price, taking the branch the term calls for
 * (TESTING §7.6). This is the single entry point callers should use; the two branch functions are
 * exported so a test can assert the branch point itself.
 */
export function investmentYieldFromPrice(spec: BillSpec & { readonly price: number }): number {
  return investmentYieldBranch(spec.daysToMaturity, spec.daysInYear) === 'simple'
    ? investmentYieldSimple(spec)
    : investmentYieldQuadratic(spec);
}

/**
 * The inverse of {@link investmentYieldFromPrice}: the price a coupon-equivalent yield implies.
 * Closed form on both branches —
 * `P = F / (1 + i t/basis)` at or below `basis/2` days and `P = F / ((1 + i/2)(1 + i(D − ½)))`
 * above it —
 * so a test can invert the quadratic branch without a solver.
 */
export function priceFromInvestmentYield(
  spec: BillSpec & { readonly investmentYield: number },
): number {
  requirePositiveFace(spec.face);
  requirePositiveTerm(spec.daysToMaturity);
  const basis = basisDays(spec.daysInYear);
  const d = spec.daysToMaturity / basis;
  const i = spec.investmentYield;
  if (!Number.isFinite(i)) {
    throw new RangeError(`bill: investmentYield must be finite, got ${String(i)}`);
  }
  const growth =
    investmentYieldBranch(spec.daysToMaturity, spec.daysInYear) === 'simple'
      ? 1 + i * d
      : (1 + i / 2) * (1 + i * (d - 0.5));
  if (growth <= 0) {
    throw new RangeError(`bill: investmentYield ${String(i)} implies a non-positive price`);
  }
  return spec.face / growth;
}

/** Money-market (ACT/360 simple) yield on price: `(F − P)/P × 360/t`. */
export function moneyMarketYield(spec: BillSpec & { readonly price: number }): number {
  requirePositiveFace(spec.face);
  requirePositivePrice(spec.price);
  requirePositiveTerm(spec.daysToMaturity);
  return ((spec.face - spec.price) / spec.price) * (BILL_DISCOUNT_BASIS_DAYS / spec.daysToMaturity);
}

/** Every measure of one bill, from its discount rate. */
export function bill(inputs: BillInputs): BillOutputs {
  const face = inputs.face ?? 100;
  const daysInYear = basisDays(inputs.daysInYear);
  const { daysToMaturity, discountRate } = inputs;
  const price = priceFromDiscount({ face, daysToMaturity, discountRate });
  const spec = { face, daysToMaturity, daysInYear, price };
  const yld = investmentYieldFromPrice(spec);
  return {
    face,
    daysToMaturity,
    daysInYear,
    discountRate,
    discountRatePercent: discountRate * 100,
    price,
    discount: face - price,
    investmentYield: yld,
    investmentYieldPercent: yld * 100,
    branch: investmentYieldBranch(daysToMaturity, daysInYear),
    moneyMarketYield: moneyMarketYield(spec),
    yieldPickup: yld - discountRate,
    conventions: BILL_CONVENTIONS,
  };
}

/** `bill@1.0.0` — the engine wrapper (ANAL-08). */
export const billEngine = defineEngine<BillInputs, BillOutputs>('bill', '1.0.0', (i) =>
  bill({
    daysToMaturity: i.daysToMaturity,
    discountRate: i.discountRate,
    ...(i.face === undefined ? {} : { face: i.face }),
    ...(i.daysInYear === undefined ? {} : { daysInYear: i.daysInYear }),
  }),
);
