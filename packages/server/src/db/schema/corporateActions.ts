/**
 * Corporate actions — mirrors `drizzle/migrations/0006_corporate_actions.sql`.
 * Bitemporal, with a dual key: the surrogate ca_id and the natural
 * (instrument_id, ca_type, ex_date, source_id) tuple (REF-10).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  char,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { caStatusEnum, caTypeEnum } from './enums.js';
import { provenance } from './provenance.js';

export const corporateActions = pgTable(
  'corporate_actions',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    caId: bigint('ca_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('ca_id_seq')`),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
    caType: caTypeEnum('ca_type').notNull(),
    status: caStatusEnum('status').notNull(),
    declaredDate: date('declared_date', { mode: 'string' }),
    exDate: date('ex_date', { mode: 'string' }).notNull(),
    recordDate: date('record_date', { mode: 'string' }),
    payDate: date('pay_date', { mode: 'string' }),
    effectiveDate: date('effective_date', { mode: 'string' }),
    amount: numeric('amount', { precision: 18, scale: 8 }),
    currency: char('currency', { length: 3 }),
    ratioNew: numeric('ratio_new', { precision: 18, scale: 8 }),
    ratioOld: numeric('ratio_old', { precision: 18, scale: 8 }),
    newInstrumentId: bigint('new_instrument_id', { mode: 'number' }),
    frequency: text('frequency'),
    grossOrNet: text('gross_or_net').notNull().default('gross'),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    note: text('note'),
    sourceId: text('source_id').notNull(),
    reviewState: text('review_state').notNull().default('auto'),
    reviewedBy: bigint('reviewed_by', { mode: 'number' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
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
    index('corporate_actions_current_idx')
      .on(t.caId)
      .where(sql`tx_to = 'infinity'`),
    index('corporate_actions_inst_ex_idx')
      .on(t.instrumentId, t.exDate)
      .where(sql`tx_to = 'infinity'`),
    index('corporate_actions_ex_date_idx')
      .on(t.exDate)
      .where(sql`tx_to = 'infinity'`),
    index('corporate_actions_review_idx')
      .on(t.reviewState)
      .where(sql`tx_to = 'infinity' AND review_state = 'queued'`),
  ],
);
