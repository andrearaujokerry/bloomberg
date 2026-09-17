/**
 * Black-Scholes-Merton with a continuous dividend yield, Black-76 for futures/forwards, the full
 * greek set, and implied volatility by Brent with a Newton accelerator — WORKPLAN §WP-02 L509,
 * ARCHITECTURE L168, ANAL-03. The pinned case set is TESTING §7.2.
 *
 * Everything here is a closed form over doubles, so the only error is double-precision rounding and
 * the golden tolerances are `1e-6`…`1e-12` (TESTING §7.1). Two design rules make that hold:
 *
 *  - **The normal CDF is Cody's rational Chebyshev `erf`/`erfc`** (W. J. Cody, *Rational Chebyshev
 *    approximation for the error function*, Math. Comp. 23 (1969); the SPECFUN `CALERF` constants).
 *    It is accurate to ~4e-16 relative over the whole line, which is what lets TESTING §7.2 pin
 *    `N(d1) = 0.6368306512` and `N(d2) = 0.5596176923` at ten decimals. A cheap Abramowitz-Stegun
 *    5-term polynomial (≈7.5e-8) would miss those pins by three orders of magnitude, and the
 *    `1e-12` pin on `d1`/`d2` would be the only thing still passing.
 *  - **Nothing is rounded here.** `bsm()` returns the unrounded double; the caller (the field
 *    formatter, the payload writer) rounds. TESTING §7.2 assertion 7 is the reason this matters:
 *    the exact call is `10.4505835722`, and feeding the *rounded* `10.450584` back into
 *    `impliedVol` returns `0.2000000114` — vega is 37.524 per unit of vol, so 4.3e-7 of price
 *    rounding is 1.1e-8 of vol, and a `1e-8` round-trip tolerance on the rounded literal is
 *    unsatisfiable by a correct implementation.
 *
 * Degenerate inputs are answered, not thrown: `sigma = 0` and `T = 0` both collapse to the
 * deterministic forward, and `T = 0` returns the payoff with every greek zero except a delta in
 * `{0, 1}` (TESTING §7.2 cases `bsm.zero.vol` and `bsm.expiry`). No branch can produce a NaN.
 *
 * Sign and unit conventions, echoed in `BSM_CONVENTIONS` and asserted by the tests:
 *
 *  - `r` and `q` are continuously compounded annual rates; `T` is in years on ACT/365F;
 *  - `vega` is per 1.00 of sigma (per *vol point* is `vega / 100`);
 *  - `theta` is per year and negative for a long ATM option (per calendar day is `theta / 365`);
 *  - `rho` is per 1.00 of r (per 100 bp is `rho / 100`).
 */

import type { Conventions } from '../engine.js';
import { defineEngine } from '../engine.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Normal distribution — Cody's erf/erfc
// ─────────────────────────────────────────────────────────────────────────────────────────────

// The SPECFUN CALERF coefficient blocks, written out as named constants rather than arrays:
// `noUncheckedIndexedAccess` makes every `A[i]` a `number | undefined`, and a Horner loop over
// `?? 0` in the hot path of every option price is neither faster nor clearer than this.
const A0 = 3.1611237438705655;
const A1 = 113.86415415105016;
const A2 = 377.485237685302;
const A3 = 3209.3775891384694;
const A4 = 0.18577770618460315;

const B0 = 23.601290952344122;
const B1 = 244.02463793444417;
const B2 = 1282.6165260773723;
const B3 = 2844.236833439171;

const C0 = 0.5641884969886701;
const C1 = 8.883149794388377;
const C2 = 66.11919063714163;
const C3 = 298.6351381974001;
const C4 = 881.952221241769;
const C5 = 1712.0476126340707;
const C6 = 2051.0783778260716;
const C7 = 1230.3393547979972;
const C8 = 2.1531153547440383e-8;

const D0 = 15.744926110709835;
const D1 = 117.6939508913125;
const D2 = 537.1811018620099;
const D3 = 1621.3895745666903;
const D4 = 3290.7992357334597;
const D5 = 4362.619090143247;
const D6 = 3439.3676741437216;
const D7 = 1230.3393548037495;

const P0 = 0.30532663496123236;
const P1 = 0.36034489994980445;
const P2 = 0.12578172611122926;
const P3 = 0.016083785148742275;
const P4 = 0.0006587491615298378;
const P5 = 0.016315387137302097;

const Q0 = 2.568520192289822;
const Q1 = 1.8729528499234604;
const Q2 = 0.5279051029514285;
const Q3 = 0.06051834131244132;
const Q4 = 0.0023352049762686918;

