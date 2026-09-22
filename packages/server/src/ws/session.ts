/**
 * `ws/session.ts` — one live WebSocket session (API.md §6.3, §6.5, §6.6; ARCHITECTURE §6.3).
 *
 * Everything that is *per socket* lives here: the principal, the subscription set, the
 * {@link Conflator} that turns plant events into `batch` frames, the timers that drive the flush
 * loop, and the bookkeeping rows (`dq_events`, `usage_events`) every backpressure rung owes.
 *
 * Three rules shape the file:
 *
 *  - **Time is injected, timers are a port.** Every instant is `clock.now()`; every schedule goes
 *    through {@link WsTimers}. This is the one module in the server allowed to hold a real timer,
 *    and it holds it only through that port, so a test can drive a handshake deadline without
 *    waiting five seconds and a virtual clock can stamp the frames it produces.
 *  - **Nothing is invented.** A denied field is `null` with a reason, a subject with no firm grant
 *    is accepted and blank, an unknown subject is rejected — never a zero, never a stale number
 *    from a tier the subscriber may not see (ENTL-05).
 *  - **The send path never awaits.** Entitlement evaluation happens while answering `sub`;
 *    `usage_events` and `dq_events` rows are queued and written on the housekeeping tick, so a slow
 *    database cannot stall a flush.
 *
 * Reply order for `sub` is the protocol's, not an implementation detail: `subAck`, then exactly one
 * `snap` per accepted subject inside `batch` frames, then `delta`s. The snapshot burst is the
 * conflator's first flush, which is also what splits it at the 1 MiB frame cap.
 */

import { randomUUID } from 'node:crypto';

import { hasField, maskOf, valueState } from '@terminal/core';
import type {
  Clock,
  EntitlementDecision,
  EntitlementRequest,
  FieldId,
  ReasonCode,
  Tier,
  ValueState,
} from '@terminal/core';
import { WS_CLOSE } from '@terminal/sdk/wire/ws';
import type { ClientMsg, ServerMsg, Snap, Status } from '@terminal/sdk/wire/ws';

import type { Db, Tx } from '../db/client.js';
import { currentTx, runWithTx, withTx } from '../db/client.js';
import { usageEvents } from '../db/schema/ops.js';
import type { HotSet } from '../ingest/hotset.js';
import { raiseWsBackpressure } from '../observability/dq.js';
import { view } from '../plant/policyTier.js';
import { allowsAllFields, instrumentIdOf, parseSubject } from '../plant/subjects.js';
import type { Plant, PlantEvent } from '../plant/tickerPlant.js';

import type { WsPrincipal } from './auth.js';
import { Conflator } from './conflator.js';
import type { BackpressureThresholds, ConflatorEvent, Subscription } from './conflator.js';
import { clientFrameLimit, decode, encode, ProtocolEncodeError } from './protocol.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** An opaque handle from {@link WsTimers.setTimeout}. */
export type WsTimerHandle = unknown;

/**
 * The scheduling port. Production passes the platform timers; a test passes a manual queue and
 * decides when 5 s of handshake patience have elapsed.
 */
export interface WsTimers {
  setTimeout(fn: () => void, ms: number): WsTimerHandle;
  clearTimeout(handle: WsTimerHandle): void;
}

