/**
 * Market data time series — mirrors `drizzle/migrations/0007_market_data.sql`.
 *
 * `bars_daily`, `bars_intraday`, `quote_ticks` and `option_quotes` are declared
 * PARTITION BY RANGE in SQL. Drizzle 0.45 cannot express partitioning, so they are
 * declared here as ordinary tables; their partitions (created by 0016 and by the
 * partition maintenance job) are NOT mirrored and belong on the drift allowlist.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sessionStateEnum } from './enums.js';
import { provenance } from './provenance.js';

/** UNADJUSTED always (REF-09: adjust on read); one truth row per instrument-day. */
export const barsDaily = pgTable(
  'bars_daily',
  {
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    sessionDate: date('session_date', { mode: 'string' }).notNull(),
    mdLineId: bigint('md_line_id', { mode: 'number' }).notNull(),
    open: numeric('open', { precision: 18, scale: 6 }),
    high: numeric('high', { precision: 18, scale: 6 }),
    low: numeric('low', { precision: 18, scale: 6 }),
    close: numeric('close', { precision: 18, scale: 6 }).notNull(),
    volume: bigint('volume', { mode: 'number' }),
    vwap: numeric('vwap', { precision: 18, scale: 6 }),
    tradeCount: integer('trade_count'),
    officialClose: numeric('official_close', { precision: 18, scale: 6 }),
    srcAdjClose: numeric('src_adj_close', { precision: 18, scale: 6 }),
    sourceTs: timestamp('source_ts', { withTimezone: true, mode: 'string' }),
    captureTs: timestamp('capture_ts', { withTimezone: true, mode: 'string' }).notNull(),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({ columns: [t.instrumentId, t.sessionDate] }),
    index('bars_daily_date_idx').on(t.sessionDate, t.instrumentId),
  ],
);

export const barsIntraday = pgTable(
  'bars_intraday',
  {
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    barInterval: text('bar_interval').notNull(),
    barTs: timestamp('bar_ts', { withTimezone: true, mode: 'string' }).notNull(),
    mdLineId: bigint('md_line_id', { mode: 'number' }).notNull(),
    open: numeric('open', { precision: 18, scale: 6 }),
    high: numeric('high', { precision: 18, scale: 6 }),
    low: numeric('low', { precision: 18, scale: 6 }),
    close: numeric('close', { precision: 18, scale: 6 }).notNull(),
    volume: bigint('volume', { mode: 'number' }),
    session: text('session').notNull().default('regular'),
    isFinal: boolean('is_final').notNull().default(false),
    captureTs: timestamp('capture_ts', { withTimezone: true, mode: 'string' }).notNull(),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.barInterval, t.barTs] })],
);

