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
  /** access_log.log_id rows written for this evaluation (ENTL-04) */
  logIds: number[];
}
