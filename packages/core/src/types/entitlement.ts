/**
 * Entitlement evaluation (ENTL-01..06, API-06, SEC-03) — ARCHITECTURE §10.
 *
 * `server/src/entitlements/evaluator.ts#evaluate(req)` runs server-side before any data service read.
 * `ReasonCode` is mirrored byte-for-byte by `sdk/wire/reasonCodes.ts`.
 */

import type { AssetClass } from './instrument.js';
import type { FieldClass, FieldId } from './fields.js';
import type { Tier } from './quote.js';

export type UsageType = 'display' | 'export' | 'api';

export type ReasonCode =
  | 'OK'
  | 'SOURCE_TIER_CAP'
  | 'NOT_ENTITLED_TIER'
  | 'NO_FIRM_ENTITLEMENT'
  | 'NO_USER_ENTITLEMENT'
  | 'LICENCE_FORBIDS_USAGE'
  | 'TIER_EOD'
  | 'CONCURRENT_SESSION'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_DOWN'
  | 'SUBJECT_UNKNOWN'
  | 'FIELD_UNKNOWN'
  | 'NOT_IN_UNIVERSE';

export interface EntitlementRequest {
  userId: number;
  firmId: number;
  sessionId: string;
  instrumentId: number | null;
  assetClass: AssetClass | null;
  fieldIds: FieldId[];
  tier: Tier;
  usage: UsageType;
  /** function code | route | 'ws.sub' */
  purpose: string;
  traceId: string;
}

export interface FieldDecision {
  fieldId: FieldId;
  sourceId: string;
  fieldClass: FieldClass;
  decision: 'allow' | 'downgrade' | 'deny';
  effectiveTier: Tier | null;
  reason: ReasonCode;
}

/** One entry of `EntitlementDecision.downgrades`. */
export interface EntitlementDowngrade {
  fieldId: FieldId;
  reason: ReasonCode;
}

export interface EntitlementDecision {
  effectiveTier: Tier | null;
  fields: FieldDecision[];
  downgrades: EntitlementDowngrade[];
  /**
   * One provisional handle per `access_log` row this evaluation queued, in field order (ENTL-04).
   *
   * These are NOT `access_log.log_id` values. The row is handed to the batching writer and reaches
   * Postgres on the 1 s timer, long after the decision is returned, so the real id does not exist
   * yet and cannot be reported here without putting a write on the response path. The handle is a
   * per-writer sequence: it correlates a field of one decision with the row queued for it, and
   * nothing more. Two writers in one process hand out the same numbers for different rows.
   */
  logIds: number[];
}