/** STOR-01 analogue: one row per observed change of a provider line (a delayed "tick"). */
export const quoteTicks = pgTable(
  'quote_ticks',
  {
    tickId: bigint('tick_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('quote_ticks_id_seq')`),
    captureTs: timestamp('capture_ts', { withTimezone: true, mode: 'string' }).notNull(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    mdLineId: bigint('md_line_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    sourceTs: timestamp('source_ts', { withTimezone: true, mode: 'string' }),
    publishTs: timestamp('publish_ts', { withTimezone: true, mode: 'string' }),
    srcSeq: bigint('src_seq', { mode: 'number' }),
    price: numeric('price', { precision: 18, scale: 6 }),
    size: bigint('size', { mode: 'number' }),
    bid: numeric('bid', { precision: 18, scale: 6 }),
    ask: numeric('ask', { precision: 18, scale: 6 }),
    bidSize: integer('bid_size'),
    askSize: integer('ask_size'),
    open: numeric('open', { precision: 18, scale: 6 }),
    high: numeric('high', { precision: 18, scale: 6 }),
    low: numeric('low', { precision: 18, scale: 6 }),
    prevClose: numeric('prev_close', { precision: 18, scale: 6 }),
    volume: bigint('volume', { mode: 'number' }),
    iv30: numeric('iv30', { precision: 10, scale: 6 }),
    tickDir: char('tick_dir', { length: 1 }),
    conditions: text('conditions')
      .array()
      .notNull()
      .default(sql`'{}'`),
    sessionState: sessionStateEnum('session_state'),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({ columns: [t.captureTs, t.tickId] }),
    index('quote_ticks_instrument_idx').on(t.instrumentId, t.captureTs.desc()),
    index('quote_ticks_line_idx').on(t.mdLineId, t.captureTs.desc()),
  ],
);

/** Cboe chain snapshots (greeks/IV as published). */
export const optionQuotes = pgTable(
  'option_quotes',
  {
    captureTs: timestamp('capture_ts', { withTimezone: true, mode: 'string' }).notNull(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    underlyingInstrumentId: bigint('underlying_instrument_id', { mode: 'number' }).notNull(),
    mdLineId: bigint('md_line_id', { mode: 'number' }).notNull(),
    bid: numeric('bid', { precision: 14, scale: 4 }),
    ask: numeric('ask', { precision: 14, scale: 4 }),
    bidSize: integer('bid_size'),
    askSize: integer('ask_size'),
    last: numeric('last', { precision: 14, scale: 4 }),
    lastTs: timestamp('last_ts', { withTimezone: true, mode: 'string' }),
    prevClose: numeric('prev_close', { precision: 14, scale: 6 }),
    volume: integer('volume'),
    openInterest: integer('open_interest'),
    iv: numeric('iv', { precision: 10, scale: 6 }),
    delta: numeric('delta', { precision: 10, scale: 6 }),
    gamma: numeric('gamma', { precision: 12, scale: 8 }),
    vega: numeric('vega', { precision: 12, scale: 6 }),
    theta: numeric('theta', { precision: 12, scale: 6 }),
    rho: numeric('rho', { precision: 12, scale: 6 }),
    theo: numeric('theo', { precision: 14, scale: 6 }),
    underlyingPx: numeric('underlying_px', { precision: 18, scale: 6 }),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({ columns: [t.captureTs, t.instrumentId] }),
    index('option_quotes_underlying_idx').on(t.underlyingInstrumentId, t.captureTs.desc()),
    index('option_quotes_contract_idx').on(t.instrumentId, t.captureTs.desc()),
  ],
);

/** Warm tier: last composite QuoteState per instrument (STOR-05, BUS-01). */
export const quoteSnapshots = pgTable('quote_snapshots', {
  instrumentId: bigint('instrument_id', { mode: 'number' }).primaryKey(),
  subject: text('subject').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  state: jsonb('state').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

/** Serves the 'eod' tier and the missing-close DQ check (BUS-06, OPS-03). */
export const eodSnapshots = pgTable(
  'eod_snapshots',
  {
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    sessionDate: date('session_date', { mode: 'string' }).notNull(),
    fields: jsonb('fields').notNull(),
    closeTs: timestamp('close_ts', { withTimezone: true, mode: 'string' }).notNull(),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.sessionDate] })],
);

/** ECB reference rates via frankfurter, for currency conversion in CHRT-03 / PORT. */
export const fxRates = pgTable(
  'fx_rates',
  {
    baseCcy: char('base_ccy', { length: 3 }).notNull(),
    quoteCcy: char('quote_ccy', { length: 3 }).notNull(),
    rateDate: date('rate_date', { mode: 'string' }).notNull(),
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    sourceId: text('source_id').notNull(),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [primaryKey({ columns: [t.baseCcy, t.quoteCcy, t.rateDate, t.sourceId] })],
);

/** FINRA consolidated short interest. */
export const shortInterest = pgTable(
  'short_interest',
  {
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    settlementDate: date('settlement_date', { mode: 'string' }).notNull(),
    shortQty: bigint('short_qty', { mode: 'number' }),
    prevShortQty: bigint('prev_short_qty', { mode: 'number' }),
    avgDailyVolume: bigint('avg_daily_volume', { mode: 'number' }),
    daysToCover: numeric('days_to_cover', { precision: 10, scale: 2 }),
    changePct: numeric('change_pct', { precision: 10, scale: 4 }),
    revision: boolean('revision').notNull().default(false),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.settlementDate] })],
);

/** N-PORT / SSGA holdings (HDS fallback; MEMB source rows). */
export const etfHoldings = pgTable(
  'etf_holdings',
  {
    etfInstrumentId: bigint('etf_instrument_id', { mode: 'number' }).notNull(),
    asOfDate: date('as_of_date', { mode: 'string' }).notNull(),
    sourceId: text('source_id').notNull(),
    lineNo: integer('line_no').notNull(),
    holdingInstrumentId: bigint('holding_instrument_id', { mode: 'number' }),
    name: text('name').notNull(),
    cusip: char('cusip', { length: 9 }),
    isin: char('isin', { length: 12 }),
    lei: char('lei', { length: 20 }),
    sedol: char('sedol', { length: 7 }),
    ticker: text('ticker'),
    shares: numeric('shares', { precision: 20, scale: 4 }),
    marketValue: numeric('market_value', { precision: 20, scale: 2 }),
    weight: numeric('weight', { precision: 12, scale: 10 }),
    assetCat: text('asset_cat'),
    issuerCat: text('issuer_cat'),
    country: char('country', { length: 2 }),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({ columns: [t.etfInstrumentId, t.asOfDate, t.sourceId, t.lineNo] }),
    index('etf_holdings_holding_idx')
      .on(t.holdingInstrumentId, t.asOfDate.desc())
      .where(sql`holding_instrument_id IS NOT NULL`),
  ],
);

/** ANAL-04 historical surface storage (derived; SVI per expiry). */
export const volSurfaces = pgTable(
  'vol_surfaces',
  {
    underlyingInstrumentId: bigint('underlying_instrument_id', { mode: 'number' }).notNull(),
    asOf: timestamp('as_of', { withTimezone: true, mode: 'string' }).notNull(),
    expiry: date('expiry', { mode: 'string' }).notNull(),
    forward: numeric('forward', { precision: 18, scale: 6 }).notNull(),
    atmIv: numeric('atm_iv', { precision: 10, scale: 6 }),
    svi: jsonb('svi').notNull(),
    engineName: text('engine_name').notNull(),
    engineVersion: text('engine_version').notNull(),
    inputsHash: char('inputs_hash', { length: 64 }).notNull(),
    provenanceIds: bigint('provenance_ids', { mode: 'number' }).array().notNull(),
  },
  (t) => [primaryKey({ columns: [t.underlyingInstrumentId, t.asOf, t.expiry] })],
);
