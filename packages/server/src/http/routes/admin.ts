/**
 * `http/routes/admin.ts` — the API.md §5.14 table (OPS-07, ENTL-06, DATA-02, DATA-09, REF-10,
 * REG-01, REG-04, MSG-02), WORKPLAN WP-07.
 *
 * Thirty-two routes over the operational tables: the OPS-07 trace join, declarations, the licence registry, entitlement
 * grants, the access log and its CSV export, the REF-10 exception queue, the corporate-action
 * review queue, data-quality events, ingest runs, the MSG-02 surveillance queue, legal holds, the
 * REG-01 message production, user administration including the REG-04 erasure, and the OPS-04
 * incident log.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. **The role column of the table is the guard.** Every route declares
 *     `requireSession({ roles })` with exactly the roles §5.14 lists. A role the table omits gets
 *     `403 FORBIDDEN`, and `test/integration/entitlements/routes.test.ts` walks the whole matrix.
 *  2. **Nothing is stubbed.** Where a subsystem does not exist yet (the corporate-action review
 *     desk, surveillance), the route is written against the tables the schema already has, so it
 *     returns the truth about an empty queue rather than a fake payload.
 *  3. **Every route is scoped to the caller's own firm.** RLS (migration 0015) covers the tenant
 *     DATA tables; it does NOT cover `users` or `access_log`, so those two carry their firm
 *     predicate in the SQL here. Without it an admin of one firm could rewrite another firm's
 *     accounts — including their passwords — and a compliance officer could read every other
 *     firm's access log. A platform-wide operator would be a distinct role, not the default.
 *  4. **Append, never rewrite.** `access_log` and `usage_events` are WORM; `corporate_actions` and
 *     `licence_registry` are bitemporal and their `bt_guard_update` trigger permits no UPDATE but
 *     `tx_to`. Both are versioned here the way `seed/licences.ts` versions them: close the current
 *     version, insert the new one, in one transaction.
 *
 * Request and response schemas come from `@terminal/sdk/wire/rest/admin` and are normative; this
 * module parses with them rather than restating them.
 *
 * Every handler runs inside `withTx(ctx, …)`, so `app.user_id` / `app.firm_id` / `app.role` are set
 * and the RLS policies of migration 0015 apply — which is what makes `/admin/export/messages`
 * return a compliance officer their own firm's rooms and nobody else's.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { Clock } from '@terminal/core';
import type { Role } from '@terminal/sdk/wire/rest/auth';
import {
  AccessLogQuery,
  ComplianceReviewQuery,
  CreateEntitlementRequest,
  CreateIncidentRequest,
  CreateLegalHoldRequest,
  CreateUserRequest,
  DeclarationQuery,
  DqQuery,
  EntitlementQuery,
  ExceptionQuery,
  ExportMessagesQuery,
  GenerateDeclarationsRequest,
  IncidentQuery,
  IncidentUpdateRequest,
  IngestRunQuery,
  PutLicenceRequest,
  ReconcileDeclarationRequest,
  ResolveExceptionRequest,
  ReviewCaRequest,
  TraceParams,
  UpdateComplianceReviewRequest,
  UpdateUserRequest,
  UserQuery,
} from '@terminal/sdk/wire/rest/admin';

import { withTx, type Db, type RequestCtx, type Tx } from '../../db/client.js';
import {
  generateDeclarations,
  listDeclarations,
  reconcileDeclaration,
  type DeclarationRow as GeneratedDeclarationRow,
} from '../../entitlements/declarations.js';
import { traceQuery } from '../../observability/traceQuery.js';
import { setPassword } from '../auth/password.js';
import { requireSession, type Principal } from '../auth/session.js';
import {
  AppError,
  AuthRequiredError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `to_char` mask rendering a timestamptz as the `z.iso.datetime()` the wire expects. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * `'infinity'` on the wire. `LicenceEntry.validTo` and `EntitlementGrant.validTo` are non-nullable
 * `z.iso.datetime()`, and `Infinity` has no ISO 8601 spelling, so the open end travels as the
 * largest timestamp the format carries and comes back the same way (see {@link isForever}).
 */
const FOREVER = '9999-12-31T23:59:59.999Z';

/** Anything in year 9999 or later means "no end" — see {@link FOREVER}. */
function isForever(iso: string): boolean {
  return iso >= '9999-01-01T00:00:00.000Z';
}

/** A CSV export without an explicit `limit` still refuses to build an unbounded string in memory. */
const CSV_ROW_CAP = 100_000;

const ROLES_ADMIN: readonly Role[] = ['admin'];
const ROLES_ADMIN_COMPLIANCE: readonly Role[] = ['admin', 'compliance'];
const ROLES_ADMIN_DATAOPS: readonly Role[] = ['admin', 'dataops'];
const ROLES_ADMIN_DATAOPS_HELPDESK: readonly Role[] = ['admin', 'dataops', 'helpdesk'];
const ROLES_ADMIN_DATAOPS_COMPLIANCE: readonly Role[] = ['admin', 'dataops', 'compliance'];
const ROLES_DATAOPS: readonly Role[] = ['dataops'];
const ROLES_COMPLIANCE: readonly Role[] = ['compliance'];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) throw new AuthRequiredError();
  return principal;
}

function ctxOf(principal: Principal): RequestCtx {
  return {
    userId: principal.userId,
    firmId: principal.firmId,
    role: principal.role,
    sessionId: principal.sessionId,
  };
}

interface AdminDeps {
  db: Db | Tx;
  clock: Clock;
  /** Optional: the ingest scheduler, wired by `index.ts` at startup step 8 (`AppDeps.scheduler`). */
  scheduler?: { runNow(jobId: string): Promise<string | null> };
}

function depsOf(request: FastifyRequest): AdminDeps {
  return request.server.deps;
}

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  location: 'body' | 'query' | 'params',
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationFailedError(location, result.error.issues);
  return result.data;
}

/** Query strings arrive as strings; coerce only the keys the wire schema types as number/boolean. */
function coerceQuery(
  raw: unknown,
  numbers: readonly string[] = [],
  booleans: readonly string[] = [],
): Record<string, unknown> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of numbers) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  for (const key of booleans) {
    const value = source[key];
    if (value === 'true' || value === '1') out[key] = true;
    else if (value === 'false' || value === '0') out[key] = false;
  }
  return out;
}

/** A positive integer path parameter, or `400`. */
function intParam(request: FastifyRequest, name: string): number {
  const params = request.params as Record<string, string | undefined>;
  const raw = params[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationFailedError('params', [{ path: [name], message: 'expected a positive integer' }]);
  }
  return value;
}

function stringParam(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, string | undefined>;
  const raw = params[name];
  if (raw === undefined || raw === '') {
    throw new ValidationFailedError('params', [{ path: [name], message: 'expected a non-empty string' }]);
  }
  return raw;
}

async function rows<R>(tx: Tx, query: SQL): Promise<R[]> {
  const result = await tx.execute(query);
  return result.rows as unknown as R[];
}

/**
 * Prove that `userId` belongs to `firmId`, or 404.
 *
 * `users` carries no RLS policy (migration 0015 covers the tenant DATA tables, not the directory),
 * so an admin of one firm is otherwise free to read, rewrite and re-credential any user of any
 * other. 404 rather than 403: a caller must not learn that a user id exists in another firm.
 */
async function assertSameFirm(tx: Tx, userId: number, firmId: number): Promise<void> {
  const found = await rows<{ user_id: string }>(
    tx,
    sql`SELECT user_id::text AS user_id FROM users WHERE user_id = ${userId} AND firm_id = ${firmId}`,
  );
  if (found[0] === undefined) throw new NotFoundError('No such user.');
}

/**
 * Write one `access_log` row for an administrative act on an account (SEC-01).
 *
 * A password reset or a role change is a privileged act on someone else's identity and has to leave
 * a trail the WORM trigger will not let anyone edit. It is written INSIDE the acting transaction —
 * this is not a hot path, and an audit row that could be lost with a buffer would not be one. The
 * row is attributed to the ACTING admin (`user_id`) with the subject in `details`.
 *
 * `tier` is NULL and `source_id` is the internal pseudo-source `internal.admin`: an administrative
 * act is not a data read, and `declarations.ts` filters on `tier IS NOT NULL`, so these rows can
 * never turn up in a monthly vendor declaration.
 */
async function logAdminAct(
  tx: Tx,
  clock: Clock,
  principal: Principal,
  traceId: string | null,
  what: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO access_log (ts, user_id, firm_id, session_id, instrument_id, field_id, field_class,
                            source_id, requested_tier, tier, usage, purpose, decision, reason,
                            trace_id, details)
    VALUES (${nowIso(clock)}::timestamptz, ${principal.userId}, ${principal.firmId},
            ${principal.sessionId}::uuid, NULL, ${what}, 'reference', 'internal.admin',
            'eod', NULL, 'display', ${`admin.${what}`}, 'allow', 'OK',
            ${traceId}::uuid, ${JSON.stringify(details)}::jsonb)`);
}

function nowIso(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** `sql.join` over a non-empty list of predicates — the WHERE of every filtered list route. */
function whereAll(parts: readonly SQL[]): SQL {
  return sql.join([...parts], sql` AND `);
}

// ── CSV (ARCHITECTURE §5.2 `CsvDocument`: UTF-8, RFC 4180 quoting, CRLF, no BOM) ──────────────

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
        ? value.toString()
        : JSON.stringify(value) ?? '';
  return /["\r\n,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvDocument(headers: readonly string[], records: readonly Record<string, unknown>[]): string {
  const lines = [headers.join(',')];
  for (const record of records) lines.push(headers.map((h) => csvCell(record[h])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function sendCsv(reply: FastifyReply, filename: string, body: string): string {
  void reply
    .type('text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`);
  return body;
}

// ── access-log cursor ─────────────────────────────────────────────────────────────────────────

