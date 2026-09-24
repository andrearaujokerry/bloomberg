/**
 * `functions/SWPM/resolve.ts` — the swap manager (FUNCTIONS_TIER3.md §SWPM).
 *
 * One USD SOFR OIS, priced on the `SOFR_OIS` build. **Every number on the page comes out of an
 * `EngineResult`** from `swap.ois@1.0.0`: the schedule, the compounded float rates, the discount
 * factors, the cashflows, the par rate, the annuity PV01 and the parallel-shift DV01. The resolver
 * does no financial arithmetic of its own; what it does is unit conversion (currency → % of
 * notional, percent → basis points) and one subtraction — the swap spread — which is the same
 * shape BTMM's spread block already has.
 *
 * Three rules shape the file:
 *
 *  1. **The schedule honours the calendar or it is wrong.** Roll dates, the T+2 spot and the
 *     two-business-day payment lag all come from `oisSwapSchedule`, which rolls modified-following
 *     on SIFMA. A schedule built on raw calendar days is wrong even when the discounting is right,
 *     so the acceptance test asserts every accrual end and every payment date against the
 *     **database-materialised** `SIFMA` calendar (REF-06), not against the rule set the engine
 *     happens to hold.
 *  2. **The curve is proxied, always, and the payload says so.** `PROXY_CURVE` and
 *     `NO_OIS_SWAP_QUOTES_SOURCE` are on every payload: there is no OIS swap quote and no futures
 *     source in this build (BRIEF §2). Nothing is blanked for it — a proxied curve still prices a
 *     swap — but the reader is told what the term points are made of.
 *  3. **No curve is a degraded page, not a 500.** With nothing stored, the schedule is still
 *     returned (it needs only the calendar) and every valuation cell is blank with a reason. The
 *     one case that *is* an error is a `curveDate` the caller typed that has no curve on or before
 *     it: a typed date that does not exist is a mistake, not a gap.
 *
 * Deviations from §SWPM are listed in `SWPM.ts`'s header; the two that matter while reading this
 * file are that `results.dv01` is the engine's analytic parallel-shift derivative (signed as the
 * NPV change for a **+1 bp** shift, which is what §SWPM's own screen shows), and that key-rate risk
 * is computed by repricing through the engine on a triangular-kernel bump rather than through a
 * `keyRateRisk` entry point the landed engine does not have.
 */

import type { ReasonCode, Tier, ValueCell, ValueState } from '@terminal/core';
import { engineMeta } from '@terminal/core/analytics/engine';
import type { DfPoint } from '@terminal/core/analytics/curve/interp';
import { interpolationName } from '@terminal/core/analytics/curve/interp';
import { bumpedDfPoints, keyRateNodes } from '@terminal/core/analytics/curve/keyRate';
import type {
  OisSwapInputs,
  OisSwapOutputs,
  OisSwapSchedule,
} from '@terminal/core/analytics/swap/ois';
import { oisSwapConventionsOf, oisSwapEngine, oisSwapSchedule } from '@terminal/core/analytics/swap/ois';
import type { Calendar, IsoDate } from '@terminal/core/calendars/calendar';
import { addDays } from '@terminal/core/calendars/calendar';
import { settlementDate } from '@terminal/core/daycount/businessDay';
import type {
  SwpmCurveBlock,
  SwpmFixing,
  SwpmKrd,
  SwpmKrdTenor,
  SwpmLeg,
  SwpmParams,
  SwpmPayload,
  SwpmPeriod,
  SwpmResults,
  SwpmSpreads,
  SwpmTrade,
} from '@terminal/core/functions/manifests/SWPM';
import { SWPM_CONVENTIONS, SWPM_CURVE_CAVEATS } from '@terminal/core/functions/manifests/SWPM';
import { localClock } from '@terminal/core/quote/session';

import type { CurveBuild, CurvePoints } from '../../data/curves.js';
import { CurveDataError } from '../../data/curves.js';
import { RateDataError } from '../../data/rates.js';
import { AppError } from '../../http/errors.js';
import type { ResolveContext } from '../context.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

const STORED_TIER: Tier = 'eod';
const CURVE_STALE_BUSINESS_DAYS = 5;
const ONE_BP = 1e-4;
const CURVE_ID = 'SOFR_OIS';
const SPREAD_CURVE_ID = 'UST_PAR';

