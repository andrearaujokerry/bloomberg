/**
 * The key-rate bump — FUNCTIONS_TIER3.md §0 "Key-rate durations", shared by every screen that
 * reports a `KRD_*` field.
 *
 * A key-rate duration is only worth reporting if it carries the **twist** exposure a single
 * duration number hides, and that is a property of *how it is computed*: bump one region of the
 * zero curve, reprice the instrument on the bumped curve, and take the difference. A tent-weighted
 * slice of a yield-space duration is not a key-rate duration — it cannot disagree with the
 * duration it was carved out of, so it sums to it exactly and says nothing about the curve. This
 * module exists so `KRD_2Y` means one thing: the same perturbation operator, applied to whatever
 * curve the instrument prices on, for YAS (a bond, on `UST_PAR`) and SWPM (a swap, on `SOFR_OIS`).
 *
 * Two pieces, both pure:
 *
 *  1. {@link keyRateKernelWeight} — the §0 triangular kernel: 1 at the key tenor, falling linearly
 *     to 0 at the neighbouring key tenors, held at 1 beyond the first and last of them. The kernels
 *     form a **partition of unity** over the whole time axis, so bumping every key tenor at once is
 *     exactly a parallel 1 bp shift. That is what makes `Σ KRDᵢ` the curve's parallel-shift
 *     duration — to within the finite-difference truncation, not exactly, because each KRD is a
 *     separate reprice.
 *  2. {@link bumpedDfPoints} — `df'(t) = df(t)·exp(−w(t)·δ·t)`, a `w(t)·δ` rise in the
 *     **continuously compounded** zero rate (FUNCTIONS_TIER3 §0 "Curve build" quotes `zero(t)`
 *     continuously). Applying the shift in log-discount space is what keeps the operator identical
 *     on every curve: it does not depend on the basis the curve happens to *quote* its zeros on,
 *     so the same 1 bp means the same perturbation of `UST_PAR` (`curves.compounding='semiannual'`)
 *     and of `SOFR_OIS` (`'simple'`), and two instruments hedged against each other on these
 *     numbers are measured against the same move.
 *
 * `δ` is signed: pass `+KEY_RATE_ONE_BP` for the up-shift and `−KEY_RATE_ONE_BP` for the down-shift
 * of a central difference. A weight of 0 returns the node untouched, bit for bit.
 */

import type { DfPoint } from './interp.js';

/** One basis point as a decimal rate — the unit §0 bumps in. */
export const KEY_RATE_ONE_BP = 1e-4;

/** A key tenor and the two key tenors either side of it (`null` at the ends of the grid). */
export interface KeyRateNode {
  /** The key tenor in years, where the kernel peaks at 1. */
  readonly key: number;
  /** The next key tenor below, where the kernel reaches 0; `null` = flat 1 below `key`. */
  readonly previous: number | null;
  /** The next key tenor above, where the kernel reaches 0; `null` = flat 1 above `key`. */
  readonly next: number | null;
}

/**
 * The §0 triangular kernel at `t` for the key tenor `key`.
 *
 * Flat at 1 below the first key and above the last, so no part of the curve is left unbumped when
 * every key is bumped — the property the sum leans on.
 */
export function keyRateKernelWeight(
  t: number,
  key: number,
  previous: number | null,
  next: number | null,
): number {
  if (t === key) return 1;
  if (t < key) {
    if (previous === null) return 1;
    if (t <= previous) return 0;
    return (t - previous) / (key - previous);
  }
  if (next === null) return 1;
  if (t >= next) return 0;
  return (next - t) / (next - key);
}

/**
 * Sort a key-rate grid and pair each tenor with its neighbours — the shape
 * {@link keyRateKernelWeight} and {@link bumpedDfPoints} take.
 *
 * Duplicates collapse: two buckets at the same tenor would double-count the same bump.
 */
export function keyRateNodes(tenors: readonly number[]): KeyRateNode[] {
  const keys = [...new Set(tenors)].sort((a, b) => a - b);
  if (keys.length === 0) {
    throw new RangeError('keyRateNodes: at least one key tenor is needed');
  }
  for (const key of keys) {
    if (!Number.isFinite(key) || key <= 0) {
      throw new RangeError(`keyRateNodes: a key tenor must be positive, got ${String(key)}`);
    }
  }
  return keys.map((key, i) => ({
    key,
    previous: i === 0 ? null : keys[i - 1]!,
    next: i === keys.length - 1 ? null : keys[i + 1]!,
  }));
}

/**
 * `df'(t) = df(t)·exp(−w(t)·bump·t)` — the curve with one key tenor shifted by `bump` (signed,
 * decimal) under the §0 kernel.
 *
 * Nodes the kernel does not reach come back untouched rather than multiplied by `exp(0)`, so an
 * unbumped region of the curve is bit-identical to the input.
 */
export function bumpedDfPoints(
  points: readonly DfPoint[],
  node: KeyRateNode,
  bump: number,
): DfPoint[] {
  return points.map((p) => {
    const w = keyRateKernelWeight(p.t, node.key, node.previous, node.next);
    if (w === 0) return { t: p.t, df: p.df };
    return { t: p.t, df: p.df * Math.exp(-w * bump * p.t) };
  });
}
