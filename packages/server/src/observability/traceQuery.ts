/**
 * `observability/traceQuery.ts` — OPS-07, `GET /api/v1/admin/trace/:traceId` (API.md §5.14).
 *
 * One `x-trace-id` is minted by `http/trace.ts` on the way in and carried by everything the
 * request touches: the `access_log` rows the entitlement evaluator appends, the `usage_events`
 * rows the runner and the client batch route write, the `provenance` rows a read-through fetch
 * writes, the `ingest_runs` row a scheduler job opened, and the `messages` and `help_tickets` rows
 * a send or a HELP press created. This module joins those six tables on that one id and returns
 * the `Rest.Admin.TraceResponse` body.
 *
 * **Scoped to the caller's firm, in SQL, not by RLS.**
 * `access_log` and `usage_events` are partitioned WORM tables with a `firm_id` column and *no RLS
 * policy* (migration 0015 grants `terminal_app` SELECT/INSERT and stops there — WP-07 found that
 * the hard way when an admin of one firm could read every other firm's access log). So both
 * queries carry their own `firm_id = $firm` predicate, and, before any of them runs, the trace is
 * checked for an owner: if any firm-scoped row exists for this trace and none of them belong to
 * the caller's firm, the whole bundle comes back empty. A foreign admin who guesses a uuid learns
 * nothing — not even that the id exists — because an unknown trace and another firm's trace return
 * the identical empty body.
 *
 * `provenance` and `ingest_runs` are platform tables with no tenant column: a provider fetch
 * belongs to the deployment, not to a firm. They are returned only once the ownership gate above
 * has passed, which is what keeps "which URL did this trace fetch" inside the firm that caused it.
 * `messages` and `help_tickets` are RLS-scoped (policies `messages_scope`, `help_tickets_scope`),
 * so they are read through the caller's own `withTx` context and additionally predicated where
 * the table carries a firm column.
 *
 * **`requests` is always empty**, and honestly so: nothing in this process writes a per-request
 * row (`ts, route, status, latencyMs, userId`) to any table. The HTTP log is pino's, on stdout.
 * Returning a fabricated row — or worse, re-deriving one from `access_log` — would put a latency
 * on an operator's screen that no clock ever measured. The key is present because the wire schema
 * requires it; the array is empty until something records requests.
 */

import { sql } from 'drizzle-orm';

import type { FieldClass, Tier, UsageType } from '@terminal/core';
import type { AccessLogRow, IngestRun, TraceProvenance } from '@terminal/sdk/wire/rest/admin';
import type { Message } from '@terminal/sdk/wire/rest/messages';
import type { Ticket } from '@terminal/sdk/wire/rest/help';
import type { UsageEvent } from '@terminal/sdk/wire/rest/usage';

import type { Db, Tx } from '../db/client.js';

/**
 * `to_char(…)` mask rendering a `timestamptz` as the `z.iso.datetime()` every wire schema wants.
 * Interpolated with `sql.raw`, never with a parameter, so it is a literal in this module.
 */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * One HTTP request of a trace (`Rest.Admin.TraceRequestRow`). Declared for the bundle's type;
 * see the module note — nothing populates it yet.
 */
export interface TraceRequestRow {
  ts: string;
  route: string;
  status: number;
  latencyMs: number;
  userId: number | null;
}

/** Everything one trace id touched, in the shape of `Rest.Admin.TraceResponse`. */
export interface TraceBundle {
  traceId: string;
  requests: TraceRequestRow[];
  accessLog: AccessLogRow[];
  usageEvents: UsageEvent[];
  provenance: TraceProvenance[];
  ingestRuns: IngestRun[];
  messages: Message[];
  tickets: Ticket[];
}

export interface TraceQuery {
  /**
   * The bundle for `traceId` as `firmId` may see it. An unknown trace, a malformed uuid and
   * another firm's trace all return the same empty bundle.
   */
  byTraceId(traceId: string, firmId: number): Promise<TraceBundle>;
}

