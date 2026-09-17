/**
 * `client/ws.ts` — `LiveClient`, the WebSocket half of the SDK.
 *
 * **WP-01 STUB — owned by WP-13 from here on.** Signatures transcribed from API.md §10.2
 * (L1304, L1313-1332); every body throws `NOT_IMPLEMENTED: WP-13`, including the constructor, so a
 * `createClient()` caller that never touches `client.live` is unaffected (`rest.ts` builds the
 * `LiveClient` lazily, on first property access).
 *
 * WP-13 implements: `hello`/`welcome` handshake at `ws(s)://host/ws/v1`, auto-reconnect with a
 * 250 ms → 8 s jittered backoff (BUS-07) and `resume:true` after the first connect, ref-counted
 * `sub`/`unsub` batching per animation frame (`subscriptions.ts`), `snap`/`delta` application with
 * the prev-chain rule (`quoteCache.ts`), `essential`/`conflation` control frames and the close-code
 * table of `wire/ws.ts` (`WS_CLOSE`).
 */
import type { FieldId, ReasonCode, Tier } from '../wire/envelope.js';
import type { ServerMsgOf } from '../wire/ws.js';
import type { QuoteCache } from './quoteCache.js';
import { type QuoteView } from './quoteCache.js';
import type { SubscribeOptions, Subscription, UpdateEvent } from './subscriptions.js';
import type { ClientOptions } from './rest.js';

const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED: WP-13';

export type { QuoteView } from './quoteCache.js';
export type {
  SubscribeOptions,
  Subscription,
  SubscriptionAck,
  UpdateEvent,
} from './subscriptions.js';
export { QuoteCache } from './quoteCache.js';

/** API.md §10.2 L1304. */
export type LiveState = 'idle' | 'connecting' | 'open' | 'resyncing' | 'closed';

/** `notice` frame — slow-consumer / overload / maintenance (BUS-04). */
export type Notice = ServerMsgOf<'notice'>;
/** `status` frame projected onto one subject. */
export interface StatusEvent {
  subject: string;
  st: ServerMsgOf<'status'>['st'];
  reason?: string | undefined;
}
/** `downgrade` frame (ENTL-04). */
export interface DowngradeEvent {
  subject?: string | undefined;
  from: Tier;
  to: Tier | null;
  reason: ReasonCode;
}
/** `alert` frame; `payload` is the REST `AlertEvent` of API.md §5.11. */
export interface LiveAlertEvent {
  alertId: string;
  firedAt: number;
  payload: unknown;
}
/** `msg` frame; `message` is the REST `Message` of API.md §5.10. */
export interface LiveMessageEvent {
  room: string;
  message: unknown;
}
/** `err` frame. */
export interface LiveErrorEvent {
  code: string;
  message: string;
  traceId: string;
  fatal: boolean;
}
/** `bye` frame or socket close. */
export interface LiveCloseEvent {
  code: number;
  reason: string;
}

/** Negotiated server limits from `welcome`. */
export interface LiveLimits {
  maxSubscriptions: number;
  maxFields: number;
}

/** API.md §10.2 L1313-1332. */
export class LiveClient {
  constructor(_opts: ClientOptions) {
    throw new Error(NOT_IMPLEMENTED);
  }

  get state(): LiveState {
    throw new Error(NOT_IMPLEMENTED);
  }

  get sessionId(): string | null {
    throw new Error(NOT_IMPLEMENTED);
  }

  get conflationMs(): number {
    throw new Error(NOT_IMPLEMENTED);
  }

  get limits(): LiveLimits {
    throw new Error(NOT_IMPLEMENTED);
  }

  /**
   * The cache this client applies `snap`/`delta` into — exposed so the host app can drive the 1 s
   * staleness sweep (TERM-12). Never a copy.
   */
  get quoteCache(): QuoteCache {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** `hello`/`welcome`; auto-reconnect with 250 ms → 8 s jittered backoff (BUS-07). */
  connect(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  close(_code?: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Ref-counted per `(subject, field)`; `sub`/`unsub` are batched per animation frame. */
  subscribe(_subjects: string[], _fields: FieldId[] | '*', _opts?: SubscribeOptions): Subscription {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Viewport → `essential` frame; `status:'shed'` subjects are re-subscribed automatically. */
  setEssential(_subjects: string[], _essential: boolean): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  setConflation(_ms: number): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Reads `quoteCache` — the same instance, never a copy. */
  get(_subject: string): QuoteView | undefined {
    throw new Error(NOT_IMPLEMENTED);
  }

  on(event: 'update', h: (e: UpdateEvent) => void): () => void;
  on(event: 'status', h: (e: StatusEvent) => void): () => void;
  on(event: 'downgrade', h: (e: DowngradeEvent) => void): () => void;
  on(event: 'notice', h: (e: Notice) => void): () => void;
  on(event: 'alert', h: (e: LiveAlertEvent) => void): () => void;
  on(event: 'message', h: (e: LiveMessageEvent) => void): () => void;
  on(event: 'state', h: (s: LiveState) => void): () => void;
  on(event: 'error', h: (e: LiveErrorEvent) => void): () => void;
  on(event: 'close', h: (e: LiveCloseEvent) => void): () => void;
  on(_event: string, _h: (e: never) => void): () => void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
