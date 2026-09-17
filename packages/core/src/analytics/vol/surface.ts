/**
 * Volatility surface: chain → forward (put-call parity) → SVI slice fit → arbitrage checks
 * (ANAL-04, WORKPLAN §WP-02 L511-512, ARCHITECTURE L171).
 *
 * The pipeline, in the order the numbers are produced:
 *
 *  1. **Forward by put-call parity.** A listed equity option chain quotes no forward, and the
 *     forward implied by a naive carry `S·e^{(r−q)T}` is only as good as the dividend forecast
 *     `q`. Parity gives it from the quotes themselves: `C(K) − P(K) = e^{−rT}·(F − K)`, so a
 *     least-squares line through `(K, C−P)` has slope `−e^{−rT}` and intercept `e^{−rT}·F`. The
 *     regression uses every two-sided strike, so a single wide market moves the forward by a
 *     fraction of a cent instead of by its own half-spread; {@link forwardByParity} falls back to
 *     the single-strike CBOE rule (`F = K* + e^{rT}·(C−P)` at the strike `K*` that minimises
 *     `|C−P|`) when the regression degenerates, and to the carry forward when there is no usable
 *     two-sided quote at all. All three numbers are reported, never just the winner.
 *
 *  2. **Market implied vols, out-of-the-money only.** For each strike the OTM side is inverted
 *     (`put` below the forward, `call` above) with `options/bsm.ts#impliedVolBlack76` — Black-76 on
 *     the parity forward, so the dividend assumption drops out of the smile entirely. The ITM side
 *     of the same strike carries the same information with a much worse signal-to-spread ratio, so
 *     it is deliberately discarded rather than averaged in.
 *
 *  3. **Raw SVI slice fit.** Gatheral's raw parameterisation of *total implied variance*
 *     `w(k) = σ²(k)·T` in log-moneyness `k = ln(K/F)`:
 *
 *     ```
 *     w(k) = a + b·( ρ·(k − m) + sqrt((k − m)² + σ²) )
 *     ```
 *
 *     The fit result is exactly `vol_surfaces.svi` — `{a, b, rho, m, sigma, rmse, n}` (CONTRACTS
 *     L183) — and nothing else: the diagnostics of the fit live beside it on the slice, not inside
 *     the jsonb the database column stores.
 *
 *  4. **Arbitrage checks.** Butterfly (a positive risk-neutral density, per slice) via Gatheral's
 *     `g(k) ≥ 0`, cross-checked by the discrete convexity of the model's own call prices; calendar
 *     (total variance non-decreasing in `T` at fixed forward-moneyness) across consecutive slices.
 *     Both are also *enforced during the fit*, as a penalty on the objective — a surface that is
 *     merely measured for arbitrage after the fact is a surface that fails the check.
 *
 * Determinism, and why there is no PRNG here: the optimiser is a Nelder-Mead simplex run from a
 * fixed multi-start grid, so the fitted parameters are a pure function of the quotes. Two runs, two
 * processes and two machines agree bit for bit, which is what lets `vol_surfaces.inputs_hash`
 * de-duplicate a rebuild (ANAL-08).
 *
 * No clock: the valuation date is an input (`asOf`), never `Date.now()` (ARCHITECTURE L49).
 */

import type { IsoDate } from '../../calendars/calendar.js';
import { ACT_365F } from '../../daycount/conventions.js';
import { defineEngine, type Conventions } from '../engine.js';
import { black76, black76Price, impliedVolBlack76, type OptionType } from '../options/bsm.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One strike of an option chain, as a vendor quotes it (bid/ask per side, plus its own IV). */
export interface ChainQuote {
  readonly strike: number;
  readonly callBid: number;
  readonly callAsk: number;
  readonly putBid: number;
  readonly putAsk: number;
  /** The vendor's own quoted call implied vol, if the capture carries one. */
  readonly callIv?: number;
  /** The vendor's own quoted put implied vol, if the capture carries one. */
  readonly putIv?: number;
}

/** One expiry of the chain: a maturity date and the strikes quoted against it. */
export interface ChainExpiry {
  /** Expiry date, `YYYY-MM-DD`. */
  readonly expiry: IsoDate;
  readonly quotes: readonly ChainQuote[];
}

/** Where the smile's implied vols come from. */
export type IvSource =
  /** Invert the mid price of the OTM side (the default, and the only self-consistent choice). */
  | 'mid_price'
  /** Trust the vendor's quoted `callIv`/`putIv`, falling back to the mid when it is absent. */
  | 'quoted';

/**
 * The surface engine's declared input set (ANAL-08).
 *
 * A `type` alias rather than an `interface`: `defineEngine`'s `I extends EngineInputs` constraint
 * needs the implicit index signature only a type alias gets.
 */
