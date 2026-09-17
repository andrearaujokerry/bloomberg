/**
 * The `Curve` object — WORKPLAN §WP-02 L504-506, ANAL-02.
 *
 * A curve is an interpolated set of discount factors plus the conventions needed to *quote* them:
 * `df(t)`, `zero(t)`, `fwd(t1, t2)` and `snapshot()`, where the snapshot is exactly what
 * `curve_builds.nodes` stores — `[{t, df, zero, fwd}]` (DATA_MODEL L1515).
 *
 * Units and sign conventions, fixed once here so nothing downstream has to guess:
 *
 *  - `t` is a **year fraction from the curve date**, measured by the curve's own day count. The
 *    curve has no notion of a date beyond `curveDate`; a caller converts dates to `t` (the
 *    bootstrap does, once, when it builds the node set).
 *  - every rate — `zero`, `fwd`, a node's `zero`/`fwd` — is a **decimal fraction per annum**
 *    (`0.05`, not `5`), on the curve's own `compounding` unless a call overrides it. Percent is a
 *    presentation unit and lives at the screen, never in the engine.
 *  - `df(0) = 1` exactly, and `df` is strictly decreasing whenever the forwards are positive.
 *
 * A node's `zero` is quoted on the curve's compounding (so a flat 5 % semiannual par curve shows
 * `zero = 0.05` at every node, which is the point of quoting it that way) and its `fwd` is the
 * forward over the interval that *ends* at the node — from the curve date for the first node — on
 * that same compounding. `fwd(t1, t2, 'continuous')` is the accessor TESTING §7.7 checks against
 * `df(t2)/df(t1) = exp(−fwd·(t2 − t1))`.
 *
 * No `Date`, no I/O (ARCHITECTURE L49).
 */

import type { IsoDate } from '../../calendars/calendar.js';
import type { DayCountId } from '../../daycount/conventions.js';
import type { CompoundingName, Conventions, InterpolationName } from '../engine.js';

import type { DfPoint, Interpolator } from './interp.js';
import { makeInterpolator } from './interp.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Compounding algebra
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The five `CompoundingName` values, matching the `curves.compounding` CHECK plus `quarterly`. */
export const COMPOUNDING_NAMES: readonly CompoundingName[] = Object.freeze([
  'simple',
  'annual',
  'semiannual',
  'quarterly',
  'continuous',
] as const);

/** True when `value` is one of the five compounding strings. */
export function isCompoundingName(value: unknown): value is CompoundingName {
  return typeof value === 'string' && (COMPOUNDING_NAMES as readonly string[]).includes(value);
}

/** Compounding periods per year; `simple` and `continuous` have none (`0` and `Infinity`). */
export function periodsPerYear(compounding: CompoundingName): number {
  switch (compounding) {
    case 'annual':
      return 1;
    case 'semiannual':
      return 2;
    case 'quarterly':
      return 4;
    case 'simple':
      return 0;
    case 'continuous':
      return Number.POSITIVE_INFINITY;
    default:
      throw new RangeError(
        `periodsPerYear: ${JSON.stringify(compounding)} is not one of ${COMPOUNDING_NAMES.join(' | ')}`,
      );
  }
}

/**
 * The rate that discounts `1` to `df` over `t` years on `compounding`.
 * `t` must be strictly positive: a rate over no time is not a number.
 */
export function rateFromDf(df: number, t: number, compounding: CompoundingName): number {
  if (!(df > 0)) throw new RangeError(`rateFromDf: df must be positive, got ${String(df)}`);
  if (!(t > 0)) throw new RangeError(`rateFromDf: t must be positive, got ${String(t)}`);
  if (compounding === 'continuous') return -Math.log(df) / t;
  if (compounding === 'simple') return (1 / df - 1) / t;
  const m = periodsPerYear(compounding);
  return m * (Math.pow(df, -1 / (m * t)) - 1);
}

/** Inverse of {@link rateFromDf}: the discount factor of `rate` over `t` years. */
export function dfFromRate(rate: number, t: number, compounding: CompoundingName): number {
  if (!Number.isFinite(rate)) {
    throw new RangeError(`dfFromRate: rate must be finite, got ${String(rate)}`);
  }
  if (!(t >= 0)) throw new RangeError(`dfFromRate: t must be non-negative, got ${String(t)}`);
  if (t === 0) return 1;
  if (compounding === 'continuous') return Math.exp(-rate * t);
  if (compounding === 'simple') return 1 / (1 + rate * t);
  const m = periodsPerYear(compounding);
  return Math.pow(1 + rate / m, -m * t);
}