/** Years per key-rate tenor label. */
const KRD_YEARS: Readonly<Record<SwpmKrdTenor, number>> = Object.freeze({
  '2Y': 2,
  '5Y': 5,
  '10Y': 10,
  '30Y': 30,
});

function numCell(v: number, st: ValueState, provIdx: number): ValueCell {
  return { v, st, provIdx };
}

function blankCell(st: ValueState, r: ReasonCode): ValueCell {
  return { v: null, st, r, provIdx: -1 };
}

/**
 * A cell the resolver *declines to compute*, as opposed to one the sources could not fill.
 *
 * It carries no `r`: the closed `ReasonCode` union (`core/types/entitlement.ts`, mirrored on the
 * wire) has no member for "not applicable", and `NOT_IN_UNIVERSE` — which this used to carry —
 * tells the reader the number lies outside the served universe, which is a different and false
 * claim. `st:'na'` is the state the screen renders as `—`, and the sentence lives in the matching
 * `meta.unavailable` entry, exactly as YAS's own `naCell` does it.
 */
function naCell(): ValueCell {
  return { v: null, st: 'na', provIdx: -1 };
}

function nyDate(ms: number): IsoDate {
  return (localClock('America/New_York', ms)?.date ??
    new Date(ms).toISOString().slice(0, 10));
}

function businessDaysBetween(cal: Calendar, from: IsoDate, to: IsoDate): number {
  if (from >= to) return 0;
  let count = 0;
  let cursor = from;
  for (let i = 0; i < 400 && cursor < to; i += 1) {
    cursor = addDays(cursor, 1);
    if (cal.isBusinessDay(cursor)) count += 1;
  }
  return count;
}

