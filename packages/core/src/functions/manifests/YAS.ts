// packages/core/src/functions/manifests/YAS.ts
//
// `YAS` — Yield & Spread Analysis (FUNCTIONS_TIER3.md §YAS L75-226, FUNCTIONS.md §6 L1105).
//
// One Treasury, every number a desk quotes it by: price↔yield on the street convention, accrued,
// duration, convexity, DV01, key-rate durations, the spread and Z-spread to a curve, and the
// remaining cashflows discounted on that curve. YAS is polymorphic *inside* the `govt` variant on
// `govt_terms.security_type` (FUNC-02): a coupon security prices on the ACT/ACT semiannual street
// convention, a bill on the ACT/360 discount basis, and TIPS/FRNs are refused with a reason
// rather than priced on a convention that does not apply to them.
//
// **Every number in the payload comes out of an `EngineResult`** (ANAL-08). That is the point of
// this package: `meta.engines[]` carries `{name, version, inputsHash}` for `bond.price`,
// `bond.risk`, `bond.zspread`, `curve.interp`, `bill` and `curve.bootstrap`, so two runs at the
// same explicit `asOf` produce byte-identical data *and* byte-identical engine notes.
//
// Three engines are defined here rather than imported, and all three deviations are deliberate:
//
//  1. `bond.zspread@1.0.0`. FUNCTIONS_TIER3 §YAS step 4 calls `bondRisk.zSpread(...)` and
//     `core/fields/defs/analytic.ts` cites `core/analytics/bond/risk.ts#zSpread`, but WP-02's
//     `bond/risk.ts` has no such export — the landed file wins, so the engine is defined here, in
//     core, pure, with no `Date` and no IO, exactly as `defineEngine` requires. It takes the
//     curve's own nodes (not a `Curve` object, which is not canonical-JSON) and rebuilds the curve
//     with `makeCurve`, so its `inputsHash` covers the discount curve it solved against.
//  2. `curve.interp@1.0.0`. The same §YAS step calls `curveInterp.parYield(pts, days)` and
//     `build.curve.parRate(T)`; `Curve` (WP-02) has `df`/`zero`/`fwd`/`snapshot` and no `parRate`.
//     The comparison yield is therefore the **published** quote of the curve interpolated linearly
//     in `tenor_days` — the number the Treasury itself publishes at the neighbouring tenors — for
//     every `curveId`, and the Z-spread remains a bootstrapped-curve number.
//  3. `bond.krd@1.0.0`. §YAS step 4 calls `bondRisk.keyRateDurations(schedule, build.curve,
//     zSpreadBp, params.krdTenors)`; the landed `bond/risk.ts` has no curve-aware entry point —
//     its `keyRateDurations` takes a *yield* and returns an analytic tent slice of the yield-based
//     modified duration, which is curve-independent and twist-blind. `KRD_2Y…KRD_30Y` are defined
//     in the dictionary as a bump of the pricing curve's zero curve with the issue's z-spread held
//     fixed, and SWPM already ships them that way, so YAS bumps and reprices too. The §0 kernel is
//     shared (`core/analytics/curve/keyRate.ts`), not copied.
//
// All three engines live here because YAS is their only consumer; a second consumer moves them to
// `core/analytics` with their versions unchanged.

import { z } from 'zod';

import { icmaYearFraction } from '../../analytics/curve/bootstrap.js';
import { makeCurve } from '../../analytics/curve/curve.js';
import { bumpedDfPoints, keyRateNodes } from '../../analytics/curve/keyRate.js';
import { solveRoot } from '../../analytics/bond/price.js';
import type { CompoundingName, Conventions, InterpolationName } from '../../analytics/engine.js';
import { defineEngine } from '../../analytics/engine.js';
import type { IsoDate } from '../../calendars/calendar.js';
import { daysBetween } from '../../calendars/calendar.js';
import type { DayCountId } from '../../daycount/conventions.js';
import type { FieldId } from '../../types/fields.js';
import type { ValueCell } from '../../types/function.js';
import type { CsvColumn, LiveSpec } from '../manifest.js';
import { defineFunction } from '../manifest.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Params (§YAS "Params")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The three curves a Treasury is spread against. */
export const YAS_CURVE_IDS = ['UST_PAR', 'UST_CMT', 'SOFR_OIS'] as const;

/** The key-rate grid YAS bumps (§YAS `krdTenors`). */
export const YAS_KRD_TENORS = ['2Y', '5Y', '10Y', '30Y'] as const;
export type YasKrdTenor = (typeof YAS_KRD_TENORS)[number];

/** `'2Y'` → `2` — the key-rate node in years the `bond.risk` engine takes. */
export const YAS_KRD_YEARS: Readonly<Record<YasKrdTenor, number>> = Object.freeze({
  '2Y': 2,
  '5Y': 5,
  '10Y': 10,
  '30Y': 30,
});

