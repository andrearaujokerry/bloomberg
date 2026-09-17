/**
 * Payload conventions (FUNCTIONS.md §1.3).
 *
 * Rules enforced by review and the golden tests:
 *  1. `variant` is the first key. Functions with `assetClasses:'none'` use 'default'.
 *  2. Any value that comes from the plant or a provider and is shown as a number is a `ValueCell`,
 *     never a bare `number`. Stored reference/fundamental values that are not live may be bare
 *     numbers only inside a block that carries a `provIdx` for the whole block.
 *  3. Timestamps are ISO-8601 UTC strings and dates `YYYY-MM-DD`; epoch ms appear only inside
 *     `ValueCell.ts` and chart series arrays.
 *  4. Numbers are unformatted (full stored precision, <= 15 significant digits); formatting is a
 *     screen and CSV concern through `core/fields/format.ts`.
 */

import type { FieldId, FieldValue } from './fields.js';
import type { Tier, ValueState } from './quote.js';
import type { ReasonCode } from './entitlement.js';

export type UnavailableReason = 'NO_SOURCE' | 'NOT_LICENSED' | 'NOT_APPLICABLE';

/** One entry of `meta.provenance[]`; blocks cite it by `idx` (DATA-10). */
export interface PayloadProvenance {
  idx: number;
  sourceId: string;
  provenanceId: number;
  capturedAt: string;
  sourceTs: string | null;
  attribution: string;
  requestKey?: string;
}

/** One entitlement note; only downgrades and denials are reported (ENTL-05). */
export interface PayloadEntitlementNote {
  fieldId: FieldId;
  decision: 'downgrade' | 'deny';
  effectiveTier: Tier | null;
  reason: ReasonCode;
}

export interface PayloadUnavailable {
  field: string;
  reason: UnavailableReason;
  detail: string;
}

/** ANAL-08: `inputsHash = sha256Hex(canonicalJson(inputs))`, the same function on every side. */
export interface PayloadEngine {
  name: string;
  version: string;
  inputsHash: string;
}

export interface PayloadAdjustment {
  beforeDate: string;
  priceFactor: number;
  volumeFactor: number;
  kind: 'split' | 'dividend' | 'capital_return';
}

export interface PayloadPage {
  index: number;
  count: number;
  cursor: string | null;
}

export interface PayloadQuota {
  dataPointsCharged: number;
  uniqueInstrumentsAdded: number;
}

/** API.md §3 Meta plus resultId — identical on REST, cached result and CSV header (ARCHITECTURE §5.3). */
export interface PayloadMeta {
  traceId: string;
  resultId: string;
  asOf: { validAt: string; knownAt: string };
  tier: Tier;
  staleness: ValueState;
  provenance: PayloadProvenance[];
  entitlement: PayloadEntitlementNote[];
  unavailable: PayloadUnavailable[];
  engines: PayloadEngine[];
  adjustments?: PayloadAdjustment[];
  page?: PayloadPage;
  servedAt: string;
  quota?: PayloadQuota;
}

export interface Payload<T> {
  data: T;
  meta: PayloadMeta;
}

/**
 * A value the screen may render as a number: carries its own staleness, reason and provenance
 * (TERM-12, DATA-10, ENTL-05). `v === null` ⇒ blank; `r` says why. `live` lets the shell overwrite
 * `v` from the WS cache.
 */
export interface ValueCell {
  /** number | string | boolean | null */
  v: FieldValue;
  st: ValueState;
  /** when `v === null` */
  r?: ReasonCode;
  /** source timestamp epoch ms (FEED-05 'src') */
  ts?: number | null;
  /** index into `meta.provenance` */
  provIdx: number;
  live?: { subject: string; field: FieldId };
}

/** Every function payload extends this. */
export interface BasePayload {
  variant: string;
}
