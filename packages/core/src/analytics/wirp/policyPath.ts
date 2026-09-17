/**
 * The implied policy path — WORKPLAN §WP-02 L513-514, ARCHITECTURE L172-173, the `WIRP` screen.
 *
 * ## Why the money-market curve and not fed funds futures
 *
 * BRIEF §2 L54-55: of the keyless sources this terminal is built on, **none** publishes fed funds
 * futures. CME FedWatch is explicitly listed among the "not reachable / not usable keyless"
 * endpoints, and there is no other venue for a 30-day fed funds future. What *is* available is the
 * money market itself — Treasury bills (`treasury.bills`), SOFR fixings (`nyfed.rates`) and the
 * Treasury/OIS curves bootstrapped from them (`core/analytics/curve/bootstrap.ts`). So WIRP here
 * derives the implied path the way a rates desk would from a curve rather than from futures:
 *
 *   1. The overnight rate is assumed to be **constant between FOMC decisions** and to change only
 *      on the day a decision takes effect. That is the one modelling assumption in this file, and
 *      it is the same assumption the futures-based screen makes — the futures version just reads
 *      the average off a contract instead of off a curve.
 *   2. Under that assumption the **forward rate over an inter-meeting period is the overnight rate
 *      the market expects to prevail over it**, because the money-market forward is by construction
 *      the rate that makes rolling overnight through the period worth the same as the term point:
 *      `df(t_i) / df(t_{i+1}) = 1 + r_i · (t_{i+1} − t_i)` on ACT/360 simple, which is exactly how an
 *      OIS float leg compounds. Reading `Curve.fwd` over `[effective_i, effective_{i+1}]` therefore
 *      *is* the implied policy rate after meeting `i` (field `WIRP_IMPL_RATE`).
 *   3. The implied **move** is that rate less the current target-range midpoint, in basis points,
 *      cumulative from today to the meeting (field `WIRP_MOVE_BP`,
 *      `(WIRP_IMPL_RATE − (TARGET_FROM + TARGET_TO)/2) × 100`).
 *   4. A move is never a fraction of a step in reality: the Committee moves in **25 bp increments**.
 *      A fractional implied move is read as a probability mixture of the two bracketing whole steps,
 *      which is the standard reading and the one the field definitions pin
 *      (`WIRP_PROB_HIKE` / `WIRP_PROB_CUT` / `WIRP_PROB_HOLD`, "the hold, hike and cut probabilities
 *      of one meeting sum to 100"). A cumulative move of −12.9 bp is −0.516 steps, i.e. a 51.6 %
 *      chance of at least one cut and 48.4 % of no change — the worked example in
 *      `fields/defs/analytic.ts`.
 *
 * ## Units
 *
 * Rates are **decimal fractions per annum** (`0.0425`, not `4.25`), as everywhere else in
 * `core/analytics` — percent is a presentation unit and belongs at the screen, which multiplies
 * `impliedRate` by 100 to render `WIRP_IMPL_RATE`. Moves are in **basis points**, because that is
 * the unit `WIRP_MOVE_BP` is declared in and a bp is a real unit rather than a rendering choice.
 * Probabilities are **fractions in [0, 1]**; the screen multiplies by 100 for the `pct` fields.
 *
 * No `Date`, no I/O, no dependency beyond the curve and day-count modules (ARCHITECTURE L49).
 */

import type { IsoDate } from '../../calendars/calendar.js';
import { addDays, compareDates, daysBetween, isIsoDate } from '../../calendars/calendar.js';
import type { DayCountId } from '../../daycount/conventions.js';
import { dayCount as dayCountConvention, isDayCountId } from '../../daycount/conventions.js';
import type { CompoundingName, Conventions, InterpolationName } from '../engine.js';
import { defineEngine } from '../engine.js';
import type { Curve } from '../curve/curve.js';
import { makeCurve } from '../curve/curve.js';
import type { DfPoint } from '../curve/interp.js';
import { isInterpolationName } from '../curve/interp.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One 25 bp increment, as a decimal rate. The Committee has not moved off this grid since 2008. */
export const DEFAULT_STEP_SIZE = 0.0025;

