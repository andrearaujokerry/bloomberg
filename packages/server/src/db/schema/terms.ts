/**
 * Instrument terms by asset class — mirrors `drizzle/migrations/0004_terms.sql`.
 * All seven tables are bitemporal and keyed on instrument_id.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { provenance } from './provenance.js';

/** US Treasury bills/notes/bonds/TIPS/FRNs (REF-04). */
export const govtTerms = pgTable(
  'govt_terms',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    securityType: text('security_type').notNull(),
    cusip: char('cusip', { length: 9 }).notNull(),
    termLabel: text('term_label'),
    issueDate: date('issue_date', { mode: 'string' }),
    datedDate: date('dated_date', { mode: 'string' }),
    maturityDate: date('maturity_date', { mode: 'string' }).notNull(),
    couponType: text('coupon_type').notNull().default('fixed'),
    couponRate: numeric('coupon_rate', { precision: 9, scale: 6 }),
    couponFreq: smallint('coupon_freq').notNull().default(2),
    dayCount: text('day_count').notNull(),
    firstCouponDate: date('first_coupon_date', { mode: 'string' }),
    lastRegularCoupon: date('last_regular_coupon', { mode: 'string' }),
    businessDayConv: text('business_day_conv').notNull().default('following'),
    calendarId: text('calendar_id').notNull().default('SIFMA'),
    settlementDays: smallint('settlement_days').notNull().default(1),
    referenceIndex: text('reference_index'),
    spreadBp: numeric('spread_bp', { precision: 9, scale: 4 }),
    indexRatioBase: numeric('index_ratio_base', { precision: 14, scale: 8 }),
    isCallable: boolean('is_callable').notNull().default(false),
    callSchedule: jsonb('call_schedule')
      .notNull()
      .default(sql`'[]'::jsonb`),
    putSchedule: jsonb('put_schedule')
      .notNull()
      .default(sql`'[]'::jsonb`),
    sinkSchedule: jsonb('sink_schedule')
      .notNull()
      .default(sql`'[]'::jsonb`),
    amortisation: jsonb('amortisation')
      .notNull()
      .default(sql`'[]'::jsonb`),
    makeWhole: jsonb('make_whole'),
    covenants: text('covenants'),
    guarantors: text('guarantors')
      .array()
      .notNull()
      .default(sql`'{}'`),
    seniority: text('seniority').notNull().default('sovereign'),
    collateral: text('collateral'),
    minDenomination: numeric('min_denomination', { precision: 14, scale: 2 })
      .notNull()
      .default('100'),
    increment: numeric('increment', { precision: 14, scale: 2 }).notNull().default('100'),
    amountOutstanding: numeric('amount_outstanding', { precision: 28, scale: 2 }),
    onTheRun: boolean('on_the_run').notNull().default(false),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('govt_terms_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
    index('govt_terms_maturity_idx')
      .on(t.maturityDate)
      .where(sql`tx_to = 'infinity'`),
    index('govt_terms_cusip_idx')
      .on(t.cusip)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** Listed US equity options (Cboe chain) (REF-05). */
export const optionTerms = pgTable(
  'option_terms',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    occSymbol: varchar('occ_symbol', { length: 21 }).notNull(),
    root: text('root').notNull(),
    underlyingInstrumentId: bigint('underlying_instrument_id', { mode: 'number' }).notNull(),
    expiry: date('expiry', { mode: 'string' }).notNull(),
    strike: numeric('strike', { precision: 14, scale: 4 }).notNull(),
    putCall: char('put_call', { length: 1 }).notNull(),
    exerciseStyle: text('exercise_style').notNull().default('american'),
    settlement: text('settlement').notNull().default('physical'),
    amPmSettlement: char('am_pm_settlement', { length: 2 }).notNull().default('pm'),
    multiplier: integer('multiplier').notNull().default(100),
    tickSize: numeric('tick_size', { precision: 8, scale: 4 }),
    exerciseCutoffLocal: time('exercise_cutoff_local').notNull().default('17:30'),
    isWeekly: boolean('is_weekly').notNull().default(false),
    lastTradeDate: date('last_trade_date', { mode: 'string' }),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('option_terms_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
    index('option_terms_chain_idx')
      .on(t.underlyingInstrumentId, t.expiry, t.strike, t.putCall)
      .where(sql`tx_to = 'infinity'`),
    index('option_terms_occ_idx')
      .on(t.occSymbol)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** Shape only in v1 (no futures source) (REF-05). */
export const futureTerms = pgTable(
  'future_terms',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    root: text('root').notNull(),
    underlyingInstrumentId: bigint('underlying_instrument_id', { mode: 'number' }),
    exchangeMic: char('exchange_mic', { length: 4 }),
    expiry: date('expiry', { mode: 'string' }).notNull(),
    lastTradeDate: date('last_trade_date', { mode: 'string' }),
    firstNoticeDate: date('first_notice_date', { mode: 'string' }),
    firstDeliveryDate: date('first_delivery_date', { mode: 'string' }),
    multiplier: numeric('multiplier', { precision: 14, scale: 4 }).notNull(),
    tickSize: numeric('tick_size', { precision: 10, scale: 6 }).notNull(),
    tickValue: numeric('tick_value', { precision: 14, scale: 6 }),
    settlement: text('settlement').notNull(),
    deliveryMonths: text('delivery_months')
      .array()
      .notNull()
      .default(sql`'{}'`),
    rollConvention: jsonb('roll_convention'),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('future_terms_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** ETFs (SPY: N-PORT filer CIK 0000884394). */
export const fundTerms = pgTable(
  'fund_terms',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    fundType: text('fund_type').notNull().default('etf'),
    trackedIndexInstrumentId: bigint('tracked_index_instrument_id', { mode: 'number' }),
    sponsor: text('sponsor'),
    cik: char('cik', { length: 10 }),
    seriesId: text('series_id'),
    expenseRatio: numeric('expense_ratio', { precision: 8, scale: 6 }),
    inceptionDate: date('inception_date', { mode: 'string' }),
    distributionFreq: text('distribution_freq'),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('fund_terms_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
  ],
);

export const indexTerms = pgTable(
  'index_terms',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    provider: text('provider').notNull(),
    methodology: text('methodology').notNull(),
    calcCurrency: char('calc_currency', { length: 3 }).notNull(),
    region: text('region'),
    baseDate: date('base_date', { mode: 'string' }),
    baseValue: numeric('base_value', { precision: 14, scale: 4 }),
    constituentCount: integer('constituent_count'),
    proxyFundInstrumentId: bigint('proxy_fund_instrument_id', { mode: 'number' }),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('index_terms_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
  ],
);

export const fxTerms = pgTable(
  'fx_terms',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    baseCcy: char('base_ccy', { length: 3 }).notNull(),
    quoteCcy: char('quote_ccy', { length: 3 }).notNull(),
    spotLag: smallint('spot_lag').notNull().default(2),
    calendarId: text('calendar_id').notNull().default('FX_USD'),
    pipSize: numeric('pip_size', { precision: 10, scale: 8 }).notNull().default('0.0001'),
    quoteConvention: text('quote_convention').notNull().default('quote_per_base'),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('fx_terms_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** SOFR, EFFR, OBFR, TGCR, BGCR, SOFRAI. */
export const rateTerms = pgTable(
  'rate_terms',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    rateCode: text('rate_code').notNull(),
    publisher: text('publisher').notNull(),
    dayCount: text('day_count').notNull().default('ACT/360'),
    publicationTimeEt: time('publication_time_et'),
    tenorDays: integer('tenor_days').notNull().default(1),
    compounding: text('compounding').notNull().default('simple'),
    seriesId: bigint('series_id', { mode: 'number' }),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('rate_terms_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
  ],
);
