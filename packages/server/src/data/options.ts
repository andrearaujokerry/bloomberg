/**
 * `data/options.ts` — listed option terms and the chain snapshot (WORKPLAN §WP-04 L706-709,
 * FUNCTIONS.md §1.4.2 L304, FUNCTIONS_TIER3 §0.1; OMON/OVME consume it).
 *
 * `option_terms` is bitemporal, so every read goes through the `bt_as_of(...)` predicate of
 * DATA_MODEL §1.3: a contract that was re-stated (a corrected strike, a late `last_trade_date`)
 * reads back as it stood at `knownAt`. `option_quotes` is a capture-time partitioned fact table,
 * so the quote side is "the newest capture at or before `validAt`", one row per contract.
 *
 * Three numbers on the underlying block are derived, and each is derived from a **stored** row or
 * left `null` — nothing here fabricates a value:
 *
 *  - `px` is `option_quotes.underlying_px` of the newest capture in the chain. That is the
 *    underlying print the chain was quoted against, which is the only price the greeks in the same
 *    row are consistent with.
 *  - `chgPct` is `px / prevClose − 1` where `prevClose` is the last `bars_daily.close` **strictly
 *    before** the capture's session date. No bar ⇒ `null`.
 *  - `iv30` is `vol_surfaces.atm_iv` of the expiry closest to 30 days at the newest surface
 *    `as_of ≤ validAt` (ANAL-04). No surface ⇒ `null`; this module never solves for one.
 *
 * Provenance: every contract quote carries the `provenance_id` of its capture; the underlying block
 * carries the capture's, or — when the underlying has no quote at all — the `provenance_id` of the
 * `instruments` version the display name came from, so the block is never uncited.
 */

import { MARKET_SECTORS, formatSecurityRef } from '@terminal/core';
import { sql } from 'drizzle-orm';

