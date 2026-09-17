/**
 * `wire/rest/admin.ts` — `Rest.Admin.*`: the 33 admin and compliance routes of API.md §5.14
 * L787-814 (OPS-07, ENTL-06, DATA-02, DATA-09, REF-10, REG-01, REG-04, MSG-02), including the
 * §9 compliance exports L1191 (`/admin/access-log/export.csv` and `/admin/declarations?format=csv`).
 *
 * 34 descriptors for 33 distinct method+path pairs: `Declarations` and `DeclarationsCsv` are the
 * JSON and `format=csv` responses of the one `GET /admin/declarations` route.
 * Owned by WP-01 now, by WP-07 (`server/src/http/routes/admin.ts`) afterwards.
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { AssetClass, FieldClass, Tier, UsageType } from '../common.js';
import { ProvenanceRef } from '../envelope.js';
import { ReasonCode } from '../reasonCodes.js';
import { Role } from './auth.js';
import { CsvDocument } from './export.js';
import { Ticket } from './help.js';
import { Message } from './messages.js';
import { CorporateAction } from './reference.js';
import { UsageEvent } from './usage.js';

/* ------------------------------------------------------------------ schemas */

/** `YYYY-MM`. */
export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export type Month = z.infer<typeof Month>;

/** `entl_decision` (DATA_MODEL §1). */
export const EntitlementDecision = z.enum(['allow', 'downgrade', 'deny']);
export type EntitlementDecision = z.infer<typeof EntitlementDecision>;

/** `entity_kind` (DATA_MODEL §1). */
export const EntityKind = z.enum(['issuer', 'issue', 'instrument', 'listing', 'person', 'topic']);
export type EntityKind = z.infer<typeof EntityKind>;