/** 1/√π, the `erfc` tail prefactor. */
const INV_SQRT_PI = 0.5641895835477563;
/** 1/√(2π), the standard normal density prefactor. */
const INV_SQRT_2PI = 0.3989422804014327;
/** Cody's first breakpoint: |x| ≤ 0.46875 uses the central rational form. */
const CODY_THRESH = 0.46875;

/**
 * `erfc(x)` to ~4e-16 relative accuracy (Cody 1969).
 *
 * The `Math.floor(y * 16) / 16` split in the two tail branches is Cody's: it evaluates
 * `exp(−y²)` as `exp(−ȳ²)·exp(−(y−ȳ)(y+ȳ))` with `ȳ` exact in binary, so the squaring does not
 * lose the low bits of the exponent argument.
 */
export function erfc(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const y = Math.abs(x);
  let result: number;

  if (y <= CODY_THRESH) {
    // Central range: compute erf directly, erfc = 1 − erf.
    const ysq = y > 1.11e-16 ? y * y : 0;
    let xnum = A4 * ysq;
    let xden = ysq;
    xnum = (xnum + A0) * ysq;
    xden = (xden + B0) * ysq;
    xnum = (xnum + A1) * ysq;
    xden = (xden + B1) * ysq;
    xnum = (xnum + A2) * ysq;
    xden = (xden + B2) * ysq;
    return 1 - (x * (xnum + A3)) / (xden + B3);
  }

  if (y <= 4) {
    let xnum = C8 * y;
    let xden = y;
    xnum = (xnum + C0) * y;
    xden = (xden + D0) * y;
    xnum = (xnum + C1) * y;
    xden = (xden + D1) * y;
    xnum = (xnum + C2) * y;
    xden = (xden + D2) * y;
    xnum = (xnum + C3) * y;
    xden = (xden + D3) * y;
    xnum = (xnum + C4) * y;
    xden = (xden + D4) * y;
    xnum = (xnum + C5) * y;
    xden = (xden + D5) * y;
    xnum = (xnum + C6) * y;
    xden = (xden + D6) * y;
    result = (xnum + C7) / (xden + D7);
  } else {
    const ysq = 1 / (y * y);
    let xnum = P5 * ysq;
    let xden = ysq;
    xnum = (xnum + P0) * ysq;
    xden = (xden + Q0) * ysq;
    xnum = (xnum + P1) * ysq;
    xden = (xden + Q1) * ysq;
    xnum = (xnum + P2) * ysq;
    xden = (xden + Q2) * ysq;
    xnum = (xnum + P3) * ysq;
    xden = (xden + Q3) * ysq;
    result = (ysq * (xnum + P4)) / (xden + Q4);
    result = (INV_SQRT_PI - result) / y;
  }

  const ybar = Math.floor(y * 16) / 16;
  const del = (y - ybar) * (y + ybar);
  result = Math.exp(-ybar * ybar) * Math.exp(-del) * result;
  return x < 0 ? 2 - result : result;
}

/** `erf(x)` = 1 − `erfc(x)`. */
export function erf(x: number): number {
  return 1 - erfc(x);
}

/** Standard normal density φ(x). */
export function normalPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/**
 * Standard normal CDF N(x), via `erfc` so the left tail keeps its relative accuracy
 * (`0.5 · erfc(−x/√2)` never forms `1 − something`).
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === Number.POSITIVE_INFINITY) return 1;
  if (x === Number.NEGATIVE_INFINITY) return 0;
  // `-x / SQRT2`, not `-x * SQRT1_2`: the division rounds once, the multiplication rounds the
  // constant and then the product. In the far tail N(x) falls like e^{-x²/2}, so one extra ulp on
  // the argument costs |x|² ulps of relative accuracy — 6e-15 at x = −8 instead of 4e-16.
  return 0.5 * erfc(-x / Math.SQRT2);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The two vanilla payoffs. */
export type OptionType = 'call' | 'put';

/**
 * BSM's declared input set (ANAL-08). A `type` alias rather than an `interface` on purpose:
 * `defineEngine`'s `I extends EngineInputs` constraint needs the implicit index signature that
 * only a type alias gets.
 */
export type BsmInputs = {
  /** Spot price of the underlying. */
  readonly S: number;
  /** Strike. */
  readonly K: number;
  /** Continuously compounded risk-free rate, annual. */
  readonly r: number;
  /** Continuous dividend yield, annual (0 for a non-payer; the foreign rate for FX). */
  readonly q: number;
  /** Volatility, annualised, as a decimal (0.20 = 20 %). */
  readonly sigma: number;
  /** Time to expiry in years (ACT/365F). */
  readonly T: number;
};

