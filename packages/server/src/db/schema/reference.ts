/**
 * Security master — mirrors `drizzle/migrations/0003_security_master.sql`.
 * Every table here is bitemporal: (valid_from, valid_to] × (tx_from, tx_to].
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
  real,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { assetClassEnum, entityKindEnum, idSchemeEnum, marketSectorEnum } from './enums.js';
import { provenance } from './provenance.js';

/** Legal entity: Apple Inc., US Treasury, SPDR Trust, an index provider, a central bank. */
export const issuers = pgTable(
  'issuers',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    issuerId: bigint('issuer_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('issuer_id_seq')`),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    lei: char('lei', { length: 20 }),
    cik: char('cik', { length: 10 }),
    country: char('country', { length: 2 }),
    stateOfInc: text('state_of_inc'),
    sic: char('sic', { length: 4 }),
    sicDescription: text('sic_description'),
    entityType: text('entity_type').notNull().default('operating'),
    fiscalYearEnd: char('fiscal_year_end', { length: 4 }),
    filerCategory: text('filer_category'),
    website: text('website'),
    formerNames: jsonb('former_names')
      .notNull()
      .default(sql`'[]'::jsonb`),
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
    index('issuers_current_idx')
      .on(t.issuerId)
      .where(sql`tx_to = 'infinity'`),
    index('issuers_lei_idx')
      .on(t.lei)
      .where(sql`tx_to = 'infinity' AND lei IS NOT NULL`),
    index('issuers_cik_idx')
      .on(t.cik)
      .where(sql`tx_to = 'infinity' AND cik IS NOT NULL`),
    index('issuers_name_trgm')
      .using('gin', sql`name gin_trgm_ops`)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** A share class / bond / fund share / index definition / fx pair / rate / series. */
export const issues = pgTable(
  'issues',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    issueId: bigint('issue_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('issue_id_seq')`),
    issuerId: bigint('issuer_id', { mode: 'number' }).notNull(),
    assetClass: assetClassEnum('asset_class').notNull(),
    securityType: text('security_type').notNull(),
    securityType2: text('security_type2'),
    shareClassFigi: char('share_class_figi', { length: 12 }),
    isin: char('isin', { length: 12 }),
    cusip: char('cusip', { length: 9 }),
    sedol: char('sedol', { length: 7 }),
    name: text('name').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    countryOfIssue: char('country_of_issue', { length: 2 }),
    parValue: numeric('par_value', { precision: 18, scale: 6 }),
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
    index('issues_current_idx')
      .on(t.issueId)
      .where(sql`tx_to = 'infinity'`),
    index('issues_issuer_idx')
      .on(t.issuerId)
      .where(sql`tx_to = 'infinity'`),
    index('issues_isin_idx')
      .on(t.isin)
      .where(sql`tx_to = 'infinity' AND isin IS NOT NULL`),
    index('issues_cusip_idx')
      .on(t.cusip)
      .where(sql`tx_to = 'infinity' AND cusip IS NOT NULL`),
  ],
);

/** The thing a user names on the command line (composite level): 'AAPL US'. */
export const instruments = pgTable(
  'instruments',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    instrumentId: bigint('instrument_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('instrument_id_seq')`),
    issueId: bigint('issue_id', { mode: 'number' }).notNull(),
    assetClass: assetClassEnum('asset_class').notNull(),
    marketSector: marketSectorEnum('market_sector').notNull(),
    compositeFigi: char('composite_figi', { length: 12 }),
    ticker: text('ticker').notNull(),
    exchCode: text('exch_code').notNull(),
    name: text('name').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    primaryListingId: bigint('primary_listing_id', { mode: 'number' }),
    status: text('status').notNull().default('active'),
    searchWeight: real('search_weight').notNull().default(1),
    priceDecimals: smallint('price_decimals').notNull().default(2),
    firstTradeDate: date('first_trade_date', { mode: 'string' }),
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
    index('instruments_current_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
    index('instruments_ticker_idx')
      .on(sql`upper(ticker)`, t.exchCode, t.marketSector)
      .where(sql`tx_to = 'infinity' AND valid_to = 'infinity'`),
    index('instruments_figi_idx')
      .on(t.compositeFigi)
      .where(sql`tx_to = 'infinity' AND composite_figi IS NOT NULL`),
    index('instruments_name_trgm')
      .using('gin', sql`name gin_trgm_ops`)
      .where(sql`tx_to = 'infinity'`),
    index('instruments_issue_idx')
      .on(t.issueId)
      .where(sql`tx_to = 'infinity'`),
    index('instruments_class_idx')
      .on(t.assetClass, t.status)
      .where(sql`tx_to = 'infinity' AND valid_to = 'infinity'`),
  ],
);

/** One instrument, many venues (OpenFIGI venue FIGIs UN/UW/UA/UP/…). */
export const listings = pgTable(
  'listings',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    listingId: bigint('listing_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('listing_id_seq')`),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    figi: char('figi', { length: 12 }),
    mic: char('mic', { length: 4 }),
    exchCode: text('exch_code').notNull(),
    localTicker: text('local_ticker').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    listingStatus: text('listing_status').notNull().default('active'),
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
    index('listings_current_idx')
      .on(t.listingId)
      .where(sql`tx_to = 'infinity'`),
    index('listings_instrument_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
    index('listings_figi_idx')
      .on(t.figi)
      .where(sql`tx_to = 'infinity' AND figi IS NOT NULL`),
  ],
);

/** Market-data line = (instrument | listing) × (source, provider symbol). */
export const mdLines = pgTable(
  'md_lines',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    mdLineId: bigint('md_line_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('md_line_id_seq')`),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    listingId: bigint('listing_id', { mode: 'number' }),
    sourceId: text('source_id').notNull(),
    providerSymbol: text('provider_symbol').notNull(),
    lineKind: text('line_kind').notNull(),
    intrinsicDelayMin: integer('intrinsic_delay_min').notNull(),
    expectedIntervalMs: integer('expected_interval_ms').notNull(),
    priority: smallint('priority').notNull().default(100),
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
    index('md_lines_current_idx')
      .on(t.mdLineId)
      .where(sql`tx_to = 'infinity'`),
    index('md_lines_instrument_idx')
      .on(t.instrumentId)
      .where(sql`tx_to = 'infinity'`),
    index('md_lines_symbol_idx')
      .on(t.sourceId, t.providerSymbol)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** REF-01 cross-reference; a ticker is reused across time, never across a valid range. */
export const identifiers = pgTable(
  'identifiers',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    entityKind: entityKindEnum('entity_kind').notNull(),
    entityId: bigint('entity_id', { mode: 'number' }).notNull(),
    scheme: idSchemeEnum('scheme').notNull(),
    value: text('value').notNull(),
    qualifier: text('qualifier').notNull().default(''),
    isPrimary: boolean('is_primary').notNull().default(false),
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
    index('identifiers_lookup_idx')
      .on(t.scheme, t.value)
      .where(sql`tx_to = 'infinity'`),
    index('identifiers_entity_idx')
      .on(t.entityKind, t.entityId)
      .where(sql`tx_to = 'infinity'`),
    index('identifiers_value_trgm')
      .using('gin', sql`value gin_trgm_ops`)
      .where(sql`tx_to = 'infinity'`),
  ],
);
