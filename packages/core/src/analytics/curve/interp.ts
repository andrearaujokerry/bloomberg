/**
 * Curve interpolation — WORKPLAN §WP-02 L504-506, ANAL-02.
 *
 * The three names are exactly the `curves.default_interpolation` CHECK values
 * (`CONTRACTS.md` L217): `'linear_zero' | 'log_linear_df' | 'monotone_convex'`. The type itself
 * lives in `analytics/engine.ts` (`InterpolationName`) so the `Conventions` object an engine echoes
 * and the interpolator it was built with cannot drift apart; this module supplies the runtime list
 * and the three implementations.
 *
 * **Everything here works on `(t, df)` pairs only.** `t` is a year fraction measured from the curve
 * date by the curve's own day count, `df` the discount factor at `t`. Nothing in this file knows
 * about compounding, dates, calendars or currencies — that is `curve.ts`'s job. Working in a single
 * representation is what makes the three interpolators comparable at all: each one is a different
 * rule for the *shape between* the nodes, never a different set of node values.
 *
 * The internal state of every interpolator is the **cumulative continuous zero**
 *
 *     y(t) = −ln df(t),     y(0) = 0,     f(t) = y′(t) = the instantaneous continuous forward
 *
 * because all three rules are naturally statements about `y`:
 *
 *  - `log_linear_df`  — `y` is piecewise linear ⇒ the forward is piecewise *constant*, equal to the
 *    discrete forward of each interval. The workhorse: it is exactly local (a node moves only the
 *    two segments touching it) and it can never produce a negative forward from decreasing `df`s.
 *  - `linear_zero`    — the *continuously compounded* zero `z(t) = y(t)/t` is piecewise linear, flat
 *    outside the node range. Also local. Note `y = z·t` is then piecewise *quadratic*, so the
 *    forward `z(t) + t·z′(t)` is piecewise linear and can go negative on a steep inversion.
 *  - `monotone_convex`— Hagan & West's monotone convex method (*Interpolation Methods for Curve
 *    Construction*, Applied Mathematical Finance 13(2), 2006, §4): it reproduces every interval's
 *    discrete forward **exactly** (so node discount factors are preserved to the last bit), keeps the
 *    instantaneous forward continuous, monotone where the discrete forwards are monotone, and — with
 *    the §5 "ensuring positivity" collar applied to the node forwards — non-negative whenever the
 *    discrete forwards are non-negative. That is the property `curve/interp.test.ts` stresses.
 *
 * Outside `[t₁, tₙ]`:
 *  - below the first node every rule extrapolates a **flat continuous zero** (`log_linear_df` and
 *    `monotone_convex` do it by anchoring the left end of the first interval at `(0, y=0)`, which is
 *    the same statement), so `df(t) = df₁^(t/t₁)` and `df(0) = 1` exactly;
 *  - above the last node `log_linear_df` and `monotone_convex` hold the last forward flat, and
 *    `linear_zero` holds the last zero flat.
 *
 * No `Date`, no I/O, no dependencies (ARCHITECTURE L49).
 */

import type { InterpolationName } from '../engine.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The three `curves.default_interpolation` values, in the order the CHECK lists them. */
export const INTERPOLATION_NAMES: readonly InterpolationName[] = Object.freeze([
  'linear_zero',
  'log_linear_df',
  'monotone_convex',
] as const);

/** True when `value` is one of the three `curves.default_interpolation` strings. */
export function isInterpolationName(value: unknown): value is InterpolationName {
  return typeof value === 'string' && (INTERPOLATION_NAMES as readonly string[]).includes(value);
}

