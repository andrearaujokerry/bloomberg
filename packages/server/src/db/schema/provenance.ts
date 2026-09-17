/**
 * Provenance and licence registry — mirrors `drizzle/migrations/0002_provenance_licence.sql`.
 *
 * Every timestamptz is declared `mode: 'string'` and every date `mode: 'string'`
 * throughout the mirror: the bitemporal tables store the sentinel 'infinity' in
 * `valid_to` / `tx_to`, which `new Date(...)` cannot represent.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { assetClassEnum, fieldClassEnum, tierEnum } from './enums.js';

/** `bytea`. drizzle-orm 0.45 has no built-in bytea column, so it is a custom type. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** DATA-10: one row per raw provider exchange (= one replay-store entry). */
export const provenance = pgTable(
  'provenance',
  {
    provenanceId: bigserial('provenance_id', { mode: 'number' }).primaryKey(),
    sourceId: text('source_id').notNull(),
    requestKey: text('request_key').notNull(),
    requestUrl: text('request_url').notNull(),
    requestHash: bytea('request_hash').notNull(),
    responseSha256: bytea('response_sha256').notNull(),
    httpStatus: integer('http_status').notNull(),
    bytes: integer('bytes').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'string' }).notNull(),
    sourceTs: timestamp('source_ts', { withTimezone: true, mode: 'string' }),
    adapterVersion: text('adapter_version').notNull(),
    traceId: uuid('trace_id'),
    // FK to ingest_runs(run_id) is added by migration 0014 (ops.ts owns that table).
    runId: bigint('run_id', { mode: 'number' }),
  },
  (t) => [
    index('provenance_source_captured_idx').on(t.sourceId, t.capturedAt.desc()),
    index('provenance_request_key_idx').on(t.requestKey, t.capturedAt.desc()),
    index('provenance_trace_idx')
      .on(t.traceId)
      .where(sql`trace_id IS NOT NULL`),
    index('provenance_run_idx')
      .on(t.runId)
      .where(sql`run_id IS NOT NULL`),
  ],
);

/** DATA-09: machine-readable terms per source; bitemporal because terms change. */
export const licenceRegistry = pgTable(
  'licence_registry',
  {
    versionId: bigserial('version_id', { mode: 'number' }).primaryKey(),
    sourceId: text('source_id').notNull(),
    sourceName: text('source_name').notNull(),
    publisher: text('publisher').notNull(),
    termsUrl: text('terms_url'),
    contractRef: text('contract_ref'),
    licenceKind: text('licence_kind').notNull(),
    display: boolean('display').notNull().default(true),
    nonDisplay: boolean('non_display').notNull().default(false),
    derived: boolean('derived').notNull().default(true),
    redistribution: boolean('redistribution').notNull().default(false),
    exportAllowed: boolean('export_allowed').notNull().default(true),
    apiAllowed: boolean('api_allowed').notNull().default(true),
    maxTier: tierEnum('max_tier').notNull().default('delayed'),
    intrinsicDelayMin: integer('intrinsic_delay_min').notNull().default(15),
    retentionDays: integer('retention_days'),
    attribution: text('attribution').notNull(),
    rateLimit: text('rate_limit').notNull(),
    requiresUserAgent: boolean('requires_user_agent').notNull().default(false),
    apiKeyEnv: text('api_key_env'),
    auditObligation: text('audit_obligation'),
    notes: text('notes'),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    txFrom: timestamp('tx_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    txTo: timestamp('tx_to', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`'infinity'`),
    provenanceId: bigint('provenance_id', { mode: 'number' }).references(
      () => provenance.provenanceId,
    ),
  },
  (t) => [
    index('licence_registry_current_idx')
      .on(t.sourceId)
      .where(sql`tx_to = 'infinity'`),
  ],
);

/** Every field × asset class → the source that supplies it (entitlement evaluator rule 1). */
export const fieldLicence = pgTable(
  'field_licence',
  {
    fieldId: text('field_id').notNull(),
    assetClass: assetClassEnum('asset_class').notNull(),
    sourceId: text('source_id').notNull(),
    fieldClass: fieldClassEnum('field_class').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fieldId, t.assetClass] }),
    index('field_licence_source_idx').on(t.sourceId),
  ],
);
