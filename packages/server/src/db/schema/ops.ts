/**
 * Drizzle mirror of migration 0014_ops.sql — product analytics, help tickets, ingest runs,
 * data-quality events, the exception queue, the status page and the config-version table.
 *
 * `usage_events` is `PARTITION BY RANGE (ts)` in SQL; Drizzle cannot express partitioning, so it
 * is declared here as an ordinary table with the same columns and composite primary key. The
 * `bump_config_version` function and its four statement triggers, and the
 * `provenance_run_fk` constraint that 0014 adds to `provenance`, are SQL-only and allowlisted in
 * the drift test.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { entityKindEnum } from './enums.js';
import { rooms } from './messaging.js';
import { users } from './users.js';

/** Backs `usage_events.event_id` (the table is partitioned, so it cannot use an identity column). */
export const usageEventsIdSeq = pgSequence('usage_events_id_seq');

/** FUNC-04: every launch, param change, page, export, help, search selection … */
export const usageEvents = pgTable(
  'usage_events',
  {
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('usage_events_id_seq')`),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    sessionId: uuid('session_id'),
    panelId: text('panel_id'),
    kind: text('kind').notNull(),
    /** Function code. */
    code: text('code'),
    /** sha256 of canonical params JSON. */
    paramsHash: text('params_hash'),
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    durationMs: integer('duration_ms'),
    traceId: uuid('trace_id'),
    details: jsonb('details').notNull().default({}),
  },
  (t) => [
    primaryKey({ name: 'usage_events_pkey', columns: [t.ts, t.eventId] }),
    index('usage_events_code_idx').on(t.kind, t.code, t.ts),
    index('usage_events_user_idx').on(t.userId, t.ts),
    index('usage_events_trace_idx')
      .on(t.traceId)
      .where(sql`${t.traceId} IS NOT NULL`),
    check(
      'usage_events_kind_check',
      sql`${t.kind} IN ('fn.launch','fn.param','fn.page','fn.export','fn.help','search.select','cmd.parse_error','panel.switch','ws.subscribe','ws.slow','ws.resync','ticket.open')`,
    ),
  ],
);

/** TERM-09: the second HELP press opens a ticket record (no live analyst in v1). */
export const helpTickets = pgTable(
  'help_tickets',
  {
    ticketId: bigint('ticket_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.userId),
    firmId: bigint('firm_id', { mode: 'number' }).notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    panelId: text('panel_id'),
    functionCode: text('function_code'),
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    params: jsonb('params'),
    /** Visible fields + their provenance indexes. */
    screenState: jsonb('screen_state').notNull().default({}),
    traceId: uuid('trace_id'),
    question: text('question').notNull(),
    /** Helpdesk room created for the ticket. */
    roomId: bigint('room_id', { mode: 'number' }).references(() => rooms.roomId),
    status: text('status').notNull().default('open'),
    answer: text('answer'),
    answeredBy: bigint('answered_by', { mode: 'number' }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => [
    index('help_tickets_open_idx')
      .on(t.openedAt.desc())
      .where(sql`${t.status} = 'open'`),
    check('help_tickets_status_check', sql`${t.status} IN ('open','answered','closed')`),
  ],
);

/** One row per scheduler job run. */
export const ingestRuns = pgTable(
  'ingest_runs',
  {
    runId: bigint('run_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    jobId: text('job_id').notNull(),
    /** NULL for internal jobs. */
    sourceId: text('source_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(),
    fetched: integer('fetched').notNull().default(0),
    inserted: integer('inserted').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    /** `JobError[]` — `{code, message, url?, requestKey?}` */
    errors: jsonb('errors').notNull().default([]),
    traceId: uuid('trace_id'),
  },
  (t) => [
    index('ingest_runs_job_idx').on(t.jobId, t.startedAt.desc()),
    check('ingest_runs_status_check', sql`${t.status} IN ('running','ok','failed','skipped')`),
  ],
);

/** OPS-03 / QA-03 / BUS-04: every widen/shed/close is a row. */
export const dqEvents = pgTable(
  'dq_events',
  {
    dqId: bigint('dq_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    instrumentId: bigint('instrument_id', { mode: 'number' }),
    mdLineId: bigint('md_line_id', { mode: 'number' }),
    sourceId: text('source_id'),
    /** Plant subject or table name. */
    subject: text('subject'),
    /** `{expected, actual, diffPct, sessionId …}` */
    details: jsonb('details').notNull().default({}),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('dq_events_open_idx')
      .on(t.kind, t.ts.desc())
      .where(sql`${t.resolvedAt} IS NULL`),
    index('dq_events_ts_idx').on(t.ts.desc()),
    check(
      'dq_events_kind_check',
      sql`${t.kind} IN ('stale_tick','cross_source_divergence','missing_close','field_population','poll_anomaly','provider_circuit_open','reconcile_mismatch','parse_error','default_partition_nonempty','ref_orphans','ws_backpressure','plant_degraded','replay_diff')`,
    ),
    check('dq_events_severity_check', sql`${t.severity} IN ('info','warn','error')`),
  ],
);

/** REF-10 exception queue with an SLA. */
export const dataExceptions = pgTable(
  'data_exceptions',
  {
    exceptionId: bigint('exception_id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    entityKind: entityKindEnum('entity_kind'),
    entityId: bigint('entity_id', { mode: 'number' }),
    field: text('field'),
    /** `[{sourceId, provenanceId, value}]` */
    candidates: jsonb('candidates').notNull().default([]),
    /** `users.user_id` for reported errors. */
    reportedBy: bigint('reported_by', { mode: 'number' }),
    status: text('status').notNull().default('open'),
    assigneeUserId: bigint('assignee_user_id', { mode: 'number' }),
    resolvedBy: bigint('resolved_by', { mode: 'number' }),
    /** `{chosenProvenanceId, versionId, note}` */
    resolution: jsonb('resolution'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  },
  (t) => [
    index('data_exceptions_open_idx')
      .on(t.slaDueAt)
      .where(sql`${t.status} = 'open'`),
    check(
      'data_exceptions_kind_check',
      sql`${t.kind} IN ('source_conflict','missing_field','parse_error','manual_review','reported_error','unresolved_identifier','ca_review')`,
    ),
    check('data_exceptions_status_check', sql`${t.status} IN ('open','resolved','rejected')`),
  ],
);

/** OPS-04 status page. */
export const statusIncidents = pgTable(
  'status_incidents',
  {
    incidentId: bigint('incident_id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** `provider:cboe.quotes`, `plant`, `ws`, `db`. */
    component: text('component').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    /** `[{ts, text}]` */
    updates: jsonb('updates').notNull().default([]),
  },
  (t) => [
    check('status_incidents_severity_check', sql`${t.severity} IN ('info','degraded','outage')`),
  ],
);

/** `field_dictionary_version`, `concept_map_version`, `seed_fixture_sha`. */
export const schemaMeta = pgTable('schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** In-memory caches reload when a version changes. Seeded with three rows by migration 0014. */
export const configVersions = pgTable('config_versions', {
  /** `entitlements`, `calendars`, `universe`. */
  name: text('name').primaryKey(),
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
