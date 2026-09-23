/**
 * `functions/FA/resolve.ts` — Financial Analysis, equity and fund
 * (FUNCTIONS_TIER2.md §FA L4-158, WORKPLAN WP-10).
 *
 * FA is the screen the point-in-time design exists for. `fin_statements` is versioned on
 * `filed_at`: a restatement does not overwrite February's number, it adds a row filed in July that
 * covers the same `period_end`. `data/fundamentals.ts#statementsForCik` therefore takes `knownAt`
 * as a required argument and returns, per period, the newest version that was already public then,
 * with `restated` set when more than one version qualified. Everything below is built on that one
 * read, and `params.knownAt` moves it — never forward of the request's own `knownAt` (STOR-06):
 * a user may look at what was known in June, never at what will be known in November.
 *
 * Four decisions worth stating:
 *
 *  1. **Rows are bare numbers; columns carry the citation.** Every column cites the companyfacts
 *     capture that produced it through `columns[i].provIdx`, so a cell is attributable without
 *     twelve rows × sixteen columns of `ValueCell`s repeating the same index (FUNCTIONS.md §1.3
 *     rule 2, and the runner's shape walk, which does not descend into a bare `number[]`).
 *  2. **Provenance is re-cited by `provenance_id`.** `fin_statements.provenance_ids` indexes the
 *     `provenance` table, not `meta.provenance`; {@link citeMany} reads the rows once and
 *     registers each through `ctx.prov.add`, which is the collector the runner publishes.
 *  3. **A read-through failure degrades.** `providers.ensure` throws when the circuit is open and
 *     nothing is stored — the state of every replay run and every test without a wired route. FA
 *     answers from the tables; a first probe that found nothing simply stays empty, with a reason.
 *  4. **Nothing is derived that was not filed.** A ratio whose denominator is null or zero is
 *     `null`, not an extrapolation, and `SEGMENTS` is empty with `SEGMENTS_UNAVAILABLE` because
 *     companyfacts carries no dimensional facts at all.
 */

import { sql } from 'drizzle-orm';

import type { AssetClass } from '@terminal/core';
import { canonicalJson, sha256Hex } from '@terminal/core';
import type {
  FaAsReported,
  FaColumn,
  FaEquityPayload,
  FaFundPayload,
  FaHoldingRow,
  FaParams,
  FaPayload,
  FaRow,
  FaRowDef,
} from '@terminal/core/functions/manifests/FA';
import { FA_ROWS } from '@terminal/core/functions/manifests/FA';

import type { FinStatement } from '../../data/fundamentals.js';
import type { EtfHolding } from '../../data/holdings.js';
import type { FunctionResolver, FunctionServerModule, ReadThroughKind, ResolveContext } from '../context.js';
import { cellFromState } from '../shared/cells.js';
import { displayOf } from '../shared/instrumentSummary.js';

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared plumbing
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `min(params.knownAt, ctx.asOf.knownAt)` — a user may look back, never forward (STOR-06). */
function knownAtOf(ctx: ResolveContext, param: string | undefined): Date {
  if (param === undefined) return ctx.asOf.knownAt;
  const asked = new Date(param);
  if (Number.isNaN(asked.getTime())) return ctx.asOf.knownAt;
  return asked.getTime() < ctx.asOf.knownAt.getTime() ? asked : ctx.asOf.knownAt;
}

/**
 * `provenance_id → meta.provenance` index, for ids a stored row names.
 *
 * The data services index provenance into a list that is **not** `meta.provenance`, so a
 * reader's own `provIdx` must never be copied into a payload: it would attribute a number to
 * whatever happens to sit at that index. Re-citing by id is also what makes the runner's
 * `assertProvenanceExists` pass by construction.
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
  const res = await ctx.db.execute<{
    provenance_id: string;
    source_id: string;
    captured_at: string;
    source_ts: string | null;
  }>(sql`
    SELECT provenance_id::text AS provenance_id, source_id,
           to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           to_char(source_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
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

/** One freshness attempt that cannot fail the screen (decision 3). */
async function tryEnsure(
  ctx: ResolveContext,
  kind: ReadThroughKind,
  key: string,
  maxAgeMs: number,
): Promise<void> {
  if (ctx.usage === 'export') return;
  if (key.trim() === '') return;
  try {
    await ctx.providers.ensure(kind, key, { maxAgeMs });
  } catch {
    // The stored rows stay what they are and the block that wanted fresher data reports its own
    // gap. Nothing is invented here.
  }
}