/** Black-76's declared input set: a forward/futures price replaces spot and the yield. */
export type Black76Inputs = {
  /** Forward or futures price. */
  readonly F: number;
  readonly K: number;
  /** Continuously compounded discount rate, annual. */
  readonly r: number;
  readonly sigma: number;
  readonly T: number;
};

/**
 * Every closed-form output of one BSM evaluation. Both payoffs are returned from a single call:
 * they share `d1`, `d2`, `gamma` and `vega`, and TESTING §7.2 asserts exactly that (assertions 3
 * and 4 compare the call's and the put's gamma and vega at `1e-15`).
 */
export interface BsmOutputs {
  /** Call price. */
  readonly call: number;
  /** Put price. */
  readonly put: number;

  /** `(ln(S/K) + (r − q + σ²/2)·T) / (σ√T)`. */
  readonly d1: number;
  /** `d1 − σ√T`. */
  readonly d2: number;
  /** `N(d1)`. */
  readonly nd1: number;
  /** `N(d2)`. */
  readonly nd2: number;
  /** `φ(d1)`, the density at d1. */
  readonly pdfD1: number;
  /** `e^{−rT}`. */
  readonly discountFactor: number;
  /** `e^{−qT}`. */
  readonly dividendDiscount: number;
  /** `S·e^{(r−q)T}`, the forward the option is really written on. */
  readonly forward: number;

  /** ∂C/∂S = `e^{−qT}·N(d1)`, in (0, 1). */
  readonly deltaCall: number;
  /** ∂P/∂S = `−e^{−qT}·N(−d1)`, in (−1, 0). */
  readonly deltaPut: number;
  /** ∂²V/∂S², identical for call and put. */
  readonly gamma: number;
  /** ∂V/∂σ per 1.00 of sigma, identical for call and put. */
  readonly vega: number;
  /** `vega / 100` — the desk quote, per vol point. */
  readonly vegaPerVolPoint: number;
  /** ∂C/∂t per year (negative for a long ATM call). */
  readonly thetaCall: number;
  /** ∂P/∂t per year. */
  readonly thetaPut: number;
  /** `thetaCall / 365` — per calendar day. */
  readonly thetaCallPerDay: number;
  /** `thetaPut / 365` — per calendar day. */
  readonly thetaPutPerDay: number;
  /** ∂C/∂r per 1.00 of r. */
  readonly rhoCall: number;
  /** ∂P/∂r per 1.00 of r. */
  readonly rhoPut: number;
  /** `rhoCall / 100` — per 100 bp. */
  readonly rhoCallPer100Bp: number;
  /** `rhoPut / 100` — per 100 bp. */
  readonly rhoPutPer100Bp: number;

  /** ∂C/∂K = `−e^{−rT}·N(d2)`; minus the risk-neutral digital, the strike sensitivity. */
  readonly dualDeltaCall: number;
  /** ∂P/∂K = `e^{−rT}·N(−d2)`. */
  readonly dualDeltaPut: number;
  /** ∂²V/∂K², identical for call and put. */
  readonly dualGamma: number;
  /** ∂²V/∂S∂σ, identical for call and put. */
  readonly vanna: number;
  /** ∂²V/∂σ², identical for call and put. */
  readonly volga: number;
  /** ∂C/∂q = `−T·S·e^{−qT}·N(d1)` (the dividend rho, "epsilon"). */
  readonly epsilonCall: number;
  /** ∂P/∂q = `T·S·e^{−qT}·N(−d1)`. */
  readonly epsilonPut: number;

  /** ANAL-07: the conventions the numbers above were computed under. */
  readonly conventions: Conventions;
}

/** The conventions every BSM output echoes (ANAL-07, WORKPLAN L492). */
export const BSM_CONVENTIONS: Conventions = Object.freeze({
  model: 'black_scholes_merton',
  dayCount: 'ACT/365F',
  compounding: 'continuous',
  dividend: 'continuous_yield',
  exercise: 'european',
  vegaUnit: 'per_1.00_sigma',
  thetaUnit: 'per_year',
  rhoUnit: 'per_1.00_rate',
  calendarDaysPerYear: 365,
} satisfies Conventions);

