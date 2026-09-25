/**
 * `client/ws.ts` — `LiveClient`, the WebSocket half of the SDK (WP-13).
 *
 * This file is a **transport and a state machine**, and deliberately nothing else. It owns the
 * socket, the `hello`/`welcome` handshake, the reconnect ladder, the heartbeat, the decode of every
 * inbound frame through `wire/ws.ts`, and the fan-out of typed events. It owns no values: what a
 * subject is worth lives in {@link QuoteCache}, and who wants it lives in `SubscriptionRegistry`.
 *
 * ## The prev-chain check, and why a visible resync beats a silent apply
 *
 * `delta.prev` is the `seq` this session last received for the subject. API.md §6.3 step 3 states
 * the client rule: **apply iff `prev === lastSeq`; drop iff `seq <= lastSeq`; otherwise send
 * `resync { subjects:[s] }` and ignore deltas for that subject until the next `snap`.**
 *
 * The rule is enforced in exactly one place — `QuoteCache.apply()` — and this file's discipline is
 * that it has **no other way to reach a view**. There is no `#views` map here, no merge, no seq
 * arithmetic; the only path from a frame to a screen is {@link LiveClient.#ingest}, and the only
 * thing `#ingest` can do with a frame is hand it to the cache. So the check cannot be bypassed by
 * adding a fast path later: there is no path to add one to. What this file does own is the
 * *consequence* of a broken chain — sending the `resync`, and reporting `state: 'resyncing'` — which
 * the cache cannot do because it has no socket.
 *
 * Why it matters that the gap is loud. A `delta` is a field-wise merge, so a gapped delta applies
 * cleanly: the numbers are all valid numbers and the row keeps ticking. What is lost is the fields
 * the missing frame carried — a bid that moved, a volume that jumped, a halt. The screen then shows
 * a price from one instant beside a bid from another, with nothing anywhere to say so: no error, no
 * blank, no stale glyph. A trader reads a spread that never existed. A visible resync costs one
 * frame and one fresh `snap`, and it is *self-healing* — `seq` values may skip (that is conflation),
 * but the `prev` chain never does, so a mismatch is proof of loss rather than a heuristic. Skipping
 * the delta silently is no better than applying it: the chain cannot heal itself, and every later
 * delta would be gapped too. Only a `snap` re-bases it, and only the client can ask for one.
 *
 * ## One socket per application (TERM-04)
 *
 * Four panels share one `LiveClient`, and the SDK never opens a second socket for a session: the
 * server closes the older one `4003 SESSION_SUPERSEDED` (API.md §6.3 step 1). `web/rt/wsBridge.ts`
 * is the single owner in the browser; `rt/leader.ts` keeps a second tab off the wire.
 *
 * ## What this file does not do
 *
 * - It does not compute staleness. `core/quote/staleness.ts#valueState` is the one implementation
 *   (TERM-12) and `QuoteCache.sweep()` is the one caller; the host drives the 1 s tick
 *   (`rt/stalenessTicker.ts`), because one timer per document also restyles the chart legend.
 * - It does not batch `sub`/`unsub`. `SubscriptionRegistry` reconciles held state against wire state
 *   once per animation frame and hands the difference to {@link LiveClient.#send}.
 */
import { SystemClock } from '@terminal/core';
import type { Clock } from '@terminal/core';

import { FieldId as FieldIdSchema, SubjectId, SUBJECT_ID_PATTERN } from '../wire/envelope.js';
import type { FieldId, ReasonCode, Tier } from '../wire/envelope.js';
import {
  ClientMsg,
  ServerMsg,
  WS_CLOSE,
  WS_PROTOCOL_VERSION,
  wsCloseIsRetryable,
} from '../wire/ws.js';
import type { ClientMsgInput, Delta, ServerMsgOf, Snap, Status } from '../wire/ws.js';
import { QuoteCache } from './quoteCache.js';
import type { QuoteView } from './quoteCache.js';
import { platformFrameScheduler, SubscriptionRegistry } from './subscriptions.js';
import type {
  FrameScheduler,
  SubscribeOptions,
  Subscription,
  UpdateEvent,
} from './subscriptions.js';
import type { ClientOptions } from './rest.js';

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

// ---------------------------------------------------------------------------------------------
// Reconnect ladder (BUS-07)
// ---------------------------------------------------------------------------------------------