/** RFC 4122 v4 — the shape `http/trace.ts` mints and every `trace_id` column accepts. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyBundle(traceId: string): TraceBundle {
  return {
    traceId,
    requests: [],
    accessLog: [],
    usageEvents: [],
    provenance: [],
    ingestRuns: [],
    messages: [],
    tickets: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes (`execute` returns snake_case, and every bigint as a string)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface AccessLogSqlRow {
  log_id: string;
  ts: string;
  user_id: string;
  firm_id: string;
  session_id: string | null;
  instrument_id: string | null;
  field_id: string | null;
  field_class: FieldClass | null;
  source_id: string | null;
  requested_tier: Tier | null;
  tier: Tier | null;
  usage: UsageType;
  purpose: string;
  decision: 'allow' | 'downgrade' | 'deny';
  reason: string;
  trace_id: string | null;
  details: Record<string, unknown> | null;
}

interface UsageEventSqlRow {
  ts: string;
  kind: string;
  panel_id: string | null;
  code: string | null;
  params_hash: string | null;
  instrument_id: string | null;
  duration_ms: number | null;
  trace_id: string | null;
  details: Record<string, unknown> | null;
}

interface ProvenanceSqlRow {
  provenance_id: string;
  source_id: string;
  request_url: string;
  http_status: number;
  captured_at: string;
  source_ts: string | null;
  request_key: string;
  attribution: string | null;
}

interface IngestRunSqlRow {
  run_id: string;
  job_id: string;
  source_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: unknown;
  trace_id: string | null;
}

interface MessageSqlRow {
  message_id: string;
  room_id: string;
  seq: string;
  sender_user_id: string;
  sender_firm_id: string;
  sender_display: string | null;
  sent_at: string;
  body: string;
  attachments: unknown;
  structured: unknown;
  client_msg_id: string;
  prev_hash: string | null;
  hash: string;
  trace_id: string | null;
}

interface TicketSqlRow {
  ticket_id: string;
  opened_at: string;
  function_code: string | null;
  question: string;
  status: 'open' | 'answered' | 'closed';
  room_id: string | null;
  answer: string | null;
  answered_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row mappers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function accessLogRow(row: AccessLogSqlRow): AccessLogRow {
  return {
    logId: Number(row.log_id),
    ts: row.ts,
    userId: Number(row.user_id),
    firmId: Number(row.firm_id),
    sessionId: row.session_id,
    instrumentId: num(row.instrument_id),
    fieldId: row.field_id,
    fieldClass: row.field_class,
    sourceId: row.source_id,
    requestedTier: row.requested_tier,
    tier: row.tier,
    usage: row.usage,
    purpose: row.purpose,
    decision: row.decision,
    reason: row.reason as AccessLogRow['reason'],
    traceId: row.trace_id,
    details: row.details ?? {},
  };
}

/**
 * `UsageEvent`'s optional members are `?:` under `exactOptionalPropertyTypes`, so a null column
 * becomes an absent key rather than an explicit `undefined`.
 */
function usageEventRow(row: UsageEventSqlRow): UsageEvent {
  return {
    ts: row.ts,
    kind: row.kind as UsageEvent['kind'],
    ...(row.panel_id === null ? {} : { panelId: row.panel_id }),
    ...(row.code === null ? {} : { code: row.code }),
    ...(row.params_hash === null ? {} : { paramsHash: row.params_hash }),
    ...(row.instrument_id === null ? {} : { instrumentId: Number(row.instrument_id) }),
    ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
    ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
    details: row.details ?? {},
  };
}

/**
 * `idx` is the position in this bundle's own array — the same convention `PayloadMeta.provenance`
 * uses, so an operator can read `meta.provenance[2]` on a screen and find the same row here.
 * `attribution` comes from the current `licence_registry` version of the source; with no version
 * on file the source id itself is the honest label, never an invented publisher.
 */