/** Resolve a stored `curves.default_interpolation` value; a bad enum is a bug, not a default. */
export function interpolationName(value: string | null | undefined): InterpolationName {
  if (value === null || value === undefined) return 'log_linear_df';
  if (!isInterpolationName(value)) {
    throw new RangeError(
      `interpolationName: ${JSON.stringify(value)} is not one of ${INTERPOLATION_NAMES.join(' | ')}`,
    );
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A knot of the interpolated curve: a discount factor at a year fraction. */
export interface DfPoint {
  /** Year fraction from the curve date, strictly positive and strictly increasing. */
  readonly t: number;
  /** Discount factor at `t`, strictly positive. */
  readonly df: number;
}

/** A built interpolator over a fixed node set. Pure and frozen: the same `t` always maps alike. */
export interface Interpolator {
  readonly name: InterpolationName;
  /** The node year fractions, ascending (the `(0, 1)` anchor is not one of them). */
  readonly times: readonly number[];
  /** Discount factor at `t ≥ 0`; `df(0) = 1` exactly. */
  df(t: number): number;
  /** `y(t) = −ln df(t)`, the cumulative continuous zero. */
  y(t: number): number;
  /**
   * The instantaneous continuously compounded forward `f(t) = y′(t)`. Piecewise definitions take
   * the right-hand limit at an interior node and the left-hand limit at the last node, so sampling
   * a whole curve never lands on an undefined point.
   */
  forward(t: number): number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Node validation
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Knots {
  /** `t[0] = 0`, then the node times. */
  readonly t: readonly number[];
  /** `y[0] = 0`, then `−ln df` at each node. */
  readonly y: readonly number[];
  /** `dt[i] = t[i] − t[i−1]` for `i ≥ 1`; `dt[0]` is unused. */
  readonly dt: readonly number[];
  /** `fd[i] = (y[i] − y[i−1]) / dt[i]` for `i ≥ 1` — the discrete forward of interval `i`. */
  readonly fd: readonly number[];
  /** The number of real nodes (`t.length − 1`). */
  readonly n: number;
}

function knotsOf(points: readonly DfPoint[], name: InterpolationName): Knots {
  if (points.length === 0) {
    throw new RangeError(`${name}: at least one curve node is required`);
  }
  const t: number[] = [0];
  const y: number[] = [0];
  const dt: number[] = [Number.NaN];
  const fd: number[] = [Number.NaN];
  let previousT = 0;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point === undefined) throw new RangeError(`${name}: node ${String(i)} is missing`);
    if (!Number.isFinite(point.t) || point.t <= 0) {
      throw new RangeError(`${name}: node ${String(i)} has non-positive t ${String(point.t)}`);
    }
    if (point.t <= previousT) {
      throw new RangeError(
        `${name}: node times must be strictly increasing, got ${String(previousT)} then ${String(point.t)}`,
      );
    }
    if (!Number.isFinite(point.df) || point.df <= 0) {
      throw new RangeError(`${name}: node ${String(i)} has non-positive df ${String(point.df)}`);
    }
    const step = point.t - previousT;
    const yi = -Math.log(point.df);
    t.push(point.t);
    y.push(yi);
    dt.push(step);
    const yPrev = y[y.length - 2] ?? 0;
    fd.push((yi - yPrev) / step);
    previousT = point.t;
  }
  return { t, y, dt, fd, n: points.length };
}

/** Index of the interval `[t[i−1], t[i]]` that contains `t`, clamped to `1 … n`. */
function intervalOf(knots: Knots, time: number): number {
  const { t, n } = knots;
  if (time <= (t[1] ?? 0)) return 1;
  if (time >= (t[n] ?? 0)) return n;
  let lo = 1;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((t[mid] ?? 0) < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function checkTime(time: number, name: InterpolationName): void {
  if (!Number.isFinite(time)) {
    throw new RangeError(`${name}: t must be finite, got ${String(time)}`);
  }
  if (time < 0) {
    throw new RangeError(`${name}: t must be non-negative, got ${String(time)}`);
  }
}

function finish(
  name: InterpolationName,
  knots: Knots,
  y: (time: number) => number,
  forward: (time: number) => number,
): Interpolator {
  const times = Object.freeze(knots.t.slice(1));
  const guardedY = (time: number): number => {
    checkTime(time, name);
    return time === 0 ? 0 : y(time);
  };
  return Object.freeze({
    name,
    times,
    y: guardedY,
    df: (time: number): number => Math.exp(-guardedY(time)),
    forward: (time: number): number => {
      checkTime(time, name);
      return forward(time);
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// log_linear_df
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `log_linear_df` — `ln df` linear in `t`, i.e. a piecewise-constant continuous forward.
 *
 * On `[t₀, t₁]` the left anchor is `(0, 1)`, so the short end is a flat continuous zero; past the
 * last node the last interval's forward is held flat.
 */
export function logLinearDf(points: readonly DfPoint[]): Interpolator {
  const knots = knotsOf(points, 'log_linear_df');
  const { t, y, fd } = knots;
  const y0 = (time: number): number => {
    const i = intervalOf(knots, time);
    return (y[i - 1] ?? 0) + (fd[i] ?? 0) * (time - (t[i - 1] ?? 0));
  };
  const f0 = (time: number): number => fd[intervalOf(knots, time)] ?? 0;
  return finish('log_linear_df', knots, y0, f0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// linear_zero
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `linear_zero` — the continuously compounded zero `z(t) = −ln df(t) / t` is linear between nodes
 * and flat outside them.
 *
 * The forward is `y′(t) = z(t) + t·z′(t)`, which is why this rule — unlike `log_linear_df` — can
 * manufacture a negative forward out of strictly decreasing discount factors on a steep inversion.
 * It is kept because it is what a great many curve vendors publish, and `curves.default_interpolation`
 * names it.
 */
export function linearZero(points: readonly DfPoint[]): Interpolator {
  const knots = knotsOf(points, 'linear_zero');
  const { t, y, n } = knots;
  /** Zero rates at the real nodes, `z[i] = y[i]/t[i]`; `z[0]` mirrors `z[1]` (flat short end). */
  const z: number[] = [0];
  for (let i = 1; i <= n; i += 1) z.push((y[i] ?? 0) / (t[i] ?? 1));
  z[0] = z[1] ?? 0;

  /** Slope of `z` on interval `i`; the first and last intervals are flat. */
  const slope = (i: number): number => {
    if (i === 1 || i > n) return 0;
    return ((z[i] ?? 0) - (z[i - 1] ?? 0)) / (knots.dt[i] ?? 1);
  };
  const zAt = (time: number): number => {
    if (time >= (t[n] ?? 0)) return z[n] ?? 0;
    const i = intervalOf(knots, time);
    if (i === 1 && time <= (t[1] ?? 0)) return z[1] ?? 0;
    return (z[i - 1] ?? 0) + slope(i) * (time - (t[i - 1] ?? 0));
  };
  const y0 = (time: number): number => zAt(time) * time;
  const f0 = (time: number): number => {
    if (time >= (t[n] ?? 0)) return z[n] ?? 0;
    const i = intervalOf(knots, time);
    const s = i === 1 && time <= (t[1] ?? 0) ? 0 : slope(i);
    return zAt(time) + s * time;
  };
  return finish('linear_zero', knots, y0, f0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// monotone_convex (Hagan & West 2006)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where `g` sits relative to the zero-integral constraint; §4.3 of the paper. */
type Region = 'flat' | 'quadratic' | 'left-flat' | 'right-flat' | 'split';

interface Segment {
  readonly region: Region;
  readonly g0: number;
  readonly g1: number;
  /** The junction abscissa of the piecewise regions, in `[0, 1]`. */
  readonly eta: number;
  /** The plateau value of the split region (iv). */
  readonly a: number;
}

const TINY = 1e-14;

/**
 * Classify one interval and pre-compute its junction. `g0 = f(tᵢ₋₁) − fᵈᵢ`, `g1 = f(tᵢ) − fᵈᵢ`; the
 * constraint every region satisfies is `∫₀¹ g = 0`, which is exactly what makes the interpolated
 * discount factor at each node equal the node's own.
 */
function classify(g0: number, g1: number): Segment {
  const scale = Math.abs(g0) + Math.abs(g1);
  if (scale <= TINY) return { region: 'flat', g0: 0, g1: 0, eta: 0, a: 0 };
  // A vanishing endpoint deviation degenerates every closed form below: η collapses to 1 (g0 → 0)
  // or to 0 (g1 → 0), and in both limits the region's own formulae converge on the flat segment —
  // the spike that would carry the non-zero endpoint has zero width and so zero integral. Falling
  // back to `flat` (log-linear discount factors on this interval) *is* that limit, and it keeps the
  // node values exact; the alternative is a 0/0 in the closed form.
  if (Math.abs(g0) <= TINY * scale || Math.abs(g1) <= TINY * scale) {
    return { region: 'flat', g0: 0, g1: 0, eta: 0, a: 0 };
  }

  const inQuadratic = (g1 + 2 * g0) * (g1 + 0.5 * g0) <= 0;
  if (inQuadratic) return { region: 'quadratic', g0, g1, eta: 0, a: 0 };

  // (ii) g1 beyond −2·g0: a flat stretch at g0, then a quadratic up to g1.
  const beyondTwice = (g0 < 0 && g1 > -2 * g0) || (g0 > 0 && g1 < -2 * g0);
  if (beyondTwice) {
    return { region: 'left-flat', g0, g1, eta: (g1 + 2 * g0) / (g1 - g0), a: 0 };
  }
  // (iii) g1 between 0 and −g0/2: a quadratic from g0, then a flat stretch at g1.
  const insideHalf = (g0 > 0 && g1 < 0 && g1 > -0.5 * g0) || (g0 < 0 && g1 > 0 && g1 < -0.5 * g0);
  if (insideHalf) {
    return { region: 'right-flat', g0, g1, eta: (3 * g1) / (g1 - g0), a: 0 };
  }
  // (iv) g0 and g1 share a sign: two quadratics meeting at a plateau of the opposite sign.
  return {
    region: 'split',
    g0,
    g1,
    eta: g1 / (g0 + g1),
    a: (-g0 * g1) / (g0 + g1),
  };
}

/** `g(x)` on `[0, 1]` — the deviation of the instantaneous forward from the discrete forward. */
function gOf(seg: Segment, x: number): number {
  const { g0, g1, eta, a } = seg;
  switch (seg.region) {
    case 'flat':
      return 0;
    case 'quadratic':
      return g0 * (1 - 4 * x + 3 * x * x) + g1 * (-2 * x + 3 * x * x);
    case 'left-flat': {
      if (x <= eta) return g0;
      const u = (x - eta) / (1 - eta);
      return g0 + (g1 - g0) * u * u;
    }
    case 'right-flat': {
      if (x >= eta) return g1;
      const u = (eta - x) / eta;
      return g1 + (g0 - g1) * u * u;
    }
    case 'split': {
      if (x <= eta) {
        const u = (eta - x) / eta;
        return a + (g0 - a) * u * u;
      }
      const u = (x - eta) / (1 - eta);
      return a + (g1 - a) * u * u;
    }
  }
}

/** `G(x) = ∫₀ˣ g(u) du`; `G(0) = G(1) = 0` in every region, algebraically. */
function capitalG(seg: Segment, x: number): number {
  const { g0, g1, eta, a } = seg;
  switch (seg.region) {
    case 'flat':
      return 0;
    case 'quadratic':
      return g0 * (x - 2 * x * x + x * x * x) + g1 * (-(x * x) + x * x * x);
    case 'left-flat': {
      if (x <= eta) return g0 * x;
      const d = x - eta;
      return g0 * x + ((g1 - g0) * d * d * d) / (3 * (1 - eta) * (1 - eta));
    }
    case 'right-flat': {
      const head = (u: number): number =>
        g1 * u + ((g0 - g1) * (eta * eta * eta - (eta - u) * (eta - u) * (eta - u))) / (3 * eta * eta);
      if (x <= eta) return head(x);
      return head(eta) + g1 * (x - eta);
    }
    case 'split': {
      const head = (u: number): number =>
        a * u + ((g0 - a) * (eta * eta * eta - (eta - u) * (eta - u) * (eta - u))) / (3 * eta * eta);
      if (x <= eta) return head(x);
      const d = x - eta;
      return head(eta) + a * d + ((g1 - a) * d * d * d) / (3 * (1 - eta) * (1 - eta));
    }
  }
}

function clampBetween(value: number, boundA: number, boundB: number): number {
  const lo = Math.min(boundA, boundB);
  const hi = Math.max(boundA, boundB);
  return Math.min(hi, Math.max(lo, value));
}

/**
 * `monotone_convex` — Hagan & West (2006) §4 with the §5 positivity collar.
 *
 * Construction:
 *  1. discrete forwards `fᵈᵢ = (yᵢ − yᵢ₋₁)/Δtᵢ` over every interval, the left anchor being `(0, 0)`;
 *  2. node forwards `fᵢ` as the Δt-weighted average of the two adjacent discrete forwards, with the
 *     paper's end conditions `f₀ = fᵈ₁ − ½(f₁ − fᵈ₁)` and `fₙ = fᵈₙ − ½(fₙ₋₁ − fᵈₙ)`;
 *  3. the collar `0 ≤ fᵢ ≤ 2·min(fᵈᵢ, fᵈᵢ₊₁)`, which is what guarantees `f(t) ≥ fᵈᵢ/2 > 0` inside
 *     every interval when the discrete forwards are positive — the property the stress test asserts;
 *  4. per interval, `f(t) = fᵈᵢ + g(x)` with `∫₀¹g = 0`, so `y` (hence every node discount factor)
 *     is reproduced to the last bit and only the shape *between* nodes changes.
 *
 * Past the last node the last interval's discrete forward is held flat.
 */
export function monotoneConvex(points: readonly DfPoint[]): Interpolator {
  const knots = knotsOf(points, 'monotone_convex');
  const { t, y, dt, fd, n } = knots;

  // Node forwards f[0..n].
  const f: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n - 1; i += 1) {
    const span = (t[i + 1] ?? 0) - (t[i - 1] ?? 0);
    f[i] = ((dt[i + 1] ?? 0) * (fd[i] ?? 0) + (dt[i] ?? 0) * (fd[i + 1] ?? 0)) / span;
  }
  if (n === 1) {
    f[0] = fd[1] ?? 0;
    f[1] = fd[1] ?? 0;
  } else {
    f[0] = (fd[1] ?? 0) - 0.5 * ((f[1] ?? 0) - (fd[1] ?? 0));
    f[n] = (fd[n] ?? 0) - 0.5 * ((f[n - 1] ?? 0) - (fd[n] ?? 0));
  }
  // §5 collar. Written with min/max bounds so a genuinely negative discrete forward (an inverted
  // real-money curve) still produces an ordered interval rather than an inverted clamp.
  f[0] = clampBetween(f[0] ?? 0, 0, 2 * (fd[1] ?? 0));
  for (let i = 1; i <= n - 1; i += 1) {
    f[i] = clampBetween(f[i] ?? 0, 0, 2 * Math.min(fd[i] ?? 0, fd[i + 1] ?? 0));
  }
  f[n] = clampBetween(f[n] ?? 0, 0, 2 * (fd[n] ?? 0));

  const segments: Segment[] = [];
  for (let i = 1; i <= n; i += 1) {
    segments.push(classify((f[i - 1] ?? 0) - (fd[i] ?? 0), (f[i] ?? 0) - (fd[i] ?? 0)));
  }

  const y0 = (time: number): number => {
    if (time >= (t[n] ?? 0)) {
      return (y[n] ?? 0) + (fd[n] ?? 0) * (time - (t[n] ?? 0));
    }
    const i = intervalOf(knots, time);
    const seg = segments[i - 1];
    if (seg === undefined) return y[i] ?? 0;
    const x = (time - (t[i - 1] ?? 0)) / (dt[i] ?? 1);
    return (y[i - 1] ?? 0) + (fd[i] ?? 0) * (dt[i] ?? 0) * x + (dt[i] ?? 0) * capitalG(seg, x);
  };
  const f0 = (time: number): number => {
    if (time > (t[n] ?? 0)) return fd[n] ?? 0;
    const i = intervalOf(knots, time);
    const seg = segments[i - 1];
    if (seg === undefined) return fd[i] ?? 0;
    const x = (time - (t[i - 1] ?? 0)) / (dt[i] ?? 1);
    return (fd[i] ?? 0) + gOf(seg, x);
  };
  return finish('monotone_convex', knots, y0, f0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Build the interpolator named by a `curves.default_interpolation` value. */
export function makeInterpolator(
  name: InterpolationName,
  points: readonly DfPoint[],
): Interpolator {
  switch (name) {
    case 'linear_zero':
      return linearZero(points);
    case 'log_linear_df':
      return logLinearDf(points);
    case 'monotone_convex':
      return monotoneConvex(points);
    default:
      throw new RangeError(
        `makeInterpolator: ${JSON.stringify(name)} is not one of ${INTERPOLATION_NAMES.join(' | ')}`,
      );
  }
}
