/**
 * Drizzle mirror of migration 0011_users_entitlements.sql — grants, the access log,
 * monthly usage declarations and quotas.
 *
 * `access_log` is `PARTITION BY RANGE (ts)` in SQL; Drizzle cannot express partitioning, so it is
 * declared here as an ordinary table with the same columns and composite primary key, and the
 * partitioning (plus the `access_log_default` partition and the append-only rules of migration
 * 0015) is allowlisted in the drift test.
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
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  assetClassEnum,
  entlDecisionEnum,
  fieldClassEnum,
  tierEnum,
  usageTypeEnum,
} from './enums.js';
import { firms, users } from './users.js';

/** ENTL-02: effective = licence cap ∩ firm grant ∩ user grant. */
export const entitlementGrants = pgTable(
  'entitlement_grants',
  {
    grantId: bigint('grant_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: bigint('subject_id', { mode: 'number' }).notNull(),
    /** NULL = all sources. */
    sourceId: text('source_id'),
    /** NULL = all. */
    assetClass: assetClassEnum('asset_class'),
    /** NULL = all. */
    fieldClass: fieldClassEnum('field_class'),
    maxTier: tierEnum('max_tier').notNull(),
    usageDisplay: boolean('usage_display').notNull().default(true),
    usageExport: boolean('usage_export').notNull().default(false),
    usageApi: boolean('usage_api').notNull().default(false),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true })
      .notNull()
      .default(sql`'infinity'`),
    grantedBy: bigint('granted_by', { mode: 'number' }),
    contractRef: text('contract_ref'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('entitlement_grants_subject_idx')
      .on(t.subjectKind, t.subjectId)
      .where(sql`${t.validTo} = 'infinity'`),
    index('entitlement_grants_source_idx')
      .on(t.sourceId)
      .where(sql`${t.sourceId} IS NOT NULL`),
    check('entitlement_grants_subject_kind_check', sql`${t.subjectKind} IN ('user','firm')`),
    check('entitlement_grants_range', sql`${t.validFrom} < ${t.validTo}`),
  ],
);

/** Backs `access_log.log_id` (the table is partitioned, so it cannot use an identity column). */
export const accessLogIdSeq = pgSequence('access_log_id_seq');

/** ENTL-04: every data access decision. Append-only, monthly partitions. */
export const accessLog = pgTable(
  'access_log',
  {
    logId: bigint('log_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('access_log_id_seq')`),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    sessionId: uuid('session_id'),
    /** NULL for non-instrument reads (econ series id in `details`). */
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    fieldId: text('field_id').notNull(),
    fieldClass: fieldClassEnum('field_class').notNull(),
    sourceId: text('source_id').notNull(),
    requestedTier: tierEnum('requested_tier').notNull(),
    /** Granted tier (NULL on deny). */
    tier: tierEnum('tier'),
    usage: usageTypeEnum('usage').notNull(),
    /** Function code | route id | `ws.sub`. */
    purpose: text('purpose').notNull(),
    decision: entlDecisionEnum('decision').notNull(),
    /** Core ReasonCode. */
    reason: text('reason').notNull().default('OK'),
    traceId: uuid('trace_id'),
    details: jsonb('details'),
  },
  (t) => [
    primaryKey({ name: 'access_log_pkey', columns: [t.ts, t.logId] }),
    index('access_log_user_idx').on(t.userId, t.ts),
    index('access_log_declare_idx').on(t.sourceId, t.fieldClass, t.tier, t.usage, t.ts),
    index('access_log_trace_idx')
      .on(t.traceId)
      .where(sql`${t.traceId} IS NOT NULL`),
  ],
);

/** ENTL-06 / DATA-02: generated monthly from `access_log`. */
export const usageDeclarations = pgTable(
  'usage_declarations',
  {
    declarationId: bigint('declaration_id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    /** First day of month. */
    month: date('month').notNull(),
    sourceId: text('source_id').notNull(),
    firmId: bigint('firm_id', { mode: 'number' })
      .notNull()
      .references(() => firms.firmId),
    fieldClass: fieldClassEnum('field_class').notNull(),
    tier: tierEnum('tier').notNull(),
    displayUsers: integer('display_users').notNull(),
    exportUsers: integer('export_users').notNull(),
    apiUsers: integer('api_users').notNull(),
    distinctUsers: integer('distinct_users').notNull(),
    instrumentCount: integer('instrument_count').notNull(),
    dataPoints: bigint('data_points', { mode: 'number' }).notNull(),
    /** `firms.seat_count` at generation (reconciliation input). */
    seatCount: integer('seat_count').notNull(),
    /** sha256 of the SQL text that produced the row. */
    querySqlHash: char('query_sql_hash', { length: 64 }).notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    billingRef: text('billing_ref'),
  },
  (t) => [
    // Postgres truncates the generated constraint name at 63 bytes.
    unique('usage_declarations_month_source_id_firm_id_field_class_tier_key').on(
      t.month,
      t.sourceId,
      t.firmId,
      t.fieldClass,
      t.tier,
    ),
  ],
);

/** API-06 quota ceilings per user or firm. */
export const quotaLimits = pgTable(
  'quota_limits',
  {
    subjectKind: text('subject_kind').notNull(),
    subjectId: bigint('subject_id', { mode: 'number' }).notNull(),
    dailyUniqueInstruments: integer('daily_unique_instruments').notNull().default(500),
    monthlyDataPoints: bigint('monthly_data_points', { mode: 'number' }).notNull().default(2000000),
    concurrentSubscriptions: integer('concurrent_subscriptions').notNull().default(2000),
  },
  (t) => [
    primaryKey({ name: 'quota_limits_pkey', columns: [t.subjectKind, t.subjectId] }),
    check('quota_limits_subject_kind_check', sql`${t.subjectKind} IN ('user','firm')`),
  ],
);

/** Rolling data-point counters per user and window. */
export const quotaCounters = pgTable(
  'quota_counters',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    windowKind: text('window_kind').notNull(),
    windowStart: date('window_start').notNull(),
    dataPoints: bigint('data_points', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: 'quota_counters_pkey',
      columns: [t.userId, t.windowKind, t.windowStart],
    }),
    check('quota_counters_window_kind_check', sql`${t.windowKind} IN ('day','month')`),
  ],
);

/** Distinct instruments a user touched on a day (the daily-unique-instrument quota). */
export const quotaInstrumentsSeen = pgTable(
  'quota_instruments_seen',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    day: date('day').notNull(),
    instrumentId: bigint('instrument_id', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'quota_instruments_seen_pkey',
      columns: [t.userId, t.day, t.instrumentId],
    }),
  ],
);