function requireInstrument(ctx: ResolveContext): { instrumentId: number; assetClass: AssetClass } {
  const row = ctx.instrument;
  if (row === null) {
    throw new Error('FA: requiresSecurity is true, so the runner must supply an instrument');
  }
  return { instrumentId: row.instrumentId, assetClass: row.assetClass };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// equity — the statements (§FA L97-110)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `item` → the `fin_statements` column it is standardised into. */
const ITEM_COLUMN: Readonly<Record<string, keyof FinStatement>> = {
  REVENUE: 'revenue',
  COGS: 'cogs',
  GROSS_PROFIT: 'grossProfit',
  OPEX: 'opex',
  RND: 'rnd',
  OPER_INC: 'operInc',
  INT_EXP: 'intExp',
  PRETAX_INC: 'pretaxInc',
  TAX: 'tax',
  NET_INC: 'netInc',
  EPS_BASIC: 'epsBasic',
  EPS_DIL: 'epsDil',
  SHARES_DIL: 'sharesDil',
  CASH: 'cash',
  TOT_ASSETS: 'totAssets',
  TOT_LIAB: 'totLiab',
  LT_DEBT: 'ltDebt',
  EQUITY: 'equity',
  CFO: 'cfo',
  CAPEX: 'capex',
  FCF: 'fcf',
  DIV_PAID: 'divPaid',
  BUYBACK: 'buyback',
  DDA: 'dda',
  DPS: 'dps',
};

/** A stored column of one statement row, or `null` when the mapping produced no number. */
function columnValue(stmt: FinStatement, item: string): number | null {
  const column = ITEM_COLUMN[item];
  if (column === undefined) return null;
  const value = stmt[column];
  return typeof value === 'number' ? value : null;
}

/** `a / b` with every degenerate denominator answering `null` rather than Infinity or NaN. */
function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  const v = a / b;
  return Number.isFinite(v) ? v : null;
}

const pct = (v: number | null): number | null => (v === null ? null : v * 100);

/**
 * The derived rows. `RATIOS` and `PER_SHARE` read the same `fin_statements` row the `IS` columns
 * come from — all five statement views are columns of one row — so neither needs a second read.
 *
 * Percentage rows are emitted in **percent units** (`net_inc / revenue × 100`), not as fractions:
 * `NET_MARGIN`, `DVD_YIELD` and `SALES_GROWTH_YOY` are dictionary fields whose unit is `pct` and
 * whose derivation says `× 100`, and `core/fields/format.ts` renders a `pct` value by appending
 * `%` without scaling it. FUNCTIONS_TIER2 §RV's CSV example shows the fraction; the dictionary and
 * the formatter are the shared vocabulary, so this file follows them and says so.
 */
function derivedValue(item: string, stmt: FinStatement): number | null {
  const revenue = stmt.revenue;
  switch (item) {
    case 'GROSS_MARGIN':
      return pct(ratio(stmt.grossProfit, revenue));
    case 'OPER_MARGIN':
      return pct(ratio(stmt.operInc, revenue));
    case 'NET_MARGIN':
      return pct(ratio(stmt.netInc, revenue));
    case 'FCF_MARGIN':
      return pct(ratio(stmt.fcf, revenue));
    case 'ROE':
      return pct(ratio(stmt.netInc, stmt.equity));
    case 'ROA':
      return pct(ratio(stmt.netInc, stmt.totAssets));
    case 'DEBT_TO_EQUITY':
      return ratio(stmt.ltDebt, stmt.equity);
    case 'PAYOUT':
      return stmt.divPaid === null ? null : pct(ratio(-stmt.divPaid, stmt.netInc));
    case 'BVPS':
      return ratio(stmt.equity, stmt.sharesDil);
    case 'FCFPS':
      return ratio(stmt.fcf, stmt.sharesDil);
    case 'SALES_PS':
      return ratio(revenue, stmt.sharesDil);
    default:
      return null;
  }
}