/** `DEFAULT_STEP_SIZE` in basis points — the unit `WIRP_MOVE_BP` is quoted in. */
export const DEFAULT_STEP_BP = DEFAULT_STEP_SIZE * 10_000;

/**
 * Calendar days from the FOMC decision to the day the new target range takes effect. The Committee
 * announces at the end of the second day and the directive is effective the following day, so the
 * inter-meeting period the forward must span starts one day after the decision date.
 */
export const DEFAULT_EFFECTIVE_LAG_DAYS = 1;

/** The money-market convention: ACT/360, simple, log-linear in the discount factor. */
export const DEFAULT_DAY_COUNT: DayCountId = 'ACT/360';
export const DEFAULT_COMPOUNDING: CompoundingName = 'simple';
export const DEFAULT_INTERPOLATION: InterpolationName = 'log_linear_df';

/**
 * Snapping tolerance, in **step counts**, applied to the fractional step count before it is split
 * into probabilities. A step count within this of a whole number is treated as that whole number.
 *
 * `1e-9` steps is `2.5e-13` in rate terms — 0.0000000025 bp, twelve orders of magnitude below the
 * smallest move anybody quotes and two orders above the `~1e-15` rate noise a bootstrapped
 * discount-factor round trip leaves behind. It removes double-rounding residue, never economic
 * information: a curve that genuinely implies 0.999 of a cut still reports 99.9 %, not 100 %.
 */
export const DEFAULT_STEP_EPSILON = 1e-9;