function provenanceRow(row: ProvenanceSqlRow, idx: number): TraceProvenance {
  return {
    idx,
    sourceId: row.source_id,
    provenanceId: Number(row.provenance_id),
    capturedAt: row.captured_at,
    sourceTs: row.source_ts,
    attribution: row.attribution ?? row.source_id,
    requestKey: row.request_key,
    requestUrl: row.request_url,
    httpStatus: row.http_status,
  };
}

function ingestRunRow(row: IngestRunSqlRow): IngestRun {
  return {
    runId: Number(row.run_id),
    jobId: row.job_id,
    sourceId: row.source_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    fetched: Number(row.fetched),
    inserted: Number(row.inserted),
    updated: Number(row.updated),
    skipped: Number(row.skipped),
    errors: (Array.isArray(row.errors) ? row.errors : []) as IngestRun['errors'],
    traceId: row.trace_id,
  };
}

function messageRow(row: MessageSqlRow): Message {
  return {
    messageId: Number(row.message_id),
    roomId: Number(row.room_id),
    seq: Number(row.seq),
    senderUserId: Number(row.sender_user_id),
    senderFirmId: Number(row.sender_firm_id),
    senderDisplay: row.sender_display ?? '',
    sentAt: row.sent_at,
    body: row.body,
    attachments: (Array.isArray(row.attachments) ? row.attachments : []) as Message['attachments'],
    structured: (row.structured ?? null) as Message['structured'],
    clientMsgId: row.client_msg_id,
    prevHash: row.prev_hash,
    hash: row.hash,
    traceId: row.trace_id,
  };
}