/** An `access_log` row (ENTL-04). */
export const AccessLogRow = z.object({
  logId: z.number().int(),
  ts: z.iso.datetime(),
  userId: z.number().int(),
  firmId: z.number().int(),
  sessionId: z.uuid().nullable(),
  /** null for non-instrument reads (the econ series id lives in `details`) */
  instrumentId: z.number().int().nullable(),
  fieldId: z.string().nullable(),
  fieldClass: FieldClass.nullable(),
  sourceId: z.string().nullable(),
  requestedTier: Tier.nullable(),
  /** granted tier; null on deny */
  tier: Tier.nullable(),
  usage: UsageType,
  /** function code, route id, or `ws.sub` */
  purpose: z.string(),
  decision: EntitlementDecision,
  reason: ReasonCode,
  traceId: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AccessLogRow = z.infer<typeof AccessLogRow>;

/** One `usage_declarations` row (ENTL-06, DATA-02). */
export const DeclarationRow = z.object({
  declarationId: z.number().int(),
  /** first day of the month, `YYYY-MM-DD` */
  month: z.iso.date(),
  sourceId: z.string(),
  firmId: z.number().int(),
  fieldClass: FieldClass,
  tier: Tier,
  displayUsers: z.number().int(),
  exportUsers: z.number().int(),
  apiUsers: z.number().int(),
  distinctUsers: z.number().int(),
  instrumentCount: z.number().int(),
  dataPoints: z.number().int(),
  seatCount: z.number().int(),
  generatedAt: z.iso.datetime(),
  reconciledAt: z.iso.datetime().nullable(),
  billingRef: z.string().nullable(),
});
export type DeclarationRow = z.infer<typeof DeclarationRow>;

export const LicenceKind = z.enum([
  'public_domain',
  'open_data',
  'exchange_delayed',
  'unofficial',
  'cc_by_sa',
  'vendor_terms',
  'internal',
]);
export type LicenceKind = z.infer<typeof LicenceKind>;

/** A bitemporal `licence_registry` version (DATA-01). */
export const LicenceEntry = z.object({
  versionId: z.number().int(),
  sourceId: z.string(),
  sourceName: z.string(),
  publisher: z.string(),
  termsUrl: z.string().nullable(),
  /** DATA-01: signed agreement reference; null for every v1 public source */
  contractRef: z.string().nullable(),
  licenceKind: LicenceKind,
  display: z.boolean(),
  /** DATA-01 distinction: programmatic / non-display use */
  nonDisplay: z.boolean(),
  derived: z.boolean(),
  redistribution: z.boolean(),
  exportAllowed: z.boolean(),
  apiAllowed: z.boolean(),
  /** ceiling any grant can reach for this source (evaluator rule 3) */
  maxTier: Tier,
  intrinsicDelayMin: z.number().int(),
  /** null = unlimited; the only input to partition drops and `retentionPurge` (STOR-07) */
  retentionDays: z.number().int().nullable(),
  /** screen footers and CSV header line */
  attribution: z.string(),
  rateLimit: z.string().nullable(),
  requiresUserAgent: z.boolean(),
  apiKeyEnv: z.string().nullable(),
  auditObligation: z.string().nullable(),
  notes: z.string().nullable(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
});
export type LicenceEntry = z.infer<typeof LicenceEntry>;

/** An `entitlement_grants` row. */
export const EntitlementGrant = z.object({
  grantId: z.number().int(),
  subjectKind: z.enum(['user', 'firm']),
  subjectId: z.number().int(),
  /** null = all sources */
  sourceId: z.string().nullable(),
  /** null = all asset classes */
  assetClass: AssetClass.nullable(),
  /** null = all field classes */
  fieldClass: FieldClass.nullable(),
  maxTier: Tier,
  usageDisplay: z.boolean(),
  usageExport: z.boolean(),
  usageApi: z.boolean(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  grantedBy: z.number().int().nullable(),
  contractRef: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type EntitlementGrant = z.infer<typeof EntitlementGrant>;

export const DataExceptionKind = z.enum([
  'source_conflict',
  'missing_field',
  'parse_error',
  'manual_review',
  'reported_error',
  'unresolved_identifier',
  'ca_review',
]);
export type DataExceptionKind = z.infer<typeof DataExceptionKind>;

export const DataExceptionStatus = z.enum(['open', 'resolved', 'rejected']);
export type DataExceptionStatus = z.infer<typeof DataExceptionStatus>;

/** A `data_exceptions` row (REF-10 queue with `slaDueAt`). */
export const DataException = z.object({
  exceptionId: z.number().int(),
  createdAt: z.iso.datetime(),
  kind: DataExceptionKind,
  entityKind: EntityKind,
  entityId: z.number().int(),
  field: z.string().nullable(),
  candidates: z.array(
    z.object({
      sourceId: z.string(),
      provenanceId: z.number().int(),
      value: z.unknown(),
    }),
  ),
  /** `users.user_id` for reported errors */
  reportedBy: z.number().int().nullable(),
  status: DataExceptionStatus,
  assigneeUserId: z.number().int().nullable(),
  resolvedBy: z.number().int().nullable(),
  resolution: z
    .object({
      chosenProvenanceId: z.number().int().nullable(),
      versionId: z.number().int().nullable(),
      note: z.string(),
    })
    .nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  slaDueAt: z.iso.datetime().nullable(),
});
export type DataException = z.infer<typeof DataException>;

export const DqEventKind = z.enum([
  'stale_tick',
  'cross_source_divergence',
  'missing_close',
  'field_population',
  'poll_anomaly',
  'provider_circuit_open',
  'reconcile_mismatch',
  'parse_error',
  'default_partition_nonempty',
  'ref_orphans',
  'ws_backpressure',
  'plant_degraded',
  'replay_diff',
]);
export type DqEventKind = z.infer<typeof DqEventKind>;

/** A `dq_events` row (OPS-03). */
export const DqEvent = z.object({
  dqId: z.number().int(),
  ts: z.iso.datetime(),
  kind: DqEventKind,
  severity: z.enum(['info', 'warn', 'error']),
  instrumentId: z.number().int().nullable(),
  mdLineId: z.number().int().nullable(),
  sourceId: z.string().nullable(),
  /** plant subject or table name */
  subject: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  resolvedAt: z.iso.datetime().nullable(),
});
export type DqEvent = z.infer<typeof DqEvent>;

/** `JobError` as stored in `ingest_runs.errors`. */
export const JobError = z.object({
  code: z.string(),
  message: z.string(),
  url: z.string().optional(),
  requestKey: z.string().optional(),
});
export type JobError = z.infer<typeof JobError>;

/** An `ingest_runs` row. */
export const IngestRun = z.object({
  runId: z.number().int(),
  jobId: z.string(),
  /** null for internal jobs */
  sourceId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: z.enum(['running', 'ok', 'failed', 'skipped']),
  fetched: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(JobError),
  traceId: z.uuid().nullable(),
});
export type IngestRun = z.infer<typeof IngestRun>;

export const ComplianceReviewStatus = z.enum(['open', 'reviewed', 'escalated']);
export type ComplianceReviewStatus = z.infer<typeof ComplianceReviewStatus>;

/** A `message_reviews` row joined to its message and lexicon hits (MSG-02). */
export const ComplianceReview = z.object({
  reviewId: z.number().int(),
  message: Message,
  flaggedBy: z.enum(['lexicon', 'random_sample', 'manual']),
  status: ComplianceReviewStatus,
  hits: z.array(
    z.object({
      termId: z.number().int(),
      pattern: z.string(),
      matchedText: z.string(),
    }),
  ),
});
export type ComplianceReview = z.infer<typeof ComplianceReview>;

export const LegalHoldScope = z.object({
  userIds: z.array(z.number().int()).optional(),
  roomIds: z.array(z.number().int()).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type LegalHoldScope = z.infer<typeof LegalHoldScope>;

/** A `legal_holds` row. */
export const LegalHold = z.object({
  holdId: z.number().int(),
  firmId: z.number().int(),
  scope: LegalHoldScope,
  reason: z.string(),
  createdBy: z.number().int(),
  createdAt: z.iso.datetime(),
  releasedAt: z.iso.datetime().nullable(),
  releasedBy: z.number().int().nullable(),
});
export type LegalHold = z.infer<typeof LegalHold>;

export const UserStatus = z.enum(['active', 'suspended', 'deprovisioned']);
export type UserStatus = z.infer<typeof UserStatus>;

/** A `users` row as the admin console sees it (SEC-01 onboarding record). */
export const User = z.object({
  userId: z.number().int(),
  firmId: z.number().int(),
  email: z.email(),
  displayName: z.string(),
  /** ethical-wall unit (MSG-03) */
  desk: z.string().nullable(),
  role: Role,
  status: UserStatus,
  /** SEC-01 onboarding evidence */
  personVerifiedAt: z.iso.datetime().nullable(),
  verifiedBy: z.number().int().nullable(),
  /** SEC-02: WebAuthn required when true */
  mfaRequired: z.boolean(),
  /** REG-06 mechanism (manual attestation in v1) */
  sanctionsScreenedAt: z.iso.datetime().nullable(),
  sanctionsStatus: z.enum(['clear', 'review', 'blocked']).nullable(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
  deprovisionedAt: z.iso.datetime().nullable(),
  /** REG-04 erasure: email/display_name replaced by `user-<id>` */
  anonymisedAt: z.iso.datetime().nullable(),
});
export type User = z.infer<typeof User>;

export const StatusIncidentUpdate = z.object({
  ts: z.iso.datetime(),
  text: z.string(),
});
export type StatusIncidentUpdate = z.infer<typeof StatusIncidentUpdate>;

/** A `status_incidents` row (OPS-04). */
export const StatusIncident = z.object({
  incidentId: z.number().int(),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** `provider:cboe.quotes`, `plant`, `ws`, `db` */
  component: z.string(),
  severity: z.enum(['info', 'degraded', 'outage']),
  title: z.string(),
  updates: z.array(StatusIncidentUpdate),
});
export type StatusIncident = z.infer<typeof StatusIncident>;

/* ---------------------------------------------------- request / response */

export const TraceParams = z.object({ traceId: z.uuid() });
export type TraceParams = z.infer<typeof TraceParams>;

export const TraceRequestRow = z.object({
  ts: z.iso.datetime(),
  route: z.string(),
  status: z.number().int(),
  latencyMs: z.number().int(),
  userId: z.number().int().nullable(),
});
export type TraceRequestRow = z.infer<typeof TraceRequestRow>;

/** Provenance with the replay-store detail admin/dataops roles may see (OPS-07). */
export const TraceProvenance = ProvenanceRef.extend({
  requestUrl: z.string(),
  httpStatus: z.number().int(),
  fixtureFile: z.string().optional(),
});
export type TraceProvenance = z.infer<typeof TraceProvenance>;

/** One string from the request all the way back to the raw recorded response (OPS-07). */
export const TraceResponse = z.object({
  traceId: z.uuid(),
  requests: z.array(TraceRequestRow),
  accessLog: z.array(AccessLogRow),
  usageEvents: z.array(UsageEvent),
  provenance: z.array(TraceProvenance),
  ingestRuns: z.array(IngestRun),
  messages: z.array(Message),
  tickets: z.array(Ticket),
});
export type TraceResponse = z.infer<typeof TraceResponse>;

export const DeclarationQuery = z.object({
  month: Month,
  sourceId: z.string().optional(),
  firmId: z.number().int().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export type DeclarationQuery = z.infer<typeof DeclarationQuery>;

export const DeclarationListResponse = z.object({ items: z.array(DeclarationRow) });
export type DeclarationListResponse = z.infer<typeof DeclarationListResponse>;

/** Runs `entitlements/declarations.ts` and upserts `usage_declarations`. */
export const GenerateDeclarationsRequest = z.object({ month: Month });
export type GenerateDeclarationsRequest = z.infer<typeof GenerateDeclarationsRequest>;

export const RunAcceptedResponse = z.object({ runId: z.number().int() });
export type RunAcceptedResponse = z.infer<typeof RunAcceptedResponse>;

export const DeclarationParams = z.object({ declarationId: z.number().int().positive() });
export type DeclarationParams = z.infer<typeof DeclarationParams>;

export const ReconcileDeclarationRequest = z.object({
  billingRef: z.string().min(1).max(200),
});
export type ReconcileDeclarationRequest = z.infer<typeof ReconcileDeclarationRequest>;

/** Current `licence_registry` versions. */
export const LicenceListResponse = z.object({ items: z.array(LicenceEntry) });
export type LicenceListResponse = z.infer<typeof LicenceListResponse>;

export const LicenceParams = z.object({ sourceId: z.string().min(1) });
export type LicenceParams = z.infer<typeof LicenceParams>;

/**
 * "`LicenceEntry` minus keys + `validFrom`" (API.md §5.14 L796): `versionId` is assigned by
 * `writeVersion` and `sourceId` comes from the path. The write bumps
 * `config_versions('entitlements')`.
 */
export const PutLicenceRequest = LicenceEntry.omit({ versionId: true, sourceId: true });
export type PutLicenceRequest = z.infer<typeof PutLicenceRequest>;

export const EntitlementQuery = z.object({
  subjectKind: z.enum(['user', 'firm']).optional(),
  subjectId: z.number().int().optional(),
  sourceId: z.string().optional(),
});
export type EntitlementQuery = z.infer<typeof EntitlementQuery>;

export const EntitlementListResponse = z.object({ items: z.array(EntitlementGrant) });
export type EntitlementListResponse = z.infer<typeof EntitlementListResponse>;

export const CreateEntitlementRequest = z.object({
  subjectKind: z.enum(['user', 'firm']),
  subjectId: z.number().int(),
  sourceId: z.string().optional(),
  assetClass: AssetClass.optional(),
  fieldClass: FieldClass.optional(),
  maxTier: Tier,
  usageDisplay: z.boolean().optional(),
  usageExport: z.boolean().optional(),
  usageApi: z.boolean().optional(),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
  contractRef: z.string().optional(),
  note: z.string().optional(),
});
export type CreateEntitlementRequest = z.infer<typeof CreateEntitlementRequest>;

export const GrantParams = z.object({ grantId: z.number().int().positive() });
export type GrantParams = z.infer<typeof GrantParams>;

export const AccessLogQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  userId: z.number().int().optional(),
  instrumentId: z.number().int().optional(),
  sourceId: z.string().optional(),
  decision: EntitlementDecision.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});
export type AccessLogQuery = z.infer<typeof AccessLogQuery>;

export const AccessLogResponse = z.object({
  items: z.array(AccessLogRow),
  nextCursor: z.string().nullable(),
});
export type AccessLogResponse = z.infer<typeof AccessLogResponse>;

export const ExceptionQuery = z.object({
  status: DataExceptionStatus.optional(),
  kind: DataExceptionKind.optional(),
  assignee: z.number().int().optional(),
});
export type ExceptionQuery = z.infer<typeof ExceptionQuery>;

export const ExceptionListResponse = z.object({ items: z.array(DataException) });
export type ExceptionListResponse = z.infer<typeof ExceptionListResponse>;

export const ExceptionParams = z.object({ exceptionId: z.number().int().positive() });
export type ExceptionParams = z.infer<typeof ExceptionParams>;

/** `accept` writes the chosen candidate as a new bitemporal version (`reason:'correction'`). */
export const ResolveExceptionRequest = z.object({
  chosenProvenanceId: z.number().int().optional(),
  note: z.string().min(1),
  action: z.enum(['accept', 'reject']),
});
export type ResolveExceptionRequest = z.infer<typeof ResolveExceptionRequest>;

/** `review_state='queued'`. */
export const CaQueueResponse = z.object({ items: z.array(CorporateAction) });
export type CaQueueResponse = z.infer<typeof CaQueueResponse>;

export const CaParams = z.object({ caId: z.number().int().positive() });
export type CaParams = z.infer<typeof CaParams>;

/** DATA-08 dual key: the reviewer may not be the ingester. */
export const ReviewCaRequest = z.object({
  decision: z.enum(['reviewed', 'rejected']),
  note: z.string().optional(),
});
export type ReviewCaRequest = z.infer<typeof ReviewCaRequest>;

export const DqQuery = z.object({
  /** true → only rows with `resolvedAt === null` */
  open: z.boolean().optional(),
  kind: DqEventKind.optional(),
  since: z.iso.datetime().optional(),
});
export type DqQuery = z.infer<typeof DqQuery>;

export const DqListResponse = z.object({ items: z.array(DqEvent) });
export type DqListResponse = z.infer<typeof DqListResponse>;

export const DqParams = z.object({ dqId: z.number().int().positive() });
export type DqParams = z.infer<typeof DqParams>;

export const IngestRunQuery = z.object({
  job: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type IngestRunQuery = z.infer<typeof IngestRunQuery>;

export const IngestRunListResponse = z.object({ items: z.array(IngestRun) });
export type IngestRunListResponse = z.infer<typeof IngestRunListResponse>;

export const IngestJobParams = z.object({ jobId: z.string().min(1) });
export type IngestJobParams = z.infer<typeof IngestJobParams>;

export const ComplianceReviewQuery = z.object({
  status: ComplianceReviewStatus.optional(),
});
export type ComplianceReviewQuery = z.infer<typeof ComplianceReviewQuery>;

export const ComplianceReviewListResponse = z.object({ items: z.array(ComplianceReview) });
export type ComplianceReviewListResponse = z.infer<typeof ComplianceReviewListResponse>;

export const ComplianceReviewParams = z.object({ reviewId: z.number().int().positive() });
export type ComplianceReviewParams = z.infer<typeof ComplianceReviewParams>;

export const UpdateComplianceReviewRequest = z.object({
  status: z.enum(['reviewed', 'escalated']),
  note: z.string(),
});
export type UpdateComplianceReviewRequest = z.infer<typeof UpdateComplianceReviewRequest>;

export const LegalHoldListResponse = z.object({ items: z.array(LegalHold) });
export type LegalHoldListResponse = z.infer<typeof LegalHoldListResponse>;

export const CreateLegalHoldRequest = z.object({
  scope: LegalHoldScope,
  reason: z.string().min(1),
});
export type CreateLegalHoldRequest = z.infer<typeof CreateLegalHoldRequest>;

export const LegalHoldParams = z.object({ holdId: z.number().int().positive() });
export type LegalHoldParams = z.infer<typeof LegalHoldParams>;

export const ExportMessagesQuery = z.object({
  room: z.number().int().optional(),
  userId: z.number().int().optional(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
});
export type ExportMessagesQuery = z.infer<typeof ExportMessagesQuery>;

/** The final line of the NDJSON body: the hash-chain verdict (REG-01). */
export const ExportMessagesChainLine = z.object({
  chain: z.enum(['ok', 'broken']),
  firstBadSeq: z.number().int().optional(),
});
export type ExportMessagesChainLine = z.infer<typeof ExportMessagesChainLine>;

/** Each line of `application/x-ndjson`: messages in `seq` order, then one chain line. */
export const ExportMessagesLine = z.union([Message, ExportMessagesChainLine]);
export type ExportMessagesLine = z.infer<typeof ExportMessagesLine>;

/** The raw `application/x-ndjson` body. */
export const NdjsonDocument = z.string();
export type NdjsonDocument = z.infer<typeof NdjsonDocument>;

export const UserQuery = z.object({
  firmId: z.number().int().optional(),
  status: UserStatus.optional(),
  q: z.string().max(120).optional(),
});
export type UserQuery = z.infer<typeof UserQuery>;

export const UserListResponse = z.object({ items: z.array(User) });
export type UserListResponse = z.infer<typeof UserListResponse>;

export const CreateUserRequest = z.object({
  email: z.email(),
  displayName: z.string().min(1).max(120),
  firmId: z.number().int(),
  role: Role,
  desk: z.string().max(80).optional(),
  mfaRequired: z.boolean().optional(),
  status: UserStatus.optional(),
  password: z.string().min(8).max(256).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UpdateUserRequest = CreateUserRequest.partial();
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const UserParams = z.object({ userId: z.number().int().positive() });
export type UserParams = z.infer<typeof UserParams>;

export const IncidentQuery = z.object({ open: z.boolean().optional() });
export type IncidentQuery = z.infer<typeof IncidentQuery>;

export const IncidentListResponse = z.object({ items: z.array(StatusIncident) });
export type IncidentListResponse = z.infer<typeof IncidentListResponse>;

export const CreateIncidentRequest = z.object({
  component: z.string().min(1),
  severity: z.enum(['info', 'degraded', 'outage']),
  title: z.string().min(1).max(200),
});
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequest>;

export const IncidentParams = z.object({ incidentId: z.number().int().positive() });
export type IncidentParams = z.infer<typeof IncidentParams>;

export const IncidentUpdateRequest = z.object({
  text: z.string().min(1),
  /** true → also sets `closed_at` */
  close: z.boolean().optional(),
});
export type IncidentUpdateRequest = z.infer<typeof IncidentUpdateRequest>;

/* ------------------------------------------------------------------- routes */

/** The 32 routes of API.md §5.14 plus the §9 CSV exports (`http/routes/admin.ts`). */
export const Admin = {
  /** OPS-07: one string from the request back to the raw recorded response. */
  Trace: {
    method: 'GET',
    path: '/admin/trace/:traceId',
    params: TraceParams,
    response: TraceResponse,
    status: 200,
  },
  /** ENTL-06, DATA-02; `format=csv` returns the §9 compliance export instead. */
  Declarations: {
    method: 'GET',
    path: '/admin/declarations',
    query: DeclarationQuery,
    response: DeclarationListResponse,
    status: 200,
  },
  /** The same route with `format=csv` (API.md §9 L1191). */
  DeclarationsCsv: {
    method: 'GET',
    path: '/admin/declarations',
    query: DeclarationQuery,
    response: CsvDocument,
    status: 200,
    format: 'csv',
  },
  GenerateDeclarations: {
    method: 'POST',
    path: '/admin/declarations/generate',
    body: GenerateDeclarationsRequest,
    response: RunAcceptedResponse,
    status: 202,
  },
  ReconcileDeclaration: {
    method: 'POST',
    path: '/admin/declarations/:declarationId/reconcile',
    params: DeclarationParams,
    body: ReconcileDeclarationRequest,
    response: DeclarationRow,
    status: 200,
  },
  Licences: {
    method: 'GET',
    path: '/admin/licences',
    response: LicenceListResponse,
    status: 200,
  },
  /** Writes a new bitemporal version via `writeVersion`; bumps `config_versions`. */
  PutLicence: {
    method: 'PUT',
    path: '/admin/licences/:sourceId',
    params: LicenceParams,
    body: PutLicenceRequest,
    response: LicenceEntry,
    status: 200,
  },
  Entitlements: {
    method: 'GET',
    path: '/admin/entitlements',
    query: EntitlementQuery,
    response: EntitlementListResponse,
    status: 200,
  },
  CreateEntitlement: {
    method: 'POST',
    path: '/admin/entitlements',
    body: CreateEntitlementRequest,
    response: EntitlementGrant,
    status: 201,
  },
  DeleteEntitlement: {
    method: 'DELETE',
    path: '/admin/entitlements/:grantId',
    params: GrantParams,
    response: z.void(),
    status: 204,
  },
  /** ENTL-04. */
  AccessLog: {
    method: 'GET',
    path: '/admin/access-log',
    query: AccessLogQuery,
    response: AccessLogResponse,
    status: 200,
  },
  /** API.md §9 L1191: same filters, CSV body. */
  AccessLogCsv: {
    method: 'GET',
    path: '/admin/access-log/export.csv',
    query: AccessLogQuery,
    response: CsvDocument,
    status: 200,
    format: 'csv',
  },
  /** REF-10 queue with `slaDueAt`. */
  Exceptions: {
    method: 'GET',
    path: '/admin/exceptions',
    query: ExceptionQuery,
    response: ExceptionListResponse,
    status: 200,
  },
  ResolveException: {
    method: 'POST',
    path: '/admin/exceptions/:exceptionId/resolve',
    params: ExceptionParams,
    body: ResolveExceptionRequest,
    response: DataException,
    status: 200,
  },
  CaQueue: {
    method: 'GET',
    path: '/admin/ca-queue',
    response: CaQueueResponse,
    status: 200,
  },
  ReviewCa: {
    method: 'POST',
    path: '/admin/ca-queue/:caId/review',
    params: CaParams,
    body: ReviewCaRequest,
    response: CorporateAction,
    status: 200,
  },
  /** OPS-03. */
  Dq: {
    method: 'GET',
    path: '/admin/dq',
    query: DqQuery,
    response: DqListResponse,
    status: 200,
  },
  ResolveDq: {
    method: 'POST',
    path: '/admin/dq/:dqId/resolve',
    params: DqParams,
    response: z.void(),
    status: 204,
  },
  IngestRuns: {
    method: 'GET',
    path: '/admin/ingest/runs',
    query: IngestRunQuery,
    response: IngestRunListResponse,
    status: 200,
  },
  /** On-demand run; respects the provider buckets and the leader lock. */
  RunIngestJob: {
    method: 'POST',
    path: '/admin/ingest/run/:jobId',
    params: IngestJobParams,
    response: RunAcceptedResponse,
    status: 202,
  },
  /** MSG-02 surveillance queue. */
  ComplianceReviews: {
    method: 'GET',
    path: '/admin/compliance/reviews',
    query: ComplianceReviewQuery,
    response: ComplianceReviewListResponse,
    status: 200,
  },
  UpdateComplianceReview: {
    method: 'POST',
    path: '/admin/compliance/reviews/:reviewId',
    params: ComplianceReviewParams,
    body: UpdateComplianceReviewRequest,
    response: ComplianceReview,
    status: 200,
  },
  LegalHolds: {
    method: 'GET',
    path: '/admin/compliance/holds',
    response: LegalHoldListResponse,
    status: 200,
  },
  CreateLegalHold: {
    method: 'POST',
    path: '/admin/compliance/holds',
    body: CreateLegalHoldRequest,
    response: LegalHold,
    status: 201,
  },
  /** Releases the hold (`released_at`, `released_by`); the row is never deleted. */
  ReleaseLegalHold: {
    method: 'DELETE',
    path: '/admin/compliance/holds/:holdId',
    params: LegalHoldParams,
    response: LegalHold,
    status: 200,
  },
  /**
   * REG-01 production on request: `application/x-ndjson`, one `Message` per line in `seq`
   * order plus a final `{ chain, firstBadSeq? }` line.
   */
  ExportMessages: {
    method: 'GET',
    path: '/admin/export/messages',
    query: ExportMessagesQuery,
    response: NdjsonDocument,
    status: 200,
    format: 'text',
  },
  Users: {
    method: 'GET',
    path: '/admin/users',
    query: UserQuery,
    response: UserListResponse,
    status: 200,
  },
  /** SEC-01 onboarding record. */
  CreateUser: {
    method: 'POST',
    path: '/admin/users',
    body: CreateUserRequest,
    response: User,
    status: 201,
  },
  UpdateUser: {
    method: 'PUT',
    path: '/admin/users/:userId',
    params: UserParams,
    body: UpdateUserRequest,
    response: User,
    status: 200,
  },
  /** Sets `person_verified_at` / `verified_by` (API.md §5.14 L812). */
  VerifyUser: {
    method: 'POST',
    path: '/admin/users/:userId/verify',
    params: UserParams,
    response: User,
    status: 200,
  },
  /**
   * Anonymises (`anonymised_at`, `user-<id>`), revokes sessions and API keys, keeps
   * `access_log` (REG-04).
   */
  DeleteUser: {
    method: 'DELETE',
    path: '/admin/users/:userId',
    params: UserParams,
    response: z.void(),
    status: 204,
  },
  /** OPS-04. */
  Incidents: {
    method: 'GET',
    path: '/admin/incidents',
    query: IncidentQuery,
    response: IncidentListResponse,
    status: 200,
  },
  CreateIncident: {
    method: 'POST',
    path: '/admin/incidents',
    body: CreateIncidentRequest,
    response: StatusIncident,
    status: 201,
  },
  AddIncidentUpdate: {
    method: 'POST',
    path: '/admin/incidents/:incidentId/updates',
    params: IncidentParams,
    body: IncidentUpdateRequest,
    response: StatusIncident,
    status: 201,
  },
} as const;
