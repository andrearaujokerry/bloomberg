/**
 * `functions/YAS/resolve.ts` — Yield & Spread Analysis (FUNCTIONS_TIER3.md §YAS L75-226).
 *
 * The rule this file exists to keep is ANAL-08: **every number in the payload comes out of an
 * `EngineResult`**, so `meta.engines[]` names the engine, its version and the hash of the inputs
 * it ran on, and two runs at the same explicit `asOf` are byte-identical. The resolver's own
 * arithmetic is confined to unit conversion (percent ↔ decimal, per-100 ↔ per-face) and to
 * multiplying a per-100 engine number by the face the user asked for; every *analytic* —
 * price, yield, accrued, duration, convexity, DV01, key-rate durations, the interpolated curve
 * quote, the Z-spread, the bill measures, the discount curve itself — is an engine call, and each
 * one is registered with `ctx.engines.add(engineMeta(result))`.
 *
 * Four decisions, each with an easier wrong answer:
 *
 *  1. **Key-rate durations come from `bond.krd`, in curve space.** §YAS step 4, the dictionary's
 *     `KRD_2Y…KRD_30Y` and SWPM's own key-rate block all describe the same thing: bump one node of
 *     the *zero curve* with the §0 triangular kernel, hold the issue's Z-spread fixed, and reprice.
 *     WP-02's landed `bond/risk.ts` instead returns an analytic tent slice of the **yield**-based
 *     modified duration — curve-independent, twist-blind, and summing to the modified duration by
 *     algebraic construction, which is why it cannot disagree with it. Reporting that under a
 *     curve-space field id would make `KRD_10Y` mean one thing here and another on SWPM, and a desk
 *     hedging a bond against a swap on the pair would be hedging a twist the bond's KRDs cannot
 *     see. `bond.krd@1.0.0` (defined in `YAS.ts`, kernel shared with SWPM) bumps and reprices; the
 *     sum is therefore the curve's parallel-shift duration to within the bump truncation, not an
 *     identity, and the test asserts it as such.
 *  2. **Provenance is re-cited by `provenance_id`.** A data service's `provIdx` indexes its own
 *     list, not `meta.provenance` (DES decision 1); {@link citeMany} registers every id this
 *     payload names through `ctx.prov`, which is the collector the runner publishes.
 *  3. **No curve is never a 503.** A valuation date with no stored curve leaves `payload.curve`
 *     null, every curve-derived cell `{v:null, st:'blank', r:'PROVIDER_DOWN'}` with a
 *     `meta.unavailable` entry, and — this is the point — a user-supplied yield or price still
 *     prices the bond. A pricing screen that refuses to price because a *comparison* is missing is
 *     worse than one that prices and says the comparison is missing.
 *  4. **TIPS and FRNs are refused, not approximated.** Pricing a TIPS on the nominal convention
 *     produces a number that looks right and is wrong by the index ratio. The results block comes
 *     back `na` with `NOT_APPLICABLE` and the reason.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell } from '@terminal/core';
import { addBusinessDays, daysBetween } from '@terminal/core/calendars/calendar';
import type { IsoDate } from '@terminal/core/calendars/calendar';
import type { BondTerms, CouponFrequency } from '@terminal/core/analytics/bond/cashflows';
import {
  accrued as accruedOf,
  cashflows as bondCashflows,
  remainingCashflows,
} from '@terminal/core/analytics/bond/cashflows';
import { bondPriceEngine, bondYieldEngine } from '@terminal/core/analytics/bond/price';
import { bondRiskEngine } from '@terminal/core/analytics/bond/risk';
import { billEngine } from '@terminal/core/analytics/bill';
import { KEY_RATE_ONE_BP } from '@terminal/core/analytics/curve/keyRate';
import { engineMeta } from '@terminal/core/analytics/engine';
import type { InterpolationName } from '@terminal/core/analytics/engine';
import type { DayCountId } from '@terminal/core/daycount/conventions';
import type {
  YasBillResults,
  YasCashflow,
  YasCouponResults,
  YasCurveRef,
  YasInstrument,
  YasKeyRate,
  YasKrdTenor,
  YasParams,
  YasPayload,
  YasResults,
  YasSecurityType,
  YasSettlement,
  YasSpreads,
  YasTerms,
} from '@terminal/core/functions/manifests/YAS';
import {
  bondKrdEngine,
  bondZSpreadEngine,
  CURVE_INTERP_CONVENTIONS,
  curveInterpEngine,
  YAS_KRD_YEARS,
  YAS_NO_BENCHMARK_ROW,
  YAS_NOT_APPLICABLE_DETAIL,
} from '@terminal/core/functions/manifests/YAS';

import type { CurveBuild, CurvePoints } from '../../data/curves.js';
import type { GovtTermsRow } from '../../refdata/terms.js';
import { displayOf } from '../shared/instrumentSummary.js';
import type { ResolveContext } from '../context.js';
import { AppError } from '../../http/errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A cell that is absent by design: null, cites nothing, and the reason lives in `meta`. */
const naCell = (): ValueCell => ({ v: null, st: 'na', provIdx: -1 });

/** A cell blanked because the provider has nothing stored for this date. */
const blankCell = (): ValueCell => ({ v: null, st: 'blank', provIdx: -1, r: 'PROVIDER_DOWN' });