export const YasParams = z.object({
  /** `'curve'` derives the yield from the pricing curve; `'discount'` is bills only. */
  input: z.enum(['curve', 'yield', 'price', 'discount']).default('curve'),
  /** Percent, street convention (coupon securities). */
  yield: z.number().min(-5).max(50).nullable().default(null),
  /** Clean price per 100. */
  price: z.number().min(1).max(300).nullable().default(null),
  /** Percent, bills only. */
  discount: z.number().min(-5).max(50).nullable().default(null),
  /** `null` = T+1 SIFMA from the valuation date. */
  settlement: z.iso.date().nullable().default(null),
  /** Currency face for DV01 and the cashflow amounts. */
  face: z.number().positive().max(1e12).default(1_000_000),
  curveId: z.enum(YAS_CURVE_IDS).default('UST_PAR'),
  interpolation: z
    .enum(['linear_zero', 'log_linear_df', 'monotone_convex'])
    .default('monotone_convex'),
  krdTenors: z
    .array(z.enum(YAS_KRD_TENORS))
    .min(1)
    .max(4)
    .default([...YAS_KRD_TENORS]),
  view: z.enum(['analysis', 'cashflows']).default('analysis'),
});
export type YasParams = z.infer<typeof YasParams>;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `curve.interp@1.0.0`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One published curve quote, as the interpolator sees it. */
export interface CurveInterpPoint {
  readonly tenorDays: number;
  /** Percent, as published. */
  readonly value: number;
}

/** `curve.interp` inputs: the published quotes and the tenor wanted. */
export type CurveInterpInputs = {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  readonly quoteType: string;
  readonly points: readonly CurveInterpPoint[];
  readonly tenorDays: number;
};

export interface CurveInterpOutputs {
  /** Percent, on the quote's own basis. */
  readonly value: number;
  readonly tenorDays: number;
  readonly lower: CurveInterpPoint | null;
  readonly upper: CurveInterpPoint | null;
  /** True when `tenorDays` sits outside the published grid and the end quote was held flat. */
  readonly extrapolated: boolean;
  readonly conventions: Conventions;
}

/** Linear in `tenor_days`, flat outside the published grid — never an invented shape. */
export const CURVE_INTERP_CONVENTIONS: Conventions = Object.freeze({
  interpolation: 'linear_zero',
  extrapolation: 'flat_quote',
  dayCount: 'ACT/365F',
});

/**
 * `curve.interp@1.0.0` — the published quote of a curve at an arbitrary tenor.
 *
 * Linear between the two neighbouring published tenors, flat beyond the ends and flagged
 * `extrapolated` when it is: a 40-year bond against a curve that stops at 30 years is quoted
 * against the 30-year point and says so, rather than being extended by a slope nobody published.
 */