/** One `fin_statements.as_reported` entry, defensively read: the column is free-form jsonb. */
function asReportedOf(stmt: FinStatement, item: string): FaAsReported | null {
  const entry: unknown = stmt.asReported[item];
  if (entry === null || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const concept = typeof e.concept === 'string' ? e.concept : null;
  const value = typeof e.value === 'number' ? e.value : Number(e.value);
  const factId = Number(e.fact_id ?? e.factId);
  if (concept === null || !Number.isFinite(value) || !Number.isInteger(factId)) return null;
  return {
    concept,
    taxonomy: typeof e.taxonomy === 'string' ? e.taxonomy : 'us-gaap',
    factId,
    value,
  };
}

function buildRow(
  def: FaRowDef,
  statements: readonly FinStatement[],
  asReported: boolean,
): FaRow {
  const values = statements.map((stmt) =>
    ITEM_COLUMN[def.item] === undefined ? derivedValue(def.item, stmt) : columnValue(stmt, def.item),
  );
  return {
    item: def.item,
    label: def.label,
    indent: def.indent,
    unit: def.unit,
    values,
    // A derived row has no XBRL concept of its own: the drill-down shows nothing rather than the
    // concept of one of its inputs, which would claim the issuer tagged a ratio it never filed.
    asReported: statements.map((stmt) => (asReported ? asReportedOf(stmt, def.item) : null)),
    fieldId: def.fieldId,
  };
}

const equity: FunctionResolver<FaParams, FaPayload> = async (ctx, params) => {
  const { instrumentId } = requireInstrument(ctx);
  const knownAt = knownAtOf(ctx, params.knownAt);
  const detail = await ctx.data.reference.instrument(instrumentId);
  const issuer = detail.issuer;
  const cik = issuer?.cik ?? null;
  const notes: string[] = [];

  const shell = (columns: FaColumn[], rows: FaRow[], mappingVersion: string): FaEquityPayload => ({
    variant: 'equity',
    issuer: {
      issuerId: issuer?.issuerId ?? 0,
      name: issuer?.name ?? detail.instrument.name,
      cik: cik ?? '',
      fiscalYearEnd: issuer?.fiscalYearEnd ?? null,
      currency: detail.instrument.currency,
    },
    statement: params.statement,
    periodType: params.periodType,
    scale: Number(params.scale),
    columns,
    rows,
    knownAt: knownAt.toISOString(),
    mappingVersion,
    engine: { name: 'fundamentals/std-map', version: mappingVersion },
    notes,
  });

  if (cik === null || cik === '') {
    ctx.unavailable.add({
      field: 'statement',
      reason: 'NO_SOURCE',
      detail: 'issuer has no SEC CIK (not an SEC filer)',
    });
    return shell([], [], '');
  }

  // `RATIOS`/`PER_SHARE` are columns of the same row the income statement comes from.
  const statementKind = params.statement === 'SEGMENTS' ? 'IS' : params.statement;
  const read = (periods: number): Promise<FinStatement[]> =>
    ctx.data.fundamentals.statementsForCik(cik, {
      statement:
        statementKind === 'RATIOS' || statementKind === 'PER_SHARE' ? 'IS' : statementKind,
      periodType: params.periodType,
      periods,
      knownAt,
      at: ctx.asOf,
    });

  // First probe, then one read-through only when the store has nothing for this issuer (§FA step 2).
  let statements = await read(params.periods);
  if (statements.length === 0) {
    await tryEnsure(ctx, 'sec.companyfacts', cik, DAY_MS);
    statements = await read(params.periods);
  }

  const cite = await citeMany(
    ctx,
    statements.map((s) => s.provenanceIds[0]),
  );
  const columns: FaColumn[] = statements.map((s) => ({
    periodEnd: s.periodEnd,
    fiscalYear: s.fiscalYear,
    fiscalPeriod: s.fiscalPeriod,
    filedAt: s.filedAt,
    accessionNo: s.accessionNo.trim(),
    form: formOf(s),
    restated: s.restated,
    derivedQ4: s.derivedQ4,
    provIdx: cite.get(s.provenanceIds[0] ?? -1) ?? -1,
  }));

  const mappingVersion = statements[0]?.mappingVersion ?? '';
  if (statements.length === 0) {
    ctx.unavailable.add({
      field: 'statement',
      reason: 'NO_SOURCE',
      detail:
        'no fin_statements rows for CIK ' +
        cik +
        ' filed on or before ' +
        knownAt.toISOString().slice(0, 10) +
        ': SEC companyfacts are not ingested for this issuer',
    });
    return shell(columns, [], mappingVersion);
  }

  if (params.statement === 'SEGMENTS') {
    notes.push('SEGMENTS_UNAVAILABLE');
    ctx.unavailable.add({
      field: 'segments',
      reason: 'NO_SOURCE',
      detail:
        'SEGMENTS_UNAVAILABLE: SEC companyfacts carries no dimensional (segment) facts',
    });
    return shell(columns, [], mappingVersion);
  }

  const rows = FA_ROWS[params.statement].map((def) => buildRow(def, statements, params.asReported));

  if (columns.some((c) => c.derivedQ4)) notes.push('DERIVED_Q4');
  if (columns.some((c) => c.restated)) notes.push('RESTATED');

  ctx.engines.add({
    name: 'fundamentals/std-map',
    version: mappingVersion,
    inputsHash: sha256Hex(
      canonicalJson({
        cik,
        periodType: params.periodType,
        periodEnds: statements.map((s) => s.periodEnd),
        filedAts: statements.map((s) => s.filedAt),
        mappingVersion,
      }),
    ),
  });

  return shell(columns, rows, mappingVersion);
};

/**
 * The form a statement version came from.
 *
 * `fin_statements` stores the accession number but not the form, and the accession number alone
 * does not carry it. The fiscal period does: `FY` is an annual report and a quarter is a 10-Q —
 * which is what the column header shows. A period type the CHECK admits but the SEC does not file
 * (`TTM`, which the standardiser computes) reports the empty string rather than a form nobody
 * filed.
 */
function formOf(stmt: FinStatement): string {
  if (stmt.periodType === 'FY') return '10-K';
  if (stmt.periodType === 'Q') return '10-Q';
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// fund — terms, NAV and the holdings file (§FA L112-119)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `instrument_id → 'SPY US Equity'` for the holdings rows that resolved to a master row. */
async function keysFor(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, { key: string; name: string }>> {
  const out = new Map<number, { key: string; name: string }>();
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return out;
  const list = sql.join(
    wanted.map((id) => sql`${String(id)}::bigint`),
    sql`, `,
  );
  const res = await ctx.db.execute<{
    instrument_id: string;
    ticker: string;
    exch_code: string;
    market_sector: string;
    name: string;
  }>(sql`
    SELECT instrument_id::text AS instrument_id, ticker, exch_code, market_sector, name
      FROM instruments
     WHERE instrument_id IN (${list})
       AND valid_from <= ${ctx.asOf.validAt.toISOString()}::timestamptz
       AND valid_to > ${ctx.asOf.validAt.toISOString()}::timestamptz
       AND tx_from <= ${ctx.asOf.knownAt.toISOString()}::timestamptz
       AND tx_to > ${ctx.asOf.knownAt.toISOString()}::timestamptz`);
  for (const row of res.rows) {
    out.set(Number(row.instrument_id), {
      key: displayOf(row.ticker, row.exch_code, row.market_sector as never),
      name: row.name,
    });
  }
  return out;
}

function topTen(
  holdings: readonly EtfHolding[],
  keys: ReadonlyMap<number, { key: string; name: string }>,
): FaHoldingRow[] {
  return holdings
    .filter((h) => h.weight !== null)
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 10)
    .map((h) => ({
      instrumentId: h.holdingInstrumentId,
      key: h.holdingInstrumentId === null ? null : (keys.get(h.holdingInstrumentId)?.key ?? null),
      name: h.name,
      weight: h.weight ?? 0,
      marketValue: h.marketValue,
    }));
}

function byAssetCat(
  holdings: readonly EtfHolding[],
): { assetCat: string; weight: number; count: number }[] {
  const groups = new Map<string, { weight: number; count: number }>();
  for (const h of holdings) {
    const cat = h.assetCat ?? 'UNKNOWN';
    const entry = groups.get(cat) ?? { weight: 0, count: 0 };
    entry.weight += h.weight ?? 0;
    entry.count += 1;
    groups.set(cat, entry);
  }
  return [...groups.entries()]
    .map(([assetCat, g]) => ({ assetCat, weight: g.weight, count: g.count }))
    .sort((a, b) => b.weight - a.weight || (a.assetCat < b.assetCat ? -1 : 1));
}

const fund: FunctionResolver<FaParams, FaPayload> = async (ctx, params) => {
  const { instrumentId } = requireInstrument(ctx);
  const detail = await ctx.data.reference.instrument(instrumentId);
  const terms = detail.terms?.kind === 'fund' ? detail.terms.terms : null;
  const cik = terms?.cik ?? detail.issuer?.cik ?? null;
  const notes: string[] = ['STATEMENTS_NOT_APPLICABLE_FUND'];

  ctx.unavailable.add({
    field: 'statement',
    reason: 'NOT_APPLICABLE',
    detail:
      'STATEMENTS_NOT_APPLICABLE_FUND: an ETF has no income statement; see holdings',
  });

  // NAV: two plant cells and nothing else. §0.4 rule 2 lets a single-security screen ensure once.
  const subject = ctx.plant.subjectFor(instrumentId);
  ctx.plant.ensureHot([subject]);
  const state = ctx.plant.snapshot(subject);
  const nav = {
    px: cellFromState(ctx, state, 'PX_LAST', subject),
    chgPct: cellFromState(ctx, state, 'CHG_PCT_1D', subject),
  };
  // Each NAV cell reports its own gap: the plant may hold a last price and no change (a composite
  // with `MISSING_CLOSE` has nothing to compute the change against), and one reason for two cells
  // would say the wrong thing about one of them (§1.3 rule 6).
  for (const [field, cell] of [
    ['PX_LAST', nav.px],
    ['CHG_PCT_1D', nav.chgPct],
  ] as const) {
    if (cell.v !== null || cell.r !== undefined) continue;
    ctx.unavailable.add({
      field,
      reason: 'NO_SOURCE',
      detail: `the plant composite for this fund carries no ${field}; the cell fills from the ws snapshot`,
    });
  }

  let holdings = await ctx.data.holdings.etfHoldings(instrumentId);
  if (holdings.length === 0 && cik !== null) {
    await tryEnsure(ctx, 'sec.nport', cik, DAY_MS);
    holdings = await ctx.data.holdings.etfHoldings(instrumentId);
  }

  let holdingsBlock: FaFundPayload['holdings'] = null;
  if (holdings.length === 0) {
    ctx.unavailable.add({
      field: 'holdings',
      reason: 'NO_SOURCE',
      detail: 'no N-PORT or issuer holdings file for this fund',
    });
  } else {
    const cite = await citeMany(
      ctx,
      holdings.map((h) => h.provenanceId),
    );
    const keys = await keysFor(
      ctx,
      holdings.flatMap((h) => (h.holdingInstrumentId === null ? [] : [h.holdingInstrumentId])),
    );
    const first = holdings[0];
    holdingsBlock = {
      asOfDate: first?.asOfDate ?? '',
      sourceId: first?.sourceId ?? '',
      count: holdings.length,
      // The N-PORT `netAssets` header is not carried by `etf_holdings` and therefore not by
      // `data/holdings.ts`; it is absent rather than reconstructed from the rows, which would be
      // a different number wearing the same name.
      netAssets: null,
      top10: topTen(holdings, keys),
      byAssetCat: byAssetCat(holdings),
      provIdx: cite.get(first?.provenanceId ?? -1) ?? -1,
    };
    ctx.unavailable.add({
      field: 'netAssets',
      reason: 'NO_SOURCE',
      detail:
        'the N-PORT net-assets header is not stored with the holdings rows; the fund total is ' +
        'absent rather than summed from the lines',
    });
  }

  let filings: FaFundPayload['filings'] = [];
  if (cik !== null && cik !== '') {
    await tryEnsure(ctx, 'sec.submissions', cik, 6 * 3600_000);
    const page = await ctx.data.filings.list(cik, {
      forms: ['NPORT-P', 'N-CEN', 'N-30D', '485BPOS'],
      limit: 8,
    });
    await citeMany(
      ctx,
      page.items.map((f) => f.provenanceId),
    );
    filings = page.items.map((f) => ({
      accessionNo: f.accessionNo.trim(),
      form: f.form,
      filedAt: f.filedDate,
      reportDate: f.reportDate,
      url: f.url,
    }));
  }

  let trackedIndex: FaFundPayload['fund']['trackedIndex'] = null;
  const trackedId = terms?.trackedIndexInstrumentId ?? null;
  if (trackedId !== null) {
    const tracked = await ctx.data.reference.instrument(trackedId).catch(() => null);
    trackedIndex =
      tracked === null
        ? null
        : {
            instrumentId: trackedId,
            key: displayOf(
              tracked.instrument.ticker,
              tracked.instrument.exchCode,
              tracked.instrument.marketSector,
            ),
          };
  }

  const expenseRatio = terms?.expenseRatio ?? null;
  const payload: FaFundPayload = {
    variant: 'fund',
    fund: {
      instrumentId,
      key: displayOf(
        detail.instrument.ticker,
        detail.instrument.exchCode,
        detail.instrument.marketSector,
      ),
      name: detail.instrument.name,
      fundType: terms?.fundType ?? 'etf',
      sponsor: terms?.sponsor ?? null,
      cik,
      expenseRatio: expenseRatio === null ? null : Number(expenseRatio),
      inceptionDate: terms?.inceptionDate ?? null,
      distributionFreq: terms?.distributionFreq ?? null,
      trackedIndex,
    },
    nav,
    holdings: holdingsBlock,
    filings,
    notes,
  };
  // `params` is honoured only in so far as a fund has statements to honour it with: the statement,
  // period type and scale are recorded in `meta` through the runner's params hash, and the screen
  // shows holdings instead (`STATEMENTS_NOT_APPLICABLE_FUND`).
  void params;
  return payload;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { equity, fund };

/** FUNC-02: `equity → 'equity'`, `etf → 'fund'`. The runner asserts the map's answer. */
export const variants: Partial<Record<AssetClass, FunctionResolver<FaParams, FaPayload>>> = {
  equity,
  etf: fund,
};

/** The dispatcher; `assetClasses` keeps it from being reached for anything else. */
export const resolve: FunctionResolver<FaParams, FaPayload> = (ctx, params) => {
  const assetClass = ctx.instrument?.assetClass;
  const variant = assetClass === undefined ? undefined : variants[assetClass];
  return (variant ?? equity)(ctx, params);
};

const module_: FunctionServerModule<FaParams, FaPayload> = { resolve, variants };

export default module_;
