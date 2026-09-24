/**
 * Curve bootstrap — WORKPLAN §WP-02 L503-506, ANAL-02, TESTING §7.7.
 *
 * Two builds live here, both wrapped in `defineEngine` so every build carries the `inputsHash`
 * written to `curve_builds.inputs_hash` (ANAL-08):
 *
 *  - **`curve.bootstrap`** (`method = 'bills+par_bootstrap'`) — Treasury bills and par coupon bonds
 *    to discount factors. A bill is a *known* node (its discount factor is its quoted price), a par
 *    bond is a *solved* node: the discount factor at its maturity that reprices it to exactly 100.
 *  - **`curve.ois.bootstrap`** (`method = 'ois_bootstrap'`) — a SOFR OIS curve from the overnight
 *    fixing plus par OIS rates: annual fixed, ACT/360, T+2, modified following, SIFMA (WORKPLAN
 *    L507). The daily-compounded float leg of a single-curve OIS telescopes to `df(start) − df(end)`,
 *    which is what makes the par condition a one-unknown root find.
 *
 * ## Why this is an *iterative* bootstrap, not a closed-form cascade
 *
 * The textbook cascade ("solve each node from the previous ones") is only valid when every
 * intermediate cash flow lands on a node and the interpolation is local. Neither holds here: a 10Y
 * par bond pays at 0.5, 1.0, … 9.5 — mostly *between* nodes — and `monotone_convex` is not local
 * (a node's discrete forward reaches back into the previous interval through the node forwards).
 * So each instrument's discount factor is solved by a bracketed root find *through the live
 * interpolation*, and the whole node set is then swept Gauss-Seidel until every instrument reprices.
 * For `linear_zero` and `log_linear_df` the second sweep is already a no-op; for `monotone_convex`
 * it is what makes TESTING §7.7's "interpolation may change values *between* nodes, never *at* them"
 * true rather than aspirational.
 *
 * ## The time axis
 *
 * `t` is a year fraction from the curve date on the curve's own day count:
 *
 *  - `ACT/ACT` (the par curve) is ICMA — actual days in the coupon period over
 *    `period days × frequency` — so a **regular** semiannual coupon date sits at exactly `k/2` and a
 *    date inside a period interpolates within it. That exactness is what makes TESTING §7.7's
 *    closed-form anchors (`df(1) = 1.025⁻²` for a flat 5 % par curve) hold to 1e-12 rather than to
 *    "whatever 181/365 gives". The par schedule is therefore **unadjusted**: a par *yield* is a
 *    quoting convention on an idealised schedule, not a settlement on a traded bond.
 *  - `ACT/360` (bills, OIS) is actual days over 360, on the **adjusted** payment dates, because an
 *    OIS actually pays on them.
 *
 * Rates cross this module's boundary in **percent** (`4.00` is 4 %), matching `curve_points.value`
 * and TESTING §7.7's quotes; everything inside `Curve` is a decimal fraction. The conversion happens
 * once, here, and is named at every site.
 *
 * No `Date`, no I/O, no dependency beyond the other core modules (ARCHITECTURE L49).
 */

import type { Calendar, IsoDate } from '../../calendars/calendar.js';
import { addDays, addMonths, daysBetween, getCalendar } from '../../calendars/calendar.js';
import { SIFMA } from '../../calendars/sifma.js';
import { addTenor, parseTenor, tryParseTenor } from '../../calendars/tenor.js';
import type { BusinessDayConvention } from '../../daycount/businessDay.js';
import { adjustDate, businessDayConvention, settlementDate } from '../../daycount/businessDay.js';
import type { DayCountId } from '../../daycount/conventions.js';
import type { CompoundingName, Conventions, EngineResult, InterpolationName } from '../engine.js';
import { defineEngine } from '../engine.js';