/** Tenor label → approximate calendar days, for picking the nearest longer Treasury point. */
function tenorDaysOf(tenor: string): number {
  const m = /^(\d+)([YM])$/.exec(tenor);
  if (m === null) return Number.POSITIVE_INFINITY;
  const n = Number(m[1]);
  return m[2] === 'Y' ? Math.round(n * 365.25) : Math.round(n * 30.4375);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Key-rate bump (§SWPM step 10)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The §0 triangular kernel and the log-discount shift it drives now live in
// `core/analytics/curve/keyRate.ts`, because YAS reports the same `KRD_*` fields for a bond and
// must perturb its curve with the *same* operator — a `KRD_10Y` that means one thing on this
// screen and another on YAS is a hedge error, not a presentation difference.
//
// The kernels form a partition of unity over the node axis, so the sum of the key-rate bumps is a
// parallel bump of exactly 1 bp. `Σ dv01` therefore *approximates* `results.dv01` rather than
// reproducing it: each key-rate `dv01` is a one-sided reprice, `pv(bumped) − pv(base)`, so it
// carries the bump's truncation error (the swap's convexity over 1 bp), while `results.dv01` is
// `swap.ois`'s analytic derivative `curveDv01`. On the golden's 5Y payer the two are
// 4,736.657990147825 and 4,737.785575467898 — a gap of 1.13 currency units, 0.024 % — which is why
// the KRD test asserts a 2 % tolerance rather than equality. (§0 specifies a ±1 bp *central*
// difference; this screen takes the one-sided one, which is the deviation its header records, and
// YAS takes the central one §0 and the dictionary spell out for a bond.)

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: SwpmParams): Promise<SwpmPayload> {
  const valuationDate = nyDate(ctx.asOf.validAt.getTime());
  const valuationTs = ctx.asOf.validAt.toISOString();
  const cal = await ctx.data.reference.calendar('SIFMA'); // REF-06
  const tradeDate = valuationDate;

  // ── 2. dates ──────────────────────────────────────────────────────────────────────────────
  const effective = (params.effective ?? settlementDate(cal, tradeDate, 2));
  if (params.maturity !== null && params.maturity <= effective) {
    throw new AppError('VALIDATION_FAILED', 'The maturity must be after the effective date.', {
      details: {
        location: 'fnParams',
        field: 'maturity',
        detail: 'maturity must be after the effective date',
      },
    });
  }

  // ── 3. the curve ──────────────────────────────────────────────────────────────────────────
  let points: CurvePoints | null = null;
  try {
    points = await ctx.data.curves.points(CURVE_ID, params.curveDate ?? valuationDate);
  } catch (err) {
    if (!(err instanceof CurveDataError)) throw err;
    if (params.curveDate !== null) {
      throw new AppError(
        'VALIDATION_FAILED',
        `No ${CURVE_ID} curve on or before ${params.curveDate}.`,
        {
          details: {
            location: 'fnParams',
            field: 'curveDate',
            detail: `no ${CURVE_ID} curve on or before ${params.curveDate}`,
          },
        },
      );
    }
  }

  let build: CurveBuild | null = null;
  if (points !== null) {
    try {
      build = await ctx.data.curves.build(CURVE_ID, points.curveDate, params.interpolation);
    } catch (err) {
      if (!(err instanceof CurveDataError)) throw err;
      build = null;
    }
  }

  // The schedule anchor: the curve date when there is one (that is the axis `t` is measured on),
  // the valuation date when there is not.
  const anchorDate = (build?.curveDate ?? valuationDate);
  if (effective < anchorDate) {
    throw new AppError(
      'VALIDATION_FAILED',
      'SWPM values spot- and forward-starting swaps; a swap already accruing needs its published fixings.',
      {
        details: {
          location: 'fnParams',
          field: 'effective',
          detail:
            `the effective date ${effective} is before the pricing date ${anchorDate}; ` +
            'swap.ois@1.0.0 values spot- and forward-starting swaps only (WORKPLAN L507)',
        },
      },
    );
  }

  let curveProvIdx = -1;
  let curveState: ValueState = 'closed';
  let curveBlock: SwpmCurveBlock;
  if (points === null || build === null) {
    ctx.unavailable.add({
      field: 'curve',
      reason: 'NO_SOURCE',
      detail: `no ${CURVE_ID} curve on or before ${params.curveDate ?? valuationDate}`,
    });
    curveBlock = {
      id: CURVE_ID,
      date: null,
      requestedDate: params.curveDate,
      buildId: null,
      method: null,
      interpolation: null,
      engine: null,
      provIdx: -1,
      caveats: [...SWPM_CURVE_CAVEATS],
    };
  } else {
    const anchor = points.points[0];
    curveState =
      businessDaysBetween(cal, points.curveDate, valuationDate) >
      CURVE_STALE_BUSINESS_DAYS
        ? 'stale'
        : 'closed';
    curveProvIdx =
      anchor === undefined
        ? -1
        : ctx.prov.add({
            sourceId: points.sourceId,
            provenanceId: anchor.provenanceId,
            capturedAt: new Date(anchor.capturedAt),
            sourceTs: anchor.sourceTs === null ? null : new Date(anchor.sourceTs),
            st: curveState,
            tier: STORED_TIER,
          });
    ctx.engines.add(build.engine);
    curveBlock = {
      id: CURVE_ID,
      date: build.curveDate,
      requestedDate: params.curveDate,
      buildId: build.buildId,
      method: 'ois_bootstrap',
      interpolation: build.interpolation,
      engine: build.engine,
      provIdx: curveProvIdx,
      caveats: [...SWPM_CURVE_CAVEATS],
    };
  }

  // ── 4. the SOFR fixing ────────────────────────────────────────────────────────────────────
  let fixing: SwpmFixing = {
    rateCode: 'SOFR',
    effectiveDate: null,
    rate: blankCell('blank', 'PROVIDER_DOWN'),
    provIdx: -1,
    usedForRealised: false,
  };
  try {
    const fx = await ctx.data.rates.latest('SOFR');
    const provIdx = ctx.prov.add({
      sourceId: 'nyfed.rates',
      provenanceId: fx.provenanceId,
      capturedAt: new Date(fx.capturedAt),
      sourceTs: fx.sourceTs === null ? null : new Date(fx.sourceTs),
      st: 'closed',
      tier: STORED_TIER,
    });
    fixing = {
      rateCode: 'SOFR',
      effectiveDate: fx.effectiveDate,
      rate:
        fx.rate === null ? blankCell('blank', 'PROVIDER_DOWN') : numCell(fx.rate, 'closed', provIdx),
      provIdx,
      // A spot- or forward-starting swap has no realised days: every observation is a curve
      // forward. The engine's scope (see the header) is what makes this always false in this build.
      usedForRealised: false,
    };
    if (fx.rate === null) {
      ctx.unavailable.add({
        field: 'fixing.rate',
        reason: 'NO_SOURCE',
        detail: `the stored SOFR fixing for ${fx.effectiveDate} has no rate`,
      });
    }
  } catch (err) {
    if (!(err instanceof RateDataError)) throw err;
    ctx.unavailable.add({
      field: 'fixing.rate',
      reason: 'NO_SOURCE',
      detail: `no SOFR fixing stored on or before ${valuationDate}`,
    });
  }

  // ── 5-10. schedule, valuation and risk ────────────────────────────────────────────────────
  const inputsOf = (
    curvePoints: readonly DfPoint[],
    fixedRate: number,
    interpolation: string,
  ): OisSwapInputs => ({
    curveDate: anchorDate,
    curve: {
      curveId: CURVE_ID,
      interpolation: interpolationName(interpolation),
      points: curvePoints,
    },
    tenor: params.tenor,
    ...(params.maturity === null ? {} : { maturityDate: params.maturity }),
    effectiveDate: effective,
    fixedRate,
    notional: params.notional,
    payReceive: params.side,
    fixedFrequency: 1,
    settlementDays: 2,
    businessDayConvention: 'modified_following',
    calendar: 'SIFMA',
    paymentLagDays: 2,
  });

  let valued: OisSwapOutputs | null = null;
  let parRatePct: number | null = null;
  const krds: SwpmKrd[] = [];

  // The schedule is a calendar question and is answered first, with or without a curve. Doing it
  // here also validates the term: `oisSwapSchedule` refuses a maturity that is not a whole number
  // of fixed periods after the effective date, and that is the caller's mistake, not a 500.
  let schedule: OisSwapSchedule;
  try {
    schedule = oisSwapSchedule(
      anchorDate,
      {
        tenor: params.tenor,
        ...(params.maturity === null ? {} : { maturityDate: params.maturity }),
        effectiveDate: effective,
      },
      oisSwapConventionsOf({ calendar: 'SIFMA', paymentLagDays: 2 }),
    );
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new AppError('VALIDATION_FAILED', 'The swap term is not schedulable.', {
      details: {
        location: 'fnParams',
        field: params.maturity === null ? 'tenor' : 'maturity',
        detail: err.message,
      },
      cause: err,
    });
  }

  if (build === null) {
    ctx.unavailable.add({
      field: 'results',
      reason: 'NO_SOURCE',
      detail: `no ${CURVE_ID} curve on or before ${params.curveDate ?? valuationDate}; the swap is not valued`,
    });
    ctx.unavailable.add({
      field: 'legs',
      reason: 'NO_SOURCE',
      detail: `no ${CURVE_ID} curve on or before ${params.curveDate ?? valuationDate}; the schedule is returned without cashflows`,
    });
  } else {
    const nodes: DfPoint[] = build.nodes.map((n) => ({ t: n.t, df: n.df }));
    // The par rate is invariant in the contract rate, so one probe at 0 % solves it and the second
    // run below is the payload's single source of truth for every other number.
    try {
      const probe = oisSwapEngine(inputsOf(nodes, 0, build.interpolation), valuationTs);
      ctx.engines.add(engineMeta(probe));
      parRatePct = probe.outputs.parRate;

      const fixedRate = params.fixedRate ?? parRatePct;
      const result = oisSwapEngine(inputsOf(nodes, fixedRate, build.interpolation), valuationTs);
      ctx.engines.add(engineMeta(result));
      valued = result.outputs;
      schedule = result.outputs.schedule;

      // Key-rate risk: one reprice per key tenor on a triangular-kernel bump of the zero curve.
      const keys = [...new Set(params.krdTenors)].sort((a, b) => KRD_YEARS[a] - KRD_YEARS[b]);
      const grid = keyRateNodes(keys.map((tenor) => KRD_YEARS[tenor]));
      for (let i = 0; i < keys.length; i += 1) {
        const tenor = keys[i]!;
        const bumped = oisSwapEngine(
          inputsOf(bumpedDfPoints(nodes, grid[i]!, ONE_BP), fixedRate, build.interpolation),
          valuationTs,
        );
        ctx.engines.add(engineMeta(bumped));
        const dv01 = bumped.outputs.pv - valued.pv;
        krds.push({ tenor, krd: dv01 / (params.notional * ONE_BP), dv01 });
      }
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      // A degenerate schedule or a non-positive annuity is never served as a partial number.
      throw new AppError('INTERNAL', `swap.ois could not value this swap: ${err.message}`, {
        details: { engine: `${oisSwapEngine.name}@${oisSwapEngine.version}` },
        cause: err,
      });
    }
  }

  // ── the legs ──────────────────────────────────────────────────────────────────────────────
  const cellState = build === null ? 'blank' : curveState;
  const periodCell = (v: number | null): ValueCell =>
    v === null ? blankCell('blank', 'PROVIDER_DOWN') : numCell(v, cellState, curveProvIdx);

  const fixedPeriods: SwpmPeriod[] = schedule.periods.map((p, i) => {
    const cf = valued?.fixedLeg[i];
    return {
      n: p.index,
      start: p.accrualStart,
      end: p.accrualEnd,
      paymentDate: p.paymentDate,
      days: p.days,
      accrualFactor: p.accrual,
      rate: periodCell(valued === null ? null : valued.fixedRate),
      realisedDays: 0,
      projectedDays: 0,
      isCurrent: p.accrualStart <= valuationDate && valuationDate < p.accrualEnd,
      cashflow: periodCell(cf?.amount ?? null),
      df: cf?.df ?? null,
      pv: periodCell(cf?.pv ?? null),
    };
  });

  const floatPeriods: SwpmPeriod[] = schedule.periods.map((p, i) => {
    const cf = valued?.floatLeg[i];
    return {
      n: p.index,
      start: p.accrualStart,
      end: p.accrualEnd,
      paymentDate: p.paymentDate,
      days: p.days,
      accrualFactor: p.accrual,
      rate: periodCell(cf === undefined ? null : cf.rate * 100),
      realisedDays: 0,
      projectedDays: cf?.observations ?? 0,
      isCurrent: p.accrualStart <= valuationDate && valuationDate < p.accrualEnd,
      cashflow: periodCell(cf?.amount ?? null),
      df: cf?.df ?? null,
      pv: periodCell(cf?.pv ?? null),
    };
  });

  const nextOf = (periods: SwpmPeriod[]): { date: string | null; cashflow: ValueCell } => {
    const hit = periods.find((p) => p.paymentDate >= valuationDate);
    return {
      date: hit?.paymentDate ?? null,
      cashflow: hit?.cashflow ?? blankCell('na', 'NOT_IN_UNIVERSE'),
    };
  };
  const nextFixed = nextOf(fixedPeriods);
  const nextFloat = nextOf(floatPeriods);
  if (nextFixed.date === null || nextFloat.date === null) {
    ctx.unavailable.add({
      field: 'legs.nextCashflow',
      reason: 'NOT_APPLICABLE',
      detail: 'every payment of this schedule is in the past',
    });
  }

  // A spot- or forward-starting swap has accrued nothing: the first period has not begun.
  const accruedValue = valued === null ? null : 0;
  ctx.unavailable.add({
    field: 'legs.dv01',
    reason: 'NOT_APPLICABLE',
    detail:
      'swap.ois@1.0.0 returns the ticket-level parallel-shift DV01 and the fixed-leg annuity ' +
      'PV01; a per-leg curve DV01 would need a per-leg reprice the engine does not expose, and is ' +
      'not computed by subtraction here (results.dv01 is the swap’s sensitivity)',
  });

  const legs: SwpmLeg[] = [
    {
      kind: 'fixed',
      payReceive: params.side,
      periods: fixedPeriods,
      pv: periodCell(valued?.fixedLegPv ?? null),
      accrued: periodCell(accruedValue),
      dv01: periodCell(valued?.dv01 ?? null),
      nextPaymentDate: nextFixed.date,
      nextCashflow: nextFixed.cashflow,
    },
    {
      kind: 'float',
      payReceive: params.side === 'pay' ? 'receive' : 'pay',
      periods: floatPeriods,
      pv: periodCell(valued?.floatLegPv ?? null),
      accrued: periodCell(accruedValue),
      // Declined, not absent: see `naCell` and the `legs.dv01` entry added above.
      dv01: naCell(),
      nextPaymentDate: nextFloat.date,
      nextCashflow: nextFloat.cashflow,
    },
  ];

  // ── 11. the swap spread ───────────────────────────────────────────────────────────────────
  let spreads: SwpmSpreads | null = null;
  if (valued !== null && build !== null) {
    let ustPoints: CurvePoints | null = null;
    try {
      ustPoints = await ctx.data.curves.points(SPREAD_CURVE_ID, build.curveDate);
    } catch (err) {
      if (!(err instanceof CurveDataError)) throw err;
    }
    const wanted = tenorDaysOf(params.tenor);
    const candidates = [...(ustPoints?.points ?? [])].sort((a, b) => a.tenorDays - b.tenorDays);
    const hit =
      candidates.find((p) => p.tenor === params.tenor) ??
      candidates.find((p) => p.tenorDays >= wanted) ??
      null;
    if (ustPoints === null || hit === null) {
      ctx.unavailable.add({
        field: 'results.spreads',
        reason: 'NO_SOURCE',
        detail: `no ${SPREAD_CURVE_ID} curve on or before ${build.curveDate}; swap spread not computed`,
      });
    } else {
      const ustProvIdx = ctx.prov.add({
        sourceId: ustPoints.sourceId,
        provenanceId: hit.provenanceId,
        capturedAt: new Date(hit.capturedAt),
        sourceTs: hit.sourceTs === null ? null : new Date(hit.sourceTs),
        st: 'closed',
        tier: STORED_TIER,
      });
      spreads = {
        treasuryTenor: hit.tenor,
        treasuryYieldPct: numCell(hit.value, 'closed', ustProvIdx),
        swapSpreadBp: numCell((valued.fixedRate - hit.value) * 100, cellState, curveProvIdx),
        curveProvIdx: ustProvIdx,
      };
    }
  } else {
    ctx.unavailable.add({
      field: 'results.spreads',
      reason: 'NO_SOURCE',
      detail: `no ${CURVE_ID} valuation, so no swap spread to compute against ${SPREAD_CURVE_ID}`,
    });
  }

  // ── 9. results ────────────────────────────────────────────────────────────────────────────
  const dv01 = valued?.curveDv01 ?? null;
  const results: SwpmResults = {
    parRatePct: periodCell(parRatePct),
    fixedRatePct: periodCell(valued?.fixedRate ?? null),
    npv: periodCell(valued?.pv ?? null),
    pvFixed: periodCell(valued?.fixedLegPv ?? null),
    pvFloat: periodCell(valued?.floatLegPv ?? null),
    annuityPv01: periodCell(valued?.dv01 ?? null),
    dv01: periodCell(dv01),
    dv01Per1mm: periodCell(dv01 === null ? null : (dv01 * 1e6) / params.notional),
    marketValuePctNotional: periodCell(
      valued === null ? null : (valued.pv / params.notional) * 100,
    ),
    accrued: periodCell(accruedValue),
    breakEvenRatePct: periodCell(parRatePct),
    effectiveDurationYears: periodCell(dv01 === null ? null : dv01 / (params.notional * ONE_BP)),
    keyRateDurations: krds,
    spreads,
  };

  const trade: SwpmTrade = {
    side: params.side,
    notional: params.notional,
    currency: 'USD',
    tenor: params.tenor,
    tradeDate,
    effective: schedule.effectiveDate,
    maturity: schedule.maturityDate,
    valuationDate,
    fixedRate: periodCell(valued?.fixedRate ?? null),
    fixedRateSource: params.fixedRate === null ? 'par' : 'user',
    stub: 'none',
  };

  return {
    variant: 'default',
    trade,
    conventions: SWPM_CONVENTIONS,
    curve: curveBlock,
    fixing,
    legs,
    results,
    engines: ctx.engines.list().map((e) => ({ name: e.name, version: e.version })),
  };
}
