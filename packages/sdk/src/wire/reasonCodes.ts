/**
 * `wire/reasonCodes.ts` — mirrors `core/types/entitlement.ts` `ReasonCode` (ARCHITECTURE §10) exactly.
 *
 * Transcribed from API.md §3 L242-243. A `ReasonCode` accompanies every entitlement decision on the
 * wire: on REST it appears in `DataResult.r[field]` and `Meta.entitlement[]`, on the WebSocket in
 * `snap.reason`, `snap.r[field]`, `subAck.accepted[].reason` and `downgrade.reason` (ENTL-05).
 */
import { z } from 'zod';

export const ReasonCode = z.enum([
  'OK',
  'SOURCE_TIER_CAP',
  'NOT_ENTITLED_TIER',
  'NO_FIRM_ENTITLEMENT',
  'NO_USER_ENTITLEMENT',
  'LICENCE_FORBIDS_USAGE',
  'TIER_EOD',
  'CONCURRENT_SESSION',
  'QUOTA_EXCEEDED',
  'PROVIDER_DOWN',
  'SUBJECT_UNKNOWN',
  'FIELD_UNKNOWN',
  'NOT_IN_UNIVERSE',
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

/** Every member, in declaration order — for exhaustive iteration in tests and admin UIs. */
export const REASON_CODES = ReasonCode.options;

/**
 * Meaning on the wire (API.md §3 L246-257). Documentation only: no code branches on this text.
 */
export const REASON_CODE_MEANINGS: Readonly<Record<ReasonCode, string>> = {
  OK: 'served at the requested tier',
  SOURCE_TIER_CAP:
    'licence max_tier below the request (every v1 source is <= delayed): served at the cap',
  NOT_ENTITLED_TIER: 'firm/user grant below the request: served at the grant tier',
  NO_FIRM_ENTITLEMENT: "no firm grant for (source, field class): field is null, st:'blank'",
  NO_USER_ENTITLEMENT: "no user grant for (source, field class): field is null, st:'blank'",
  LICENCE_FORBIDS_USAGE:
    'registry forbids this usage (export_allowed/api_allowed false): request refused (403)',
  TIER_EOD: 'granted tier is eod and the field is not part of the end-of-day view: null',
  CONCURRENT_SESSION: 'login superseded (audit row only; never a field reason)',
  QUOTA_EXCEEDED: 'API-06 quota hit (429 / subAck.rejected)',
  PROVIDER_DOWN:
    "subject known, source circuit open: last values with st:'stale', never silently dropped",
  SUBJECT_UNKNOWN: 'subscription/resolution rejection',
  FIELD_UNKNOWN: 'subscription/resolution rejection',
  NOT_IN_UNIVERSE: 'subscription/resolution rejection',
};
