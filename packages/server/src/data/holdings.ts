/**
 * `data/holdings.ts` — fund holdings and the inverse holder view (WORKPLAN §WP-04 L706-709,
 * FUNCTIONS.md §1.4.2 L307, FUNCTIONS_TIER2 §HDS L1602-1614). HDS and MEMB read it.
 *
 * Two files feed `etf_holdings`: the SEC N-PORT filing (`sec.archives`) and the daily SSGA
 * holdings file (`ssga.holdings`). They arrive on different dates, so "the holdings as of D" is
 * **per source**: the greatest `as_of_date ≤ D` for each `(etf_instrument_id, source_id)`, never a
 * `max()` across sources that would silently drop the fund whose file is a week older.
 *
 * `holders(id)` is the same table read the other way — every fund whose latest file lists `id` —
 * and is the only ownership source in v1. There is no 13F feed (BRIEF §2); this module returns
 * what the ingested fund files say and nothing else. A caller that wants the
 * `13F_NOT_AVAILABLE` note adds it; a data service does not fabricate an institutional line.
 *
 * ### Index membership as holdings (WP-04 L707)
 *
 * An **index** has constituents, not holdings: `index_members` is bitemporal (a roster is true over
 * a valid range and known from a transaction time) while `etf_holdings` is a file snapshot. For the
 * screens that render either through one grid, `membershipAsHoldings` projects the bitemporal
 * roster into the `EtfHolding` shape, and `etfHoldings` falls back to it when the instrument has no
 * holdings file of its own but is an index. `sourceId` on those rows is the index's own
 * `indices.membership_source_id`, so the attribution stays truthful about where the roster came
 * from.
 *
 * Provenance: every row carries the `provenance_id` of the file (or roster version) it came from,
 * plus that provenance row's `capturedAt`/`sourceTs`.
 */

import { sql } from 'drizzle-orm';

import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One line of a fund holdings file (`etf_holdings`), or one projected index constituent. */
export interface EtfHolding {
  etfInstrumentId: number;
  asOfDate: string;
  sourceId: string;
  lineNo: number;
  /** `null` when the line did not resolve — the job wrote a `data_exceptions` row for it. */
  holdingInstrumentId: number | null;
  name: string;
  cusip: string | null;
  isin: string | null;
  lei: string | null;
  sedol: string | null;
  ticker: string | null;
  shares: number | null;
  marketValue: number | null;
  /** Fraction, not percent. */
  weight: number | null;
  assetCat: string | null;
  issuerCat: string | null;
  country: string | null;
  provenanceId: number;
  capturedAt: string;
  sourceTs: string | null;
}

/** One fund that holds the requested instrument. */
export interface Holder {
  /** The fund. */
  holderInstrumentId: number;
  holderName: string;
  /** `'SPY US Equity'` when the fund is itself in the universe; `null` otherwise. */
  holderKey: string | null;
  /** Only `'etf'` in v1: there is no 13F source. */
  holderKind: 'etf';
  shares: number | null;
  marketValue: number | null;
  /** The holding's weight **inside the holder's** portfolio, as a fraction. */
  weightInHolder: number | null;
  asOfDate: string;
  sourceId: string;
  provenanceId: number;
  capturedAt: string;
  sourceTs: string | null;
}

/** `DataServices.holdings.holders` result. */
export interface HoldersResponse {
  instrumentId: number;
  /** The newest file date any holder reported; `null` when nothing holds it. */
  asOfDate: string | null;
  /** Distinct source ids across the returned holders. */
  sources: string[];
  holders: Holder[];
  /** Σ shares and Σ market value over `holders`, `null` when no holder reported the column. */
  totals: { shares: number | null; marketValue: number | null; holderCount: number };
}