export const curveInterpEngine = defineEngine<CurveInterpInputs, CurveInterpOutputs>(
  'curve.interp',
  '1.0.0',
  (i) => {
    const points = [...i.points].sort((a, b) => a.tenorDays - b.tenorDays);
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) {
      throw new RangeError(`curve.interp: ${i.curveId} has no points on ${i.curveDate}`);
    }
    if (i.tenorDays <= first.tenorDays) {
      return {
        value: first.value,
        tenorDays: i.tenorDays,
        lower: null,
        upper: first,
        extrapolated: i.tenorDays < first.tenorDays,
        conventions: CURVE_INTERP_CONVENTIONS,
      };
    }
    if (i.tenorDays >= last.tenorDays) {
      return {
        value: last.value,
        tenorDays: i.tenorDays,
        lower: last,
        upper: null,
        extrapolated: i.tenorDays > last.tenorDays,
        conventions: CURVE_INTERP_CONVENTIONS,
      };
    }
    for (let k = 0; k + 1 < points.length; k += 1) {
      const lower = points[k]!;
      const upper = points[k + 1]!;
      if (i.tenorDays >= lower.tenorDays && i.tenorDays <= upper.tenorDays) {
        const span = upper.tenorDays - lower.tenorDays;
        const w = span === 0 ? 0 : (i.tenorDays - lower.tenorDays) / span;
        return {
          value: lower.value + w * (upper.value - lower.value),
          tenorDays: i.tenorDays,
          lower,
          upper,
          extrapolated: false,
          conventions: CURVE_INTERP_CONVENTIONS,
        };
      }
    }
    /* c8 ignore next */
    throw new RangeError(`curve.interp: no bracket contains ${String(i.tenorDays)} days`);
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `bond.zspread@1.0.0`
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One remaining cashflow, per 100 face, as the Z-spread solver sees it. */
export interface ZSpreadFlow {
  readonly date: IsoDate;
  readonly amount: number;
}

/** What the discounting produced for one flow. */
export interface ZSpreadFlowResult {
  readonly date: IsoDate;
  /** Year fraction from the curve date on the curve's own time axis. */
  readonly t: number;
  /** Discount factor from settlement at the solved spread. */
  readonly df: number;
  readonly pv: number;
}

export type BondZSpreadInputs = {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  readonly dayCount: DayCountId;
  readonly compounding: CompoundingName;
  readonly interpolation: InterpolationName;
  /** `curve_builds.nodes` reduced to what a curve needs. */
  readonly nodes: readonly { readonly t: number; readonly df: number }[];
  readonly settlement: IsoDate;
  readonly flows: readonly ZSpreadFlow[];
  /** Invoice price per 100 face at settlement. */
  readonly dirtyPrice: number;
  /** Compounding frequency the spread is quoted on: 2 for a Treasury. */
  readonly frequency: number;
};

export interface BondZSpreadOutputs {
  readonly ok: boolean;
  /** Decimal fraction per annum; `NaN` when the solve failed. */
  readonly spread: number;
  readonly spreadBp: number;
  readonly iterations: number;
  readonly residual: number;
  /** Dirty price of the same flows on the curve with **no** spread — the zero-spread benchmark. */
  readonly curveDirtyPrice: number;
  readonly flows: readonly ZSpreadFlowResult[];
  readonly conventions: Conventions;
}

/** ±2 000 bp, the bracket §YAS step 4 specifies. */
export const Z_SPREAD_BRACKET = 0.2;

/** What `bond.zspread` and `bond.krd` both need to turn a flow schedule into a price on a curve. */
type CurveFlowInputs = {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  readonly dayCount: DayCountId;
  readonly compounding: CompoundingName;
  readonly interpolation: InterpolationName;
  readonly settlement: IsoDate;
  readonly flows: readonly ZSpreadFlow[];
  readonly frequency: number;
};

/** One flow, placed on the curve's time axis with its forward discount factor from settlement. */
interface CurveFlow {
  readonly date: IsoDate;
  readonly amount: number;
  readonly t: number;
  readonly dfForward: number;
}

/**
 * Discount `i.flows` on the curve made of `points`, and return the flows plus a `priceAt(spread)`
 * that adds a parallel spread on the curve's own compounding basis.
 *
 * Shared by `bond.zspread` (which solves for the spread) and `bond.krd` (which holds it fixed and
 * moves the curve). One implementation on purpose: a key-rate duration is only meaningful against
 * the Z-spread it holds fixed if both are measured by the same discounting, down to the order the
 * multiplications happen in.
 */
function priceFlowsOnCurve(
  i: CurveFlowInputs,
  points: readonly { readonly t: number; readonly df: number }[],
  engineName: string,
): {
  settlementTime: number;
  flows: readonly CurveFlow[];
  priceAt: (spread: number) => number;
} {
  const curve = makeCurve({
    curveId: i.curveId,
    curveDate: i.curveDate,
    dayCount: i.dayCount,
    compounding: i.compounding,
    interpolation: i.interpolation,
    points: points.map((n) => ({ t: n.t, df: n.df })),
  });
  const timeOf = (date: IsoDate): number => {
    if (i.dayCount === 'ACT/360') return daysBetween(i.curveDate, date) / 360;
    if (i.dayCount === 'ACT/365F') return daysBetween(i.curveDate, date) / 365;
    return icmaYearFraction(i.curveDate, date, i.frequency);
  };
  const settlementTime = timeOf(i.settlement);
  const dfSettlement = curve.df(settlementTime);
  if (!(dfSettlement > 0)) {
    throw new RangeError(`${engineName}: the curve discounts settlement to ${dfSettlement}`);
  }
  const flows = i.flows.map((flow) => {
    const t = timeOf(flow.date);
    return { date: flow.date, amount: flow.amount, t, dfForward: curve.df(t) / dfSettlement };
  });
  const priceAt = (spread: number): number => {
    const b = 1 + spread / i.frequency;
    if (!(b > 0)) return Number.NaN;
    let pv = 0;
    for (const flow of flows) {
      pv += flow.amount * flow.dfForward * Math.pow(b, -i.frequency * (flow.t - settlementTime));
    }
    return pv;
  };
  return { settlementTime, flows, priceAt };
}

/**
 * `bond.zspread@1.0.0` — the parallel spread over the zero curve that reprices the bond.
 *
 * `D(t) = df(t)/df(tₛ)` is the forward discount factor from settlement, so the solve is about the
 * bond's own flows and not about the two days between the curve date and settlement. The spread is
 * added on the **curve's compounding basis** (semiannual for a Treasury curve), which is the basis
 * the screen quotes the yield on; a bond priced exactly off its own curve therefore solves to
 * 0 bp, which is the property `YAS.test.ts` and `bond.risk.test.ts` both lean on.
 */
export const bondZSpreadEngine = defineEngine<BondZSpreadInputs, BondZSpreadOutputs>(
  'bond.zspread',
  '1.0.0',
  (i) => {
    const { settlementTime, flows, priceAt } = priceFlowsOnCurve(i, i.nodes, 'bond.zspread');
    const curveDirtyPrice = priceAt(0);
    const solved = solveRoot((s) => priceAt(s) - i.dirtyPrice, {
      y0: 0,
      lo: -Z_SPREAD_BRACKET,
      hi: Z_SPREAD_BRACKET,
      yTol: 1e-12,
    });
    const spread = solved.ok ? solved.y : Number.NaN;
    const b = 1 + spread / i.frequency;
    return {
      ok: solved.ok,
      spread,
      spreadBp: solved.ok ? spread * 10_000 : Number.NaN,
      iterations: solved.ok ? solved.iterations : 0,
      residual: solved.ok ? solved.residual : Number.NaN,
      curveDirtyPrice,
      flows: flows.map((flow) => {
        const df = solved.ok
          ? flow.dfForward * Math.pow(b, -i.frequency * (flow.t - settlementTime))
          : Number.NaN;
        return { date: flow.date, t: flow.t, df, pv: flow.amount * df };
      }),
      conventions: Object.freeze({
        dayCount: i.dayCount,
        compounding: i.compounding,
        interpolation: i.interpolation,
        frequency: i.frequency,
      }),
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `bond.krd@1.0.0`
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type BondKrdInputs = {
  readonly curveId: string;
  readonly curveDate: IsoDate;
  readonly dayCount: DayCountId;
  readonly compounding: CompoundingName;
  readonly interpolation: InterpolationName;
  /** `curve_builds.nodes` reduced to what a curve needs — the curve that is bumped. */
  readonly nodes: readonly { readonly t: number; readonly df: number }[];
  readonly settlement: IsoDate;
  readonly flows: readonly ZSpreadFlow[];
  /** The issue's Z-spread as a decimal fraction per annum, **held fixed** across every bump. */
  readonly spread: number;
  /** Compounding frequency the spread is quoted on: 2 for a Treasury. */
  readonly frequency: number;
  /** Key-rate tenors in years, e.g. `[2, 5, 10, 30]`. */
  readonly keyRateTenors: readonly number[];
  /** Bump size as a decimal rate; the screens pass one basis point. */
  readonly bump: number;
};

/** One bucket of curve risk: the node it belongs to and the sensitivity attributed to it. */
export interface BondKeyRateDuration {
  /** Node tenor in years. */
  readonly tenor: number;
  /** `−(P⁺ − P⁻) / (2 · P · bump)`, in years — the same unit as modified duration. */
  readonly duration: number;
  /** Price change per 100 face per basis point at this node alone. */
  readonly dv01: number;
}

export interface BondKrdOutputs {
  /** Dirty price per 100 face on the unbumped curve at `spread` — the `P` of the §0 formula. */
  readonly basePrice: number;
  readonly keyRateDurations: readonly BondKeyRateDuration[];
  /**
   * `Σ duration`. The kernels are a partition of unity, so this is the curve's **parallel-shift**
   * duration to within the finite-difference truncation — *not* the modified duration, which is a
   * derivative in yield space over a flat curve. The two differ by the curve's shape and by the
   * basis the shift is applied on; see {@link bondKrdEngine}.
   */
  readonly keyRateDurationSum: number;
  readonly conventions: Conventions;
}

/**
 * `bond.krd@1.0.0` — curve key-rate durations: bump, reprice, difference.
 *
 * FUNCTIONS_TIER3 §YAS step 4 calls `bondRisk.keyRateDurations(schedule, build.curve, zSpreadBp,
 * params.krdTenors)`. WP-02's `bond/risk.ts` has no such entry point: its `keyRateDurations` takes
 * a *yield*, and returns an analytic tent decomposition of the yield-based modified duration. That
 * decomposition is curve-independent and twist-blind — it sums to the modified duration by
 * algebraic construction, so it cannot disagree with it, which is exactly the information a
 * key-rate duration exists to carry. Reporting it under `KRD_2Y…KRD_30Y` (which
 * `core/fields/defs/analytic.ts` defines as a bump of *the pricing curve's zero curve*, and which
 * SWPM already computes that way) would mean the same four field ids named two different
 * quantities on two screens of the same tier. So the engine lives here, beside `bond.zspread`,
 * pure and canonical-JSON representable, exactly as `defineEngine` requires.
 *
 * The method is §0's, and it is the one SWPM uses:
 *
 *  1. Shift the key tenor's region of the zero curve with the shared §0 triangular kernel
 *     (`core/analytics/curve/keyRate.ts`), up and down by `bump`.
 *  2. Reprice the bond's remaining flows on each bumped curve with `spread` **held fixed**, so the
 *     number is the bond's exposure to the curve and not to its own credit/liquidity spread.
 *  3. `KRD = −(P⁺ − P⁻) / (2 · P · bump)`.
 *
 * Two properties worth knowing before reading the numbers:
 *
 *  - **`Σ KRD` is the parallel-shift duration, to within truncation** — the kernels sum to 1 at
 *    every `t`, so bumping every key at once is a parallel shift. Four independent reprices do not
 *    telescope, so the sum carries the bond's convexity over the bump; the residual is ~1e-5
 *    relative on a Treasury, not zero.
 *  - **`Σ KRD` is only *approximately* the modified duration.** The shift is applied to the
 *    continuously compounded zero (`df·exp(−w·δ·t)`, which is what keeps the operator identical on
 *    every curve whatever basis it quotes its own zeros on), while modified duration differentiates
 *    a flat semiannual yield: the two differ by ≈ `y/2` from the basis and by the curve's slope
 *    over the bond's life. On the seeded `UST_PAR` curve that is +1.9 % for the 2Y/10Y notes and
 *    −0.04 % for the 30Y bond. A KRD that reproduced the modified duration exactly would be the
 *    yield decomposition again.
 */
export const bondKrdEngine = defineEngine<BondKrdInputs, BondKrdOutputs>(
  'bond.krd',
  '1.0.0',
  (i) => {
    // A non-finite `spread` never reaches here: `defineEngine` hashes the inputs first and
    // `canonicalJson` refuses `NaN`/`±Infinity` (ANAL-08), which is asserted in `keyRate.test.ts`.
    if (!(i.bump > 0)) {
      throw new RangeError(`bond.krd: bump must be positive, got ${String(i.bump)}`);
    }
    const basePrice = priceFlowsOnCurve(i, i.nodes, 'bond.krd').priceAt(i.spread);
    if (!(basePrice > 0)) {
      throw new RangeError(`bond.krd: the curve prices the bond at ${String(basePrice)}`);
    }
    const keyRateDurations = keyRateNodes(i.keyRateTenors).map((node) => {
      const up = priceFlowsOnCurve(i, bumpedDfPoints(i.nodes, node, i.bump), 'bond.krd').priceAt(
        i.spread,
      );
      const down = priceFlowsOnCurve(i, bumpedDfPoints(i.nodes, node, -i.bump), 'bond.krd').priceAt(
        i.spread,
      );
      const duration = -(up - down) / (2 * basePrice * i.bump);
      return { tenor: node.key, duration, dv01: duration * basePrice * 1e-4 };
    });
    return {
      basePrice,
      keyRateDurations,
      keyRateDurationSum: keyRateDurations.reduce((sum, k) => sum + k.duration, 0),
      conventions: Object.freeze({
        dayCount: i.dayCount,
        compounding: i.compounding,
        interpolation: i.interpolation,
        frequency: i.frequency,
        bumpBasis: 'continuous',
      }),
    };
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Payload (§YAS "Payload")
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type YasSecurityType = 'bill' | 'note' | 'bond' | 'tips' | 'frn';

export interface YasInstrument {
  instrumentId: number;
  /** `'T 4.25 08/15/36 Govt'`. */
  key: string;
  name: string;
  cusip: string;
  securityType: YasSecurityType;
  termLabel: string | null;
  onTheRun: boolean;
}

/** REF-03: the terms as they were believed at `ctx.asOf.knownAt`. */
export interface YasTerms {
  provIdx: number;
  couponRate: number | null;
  couponFreq: number;
  dayCount: string;
  issueDate: string | null;
  datedDate: string | null;
  maturityDate: string;
  firstCouponDate: string | null;
  businessDayConv: string;
  calendarId: string;
  settlementDays: number;
  minDenomination: number;
  amountOutstanding: number | null;
  knownAt: string;
}

export interface YasSettlement {
  date: string;
  valuationDate: string;
  daysToMaturity: number;
  yearsToMaturity: number;
  rule: 'T+1 SIFMA' | 'user';
}

export interface YasInputs {
  mode: 'curve' | 'yield' | 'price' | 'discount';
  source: 'user' | 'curve';
  curveId: string;
  curveDate: string | null;
  curveProvIdx: number;
  face: number;
}

export interface YasKeyRate {
  tenor: YasKrdTenor;
  /**
   * Years, from `bond.krd`: a ±1 bp triangular-kernel bump of this node of the pricing curve's
   * zero curve, repriced with the issue's z-spread held fixed. `null` when the bond has no usable
   * pricing curve or no solved z-spread — never the yield-space number under a curve-space name.
   *
   * `Σ krd` is the curve's parallel-shift duration and so only *approximates* the modified
   * duration; see {@link bondKrdEngine}.
   */
  krd: number | null;
}

export interface YasBenchmark {
  key: string;
  tenor: string;
  yieldPct: number;
  spreadBp: number;
  provIdx: number;
}

export interface YasSpreads {
  interpolatedCurveYieldPct: ValueCell;
  toCurveBp: ValueCell;
  zSpreadBp: ValueCell | null;
  benchmark: YasBenchmark | null;
}

export interface YasCouponResults {
  kind: 'coupon';
  yieldPct: ValueCell;
  cleanPrice: ValueCell;
  dirtyPrice: ValueCell;
  accrued: ValueCell;
  accruedDays: number;
  daysInPeriod: number;
  macaulayDuration: ValueCell;
  modifiedDuration: ValueCell;
  convexity: ValueCell;
  dv01: ValueCell;
  dv01Per100: ValueCell;
  yieldValueOf32nd: ValueCell;
  keyRateDurations: YasKeyRate[];
  spreads: YasSpreads;
  conventions: Conventions;
}

export interface YasBillResults {
  kind: 'bill';
  discountRatePct: ValueCell;
  investmentYieldPct: ValueCell;
  price: ValueCell;
  moneyMarketYieldPct: ValueCell;
  daysToMaturity: number;
  dollarDiscount: ValueCell;
  dv01: ValueCell;
  modifiedDuration: ValueCell;
  spreads: YasSpreads;
  conventions: Conventions;
}

export type YasResults = YasCouponResults | YasBillResults;

export interface YasCashflow {
  date: string;
  kind: 'coupon' | 'principal' | 'maturity';
  days: number;
  coupon: number;
  principal: number;
  total: number;
  df: number | null;
  pv: number | null;
  fromCurve: boolean;
}

export interface YasCurveRef {
  id: string;
  date: string;
  /**
   * The **build's** interpolation (`monotone_convex` by default) — the one `bond.zspread` discounts
   * the cashflows on, and so the one behind `results.spreads.zSpreadBp`.
   */
  interpolation: string;
  /**
   * The **quote's** interpolation, `curve.interp@1.0.0`'s own `CURVE_INTERP_CONVENTIONS`: linear in
   * `tenor_days` across the published par quotes, held flat outside the grid.
   *
   * Two different rules produce the two curve numbers on this screen, exactly as §YAS specifies:
   * `spreads.interpolatedCurveYieldPct` (and therefore `toCurveBp`) is read off the *published
   * quotes* linearly, while the Z-spread discounts on the *bootstrapped build*. Publishing only the
   * build's label made "Spread to UST_PAR" look as though it had been read off a monotone-convex
   * curve when it had not; both labels now reach the reader.
   */
  quoteInterpolation: string;
  /** `curve.interp`'s extrapolation: the end quote held flat, never a slope nobody published. */
  quoteExtrapolation: string;
  buildId: number;
  provIdx: number;
}

export interface YasPayload {
  variant: 'govt';
  instrument: YasInstrument;
  terms: YasTerms;
  settlement: YasSettlement;
  inputs: YasInputs;
  results: YasResults;
  cashflows: YasCashflow[];
  /**
   * **Deviation from §YAS's payload type, which declares this non-null.** A valuation date with no
   * stored curve is an explicit degraded path in the same entry ("`503` is *not* raised … every
   * curve-derived cell `{v:null}`"), and there is no honest `buildId` or `date` to put here when
   * nothing was built. `null` says so; the screen renders the curve block as `—`.
   */
  curve: YasCurveRef | null;
  /** Echo of `meta.engines[]` names for the footer. */
  engines: { name: string; version: string }[];
  /** `ctx.asOf.validAt` — the instant this payload reproduces at, and the CSV's `asOf` column. */
  asOf: string;
}

/** The `meta.unavailable.detail` for a TIPS or FRN (§YAS "Unavailable and reason codes"). */
export const YAS_NOT_APPLICABLE_DETAIL =
  'YAS v1 prices fixed-coupon notes/bonds and bills; TIPS/FRN pricing needs an ' +
  'inflation/reference-rate engine';

/** Footer note when no on-the-run row matches the security's tenor. */
export const YAS_NO_BENCHMARK_ROW = 'NO_BENCHMARK_ROW';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Field ids (§YAS "Field ids")
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * §YAS names `DAY_CNT_DES` and `MTY_YEARS`; the dictionary (WP-03) spells them `DAY_CNT` and
 * `DAYS_TO_MTY`, and adds the two spread ids the entry's payload needs but its list omits. The
 * dictionary is the landed file and wins.
 */
export const YAS_FIELD_IDS: readonly FieldId[] = Object.freeze([
  'CPN',
  'CPN_FREQ',
  'DAY_CNT',
  'MATURITY',
  'ISSUE_DT',
  'SECURITY_TYP',
  'DAYS_TO_MTY',
  'YLD_YTM_MID',
  'PX_DIRTY_MID',
  'ACCRUED',
  'DUR_MID',
  'DUR_ADJ_MID',
  'CONVEXITY_MID',
  'DV01',
  'KRD_2Y',
  'KRD_5Y',
  'KRD_10Y',
  'KRD_30Y',
  'DISC_RATE',
  'BEY',
  'CURVE_PAR',
  'CURVE_ZERO',
  'CURVE_DF',
  'SPRD_TO_CRV',
  'SPRD_TO_BENCH',
  'Z_SPRD_MID',
] as const);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CSV (§YAS "CSV") — long format, because the results dominate (FUNCTIONS.md §1.6 rule 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const YAS_CSV_COLUMNS: CsvColumn[] = [
  { id: 'section', label: 'Section', type: 'string' },
  { id: 'key', label: 'Key', type: 'string' },
  { id: 'value', label: 'Value', type: 'number' },
  { id: 'unit', label: 'Unit', type: 'string' },
  { id: 'asOf', label: 'As of', type: 'datetime' },
  { id: 'source', label: 'Source', type: 'string' },
];

const DERIVED = 'internal.derived';

type CsvRow = (string | number | boolean | null)[];

function cellRow(section: string, key: string, cell: ValueCell, unit: string, asOf: string): CsvRow {
  return [section, key, typeof cell.v === 'number' ? cell.v : null, unit, asOf, DERIVED];
}

function yasCsvRows(payload: YasPayload): CsvRow[] {
  const rows: CsvRow[] = [];
  const asOf = payload.asOf;
  const results = payload.results;
  if (results.kind === 'coupon') {
    rows.push(
      cellRow('results', 'yieldPct', results.yieldPct, 'pct', asOf),
      cellRow('results', 'cleanPrice', results.cleanPrice, 'px', asOf),
      cellRow('results', 'dirtyPrice', results.dirtyPrice, 'px', asOf),
      cellRow('results', 'accrued', results.accrued, 'px', asOf),
      cellRow('results', 'macaulayDuration', results.macaulayDuration, 'years', asOf),
      cellRow('results', 'modifiedDuration', results.modifiedDuration, 'years', asOf),
      cellRow('results', 'convexity', results.convexity, 'years', asOf),
      cellRow('results', 'dv01', results.dv01, 'ccy', asOf),
      cellRow('results', 'dv01Per100', results.dv01Per100, 'px', asOf),
      cellRow('results', 'yieldValueOf32nd', results.yieldValueOf32nd, 'bp', asOf),
    );
    for (const krd of results.keyRateDurations) {
      rows.push(['krd', krd.tenor, krd.krd, 'years', asOf, DERIVED]);
    }
  } else {
    rows.push(
      cellRow('results', 'discountRatePct', results.discountRatePct, 'pct', asOf),
      cellRow('results', 'investmentYieldPct', results.investmentYieldPct, 'pct', asOf),
      cellRow('results', 'price', results.price, 'px', asOf),
      cellRow('results', 'moneyMarketYieldPct', results.moneyMarketYieldPct, 'pct', asOf),
      cellRow('results', 'dollarDiscount', results.dollarDiscount, 'ccy', asOf),
      cellRow('results', 'dv01', results.dv01, 'ccy', asOf),
      cellRow('results', 'modifiedDuration', results.modifiedDuration, 'years', asOf),
    );
  }
  rows.push(
    cellRow('spreads', 'interpolatedCurveYieldPct', results.spreads.interpolatedCurveYieldPct, 'pct', asOf),
    cellRow('spreads', 'toCurveBp', results.spreads.toCurveBp, 'bp', asOf),
  );
  if (results.spreads.zSpreadBp !== null) {
    rows.push(cellRow('spreads', 'zSpreadBp', results.spreads.zSpreadBp, 'bp', asOf));
  }
  if (results.spreads.benchmark !== null) {
    const bench = results.spreads.benchmark;
    rows.push(['spreads', `benchmark.${bench.tenor}`, bench.spreadBp, 'bp', asOf, DERIVED]);
  }

  rows.push(
    ['terms', 'couponRate', payload.terms.couponRate, 'pct', asOf, 'internal.reference'],
    ['terms', 'couponFreq', payload.terms.couponFreq, 'int', asOf, 'internal.reference'],
    ['terms', 'maturityDate', null, 'date', asOf, 'internal.reference'],
    ['terms', 'settlementDays', payload.terms.settlementDays, 'int', asOf, 'internal.reference'],
    ['inputs', 'face', payload.inputs.face, 'ccy', asOf, 'internal.user'],
    ['inputs', 'mode', null, 'text', asOf, 'internal.user'],
    ['settlement', 'daysToMaturity', payload.settlement.daysToMaturity, 'int', asOf, DERIVED],
    ['settlement', 'yearsToMaturity', payload.settlement.yearsToMaturity, 'years', asOf, DERIVED],
  );

  for (const flow of payload.cashflows) {
    rows.push(['cashflow', flow.date, flow.total, 'ccy', asOf, DERIVED]);
    rows.push(['cashflow', `${flow.date}/coupon`, flow.coupon, 'ccy', asOf, DERIVED]);
    rows.push(['cashflow', `${flow.date}/df`, flow.df, 'px', asOf, DERIVED]);
    rows.push(['cashflow', `${flow.date}/pv`, flow.pv, 'ccy', asOf, DERIVED]);
  }
  return rows;
}

/** `'T 4.25 08/15/36 Govt'` → `'T_4_25_08_15_36_Govt'`. */
export function yasFilenameKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, '_');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const YAS = defineFunction<typeof YasParams, YasPayload>({
  code: 'YAS',
  name: 'Yield & Spread Analysis',
  aliases: ['YA'],
  tier: 3,
  category: 'rates',
  // FUNCTIONS.md §6 L1105, verbatim.
  assetClasses: ['govt'],
  requiresSecurity: true,
  variants: { govt: 'govt' },
  params: YasParams,
  paramGrammar: {
    // A single number is a quote; the resolver reads `input` and the three nullable slots, so the
    // shape rule of §YAS's `argMap` (`< 30` → yield/discount, `≥ 30` → price) is applied by the
    // command line's `quote` slot rather than by a manifest hook — `FunctionManifest` has no
    // `argMap` member (WP-03's landed `manifest.ts`), which is the deviation recorded here.
    positional: [{ name: 'quote', type: 'number', optional: true }],
    keyed: {
      S: { name: 'settlement', type: 'date' },
      FACE: { name: 'face', type: 'number' },
      CRV: { name: 'curveId', type: 'curve', values: YAS_CURVE_IDS },
      Y: { name: 'yield', type: 'number' },
      P: { name: 'price', type: 'number' },
      D: { name: 'discount', type: 'number' },
    },
  },
  fieldIds: (assetClass): FieldId[] => (assetClass === 'govt' ? [...YAS_FIELD_IDS] : []),
  pageable: false,
  // The curve is a daily object: the subscription exists so the shell can raise CURVE_UPDATED, and
  // no cell carries `live`.
  live: (params): LiveSpec => ({
    subjects: [`c:${params.curveId}`],
    fields: '*',
    conflationMs: 1000,
  }),
  csv: {
    filename: (_params, ctx): string =>
      `YAS_${yasFilenameKey(ctx.display ?? 'GOVT')}_${ctx.asOf.replace(/[-:]/g, '')}.csv`,
    columns: YAS_CSV_COLUMNS,
    rows: (payload): CsvRow[] => yasCsvRows(payload),
  },
  help: {
    summary: 'Price/yield, accrued, duration, DV01, KRDs and spreads for a Treasury',
    description:
      'YAS prices a US Treasury bill, note or bond on the street convention (ACT/ACT, semiannual, ' +
      'T+1 SIFMA settlement) or the bill discount basis (ACT/360). With no input the yield is ' +
      "taken from the Treasury par curve at the security's maturity; type a yield, a price or a " +
      'discount rate to override it. Spread and Z-spread are measured against the selected curve; ' +
      'key-rate durations bump the zero curve at 2, 5, 10 and 30 years and reprice with the ' +
      "issue's Z-spread held fixed. Every number is produced by a versioned engine listed in the " +
      'footer, and the same engine serves the API and the CSV export.',
    params: [
      { name: 'input', text: 'curve, yield, price or discount', example: 'yield' },
      { name: 'yield', text: 'street yield, percent', example: '4.95' },
      { name: 'price', text: 'clean price per 100', example: '99.5' },
      { name: 'discount', text: 'bill discount rate, percent', example: '3.69' },
      { name: 'settlement', text: 'settlement date; default T+1 SIFMA', example: '2026-09-17' },
      { name: 'face', text: 'face amount for DV01 and cashflows', example: '5000000' },
      { name: 'curveId', text: 'UST_PAR, UST_CMT or SOFR_OIS' },
      { name: 'interpolation', text: 'zero-curve interpolation' },
      { name: 'krdTenors', text: 'key-rate tenors' },
      { name: 'view', text: 'analysis or cashflows' },
    ],
    keys: [
      { key: 'Enter', action: 'reprice from the form' },
      { key: 'ArrowUp / ArrowDown', action: 'bump the focused input by 1 bp (1/32 on price)' },
      { key: 'M', action: 'cycle the pricing mode' },
      { key: 'C', action: 'cycle the pricing curve' },
      { key: '1 / 2', action: 'analysis / cashflows' },
    ],
    sources: ['treasury.yieldcurve', 'treasury.bills', 'internal.derived', 'internal.user'],
    related: ['DES', 'GC', 'CRVF', 'SRCH', 'SWPM'],
  },
  keymap: [
    { key: 'Enter', action: 'reprice', when: 'form', description: 'Reprice with the form values' },
    { key: 'ArrowUp', action: 'bump-yield', when: 'form', description: 'Bump the focused input up' },
    {
      key: 'ArrowDown',
      action: 'bump-yield',
      when: 'form',
      description: 'Bump the focused input down',
    },
    {
      key: 'Shift+ArrowUp',
      action: 'bump-yield-10',
      when: 'form',
      description: 'Bump the focused input by ten steps',
    },
    {
      key: 'Shift+ArrowDown',
      action: 'bump-yield-10',
      when: 'form',
      description: 'Bump the focused input down by ten steps',
    },
    { key: 'M', action: 'cycle-mode', description: 'Cycle curve / yield / price (discount on bills)' },
    { key: 'S', action: 'settlement-prompt', description: 'Prompt for a settlement date' },
    { key: 'C', action: 'cycle-curve', description: 'Cycle UST_PAR / UST_CMT / SOFR_OIS' },
    { key: 'I', action: 'cycle-interp', description: 'Cycle the zero-curve interpolation' },
    { key: '1', action: 'tab-analysis', description: 'Analysis tab' },
    { key: '2', action: 'tab-cashflows', description: 'Cashflows tab' },
    { key: 'D', action: 'open-des', description: 'Description of this security' },
    { key: 'G', action: 'open-gc', description: 'Benchmark curve chart' },
    {
      key: 'Shift+Enter',
      action: 'open-crvf-next',
      when: 'grid',
      description: 'Curve construction in the next panel',
    },
  ],
  screenKind: 'declarative',
  payloadVersion: 1,
});

export default YAS;
