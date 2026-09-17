/**
 * Seeded Monte Carlo for European options, with antithetic variates and a control variate —
 * WORKPLAN §WP-02 L510, ARCHITECTURE L170, TESTING §7.2 assertion 8.
 *
 * The contract, in order of importance:
 *
 *  1. **A seed determines the answer, bit for bit.** `Math.random` is a banned property in
 *     `packages/core/src/**` (QA-02): every draw comes from `analytics/prng.ts`, the xoshiro128**
 *     generator whose state is derived from `sha256Hex('xoshiro128**:' + seed)`. Two runs of
 *     `monteCarlo` with the same inputs produce the identical double — not "the same to six
 *     decimals" — because the draws, the arithmetic and the accumulation order are all fixed. A
 *     Monte Carlo price that cannot be reproduced is not a price.
 *  2. **Variance reduction is on by default**, because the alternative is quoting an error bar four
 *     times wider for the same cost:
 *     - *antithetic variates*: each normal `z` is used twice, as `z` and `−z`. The pair average is
 *       the sample. For a monotone payoff the two halves are negatively correlated, so the pair
 *       average has less than half the variance of one path — the variance falls by more than the
 *       factor of two that simply doubling the path count would buy.
 *     - *control variate on the terminal spot*: `E[S_T] = S·e^{(r−q)T}` is known exactly, and
 *       `S_T` is strongly correlated with the payoff. The estimator is
 *       `Ȳ − β(X̄ − E[X])` with `β = Cov(Y, X)/Var(X)` estimated from the same sample, which is the
 *       textbook (slightly biased, `O(1/n)`, far below the standard error) regression estimator.
 *  3. **The standard error is reported, and it is the *controlled* standard error**
 *     `sqrt((Var Y − Cov²/Var X)/n)` — the error bar of the number actually returned, not of the
 *     naive mean. TESTING §7.2 asks the Monte Carlo price to sit within ≈3 standard errors of the
 *     closed form, and that is only a meaningful assertion if the standard error is the right one.
 *
 * Only the terminal value is simulated: a European payoff depends on `S_T` alone, so the exact
 * one-step lognormal draw `S_T = S·exp((r − q − σ²/2)T + σ√T·z)` is both faster and *exact* — there
 * is no time-discretisation bias to trade off, unlike an Euler scheme.
 *
 * Portability note: the xoshiro stream is exactly reproducible everywhere (it is integer
 * arithmetic), and so is every operation here; the one machine-dependent ingredient anywhere in the
 * chain is the host `Math.exp`/`log`/`sin`/`cos`, which V8 implements in software and identically
 * on every platform. Bit-identity therefore holds across machines and releases on the pinned
 * runtime, which is what the test asserts.
 */

import type { Conventions } from '../engine.js';
import { defineEngine } from '../engine.js';
import { makePrng } from '../prng.js';
import type { OptionType } from './bsm.js';

/** Which control variate to regress the payoff on. */
export type ControlVariate = 'none' | 'terminal_spot';

/** The Monte Carlo engine's declared input set. */
export type McInputs = {
  readonly S: number;
  readonly K: number;
  /** Continuously compounded risk-free rate, annual. */
  readonly r: number;
  /** Continuous dividend yield, annual. */
  readonly q: number;
  readonly sigma: number;
  /** Years to expiry (ACT/365F). */
  readonly T: number;
  readonly type: OptionType;
  /**
   * Total simulated paths. With `antithetic` on (the default) they come in mirrored pairs, so this
   * must be even and the number of independent samples is `paths / 2`.
   */
  readonly paths: number;
  /** The PRNG seed. The same seed is the same sequence in every process (ANAL-08, QA-02). */
  readonly seed: number | string;
  /** Antithetic variates. Default `true`. */
  readonly antithetic?: boolean;
  /** Control variate. Default `'terminal_spot'`. */
  readonly control?: ControlVariate;
};

/** What the simulation reports. */
export interface McOutputs {
  /** The variance-reduced price estimate — the number to quote. */
  readonly price: number;
  /** The plain discounted-payoff mean, with no control variate applied, for comparison. */
  readonly priceUncontrolled: number;
  /** Standard error of `price`. */
  readonly stdError: number;
  /** Standard error of `priceUncontrolled`. */
  readonly stdErrorUncontrolled: number;
  /** `price − 1.959964·stdError`. */
  readonly ci95Low: number;
  /** `price + 1.959964·stdError`. */
  readonly ci95High: number;
  /** The fitted control-variate coefficient `β`; `0` when no control variate is used. */
  readonly beta: number;
  /** Correlation between the discounted payoff and the control; `0` without a control. */
  readonly controlCorrelation: number;
  /** `Var(uncontrolled) / Var(controlled)` — how much the control variate actually bought. */
  readonly varianceReduction: number;
  /** Independent samples averaged (`paths / 2` when antithetic). */
  readonly samples: number;
  readonly paths: number;
  readonly seed: number | string;
  readonly conventions: Conventions;
}

/** Two-sided 95 % normal quantile. */
const Z95 = 1.959963984540054;