import type { MarketSector } from '@terminal/core';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes (FUNCTIONS_TIER3 §0.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One listed contract's terms, as `option_terms` holds them. */
export interface OptionTerms {
  instrumentId: number;
  occSymbol: string;
  root: string;
  underlyingInstrumentId: number;
  expiry: string;
  strike: number;
  putCall: 'C' | 'P';
  exerciseStyle: 'american' | 'european';
  settlement: 'physical' | 'cash';
  amPm: 'am' | 'pm';
  multiplier: number;
  tickSize: number | null;
  isWeekly: boolean;
  lastTradeDate: string | null;
  provenanceId: number;
}

/** One contract's newest quote at or before `validAt`. */
export interface OptionQuote {
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  last: number | null;
  lastTs: string | null;
  prevClose: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  rho: number | null;
  theo: number | null;
  underlyingPx: number | null;
  provenanceId: number;
  captureTs: string;
}

/** `DataServices.options.chain` result. */
export interface ChainSnapshot {
  underlying: {
    instrumentId: number;
    display: string;
    px: number | null;
    chgPct: number | null;
    iv30: number | null;
    provenanceId: number;
    capturedAt: string;
    sourceTs: string | null;
  };
  /** The newest capture instant in the chain; the underlying's capture when the chain is empty. */
  captureTs: string;
  /** The whole expiry ladder of the underlying, ascending — not filtered by `expiry`. */
  expiries: { expiry: string; contractCount: number }[];
  /** Filtered to `expiry` when one was given; ascending in `(expiry, strike, putCall)`. */
  contracts: (OptionTerms & { q: OptionQuote | null })[];
}

/** Raised rather than returning an empty chain for an instrument that does not exist. */
export class OptionDataError extends Error {
  readonly code: 'underlying_not_found' | 'contract_not_found';
  constructor(code: OptionDataError['code'], message: string) {
    super(message);
    this.name = 'OptionDataError';
    this.code = code;
  }
}

/** The service as `DataServices.options` declares it. */
export interface OptionsService {
  chain(underlyingId: number, expiry?: string): Promise<ChainSnapshot>;
  terms(contractId: number): Promise<OptionTerms>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conversions
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, what: string): string {
  if (!DATE_RE.test(value)) {
    throw new RangeError(`data/options: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  return value;
}

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function reqNum(value: string | number | null, what: string): number {
  const n = num(value);
  if (n === null) throw new TypeError(`data/options: ${what} is not a finite number`);
  return n;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function reqIso(value: Date | string, what: string): string {
  const s = iso(value);
  if (s === null) throw new TypeError(`data/options: ${what} is null`);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Terms
// ─────────────────────────────────────────────────────────────────────────────────────────────

type TermsRow = {
  instrument_id: string;
  occ_symbol: string;
  root: string;
  underlying_instrument_id: string;
  expiry: string;
  strike: string;
  put_call: string;
  exercise_style: string;
  settlement: string;
  am_pm_settlement: string;
  multiplier: number;
  tick_size: string | null;
  is_weekly: boolean;
  last_trade_date: string | null;
  provenance_id: string;
};

const TERMS_COLUMNS = sql`
  t.instrument_id::text AS instrument_id, t.occ_symbol, t.root,
  t.underlying_instrument_id::text AS underlying_instrument_id,
  t.expiry::text AS expiry, t.strike::text AS strike, t.put_call,
  t.exercise_style, t.settlement, t.am_pm_settlement, t.multiplier,
  t.tick_size::text AS tick_size, t.is_weekly, t.last_trade_date::text AS last_trade_date,
  t.provenance_id::text AS provenance_id`;

function toTerms(row: TermsRow): OptionTerms {
  return {
    instrumentId: Number(row.instrument_id),
    occSymbol: row.occ_symbol,
    root: row.root,
    underlyingInstrumentId: Number(row.underlying_instrument_id),
    expiry: row.expiry,
    strike: reqNum(row.strike, 'strike'),
    putCall: row.put_call === 'P' ? 'P' : 'C',
    exerciseStyle: row.exercise_style === 'european' ? 'european' : 'american',
    settlement: row.settlement === 'cash' ? 'cash' : 'physical',
    amPm: row.am_pm_settlement === 'am' ? 'am' : 'pm',
    multiplier: Number(row.multiplier),
    tickSize: num(row.tick_size),
    isWeekly: row.is_weekly,
    lastTradeDate: row.last_trade_date,
    provenanceId: Number(row.provenance_id),
  };
}

/** The `bt_as_of(...)` predicate over `option_terms`, aliased `t`. */
const termsAsOf = (at: AsOf) => sql`bt_as_of(t.valid_from, t.valid_to, t.tx_from, t.tx_to,
                                             ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)`;

/** `DataServices.options.terms`. @throws OptionDataError when the contract is unknown then. */
export async function contractTerms(tx: Tx, at: AsOf, contractId: number): Promise<OptionTerms> {
  const res = await tx.execute<TermsRow>(sql`
    SELECT ${TERMS_COLUMNS}
      FROM option_terms t
     WHERE t.instrument_id = ${contractId}::bigint
       AND ${termsAsOf(at)}
     LIMIT 1`);
  const row = res.rows[0];
  if (row === undefined) {
    throw new OptionDataError(
      'contract_not_found',
      `data/options: contract ${contractId} has no option_terms version valid at ` +
        `${at.validAt.toISOString()} known at ${at.knownAt.toISOString()}`,
    );
  }
  return toTerms(row);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Chain
// ─────────────────────────────────────────────────────────────────────────────────────────────

type QuoteRow = {
  instrument_id: string;
  capture_ts: Date;
  bid: string | null;
  ask: string | null;
  bid_size: number | null;
  ask_size: number | null;
  last: string | null;
  last_ts: Date | null;
  prev_close: string | null;
  volume: number | null;
  open_interest: number | null;
  iv: string | null;
  delta: string | null;
  gamma: string | null;
  vega: string | null;
  theta: string | null;
  rho: string | null;
  theo: string | null;
  underlying_px: string | null;
  provenance_id: string;
};

function toQuote(row: QuoteRow): OptionQuote {
  return {
    bid: num(row.bid),
    ask: num(row.ask),
    bidSize: row.bid_size,
    askSize: row.ask_size,
    last: num(row.last),
    lastTs: iso(row.last_ts),
    prevClose: num(row.prev_close),
    volume: row.volume,
    openInterest: row.open_interest,
    iv: num(row.iv),
    delta: num(row.delta),
    gamma: num(row.gamma),
    vega: num(row.vega),
    theta: num(row.theta),
    rho: num(row.rho),
    theo: num(row.theo),
    underlyingPx: num(row.underlying_px),
    provenanceId: Number(row.provenance_id),
    captureTs: reqIso(row.capture_ts, 'capture_ts'),
  };
}

type UnderlyingRow = {
  ticker: string;
  exch_code: string;
  market_sector: string;
  provenance_id: string;
  captured_at: Date;
  source_ts: Date | null;
};

/**
 * The chain of `underlyingId` at `(validAt, knownAt)`.
 *
 * @throws OptionDataError when the underlying has no `instruments` version at those instants — an
 *         empty chain for a real instrument is a legitimate answer, an empty chain for an unknown
 *         instrument id is a caller bug.
 */
export async function chainSnapshot(
  tx: Tx,
  at: AsOf,
  underlyingId: number,
  expiry?: string,
): Promise<ChainSnapshot> {
  const underlyingRes = await tx.execute<UnderlyingRow>(sql`
    SELECT i.ticker, i.exch_code, i.market_sector::text AS market_sector,
           i.provenance_id::text AS provenance_id, p.captured_at, p.source_ts
      FROM instruments i
      JOIN provenance p ON p.provenance_id = i.provenance_id
     WHERE i.instrument_id = ${underlyingId}::bigint
       AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
     LIMIT 1`);
  const underlyingRow = underlyingRes.rows[0];
  if (underlyingRow === undefined) {
    throw new OptionDataError(
      'underlying_not_found',
      `data/options: instrument ${underlyingId} has no version valid at ` +
        `${at.validAt.toISOString()} known at ${at.knownAt.toISOString()}`,
    );
  }
  const sector = (MARKET_SECTORS as readonly string[]).includes(underlyingRow.market_sector)
    ? (underlyingRow.market_sector as MarketSector)
    : undefined;
  const display = formatSecurityRef({
    kind: 'ticker',
    value: underlyingRow.ticker,
    exchCode: underlyingRow.exch_code,
    ...(sector === undefined ? {} : { sector }),
  });

  // The whole ladder, so the screen can offer every expiry even when one was asked for.
  const ladderRes = await tx.execute<{ expiry: string; n: string }>(sql`
    SELECT t.expiry::text AS expiry, count(*)::text AS n
      FROM option_terms t
     WHERE t.underlying_instrument_id = ${underlyingId}::bigint
       AND ${termsAsOf(at)}
     GROUP BY t.expiry
     ORDER BY t.expiry`);
  const expiries = ladderRes.rows.map((row) => ({
    expiry: row.expiry,
    contractCount: Number(row.n),
  }));

  const expiryFilter =
    expiry === undefined ? sql`` : sql` AND t.expiry = ${assertDate(expiry, 'expiry')}::date`;
  const termsRes = await tx.execute<TermsRow>(sql`
    SELECT ${TERMS_COLUMNS}
      FROM option_terms t
     WHERE t.underlying_instrument_id = ${underlyingId}::bigint
       AND ${termsAsOf(at)}${expiryFilter}
     ORDER BY t.expiry, t.strike, t.put_call`);
  const contracts = termsRes.rows.map(toTerms);

  // One quote per contract: the newest capture at or before `validAt`. The join is on the
  // contract's own `instrument_id`, so a chain filtered to one expiry reads only that expiry's
  // partitions' worth of rows.
  const quotes = new Map<number, OptionQuote>();
  if (contracts.length > 0) {
    const ids = contracts.map((c) => c.instrumentId);
    const quoteRes = await tx.execute<QuoteRow>(sql`
      SELECT DISTINCT ON (q.instrument_id)
             q.instrument_id::text AS instrument_id, q.capture_ts,
             q.bid::text AS bid, q.ask::text AS ask, q.bid_size, q.ask_size,
             q.last::text AS last, q.last_ts, q.prev_close::text AS prev_close,
             q.volume, q.open_interest, q.iv::text AS iv, q.delta::text AS delta,
             q.gamma::text AS gamma, q.vega::text AS vega, q.theta::text AS theta,
             q.rho::text AS rho, q.theo::text AS theo,
             q.underlying_px::text AS underlying_px, q.provenance_id::text AS provenance_id
        FROM option_quotes q
       WHERE q.instrument_id = ANY(${sql.raw(`ARRAY[${ids.join(',')}]::bigint[]`)})
         AND q.capture_ts <= ${at.validAt}::timestamptz
       ORDER BY q.instrument_id, q.capture_ts DESC`);
    for (const row of quoteRes.rows) quotes.set(Number(row.instrument_id), toQuote(row));
  }

  // The chain's capture instant and the underlying print that goes with it.
  let captureTs: string | null = null;
  let underlyingPx: number | null = null;
  let underlyingProvenanceId: number | null = null;
  for (const quote of quotes.values()) {
    if (captureTs === null || quote.captureTs > captureTs) {
      captureTs = quote.captureTs;
      underlyingPx = quote.underlyingPx;
      underlyingProvenanceId = quote.provenanceId;
    }
  }

  const capturedAt = captureTs ?? reqIso(underlyingRow.captured_at, 'provenance.captured_at');
  const chgPct =
    underlyingPx === null || captureTs === null
      ? null
      : await changePct(tx, underlyingId, underlyingPx, captureTs);
  const iv30 = await atmIv30(tx, underlyingId, at.validAt);

  return {
    underlying: {
      instrumentId: underlyingId,
      display,
      px: underlyingPx,
      chgPct,
      iv30,
      provenanceId: underlyingProvenanceId ?? Number(underlyingRow.provenance_id),
      capturedAt,
      sourceTs: iso(underlyingRow.source_ts),
    },
    captureTs: capturedAt,
    expiries,
    contracts: contracts.map((terms) => ({ ...terms, q: quotes.get(terms.instrumentId) ?? null })),
  };
}

/** `px / prevClose − 1`, where `prevClose` is the last daily close before the capture's date. */
async function changePct(
  tx: Tx,
  instrumentId: number,
  px: number,
  captureTs: string,
): Promise<number | null> {
  const res = await tx.execute<{ close: string }>(sql`
    SELECT close::text AS close
      FROM bars_daily
     WHERE instrument_id = ${instrumentId}::bigint
       AND session_date < ${captureTs}::timestamptz::date
     ORDER BY session_date DESC
     LIMIT 1`);
  const prev = num(res.rows[0]?.close ?? null);
  if (prev === null || prev === 0) return null;
  return px / prev - 1;
}

/** `vol_surfaces.atm_iv` for the expiry nearest 30 days on the newest surface at or before `at`. */
async function atmIv30(tx: Tx, underlyingId: number, validAt: Date): Promise<number | null> {
  const res = await tx.execute<{ atm_iv: string | null }>(sql`
    WITH newest AS (
      SELECT max(as_of) AS as_of
        FROM vol_surfaces
       WHERE underlying_instrument_id = ${underlyingId}::bigint
         AND as_of <= ${validAt}::timestamptz
    )
    SELECT v.atm_iv::text AS atm_iv
      FROM vol_surfaces v
      JOIN newest n ON v.as_of = n.as_of
     WHERE v.underlying_instrument_id = ${underlyingId}::bigint
       AND v.atm_iv IS NOT NULL
     ORDER BY abs((v.expiry - v.as_of::date) - 30)
     LIMIT 1`);
  return num(res.rows[0]?.atm_iv ?? null);
}

/** `DataServices.options`, bound to one transaction and one `(validAt, knownAt)` pair. */
export function optionsService(tx: Tx, at: AsOf): OptionsService {
  return {
    chain: (underlyingId, expiry) => chainSnapshot(tx, at, underlyingId, expiry),
    terms: (contractId) => contractTerms(tx, at, contractId),
  };
}
