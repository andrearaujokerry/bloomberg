/**
 * Lattice option pricing: the Cox-Ross-Rubinstein binomial and a Kamrad-Ritchken trinomial, both
 * with American exercise — WORKPLAN §WP-02 L509-510, ARCHITECTURE L169.
 *
 * The trees exist for two reasons, and both are tested:
 *
 *  1. **American exercise.** BSM has no closed form for an American put, and the lattice is the
 *     reference implementation the terminal quotes from. `packages/core/test/analytics/options/
 *     tree.test.ts` pins the structural fact that makes it worth having: an American put is never
 *     worth less than the European put with the same terms, because the holder may always simply
 *     not exercise early.
 *  2. **An independent check on the closed form** (ANAL-09, TESTING §7.2 assertion 8). A lattice
 *     shares no code with `bsm.ts` — no `erfc`, no `d1` — so its convergence to 10.450584 is real
 *     corroboration rather than a tautology.
 *
 * Convergence, and why the tolerances in the test look loose. CRR's error on a European option is
 * `O(1/n)` but *oscillating*: the price sawtooths with the parity of `n`, because what moves is the
 * position of the strike relative to the terminal node grid. Averaging two adjacent step counts
 * (`n` and `n+1`) cancels the leading oscillation, which is why `crrAveraged` is exported and why a
 * bound quoted at a single `n` is an envelope, not a fudge factor. The trinomial's extra degree of
 * freedom (λ) puts a node exactly at the strike far more often, and it converges visibly smoother
 * at the same node count.
 *
 * Memory: the backward induction keeps one `Float64Array` row, so `steps = 5_000` is ~40 KB for
 * the binomial and ~80 KB for the trinomial, and the cost is the `O(n²)` arithmetic alone.
 */

import type { Conventions } from '../engine.js';
import { defineEngine } from '../engine.js';
import type { OptionType } from './bsm.js';

/** European (expiry only) or American (any time up to expiry). */
export type Exercise = 'european' | 'american';

/** Which lattice `treeEngine` should run. */
export type TreeMethod = 'crr' | 'trinomial';

/** A lattice's declared input set. */
export type TreeInputs = {
  readonly S: number;
  readonly K: number;
  /** Continuously compounded risk-free rate, annual. */
  readonly r: number;
  /** Continuous dividend yield, annual. */
  readonly q: number;
  readonly sigma: number;
  /** Years to expiry (ACT/365F). */
  readonly T: number;
  /** Time steps. More steps, more accuracy, `O(n²)` work. */
  readonly steps: number;
  readonly type: OptionType;
  readonly exercise: Exercise;
  /**
   * Trinomial stretch parameter λ ≥ 1 (Kamrad-Ritchken). Ignored by the binomial. Default
   * `√(3/2)`, which makes the middle probability exactly 1/3.
   */
  readonly lambda?: number;
};

/** What a lattice returns. Greeks come off the lattice itself, not from a reprice. */
export interface TreeOutputs {
  /** The option value at the root node. */
  readonly price: number;
  /** ∂V/∂S from the two step-1 nodes. */
  readonly delta: number;
  /** ∂²V/∂S² from the three step-2 nodes. */
  readonly gamma: number;
  /** ∂V/∂t per year, from the centre node two steps in (it sits at `t = 2·dt`, `S = S₀`). */
  readonly theta: number;
  readonly method: TreeMethod;
  readonly steps: number;
  /** `T / steps`. */
  readonly dt: number;
  /** Up move multiplier. */
  readonly up: number;
  /** Down move multiplier (`1 / up` for both lattices here). */
  readonly down: number;
  /** Risk-neutral probability of the up move. */
  readonly pUp: number;
  /** Risk-neutral probability of the down move. */
  readonly pDown: number;
  /** Risk-neutral probability of no move; `0` for the binomial. */
  readonly pMid: number;
  /**
   * `true` when the American value strictly exceeded the continuation value at some node, i.e.
   * early exercise was actually optimal somewhere on the lattice.
   */
  readonly earlyExercise: boolean;
  readonly conventions: Conventions;
}

/** The conventions a lattice result echoes (ANAL-07). */
function treeConventions(method: TreeMethod, exercise: Exercise, steps: number): Conventions {
  return Object.freeze({
    model: method === 'crr' ? 'cox_ross_rubinstein' : 'kamrad_ritchken_trinomial',
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    dividend: 'continuous_yield',
    exercise,
    steps,
  } satisfies Conventions);
}

/** Kamrad-Ritchken's λ: `pMid = 1 − 1/λ² = 1/3`. */
export const DEFAULT_TRINOMIAL_LAMBDA = Math.sqrt(1.5);