/**
 * `access_log` is keyed `(ts, log_id)` — the primary key of the partitioned table — so the cursor
 * is that pair, base64url'd. Keyset pagination, not OFFSET: a compliance read walks millions of
 * rows and the batched writer keeps appending underneath it.
 */
interface LogCursor {
  ts: string;
  logId: number;
}

function encodeCursor(cursor: LogCursor): string {
  return Buffer.from(`${cursor.ts}|${String(cursor.logId)}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): LogCursor {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = text.lastIndexOf('|');
  const ts = sep === -1 ? '' : text.slice(0, sep);
  const logId = sep === -1 ? Number.NaN : Number(text.slice(sep + 1));
  if (ts === '' || Number.isNaN(Date.parse(ts)) || !Number.isInteger(logId)) {
    throw new BadRequestError('The cursor is not one this endpoint issued.');
  }
  return { ts, logId };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes returned by `tx.execute` (snake_case; bigint and numeric arrive as strings)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface DeclarationSqlRow {
  declaration_id: string;
  month: string;
  source_id: string;
  firm_id: string;
  field_class: string;
  tier: string;
  display_users: number;
  export_users: number;
  api_users: number;
  distinct_users: number;
  instrument_count: number;
  data_points: string;
  seat_count: number;
  generated_at: string;
  reconciled_at: string | null;
  billing_ref: string | null;
}

interface LicenceSqlRow {
  version_id: string;
  source_id: string;
  source_name: string;
  publisher: string;
  terms_url: string | null;
  contract_ref: string | null;
  licence_kind: string;
  display: boolean;
  non_display: boolean;
  derived: boolean;
  redistribution: boolean;
  export_allowed: boolean;
  api_allowed: boolean;
  max_tier: string;
  intrinsic_delay_min: number;
  retention_days: number | null;
  attribution: string;
  rate_limit: string | null;
  requires_user_agent: boolean;
  api_key_env: string | null;
  audit_obligation: string | null;
  notes: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

interface GrantSqlRow {
  grant_id: string;
  subject_kind: 'user' | 'firm';
  subject_id: string;
  source_id: string | null;
  asset_class: string | null;
  field_class: string | null;
  max_tier: string;
  usage_display: boolean;
  usage_export: boolean;
  usage_api: boolean;
  valid_from: string | null;
  valid_to: string | null;
  granted_by: string | null;
  contract_ref: string | null;
  note: string | null;
  created_at: string;
}

interface AccessLogSqlRow {
  log_id: string;
  ts: string;
  user_id: string;
  firm_id: string;
  session_id: string | null;
  instrument_id: string | null;
  field_id: string | null;
  field_class: string | null;
  source_id: string | null;
  requested_tier: string | null;
  tier: string | null;
  usage: string;
  purpose: string;
  decision: string;
  reason: string;
  trace_id: string | null;
  details: Record<string, unknown> | null;
}

interface ExceptionSqlRow {
  exception_id: string;
  created_at: string;
  kind: string;
  entity_kind: string | null;
  entity_id: string | null;
  field: string | null;
  candidates: unknown;
  reported_by: string | null;
  status: string;
  assignee_user_id: string | null;
  resolved_by: string | null;
  resolution: Record<string, unknown> | null;
  resolved_at: string | null;
  sla_due_at: string | null;
}

interface CorporateActionSqlRow {
  version_id: string;
  ca_id: string;
  instrument_id: string;
  ca_type: string;
  status: string;
  declared_date: string | null;
  ex_date: string;
  record_date: string | null;
  pay_date: string | null;
  effective_date: string | null;
  amount: number | null;
  currency: string | null;
  ratio_new: number | null;
  ratio_old: number | null;
  new_instrument_id: string | null;
  frequency: string | null;
  gross_or_net: string;
  details: Record<string, unknown> | null;
  source_id: string;
  review_state: string;
  reviewed_by: string | null;
}

interface DqSqlRow {
  dq_id: string;
  ts: string;
  kind: string;
  severity: string;
  instrument_id: string | null;
  md_line_id: string | null;
  source_id: string | null;
  subject: string | null;
  details: Record<string, unknown> | null;
  resolved_at: string | null;
}

interface IngestRunSqlRow {
  run_id: string;
  job_id: string;
  source_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
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
  sender_display: string;
  sent_at: string;
  body: string;
  attachments: unknown;
  structured: unknown;
  client_msg_id: string;
  prev_hash: string | null;
  hash: string;
  trace_id: string | null;
}

interface ReviewSqlRow extends MessageSqlRow {
  review_id: string;
  flagged_by: string;
  status: string;
}

interface HitSqlRow {
  message_id: string;
  term_id: string;
  pattern: string;
  matched_text: string;
}

interface LegalHoldSqlRow {
  hold_id: string;
  firm_id: string;
  scope: Record<string, unknown> | null;
  reason: string;
  created_by: string;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
}

interface UserSqlRow {
  user_id: string;
  firm_id: string;
  email: string;
  display_name: string;
  desk: string | null;
  role: string;
  status: string;
  person_verified_at: string | null;
  verified_by: string | null;
  mfa_required: boolean;
  sanctions_screened_at: string | null;
  sanctions_status: string | null;
  created_at: string;
  last_login_at: string | null;
  deprovisioned_at: string | null;
  anonymised_at: string | null;
}

interface IncidentSqlRow {
  incident_id: string;
  opened_at: string;
  closed_at: string | null;
  component: string;
  severity: string;
  title: string;
  updates: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row → wire
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `entitlements/declarations.ts` returns a richer row than the wire carries — it also knows the
 * `query_sql_hash` that produced it and whether the firm is inside its seat count. `DeclarationRow`
 * (API.md §5.14) is the subset a console shows.
 */
function toWireDeclaration(row: GeneratedDeclarationRow): Record<string, unknown> {
  return {
    declarationId: row.declarationId,
    month: row.month,
    sourceId: row.sourceId,
    firmId: row.firmId,
    fieldClass: row.fieldClass,
    tier: row.tier,
    displayUsers: row.displayUsers,
    exportUsers: row.exportUsers,
    apiUsers: row.apiUsers,
    distinctUsers: row.distinctUsers,
    instrumentCount: row.instrumentCount,
    dataPoints: row.dataPoints,
    seatCount: row.seatCount,
    generatedAt: row.generatedAt,
    reconciledAt: row.reconciledAt,
    billingRef: row.billingRef,
  };
}

function toDeclaration(row: DeclarationSqlRow): Record<string, unknown> {
  return {
    declarationId: Number(row.declaration_id),
    month: row.month,
    sourceId: row.source_id,
    firmId: Number(row.firm_id),
    fieldClass: row.field_class,
    tier: row.tier,
    displayUsers: Number(row.display_users),
    exportUsers: Number(row.export_users),
    apiUsers: Number(row.api_users),
    distinctUsers: Number(row.distinct_users),
    instrumentCount: Number(row.instrument_count),
    dataPoints: Number(row.data_points),
    seatCount: Number(row.seat_count),
    generatedAt: row.generated_at,
    reconciledAt: row.reconciled_at,
    billingRef: row.billing_ref,
  };
}

function toLicence(row: LicenceSqlRow): Record<string, unknown> {
  return {
    versionId: Number(row.version_id),
    sourceId: row.source_id,
    sourceName: row.source_name,
    publisher: row.publisher,
    termsUrl: row.terms_url,
    contractRef: row.contract_ref,
    licenceKind: row.licence_kind,
    display: row.display,
    nonDisplay: row.non_display,
    derived: row.derived,
    redistribution: row.redistribution,
    exportAllowed: row.export_allowed,
    apiAllowed: row.api_allowed,
    maxTier: row.max_tier,
    intrinsicDelayMin: Number(row.intrinsic_delay_min),
    retentionDays: row.retention_days === null ? null : Number(row.retention_days),
    attribution: row.attribution,
    rateLimit: row.rate_limit,
    requiresUserAgent: row.requires_user_agent,
    apiKeyEnv: row.api_key_env,
    auditObligation: row.audit_obligation,
    notes: row.notes,
    validFrom: row.valid_from ?? '0001-01-01T00:00:00.000Z',
    validTo: row.valid_to ?? FOREVER,
  };
}

function toGrant(row: GrantSqlRow): Record<string, unknown> {
  return {
    grantId: Number(row.grant_id),
    subjectKind: row.subject_kind,
    subjectId: Number(row.subject_id),
    sourceId: row.source_id,
    assetClass: row.asset_class,
    fieldClass: row.field_class,
    maxTier: row.max_tier,
    usageDisplay: row.usage_display,
    usageExport: row.usage_export,
    usageApi: row.usage_api,
    validFrom: row.valid_from ?? '0001-01-01T00:00:00.000Z',
    validTo: row.valid_to ?? FOREVER,
    grantedBy: row.granted_by === null ? null : Number(row.granted_by),
    contractRef: row.contract_ref,
    note: row.note,
    createdAt: row.created_at,
  };
}

function toAccessLog(row: AccessLogSqlRow): Record<string, unknown> {
  return {
    logId: Number(row.log_id),
    ts: row.ts,
    userId: Number(row.user_id),
    firmId: Number(row.firm_id),
    sessionId: row.session_id,
    instrumentId: row.instrument_id === null ? null : Number(row.instrument_id),
    fieldId: row.field_id,
    fieldClass: row.field_class,
    sourceId: row.source_id,
    requestedTier: row.requested_tier,
    tier: row.tier,
    usage: row.usage,
    purpose: row.purpose,
    decision: row.decision,
    reason: row.reason,
    traceId: row.trace_id,
    details: row.details ?? {},
  };
}

function toException(row: ExceptionSqlRow): Record<string, unknown> {
  return {
    exceptionId: Number(row.exception_id),
    createdAt: row.created_at,
    kind: row.kind,
    entityKind: row.entity_kind,
    entityId: row.entity_id === null ? null : Number(row.entity_id),
    field: row.field,
    candidates: row.candidates ?? [],
    reportedBy: row.reported_by === null ? null : Number(row.reported_by),
    status: row.status,
    assigneeUserId: row.assignee_user_id === null ? null : Number(row.assignee_user_id),
    resolvedBy: row.resolved_by === null ? null : Number(row.resolved_by),
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    slaDueAt: row.sla_due_at,
  };
}

function toCorporateAction(row: CorporateActionSqlRow): Record<string, unknown> {
  return {
    caId: Number(row.ca_id),
    instrumentId: Number(row.instrument_id),
    caType: row.ca_type,
    status: row.status,
    declaredDate: row.declared_date,
    exDate: row.ex_date,
    recordDate: row.record_date,
    payDate: row.pay_date,
    effectiveDate: row.effective_date,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    ratioNew: row.ratio_new === null ? null : Number(row.ratio_new),
    ratioOld: row.ratio_old === null ? null : Number(row.ratio_old),
    newInstrumentId: row.new_instrument_id === null ? null : Number(row.new_instrument_id),
    frequency: row.frequency,
    grossOrNet: row.gross_or_net,
    details: row.details ?? {},
    sourceId: row.source_id,
    reviewState: row.review_state,
    // `provIdx` indexes `meta.provenance`, which an admin queue response has no room for; the
    // provenance of the version is reachable through `/admin/trace` and the version row itself.
    provIdx: 0,
  };
}

function toDqEvent(row: DqSqlRow): Record<string, unknown> {
  return {
    dqId: Number(row.dq_id),
    ts: row.ts,
    kind: row.kind,
    severity: row.severity,
    instrumentId: row.instrument_id === null ? null : Number(row.instrument_id),
    mdLineId: row.md_line_id === null ? null : Number(row.md_line_id),
    sourceId: row.source_id,
    subject: row.subject,
    details: row.details ?? {},
    resolvedAt: row.resolved_at,
  };
}

function toIngestRun(row: IngestRunSqlRow): Record<string, unknown> {
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
    errors: row.errors ?? [],
    traceId: row.trace_id,
  };
}

function toMessage(row: MessageSqlRow): Record<string, unknown> {
  return {
    messageId: Number(row.message_id),
    roomId: Number(row.room_id),
    seq: Number(row.seq),
    senderUserId: Number(row.sender_user_id),
    senderFirmId: Number(row.sender_firm_id),
    senderDisplay: row.sender_display,
    sentAt: row.sent_at,
    body: row.body,
    attachments: row.attachments ?? [],
    structured: row.structured ?? null,
    clientMsgId: row.client_msg_id,
    prevHash: row.prev_hash,
    hash: row.hash,
    traceId: row.trace_id,
  };
}

function toLegalHold(row: LegalHoldSqlRow): Record<string, unknown> {
  return {
    holdId: Number(row.hold_id),
    firmId: Number(row.firm_id),
    scope: row.scope ?? {},
    reason: row.reason,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releasedBy: row.released_by === null ? null : Number(row.released_by),
  };
}

function toUser(row: UserSqlRow): Record<string, unknown> {
  return {
    userId: Number(row.user_id),
    firmId: Number(row.firm_id),
    email: row.email,
    displayName: row.display_name,
    desk: row.desk,
    role: row.role,
    status: row.status,
    personVerifiedAt: row.person_verified_at,
    verifiedBy: row.verified_by === null ? null : Number(row.verified_by),
    mfaRequired: row.mfa_required,
    sanctionsScreenedAt: row.sanctions_screened_at,
    sanctionsStatus: row.sanctions_status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    deprovisionedAt: row.deprovisioned_at,
    anonymisedAt: row.anonymised_at,
  };
}

function toIncident(row: IncidentSqlRow): Record<string, unknown> {
  return {
    incidentId: Number(row.incident_id),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    component: row.component,
    severity: row.severity,
    title: row.title,
    updates: row.updates ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Column lists (kept next to the mappers so a rename fails in one place)
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DECLARATION_COLUMNS = sql`
  declaration_id::text            AS declaration_id,
  to_char(month, 'YYYY-MM-DD')    AS month,
  source_id,
  firm_id::text                   AS firm_id,
  field_class::text               AS field_class,
  tier::text                      AS tier,
  display_users, export_users, api_users, distinct_users, instrument_count,
  data_points::text               AS data_points,
  seat_count,
  to_char(generated_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)})  AS generated_at,
  CASE WHEN reconciled_at IS NULL THEN NULL
       ELSE to_char(reconciled_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS reconciled_at,
  billing_ref`;

const LICENCE_COLUMNS = sql`
  version_id::text AS version_id, source_id, source_name, publisher, terms_url, contract_ref,
  licence_kind, display, non_display, derived, redistribution, export_allowed, api_allowed,
  max_tier::text AS max_tier, intrinsic_delay_min, retention_days, attribution, rate_limit,
  requires_user_agent, api_key_env, audit_obligation, notes,
  CASE WHEN valid_from = '-infinity' THEN NULL
       ELSE to_char(valid_from AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_from,
  CASE WHEN valid_to = 'infinity' THEN NULL
       ELSE to_char(valid_to AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_to`;

/**
 * Every non-bitemporal column of `licence_registry`, in one order, used as both the INSERT column
 * list and the SELECT list when a versioned write re-states a remainder (`writeVersion` step 2).
 */
const LICENCE_DATA_COLUMNS = sql.raw(
  [
    'source_id',
    'source_name',
    'publisher',
    'terms_url',
    'contract_ref',
    'licence_kind',
    'display',
    'non_display',
    'derived',
    'redistribution',
    'export_allowed',
    'api_allowed',
    'max_tier',
    'intrinsic_delay_min',
    'retention_days',
    'attribution',
    'rate_limit',
    'requires_user_agent',
    'api_key_env',
    'audit_obligation',
    'notes',
  ].join(', '),
);

const GRANT_COLUMNS = sql`
  grant_id::text AS grant_id, subject_kind, subject_id::text AS subject_id, source_id,
  asset_class::text AS asset_class, field_class::text AS field_class, max_tier::text AS max_tier,
  usage_display, usage_export, usage_api,
  CASE WHEN valid_from = '-infinity' THEN NULL
       ELSE to_char(valid_from AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_from,
  CASE WHEN valid_to = 'infinity' THEN NULL
       ELSE to_char(valid_to AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_to,
  granted_by::text AS granted_by, contract_ref, note,
  to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at`;

const ACCESS_LOG_COLUMNS = sql`
  log_id::text AS log_id,
  to_char(ts AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS ts,
  user_id::text AS user_id, firm_id::text AS firm_id, session_id::text AS session_id,
  instrument_id::text AS instrument_id, field_id, field_class::text AS field_class, source_id,
  requested_tier::text AS requested_tier, tier::text AS tier, usage::text AS usage,
  purpose, decision::text AS decision, reason, trace_id::text AS trace_id, details`;

const EXCEPTION_COLUMNS = sql`
  exception_id::text AS exception_id,
  to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
  kind, entity_kind::text AS entity_kind, entity_id::text AS entity_id, field, candidates,
  reported_by::text AS reported_by, status, assignee_user_id::text AS assignee_user_id,
  resolved_by::text AS resolved_by, resolution,
  CASE WHEN resolved_at IS NULL THEN NULL
       ELSE to_char(resolved_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS resolved_at,
  CASE WHEN sla_due_at IS NULL THEN NULL
       ELSE to_char(sla_due_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS sla_due_at`;

const CA_COLUMNS = sql`
  version_id::text AS version_id, ca_id::text AS ca_id, instrument_id::text AS instrument_id,
  ca_type::text AS ca_type, status::text AS status,
  to_char(declared_date, 'YYYY-MM-DD') AS declared_date,
  to_char(ex_date, 'YYYY-MM-DD')       AS ex_date,
  to_char(record_date, 'YYYY-MM-DD')   AS record_date,
  to_char(pay_date, 'YYYY-MM-DD')      AS pay_date,
  to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
  amount::float8 AS amount, currency, ratio_new::float8 AS ratio_new, ratio_old::float8 AS ratio_old,
  new_instrument_id::text AS new_instrument_id, frequency, gross_or_net, details, source_id,
  review_state, reviewed_by::text AS reviewed_by`;

const DQ_COLUMNS = sql`
  dq_id::text AS dq_id, to_char(ts AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS ts,
  kind, severity, instrument_id::text AS instrument_id, md_line_id::text AS md_line_id,
  source_id, subject, details,
  CASE WHEN resolved_at IS NULL THEN NULL
       ELSE to_char(resolved_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS resolved_at`;

const INGEST_RUN_COLUMNS = sql`
  run_id::text AS run_id, job_id, source_id,
  to_char(started_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS started_at,
  CASE WHEN finished_at IS NULL THEN NULL
       ELSE to_char(finished_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS finished_at,
  status, fetched, inserted, updated, skipped, errors, trace_id::text AS trace_id`;

const MESSAGE_COLUMNS = sql`
  m.message_id::text AS message_id, m.room_id::text AS room_id, m.seq::text AS seq,
  m.sender_user_id::text AS sender_user_id, m.sender_firm_id::text AS sender_firm_id,
  u.display_name AS sender_display,
  to_char(m.sent_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS sent_at,
  m.body, m.attachments, m.structured, m.client_msg_id::text AS client_msg_id,
  encode(m.prev_hash, 'hex') AS prev_hash, encode(m.hash, 'hex') AS hash,
  m.trace_id::text AS trace_id`;

const HOLD_COLUMNS = sql`
  hold_id::text AS hold_id, firm_id::text AS firm_id, scope, reason,
  created_by::text AS created_by,
  to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
  CASE WHEN released_at IS NULL THEN NULL
       ELSE to_char(released_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS released_at,
  released_by::text AS released_by`;

const USER_COLUMNS = sql`
  user_id::text AS user_id, firm_id::text AS firm_id, email, display_name, desk, role, status,
  CASE WHEN person_verified_at IS NULL THEN NULL
       ELSE to_char(person_verified_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS person_verified_at,
  verified_by::text AS verified_by, mfa_required,
  CASE WHEN sanctions_screened_at IS NULL THEN NULL
       ELSE to_char(sanctions_screened_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS sanctions_screened_at,
  sanctions_status,
  to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
  CASE WHEN last_login_at IS NULL THEN NULL
       ELSE to_char(last_login_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS last_login_at,
  CASE WHEN deprovisioned_at IS NULL THEN NULL
       ELSE to_char(deprovisioned_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS deprovisioned_at,
  CASE WHEN anonymised_at IS NULL THEN NULL
       ELSE to_char(anonymised_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS anonymised_at`;

const INCIDENT_COLUMNS = sql`
  incident_id::text AS incident_id,
  to_char(opened_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS opened_at,
  CASE WHEN closed_at IS NULL THEN NULL
       ELSE to_char(closed_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS closed_at,
  component, severity, title, updates`;

/** The CSV header of `/admin/access-log/export.csv` — the `AccessLogRow` keys, in wire order. */
const ACCESS_LOG_CSV_HEADERS = [
  'logId',
  'ts',
  'userId',
  'firmId',
  'sessionId',
  'instrumentId',
  'fieldId',
  'fieldClass',
  'sourceId',
  'requestedTier',
  'tier',
  'usage',
  'purpose',
  'decision',
  'reason',
  'traceId',
  'details',
] as const;

/** The CSV header of `/admin/declarations?format=csv` — the `DeclarationRow` keys. */
const DECLARATION_CSV_HEADERS = [
  'declarationId',
  'month',
  'sourceId',
  'firmId',
  'fieldClass',
  'tier',
  'displayUsers',
  'exportUsers',
  'apiUsers',
  'distinctUsers',
  'instrumentCount',
  'dataPoints',
  'seatCount',
  'generatedAt',
  'reconciledAt',
  'billingRef',
] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // ═══ Trace (OPS-07) ═══════════════════════════════════════════════════════════════════

  // The join itself is `observability/traceQuery.ts` (WP-08): it owns the firm scoping, which
  // `access_log` and `usage_events` cannot get from RLS because migration 0015 gives them no
  // policy. This route is the guard, the parse and the transaction, and nothing else.
  app.get(
    '/admin/trace/:traceId',
    { preHandler: requireSession({ roles: ROLES_ADMIN_DATAOPS_HELPDESK }) },
    async (request) => {
      const principal = principalOf(request);
      const params = parse(TraceParams, request.params, 'params');
      return withTx(ctxOf(principal), (tx) =>
        traceQuery(tx).byTraceId(params.traceId, principal.firmId),
      );
    },
  );

  // ═══ Declarations (ENTL-06, DATA-02) ═══════════════════════════════════════════════════════

  app.get(
    '/admin/declarations',
    { preHandler: requireSession({ roles: ROLES_ADMIN_COMPLIANCE }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const query = parse(DeclarationQuery, coerceQuery(request.query, ['firmId']), 'query');

      const items = await withTx(ctxOf(principal), async (tx) => {
        const found = await listDeclarations(tx, {
          month: query.month,
          ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
          ...(query.firmId === undefined ? {} : { firmId: query.firmId }),
        });
        return found.map(toWireDeclaration);
      });

      if (query.format === 'csv') {
        return sendCsv(
          reply,
          `declarations-${query.month}.csv`,
          csvDocument(DECLARATION_CSV_HEADERS, items),
        );
      }
      return { items };
    },
  );

  app.post(
    '/admin/declarations/generate',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const body = parse(GenerateDeclarationsRequest, request.body, 'body');

      const runId = await withTx(ctxOf(principal), async (tx) => {
        const started = await rows<{ run_id: string }>(
          tx,
          sql`INSERT INTO ingest_runs (job_id, started_at, status, trace_id)
              VALUES ('usageDeclarations', ${nowIso(clock)}::timestamptz, 'running', ${request.traceId}::uuid)
              RETURNING run_id::text AS run_id`,
        );
        const id = Number(started[0]?.run_id ?? Number.NaN);
        if (!Number.isInteger(id)) throw new AppError('INTERNAL', 'ingest_runs insert returned no id.');

        try {
          const result = await generateDeclarations({ db: tx, clock }, body.month);
          await tx.execute(sql`
            UPDATE ingest_runs
               SET status = 'ok', finished_at = ${nowIso(clock)}::timestamptz,
                   fetched = ${result.rows.length}, inserted = ${result.inserted},
                   updated = ${result.updated}
             WHERE run_id = ${id}`);
        } catch (cause) {
          await tx.execute(sql`
            UPDATE ingest_runs
               SET status = 'failed', finished_at = ${nowIso(clock)}::timestamptz,
                   errors = ${JSON.stringify([
                     { code: 'DECLARATIONS_FAILED', message: String(cause) },
                   ])}::jsonb
             WHERE run_id = ${id}`);
          throw cause;
        }
        return id;
      });

      void reply.status(202);
      return { runId };
    },
  );

  app.post(
    '/admin/declarations/:declarationId/reconcile',
    { preHandler: requireSession({ roles: ROLES_ADMIN_COMPLIANCE }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const declarationId = intParam(request, 'declarationId');
      const body = parse(ReconcileDeclarationRequest, request.body, 'body');

      return withTx(ctxOf(principal), async (tx) => {
        const ok = await reconcileDeclaration({ db: tx, clock }, declarationId, body.billingRef);
        if (!ok) throw new NotFoundError('No such declaration.');
        const found = await rows<DeclarationSqlRow>(
          tx,
          sql`SELECT ${DECLARATION_COLUMNS} FROM usage_declarations
               WHERE declaration_id = ${declarationId}`,
        );
        const row = found[0];
        if (row === undefined) throw new NotFoundError('No such declaration.');
        return toDeclaration(row);
      });
    },
  );

  // ═══ Licence registry (DATA-09) ════════════════════════════════════════════════════════════

  app.get(
    '/admin/licences',
    { preHandler: requireSession({ roles: ROLES_ADMIN_DATAOPS_COMPLIANCE }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      return withTx(ctxOf(principal), async (tx) => {
        const found = await rows<LicenceSqlRow>(
          tx,
          sql`SELECT ${LICENCE_COLUMNS} FROM licence_registry
               WHERE tx_to = 'infinity' AND valid_to > ${nowIso(clock)}::timestamptz
               ORDER BY source_id`,
        );
        return { items: found.map(toLicence) };
      });
    },
  );

  /**
   * A new bitemporal version of one source's terms. The mechanics are `seed/licences.ts`'s: close
   * every current version whose valid range the new one touches, then insert. `writeVersion` is the
   * generic path, and it requires a `provenance_id`; a licence edited by an administrator is not a
   * provider exchange, so this write carries `provenance_id = NULL` exactly as the seed's does.
   *
   * The INSERT fires `licence_registry_bump`, which moves `config_versions('entitlements')` — that
   * is how a running evaluator's `LicenceRegistry.refreshIfStale()` learns to reload.
   */
  app.put(
    '/admin/licences/:sourceId',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request) => {
      const principal = principalOf(request);
      const sourceId = stringParam(request, 'sourceId');
      const body = parse(PutLicenceRequest, request.body, 'body');
      const validTo = isForever(body.validTo)
        ? sql`'infinity'::timestamptz`
        : sql`${body.validTo}::timestamptz`;

      return withTx(ctxOf(principal), async (tx) => {
        const known = await rows<{ source_id: string }>(
          tx,
          sql`SELECT source_id FROM licence_registry WHERE source_id = ${sourceId} LIMIT 1`,
        );
        if (known[0] === undefined) {
          throw new NotFoundError(`No licence registered for source ${sourceId}.`);
        }

        // One knowledge instant for the whole write, exactly as `writeVersion` does — and read
        // from the DATABASE, not the injected clock: `tx_to` must be after the closed row's
        // `tx_from` or `bt_guard_update` refuses the UPDATE, and a virtual clock is free to sit
        // in the past. Business time (`valid_from`/`valid_to`) is the caller's; this is not.
        const instant = await rows<{ now: string }>(
          tx,
          sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS now`,
        );
        const txAt = instant[0]?.now;
        if (txAt === undefined) throw new AppError('INTERNAL', 'clock_timestamp() returned no row.');

        // Step 1a of `writeVersion`: which current versions does the new range touch, and how do
        // they stick out? Read before the close, while `tx_to = 'infinity'` still identifies them.
        const overlapping = await rows<{ version_id: string; head: boolean; tail: boolean }>(
          tx,
          sql`SELECT version_id::text AS version_id,
                     (valid_from < ${body.validFrom}::timestamptz) AS head,
                     (valid_to   > ${validTo})                     AS tail
                FROM licence_registry
               WHERE source_id = ${sourceId}
                 AND tx_to = 'infinity'
                 AND tstzrange(valid_from, valid_to, '[)')
                  && tstzrange(${body.validFrom}::timestamptz, ${validTo}, '[)')`);

        await tx.execute(sql`
          UPDATE licence_registry SET tx_to = ${txAt}::timestamptz
           WHERE source_id = ${sourceId}
             AND tx_to = 'infinity'
             AND tstzrange(valid_from, valid_to, '[)')
              && tstzrange(${body.validFrom}::timestamptz, ${validTo}, '[)')`);

        // Step 2: re-state the parts of the closed versions that stick out of the new range, with
        // their old data — otherwise a narrower new version would silently erase the terms that
        // applied before it.
        for (const row of overlapping) {
          const versionId = Number(row.version_id);
          if (row.head) {
            await tx.execute(sql`
              INSERT INTO licence_registry (${LICENCE_DATA_COLUMNS},
                          valid_from, valid_to, tx_from, tx_to, provenance_id)
              SELECT ${LICENCE_DATA_COLUMNS},
                     valid_from, ${body.validFrom}::timestamptz, ${txAt}::timestamptz,
                     'infinity', provenance_id
                FROM licence_registry WHERE version_id = ${versionId}`);
          }
          if (row.tail) {
            await tx.execute(sql`
              INSERT INTO licence_registry (${LICENCE_DATA_COLUMNS},
                          valid_from, valid_to, tx_from, tx_to, provenance_id)
              SELECT ${LICENCE_DATA_COLUMNS},
                     ${validTo}, valid_to, ${txAt}::timestamptz, 'infinity', provenance_id
                FROM licence_registry WHERE version_id = ${versionId}`);
          }
        }

        const inserted = await rows<LicenceSqlRow>(
          tx,
          sql`INSERT INTO licence_registry (
                source_id, source_name, publisher, terms_url, contract_ref, licence_kind,
                display, non_display, derived, redistribution, export_allowed, api_allowed,
                max_tier, intrinsic_delay_min, retention_days, attribution, rate_limit,
                requires_user_agent, api_key_env, audit_obligation, notes,
                valid_from, valid_to, tx_from, tx_to, provenance_id)
              VALUES (
                ${sourceId}, ${body.sourceName}, ${body.publisher}, ${body.termsUrl},
                ${body.contractRef}, ${body.licenceKind},
                ${body.display}, ${body.nonDisplay}, ${body.derived}, ${body.redistribution},
                ${body.exportAllowed}, ${body.apiAllowed},
                ${body.maxTier}::tier, ${body.intrinsicDelayMin}, ${body.retentionDays},
                ${body.attribution}, ${body.rateLimit},
                ${body.requiresUserAgent}, ${body.apiKeyEnv}, ${body.auditObligation}, ${body.notes},
                ${body.validFrom}::timestamptz, ${validTo}, ${txAt}::timestamptz, 'infinity', NULL)
           RETURNING ${LICENCE_COLUMNS}`,
        );
        const row = inserted[0];
        if (row === undefined) throw new AppError('INTERNAL', 'licence insert returned no row.');
        return toLicence(row);
      });
    },
  );

  // ═══ Entitlement grants ════════════════════════════════════════════════════════════════════

  app.get(
    '/admin/entitlements',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request) => {
      const principal = principalOf(request);
      const query = parse(EntitlementQuery, coerceQuery(request.query, ['subjectId']), 'query');

      return withTx(ctxOf(principal), async (tx) => {
        // Every grant the table holds, in force or not: an administrator deciding what to grant
        // needs to see the one that expired last week as much as the one running today. The
        // evaluator filters on validity itself, at every call.
        const parts: SQL[] = [sql`true`];
        if (query.subjectKind !== undefined) parts.push(sql`subject_kind = ${query.subjectKind}`);
        if (query.subjectId !== undefined) parts.push(sql`subject_id = ${query.subjectId}`);
        if (query.sourceId !== undefined) parts.push(sql`source_id = ${query.sourceId}`);
        const found = await rows<GrantSqlRow>(
          tx,
          sql`SELECT ${GRANT_COLUMNS} FROM entitlement_grants
               WHERE ${whereAll(parts)} ORDER BY grant_id`,
        );
        return { items: found.map(toGrant) };
      });
    },
  );

  app.post(
    '/admin/entitlements',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const body = parse(CreateEntitlementRequest, request.body, 'body');
      const validFrom = body.validFrom ?? nowIso(clock);
      const validTo =
        body.validTo === undefined || isForever(body.validTo)
          ? sql`'infinity'::timestamptz`
          : sql`${body.validTo}::timestamptz`;

      const grant = await withTx(ctxOf(principal), async (tx) => {
        const inserted = await rows<GrantSqlRow>(
          tx,
          sql`INSERT INTO entitlement_grants (
                subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
                usage_display, usage_export, usage_api, valid_from, valid_to, granted_by,
                contract_ref, note)
              VALUES (
                ${body.subjectKind}, ${body.subjectId}, ${body.sourceId ?? null},
                ${body.assetClass ?? null}::asset_class, ${body.fieldClass ?? null}::field_class,
                ${body.maxTier}::tier,
                ${body.usageDisplay ?? true}, ${body.usageExport ?? false}, ${body.usageApi ?? false},
                ${validFrom}::timestamptz, ${validTo}, ${principal.userId},
                ${body.contractRef ?? null}, ${body.note ?? null})
           RETURNING ${GRANT_COLUMNS}`,
        );
        const row = inserted[0];
        if (row === undefined) throw new AppError('INTERNAL', 'grant insert returned no row.');
        return toGrant(row);
      });

      void reply.status(201);
      return grant;
    },
  );

  /**
   * `entitlement_grants` is a live policy table, not an audit trail: what was *decided* under a
   * grant is in `access_log`, which is WORM and carries the source, the tier and the reason for
   * every field ever served. So a grant is deleted, which is also what migration 0014's
   * `entitlement_grants_bump` expects — it fires on DELETE as well as INSERT and UPDATE, which is
   * how a running evaluator learns the grant is gone. To end a grant without erasing it, PUT a
   * `validTo` instead.
   */
  app.delete(
    '/admin/entitlements/:grantId',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const grantId = intParam(request, 'grantId');

      await withTx(ctxOf(principal), async (tx) => {
        const deleted = await rows<{ grant_id: string }>(
          tx,
          sql`DELETE FROM entitlement_grants WHERE grant_id = ${grantId}
           RETURNING grant_id::text AS grant_id`,
        );
        if (deleted[0] === undefined) throw new NotFoundError('No such grant.');
      });

      void reply.status(204);
    },
  );

  // ═══ Access log (ENTL-04) ══════════════════════════════════════════════════════════════════

  /**
   * The filters of `GET /admin/access-log`, **always** scoped to the caller's own firm.
   *
   * `access_log` carries the WORM trigger of migration 0015 and no RLS policy, so `withTx`'s
   * `app.firm_id` is never consulted for it: the firm predicate has to be written here or every
   * firm's compliance officer reads every other firm's reads — who looked at which field of which
   * instrument, at which tier, for what purpose. That is the most sensitive cross-tenant artefact
   * in the system. A platform-wide auditor would be a distinct role, not every firm's own.
   */
  const accessLogPredicates = (
    query: z.infer<typeof AccessLogQuery>,
    firmId: number,
  ): SQL[] => {
    const parts: SQL[] = [
      sql`firm_id = ${firmId}`,
      sql`ts >= ${query.from}::timestamptz`,
      sql`ts <= ${query.to}::timestamptz`,
    ];
    if (query.userId !== undefined) parts.push(sql`user_id = ${query.userId}`);
    if (query.instrumentId !== undefined) parts.push(sql`instrument_id = ${query.instrumentId}`);
    if (query.sourceId !== undefined) parts.push(sql`source_id = ${query.sourceId}`);
    if (query.decision !== undefined) parts.push(sql`decision = ${query.decision}::entl_decision`);
    return parts;
  };

  app.get(
    '/admin/access-log',
    { preHandler: requireSession({ roles: ROLES_ADMIN_COMPLIANCE }) },
    async (request) => {
      const principal = principalOf(request);
      const query = parse(
        AccessLogQuery,
        coerceQuery(request.query, ['userId', 'instrumentId', 'limit']),
        'query',
      );

      return withTx(ctxOf(principal), async (tx) => {
        if (query.userId !== undefined) await assertSameFirm(tx, query.userId, principal.firmId);
        const parts = accessLogPredicates(query, principal.firmId);
        if (query.cursor !== undefined) {
          const cursor = decodeCursor(query.cursor);
          parts.push(sql`(ts, log_id) > (${cursor.ts}::timestamptz, ${cursor.logId}::bigint)`);
        }
        const found = await rows<AccessLogSqlRow>(
          tx,
          sql`SELECT ${ACCESS_LOG_COLUMNS} FROM access_log
               WHERE ${whereAll(parts)}
               ORDER BY ts, log_id
               LIMIT ${query.limit}`,
        );
        const items = found.map(toAccessLog);
        const last = found[found.length - 1];
        const nextCursor =
          found.length === query.limit && last !== undefined
            ? encodeCursor({ ts: last.ts, logId: Number(last.log_id) })
            : null;
        return { items, nextCursor };
      });
    },
  );

  app.get(
    '/admin/access-log/export.csv',
    { preHandler: requireSession({ roles: ROLES_ADMIN_COMPLIANCE }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const raw = coerceQuery(request.query, ['userId', 'instrumentId', 'limit']);
      const query = parse(AccessLogQuery, raw, 'query');
      // `limit` defaults to 200 for the paged JSON route; an export the caller did not bound takes
      // every matching row, up to the in-memory cap.
      const cap = raw.limit === undefined ? CSV_ROW_CAP : query.limit;

      const body = await withTx(ctxOf(principal), async (tx) => {
        if (query.userId !== undefined) await assertSameFirm(tx, query.userId, principal.firmId);
        const found = await rows<AccessLogSqlRow>(
          tx,
          sql`SELECT ${ACCESS_LOG_COLUMNS} FROM access_log
               WHERE ${whereAll(accessLogPredicates(query, principal.firmId))}
               ORDER BY ts, log_id
               LIMIT ${cap}`,
        );
        return csvDocument(
          ACCESS_LOG_CSV_HEADERS,
          found.map(toAccessLog),
        );
      });

      return sendCsv(reply, 'access-log.csv', body);
    },
  );

  // ═══ Data exceptions (REF-10) ══════════════════════════════════════════════════════════════

  app.get(
    '/admin/exceptions',
    { preHandler: requireSession({ roles: ROLES_ADMIN_DATAOPS }) },
    async (request) => {
      const principal = principalOf(request);
      const query = parse(ExceptionQuery, coerceQuery(request.query, ['assignee']), 'query');

      return withTx(ctxOf(principal), async (tx) => {
        const parts: SQL[] = [sql`true`];
        if (query.status !== undefined) parts.push(sql`status = ${query.status}`);
        if (query.kind !== undefined) parts.push(sql`kind = ${query.kind}`);
        if (query.assignee !== undefined) parts.push(sql`assignee_user_id = ${query.assignee}`);
        const found = await rows<ExceptionSqlRow>(
          tx,
          sql`SELECT ${EXCEPTION_COLUMNS} FROM data_exceptions
               WHERE ${whereAll(parts)}
               ORDER BY sla_due_at NULLS LAST, exception_id`,
        );
        return { items: found.map(toException) };
      });
    },
  );

  app.post(
    '/admin/exceptions/:exceptionId/resolve',
    { preHandler: requireSession({ roles: ROLES_DATAOPS }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const exceptionId = intParam(request, 'exceptionId');
      const body = parse(ResolveExceptionRequest, request.body, 'body');

      return withTx(ctxOf(principal), async (tx) => {
        const current = await rows<ExceptionSqlRow>(
          tx,
          sql`SELECT ${EXCEPTION_COLUMNS} FROM data_exceptions WHERE exception_id = ${exceptionId}`,
        );
        const row = current[0];
        if (row === undefined) throw new NotFoundError('No such exception.');
        if (row.status !== 'open') throw new BadRequestError('This exception is already closed.');

        const resolution = {
          chosenProvenanceId: body.chosenProvenanceId ?? null,
          versionId: null,
          note: body.note,
        };
        const updated = await rows<ExceptionSqlRow>(
          tx,
          sql`UPDATE data_exceptions
                 SET status = ${body.action === 'accept' ? 'resolved' : 'rejected'},
                     resolved_by = ${principal.userId},
                     resolved_at = ${nowIso(clock)}::timestamptz,
                     resolution = ${JSON.stringify(resolution)}::jsonb
               WHERE exception_id = ${exceptionId}
           RETURNING ${EXCEPTION_COLUMNS}`,
        );
        const after = updated[0];
        if (after === undefined) throw new NotFoundError('No such exception.');
        return toException(after);
      });
    },
  );

  // ═══ Corporate-action review queue (DATA-08) ═══════════════════════════════════════════════

  app.get(
    '/admin/ca-queue',
    { preHandler: requireSession({ roles: ROLES_DATAOPS }) },
    async (request) => {
      const principal = principalOf(request);
      return withTx(ctxOf(principal), async (tx) => {
        const found = await rows<CorporateActionSqlRow>(
          tx,
          sql`SELECT ${CA_COLUMNS} FROM corporate_actions
               WHERE tx_to = 'infinity' AND review_state = 'queued'
               ORDER BY ex_date, ca_id`,
        );
        return { items: found.map(toCorporateAction) };
      });
    },
  );

  /**
   * DATA-08 dual key: `corporate_actions` is bitemporal and `bt_guard_update` permits no UPDATE but
   * `tx_to`, so a review is a new version — same valid range, same provenance, later transaction
   * time (a `'correction'` in `writeVersion`'s vocabulary). The reviewer may not be the person
   * already recorded on the row.
   */
  app.post(
    '/admin/ca-queue/:caId/review',
    { preHandler: requireSession({ roles: ROLES_DATAOPS }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const caId = intParam(request, 'caId');
      const body = parse(ReviewCaRequest, request.body, 'body');

      return withTx(ctxOf(principal), async (tx) => {
        const current = await rows<CorporateActionSqlRow>(
          tx,
          sql`SELECT ${CA_COLUMNS} FROM corporate_actions
               WHERE ca_id = ${caId} AND tx_to = 'infinity'
               ORDER BY valid_from DESC LIMIT 1`,
        );
        const row = current[0];
        if (row === undefined) throw new NotFoundError('No such corporate action.');
        if (row.review_state !== 'queued') {
          throw new BadRequestError('This corporate action is not queued for review.');
        }
        if (row.reviewed_by !== null && Number(row.reviewed_by) === principal.userId) {
          throw new ForbiddenError('DATA-08: the reviewer may not be the person who filed the row.');
        }

        await tx.execute(sql`
          UPDATE corporate_actions SET tx_to = clock_timestamp()
           WHERE version_id = ${Number(row.version_id)} AND tx_to = 'infinity'`);

        const inserted = await rows<CorporateActionSqlRow>(
          tx,
          sql`INSERT INTO corporate_actions (
                ca_id, instrument_id, ca_type, status, declared_date, ex_date, record_date, pay_date,
                effective_date, amount, currency, ratio_new, ratio_old, new_instrument_id, frequency,
                gross_or_net, details, note, source_id, review_state, reviewed_by, reviewed_at,
                valid_from, valid_to, tx_from, tx_to, provenance_id)
              SELECT ca_id, instrument_id, ca_type, status, declared_date, ex_date, record_date,
                     pay_date, effective_date, amount, currency, ratio_new, ratio_old,
                     new_instrument_id, frequency, gross_or_net, details,
                     ${body.note ?? null}, source_id,
                     ${body.decision}, ${principal.userId}, ${nowIso(clock)}::timestamptz,
                     valid_from, valid_to, clock_timestamp(), 'infinity', provenance_id
                FROM corporate_actions
               WHERE version_id = ${Number(row.version_id)}
           RETURNING ${CA_COLUMNS}`,
        );
        const after = inserted[0];
        if (after === undefined) throw new AppError('INTERNAL', 'CA review insert returned no row.');
        return toCorporateAction(after);
      });
    },
  );

  // ═══ Data quality (OPS-03) ═════════════════════════════════════════════════════════════════

  app.get(
    '/admin/dq',
    { preHandler: requireSession({ roles: ROLES_ADMIN_DATAOPS }) },
    async (request) => {
      const principal = principalOf(request);
      const query = parse(DqQuery, coerceQuery(request.query, [], ['open']), 'query');

      return withTx(ctxOf(principal), async (tx) => {
        const parts: SQL[] = [sql`true`];
        if (query.open === true) parts.push(sql`resolved_at IS NULL`);
        if (query.kind !== undefined) parts.push(sql`kind = ${query.kind}`);
        if (query.since !== undefined) parts.push(sql`ts >= ${query.since}::timestamptz`);
        const found = await rows<DqSqlRow>(
          tx,
          sql`SELECT ${DQ_COLUMNS} FROM dq_events
               WHERE ${whereAll(parts)} ORDER BY ts DESC, dq_id DESC LIMIT 1000`,
        );
        return { items: found.map(toDqEvent) };
      });
    },
  );

  app.post(
    '/admin/dq/:dqId/resolve',
    { preHandler: requireSession({ roles: ROLES_DATAOPS }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const dqId = intParam(request, 'dqId');

      await withTx(ctxOf(principal), async (tx) => {
        const updated = await rows<{ dq_id: string }>(
          tx,
          sql`UPDATE dq_events SET resolved_at = ${nowIso(clock)}::timestamptz
               WHERE dq_id = ${dqId} AND resolved_at IS NULL
           RETURNING dq_id::text AS dq_id`,
        );
        if (updated[0] === undefined) throw new NotFoundError('No such open dq event.');
      });

      void reply.status(204);
    },
  );

  // ═══ Ingest runs ═══════════════════════════════════════════════════════════════════════════

  app.get(
    '/admin/ingest/runs',
    { preHandler: requireSession({ roles: ROLES_ADMIN_DATAOPS }) },
    async (request) => {
      const principal = principalOf(request);
      const query = parse(IngestRunQuery, coerceQuery(request.query, ['limit']), 'query');

      return withTx(ctxOf(principal), async (tx) => {
        const parts: SQL[] = [sql`true`];
        if (query.job !== undefined) parts.push(sql`job_id = ${query.job}`);
        const found = await rows<IngestRunSqlRow>(
          tx,
          sql`SELECT ${INGEST_RUN_COLUMNS} FROM ingest_runs
               WHERE ${whereAll(parts)}
               ORDER BY started_at DESC, run_id DESC
               LIMIT ${query.limit}`,
        );
        return { items: found.map(toIngestRun) };
      });
    },
  );

  /**
   * On demand, through the scheduler itself — `Scheduler.runNow` is the method that respects the
   * one-instance rule, the provider buckets and the `ingest-leader` advisory lock. A `null` answer
   * means this node is a follower or the job is already in flight, which API.md's own note calls a
   * 409. A process without a scheduler (a test app, a web-only node) says so with `503 STARTING`
   * rather than pretending to have queued something.
   */
  app.post(
    '/admin/ingest/run/:jobId',
    { preHandler: requireSession({ roles: ROLES_ADMIN_DATAOPS }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const { scheduler } = depsOf(request);
      const jobId = stringParam(request, 'jobId');
      if (scheduler === undefined) {
        throw new AppError('STARTING', 'The ingest scheduler is not running in this process.', {
          retryAfterMs: 5_000,
        });
      }

      let status: string | null;
      try {
        status = await scheduler.runNow(jobId);
      } catch (cause) {
        throw new NotFoundError(`No such ingest job: ${jobId}`, 'NOT_FOUND', {
          cause: String(cause),
        });
      }
      if (status === null) {
        throw new AppError(
          'DUPLICATE_NAME',
          'That job is already running, or this node is not the ingest leader.',
        );
      }

      const runId = await withTx(ctxOf(principal), async (tx) => {
        const found = await rows<{ run_id: string }>(
          tx,
          sql`SELECT run_id::text AS run_id FROM ingest_runs
               WHERE job_id = ${jobId} ORDER BY started_at DESC, run_id DESC LIMIT 1`,
        );
        return Number(found[0]?.run_id ?? 0);
      });

      void reply.status(202);
      return { runId };
    },
  );

  // ═══ Compliance: surveillance reviews (MSG-02) ═════════════════════════════════════════════

  async function reviewsWith(tx: Tx, parts: readonly SQL[]): Promise<Record<string, unknown>[]> {
    const found = await rows<ReviewSqlRow>(
      tx,
      sql`SELECT r.review_id::text AS review_id, r.flagged_by, r.status, ${MESSAGE_COLUMNS}
            FROM message_reviews r
            JOIN messages m ON m.message_id = r.message_id
            JOIN users u ON u.user_id = m.sender_user_id
           WHERE ${whereAll(parts)}
           ORDER BY r.review_id`,
    );
    if (found.length === 0) return [];

    const messageIds = found.map((row) => Number(row.message_id));
    const hits = await rows<HitSqlRow>(
      tx,
      sql`SELECT h.message_id::text AS message_id, h.term_id::text AS term_id,
                 l.pattern, h.matched_text
            FROM surveillance_hits h
            JOIN surveillance_lexicon l ON l.term_id = h.term_id
           WHERE h.message_id IN (${sql.join(
             messageIds.map((id) => sql`${id}`),
             sql`, `,
           )})
           ORDER BY h.hit_id`,
    );
    const byMessage = new Map<string, HitSqlRow[]>();
    for (const hit of hits) {
      const list = byMessage.get(hit.message_id) ?? [];
      list.push(hit);
      byMessage.set(hit.message_id, list);
    }

    return found.map((row) => ({
      reviewId: Number(row.review_id),
      message: toMessage(row),
      flaggedBy: row.flagged_by,
      status: row.status,
      hits: (byMessage.get(row.message_id) ?? []).map((hit) => ({
        termId: Number(hit.term_id),
        pattern: hit.pattern,
        matchedText: hit.matched_text,
      })),
    }));
  }

  app.get(
    '/admin/compliance/reviews',
    { preHandler: requireSession({ roles: ROLES_COMPLIANCE }) },
    async (request) => {
      const principal = principalOf(request);
      const query = parse(ComplianceReviewQuery, request.query, 'query');
      return withTx(ctxOf(principal), async (tx) => {
        const parts: SQL[] = [sql`true`];
        if (query.status !== undefined) parts.push(sql`r.status = ${query.status}`);
        return { items: await reviewsWith(tx, parts) };
      });
    },
  );

  app.post(
    '/admin/compliance/reviews/:reviewId',
    { preHandler: requireSession({ roles: ROLES_COMPLIANCE }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const reviewId = intParam(request, 'reviewId');
      const body = parse(UpdateComplianceReviewRequest, request.body, 'body');

      return withTx(ctxOf(principal), async (tx) => {
        const updated = await rows<{ review_id: string }>(
          tx,
          sql`UPDATE message_reviews
                 SET status = ${body.status}, reviewer_user_id = ${principal.userId},
                     reviewed_at = ${nowIso(clock)}::timestamptz, note = ${body.note}
               WHERE review_id = ${reviewId}
           RETURNING review_id::text AS review_id`,
        );
        if (updated[0] === undefined) throw new NotFoundError('No such review.');
        const items = await reviewsWith(tx, [sql`r.review_id = ${reviewId}`]);
        const item = items[0];
        if (item === undefined) throw new NotFoundError('No such review.');
        return item;
      });
    },
  );

  // ═══ Compliance: legal holds ═══════════════════════════════════════════════════════════════

  app.get(
    '/admin/compliance/holds',
    { preHandler: requireSession({ roles: ROLES_COMPLIANCE }) },
    async (request) => {
      const principal = principalOf(request);
      return withTx(ctxOf(principal), async (tx) => {
        const found = await rows<LegalHoldSqlRow>(
          tx,
          sql`SELECT ${HOLD_COLUMNS} FROM legal_holds ORDER BY hold_id DESC`,
        );
        return { items: found.map(toLegalHold) };
      });
    },
  );

  app.post(
    '/admin/compliance/holds',
    { preHandler: requireSession({ roles: ROLES_COMPLIANCE }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const body = parse(CreateLegalHoldRequest, request.body, 'body');

      const hold = await withTx(ctxOf(principal), async (tx) => {
        const inserted = await rows<LegalHoldSqlRow>(
          tx,
          sql`INSERT INTO legal_holds (firm_id, scope, reason, created_by)
              VALUES (${principal.firmId}, ${JSON.stringify(body.scope)}::jsonb, ${body.reason},
                      ${principal.userId})
           RETURNING ${HOLD_COLUMNS}`,
        );
        const row = inserted[0];
        if (row === undefined) throw new AppError('INTERNAL', 'hold insert returned no row.');
        return toLegalHold(row);
      });

      void reply.status(201);
      return hold;
    },
  );

  /** Release, never delete: a hold is evidence that data was preserved (REG-01). */
  app.delete(
    '/admin/compliance/holds/:holdId',
    { preHandler: requireSession({ roles: ROLES_COMPLIANCE }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const holdId = intParam(request, 'holdId');

      return withTx(ctxOf(principal), async (tx) => {
        const updated = await rows<LegalHoldSqlRow>(
          tx,
          sql`UPDATE legal_holds
                 SET released_at = ${nowIso(clock)}::timestamptz, released_by = ${principal.userId}
               WHERE hold_id = ${holdId} AND released_at IS NULL
           RETURNING ${HOLD_COLUMNS}`,
        );
        const row = updated[0];
        if (row === undefined) throw new NotFoundError('No such open legal hold.');
        return toLegalHold(row);
      });
    },
  );

  // ═══ Compliance: message production (REG-01) ═══════════════════════════════════════════════

  /**
   * NDJSON: one `Message` per line in `seq` order, then one `{ chain, firstBadSeq? }` line.
   *
   * The chain verdict is recomputed, not trusted: the final query re-derives every message's hash
   * exactly as `messages_chain()` (migration 0015 §15.e) does — `sha256(prev || room|seq|sender|
   * sent_at|body|attachments)` — over each touched room's COMPLETE history, because a chain can
   * only be verified from its first link. `firstBadSeq` is the lowest `seq` whose stored hash or
   * `prev_hash` does not match.
   */
  app.get(
    '/admin/export/messages',
    { preHandler: requireSession({ roles: ROLES_COMPLIANCE }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const query = parse(
        ExportMessagesQuery,
        coerceQuery(request.query, ['room', 'userId']),
        'query',
      );

      const body = await withTx(ctxOf(principal), async (tx) => {
        const parts: SQL[] = [
          sql`m.sent_at >= ${query.from}::timestamptz`,
          sql`m.sent_at <= ${query.to}::timestamptz`,
        ];
        if (query.room !== undefined) parts.push(sql`m.room_id = ${query.room}`);
        if (query.userId !== undefined) parts.push(sql`m.sender_user_id = ${query.userId}`);

        const found = await rows<MessageSqlRow>(
          tx,
          sql`SELECT ${MESSAGE_COLUMNS}
                FROM messages m
                JOIN users u ON u.user_id = m.sender_user_id
               WHERE ${whereAll(parts)}
               ORDER BY m.room_id, m.seq`,
        );

        const lines = found.map((row) => JSON.stringify(toMessage(row)));
        const roomIds = [...new Set(found.map((row) => Number(row.room_id)))];

        if (roomIds.length === 0) {
          lines.push(JSON.stringify({ chain: 'ok' }));
          return `${lines.join('\n')}\n`;
        }

        const broken = await rows<{ seq: string }>(
          tx,
          sql`
          WITH ordered AS (
            SELECT room_id, seq, prev_hash, hash,
                   lag(hash) OVER (PARTITION BY room_id ORDER BY seq) AS expected_prev,
                   digest(
                     coalesce(lag(hash) OVER (PARTITION BY room_id ORDER BY seq), '\\x'::bytea)
                     || convert_to(room_id::text || '|' || seq::text || '|' || sender_user_id::text
                                   || '|' || to_char(sent_at AT TIME ZONE 'UTC',
                                                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                                   || '|' || body || '|' || attachments::text, 'UTF8'),
                     'sha256') AS expected_hash
              FROM messages
             WHERE room_id IN (${sql.join(
               roomIds.map((id) => sql`${id}`),
               sql`, `,
             )})
          )
          SELECT seq::text AS seq FROM ordered
           WHERE hash IS DISTINCT FROM expected_hash
              OR prev_hash IS DISTINCT FROM expected_prev
           ORDER BY room_id, seq
           LIMIT 1`,
        );

        const bad = broken[0];
        lines.push(
          bad === undefined
            ? JSON.stringify({ chain: 'ok' })
            : JSON.stringify({ chain: 'broken', firstBadSeq: Number(bad.seq) }),
        );
        return `${lines.join('\n')}\n`;
      });

      void reply.type('application/x-ndjson');
      return body;
    },
  );

  // ═══ Users (SEC-01, REG-04) ════════════════════════════════════════════════════════════════

  app.get('/admin/users', { preHandler: requireSession({ roles: ROLES_ADMIN }) }, async (request) => {
    const principal = principalOf(request);
    const query = parse(UserQuery, coerceQuery(request.query, ['firmId']), 'query');

    // `users` has no RLS policy, so the firm scope is written here or it does not exist.
    // `?firmId=` may only ever name the caller's own firm; anything else is a 403.
    if (query.firmId !== undefined && query.firmId !== principal.firmId) {
      throw new ForbiddenError('Users of another firm are not visible from here.');
    }

    return withTx(ctxOf(principal), async (tx) => {
      const parts: SQL[] = [sql`firm_id = ${principal.firmId}`];
      if (query.status !== undefined) parts.push(sql`status = ${query.status}`);
      if (query.q !== undefined) {
        const like = `%${query.q}%`;
        parts.push(sql`(email ILIKE ${like} OR display_name ILIKE ${like})`);
      }
      const found = await rows<UserSqlRow>(
        tx,
        sql`SELECT ${USER_COLUMNS} FROM users WHERE ${whereAll(parts)} ORDER BY user_id`,
      );
      return { items: found.map(toUser) };
    });
  });

  app.post(
    '/admin/users',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const body = parse(CreateUserRequest, request.body, 'body');
      // An admin onboards into their OWN firm. Creating a user elsewhere — with a password the
      // creator chose — would be an account in a tenant they cannot otherwise see.
      if (body.firmId !== principal.firmId) {
        throw new ForbiddenError('A user can only be created in your own firm.');
      }

      const user = await withTx(ctxOf(principal), async (tx) => {
        const inserted = await rows<UserSqlRow>(
          tx,
          sql`INSERT INTO users (firm_id, email, display_name, desk, role, status, mfa_required)
              VALUES (${body.firmId}, ${body.email}, ${body.displayName}, ${body.desk ?? null},
                      ${body.role}, ${body.status ?? 'active'}, ${body.mfaRequired ?? false})
           RETURNING ${USER_COLUMNS}`,
        );
        const row = inserted[0];
        if (row === undefined) throw new AppError('INTERNAL', 'user insert returned no row.');
        if (body.password !== undefined) await setPassword(tx, Number(row.user_id), body.password);
        return toUser(row);
      });

      void reply.status(201);
      return user;
    },
  );

  app.put(
    '/admin/users/:userId',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const userId = intParam(request, 'userId');
      const body = parse(UpdateUserRequest, request.body, 'body');
      const now = nowIso(clock);
      // Moving a person into another firm from here would be a way to reach into that firm, and
      // moving one OUT would strand their tenant data. Neither is an administrative act this route
      // performs; a body that names any other firm is refused outright.
      if (body.firmId !== undefined && body.firmId !== principal.firmId) {
        throw new ForbiddenError('A user cannot be moved to another firm.');
      }

      return withTx(ctxOf(principal), async (tx) => {
        // Before anything is written: the subject must be one of ours. Without this an admin of
        // firm A could set `password` on a user of firm B and log in as them.
        await assertSameFirm(tx, userId, principal.firmId);
        const sets: SQL[] = [];
        if (body.email !== undefined) sets.push(sql`email = ${body.email}`);
        if (body.displayName !== undefined) sets.push(sql`display_name = ${body.displayName}`);
        if (body.firmId !== undefined) sets.push(sql`firm_id = ${body.firmId}`);
        if (body.role !== undefined) sets.push(sql`role = ${body.role}`);
        if (body.desk !== undefined) sets.push(sql`desk = ${body.desk}`);
        if (body.mfaRequired !== undefined) sets.push(sql`mfa_required = ${body.mfaRequired}`);
        if (body.status !== undefined) {
          sets.push(sql`status = ${body.status}`);
          if (body.status === 'deprovisioned') sets.push(sql`deprovisioned_at = ${now}::timestamptz`);
        }
        if (sets.length === 0 && body.password === undefined) {
          throw new BadRequestError('Nothing to update.');
        }

        let row: UserSqlRow | undefined;
        if (sets.length > 0) {
          const updated = await rows<UserSqlRow>(
            tx,
            sql`UPDATE users SET ${sql.join(sets, sql`, `)}
                 WHERE user_id = ${userId} AND firm_id = ${principal.firmId}
             RETURNING ${USER_COLUMNS}`,
          );
          row = updated[0];
        } else {
          const found = await rows<UserSqlRow>(
            tx,
            sql`SELECT ${USER_COLUMNS} FROM users
                 WHERE user_id = ${userId} AND firm_id = ${principal.firmId}`,
          );
          row = found[0];
        }
        if (row === undefined) throw new NotFoundError('No such user.');

        if (body.password !== undefined) await setPassword(tx, userId, body.password);

        // SEC-01: a credential or a privilege changed by someone other than its owner is an
        // auditable act, and `access_log` is the WORM table that records it.
        if (body.password !== undefined || body.role !== undefined || body.status !== undefined) {
          await logAdminAct(tx, clock, principal, request.traceId, 'user.update', {
            subjectUserId: userId,
            passwordChanged: body.password !== undefined,
            ...(body.role === undefined ? {} : { role: body.role }),
            ...(body.status === undefined ? {} : { status: body.status }),
          });
        }

        // SEC-01: deprovisioning revokes every session and key immediately.
        if (body.status === 'deprovisioned') {
          await tx.execute(sql`
            UPDATE sessions SET revoked_at = ${now}::timestamptz, revoke_reason = 'deprovisioned'
             WHERE user_id = ${userId} AND revoked_at IS NULL`);
          await tx.execute(sql`
            UPDATE api_keys SET revoked_at = ${now}::timestamptz
             WHERE user_id = ${userId} AND revoked_at IS NULL`);
        }
        return toUser(row);
      });
    },
  );

  app.post(
    '/admin/users/:userId/verify',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const userId = intParam(request, 'userId');

      return withTx(ctxOf(principal), async (tx) => {
        const updated = await rows<UserSqlRow>(
          tx,
          sql`UPDATE users
                 SET person_verified_at = ${nowIso(clock)}::timestamptz,
                     verified_by = ${principal.userId}
               WHERE user_id = ${userId} AND firm_id = ${principal.firmId}
           RETURNING ${USER_COLUMNS}`,
        );
        const row = updated[0];
        if (row === undefined) throw new NotFoundError('No such user.');
        return toUser(row);
      });
    },
  );

  /**
   * REG-04 erasure. The `users` row survives — `access_log`, `usage_events` and `messages` all
   * carry `user_id` and are WORM, so deleting the person would leave an unattributable audit trail
   * and break foreign keys. What goes is the identifying data: `email` and `display_name` become
   * `user-<id>`, `anonymised_at` is stamped, every session and API key is revoked.
   */
  app.delete(
    '/admin/users/:userId',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const userId = intParam(request, 'userId');
      const now = nowIso(clock);
      const handle = `user-${String(userId)}`;

      await withTx(ctxOf(principal), async (tx) => {
        const updated = await rows<{ user_id: string }>(
          tx,
          sql`UPDATE users
                 SET email = ${`${handle}@anonymised.invalid`},
                     display_name = ${handle},
                     desk = NULL,
                     status = 'deprovisioned',
                     deprovisioned_at = coalesce(deprovisioned_at, ${now}::timestamptz),
                     anonymised_at = ${now}::timestamptz
               WHERE user_id = ${userId}
                 AND firm_id = ${principal.firmId}
                 AND anonymised_at IS NULL
           RETURNING user_id::text AS user_id`,
        );
        if (updated[0] === undefined) throw new NotFoundError('No such user.');

        await logAdminAct(tx, clock, principal, request.traceId, 'user.erase', {
          subjectUserId: userId,
        });

        await tx.execute(sql`
          UPDATE sessions SET revoked_at = ${now}::timestamptz, revoke_reason = 'deprovisioned'
           WHERE user_id = ${userId} AND revoked_at IS NULL`);
        await tx.execute(sql`
          UPDATE api_keys SET revoked_at = ${now}::timestamptz
           WHERE user_id = ${userId} AND revoked_at IS NULL`);
        await tx.execute(sql`
          UPDATE user_credentials SET revoked_at = ${now}::timestamptz
           WHERE user_id = ${userId} AND revoked_at IS NULL`);
      });

      void reply.status(204);
    },
  );

  // ═══ Incidents (OPS-04) ════════════════════════════════════════════════════════════════════

  app.get(
    '/admin/incidents',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request) => {
      const principal = principalOf(request);
      const query = parse(IncidentQuery, coerceQuery(request.query, [], ['open']), 'query');

      return withTx(ctxOf(principal), async (tx) => {
        const parts: SQL[] = [sql`true`];
        if (query.open === true) parts.push(sql`closed_at IS NULL`);
        if (query.open === false) parts.push(sql`closed_at IS NOT NULL`);
        const found = await rows<IncidentSqlRow>(
          tx,
          sql`SELECT ${INCIDENT_COLUMNS} FROM status_incidents
               WHERE ${whereAll(parts)} ORDER BY opened_at DESC, incident_id DESC`,
        );
        return { items: found.map(toIncident) };
      });
    },
  );

  app.post(
    '/admin/incidents',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const body = parse(CreateIncidentRequest, request.body, 'body');

      const incident = await withTx(ctxOf(principal), async (tx) => {
        const inserted = await rows<IncidentSqlRow>(
          tx,
          sql`INSERT INTO status_incidents (opened_at, component, severity, title)
              VALUES (${nowIso(clock)}::timestamptz, ${body.component}, ${body.severity}, ${body.title})
           RETURNING ${INCIDENT_COLUMNS}`,
        );
        const row = inserted[0];
        if (row === undefined) throw new AppError('INTERNAL', 'incident insert returned no row.');
        return toIncident(row);
      });

      void reply.status(201);
      return incident;
    },
  );

  app.post(
    '/admin/incidents/:incidentId/updates',
    { preHandler: requireSession({ roles: ROLES_ADMIN }) },
    async (request, reply) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const incidentId = intParam(request, 'incidentId');
      const body = parse(IncidentUpdateRequest, request.body, 'body');
      const now = nowIso(clock);

      const incident = await withTx(ctxOf(principal), async (tx) => {
        const updated = await rows<IncidentSqlRow>(
          tx,
          sql`UPDATE status_incidents
                 SET updates = updates || ${JSON.stringify([{ ts: now, text: body.text }])}::jsonb,
                     closed_at = CASE WHEN ${body.close ?? false} THEN ${now}::timestamptz
                                      ELSE closed_at END
               WHERE incident_id = ${incidentId}
           RETURNING ${INCIDENT_COLUMNS}`,
        );
        const row = updated[0];
        if (row === undefined) throw new NotFoundError('No such incident.');
        return toIncident(row);
      });

      void reply.status(201);
      return incident;
    },
  );

  await Promise.resolve();
};

export default adminRoutes;