/** A stored or derived number, cited to the row it came from (§0.4 rules 3 and 4). */
const cell = (v: number, provIdx: number): ValueCell => ({ v, st: 'closed', provIdx, ts: null });

/** The `curves.quote_type` values that carry a comparison yield, per curve kind. */
const COMPARISON_QUOTES: ReadonlySet<string> = new Set([
  'par_yield',
  'cmt_yield',
  'ois_rate',
  'investment_yield',
]);

type ProvRow = {
  provenance_id: string;
  source_id: string;
  captured_at: string;
  source_ts: string | null;
};

/**
 * Register every `provenance_id` this payload names, in one statement, and return
 * `provenance_id → meta.provenance` index. See decision 2 in the header.
 */
async function citeMany(
  ctx: ResolveContext,
  ids: readonly (number | null | undefined)[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const want: number[] = [];
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) continue;
    if (!want.includes(id)) want.push(id);
  }
  if (want.length === 0) return out;
  const list = sql.join(
    want.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<ProvRow>(sql`
    SELECT provenance_id::text AS provenance_id, source_id,
           to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(source_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
      FROM provenance
     WHERE provenance_id IN (${list})`);
  const rows = new Map(res.rows.map((row) => [Number(row.provenance_id), row]));
  for (const id of want) {
    const row = rows.get(id);
    if (row === undefined) continue;
    out.set(
      id,
      ctx.prov.add({
        sourceId: row.source_id,
        provenanceId: id,
        capturedAt: new Date(row.captured_at),
        sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
        st: 'closed',
        tier: 'eod',
      }),
    );
  }
  return out;
}

/** `numeric` arrives as a string over the wire. */
function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `govt_terms.security_type` → the five YAS knows. */
function securityTypeOf(raw: string): YasSecurityType {
  const value = raw.trim().toLowerCase();
  if (value === 'bill' || value === 'note' || value === 'bond' || value === 'tips') return value;
  if (value === 'frn' || value === 'floater') return 'frn';
  // A coupon-bearing Treasury whose type string is something else (`'US GOVERNMENT'` in the
  // master's own vocabulary) is a note: it has a coupon and a maturity and prices on the street
  // convention. Never a bill — a bill is identified by its zero coupon, which the caller checks.
  return 'note';
}

/** `govt_terms.coupon_freq` → the engine's `CouponFrequency`. */
function frequencyOf(freq: number): CouponFrequency {
  switch (freq) {
    case 1:
    case 2:
    case 4:
    case 6:
    case 12:
      return freq;
    default:
      return 2;
  }
}

/** The ISO day of an instant in New York — the trading day this page is "today". */
function nyDate(at: Date): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const code = 'YAS';

