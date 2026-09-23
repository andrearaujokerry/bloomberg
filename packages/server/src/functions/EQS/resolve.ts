/**
 * `functions/EQS/resolve.ts` — the multi-factor screen (FUNCTIONS_TIER2.md §EQS L374-388).
 *
 * ## A missing value is never a passing value
 *
 * This is the whole design. A screen's failure mode is a row that stays in because the factor it
 * should have been judged on was absent, or one that drops out because an absence was read as a
 * zero. Neither happens here: a row whose cell for a criterion's factor is `null` is **excluded and
 * counted** in `criteria[i].noData`, and the counts (`universe → afterFilters → afterCriteria`,
 * plus `excludedNoData`) are on the payload so the screen can say *how many* names it could not
 * judge. A factor with no reachable source at all is worse than a per-row gap, because applying a
 * criterion on it would silently empty the screen — so that criterion is marked
 * `unavailableReason` and is **not applied**, and the column keeps its header with every cell `—`.
 *
 * ## One query per source class, never one per row
 *
 * Six source classes, at most six reads over the whole surviving id set: the plant snapshot (in
 * memory), the `bars_daily` cross-section, the `dei` reference facts, the `short_interest` and
 * `corporate_actions` rows behind `SHORT_INT_RATIO` and `DVD_YIELD`, the `fin_statements`
 * cross-section, and one `xbrl_frames` read per distinct concept. No provider call is made at all
 * (TIER1 §0.4 rule 2): 503 names × a 3.7 MB companyfacts fetch is not a request-path operation, so
 * a universe whose filings have not been ingested is *reported* — `FUNDAMENTALS_NOT_INGESTED`,
 * `FRAME_NOT_INGESTED` — never fetched inline.
 *
 * ## Point in time
 *
 * `knownAt = min(params.knownAt, ctx.asOf.knownAt)` (STOR-06). `fin_statements` is read at that
 * instant on `filed_at`; `xbrl_frames` at that instant on `captured_at`, and a contributing row
 * with `filed_at IS NULL` is not point-in-time at all, which raises `FRAMES_NOT_POINT_IN_TIME`
 * rather than being quietly included as if it were (DATA_MODEL §20 decision 4).
 */

import { sql } from 'drizzle-orm';

import type { AssetClass, MarketSector, ValueCell } from '@terminal/core';
import { canonicalJson, sha256Hex } from '@terminal/core';
import type { MonitorColumn } from '@terminal/core/functions/shared/monitor';
import type {
  EqsCriterion,
  EqsCriterionView,
  EqsFactor,
  EqsFactorSource,
  EqsParams,
  EqsPayload,
  EqsRow,
  EqsUniverse,
  ScreenCriteria as ScreenCriteriaType,
} from '@terminal/core/functions/manifests/EQS';
import {
  EQS_ABSENT_CELL,
  EQS_FACTOR_SOURCE,
  EQS_FRAME_CONCEPT,
  ScreenCriteria,
  criterionLabel,
  eqsColumn,
} from '@terminal/core/functions/manifests/EQS';

import { findIndexByCode } from '../../refdata/indexMembership.js';
import { citeProvenanceIds } from '../MEMB/resolve.js';
import type { ResolveContext } from '../context.js';
import { cellFromState, storedCell } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';
import {
  PERIOD_RETURNS_CONVENTIONS,
  STATS_ENGINE,
  periodReturns,
  type PeriodBar,
} from '../shared/returns.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Notes
// ─────────────────────────────────────────────────────────────────────────────────────────────

const NOTE_FRAMES_NOT_PIT = 'FRAMES_NOT_POINT_IN_TIME';
const NOTE_FUNDAMENTALS_NOT_INGESTED = 'FUNDAMENTALS_NOT_INGESTED';
const NOTE_NO_HISTORY = 'NO_HISTORY';
const NOTE_CRITERION_NOT_APPLIED = 'CRITERION_NOT_APPLIED';