/** First reconnect delay (API.md §6.3 step 6: "backoff 250 ms → 8 s with jitter"). */
export const BACKOFF_MIN_MS = 250;
/** Ceiling of the ladder. A terminal that has been down a minute retries every 8 s, not faster. */
export const BACKOFF_MAX_MS = 8_000;
/**
 * Jitter as a fraction of the step, applied symmetrically and then clamped back into
 * `[BACKOFF_MIN_MS, BACKOFF_MAX_MS]`.
 *
 * Jitter is not decoration: a plant restart drops every terminal in the building at the same
 * millisecond, and an unjittered ladder brings them all back in one synchronised wave — the
 * thundering herd that turns a 2 s restart into a 30 s outage. The spread is what makes the
 * reconnect load flat instead of spiky.
 */
export const BACKOFF_JITTER = 0.2;

/**
 * The delay before reconnect attempt `attempt` (1-based): `250 · 2^(attempt-1)` capped at 8 s, then
 * jittered by ±{@link BACKOFF_JITTER} and clamped back inside the documented bounds — so no delay is
 * ever shorter than 250 ms or longer than 8 s, however the random source behaves.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.trunc(attempt));
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (n - 1));
  const jittered = step * (1 + (random() * 2 - 1) * BACKOFF_JITTER);
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)));
}

/** `'https://host'` → `'wss://host/ws/v1'`; `'http://host'` → `'ws://host/ws/v1'` (API.md §6.1). */
export function liveUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed.replace(/^http/, 'ws')}/ws/v1`;
}

/**
 * The timer pair the backoff and the heartbeat use. Injectable for the same reason `Clock` is: a
 * test that has to wait 8 real seconds to assert the top of the ladder is a test nobody runs.
 */
export interface LiveTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const platformTimers: LiveTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Injected collaborators. All optional, all with working defaults — the same shape as the WP-01
 * additions on {@link ClientOptions}. Nothing here changes the protocol; it exists so the reconnect
 * ladder, the frame batch and the clock are driven rather than waited on.
 */
export interface LiveClientDeps {
  /**
   * The cache this client applies into. Default a fresh {@link QuoteCache} over `clock`. Passed in
   * when the host already owns one (a relay client sharing the leader tab's cache, CLIENT.md §8.4).
   */
  quoteCache?: QuoteCache | undefined;
  clock?: Clock | undefined;
  timers?: LiveTimers | undefined;
  /** Source of the backoff jitter. Default `Math.random`. */
  random?: (() => number) | undefined;
  /** How `sub`/`unsub`/`resync` batches are scheduled. Default the platform's animation frame. */
  scheduleFrame?: FrameScheduler | undefined;
}

/** Counters `rt/wsBridge.ts` reads for the status bar, and a test reads instead of a spy. */
export interface LiveStats {
  framesReceived: number;
  framesSent: number;
  /** Frames the registry produced while the socket was down; `resume()` re-derives them. */
  framesDropped: number;
  /** `snap`/`delta` frames the cache applied. */
  applied: number;
  /** `snap`/`delta` frames the cache dropped as duplicates or ignored while awaiting a snap. */
  skipped: number;
  /** Broken prev-chains — the count that should be zero and is worth a metric when it is not. */
  resyncs: number;
  reconnects: number;
  protocolErrors: number;
}

/** What each event hands its handler. */
interface LiveEventMap {
  update: UpdateEvent;
  status: StatusEvent;
  downgrade: DowngradeEvent;
  notice: Notice;
  alert: LiveAlertEvent;
  message: LiveMessageEvent;
  state: LiveState;
  error: LiveErrorEvent;
  close: LiveCloseEvent;
}
type LiveEventName = keyof LiveEventMap;

/**
 * The socket lifecycle, which is finer-grained than {@link LiveState}: `connecting` and
 * `reconnecting` both report `'connecting'`/`'resyncing'` outward, and `open` reports `'resyncing'`
 * while any subject is waiting for the `snap` this client asked for.
 */
type Phase = 'idle' | 'connecting' | 'reconnecting' | 'open' | 'closed';

/** Close codes that mean "try again": ours from §6.7, plus the two the browser invents. */
function shouldReconnect(code: number): boolean {
  // 1005 = no status received, 1006 = abnormal closure. Neither is a server verdict; both are how a
  // dropped TCP connection reaches an `onclose` handler, which is the case reconnect exists for.
  return code === 1005 || code === 1006 || wsCloseIsRetryable(code);
}

/** API.md §10.2 L1313-1332. */
export class LiveClient {
  readonly #options: ClientOptions;
  readonly #url: string;
  readonly #clock: Clock;
  readonly #timers: LiveTimers;
  readonly #random: () => number;
  readonly #scheduleFrame: FrameScheduler;
  readonly #cache: QuoteCache;
  readonly #registry: SubscriptionRegistry;

  readonly #handlers = new Map<LiveEventName, Set<(e: unknown) => void>>();

  #socket: WebSocket | null = null;
  #phase: Phase = 'idle';
  #announced: LiveState = 'idle';
  #sessionId: string | null = null;
  #limits: LiveLimits = { maxSubscriptions: 10_000, maxFields: 100 };
  #requestedConflationMs: number;
  #effectiveConflationMs: number;
  #heartbeatMs = 15_000;

  /** True once a `welcome` has ever arrived — which is what `hello.resume` means (§6.3 step 6). */
  #resumable = false;
  #closedByUser = false;
  #attempt = 0;
  #backoffHandle: unknown = null;
  #heartbeatHandle: unknown = null;
  #pingN = 0;

  #connectPromise: Promise<void> | null = null;
  #settleConnect: ((err: Error | null) => void) | null = null;
  /** One `close` event per socket, whichever of the two paths below observes the close first. */
  #closeEmitted = false;
  /** The in-band copy of the close code, when a `bye` arrived before the close frame (§6.7). */
  #bye: LiveCloseEvent | null = null;

  /**
   * Subjects for which a fresh `snap` has been asked for and not yet arrived — a client-detected gap
   * or a server-initiated `resync`. A derived index of `QuoteCache`'s own quarantine, maintained at
   * the two points that change it, kept here so {@link LiveClient.state} costs O(1) rather than a
   * walk over ten thousand subjects on every frame. The cache stays authoritative for whether a
   * delta may apply; this set only decides what the status bar says.
   */
  readonly #gapped = new Set<string>();
  /** Subjects whose `resync` frame has not gone out yet, batched so a gapped grid sends one frame. */
  readonly #resyncToSend = new Set<string>();
  #resyncScheduled = false;

  readonly #stats: LiveStats = {
    framesReceived: 0,
    framesSent: 0,
    framesDropped: 0,
    applied: 0,
    skipped: 0,
    resyncs: 0,
    reconnects: 0,
    protocolErrors: 0,
  };

  constructor(opts: ClientOptions, deps: LiveClientDeps = {}) {
    if (typeof opts.baseUrl !== 'string' || opts.baseUrl.length === 0) {
      throw new TypeError('ClientOptions.baseUrl is required');
    }
    if (typeof opts.clientVersion !== 'string' || opts.clientVersion.length === 0) {
      throw new TypeError("ClientOptions.clientVersion is required (e.g. 'web/0.1.0')");
    }
    this.#options = opts;
    this.#url = liveUrl(opts.baseUrl);
    this.#clock = deps.clock ?? new SystemClock();
    this.#timers = deps.timers ?? platformTimers;
    this.#random = deps.random ?? Math.random;
    this.#scheduleFrame = deps.scheduleFrame ?? platformFrameScheduler;
    this.#requestedConflationMs = opts.conflationMs ?? 250;
    this.#effectiveConflationMs = this.#requestedConflationMs;
    this.#cache = deps.quoteCache ?? new QuoteCache({ clock: this.#clock });
    this.#registry = new SubscriptionRegistry({
      send: (msg) => {
        this.#send(msg);
      },
      ...(deps.scheduleFrame === undefined ? {} : { scheduleFrame: deps.scheduleFrame }),
      knownSeq: (subject) => this.#cache.get(subject)?.seq,
      onUnsubscribed: (subjects) => {
        for (const subject of subjects) {
          this.#cache.delete(subject);
          this.#gapped.delete(subject);
          this.#resyncToSend.delete(subject);
        }
        this.#announceState();
      },
    });
  }

  // ── Read-only surface (API.md §10.2 L1315) ──────────────────────────────────────────────────

  get state(): LiveState {
    switch (this.#phase) {
      case 'idle':
        return 'idle';
      case 'connecting':
        return 'connecting';
      case 'reconnecting':
        return 'resyncing';
      case 'closed':
        return 'closed';
      case 'open':
        return this.#gapped.size > 0 ? 'resyncing' : 'open';
    }
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** The conflation interval in force — the granted value, widened by a `notice` (§6.5). */
  get conflationMs(): number {
    return this.#effectiveConflationMs;
  }

  /** What this client asked for; the server never narrows below it (§6.4). */
  get requestedConflationMs(): number {
    return this.#requestedConflationMs;
  }

  get limits(): LiveLimits {
    return { ...this.#limits };
  }

  get stats(): LiveStats {
    return { ...this.#stats };
  }

  /** How many reconnects the current outage has attempted; 0 while connected. */
  get reconnectAttempt(): number {
    return this.#attempt;
  }

  /** The subscription bookkeeping — exposed so `rt/wsBridge.ts` can read ref counts and shed state. */
  get subscriptions(): SubscriptionRegistry {
    return this.#registry;
  }

  /**
   * The cache this client applies `snap`/`delta` into — exposed so the host app can drive the 1 s
   * staleness sweep (TERM-12). Never a copy.
   */
  get quoteCache(): QuoteCache {
    return this.#cache;
  }

  /** Reads {@link LiveClient.quoteCache} — the same instance, never a copy. */
  get(subject: string): QuoteView | undefined {
    return this.#cache.get(subject);
  }

  // ── Connect / close ─────────────────────────────────────────────────────────────────────────

  /**
   * `hello`/`welcome`; auto-reconnect with 250 ms → 8 s jittered backoff (BUS-07).
   *
   * Resolves on the first `welcome`. It rejects only when reconnecting could not help — a close code
   * of `4001 AUTH_REQUIRED`, `4002 PROTOCOL_ERROR`, `4003 SESSION_SUPERSEDED` or `4010
   * PROTOCOL_VERSION`, or a {@link LiveClient.close} while the handshake is still in flight. A
   * retryable failure does **not** reject: the ladder keeps climbing and the promise settles when the
   * server comes back, which is what a terminal left open overnight needs.
   */
  connect(): Promise<void> {
    if (this.#phase === 'open') return Promise.resolve();
    if (this.#connectPromise !== null) return this.#connectPromise;
    this.#closedByUser = false;
    this.#attempt = 0;
    this.#connectPromise = new Promise<void>((resolve, reject) => {
      this.#settleConnect = (err) => {
        this.#settleConnect = null;
        this.#connectPromise = null;
        if (err === null) resolve();
        else reject(err);
      };
    });
    this.#openSocket();
    return this.#connectPromise;
  }

  close(code: number = WS_CLOSE.NORMAL): void {
    this.#closedByUser = true;
    this.#clearBackoff();
    this.#stopHeartbeat();
    const socket = this.#socket;
    if (socket !== null && socket.readyState !== socket.CLOSED) {
      socket.close(code, 'client-close');
      // A real `WebSocket` fires `close` asynchronously; the teardown below is idempotent, so it
      // runs now and the late event finds nothing left to do.
    }
    this.#teardown(code, 'client-close');
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────────────────────

  /**
   * Ref-counted per `(subject, field)`; `sub`/`unsub` are batched per animation frame.
   *
   * Subject ids and field ids are validated here rather than at flush time: the caller is the one
   * who can fix a typo, and a frame rejected inside a batch callback would surface as an event
   * nobody is listening for yet.
   */
  subscribe(subjects: string[], fields: FieldId[] | '*', opts?: SubscribeOptions): Subscription {
    if (this.#phase === 'closed') {
      throw new Error('LiveClient.subscribe: the client is closed; call connect() first');
    }
    if (subjects.length === 0) {
      throw new TypeError('LiveClient.subscribe: at least one subject is required');
    }
    for (const subject of subjects) {
      if (!SubjectId.safeParse(subject).success) {
        throw new TypeError(
          `LiveClient.subscribe: '${subject}' is not a subject id (${SUBJECT_ID_PATTERN.source})`,
        );
      }
    }
    if (fields !== '*') {
      for (const field of fields) {
        if (!FieldIdSchema.safeParse(field).success) {
          throw new TypeError(`LiveClient.subscribe: '${field}' is not a field id`);
        }
      }
      const distinct = new Set(fields).size;
      if (distinct > this.#limits.maxFields) {
        throw new RangeError(
          `LiveClient.subscribe: ${String(distinct)} fields exceeds maxFields=${String(this.#limits.maxFields)}`,
        );
      }
    }
    return this.#registry.add(subjects, fields, opts);
  }

  /** Viewport → `essential` frame; `status:'shed'` subjects are re-subscribed automatically. */
  setEssential(subjects: string[], essential: boolean): void {
    for (const subject of subjects) {
      if (!SubjectId.safeParse(subject).success) {
        throw new TypeError(`LiveClient.setEssential: '${subject}' is not a subject id`);
      }
    }
    this.#registry.setEssential(subjects, essential);
  }

  /** Request a conflation interval (50–5 000 ms, §6.4). The server may widen it, never narrow it. */
  setConflation(ms: number): void {
    if (!Number.isInteger(ms) || ms < 50 || ms > 5_000) {
      throw new RangeError(
        `LiveClient.setConflation: ${String(ms)} is outside the requestable range 50–5000 ms (API.md §6.4)`,
      );
    }
    this.#requestedConflationMs = ms;
    this.#send({ t: 'conflation', ms });
  }

  // ── Events ──────────────────────────────────────────────────────────────────────────────────

  on(event: 'update', h: (e: UpdateEvent) => void): () => void;
  on(event: 'status', h: (e: StatusEvent) => void): () => void;
  on(event: 'downgrade', h: (e: DowngradeEvent) => void): () => void;
  on(event: 'notice', h: (e: Notice) => void): () => void;
  on(event: 'alert', h: (e: LiveAlertEvent) => void): () => void;
  on(event: 'message', h: (e: LiveMessageEvent) => void): () => void;
  on(event: 'state', h: (s: LiveState) => void): () => void;
  on(event: 'error', h: (e: LiveErrorEvent) => void): () => void;
  on(event: 'close', h: (e: LiveCloseEvent) => void): () => void;
  on(event: string, h: (e: never) => void): () => void {
    const name = event as LiveEventName;
    const handler = h as unknown as (e: unknown) => void;
    const set = this.#handlers.get(name) ?? new Set<(e: unknown) => void>();
    set.add(handler);
    this.#handlers.set(name, set);
    return () => {
      this.#handlers.get(name)?.delete(handler);
    };
  }

  #emit<E extends LiveEventName>(event: E, payload: LiveEventMap[E]): void {
    const set = this.#handlers.get(event);
    if (set === undefined || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // A listener that throws must not stop the frame pipeline: one broken widget would freeze
        // every other panel on the socket. `error` is excluded from the report to keep a throwing
        // error handler from recursing.
        if (event !== 'error') {
          this.#emit('error', {
            code: 'LISTENER_FAILED',
            message: `a '${event}' handler threw: ${err instanceof Error ? err.message : String(err)}`,
            traceId: '',
            fatal: false,
          });
        }
      }
    }
  }

  /**
   * At most one `close` per socket. `close()` tears down immediately while a real `WebSocket` fires
   * its `close` event a turn later, and a `bye` frame may have said the same thing in-band first;
   * all three arrive here and the first one wins.
   */
  #emitClose(code: number, reason: string): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.#emit('close', { code, reason });
  }

  #announceState(): void {
    const next = this.state;
    if (next === this.#announced) return;
    this.#announced = next;
    this.#emit('state', next);
  }

  // ── Socket lifecycle ────────────────────────────────────────────────────────────────────────

  #openSocket(): void {
    const Ctor =
      this.#options.WebSocket ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (typeof Ctor !== 'function') {
      const err = new TypeError('No WebSocket implementation: pass ClientOptions.WebSocket');
      this.#phase = 'closed';
      this.#announceState();
      // From `connect()` the caller gets the rejection; from a backoff timer there is no caller to
      // throw at, so the error surfaces as the promise the host is already holding.
      if (this.#settleConnect !== null) {
        this.#settleConnect(err);
        return;
      }
      throw err;
    }
    this.#phase = this.#resumable ? 'reconnecting' : 'connecting';
    this.#closeEmitted = false;
    this.#bye = null;
    this.#announceState();

    const socket = new Ctor(this.#url);
    this.#socket = socket;
    socket.addEventListener('open', (() => {
      this.#onOpen(socket);
    }) as unknown as EventListener);
    socket.addEventListener('message', ((event: { data: unknown }) => {
      this.#onFrame(socket, event.data);
    }) as unknown as EventListener);
    socket.addEventListener('close', ((event: { code?: number; reason?: string }) => {
      this.#onClose(socket, event.code ?? 1006, event.reason ?? '');
    }) as unknown as EventListener);
    socket.addEventListener('error', (() => {
      // `error` on a WebSocket carries no detail by specification and is always followed by `close`,
      // which is where the decision to reconnect belongs. Reporting it keeps it out of the dark.
      this.#emit('error', {
        code: 'SOCKET_ERROR',
        message: 'the WebSocket reported a transport error',
        traceId: '',
        fatal: false,
      });
    }) as unknown as EventListener);
  }

  #onOpen(socket: WebSocket): void {
    if (socket !== this.#socket) return;
    const token = this.#options.token;
    this.#sendOn(socket, {
      t: 'hello',
      protocol: WS_PROTOCOL_VERSION,
      client: this.#options.clientVersion,
      ...(token === undefined ? {} : { token }),
      conflationMs: this.#requestedConflationMs,
      resume: this.#resumable,
    });
  }

  #onClose(socket: WebSocket, rawCode: number, rawReason: string): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#stopHeartbeat();
    // 1005/1006 mean the close frame never arrived; `bye` is the in-band copy of the same verdict,
    // so a lost close frame still gets its real code (`wire/ws.ts` on WS_CLOSE).
    const bye = this.#bye;
    const lost = rawCode === 1005 || rawCode === 1006;
    const code = lost && bye !== null ? bye.code : rawCode;
    const reason = lost && bye !== null ? bye.reason : rawReason;
    this.#emitClose(code, reason);

    if (this.#closedByUser) {
      this.#teardown(code, reason);
      return;
    }
    if (!shouldReconnect(code)) {
      // 4001/4002/4003/4010: reconnecting without new credentials or a new build would loop.
      this.#phase = 'closed';
      this.#announceState();
      this.#settleConnect?.(
        new Error(`LiveClient: socket closed ${String(code)} (${reason}); not retryable`),
      );
      return;
    }
    this.#stats.reconnects += 1;
    this.#phase = 'reconnecting';
    this.#announceState();
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    this.#clearBackoff();
    this.#attempt += 1;
    const delay = backoffDelayMs(this.#attempt, this.#random);
    this.#backoffHandle = this.#timers.setTimeout(() => {
      this.#backoffHandle = null;
      if (this.#closedByUser || this.#phase === 'closed') return;
      this.#openSocket();
    }, delay);
  }

  #clearBackoff(): void {
    if (this.#backoffHandle === null) return;
    this.#timers.clearTimeout(this.#backoffHandle);
    this.#backoffHandle = null;
  }

  /** Idempotent: `close()` and a late `close` event both land here. */
  #teardown(code: number, reason: string): void {
    this.#emitClose(code, reason);
    this.#clearBackoff();
    this.#stopHeartbeat();
    this.#socket = null;
    this.#registry.clear();
    this.#cache.stopTicker();
    this.#cache.delete();
    this.#gapped.clear();
    this.#resyncToSend.clear();
    this.#resyncScheduled = false;
    this.#sessionId = null;
    this.#resumable = false;
    this.#attempt = 0;
    if (this.#phase !== 'closed') {
      this.#phase = 'closed';
      this.#announceState();
    }
    this.#settleConnect?.(
      new Error(`LiveClient: closed ${String(code)} (${reason}) before the handshake completed`),
    );
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    const tick = (): void => {
      if (this.#phase !== 'open' || this.#socket === null) return;
      this.#pingN += 1;
      this.#send({ t: 'ping', n: this.#pingN });
      this.#heartbeatHandle = this.#timers.setTimeout(tick, this.#heartbeatMs);
    };
    this.#heartbeatHandle = this.#timers.setTimeout(tick, this.#heartbeatMs);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatHandle === null) return;
    this.#timers.clearTimeout(this.#heartbeatHandle);
    this.#heartbeatHandle = null;
  }

  // ── Sending ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The registry's sink, and every control frame's.
   *
   * A frame produced while the socket is down is **dropped, not queued**. The registry's flush is a
   * reconciliation of held state against wire state, not a queue of intentions, so a `sub` that
   * missed its socket is re-derived by `resume()` on the next `welcome` — with `known: lastSeq`,
   * which a queued copy would not have. Queuing would replay a stale field set at a stale tier.
   */
  #send(msg: ClientMsgInput): void {
    const socket = this.#socket;
    if (socket === null || this.#phase !== 'open') {
      this.#stats.framesDropped += 1;
      return;
    }
    this.#sendOn(socket, msg);
  }

  #sendOn(socket: WebSocket, msg: ClientMsgInput): void {
    const parsed = ClientMsg.safeParse(msg);
    if (!parsed.success) {
      // Our own bug, not the server's. Report it rather than putting a frame on the wire that the
      // server will answer with `err { fatal:true }` and `bye 4002`.
      this.#emit('error', {
        code: 'VALIDATION_FAILED',
        message: `refusing to send an invalid ${String((msg as { t?: unknown }).t)} frame: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
        traceId: '',
        fatal: false,
      });
      return;
    }
    socket.send(JSON.stringify(msg));
    this.#stats.framesSent += 1;
  }

  // ── Receiving ───────────────────────────────────────────────────────────────────────────────

  #onFrame(socket: WebSocket, data: unknown): void {
    if (socket !== this.#socket) return;
    if (typeof data !== 'string') {
      this.#protocolError('the server sent a non-text frame; this protocol is JSON only');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch (err) {
      this.#protocolError(`malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const parsed = ServerMsg.safeParse(json);
    if (!parsed.success) {
      this.#protocolError(
        `frame failed ServerMsg: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
      return;
    }
    this.#stats.framesReceived += 1;
    this.#handle(parsed.data);
  }

  /**
   * A frame that does not parse is a protocol error, not something to coerce.
   *
   * Nothing is guessed from a frame this client cannot read: field order, frame boundaries and the
   * `prev` chain all depend on understanding every frame, so a stream we can only partly decode is
   * one whose numbers we cannot stand behind. `4002` is terminal by §6.7 — reconnecting to a server
   * speaking a dialect this build does not know would loop — so the socket closes and stays closed
   * until the host reconnects deliberately.
   */
  #protocolError(message: string): void {
    this.#stats.protocolErrors += 1;
    this.#emit('error', { code: 'PROTOCOL_ERROR', message, traceId: '', fatal: true });
    this.#closedByUser = true;
    const socket = this.#socket;
    if (socket !== null && socket.readyState !== socket.CLOSED) {
      socket.close(WS_CLOSE.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
    }
    this.#teardown(WS_CLOSE.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
  }

  #handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.#onWelcome(msg);
        return;
      case 'subAck':
        this.#registry.settle({ accepted: [...msg.accepted], rejected: [...msg.rejected] });
        for (const row of msg.rejected) {
          // A rejection is not an exception — the `ack` promise carries it — but it must not be
          // invisible either: a subject nobody awaited would otherwise vanish without a word.
          this.#emit('error', {
            code: row.code,
            message: `sub rejected for ${row.s}: ${row.reason}`,
            traceId: msg.traceId,
            fatal: false,
          });
        }
        return;
      case 'snap':
      case 'delta':
      case 'status':
        this.#ingest(msg);
        this.#announceState();
        return;
      case 'batch':
        for (const inner of msg.m) this.#ingest(inner);
        this.#announceState();
        return;
      case 'downgrade':
        this.#emit('downgrade', {
          ...(msg.s === undefined ? {} : { subject: msg.s }),
          from: msg.from,
          to: msg.to,
          reason: msg.reason,
        });
        return;
      case 'resync':
        this.#onServerResync(msg.subjects);
        return;
      case 'notice':
        if (msg.conflationMs !== undefined) this.#effectiveConflationMs = msg.conflationMs;
        this.#emit('notice', msg);
        return;
      case 'alert':
        this.#emit('alert', { alertId: msg.alertId, firedAt: msg.firedAt, payload: msg.payload });
        return;
      case 'msg':
        this.#emit('message', { room: msg.room, message: msg.message });
        return;
      case 'err':
        this.#emit('error', {
          code: msg.code,
          message: msg.message,
          traceId: msg.traceId,
          fatal: msg.fatal,
        });
        return;
      case 'pong':
        return;
      case 'bye':
        // Not a close in itself: the socket's own close frame follows and is what `close` reports.
        // This is the in-band copy, kept so a lost close frame still yields the real code (§6.7).
        this.#bye = { code: msg.code, reason: msg.reason };
        return;
    }
  }

  #onWelcome(msg: ServerMsgOf<'welcome'>): void {
    this.#sessionId = msg.sessionId;
    this.#limits = { ...msg.limits };
    this.#effectiveConflationMs = msg.conflationMs;
    this.#heartbeatMs = msg.heartbeatMs;
    this.#resumable = true;
    this.#attempt = 0;
    this.#phase = 'open';
    // The fresh `snap`s are on their way for everything (§6.3 step 6), so nothing is waiting on a
    // gap any more. Cleared rather than filled with every subject because a subject the server now
    // rejects never sends a snap, and a client that waited for all of them would never leave
    // 'resyncing'. The cache keeps its own per-subject quarantine, so no delta can slip in early.
    this.#gapped.clear();
    this.#resyncToSend.clear();
    this.#announceState();
    this.#startHeartbeat();
    // Re-`sub` every live subscription with `known: lastSeq[s]`. On the very first `welcome` this is
    // the initial `sub`; on a reconnect the server answers with fresh snaps and never replays
    // deltas, so applying them is idempotent either way.
    this.#registry.resume();
    this.#settleConnect?.(null);
  }

  /**
   * The only path from a frame to a screen.
   *
   * `QuoteCache.apply()` is the sole implementation of the prev-chain rule (§6.3 step 3) and the
   * sole owner of the views, so there is nothing to bypass it with. What is decided here is the
   * consequence: `resyncNeeded` means the chain broke and a fresh `snap` must be asked for, and a
   * frame the cache did not take (a duplicate, or a delta ignored while the subject waits for its
   * snap) raises no `update`.
   *
   * Whether the cache took the frame is read from the view's `seq` **advancing**, not from it merely
   * equalling the frame's: a duplicate at exactly `lastSeq` is dropped by the rule and leaves a view
   * whose `seq` already matches, so equality would report it as applied and emit an `update` for a
   * frame nothing happened for. Reading the movement costs one lookup and keeps this file free of a
   * second copy of `lastSeq` that could drift from the cache's.
   */
  #ingest(frame: Snap | Delta | Status): void {
    const seqBefore = this.#cache.get(frame.s)?.seq ?? -1;
    const result = this.#cache.apply(frame);
    if (result.resyncNeeded) {
      this.#requestResync(frame.s);
      return;
    }
    if (frame.t === 'status') {
      if (frame.st === 'shed') this.#registry.markShed(frame.s);
      this.#emit('status', {
        subject: frame.s,
        st: frame.st,
        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      });
      return;
    }
    const view = this.#cache.get(frame.s);
    // A `snap` always re-bases, even onto the same `seq` (a second copy of a snapshot is idempotent,
    // not a duplicate to ignore); a `delta` counts as applied only when it moved the view forward.
    const applied = view !== undefined && (frame.t === 'snap' || view.seq > seqBefore);
    if (view === undefined || !applied) {
      this.#stats.skipped += 1;
      return;
    }
    this.#stats.applied += 1;
    if (frame.t === 'snap') {
      this.#gapped.delete(frame.s);
      this.#resyncToSend.delete(frame.s);
    }
    const event: UpdateEvent = {
      subject: frame.s,
      seq: frame.seq,
      changed: result.changed,
      state: view,
      kind: frame.t,
    };
    this.#emit('update', event);
    this.#registry.dispatch(event);
  }

  /**
   * A broken chain: ask for a fresh `snap` and say so in {@link LiveClient.state}.
   *
   * The frame is batched with the animation frame rather than sent immediately, because a socket
   * hiccup gaps every subject in the same `batch`: a thousand rows would be a thousand `resync`
   * frames, which is fifty times the 20-messages-per-second limit of §6.7 and would earn a
   * `4029 RATE_LIMITED` close — turning one lost frame into an outage. Coalescing is safe precisely
   * because the rule already ignores every further delta for the subject until its `snap` arrives,
   * so nothing can be wrongly applied in the meantime.
   */
  #requestResync(subject: string): void {
    this.#stats.resyncs += 1;
    this.#gapped.add(subject);
    if (this.#resyncToSend.has(subject)) return;
    this.#resyncToSend.add(subject);
    this.#announceState();
    if (this.#resyncScheduled) return;
    this.#resyncScheduled = true;
    this.#scheduleFrame(() => {
      this.#resyncScheduled = false;
      this.#flushResync();
    });
  }

  #flushResync(): void {
    if (this.#resyncToSend.size === 0) return;
    const subjects = [...this.#resyncToSend];
    this.#resyncToSend.clear();
    if (this.#phase !== 'open') {
      // The reconnect's `resume()` re-`sub`s everything and gets a fresh snap per subject, which is
      // strictly more than this frame would have asked for.
      return;
    }
    this.#send({ t: 'resync', subjects });
  }

  /**
   * Server-initiated resync (§6.3 step 7): the listed subjects must be re-`sub`bed, and until they
   * are, the server sends nothing for them — it has already dropped its hold
   * (`ws/session.ts#resyncFromServer` removes them from the conflator).
   *
   * `SubscriptionRegistry.resume()` re-`sub`s every held subject rather than only the listed ones.
   * That is a superset of what step 7 requires and costs extra snapshots when the list is short; it
   * is what the registry's surface offers today, and the cause of a server resync — a plant restart
   * or an entitlement cache reload — is a whole-session event in practice.
   */
  #onServerResync(subjects: readonly string[] | undefined): void {
    if (this.#phase !== 'open') return;
    const held = new Set(this.#registry.subjects());
    const affected =
      subjects === undefined ? [...held] : subjects.filter((subject) => held.has(subject));
    if (affected.length === 0) return;
    this.#stats.resyncs += affected.length;
    for (const subject of affected) {
      this.#gapped.add(subject);
      this.#resyncToSend.delete(subject);
    }
    this.#announceState();
    this.#registry.resume();
  }
}
