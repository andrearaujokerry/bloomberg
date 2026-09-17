/**
 * Brinson–Fachler performance attribution (PORT-03) — WORKPLAN L516, L549, ARCHITECTURE L177,
 * FUNCTIONS_TIER2 L1435 (`portfolio/attribution@1.0.0`).
 *
 * Single period, `n` segments (sectors, or securities inside a sector). For segment `i` with
 * portfolio weight `wPᵢ` and return `rPᵢ`, benchmark weight `wBᵢ` and return `rBᵢ`, and total
 * benchmark return `R_B = Σ wBᵢ rBᵢ`:
 *
 * ```
 *   allocationᵢ  = (wPᵢ − wBᵢ) · (rBᵢ − R_B)      ← Fachler: relative to the whole benchmark
 *   selectionᵢ   =  wBᵢ        · (rPᵢ − rBᵢ)
 *   interactionᵢ = (wPᵢ − wBᵢ) · (rPᵢ − rBᵢ)
 * ```
 *
 * The identity this module exists to guarantee (WORKPLAN L549):
 *
 * ```
 *   Σᵢ (allocationᵢ + selectionᵢ + interactionᵢ) = Σᵢ wPᵢ rPᵢ − Σᵢ wBᵢ rBᵢ = R_P − R_B
 * ```
 *
 * Per segment the three terms telescope to `wPᵢ rPᵢ − wBᵢ rBᵢ − (wPᵢ − wBᵢ) R_B`; summing, the
 * last term is `R_B · (Σ wPᵢ − Σ wBᵢ)`, which vanishes **only because both weight vectors sum to
 * one**. That is why {@link brinsonFachler} validates the two weight sums instead of trusting
 * them: an unnormalised weight column is the one input that silently breaks the identity, and the
 * `−R_B` term is also the *only* difference between Brinson–Fachler and Brinson–Hood–Beebower,
 * whose allocation term is `(wPᵢ − wBᵢ) · rBᵢ` and whose total is identical.
 *
 * Fixed-income (curve/spread/carry) and currency attribution are **not** implemented: no source in
 * this wedge supplies those return decompositions (TRACEABILITY PORT-03, FUNCTIONS_TIER2 L1514
 * `FI_ATTRIBUTION_UNAVAILABLE` / `CCY_ATTRIBUTION_UNAVAILABLE`).
 *
 * Pure: no clock, no IO, no `Date`.
 */

import type { Conventions } from '../engine.js';
import { defineEngine } from '../engine.js';

import { compensatedSum } from './exposure.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conventions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `brinson-fachler` (the default, PORT-03) measures allocation against the *total* benchmark
 * return; `brinson-hood-beebower` measures it against zero. The three-term total is the same.
 */
export type AttributionModel = 'brinson-fachler' | 'brinson-hood-beebower';

/** Convention overrides accepted by {@link brinsonFachler}. */
export interface AttributionConventionOverrides {
  readonly model?: AttributionModel;
  /** What the segments are: `'sector'`, `'security'`, `'assetClass'`, … Labelling only. */
  readonly segmentBasis?: string;
  /** Tolerance on `|Σw − 1|` before the input is rejected. Default `1e-9`. */
  readonly weightSumTolerance?: number;
  /** Set `false` to attribute a book whose weights deliberately do not sum to 1. */
  readonly requireWeightsSumToOne?: boolean;
}

/** The attribution convention set, echoed in the outputs (ANAL-07). */
export interface AttributionConventions extends Conventions {
  readonly model: AttributionModel;
  readonly segmentBasis: string;
  readonly weightSumTolerance: number;
  readonly requireWeightsSumToOne: boolean;
  readonly linking: string;
  readonly allocationFormula: string;
  readonly selectionFormula: string;
  readonly interactionFormula: string;
  readonly activeReturnFormula: string;
  readonly returns: 'simple';
  readonly fixedIncomeAttribution: string;
  readonly currencyAttribution: string;
}

