/**
 * Drizzle mirror of migration 0009_econ_curves.sql — the econ half.
 *
 * DDL authority is the SQL; this file exists for typed queries only. Triggers, partial
 * indexes that Drizzle can express are declared, everything Drizzle cannot model
 * (`assert_source_known` triggers) lives only in the migration and is allowlisted by
 * `test/integration/db/schema-drift.test.ts`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { provenance } from './provenance.js';

/** FRED / BLS / Fed release definitions behind the ECO calendar. */
export const econReleases = pgTable(
  'econ_releases',
  {
    releaseId: bigint('release_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    sourceId: text('source_id').notNull(),
    providerReleaseId: text('provider_release_id').notNull(),
    name: text('name').notNull(),
    country: char('country', { length: 2 }).notNull().default('US'),
    url: text('url'),
    importance: smallint('importance').notNull().default(2),
  },
  (t) => [
    unique('econ_releases_source_id_provider_release_id_key').on(t.sourceId, t.providerReleaseId),
    check('econ_releases_importance_check', sql`${t.importance} BETWEEN 1 AND 3`),
  ],
);

/** One economic time series (`e:<seriesCode>` subjects, SERIES_CODE identifiers). */
export const econSeries = pgTable(
  'econ_series',
  {
    seriesId: bigint('series_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    seriesCode: text('series_code').notNull(),
    sourceId: text('source_id').notNull(),
    providerCode: text('provider_code').notNull(),
    name: text('name').notNull(),
    units: text('units').notNull(),
    frequency: char('frequency', { length: 1 }).notNull(),
    seasonalAdj: text('seasonal_adj'),
    country: char('country', { length: 2 }).notNull().default('US'),
    releaseId: bigint('release_id', { mode: 'number' }).references(() => econReleases.releaseId),
    /** The asset_class='econ' instrument; deliberately no FK (instruments are bitemporal). */
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    decimals: smallint('decimals').notNull().default(2),
    firstObsDate: date('first_obs_date'),
    lastObsDate: date('last_obs_date'),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('econ_series_series_code_key').on(t.seriesCode),
    unique('econ_series_source_id_provider_code_key').on(t.sourceId, t.providerCode),
    index('econ_series_name_trgm').using('gin', t.name.op('gin_trgm_ops')),
    check('econ_series_frequency_check', sql`${t.frequency} IN ('D','W','M','Q','A')`),
  ],
);

/** Vintaged observations: a revision adds a row, it never overwrites. */
export const econObservations = pgTable(
  'econ_observations',
  {
    seriesId: bigint('series_id', { mode: 'number' })
      .notNull()
      .references(() => econSeries.seriesId),
    obsDate: date('obs_date').notNull(),
    vintageAt: timestamp('vintage_at', { withTimezone: true }).notNull(),
    value: numeric('value', { precision: 20, scale: 6 }),
    status: text('status').notNull().default('final'),
    footnote: text('footnote'),
    isLatest: boolean('is_latest').notNull().default(true),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({ name: 'econ_observations_pkey', columns: [t.seriesId, t.obsDate, t.vintageAt] }),
    uniqueIndex('econ_observations_latest_uniq')
      .on(t.seriesId, t.obsDate)
      .where(sql`${t.isLatest}`),
    index('econ_observations_pit_idx').on(t.seriesId, t.obsDate.desc(), t.vintageAt.desc()),
    check(
      'econ_observations_status_check',
      sql`${t.status} IN ('final','preliminary','revised','missing')`,
    ),
  ],
);

/** Full NY Fed / H.15 fixing record (percentiles, volume, target range, averages, index). */
export const rateFixings = pgTable(
  'rate_fixings',
  {
    rateCode: text('rate_code').notNull(),
    effectiveDate: date('effective_date').notNull(),
    vintageAt: timestamp('vintage_at', { withTimezone: true }).notNull(),
    rate: numeric('rate', { precision: 12, scale: 8 }),
    pct1: numeric('pct_1', { precision: 12, scale: 8 }),
    pct25: numeric('pct_25', { precision: 12, scale: 8 }),
    pct75: numeric('pct_75', { precision: 12, scale: 8 }),
    pct99: numeric('pct_99', { precision: 12, scale: 8 }),
    volumeBn: numeric('volume_bn', { precision: 14, scale: 2 }),
    targetFrom: numeric('target_from', { precision: 8, scale: 4 }),
    targetTo: numeric('target_to', { precision: 8, scale: 4 }),
    avg30d: numeric('avg_30d', { precision: 12, scale: 8 }),
    avg90d: numeric('avg_90d', { precision: 12, scale: 8 }),
    avg180d: numeric('avg_180d', { precision: 12, scale: 8 }),
    indexValue: numeric('index_value', { precision: 18, scale: 10 }),
    revisionIndicator: text('revision_indicator'),
    isLatest: boolean('is_latest').notNull().default(true),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({ name: 'rate_fixings_pkey', columns: [t.rateCode, t.effectiveDate, t.vintageAt] }),
    uniqueIndex('rate_fixings_latest_uniq')
      .on(t.rateCode, t.effectiveDate)
      .where(sql`${t.isLatest}`),
  ],
);

/** ECO calendar events. */
export const econReleaseEvents = pgTable(
  'econ_release_events',
  {
    eventId: bigint('event_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    releaseId: bigint('release_id', { mode: 'number' })
      .notNull()
      .references(() => econReleases.releaseId),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    timeKnown: boolean('time_known').notNull().default(true),
    periodLabel: text('period_label').notNull(),
    seriesId: bigint('series_id', { mode: 'number' }).references(() => econSeries.seriesId),
    actual: numeric('actual', { precision: 20, scale: 6 }),
    prior: numeric('prior', { precision: 20, scale: 6 }),
    revisedPrior: numeric('revised_prior', { precision: 20, scale: 6 }),
    /** Always NULL in v1: no consensus source. */
    consensus: numeric('consensus', { precision: 20, scale: 6 }),
    consensusUnavailableReason: text('consensus_unavailable_reason').notNull().default('NO_SOURCE'),
    status: text('status').notNull().default('scheduled'),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    unique('econ_release_events_release_id_scheduled_at_period_label_key').on(
      t.releaseId,
      t.scheduledAt,
      t.periodLabel,
    ),
    index('econ_release_events_time_idx').on(t.scheduledAt),
    check(
      'econ_release_events_status_check',
      sql`${t.status} IN ('scheduled','released','revised','delayed','cancelled')`,
    ),
  ],
);

/** WIRP policy-path nodes. */
export const fomcMeetings = pgTable('fomc_meetings', {
  meetingDate: date('meeting_date').primaryKey(),
  statementAt: timestamp('statement_at', { withTimezone: true }),
  hasSep: boolean('has_sep').notNull().default(false),
  decisionBp: smallint('decision_bp'),
  provenanceId: bigint('provenance_id', { mode: 'number' }).references(
    () => provenance.provenanceId,
  ),
});