/** Guard: beyond this many whole steps either way the input is a mistake, not a policy path. */
const MAX_STEPS = 200;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Free functions (the symbols `fields/defs/analytic.ts` cites as this engine's sources)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `WIRP_IMPL_RATE` — the overnight rate the curve implies over `[t0, t1]`, decimal per annum.
 *
 * This is nothing more than `Curve.fwd` on the money-market convention, named for what it means on
 * the WIRP screen. `compounding` defaults to the curve's own, which for a bill/OIS curve is
 * `simple` (ACT/360), the basis on which the forward equals the expected compounded overnight
 * average over the period.
 */
export function impliedRate(
  curve: Curve,
  t0: number,
  t1: number,
  compounding?: CompoundingName,
): number {
  return compounding === undefined ? curve.fwd(t0, t1) : curve.fwd(t0, t1, compounding);
}

/**
 * `WIRP_MOVE_BP` — the implied move in basis points, cumulative from the current target midpoint
 * to `rate`. Negative means easing: `(rate − currentRate) × 10 000`.
 */
export function impliedMove(rate: number, currentRate: number): number {
  return (rate - currentRate) * 10_000;
}

/** One 25 bp outcome of a meeting, and the probability the implied move assigns to it. */
export interface PolicyStepProbability {
  /** Whole steps from the current target: `−1` is one 25 bp cut, `+2` is two 25 bp hikes. */
  readonly steps: number;
  /** `steps × stepBp` — the outcome in basis points. */
  readonly bp: number;
  /** Probability in `[0, 1]`. The screen renders `probability × 100` (`pct`). */
  readonly probability: number;
}

/** What {@link stepProbabilities} returns: the outcome ladder and its three summary shares. */
export interface StepProbabilities {
  /**
   * The fractional step count the move corresponds to, after snapping (see
   * {@link DEFAULT_STEP_EPSILON}). `−0.516` for a 12.9 bp implied cut.
   */
  readonly steps: number;
  /**
   * One entry per whole-step outcome, ascending, always spanning `0` so the screen has a row for
   * "no change" even when it is impossible. Probabilities sum to 1.
   */
  readonly outcomes: readonly PolicyStepProbability[];
  /** `WIRP_PROB_HIKE` — total probability of a move up of at least one step. */
  readonly hikeProbability: number;
  /** `WIRP_PROB_CUT` — total probability of a move down of at least one step. */
  readonly cutProbability: number;
  /** `WIRP_PROB_HOLD` — probability of the `0`-step outcome. */
  readonly holdProbability: number;
}

/**
 * `WIRP_PROB_HIKE` / `WIRP_PROB_CUT` / `WIRP_PROB_HOLD` — split `moveBp` across the two bracketing
 * whole 25 bp steps.
 *
 * The Committee moves in whole increments, so an implied move of `−12.9 bp = −0.516` steps is read
 * as the mixture that reproduces it in expectation: `0.516` on `−1` step and `0.484` on `0`. The
 * general rule for a fractional count `s` is `p(⌈s⌉) = s − ⌊s⌋`, `p(⌊s⌋) = 1 − p(⌈s⌉)`, and every
 * other outcome `0`; for a whole `s` the single outcome `s` takes the whole mass. The returned
 * ladder is contiguous and always contains `0`, so the two-outcome case still renders three rows
 * when the move is a hike and a "hold" row when it is a cut.
 *
 * @param moveBp  the implied move in basis points (see {@link impliedMove}).
 * @param stepBp  the increment in basis points; 25 by default.
 * @param epsilonSteps snapping tolerance in step counts; see {@link DEFAULT_STEP_EPSILON}.
 */
export function stepProbabilities(
  moveBp: number,
  stepBp: number = DEFAULT_STEP_BP,
  epsilonSteps: number = DEFAULT_STEP_EPSILON,
): StepProbabilities {
  if (!Number.isFinite(moveBp)) {
    throw new RangeError(`stepProbabilities: moveBp must be finite, got ${String(moveBp)}`);
  }
  if (!(stepBp > 0) || !Number.isFinite(stepBp)) {
    throw new RangeError(`stepProbabilities: stepBp must be positive, got ${String(stepBp)}`);
  }
  if (!(epsilonSteps >= 0) || !Number.isFinite(epsilonSteps)) {
    throw new RangeError(
      `stepProbabilities: epsilonSteps must be non-negative, got ${String(epsilonSteps)}`,
    );
  }

  const raw = moveBp / stepBp;
  const nearest = Math.round(raw);
  const steps = Math.abs(raw - nearest) <= epsilonSteps ? nearest : raw;

  if (Math.abs(steps) > MAX_STEPS) {
    throw new RangeError(
      `stepProbabilities: implied move of ${String(moveBp)} bp is ${String(steps)} steps, ` +
        `beyond the ±${String(MAX_STEPS)}-step guard`,
    );
  }

  const low = Math.floor(steps);
  const high = Math.ceil(steps);
  // For a whole step count `low === high` and that outcome takes the whole mass; otherwise the
  // fraction above the lower step is the probability of the upper one, which is what makes the
  // mixture reproduce `steps` in expectation.
  const pHigh = low === high ? 1 : steps - low;
  const pLow = low === high ? 0 : 1 - pHigh;

  const from = Math.min(0, low);
  const to = Math.max(0, high);
  const outcomes: PolicyStepProbability[] = [];
  let hike = 0;
  let cut = 0;
  let hold = 0;
  for (let k = from; k <= to; k += 1) {
    let probability = 0;
    if (low === high) probability = k === low ? 1 : 0;
    else if (k === low) probability = pLow;
    else if (k === high) probability = pHigh;
    outcomes.push(Object.freeze({ steps: k, bp: k * stepBp, probability }));
    if (k > 0) hike += probability;
    else if (k < 0) cut += probability;
    else hold = probability;
  }

  return Object.freeze({
    steps,
    outcomes: Object.freeze(outcomes),
    hikeProbability: hike,
    cutProbability: cut,
    holdProbability: hold,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engine inputs and outputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `wirp.policypath`'s declared input set (ANAL-08). A `type` alias rather than an `interface`:
 * `defineEngine`'s `I extends EngineInputs` constraint needs the implicit index signature only a
 * type alias gets.
 *
 * The curve arrives as its **node set**, not as a live `Curve`, for two reasons: `inputsHash` has
 * to be `sha256Hex(canonicalJson(inputs))` and a closure does not canonicalise, and the node set is
 * exactly what `curve_builds.nodes` persists, so a stored build can be replayed through this engine
 * unchanged. `CurveBuildOutputs.nodes` (`[{t, df, zero, fwd}]`) is assignable here as-is — the two
 * extra keys are carried into the hash and otherwise ignored.
 */
export type PolicyPathInputs = {
  /** `curves.curve_id` of the money-market curve — `'SOFR_OIS'`, `'UST_BILL'`. */
  readonly curveId: string;
  /** `curve_builds.curve_date`; every `t` below is measured from it. */
  readonly curveDate: IsoDate;
  /** The bootstrapped nodes, ascending in `t`, `t > 0`. */
  readonly points: readonly DfPoint[];
  /**
   * FOMC **decision** dates, strictly ascending, in the future relative to `curveDate`. The
   * effective date of each is `decision + effectiveLagDays`.
   */
  readonly meetings: readonly IsoDate[];
  /**
   * The current target-range midpoint `(TARGET_FROM + TARGET_TO)/2`, decimal per annum — the anchor
   * every `WIRP_MOVE_BP` is measured from. Defaults to the curve's own overnight forward from
   * `curveDate` to the first effective date, which is what makes a flat curve produce a strictly
   * zero path whatever the target happens to be.
   */
  readonly currentRate?: number;
  /** The move increment, decimal; `0.0025` (25 bp) by default. */
  readonly stepSize?: number;
  /** Calendar days from a decision to its effective date; `1` by default. */
  readonly effectiveLagDays?: number;
  /**
   * The far end of the last inter-meeting period. Defaults to the last effective date plus the
   * length of the preceding inter-meeting gap — the only choice that needs no calendar beyond the
   * meeting list itself, and the one a desk makes when the next meeting is not yet scheduled.
   */
  readonly terminalDate?: IsoDate;
  /** `curves.day_count`; `ACT/360` by default. */
  readonly dayCount?: DayCountId;
  /** `curves.compounding` — the basis the forwards are quoted on; `simple` by default. */
  readonly compounding?: CompoundingName;
  /** `curves.default_interpolation`; `log_linear_df` by default. */
  readonly interpolation?: InterpolationName;
  /** Step-count snapping tolerance; see {@link DEFAULT_STEP_EPSILON}. */
  readonly stepEpsilon?: number;
};

/** One constant-rate stretch of the path: from one policy boundary to the next. */
export interface PolicySegment {
  /** The curve date for the first segment, otherwise the previous meeting's effective date. */
  readonly from: IsoDate;
  /** The next meeting's effective date, or `terminalDate` for the last segment. */
  readonly to: IsoDate;
  /** Year fraction of `from` from the curve date. */
  readonly t0: number;
  /** Year fraction of `to` from the curve date. */
  readonly t1: number;
  /** The implied overnight rate over the segment, decimal per annum. */
  readonly rate: number;
}

/** One FOMC date as the WIRP screen renders it. */
export interface PolicyMeeting {
  /** The decision date, exactly as it was passed in. */
  readonly meetingDate: IsoDate;
  /** `meetingDate + effectiveLagDays`. */
  readonly effectiveDate: IsoDate;
  /** Year fraction of `effectiveDate` from the curve date. */
  readonly t: number;
  /** The implied overnight rate over the segment *ending* at this meeting's effective date. */
  readonly rateBefore: number;
  /** `WIRP_IMPL_RATE` as a decimal: the rate over the segment starting at the effective date. */
  readonly impliedRate: number;
  /** `WIRP_MOVE_BP`: `(impliedRate − currentRate) × 10 000`, cumulative. Negative is easing. */
  readonly moveBp: number;
  /** `(impliedRate − rateBefore) × 10 000`: this meeting's own move, not the cumulative one. */
  readonly incrementalBp: number;
  /** `moveBp / stepBp` after snapping — the fractional step count the probabilities split. */
  readonly steps: number;
  /** The 25 bp outcome ladder; probabilities sum to 1. */
  readonly probabilities: readonly PolicyStepProbability[];
  /** `WIRP_PROB_HIKE` as a fraction. */
  readonly hikeProbability: number;
  /** `WIRP_PROB_CUT` as a fraction. */
  readonly cutProbability: number;
  /** `WIRP_PROB_HOLD` as a fraction. */
  readonly holdProbability: number;
}

/** What `wirp.policypath` produces. */
export interface PolicyPathOutputs {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  /** The overnight rate the curve implies between the curve date and the first effective date. */
  readonly spotRate: number;
  /** The target midpoint the moves are measured from — the input, or `spotRate` when omitted. */
  readonly currentRate: number;
  /** `(spotRate − currentRate) × 10 000`: how far the curve's front sits off the target today. */
  readonly spotBasisBp: number;
  /** The move increment actually used, decimal. */
  readonly stepSize: number;
  /** The far end of the last inter-meeting period. */
  readonly terminalDate: IsoDate;
  /** The rate over the final segment — the path's terminal level. */
  readonly terminalRate: number;
  /** `meetings.length + 1` constant-rate stretches, ascending. */
  readonly segments: readonly PolicySegment[];
  /** One entry per FOMC date, in input order. */
  readonly meetings: readonly PolicyMeeting[];
  /**
   * True when a boundary falls past the last curve node, so at least one forward came from the
   * curve's flat-forward extrapolation rather than from a bootstrapped instrument. The path is
   * still well defined; the screen should mark it.
   */
  readonly extrapolated: boolean;
  /** The conventions this path was computed under, echoed into the output (ANAL-07). */
  readonly conventions: Conventions;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────────────────────

function requireIsoDate(label: string, value: unknown): IsoDate {
  if (!isIsoDate(value)) {
    throw new RangeError(`wirp.policypath: ${label} must be an ISO date, got ${String(value)}`);
  }
  return value;
}

/**
 * The implied policy path (WIRP).
 *
 * Boundaries are `curveDate`, then each meeting's effective date, then `terminalDate`; the forward
 * over each `[boundary_i, boundary_{i+1}]` is the overnight rate implied over it, and meeting `i`
 * moves the rate from the segment before it to the segment after it.
 */
export const policyPathEngine = defineEngine<PolicyPathInputs, PolicyPathOutputs>(
  'wirp.policypath',
  '1.0.0',
  (inputs) => {
    const curveDate = requireIsoDate('curveDate', inputs.curveDate);

    const dcId = inputs.dayCount ?? DEFAULT_DAY_COUNT;
    if (!isDayCountId(dcId)) {
      throw new RangeError(`wirp.policypath: unknown dayCount ${String(inputs.dayCount)}`);
    }
    const interpolation = inputs.interpolation ?? DEFAULT_INTERPOLATION;
    if (!isInterpolationName(interpolation)) {
      throw new RangeError(
        `wirp.policypath: unknown interpolation ${String(inputs.interpolation)}`,
      );
    }
    const compounding = inputs.compounding ?? DEFAULT_COMPOUNDING;

    const points = inputs.points;
    if (!Array.isArray(points) || points.length === 0) {
      throw new RangeError('wirp.policypath: points must be a non-empty curve node set');
    }

    const stepSize = inputs.stepSize ?? DEFAULT_STEP_SIZE;
    if (!(stepSize > 0) || !Number.isFinite(stepSize)) {
      throw new RangeError(`wirp.policypath: stepSize must be positive, got ${String(stepSize)}`);
    }
    const stepBp = stepSize * 10_000;
    const stepEpsilon = inputs.stepEpsilon ?? DEFAULT_STEP_EPSILON;

    const lag = inputs.effectiveLagDays ?? DEFAULT_EFFECTIVE_LAG_DAYS;
    if (!Number.isInteger(lag) || lag < 0) {
      throw new RangeError(
        `wirp.policypath: effectiveLagDays must be a non-negative integer, got ${String(lag)}`,
      );
    }

    const meetings = inputs.meetings;
    if (!Array.isArray(meetings) || meetings.length === 0) {
      throw new RangeError('wirp.policypath: meetings must list at least one FOMC date');
    }

    // ── Boundaries ──────────────────────────────────────────────────────────────────────────
    const decisions: IsoDate[] = [];
    const effectives: IsoDate[] = [];
    let previous = curveDate;
    for (let i = 0; i < meetings.length; i += 1) {
      const decision = requireIsoDate(`meetings[${String(i)}]`, meetings[i]);
      const effective = addDays(decision, lag);
      if (compareDates(effective, previous) <= 0) {
        throw new RangeError(
          `wirp.policypath: meeting dates must be strictly ascending and after the curve date — ` +
            `${decision} is effective ${effective}, which does not follow ${previous}`,
        );
      }
      decisions.push(decision);
      effectives.push(effective);
      previous = effective;
    }

    const lastEffective = effectives[effectives.length - 1]!;
    const penultimate = effectives.length >= 2 ? (effectives[effectives.length - 2]!) : curveDate;
    const defaultTerminal = addDays(lastEffective, daysBetween(penultimate, lastEffective));
    const terminalDate =
      inputs.terminalDate === undefined
        ? defaultTerminal
        : requireIsoDate('terminalDate', inputs.terminalDate);
    if (compareDates(terminalDate, lastEffective) <= 0) {
      throw new RangeError(
        `wirp.policypath: terminalDate ${terminalDate} must follow the last effective date ${lastEffective}`,
      );
    }

    // ── Time axis, on the curve's own day count ─────────────────────────────────────────────
    const convention = dayCountConvention(dcId);
    const timeOf = (date: IsoDate): number => convention.yearFraction(curveDate, date);

    const boundaryDates: IsoDate[] = [curveDate, ...effectives, terminalDate];
    const boundaryTimes = boundaryDates.map(timeOf);
    for (let i = 1; i < boundaryTimes.length; i += 1) {
      const a = boundaryTimes[i - 1]!;
      const b = boundaryTimes[i]!;
      if (!(b > a)) {
        throw new RangeError(
          `wirp.policypath: boundary ${boundaryDates[i]!} is not strictly after ` +
            `${boundaryDates[i - 1]!} on ${dcId}`,
        );
      }
    }

    // ── The curve ───────────────────────────────────────────────────────────────────────────
    const curve = makeCurve({
      curveId: inputs.curveId,
      curveDate,
      dayCount: dcId,
      compounding,
      interpolation,
      points,
    });
    const lastNode = curve.times[curve.times.length - 1]!;
    const horizon = boundaryTimes[boundaryTimes.length - 1]!;
    const extrapolated = horizon > lastNode;

    // ── Segment rates: the implied overnight rate between policy boundaries ──────────────────
    const segments: PolicySegment[] = [];
    for (let i = 0; i + 1 < boundaryTimes.length; i += 1) {
      const t0 = boundaryTimes[i]!;
      const t1 = boundaryTimes[i + 1]!;
      segments.push(
        Object.freeze({
          from: boundaryDates[i]!,
          to: boundaryDates[i + 1]!,
          t0,
          t1,
          rate: impliedRate(curve, t0, t1, compounding),
        }),
      );
    }

    const spotRate = (segments[0]!).rate;
    const currentRate = inputs.currentRate ?? spotRate;
    if (!Number.isFinite(currentRate)) {
      throw new RangeError(
        `wirp.policypath: currentRate must be finite, got ${String(inputs.currentRate)}`,
      );
    }

    // ── Per-meeting probabilities ───────────────────────────────────────────────────────────
    const path: PolicyMeeting[] = [];
    for (let i = 0; i < decisions.length; i += 1) {
      const before = (segments[i]!).rate;
      const after = (segments[i + 1]!).rate;
      const moveBp = impliedMove(after, currentRate);
      const split = stepProbabilities(moveBp, stepBp, stepEpsilon);
      path.push(
        Object.freeze({
          meetingDate: decisions[i]!,
          effectiveDate: effectives[i]!,
          t: boundaryTimes[i + 1]!,
          rateBefore: before,
          impliedRate: after,
          moveBp,
          incrementalBp: (after - before) * 10_000,
          steps: split.steps,
          probabilities: split.outcomes,
          hikeProbability: split.hikeProbability,
          cutProbability: split.cutProbability,
          holdProbability: split.holdProbability,
        }),
      );
    }

    const conventions: Conventions = Object.freeze({
      dayCount: dcId,
      compounding,
      interpolation,
      extrapolation: interpolation === 'linear_zero' ? 'flat_zero' : 'flat_forward',
      stepBp,
      effectiveLagDays: lag,
    });

    return Object.freeze({
      curveId: inputs.curveId,
      curveDate,
      spotRate,
      currentRate,
      spotBasisBp: (spotRate - currentRate) * 10_000,
      stepSize,
      terminalDate,
      terminalRate: (segments[segments.length - 1]!).rate,
      segments: Object.freeze(segments),
      meetings: Object.freeze(path),
      extrapolated,
      conventions,
    });
  },
);

/** Convenience wrapper: the outputs alone, for callers that do not need the ANAL-08 envelope. */
export function policyPath(inputs: PolicyPathInputs, valuationTs: string): PolicyPathOutputs {
  return policyPathEngine(inputs, valuationTs).outputs;
}
