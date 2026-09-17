/**
 * Drizzle mirror of migration 0009_econ_curves.sql — the curve half.
 *
 * The `curves_source_known` trigger lives only in the SQL (allowlisted in the drift test).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { provenance } from './provenance.js';

/** Curve definitions: `c:UST_PAR`, `c:SOFR_OIS`, … */
export const curves = pgTable(
  'curves',
  {
    curveId: text('curve_id').primaryKey(),
    name: text('name').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    kind: text('kind').notNull(),
    dayCount: text('day_count').notNull(),
    compounding: text('compounding').notNull(),
    sourceId: text('source_id').notNull(),
    defaultInterpolation: text('default_interpolation').notNull().default('monotone_convex'),
  },
  (t) => [
    check('curves_kind_check', sql`${t.kind} IN ('par','bill','cmt','fixing','ois','zero')`),
    check(
      'curves_compounding_check',
      sql`${t.compounding} IN ('semiannual','annual','simple','continuous')`,
    ),
    check(
      'curves_default_interpolation_check',
      sql`${t.defaultInterpolation} IN ('linear_zero','log_linear_df','monotone_convex')`,
    ),
  ],
);

/** Published curve inputs, vintaged. */
export const curvePoints = pgTable(
  'curve_points',
  {
    curveId: text('curve_id')
      .notNull()
      .references(() => curves.curveId),
    curveDate: date('curve_date').notNull(),
    tenor: text('tenor').notNull(),
    quoteType: text('quote_type').notNull(),
    vintageAt: timestamp('vintage_at', { withTimezone: true }).notNull(),
    tenorDays: integer('tenor_days').notNull(),
    /** Percent. */
    value: numeric('value', { precision: 12, scale: 8 }).notNull(),
    /** On-the-run bill/note for the tenor when known; deliberately no FK. */
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    maturityDate: date('maturity_date'),
    isLatest: boolean('is_latest').notNull().default(true),
    provenanceId: bigint('provenance_id', { mode: 'number' })
      .notNull()
      .references(() => provenance.provenanceId),
  },
  (t) => [
    primaryKey({
      name: 'curve_points_pkey',
      columns: [t.curveId, t.curveDate, t.tenor, t.quoteType, t.vintageAt],
    }),
    uniqueIndex('curve_points_latest_uniq')
      .on(t.curveId, t.curveDate, t.tenor, t.quoteType)
      .where(sql`${t.isLatest}`),
    index('curve_points_date_idx')
      .on(t.curveId, t.curveDate.desc())
      .where(sql`${t.isLatest}`),
    check(
      'curve_points_quote_type_check',
      sql`${t.quoteType} IN ('par_yield','discount_rate','investment_yield','cmt_yield','ois_rate','zero_rate','fixing')`,
    ),
  ],
);

/** Bootstrapped curves cached by inputs hash (ANAL-08 reproducibility). */
export const curveBuilds = pgTable(
  'curve_builds',
  {
    buildId: bigint('build_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    curveId: text('curve_id')
      .notNull()
      .references(() => curves.curveId),
    curveDate: date('curve_date').notNull(),
    valuationTs: timestamp('valuation_ts', { withTimezone: true }).notNull(),
    method: text('method').notNull(),
    interpolation: text('interpolation').notNull(),
    engineName: text('engine_name').notNull(),
    engineVersion: text('engine_version').notNull(),
    inputsHash: char('inputs_hash', { length: 64 }).notNull(),
    /** The exact points + settings used. */
    inputs: jsonb('inputs').notNull(),
    /** `[{t, df, zero, fwd}]` */
    nodes: jsonb('nodes').notNull(),
    provenanceIds: bigint('provenance_ids', { mode: 'number' }).array().notNull(),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Postgres truncates the generated constraint name at 63 bytes.
    unique('curve_builds_curve_id_curve_date_method_interpolation_engin_key').on(
      t.curveId,
      t.curveDate,
      t.method,
      t.interpolation,
      t.engineVersion,
      t.inputsHash,
    ),
  ],
);