const FIXED_CONVENTIONS = {
  linking: 'single-period: effects are arithmetic and are not geometrically linked across periods',
  selectionFormula: 'selection_i = wB_i × (rP_i − rB_i)',
  interactionFormula: 'interaction_i = (wP_i − wB_i) × (rP_i − rB_i)',
  activeReturnFormula: 'activeReturn = Σ wP_i rP_i − Σ wB_i rB_i',
  returns: 'simple',
  fixedIncomeAttribution:
    'not computed: FI_ATTRIBUTION_UNAVAILABLE — no curve/spread/carry decomposition source (PORT-03 gap)',
  currencyAttribution:
    'not computed: CCY_ATTRIBUTION_UNAVAILABLE — no hedged/unhedged return decomposition source (PORT-03 gap)',
} as const;

const ALLOCATION_FORMULA: Readonly<Record<AttributionModel, string>> = Object.freeze({
  'brinson-fachler': 'allocation_i = (wP_i − wB_i) × (rB_i − R_B)',
  'brinson-hood-beebower': 'allocation_i = (wP_i − wB_i) × rB_i',
});

/** The default attribution conventions: Brinson–Fachler over sectors, single period. */
export const DEFAULT_ATTRIBUTION_CONVENTIONS: AttributionConventions = Object.freeze({
  model: 'brinson-fachler',
  segmentBasis: 'sector',
  weightSumTolerance: 1e-9,
  requireWeightsSumToOne: true,
  allocationFormula: ALLOCATION_FORMULA['brinson-fachler'],
  ...FIXED_CONVENTIONS,
} satisfies AttributionConventions);

/** Merge overrides onto {@link DEFAULT_ATTRIBUTION_CONVENTIONS} and validate. */
export function resolveAttributionConventions(
  overrides?: AttributionConventionOverrides,
): AttributionConventions {
  const model = overrides?.model ?? DEFAULT_ATTRIBUTION_CONVENTIONS.model;
  if (model !== 'brinson-fachler' && model !== 'brinson-hood-beebower') {
    throw new RangeError(
      `attribution: conventions.model must be 'brinson-fachler' or 'brinson-hood-beebower', got '${String(model)}'`,
    );
  }
  const tol = overrides?.weightSumTolerance ?? DEFAULT_ATTRIBUTION_CONVENTIONS.weightSumTolerance;
  if (typeof tol !== 'number' || !Number.isFinite(tol) || tol < 0) {
    throw new RangeError(
      `attribution: conventions.weightSumTolerance must be a non-negative number, got ${String(tol)}`,
    );
  }
  return Object.freeze({
    model,
    segmentBasis: overrides?.segmentBasis ?? DEFAULT_ATTRIBUTION_CONVENTIONS.segmentBasis,
    weightSumTolerance: tol,
    requireWeightsSumToOne:
      overrides?.requireWeightsSumToOne ?? DEFAULT_ATTRIBUTION_CONVENTIONS.requireWeightsSumToOne,
    allocationFormula: ALLOCATION_FORMULA[model],
    ...FIXED_CONVENTIONS,
  } satisfies AttributionConventions);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inputs and outputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One segment's portfolio and benchmark weight and return, as decimal fractions. */
export interface AttributionSegment {
  /** Sector name, security id — whatever `conventions.segmentBasis` says these are. */
  readonly segment: string;
  readonly portfolioWeight: number;
  readonly portfolioReturn: number;
  readonly benchmarkWeight: number;
  readonly benchmarkReturn: number;
}

/** One segment's decomposed contribution. */
export interface SegmentAttribution {
  readonly segment: string;
  readonly portfolioWeight: number;
  readonly portfolioReturn: number;
  readonly benchmarkWeight: number;
  readonly benchmarkReturn: number;
  /** `wP − wB` — the over/underweight. */
  readonly activeWeight: number;
  /** `rP − rB` — the segment's return edge. */
  readonly activeReturn: number;
  /** `wP × rP`. */
  readonly portfolioContribution: number;
  /** `wB × rB`. */
  readonly benchmarkContribution: number;
  readonly allocation: number;
  readonly selection: number;
  readonly interaction: number;
  /** `allocation + selection + interaction`. */
  readonly total: number;
}

/** What {@link brinsonFachler} returns. */
export interface AttributionResult {
  readonly segments: readonly SegmentAttribution[];
  /** `R_P = Σ wP_i rP_i`. */
  readonly portfolioReturn: number;
  /** `R_B = Σ wB_i rB_i`. */
  readonly benchmarkReturn: number;
  /** `R_P − R_B`. */
  readonly activeReturn: number;
  readonly allocation: number;
  readonly selection: number;
  readonly interaction: number;
  /** `allocation + selection + interaction` — equal to `activeReturn` (WORKPLAN L549). */
  readonly total: number;
  /** `activeReturn − total`. Zero by construction; reported so a screen can prove it. */
  readonly residual: number;
  readonly portfolioWeightSum: number;
  readonly benchmarkWeightSum: number;
  readonly conventions: AttributionConventions;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The analytic
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Assert without narrowing — see the note on `exposure.ts`'s twin. */
function requireArray(label: string, xs: unknown): void {
  if (!Array.isArray(xs)) {
    throw new TypeError(`attribution: ${label} must be an array`);
  }
}

function requireFinite(label: string, x: unknown): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new RangeError(`attribution: ${label} must be a finite number, got ${String(x)}`);
  }
  return x;
}