export async function resolve(ctx: ResolveContext, params: YasParams): Promise<YasPayload> {
  const instrument = ctx.instrument;
  if (instrument === null) {
    throw new AppError('NO_SECURITY_CONTEXT', 'YAS needs a government security.', {
      details: { code: 'YAS' },
    });
  }

  // ── 1. terms, as believed at knownAt (REF-03) ───────────────────────────────────────────────
  const detail = await ctx.data.reference.instrument(instrument.instrumentId);
  const govt = detail.terms !== null && detail.terms.kind === 'govt' ? detail.terms.terms : null;
  const valuationDate = nyDate(ctx.asOf.validAt);
  const asOf = ctx.asOf.validAt.toISOString();

  const key = displayOf(
    detail.instrument.ticker,
    detail.instrument.exchCode,
    detail.instrument.marketSector,
  );

  if (govt === null) {
    throw new AppError('FUNCTION_NOT_APPLICABLE', `${key} has no government terms to price.`, {
      details: { code: 'YAS', instrumentId: instrument.instrumentId },
    });
  }

  const cite = await citeMany(ctx, [govt.provenanceId]);
  const provIdxTerms = cite.get(govt.provenanceId) ?? -1;
  const securityType = securityTypeOf(govt.securityType);
  const couponRate = num(govt.couponRate);
  const isBill = securityType === 'bill' || (couponRate === null && securityType !== 'tips');

  const instrumentBlock: YasInstrument = {
    instrumentId: detail.instrument.instrumentId,
    key,
    name: detail.instrument.name,
    cusip: govt.cusip,
    securityType,
    termLabel: govt.termLabel,
    onTheRun: govt.onTheRun,
  };
  const termsBlock: YasTerms = {
    provIdx: provIdxTerms,
    couponRate,
    couponFreq: govt.couponFreq,
    dayCount: govt.dayCount,
    issueDate: govt.issueDate,
    datedDate: govt.datedDate,
    maturityDate: govt.maturityDate,
    firstCouponDate: govt.firstCouponDate,
    businessDayConv: govt.businessDayConv,
    calendarId: govt.calendarId,
    settlementDays: govt.settlementDays,
    minDenomination: num(govt.minDenomination) ?? 100,
    amountOutstanding: num(govt.amountOutstanding),
    knownAt: ctx.asOf.knownAt.toISOString(),
  };

  // ── 2. settlement (REF-06) ──────────────────────────────────────────────────────────────────
  // `govt_terms.calendar_id` is NOT NULL and defaults to 'SIFMA'.
  const calendar = await ctx.data.reference.calendar(govt.calendarId);
  const settlement: IsoDate =
    params.settlement ?? addBusinessDays(calendar, valuationDate, govt.settlementDays);
  if (daysBetween(settlement, govt.maturityDate) <= 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `settlement ${settlement} is on or after maturity ${govt.maturityDate}.`,
      { details: { location: 'fnParams', field: 'settlement' } },
    );
  }
  const daysToMaturity = daysBetween(settlement, govt.maturityDate);
  const settlementBlock: YasSettlement = {
    date: settlement,
    valuationDate,
    daysToMaturity,
    yearsToMaturity: daysToMaturity / 365,
    rule: params.settlement === null ? 'T+1 SIFMA' : 'user',
  };

  // ── 3. the pricing curve ────────────────────────────────────────────────────────────────────
  const curve = await loadCurve(ctx, params, valuationDate);
  const curveRef: YasCurveRef | null =
    curve === null
      ? null
      : {
          id: curve.points.curveId,
          date: curve.points.curveDate,
          interpolation: curve.build.interpolation,
          // The quote and the Z-spread are read off the same curve by two different rules (§YAS):
          // the quote linearly across the published tenors, the Z-spread on the build. The engine's
          // own conventions are the source of these two labels — never a literal repeated here.
          quoteInterpolation: String(CURVE_INTERP_CONVENTIONS.interpolation),
          quoteExtrapolation: String(CURVE_INTERP_CONVENTIONS.extrapolation),
          buildId: curve.build.buildId,
          provIdx: curve.provIdx,
        };
  if (curve === null) {
    ctx.unavailable.add({
      field: 'curve',
      reason: 'NO_SOURCE',
      detail: `no ${params.curveId} curve on or before ${valuationDate}`,
    });
  } else {
    ctx.engines.add(curve.build.engine);
  }

  // TIPS / FRN: refuse rather than price on a convention that does not apply.
  if (securityType === 'tips' || securityType === 'frn') {
    ctx.unavailable.add({
      field: 'results',
      reason: 'NOT_APPLICABLE',
      detail: YAS_NOT_APPLICABLE_DETAIL,
    });
    return {
      variant: 'govt',
      instrument: instrumentBlock,
      terms: termsBlock,
      settlement: settlementBlock,
      inputs: {
        mode: params.input,
        source: 'user',
        curveId: params.curveId,
        curveDate: curve?.points.curveDate ?? null,
        curveProvIdx: curve?.provIdx ?? -1,
        face: params.face,
      },
      results: notApplicableResults(),
      cashflows: [],
      curve: curveRef,
      engines: ctx.engines.list().map((e) => ({ name: e.name, version: e.version })),
      asOf,
    };
  }

  const comparison = curve === null ? null : comparisonYield(ctx, curve, daysToMaturity);

  const bondTerms = isBill ? null : bondTermsOf(govt, couponRate ?? 0);
  const billCurve = isBill ? await loadBillCurve(ctx, valuationDate) : null;
  const priced: PricedResults = isBill
    ? billResults(ctx, {
        params,
        settlement,
        daysToMaturity,
        maturityDate: govt.maturityDate,
        instrumentId: detail.instrument.instrumentId,
        curve,
        billCurve,
        comparison,
        provIdxTerms,
      })
    : couponResults(ctx, {
        params,
        settlement,
        curve,
        comparison,
        provIdxTerms,
        terms: bondTerms!,
      });
  const results = priced.results;

  const cashflowRows =
    bondTerms === null
      ? billCashflows(params.face, govt.maturityDate, settlement)
      : couponCashflows(bondTerms, settlement, params.face, priced.discounted);

  // The benchmark row: the on-the-run security whose term label is the nearest tenor ≥ this
  // security's remaining life, quoted at the curve's published yield for that tenor.
  const benchmark = await benchmarkOf(ctx, {
    curve,
    instrumentId: detail.instrument.instrumentId,
    onTheRun: govt.onTheRun,
    yieldPct: numberOf(results),
    daysToMaturity,
  });
  if (benchmark === null) {
    ctx.unavailable.add({
      field: 'spreads.benchmark',
      reason: 'NO_SOURCE',
      detail: `${YAS_NO_BENCHMARK_ROW}: no on-the-run Treasury covers ${String(daysToMaturity)} days`,
    });
  }
  results.spreads.benchmark = benchmark;

  return {
    variant: 'govt',
    instrument: instrumentBlock,
    terms: termsBlock,
    settlement: settlementBlock,
    inputs: {
      mode: params.input,
      source: params.input === 'curve' ? 'curve' : 'user',
      curveId: params.curveId,
      curveDate: curve?.points.curveDate ?? null,
      curveProvIdx: curve?.provIdx ?? -1,
      face: params.face,
    },
    results,
    cashflows: cashflowRows,
    curve: curveRef,
    engines: ctx.engines.list().map((e) => ({ name: e.name, version: e.version })),
    asOf,
  };
}