function ticketRow(row: TicketSqlRow): Ticket {
  return {
    ticketId: Number(row.ticket_id),
    openedAt: row.opened_at,
    functionCode: row.function_code,
    question: row.question,
    status: row.status,
    roomId: num(row.room_id),
    answer: row.answer,
    answeredAt: row.answered_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the OPS-07 reader over `db`. Pass the transaction opened by `withTx(ctx, …)` so the
 * caller's `app.user_id` / `app.firm_id` / `app.role` are set and the RLS policies on `messages`
 * and `help_tickets` apply; `firmId` is still passed explicitly because the two WORM tables have
 * no policy to apply.
 */
export function traceQuery(db: Db | Tx): TraceQuery {
  async function owners(traceId: string): Promise<Set<number>> {
    const result = await db.execute(sql`
      SELECT DISTINCT firm_id::text AS firm_id FROM access_log   WHERE trace_id = ${traceId}::uuid
      UNION
      SELECT DISTINCT firm_id::text AS firm_id FROM usage_events WHERE trace_id = ${traceId}::uuid`);
    const rows = result.rows as unknown as { firm_id: string }[];
    return new Set(rows.map((row) => Number(row.firm_id)));
  }

  return {
    async byTraceId(traceId: string, firmId: number): Promise<TraceBundle> {
      // A malformed id never reaches a `uuid` cast: Postgres would raise 22P02 and the route
      // would answer 500 for what is plainly a 404-shaped mistake.
      if (!UUID_V4.test(traceId)) return emptyBundle(traceId);
      const id = traceId.toLowerCase();

      // The ownership gate. A trace with no firm-scoped row at all (a pure scheduler trace:
      // provenance + ingest_runs, nobody's tenant data) is readable by any admin; a trace that
      // belongs to someone else is not readable at all.
      const owned = await owners(id);
      if (owned.size > 0 && !owned.has(firmId)) return emptyBundle(id);

      const firm = String(firmId);

      const accessLogResult = await db.execute(sql`
        SELECT log_id::text AS log_id,
               to_char(ts AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS ts,
               user_id::text AS user_id, firm_id::text AS firm_id, session_id::text AS session_id,
               instrument_id::text AS instrument_id, field_id, field_class::text AS field_class,
               source_id, requested_tier::text AS requested_tier, tier::text AS tier,
               usage::text AS usage, purpose, decision::text AS decision, reason,
               trace_id::text AS trace_id, details
          FROM access_log
         WHERE trace_id = ${id}::uuid
           AND firm_id  = ${firm}::bigint
         ORDER BY ts, log_id`);

      const usageResult = await db.execute(sql`
        SELECT to_char(ts AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS ts,
               kind, panel_id, code, params_hash, instrument_id::text AS instrument_id,
               duration_ms, trace_id::text AS trace_id, details
          FROM usage_events
         WHERE trace_id = ${id}::uuid
           AND firm_id  = ${firm}::bigint
         ORDER BY ts, event_id`);

      const provenanceResult = await db.execute(sql`
        SELECT p.provenance_id::text AS provenance_id, p.source_id, p.request_url, p.http_status,
               to_char(p.captured_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS captured_at,
               CASE WHEN p.source_ts IS NULL THEN NULL
                    ELSE to_char(p.source_ts AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS source_ts,
               p.request_key, l.attribution
          FROM provenance p
          LEFT JOIN LATERAL (
                 SELECT attribution
                   FROM licence_registry lr
                  WHERE lr.source_id = p.source_id
                    AND lr.tx_to = 'infinity'
                  ORDER BY lr.valid_from DESC
                  LIMIT 1) l ON true
         WHERE p.trace_id = ${id}::uuid
         ORDER BY p.captured_at, p.provenance_id`);

      const ingestResult = await db.execute(sql`
        SELECT run_id::text AS run_id, job_id, source_id,
               to_char(started_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS started_at,
               CASE WHEN finished_at IS NULL THEN NULL
                    ELSE to_char(finished_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS finished_at,
               status, fetched, inserted, updated, skipped, errors, trace_id::text AS trace_id
          FROM ingest_runs
         WHERE trace_id = ${id}::uuid
         ORDER BY started_at, run_id`);

      // RLS decides what of this the caller may see; the `sender_firm_id` predicate is not added
      // here because MSG-02 review is cross-firm by design within a room the caller belongs to.
      const messageResult = await db.execute(sql`
        SELECT m.message_id::text AS message_id, m.room_id::text AS room_id, m.seq::text AS seq,
               m.sender_user_id::text AS sender_user_id, m.sender_firm_id::text AS sender_firm_id,
               u.display_name AS sender_display,
               to_char(m.sent_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS sent_at,
               m.body, m.attachments, m.structured, m.client_msg_id::text AS client_msg_id,
               encode(m.prev_hash, 'hex') AS prev_hash, encode(m.hash, 'hex') AS hash,
               m.trace_id::text AS trace_id
          FROM messages m
          LEFT JOIN users u ON u.user_id = m.sender_user_id
         WHERE m.trace_id = ${id}::uuid
         ORDER BY m.sent_at, m.message_id`);

      const ticketResult = await db.execute(sql`
        SELECT ticket_id::text AS ticket_id,
               to_char(opened_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS opened_at,
               function_code, question, status, room_id::text AS room_id, answer,
               CASE WHEN answered_at IS NULL THEN NULL
                    ELSE to_char(answered_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS answered_at
          FROM help_tickets
         WHERE trace_id = ${id}::uuid
           AND firm_id  = ${firm}::bigint
         ORDER BY opened_at, ticket_id`);

      return {
        traceId: id,
        requests: [],
        accessLog: (accessLogResult.rows as unknown as AccessLogSqlRow[]).map(accessLogRow),
        usageEvents: (usageResult.rows as unknown as UsageEventSqlRow[]).map(usageEventRow),
        provenance: (provenanceResult.rows as unknown as ProvenanceSqlRow[]).map(provenanceRow),
        ingestRuns: (ingestResult.rows as unknown as IngestRunSqlRow[]).map(ingestRunRow),
        messages: (messageResult.rows as unknown as MessageSqlRow[]).map(messageRow),
        tickets: (ticketResult.rows as unknown as TicketSqlRow[]).map(ticketRow),
      };
    },
  };
}
