/**
 * `functions/SRCH/resolve.ts` — Treasury Search (FUNCTIONS_TIER3.md §SRCH L1302-1558).
 *
 * SRCH is a *terms* screen that happens to show yields. That ordering is the whole design:
 *
 *  1. **No row is ever given a fabricated price.** There is no evaluated Treasury price source in
 *     this build, so every analytic column is derived from the stored curve by the same engines YAS
 *     calls — `curve.interp`, `bond.price`, `bond.risk`, `bill` — and each call is registered with
 *     `ctx.engines.add` so `meta.engines[]` can be recomputed years later (ANAL-08). A row's yield
 *     therefore equals the YAS screen's yield for the same security and settlement (ANAL-09), which
 *     is only true because both sides call the same functions rather than agreeing today.
 *  2. **A missing curve is not a 503.** With nothing stored on or before the valuation date the
 *     analytic cells are `{v:null, st:'blank', r:'PROVIDER_DOWN'}` with one `meta.unavailable`
 *     entry, and the terms columns, filters, counts and facets are still returned: the screen stays
 *     a usable terms search, which is what a user with no curve still came for.
 *  3. **TIPS and FRNs keep their terms and refuse their analytics.** Pricing a TIPS on the nominal
 *     convention produces a number that looks right and is wrong by the index ratio, so those rows
 *     carry `na` cells with `NOT_IN_UNIVERSE` and the note `TIPS_FRN_NOT_PRICED` — the same
 *     boundary YAS draws.
 *
 * Two deviations from §SRCH, both forced by what is landed and neither of them silent:
 *
 *  - **There is no `data.govt.search`.** §SRCH's data-dependency table introduces it ("new — see
 *    additions below") and `packages/server/src/data/` has no `govt.ts`; that file is not this
 *    task's to write. The universe read is therefore one statement issued here, exactly as YAS's
 *    benchmark read and WEI's universe read are, and it returns the current Treasury set with its
 *    provenance. Predicates, per-predicate `matched` counts, facets, sort and paging run in the
 *    resolver over that set — which §SRCH step 6 already sanctions for the analytic sort case
 *    ("with 14 seeded securities this is one in-memory sort") and which is bounded by
 *    {@link UNIVERSE_CAP} with a stated reason when it binds.
 *  - **`counts.excludedNoTerms`** is counted in the same statement rather than a second one.
 */

import { sql } from 'drizzle-orm';

import type { ValueCell } from '@terminal/core';
import {
  addBusinessDays,
  addYears,
  businessDaysBetween,
  compareDates,
  daysBetween,
} from '@terminal/core/calendars/calendar';
import type { IsoDate } from '@terminal/core/calendars/calendar';
import type { CouponFrequency } from '@terminal/core/analytics/bond/cashflows';
import { bondPriceEngine } from '@terminal/core/analytics/bond/price';
import { bondRiskEngine } from '@terminal/core/analytics/bond/risk';
import { billEngine } from '@terminal/core/analytics/bill';
import { engineMeta } from '@terminal/core/analytics/engine';
import type { DayCountId } from '@terminal/core/daycount/conventions';
import type {
  SrchColumn,
  SrchColumnId,
  SrchCounts,
  SrchFacets,
  SrchFilter,
  SrchMaturityBucket,
  SrchNote,
  SrchParams,
  SrchPayload,
  SrchPricing,
  SrchRow,
  SrchSecurityType,
} from '@terminal/core/functions/manifests/SRCH';
import {
  SRCH_ANALYTIC_COLUMNS,
  SRCH_COLUMNS,
  SRCH_COLUMN_IDS,
  SRCH_TIPS_FRN_DETAIL,
  SrchCriteria,
  srchMaturityBucket,
} from '@terminal/core/functions/manifests/SRCH';
import { curveInterpEngine } from '@terminal/core/functions/manifests/YAS';

import type { CurveBuild, CurvePoints } from '../../data/curves.js';
import type { ResolveContext } from '../context.js';
import { displayOf } from '../shared/instrumentSummary.js';

export const code = 'SRCH';

/**
 * The most Treasury rows one run will read.
 *
 * The universe of this build is the seeded Treasury set — there is no issuance file — so this is a
 * guard rather than a limit anyone meets. When it binds the payload says so instead of silently
 * screening part of the market.
 */
const UNIVERSE_CAP = 2000;

/** How old the curve may be before the derived cells are marked stale (TERM-12). */
const STALE_AFTER_BUSINESS_DAYS = 5;

/** The `curve_points.quote_type` values that carry a comparison yield. */
const COMPARISON_QUOTES: ReadonlySet<string> = new Set([
  'par_yield',
  'cmt_yield',
  'ois_rate',
  'investment_yield',
]);

/** The face DV01 is quoted on (§SRCH step 5). */
const DV01_FACE = 1_000_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

