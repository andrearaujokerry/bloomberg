/**
 * `client/subscriptions.ts` — ref-counted subscription bookkeeping for `LiveClient`.
 *
 * **WP-01 STUB — owned by WP-13 from here on.** Signatures from API.md §10.2 (L1305-1306,
 * L1333-1338); every body throws `NOT_IMPLEMENTED: WP-13`. WP-13 implements ref counting per
 * `(subject, field)`, the per-animation-frame `sub`/`unsub` batching and the `ack` promise resolved
 * by the matching `subAck` frame.
 */
import type { FieldId, ReasonCode, Tier } from '../wire/envelope.js';
import type { QuoteView } from './quoteCache.js';

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED: WP-13';

/** API.md §10.2 L1305. */
export interface SubscribeOptions {
  tier?: Tier | undefined;
  essential?: boolean | undefined;
  conflationMs?: number | undefined;
}

/** API.md §10.2 L1306 — what `web/grid/cellRegistry` flashes (ARCHITECTURE §6.6). */
export interface UpdateEvent {
  subject: string;
  seq: number;
  changed: FieldId[];
  state: QuoteView;
  kind: 'snap' | 'delta';
}

/** The `subAck` frame projected onto one subscription (API.md §10.2 L1335). */
export interface SubscriptionAck {
  accepted: { s: string; tier: Tier; reason: ReasonCode }[];
  rejected: { s: string; code: string; reason: string }[];
}

/** API.md §10.2 L1333-1338. */
export interface Subscription {
  readonly id: number;
  readonly subjects: readonly string[];
  readonly fields: readonly FieldId[] | '*';
  readonly ack: Promise<SubscriptionAck>;
  /** Only the subjects and fields of this subscription. Returns an unsubscribe-the-handler fn. */
  on(event: 'update', h: (e: UpdateEvent) => void): () => void;
  /** Ref-count decrement; the `unsub` frame is sent when the count reaches zero. */
  unsubscribe(): void;
}

/**
 * The ref-count table behind `LiveClient.subscribe()`. Not part of the public API.md surface; it is
 * declared here so WP-13 has a single owner for the bookkeeping and `ws.ts` stays a transport.
 */
export class SubscriptionRegistry {
  /** Register a new subscription and return it; batches the `sub` frame for the next frame tick. */
  add(
    _subjects: readonly string[],
    _fields: readonly FieldId[] | '*',
    _opts?: SubscribeOptions,
  ): Subscription {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Resolve the pending `ack` promises for one `subAck` frame. */
  settle(_ack: SubscriptionAck): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Fan one `UpdateEvent` out to the subscriptions that asked for that subject/field. */
  dispatch(_event: UpdateEvent): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** `(subject, fields)` pairs to re-`sub` after a reconnect. */
  resumePlan(): { subject: string; fields: readonly FieldId[] | '*' }[] {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Drop everything (client close). */
  clear(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