function validate(i: TreeInputs, method: TreeMethod): void {
  for (const [name, value] of [
    ['S', i.S],
    ['K', i.K],
    ['r', i.r],
    ['q', i.q],
    ['sigma', i.sigma],
    ['T', i.T],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${method}: ${name} must be a finite number, got ${String(value)}`);
    }
  }
  if (i.S <= 0) throw new RangeError(`${method}: S must be positive, got ${String(i.S)}`);
  if (i.K <= 0) throw new RangeError(`${method}: K must be positive, got ${String(i.K)}`);
  if (i.sigma < 0) throw new RangeError(`${method}: sigma must not be negative`);
  if (i.T < 0) throw new RangeError(`${method}: T must not be negative`);
  if (!Number.isInteger(i.steps) || i.steps < 1) {
    throw new RangeError(`${method}: steps must be a positive integer, got ${String(i.steps)}`);
  }
  if (i.type !== 'call' && i.type !== 'put') {
    throw new RangeError(`${method}: type must be 'call' or 'put', got '${String(i.type)}'`);
  }
  if (i.exercise !== 'european' && i.exercise !== 'american') {
    throw new RangeError(
      `${method}: exercise must be 'european' or 'american', got '${String(i.exercise)}'`,
    );
  }
}

/** Intrinsic value at a node. */
function payoff(type: OptionType, S: number, K: number): number {
  return type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
}

/** Degenerate lattice: expiry is now, so the value is the payoff and the greeks are the payoff's. */
function atExpiry(i: TreeInputs, method: TreeMethod): TreeOutputs {
  const intrinsic = payoff(i.type, i.S, i.K);
  const inTheMoney = i.type === 'call' ? i.S > i.K : i.S < i.K;
  return Object.freeze({
    price: intrinsic,
    delta: inTheMoney ? (i.type === 'call' ? 1 : -1) : 0,
    gamma: 0,
    theta: 0,
    method,
    steps: i.steps,
    dt: 0,
    up: 1,
    down: 1,
    pUp: 0,
    pDown: 0,
    pMid: 0,
    earlyExercise: false,
    conventions: treeConventions(method, i.exercise, i.steps),
  });
}

/**
 * `sigma = 0`: the lattice degenerates to a single deterministic path, and `u − d = 0` would be a
 * division by zero. The answer is exact instead of approximated — the underlying follows
 * `S·e^{(r−q)t}`, so a European option is the discounted terminal payoff and an American one is the
 * best discounted payoff over the exercise dates the lattice actually offers (`t = i·dt`). Delta is
 * `e^{−q·t*}` at the optimal exercise time when in the money; gamma and theta of a deterministic
 * path are zero.
 */
function deterministic(i: TreeInputs, method: TreeMethod): TreeOutputs {
  const { S, K, r, q, T, steps, type, exercise } = i;
  const dt = T / steps;
  let best = Math.exp(-r * T) * payoff(type, S * Math.exp((r - q) * T), K);
  let bestTime = T;
  if (exercise === 'american') {
    for (let step = 0; step < steps; step += 1) {
      const t = step * dt;
      const value = Math.exp(-r * t) * payoff(type, S * Math.exp((r - q) * t), K);
      if (value > best) {
        best = value;
        bestTime = t;
      }
    }
  }
  const inTheMoney = best > 0;
  const sign = type === 'call' ? 1 : -1;
  return Object.freeze({
    price: best,
    delta: inTheMoney ? sign * Math.exp(-q * bestTime) : 0,
    gamma: 0,
    theta: 0,
    method,
    steps,
    dt,
    up: 1,
    down: 1,
    pUp: method === 'crr' ? 1 : 0,
    pDown: 0,
    pMid: method === 'crr' ? 0 : 1,
    earlyExercise: exercise === 'american' && bestTime < T,
    conventions: treeConventions(method, exercise, steps),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cox-Ross-Rubinstein binomial
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * CRR binomial, European or American.
 *
 * `u = e^{σ√dt}`, `d = 1/u`, `p = (e^{(r−q)dt} − d)/(u − d)`: the multiplicative, recombining
 * lattice whose log-moves match the diffusion's variance to `O(dt)`. The `u`/`d` grid is built
 * once and indexed, so the terminal prices are `S·u^{2j−n}` with no repeated exponentiation.
 *
 * With `sigma√dt` large enough that `p` leaves `[0, 1]` the lattice is not a probability model at
 * all; that throws rather than silently returning a negative price.
 */
export function crr(inputs: TreeInputs): TreeOutputs {
  validate(inputs, 'crr');
  const { S, K, r, q, sigma, T, steps, type, exercise } = inputs;
  if (T === 0) return atExpiry(inputs, 'crr');
  if (sigma === 0) return deterministic(inputs, 'crr');

  const dt = T / steps;
  const up = Math.exp(sigma * Math.sqrt(dt));
  const down = 1 / up;
  const growth = Math.exp((r - q) * dt);
  const disc = Math.exp(-r * dt);
  const pUp = (growth - down) / (up - down);
  const pDown = 1 - pUp;
  if (!(pUp >= 0 && pUp <= 1)) {
    throw new RangeError(
      `crr: risk-neutral probability ${String(pUp)} is outside [0, 1] — dt is too large for ` +
        `sigma=${String(sigma)}; increase steps`,
    );
  }

  // Node prices at the final layer: S·u^{2j−n}, j = 0…n.
  const values = new Float64Array(steps + 1);
  const lowest = S * Math.pow(down, steps);
  const ratio = up * up;
  let price = lowest;
  let earlyExercise = false;
  for (let j = 0; j <= steps; j += 1) {
    values[j] = payoff(type, price, K);
    price *= ratio;
  }

  // Backward induction. `layerLowest` tracks S·u^{−i} so a node price is one multiply away.
  let deltaNodes: readonly [number, number] | null = null;
  let gammaNodes: readonly [number, number, number] | null = null;
  let centreAtStep2 = Number.NaN;
  for (let i = steps - 1; i >= 0; i -= 1) {
    const layerLowest = S * Math.pow(down, i);
    let nodePrice = layerLowest;
    for (let j = 0; j <= i; j += 1) {
      const continuation = disc * (pUp * (values[j + 1] ?? 0) + pDown * (values[j] ?? 0));
      if (exercise === 'american') {
        const intrinsic = payoff(type, nodePrice, K);
        if (intrinsic > continuation) {
          earlyExercise = true;
          values[j] = intrinsic;
        } else {
          values[j] = continuation;
        }
      } else {
        values[j] = continuation;
      }
      nodePrice *= ratio;
    }
    if (i === 2) {
      gammaNodes = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
      centreAtStep2 = values[1] ?? 0;
    }
    if (i === 1) deltaNodes = [values[0] ?? 0, values[1] ?? 0];
  }

  const root = values[0] ?? 0;
  const sUp = S * up;
  const sDown = S * down;
  const delta = deltaNodes === null ? Number.NaN : (deltaNodes[1] - deltaNodes[0]) / (sUp - sDown);

  let gamma = Number.NaN;
  let theta = Number.NaN;
  if (gammaNodes !== null) {
    const sUu = S * up * up;
    const sDd = S * down * down;
    const upperSlope = (gammaNodes[2] - gammaNodes[1]) / (sUu - S);
    const lowerSlope = (gammaNodes[1] - gammaNodes[0]) / (S - sDd);
    gamma = (upperSlope - lowerSlope) / (0.5 * (sUu - sDd));
    theta = (centreAtStep2 - root) / (2 * dt);
  }

  return Object.freeze({
    price: root,
    delta,
    gamma,
    theta,
    method: 'crr' as const,
    steps,
    dt,
    up,
    down,
    pUp,
    pDown,
    pMid: 0,
    earlyExercise,
    conventions: treeConventions('crr', exercise, steps),
  });
}

/**
 * The average of `crr` at `n` and `n + 1` steps.
 *
 * CRR's European error oscillates with the parity of the step count: the two prices straddle the
 * true value, so their mean kills the leading `O(1/n)` term and converges roughly `O(1/n²)`. This
 * is the standard way to quote a lattice price, and the tree test uses it to show the *smooth*
 * convergence underneath the sawtooth.
 */
export function crrAveraged(inputs: TreeInputs): number {
  const a = crr(inputs);
  const b = crr({ ...inputs, steps: inputs.steps + 1 });
  return 0.5 * (a.price + b.price);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Kamrad-Ritchken trinomial
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Trinomial lattice (Kamrad & Ritchken 1991), European or American.
 *
 * `u = e^{λσ√dt}`, `m = 1`, `d = 1/u` with
 * `pu = 1/(2λ²) + ν√dt/(2λσ)`, `pm = 1 − 1/λ²`, `pd = 1/(2λ²) − ν√dt/(2λσ)`, `ν = r − q − σ²/2`.
 *
 * At the default `λ = √(3/2)` the middle branch carries 1/3 of the mass. The extra branch is what
 * makes the lattice smooth: the centre column stays at `S₀` for every step, so the strike is
 * straddled the same way at every step count instead of drifting with the parity of `n`.
 */
export function trinomial(inputs: TreeInputs): TreeOutputs {
  validate(inputs, 'trinomial');
  const { S, K, r, q, sigma, T, steps, type, exercise } = inputs;
  if (T === 0) return atExpiry(inputs, 'trinomial');
  if (sigma === 0) return deterministic(inputs, 'trinomial');

  const lambda = inputs.lambda ?? DEFAULT_TRINOMIAL_LAMBDA;
  if (!Number.isFinite(lambda) || lambda < 1) {
    throw new RangeError(`trinomial: lambda must be a finite number ≥ 1, got ${String(lambda)}`);
  }

  const dt = T / steps;
  const sqrtDt = Math.sqrt(dt);
  const nu = r - q - 0.5 * sigma * sigma;
  const up = Math.exp(lambda * sigma * sqrtDt);
  const down = 1 / up;
  const disc = Math.exp(-r * dt);

  const base = 1 / (2 * lambda * lambda);
  const drift = (nu * sqrtDt) / (2 * lambda * sigma);
  const pUp = base + drift;
  const pMid = 1 - 2 * base;
  const pDown = base - drift;
  if (!(pUp >= 0 && pDown >= 0 && pMid >= 0)) {
    throw new RangeError(
      `trinomial: probabilities (${String(pUp)}, ${String(pMid)}, ${String(pDown)}) are not a ` +
        `distribution — dt is too large for sigma=${String(sigma)}; increase steps`,
    );
  }

  // 2n+1 terminal nodes: S·u^{k−n}, k = 0…2n. Index k counts up-moves minus down-moves, offset n.
  const width = 2 * steps + 1;
  const values = new Float64Array(width);
  let nodePrice = S * Math.pow(down, steps);
  let earlyExercise = false;
  for (let k = 0; k < width; k += 1) {
    values[k] = payoff(type, nodePrice, K);
    nodePrice *= up;
  }

  let deltaNodes: readonly [number, number] | null = null;
  let gammaNodes: readonly [number, number, number] | null = null;
  let centreAtStep1 = Number.NaN;
  for (let i = steps - 1; i >= 0; i -= 1) {
    const layerWidth = 2 * i + 1;
    let layerPrice = S * Math.pow(down, i);
    for (let k = 0; k < layerWidth; k += 1) {
      const continuation =
        disc *
        (pUp * (values[k + 2] ?? 0) + pMid * (values[k + 1] ?? 0) + pDown * (values[k] ?? 0));
      if (exercise === 'american') {
        const intrinsic = payoff(type, layerPrice, K);
        if (intrinsic > continuation) {
          earlyExercise = true;
          values[k] = intrinsic;
        } else {
          values[k] = continuation;
        }
      } else {
        values[k] = continuation;
      }
      layerPrice *= up;
    }
    if (i === 1) {
      // One step in, the three surviving nodes are S·d, S, S·u — delta and gamma in one layer.
      gammaNodes = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
      deltaNodes = [values[0] ?? 0, values[2] ?? 0];
      centreAtStep1 = values[1] ?? 0;
    }
  }

  const root = values[0] ?? 0;
  const sUp = S * up;
  const sDown = S * down;
  const delta = deltaNodes === null ? Number.NaN : (deltaNodes[1] - deltaNodes[0]) / (sUp - sDown);
  let gamma = Number.NaN;
  let theta = Number.NaN;
  if (gammaNodes !== null) {
    const upperSlope = (gammaNodes[2] - gammaNodes[1]) / (sUp - S);
    const lowerSlope = (gammaNodes[1] - gammaNodes[0]) / (S - sDown);
    gamma = (upperSlope - lowerSlope) / (0.5 * (sUp - sDown));
    theta = (centreAtStep1 - root) / dt;
  }

  return Object.freeze({
    price: root,
    delta,
    gamma,
    theta,
    method: 'trinomial' as const,
    steps,
    dt,
    up,
    down,
    pUp,
    pDown,
    pMid,
    earlyExercise,
    conventions: treeConventions('trinomial', exercise, steps),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engine (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `treeEngine`'s input set: a lattice plus which lattice. */
export type TreeEngineInputs = TreeInputs & { readonly method: TreeMethod };

/** `option.tree@1.0.0` — CRR or trinomial, selected by `inputs.method`. */
export const treeEngine = defineEngine<TreeEngineInputs, TreeOutputs>(
  'option.tree',
  '1.0.0',
  (i) => {
    const lattice: TreeInputs = {
      S: i.S,
      K: i.K,
      r: i.r,
      q: i.q,
      sigma: i.sigma,
      T: i.T,
      steps: i.steps,
      type: i.type,
      exercise: i.exercise,
      ...(i.lambda === undefined ? {} : { lambda: i.lambda }),
    };
    if (i.method === 'crr') return crr(lattice);
    if (i.method === 'trinomial') return trinomial(lattice);
    throw new RangeError(
      `option.tree: method must be 'crr' or 'trinomial', got '${String(i.method)}'`,
    );
  },
);