/** The conventions Black-76 outputs echo: a forward, no spot and no yield. */
export const BLACK76_CONVENTIONS: Conventions = Object.freeze({
  model: 'black_76',
  dayCount: 'ACT/365F',
  compounding: 'continuous',
  dividend: 'none_forward_priced',
  exercise: 'european',
  vegaUnit: 'per_1.00_sigma',
  thetaUnit: 'per_year',
  rhoUnit: 'per_1.00_rate',
  calendarDaysPerYear: 365,
} satisfies Conventions);

/** Days used to quote theta per day. Calendar days, matching the `thetaUnit` convention. */
const CALENDAR_DAYS_PER_YEAR = 365;

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`bsm: ${name} must be a finite number, got ${String(value)}`);
  }
}

function validate(i: BsmInputs): void {
  requireFinite('S', i.S);
  requireFinite('K', i.K);
  requireFinite('r', i.r);
  requireFinite('q', i.q);
  requireFinite('sigma', i.sigma);
  requireFinite('T', i.T);
  if (i.S <= 0) throw new RangeError(`bsm: S must be positive, got ${String(i.S)}`);
  if (i.K <= 0) throw new RangeError(`bsm: K must be positive, got ${String(i.K)}`);
  if (i.sigma < 0) throw new RangeError(`bsm: sigma must not be negative, got ${String(i.sigma)}`);
  if (i.T < 0) throw new RangeError(`bsm: T must not be negative, got ${String(i.T)}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The closed form
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Price and greeks for a European call and put under BSM with a continuous yield `q`.
 *
 * Returns unrounded doubles — the caller rounds (TESTING §7.2 assertion 7).
 */
export function bsm(inputs: BsmInputs): BsmOutputs {
  validate(inputs);
  const { S, K, r, q, sigma, T } = inputs;

  const dfR = Math.exp(-r * T);
  const dfQ = Math.exp(-q * T);
  const forward = (S * dfQ) / dfR;
  const sqrtT = Math.sqrt(T);
  const stdDev = sigma * sqrtT;

  // ── Expiry: the payoff, and no greeks. TESTING §7.2 `bsm.expiry`.
  if (T === 0) {
    const inTheMoneyCall = S > K;
    return Object.freeze({
      call: Math.max(S - K, 0),
      put: Math.max(K - S, 0),
      d1: S === K ? 0 : sign(S - K) * Number.POSITIVE_INFINITY,
      d2: S === K ? 0 : sign(S - K) * Number.POSITIVE_INFINITY,
      nd1: S === K ? 0.5 : inTheMoneyCall ? 1 : 0,
      nd2: S === K ? 0.5 : inTheMoneyCall ? 1 : 0,
      pdfD1: 0,
      discountFactor: 1,
      dividendDiscount: 1,
      forward: S,
      deltaCall: inTheMoneyCall ? 1 : 0,
      deltaPut: S < K ? -1 : 0,
      gamma: 0,
      vega: 0,
      vegaPerVolPoint: 0,
      thetaCall: 0,
      thetaPut: 0,
      thetaCallPerDay: 0,
      thetaPutPerDay: 0,
      rhoCall: 0,
      rhoPut: 0,
      rhoCallPer100Bp: 0,
      rhoPutPer100Bp: 0,
      dualDeltaCall: inTheMoneyCall ? -1 : 0,
      dualDeltaPut: S < K ? 1 : 0,
      dualGamma: 0,
      vanna: 0,
      volga: 0,
      epsilonCall: 0,
      epsilonPut: 0,
      conventions: BSM_CONVENTIONS,
    });
  }

  // ── Zero vol, positive T: the deterministic forward, discounted. TESTING §7.2 `bsm.zero.vol`.
  if (stdDev === 0) {
    const pvForward = S * dfQ;
    const pvStrike = K * dfR;
    const callInTheMoney = pvForward > pvStrike;
    const putInTheMoney = pvForward < pvStrike;
    const indicator = callInTheMoney ? 1 : 0;
    const putIndicator = putInTheMoney ? 1 : 0;
    const infinity =
      pvForward === pvStrike ? 0 : sign(pvForward - pvStrike) * Number.POSITIVE_INFINITY;
    // θ = −∂V/∂T on the deterministic leg: only the two discount factors move.
    const thetaCall = callInTheMoney ? q * pvForward - r * pvStrike : 0;
    const thetaPut = putInTheMoney ? r * pvStrike - q * pvForward : 0;
    return Object.freeze({
      call: Math.max(pvForward - pvStrike, 0),
      put: Math.max(pvStrike - pvForward, 0),
      d1: infinity,
      d2: infinity,
      nd1: pvForward === pvStrike ? 0.5 : indicator,
      nd2: pvForward === pvStrike ? 0.5 : indicator,
      pdfD1: 0,
      discountFactor: dfR,
      dividendDiscount: dfQ,
      forward,
      deltaCall: dfQ * indicator,
      deltaPut: -dfQ * putIndicator,
      gamma: 0,
      vega: 0,
      vegaPerVolPoint: 0,
      thetaCall,
      thetaPut,
      thetaCallPerDay: thetaCall / CALENDAR_DAYS_PER_YEAR,
      thetaPutPerDay: thetaPut / CALENDAR_DAYS_PER_YEAR,
      rhoCall: K * T * dfR * indicator,
      rhoPut: -K * T * dfR * putIndicator,
      rhoCallPer100Bp: (K * T * dfR * indicator) / 100,
      rhoPutPer100Bp: (-K * T * dfR * putIndicator) / 100,
      dualDeltaCall: -dfR * indicator,
      dualDeltaPut: dfR * putIndicator,
      dualGamma: 0,
      vanna: 0,
      volga: 0,
      epsilonCall: -T * pvForward * indicator,
      epsilonPut: T * pvForward * putIndicator,
      conventions: BSM_CONVENTIONS,
    });
  }

  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / stdDev;
  const d2 = d1 - stdDev;

  const nd1 = normalCdf(d1);
  const nd2 = normalCdf(d2);
  const nMinusD1 = normalCdf(-d1);
  const nMinusD2 = normalCdf(-d2);
  const pdfD1 = normalPdf(d1);
  // φ(d2) = φ(d1)·(S e^{−qT})/(K e^{−rT}) exactly; computing it directly is just as accurate and
  // does not compound the ratio's rounding.
  const pdfD2 = normalPdf(d2);

  const pvForward = S * dfQ;
  const pvStrike = K * dfR;

  const call = pvForward * nd1 - pvStrike * nd2;
  const put = pvStrike * nMinusD2 - pvForward * nMinusD1;

  const gamma = (dfQ * pdfD1) / (S * stdDev);
  const vega = pvForward * pdfD1 * sqrtT;
  const decay = (pvForward * pdfD1 * sigma) / (2 * sqrtT);
  const thetaCall = -decay - r * pvStrike * nd2 + q * pvForward * nd1;
  const thetaPut = -decay + r * pvStrike * nMinusD2 - q * pvForward * nMinusD1;
  const rhoCall = K * T * dfR * nd2;
  const rhoPut = -K * T * dfR * nMinusD2;

  return Object.freeze({
    call,
    put,
    d1,
    d2,
    nd1,
    nd2,
    pdfD1,
    discountFactor: dfR,
    dividendDiscount: dfQ,
    forward,
    deltaCall: dfQ * nd1,
    deltaPut: -dfQ * nMinusD1,
    gamma,
    vega,
    vegaPerVolPoint: vega / 100,
    thetaCall,
    thetaPut,
    thetaCallPerDay: thetaCall / CALENDAR_DAYS_PER_YEAR,
    thetaPutPerDay: thetaPut / CALENDAR_DAYS_PER_YEAR,
    rhoCall,
    rhoPut,
    rhoCallPer100Bp: rhoCall / 100,
    rhoPutPer100Bp: rhoPut / 100,
    dualDeltaCall: -dfR * nd2,
    dualDeltaPut: dfR * nMinusD2,
    dualGamma: (dfR * pdfD2) / (K * stdDev),
    vanna: (-dfQ * pdfD1 * d2) / sigma,
    volga: (vega * d1 * d2) / sigma,
    epsilonCall: -T * pvForward * nd1,
    epsilonPut: T * pvForward * nMinusD1,
    conventions: BSM_CONVENTIONS,
  });
}

/** −1, 0 or +1 without `Math.sign`'s `-0`. */
function sign(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

/** One price, for callers that do not want the whole greek block (the implied-vol solver's `f`). */
export function bsmPrice(inputs: BsmInputs, type: OptionType): number {
  const out = bsm(inputs);
  return type === 'call' ? out.call : out.put;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Black-76
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Black-76 outputs. The greeks are taken with respect to the **forward** `F`, which is what a
 * futures-option desk hedges with, and `rho` is pure discounting: `−T·V`, because no other term
 * in the formula sees `r`.
 */
export interface Black76Outputs {
  readonly call: number;
  readonly put: number;
  readonly d1: number;
  readonly d2: number;
  readonly nd1: number;
  readonly nd2: number;
  readonly pdfD1: number;
  readonly discountFactor: number;
  /** ∂C/∂F = `e^{−rT}·N(d1)`. */
  readonly deltaCall: number;
  /** ∂P/∂F = `−e^{−rT}·N(−d1)`. */
  readonly deltaPut: number;
  readonly gamma: number;
  readonly vega: number;
  readonly vegaPerVolPoint: number;
  readonly thetaCall: number;
  readonly thetaPut: number;
  readonly thetaCallPerDay: number;
  readonly thetaPutPerDay: number;
  /** ∂C/∂r = `−T·C`. */
  readonly rhoCall: number;
  /** ∂P/∂r = `−T·P`. */
  readonly rhoPut: number;
  readonly dualDeltaCall: number;
  readonly dualDeltaPut: number;
  readonly vanna: number;
  readonly volga: number;
  readonly conventions: Conventions;
}

/**
 * Black-76 for options on futures and forwards.
 *
 * It is BSM with `S := F` and `q := r` — the carry of a forward is exactly the financing rate —
 * except for `rho`, which in Black-76 is only the discount factor's own sensitivity.
 */
export function black76(inputs: Black76Inputs): Black76Outputs {
  const { F, K, r, sigma, T } = inputs;
  requireFinite('F', F);
  if (F <= 0) throw new RangeError(`black76: F must be positive, got ${String(F)}`);
  const core = bsm({ S: F, K, r, q: r, sigma, T });
  return Object.freeze({
    call: core.call,
    put: core.put,
    d1: core.d1,
    d2: core.d2,
    nd1: core.nd1,
    nd2: core.nd2,
    pdfD1: core.pdfD1,
    discountFactor: core.discountFactor,
    deltaCall: core.deltaCall,
    deltaPut: core.deltaPut,
    gamma: core.gamma,
    vega: core.vega,
    vegaPerVolPoint: core.vegaPerVolPoint,
    thetaCall: core.thetaCall,
    thetaPut: core.thetaPut,
    thetaCallPerDay: core.thetaCallPerDay,
    thetaPutPerDay: core.thetaPutPerDay,
    rhoCall: -T * core.call,
    rhoPut: -T * core.put,
    dualDeltaCall: core.dualDeltaCall,
    dualDeltaPut: core.dualDeltaPut,
    vanna: core.vanna,
    volga: core.volga,
    conventions: BLACK76_CONVENTIONS,
  });
}

/** One Black-76 price. */
export function black76Price(inputs: Black76Inputs, type: OptionType): number {
  const out = black76(inputs);
  return type === 'call' ? out.call : out.put;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Implied volatility — Brent with a Newton accelerator (ANAL-03)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Why `impliedVol` returned no volatility. */
export type ImpliedVolFailure =
  /** The quoted price is outside `[intrinsic, upper bound]`: no non-negative vol reproduces it. */
  | 'NO_ARBITRAGE_BOUND'
  /** `T = 0`, or a non-finite input: there is no volatility to imply. */
  | 'DEGENERATE_INPUT'
  /** The bracket held but the iteration limit was hit before the tolerance. */
  | 'NO_CONVERGENCE';

/**
 * The solver's answer. `sigma` is `null` on failure — never a negative or NaN volatility, and
 * never a throw (TESTING §7.2 assertion 7: a price below the intrinsic bound "returns `null` with
 * `reason: 'NO_ARBITRAGE_BOUND'`, it does not throw and does not return a negative vol").
 */
export interface ImpliedVolResult {
  /** The implied volatility, or `null` when `reason` is set. */
  readonly sigma: number | null;
  /** Price-function evaluations of the root find (Newton steps included). */
  readonly iterations: number;
  readonly converged: boolean;
  /** `null` exactly when `sigma` is a number. */
  readonly reason: ImpliedVolFailure | null;
  /** `|model(sigma) − target|` at the returned root, for the caller's own quality gate. */
  readonly priceError: number;
}

/** Tuning knobs; every default is stated so a call site never has to guess. */
export interface ImpliedVolOptions {
  /** Absolute convergence tolerance on sigma. Default `1e-12`. */
  readonly tolerance?: number;
  /** Iteration cap. Default `64` (TESTING §7.2 requires ≤ 12 on the pinned round trip). */
  readonly maxIterations?: number;
  /** Largest volatility the bracket may expand to. Default `5.0` (500 %). */
  readonly sigmaMax?: number;
}

const DEFAULT_IV_TOLERANCE = 1e-12;
const DEFAULT_IV_MAX_ITERATIONS = 64;
const DEFAULT_IV_SIGMA_MAX = 5;

/**
 * Relative slack on the arbitrage bounds, in units of the option's own scale.
 *
 * Sixteen ulps and not a basis point: this is the width of "the quote *is* the intrinsic value,
 * up to double rounding", nothing more. A deep in-the-money option whose entire time value is
 * below that (a 90 % moneyness call at 1 % vol prices to its intrinsic in doubles) has no
 * recoverable volatility, and `sigma = 0` is the only honest answer; a quote genuinely *below*
 * intrinsic is `NO_ARBITRAGE_BOUND`, per TESTING §7.2 assertion 7.
 */
const BOUND_SLACK = 16 * Number.EPSILON;

function failure(reason: ImpliedVolFailure, iterations: number): ImpliedVolResult {
  return Object.freeze({ sigma: null, iterations, converged: false, reason, priceError: NaN });
}

/**
 * Invert BSM for sigma: Brent's method on the bracketed price error, with a Newton step taken
 * whenever vega admits one.
 *
 * Why the hybrid. Vega is the derivative the market hands you for free, and it is smooth and
 * positive for every `sigma > 0`, so Newton converges quadratically from almost anywhere —
 * typically three steps from the Brenner-Subrahmanyam seed. But vega collapses to zero for deep
 * out-of-the-money options and for very low or very high vol, and there Newton walks straight out
 * of the domain and returns a negative volatility. So the iteration keeps Brent's bracket
 * `[lo, hi]` with a sign change across it at all times: a Newton step is taken only when it lands
 * strictly inside the bracket **and** at least halves the previous step; otherwise Brent's own
 * inverse-quadratic/secant/bisection choice is used. The result is Newton's speed with bisection's
 * guarantee — the root is never lost.
 *
 * @param price   the observed option premium
 * @param inputs  the BSM inputs without `sigma`
 * @param type    which payoff `price` quotes
 */
export function impliedVol(
  price: number,
  inputs: Omit<BsmInputs, 'sigma'>,
  type: OptionType,
  options?: ImpliedVolOptions,
): ImpliedVolResult {
  const tolerance = options?.tolerance ?? DEFAULT_IV_TOLERANCE;
  const maxIterations = options?.maxIterations ?? DEFAULT_IV_MAX_ITERATIONS;
  const sigmaMax = options?.sigmaMax ?? DEFAULT_IV_SIGMA_MAX;

  const { S, K, r, q, T } = inputs;
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(S) ||
    !Number.isFinite(K) ||
    !Number.isFinite(r) ||
    !Number.isFinite(q) ||
    !Number.isFinite(T) ||
    S <= 0 ||
    K <= 0 ||
    T <= 0
  ) {
    return failure('DEGENERATE_INPUT', 0);
  }

  const dfR = Math.exp(-r * T);
  const dfQ = Math.exp(-q * T);
  const pvForward = S * dfQ;
  const pvStrike = K * dfR;

  // The model's range over sigma ∈ [0, ∞): [intrinsic, upper], both ends attained only in a limit.
  const lower =
    type === 'call' ? Math.max(pvForward - pvStrike, 0) : Math.max(pvStrike - pvForward, 0);
  const upper = type === 'call' ? pvForward : pvStrike;
  const scale = Math.max(pvForward, pvStrike);

  if (price < lower - BOUND_SLACK * scale || price > upper + BOUND_SLACK * scale) {
    return failure('NO_ARBITRAGE_BOUND', 0);
  }
  if (price <= lower + BOUND_SLACK * scale) {
    // Exactly at intrinsic: the implied vol is zero, and Brent would have no bracket.
    return Object.freeze({
      sigma: 0,
      iterations: 0,
      converged: true,
      reason: null,
      priceError: Math.abs(price - lower),
    });
  }
  if (price >= upper - BOUND_SLACK * scale) {
    // The upper bound is the σ → ∞ limit; no finite volatility reproduces it.
    return failure('NO_ARBITRAGE_BOUND', 0);
  }

  let evaluations = 0;
  const priceAt = (sigma: number): number => {
    evaluations += 1;
    return bsmPrice({ S, K, r, q, sigma, T }, type);
  };
  const vegaAt = (sigma: number): number => bsm({ S, K, r, q, sigma, T }).vega;

  // Brenner-Subrahmanyam: for an at-the-money-forward option, C ≈ 0.3989·F·e^{−rT}·σ√T, so
  // σ ≈ √(2π/T)·C/(F e^{−rT}). It is exact at the money and a serviceable seed away from it.
  const atmSeed = (Math.sqrt((2 * Math.PI) / T) * price) / pvForward;
  const seed = Math.min(
    Math.max(Number.isFinite(atmSeed) && atmSeed > 0 ? atmSeed : 0.2, 1e-4),
    sigmaMax,
  );

  // Bracket [lo, hi] with f(lo) < 0 < f(hi); f is strictly increasing in sigma.
  let lo = 0;
  let fLo = lower - price; // f(0), strictly negative here
  let hi = seed;
  let fHi = priceAt(hi) - price;
  if (fHi < 0) {
    while (fHi < 0 && hi < sigmaMax) {
      lo = hi;
      fLo = fHi;
      hi = Math.min(hi * 2, sigmaMax);
      fHi = priceAt(hi) - price;
    }
    if (fHi < 0) return failure('NO_CONVERGENCE', evaluations);
  } else {
    // The seed already overshoots: walk down for a negative end, keeping 0 as the backstop.
    let probe = seed;
    for (let i = 0; i < 40 && probe > 1e-9; i += 1) {
      probe /= 2;
      const fProbe = priceAt(probe) - price;
      if (fProbe < 0) {
        lo = probe;
        fLo = fProbe;
        break;
      }
      hi = probe;
      fHi = fProbe;
    }
  }

  // ── Brent (`zbrent`) with a Newton accelerator ────────────────────────────────────────────
  let a = lo;
  let fa = fLo;
  let b = hi;
  let fb = fHi;
  let c = a;
  let fc = fa;
  let d = b - a;
  let e = d;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    if (fb > 0 === fc > 0) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tolerance;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) {
      return Object.freeze({
        sigma: b,
        iterations: evaluations,
        converged: true,
        reason: null,
        priceError: Math.abs(fb),
      });
    }

    let step: number | null = null;

    // Newton first: one vega evaluation buys quadratic convergence when it is admissible.
    const v = vegaAt(b);
    if (v > 0) {
      const newtonStep = -fb / v;
      const candidate = b + newtonStep;
      const low = Math.min(b, c);
      const high = Math.max(b, c);
      if (candidate > low && candidate < high && Math.abs(newtonStep) <= 0.5 * Math.abs(e)) {
        step = newtonStep;
        e = d;
        d = newtonStep;
      }
    }

    if (step === null) {
      if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
        // Inverse quadratic interpolation when three distinct ordinates exist, secant otherwise.
        const s = fb / fa;
        let p: number;
        let qq: number;
        if (a === c) {
          p = 2 * xm * s;
          qq = 1 - s;
        } else {
          const qa = fa / fc;
          const rr = fb / fc;
          p = s * (2 * xm * qa * (qa - rr) - (b - a) * (rr - 1));
          qq = (qa - 1) * (rr - 1) * (s - 1);
        }
        if (p > 0) qq = -qq;
        p = Math.abs(p);
        const min1 = 3 * xm * qq - Math.abs(tol1 * qq);
        const min2 = Math.abs(e * qq);
        if (2 * p < Math.min(min1, min2)) {
          e = d;
          d = p / qq;
        } else {
          d = xm;
          e = d;
        }
      } else {
        d = xm;
        e = d;
      }
      step = d;
    }

    a = b;
    fa = fb;
    b += Math.abs(step) > tol1 ? step : tol1 * sign(xm === 0 ? 1 : xm);
    fb = priceAt(b) - price;
  }

  return failure('NO_CONVERGENCE', evaluations);
}

/** Implied vol under Black-76: BSM with `S := F`, `q := r`. */
export function impliedVolBlack76(
  price: number,
  inputs: Omit<Black76Inputs, 'sigma'>,
  type: OptionType,
  options?: ImpliedVolOptions,
): ImpliedVolResult {
  const { F, K, r, T } = inputs;
  if (!Number.isFinite(F) || F <= 0) return failure('DEGENERATE_INPUT', 0);
  return impliedVol(price, { S: F, K, r, q: r, T }, type, options);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engines (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `bsm@1.0.0` — the engine the golden cases in `fixtures/golden/analytics/bsm/**` are pinned to.
 * A version bump must re-bless every one of them (TESTING §7.1).
 */
export const bsmEngine = defineEngine<BsmInputs, BsmOutputs>('bsm', '1.0.0', (i) =>
  bsm({ S: i.S, K: i.K, r: i.r, q: i.q, sigma: i.sigma, T: i.T }),
);

/** `black76@1.0.0`. */
export const black76Engine = defineEngine<Black76Inputs, Black76Outputs>('black76', '1.0.0', (i) =>
  black76({ F: i.F, K: i.K, r: i.r, sigma: i.sigma, T: i.T }),
);