function validate(i: McInputs): void {
  for (const [name, value] of [
    ['S', i.S],
    ['K', i.K],
    ['r', i.r],
    ['q', i.q],
    ['sigma', i.sigma],
    ['T', i.T],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`option.mc: ${name} must be a finite number, got ${String(value)}`);
    }
  }
  if (i.S <= 0) throw new RangeError(`option.mc: S must be positive, got ${String(i.S)}`);
  if (i.K <= 0) throw new RangeError(`option.mc: K must be positive, got ${String(i.K)}`);
  if (i.sigma < 0) throw new RangeError('option.mc: sigma must not be negative');
  if (i.T < 0) throw new RangeError('option.mc: T must not be negative');
  if (!Number.isInteger(i.paths) || i.paths < 2) {
    throw new RangeError(`option.mc: paths must be an integer ≥ 2, got ${String(i.paths)}`);
  }
  if ((i.antithetic ?? true) && i.paths % 2 !== 0) {
    throw new RangeError(
      `option.mc: antithetic sampling pairs every path, so paths must be even, got ${String(i.paths)}`,
    );
  }
  if (i.type !== 'call' && i.type !== 'put') {
    throw new RangeError(`option.mc: type must be 'call' or 'put', got '${String(i.type)}'`);
  }
}

function mcConventions(i: McInputs, antithetic: boolean, control: ControlVariate): Conventions {
  return Object.freeze({
    model: 'monte_carlo_gbm_terminal',
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    dividend: 'continuous_yield',
    exercise: 'european',
    prng: 'xoshiro128**',
    normal: 'box_muller',
    antithetic,
    control,
    paths: i.paths,
  } satisfies Conventions);
}

/**
 * Price a European call or put by simulation.
 *
 * Deterministic in its inputs: same inputs, same double, every time.
 */
export function monteCarlo(inputs: McInputs): McOutputs {
  validate(inputs);
  const { S, K, r, q, sigma, T, type, paths, seed } = inputs;
  const antithetic = inputs.antithetic ?? true;
  const control = inputs.control ?? 'terminal_spot';

  const samples = antithetic ? paths / 2 : paths;
  const disc = Math.exp(-r * T);
  const drift = (r - q - 0.5 * sigma * sigma) * T;
  const diffusion = sigma * Math.sqrt(T);
  /** `E[S_T]` under the risk-neutral measure — the control variate's exact mean. */
  const controlMean = S * Math.exp((r - q) * T);

  const rng = makePrng(seed);
  const isCall = type === 'call';

  // Running sums: the estimator, its variance and the control regression all come from these.
  let sumY = 0;
  let sumY2 = 0;
  let sumX = 0;
  let sumX2 = 0;
  let sumXY = 0;

  for (let i = 0; i < samples; i += 1) {
    const z = rng.normal();
    const sT = S * Math.exp(drift + diffusion * z);
    let payoff = isCall ? Math.max(sT - K, 0) : Math.max(K - sT, 0);
    let spot = sT;
    if (antithetic) {
      const sTMirror = S * Math.exp(drift - diffusion * z);
      payoff = 0.5 * (payoff + (isCall ? Math.max(sTMirror - K, 0) : Math.max(K - sTMirror, 0)));
      spot = 0.5 * (sT + sTMirror);
    }
    const y = disc * payoff;
    sumY += y;
    sumY2 += y * y;
    sumX += spot;
    sumX2 += spot * spot;
    sumXY += spot * y;
  }

  const n = samples;
  const meanY = sumY / n;
  const meanX = sumX / n;
  // Sample (ddof = 1) variances and covariance. `n = 1` has no variance to report: the estimator
  // is still the mean, the error bar is simply unknown.
  const denom = n > 1 ? n - 1 : 1;
  const varY = Math.max((sumY2 - n * meanY * meanY) / denom, 0);
  const varX = Math.max((sumX2 - n * meanX * meanX) / denom, 0);
  const covXY = (sumXY - n * meanX * meanY) / denom;

  let beta = 0;
  let price = meanY;
  let varControlled = varY;
  let correlation = 0;
  if (control === 'terminal_spot' && varX > 0 && n > 1) {
    beta = covXY / varX;
    price = meanY - beta * (meanX - controlMean);
    // Var(Y − βX) = VarY − Cov²/VarX at the optimal β; clamp at 0 against rounding.
    varControlled = Math.max(varY - (covXY * covXY) / varX, 0);
    correlation = varY > 0 ? covXY / Math.sqrt(varY * varX) : 0;
  }

  const stdError = n > 1 ? Math.sqrt(varControlled / n) : Number.NaN;
  const stdErrorUncontrolled = n > 1 ? Math.sqrt(varY / n) : Number.NaN;

  return Object.freeze({
    price,
    priceUncontrolled: meanY,
    stdError,
    stdErrorUncontrolled,
    ci95Low: price - Z95 * stdError,
    ci95High: price + Z95 * stdError,
    beta,
    controlCorrelation: correlation,
    varianceReduction: varControlled > 0 ? varY / varControlled : Number.POSITIVE_INFINITY,
    samples: n,
    paths,
    seed,
    conventions: mcConventions(inputs, antithetic, control),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Engine (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `option.mc@1.0.0`. The seed is part of the declared input set, so `inputsHash` changes when the
 * seed changes: a re-run with a different seed is a different computation, and the `inputs_hash`
 * columns record that honestly.
 */
export const mcEngine = defineEngine<McInputs, McOutputs>('option.mc', '1.0.0', (i) =>
  monteCarlo({
    S: i.S,
    K: i.K,
    r: i.r,
    q: i.q,
    sigma: i.sigma,
    T: i.T,
    type: i.type,
    paths: i.paths,
    seed: i.seed,
    ...(i.antithetic === undefined ? {} : { antithetic: i.antithetic }),
    ...(i.control === undefined ? {} : { control: i.control }),
  }),
);
