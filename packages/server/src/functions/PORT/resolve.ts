/**
 * `functions/PORT/resolve.ts` — portfolio analytics (FUNCTIONS_TIER2.md §PORT L1439-1453).
 *
 * ## The tenancy property comes first
 *
 * Every read here goes through `ctx.data.portfolio`, which is constructed from the caller's
 * `{firmId, userId}` and carries `firm_id` in the `WHERE` of every statement (`data/portfolio.ts`),
 * on top of migration 0015's RLS policies. A portfolio of another firm and a portfolio that does
 * not exist raise the same `PortfolioAccessError('not_found')`, and this resolver turns both into
 * the same `NO_PORTFOLIO` payload — no rows, no totals, and nothing that says whether the id exists
 * somewhere else (PORT-07). Nothing in this file sends a holding identifier to a provider: the
 * `providers.ensure` calls §PORT names are for *market* history of names the firm happens to hold,
 * and this resolver does not make them at all — the stored bars are what it values the book from.
 *
 * ## Where each number comes from
 *
 * A holding's quantity and cost are the import's (`internal.user`); its price is the plant's live
 * composite, or — when the plant has never been polled for the name — the last stored daily close,
 * which is a different source and says so through its own `provIdx` and `st:'closed'`. Every
 * derived cell (market value, weight, day P&L, unrealised P&L) cites the `provIdx` of its primary
 * input, §0.4 rule 4, so `Ctrl+I` on a market value lands on the price that produced it rather than
 * on the portfolio row.
 *
 * **Deviation from §PORT step 3, recorded rather than hidden.** The spec reads the price from the
 * plant alone and then says a name with "no quote **and** no `bars_daily` close in the last 10
 * sessions" is `price_missing` — which only makes sense if a stored close *does* price a name the
 * plant has not been polled for. That is what this file does: plant first, last stored close
 * second, `price_missing` third. Taking the first clause literally would leave every holding of a
 * cold plant unpriced while the payload still claimed the book was reconciled.
 *
 * ## What is not computed
 *
 * `risk.varMonteCarlo` and `risk.factorExposures` are `null` with reasons, because there is no
 * Monte-Carlo VaR and no licensable factor model in this build. Fixed-income and derivative
 * positions are one `unattributed` bucket, because Brinson needs a segment return and a bond's
 * needs evaluated prices DATA-04 does not source here. A curve scenario over a `govt` holding with
 * no DV01 is reported as unavailable for that scenario — never as a zero P&L, which would read as
 * "the shock does not move this book".
 */

import { sql } from 'drizzle-orm';

import type { AssetClass, MarketSector, ValueCell } from '@terminal/core';
import { engineMeta } from '@terminal/core/analytics/engine';
import { statsEngine } from '@terminal/core/analytics/stats/index';
import type {
  PortAttribution,
  PortAttributionRow,
  PortBenchmark,
  PortCurrencyRow,
  PortExposure,
  PortExposureRow,
  PortHeader,
  PortHoldingRow,
  PortParams,
  PortPayload,
  PortReconStatus,
  PortRisk,
  PortScenarioRow,
  PortTotals,
} from '@terminal/core/functions/manifests/PORT';
import {
  PORT_CONFIDENTIALITY,
  PORT_NOTE_EPISODE_WINDOW,
  PORT_NOTE_FI_UNATTRIBUTED,
  PORT_NOTE_FX_MISSING,
  PORT_NOTE_NO_BENCHMARK,
  PORT_NOTE_PRICE_MISSING,
  PORT_NOTE_SHORT_HISTORY,
  PORT_UNATTRIBUTED_CLASSES,
} from '@terminal/core/functions/manifests/PORT';
import type { AttributionHolding } from '@terminal/core/analytics/portfolio/attribution';
import type { RiskHolding } from '@terminal/core/analytics/portfolio/risk';

import { PortfolioAccessError } from '../../data/portfolio.js';
import type { Lot, Portfolio, Position } from '../../data/portfolio.js';
import {
  alignReturns,
  attributionOf,
  datedSimpleReturns,
  exposureOf,
  NO_RETURNS,
  riskOf,
  tailReturns,
  valueHoldings,
  weightedReturnSeries,
  type DatedReturns,
  type ValuedHolding,
} from '../../portfolio/service.js';
import type { ResolveContext } from '../context.js';
import { citeProvenanceIds } from '../MEMB/resolve.js';
import { cellFromState, storedCell } from '../shared/cells.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §PORT step 3: how far back a stored close may be before the name counts as unpriced. */
const PRICE_STALE_DAYS = 14;

/** The two historical episodes §PORT step 10 replays, and their windows. */
const EPISODES: Readonly<Record<string, { from: string; to: string; label: string }>> = Object.freeze({
  EPISODE_2020_COVID: {
    from: '2020-02-19',
    to: '2020-03-23',
    label: 'COVID crash (2020-02-19 → 2020-03-23)',
  },
  EPISODE_2022_RATES: {
    from: '2022-01-03',
    to: '2022-10-14',
    label: 'Rate shock (2022-01-03 → 2022-10-14)',
  },
});

const SHOCK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  UST_PARALLEL_UP_100: 'UST curve +100bp parallel',
  UST_PARALLEL_DN_100: 'UST curve −100bp parallel',
  UST_STEEPEN_50: 'UST 2s10s steepens 50bp (pivot 5Y)',
  EQUITY_DOWN_10: 'Broad equity market −10 %',
  EQUITY_DOWN_20: 'Broad equity market −20 %',
  USD_UP_5: 'Base currency +5 % against every other currency',
  USD_DN_5: 'Base currency −5 % against every other currency',
});