/**
 * Decompose active return into allocation, selection and interaction.
 *
 * The result's `total` equals `activeReturn` to the last bit for any input whose arithmetic is
 * exact in binary floating point, and to rounding otherwise; `residual` reports the difference.
 */
export function brinsonFachler(
  segments: readonly AttributionSegment[],
  conventions?: AttributionConventionOverrides,
): AttributionResult {
  const conv = resolveAttributionConventions(conventions);
  requireArray('segments', segments);
  if (segments.length === 0) {
    throw new RangeError('attribution: needs at least one segment');
  }

  const seen = new Set<string>();
  for (const s of segments) {
    if (typeof s.segment !== 'string' || s.segment.length === 0) {
      throw new RangeError('attribution: every segment needs a non-empty name');
    }
    if (seen.has(s.segment)) {
      throw new RangeError(`attribution: duplicate segment '${s.segment}'`);
    }
    seen.add(s.segment);
    requireFinite(`segment '${s.segment}' portfolioWeight`, s.portfolioWeight);
    requireFinite(`segment '${s.segment}' portfolioReturn`, s.portfolioReturn);
    requireFinite(`segment '${s.segment}' benchmarkWeight`, s.benchmarkWeight);
    requireFinite(`segment '${s.segment}' benchmarkReturn`, s.benchmarkReturn);
  }

  const portfolioWeightSum = compensatedSum(segments.map((s) => s.portfolioWeight));
  const benchmarkWeightSum = compensatedSum(segments.map((s) => s.benchmarkWeight));
  if (conv.requireWeightsSumToOne) {
    for (const [label, sum] of [
      ['portfolio', portfolioWeightSum],
      ['benchmark', benchmarkWeightSum],
    ] as const) {
      if (Math.abs(sum - 1) > conv.weightSumTolerance) {
        throw new RangeError(
          `attribution: ${label} weights sum to ${sum}, not 1 (tolerance ${conv.weightSumTolerance}); ` +
            'the allocation identity only holds for normalised weight vectors — normalise, or pass ' +
            'conventions.requireWeightsSumToOne = false',
        );
      }
    }
  }

  const portfolioReturn = compensatedSum(
    segments.map((s) => s.portfolioWeight * s.portfolioReturn),
  );
  const benchmarkReturn = compensatedSum(
    segments.map((s) => s.benchmarkWeight * s.benchmarkReturn),
  );
  const activeReturn = portfolioReturn - benchmarkReturn;
  const benchmarkBase = conv.model === 'brinson-fachler' ? benchmarkReturn : 0;

  const rows: SegmentAttribution[] = segments.map((s) => {
    const activeWeight = s.portfolioWeight - s.benchmarkWeight;
    const segmentActiveReturn = s.portfolioReturn - s.benchmarkReturn;
    const allocation = activeWeight * (s.benchmarkReturn - benchmarkBase);
    const selection = s.benchmarkWeight * segmentActiveReturn;
    const interaction = activeWeight * segmentActiveReturn;
    return {
      segment: s.segment,
      portfolioWeight: s.portfolioWeight,
      portfolioReturn: s.portfolioReturn,
      benchmarkWeight: s.benchmarkWeight,
      benchmarkReturn: s.benchmarkReturn,
      activeWeight,
      activeReturn: segmentActiveReturn,
      portfolioContribution: s.portfolioWeight * s.portfolioReturn,
      benchmarkContribution: s.benchmarkWeight * s.benchmarkReturn,
      allocation,
      selection,
      interaction,
      total: allocation + selection + interaction,
    };
  });

  const allocation = compensatedSum(rows.map((r) => r.allocation));
  const selection = compensatedSum(rows.map((r) => r.selection));
  const interaction = compensatedSum(rows.map((r) => r.interaction));
  const total = allocation + selection + interaction;

  return Object.freeze({
    segments: Object.freeze(rows),
    portfolioReturn,
    benchmarkReturn,
    activeReturn,
    allocation,
    selection,
    interaction,
    total,
    residual: activeReturn - total,
    portfolioWeightSum,
    benchmarkWeightSum,
    conventions: conv,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Building segments from holdings
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One holding on either side of the attribution, before grouping. */
export interface AttributionHolding {
  /** The grouping key: sector name, security id, asset class. */
  readonly segment: string;
  /** Weight in its own portfolio (or benchmark), decimal fraction. */
  readonly weight: number;
  /** The holding's return over the period, decimal fraction. */
  readonly return: number;
}

/**
 * Roll two holding lists up into {@link AttributionSegment}s: weights add, segment returns are the
 * weight-weighted average of their members (`Σ wᵢrᵢ / Σ wᵢ`), which is the only aggregation that
 * preserves `Σ w r` and therefore the identity. A segment present on one side only appears with a
 * zero weight and a zero return on the other — the standard convention for an unheld sector, and
 * the case Brinson–Fachler's `(rBᵢ − R_B)` term exists to price correctly.
 */
export function segmentsFromHoldings(
  portfolio: readonly AttributionHolding[],
  benchmark: readonly AttributionHolding[],
): AttributionSegment[] {
  const keys: string[] = [];
  const add = (holdings: readonly AttributionHolding[]): void => {
    for (const h of holdings) {
      if (!keys.includes(h.segment)) keys.push(h.segment);
    }
  };
  add(portfolio);
  add(benchmark);
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const roll = (
    holdings: readonly AttributionHolding[],
    key: string,
  ): { weight: number; ret: number } => {
    const members = holdings.filter((h) => h.segment === key);
    const weight = compensatedSum(members.map((h) => h.weight));
    if (weight === 0) return { weight: 0, ret: 0 };
    return { weight, ret: compensatedSum(members.map((h) => h.weight * h.return)) / weight };
  };

  return keys.map((key) => {
    const p = roll(portfolio, key);
    const b = roll(benchmark, key);
    return {
      segment: key,
      portfolioWeight: p.weight,
      portfolioReturn: p.ret,
      benchmarkWeight: b.weight,
      benchmarkReturn: b.ret,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The engine (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The declared input set of the `portfolio/attribution` engine. */
export type AttributionEngineInputs = {
  readonly segments: readonly AttributionSegment[];
  readonly conventions?: AttributionConventionOverrides;
};

/**
 * `portfolio/attribution@1.0.0` (FUNCTIONS_TIER2 L1435, PORT-03), wrapped in `defineEngine` so a
 * result carries its inputs, the engine identity and the `char(64)` `inputsHash` (ANAL-08).
 */
export const attributionEngine = defineEngine<AttributionEngineInputs, AttributionResult>(
  'portfolio/attribution',
  '1.0.0',
  (inputs) => brinsonFachler(inputs.segments, inputs.conventions),
);