/** Convert a rate from one compounding to another over the horizon `t`. */
export function convertCompounding(
  rate: number,
  t: number,
  from: CompoundingName,
  to: CompoundingName,
): number {
  if (from === to) return rate;
  return rateFromDf(dfFromRate(rate, t, from), t, to);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One row of `curve_builds.nodes` — the jsonb shape is `[{t, df, zero, fwd}]` and this interface is
 * that shape, key for key, with no extras: anything the database does not store does not belong on
 * a node.
 */
export interface CurveNode {
  /** Year fraction from the curve date. */
  readonly t: number;
  /** Discount factor at `t`. */
  readonly df: number;
  /** Zero rate to `t`, decimal per annum, on the curve's compounding. */
  readonly zero: number;
  /** Forward rate over the interval ending at `t` (from the curve date for the first node). */
  readonly fwd: number;
}

/** The keys of `curve_builds.nodes`, in the order the jsonb documents them. */
export const CURVE_NODE_KEYS: readonly string[] = Object.freeze(['t', 'df', 'zero', 'fwd']);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Curve
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Everything a curve needs besides its node set. */
export interface CurveSpec {
  /** `curves.curve_id` — `'UST_PAR'`, `'SOFR_OIS'`, … Free-form here; the database constrains it. */
  readonly curveId: string;
  /** `curve_builds.curve_date`. */
  readonly curveDate: IsoDate;
  /** `curves.day_count` — the convention `t` was measured with. */
  readonly dayCount: DayCountId;
  /** `curves.compounding` — the basis `zero` and `fwd` are quoted on by default. */
  readonly compounding: CompoundingName;
  /** `curves.default_interpolation`. */
  readonly interpolation: InterpolationName;
  /** The bootstrapped knots, ascending in `t`. */
  readonly points: readonly DfPoint[];
  /** Coupon frequency the curve was bootstrapped from, echoed in `Conventions`. Optional. */
  readonly frequency?: number;
}

/** The interpolated term structure. Frozen and pure: every accessor is a function of `t` alone. */
export interface Curve {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  readonly dayCount: DayCountId;
  readonly compounding: CompoundingName;
  readonly interpolation: InterpolationName;
  /** The conventions this curve was built under, echoed into every engine output (ANAL-07). */
  readonly conventions: Conventions;
  /** The node year fractions, ascending. */
  readonly times: readonly number[];

  /** Discount factor at `t ≥ 0`. `df(0) = 1` exactly. */
  df(t: number): number;
  /**
   * Zero rate to `t`, decimal per annum, on `compounding` unless overridden.
   * `zero(0)` is the short-end limit — the zero of the first node — rather than a division by zero.
   */
  zero(t: number, compounding?: CompoundingName): number;
  /**
   * Forward rate over `[t1, t2]`, `t2 > t1 ≥ 0`, decimal per annum, on `compounding` unless
   * overridden. With `'continuous'` this is the accessor that satisfies
   * `df(t2)/df(t1) = exp(−fwd·(t2 − t1))` exactly (TESTING §7.7).
   */
  fwd(t1: number, t2: number, compounding?: CompoundingName): number;
  /** The instantaneous continuously compounded forward `−d ln df/dt` at `t`. */
  instantaneousForward(t: number): number;
  /** Exactly what `curve_builds.nodes` stores: `[{t, df, zero, fwd}]`. A fresh array each call. */
  snapshot(): CurveNode[];
  /** The underlying interpolator, for callers that want to re-interpolate on the same knots. */
  readonly interpolator: Interpolator;
}

/** Build a curve over an already-bootstrapped node set. */
export function makeCurve(spec: CurveSpec): Curve {
  const interpolator = makeInterpolator(spec.interpolation, spec.points);
  const times = interpolator.times;
  const first = times[0];
  if (first === undefined) throw new RangeError('makeCurve: a curve needs at least one node');

  const conventions: Conventions = Object.freeze({
    dayCount: spec.dayCount,
    compounding: spec.compounding,
    interpolation: spec.interpolation,
    ...(spec.frequency === undefined ? {} : { frequency: spec.frequency }),
    extrapolation: spec.interpolation === 'linear_zero' ? 'flat_zero' : 'flat_forward',
  });

  const df = (t: number): number => interpolator.df(t);

  const zero = (t: number, compounding: CompoundingName = spec.compounding): number => {
    if (!Number.isFinite(t) || t < 0) {
      throw new RangeError(`Curve.zero: t must be finite and non-negative, got ${String(t)}`);
    }
    // The short-end limit. Below the first node every interpolator here holds the zero flat, so the
    // limit as t → 0⁺ is the first node's own zero; returning it beats a 0/0.
    const at = t === 0 ? first : t;
    return rateFromDf(df(at), at, compounding);
  };

  const fwd = (t1: number, t2: number, compounding: CompoundingName = spec.compounding): number => {
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) {
      throw new RangeError(`Curve.fwd: t1 and t2 must be finite, got ${String(t1)}, ${String(t2)}`);
    }
    if (t1 < 0) throw new RangeError(`Curve.fwd: t1 must be non-negative, got ${String(t1)}`);
    if (!(t2 > t1)) {
      throw new RangeError(`Curve.fwd: t2 must exceed t1, got ${String(t1)} → ${String(t2)}`);
    }
    // The forward discount factor df(t2)/df(t1) over the tenor t2 − t1, quoted on `compounding`.
    return rateFromDf(df(t2) / df(t1), t2 - t1, compounding);
  };

  const snapshot = (): CurveNode[] => {
    const nodes: CurveNode[] = [];
    let previous = 0;
    for (const t of times) {
      nodes.push({
        t,
        df: df(t),
        zero: zero(t),
        fwd: fwd(previous, t),
      });
      previous = t;
    }
    return nodes;
  };

  return Object.freeze({
    curveId: spec.curveId,
    curveDate: spec.curveDate,
    dayCount: spec.dayCount,
    compounding: spec.compounding,
    interpolation: spec.interpolation,
    conventions,
    times,
    interpolator,
    df,
    zero,
    fwd,
    instantaneousForward: (t: number): number => interpolator.forward(t),
    snapshot,
  });
}

/** True when `node` has exactly the four `curve_builds.nodes` keys and all four are finite. */
export function isCurveNode(node: unknown): node is CurveNode {
  if (node === null || typeof node !== 'object') return false;
  const keys = Object.keys(node).sort();
  const expected = [...CURVE_NODE_KEYS].sort();
  if (keys.length !== expected.length) return false;
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== expected[i]) return false;
  }
  const record = node as Record<string, unknown>;
  return CURVE_NODE_KEYS.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]));
}