const ASSET_CLASSES: readonly AssetClass[] = [
  'equity',
  'etf',
  'index',
  'fx',
  'govt',
  'option',
  'future',
  'crypto',
  'rate',
  'econ',
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function asAssetClass(value: string | null | undefined): AssetClass | null {
  if (value == null) return null;
  return ASSET_CLASSES.find((c) => c === value) ?? null;
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A derived cell: the value plus the `provIdx` of its primary input (§0.4 rule 4). */
function derived(v: number | null, provIdx: number): ValueCell {
  if (v === null || !Number.isFinite(v) || provIdx < 0) {
    return { v: null, st: 'na', provIdx: -1 };
  }
  return { v, st: 'closed', provIdx };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reference joins
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface InstrumentRow extends Record<string, unknown> {
  instrument_id: string;
  market_sector: string;
  asset_class: string;
  gics_sector: string | null;
  gics_source_id: string | null;
  gics_provenance_id: string | null;
  gics_captured_at: string | null;
}

/**
 * Market sector, asset class and the GICS level-1 name per instrument, as-of `ctx.asOf`.
 *
 * The classification may sit on the instrument or on its issuer (the `wiki.sp500` capture assigns
 * by issuer); the instrument's own row wins when both exist, which is the precedence QM and MEMB
 * use. A member with no row is `null` and groups under `Unclassified` — never inferred.
 */
async function instrumentFacts(
  ctx: ResolveContext,
  ids: readonly number[],
): Promise<Map<number, InstrumentRow>> {
  const out = new Map<number, InstrumentRow>();
  if (ids.length === 0) return out;
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<InstrumentRow>(sql`
    SELECT ins.instrument_id::text AS instrument_id,
           ins.market_sector::text AS market_sector,
           ins.asset_class::text   AS asset_class,
           gics.name               AS gics_sector,
           gics.source_id          AS gics_source_id,
           gics.provenance_id::text AS gics_provenance_id,
           to_char(gics.captured_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS gics_captured_at
      FROM instruments ins
      LEFT JOIN issues iss
        ON iss.issue_id = ins.issue_id
       AND bt_as_of(iss.valid_from, iss.valid_to, iss.tx_from, iss.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)
      LEFT JOIN LATERAL (
        SELECT c.name, p.source_id, p.provenance_id, p.captured_at
          FROM entity_classifications ec
          JOIN classification_codes c ON c.scheme = 'GICS' AND c.code = left(ec.code, 2)
          JOIN provenance p ON p.provenance_id = ec.provenance_id
         WHERE ec.scheme = 'GICS'
           AND ((ec.entity_kind = 'instrument' AND ec.entity_id = ins.instrument_id)
             OR (ec.entity_kind = 'issuer' AND ec.entity_id = iss.issuer_id))
           AND bt_as_of(ec.valid_from, ec.valid_to, ec.tx_from, ec.tx_to,
                        ${validAt}::timestamptz, ${knownAt}::timestamptz)
         ORDER BY (ec.entity_kind = 'instrument') DESC
         LIMIT 1
      ) gics ON true
     WHERE ins.instrument_id = ANY(${sql.param(ids.map(String))}::bigint[])
       AND bt_as_of(ins.valid_from, ins.valid_to, ins.tx_from, ins.tx_to,
                    ${validAt}::timestamptz, ${knownAt}::timestamptz)`);
  for (const row of res.rows) out.set(Number(row.instrument_id), row);
  return out;
}

interface CloseRow extends Record<string, unknown> {
  instrument_id: string;
  session_date: string;
  close: string | null;
  prev_close: string | null;
  provenance_id: string;
}

/** The last stored close on or before `asOfDate` per instrument, plus the one before it. */
async function lastCloses(
  ctx: ResolveContext,
  ids: readonly number[],
  asOfDate: string,
): Promise<Map<number, CloseRow>> {
  const out = new Map<number, CloseRow>();
  if (ids.length === 0) return out;
  const res = await ctx.db.execute<CloseRow>(sql`
    SELECT w.instrument_id::text AS instrument_id,
           b.session_date::text  AS session_date,
           b.close::text         AS close,
           b.prev_close::text    AS prev_close,
           b.provenance_id::text AS provenance_id
      FROM unnest(${sql.param(ids.map(String))}::bigint[]) AS w(instrument_id)
      CROSS JOIN LATERAL (
        SELECT d.session_date, d.close, d.provenance_id,
               lag(d.close) OVER (ORDER BY d.session_date) AS prev_close
          FROM (SELECT session_date, close, provenance_id
                  FROM bars_daily
                 WHERE instrument_id = w.instrument_id
                   AND session_date <= ${asOfDate}::date
                   AND close IS NOT NULL
                 ORDER BY session_date DESC
                 LIMIT 2) d
         ORDER BY d.session_date DESC
         LIMIT 1) b`);
  for (const row of res.rows) out.set(Number(row.instrument_id), row);
  return out;
}

interface FxRow extends Record<string, unknown> {
  base_ccy: string;
  rate: string;
  rate_date: string;
  source_id: string;
  provenance_id: string;
}

/** One FX line per currency: the newest rate on or before `asOfDate`, frankfurter preferred. */
async function fxRates(
  ctx: ResolveContext,
  currencies: readonly string[],
  baseCurrency: string,
  asOfDate: string,
): Promise<Map<string, FxRow>> {
  const out = new Map<string, FxRow>();
  const wanted = currencies.filter((c) => c !== baseCurrency);
  if (wanted.length === 0) return out;
  const res = await ctx.db.execute<FxRow>(sql`
    SELECT DISTINCT ON (base_ccy)
           base_ccy, rate::text AS rate, rate_date::text AS rate_date, source_id,
           provenance_id::text AS provenance_id
      FROM fx_rates
     WHERE quote_ccy = ${baseCurrency}
       AND base_ccy = ANY(${sql.param([...new Set(wanted)])}::text[])
       AND rate_date <= ${asOfDate}::date
     ORDER BY base_ccy, rate_date DESC, (source_id = 'frankfurter') DESC, provenance_id DESC`);
  for (const row of res.rows) out.set(row.base_ccy, row);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Return series
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Series {
  dates: string[];
  closes: number[];
}

/**
 * Split-adjusted daily closes per instrument over `[start, end]`, through the historical reader so
 * REF-09's `price` policy is applied — a raw `bars_daily` read would compute a return across a
 * split. One call per instrument, eight at a time; §PORT's budget line asks for a single batched
 * query, and this trades that round-trip count for the adjustment the budget line does not mention.
 */
async function closeSeries(
  ctx: ResolveContext,
  ids: readonly number[],
  start: string,
  end: string,
): Promise<Map<number, Series>> {
  const out = new Map<number, Series>();
  const wanted = [...new Set(ids)];
  const CHUNK = 8;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const blocks = await Promise.all(
      chunk.map(async (id) => {
        try {
          const block = await ctx.data.historical.bars(id, {
            start,
            end,
            periodicity: 'D',
            adjust: 'price',
            fields: ['PX_LAST'],
          });
          return { id, block };
        } catch {
          // No version at this instant, or no bars at all: the name simply has no history, which
          // the caller reports as a gap rather than filling in.
          return { id, block: null };
        }
      }),
    );
    for (const { id, block } of blocks) {
      if (block === null) continue;
      const col = block.columns.indexOf('PX_LAST');
      if (col < 0) continue;
      const dates: string[] = [];
      const closes: number[] = [];
      block.index.forEach((day, row) => {
        const value = block.rows[row]?.[col];
        if (typeof value !== 'number' || !Number.isFinite(value)) return;
        dates.push(day);
        closes.push(value);
      });
      if (closes.length > 0) out.set(id, { dates, closes });
    }
  }
  return out;
}

/** The buy-and-hold return of a series over its own window; `null` when it has fewer than 2 points. */
function windowReturn(series: Series | undefined): number | null {
  if (series === undefined || series.closes.length < 2) return null;
  const first = series.closes[0];
  const last = series.closes[series.closes.length - 1];
  if (first === undefined || last === undefined || first === 0) return null;
  return last / first - 1;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The empty payload
// ─────────────────────────────────────────────────────────────────────────────────────────────

const NA_CELL: ValueCell = { v: null, st: 'na', provIdx: -1 };

function emptyTotals(): PortTotals {
  return {
    marketValue: NA_CELL,
    costBasis: null,
    unrealisedPnl: NA_CELL,
    dayPnl: NA_CELL,
    cash: 0,
    // Not zero: there is no book here to accrue on, and stating a number with nothing behind it is
    // what DATA-10 forbids. `noPortfolioPayload` explains it at `totals`.
    accrued: null,
    longMv: 0,
    shortMv: 0,
    grossMv: 0,
    netMv: 0,
    pricedWeight: 0,
  };
}

function emptyRecon(): PortPayload['recon'] {
  return {
    importId: null,
    channel: null,
    uploadedAt: null,
    status: null,
    rowsTotal: 0,
    rowsOk: 0,
    rowsError: 0,
    errors: [],
    matched: 0,
    added: 0,
    removed: 0,
    quantityDiffs: [],
  };
}

/** §PORT step 1: no portfolio is visible — the same answer for "none" and "another firm's". */
function noPortfolioPayload(ctx: ResolveContext, params: PortParams): PortPayload {
  ctx.unavailable.add({
    field: 'portfolio',
    reason: 'NO_SOURCE',
    detail:
      'NO_PORTFOLIO: no portfolio is visible to this user; create one or import positions ' +
      '(PORT-01)',
  });
  ctx.unavailable.add({
    field: 'totals',
    reason: 'NO_SOURCE',
    detail:
      'NO_PORTFOLIO: with no book to value there is no market value, cost basis or accrued ' +
      'interest to state, so the totals are empty rather than zero',
  });
  return {
    variant: 'default',
    view: params.view,
    portfolio: {
      portfolioId: params.portfolioId ?? 0,
      firmId: ctx.user.firmId,
      name: '',
      baseCurrency: '',
      benchmark: null,
      asOfDate: params.asOfDate ?? utcDate(ctx.asOf.validAt),
      positionCount: 0,
      updatedAt: ctx.asOf.validAt.toISOString(),
    },
    totals: emptyTotals(),
    holdings: [],
    exposure: null,
    attribution: null,
    risk: null,
    recon: emptyRecon(),
    confidentiality: PORT_CONFIDENTIALITY,
    notes: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: PortParams): Promise<PortPayload> {
  // 1 — the portfolio. RLS and the reader's own `firm_id` predicate make another firm's row
  // invisible; both invisibility and absence arrive here as `not_found` (PORT-07).
  const pf = await pickPortfolio(ctx, params);
  if (pf === null) return noPortfolioPayload(ctx, params);

  const notes: string[] = [];

  // 2 — positions, lots and the import that wrote them.
  const positions = await ctx.data.portfolio.positions(pf.portfolioId, params.asOfDate);
  const asOfDate = positions[0]?.asOfDate ?? params.asOfDate ?? utcDate(ctx.asOf.validAt);
  const lots = await ctx.data.portfolio.lots(pf.portfolioId, { open: true });
  const positionProv = await citeProvenanceIds(
    ctx,
    positions.flatMap((p) => (p.provenanceId === null ? [] : [p.provenanceId])),
  );
  if (positions.some((p) => p.provenanceId === null)) {
    ctx.unavailable.add({
      field: 'quantity',
      reason: 'NO_SOURCE',
      detail:
        'POSITION_PROVENANCE_MISSING: one or more positions predate any import row, so the ' +
        'quantity cannot be traced to an upload; re-import the book to restore the audit trail',
    });
  }

  // 3 — reference joins, prices and FX, all over the whole book at once.
  const instrumentIds = positions.flatMap((p) => (p.instrument === null ? [] : [p.instrument.instrumentId]));
  const facts = await instrumentFacts(ctx, instrumentIds);
  citeGics(ctx, facts);

  const subjects = positions.flatMap((p) =>
    p.instrument === null || p.isCash ? [] : [ctx.plant.subjectFor(p.instrument.instrumentId)],
  );
  ctx.plant.ensureHot(subjects);
  const states = ctx.plant.snapshotMany(subjects);
  const closes = await lastCloses(ctx, instrumentIds, asOfDate);
  const closeProv = await citeProvenanceIds(
    ctx,
    [...closes.values()].map((row) => Number(row.provenance_id)),
  );

  const currencies = positions.map((p) => currencyOf(p, pf));
  const fx = await fxRates(ctx, currencies, pf.baseCurrency, asOfDate);
  const fxProv = await citeProvenanceIds(
    ctx,
    [...fx.values()].map((row) => Number(row.provenance_id)),
  );

  // 4 — the benchmark and its weights.
  const benchmark = await resolveBenchmark(ctx, params, pf);
  const benchWeights = benchmark === null ? null : await benchmarkWeights(ctx, benchmark, asOfDate);
  if (benchmark === null) {
    notes.push(PORT_NOTE_NO_BENCHMARK);
    ctx.unavailable.add({
      field: 'attribution',
      reason: 'NOT_APPLICABLE',
      detail: 'NO_BENCHMARK: the portfolio has no benchmark; set one on the portfolio or pass BM=',
    });
  }

  // 5 — the rows.
  const rows: PortHoldingRow[] = [];
  const valued: ValuedHolding[] = [];
  let priceMissing = 0;
  let fxMissing = 0;

  for (const position of positions) {
    const instrumentId = position.instrument?.instrumentId ?? null;
    const fact = instrumentId === null ? undefined : facts.get(instrumentId);
    const currency = currencyOf(position, pf);
    const subject =
      instrumentId === null || position.isCash ? null : ctx.plant.subjectFor(instrumentId);
    const positionProvIdx =
      position.provenanceId === null ? -1 : (positionProv.get(position.provenanceId) ?? -1);

    // Price: the plant's live composite, else the last stored close, else nothing.
    const state = subject === null ? undefined : states.get(subject);
    const closeRow = instrumentId === null ? undefined : closes.get(instrumentId);
    const closeProvIdx =
      closeRow === undefined ? -1 : (closeProv.get(Number(closeRow.provenance_id)) ?? -1);
    let px: ValueCell = position.isCash
      ? { v: null, st: 'na', provIdx: -1 }
      : subject === null
        ? { v: null, st: 'na', provIdx: -1 }
        : cellFromState(ctx, state, 'PX_LAST', subject);
    let chgNet: number | null =
      typeof state?.fields.CHG_NET_1D === 'number' ? state.fields.CHG_NET_1D : null;

    const closeValue = num(closeRow?.close ?? null);
    const closeFresh =
      closeRow !== undefined && closeRow.session_date >= shiftDays(asOfDate, -PRICE_STALE_DAYS);
    // A close older than the freshness window is not a price: it is history. Using it would value
    // a name nobody has traded for ten weeks at a number the screen would show as current.
    if (!position.isCash && px.v === null && closeFresh && closeValue !== null && closeProvIdx >= 0) {
      px = storedCell({ v: closeValue, provIdx: closeProvIdx });
      const prev = num(closeRow?.prev_close ?? null);
      chgNet = prev === null ? null : closeValue - prev;
    }

    // FX: 1 in the base currency (cited to the row that carries the position), else the stored rate.
    let fxCell: ValueCell;
    let fxValue: number | null;
    if (currency === pf.baseCurrency) {
      const idx = positionProvIdx >= 0 ? positionProvIdx : px.provIdx;
      fxValue = 1;
      fxCell = idx >= 0 ? storedCell({ v: 1, provIdx: idx }) : { v: null, st: 'na', provIdx: -1 };
    } else {
      const row = fx.get(currency);
      const rate = num(row?.rate ?? null);
      const idx = row === undefined ? -1 : (fxProv.get(Number(row.provenance_id)) ?? -1);
      if (rate === null || idx < 0) {
        fxValue = null;
        fxCell = NA_CELL;
        fxMissing += 1;
        ctx.unavailable.add({
          field: 'FX_USD',
          reason: 'NO_SOURCE',
          detail: `FX_MISSING: no fx_rates row for ${currency}/${pf.baseCurrency} on or before ${asOfDate}`,
        });
      } else {
        fxValue = rate;
        fxCell = storedCell({ v: rate, provIdx: idx });
      }
    }

    // Reconciliation status. `duplicate`/`unresolved` are the import's own verdict; a resolved
    // name that nothing can price is `price_missing`, decided here.
    let reconStatus: PortReconStatus = position.reconStatus;
    if (instrumentId === null && !position.isCash) {
      reconStatus = 'unresolved';
      ctx.unavailable.add({
        field: 'instrumentId',
        reason: 'NO_SOURCE',
        detail:
          `UNRESOLVED_IDENTIFIER: "${position.identifier}" did not resolve to an instrument; ` +
          'see the import report',
      });
    } else if (!position.isCash && px.v === null && !closeFresh && reconStatus === 'ok') {
      reconStatus = 'price_missing';
    }
    if (reconStatus === 'price_missing') {
      priceMissing += 1;
      ctx.unavailable.add({
        field: 'PX_LAST',
        reason: 'NO_SOURCE',
        detail:
          'PRICE_MISSING: no quote and no daily close in the last 10 sessions for ' +
          `${position.instrument?.key ?? position.identifier}`,
      });
    }

    const lotRows = instrumentId === null ? [] : lots.filter((l) => l.instrumentId === instrumentId);
    const costPrice = position.costPrice ?? weightedCost(lotRows);
    const pxValue = typeof px.v === 'number' ? px.v : null;

    const marketValue =
      fxValue === null
        ? null
        : position.isCash
          ? position.quantity * fxValue
          : pxValue === null
            ? null
            : position.quantity * pxValue * fxValue;
    const dayPnl =
      fxValue === null || chgNet === null || position.isCash
        ? null
        : position.quantity * chgNet * fxValue;
    const unrealised =
      fxValue === null || pxValue === null || costPrice === null || position.isCash
        ? null
        : position.quantity * (pxValue - costPrice) * fxValue;

    // Every derived cell cites the provenance of its primary input (§0.4 rule 4): the price for a
    // valued line, the import for a cash line whose only input is the quantity.
    const inputIdx = position.isCash ? (positionProvIdx >= 0 ? positionProvIdx : -1) : px.provIdx;

    const assetClass = asAssetClass(fact?.asset_class ?? position.instrument?.assetClass ?? null);
    rows.push({
      positionId: position.positionId,
      instrumentId,
      key: position.instrument?.key ?? null,
      name: position.instrument?.name ?? position.identifier,
      rawIdentifier: position.identifier,
      assetClass,
      marketSector: (fact?.market_sector ?? null) as MarketSector | null,
      gicsSector: fact?.gics_sector ?? null,
      currency,
      isCash: position.isCash,
      lotCount: lotRows.length === 0 ? 1 : lotRows.length,
      quantity: position.quantity,
      costPrice,
      costCurrency: position.costCurrency,
      tradeDate: position.tradeDate,
      accrued: position.accrued,
      px,
      fxRate: fxCell,
      marketValue: derived(marketValue, inputIdx),
      weight: NA_CELL,
      dayPnl: derived(dayPnl, inputIdx),
      unrealisedPnl: derived(unrealised, inputIdx),
      benchWeight: null,
      activeWeight: null,
      reconStatus,
      subject,
      provIdx: positionProvIdx,
    });

    valued.push({
      key: position.instrument?.key ?? position.identifier,
      instrumentId,
      assetClass: position.isCash ? 'cash' : (assetClass ?? 'equity'),
      sector: fact?.gics_sector ?? null,
      currency,
      quantity: position.quantity,
      price: position.isCash ? null : pxValue,
      costPrice,
      fxRate: fxValue,
      isCash: position.isCash,
    });
  }

  if (priceMissing > 0) notes.push(PORT_NOTE_PRICE_MISSING);
  if (fxMissing > 0) notes.push(PORT_NOTE_FX_MISSING);

  // 6 — totals and weights, from the one valuation the engines also use.
  //
  // One base for every row (§PORT step 5: `grossMv = Σ|marketValue|`, `weight = marketValue /
  // grossMv`). `valuation.grossMv` counts the cash line like any other, so the column foots to
  // 100 %: dividing cash by a gross that excluded it gave that row a weight measured against a
  // different book from its neighbours and the column added up to 105.9 %.
  const valuation = valueHoldings(valued, pf.baseCurrency);
  const totalsProvIdx = firstProvIdx(rows);
  for (const [i, row] of rows.entries()) {
    const mv = typeof row.marketValue.v === 'number' ? row.marketValue.v : null;
    const weight = mv === null || valuation.grossMv === 0 ? null : mv / valuation.grossMv;
    rows[i] = { ...row, weight: derived(weight, row.marketValue.provIdx) };
  }
  if (benchWeights !== null) applyBenchmarkWeights(rows, benchWeights);

  // §1.3 rule 6 over the holdings grid: every column that came back empty for at least one row
  // says why, once, at the column. A blank in a grid is a claim that something is not known, and
  // an unexplained blank is indistinguishable from a bug in the resolver — which is exactly what
  // the payload guard refuses to let through.
  const emptyColumns: {
    column: string;
    empty: (row: PortHoldingRow) => boolean;
    reason: 'NO_SOURCE' | 'NOT_LICENSED' | 'NOT_APPLICABLE';
    detail: string;
  }[] = [
    {
      column: 'key',
      empty: (row) => row.key === null,
      reason: 'NOT_APPLICABLE',
      detail:
        'NO_INSTRUMENT_KEY: a cash balance and an identifier that did not resolve have no ' +
        'instrument and therefore no command-line key; those rows are named by rawIdentifier',
    },
    {
      column: 'assetClass',
      empty: (row) => row.assetClass === null,
      reason: 'NOT_APPLICABLE',
      detail:
        'NO_ASSET_CLASS: a cash balance is not a security and an unresolved identifier is not an ' +
        'instrument, so neither carries an asset class',
    },
    {
      column: 'marketSector',
      empty: (row) => row.marketSector === null,
      reason: 'NOT_APPLICABLE',
      detail:
        'NO_MARKET_SECTOR: the Bloomberg-style market sector comes from the instrument master; a ' +
        'cash balance and an unresolved identifier have no row in it',
    },
    {
      column: 'gicsSector',
      empty: (row) => row.gicsSector === null,
      reason: 'NO_SOURCE',
      detail:
        'NO_GICS_ROW: no level-1 GICS classification is stored for this name as of the request ' +
        'date; it is grouped under Unclassified rather than assigned a sector nobody published',
    },
    {
      column: 'costPrice',
      empty: (row) => row.costPrice === null,
      reason: 'NO_SOURCE',
      detail:
        'NO_COST_BASIS: the import carried no cost price for this line and no lot opens it, so ' +
        'there is none to state (PORT-02)',
    },
    {
      column: 'costCurrency',
      empty: (row) => row.costCurrency === null,
      reason: 'NO_SOURCE',
      detail: 'NO_COST_BASIS: a line with no cost price has no currency to state it in',
    },
    {
      column: 'tradeDate',
      empty: (row) => row.tradeDate === null,
      reason: 'NO_SOURCE',
      detail: 'NO_TRADE_DATE: the uploaded position file gave none for this line',
    },
    {
      column: 'benchWeight',
      empty: (row) => row.benchWeight === null,
      reason: 'NOT_APPLICABLE',
      detail:
        'NO_BENCHMARK: the portfolio has no benchmark, so no benchmark weight exists for the row; ' +
        'a held name the benchmark does not carry has 0, never null',
    },
    {
      column: 'activeWeight',
      empty: (row) => row.activeWeight === null,
      reason: 'NOT_APPLICABLE',
      detail:
        'NO_ACTIVE_WEIGHT: an active weight is the position weight minus the benchmark weight, so ' +
        'a row with no weight of its own (unpriced, or an identifier that did not resolve) and a ' +
        'book with no benchmark have none',
    },
  ];
  for (const column of emptyColumns) {
    if (!rows.some((row) => column.empty(row))) continue;
    ctx.unavailable.add({
      field: `holdings.${column.column}`,
      reason: column.reason,
      detail: column.detail,
    });
  }

  const totals: PortTotals = {
    marketValue: derived(valuation.netMv, totalsProvIdx),
    costBasis: costBasisOf(rows),
    unrealisedPnl: derived(sumCells(rows, 'unrealisedPnl'), totalsProvIdx),
    dayPnl: derived(sumCells(rows, 'dayPnl'), totalsProvIdx),
    cash: valuation.cash,
    accrued: rows.reduce((sum, r) => sum + r.accrued, 0),
    longMv: valuation.longMv,
    shortMv: valuation.shortMv,
    grossMv: valuation.grossMv,
    netMv: valuation.netMv,
    pricedWeight: valuation.pricedWeight,
  };

  const header: PortHeader = {
    portfolioId: pf.portfolioId,
    firmId: pf.firmId,
    name: pf.name,
    baseCurrency: pf.baseCurrency,
    benchmark,
    asOfDate,
    positionCount: positions.length,
    updatedAt: pf.updatedAt,
  };

  // 7-10 — exactly one analytic view, and only the one that was asked for (§PORT step 12).
  const valuationTs = ctx.asOf.validAt.toISOString();
  const exposure =
    params.view === 'exposure'
      ? buildExposure(ctx, params, rows, valued, fx, fxProv, pf.baseCurrency, valuationTs, asOfDate)
      : null;
  const attribution =
    params.view === 'attribution'
      ? await buildAttribution(ctx, params, rows, benchmark, benchWeights, asOfDate, valuationTs, notes)
      : null;
  const risk =
    params.view === 'risk'
      ? await buildRisk(ctx, params, rows, benchmark, valuation, asOfDate, valuationTs, notes)
      : null;

  // 11 — the import report.
  const recon = await buildRecon(ctx, pf.portfolioId);

  return {
    variant: 'default',
    view: params.view,
    portfolio: header,
    totals,
    holdings: rows,
    exposure,
    attribution,
    risk,
    recon,
    confidentiality: PORT_CONFIDENTIALITY,
    notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Step helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function pickPortfolio(ctx: ResolveContext, params: PortParams): Promise<Portfolio | null> {
  try {
    if (params.portfolioId !== undefined) return await ctx.data.portfolio.get(params.portfolioId);
    const all = await ctx.data.portfolio.list();
    const sorted = [...all].sort(
      (a, b) =>
        (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) ||
        b.portfolioId - a.portfolioId,
    );
    return sorted[0] ?? null;
  } catch (err) {
    if (err instanceof PortfolioAccessError) return null;
    throw err;
  }
}

function currencyOf(position: Position, pf: Portfolio): string {
  if (position.isCash) return position.cashCurrency ?? pf.baseCurrency;
  const ccy = position.instrument?.currency ?? '';
  return ccy === '' ? pf.baseCurrency : ccy;
}

function weightedCost(lots: readonly Lot[]): number | null {
  let quantity = 0;
  let cost = 0;
  for (const lot of lots) {
    quantity += lot.quantity;
    cost += lot.quantity * lot.unitCost;
  }
  return quantity === 0 ? null : cost / quantity;
}

function firstProvIdx(rows: readonly PortHoldingRow[]): number {
  for (const row of rows) {
    if (row.provIdx >= 0) return row.provIdx;
  }
  for (const row of rows) {
    if (row.px.provIdx >= 0) return row.px.provIdx;
  }
  return -1;
}

function sumCells(rows: readonly PortHoldingRow[], key: 'dayPnl' | 'unrealisedPnl'): number | null {
  let seen = false;
  let sum = 0;
  for (const row of rows) {
    const v = row[key].v;
    if (typeof v !== 'number') continue;
    seen = true;
    sum += v;
  }
  return seen ? sum : null;
}

function costBasisOf(rows: readonly PortHoldingRow[]): number | null {
  let seen = false;
  let sum = 0;
  for (const row of rows) {
    if (row.costPrice === null) continue;
    seen = true;
    sum += row.quantity * row.costPrice;
  }
  return seen ? sum : null;
}

/** The GICS join's own citation — the second attribution a PORT payload carries (DATA-09). */
function citeGics(ctx: ResolveContext, facts: ReadonlyMap<number, InstrumentRow>): void {
  for (const fact of facts.values()) {
    if (fact.gics_provenance_id === null || fact.gics_source_id === null) continue;
    ctx.prov.add({
      sourceId: fact.gics_source_id,
      provenanceId: Number(fact.gics_provenance_id),
      capturedAt: new Date(fact.gics_captured_at ?? ctx.asOf.knownAt.toISOString()),
      sourceTs: null,
      st: 'closed',
      tier: 'eod',
    });
  }
}

async function resolveBenchmark(
  ctx: ResolveContext,
  params: PortParams,
  pf: Portfolio,
): Promise<PortBenchmark | null> {
  const ref = params.benchmark;
  if (ref !== undefined && !('formula' in ref)) {
    const item = await ctx.data.reference.resolve('id' in ref ? { id: ref.id } : ref.ref);
    const found = item.instrument;
    if (found !== null) {
      return {
        instrumentId: found.instrumentId,
        key: found.display,
        name: found.name,
        source: 'param',
      };
    }
  }
  const own = pf.benchmark;
  if (own === null) return null;
  return {
    instrumentId: own.instrumentId,
    key: own.key,
    name: own.name,
    source: 'portfolio',
  };
}

/**
 * The benchmark's constituent weights: `index_members` for an index, `etf_holdings` for a fund.
 * An empty map is a benchmark with no published roster, which is not an error — the held names
 * simply have no benchmark weight, and the attribution view says so.
 */
async function benchmarkWeights(
  ctx: ResolveContext,
  benchmark: PortBenchmark,
  asOfDate: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const roster = await ctx.data.reference.members(benchmark.instrumentId, asOfDate);
    for (const member of roster.members) {
      if (member.weight !== null) out.set(member.instrumentId, member.weight);
    }
    if (out.size > 0) return out;
  } catch {
    // Not an index: fall through to the fund file.
  }
  try {
    const lines = await ctx.data.holdings.etfHoldings(benchmark.instrumentId, asOfDate);
    for (const line of lines) {
      if (line.holdingInstrumentId === null || line.weight === null) continue;
      out.set(line.holdingInstrumentId, line.weight);
    }
  } catch {
    // No holdings file either: the benchmark has no reachable roster.
  }
  return out;
}

/**
 * §PORT step 6: a held name the benchmark does not carry has weight `0`, never `null`, so its
 * active weight is the whole position.
 */
function applyBenchmarkWeights(
  rows: PortHoldingRow[],
  benchWeights: ReadonlyMap<number, number>,
): void {
  for (const [i, row] of rows.entries()) {
    if (row.isCash) {
      rows[i] = { ...row, benchWeight: 0, activeWeight: weightOf(row) };
      continue;
    }
    const bench = row.instrumentId === null ? 0 : (benchWeights.get(row.instrumentId) ?? 0);
    const weight = weightOf(row);
    rows[i] = {
      ...row,
      benchWeight: bench,
      activeWeight: weight === null ? null : weight - bench,
    };
  }
}

function weightOf(row: PortHoldingRow): number | null {
  return typeof row.weight.v === 'number' ? row.weight.v : null;
}

// ── exposure (§PORT step 7) ───────────────────────────────────────────────────────────────────

function buildExposure(
  ctx: ResolveContext,
  params: PortParams,
  rows: readonly PortHoldingRow[],
  valued: readonly ValuedHolding[],
  fx: ReadonlyMap<string, FxRow>,
  fxProv: ReadonlyMap<number, number>,
  baseCurrency: string,
  valuationTs: string,
  asOfDate: string,
): PortExposure {
  const outcome = exposureOf(valued, { baseCurrency, valuationTs });
  ctx.engines.add(outcome.engine);

  const grossMv = outcome.valuation.grossMv;
  const groups = new Map<string, { marketValue: number; bench: number; count: number; hasBench: boolean }>();
  for (const row of rows) {
    const key = groupKeyOf(row, params.groupBy);
    const bucket = groups.get(key) ?? { marketValue: 0, bench: 0, count: 0, hasBench: false };
    const mv = typeof row.marketValue.v === 'number' ? row.marketValue.v : 0;
    bucket.marketValue += mv;
    bucket.count += 1;
    if (row.benchWeight !== null) {
      bucket.bench += row.benchWeight;
      bucket.hasBench = true;
    }
    groups.set(key, bucket);
  }

  const exposureRows: PortExposureRow[] = [...groups.entries()]
    .sort((a, b) => Math.abs(b[1].marketValue) - Math.abs(a[1].marketValue) || (a[0] < b[0] ? -1 : 1))
    .map(([key, bucket]): PortExposureRow => {
      const weight = grossMv === 0 ? 0 : bucket.marketValue / grossMv;
      return {
        key,
        label: key,
        marketValue: bucket.marketValue,
        weight,
        benchWeight: bucket.hasBench ? bucket.bench : null,
        activeWeight: bucket.hasBench ? weight - bucket.bench : null,
        count: bucket.count,
      };
    });

  const byCcy = new Map<string, number>();
  for (const row of rows) {
    const mv = typeof row.marketValue.v === 'number' ? row.marketValue.v : 0;
    byCcy.set(row.currency, (byCcy.get(row.currency) ?? 0) + mv);
  }
  const currency: PortCurrencyRow[] = [...byCcy.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([ccy, marketValue]): PortCurrencyRow => {
      const row = fx.get(ccy);
      const idx = row === undefined ? -1 : (fxProv.get(Number(row.provenance_id)) ?? -1);
      const rate = row === undefined ? null : num(row.rate);
      return {
        ccy,
        marketValue,
        weight: grossMv === 0 ? 0 : marketValue / grossMv,
        fxRate:
          ccy === baseCurrency
            ? derived(1, firstProvIdx(rows))
            : rate === null || idx < 0
              ? NA_CELL
              : storedCell({ v: rate, provIdx: idx }),
        fxDate: row?.rate_date ?? asOfDate,
      };
    });

  return {
    groupBy: params.groupBy,
    rows: exposureRows,
    currency,
    engine: { name: 'portfolio/exposure', version: outcome.engine.version },
  };
}

function groupKeyOf(row: PortHoldingRow, groupBy: PortParams['groupBy']): string {
  if (groupBy === 'currency') return row.currency;
  if (groupBy === 'assetClass') return row.isCash ? 'cash' : (row.assetClass ?? 'unclassified');
  if (groupBy === 'instrument') return row.key ?? row.rawIdentifier;
  return row.isCash ? 'Cash' : (row.gicsSector ?? 'Unclassified');
}

// ── attribution (§PORT step 8) ────────────────────────────────────────────────────────────────

async function buildAttribution(
  ctx: ResolveContext,
  params: PortParams,
  rows: readonly PortHoldingRow[],
  benchmark: PortBenchmark | null,
  benchWeights: ReadonlyMap<number, number> | null,
  asOfDate: string,
  valuationTs: string,
  notes: string[],
): Promise<PortAttribution | null> {
  if (benchmark === null || benchWeights === null) return null;

  ctx.unavailable.add({
    field: 'attribution.currency',
    reason: 'NOT_APPLICABLE',
    detail:
      'CCY_ATTRIBUTION_UNAVAILABLE: no forward points source; currency effect is shown as ' +
      'exposure, not as an attribution term',
  });

  const start = shiftDays(asOfDate, -Math.ceil(params.lookbackDays * 1.5));
  const attributable = rows.filter(
    (row) =>
      !row.isCash &&
      row.instrumentId !== null &&
      row.reconStatus !== 'price_missing' &&
      !PORT_UNATTRIBUTED_CLASSES.includes(row.assetClass ?? 'equity'),
  );
  const unattributedRows = rows.filter((row) => !row.isCash && !attributable.includes(row));

  const memberIds = [...benchWeights.keys()];
  const series = await closeSeries(
    ctx,
    [...attributable.flatMap((r) => (r.instrumentId === null ? [] : [r.instrumentId])), ...memberIds],
    start,
    asOfDate,
  );
  const memberFacts = await instrumentFacts(ctx, memberIds);

  const portfolio: AttributionHolding[] = attributable.flatMap((row) => {
    const ret = windowReturn(row.instrumentId === null ? undefined : series.get(row.instrumentId));
    const weight = weightOf(row);
    if (ret === null || weight === null) return [];
    return [{ segment: row.gicsSector ?? 'Unclassified', weight, return: ret }];
  });
  const bench: AttributionHolding[] = [...benchWeights.entries()].flatMap(([id, weight]) => {
    const ret = windowReturn(series.get(id));
    if (ret === null) return [];
    return [{ segment: memberFacts.get(id)?.gics_sector ?? 'Unclassified', weight, return: ret }];
  });

  if (portfolio.length === 0 || bench.length === 0) {
    notes.push(PORT_NOTE_SHORT_HISTORY);
    ctx.unavailable.add({
      field: 'attribution.rows',
      reason: 'NO_SOURCE',
      detail:
        'INSUFFICIENT_HISTORY: no adjusted daily bars cover the attribution window for the ' +
        'portfolio or the benchmark, so no segment return can be computed',
    });
    return null;
  }

  // Brinson's identity only holds over a normalised weight vector, and `core/analytics` enforces
  // that. The attributable subset is smaller than the book — cash, fixed income and anything that
  // could not be priced are out — so both sides are renormalised over what *is* attributable, and
  // the weight that was left out is reported in `unattributed` rather than quietly spread across
  // the sectors that remain.
  const portScale = portfolio.reduce((sum, h) => sum + h.weight, 0);
  const benchScale = bench.reduce((sum, h) => sum + h.weight, 0);
  if (portScale === 0 || benchScale === 0) {
    notes.push(PORT_NOTE_SHORT_HISTORY);
    ctx.unavailable.add({
      field: 'attribution.rows',
      reason: 'NO_SOURCE',
      detail:
        'INSUFFICIENT_HISTORY: the attributable side of the book or of the benchmark carries no ' +
        'weight at all, so no segment return can be computed',
    });
    return null;
  }
  const normalisedPortfolio = portfolio.map((h) => ({ ...h, weight: h.weight / portScale }));
  const normalisedBench = bench.map((h) => ({ ...h, weight: h.weight / benchScale }));

  const outcome = attributionOf({
    portfolio: normalisedPortfolio,
    benchmark: normalisedBench,
    valuationTs,
  });
  ctx.engines.add(outcome.engine);
  const result = outcome.outputs;

  const sessions = Math.max(
    ...[...series.values()].map((s) => s.closes.length),
    0,
  );
  const from = [...series.values()].map((s) => s.dates[0] ?? asOfDate).sort()[0] ?? start;

  const attributionRows: PortAttributionRow[] = result.segments.map((s) => ({
    key: s.segment,
    label: s.segment,
    portWeight: s.portfolioWeight,
    benchWeight: s.benchmarkWeight,
    portReturn: s.portfolioReturn,
    benchReturn: s.benchmarkReturn,
    allocation: s.allocation,
    selection: s.selection,
    interaction: s.interaction,
    total: s.total,
  }));

  let unattributed: PortAttribution['unattributed'] = null;
  if (unattributedRows.length > 0) {
    const fixedIncome = unattributedRows.some((row) =>
      PORT_UNATTRIBUTED_CLASSES.includes(row.assetClass ?? 'equity'),
    );
    const weight = unattributedRows.reduce((sum, row) => sum + (weightOf(row) ?? 0), 0);
    // `total` is this sleeve's contribution to active return, and the whole point of the row is
    // that it could not be computed — so it is `null` with the reason beside it, never the `0` it
    // used to carry. Zero is a statement about the contribution; this row exists to say there
    // isn't one to state.
    unattributed = {
      weight,
      total: null,
      reason: fixedIncome ? 'FI_ATTRIBUTION_UNAVAILABLE' : 'PRICE_MISSING',
    };
    ctx.unavailable.add({
      field: 'attribution.unattributed.total',
      reason: 'NO_SOURCE',
      detail: fixedIncome
        ? 'FI_ATTRIBUTION_UNAVAILABLE: with no evaluated bond prices there is no segment return ' +
          'for the fixed-income sleeve, so its contribution to active return is unknown — not zero'
        : 'PRICE_MISSING: a position with no price has no return, so its contribution to active ' +
          'return is unknown — not zero',
    });
    if (fixedIncome) {
      notes.push(PORT_NOTE_FI_UNATTRIBUTED);
      ctx.unavailable.add({
        field: 'attribution.fixedIncome',
        reason: 'NO_SOURCE',
        detail:
          'FI_ATTRIBUTION_UNAVAILABLE: curve/spread/carry attribution needs evaluated bond ' +
          'prices; DATA-04 is out of scope in this wedge (BRIEF §1), so fixed-income positions ' +
          'are reported as one unattributed bucket',
      });
    }
  }

  return {
    method: 'brinson_fachler',
    groupBy: 'sector',
    period: { from, to: asOfDate, sessions },
    rows: attributionRows,
    // What the renormalisation above divided by: the attributable sleeve's share of the book. The
    // rows' weights sum to 1 *within* this fraction, so a reader can tell `total.portReturn` from
    // the portfolio's return without recomputing it.
    attributableWeight: portScale,
    total: {
      portReturn: result.portfolioReturn,
      benchReturn: result.benchmarkReturn,
      active: result.activeReturn,
      allocation: result.allocation,
      selection: result.selection,
      interaction: result.interaction,
    },
    unattributed,
    engine: {
      name: 'portfolio/attribution',
      version: outcome.engine.version,
      inputsHash: outcome.engine.inputsHash,
    },
  };
}

// ── risk (§PORT steps 9 and 10) ───────────────────────────────────────────────────────────────

async function buildRisk(
  ctx: ResolveContext,
  params: PortParams,
  rows: readonly PortHoldingRow[],
  benchmark: PortBenchmark | null,
  valuation: ReturnType<typeof valueHoldings>,
  asOfDate: string,
  valuationTs: string,
  notes: string[],
): Promise<PortRisk | null> {
  ctx.unavailable.add({
    field: 'risk.varMonteCarlo',
    reason: 'NOT_APPLICABLE',
    detail:
      'VAR_MC_NOT_IN_V1: core/analytics/portfolio/risk.ts implements historical and parametric ' +
      'VaR only',
  });
  ctx.unavailable.add({
    field: 'risk.factorExposures',
    reason: 'NO_SOURCE',
    detail:
      'NO_FACTOR_MODEL: no commercial multi-factor risk model is licensable in this wedge; ' +
      'tracking error, beta and contribution are computed ex-post from returns instead ' +
      '(PORT-04 partial)',
  });

  const confidence = params.varConfidence === '99' ? 99 : 95;
  // The window is whatever the engine was actually handed — `lookbackDays` capped by the
  // overlapping history — never a literal. `volPct` is `stdev(the whole series) × √252`, so
  // declaring the §0.6 `vol30d` window of 30 beside a 252-session number labelled a year's
  // volatility as a month's. BRIEF's rule: nothing is stated that the payload did not compute.
  const conventionsOver = (sessions: number): PortRisk['conventions'] => ({
    returns: 'simple',
    priceBasis: 'close',
    adjust: 'price',
    annualisation: 252,
    volWindow: sessions,
  });

  const priced = rows.filter(
    (row) => !row.isCash && row.instrumentId !== null && typeof row.marketValue.v === 'number',
  );
  const start = shiftDays(asOfDate, -Math.ceil(params.lookbackDays * 1.5));
  const ids = priced.flatMap((row) => (row.instrumentId === null ? [] : [row.instrumentId]));
  const benchIds = benchmark === null ? [] : [benchmark.instrumentId];
  const series = await closeSeries(ctx, [...ids, ...benchIds], start, asOfDate);

  const weights = new Map<string, number>();
  const returns = new Map<string, DatedReturns>();
  const betas = new Map<string, number>();
  for (const row of priced) {
    const key = row.key ?? row.rawIdentifier;
    const s = row.instrumentId === null ? undefined : series.get(row.instrumentId);
    if (s === undefined) continue;
    const weight = weightOf(row);
    if (weight === null) continue;
    weights.set(key, weight);
    // Dated, not bare: two holdings on different exchange calendars have the same number of
    // sessions over a window and not the same sessions, and everything below pairs by date.
    returns.set(key, tailReturns(datedSimpleReturns(s.dates, s.closes), params.lookbackDays));
  }

  const benchSeries = benchmark === null ? undefined : series.get(benchmark.instrumentId);
  const benchReturns =
    benchSeries === undefined
      ? NO_RETURNS
      : tailReturns(datedSimpleReturns(benchSeries.dates, benchSeries.closes), params.lookbackDays);
  const portfolioReturns = weightedReturnSeries(weights, returns);

  if (portfolioReturns.returns.length < 2) {
    notes.push(PORT_NOTE_SHORT_HISTORY);
    ctx.unavailable.add({
      field: 'risk',
      reason: 'NO_SOURCE',
      detail:
        'INSUFFICIENT_HISTORY: fewer than two overlapping sessions of adjusted daily bars cover ' +
        'the held names, so no volatility, tracking error or VaR can be computed',
    });
    return {
      lookbackDays: params.lookbackDays,
      sessions: portfolioReturns.returns.length,
      conventions: conventionsOver(portfolioReturns.returns.length),
      volPct: null,
      benchVolPct: null,
      trackingErrorPct: null,
      beta: null,
      corr: null,
      r2: null,
      sharpe: null,
      informationRatio: null,
      maxDrawdownPct: null,
      var: {
        method: params.varMethod,
        confidence,
        horizonDays: 1,
        valuePct: null,
        valueCcy: null,
        backtest: null,
      },
      varMonteCarlo: null,
      factorExposures: null,
      scenarios: [],
      engine: { name: 'portfolio/risk', version: '1.0.0', inputsHash: '' },
    };
  }

  // Beta, correlation and tracking error are statistics of a *pair*, so the two series are
  // intersected by date rather than trimmed to a common length: equal lengths do not mean equal
  // sessions, and pairing a portfolio session with the benchmark's neighbouring one would measure
  // a relationship that was never observed. A session either side is missing is dropped, never
  // padded.
  const paired = benchReturns.returns.length === 0 ? null : alignReturns(portfolioReturns, benchReturns);
  const port = paired === null ? [...portfolioReturns.returns] : paired.a;
  const bench = paired === null ? undefined : paired.b;

  const stats = statsEngine(
    { returns: port, ...(bench === undefined ? {} : { benchmark: bench }) },
    valuationTs,
  );
  ctx.engines.add(engineMeta(stats));
  const s = stats.outputs;

  for (const row of priced) {
    const key = row.key ?? row.rawIdentifier;
    const own = returns.get(key);
    if (own === undefined || benchReturns.returns.length === 0 || own.returns.length < 2) continue;
    const pair = alignReturns(own, benchReturns);
    if (pair.a.length < 2) continue;
    try {
      const b = statsEngine({ returns: pair.a, benchmark: pair.b }, valuationTs);
      const value = b.outputs.beta;
      if (value !== null) betas.set(key, value);
    } catch {
      // A zero-variance series has no beta; the engine's default of 1 for an equity-like line is
      // what the scenario then uses, and it is stated in the scenario's `detail`.
    }
  }

  // A beta is only handed to the engine for an equity-like line. Attaching the OLS beta of a bond
  // to a `govt` holding would make an *equity* shock move the bond book, which is not what the
  // shock says; the engine's own default (0 for a non-equity-like class) is the honest one.
  const EQUITY_LIKE: ReadonlySet<string> = new Set(['equity', 'etf', 'index']);
  const riskHoldings: RiskHolding[] = priced.map((row) => {
    const key = row.key ?? row.rawIdentifier;
    const assetClass = row.assetClass ?? 'equity';
    const b = EQUITY_LIKE.has(assetClass) ? betas.get(key) : undefined;
    return {
      instrumentId: key,
      assetClass,
      currency: row.currency,
      marketValue: typeof row.marketValue.v === 'number' ? row.marketValue.v : 0,
      ...(b === undefined ? {} : { beta: b }),
    };
  });

  const shockIds = params.scenarios.filter((id) => !(id in EPISODES));
  const backtestWindow = port.length >= 60 ? Math.min(60, Math.floor(port.length / 2)) : undefined;
  const outcome = riskOf({
    returns: port,
    benchmark: bench,
    // The weights the return series is built at are fractions of `grossMv` (cash included), so the
    // value a VaR *fraction* is turned into an amount against has to be the same book.
    portfolioValue: valuation.grossMv,
    holdings: riskHoldings,
    scenarios: shockIds,
    ...(backtestWindow === undefined ? {} : { backtestWindow }),
    varConfidence: confidence === 99 ? 0.99 : 0.95,
    valuationTs,
  });
  ctx.engines.add(outcome.engine);
  const r = outcome.outputs;

  const varReturn =
    params.varMethod === 'parametric' ? r.parametricVarReturn : r.historicalVarReturn;
  const varAmount =
    params.varMethod === 'parametric' ? r.parametricVarAmount : r.historicalVarAmount;

  const scenarios = await buildScenarios(ctx, params, rows, r.scenarios);

  return {
    lookbackDays: params.lookbackDays,
    sessions: port.length,
    conventions: conventionsOver(port.length),
    volPct: r.volAnnualised * 100,
    benchVolPct: bench === undefined ? null : benchVol(bench),
    trackingErrorPct: r.trackingErrorAnnualised === null ? null : r.trackingErrorAnnualised * 100,
    beta: s.beta,
    corr: s.correlation,
    r2: s.rSquared,
    sharpe: s.sharpe,
    informationRatio: s.informationRatio,
    maxDrawdownPct: s.maxDrawdown * 100,
    var: {
      method: params.varMethod,
      confidence,
      horizonDays: 1,
      valuePct: varReturn * 100,
      valueCcy: varAmount,
      backtest:
        r.backtestSessions === null
          ? null
          : {
              windowSessions: backtestWindow ?? 0,
              exceptions: r.backtestExceptions ?? 0,
              expected: r.backtestExpectedExceptions ?? 0,
            },
    },
    varMonteCarlo: null,
    factorExposures: null,
    scenarios,
    engine: {
      name: 'portfolio/risk',
      version: outcome.engine.version,
      inputsHash: outcome.engine.inputsHash,
    },
  };
}

function benchVol(returns: readonly number[]): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - mean) * (r - mean), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/**
 * The scenario grid: the engine's shock results, plus the two episode replays this resolver runs
 * itself because they are a *history* question rather than a sensitivity one.
 *
 * A `govt` line with no DV01 is reported through the engine's `unpricedInstrumentIds` rather than
 * as a zero: a curve shock that moves a bond book by nothing is a wrong answer, not a small one.
 */
async function buildScenarios(
  ctx: ResolveContext,
  params: PortParams,
  rows: readonly PortHoldingRow[],
  shocks: readonly {
    id: string;
    description: string;
    pnl: number;
    pnlPct: number | null;
    unpricedInstrumentIds: readonly string[];
  }[],
): Promise<PortScenarioRow[]> {
  const out: PortScenarioRow[] = [];
  const byId = new Map(shocks.map((s) => [s.id, s]));

  for (const id of params.scenarios) {
    const episode = EPISODES[id];
    if (episode === undefined) {
      const shock = byId.get(id);
      if (shock === undefined) continue;
      const unpriced = shock.unpricedInstrumentIds;
      out.push({
        id,
        label: SHOCK_LABELS[id] ?? shock.description,
        method: 'shock',
        detail:
          unpriced.length === 0
            ? `${shock.description}; equity lines move through beta, rate lines through DV01`
            : `${shock.description}; ${String(unpriced.length)} rate-sensitive line(s) carry no ` +
              `DV01 in this build (${unpriced.slice(0, 4).join(', ')})`,
        pnlCcy: unpriced.length === 0 ? shock.pnl : null,
        pnlPct: unpriced.length === 0 ? shock.pnlPct : null,
        unavailableReason: unpriced.length === 0 ? null : 'RATE_SENSITIVITY_UNAVAILABLE',
      });
      if (unpriced.length > 0) {
        ctx.unavailable.add({
          field: `risk.scenarios.${id}`,
          reason: 'NO_SOURCE',
          detail:
            'RATE_SENSITIVITY_UNAVAILABLE: a curve scenario needs a DV01 per rate-sensitive ' +
            'holding, and evaluated bond analytics (DATA-04) are out of scope in this wedge; the ' +
            'shock is reported as unavailable rather than as a zero P&L',
        });
      }
      continue;
    }

    const held = rows.filter(
      (row) => !row.isCash && row.instrumentId !== null && typeof row.marketValue.v === 'number',
    );
    const series = await closeSeries(
      ctx,
      held.flatMap((row) => (row.instrumentId === null ? [] : [row.instrumentId])),
      episode.from,
      episode.to,
    );
    const missing = held.filter(
      (row) => windowReturn(row.instrumentId === null ? undefined : series.get(row.instrumentId)) === null,
    );
    if (missing.length > 0 || held.length === 0) {
      out.push({
        id,
        label: episode.label,
        method: 'episode',
        detail:
          `realised return of every held name over ${episode.from} → ${episode.to}; ` +
          `${String(missing.length)} name(s) have no bars covering the window` +
          (missing.length === 0 ? '' : ` (${missing.slice(0, 4).map((m) => m.key ?? m.rawIdentifier).join(', ')})`),
        pnlCcy: null,
        pnlPct: null,
        unavailableReason: PORT_NOTE_EPISODE_WINDOW,
      });
      ctx.unavailable.add({
        field: `risk.scenarios.${id}`,
        reason: 'NO_SOURCE',
        detail:
          `EPISODE_WINDOW_UNAVAILABLE: bars_daily does not cover ${episode.from} → ${episode.to} ` +
          `for ${missing.map((m) => m.key ?? m.rawIdentifier).join(', ') || 'any held name'}`,
      });
      continue;
    }

    let pnl = 0;
    let gross = 0;
    for (const row of held) {
      const ret = windowReturn(row.instrumentId === null ? undefined : series.get(row.instrumentId));
      const mv = typeof row.marketValue.v === 'number' ? row.marketValue.v : 0;
      if (ret === null) continue;
      pnl += mv * ret;
      gross += Math.abs(mv);
    }
    out.push({
      id,
      label: episode.label,
      method: 'episode',
      detail: `realised return of every held name over ${episode.from} → ${episode.to}, at today's weights`,
      pnlCcy: pnl,
      pnlPct: gross === 0 ? null : pnl / gross,
      unavailableReason: null,
    });
  }

  return out;
}

// ── reconciliation (§PORT step 11) ────────────────────────────────────────────────────────────

async function buildRecon(ctx: ResolveContext, portfolioId: number): Promise<PortPayload['recon']> {
  try {
    const report = await ctx.data.portfolio.recon(portfolioId);
    return {
      importId: report.importId,
      channel: report.channel,
      uploadedAt: report.uploadedAt,
      status: report.status,
      rowsTotal: report.rowsTotal,
      rowsOk: report.rowsOk,
      rowsError: report.rowsError,
      errors: report.errors,
      matched: report.reconciliation.matched,
      added: report.reconciliation.added,
      removed: report.reconciliation.removed,
      quantityDiffs: report.reconciliation.quantityDiffs,
    };
  } catch (err) {
    // A portfolio written through `PUT /portfolios/:id/positions` has no import row; that is not
    // an access failure and not a gap in the data — there was simply never an upload to report.
    if (err instanceof PortfolioAccessError) return emptyRecon();
    throw err;
  }
}

export default { resolve };