import type { Curve, CurveNode } from './curve.js';
import { makeCurve } from './curve.js';
import type { DfPoint } from './interp.js';
import { interpolationName } from './interp.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Percent
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `4.00` (percent, as quoted) → `0.04` (decimal, as the curve works in). */
function fromPercent(percent: number, what: string): number {
  if (!Number.isFinite(percent)) {
    throw new RangeError(`${what} must be a finite percent, got ${String(percent)}`);
  }
  return percent / 100;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Root finding
// ─────────────────────────────────────────────────────────────────────────────────────────────

const BRENT_MAX_ITER = 200;

/**
 * Brent's method on `[a, b]` with `f(a)` and `f(b)` of opposite signs — inverse quadratic
 * interpolation with a bisection guarantee, so it converges for every bracket it is handed and
 * never wanders off one (Brent 1973, *Algorithms for Minimization without Derivatives*, ch. 4).
 *
 * The bootstrap needs the root to machine precision: a discount factor is multiplied by ~100 to get
 * a price, and TESTING §7.7 wants that price at 1e-10 or better.
 */
function brent(f: (x: number) => number, a: number, b: number): number {
  let lo = a;
  let hi = b;
  let fLo = f(lo);
  let fHi = f(hi);
  if (fLo === 0) return lo;
  if (fHi === 0) return hi;
  if (fLo * fHi > 0) {
    throw new RangeError(
      `brent: the bracket [${String(a)}, ${String(b)}] does not straddle a root ` +
        `(f = ${String(fLo)}, ${String(fHi)})`,
    );
  }
  let c = lo;
  let fC = fLo;
  let d = hi - lo;
  let e = d;
  for (let iter = 0; iter < BRENT_MAX_ITER; iter += 1) {
    if (fHi * fC > 0) {
      c = lo;
      fC = fLo;
      d = hi - lo;
      e = d;
    }
    if (Math.abs(fC) < Math.abs(fHi)) {
      lo = hi;
      hi = c;
      c = lo;
      fLo = fHi;
      fHi = fC;
      fC = fLo;
    }
    const tol = 2 * Number.EPSILON * Math.abs(hi) + 1e-16;
    const half = 0.5 * (c - hi);
    if (Math.abs(half) <= tol || fHi === 0) return hi;
    if (Math.abs(e) >= tol && Math.abs(fLo) > Math.abs(fHi)) {
      const s = fHi / fLo;
      let p: number;
      let q: number;
      if (lo === c) {
        p = 2 * half * s;
        q = 1 - s;
      } else {
        const r = fHi / fC;
        const t = fLo / fC;
        p = s * (2 * half * t * (t - r) - (hi - lo) * (r - 1));
        q = (t - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      const acceptable =
        2 * p < Math.min(3 * half * q - Math.abs(tol * q), Math.abs(e * q));
      if (acceptable) {
        e = d;
        d = p / q;
      } else {
        d = half;
        e = d;
      }
    } else {
      d = half;
      e = d;
    }
    lo = hi;
    fLo = fHi;
    hi += Math.abs(d) > tol ? d : half > 0 ? tol : -tol;
    fHi = f(hi);
  }
  throw new RangeError(`brent: no convergence in ${String(BRENT_MAX_ITER)} iterations`);
}

/** The widest discount factor a sane curve node can take: deeply negative to deeply positive rates. */
const DF_FLOOR = 1e-9;
const DF_CEILING = 5;

/**
 * Widen a bracket around `guess` until `f` changes sign, then hand it to Brent. `f` must be
 * increasing in the discount factor, which it is for every instrument here: raising a node's
 * discount factor raises the present value of everything discounted at or near it.
 */
function solveDf(f: (df: number) => number, guess: number): number {
  let lo = Math.max(DF_FLOOR, guess * 0.9);
  let hi = Math.min(DF_CEILING, Math.max(guess * 1.1, guess + 1e-6));
  let fLo = f(lo);
  let fHi = f(hi);
  for (let i = 0; i < 60 && fLo * fHi > 0; i += 1) {
    if (fLo > 0) {
      hi = lo;
      fHi = fLo;
      lo = Math.max(DF_FLOOR, lo * 0.5);
      fLo = f(lo);
    } else {
      lo = hi;
      fLo = fHi;
      hi = Math.min(DF_CEILING, hi * 1.5);
      fHi = f(hi);
    }
    if (lo <= DF_FLOOR && hi >= DF_CEILING) break;
  }
  if (fLo * fHi > 0) {
    throw new RangeError(
      `bootstrap: no discount factor in [${String(DF_FLOOR)}, ${String(DF_CEILING)}] reprices the ` +
        `instrument (residuals ${String(fLo)} … ${String(fHi)}) — check the quote`,
    );
  }
  return brent(f, lo, hi);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The generic sequential-then-sweep bootstrap
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One thing the curve must reprice. `residual(curve)` is zero when it does. */
interface BootstrapInstrument {
  /** Human label used in error messages and keyed outputs: `'2Y'`, `'13W'`. */
  readonly id: string;
  /** The node year fraction this instrument pins — its maturity. */
  readonly t: number;
  /** The discount factor when it is known outright (a bill), rather than solved. */
  readonly knownDf?: number;
  /** Value minus target; must be increasing in `df(t)`. */
  residual(curve: Curve): number;
  /** A starting discount factor, used to seed the bracket. */
  readonly guess: number;
}

/** How exactly the swept curve must reprice its own inputs before the build is accepted. */
const RESIDUAL_TOLERANCE = 1e-12;
const MAX_SWEEPS = 64;

interface SolvedNodes {
  readonly points: readonly DfPoint[];
  /** Sweeps taken after the initial sequential pass. */
  readonly sweeps: number;
  /** The largest `|residual|` over all instruments at the accepted solution. */
  readonly maxResidual: number;
}

function solveNodeSet(
  instruments: readonly BootstrapInstrument[],
  spec: {
    readonly curveId: string;
    readonly curveDate: IsoDate;
    readonly dayCount: DayCountId;
    readonly compounding: CompoundingName;
    readonly interpolation: InterpolationName;
    readonly frequency?: number;
  },
): SolvedNodes {
  if (instruments.length === 0) {
    throw new RangeError('bootstrap: at least one instrument is required');
  }
  const sorted = [...instruments].sort((x, y) => x.t - y.t);
  let previous = 0;
  for (const instrument of sorted) {
    if (!(instrument.t > previous)) {
      throw new RangeError(
        `bootstrap: instrument ${instrument.id} has t = ${String(instrument.t)}, which does not ` +
          `follow the previous node at ${String(previous)} — two instruments share a maturity`,
      );
    }
    previous = instrument.t;
  }

  const dfs = sorted.map((instrument) => instrument.knownDf ?? instrument.guess);
  const curveOver = (count: number): Curve =>
    makeCurve({
      curveId: spec.curveId,
      curveDate: spec.curveDate,
      dayCount: spec.dayCount,
      compounding: spec.compounding,
      interpolation: spec.interpolation,
      ...(spec.frequency === undefined ? {} : { frequency: spec.frequency }),
      points: sorted.slice(0, count).map((instrument, i) => ({
        t: instrument.t,
        df: dfs[i] ?? instrument.guess,
      })),
    });

  // Pass 1 — sequential. Each node is solved over the curve built from the nodes up to and
  // including it, so a later quote can never perturb an earlier solve before it exists.
  for (let i = 0; i < sorted.length; i += 1) {
    const instrument = sorted[i];
    if (instrument === undefined) continue;
    if (instrument.knownDf !== undefined) {
      dfs[i] = instrument.knownDf;
      continue;
    }
    dfs[i] = solveDf((df) => {
      dfs[i] = df;
      return instrument.residual(curveOver(i + 1));
    }, instrument.guess);
  }

  // Passes 2… — Gauss-Seidel over the whole node set. A no-op for the local interpolations; the
  // fixed point that makes `monotone_convex` reprice every input exactly.
  const residualsOf = (): number => {
    const curve = curveOver(sorted.length);
    let worst = 0;
    for (const instrument of sorted) {
      worst = Math.max(worst, Math.abs(instrument.residual(curve)));
    }
    return worst;
  };
  let sweeps = 0;
  let maxResidual = residualsOf();
  while (maxResidual > RESIDUAL_TOLERANCE && sweeps < MAX_SWEEPS) {
    for (let i = 0; i < sorted.length; i += 1) {
      const instrument = sorted[i];
      if (instrument === undefined || instrument.knownDf !== undefined) continue;
      const current = dfs[i] ?? instrument.guess;
      dfs[i] = solveDf((df) => {
        dfs[i] = df;
        return instrument.residual(curveOver(sorted.length));
      }, current);
    }
    sweeps += 1;
    maxResidual = residualsOf();
  }
  if (maxResidual > RESIDUAL_TOLERANCE) {
    throw new RangeError(
      `bootstrap: the ${spec.interpolation} node set did not converge in ${String(MAX_SWEEPS)} ` +
        `sweeps — worst residual ${String(maxResidual)}`,
    );
  }

  const points: DfPoint[] = sorted.map((instrument, i) => ({
    t: instrument.t,
    df: dfs[i] ?? instrument.guess,
  }));
  return { points, sweeps, maxResidual };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The par-bond time grid (ACT/ACT ICMA)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Months in a tenor that must be a whole number of months (`'6M'`, `'2Y'`). */
function tenorMonths(tenor: string): number {
  const parsed = parseTenor(tenor);
  switch (parsed.unit) {
    case 'Y':
      return parsed.n * 12;
    case 'M':
      return parsed.n;
    default:
      throw new RangeError(
        `bootstrap: par tenor ${tenor} must be a whole number of months or years`,
      );
  }
}

/**
 * The maturity of a par quote that matures **before the first coupon date**, or `null` when the
 * quote is an ordinary coupon bond and the schedule path handles it.
 *
 * The maturity comes from the tenor label — `addMonths`, exactly as `couponDates` derives every
 * other par node's maturity, so the short end and the coupon end measure time the same way — except
 * for a label that is not whole months (`'1.5M'`), where `quote.days` is the only thing that says
 * what the tenor means and the quote must carry it.
 */
function stubMaturity(
  curveDate: IsoDate,
  quote: ParQuote,
  monthsPerPeriod: number,
): IsoDate | null {
  const firstCoupon = addMonths(curveDate, monthsPerPeriod);
  if (quote.days !== undefined) {
    if (!Number.isInteger(quote.days) || quote.days <= 0) {
      throw new RangeError(
        `curve.bootstrap: par quote ${quote.tenor} needs a positive whole number of days`,
      );
    }
    const maturity = addDays(curveDate, quote.days);
    return maturity < firstCoupon ? maturity : null;
  }
  const parsed = tryParseTenor(quote.tenor);
  if (parsed === undefined) {
    throw new RangeError(
      `curve.bootstrap: par quote ${quote.tenor} is not a whole number of months or years, so it ` +
        'must carry its `days`',
    );
  }
  if (parsed.unit === 'D' || parsed.unit === 'W') {
    // A day or week tenor is never a whole number of coupon periods: it is a money-market point or
    // it is nothing, and `tenorMonths` would only raise on it.
    const days = parsed.unit === 'W' ? parsed.n * 7 : parsed.n;
    if (days <= 0) return null;
    const maturity = addDays(curveDate, days);
    return maturity < firstCoupon ? maturity : null;
  }
  const months = parsed.unit === 'Y' ? parsed.n * 12 : parsed.n;
  if (months <= 0 || months >= monthsPerPeriod) return null;
  return addMonths(curveDate, months);
}

/** The unadjusted coupon dates of a par bond, `curveDate` excluded, maturity included. */
function couponDates(curveDate: IsoDate, months: number, frequency: number): IsoDate[] {
  const monthsPerPeriod = 12 / frequency;
  if (!Number.isInteger(monthsPerPeriod)) {
    throw new RangeError(`bootstrap: frequency ${String(frequency)} does not divide 12 months`);
  }
  const periods = months / monthsPerPeriod;
  if (!Number.isInteger(periods) || periods < 1) {
    throw new RangeError(
      `bootstrap: a ${String(months)}-month tenor is not a whole number of ` +
        `${String(frequency)}/yr coupon periods`,
    );
  }
  const dates: IsoDate[] = [];
  for (let k = 1; k <= periods; k += 1) {
    dates.push(addMonths(curveDate, k * monthsPerPeriod));
  }
  return dates;
}

/**
 * The ACT/ACT **ICMA** year fraction from `curveDate` to `date` on a regular `frequency`/yr schedule
 * anchored at `curveDate`: whole periods count `1/frequency` each — exactly — and the stub inside
 * the last period is actual days over `period days × frequency`.
 */
export function icmaYearFraction(curveDate: IsoDate, date: IsoDate, frequency: number): number {
  const monthsPerPeriod = 12 / frequency;
  if (!Number.isInteger(monthsPerPeriod)) {
    throw new RangeError(`icmaYearFraction: frequency ${String(frequency)} does not divide 12`);
  }
  const total = daysBetween(curveDate, date);
  if (total < 0) {
    throw new RangeError(`icmaYearFraction: ${date} precedes the curve date ${curveDate}`);
  }
  if (total === 0) return 0;
  let periodStart = curveDate;
  for (let k = 1; k <= 2000; k += 1) {
    const periodEnd = addMonths(curveDate, k * monthsPerPeriod);
    const elapsed = daysBetween(periodStart, date);
    const periodDays = daysBetween(periodStart, periodEnd);
    if (daysBetween(date, periodEnd) >= 0) {
      return (k - 1) / frequency + elapsed / (periodDays * frequency);
    }
    periodStart = periodEnd;
  }
  throw new RangeError(`icmaYearFraction: ${date} is more than 2000 periods from ${curveDate}`);
}

/** Actual days over a fixed denominator — `ACT/360` for bills and OIS, `ACT/365F` if ever asked. */
function fixedYearFraction(curveDate: IsoDate, date: IsoDate, denominator: number): number {
  return daysBetween(curveDate, date) / denominator;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Par bond pricing on a curve
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A par coupon bond as the bootstrap sees it: coupon times and the coupon itself. */
export interface ParBondSchedule {
  /** Year fractions of every coupon payment, ascending; the last one is the maturity. */
  readonly times: readonly number[];
  /** Coupons per year. */
  readonly frequency: number;
}

/**
 * Clean price per 100 of a bond paying `couponRate` (decimal per annum) on `schedule`, discounted
 * on `curve`. Settlement is the curve date and the schedule starts there, so there is no accrued
 * interest and clean = dirty — which is the whole point of a *par* quote.
 */
export function parBondPrice(
  curve: Curve,
  schedule: ParBondSchedule,
  couponRate: number,
): number {
  const coupon = (100 * couponRate) / schedule.frequency;
  let pv = 0;
  for (const t of schedule.times) pv += coupon * curve.df(t);
  const maturity = schedule.times[schedule.times.length - 1];
  if (maturity === undefined) throw new RangeError('parBondPrice: the schedule is empty');
  return pv + 100 * curve.df(maturity);
}

/**
 * The coupon (decimal per annum) that prices `schedule` at exactly 100 on `curve`:
 * `c = frequency · (1 − df(T)) / Σ df(tₖ)` — the par rate, the inverse of {@link parBondPrice}.
 */
export function impliedParRate(curve: Curve, schedule: ParBondSchedule): number {
  let annuity = 0;
  for (const t of schedule.times) annuity += curve.df(t);
  const maturity = schedule.times[schedule.times.length - 1];
  if (maturity === undefined) throw new RangeError('impliedParRate: the schedule is empty');
  if (annuity <= 0) throw new RangeError('impliedParRate: non-positive annuity');
  return (schedule.frequency * (1 - curve.df(maturity))) / annuity;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// curve.bootstrap — bills + par coupon bonds
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A Treasury bill quote: the discount rate that *is* its price (ACT/360, discount basis). */
export interface BillQuote {
  /** Label for the node — `'4W'`, `'13W'`, `'52W'`. */
  readonly tenor: string;
  /** Actual days from the curve date to maturity. */
  readonly days: number;
  /** Bank-discount rate in **percent** (`4.28` is 4.28 %). */
  readonly discountRate: number;
}

/** A par coupon quote: the yield at which the bond of that tenor trades at exactly 100. */
export interface ParQuote {
  /**
   * `'1Y'`, `'2Y'`, `'10Y'` — a whole number of coupon periods — or a tenor **shorter than one**
   * coupon period (`'1M'`, `'2M'`, `'3M'`, `'4M'`), which is bootstrapped as a money-market point.
   */
  readonly tenor: string;
  /** Par yield in **percent** (`4.00` is 4.00 %). */
  readonly parRate: number;
  /**
   * Actual days to maturity, needed **only** when the tenor label cannot express the maturity as
   * whole months — the Treasury's `1.5M` point is the one case in this system. Every other par
   * quote takes its maturity from the label, exactly as the coupon schedule does, so passing this
   * where it is not needed would change `inputs_hash` for no gain.
   */
  readonly days?: number;
}

/** `curve.bootstrap` inputs — exactly what `curve_builds.inputs` stores (ANAL-08). */
export interface ParBootstrapInputs {
  /** `curves.curve_id`, e.g. `'UST_PAR'`. */
  readonly curveId: string;
  /** `curve_builds.curve_date`. */
  readonly curveDate: IsoDate;
  /** Par coupon quotes, ascending in tenor. */
  readonly parQuotes: readonly ParQuote[];
  /** Bill quotes for the short end, if any. */
  readonly bills?: readonly BillQuote[];
  /** Coupons per year; `2` for every US Treasury note and bond. */
  readonly frequency?: number;
  /** `curves.day_count`; `'ACT/ACT'` (ICMA) for the par curve. */
  readonly dayCount?: DayCountId;
  /** `curves.compounding`; `'semiannual'` bond basis. */
  readonly compounding?: CompoundingName;
  /** `curves.default_interpolation`. */
  readonly interpolation?: InterpolationName;
  readonly [key: string]: unknown;
}

/** What a build returns — the `nodes` are exactly `curve_builds.nodes`. */
export interface CurveBuildOutputs {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  /** `curve_builds.method`. */
  readonly method: 'bills+par_bootstrap' | 'ois_bootstrap';
  readonly interpolation: InterpolationName;
  /** `[{t, df, zero, fwd}]`, one per input instrument. */
  readonly nodes: readonly CurveNode[];
  /** The live curve: `df(t)`, `zero(t)`, `fwd(t1,t2)`, `snapshot()`. */
  readonly curve: Curve;
  /** The conventions the build ran under, echoed into the output (ANAL-07). */
  readonly conventions: Conventions;
  /** Gauss-Seidel sweeps past the sequential pass; `0` for a local interpolation. */
  readonly sweeps: number;
  /** Worst `|value − target|` over the inputs at the accepted node set, in price/PV units. */
  readonly maxResidual: number;
}

const DEFAULT_PAR_FREQUENCY = 2;

/**
 * Bills plus par coupon bonds to discount factors (ANAL-02).
 *
 * Each bill contributes a node outright — its discount factor is `1 − d·days/360`, the price it is
 * quoted at. Each par bond contributes a node solved so that the bond, discounted on the curve
 * being built, is worth exactly 100.
 *
 * **Par quotes shorter than one coupon period are money-market points.** The Treasury publishes
 * fourteen par tenors and five of them — `1M`, `1.5M`, `2M`, `3M`, `4M` — mature before the first
 * semiannual coupon date, so there is no coupon bond to solve: the instrument is a single payment
 * at maturity and its quote is simple interest on it, `df = 1 / (1 + y·t)` on the curve's own year
 * fraction. Treating them as coupon bonds is what made `couponDates` raise on "a 1-month tenor is
 * not a whole number of 2/yr coupon periods", and that raise took the whole build down: every
 * screen that prices off `UST_PAR` (CRVF, YAS's curve mode, SRCH's analytics block, GC) fell back
 * to terms-only on the output of this system's own ingest job, which writes all fourteen tenors.
 * A tenor of one period or more that is *not* a whole number of them still raises — a 9M par bond
 * has a coupon in between and simple interest would be a different instrument, not a stub.
 */
export const parCurveBootstrapEngine = defineEngine<ParBootstrapInputs, CurveBuildOutputs>(
  'curve.bootstrap',
  '1.0.0',
  (inputs) => {
    const frequency = inputs.frequency ?? DEFAULT_PAR_FREQUENCY;
    const dayCount: DayCountId = inputs.dayCount ?? 'ACT/ACT';
    const compounding: CompoundingName = inputs.compounding ?? 'semiannual';
    const interpolation = interpolationName(inputs.interpolation);
    const curveDate = inputs.curveDate;
    if (inputs.parQuotes.length === 0 && (inputs.bills ?? []).length === 0) {
      throw new RangeError('curve.bootstrap: no bills and no par quotes');
    }

    const timeOf = (date: IsoDate): number =>
      dayCount === 'ACT/360'
        ? fixedYearFraction(curveDate, date, 360)
        : dayCount === 'ACT/365F'
          ? fixedYearFraction(curveDate, date, 365)
          : icmaYearFraction(curveDate, date, frequency);

    const instruments: BootstrapInstrument[] = [];

    for (const bill of inputs.bills ?? []) {
      if (!Number.isInteger(bill.days) || bill.days <= 0) {
        throw new RangeError(
          `curve.bootstrap: bill ${bill.tenor} needs a positive whole number of days`,
        );
      }
      // Bank discount basis: price per 1 = 1 − d · days/360, and for spot settlement that price
      // *is* the discount factor to the bill's maturity.
      const df = 1 - fromPercent(bill.discountRate, `bill ${bill.tenor} discountRate`) * (bill.days / 360);
      if (!(df > 0)) {
        throw new RangeError(`curve.bootstrap: bill ${bill.tenor} prices to a non-positive df`);
      }
      const t = timeOf(addDays(curveDate, bill.days));
      instruments.push({ id: bill.tenor, t, knownDf: df, guess: df, residual: () => 0 });
    }

    const monthsPerPeriod = 12 / frequency;
    for (const quote of inputs.parQuotes) {
      // A quote that matures before the first coupon date: one payment, simple interest, no
      // schedule to solve. Known outright, like a bill, so the sweep never touches it.
      const stub = stubMaturity(curveDate, quote, monthsPerPeriod);
      if (stub !== null) {
        const rate = fromPercent(quote.parRate, `par quote ${quote.tenor}`);
        const t = timeOf(stub);
        if (!(t > 0)) {
          throw new RangeError(
            `curve.bootstrap: par quote ${quote.tenor} matures on the curve date ${curveDate}`,
          );
        }
        const df = 1 / (1 + rate * t);
        if (!(df > 0) || !Number.isFinite(df)) {
          throw new RangeError(
            `curve.bootstrap: par quote ${quote.tenor} prices to a non-positive df`,
          );
        }
        instruments.push({ id: quote.tenor, t, knownDf: df, guess: df, residual: () => 0 });
        continue;
      }
      const months = tenorMonths(quote.tenor);
      const dates = couponDates(curveDate, months, frequency);
      const times = dates.map(timeOf);
      const maturity = times[times.length - 1];
      if (maturity === undefined) {
        throw new RangeError(`curve.bootstrap: par quote ${quote.tenor} has no coupon dates`);
      }
      const couponRate = fromPercent(quote.parRate, `par quote ${quote.tenor}`);
      const schedule: ParBondSchedule = { times, frequency };
      instruments.push({
        id: quote.tenor,
        t: maturity,
        guess: Math.pow(1 + couponRate / frequency, -frequency * maturity),
        residual: (curve) => parBondPrice(curve, schedule, couponRate) - 100,
      });
    }

    const solved = solveNodeSet(instruments, {
      curveId: inputs.curveId,
      curveDate,
      dayCount,
      compounding,
      interpolation,
      frequency,
    });
    const curve = makeCurve({
      curveId: inputs.curveId,
      curveDate,
      dayCount,
      compounding,
      interpolation,
      frequency,
      points: solved.points,
    });
    return {
      curveId: inputs.curveId,
      curveDate,
      method: 'bills+par_bootstrap',
      interpolation,
      nodes: Object.freeze(curve.snapshot()),
      curve,
      conventions: curve.conventions,
      sweeps: solved.sweeps,
      maxResidual: solved.maxResidual,
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// curve.ois.bootstrap — SOFR fixings + par OIS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One published overnight fixing (`rate_fixings`): a rate in **percent**, ACT/360. */
export interface OisFixing {
  /** The fixing's *effective* date. */
  readonly date: IsoDate;
  /** The overnight rate in percent (`5.31` is 5.31 %). */
  readonly rate: number;
}

/** A par OIS quote: the annual fixed rate that makes the swap worth zero. */
export interface OisQuote {
  /** `'1Y'`, `'2Y'`, `'5Y'`, `'10Y'`. */
  readonly tenor: string;
  /** Par rate in **percent**. */
  readonly parRate: number;
}

/** `curve.ois.bootstrap` inputs. */
export interface OisBootstrapInputs {
  /** `curves.curve_id`, e.g. `'SOFR_OIS'`. */
  readonly curveId: string;
  readonly curveDate: IsoDate;
  /** Published SOFR fixings; the one dated on or before the curve date anchors the O/N node. */
  readonly fixings: readonly OisFixing[];
  /** Par OIS quotes, ascending in tenor. */
  readonly quotes: readonly OisQuote[];
  /** `curves.default_interpolation`; `'log_linear_df'` by default. */
  readonly interpolation?: InterpolationName;
  /** Fixed-leg payments per year; annual (WORKPLAN L507). */
  readonly fixedFrequency?: number;
  /** Business days from the curve date to the swap start; T+2. */
  readonly settlementDays?: number;
  /** `govt_terms.business_day_conv`; modified following. */
  readonly businessDayConvention?: BusinessDayConvention;
  /** Settlement calendar id; SIFMA. */
  readonly calendar?: string;
  readonly [key: string]: unknown;
}

const DEFAULT_OIS_FIXED_FREQUENCY = 1;
const DEFAULT_OIS_SETTLEMENT_DAYS = 2;

function resolveCalendar(id: string | undefined): Calendar {
  if (id === undefined || id === SIFMA.id) return SIFMA;
  return getCalendar(id);
}

/** One fixed-leg payment of an OIS, on the curve's `ACT/360` time axis. */
export interface OisPayment {
  /** The adjusted payment date. */
  readonly date: IsoDate;
  /** Year fraction from the curve date to `date`, ACT/360. */
  readonly t: number;
  /** ACT/360 accrual from the previous adjusted date (the start date for the first period). */
  readonly accrual: number;
}

/** A spot-starting OIS schedule: the start leg plus the annual fixed payments. */
export interface OisSchedule {
  /** T+2 from the curve date on the settlement calendar. */
  readonly start: IsoDate;
  /** Year fraction from the curve date to `start`, ACT/360. */
  readonly startTime: number;
  readonly payments: readonly OisPayment[];
  /** The last payment — the swap's maturity. */
  readonly maturity: OisPayment;
}

/** How an OIS schedule rolls: WORKPLAN L507's T+2, modified following, SIFMA, annual fixed. */
export interface OisScheduleConventions {
  readonly fixedFrequency: number;
  readonly settlementDays: number;
  readonly businessDayConvention: BusinessDayConvention;
  readonly calendar: Calendar;
}

/**
 * The fixed-leg schedule of a spot-starting OIS of `tenor` (WORKPLAN L507: annual fixed, ACT/360,
 * T+2, modified following, SIFMA). Exported so a test can reprice the very swap the bootstrap
 * solved, rather than a re-derived approximation of it.
 */
export function oisScheduleOf(
  curveDate: IsoDate,
  tenor: string,
  conventions: OisScheduleConventions,
): OisSchedule {
  const monthsPerPeriod = 12 / conventions.fixedFrequency;
  if (!Number.isInteger(monthsPerPeriod)) {
    throw new RangeError(
      `oisScheduleOf: fixedFrequency ${String(conventions.fixedFrequency)} does not divide 12 months`,
    );
  }
  const periods = tenorMonths(tenor) / monthsPerPeriod;
  if (!Number.isInteger(periods) || periods < 1) {
    throw new RangeError(
      `oisScheduleOf: ${tenor} is not a whole number of ` +
        `${String(conventions.fixedFrequency)}/yr fixed periods`,
    );
  }
  const start = settlementDate(conventions.calendar, curveDate, conventions.settlementDays);
  const payments: OisPayment[] = [];
  let accrualStart = start;
  for (let k = 1; k <= periods; k += 1) {
    const unadjusted = addTenor(start, parseTenor(`${String(k * monthsPerPeriod)}M`));
    const date = adjustDate(conventions.calendar, unadjusted, conventions.businessDayConvention);
    payments.push({
      date,
      t: fixedYearFraction(curveDate, date, 360),
      accrual: fixedYearFraction(accrualStart, date, 360),
    });
    accrualStart = date;
  }
  const maturity = payments[payments.length - 1];
  if (maturity === undefined) throw new RangeError(`oisScheduleOf: ${tenor} produced no payments`);
  return {
    start,
    startTime: fixedYearFraction(curveDate, start, 360),
    payments,
    maturity,
  };
}

/**
 * PV per 1 of notional of a **payer** OIS on `curve`: the daily-compounded float leg, which
 * telescopes to `df(start) − df(maturity)`, less the annual fixed leg `R·Σ τᵢ·df(tᵢ)`.
 */
export function oisPv(curve: Curve, schedule: OisSchedule, fixedRate: number): number {
  let annuity = 0;
  for (const payment of schedule.payments) annuity += payment.accrual * curve.df(payment.t);
  const float = curve.df(schedule.startTime) - curve.df(schedule.maturity.t);
  return float - fixedRate * annuity;
}

/** The fixed rate that makes {@link oisPv} zero on `curve`. */
export function oisParRate(curve: Curve, schedule: OisSchedule): number {
  let annuity = 0;
  for (const payment of schedule.payments) annuity += payment.accrual * curve.df(payment.t);
  if (annuity <= 0) throw new RangeError('oisParRate: non-positive annuity');
  return (curve.df(schedule.startTime) - curve.df(schedule.maturity.t)) / annuity;
}

/**
 * SOFR OIS bootstrap (ANAL-02, WORKPLAN L503 and L507).
 *
 * The float leg of a single-curve OIS is the daily compounding of the overnight rate implied by the
 * discount curve, and that product telescopes exactly:
 *
 *     Σᵢ dfᵢ · (∏ⱼ(1 + rⱼ·τⱼ) − 1) = df(start) − df(end)
 *
 * so a par swap is `R · Σ τᵢ·df(tᵢ) = df(start) − df(end)` and each quote pins exactly one unknown
 * discount factor. The overnight fixing pins the first node outright: `df = 1/(1 + r·τ)` over the
 * one business day it covers, ACT/360 — the same simple-interest convention SOFR is published on.
 */
export const oisCurveBootstrapEngine = defineEngine<OisBootstrapInputs, CurveBuildOutputs>(
  'curve.ois.bootstrap',
  '1.0.0',
  (inputs) => {
    const interpolation = interpolationName(inputs.interpolation);
    const fixedFrequency = inputs.fixedFrequency ?? DEFAULT_OIS_FIXED_FREQUENCY;
    const settlementDays = inputs.settlementDays ?? DEFAULT_OIS_SETTLEMENT_DAYS;
    const bdc = businessDayConvention(inputs.businessDayConvention ?? 'modified_following');
    const calendar = resolveCalendar(inputs.calendar);
    const curveDate = inputs.curveDate;
    const monthsPerPeriod = 12 / fixedFrequency;
    if (!Number.isInteger(monthsPerPeriod)) {
      throw new RangeError(
        `curve.ois.bootstrap: fixedFrequency ${String(fixedFrequency)} does not divide 12 months`,
      );
    }
    const timeOf = (date: IsoDate): number => fixedYearFraction(curveDate, date, 360);

    // ── the overnight node, from the fixing effective on the curve date ───────────────────────
    const usable = inputs.fixings.filter((fixing) => daysBetween(fixing.date, curveDate) >= 0);
    const latest = usable.reduce<OisFixing | undefined>(
      (best, fixing) =>
        best === undefined || daysBetween(best.date, fixing.date) > 0 ? fixing : best,
      undefined,
    );
    if (latest === undefined) {
      throw new RangeError(
        `curve.ois.bootstrap: no SOFR fixing dated on or before ${curveDate} — the overnight node ` +
          'cannot be anchored',
      );
    }
    const overnightEnd = adjustDate(calendar, addDays(curveDate, 1), 'following');
    const overnightTime = timeOf(overnightEnd);
    const overnightRate = fromPercent(latest.rate, `SOFR fixing ${latest.date}`);
    const overnightDf = 1 / (1 + overnightRate * overnightTime);

    const instruments: BootstrapInstrument[] = [
      {
        id: 'O/N',
        t: overnightTime,
        knownDf: overnightDf,
        guess: overnightDf,
        residual: () => 0,
      },
    ];

    // ── the par swaps ─────────────────────────────────────────────────────────────────────────
    const scheduleConventions: OisScheduleConventions = {
      fixedFrequency,
      settlementDays,
      businessDayConvention: bdc,
      calendar,
    };
    for (const quote of inputs.quotes) {
      const schedule = oisScheduleOf(curveDate, quote.tenor, scheduleConventions);
      const rate = fromPercent(quote.parRate, `OIS quote ${quote.tenor}`);
      instruments.push({
        id: quote.tenor,
        t: schedule.maturity.t,
        guess: Math.exp(-rate * schedule.maturity.t),
        // Raising df(maturity) raises the fixed leg and lowers the float leg, so the residual is
        // increasing in the unknown — the monotonicity `solveDf` brackets against.
        residual: (curve) => -oisPv(curve, schedule, rate),
      });
    }

    const solved = solveNodeSet(instruments, {
      curveId: inputs.curveId,
      curveDate,
      dayCount: 'ACT/360',
      compounding: 'continuous',
      interpolation,
      frequency: fixedFrequency,
    });
    const curve = makeCurve({
      curveId: inputs.curveId,
      curveDate,
      dayCount: 'ACT/360',
      compounding: 'continuous',
      interpolation,
      frequency: fixedFrequency,
      points: solved.points,
    });
    const conventions: Conventions = Object.freeze({
      ...curve.conventions,
      businessDayConvention: bdc,
      calendar: calendar.id,
      settlementDays,
    });
    return {
      curveId: inputs.curveId,
      curveDate,
      method: 'ois_bootstrap',
      interpolation,
      nodes: Object.freeze(curve.snapshot()),
      curve,
      conventions,
      sweeps: solved.sweeps,
      maxResidual: solved.maxResidual,
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Convenience wrappers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Run {@link parCurveBootstrapEngine}; the result carries `inputsHash` (ANAL-08). */
export function bootstrapParCurve(
  inputs: ParBootstrapInputs,
  valuationTs: string,
): EngineResult<ParBootstrapInputs, CurveBuildOutputs> {
  return parCurveBootstrapEngine(inputs, valuationTs);
}

/** Run {@link oisCurveBootstrapEngine}; the result carries `inputsHash` (ANAL-08). */
export function bootstrapOisCurve(
  inputs: OisBootstrapInputs,
  valuationTs: string,
): EngineResult<OisBootstrapInputs, CurveBuildOutputs> {
  return oisCurveBootstrapEngine(inputs, valuationTs);
}

/**
 * The par bond schedule a `curve.bootstrap` quote of `tenor` defines, in the curve's own time axis.
 * Exported so a test can reprice an input without re-deriving the grid the engine used.
 */
export function parScheduleOf(
  curveDate: IsoDate,
  tenor: string,
  frequency = DEFAULT_PAR_FREQUENCY,
  dayCount: DayCountId = 'ACT/ACT',
): ParBondSchedule {
  const dates = couponDates(curveDate, tenorMonths(tenor), frequency);
  const times = dates.map((date) =>
    dayCount === 'ACT/360'
      ? fixedYearFraction(curveDate, date, 360)
      : dayCount === 'ACT/365F'
        ? fixedYearFraction(curveDate, date, 365)
        : icmaYearFraction(curveDate, date, frequency),
  );
  return { times, frequency };
}
