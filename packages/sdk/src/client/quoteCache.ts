/**
 * `client/quoteCache.ts` — the SDK's projection of live quote state.
 *
 * **WP-01 STUB — owned by WP-13 from here on.** The signatures below are transcribed from
 * API.md §10.2 (L1307-1312, L1339-1342); every body throws `NOT_IMPLEMENTED: WP-13`. WP-13 replaces
 * the bodies (and only the bodies) with the real implementation: a `Map<subject, QuoteView>` that
 * applies `snap`/`delta` under the prev-chain rule of API.md §6.3 rule 3 (`prev === lastSeq` apply;
 * `seq <= lastSeq` drop; otherwise request a resync) plus the 1 s staleness sweep (TERM-12,
 * `core/quote/staleness.ts`).
 */
import type {
  AssetClass,
  FieldId,
  FieldValue,
  ReasonCode,
  SessionState,
  Tier,
  ValueState,
} from '../wire/envelope.js';
import type { Delta, Prov, Snap, Status, Ts } from '../wire/ws.js';

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED: WP-13';

/** API.md §10.2 L1307-1312 — one subject's view; `f` holds only the subscribed fields. */
export interface QuoteView {
  subject: string;
  instrumentId: number | null;
  assetClass: AssetClass | null;
  seq: number;
  tier: Tier;
  reason: ReasonCode;
  /** field values */
  f: Record<FieldId, FieldValue>;
  /** per-field timestamps (epoch ms) */
  fts: Record<FieldId, number>;
  /** per-field entitlement reason */
  r: Record<FieldId, ReasonCode>;
  /** FEED-05 three timestamps */
  ts: Ts;
  st: ValueState;
  session: SessionState;
  prov: Prov;
  /** the last `status` frame for this subject, or `null` before one arrives */
  status: 'live' | 'pending' | 'shed' | 'gone' | null;
}

/** What `QuoteCache.apply()` reports back to `LiveClient`. */
export interface ApplyResult {
  changed: FieldId[];
  resyncNeeded: boolean;
}

/**
 * API.md §10.2 L1339-1342 — `Map<subject, QuoteView>`; applies `snap`/`delta` with the prev-chain
 * rule (§6.3) and exposes the 1 s staleness ticker (TERM-12).
 */
export class QuoteCache {
  /** Apply one server frame. Returns the changed field ids and whether a `resync` must be sent. */
  apply(_msg: Snap | Delta | Status): ApplyResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Re-evaluate `valueState` at `now` (epoch ms); returns the subjects whose state changed. */
  sweep(_now: number): string[] {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** The current view for one subject, or `undefined` when the cache has never seen it. */
  get(_subject: string): QuoteView | undefined {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Every subject currently held. */
  subjects(): string[] {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Drop one subject (on `unsub`) or, with no argument, everything (on a failed resume). */
  delete(_subject?: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** The `known` map (`subject → seq`) sent with `hello`/`resync` after a reconnect. */
  known(): Record<string, number> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