export type VolSurfaceInputs = {
  /** Underlying ticker, echoed into the output (`vol_surfaces.underlying_instrument_id`'s symbol). */
  readonly underlying: string;
  /**
   * Valuation date, `YYYY-MM-DD`. Explicitly an *input*, not `EngineContext.valuationTs`: every
   * `T` on the surface is measured from it, so it belongs inside `inputsHash` (engine.ts L17-20).
   */
  readonly asOf: IsoDate;
  /** Spot price of the underlying at `asOf`. */
  readonly spot: number;
  /** Continuously compounded risk-free rate, annual. */
  readonly rate: number;
  /** Continuous dividend yield, annual — used for the carry forward and the parity fallback. */
  readonly dividendYield: number;
  /** The chain, one entry per expiry. */
  readonly expiries: readonly ChainExpiry[];
  /** Where the smile comes from; `'mid_price'` when omitted. */
  readonly ivSource?: IvSource;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fitted slice, in exactly the shape `vol_surfaces.svi` stores (CONTRACTS L183:
 * `svi jsonb -- {a,b,rho,m,sigma,rmse,n}`). Seven keys, no more: a consumer reading the column
 * back gets this object and nothing else.
 */
export interface SviParams {
  /** Vertical translation of total variance. */
  readonly a: number;
  /** Angle between the wings; `b ≥ 0`. */
  readonly b: number;
  /** Rotation — the skew. `ρ ∈ (−1, 1)`, negative for equity. */
  readonly rho: number;
  /** Horizontal translation: the log-moneyness of the variance minimum's centre. */
  readonly m: number;
  /** Smoothing of the vertex; `σ > 0`. */
  readonly sigma: number;
  /** Root-mean-square fit residual, in implied-vol decimals (0.0012 = 12 bp of vol). */
  readonly rmse: number;
  /** Number of quotes the fit consumed. */
  readonly n: number;
}

/** Just the five shape parameters — what the SVI formulas need. */
export type SviShape = Pick<SviParams, 'a' | 'b' | 'rho' | 'm' | 'sigma'>;

/** How the slice's forward was obtained, in decreasing order of preference. */
export type ForwardMethod = 'parity_regression' | 'parity_atm' | 'carry';

/** Everything the parity step produced, winner and runners-up alike. */
export interface ForwardEstimate {
  /** The forward the slice is fitted on. */
  readonly forward: number;
  readonly method: ForwardMethod;
  /** `e^{−rT}` from the input rate — the discount factor the fit uses. */
  readonly discountFactor: number;
  /** `−slope` of the parity regression: the discount factor the *market* implies. `null` if none. */
  readonly impliedDiscountFactor: number | null;
  /** The regression forward, `null` when fewer than three two-sided strikes exist. */
  readonly regressionForward: number | null;
  /** R² of the parity regression, `null` when there is no regression. */
  readonly regressionR2: number | null;
  /** The single-strike CBOE forward at the minimum-|C−P| strike, `null` when no strike qualifies. */
  readonly atmParityForward: number | null;
  /** The strike that minimised `|C − P|`, `null` when no strike qualifies. */
  readonly atmParityStrike: number | null;
  /** `S·e^{(r−q)T}` — the forward the input dividend yield asserts. */
  readonly carryForward: number;
  /** `r − ln(F/S)/T`: the dividend yield the chosen forward implies. */
  readonly impliedDividendYield: number;
  /** Two-sided strikes the parity step used. */
  readonly strikesUsed: number;
}

/** One quote that survived into the fit. */
export interface SlicePoint {
  readonly strike: number;
  /** `ln(K/F)`. */
  readonly logMoneyness: number;
  /** Which side was inverted: the OTM one. */
  readonly optionType: OptionType;
  readonly midPrice: number;
  readonly marketIv: number;
  readonly modelIv: number;
  /** `modelIv − marketIv`, in vol decimals. */
  readonly residual: number;
  /** Black-76 vega at the market vol — the fit weight. */
  readonly weight: number;
  /** `marketIv²·T`. */
  readonly totalVariance: number;
}

/** A quote the slice could not use, and why. */
export interface SkippedQuote {
  readonly strike: number;
  readonly reason:
    'NO_TWO_SIDED_QUOTE' | 'NON_POSITIVE_MID' | 'NO_IMPLIED_VOL' | 'NON_FINITE_INPUT';
}

/** Butterfly (density-positivity) verdict for one slice. */
export interface ButterflyCheck {
  readonly arbitrageFree: boolean;
  /** `min_k g(k)` over the check grid; `≥ 0` means a non-negative density everywhere on it. */
  readonly minG: number;
  /** The log-moneyness where `g` is smallest. */
  readonly kAtMinG: number;
  /**
   * The slack of the tightest discrete butterfly on the model's own call prices:
   * `((K₃−K₂)·C(K₁) + (K₂−K₁)·C(K₃))/(K₃−K₁) − C(K₂)`, minimised over consecutive triples.
   * Non-negative means the model prices a convex call curve. `null` with fewer than three strikes.
   */
  readonly minModelConvexity: number | null;
  /** The same slack on the *quoted* mid call prices — is the input chain itself convex? */
  readonly minMarketConvexity: number | null;
  /** Points on the `g` grid. */
  readonly gridPoints: number;
}

/** One expiry of the surface. */
export interface VolSurfaceSlice {
  readonly expiry: IsoDate;
  /** ACT/365F year fraction from `asOf` to `expiry`. */
  readonly T: number;
  /** Calendar days from `asOf` to `expiry`. */
  readonly days: number;
  readonly forward: number;
  readonly forwardDetail: ForwardEstimate;
  /** The listed strike nearest the forward. */
  readonly atmStrike: number;
  /** The fitted vol at `k = 0` — `vol_surfaces.atm_iv`. */
  readonly atmIv: number;
  /** Exactly `vol_surfaces.svi`. */
  readonly svi: SviParams;
  /** Weighted mean squared error the optimiser actually minimised (vol², penalties excluded). */
  readonly fitObjective: number;
  /** Largest absolute vol residual on the slice. */
  readonly maxAbsResidual: number;
  readonly butterfly: ButterflyCheck;
  readonly points: readonly SlicePoint[];
  readonly skipped: readonly SkippedQuote[];
}

/** Calendar-spread verdict across the whole surface. */
export interface CalendarCheck {
  readonly arbitrageFree: boolean;
  /**
   * `min over consecutive slice pairs, over k of (w_long(k) − w_short(k))`. Non-negative means
   * total variance never decreases with maturity, which is the calendar-spread condition.
   */
  readonly minGap: number;
  /** Where that minimum sits, or `null` when there is nothing to compare. */
  readonly kAtMinGap: number | null;
  /** The longer expiry of the pair that produced `minGap`. */
  readonly expiryAtMinGap: IsoDate | null;
  readonly pairsChecked: number;
}

/** What the surface engine returns. */
export interface VolSurfaceOutputs {
  readonly underlying: string;
  readonly asOf: IsoDate;
  readonly slices: readonly VolSurfaceSlice[];
  readonly calendar: CalendarCheck;

  /** `true` when no slice shows butterfly arbitrage and no pair shows calendar arbitrage. */
  readonly arbitrageFree: boolean;
  readonly butterflyArbitrage: boolean;
  readonly calendarArbitrage: boolean;
  /** Smallest `g(k)` over every slice. */
  readonly minButterflyG: number;
  /** `CalendarCheck.minGap`, hoisted. */
  readonly minCalendarGap: number;
  /** Largest `svi.rmse` over the slices, in vol decimals. */
  readonly maxRmse: number;
  readonly nSlices: number;
  /** Quotes that made it into a fit, summed over slices. */
  readonly nQuotes: number;

  /** Summary of the nearest expiry — flat scalars, for the QA-01 golden driver (TESTING §7.1). */
  readonly frontExpiry: IsoDate;
  readonly frontT: number;
  readonly frontForward: number;
  readonly frontAtmIv: number;
  readonly frontRmse: number;
  /** Summary of the farthest expiry; identical to the front on a single-slice surface. */
  readonly backExpiry: IsoDate;
  readonly backT: number;
  readonly backForward: number;
  readonly backAtmIv: number;
  readonly backRmse: number;

  /** ANAL-07. */
  readonly conventions: Conventions;
}

/** The conventions every surface output echoes (ANAL-07, WORKPLAN L492). */
export const VOL_SURFACE_CONVENTIONS: Conventions = Object.freeze({
  model: 'svi_raw',
  parameterisation: 'gatheral_raw_total_variance',
  moneyness: 'log_strike_over_forward',
  dayCount: 'ACT/365F',
  compounding: 'continuous',
  calendarDaysPerYear: 365,
  forwardMethod: 'put_call_parity',
  smileSide: 'out_of_the_money',
  pricingModel: 'black_76',
  fitObjective: 'vega_weighted_least_squares_in_implied_vol',
  rmseUnit: 'implied_vol_decimal',
  rmseBasis: 'unweighted_rms_of_vol_residuals',
  optimiser: 'nelder_mead_multistart',
  arbitrageChecks: 'butterfly_gatheral_g,calendar_total_variance',
} satisfies Conventions);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SVI math
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Total implied variance `w(k) = a + b(ρ(k−m) + sqrt((k−m)² + σ²))`. */
export function sviTotalVariance(p: SviShape, k: number): number {
  const d = k - p.m;
  return p.a + p.b * (p.rho * d + Math.sqrt(d * d + p.sigma * p.sigma));
}

/** `∂w/∂k = b(ρ + (k−m)/sqrt((k−m)² + σ²))`. */
export function sviSlope(p: SviShape, k: number): number {
  const d = k - p.m;
  return p.b * (p.rho + d / Math.sqrt(d * d + p.sigma * p.sigma));
}

/** `∂²w/∂k² = b·σ²/((k−m)² + σ²)^{3/2}`. */
export function sviCurvature(p: SviShape, k: number): number {
  const d = k - p.m;
  const q = d * d + p.sigma * p.sigma;
  return (p.b * p.sigma * p.sigma) / (q * Math.sqrt(q));
}

/** Implied vol `sqrt(w(k)/T)`; a negative total variance is clamped to zero rather than NaN. */
export function sviImpliedVol(p: SviShape, k: number, T: number): number {
  if (!(T > 0)) return 0;
  const w = sviTotalVariance(p, k);
  return w > 0 ? Math.sqrt(w / T) : 0;
}

/**
 * Gatheral's `g(k)` — the density of the slice up to a positive factor (Gatheral & Jacquier,
 * *Arbitrage-free SVI volatility surfaces*, eq. 2.1):
 *
 * ```
 * g(k) = (1 − k·w'(k)/(2·w(k)))² − (w'(k)²/4)·(1/w(k) + 1/4) + w''(k)/2
 * ```
 *
 * `g(k) ≥ 0` for every `k` is exactly "no butterfly arbitrage": the risk-neutral density implied
 * by the slice is non-negative, so no long-butterfly spread has a negative price.
 */
export function sviG(p: SviShape, k: number): number {
  const w = sviTotalVariance(p, k);
  if (!(w > 0)) return Number.NEGATIVE_INFINITY;
  const w1 = sviSlope(p, k);
  const w2 = sviCurvature(p, k);
  const term1 = 1 - (k * w1) / (2 * w);
  return term1 * term1 - ((w1 * w1) / 4) * (1 / w + 0.25) + w2 / 2;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small numeric helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Indexed read that survives `noUncheckedIndexedAccess` without a non-null assertion. */
function at(values: readonly number[], i: number): number {
  const v = values[i];
  if (v === undefined) throw new RangeError(`vol.surface: index ${i} out of range`);
  return v;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`vol.surface: ${name} must be a finite number, got ${String(value)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 1 — the forward, by put-call parity
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A strike with a usable two-sided market on both the call and the put. */
interface ParityRow {
  readonly strike: number;
  readonly callMid: number;
  readonly putMid: number;
}

function parityRows(quotes: readonly ChainQuote[]): ParityRow[] {
  const rows: ParityRow[] = [];
  for (const q of quotes) {
    const twoSided =
      Number.isFinite(q.callBid) &&
      Number.isFinite(q.callAsk) &&
      Number.isFinite(q.putBid) &&
      Number.isFinite(q.putAsk) &&
      q.callBid > 0 &&
      q.putBid > 0 &&
      q.callAsk >= q.callBid &&
      q.putAsk >= q.putBid;
    if (!twoSided) continue;
    rows.push({
      strike: q.strike,
      callMid: (q.callBid + q.callAsk) / 2,
      putMid: (q.putBid + q.putAsk) / 2,
    });
  }
  return rows;
}

/**
 * The forward implied by `C(K) − P(K) = e^{−rT}(F − K)`.
 *
 * Three estimates are produced and the best available one is chosen:
 *
 *  - **`parity_regression`** — ordinary least squares of `C−P` on `K` over every two-sided strike.
 *    Slope `β = −e^{−rT}`, intercept `α = e^{−rT}·F`, so `F = −α/β`. Used when at least three
 *    strikes qualify, the slope is negative, and the discount factor it implies is within 5 % of
 *    `e^{−rT}` (a wider gap means the quotes are not a single arbitrage-free snapshot, and the
 *    regression is the wrong tool).
 *  - **`parity_atm`** — the CBOE rule: at the strike `K*` minimising `|C−P|`,
 *    `F = K* + e^{rT}·(C−P)`. One strike, no regression assumptions.
 *  - **`carry`** — `S·e^{(r−q)T}`, when no strike has a two-sided market at all.
 */
export function forwardByParity(
  quotes: readonly ChainQuote[],
  spot: number,
  rate: number,
  dividendYield: number,
  T: number,
): ForwardEstimate {
  const discountFactor = Math.exp(-rate * T);
  const carryForward = spot * Math.exp((rate - dividendYield) * T);
  const rows = parityRows(quotes);

  // Single-strike parity at the minimum-|C−P| strike.
  let atmParityForward: number | null = null;
  let atmParityStrike: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const gap = Math.abs(row.callMid - row.putMid);
    if (gap < bestGap) {
      bestGap = gap;
      atmParityStrike = row.strike;
      atmParityForward = row.strike + (row.callMid - row.putMid) / discountFactor;
    }
  }

  // Least squares of (C − P) on K.
  let regressionForward: number | null = null;
  let regressionR2: number | null = null;
  let impliedDiscountFactor: number | null = null;
  if (rows.length >= 3) {
    const n = rows.length;
    let sx = 0;
    let sy = 0;
    for (const row of rows) {
      sx += row.strike;
      sy += row.callMid - row.putMid;
    }
    const mx = sx / n;
    const my = sy / n;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const row of rows) {
      const dx = row.strike - mx;
      const dy = row.callMid - row.putMid - my;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    if (sxx > 0) {
      const slope = sxy / sxx;
      const intercept = my - slope * mx;
      if (slope < 0) {
        impliedDiscountFactor = -slope;
        regressionForward = -intercept / slope;
        regressionR2 = syy > 0 ? clamp((sxy * sxy) / (sxx * syy), 0, 1) : 1;
      }
    }
  }

  const regressionUsable =
    regressionForward !== null &&
    regressionForward > 0 &&
    impliedDiscountFactor !== null &&
    Math.abs(impliedDiscountFactor / discountFactor - 1) <= 0.05;

  let forward: number;
  let method: ForwardMethod;
  if (regressionUsable && regressionForward !== null) {
    forward = regressionForward;
    method = 'parity_regression';
  } else if (atmParityForward !== null && atmParityForward > 0) {
    forward = atmParityForward;
    method = 'parity_atm';
  } else {
    forward = carryForward;
    method = 'carry';
  }

  const impliedDividendYield = T > 0 ? rate - Math.log(forward / spot) / T : rate;

  return Object.freeze({
    forward,
    method,
    discountFactor,
    impliedDiscountFactor,
    regressionForward,
    regressionR2,
    atmParityForward,
    atmParityStrike,
    carryForward,
    impliedDividendYield,
    strikesUsed: rows.length,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 2 — the observed smile
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A quote reduced to what the fit needs. */
interface RawPoint {
  readonly strike: number;
  readonly k: number;
  readonly optionType: OptionType;
  readonly midPrice: number;
  readonly iv: number;
  readonly weight: number;
}

function extractSmile(
  quotes: readonly ChainQuote[],
  forward: number,
  rate: number,
  T: number,
  ivSource: IvSource,
): { points: RawPoint[]; skipped: SkippedQuote[] } {
  const points: RawPoint[] = [];
  const skipped: SkippedQuote[] = [];

  for (const q of quotes) {
    if (!Number.isFinite(q.strike) || q.strike <= 0) {
      skipped.push({ strike: q.strike, reason: 'NON_FINITE_INPUT' });
      continue;
    }
    const otm: OptionType = q.strike >= forward ? 'call' : 'put';
    const bid = otm === 'call' ? q.callBid : q.putBid;
    const ask = otm === 'call' ? q.callAsk : q.putAsk;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
      skipped.push({ strike: q.strike, reason: 'NO_TWO_SIDED_QUOTE' });
      continue;
    }
    const mid = (bid + ask) / 2;
    if (!(mid > 0)) {
      skipped.push({ strike: q.strike, reason: 'NON_POSITIVE_MID' });
      continue;
    }

    const quotedIv = otm === 'call' ? q.callIv : q.putIv;
    let iv: number | null = null;
    if (
      ivSource === 'quoted' &&
      quotedIv !== undefined &&
      Number.isFinite(quotedIv) &&
      quotedIv > 0
    ) {
      iv = quotedIv;
    } else {
      const solved = impliedVolBlack76(mid, { F: forward, K: q.strike, r: rate, T }, otm);
      iv = solved.sigma !== null && solved.converged && solved.sigma > 0 ? solved.sigma : null;
    }
    if (iv === null) {
      skipped.push({ strike: q.strike, reason: 'NO_IMPLIED_VOL' });
      continue;
    }

    // Vega weighting: the fit is in vol space, but the *quotes* are prices, so a vol residual
    // matters in proportion to the price it moves. Vega is that factor, and it collapses exactly
    // where the quote carries least information (the far wings, where a penny of spread is worth
    // several vol points).
    const vega = black76({ F: forward, K: q.strike, r: rate, sigma: iv, T }).vega;
    points.push({
      strike: q.strike,
      k: Math.log(q.strike / forward),
      optionType: otm,
      midPrice: mid,
      iv,
      weight: Number.isFinite(vega) && vega > 0 ? vega : 0,
    });
  }

  // Normalise the weights to mean 1, so the objective's scale — and the arbitrage penalty
  // calibrated against it — does not depend on the notional of the underlying.
  const total = points.reduce((s, p) => s + p.weight, 0);
  if (total > 0) {
    const scale = points.length / total;
    return {
      points: points.map((p) => ({ ...p, weight: p.weight * scale })),
      skipped,
    };
  }
  return { points: points.map((p) => ({ ...p, weight: 1 })), skipped };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 3 — the SVI fit
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the fit produced besides the seven stored parameters. */
export interface SviFitResult {
  readonly svi: SviParams;
  /** The weighted mean squared vol error, penalties excluded. */
  readonly objective: number;
  /** Nelder-Mead objective evaluations across every start. */
  readonly evaluations: number;
  readonly maxAbsResidual: number;
}

/** A quote as the fitter sees it: log-moneyness, implied vol, weight. */
export interface SviFitPoint {
  readonly k: number;
  readonly iv: number;
  readonly weight: number;
}

/**
 * The fit is parameterised so that *every* SVI no-arbitrage constraint except Roger Lee's slope
 * bound holds by construction, which is why an unconstrained simplex is enough:
 *
 * ```
 * wMin = e^{θ₀} > 0     b = e^{θ₁} ≥ 0     ρ = tanh(θ₂) ∈ (−1,1)     m = θ₃     σ = e^{θ₄} > 0
 * a    = wMin − b·σ·sqrt(1 − ρ²)
 * ```
 *
 * `a + b·σ·sqrt(1−ρ²) = wMin > 0` is exactly the minimum of `w`, so total variance is positive
 * everywhere by construction; `b ≥ 0` and `|ρ| < 1` likewise. Lee's bound `b·T·(1+|ρ|) ≤ 4` and
 * butterfly positivity are the two that do not fall out of the algebra, and are added as
 * penalties.
 */
function shapeFromTheta(theta: readonly number[]): SviShape {
  const wMin = Math.exp(clamp(at(theta, 0), -40, 6));
  const b = Math.exp(clamp(at(theta, 1), -30, 6));
  const rho = Math.tanh(clamp(at(theta, 2), -12, 12));
  const m = clamp(at(theta, 3), -5, 5);
  const sigma = Math.exp(clamp(at(theta, 4), -14, 4));
  const a = wMin - b * sigma * Math.sqrt(1 - rho * rho);
  return { a, b, rho, m, sigma };
}

/** Points of the grid the butterfly penalty and the butterfly check both run on. */
const G_GRID_POINTS = 121;
/** How far past the quoted strike range the `g` grid extends, in log-moneyness. */
const G_GRID_PADDING = 0.25;
/**
 * Weight of a butterfly violation in the fit objective. The objective itself is a mean squared
 * vol error — `1e-8` for a slice that fits to a basis point — so a coefficient of 1 makes even a
 * `g = −1e-3` violation (1e-6) dominate the fit entirely. That is the intent: the penalty is a
 * constraint wearing a soft-constraint's clothes, not a trade-off.
 */
const BUTTERFLY_PENALTY = 1;
/** Weight of a Lee-bound violation; `b·T·(1+|ρ|)` is O(1), so the same scale argument applies. */
const LEE_PENALTY = 1;

function gGrid(kMin: number, kMax: number): number[] {
  const lo = kMin - G_GRID_PADDING;
  const hi = kMax + G_GRID_PADDING;
  const step = (hi - lo) / (G_GRID_POINTS - 1);
  const grid: number[] = [];
  for (let i = 0; i < G_GRID_POINTS; i += 1) grid.push(lo + i * step);
  return grid;
}

function weightedMse(p: SviShape, points: readonly SviFitPoint[], T: number): number {
  let num = 0;
  let den = 0;
  for (const pt of points) {
    const d = sviImpliedVol(p, pt.k, T) - pt.iv;
    num += pt.weight * d * d;
    den += pt.weight;
  }
  return den > 0 ? num / den : Number.POSITIVE_INFINITY;
}

/**
 * Fit a raw-SVI slice to one expiry's smile.
 *
 * Multi-start Nelder-Mead: 18 starts spanning the plausible `(b, ρ, σ)` box, each polished twice
 * from its own optimum with a shrunken simplex. The start grid is a literal constant, so the fit
 * is a pure, deterministic function of the quotes — a rerun cannot land on a different local
 * minimum, which is what `vol_surfaces.inputs_hash` de-duplication assumes (ANAL-08).
 */
export function fitSviSlice(points: readonly SviFitPoint[], T: number): SviFitResult {
  if (points.length < 5) {
    throw new RangeError(
      `vol.surface: an SVI slice needs at least 5 usable quotes, got ${String(points.length)}`,
    );
  }
  requireFinite('T', T);
  if (!(T > 0)) throw new RangeError(`vol.surface: T must be positive, got ${String(T)}`);

  let kMin = Number.POSITIVE_INFINITY;
  let kMax = Number.NEGATIVE_INFINITY;
  let minVariance = Number.POSITIVE_INFINITY;
  for (const pt of points) {
    requireFinite('k', pt.k);
    requireFinite('iv', pt.iv);
    if (pt.k < kMin) kMin = pt.k;
    if (pt.k > kMax) kMax = pt.k;
    minVariance = Math.min(minVariance, pt.iv * pt.iv * T);
  }

  const grid = gGrid(kMin, kMax);
  const leeCap = 4 / T;
  let evaluations = 0;

  const objective = (theta: readonly number[]): number => {
    evaluations += 1;
    const p = shapeFromTheta(theta);
    if (!Number.isFinite(p.a) || !Number.isFinite(p.b) || !Number.isFinite(p.sigma)) {
      return Number.POSITIVE_INFINITY;
    }
    let loss = weightedMse(p, points, T);
    if (!Number.isFinite(loss)) return Number.POSITIVE_INFINITY;

    const leeExcess = p.b * (1 + Math.abs(p.rho)) - leeCap;
    if (leeExcess > 0) loss += LEE_PENALTY * leeExcess * leeExcess;

    for (const k of grid) {
      const g = sviG(p, k);
      if (!Number.isFinite(g)) return Number.POSITIVE_INFINITY;
      if (g < 0) loss += BUTTERFLY_PENALTY * g * g;
    }
    return loss;
  };

  // The multi-start grid. `wMin` and `m` start from the data; the three shape coordinates are
  // swept, because they are the ones with distinct local minima on a real smile.
  const wMinStart = Math.max(minVariance * 0.9, 1e-8);
  const mStarts = [0, (kMin + kMax) / 2] as const;
  const bStarts = [0.02, 0.1, 0.4] as const;
  const rhoStarts = [-0.75, -0.3, 0] as const;
  const sigmaStart = Math.max((kMax - kMin) / 4, 0.02);

  let best: number[] | null = null;
  let bestValue = Number.POSITIVE_INFINITY;

  for (const m0 of mStarts) {
    for (const b0 of bStarts) {
      for (const rho0 of rhoStarts) {
        const theta0 = [
          Math.log(wMinStart),
          Math.log(b0),
          Math.atanh(rho0),
          m0,
          Math.log(sigmaStart),
        ];
        let run = nelderMead(objective, theta0, [0.6, 0.6, 0.6, 0.05, 0.6], 1500);
        // Two restarts from the optimum with a shrinking simplex: Nelder-Mead's simplex can
        // collapse along a direction and stall, and a restart is the standard cure.
        run = nelderMead(objective, run.x, [0.1, 0.1, 0.1, 0.02, 0.1], 1500);
        run = nelderMead(objective, run.x, [0.02, 0.02, 0.02, 0.005, 0.02], 1500);
        if (run.fx < bestValue) {
          bestValue = run.fx;
          best = run.x;
        }
      }
    }
  }

  if (best === null || !Number.isFinite(bestValue)) {
    throw new RangeError('vol.surface: the SVI fit did not converge on any start');
  }

  const shape = shapeFromTheta(best);
  let sse = 0;
  let maxAbsResidual = 0;
  for (const pt of points) {
    const d = sviImpliedVol(shape, pt.k, T) - pt.iv;
    sse += d * d;
    maxAbsResidual = Math.max(maxAbsResidual, Math.abs(d));
  }
  const rmse = Math.sqrt(sse / points.length);

  // Exactly the seven keys of `vol_surfaces.svi` (CONTRACTS L183), in that order.
  const svi: SviParams = Object.freeze({
    a: shape.a,
    b: shape.b,
    rho: shape.rho,
    m: shape.m,
    sigma: shape.sigma,
    rmse,
    n: points.length,
  });

  return Object.freeze({
    svi,
    objective: weightedMse(shape, points, T),
    evaluations,
    maxAbsResidual,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Nelder-Mead
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SimplexResult {
  readonly x: number[];
  readonly fx: number;
}

/**
 * Nelder-Mead downhill simplex with the standard coefficients (reflection 1, expansion 2,
 * contraction 1/2, shrink 1/2).
 *
 * Derivative-free on purpose: the objective carries a `max(0, −g)²` penalty whose gradient is
 * discontinuous at the constraint boundary, which is precisely where a gradient method stalls.
 * The initial simplex is the start point plus one axis step per coordinate, so the whole run is
 * determined by `(x0, steps)` — no randomness anywhere.
 */
function nelderMead(
  f: (x: readonly number[]) => number,
  x0: readonly number[],
  steps: readonly number[],
  maxIterations: number,
): SimplexResult {
  const n = x0.length;
  const simplex: number[][] = [];
  const values: number[] = [];

  const start = [...x0];
  simplex.push(start);
  values.push(f(start));
  for (let i = 0; i < n; i += 1) {
    const vertex = [...x0];
    vertex[i] = at(x0, i) + at(steps, i);
    simplex.push(vertex);
    values.push(f(vertex));
  }

  const order = (): number[] => {
    const idx = simplex.map((_, i) => i);
    idx.sort((i, j) => at(values, i) - at(values, j));
    return idx;
  };

  const vertexAt = (i: number): number[] => {
    const v = simplex[i];
    if (v === undefined) throw new RangeError('vol.surface: simplex vertex missing');
    return v;
  };

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const idx = order();
    const bestI = at(idx, 0);
    const worstI = at(idx, n);
    const secondWorstI = at(idx, n - 1);
    const fBest = at(values, bestI);
    const fWorst = at(values, worstI);

    // Converged when the simplex has collapsed both in value and in size.
    const spread = Math.abs(fWorst - fBest) / (Math.abs(fBest) + Math.abs(fWorst) + 1e-300);
    let size = 0;
    const bestVertex = vertexAt(bestI);
    for (let i = 0; i <= n; i += 1) {
      const v = vertexAt(i);
      for (let j = 0; j < n; j += 1) size = Math.max(size, Math.abs(at(v, j) - at(bestVertex, j)));
    }
    if (spread < 1e-12 && size < 1e-10) break;

    // Centroid of everything but the worst vertex.
    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      const v = vertexAt(at(idx, i));
      for (let j = 0; j < n; j += 1) centroid[j] = at(centroid, j) + at(v, j) / n;
    }

    const worst = vertexAt(worstI);
    const reflected = centroid.map((c, j) => c + (c - at(worst, j)));
    const fReflected = f(reflected);

    if (fReflected < fBest) {
      const expanded = centroid.map((c, j) => c + 2 * (c - at(worst, j)));
      const fExpanded = f(expanded);
      if (fExpanded < fReflected) {
        simplex[worstI] = expanded;
        values[worstI] = fExpanded;
      } else {
        simplex[worstI] = reflected;
        values[worstI] = fReflected;
      }
      continue;
    }

    if (fReflected < at(values, secondWorstI)) {
      simplex[worstI] = reflected;
      values[worstI] = fReflected;
      continue;
    }

    // Contract — outside if the reflection improved on the worst, inside otherwise.
    const outside = fReflected < fWorst;
    const contracted = centroid.map((c, j) =>
      outside ? c + 0.5 * (c - at(worst, j)) : c - 0.5 * (c - at(worst, j)),
    );
    const fContracted = f(contracted);
    if (fContracted < Math.min(fReflected, fWorst)) {
      simplex[worstI] = contracted;
      values[worstI] = fContracted;
      continue;
    }

    // Shrink towards the best vertex.
    for (let i = 0; i <= n; i += 1) {
      if (i === bestI) continue;
      const v = vertexAt(i);
      const shrunk = v.map((x, j) => at(bestVertex, j) + 0.5 * (x - at(bestVertex, j)));
      simplex[i] = shrunk;
      values[i] = f(shrunk);
    }
  }

  const finalIdx = order();
  const bestI = at(finalIdx, 0);
  return { x: vertexAt(bestI), fx: at(values, bestI) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step 4 — arbitrage checks
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tolerance on a butterfly verdict. `g` is O(1) and computed from doubles through a square root
 * and three divisions, so a violation smaller than this is rounding, not arbitrage.
 */
const G_TOLERANCE = 1e-10;
/** The same idea for a call-price convexity slack, in price units (a nano-cent). */
const CONVEXITY_TOLERANCE = 1e-9;
/** And for a calendar gap, in total-variance units. */
const CALENDAR_TOLERANCE = 1e-10;

/**
 * Discrete butterfly slack over consecutive strike triples:
 * `((K₃−K₂)·C(K₁) + (K₂−K₁)·C(K₃))/(K₃−K₁) − C(K₂)`, which is `≥ 0` exactly when the call curve
 * is convex in the strike — the payoff-level statement of the same no-arbitrage condition `g ≥ 0`
 * makes in the density. Two statements of one condition, computed by different routes: a sign slip
 * in `g` cannot hide behind it.
 */
function minButterflySlack(strikes: readonly number[], calls: readonly number[]): number | null {
  if (strikes.length < 3) return null;
  let worst = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 2 < strikes.length; i += 1) {
    const k1 = at(strikes, i);
    const k2 = at(strikes, i + 1);
    const k3 = at(strikes, i + 2);
    if (!(k3 > k1)) continue;
    const interpolated = ((k3 - k2) * at(calls, i) + (k2 - k1) * at(calls, i + 2)) / (k3 - k1);
    worst = Math.min(worst, interpolated - at(calls, i + 1));
  }
  return Number.isFinite(worst) ? worst : null;
}

/**
 * Butterfly check for one fitted slice: Gatheral's `g(k)` on a grid spanning the quoted strikes
 * plus a 0.25 log-moneyness pad on each side, cross-checked against the convexity of the model's
 * own call prices at the quoted strikes and of the quoted mid call prices themselves.
 */
export function butterflyCheck(
  p: SviShape,
  T: number,
  forward: number,
  rate: number,
  strikes: readonly number[],
  marketCallMids: readonly number[],
): ButterflyCheck {
  const sorted = [...strikes].sort((x, y) => x - y);
  const kMin = sorted.length > 0 ? Math.log(at(sorted, 0) / forward) : -0.5;
  const kMax = sorted.length > 0 ? Math.log(at(sorted, sorted.length - 1) / forward) : 0.5;

  let minG = Number.POSITIVE_INFINITY;
  let kAtMinG = 0;
  const grid = gGrid(kMin, kMax);
  for (const k of grid) {
    const g = sviG(p, k);
    if (g < minG) {
      minG = g;
      kAtMinG = k;
    }
  }

  const modelCalls = sorted.map((K) =>
    black76Price(
      { F: forward, K, r: rate, sigma: sviImpliedVol(p, Math.log(K / forward), T), T },
      'call',
    ),
  );
  const minModelConvexity = minButterflySlack(sorted, modelCalls);
  const minMarketConvexity =
    marketCallMids.length === strikes.length
      ? minButterflySlack(
          sorted,
          sorted.map((K) => {
            const i = strikes.indexOf(K);
            return i >= 0 ? at(marketCallMids, i) : Number.NaN;
          }),
        )
      : null;

  const arbitrageFree =
    minG >= -G_TOLERANCE &&
    (minModelConvexity === null || minModelConvexity >= -CONVEXITY_TOLERANCE);

  return Object.freeze({
    arbitrageFree,
    minG,
    kAtMinG,
    minModelConvexity,
    minMarketConvexity,
    gridPoints: grid.length,
  });
}

/**
 * Calendar check across the surface: at every log-moneyness, total implied variance must not
 * decrease with maturity, `w(k, T₂) ≥ w(k, T₁)` for `T₂ > T₁`. A violation is a calendar spread
 * with a negative price.
 *
 * Consecutive pairs only — the condition is transitive, so pinning each adjacent pair pins the
 * whole surface. The comparison grid is the *intersection* of the two slices' quoted ranges,
 * padded, because comparing the slices where neither has data would test the extrapolation rather
 * than the fit.
 */
export function calendarCheck(
  slices: readonly {
    readonly expiry: IsoDate;
    readonly T: number;
    readonly svi: SviShape;
    readonly kMin: number;
    readonly kMax: number;
  }[],
): CalendarCheck {
  const ordered = [...slices].sort((x, y) => x.T - y.T);
  let minGap = Number.POSITIVE_INFINITY;
  let kAtMinGap: number | null = null;
  let expiryAtMinGap: IsoDate | null = null;
  let pairsChecked = 0;

  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const shortSlice = ordered[i];
    const longSlice = ordered[i + 1];
    if (shortSlice === undefined || longSlice === undefined) continue;
    const lo = Math.max(shortSlice.kMin, longSlice.kMin) - G_GRID_PADDING;
    const hi = Math.min(shortSlice.kMax, longSlice.kMax) + G_GRID_PADDING;
    if (!(hi > lo)) continue;
    pairsChecked += 1;
    const step = (hi - lo) / (G_GRID_POINTS - 1);
    for (let j = 0; j < G_GRID_POINTS; j += 1) {
      const k = lo + j * step;
      const gap = sviTotalVariance(longSlice.svi, k) - sviTotalVariance(shortSlice.svi, k);
      if (gap < minGap) {
        minGap = gap;
        kAtMinGap = k;
        expiryAtMinGap = longSlice.expiry;
      }
    }
  }

  if (pairsChecked === 0) {
    // A one-expiry surface cannot show calendar arbitrage: there is nothing to compare it to.
    return Object.freeze({
      arbitrageFree: true,
      minGap: Number.POSITIVE_INFINITY,
      kAtMinGap: null,
      expiryAtMinGap: null,
      pairsChecked: 0,
    });
  }

  return Object.freeze({
    arbitrageFree: minGap >= -CALENDAR_TOLERANCE,
    minGap,
    kAtMinGap,
    expiryAtMinGap,
    pairsChecked,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The surface
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the whole surface: one SVI slice per expiry, plus the two arbitrage verdicts.
 *
 * Pure and clock-free — `asOf` comes from the inputs, and every `T` is `ACT/365F` from it to the
 * expiry, matching the `dayCount` convention echoed in the output.
 */
export function volSurface(inputs: VolSurfaceInputs): VolSurfaceOutputs {
  const { underlying, asOf, spot, rate, dividendYield, expiries } = inputs;
  const ivSource: IvSource = inputs.ivSource ?? 'mid_price';

  requireFinite('spot', spot);
  requireFinite('rate', rate);
  requireFinite('dividendYield', dividendYield);
  if (spot <= 0) throw new RangeError(`vol.surface: spot must be positive, got ${String(spot)}`);
  if (expiries.length === 0) throw new RangeError('vol.surface: the chain has no expiries');

  const slices: VolSurfaceSlice[] = [];
  const forCalendar: {
    expiry: IsoDate;
    T: number;
    svi: SviShape;
    kMin: number;
    kMax: number;
  }[] = [];

  for (const chainExpiry of expiries) {
    const days = ACT_365F.measure(asOf, chainExpiry.expiry).days;
    const T = ACT_365F.yearFraction(asOf, chainExpiry.expiry);
    if (!(T > 0)) {
      throw new RangeError(
        `vol.surface: expiry ${chainExpiry.expiry} is not after asOf ${asOf} (T = ${String(T)})`,
      );
    }

    const forwardDetail = forwardByParity(chainExpiry.quotes, spot, rate, dividendYield, T);
    const forward = forwardDetail.forward;
    const { points: raw, skipped } = extractSmile(chainExpiry.quotes, forward, rate, T, ivSource);

    const fit = fitSviSlice(
      raw.map((p) => ({ k: p.k, iv: p.iv, weight: p.weight })),
      T,
    );
    const shape: SviShape = {
      a: fit.svi.a,
      b: fit.svi.b,
      rho: fit.svi.rho,
      m: fit.svi.m,
      sigma: fit.svi.sigma,
    };

    const points: SlicePoint[] = raw.map((p) => {
      const modelIv = sviImpliedVol(shape, p.k, T);
      return Object.freeze({
        strike: p.strike,
        logMoneyness: p.k,
        optionType: p.optionType,
        midPrice: p.midPrice,
        marketIv: p.iv,
        modelIv,
        residual: modelIv - p.iv,
        weight: p.weight,
        totalVariance: p.iv * p.iv * T,
      });
    });

    const strikes = chainExpiry.quotes.map((q) => q.strike);
    const callMids = chainExpiry.quotes.map((q) => (q.callBid + q.callAsk) / 2);
    const butterfly = butterflyCheck(shape, T, forward, rate, strikes, callMids);

    let atmStrike = strikes.length > 0 ? at(strikes, 0) : forward;
    let bestDistance = Math.abs(atmStrike - forward);
    for (const K of strikes) {
      const d = Math.abs(K - forward);
      if (d < bestDistance) {
        bestDistance = d;
        atmStrike = K;
      }
    }

    const ks = points.map((p) => p.logMoneyness);
    const kMin = ks.reduce((lo, k) => Math.min(lo, k), Number.POSITIVE_INFINITY);
    const kMax = ks.reduce((hi, k) => Math.max(hi, k), Number.NEGATIVE_INFINITY);

    slices.push(
      Object.freeze({
        expiry: chainExpiry.expiry,
        T,
        days,
        forward,
        forwardDetail,
        atmStrike,
        atmIv: sviImpliedVol(shape, 0, T),
        svi: fit.svi,
        fitObjective: fit.objective,
        maxAbsResidual: fit.maxAbsResidual,
        butterfly,
        points: Object.freeze(points),
        skipped: Object.freeze(skipped),
      }),
    );
    forCalendar.push({ expiry: chainExpiry.expiry, T, svi: shape, kMin, kMax });
  }

  slices.sort((x, y) => x.T - y.T);
  const calendar = calendarCheck(forCalendar);

  const front = slices[0];
  const back = slices[slices.length - 1];
  if (front === undefined || back === undefined) {
    throw new RangeError('vol.surface: no slice could be fitted');
  }

  const butterflyArbitrage = slices.some((s) => !s.butterfly.arbitrageFree);
  const minButterflyG = slices.reduce(
    (lo, s) => Math.min(lo, s.butterfly.minG),
    Number.POSITIVE_INFINITY,
  );
  const maxRmse = slices.reduce((hi, s) => Math.max(hi, s.svi.rmse), 0);
  const nQuotes = slices.reduce((total, s) => total + s.svi.n, 0);

  return Object.freeze({
    underlying,
    asOf,
    slices: Object.freeze(slices),
    calendar,
    arbitrageFree: !butterflyArbitrage && calendar.arbitrageFree,
    butterflyArbitrage,
    calendarArbitrage: !calendar.arbitrageFree,
    minButterflyG,
    minCalendarGap: calendar.minGap,
    maxRmse,
    nSlices: slices.length,
    nQuotes,
    frontExpiry: front.expiry,
    frontT: front.T,
    frontForward: front.forward,
    frontAtmIv: front.atmIv,
    frontRmse: front.svi.rmse,
    backExpiry: back.expiry,
    backT: back.T,
    backForward: back.forward,
    backAtmIv: back.atmIv,
    backRmse: back.svi.rmse,
    conventions: VOL_SURFACE_CONVENTIONS,
  });
}

/**
 * `vol.surface@1.0.0` — the engine the golden case
 * `fixtures/golden/analytics/vol/aapl-slice.json` is pinned to. A version bump must re-bless it
 * (TESTING §7.1).
 */
export const volSurfaceEngine = defineEngine<VolSurfaceInputs, VolSurfaceOutputs>(
  'vol.surface',
  '1.0.0',
  (i) =>
    volSurface({
      underlying: i.underlying,
      asOf: i.asOf,
      spot: i.spot,
      rate: i.rate,
      dividendYield: i.dividendYield,
      expiries: i.expiries,
      ...(i.ivSource === undefined ? {} : { ivSource: i.ivSource }),
    }),
);