/** Sessions of `bars_daily` loaded for the cross-section — 252 plus a month of slack. */
const BARS_LOOKBACK_SESSIONS = 260;
const BARS_LOOKBACK_DAYS = Math.ceil(BARS_LOOKBACK_SESSIONS * (365 / 252)) + 10;
const DAY_MS = 86_400_000;

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row metadata and the reference filters (§EQS steps 2-3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface MetaSql extends Record<string, unknown> {
  instrument_id: string;
  ticker: string;
  name: string;
  exch_code: string;
  asset_class: string;
  market_sector: string;
  gics_sector: string | null;
  gics_sub_industry: string | null;
  issuer_id: string | null;
  cik: string | null;
  country: string | null;
  calendar_id: string | null;
  mic: string | null;
}

interface RowMeta {
  instrumentId: number;
  key: string;
  name: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  exchCode: string;
  gicsSector: string | null;
  gicsSubIndustry: string | null;
  issuerId: number | null;
  cik: string | null;
  country: string | null;
  calendarId: string | null;
  mic: string | null;
}

/**
 * Everything the grid shows about a name that is not a factor, plus the three filter columns and
 * the venue calendar — one join, whether the universe came from an index, a watchlist or the
 * master.
 */
async function loadMeta(
  ctx: ResolveContext,
  restrictTo: readonly number[] | null,
  assetClass: 'equity' | 'etf' | null,
): Promise<RowMeta[]> {
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  if (restrictTo !== null && restrictTo.length === 0) return [];

  const res = await ctx.db.execute<MetaSql>(sql`
    SELECT ins.instrument_id::text AS instrument_id,
           ins.ticker, ins.name, ins.exch_code,
           ins.asset_class::text   AS asset_class,
           ins.market_sector::text AS market_sector,
           sec.name                AS gics_sector,
           sub.name                AS gics_sub_industry,
           iss.issuer_id::text     AS issuer_id,
           isr.cik                 AS cik,
           iss.country_of_issue    AS country,
           exch.calendar_id        AS calendar_id,
           lst.mic                 AS mic
      FROM instruments ins
      LEFT JOIN issues iss
        ON iss.issue_id = ins.issue_id
       AND bt_as_of(iss.valid_from, iss.valid_to, iss.tx_from, iss.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN issuers isr
        ON isr.issuer_id = iss.issuer_id
       AND bt_as_of(isr.valid_from, isr.valid_to, isr.tx_from, isr.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN LATERAL (
        SELECT ec.code
          FROM entity_classifications ec
         WHERE ec.scheme = 'GICS'
           AND ((ec.entity_kind = 'instrument' AND ec.entity_id = ins.instrument_id)
             OR (ec.entity_kind = 'issuer' AND ec.entity_id = iss.issuer_id))
           AND bt_as_of(ec.valid_from, ec.valid_to, ec.tx_from, ec.tx_to,
                        ${validAt}::timestamptz, ${knownAt}::timestamptz)
         ORDER BY (ec.entity_kind = 'instrument') DESC
         LIMIT 1
      ) gics ON true
      LEFT JOIN classification_codes sec
        ON sec.scheme = 'GICS' AND sec.code = left(gics.code, 2)
      LEFT JOIN classification_codes sub
        ON sub.scheme = 'GICS' AND sub.code = gics.code
      LEFT JOIN listings lst
        ON lst.listing_id = ins.primary_listing_id
       AND bt_as_of(lst.valid_from, lst.valid_to, lst.tx_from, lst.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN exchanges exch ON exch.mic = lst.mic
     WHERE bt_as_of(ins.valid_from, ins.valid_to, ins.tx_from, ins.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
       AND (${restrictTo === null ? null : sql.param(restrictTo.map(String))}::bigint[] IS NULL
            OR ins.instrument_id = ANY(${
              restrictTo === null ? null : sql.param(restrictTo.map(String))
            }::bigint[]))
       AND (${assetClass}::text IS NULL OR ins.asset_class::text = ${assetClass}::text)
       AND (${assetClass}::text IS NULL OR ins.status = 'active')`);

  return res.rows.map((row) => ({
    instrumentId: Number(row.instrument_id),
    key: displayOf(row.ticker, row.exch_code, row.market_sector as MarketSector),
    name: row.name,
    assetClass: row.asset_class as AssetClass,
    marketSector: row.market_sector as MarketSector,
    exchCode: row.exch_code,
    gicsSector: row.gics_sector,
    gicsSubIndustry: row.gics_sub_industry,
    issuerId: row.issuer_id === null ? null : Number(row.issuer_id),
    cik: row.cik,
    country: row.country,
    calendarId: row.calendar_id,
    mic: row.mic,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Factor loading (§EQS step 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Cells = Map<number, Record<string, ValueCell>>;

function put(cells: Cells, instrumentId: number, factor: string, cell: ValueCell): void {
  const row = cells.get(instrumentId) ?? {};
  row[factor] = cell;
  cells.set(instrumentId, row);
}

interface BarSql extends Record<string, unknown> {
  instrument_id: string;
  session_date: string;
  close: string | null;
  high: string | null;
  low: string | null;
  volume: string | null;
  provenance_id: string;
}

async function loadBars(
  ctx: ResolveContext,
  ids: readonly number[],
  from: string,
  to: string,
): Promise<Map<number, { bars: PeriodBar[]; provenanceId: number }>> {
  const out = new Map<number, { bars: PeriodBar[]; provenanceId: number }>();
  if (ids.length === 0) return out;
  const res = await ctx.db.execute<BarSql>(sql`
    SELECT instrument_id::text AS instrument_id,
           to_char(session_date, 'YYYY-MM-DD') AS session_date,
           close::text AS close, high::text AS high, low::text AS low,
           volume::text AS volume, provenance_id::text AS provenance_id
      FROM bars_daily
     WHERE instrument_id = ANY(${sql.param(ids.map(String))}::bigint[])
       AND session_date >= ${from}::date
       AND session_date <= ${to}::date
     ORDER BY instrument_id, session_date`);
  for (const row of res.rows) {
    const id = Number(row.instrument_id);
    const entry = out.get(id) ?? { bars: [], provenanceId: Number(row.provenance_id) };
    entry.bars.push({
      date: row.session_date,
      close: row.close === null ? null : Number(row.close),
      high: row.high === null ? null : Number(row.high),
      low: row.low === null ? null : Number(row.low),
      volume: row.volume === null ? null : Number(row.volume),
    });
    entry.provenanceId = Number(row.provenance_id);
    out.set(id, entry);
  }
  return out;
}

interface DeiSql extends Record<string, unknown> {
  cik: string;
  concept: string;
  value: string;
  provenance_id: string;
  captured_at: string;
}

/** The latest `dei` share count and public float per CIK, point-in-time on `filed_at`. */
async function loadDeiFacts(
  ctx: ResolveContext,
  ciks: readonly string[],
  knownAt: Date,
): Promise<Map<string, Map<string, { value: number; provenanceId: number; capturedAt: string }>>> {
  const out = new Map<string, Map<string, { value: number; provenanceId: number; capturedAt: string }>>();
  if (ciks.length === 0) return out;
  const res = await ctx.db.execute<DeiSql>(sql`
    SELECT DISTINCT ON (f.cik, f.concept)
           f.cik, f.concept, f.value::text AS value, f.provenance_id::text AS provenance_id,
           to_char(f.captured_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at
      FROM xbrl_facts f
     WHERE f.cik = ANY(${sql.param([...ciks])}::char(10)[])
       AND f.taxonomy = 'dei'
       AND f.concept IN ('EntityCommonStockSharesOutstanding', 'EntityPublicFloat')
       AND f.filed_at <= ${isoDate(knownAt)}::date
     ORDER BY f.cik, f.concept, f.period_end DESC, f.filed_at DESC`);
  for (const row of res.rows) {
    const byConcept =
      out.get(row.cik) ??
      new Map<string, { value: number; provenanceId: number; capturedAt: string }>();
    byConcept.set(row.concept, {
      value: Number(row.value),
      provenanceId: Number(row.provenance_id),
      capturedAt: row.captured_at,
    });
    out.set(row.cik, byConcept);
  }
  return out;
}

interface ShortSql extends Record<string, unknown> {
  instrument_id: string;
  days_to_cover: string | null;
  provenance_id: string;
}

async function loadShortInterest(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, { daysToCover: number; provenanceId: number }>> {
  const out = new Map<number, { daysToCover: number; provenanceId: number }>();
  if (ids.length === 0) return out;
  const res = await ctx.db.execute<ShortSql>(sql`
    SELECT DISTINCT ON (instrument_id)
           instrument_id::text AS instrument_id, days_to_cover::text AS days_to_cover,
           provenance_id::text AS provenance_id
      FROM short_interest
     WHERE instrument_id = ANY(${sql.param(ids.map(String))}::bigint[])
       AND settlement_date <= ${isoDate(ctx.asOf.validAt)}::date
     ORDER BY instrument_id, settlement_date DESC`);
  for (const row of res.rows) {
    if (row.days_to_cover === null) continue;
    out.set(Number(row.instrument_id), {
      daysToCover: Number(row.days_to_cover),
      provenanceId: Number(row.provenance_id),
    });
  }
  return out;
}

interface DvdSql extends Record<string, unknown> {
  instrument_id: string;
  total: string;
  provenance_id: string;
}

/** `DVD_SH_12M` per instrument — the trailing-365-day cash and special dividends (TIER1 §0.3). */
async function loadTrailingDividends(
  ctx: ResolveContext,
  ids: readonly number[],
  knownAt: Date,
): Promise<Map<number, { total: number; provenanceId: number }>> {
  const out = new Map<number, { total: number; provenanceId: number }>();
  if (ids.length === 0) return out;
  const validAt = ctx.asOf.validAt;
  const res = await ctx.db.execute<DvdSql>(sql`
    SELECT ca.instrument_id::text AS instrument_id,
           sum(ca.amount)::text   AS total,
           max(ca.provenance_id)::text AS provenance_id
      FROM corporate_actions ca
     WHERE ca.instrument_id = ANY(${sql.param(ids.map(String))}::bigint[])
       AND ca.ca_type IN ('cash_dividend', 'special_dividend')
       AND ca.status IN ('announced', 'confirmed', 'paid')
       AND ca.ex_date > ${isoDate(new Date(validAt.getTime() - 365 * DAY_MS))}::date
       AND ca.ex_date <= ${isoDate(validAt)}::date
       AND ca.amount IS NOT NULL
       AND bt_as_of(ca.valid_from, ca.valid_to, ca.tx_from, ca.tx_to,
                    ${validAt.toISOString()}::timestamptz, ${knownAt.toISOString()}::timestamptz)
     GROUP BY ca.instrument_id`);
  for (const row of res.rows) {
    out.set(Number(row.instrument_id), {
      total: Number(row.total),
      provenanceId: Number(row.provenance_id),
    });
  }
  return out;
}

interface StatementSql extends Record<string, unknown> {
  issuer_id: string;
  period_type: string;
  period_end: string;
  revenue: string | null;
  gross_profit: string | null;
  oper_inc: string | null;
  net_inc: string | null;
  eps_dil: string | null;
  fcf: string | null;
  equity: string | null;
  lt_debt: string | null;
  cash: string | null;
  dda: string | null;
  provenance_ids: string[];
}

interface Statement {
  periodType: string;
  periodEnd: string;
  revenue: number | null;
  grossProfit: number | null;
  operInc: number | null;
  netInc: number | null;
  epsDil: number | null;
  fcf: number | null;
  equity: number | null;
  ltDebt: number | null;
  cash: number | null;
  dda: number | null;
  provenanceId: number | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/**
 * The newest `TTM` row per issuer at `knownAt`, with `FY` as the fallback, plus the `FY` row one
 * year earlier for `SALES_GROWTH_YOY`.
 */
async function loadStatements(
  ctx: ResolveContext,
  issuerIds: readonly number[],
  knownAt: Date,
): Promise<Map<number, Statement[]>> {
  const out = new Map<number, Statement[]>();
  if (issuerIds.length === 0) return out;
  const res = await ctx.db.execute<StatementSql>(sql`
    SELECT DISTINCT ON (s.issuer_id, s.period_type, s.period_end)
           s.issuer_id::text AS issuer_id, s.period_type,
           to_char(s.period_end, 'YYYY-MM-DD') AS period_end,
           s.revenue::text AS revenue, s.gross_profit::text AS gross_profit,
           s.oper_inc::text AS oper_inc, s.net_inc::text AS net_inc,
           s.eps_dil::text AS eps_dil, s.fcf::text AS fcf, s.equity::text AS equity,
           s.lt_debt::text AS lt_debt, s.cash::text AS cash, s.dda::text AS dda,
           s.provenance_ids
      FROM fin_statements s
     WHERE s.issuer_id = ANY(${sql.param(issuerIds.map(String))}::bigint[])
       AND s.period_type IN ('TTM', 'FY')
       AND s.filed_at <= ${isoDate(knownAt)}::date
     ORDER BY s.issuer_id, s.period_type, s.period_end DESC, s.filed_at DESC`);
  for (const row of res.rows) {
    const id = Number(row.issuer_id);
    const list = out.get(id) ?? [];
    list.push({
      periodType: row.period_type,
      periodEnd: row.period_end,
      revenue: num(row.revenue),
      grossProfit: num(row.gross_profit),
      operInc: num(row.oper_inc),
      netInc: num(row.net_inc),
      epsDil: num(row.eps_dil),
      fcf: num(row.fcf),
      equity: num(row.equity),
      ltDebt: num(row.lt_debt),
      cash: num(row.cash),
      dda: num(row.dda),
      provenanceId: row.provenance_ids[0] === undefined ? null : Number(row.provenance_ids[0]),
    });
    out.set(id, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
  }
  return out;
}

interface FrameSql extends Record<string, unknown> {
  cik: string;
  frame: string;
  value: string;
  filed_at: string | null;
  provenance_id: string;
  captured_at: string;
}

/** The newest ingested frame for one concept at `knownAt`, and every CIK's value in it. */
async function loadFrame(
  ctx: ResolveContext,
  concept: string,
  unit: string,
  kind: 'instant' | 'duration',
  knownAt: Date,
): Promise<{ frame: string; rows: Map<string, FrameSql> } | null> {
  const [taxonomy, bare] = concept.split(':');
  const res = await ctx.db.execute<FrameSql>(sql`
    SELECT f.cik, f.frame, f.value::text AS value,
           to_char(f.filed_at, 'YYYY-MM-DD') AS filed_at,
           f.provenance_id::text AS provenance_id,
           to_char(f.captured_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at
      FROM xbrl_frames f
     WHERE f.taxonomy = ${taxonomy ?? ''}
       AND f.concept = ${bare ?? concept}
       AND f.unit = ${unit}
       AND f.frame LIKE ${kind === 'instant' ? '%I' : 'CY%Q_'}
       AND (${kind === 'instant'} OR f.frame NOT LIKE '%I')
       AND f.captured_at <= ${knownAt.toISOString()}::timestamptz
       AND (f.filed_at IS NULL OR f.filed_at <= ${isoDate(knownAt)}::date)
       AND f.frame = (
         SELECT g.frame FROM xbrl_frames g
          WHERE g.taxonomy = ${taxonomy ?? ''} AND g.concept = ${bare ?? concept}
            AND g.unit = ${unit}
            AND g.frame LIKE ${kind === 'instant' ? '%I' : 'CY%Q_'}
            AND (${kind === 'instant'} OR g.frame NOT LIKE '%I')
            AND g.captured_at <= ${knownAt.toISOString()}::timestamptz
          ORDER BY g.frame DESC LIMIT 1)`);
  const first = res.rows[0];
  if (first === undefined) return null;
  const rows = new Map<string, FrameSql>();
  for (const row of res.rows) rows.set(row.cik, row);
  return { frame: first.frame, rows };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Criteria (§EQS step 5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function passes(criterion: EqsCriterion, value: number): boolean {
  const { value: a, value2: b } = criterion;
  switch (criterion.op) {
    case 'gt':
      return a !== null && value > a;
    case 'gte':
      return a !== null && value >= a;
    case 'lt':
      return a !== null && value < a;
    case 'lte':
      return a !== null && value <= a;
    case 'eq':
      return a !== null && value === a;
    case 'ne':
      return a !== null && value !== a;
    case 'between':
      return a !== null && b !== null && value >= a && value <= b;
    default:
      return true; // top / bottom are a rank cut, applied after the comparison filters
  }
}

function numberOf(cell: ValueCell | undefined): number | null {
  const v = cell?.v;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: EqsParams): Promise<EqsPayload> {
  const notes: string[] = [];

  // 1 — point in time, and the saved screen.
  const knownAt =
    params.knownAt === undefined
      ? ctx.asOf.knownAt
      : new Date(Math.min(Date.parse(params.knownAt), ctx.asOf.knownAt.getTime()));

  let effective: ScreenCriteriaType = ScreenCriteria.parse(params);
  let savedSearch: EqsPayload['savedSearch'] = null;
  if (params.savedSearchId !== undefined) {
    const saved = await loadSavedSearch(ctx, params.savedSearchId);
    if (saved === null) {
      ctx.unavailable.add({
        field: 'savedSearch',
        reason: 'NO_SOURCE',
        detail: 'saved screen not found or not owned by this user',
      });
    } else {
      // Explicit params win over the saved ones: the saved screen is the floor, not the ceiling.
      effective = ScreenCriteria.parse({ ...saved.query, ...stripDefaults(params) });
      savedSearch = { searchId: saved.searchId, name: saved.name };
    }
  }

  // 2 — the universe.
  const universe = await loadUniverse(ctx, effective);
  const meta = await loadMeta(
    ctx,
    universe.ids,
    effective.universe === 'EQUITY' ? 'equity' : effective.universe === 'ETF' ? 'etf' : null,
  );
  const universeCount = effective.universe === 'INDEX' || effective.universe === 'WATCHLIST'
    ? universe.ids?.length ?? meta.length
    : meta.length;

  // 3 — the reference filters.
  const filtered = meta.filter(
    (row) =>
      (effective.sector === null || row.gicsSector === effective.sector) &&
      (effective.exchange === null || row.exchCode === effective.exchange) &&
      (effective.country === null || row.country === effective.country),
  );

  const ids = filtered.map((r) => r.instrumentId);
  const columns: MonitorColumn[] = effective.columns.map(eqsColumn);
  const wanted = new Set<EqsFactor>([
    ...effective.columns,
    ...effective.criteria.map((c) => c.factor),
    ...(effective.sort.col in EQS_FACTOR_SOURCE ? [effective.sort.col as EqsFactor] : []),
  ]);
  const classes = new Set<EqsFactorSource>([...wanted].map((f) => EQS_FACTOR_SOURCE[f]));

  const cells: Cells = new Map();
  const unavailableFactors = new Map<EqsFactor, string>();

  // 4a — quote.
  const subjects = ids.map((id) => ctx.plant.subjectFor(id));
  if (classes.has('quote') || classes.has('reference') || classes.has('actions') || classes.has('statements')) {
    ctx.plant.ensureHot(subjects);
  }
  const states = ctx.plant.snapshotMany(subjects);
  const pxOf = new Map<number, number | null>();
  for (const row of filtered) {
    const subject = ctx.plant.subjectFor(row.instrumentId);
    const state = states.get(subject);
    const px = cellFromState(ctx, state, 'PX_LAST', subject);
    pxOf.set(row.instrumentId, numberOf(px));
    if (wanted.has('PX_LAST')) put(cells, row.instrumentId, 'PX_LAST', px);
    if (wanted.has('CHG_PCT_1D')) {
      put(cells, row.instrumentId, 'CHG_PCT_1D', cellFromState(ctx, state, 'CHG_PCT_1D', subject));
    }
    if (wanted.has('PX_VOLUME')) {
      put(cells, row.instrumentId, 'PX_VOLUME', cellFromState(ctx, state, 'PX_VOLUME', subject));
    }
  }

  // 4b — bars.
  if (classes.has('bars')) {
    await loadBarFactors(ctx, filtered, wanted, cells, notes);
  }

  // 4c — reference and actions.
  if (classes.has('reference') || classes.has('actions')) {
    await loadReferenceFactors(ctx, filtered, wanted, cells, pxOf, universe.weights, knownAt);
  }

  // 4d — statements.
  if (classes.has('statements')) {
    await loadStatementFactors(ctx, filtered, wanted, cells, pxOf, knownAt, notes, unavailableFactors);
  }

  // 4e — frames.
  let frame: string | null = null;
  if (classes.has('frames')) {
    frame = await loadFrameFactors(ctx, filtered, wanted, cells, knownAt, notes, unavailableFactors);
  }

  // Fill every requested column that produced no cell for a row with the stated absence.
  for (const row of filtered) {
    const bucket = cells.get(row.instrumentId) ?? {};
    for (const factor of wanted) {
      bucket[factor] ??= { ...EQS_ABSENT_CELL };
    }
    cells.set(row.instrumentId, bucket);
  }

  // 5 — the criteria, in array order.
  let surviving = filtered;
  const criteriaView: EqsCriterionView[] = [];
  let excludedNoData = 0;
  for (const criterion of effective.criteria) {
    const reason = unavailableFactors.get(criterion.factor) ?? null;
    if (reason !== null) {
      if (!notes.includes(NOTE_CRITERION_NOT_APPLIED)) notes.push(NOTE_CRITERION_NOT_APPLIED);
      criteriaView.push({
        factor: criterion.factor,
        op: criterion.op,
        value: criterion.value,
        value2: criterion.value2,
        label: criterionLabel(criterion),
        source: EQS_FACTOR_SOURCE[criterion.factor],
        passed: surviving.length,
        noData: 0,
        unavailableReason: reason,
      });
      continue;
    }

    let noData = 0;
    const kept: RowMeta[] = [];
    for (const row of surviving) {
      const value = numberOf(cells.get(row.instrumentId)?.[criterion.factor]);
      if (value === null) {
        noData += 1;
        continue;
      }
      if (passes(criterion, value)) kept.push(row);
    }

    let next = kept;
    if (criterion.op === 'top' || criterion.op === 'bottom') {
      const n = Math.max(0, Math.trunc(criterion.value ?? 0));
      next = [...kept]
        .sort((a, b) => {
          const av = numberOf(cells.get(a.instrumentId)?.[criterion.factor]) ?? 0;
          const bv = numberOf(cells.get(b.instrumentId)?.[criterion.factor]) ?? 0;
          return criterion.op === 'top' ? bv - av : av - bv;
        })
        .slice(0, n);
    }

    excludedNoData += noData;
    criteriaView.push({
      factor: criterion.factor,
      op: criterion.op,
      value: criterion.value,
      value2: criterion.value2,
      label: criterionLabel(criterion),
      source: EQS_FACTOR_SOURCE[criterion.factor],
      passed: next.length,
      noData,
      unavailableReason: null,
    });
    surviving = next;
  }

  // 6 — sort, rank and page. `nulls last` in both directions; instrument id breaks the tie.
  const sortCol = effective.sort.col;
  const dir = effective.sort.dir === 'asc' ? 1 : -1;
  const sorted = [...surviving].sort((a, b) => {
    const av = numberOf(cells.get(a.instrumentId)?.[sortCol]);
    const bv = numberOf(cells.get(b.instrumentId)?.[sortCol]);
    if (av === null && bv === null) return a.instrumentId - b.instrumentId;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return (av - bv) * dir;
    return a.instrumentId - b.instrumentId;
  });

  const start = pageStart(ctx, params, sorted, cells, sortCol);
  const pageRows = sorted.slice(start, start + params.pageSize);
  const rows: EqsRow[] = pageRows.map((row, i) => ({
    instrumentId: row.instrumentId,
    key: row.key,
    name: row.name,
    assetClass: row.assetClass,
    marketSector: row.marketSector,
    exchCode: row.exchCode,
    gicsSector: row.gicsSector,
    subject: ctx.plant.subjectFor(row.instrumentId),
    cells: pick(cells.get(row.instrumentId) ?? {}, effective.columns),
    rank: start + i + 1,
    gicsSubIndustry: row.gicsSubIndustry,
    issuerId: row.issuerId,
    cik: row.cik,
  }));

  ctx.page?.set({
    index: start,
    count: sorted.length,
    cursor:
      start + pageRows.length >= sorted.length
        ? null
        : encodeCursor(pageRows.at(-1), cells, sortCol),
  });

  return {
    variant: 'default',
    universe: { ...universe.block, size: universeCount },
    filters: {
      sector: effective.sector,
      exchange: effective.exchange,
      country: effective.country,
    },
    criteria: criteriaView,
    columns,
    rows,
    counts: {
      universe: universeCount,
      afterFilters: filtered.length,
      afterCriteria: sorted.length,
      returned: rows.length,
      excludedNoData: excludedNoData + universe.skipped,
    },
    knownAt: knownAt.toISOString(),
    frame,
    savedSearch,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Universe
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface UniverseResult {
  block: Omit<EqsUniverse, 'size'>;
  /** `null` = the whole master (EQUITY / ETF); otherwise the ids to restrict to. */
  ids: number[] | null;
  weights: Map<number, { weight: number; provIdx: number }>;
  /** Watchlist formula rows, counted rather than rendered. */
  skipped: number;
}

async function loadUniverse(
  ctx: ResolveContext,
  criteria: ScreenCriteriaType,
): Promise<UniverseResult> {
  const weights = new Map<number, { weight: number; provIdx: number }>();

  if (criteria.universe === 'INDEX') {
    const index = await findIndexByCode(ctx.db, criteria.index);
    if (index?.membershipSourceId == null) {
      ctx.unavailable.add({
        field: 'universe',
        reason: 'NO_SOURCE',
        detail:
          `no membership source for ${criteria.index} ` +
          '(indices.membership_source_id is null)',
      });
      return {
        block: {
          kind: 'INDEX',
          label: `${criteria.index} Index members`,
          indexInstrumentId: null,
          watchlistId: null,
          asOfDate: null,
          provIdx: -1,
        },
        ids: [],
        weights,
        skipped: 0,
      };
    }
    const roster = await ctx.data.reference.members(index.instrumentId);
    // See `functions/MEMB/resolve.ts#citeProvenanceIds`: a reader's `provIdx` indexes the data
    // services' own provenance array, not the payload's, so the membership file is re-cited here.
    const rosterProv = await citeProvenanceIds(ctx, roster.members.map((m) => m.provenanceId));
    for (const member of roster.members) {
      if (member.weight === null) continue;
      weights.set(member.instrumentId, {
        weight: member.weight,
        provIdx: rosterProv.get(member.provenanceId) ?? -1,
      });
    }
    const firstMember = roster.members[0];
    return {
      block: {
        kind: 'INDEX',
        label: `${index.code} Index members (${roster.asOfDate})`,
        indexInstrumentId: index.instrumentId,
        watchlistId: null,
        asOfDate: roster.asOfDate,
        provIdx:
          firstMember === undefined ? -1 : (rosterProv.get(firstMember.provenanceId) ?? -1),
      },
      ids: roster.members.map((m) => m.instrumentId),
      weights,
      skipped: 0,
    };
  }

  if (criteria.universe === 'WATCHLIST') {
    const watchlistId = criteria.watchlistId;
    if (watchlistId === null) {
      ctx.unavailable.add({
        field: 'universe',
        reason: 'NOT_APPLICABLE',
        detail: 'universe WATCHLIST needs a watchlist: WL=<name or id>',
      });
      return {
        block: {
          kind: 'WATCHLIST',
          label: 'Watchlist',
          indexInstrumentId: null,
          watchlistId: null,
          asOfDate: null,
          provIdx: -1,
        },
        ids: [],
        weights,
        skipped: 0,
      };
    }
    // `DataServices.workspace` is not wired in this build, so the items are read directly.
    const res = await ctx.db.execute<{ instrument_id: string | null; formula: string | null; name: string }>(sql`
      SELECT i.instrument_id::text AS instrument_id, i.formula, w.name
        FROM watchlist_items i
        JOIN watchlists w ON w.watchlist_id = i.watchlist_id
       WHERE i.watchlist_id = ${watchlistId}::bigint
       ORDER BY i.position`);
    const ids: number[] = [];
    let skipped = 0;
    for (const row of res.rows) {
      if (row.instrument_id !== null) ids.push(Number(row.instrument_id));
      else skipped += 1;
    }
    return {
      block: {
        kind: 'WATCHLIST',
        label: `${res.rows[0]?.name ?? 'Watchlist'} (${String(ids.length)} names)`,
        indexInstrumentId: null,
        watchlistId,
        asOfDate: null,
        provIdx: -1,
      },
      ids,
      weights,
      skipped,
    };
  }

  return {
    block: {
      kind: criteria.universe,
      label: criteria.universe === 'ETF' ? 'Listed ETFs' : 'Listed equities',
      indexInstrumentId: null,
      watchlistId: null,
      asOfDate: null,
      provIdx: -1,
    },
    ids: null,
    weights,
    skipped: 0,
  };
}

interface SavedSearchRow extends Record<string, unknown> {
  search_id: string;
  name: string;
  query: unknown;
}

async function loadSavedSearch(
  ctx: ResolveContext,
  searchId: number,
): Promise<{ searchId: number; name: string; query: ScreenCriteriaType } | null> {
  const res = await ctx.db.execute<SavedSearchRow>(sql`
    SELECT search_id::text AS search_id, name, query
      FROM saved_searches
     WHERE search_id = ${searchId}::bigint
       AND kind = 'eqs'
       AND owner_user_id = ${ctx.user.userId}::bigint
     LIMIT 1`);
  const row = res.rows[0];
  if (row === undefined) return null;
  const parsed = ScreenCriteria.safeParse(row.query);
  if (!parsed.success) return null;
  return { searchId: Number(row.search_id), name: row.name, query: parsed.data };
}

/**
 * The params the caller actually typed, so a saved screen's values are not overwritten by the zod
 * defaults of the keys they left alone.
 */
function stripDefaults(params: EqsParams): Partial<ScreenCriteriaType> {
  const out: Partial<ScreenCriteriaType> = {};
  if (params.sector !== null) out.sector = params.sector;
  if (params.exchange !== null) out.exchange = params.exchange;
  if (params.country !== null) out.country = params.country;
  if (params.watchlistId !== null) out.watchlistId = params.watchlistId;
  if (params.criteria.length > 0) out.criteria = params.criteria;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Factor loaders
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function loadBarFactors(
  ctx: ResolveContext,
  rows: readonly RowMeta[],
  wanted: ReadonlySet<EqsFactor>,
  cells: Cells,
  notes: string[],
): Promise<void> {
  const asOfDate = isoDate(ctx.asOf.validAt);
  const from = isoDate(new Date(ctx.asOf.validAt.getTime() - BARS_LOOKBACK_DAYS * DAY_MS));
  const bars = await loadBars(ctx, rows.map((r) => r.instrumentId), from, asOfDate);

  const calendars = new Map<string, Awaited<ReturnType<typeof ctx.data.reference.calendar>> | null>();
  const load = async (id: string | null): Promise<Awaited<ReturnType<typeof ctx.data.reference.calendar>> | null> => {
    if (id === null) return null;
    if (calendars.has(id)) return calendars.get(id) ?? null;
    try {
      const calendar = await ctx.data.reference.calendar(id);
      calendars.set(id, calendar);
      return calendar;
    } catch {
      calendars.set(id, null);
      return null;
    }
  };

  let noHistory = 0;
  for (const row of rows) {
    const entry = bars.get(row.instrumentId);
    const series = entry?.bars ?? [];
    if (series.length < 2) noHistory += 1;
    const calendar = await load(row.calendarId);
    const result = periodReturns(series, calendar, asOfDate, row.mic ?? 'this venue');
    const provIdx =
      entry === undefined
        ? -1
        : ctx.prov.add({
            sourceId: 'yahoo.chart',
            provenanceId: entry.provenanceId,
            capturedAt: ctx.asOf.knownAt,
            sourceTs: null,
            st: 'closed',
            tier: 'eod',
          });

    const values: [EqsFactor, number | null][] = [
      ['RET_1D', result.ret1d],
      ['RET_1W', result.ret1w],
      ['RET_1M', result.ret1m],
      ['RET_YTD', result.retYtd],
      ['RET_1Y', result.ret1y],
      ['PX_HIGH_52W', result.high52w],
      ['PX_LOW_52W', result.low52w],
      ['VOLUME_AVG_30D', result.avgVolume30d],
      ['VOL_30D', result.vol30d],
    ];
    for (const [factor, value] of values) {
      if (!wanted.has(factor)) continue;
      put(
        cells,
        row.instrumentId,
        factor,
        value === null ? { ...EQS_ABSENT_CELL } : storedCell({ v: value, provIdx }),
      );
    }
    // `RET_3M` and `BETA_1Y` have no `periodReturns` output in this build; they are stated absent
    // rather than approximated from a neighbouring window.
    for (const factor of ['RET_3M', 'BETA_1Y'] as EqsFactor[]) {
      if (wanted.has(factor)) put(cells, row.instrumentId, factor, { ...EQS_ABSENT_CELL });
    }
  }

  if (noHistory > 0) {
    notes.push(NOTE_NO_HISTORY);
    for (const factor of wanted) {
      if (EQS_FACTOR_SOURCE[factor] !== 'bars') continue;
      ctx.unavailable.add({
        field: factor,
        reason: 'NO_SOURCE',
        detail: `${NOTE_NO_HISTORY}: fewer than 2 daily bars for ${String(noHistory)} instruments`,
      });
    }
  }
  for (const factor of ['RET_3M', 'BETA_1Y'] as EqsFactor[]) {
    if (!wanted.has(factor)) continue;
    ctx.unavailable.add({
      field: factor,
      reason: 'NO_SOURCE',
      detail:
        `${factor} is not produced by server/src/functions/shared/returns.ts#periodReturns in ` +
        'this build, and is never approximated from an adjacent window',
    });
  }

  ctx.engines.add({
    name: STATS_ENGINE.name,
    version: STATS_ENGINE.version,
    inputsHash: sha256Hex(
      canonicalJson({
        instrumentIds: rows.map((r) => r.instrumentId),
        asOfDate,
        conventions: PERIOD_RETURNS_CONVENTIONS,
      }),
    ),
  });
}

async function loadReferenceFactors(
  ctx: ResolveContext,
  rows: readonly RowMeta[],
  wanted: ReadonlySet<EqsFactor>,
  cells: Cells,
  pxOf: ReadonlyMap<number, number | null>,
  weights: ReadonlyMap<number, { weight: number; provIdx: number }>,
  knownAt: Date,
): Promise<void> {
  const ciks = [...new Set(rows.map((r) => r.cik).filter((c): c is string => c !== null))];
  const dei = await loadDeiFacts(ctx, ciks, knownAt);
  const shorts = wanted.has('SHORT_INT_RATIO')
    ? await loadShortInterest(ctx, rows.map((r) => r.instrumentId))
    : new Map<number, { daysToCover: number; provenanceId: number }>();
  const dividends = wanted.has('DVD_YIELD')
    ? await loadTrailingDividends(ctx, rows.map((r) => r.instrumentId), knownAt)
    : new Map<number, { total: number; provenanceId: number }>();

  let missingFloat = 0;
  for (const row of rows) {
    const facts = row.cik === null ? undefined : dei.get(row.cik);
    const shares = facts?.get('EntityCommonStockSharesOutstanding');
    const float = facts?.get('EntityPublicFloat');
    const px = pxOf.get(row.instrumentId) ?? null;
    if (float === undefined) missingFloat += 1;

    const citeFact = (fact: { provenanceId: number; capturedAt: string }): number =>
      ctx.prov.add({
        sourceId: 'sec.companyfacts',
        provenanceId: fact.provenanceId,
        capturedAt: new Date(fact.capturedAt),
        sourceTs: null,
        st: 'closed',
        tier: 'eod',
      });

    if (wanted.has('EQY_SH_OUT')) {
      put(
        cells,
        row.instrumentId,
        'EQY_SH_OUT',
        shares === undefined
          ? { ...EQS_ABSENT_CELL }
          : storedCell({ v: shares.value, provIdx: citeFact(shares) }),
      );
    }
    if (wanted.has('PUBLIC_FLOAT')) {
      put(
        cells,
        row.instrumentId,
        'PUBLIC_FLOAT',
        float === undefined
          ? { ...EQS_ABSENT_CELL }
          : storedCell({ v: float.value, provIdx: citeFact(float) }),
      );
    }
    if (wanted.has('EQY_FLOAT_PCT')) {
      const value =
        float === undefined || shares === undefined || shares.value <= 0
          ? null
          : float.value / shares.value;
      put(
        cells,
        row.instrumentId,
        'EQY_FLOAT_PCT',
        value === null ? { ...EQS_ABSENT_CELL } : storedCell({ v: value, provIdx: citeFact(float!) }),
      );
    }
    if (wanted.has('CUR_MKT_CAP')) {
      const value = px === null || shares === undefined ? null : px * shares.value;
      put(
        cells,
        row.instrumentId,
        'CUR_MKT_CAP',
        value === null
          ? { ...EQS_ABSENT_CELL }
          : storedCell({ v: value, provIdx: citeFact(shares!) }),
      );
    }
    if (wanted.has('SHORT_INT_RATIO')) {
      const si = shorts.get(row.instrumentId);
      put(
        cells,
        row.instrumentId,
        'SHORT_INT_RATIO',
        si === undefined
          ? { ...EQS_ABSENT_CELL }
          : storedCell({
              v: si.daysToCover,
              provIdx: ctx.prov.add({
                sourceId: 'finra.shortInterest',
                provenanceId: si.provenanceId,
                capturedAt: ctx.asOf.knownAt,
                sourceTs: null,
                st: 'closed',
                tier: 'eod',
              }),
            }),
      );
    }
    if (wanted.has('IDX_MEMBER_WEIGHT')) {
      const w = weights.get(row.instrumentId);
      put(
        cells,
        row.instrumentId,
        'IDX_MEMBER_WEIGHT',
        w === undefined
          ? { ...EQS_ABSENT_CELL }
          : storedCell({ v: w.weight, provIdx: w.provIdx }),
      );
    }
    if (wanted.has('DVD_YIELD')) {
      const dvd = dividends.get(row.instrumentId);
      const value = dvd === undefined || px === null || px === 0 ? null : (dvd.total / px) * 100;
      put(
        cells,
        row.instrumentId,
        'DVD_YIELD',
        value === null || dvd === undefined
          ? { ...EQS_ABSENT_CELL }
          : storedCell({
              v: value,
              provIdx: ctx.prov.add({
                sourceId: 'yahoo.chart',
                provenanceId: dvd.provenanceId,
                capturedAt: ctx.asOf.knownAt,
                sourceTs: null,
                st: 'closed',
                tier: 'eod',
              }),
            }),
      );
    }
  }

  if ((wanted.has('PUBLIC_FLOAT') || wanted.has('EQY_FLOAT_PCT')) && missingFloat > 0) {
    ctx.unavailable.add({
      field: 'PUBLIC_FLOAT',
      reason: 'NO_SOURCE',
      detail:
        'no free-float source in the wedge; dei:EntityPublicFloat is filed annually and only by ' +
        'some registrants',
    });
  }

  // Every remaining reference gap gets its own sentence. A market capitalisation that is blank
  // because the plant has not been polled is a different fact from one that is blank because the
  // share count was never filed, and a screen that showed both as `—` with no reason would leave
  // a reader guessing which.
  const REFERENCE_DETAIL: Readonly<Record<string, string>> = {
    EQY_SH_OUT:
      'dei:EntityCommonStockSharesOutstanding has not been ingested for these filers; open FA on ' +
      'a name to ingest it',
    EQY_FLOAT_PCT: 'free float needs both dei:EntityPublicFloat and the share count',
    CUR_MKT_CAP:
      'market capitalisation needs a last price and a share count; one of them is absent — a ' +
      'quote the plant has not polled yet fills in over the WebSocket',
    SHORT_INT_RATIO: 'no FINRA short-interest settlement on or before this date for these names',
    IDX_MEMBER_WEIGHT: 'the membership file carries no weight for these constituents',
    DVD_YIELD:
      'a trailing-twelve-month dividend and a last price are both needed; one of them is absent',
  };
  for (const factor of wanted) {
    const source = EQS_FACTOR_SOURCE[factor];
    if (source !== 'reference' && source !== 'actions') continue;
    if (factor === 'PUBLIC_FLOAT') continue;
    const missing = rows.filter(
      (row) => numberOf(cells.get(row.instrumentId)?.[factor]) === null,
    ).length;
    if (missing === 0) continue;
    ctx.unavailable.add({
      field: factor,
      reason: 'NO_SOURCE',
      detail:
        `${String(missing)} of ${String(rows.length)} names have no ${factor}: ` +
        `${REFERENCE_DETAIL[factor] ?? 'no reachable source'}`,
    });
  }
}

async function loadStatementFactors(
  ctx: ResolveContext,
  rows: readonly RowMeta[],
  wanted: ReadonlySet<EqsFactor>,
  cells: Cells,
  pxOf: ReadonlyMap<number, number | null>,
  knownAt: Date,
  notes: string[],
  unavailableFactors: Map<EqsFactor, string>,
): Promise<void> {
  const issuerIds = [...new Set(rows.map((r) => r.issuerId).filter((id): id is number => id !== null))];
  const statements = await loadStatements(ctx, issuerIds, knownAt);

  let withStatements = 0;
  for (const row of rows) {
    const list = row.issuerId === null ? undefined : statements.get(row.issuerId);
    const current = list?.find((s) => s.periodType === 'TTM') ?? list?.find((s) => s.periodType === 'FY');
    if (current !== undefined) withStatements += 1;
    const priorYear =
      current === undefined
        ? undefined
        : list?.find(
            (s) =>
              s.periodType === current.periodType &&
              s.periodEnd < current.periodEnd &&
              Date.parse(current.periodEnd) - Date.parse(s.periodEnd) > 300 * DAY_MS,
          );

    const provIdx =
      current?.provenanceId == null
        ? -1
        : ctx.prov.add({
            sourceId: 'sec.companyfacts',
            provenanceId: current.provenanceId,
            capturedAt: ctx.asOf.knownAt,
            sourceTs: null,
            st: 'closed',
            tier: 'eod',
          });

    const px = pxOf.get(row.instrumentId) ?? null;
    const mktCap = numberOf(cells.get(row.instrumentId)?.CUR_MKT_CAP);

    const ratio = (numerator: number | null, denominator: number | null): number | null =>
      numerator === null || denominator === null || denominator <= 0 ? null : numerator / denominator;

    const values: [EqsFactor, number | null][] = [
      ['SALES_REV_TURN', current?.revenue ?? null],
      ['GROSS_PROFIT', current?.grossProfit ?? null],
      ['IS_OPER_INC', current?.operInc ?? null],
      ['NET_INCOME', current?.netInc ?? null],
      ['IS_EPS_DIL', current?.epsDil ?? null],
      ['FREE_CASH_FLOW', current?.fcf ?? null],
      ['NET_MARGIN', ratio(current?.netInc ?? null, current?.revenue ?? null)],
      [
        'SALES_GROWTH_YOY',
        current?.revenue == null || priorYear?.revenue == null || priorYear.revenue <= 0
          ? null
          : current.revenue / priorYear.revenue - 1,
      ],
      ['RETURN_COM_EQY', ratio(current?.netInc ?? null, current?.equity ?? null)],
      ['PE_RATIO', ratio(px, current?.epsDil ?? null)],
      ['PX_TO_BOOK_RATIO', ratio(mktCap, current?.equity ?? null)],
      ['PX_TO_SALES_RATIO', ratio(mktCap, current?.revenue ?? null)],
      [
        'EV_TO_EBITDA',
        mktCap === null || current === undefined
          ? null
          : ratio(
              mktCap + (current.ltDebt ?? 0) - (current.cash ?? 0),
              (current.operInc ?? 0) + (current.dda ?? 0),
            ),
      ],
    ];
    for (const [factor, value] of values) {
      if (!wanted.has(factor)) continue;
      put(
        cells,
        row.instrumentId,
        factor,
        value === null || provIdx < 0
          ? { ...EQS_ABSENT_CELL }
          : storedCell({ v: value, provIdx }),
      );
    }
  }

  const missing = rows.length - withStatements;
  if (missing > 0) {
    notes.push(NOTE_FUNDAMENTALS_NOT_INGESTED);
    for (const factor of wanted) {
      if (EQS_FACTOR_SOURCE[factor] !== 'statements') continue;
      ctx.unavailable.add({
        field: factor,
        reason: 'NO_SOURCE',
        detail:
          `${NOTE_FUNDAMENTALS_NOT_INGESTED}: SEC companyfacts have not been ingested for ` +
          `${String(missing)} of ${String(rows.length)} issuers in this universe; open FA on a ` +
          'name to ingest it',
      });
      if (withStatements === 0) unavailableFactors.set(factor, NOTE_FUNDAMENTALS_NOT_INGESTED);
    }
  }
}

async function loadFrameFactors(
  ctx: ResolveContext,
  rows: readonly RowMeta[],
  wanted: ReadonlySet<EqsFactor>,
  cells: Cells,
  knownAt: Date,
  notes: string[],
  unavailableFactors: Map<EqsFactor, string>,
): Promise<string | null> {
  let reported: string | null = null;
  for (const factor of wanted) {
    if (EQS_FACTOR_SOURCE[factor] !== 'frames') continue;
    const spec = EQS_FRAME_CONCEPT[factor];
    if (spec === undefined) continue;
    const loaded = await loadFrame(ctx, spec.concept, spec.unit, spec.kind, knownAt);
    if (loaded === null) {
      unavailableFactors.set(factor, 'FRAME_NOT_INGESTED');
      ctx.unavailable.add({
        field: factor,
        reason: 'NO_SOURCE',
        detail:
          `FRAME_NOT_INGESTED: the weekly sec.frames job has not fetched ${spec.concept} for any ` +
          'frame at this knownAt',
      });
      for (const row of rows) put(cells, row.instrumentId, factor, { ...EQS_ABSENT_CELL });
      continue;
    }
    reported ??= loaded.frame;
    for (const row of rows) {
      const value = row.cik === null ? undefined : loaded.rows.get(row.cik);
      if (value === undefined) {
        put(cells, row.instrumentId, factor, { ...EQS_ABSENT_CELL });
        continue;
      }
      if (value.filed_at === null && !notes.includes(NOTE_FRAMES_NOT_PIT)) {
        notes.push(NOTE_FRAMES_NOT_PIT);
      }
      put(
        cells,
        row.instrumentId,
        factor,
        storedCell({
          v: Number(value.value),
          provIdx: ctx.prov.add({
            sourceId: 'sec.frames',
            provenanceId: Number(value.provenance_id),
            capturedAt: new Date(value.captured_at),
            sourceTs: null,
            st: 'closed',
            tier: 'eod',
          }),
        }),
      );
    }
    const missing = rows.filter((r) => r.cik === null || !loaded.rows.has(r.cik)).length;
    if (missing > 0) {
      ctx.unavailable.add({
        field: factor,
        reason: 'NO_SOURCE',
        detail:
          `FRAME_NOT_INGESTED: ${String(missing)} of ${String(rows.length)} names have no ` +
          `${spec.concept} value in frame ${loaded.frame}`,
      });
    }
  }
  return reported;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Paging
// ─────────────────────────────────────────────────────────────────────────────────────────────

function encodeCursor(
  row: RowMeta | undefined,
  cells: Cells,
  sortCol: string,
): string | null {
  if (row === undefined) return null;
  return Buffer.from(
    JSON.stringify({ v: numberOf(cells.get(row.instrumentId)?.[sortCol]), id: row.instrumentId }),
    'utf8',
  ).toString('base64url');
}

function pageStart(
  ctx: ResolveContext,
  params: EqsParams,
  sorted: readonly RowMeta[],
  cells: Cells,
  sortCol: string,
): number {
  const page = ctx.page;
  const cursor = page?.cursor;
  if (page === undefined || cursor == null || cursor === '') return 0;
  let decoded: { v: number | null; id: number };
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v: number | null;
      id: number;
    };
  } catch {
    throw new TypeError(`EQS: '${cursor}' is not a screen cursor`);
  }
  const at = sorted.findIndex(
    (r) =>
      r.instrumentId === decoded.id &&
      numberOf(cells.get(r.instrumentId)?.[sortCol]) === decoded.v,
  );
  if (at < 0) return 0;
  return page.direction === 'fwd' ? at + 1 : Math.max(0, at - params.pageSize);
}

function pick(
  bucket: Record<string, ValueCell>,
  columns: readonly EqsFactor[],
): Record<string, ValueCell> {
  const out: Record<string, ValueCell> = {};
  for (const column of columns) out[column] = bucket[column] ?? { ...EQS_ABSENT_CELL };
  return out;
}

export default { resolve };