const naCell = (): ValueCell => ({ v: null, st: 'na', provIdx: -1 });
const notPricedCell = (): ValueCell => ({ v: null, st: 'na', r: 'NOT_IN_UNIVERSE', provIdx: -1 });
const blankCell = (): ValueCell => ({ v: null, st: 'blank', r: 'PROVIDER_DOWN', provIdx: -1 });
const textCell = (v: string | boolean | null, provIdx: number): ValueCell =>
  v === null ? naCell() : { v, st: 'closed', provIdx };
const numCell = (v: number | null, provIdx: number, st: ValueCell['st'] = 'closed'): ValueCell =>
  v === null ? naCell() : { v, st, provIdx };

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `govt_terms.security_type` → the five SRCH screens on. */
function securityTypeOf(raw: string, couponRate: number | null): SrchSecurityType {
  const value = raw.trim().toLowerCase();
  if (value === 'bill' || value === 'note' || value === 'bond' || value === 'tips') return value;
  if (value === 'frn' || value === 'floater') return 'frn';
  // A coupon-bearing Treasury whose type string is the master's own vocabulary is a note; a
  // zero-coupon one is a bill. Never guessed the other way: a bill priced as a note is wrong by
  // the whole accrued convention.
  return couponRate === null ? 'bill' : 'note';
}

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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The universe (§SRCH step 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface UniverseSqlRow extends Record<string, unknown> {
  instrument_id: string;
  ticker: string;
  exch_code: string;
  market_sector: string;
  instrument_name: string;
  cusip: string;
  security_type: string;
  term_label: string | null;
  issue_date: string | null;
  dated_date: string | null;
  maturity_date: string;
  coupon_type: string;
  coupon_rate: string | null;
  coupon_freq: number;
  day_count: string;
  first_coupon_date: string | null;
  last_regular_coupon: string | null;
  is_callable: boolean;
  amount_outstanding: string | null;
  on_the_run: boolean;
  provenance_id: string;
  source_id: string | null;
  captured_at: string | null;
  source_ts: string | null;
  excluded_no_terms: string;
}

/**
 * The current Treasury universe, as believed at `knownAt` and valid at `validAt` (REF-03, REF-04),
 * with the count of `govt` instruments that carry no terms row at all.
 *
 * One statement. The bitemporal predicates are `bt_as_of`, the same function `db/bitemporal.ts`
 * emits, so this read sees exactly what a repository read would.
 */
async function universe(ctx: ResolveContext): Promise<UniverseSqlRow[]> {
  const validAt = ctx.asOf.validAt;
  const knownAt = ctx.asOf.knownAt;
  const res = await ctx.db.execute<UniverseSqlRow>(sql`
    WITH no_terms AS (
      SELECT count(*)::text AS n
        FROM instruments i
       WHERE i.asset_class = 'govt'
         AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                      ${validAt}::timestamptz, ${knownAt}::timestamptz)
         AND NOT EXISTS (
               SELECT 1 FROM govt_terms g
                WHERE g.instrument_id = i.instrument_id
                  AND bt_as_of(g.valid_from, g.valid_to, g.tx_from, g.tx_to,
                               ${validAt}::timestamptz, ${knownAt}::timestamptz))
    )
    SELECT i.instrument_id::text        AS instrument_id,
           i.ticker, i.exch_code,
           i.market_sector::text        AS market_sector,
           i.name                       AS instrument_name,
           g.cusip, g.security_type, g.term_label,
           g.issue_date::text           AS issue_date,
           g.dated_date::text           AS dated_date,
           g.maturity_date::text        AS maturity_date,
           g.coupon_type,
           g.coupon_rate::text          AS coupon_rate,
           g.coupon_freq,
           g.day_count,
           g.first_coupon_date::text    AS first_coupon_date,
           g.last_regular_coupon::text  AS last_regular_coupon,
           g.is_callable,
           g.amount_outstanding::text   AS amount_outstanding,
           g.on_the_run,
           g.provenance_id::text        AS provenance_id,
           p.source_id,
           to_char(p.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(p.source_ts   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts,
           (SELECT n FROM no_terms)     AS excluded_no_terms
      FROM govt_terms g
      JOIN instruments i
        ON i.instrument_id = g.instrument_id
       AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN provenance p ON p.provenance_id = g.provenance_id
     WHERE bt_as_of(g.valid_from, g.valid_to, g.tx_from, g.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
     ORDER BY g.maturity_date, g.instrument_id
     LIMIT ${sql.param(UNIVERSE_CAP + 1)}`);
  return [...res.rows];
}

/** One security as the resolver works with it: the row, parsed, plus its provenance index. */
interface Security {
  instrumentId: number;
  key: string;
  name: string;
  cusip: string;
  securityType: SrchSecurityType;
  termLabel: string | null;
  onTheRun: boolean;
  isCallable: boolean;
  maturityDate: IsoDate;
  issueDate: string | null;
  datedDate: string | null;
  firstCouponDate: string | null;
  lastRegularCoupon: string | null;
  couponType: string;
  couponRate: number | null;
  couponFreq: number;
  dayCount: string;
  amountOutstanding: number | null;
  provIdx: number;
}

function toSecurity(ctx: ResolveContext, row: UniverseSqlRow): Security {
  const provenanceId = Number(row.provenance_id);
  const provIdx =
    row.source_id === null || row.captured_at === null || !Number.isInteger(provenanceId)
      ? -1
      : ctx.prov.add({
          sourceId: row.source_id,
          provenanceId,
          capturedAt: new Date(row.captured_at),
          sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
          st: 'closed',
          tier: 'eod',
        });
  const couponRate = num(row.coupon_rate);
  return {
    instrumentId: Number(row.instrument_id),
    key: displayOf(
      row.ticker,
      row.exch_code,
      row.market_sector as Parameters<typeof displayOf>[2],
    ),
    name: row.instrument_name,
    cusip: row.cusip.trim(),
    securityType: securityTypeOf(row.security_type, couponRate),
    termLabel: row.term_label,
    onTheRun: row.on_the_run,
    isCallable: row.is_callable,
    maturityDate: row.maturity_date,
    issueDate: row.issue_date,
    datedDate: row.dated_date,
    firstCouponDate: row.first_coupon_date,
    lastRegularCoupon: row.last_regular_coupon,
    couponType: row.coupon_type,
    couponRate,
    couponFreq: row.coupon_freq,
    dayCount: row.day_count,
    amountOutstanding: num(row.amount_outstanding),
    provIdx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Criteria (§SRCH step 2's predicates, evaluated one at a time so `filters[].matched` is real)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Predicate {
  field: string;
  label: string;
  test: (s: Security) => boolean;
  unavailableReason: string | null;
}

function predicates(params: SrchParams, valuationDate: IsoDate): Predicate[] {
  const out: Predicate[] = [];

  out.push({
    field: 'securityTypes',
    label: `Type ${params.securityTypes.join(', ')}`,
    test: (s) => params.securityTypes.includes(s.securityType),
    unavailableReason: null,
  });
  out.push({
    field: 'couponTypes',
    label: `Coupon type ${params.couponTypes.join(', ')}`,
    test: (s) => (params.couponTypes as readonly string[]).includes(s.couponType),
    unavailableReason: null,
  });

  // `maturityFrom/To` win; `yearsFrom/To` are the same window expressed from the valuation date.
  const maturityFrom =
    params.maturityFrom ??
    (params.yearsFrom === null ? null : addDaysByYears(valuationDate, params.yearsFrom));
  const maturityTo =
    params.maturityTo ??
    (params.yearsTo === null ? null : addDaysByYears(valuationDate, params.yearsTo));
  if (maturityFrom !== null || maturityTo !== null) {
    out.push({
      field: 'maturity',
      label: `Maturity ${maturityFrom ?? '…'} … ${maturityTo ?? '…'}`,
      test: (s) =>
        (maturityFrom === null || compareDates(s.maturityDate, maturityFrom) >= 0) &&
        (maturityTo === null || compareDates(s.maturityDate, maturityTo) <= 0),
      unavailableReason: null,
    });
  }

  if (params.couponFrom !== null || params.couponTo !== null) {
    out.push({
      field: 'coupon',
      label: `Coupon ${params.couponFrom ?? '…'} … ${params.couponTo ?? '…'} %`,
      // A bill has no coupon at all: it passes a coupon window only when no window was asked for,
      // which is the one reading that does not silently drop or silently keep it.
      test: (s) =>
        s.couponRate === null
          ? false
          : (params.couponFrom === null || s.couponRate >= params.couponFrom) &&
            (params.couponTo === null || s.couponRate <= params.couponTo),
      unavailableReason: null,
    });
  }

  if (params.onTheRun !== 'any') {
    out.push({
      field: 'onTheRun',
      label: `On-the-run ${params.onTheRun}`,
      test: (s) => (params.onTheRun === 'only' ? s.onTheRun : !s.onTheRun),
      unavailableReason: null,
    });
  }

  if (params.callable !== 'any') {
    out.push({
      field: 'callable',
      label: `Callable ${params.callable}`,
      test: (s) => (params.callable === 'only' ? s.isCallable : !s.isCallable),
      unavailableReason: null,
    });
  }

  if (params.minAmountOutstanding !== null) {
    const min = params.minAmountOutstanding;
    out.push({
      field: 'minAmountOutstanding',
      label: `Amount outstanding ≥ ${String(min)}`,
      test: (s) => s.amountOutstanding !== null && s.amountOutstanding >= min,
      unavailableReason: 'AMOUNT_OUTSTANDING_NOT_PUBLISHED_FOR_EVERY_SECURITY',
    });
  }

  if (params.cusip !== null) {
    const prefix = params.cusip.toUpperCase();
    out.push({
      field: 'cusip',
      label: `CUSIP ${prefix}*`,
      test: (s) => s.cusip.toUpperCase().startsWith(prefix),
      unavailableReason: null,
    });
  }

  return out;
}

/** `date + n years`, with a fractional year taken as 365 days — the 365-day year `MTY_YEARS` uses. */
function addDaysByYears(date: IsoDate, years: number): IsoDate {
  const whole = Math.trunc(years);
  const rest = years - whole;
  const base = addYears(date, whole);
  if (rest === 0) return base;
  const ms = Date.parse(`${base}T00:00:00.000Z`) + Math.round(rest * 365) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pricing inputs (§SRCH step 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface LoadedCurve {
  points: CurvePoints;
  build: CurveBuild;
  provIdx: number;
  /** The published comparison quotes, ready for `curve.interp`. */
  quotes: { tenorDays: number; value: number }[];
  quoteType: string;
}

async function loadCurve(
  ctx: ResolveContext,
  params: SrchParams,
  valuationDate: IsoDate,
): Promise<LoadedCurve | null> {
  const points = await ctx.data.curves
    .points(params.curveId, params.curveDate ?? valuationDate)
    .catch(() => null);
  if (points === null || points.points.length === 0) return null;
  const build = await ctx.data.curves
    .build(params.curveId, points.curveDate, points.defaultInterpolation)
    .catch((err: unknown) => {
      ctx.unavailable.add({
        field: 'pricing',
        reason: 'NO_SOURCE',
        detail:
          `the ${params.curveId} curve for ${points.curveDate} could not be bootstrapped: ` +
          (err instanceof Error ? err.message : String(err)),
      });
      return null;
    });
  if (build === null) return null;
  const quotePoints = points.points.filter((p) => COMPARISON_QUOTES.has(p.quoteType));
  if (quotePoints.length === 0) return null;
  const first = points.points[0]!;
  const provIdx = ctx.prov.add({
    sourceId: points.sourceId,
    provenanceId: first.provenanceId,
    capturedAt: new Date(first.capturedAt),
    sourceTs: first.sourceTs === null ? null : new Date(first.sourceTs),
    st: 'closed',
    tier: 'eod',
  });
  return {
    points,
    build,
    provIdx,
    quotes: quotePoints.map((p) => ({ tenorDays: p.tenorDays, value: p.value })),
    quoteType: quotePoints[0]!.quoteType,
  };
}

interface BillCurve {
  points: CurvePoints;
  provIdx: number;
  provIdxOf: Map<number, number>;
}

async function loadBillCurve(
  ctx: ResolveContext,
  curveDate: IsoDate,
): Promise<BillCurve | null> {
  const points = await ctx.data.curves.points('UST_BILL', curveDate).catch(() => null);
  if (points === null || points.points.length === 0) return null;
  const provIdxOf = new Map<number, number>();
  for (const point of points.points) {
    if (provIdxOf.has(point.provenanceId)) continue;
    provIdxOf.set(
      point.provenanceId,
      ctx.prov.add({
        sourceId: points.sourceId,
        provenanceId: point.provenanceId,
        capturedAt: new Date(point.capturedAt),
        sourceTs: point.sourceTs === null ? null : new Date(point.sourceTs),
        st: 'closed',
        tier: 'eod',
      }),
    );
  }
  const first = points.points[0]!;
  return { points, provIdx: provIdxOf.get(first.provenanceId) ?? -1, provIdxOf };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-row analytics (§SRCH step 5) — every number out of an engine (ANAL-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Cells = Record<SrchColumnId, ValueCell>;

interface PricingEnv {
  curve: LoadedCurve | null;
  billCurve: BillCurve | null;
  settlement: IsoDate;
  /** `'closed'` normally, `'stale'` when the curve is older than five business days (TERM-12). */
  analyticState: ValueCell['st'];
}

/** The terms half of a row: the same for every security type, cited to the `govt_terms` row. */
function termsCells(security: Security, yearsToMaturity: number): Partial<Cells> {
  const p = security.provIdx;
  return {
    CUSIP: textCell(security.cusip, p),
    SECURITY_TYP: textCell(security.securityType, p),
    TERM_LABEL: textCell(security.termLabel, p),
    CPN: numCell(security.couponRate, p),
    CPN_FREQ: numCell(security.couponFreq, p),
    MATURITY: textCell(security.maturityDate, p),
    ISSUE_DT: textCell(security.issueDate, p),
    MTY_YEARS: numCell(yearsToMaturity, p),
    AMT_OUTSTANDING: numCell(security.amountOutstanding, p),
    ON_THE_RUN: textCell(security.onTheRun, p),
    DAY_CNT_DES: textCell(security.dayCount, p),
  };
}

function everyAnalytic(cell: () => ValueCell): Partial<Cells> {
  const out: Partial<Cells> = {};
  for (const id of SRCH_ANALYTIC_COLUMNS) out[id] = cell();
  return out;
}

/** A coupon security, priced at the curve's own yield for its remaining life. */
function couponCells(ctx: ResolveContext, security: Security, env: PricingEnv): Partial<Cells> {
  const curve = env.curve;
  if (curve === null) return everyAnalytic(blankCell);

  const daysToMaturity = daysBetween(env.settlement, security.maturityDate);
  const interpolated = curveInterpEngine(
    {
      curveId: curve.points.curveId,
      curveDate: curve.points.curveDate,
      quoteType: curve.quoteType,
      points: curve.quotes,
      tenorDays: daysToMaturity,
    },
    `${curve.points.curveDate}T00:00:00.000Z`,
  );
  ctx.engines.add(engineMeta(interpolated));
  const yieldPct = interpolated.outputs.value;

  const engineTerms = {
    couponRate: (security.couponRate ?? 0) / 100,
    frequency: frequencyOf(security.couponFreq),
    datedDate: security.datedDate ?? security.issueDate ?? security.maturityDate,
    maturity: security.maturityDate,
    settlement: env.settlement,
    dayCount: (security.dayCount as DayCountId) ?? 'ACT/ACT',
    ...(security.firstCouponDate === null ? {} : { firstCouponDate: security.firstCouponDate }),
    ...(security.lastRegularCoupon === null
      ? {}
      : { penultimateCouponDate: security.lastRegularCoupon }),
  };
  const valuationTs = `${env.settlement}T00:00:00.000Z`;
  const priced = bondPriceEngine({ ...engineTerms, yield: yieldPct / 100 }, valuationTs);
  ctx.engines.add(engineMeta(priced));
  const risk = bondRiskEngine({ ...engineTerms, yield: yieldPct / 100 }, valuationTs);
  ctx.engines.add(engineMeta(risk));

  const idx = curve.provIdx;
  const st = env.analyticState;
  return {
    YLD_YTM_MID: numCell(yieldPct, idx, st),
    // A coupon security has no discount rate and no bond-equivalent yield of the bill kind: those
    // two cells are `na`, which is an answer, not a gap.
    DISC_RATE: naCell(),
    BEY: naCell(),
    PX_CLEAN_MID: numCell(priced.outputs.cleanPrice, idx, st),
    PX_DIRTY_MID: numCell(priced.outputs.dirtyPrice, idx, st),
    ACCRUED: numCell(priced.outputs.accrued, idx, st),
    DUR_ADJ_MID: numCell(risk.outputs.modifiedDuration, idx, st),
    DV01: numCell((risk.outputs.dv01 * DV01_FACE) / 100, idx, st),
  };
}

/** A bill, priced off the published discount rate — interpolated only when it says so. */
function billCells(ctx: ResolveContext, security: Security, env: PricingEnv): Partial<Cells> {
  const bills = env.billCurve;
  const daysToMaturity = daysBetween(env.settlement, security.maturityDate);
  if (bills === null || daysToMaturity <= 0) {
    if (bills === null) {
      ctx.unavailable.add({
        field: `rows.${security.cusip}.DISC_RATE`,
        reason: 'NO_SOURCE',
        detail: `no Treasury bill curve stored for ${env.curve?.points.curveDate ?? 'the valuation date'}`,
      });
    }
    return everyAnalytic(blankCell);
  }

  let discountPct: number | null = null;
  let idx = bills.provIdx;
  const exact = bills.points.points.find(
    (p) => p.quoteType === 'discount_rate' && p.instrumentId === security.instrumentId,
  );
  if (exact !== undefined) {
    discountPct = exact.value;
    idx = bills.provIdxOf.get(exact.provenanceId) ?? bills.provIdx;
  } else {
    const quotes = bills.points.points.filter((p) => p.quoteType === 'discount_rate');
    if (quotes.length > 0) {
      const interpolated = curveInterpEngine(
        {
          curveId: bills.points.curveId,
          curveDate: bills.points.curveDate,
          quoteType: 'discount_rate',
          points: quotes.map((p) => ({ tenorDays: p.tenorDays, value: p.value })),
          tenorDays: daysToMaturity,
        },
        `${bills.points.curveDate}T00:00:00.000Z`,
      );
      ctx.engines.add(engineMeta(interpolated));
      discountPct = interpolated.outputs.value;
      ctx.unavailable.add({
        field: `rows.${security.cusip}.DISC_RATE`,
        reason: 'NO_SOURCE',
        detail:
          `bill not on the Treasury bill curve for ${bills.points.curveDate}; ` +
          'discount rate interpolated',
      });
    }
  }
  if (discountPct === null) return everyAnalytic(blankCell);

  const priced = billEngine(
    { daysToMaturity, discountRate: discountPct / 100, face: 100 },
    `${env.settlement}T00:00:00.000Z`,
  );
  ctx.engines.add(engineMeta(priced));
  const out = priced.outputs;
  const years = daysToMaturity / 365;
  const modifiedDuration = years / (1 + (out.investmentYield * daysToMaturity) / 365);
  const dv01 = modifiedDuration * (out.price / 100) * DV01_FACE * 1e-4;
  const st = env.analyticState;
  return {
    // The comparable yield measure for a bill is its bond-equivalent yield, which is what the
    // screen's `Yld %` column means for this row — not a par yield it does not have.
    YLD_YTM_MID: numCell(out.investmentYieldPercent, idx, st),
    DISC_RATE: numCell(out.discountRatePercent, idx, st),
    BEY: numCell(out.investmentYieldPercent, idx, st),
    PX_CLEAN_MID: numCell(out.price, idx, st),
    PX_DIRTY_MID: numCell(out.price, idx, st),
    ACCRUED: numCell(0, idx, st),
    DUR_ADJ_MID: numCell(modifiedDuration, idx, st),
    DV01: numCell(dv01, idx, st),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sort and page (§SRCH step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type SortKey = number | string | null;

function sortKeyOf(cells: Cells, col: string): SortKey {
  const cell = cells[col as SrchColumnId];
  if (cell === undefined) return null;
  const v = cell.v;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function encodeCursor(v: SortKey, id: number): string {
  return Buffer.from(JSON.stringify({ v, id }), 'utf8').toString('base64url');
}

function pageStart(
  ctx: ResolveContext,
  params: SrchParams,
  sorted: readonly { instrumentId: number; sortKey: SortKey }[],
): number {
  const page = ctx.page;
  const cursor = page?.cursor;
  if (page === undefined || cursor === undefined || cursor === null || cursor === '') return 0;
  let decoded: { v: SortKey; id: number };
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v: SortKey;
      id: number;
    };
  } catch {
    throw new TypeError(`SRCH: '${cursor}' is not a screen cursor`);
  }
  const at = sorted.findIndex((row) => row.instrumentId === decoded.id);
  if (at < 0) return 0;
  return page.direction === 'fwd' ? at + 1 : Math.max(0, at - params.pageSize);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Saved searches (§SRCH step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SavedSearchRow extends Record<string, unknown> {
  search_id: string;
  name: string;
  query: unknown;
}

async function loadSavedSearch(
  ctx: ResolveContext,
  searchId: number,
): Promise<{ searchId: number; name: string; criteria: Partial<SrchParams> } | null> {
  const res = await ctx.db.execute<SavedSearchRow>(sql`
    SELECT search_id::text AS search_id, name, query
      FROM saved_searches
     WHERE search_id = ${String(searchId)}::bigint
       AND kind = 'srch'
       AND owner_user_id = ${String(ctx.user.userId)}::bigint`);
  const row = res.rows[0];
  if (row === undefined) return null;
  const parsed = SrchCriteria.safeParse(row.query);
  if (!parsed.success) return null;
  return { searchId: Number(row.search_id), name: row.name, criteria: parsed.data };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: SrchParams): Promise<SrchPayload> {
  const valuationDate = nyDate(ctx.asOf.validAt);
  const notes: SrchNote[] = ['NO_BOND_PRICE_SOURCE', 'SEED_UNIVERSE_ONLY'];

  // ── 1. saved search: the stored criteria first, the explicit params over them ────────────────
  let savedSearch: { searchId: number; name: string } | null = null;
  let effective = params;
  if (params.savedSearchId !== null) {
    const saved = await loadSavedSearch(ctx, params.savedSearchId);
    if (saved === null) {
      ctx.unavailable.add({
        field: 'savedSearch',
        reason: 'NO_SOURCE',
        detail: 'saved search not found or not owned by this user',
      });
    } else {
      savedSearch = { searchId: saved.searchId, name: saved.name };
      // An explicit param wins over the saved one. `SrchParams.parse` has filled every key with a
      // default, so "explicit" is decided by comparing with the defaults rather than by presence.
      const defaults = SrchCriteria.parse({});
      const overrides: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(params)) {
        if (!(key in defaults)) continue;
        const asDefault = (defaults as Record<string, unknown>)[key];
        if (JSON.stringify(value) !== JSON.stringify(asDefault)) overrides[key] = value;
      }
      effective = { ...params, ...saved.criteria, ...overrides };
    }
  }

  // ── 2. universe and filters ─────────────────────────────────────────────────────────────────
  const rawRows = await universe(ctx);
  if (rawRows.length > UNIVERSE_CAP) {
    ctx.unavailable.add({
      field: 'universe',
      reason: 'NOT_APPLICABLE',
      detail: `more than ${String(UNIVERSE_CAP)} Treasury securities are stored; the screen read the first ${String(UNIVERSE_CAP)} by maturity`,
    });
    rawRows.length = UNIVERSE_CAP;
  }
  const securities = rawRows.map((row) => toSecurity(ctx, row));
  const excludedNoTerms = Number(rawRows[0]?.excluded_no_terms ?? '0');

  const tests = predicates(effective, valuationDate);
  const filters: SrchFilter[] = tests.map((predicate) => ({
    field: predicate.field,
    label: predicate.label,
    matched: securities.filter((s) => predicate.test(s)).length,
    unavailableReason: predicate.unavailableReason,
  }));
  const matched = securities.filter((s) => tests.every((predicate) => predicate.test(s)));

  const universeBlock = {
    market: 'UST' as const,
    label: `US Treasuries (govt_terms, as of ${valuationDate})`,
    size: securities.length,
    coverage: 'SEED_UNIVERSE_ONLY' as const,
    provIdx: securities[0]?.provIdx ?? -1,
  };

  // ── 3. pricing inputs ───────────────────────────────────────────────────────────────────────
  const calendar = await ctx.data.reference.calendar('SIFMA');
  const settlement: IsoDate =
    effective.settlement ?? addBusinessDays(calendar, valuationDate, 1);
  const curve = await loadCurve(ctx, effective, valuationDate);
  if (curve === null) {
    ctx.unavailable.add({
      field: 'pricing',
      reason: 'NO_SOURCE',
      detail: `no ${effective.curveId} curve on or before ${effective.curveDate ?? valuationDate}`,
    });
  } else {
    ctx.engines.add(curve.build.engine);
    if (compareDates(curve.points.curveDate, valuationDate) < 0) {
      notes.push('CURVE_DATE_BEFORE_VALUATION');
    }
  }
  const staleBy =
    curve === null ? 0 : businessDaysBetween(calendar, curve.points.curveDate, valuationDate);
  const analyticState: ValueCell['st'] = staleBy > STALE_AFTER_BUSINESS_DAYS ? 'stale' : 'closed';
  const billCurve =
    curve === null ? null : await loadBillCurve(ctx, curve.points.curveDate);
  const env: PricingEnv = { curve, billCurve, settlement, analyticState };

  const pricing: SrchPricing = {
    basis: 'curve_derived_no_market_quotes',
    curveId: effective.curveId,
    curveDate: curve?.points.curveDate ?? null,
    interpolation: curve?.build.interpolation ?? null,
    buildId: curve?.build.buildId ?? null,
    settlement,
    settlementRule: effective.settlement === null ? 'T+1 SIFMA' : 'user',
    provIdx: curve?.provIdx ?? -1,
    engine: curve?.build.engine ?? null,
  };

  // ── 4. per-row analytics over the whole filtered set (an analytic sort needs them all) ───────
  let excludedNotPriced = 0;
  let sawNullCoupon = false;
  let sawNullAmount = false;
  const priced = matched.map((security) => {
    // Measured from settlement, not from the valuation date: every priced cell beside it in the
    // row — DISC_RATE, BEY, PX_CLEAN_MID, DUR_ADJ_MID, DV01 — is computed off `pricing.settlement`,
    // and YAS reports the same security's `yearsToMaturity` from settlement too. On a one-day basis
    // mismatch a 14-day bill showed MTY_YEARS 14/365 beside a BEY derived from 13 days, so a reader
    // who recomputed the yield from the column got a different answer and the two screens disagreed
    // about the same security's remaining life (ANAL-09). The `yearsFrom`/`yearsTo` *filter* stays
    // on the valuation date, as §SRCH step 2 specifies for the SQL window.
    const yearsToMaturity = daysBetween(settlement, security.maturityDate) / 365;
    let analytics: Partial<Cells>;
    if (security.securityType === 'tips' || security.securityType === 'frn') {
      analytics = everyAnalytic(notPricedCell);
      excludedNotPriced += 1;
      if (!notes.includes('TIPS_FRN_NOT_PRICED')) notes.push('TIPS_FRN_NOT_PRICED');
      ctx.unavailable.add({
        field: `rows.${security.cusip}.analytics`,
        reason: 'NOT_APPLICABLE',
        detail: SRCH_TIPS_FRN_DETAIL,
      });
    } else if (security.securityType === 'bill') {
      analytics = billCells(ctx, security, env);
    } else {
      analytics = couponCells(ctx, security, env);
    }
    if (security.couponRate === null) sawNullCoupon = true;
    if (security.amountOutstanding === null) sawNullAmount = true;
    const cells = { ...termsCells(security, yearsToMaturity), ...analytics } as Cells;
    return { security, cells, yearsToMaturity };
  });

  // Two row columns are plain numbers rather than cells, and a null in one of them is a statement
  // about the security rather than a gap in the screen. §1.3 rule 6 asks for the statement.
  if (sawNullCoupon) {
    ctx.unavailable.add({
      field: 'rows.couponRate',
      reason: 'NOT_APPLICABLE',
      detail: 'a bill carries no coupon; its discount rate is in the DISC_RATE column',
    });
  }
  if (sawNullAmount) {
    ctx.unavailable.add({
      field: 'rows.amountOutstanding',
      reason: 'NO_SOURCE',
      detail: 'govt_terms.amount_outstanding is not published for every seeded security',
    });
  }

  // ── 5. sort, rank, page ─────────────────────────────────────────────────────────────────────
  const dir = effective.sort.dir === 'asc' ? 1 : -1;
  const withKeys = priced.map((row) => ({
    ...row,
    instrumentId: row.security.instrumentId,
    sortKey: sortKeyOf(row.cells, effective.sort.col),
  }));
  withKeys.sort((a, b) => {
    if (a.sortKey === null && b.sortKey === null) return a.instrumentId - b.instrumentId;
    // Nulls last in BOTH directions: a blank is not the smallest value, it is no value.
    if (a.sortKey === null) return 1;
    if (b.sortKey === null) return -1;
    const cmp = compareKeys(a.sortKey, b.sortKey);
    return cmp === 0 ? a.instrumentId - b.instrumentId : cmp * dir;
  });

  const start = pageStart(ctx, effective, withKeys);
  const pageRows = withKeys.slice(start, start + effective.pageSize);
  const chosen = effective.columns;
  const rows: SrchRow[] = pageRows.map((row, i) => {
    const cells: Record<string, ValueCell> = {};
    for (const id of chosen) cells[id] = row.cells[id];
    return {
      instrumentId: row.security.instrumentId,
      key: row.security.key,
      name: row.security.name,
      cusip: row.security.cusip,
      securityType: row.security.securityType,
      termLabel: row.security.termLabel,
      onTheRun: row.security.onTheRun,
      maturityDate: row.security.maturityDate,
      issueDate: row.security.issueDate,
      couponRate: row.security.couponRate,
      couponFreq: row.security.couponFreq,
      dayCount: row.security.dayCount,
      isCallable: row.security.isCallable,
      amountOutstanding: row.security.amountOutstanding,
      termsProvIdx: row.security.provIdx,
      cells,
      subject: ctx.plant.subjectFor(row.security.instrumentId),
      rank: start + i + 1,
    };
  });

  const last = pageRows.at(-1);
  ctx.page?.set({
    index: start,
    count: withKeys.length,
    cursor:
      last === undefined || start + pageRows.length >= withKeys.length
        ? null
        : encodeCursor(last.sortKey, last.instrumentId),
  });

  // There is no Treasury market-data line in this build, so the screen registers no subjects and
  // no cell carries `live` (§SRCH "Live"). Said once, in `meta`, rather than per cell.
  ctx.unavailable.add({
    field: 'rows.live',
    reason: 'NO_SOURCE',
    detail:
      'no Treasury market-data line: neither Cboe nor Yahoo publishes Treasury security quotes ' +
      '(BRIEF §2)',
  });

  // ── 6. facets and counts, over the filtered set rather than the page ────────────────────────
  const facets = facetsOf(priced.map((row) => ({ security: row.security, years: row.yearsToMaturity })));
  const counts: SrchCounts = {
    universe: securities.length,
    afterFilters: matched.length,
    returned: rows.length,
    excludedNoTerms,
    excludedNotPriced,
  };

  const columns: SrchColumn[] = chosen.map((id) => {
    const def = SRCH_COLUMNS[id];
    return {
      id: def.id,
      label: def.label,
      fmt: def.fmt,
      sortable: true,
      ...(def.decimals === undefined ? {} : { decimals: def.decimals }),
      ...(def.fieldId === undefined ? {} : { fieldId: def.fieldId }),
    };
  });

  return {
    variant: 'default',
    universe: universeBlock,
    filters,
    pricing,
    columns,
    rows,
    counts,
    facets,
    savedSearch,
    notes,
  };
}

/** The three facets, counted over everything that survived the filters (§SRCH step 2). */
function facetsOf(rows: readonly { security: Security; years: number }[]): SrchFacets {
  const types = new Map<string, number>();
  const buckets = new Map<SrchMaturityBucket, number>();
  let otrTrue = 0;
  for (const row of rows) {
    types.set(row.security.securityType, (types.get(row.security.securityType) ?? 0) + 1);
    const bucket = srchMaturityBucket(row.years);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    if (row.security.onTheRun) otrTrue += 1;
  }
  return {
    // Fixed orders, so two runs over the same set produce byte-identical payloads (ANAL-08).
    securityType: ['bill', 'note', 'bond', 'tips', 'frn'].flatMap((value) => {
      const count = types.get(value);
      return count === undefined ? [] : [{ value, count }];
    }),
    maturityBucket: (['0-1Y', '1-3Y', '3-7Y', '7-10Y', '10-20Y', '20Y+'] as const).flatMap(
      (value) => {
        const count = buckets.get(value);
        return count === undefined ? [] : [{ value, count }];
      },
    ),
    onTheRun: [
      { value: 'true' as const, count: otrTrue },
      { value: 'false' as const, count: rows.length - otrTrue },
    ],
  };
}

/** Every column id, for the tests and the screen — re-exported so neither restates the list. */
export const COLUMN_IDS = SRCH_COLUMN_IDS;
