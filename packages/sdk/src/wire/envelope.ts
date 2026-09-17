/**
 * `wire/envelope.ts` — the error envelope, the response `Meta`/`PayloadMeta` block and the common
 * wire primitives every other `wire/*` module builds on.
 *
 * Transcribed from API.md §2 (L133-196) and §3 (L199-286). The enums are byte-identical to
 * `core/types/*.ts` and to the Postgres enums in DATA_MODEL §1.
 *
 * API.md §3 splits these declarations across `wire/common.ts` (the enums and reference shapes) and
 * `wire/envelope.ts` (the error envelope and `Meta`). `common.ts` sits at the bottom of the import
 * graph; this module imports what it needs from it and re-exports the rest, so `wire/envelope.js`
 * remains a sufficient import for the whole common vocabulary.
 */
import { z } from 'zod';

import { FieldId, Tier, ValueState } from './common.js';
import { ReasonCode } from './reasonCodes.js';

/** Re-exported so `wire/envelope.js` is a sufficient import for the whole common vocabulary. */
export { ReasonCode };
export * from './common.js';

// ---------------------------------------------------------------------------
// Error envelope — API.md §2 L139-179
// ---------------------------------------------------------------------------

export const ErrorCode = z.enum([
  // 400
  'VALIDATION_FAILED', // zod parse failure — details.issues: z.core.$ZodIssue[]; details.location: 'body'|'query'|'params'|'fnParams'
  'BAD_REQUEST',
  // 401
  'AUTH_REQUIRED',
  'AUTH_INVALID_CREDENTIALS',
  'SESSION_EXPIRED',
  'SESSION_SUPERSEDED',
  'MFA_REQUIRED',
  // 403
  'FORBIDDEN', // role or scope — details.requiredRole | details.requiredScope
  'CSRF_REJECTED',
  'USER_SUSPENDED',
  'ENTITLEMENT_DENIED', // whole request denied — details.reasons: EntitlementNote[] (§3); partial denials are per-field, HTTP 200
  'MESSAGE_POLICY_BLOCKED', // MSG-03 — details.rule: 'counterparty'|'ethical_wall'|'external'|'legal_hold'
  // 404
  'NOT_FOUND',
  'SECURITY_NOT_FOUND',
  'FUNCTION_NOT_FOUND',
  'FIELD_UNKNOWN',
  'RESULT_EXPIRED',
  // 409
  'AMBIGUOUS_SECURITY', // details.candidates: InstrumentSummary[]
  'WORKSPACE_VERSION_CONFLICT', // details.current: Workspace (the server copy)
  'DUPLICATE_NAME',
  // 422
  'FUNCTION_NOT_APPLICABLE', // FUNC-02 — details.assetClass, details.applicable: AssetClass[]
  'NOT_IN_UNIVERSE', // sector parsed (e.g. 'Corp') but no data source in the wedge
  'NO_SECURITY_CONTEXT', // manifest.requiresSecurity and no security supplied
  // 426
  'PROTOCOL_VERSION',
  // 429
  'QUOTA_EXCEEDED', // details: { quota: 'dailyUniqueInstruments'|'monthlyDataPoints'|'concurrentSubscriptions', used, limit, resetsAt }
  'RATE_LIMITED',
  // 500 / 503
  'INTERNAL',
  'REPLAY_MISS',
  'PROVIDER_UNAVAILABLE',
  'STARTING',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(), // human text, shown verbatim in the panel footer
    traceId: z.uuid(),
    retryable: z.boolean(), // true only for PROVIDER_UNAVAILABLE, STARTING, RATE_LIMITED, QUOTA_EXCEEDED
    retryAfterMs: z.number().int().optional(), // 429 / 503; also sent as the Retry-After header (seconds)
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/**
 * HTTP status for each code — API.md §2 L182-193. `client/rest.ts` classifies on the code, not the
 * status, so this table is the single place the mapping is written down for both sides.
 */
export const ERROR_CODE_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  BAD_REQUEST: 400,
  AUTH_REQUIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  SESSION_SUPERSEDED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  USER_SUSPENDED: 403,
  ENTITLEMENT_DENIED: 403,
  MESSAGE_POLICY_BLOCKED: 403,
  NOT_FOUND: 404,
  SECURITY_NOT_FOUND: 404,
  FUNCTION_NOT_FOUND: 404,
  FIELD_UNKNOWN: 404,
  RESULT_EXPIRED: 404,
  AMBIGUOUS_SECURITY: 409,
  WORKSPACE_VERSION_CONFLICT: 409,
  DUPLICATE_NAME: 409,
  FUNCTION_NOT_APPLICABLE: 422,
  NOT_IN_UNIVERSE: 422,
  NO_SECURITY_CONTEXT: 422,
  PROTOCOL_VERSION: 426,
  QUOTA_EXCEEDED: 429,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  REPLAY_MISS: 500,
  PROVIDER_UNAVAILABLE: 503,
  STARTING: 503,
};

/** API.md §2 L175 — the only codes for which `error.retryable` is ever true. */
export const RETRYABLE_ERROR_CODES: readonly ErrorCode[] = [
  'PROVIDER_UNAVAILABLE',
  'STARTING',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
];

// ---------------------------------------------------------------------------
// Meta — the same object on REST data responses, function payloads and CSV
// headers (ARCHITECTURE §5.3) — API.md §3 L260-285
// ---------------------------------------------------------------------------

/** request side; defaults now/now (REF-03) */
export const AsOf = z.object({
  validAt: z.iso.datetime().optional(),
  knownAt: z.iso.datetime().optional(),
});
export type AsOf = z.infer<typeof AsOf>;

export const ProvenanceRef = z.object({
  idx: z.number().int(),
  sourceId: z.string(),
  provenanceId: z.number().int(),
  capturedAt: z.iso.datetime(),
  sourceTs: z.iso.datetime().nullable(),
  attribution: z.string(),
  /** replay-store key; admin/dataops roles only */
  requestKey: z.string().optional(),
});
export type ProvenanceRef = z.infer<typeof ProvenanceRef>;

export const EntitlementNote = z.object({
  fieldId: FieldId,
  decision: z.enum(['downgrade', 'deny']),
  effectiveTier: Tier.nullable(),
  reason: ReasonCode,
});
export type EntitlementNote = z.infer<typeof EntitlementNote>;

export const UnavailableNote = z.object({
  field: z.string(),
  reason: z.enum(['NO_SOURCE', 'NOT_LICENSED', 'NOT_APPLICABLE']),
  detail: z.string(),
});
export type UnavailableNote = z.infer<typeof UnavailableNote>;

/** ANAL-08 */
export const EngineNote = z.object({
  name: z.string(),
  version: z.string(),
  inputsHash: z.string().length(64),
});
export type EngineNote = z.infer<typeof EngineNote>;

export const PageInfo = z.object({
  index: z.number().int(),
  count: z.number().int(),
  cursor: z.string().nullable(),
});
export type PageInfo = z.infer<typeof PageInfo>;

export const AdjustmentStep = z.object({
  beforeDate: z.iso.date(),
  priceFactor: z.number(),
  volumeFactor: z.number(),
  kind: z.enum(['split', 'dividend', 'capital_return']),
});
export type AdjustmentStep = z.infer<typeof AdjustmentStep>;

export const Meta = z.object({
  traceId: z.uuid(),
  /** the EFFECTIVE values (REF-03, STOR-06) */
  asOf: z.object({ validAt: z.iso.datetime(), knownAt: z.iso.datetime() }),
  /** lowest tier among cited values */
  tier: Tier,
  /** worst ValueState among cited values (TERM-12) */
  staleness: ValueState,
  /** every value block cites an idx into this (DATA-10) */
  provenance: z.array(ProvenanceRef),
  /** downgrades and denials (ENTL-05) */
  entitlement: z.array(EntitlementNote),
  /** e.g. EE estimates: NO_SOURCE (BRIEF §2) */
  unavailable: z.array(UnavailableNote),
  engines: z.array(EngineNote),
  /** historical reads only (REF-09) */
  adjustments: z.array(AdjustmentStep).optional(),
  page: PageInfo.optional(),
  servedAt: z.iso.datetime(),
  /** API-06 (api sessions) */
  quota: z
    .object({
      dataPointsCharged: z.number().int(),
      uniqueInstrumentsAdded: z.number().int(),
    })
    .optional(),
});
export type Meta = z.infer<typeof Meta>;

/** core/types/function.ts PayloadMeta; resultId = ULID of the cached result */
export const PayloadMeta = Meta.extend({ resultId: z.string() });
export type PayloadMeta = z.infer<typeof PayloadMeta>;