/** The platform timers, unref'd so a pending flush never holds the process open. */
export const systemTimers: WsTimers = {
  setTimeout(fn: () => void, ms: number): WsTimerHandle {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle: WsTimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** The entitlement evaluator, as a port: WP-07 owns the implementation (ENTL-01). */
export interface WsEntitlements {
  evaluate(req: EntitlementRequest): Promise<EntitlementDecision>;
}

/**
 * The fail-closed default (ENTL-01). Until WP-07 wires the real evaluator, a server that has no
 * entitlement source denies every field rather than serving data it cannot prove a licence for.
 */
export const denyAllEntitlements: WsEntitlements = {
  evaluate(req: EntitlementRequest): Promise<EntitlementDecision> {
    return Promise.resolve({
      effectiveTier: null,
      fields: req.fieldIds.map((fieldId) => ({
        fieldId,
        sourceId: '',
        fieldClass: 'price' as const,
        decision: 'deny' as const,
        effectiveTier: null,
        reason: 'NO_FIRM_ENTITLEMENT' as const,
      })),
      downgrades: [],
      logIds: [],
    });
  },
};

/**
 * The quota source, as a port: `entitlements/quotas.ts` (WP-07) satisfies it structurally.
 *
 * Only the concurrency ceiling is needed here, and only the EXPLICIT one. API.md §8 puts the
 * per-subject limits in `quota_limits` (user row, then firm row) and leaves the defaults to the
 * host — 10 000 for a web session, 2 000 for an api one (BUS-08) — so `null` means "no row, use
 * your own {@link WsLimits}" and is not the same answer as a row that happens to say 2 000.
 */
export interface WsQuotas {
  concurrencyCeiling(userId: number, firmId: number): Promise<number | null>;
}

/** The socket, narrowed to what a session uses (`ws.WebSocket` satisfies it structurally). */
export interface SessionSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** Limits and cadences of API.md §6.3/§6.7. Everything is overridable so a test can be quick. */
export interface WsLimits {
  /** `welcome.limits.maxSubscriptions` for a cookie session. */
  maxSubscriptionsWeb: number;
  /** `welcome.limits.maxSubscriptions` for a bearer session. */
  maxSubscriptionsApi: number;
  /** `welcome.limits.maxFields`; the wire schema caps `f` at 100 independently. */
  maxFields: number;
  /** `welcome.heartbeatMs` — how often the client should `ping`. */
  heartbeatMs: number;
  /** Silence after which the session closes `4000 IDLE`. */
  idleTimeoutMs: number;
  /** How long a socket may stay silent before `hello`; then `4001 AUTH_REQUIRED`. */
  helloTimeoutMs: number;
  /** Client messages per second before the rate limiter starts counting the overage. */
  maxClientMsgsPerSec: number;
  /** How long the rate may stay over before `4029 RATE_LIMITED`. */
  rateGraceMs: number;
  /** The staleness sweep and housekeeping cadence (TERM-12). */
  sweepMs: number;
  /** `hello.conflationMs`'s default when the client sends none. */
  conflationDefaultMs: number;
  /** How many `sub` frames may be rejected with `LIMIT` before `4011 SUBSCRIPTION_LIMIT`. */
  maxLimitRejections: number;
}

export const DEFAULT_WS_LIMITS: WsLimits = Object.freeze({
  maxSubscriptionsWeb: 10_000,
  maxSubscriptionsApi: 2_000,
  maxFields: 100,
  heartbeatMs: 15_000,
  idleTimeoutMs: 45_000,
  helloTimeoutMs: 5_000,
  maxClientMsgsPerSec: 20,
  rateGraceMs: 3_000,
  sweepMs: 1_000,
  conflationDefaultMs: 250,
  maxLimitRejections: 2,
});

/** What the session needs from its host. */
export interface WsSessionDeps {
  socket: SessionSocket;
  clock: Clock;
  plant: Plant;
  timers: WsTimers;
  limits: WsLimits;
  entitlements: WsEntitlements;
  /**
   * API-06. Read ONCE, at `hello`, for this session's concurrent-subscription ceiling. Omitted →
   * the ceiling is {@link WsLimits}'s, which is what every WP-06 test relies on.
   */
  quotas?: WsQuotas;
  /** Resolved on the upgrade from the `tsid` cookie; `null` until `hello.token` says otherwise. */
  principal: WsPrincipal | null;
  /** Answers `hello.token`; `null` when the socket already has a cookie principal. */
  authenticate(token: string): Promise<WsPrincipal | null>;
  thresholds?: Partial<BackpressureThresholds>;
  db?: Db | Tx;
  hotset?: HotSet;
  /** Called once the principal is known, so the gateway can supersede an older socket. */
  onAuthenticated?(session: WsSession): void;
  /** Called once, when the socket is gone. */
  onClosed?(session: WsSession): void;
  log?: { warn(o: unknown, m: string): void; error(o: unknown, m: string): void };
}

/** One queued `usage_events` row (FUNC-04). Written on the housekeeping tick, never on the send path. */
interface UsageRow {
  ts: Date;
  userId: number;
  firmId: number;
  sessionId: string;
  kind: 'ws.subscribe' | 'ws.slow' | 'ws.resync';
  instrumentId: number | null;
  traceId: string;
  details: Record<string, unknown>;
}

/** Tier order, lowest first — `eod < delayed < realtime` (API.md §6.6). */
const TIER_RANK: Record<Tier, number> = { eod: 0, delayed: 1, realtime: 2 };

/**
 * How many subjects of an oversize `sub` are named in the `LIMIT` rejection. Nothing in the frame
 * was accepted, so the list is a diagnostic; capping it keeps the answer to an over-large frame
 * from being over-large itself.
 */
const OVERSIZE_REJECT_CAP = 100;

/** `ValueState` → the `status.st` enum, or `null` when the state has no wire form. */
function statusState(v: ValueState): Status['st'] | null {
  switch (v) {
    case 'stale':
      return 'stale';
    case 'closed':
      return 'closed';
    case 'blank':
      return 'blank';
    default:
      // `live` and `na` have no `status` form: the client recomputes `valueState` every second
      // (TERM-12) and the next `delta` carries the recovered verdict.
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────────────────────

export class WsSession {
  /** `sessions.session_id` once authenticated; a synthetic id before that (for logs only). */
  principal: WsPrincipal | null;

  readonly traceId = randomUUID();

  readonly #deps: WsSessionDeps;
  readonly #clock: Clock;
  readonly #limits: WsLimits;
  readonly #socket: SessionSocket;

  /** Resolved once at `hello` (API-06); `null` until then, when {@link WsLimits} decides. */
  #subscriptionCeiling: number | null = null;

  #conflator: Conflator | null = null;
  #unsubscribePlant: (() => void) | null = null;

  #open = true;
  #helloSeen = false;
  #authPending = false;
  /** Frames that arrived while `hello`'s authentication was in flight, in receipt order. */
  readonly #pending: string[] = [];

  #helloTimer: WsTimerHandle = null;
  #flushTimer: WsTimerHandle = null;
  #sweepTimer: WsTimerHandle = null;

  #lastClientMs: number;
  /**
   * Arrival instants of the most recent `maxClientMsgsPerSec + 1` client frames, oldest first: a
   * **sliding** second, not a tumbling one. The rate is over the limit exactly while that many
   * frames have arrived inside the last 1 000 ms, which is what lets a sustained overage
   * accumulate across second boundaries until `4029` (API.md §6.7).
   */
  readonly #rateTimes: number[] = [];
  #rateOverSinceMs: number | null = null;
  /** When the client was last told it is over the limit; at most one `err` per second. */
  #rateNotifiedMs: number | null = null;

  #limitRejections = 0;

  /** Subjects the server asked the client to re-`sub`; no frame is sent for them until it does. */
  readonly #suppressed = new Set<string>();

  readonly #usage: UsageRow[] = [];
  /**
   * Usage writes are serialised: at most one insert is ever in flight for a session, and
   * {@link WsSession.settle} is what a host awaits before the connection under it goes away. A
   * fire-and-forget write that outlived its transaction would land in the *next* one.
   */
  #usageChain: Promise<void> = Promise.resolve();
  #usageDropped = 0;
  #framesSent = 0;

  constructor(deps: WsSessionDeps) {
    this.#deps = deps;
    this.#clock = deps.clock;
    this.#limits = deps.limits;
    this.#socket = deps.socket;
    this.principal = deps.principal;
    this.#lastClientMs = deps.clock.now();
    this.#helloTimer = deps.timers.setTimeout(() => {
      this.#onHelloTimeout();
    }, deps.limits.helloTimeoutMs);
  }

  get open(): boolean {
    return this.#open;
  }

  /** The conflator, once `hello` has been answered. */
  get conflator(): Conflator | null {
    return this.#conflator;
  }

  get subjects(): readonly string[] {
    return this.#conflator === null ? [] : [...this.#conflator.subs.keys()];
  }

  stats(): {
    subscriptions: number;
    framesSent: number;
    usageQueued: number;
    usageDropped: number;
    effectiveMs: number;
  } {
    return {
      subscriptions: this.#conflator?.subs.size ?? 0,
      framesSent: this.#framesSent,
      usageQueued: this.#usage.length,
      usageDropped: this.#usageDropped,
      effectiveMs: this.#conflator?.effectiveMs ?? 0,
    };
  }

  // -- inbound --------------------------------------------------------------

  /** One raw text frame from the socket. Never throws. */
  handleRaw(text: string): void {
    if (!this.#open) return;
    if (this.#authPending) {
      this.#pending.push(text);
      return;
    }

    // The idle deadline is refreshed by a frame the session actually handles: a frame the rate
    // limiter drops must not hold the socket (and its subscriptions) open past `4000 IDLE`.
    if (!this.#rateOk()) return;
    this.#lastClientMs = this.#clock.now();

    const result = decode(text);
    if (!result.ok) {
      // Protocol *version* negotiation happens before schema validation: a `hello` whose
      // `protocol` is not the served one fails `ClientMsg` (the schema pins `z.literal(1)`), and
      // API.md §6.7 answers that with `4010 PROTOCOL_VERSION`, not `4002`. The frame is never
      // re-parsed here — `ws/protocol.ts` is the only module that parses a frame — so the
      // discrimination is made on the decoder's own issue report.
      if (
        !this.#helloSeen &&
        result.code === 'BAD_FRAME' &&
        /(^|; )protocol: /.test(result.message)
      ) {
        this.#send({
          t: 'err',
          code: 'PROTOCOL_VERSION',
          message: 'unsupported protocol version',
          traceId: this.traceId,
          fatal: true,
        });
        this.close(WS_CLOSE.PROTOCOL_VERSION, 'PROTOCOL_VERSION');
        return;
      }
      this.#send({
        t: 'err',
        code: result.code,
        message: result.message,
        traceId: this.traceId,
        fatal: true,
      });
      this.close(WS_CLOSE.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
      return;
    }

    const limit = clientFrameLimit(result.msg.t);
    if (result.bytes > limit) {
      this.#onOversizeFrame(result.msg, result.bytes, limit);
      return;
    }

    this.#dispatch(result.msg);
  }

  /**
   * A schema-valid frame past the ceiling of its own type (API.md §6.7: 64 KiB in general, 1 MiB
   * for `sub`). This is not "a frame that fails `ClientMsg`", so it is not a `4002`: a `sub` is
   * answered with `subAck.rejected[].code = 'LIMIT'` (§6.6 maps frame size to `LIMIT`) and the
   * other subject frames with a non-fatal `err` — the client is told, never disconnected. Only a
   * frame of a type whose ceiling is the general 64 KiB one is fatal.
   */
  #onOversizeFrame(msg: ClientMsg, bytes: number, limit: number): void {
    const message = `${msg.t} frame is ${String(bytes)} bytes, limit is ${String(limit)}`;
    if (msg.t === 'sub') {
      const rejected = msg.subjects
        .slice(0, OVERSIZE_REJECT_CAP)
        .map((item) => ({ s: item.s, code: 'LIMIT' as const, reason: message }));
      this.#send({ t: 'subAck', id: msg.id, accepted: [], rejected, traceId: this.traceId });
      return;
    }
    if (msg.t === 'unsub' || msg.t === 'resync') {
      this.#send({ t: 'err', code: 'LIMIT', message, traceId: this.traceId, fatal: false });
      return;
    }
    this.#send({
      t: 'err',
      code: 'FRAME_TOO_LARGE',
      message,
      traceId: this.traceId,
      fatal: true,
    });
    this.close(WS_CLOSE.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
  }

  /** The socket went away (client close, kill, or our own close). */
  onSocketClosed(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#teardown();
    this.#deps.onClosed?.(this);
  }

  /** Send `bye`, then close. Safe to call twice. */
  close(code: number, reason: string): void {
    if (!this.#open) return;
    this.#send({ t: 'bye', code, reason });
    this.#open = false;
    this.#teardown();
    try {
      this.#socket.close(code, reason.slice(0, 120));
    } catch {
      this.#socket.terminate();
    }
    this.#deps.onClosed?.(this);
  }

  // -- outbound -------------------------------------------------------------

  /** Send one server frame. Encoding failures are the server's bug and are logged, never shipped. */
  #send(frame: ServerMsg): void {
    if (!this.#open) return;
    let text: string;
    try {
      text = encode(frame);
    } catch (err) {
      if (err instanceof ProtocolEncodeError) {
        this.#deps.log?.error({ err: err.issues, t: frame.t }, 'ws: refusing to send an off-schema frame');
        return;
      }
      throw err;
    }
    try {
      this.#socket.send(text);
      this.#framesSent += 1;
    } catch (err) {
      this.#deps.log?.warn({ err: String(err) }, 'ws: send failed');
    }
  }

  /** Server-initiated resync (API.md §6.3 step 7): re-`sub` these subjects; nothing flows first. */
  resyncFromServer(subjects?: readonly string[]): void {
    if (!this.#open || this.#conflator === null) return;
    const wanted =
      subjects === undefined
        ? [...this.#conflator.subs.keys()]
        : subjects.filter((s) => this.#conflator?.subs.has(s) === true);
    if (wanted.length === 0) return;
    for (const subject of wanted) {
      this.#suppressed.add(subject);
      this.#conflator.remove(subject);
      this.#deps.hotset?.unsubscribe(subject);
    }
    this.#send({ t: 'resync', subjects: wanted });
    this.#queueUsage('ws.resync', null, { subjects: wanted.length, cause: 'server' });
  }

  /**
   * A grant changed under a live session (ENTL-05; TESTING.md §10 row 15). Every held subscription
   * is re-evaluated at the tier it currently holds; a subject that lost tier, lost its grant
   * entirely, or gained a field denial is told once with a `downgrade` frame and then resynced, so
   * its next value arrives in a fresh `snap`. That ordering is the rule, not a convenience: a
   * `delta` may never introduce a denial (API.md §6.4), and the only frame that can carry an `r`
   * map is a `snap`.
   */
  async revalidate(): Promise<void> {
    const conflator = this.#conflator;
    const principal = this.principal;
    if (!this.#open || conflator === null || principal === null) return;

    const changed: string[] = [];
    for (const sub of [...conflator.subs.values()]) {
      const state = this.#deps.plant.get(sub.subject);
      if (state === undefined) continue;
      const parsed = parseSubject(sub.subject);
      const fieldIds: FieldId[] =
        sub.fieldIds.length > 0 ? sub.fieldIds : Object.keys(state.fields);
      const request: EntitlementRequest = {
        userId: principal.userId,
        firmId: principal.firmId,
        sessionId: principal.sessionId,
        instrumentId: (parsed === null ? null : instrumentIdOf(parsed)) ?? state.instrumentId,
        assetClass: state.assetClass,
        fieldIds,
        tier: sub.tier,
        usage: principal.clientKind === 'api' ? 'api' : 'display',
        purpose: 'ws.sub',
        traceId: this.traceId,
      };

      let decision: EntitlementDecision;
      try {
        decision = await this.#deps.entitlements.evaluate(request);
      } catch (err) {
        this.#deps.log?.error(
          { err: String(err), subject: sub.subject },
          'ws: entitlement re-evaluation failed',
        );
        continue;
      }
      if (!this.#open) return;

      const effective = decision.effectiveTier;
      const lowered = effective === null || TIER_RANK[effective] < TIER_RANK[sub.tier];
      const newDenial = decision.fields.some(
        (f) => f.decision === 'deny' && !sub.denied.has(f.fieldId),
      );
      if (!lowered && !newDenial) continue;

      this.#send({
        t: 'downgrade',
        s: sub.subject,
        from: sub.tier,
        to: effective,
        reason: reasonOf(decision, effective === null),
      });
      changed.push(sub.subject);
    }

    if (changed.length > 0) this.resyncFromServer(changed);
  }

  /** Does this session hold a subscription on `subject`? (`sendToRoom` membership.) */
  holds(subject: string): boolean {
    return this.#conflator?.subs.has(subject) === true;
  }

  /** Push a frame the gateway built (alerts, room messages, shutdown notices). */
  push(frame: ServerMsg): void {
    this.#send(frame);
  }

  // -- dispatch -------------------------------------------------------------

  #dispatch(msg: ClientMsg): void {
    switch (msg.t) {
      case 'hello':
        this.#onHello(msg);
        return;
      case 'sub':
        void this.#onSub(msg);
        return;
      case 'unsub':
        this.#onUnsub(msg.subjects);
        return;
      case 'resync':
        this.#onResync(msg.subjects);
        return;
      case 'conflation':
        this.#conflator?.setRequestedMs(msg.ms);
        return;
      case 'essential':
        for (const subject of msg.subjects) {
          const sub = this.#conflator?.subs.get(subject);
          if (sub !== undefined) sub.essential = msg.essential;
        }
        return;
      case 'ping':
        this.#send({ t: 'pong', n: msg.n, serverTime: this.#clock.now() });
        return;
    }
  }

  #onHello(msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (this.#helloSeen) {
      this.#send({
        t: 'err',
        code: 'PROTOCOL_ERROR',
        message: 'hello already received',
        traceId: this.traceId,
        fatal: true,
      });
      this.close(WS_CLOSE.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
      return;
    }
    this.#helloSeen = true;
    this.#clearHelloTimer();

    if (this.principal !== null) {
      this.#beginWelcome(msg);
      return;
    }
    if (msg.token === undefined || msg.token.length === 0) {
      this.#send({ t: 'bye', code: WS_CLOSE.AUTH_REQUIRED, reason: 'AUTH_REQUIRED' });
      this.close(WS_CLOSE.AUTH_REQUIRED, 'AUTH_REQUIRED');
      return;
    }

    this.#authPending = true;
    void this.#deps
      .authenticate(msg.token)
      .then((principal) => {
        this.#authPending = false;
        if (!this.#open) return;
        if (principal === null) {
          this.close(WS_CLOSE.AUTH_REQUIRED, 'AUTH_REQUIRED');
          return;
        }
        this.principal = principal;
        this.#beginWelcome(msg);
      })
      .catch((err: unknown) => {
        this.#authPending = false;
        this.#deps.log?.error({ err: String(err) }, 'ws: authentication failed');
        this.close(WS_CLOSE.AUTH_REQUIRED, 'AUTH_REQUIRED');
      });
  }

  #drainPending(): void {
    while (this.#pending.length > 0 && this.#open) {
      const next = this.#pending.shift();
      if (next !== undefined) this.handleRaw(next);
    }
  }

  /**
   * `welcome` needs one asynchronous fact — the session's concurrent-subscription ceiling
   * (API.md §8) — and `welcome` must still be the first frame the client sees. So the session
   * keeps the `#authPending` gate raised across the lookup: frames that arrive meanwhile queue in
   * `#pending`, exactly as they do while `hello.token` is being authenticated, and are drained
   * once the conflator exists. Without the gate a `sub` sent immediately after `hello` would find
   * no conflator and be answered "sub before hello".
   */
  #beginWelcome(msg: Extract<ClientMsg, { t: 'hello' }>): void {
    this.#authPending = true;
    void this.#welcome(msg)
      .catch((err: unknown) => {
        // `#resolveCeiling` already swallows a failed quota read, so reaching here is a server
        // bug. `1001` is the one code whose documented client behaviour — reconnect with backoff
        // and resync — is right for it (API.md §6.7).
        this.#deps.log?.error({ err: String(err) }, 'ws: welcome failed');
        this.close(WS_CLOSE.SERVER_SHUTDOWN, 'welcome-failed');
      })
      .finally(() => {
        this.#authPending = false;
        this.#drainPending();
      });
  }

  async #welcome(msg: Extract<ClientMsg, { t: 'hello' }>): Promise<void> {
    const principal = this.principal;
    if (principal === null) return;

    this.#subscriptionCeiling = await this.#resolveCeiling(principal);
    if (!this.#open) return;

    const requestedMs = msg.conflationMs;
    this.#conflator = new Conflator({
      plant: this.#deps.plant,
      clock: this.#clock,
      requestedMs,
      send: (frame) => {
        this.#send(frame);
      },
      bufferedAmount: () => this.#socket.bufferedAmount,
      ...(this.#deps.thresholds === undefined ? {} : { thresholds: this.#deps.thresholds }),
      onEvent: (ev) => {
        this.#onConflatorEvent(ev);
      },
    });

    this.#unsubscribePlant = this.#deps.plant.subscribe((ev) => {
      this.#onPlantEvent(ev);
    });

    this.#deps.onAuthenticated?.(this);

    this.#send({
      t: 'welcome',
      sessionId: principal.sessionId,
      serverTime: this.#clock.now(),
      protocol: 1,
      conflationMs: requestedMs,
      heartbeatMs: this.#limits.heartbeatMs,
      limits: {
        maxSubscriptions: this.#maxSubscriptions(),
        maxFields: this.#limits.maxFields,
      },
    });

    this.#armFlush();
    this.#armSweep();
  }

  /**
   * The host's own ceiling for this client kind (BUS-08): what applies when `quota_limits` holds
   * no row for the user or the firm, and what a test injects through {@link WsLimits}.
   */
  #hostCeiling(): number {
    return this.principal?.clientKind === 'api'
      ? this.#limits.maxSubscriptionsApi
      : this.#limits.maxSubscriptionsWeb;
  }

  /** The explicit `quota_limits` ceiling, or the host's. Never throws: a failed read falls back. */
  async #resolveCeiling(principal: WsPrincipal): Promise<number> {
    const quotas = this.#deps.quotas;
    if (quotas === undefined) return this.#hostCeiling();
    try {
      const explicit = await quotas.concurrencyCeiling(principal.userId, principal.firmId);
      return explicit ?? this.#hostCeiling();
    } catch (err) {
      this.#deps.log?.warn({ err: String(err) }, 'ws: quota ceiling lookup failed');
      return this.#hostCeiling();
    }
  }

  #maxSubscriptions(): number {
    return this.#subscriptionCeiling ?? this.#hostCeiling();
  }

  // -- sub ------------------------------------------------------------------

  async #onSub(msg: Extract<ClientMsg, { t: 'sub' }>): Promise<void> {
    const conflator = this.#conflator;
    const principal = this.principal;
    if (conflator === null || principal === null) {
      this.#send({
        t: 'err',
        code: 'PROTOCOL_ERROR',
        message: 'sub before hello',
        traceId: this.traceId,
        fatal: true,
      });
      this.close(WS_CLOSE.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
      return;
    }

    const accepted: { s: string; tier: Tier; reason: ReasonCode }[] = [];
    const rejected: { s: string; code: RejectCode; reason: string }[] = [];
    const blanks: Subscription[] = [];
    const requestedTier: Tier = msg.tier ?? 'delayed';

    // API-01: a bearer key carries scopes, and `ws:subscribe` is the one this frame needs. A key
    // minted without it is a read-only key; the scope is checked HERE because there is nowhere
    // else on this path that sees it. A web session is the person and always holds it.
    if (principal.clientKind === 'api' && !principal.scopes.includes('ws:subscribe')) {
      this.#send({
        t: 'subAck',
        id: msg.id,
        accepted: [],
        rejected: msg.subjects.slice(0, OVERSIZE_REJECT_CAP).map((item) => ({
          s: item.s,
          code: 'NOT_ENTITLED' as const,
          reason: 'this API key does not carry the ws:subscribe scope',
        })),
        traceId: this.traceId,
      });
      return;
    }
    /** Set only by the `maxSubscriptions` rung: that is the one `4011` counts (API.md §6.7). */
    let limitHit = false;

    for (const item of msg.subjects) {
      const subject = item.s;
      const parsed = parseSubject(subject);
      if (parsed === null) {
        rejected.push({ s: subject, code: 'SUBJECT_UNKNOWN', reason: 'subject does not parse' });
        continue;
      }
      if (item.f.length === 0 && !allowsAllFields(parsed.family)) {
        rejected.push({
          s: subject,
          code: 'FIELD_UNKNOWN',
          reason: `family ${parsed.family} must name its fields`,
        });
        continue;
      }
      const unknown = item.f.filter((id) => !hasField(id));
      if (unknown.length > 0) {
        rejected.push({
          s: subject,
          code: 'FIELD_UNKNOWN',
          reason: `unknown field ${unknown.slice(0, 3).join(', ')}`,
        });
        continue;
      }
      if (item.f.length > this.#limits.maxFields) {
        rejected.push({
          s: subject,
          code: 'LIMIT',
          reason: `at most ${String(this.#limits.maxFields)} fields per subject`,
        });
        continue;
      }
      if (!conflator.subs.has(subject) && conflator.subs.size >= this.#maxSubscriptions()) {
        limitHit = true;
        rejected.push({
          s: subject,
          // API.md §8: the concurrency ceiling is a QUOTA for an api session and the web ceiling
          // alone is reported as `LIMIT`.
          code: principal.clientKind === 'api' ? 'QUOTA_EXCEEDED' : 'LIMIT',
          reason: `at most ${String(this.#maxSubscriptions())} subscriptions per session`,
        });
        continue;
      }
      const state = this.#deps.plant.get(subject);
      if (state === undefined) {
        rejected.push({ s: subject, code: 'SUBJECT_UNKNOWN', reason: 'no such subject' });
        continue;
      }

      const fieldIds = item.f;
      const request: EntitlementRequest = {
        userId: principal.userId,
        firmId: principal.firmId,
        sessionId: principal.sessionId,
        instrumentId: instrumentIdOf(parsed) ?? state.instrumentId,
        assetClass: state.assetClass,
        fieldIds: fieldIds.length > 0 ? fieldIds : (Object.keys(state.fields)),
        tier: requestedTier,
        usage: principal.clientKind === 'api' ? 'api' : 'display',
        purpose: 'ws.sub',
        traceId: this.traceId,
      };

      let decision: EntitlementDecision;
      try {
        decision = await this.#deps.entitlements.evaluate(request);
      } catch (err) {
        this.#deps.log?.error({ err: String(err), subject }, 'ws: entitlement evaluation failed');
        rejected.push({ s: subject, code: 'NOT_ENTITLED', reason: 'entitlement check failed' });
        continue;
      }
      if (!this.#open) return;

      const denied = new Map<FieldId, ReasonCode>();
      for (const field of decision.fields) {
        if (field.decision === 'deny') denied.set(field.fieldId, field.reason);
      }
      const licenceForbids = decision.fields.some(
        (f) => f.reason === 'LICENCE_FORBIDS_USAGE' && f.decision === 'deny',
      );
      if (licenceForbids) {
        rejected.push({ s: subject, code: 'NOT_ENTITLED', reason: 'LICENCE_FORBIDS_USAGE' });
        continue;
      }

      const effective = decision.effectiveTier;
      const blank = effective === null;
      const tier: Tier = effective ?? requestedTier;
      const reason: ReasonCode = reasonOf(decision, blank);
      if (blank) {
        for (const id of request.fieldIds) if (!denied.has(id)) denied.set(id, reason);
      } else if (TIER_RANK[tier] < TIER_RANK[requestedTier]) {
        this.#send({ t: 'downgrade', s: subject, from: requestedTier, to: tier, reason });
      }

      this.#suppressed.delete(subject);
      const existing = conflator.subs.get(subject);
      const sub: Subscription = {
        subject,
        fieldMask: maskOf(fieldIds),
        fieldIds,
        lastSentSeq: existing?.lastSentSeq ?? 0,
        tier,
        essential: item.essential,
        denied,
        reason,
        lastFlushMs: 0,
      };
      // A blank subscription carries no value at all, so its `snap` is built here (with
      // `st:'blank'`, API.md §6.6) rather than by the conflator, which projects the plant's state.
      conflator.add(sub, { snapshot: !blank });
      if (blank) blanks.push(sub);
      // A re-`sub` (resync, reconnect) is the same hold, not a second one.
      if (existing === undefined) this.#deps.hotset?.subscribe(subject);
      accepted.push({ s: subject, tier, reason });
      this.#queueUsage('ws.subscribe', state.instrumentId, {
        subject,
        tier,
        reason,
        fields: fieldIds.length,
      });
      if (item.known !== undefined) {
        this.#queueUsage('ws.resync', state.instrumentId, {
          subject,
          known: item.known,
          gap: state.seq - item.known,
          cause: 'client',
        });
      }
    }

    this.#send({ t: 'subAck', id: msg.id, accepted, rejected, traceId: this.traceId });
    for (const sub of blanks) this.#sendBlankSnap(sub);
    // The snapshot burst: one `snap` per accepted subject, inside `batch` frames, split at the cap.
    conflator.flush();
    this.#armFlush();

    if (limitHit) {
      this.#limitRejections += 1;
      if (this.#limitRejections >= this.#limits.maxLimitRejections) {
        this.close(WS_CLOSE.SUBSCRIPTION_LIMIT, 'SUBSCRIPTION_LIMIT');
      }
    }
  }

  /** The `snap` of a subject the subscriber has no grant for: every field `null`, `st:'blank'`. */
  #sendBlankSnap(sub: Subscription): void {
    const state = this.#deps.plant.get(sub.subject);
    if (state === undefined) return;
    const ids = sub.fieldIds.length > 0 ? sub.fieldIds : (Object.keys(state.fields));
    const v = view(state, sub.tier, { fieldIds: ids, denied: sub.denied });
    const frame: Snap = {
      t: 'snap',
      s: sub.subject,
      seq: v.seq,
      tier: v.tier,
      reason: sub.reason,
      f: v.fields,
      fts: {},
      r: v.r,
      ts: v.ts,
      st: valueState({ ...state, denied: true }, this.#clock.now()),
      session: v.session,
      prov:
        state.prov.srcSeq === undefined
          ? { p: state.prov.sourceId, id: state.prov.provenanceId }
          : { p: state.prov.sourceId, id: state.prov.provenanceId, seq: state.prov.srcSeq },
      ac: state.assetClass,
      id: state.instrumentId,
    };
    sub.lastSentSeq = v.seq;
    sub.lastFlushMs = this.#clock.now();
    this.#send({ t: 'batch', m: [frame] });
  }

  #onUnsub(subjects: readonly string[]): void {
    for (const subject of subjects) {
      if (this.#conflator?.subs.has(subject) === true) {
        this.#conflator.remove(subject);
        this.#deps.hotset?.unsubscribe(subject);
      }
      this.#suppressed.delete(subject);
    }
  }

  #onResync(subjects: readonly string[]): void {
    const conflator = this.#conflator;
    if (conflator === null) return;
    for (const subject of subjects) {
      if (!conflator.subs.has(subject)) continue;
      // A fresh `snap`, never replayed deltas (API.md §6.3 step 6).
      conflator.markSnapshot(subject);
      const state = this.#deps.plant.get(subject);
      this.#queueUsage('ws.resync', state?.instrumentId ?? null, { subject, cause: 'client' });
    }
    conflator.flush();
    this.#armFlush();
  }

  // -- plant fan-out --------------------------------------------------------

  #onPlantEvent(ev: PlantEvent): void {
    const conflator = this.#conflator;
    if (conflator === null || !this.#open) return;
    if (!conflator.subs.has(ev.subject)) return;
    if (this.#suppressed.has(ev.subject)) return;

    if (ev.resync === true) {
      this.resyncFromServer([ev.subject]);
      return;
    }
    if (ev.queued) {
      // News is queued, never conflated: the state as published, so a headline cannot be
      // overwritten by the next one inside the window (NEWS-01).
      conflator.markQueued(ev.subject, ev.seq, this.#deps.plant.snapshot(ev.subject));
      return;
    }
    conflator.mark(ev.subject, ev.changed);
  }

  // -- timers ---------------------------------------------------------------

  #armFlush(): void {
    if (!this.#open || this.#conflator === null || this.#flushTimer !== null) return;
    const ms = Math.max(1, this.#conflator.effectiveMs);
    this.#flushTimer = this.#deps.timers.setTimeout(() => {
      this.#flushTimer = null;
      this.#onFlushTick();
    }, ms);
  }

  #onFlushTick(): void {
    if (!this.#open || this.#conflator === null) return;
    const outcome = this.#conflator.flush();
    if (outcome.closed) {
      this.close(WS_CLOSE.SLOW_CONSUMER, 'SLOW_CONSUMER');
      return;
    }
    this.#armFlush();
  }

  #armSweep(): void {
    if (!this.#open || this.#sweepTimer !== null) return;
    this.#sweepTimer = this.#deps.timers.setTimeout(() => {
      this.#sweepTimer = null;
      this.#onSweepTick();
    }, this.#limits.sweepMs);
  }

  #onSweepTick(): void {
    if (!this.#open) return;
    const now = this.#clock.now();
    if (now - this.#lastClientMs > this.#limits.idleTimeoutMs) {
      this.close(WS_CLOSE.IDLE, 'IDLE');
      return;
    }
    void this.flushUsage();
    this.#armSweep();
  }

  /**
   * The 1 s staleness sweep's verdict for one subject (TERM-12). The gateway runs the sweep once
   * for the whole plant and hands every session the transitions; a session sends a `status` frame
   * only for the subjects it holds, and only when the new verdict has a wire form.
   */
  onStalenessTransition(subject: string, to: ValueState, at: number): void {
    if (!this.#open || this.#suppressed.has(subject)) return;
    if (this.#conflator?.subs.has(subject) !== true) return;
    const st = statusState(to);
    if (st === null) return;
    this.#send({ t: 'status', s: subject, st, reason: 'STALENESS', ts: at });
  }

  #onHelloTimeout(): void {
    this.#helloTimer = null;
    if (!this.#open || this.#helloSeen) return;
    this.#send({ t: 'bye', code: WS_CLOSE.AUTH_REQUIRED, reason: 'AUTH_REQUIRED' });
    this.#open = false;
    this.#teardown();
    try {
      this.#socket.close(WS_CLOSE.AUTH_REQUIRED, 'AUTH_REQUIRED');
    } catch {
      this.#socket.terminate();
    }
    this.#deps.onClosed?.(this);
  }

  #clearHelloTimer(): void {
    if (this.#helloTimer === null) return;
    this.#deps.timers.clearTimeout(this.#helloTimer);
    this.#helloTimer = null;
  }

  #teardown(): void {
    this.#clearHelloTimer();
    if (this.#flushTimer !== null) {
      this.#deps.timers.clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#sweepTimer !== null) {
      this.#deps.timers.clearTimeout(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#unsubscribePlant?.();
    this.#unsubscribePlant = null;
    if (this.#conflator !== null) {
      for (const subject of this.#conflator.subs.keys()) this.#deps.hotset?.unsubscribe(subject);
      this.#conflator.subs.clear();
    }
    void this.flushUsage();
  }

  // -- rate limiting --------------------------------------------------------

  /**
   * The 20 msg/s limit of API.md §6.7, measured over a sliding second: `false` when this frame is
   * dropped, and the session is closed `4029 RATE_LIMITED` once the rate has been **continuously**
   * over the limit for `rateGraceMs`.
   *
   * The overage is a single instant (`#rateOverSinceMs`) that survives second boundaries and is
   * cleared only when the trailing second falls back to the limit — a tumbling window that reset
   * the overage on the first frame of each new second could never reach the 3 s grace at all.
   * Dropped frames still count as arrivals: they are traffic the client sent.
   */
  #rateOk(): boolean {
    const now = this.#clock.now();
    const limit = this.#limits.maxClientMsgsPerSec;
    this.#rateTimes.push(now);
    if (this.#rateTimes.length > limit + 1) this.#rateTimes.shift();
    const oldest = this.#rateTimes[0];
    const over =
      this.#rateTimes.length > limit && oldest !== undefined && now - oldest < 1_000;

    if (!over) {
      this.#rateOverSinceMs = null;
      this.#rateNotifiedMs = null;
      return true;
    }

    if (this.#rateOverSinceMs === null) this.#rateOverSinceMs = now;
    if (now - this.#rateOverSinceMs >= this.#limits.rateGraceMs) {
      this.close(WS_CLOSE.RATE_LIMITED, 'RATE_LIMITED');
      return false;
    }
    // Over the limit but inside the grace window: the frame is dropped, not answered, and the
    // client is told (at most once a second) so the overage is never silent.
    if (this.#rateNotifiedMs === null || now - this.#rateNotifiedMs >= 1_000) {
      this.#rateNotifiedMs = now;
      this.#send({
        t: 'err',
        code: 'RATE_LIMITED',
        message: `more than ${String(limit)} messages per second`,
        traceId: this.traceId,
        fatal: false,
      });
    }
    return false;
  }

  // -- backpressure bookkeeping --------------------------------------------

  /**
   * Plant overload (NFR-02, API.md §6.5 last row): the gateway decides the condition once for the
   * process and applies it to every session here. Raising the floor widens `effectiveMs` (the
   * conflator sends `notice { kind:'overload', action:'conflation-widened' }` and the rung is
   * recorded); the non-essential subjects are then shed, except any carrying `PX_LAST`,
   * `CHG_NET_1D` or `CHG_PCT_1D`, which are never taken away. `floorMs = 0` lifts the floor.
   */
  applyOverloadFloor(floorMs: number): void {
    const conflator = this.#conflator;
    if (!this.#open || conflator === null) return;
    conflator.setFloor(floorMs);
    if (floorMs <= 0) return;
    const victims = conflator.shedNonEssential('PLANT_DEGRADED', { protectCoreFields: true });
    if (victims.length === 0) return;
    for (const subject of victims) this.#deps.hotset?.unsubscribe(subject);
    this.#send({ t: 'notice', kind: 'overload', action: 'shed' });
    this.#recordBackpressure('shed', this.#socket.bufferedAmount, {
      cause: 'overload',
      subjects: victims.length,
    });
  }

  #onConflatorEvent(ev: ConflatorEvent): void {
    switch (ev.kind) {
      case 'conflation-widened':
        this.#recordBackpressure('conflation-widened', ev.bufferedBytes, {
          cause: ev.cause,
          conflationMs: ev.conflationMs,
        });
        return;
      case 'flush-skipped':
        this.#recordBackpressure('flush-skipped', ev.bufferedBytes, {
          dirtySubjects: ev.dirtySubjects,
          overMs: ev.overMs,
        });
        return;
      case 'shed':
        for (const subject of ev.subjects) this.#deps.hotset?.unsubscribe(subject);
        this.#recordBackpressure('shed', ev.bufferedBytes, {
          cause: ev.cause,
          subjects: ev.subjects.length,
        });
        return;
      case 'disconnect-soon':
        this.#recordBackpressure('disconnect-soon', ev.bufferedBytes, {});
        return;
      case 'close':
        this.#recordBackpressure('close', ev.bufferedBytes, { code: ev.code });
        return;
      case 'conflation-restored':
        this.#queueUsage('ws.slow', null, {
          rung: 'conflation-restored',
          conflationMs: ev.conflationMs,
        });
        return;
      case 'frame-oversize':
        this.#deps.log?.warn(
          { subject: ev.subject, bytes: ev.bytes },
          'ws: a single frame exceeds the batch cap',
        );
        return;
      case 'flushed':
        return;
    }
  }

  /** Every rung of the §6.5 ladder is a `dq_events` row *and* a `usage_events` row. */
  #recordBackpressure(rung: string, bufferedBytes: number, details: Record<string, unknown>): void {
    const principal = this.principal;
    this.#queueUsage('ws.slow', null, { rung, bufferedBytes, ...details });
    if (principal === null) return;
    void raiseWsBackpressure({
      subject: 'ws:session',
      sessionId: principal.sessionId,
      queued: this.#conflator?.dirtySize() ?? 0,
      droppedFrames: 0,
      severity: rung === 'close' ? 'error' : 'warn',
    }).catch((err: unknown) => {
      this.#deps.log?.warn({ err: String(err) }, 'ws: dq_events write failed');
    });
  }

  // -- usage events ---------------------------------------------------------

  #queueUsage(
    kind: UsageRow['kind'],
    instrumentId: number | null,
    details: Record<string, unknown>,
  ): void {
    const principal = this.principal;
    if (principal === null) return;
    if (this.#usage.length >= 2_000) {
      this.#usageDropped += 1;
      return;
    }
    this.#usage.push({
      ts: new Date(this.#clock.now()),
      userId: principal.userId,
      firmId: principal.firmId,
      sessionId: principal.sessionId,
      kind,
      instrumentId,
      traceId: this.traceId,
      details,
    });
  }

  /**
   * Write the queued `usage_events` rows. Never awaited on the send path, and a failure is logged
   * rather than propagated: a busy analytics table must not drop a market-data session.
   */
  flushUsage(): Promise<void> {
    const next = this.#usageChain.then(
      () => this.#flushUsageNow(),
      () => this.#flushUsageNow(),
    );
    this.#usageChain = next.catch(() => undefined);
    return next;
  }

  /** Resolves when every queued write this session started has finished (or failed). */
  settle(): Promise<void> {
    return this.#usageChain;
  }

  async #flushUsageNow(): Promise<void> {
    const db = this.#deps.db;
    if (db === undefined || this.#usage.length === 0) return;
    const batch = this.#usage.splice(0, this.#usage.length);
    const rows = batch.map((row) => ({
      ts: row.ts,
      userId: row.userId,
      firmId: row.firmId,
      sessionId: row.sessionId,
      kind: row.kind,
      instrumentId: row.instrumentId,
      traceId: row.traceId,
      details: row.details,
    }));
    try {
      await inTx(db, async (tx) => {
        await tx.insert(usageEvents).values(rows);
      });
    } catch (err) {
      this.#usageDropped += rows.length;
      this.#deps.log?.warn({ err: String(err) }, 'ws: usage_events write failed');
    }
  }
}

type RejectCode = 'SUBJECT_UNKNOWN' | 'NOT_ENTITLED' | 'QUOTA_EXCEEDED' | 'FIELD_UNKNOWN' | 'LIMIT';

/**
 * `subAck.accepted[].reason` — the decision's own word for why this is the tier the subscriber got.
 * A clean allow at the requested tier is `'OK'`; a source cap or a grant cap names itself, and is
 * repeated in every `snap` (API.md §6.3 step 2).
 */
function reasonOf(decision: EntitlementDecision, blank: boolean): ReasonCode {
  const downgrade = decision.downgrades[0]?.reason;
  if (downgrade !== undefined) return downgrade;
  for (const field of decision.fields) {
    if (field.reason !== 'OK') return field.reason;
  }
  return blank ? 'NO_FIRM_ENTITLEMENT' : 'OK';
}

/** Bind `fn` to the transaction in scope (savepoint) or open one on the injected handle. */
function inTx<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (currentTx() !== undefined) return withTx(null, fn);
  return db.transaction((tx) => runWithTx(tx, () => fn(tx)));
}