/** The service as `DataServices.holdings` declares it. */
export interface HoldingsService {
  holders(id: number, asOfDate?: string): Promise<HoldersResponse>;
  etfHoldings(etfId: number, asOfDate?: string): Promise<EtfHolding[]>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conversions
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, what: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(`data/holdings: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function reqIso(value: Date | string, what: string): string {
  const s = iso(value);
  if (s === null) throw new TypeError(`data/holdings: ${what} is null`);
  return s;
}

/** The UTC calendar date of an instant — the default as-of date of a read. */
function dateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// etf_holdings
// ─────────────────────────────────────────────────────────────────────────────────────────────

type HoldingRow = {
  etf_instrument_id: string;
  as_of_date: string;
  source_id: string;
  line_no: number;
  holding_instrument_id: string | null;
  name: string;
  cusip: string | null;
  isin: string | null;
  lei: string | null;
  sedol: string | null;
  ticker: string | null;
  shares: string | null;
  market_value: string | null;
  weight: string | null;
  asset_cat: string | null;
  issuer_cat: string | null;
  country: string | null;
  provenance_id: string;
  captured_at: Date;
  source_ts: Date | null;
};

function toHolding(row: HoldingRow): EtfHolding {
  return {
    etfInstrumentId: Number(row.etf_instrument_id),
    asOfDate: row.as_of_date,
    sourceId: row.source_id,
    lineNo: Number(row.line_no),
    holdingInstrumentId:
      row.holding_instrument_id === null ? null : Number(row.holding_instrument_id),
    name: row.name,
    cusip: row.cusip,
    isin: row.isin,
    lei: row.lei,
    sedol: row.sedol,
    ticker: row.ticker,
    shares: num(row.shares),
    marketValue: num(row.market_value),
    weight: num(row.weight),
    assetCat: row.asset_cat,
    issuerCat: row.issuer_cat,
    country: row.country,
    provenanceId: Number(row.provenance_id),
    capturedAt: reqIso(row.captured_at, 'captured_at'),
    sourceTs: iso(row.source_ts),
  };
}

const HOLDING_COLUMNS = sql`
  h.etf_instrument_id::text AS etf_instrument_id, h.as_of_date::text AS as_of_date, h.source_id,
  h.line_no, h.holding_instrument_id::text AS holding_instrument_id, h.name, h.cusip, h.isin,
  h.lei, h.sedol, h.ticker, h.shares::text AS shares, h.market_value::text AS market_value,
  h.weight::text AS weight, h.asset_cat, h.issuer_cat, h.country,
  h.provenance_id::text AS provenance_id, p.captured_at, p.source_ts`;

/**
 * The holdings file(s) of `etfId` as of `asOfDate` — one file per source, each the greatest
 * `as_of_date ≤ asOfDate`. Empty when the fund has no ingested file (and is not an index; see
 * {@link readEtfHoldings}).
 */
export async function holdingsFiles(
  tx: Tx,
  etfId: number,
  onOrBefore: string,
): Promise<EtfHolding[]> {
  const res = await tx.execute<HoldingRow>(sql`
    WITH latest AS (
      SELECT source_id, max(as_of_date) AS as_of_date
        FROM etf_holdings
       WHERE etf_instrument_id = ${etfId}::bigint
         AND as_of_date <= ${assertDate(onOrBefore, 'asOfDate')}::date
       GROUP BY source_id
    )
    SELECT ${HOLDING_COLUMNS}
      FROM etf_holdings h
      JOIN latest l ON l.source_id = h.source_id AND l.as_of_date = h.as_of_date
      JOIN provenance p ON p.provenance_id = h.provenance_id
     WHERE h.etf_instrument_id = ${etfId}::bigint
     ORDER BY h.source_id, h.line_no`);
  return res.rows.map(toHolding);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Index membership projected into the holdings shape
// ─────────────────────────────────────────────────────────────────────────────────────────────

type MemberRow = {
  instrument_id: string | null;
  name: string | null;
  ticker: string | null;
  weight: string | null;
  shares: string | null;
  market_value: string | null;
  as_of_date: string;
  source_id: string;
  provenance_id: string;
  captured_at: Date;
  source_ts: Date | null;
};

/**
 * `index_members` of the index whose tracked instrument is `indexInstrumentId`, projected into
 * `EtfHolding`. The roster is read through `bt_as_of(...)`, so a past-dated read returns the
 * constituents as they were known then (REF-07, REF-03).
 *
 * `lineNo` is assigned by descending weight, which is the order the grid renders and is stable for
 * one roster; it is **not** a file line number, because a roster has no file.
 */
export async function membershipAsHoldings(
  tx: Tx,
  at: AsOf,
  indexInstrumentId: number,
): Promise<EtfHolding[]> {
  const res = await tx.execute<MemberRow>(sql`
    SELECT m.instrument_id::text AS instrument_id,
           i.name, i.ticker,
           m.weight::text AS weight, m.shares::text AS shares,
           m.market_value::text AS market_value, m.as_of_date::text AS as_of_date,
           m.source_id, m.provenance_id::text AS provenance_id, p.captured_at, p.source_ts
      FROM index_members m
      JOIN indices idx ON idx.index_id = m.index_id
      JOIN provenance p ON p.provenance_id = m.provenance_id
      LEFT JOIN instruments i
             ON i.instrument_id = m.instrument_id
            AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                         ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
     WHERE idx.instrument_id = ${indexInstrumentId}::bigint
       AND bt_as_of(m.valid_from, m.valid_to, m.tx_from, m.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
     ORDER BY m.weight DESC NULLS LAST, m.instrument_id`);
  return res.rows.map((row, i) => ({
    etfInstrumentId: indexInstrumentId,
    asOfDate: row.as_of_date,
    sourceId: row.source_id,
    lineNo: i + 1,
    holdingInstrumentId: row.instrument_id === null ? null : Number(row.instrument_id),
    name: row.name ?? row.ticker ?? '',
    cusip: null,
    isin: null,
    lei: null,
    sedol: null,
    ticker: row.ticker,
    shares: num(row.shares),
    marketValue: num(row.market_value),
    weight: num(row.weight),
    assetCat: null,
    issuerCat: null,
    country: null,
    provenanceId: Number(row.provenance_id),
    capturedAt: reqIso(row.captured_at, 'captured_at'),
    sourceTs: iso(row.source_ts),
  }));
}

/**
 * `DataServices.holdings.etfHoldings`.
 *
 * The fund's own file(s) when it has any; otherwise, when the instrument is an index, its roster
 * projected into the same shape. An instrument that is neither returns `[]` — an empty holdings
 * list is a legitimate answer and the caller renders `HOLDERS_LIMITED_TO_SEEDED_FUNDS`.
 */
export async function readEtfHoldings(
  tx: Tx,
  at: AsOf,
  etfId: number,
  asOfDate?: string,
): Promise<EtfHolding[]> {
  const onOrBefore = asOfDate === undefined ? dateOf(at.validAt) : assertDate(asOfDate, 'asOfDate');
  const files = await holdingsFiles(tx, etfId, onOrBefore);
  if (files.length > 0) return files;
  return membershipAsHoldings(tx, at, etfId);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Holders (the inverse read)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type HolderRow = {
  etf_instrument_id: string;
  as_of_date: string;
  source_id: string;
  shares: string | null;
  market_value: string | null;
  weight: string | null;
  provenance_id: string;
  captured_at: Date;
  source_ts: Date | null;
  holder_name: string | null;
  holder_ticker: string | null;
  holder_exch: string | null;
  holder_sector: string | null;
};

/**
 * `DataServices.holdings.holders` — every fund whose latest file at or before `asOfDate` lists
 * `id`, heaviest weight first.
 *
 * The `latest` CTE is per `(etf_instrument_id, source_id)`: two funds whose files are days apart
 * both appear, each citing its own file date. A fund that dropped the name from its newest file
 * does **not** appear, because the join is against that newest file only.
 */
export async function readHolders(
  tx: Tx,
  at: AsOf,
  id: number,
  asOfDate?: string,
): Promise<HoldersResponse> {
  const onOrBefore = asOfDate === undefined ? dateOf(at.validAt) : assertDate(asOfDate, 'asOfDate');
  const res = await tx.execute<HolderRow>(sql`
    WITH latest AS (
      SELECT etf_instrument_id, source_id, max(as_of_date) AS as_of_date
        FROM etf_holdings
       WHERE as_of_date <= ${onOrBefore}::date
       GROUP BY etf_instrument_id, source_id
    )
    SELECT h.etf_instrument_id::text AS etf_instrument_id, h.as_of_date::text AS as_of_date,
           h.source_id, h.shares::text AS shares, h.market_value::text AS market_value,
           h.weight::text AS weight, h.provenance_id::text AS provenance_id,
           p.captured_at, p.source_ts,
           i.name AS holder_name, i.ticker AS holder_ticker, i.exch_code AS holder_exch,
           i.market_sector::text AS holder_sector
      FROM etf_holdings h
      JOIN latest l ON l.etf_instrument_id = h.etf_instrument_id
                   AND l.source_id = h.source_id
                   AND l.as_of_date = h.as_of_date
      JOIN provenance p ON p.provenance_id = h.provenance_id
      LEFT JOIN instruments i
             ON i.instrument_id = h.etf_instrument_id
            AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                         ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
     WHERE h.holding_instrument_id = ${id}::bigint
     ORDER BY h.weight DESC NULLS LAST, h.etf_instrument_id, h.source_id`);

  const holders: Holder[] = res.rows.map((row) => ({
    holderInstrumentId: Number(row.etf_instrument_id),
    holderName: row.holder_name ?? row.holder_ticker ?? '',
    holderKey:
      row.holder_ticker === null || row.holder_exch === null || row.holder_sector === null
        ? null
        : `${row.holder_ticker} ${row.holder_exch} ${row.holder_sector}`,
    holderKind: 'etf',
    shares: num(row.shares),
    marketValue: num(row.market_value),
    weightInHolder: num(row.weight),
    asOfDate: row.as_of_date,
    sourceId: row.source_id,
    provenanceId: Number(row.provenance_id),
    capturedAt: reqIso(row.captured_at, 'captured_at'),
    sourceTs: iso(row.source_ts),
  }));

  let shares: number | null = null;
  let marketValue: number | null = null;
  let newest: string | null = null;
  for (const holder of holders) {
    if (holder.shares !== null) shares = (shares ?? 0) + holder.shares;
    if (holder.marketValue !== null) marketValue = (marketValue ?? 0) + holder.marketValue;
    if (newest === null || holder.asOfDate > newest) newest = holder.asOfDate;
  }

  return {
    instrumentId: id,
    asOfDate: newest,
    sources: [...new Set(holders.map((holder) => holder.sourceId))].sort(),
    holders,
    totals: { shares, marketValue, holderCount: holders.length },
  };
}

/** `DataServices.holdings`, bound to one transaction and one `(validAt, knownAt)` pair. */
export function holdingsService(tx: Tx, at: AsOf): HoldingsService {
  return {
    holders: (id, asOfDate) => readHolders(tx, at, id, asOfDate),
    etfHoldings: (etfId, asOfDate) => readEtfHoldings(tx, at, etfId, asOfDate),
  };
}
