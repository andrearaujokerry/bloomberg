/**
 * SEC filings, XBRL facts/frames and standardised statements —
 * mirrors `drizzle/migrations/0008_fundamentals.sql`.
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
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { provenance } from './provenance.js';

/** SEC submissions.recent. */
export const filings = pgTable(
  'filings',
  {
    accessionNo: char('accession_no', { length: 20 }).primaryKey(),
    cik: char('cik', { length: 10 }).notNull(),
    issuerId: bigint('issuer_id', { mode: 'number' }),
    form: text('form').notNull(),
    filedDate: date('filed_date', { mode: 'string' }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'string' }),
    reportDate: date('report_date', { mode: 'string' }),
    items: text('items')
      .array()
      .notNull()
      .default(sql`'{}'`),
    primaryDoc: text('primary_doc'),
    primaryDocDesc: text('primary_doc_desc'),
    isXbrl: boolean('is_xbrl').notNull().default(false),
    isInlineXbrl: boolean('is_inline_xbrl').notNull().default(false),
    sizeBytes: integer('size_bytes'),
    url: text('url').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    index('filings_issuer_idx')
      .on(t.issuerId, t.filedDate.desc())
      .where(sql`issuer_id IS NOT NULL`),
    index('filings_cik_idx').on(t.cik, t.filedDate.desc()),
    index('filings_form_idx').on(t.form, t.filedDate.desc()),
    index('filings_items_idx').using('gin', t.items),
  ],
);

/** One row per (cik, taxonomy, concept, unit, period, accession): the PIT store (STOR-06). */
export const xbrlFacts = pgTable(
  'xbrl_facts',
  {
    factId: bigint('fact_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    cik: char('cik', { length: 10 }).notNull(),
    issuerId: bigint('issuer_id', { mode: 'number' }),
    taxonomy: text('taxonomy').notNull(),
    concept: text('concept').notNull(),
    unit: text('unit').notNull(),
    periodStart: date('period_start', { mode: 'string' }),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    fy: smallint('fy'),
    fp: text('fp'),
    form: text('form').notNull(),
    accessionNo: char('accession_no', { length: 20 }).notNull(),
    filedAt: date('filed_at', { mode: 'string' }).notNull(),
    frame: text('frame'),
    value: numeric('value', { precision: 28, scale: 6 }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    uniqueIndex('xbrl_facts_natural_uniq').on(
      t.cik,
      t.taxonomy,
      t.concept,
      t.unit,
      t.periodEnd,
      sql`COALESCE(period_start, '0001-01-01'::date)`,
      t.accessionNo,
    ),
    index('xbrl_facts_pit_idx').on(
      t.cik,
      t.taxonomy,
      t.concept,
      t.unit,
      t.periodEnd.desc(),
      t.filedAt.desc(),
    ),
    index('xbrl_facts_filed_idx').on(t.cik, t.filedAt.desc()),
  ],
);

/** SEC frames API: one value per CIK for a canonical period — the EQS cross-section store. */
export const xbrlFrames = pgTable(
  'xbrl_frames',
  {
    taxonomy: text('taxonomy').notNull(),
    concept: text('concept').notNull(),
    unit: text('unit').notNull(),
    frame: text('frame').notNull(),
    cik: char('cik', { length: 10 }).notNull(),
    issuerId: bigint('issuer_id', { mode: 'number' }),
    accessionNo: char('accession_no', { length: 20 }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    value: numeric('value', { precision: 28, scale: 6 }).notNull(),
    filedAt: date('filed_at', { mode: 'string' }),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({ columns: [t.taxonomy, t.concept, t.unit, t.frame, t.cik] }),
    index('xbrl_frames_cik_idx').on(t.cik, t.frame),
  ],
);

/** Standardisation: standard item → concept priority list (DATA-06). */
export const xbrlConceptMap = pgTable(
  'xbrl_concept_map',
  {
    mappingVersion: text('mapping_version').notNull(),
    standardItem: text('standard_item').notNull(),
    taxonomy: text('taxonomy').notNull(),
    concept: text('concept').notNull(),
    priority: smallint('priority').notNull(),
    sign: smallint('sign').notNull().default(1),
    statement: char('statement', { length: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.mappingVersion, t.standardItem, t.taxonomy, t.concept] })],
);

/** Materialised standardised statements, PIT-keyed on filed_at; derived (internal.derived). */
export const finStatements = pgTable(
  'fin_statements',
  {
    issuerId: bigint('issuer_id', { mode: 'number' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    periodType: text('period_type').notNull(),
    filedAt: date('filed_at', { mode: 'string' }).notNull(),
    mappingVersion: text('mapping_version').notNull(),
    fiscalYear: smallint('fiscal_year'),
    fiscalPeriod: text('fiscal_period'),
    accessionNo: char('accession_no', { length: 20 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('USD'),
    revenue: numeric('revenue', { precision: 28, scale: 2 }),
    cogs: numeric('cogs', { precision: 28, scale: 2 }),
    grossProfit: numeric('gross_profit', { precision: 28, scale: 2 }),
    opex: numeric('opex', { precision: 28, scale: 2 }),
    rnd: numeric('rnd', { precision: 28, scale: 2 }),
    operInc: numeric('oper_inc', { precision: 28, scale: 2 }),
    intExp: numeric('int_exp', { precision: 28, scale: 2 }),
    pretaxInc: numeric('pretax_inc', { precision: 28, scale: 2 }),
    tax: numeric('tax', { precision: 28, scale: 2 }),
    netInc: numeric('net_inc', { precision: 28, scale: 2 }),
    epsBasic: numeric('eps_basic', { precision: 12, scale: 4 }),
    epsDil: numeric('eps_dil', { precision: 12, scale: 4 }),
    sharesDil: numeric('shares_dil', { precision: 20, scale: 0 }),
    totAssets: numeric('tot_assets', { precision: 28, scale: 2 }),
    totLiab: numeric('tot_liab', { precision: 28, scale: 2 }),
    equity: numeric('equity', { precision: 28, scale: 2 }),
    cash: numeric('cash', { precision: 28, scale: 2 }),
    ltDebt: numeric('lt_debt', { precision: 28, scale: 2 }),
    cfo: numeric('cfo', { precision: 28, scale: 2 }),
    capex: numeric('capex', { precision: 28, scale: 2 }),
    fcf: numeric('fcf', { precision: 28, scale: 2 }),
    divPaid: numeric('div_paid', { precision: 28, scale: 2 }),
    buyback: numeric('buyback', { precision: 28, scale: 2 }),
    dps: numeric('dps', { precision: 12, scale: 6 }),
    dda: numeric('dda', { precision: 28, scale: 2 }),
    derivedQ4: boolean('derived_q4').notNull().default(false),
    asReported: jsonb('as_reported').notNull(),
    builtAt: timestamp('built_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    engineName: text('engine_name').notNull(),
    engineVersion: text('engine_version').notNull(),
    inputsHash: char('inputs_hash', { length: 64 }).notNull(),
    provenanceIds: bigint('provenance_ids', { mode: 'number' }).array().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.issuerId, t.periodEnd, t.periodType, t.filedAt, t.mappingVersion],
    }),
    index('fin_statements_pit_idx').on(
      t.issuerId,
      t.periodType,
      t.periodEnd.desc(),
      t.filedAt.desc(),
    ),
  ],
);