/** The priced yield of a result block, in percent, or `null`. */
function numberOf(results: YasResults): number | null {
  if (results.kind === 'coupon') {
    return typeof results.yieldPct.v === 'number' ? results.yieldPct.v : null;
  }
  return typeof results.investmentYieldPct.v === 'number' ? results.investmentYieldPct.v : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Curve
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface LoadedCurve {
  points: CurvePoints;
  build: CurveBuild;
  provIdx: number;
}

/**
 * The curve for the valuation date, or `null` when nothing is stored on or before it.
 *
 * Never a provider call: the Treasury XML endpoint takes ≈ 18 s (BRIEF §2) and the scheduler owns
 * it. A date older than the valuation date is served and cited as itself.
 */
async function loadCurve(
  ctx: ResolveContext,
  params: YasParams,
  valuationDate: IsoDate,
): Promise<LoadedCurve | null> {
  const points = await ctx.data.curves.points(params.curveId, valuationDate).catch(() => null);
  if (points === null || points.points.length === 0) return null;
  const build = await ctx.data.curves
    .build(params.curveId, points.curveDate, params.interpolation)
    .catch((err: unknown) => {
      // A curve whose published tenors the bootstrap cannot consume is a gap with a reason, not a
      // 500: the inputs are still real and a user-supplied yield still prices the bond.
      ctx.unavailable.add({
        field: 'curve',
        reason: 'NO_SOURCE',
        detail:
          `the ${params.curveId} curve for ${points.curveDate} could not be bootstrapped: ` +
          (err instanceof Error ? err.message : String(err)),
      });
      return null;
    });
  if (build === null) return null;
  const cite = await citeMany(
    ctx,
    points.points.map((p) => p.provenanceId),
  );
  const first = points.points[0];
  const provIdx = first === undefined ? -1 : (cite.get(first.provenanceId) ?? -1);
  return { points, build, provIdx };
}

/** The published Treasury bill curve: points only, no bootstrap (a bill *is* its own discount). */
interface BillCurve {
  points: CurvePoints;
  provIdx: number;
  provIdxOf: Map<number, number>;
}

async function loadBillCurve(
  ctx: ResolveContext,
  valuationDate: IsoDate,
): Promise<BillCurve | null> {
  const points = await ctx.data.curves.points('UST_BILL', valuationDate).catch(() => null);
  if (points === null || points.points.length === 0) return null;
  const provIdxOf = await citeMany(
    ctx,
    points.points.map((p) => p.provenanceId),
  );
  const first = points.points[0]!;
  return { points, provIdx: provIdxOf.get(first.provenanceId) ?? -1, provIdxOf };
}

interface Comparison {
  /** Percent. */
  valuePct: number;
  provIdx: number;
}

/** The curve's published quote at the security's remaining life — `curve.interp@1.0.0`. */
function comparisonYield(
  ctx: ResolveContext,
  curve: LoadedCurve,
  daysToMaturity: number,
): Comparison | null {
  const quotes = curve.points.points.filter((p) => COMPARISON_QUOTES.has(p.quoteType));
  if (quotes.length === 0) return null;
  const result = curveInterpEngine(
    {
      curveId: curve.points.curveId,
      curveDate: curve.points.curveDate,
      quoteType: quotes[0]!.quoteType,
      points: quotes.map((p) => ({ tenorDays: p.tenorDays, value: p.value })),
      tenorDays: daysToMaturity,
    },
    `${curve.points.curveDate}T00:00:00.000Z`,
  );
  ctx.engines.add(engineMeta(result));
  return { valuePct: result.outputs.value, provIdx: curve.provIdx };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Coupon securities (§YAS resolver step 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `govt_terms` → the engines' `BondTerms`, in engine units (coupon as a decimal fraction). */
function bondTermsOf(row: GovtTermsRow, couponPct: number): BondTerms {
  const terms: BondTerms = {
    couponRate: couponPct / 100,
    frequency: frequencyOf(row.couponFreq),
    datedDate: (row.datedDate ?? row.issueDate ?? row.maturityDate),
    maturity: row.maturityDate,
    dayCount: (row.dayCount as DayCountId) ?? 'ACT/ACT',
    ...(row.firstCouponDate === null ? {} : { firstCouponDate: row.firstCouponDate }),
    ...(row.lastRegularCoupon === null
      ? {}
      : { penultimateCouponDate: row.lastRegularCoupon }),
  };
  return terms;
}

interface CouponArgs {
  params: YasParams;
  settlement: IsoDate;
  curve: LoadedCurve | null;
  comparison: Comparison | null;
  provIdxTerms: number;
  terms: BondTerms;
}

/** A priced result block and the curve-discounted flows behind its cashflow table. */
interface PricedResults {
  results: YasResults;
  discounted: Map<string, { df: number; pv: number }>;
}

function couponResults(ctx: ResolveContext, args: CouponArgs): PricedResults {
  const { params, settlement, terms, provIdxTerms } = args;
  const valuationTs = `${settlement}T00:00:00.000Z`;
  const engineTerms = {
    couponRate: terms.couponRate,
    frequency: terms.frequency,
    datedDate: terms.datedDate,
    maturity: terms.maturity,
    settlement,
    ...(terms.firstCouponDate === undefined ? {} : { firstCouponDate: terms.firstCouponDate }),
    ...(terms.penultimateCouponDate === undefined
      ? {}
      : { penultimateCouponDate: terms.penultimateCouponDate }),
    ...(terms.dayCount === undefined ? {} : { dayCount: terms.dayCount }),
  };

  // The yield this pricing runs at, and where it came from.
  let yieldPct: number | null = null;
  let yieldProvIdx = provIdxTerms;
  if (params.input === 'price' && params.price !== null) {
    const solved = bondYieldEngine({ ...engineTerms, cleanPrice: params.price }, valuationTs);
    ctx.engines.add(engineMeta(solved));
    if (!solved.outputs.ok) {
      throw new AppError('INTERNAL', 'the yield solver did not converge for this price.', {
        details: { engine: 'bond.yield', reason: solved.outputs.reason },
      });
    }
    yieldPct = solved.outputs.yieldPercent;
  } else if (params.input === 'yield' && params.yield !== null) {
    yieldPct = params.yield;
  } else if (args.comparison !== null) {
    yieldPct = args.comparison.valuePct;
    yieldProvIdx = args.comparison.provIdx;
  }

  if (yieldPct === null) {
    ctx.unavailable.add({
      field: 'results',
      reason: 'NO_SOURCE',
      detail:
        `no yield to price ${String(terms.maturity)} at: mode '${params.input}' supplied none and ` +
        'no curve is stored on or before the valuation date',
    });
    return {
      results: blankCouponResults(args.comparison, params.krdTenors),
      discounted: new Map(),
    };
  }

  const priced = bondPriceEngine({ ...engineTerms, yield: yieldPct / 100 }, valuationTs);
  ctx.engines.add(engineMeta(priced));
  // `bond.risk` is the *yield*-space engine: duration, convexity and DV01 at the bond's own yield.
  // Its `keyRateDurations` are not asked for and are not what `KRD_*` reports — see decision 1.
  const risk = bondRiskEngine({ ...engineTerms, yield: yieldPct / 100 }, valuationTs);
  ctx.engines.add(engineMeta(risk));

  const faceRatio = params.face / 100;
  const accrual = accrualDays(terms, settlement);

  // The Z-spread is solved first because the key-rate bumps hold it fixed (§0, dictionary).
  const spread = spreadBlock(ctx, {
    curve: args.curve,
    comparison: args.comparison,
    yieldPct,
    dirtyPrice: priced.outputs.dirtyPrice,
    terms,
    settlement,
    provIdxTerms,
  });
  const keyRateDurations = keyRates(ctx, {
    curve: args.curve,
    terms,
    settlement,
    spread: spread.spread,
    tenors: params.krdTenors,
  });

  const results: YasCouponResults = {
    kind: 'coupon',
    yieldPct: cell(yieldPct, yieldProvIdx),
    cleanPrice: cell(priced.outputs.cleanPrice, yieldProvIdx),
    dirtyPrice: cell(priced.outputs.dirtyPrice, yieldProvIdx),
    accrued: cell(priced.outputs.accrued, provIdxTerms),
    accruedDays: accrual.days,
    daysInPeriod: accrual.periodDays,
    macaulayDuration: cell(risk.outputs.macaulayDuration, yieldProvIdx),
    modifiedDuration: cell(risk.outputs.modifiedDuration, yieldProvIdx),
    convexity: cell(risk.outputs.convexity, yieldProvIdx),
    dv01: cell(risk.outputs.dv01 * faceRatio, yieldProvIdx),
    dv01Per100: cell(risk.outputs.dv01, yieldProvIdx),
    // The yield value of a 32nd: how many basis points of yield one 32nd of a point is worth.
    yieldValueOf32nd: cell(1 / 32 / risk.outputs.dv01, yieldProvIdx),
    keyRateDurations,
    spreads: spread.spreads,
    conventions: risk.outputs.conventions,
  };
  return { results, discounted: spread.discounted };
}

/** Accrued days and the days in the period, from the engine's own accrual result. */
function accrualDays(terms: BondTerms, settlement: IsoDate): { days: number; periodDays: number } {
  // `bond.price`'s outputs do not carry the day counts, and `accrued()` is the same pure function
  // the engine calls; using it here reports the engine's own numerator and denominator rather than
  // a second count of the same days.
  const accrual = accruedOf(terms, settlement);
  return { days: accrual.days, periodDays: accrual.periodDays };
}

function blankCouponResults(
  comparison: Comparison | null,
  krdTenors: readonly YasKrdTenor[],
): YasCouponResults {
  return {
    kind: 'coupon',
    yieldPct: blankCell(),
    cleanPrice: blankCell(),
    dirtyPrice: blankCell(),
    accrued: blankCell(),
    accruedDays: 0,
    daysInPeriod: 0,
    macaulayDuration: blankCell(),
    modifiedDuration: blankCell(),
    convexity: blankCell(),
    dv01: blankCell(),
    dv01Per100: blankCell(),
    yieldValueOf32nd: blankCell(),
    // Never 0: a zero key-rate duration is a claim about the bond, and this path has no price.
    keyRateDurations: krdTenors.map((tenor) => ({ tenor, krd: null })),
    spreads: {
      interpolatedCurveYieldPct:
        comparison === null ? blankCell() : cell(comparison.valuePct, comparison.provIdx),
      toCurveBp: blankCell(),
      zSpreadBp: blankCell(),
      benchmark: null,
    },
    conventions: {},
  };
}

function notApplicableResults(): YasCouponResults {
  return {
    kind: 'coupon',
    yieldPct: naCell(),
    cleanPrice: naCell(),
    dirtyPrice: naCell(),
    accrued: naCell(),
    accruedDays: 0,
    daysInPeriod: 0,
    macaulayDuration: naCell(),
    modifiedDuration: naCell(),
    convexity: naCell(),
    dv01: naCell(),
    dv01Per100: naCell(),
    yieldValueOf32nd: naCell(),
    keyRateDurations: [],
    spreads: {
      interpolatedCurveYieldPct: naCell(),
      toCurveBp: naCell(),
      zSpreadBp: naCell(),
      benchmark: null,
    },
    conventions: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spreads
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SpreadArgs {
  curve: LoadedCurve | null;
  comparison: Comparison | null;
  yieldPct: number;
  dirtyPrice: number | null;
  terms: BondTerms | null;
  settlement: IsoDate;
  provIdxTerms: number;
}

/** The spreads block, plus the flows the Z-spread solve discounted (one solve per run). */
interface SpreadResult {
  spreads: YasSpreads;
  discounted: Map<string, { df: number; pv: number }>;
  /**
   * The solved Z-spread as a decimal fraction per annum, or `null` when there is nothing to solve
   * against or the solver found no root. The key-rate bumps hold exactly this number fixed, so it
   * travels as the engine produced it — never re-derived from the basis-point cell.
   */
  spread: number | null;
}

function spreadBlock(ctx: ResolveContext, args: SpreadArgs): SpreadResult {
  const { comparison, curve } = args;
  if (comparison === null) {
    ctx.unavailable.add({
      field: 'spreads',
      reason: 'NO_SOURCE',
      detail: 'no stored curve quote to spread against on or before the valuation date',
    });
    return {
      spreads: {
        interpolatedCurveYieldPct: blankCell(),
        toCurveBp: blankCell(),
        zSpreadBp: blankCell(),
        benchmark: null,
      },
      discounted: new Map(),
      spread: null,
    };
  }
  const toCurveBp = (args.yieldPct - comparison.valuePct) * 100;
  const discounted = new Map<string, { df: number; pv: number }>();
  let zSpread: ValueCell | null = null;
  let spread: number | null = null;
  if (curve !== null && args.terms !== null && args.dirtyPrice !== null) {
    const flows = remainingCashflows(args.terms, args.settlement).map((flow) => ({
      date: flow.date,
      amount: flow.amount,
    }));
    const solved = bondZSpreadEngine(
      {
        curveId: curve.points.curveId,
        curveDate: curve.points.curveDate,
        dayCount: curve.points.dayCount as DayCountId,
        compounding: curve.points.compounding,
        interpolation: curve.build.interpolation as InterpolationName,
        nodes: curve.build.nodes.map((n) => ({ t: n.t, df: n.df })),
        settlement: args.settlement,
        flows,
        dirtyPrice: args.dirtyPrice,
        frequency: args.terms.frequency,
      },
      `${curve.points.curveDate}T00:00:00.000Z`,
    );
    ctx.engines.add(engineMeta(solved));
    if (solved.outputs.ok) {
      zSpread = cell(solved.outputs.spreadBp, comparison.provIdx);
      spread = solved.outputs.spread;
      for (const flow of solved.outputs.flows) {
        discounted.set(flow.date, { df: flow.df, pv: flow.pv });
      }
    } else {
      ctx.unavailable.add({
        field: 'spreads.zSpreadBp',
        reason: 'NO_SOURCE',
        detail: 'the Z-spread solver found no root within ±2000 bp of the stored curve',
      });
      zSpread = naCell();
    }
  }
  return {
    spreads: {
      interpolatedCurveYieldPct: cell(comparison.valuePct, comparison.provIdx),
      toCurveBp: cell(toCurveBp, comparison.provIdx),
      zSpreadBp: zSpread,
      benchmark: null,
    },
    discounted,
    spread,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Key-rate durations (§YAS resolver step 4, §0 "Key-rate durations")
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface KeyRateArgs {
  curve: LoadedCurve | null;
  terms: BondTerms;
  settlement: IsoDate;
  /** The solved Z-spread, decimal per annum — held fixed across every bump. */
  spread: number | null;
  tenors: readonly YasKrdTenor[];
}

/**
 * `bond.krd@1.0.0`: one ±1 bp triangular-kernel bump of each key node of the pricing curve's zero
 * curve, repriced with the Z-spread held fixed (see decision 1 in the header).
 *
 * With no curve — or with a curve the Z-spread solver could not price against — every bucket is
 * `null` with a `meta.unavailable` entry saying which. It is never the yield-space decomposition
 * `bond.risk` would happily hand over, because that number answers a different question and would
 * arrive under a field id that promises this one.
 */
function keyRates(ctx: ResolveContext, args: KeyRateArgs): YasKeyRate[] {
  const tenors = [...new Set(args.tenors)].sort(
    (a, b) => YAS_KRD_YEARS[a] - YAS_KRD_YEARS[b],
  );
  const curve = args.curve;
  if (curve === null || args.spread === null) {
    ctx.unavailable.add({
      field: 'results.keyRateDurations',
      reason: 'NO_SOURCE',
      detail:
        curve === null
          ? 'no pricing curve on or before the valuation date, so there is no zero curve to bump'
          : 'the Z-spread did not solve, so there is no spread to hold fixed while the curve moves',
    });
    return tenors.map((tenor) => ({ tenor, krd: null }));
  }
  const result = bondKrdEngine(
    {
      curveId: curve.points.curveId,
      curveDate: curve.points.curveDate,
      dayCount: curve.points.dayCount as DayCountId,
      compounding: curve.points.compounding,
      interpolation: curve.build.interpolation as InterpolationName,
      nodes: curve.build.nodes.map((n) => ({ t: n.t, df: n.df })),
      settlement: args.settlement,
      flows: remainingCashflows(args.terms, args.settlement).map((flow) => ({
        date: flow.date,
        amount: flow.amount,
      })),
      spread: args.spread,
      frequency: args.terms.frequency,
      keyRateTenors: tenors.map((tenor) => YAS_KRD_YEARS[tenor]),
      bump: KEY_RATE_ONE_BP,
    },
    `${curve.points.curveDate}T00:00:00.000Z`,
  );
  ctx.engines.add(engineMeta(result));
  return tenors.map((tenor) => {
    const node = result.outputs.keyRateDurations.find((k) => k.tenor === YAS_KRD_YEARS[tenor]);
    return { tenor, krd: node?.duration ?? null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Bills (§YAS resolver step 5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface BillArgs {
  params: YasParams;
  settlement: IsoDate;
  daysToMaturity: number;
  maturityDate: string;
  instrumentId: number;
  /** The pricing curve the spread is measured against (`params.curveId`). */
  curve: LoadedCurve | null;
  /**
   * The Treasury **bill** curve, which is where a bill's discount rate is published — a separate
   * read from the pricing curve, because `UST_PAR` carries no `discount_rate` quote (§YAS step 5).
   */
  billCurve: BillCurve | null;
  comparison: Comparison | null;
  provIdxTerms: number;
}

function billResults(ctx: ResolveContext, args: BillArgs): PricedResults {
  const { params, daysToMaturity, provIdxTerms } = args;
  let discountPct: number | null = null;
  let discountProvIdx = provIdxTerms;

  if (params.input === 'discount' && params.discount !== null) {
    discountPct = params.discount;
  } else if (params.input === 'price' && params.price !== null) {
    // `P = F(1 − d·t/360)` inverted: the engine takes the discount rate, so the price branch
    // inverts the same published identity before the engine runs.
    discountPct = ((100 - params.price) / 100) * (360 / daysToMaturity) * 100;
  } else if (args.billCurve !== null) {
    const bills = args.billCurve.points;
    const point = bills.points.find(
      (p) => p.quoteType === 'discount_rate' && p.instrumentId === args.instrumentId,
    );
    if (point !== undefined) {
      discountPct = point.value;
      discountProvIdx = args.billCurve.provIdxOf.get(point.provenanceId) ?? provIdxTerms;
    } else {
      const quotes = bills.points.filter((p) => p.quoteType === 'discount_rate');
      if (quotes.length > 0) {
        const interpolated = curveInterpEngine(
          {
            curveId: bills.curveId,
            curveDate: bills.curveDate,
            quoteType: 'discount_rate',
            points: quotes.map((p) => ({ tenorDays: p.tenorDays, value: p.value })),
            tenorDays: daysToMaturity,
          },
          `${bills.curveDate}T00:00:00.000Z`,
        );
        ctx.engines.add(engineMeta(interpolated));
        discountPct = interpolated.outputs.value;
        discountProvIdx = args.billCurve.provIdx;
        ctx.unavailable.add({
          field: 'inputs.discount',
          reason: 'NO_SOURCE',
          detail:
            `bill not on the Treasury bill curve for ${bills.curveDate}; discount rate interpolated`,
        });
      }
    }
  }

  const spreads = spreadBlock(ctx, {
    curve: args.curve,
    comparison: args.comparison,
    yieldPct: 0,
    dirtyPrice: null,
    terms: null,
    settlement: args.settlement,
    provIdxTerms,
  }).spreads;
  // A bill has one flow and no coupon: there is no Z-spread to speak of (§YAS payload).
  spreads.zSpreadBp = null;

  if (discountPct === null) {
    ctx.unavailable.add({
      field: 'results',
      reason: 'NO_SOURCE',
      detail: `no discount rate for this bill on or before ${args.settlement}, and none supplied`,
    });
    return {
      results: {
        kind: 'bill',
        discountRatePct: blankCell(),
        investmentYieldPct: blankCell(),
        price: blankCell(),
        moneyMarketYieldPct: blankCell(),
        daysToMaturity,
        dollarDiscount: blankCell(),
        dv01: blankCell(),
        modifiedDuration: blankCell(),
        spreads,
        conventions: {},
      },
      discounted: new Map(),
    };
  }

  const priced = billEngine(
    { daysToMaturity, discountRate: discountPct / 100, face: 100 },
    `${args.settlement}T00:00:00.000Z`,
  );
  ctx.engines.add(engineMeta(priced));
  const out = priced.outputs;
  const faceRatio = params.face / 100;
  const years = daysToMaturity / 365;
  const modifiedDuration = years / (1 + (out.investmentYield * daysToMaturity) / 365);
  const dv01 = modifiedDuration * (out.price / 100) * params.face * 1e-4;

  if (spreads.interpolatedCurveYieldPct.v !== null && typeof spreads.interpolatedCurveYieldPct.v === 'number') {
    spreads.toCurveBp = cell(
      (out.investmentYieldPercent - spreads.interpolatedCurveYieldPct.v) * 100,
      spreads.interpolatedCurveYieldPct.provIdx,
    );
  }

  const results: YasBillResults = {
    kind: 'bill',
    discountRatePct: cell(out.discountRatePercent, discountProvIdx),
    investmentYieldPct: cell(out.investmentYieldPercent, discountProvIdx),
    price: cell(out.price, discountProvIdx),
    moneyMarketYieldPct: cell(out.moneyMarketYield * 100, discountProvIdx),
    daysToMaturity,
    dollarDiscount: cell(out.discount * faceRatio, discountProvIdx),
    dv01: cell(dv01, discountProvIdx),
    modifiedDuration: cell(modifiedDuration, discountProvIdx),
    spreads,
    conventions: out.conventions,
  };
  return { results, discounted: new Map() };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cashflows
// ─────────────────────────────────────────────────────────────────────────────────────────────

function couponCashflows(
  terms: BondTerms,
  settlement: IsoDate,
  face: number,
  discounted: Map<string, { df: number; pv: number }>,
): YasCashflow[] {
  const ratio = face / 100;
  return bondCashflows(terms)
    .filter((flow) => daysBetween(settlement, flow.date) > 0)
    .map((flow) => {
      const hit = discounted.get(flow.date);
      const total = flow.amount * ratio;
      return {
        date: flow.date,
        kind: flow.principal > 0 ? ('maturity' as const) : ('coupon' as const),
        days: daysBetween(settlement, flow.date),
        coupon: flow.interest * ratio,
        principal: flow.principal * ratio,
        total,
        df: hit?.df ?? null,
        pv: hit === undefined ? null : hit.df * total,
        fromCurve: hit !== undefined,
      };
    });
}

function billCashflows(face: number, maturityDate: string, settlement: IsoDate): YasCashflow[] {
  return [
    {
      date: maturityDate,
      kind: 'maturity',
      days: daysBetween(settlement, maturityDate),
      coupon: 0,
      principal: face,
      total: face,
      df: null,
      pv: null,
      fromCurve: false,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Benchmark
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface BenchmarkArgs {
  curve: LoadedCurve | null;
  instrumentId: number;
  onTheRun: boolean;
  yieldPct: number | null;
  daysToMaturity: number;
}

type BenchmarkRow = {
  instrument_id: string;
  ticker: string;
  exch_code: string;
  market_sector: string;
  term_label: string | null;
  maturity_date: string;
  provenance_id: string;
};

/**
 * The on-the-run security whose remaining life is the smallest one at least as long as this
 * security's, quoted at the curve's published yield for its own tenor.
 *
 * `null` — with the footer note — when the security *is* the benchmark, when it is a bill, or when
 * no on-the-run row covers it. Never the nearest row in either direction: a 30-year bond compared
 * with the 10-year note is a spread nobody asked for.
 */
async function benchmarkOf(
  ctx: ResolveContext,
  args: BenchmarkArgs,
): Promise<YasPayload['results']['spreads']['benchmark']> {
  const { curve } = args;
  if (curve === null || args.onTheRun || args.yieldPct === null) return null;
  const res = await ctx.db.execute<BenchmarkRow>(sql`
    SELECT g.instrument_id::text AS instrument_id, i.ticker, i.exch_code, i.market_sector,
           g.term_label, g.maturity_date::text AS maturity_date,
           g.provenance_id::text AS provenance_id
      FROM govt_terms g
      JOIN instruments i ON i.instrument_id = g.instrument_id
     WHERE g.on_the_run = true
       AND g.security_type IN ('note', 'bond')
       AND g.instrument_id <> ${String(args.instrumentId)}::bigint
       AND g.valid_from <= ${ctx.asOf.validAt}::timestamptz
       AND g.valid_to   >  ${ctx.asOf.validAt}::timestamptz
       AND g.tx_from    <= ${ctx.asOf.knownAt}::timestamptz
       AND g.tx_to      >  ${ctx.asOf.knownAt}::timestamptz
       AND i.valid_from <= ${ctx.asOf.validAt}::timestamptz
       AND i.valid_to   >  ${ctx.asOf.validAt}::timestamptz
       AND i.tx_from    <= ${ctx.asOf.knownAt}::timestamptz
       AND i.tx_to      >  ${ctx.asOf.knownAt}::timestamptz
     ORDER BY g.maturity_date`);
  const valuationDate = nyDate(ctx.asOf.validAt);
  const candidates = res.rows
    .map((row) => ({
      row,
      days: daysBetween(valuationDate, row.maturity_date),
    }))
    .filter((c) => c.days >= args.daysToMaturity)
    .sort((a, b) => a.days - b.days);
  const best = candidates[0];
  if (best === undefined) return null;

  const quotes = curve.points.points.filter((p) => COMPARISON_QUOTES.has(p.quoteType));
  if (quotes.length === 0) return null;
  const interpolated = curveInterpEngine(
    {
      curveId: curve.points.curveId,
      curveDate: curve.points.curveDate,
      quoteType: quotes[0]!.quoteType,
      points: quotes.map((p) => ({ tenorDays: p.tenorDays, value: p.value })),
      tenorDays: best.days,
    },
    `${curve.points.curveDate}T00:00:00.000Z`,
  );
  ctx.engines.add(engineMeta(interpolated));
  const benchYield = interpolated.outputs.value;
  return {
    key: displayOf(
      best.row.ticker,
      best.row.exch_code,
      best.row.market_sector as Parameters<typeof displayOf>[2],
    ),
    tenor: best.row.term_label ?? `${String(best.days)}D`,
    yieldPct: benchYield,
    spreadBp: (args.yieldPct - benchYield) * 100,
    provIdx: curve.provIdx,
  };
}
