/**
 * `ws/gateway.ts` — the WebSocket endpoint (API.md §6.3, §6.7; ARCHITECTURE §6.4, WORKPLAN WP-06).
 *
 * The gateway owns three things and delegates everything else to `ws/session.ts`:
 *
 *  1. **The upgrade.** A `ws.WebSocketServer({ noServer: true })` is attached to the Fastify HTTP
 *     server's `upgrade` event. Only {@link WS_PATH} is upgraded; any other path is answered with a
 *     404 and the socket destroyed, so a mistyped URL fails loudly instead of hanging a client on a
 *     socket that will never speak the protocol.
 *  2. **The principal.** The signed `tsid` cookie on the upgrade is a `web` session; a socket with
 *     no cookie waits for `hello.token` and becomes an `api` session. A second socket for the same
 *     `sessions.session_id` supersedes the first, which is closed `4003` with reason `'ws-replaced'`
 *     (API.md §6.3 step 1 — four panels share one socket, TERM-04).
 *  3. **The registry.** Live sessions, the single 1 s staleness sweep that feeds all of them
 *     (TERM-12 — the sweep runs once for the plant, not once per session), the server-initiated
 *     `resync` fan-out, and `bye 1001` to everyone on SIGTERM (ARCHITECTURE L1253).
 *
 * **Dependency resolution.** `app.ts` is frozen: it calls `registerWsGateway(app, { config, clock,
 * plant })`. Everything else is resolved here, in this order: an explicit member of
 * {@link WsGatewayDeps}, then the same member on `app.deps` (which gains only *optional* fields),
 * then a default. The defaults are the production wiring: `dbAuthenticator(app.deps.db, clock)`
 * for authentication and a **fail-closed** evaluator for entitlements — until WP-07 lands, a
 * process with no evaluator denies every field rather than serving data it cannot prove a licence
 * for (ENTL-01). That substitution is logged once, at registration, because a server that silently
 * blanked every quote would be a mystery rather than a policy.
 */

import { WebSocketServer, type WebSocket } from 'ws';

import type { Clock, ValueState } from '@terminal/core';
import type { ServerMsg } from '@terminal/sdk/wire/ws';
import { WS_CLOSE } from '@terminal/sdk/wire/ws';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { Config } from '../config.js';
import type { Db, Tx } from '../db/client.js';
import type { HotSet } from '../ingest/hotset.js';
import { raisePlantDegraded } from '../observability/dq.js';
import type { Plant } from '../plant/tickerPlant.js';

import { dbAuthenticator, type WsAuthenticator, type WsPrincipal } from './auth.js';
import type { BackpressureThresholds } from './conflator.js';
import {
  DEFAULT_WS_LIMITS,
  denyAllEntitlements,
  systemTimers,
  WsSession,
  type WsEntitlements,
  type WsLimits,
  type WsQuotas,
  type WsTimers,
} from './session.js';

export type { WsEntitlements, WsLimits, WsQuotas, WsTimers } from './session.js';
export type { WsAuthenticator, WsPrincipal } from './auth.js';

/** The gateway's mount path (API.md §6). */
export const WS_PATH = '/ws/v1';

/** The single supported protocol version (OPS-02, API.md §6). */
export const WS_PROTOCOL_VERSION = 1 as const;

/** The session cookie the browser presents on the upgrade (app.ts registers `@fastify/cookie`). */
export const SESSION_COOKIE = 'tsid';

/** Everything the gateway can be given; only the first three are passed by `app.ts`. */
export interface WsGatewayDeps {
  config: Config;
  clock: Clock;
  plant: Plant;
  db?: Db | Tx;
  auth?: WsAuthenticator;
  entitlements?: WsEntitlements;
  /** API-06. With none wired the concurrency ceiling is {@link WsLimits}'s (BUS-08). */
  quotas?: WsQuotas;
  hotset?: HotSet;
  thresholds?: Partial<BackpressureThresholds>;
  timers?: WsTimers;
  limits?: Partial<WsLimits>;
  /**
   * Event-loop lag in milliseconds, read once per sweep (NFR-02, API.md §6.5 last row). Above
   * {@link OVERLOAD_LAG_MS} the gateway floors every session's `effectiveMs` at
   * {@link OVERLOAD_FLOOR_MS}, sheds the non-essential subjects that do not carry a protected
   * field, and publishes `sys:status`. With no probe wired the process never declares overload —
   * a host that cannot measure its own lag must not guess at it.
   */
  lagProbe?: () => number;
}

/** Event-loop lag above which the plant is declared degraded (API.md §6.5, NFR-02). */
export const OVERLOAD_LAG_MS = 200;

/** The global conflation floor every session obeys while the plant is degraded. */
export const OVERLOAD_FLOOR_MS = 1_000;

/** The gateway members a host may inject through `app.deps.ws` (tests, and later composition). */
export type WsAppOptions = Partial<Omit<WsGatewayDeps, 'config' | 'clock' | 'plant'>>;

declare module '../app.js' {
  // Optional additions only: `buildApp`'s contract is "adding an optional field is not a change"
  // (app.ts L60-64). Nothing in app.ts moves.
  interface AppDeps {
    entitlements?: WsEntitlements;
    quotas?: WsQuotas;
    wsAuth?: WsAuthenticator;
    hotset?: HotSet;
    /** One bag for the rest of {@link WsGatewayDeps} — what a test injects. */
    ws?: WsAppOptions;
  }
}

export interface WsGateway {
  /** Live session count (`StatusResponse.ws.sessions`). */
  sessionCount(): number;
  /** Close every session with `bye 1001` and stop accepting upgrades. */
  close(): Promise<void>;
  /** Push a frame to every session of one user (alerts, `alerts:me`). */
  sendToUser(userId: number, msg: ServerMsg): number;
  /** Push a frame to every session subscribed to `room:<roomId>` (MSG-01). */
  sendToRoom(roomId: string, msg: ServerMsg): number;
  /**
   * Ask every session to re-`sub` (plant restart, entitlement reload; API.md §6.3 step 7). No
   * frame is sent for those subjects until the client does.
   */
  forceResync(subjects?: string[]): void;
  /**
   * A grant or licence changed (ENTL-05): re-evaluate every live subscription of `userId`, or of
   * every session when it is omitted. A subject that lost tier or gained a denial gets a
   * `downgrade` and a `resync`, and nothing flows for it until the client re-`sub`s.
   */
  revalidateEntitlements(userId?: number): void;
}

/** The `tsid` value from a raw `Cookie` header, or `undefined`. No JSON, no framework. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** `Authorization: Bearer <token>` on the upgrade, for an API client that can set headers. */
function readBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

export function registerWsGateway(app: FastifyInstance, deps: WsGatewayDeps): WsGateway {
  const injected: WsAppOptions = app.deps.ws ?? {};
  const clock = deps.clock;
  const plant = deps.plant;
  const db = deps.db ?? injected.db ?? app.deps.db;
  const auth =
    deps.auth ?? injected.auth ?? app.deps.wsAuth ?? dbAuthenticator(db, clock);
  const entitlementsDep = deps.entitlements ?? injected.entitlements ?? app.deps.entitlements;
  const entitlements = entitlementsDep ?? denyAllEntitlements;
  const wsQuotas = deps.quotas ?? injected.quotas ?? app.deps.quotas;
  const hotset = deps.hotset ?? injected.hotset ?? app.deps.hotset;
  const timers = deps.timers ?? injected.timers ?? systemTimers;
  const thresholds = deps.thresholds ?? injected.thresholds;
  const lagProbe = deps.lagProbe ?? injected.lagProbe;
  const limits: WsLimits = {
    ...DEFAULT_WS_LIMITS,
    conflationDefaultMs: deps.config.CONFLATION_MS_DEFAULT,
    ...injected.limits,
    ...deps.limits,
  };

  if (entitlementsDep === undefined) {
    app.log.warn(
      { path: WS_PATH },
      'ws gateway: no entitlement evaluator wired — every field is denied NO_FIRM_ENTITLEMENT ' +
        '(fail closed, ENTL-01; WP-07 wires the real evaluator)',
    );
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const sessions = new Set<WsSession>();
  /** Sessions that have gone away but may still owe an in-flight `usage_events` write. */
  const retiring = new Set<Promise<void>>();
  /** `sessions.session_id` → the newest socket for it (API.md §6.3 step 1). */
  const bySessionId = new Map<string, WsSession>();
  let sweepTimer: unknown = null;
  let closing = false;
  /** `true` while {@link WsGatewayDeps.lagProbe} reads above {@link OVERLOAD_LAG_MS}. */
  let degraded = false;

  function armSweep(): void {
    if (sweepTimer !== null || closing || sessions.size === 0) return;
    sweepTimer = timers.setTimeout(() => {
      sweepTimer = null;
      checkOverload();
      runSweep();
      armSweep();
    }, limits.sweepMs);
  }

  /**
   * NFR-02 / API.md §6.5 (last row). Event-loop lag over {@link OVERLOAD_LAG_MS} is a *global*
   * condition, so it is decided once per sweep and applied to every live session: the conflation
   * floor rises to {@link OVERLOAD_FLOOR_MS}, non-essential subjects that carry no protected field
   * are shed, and the change is published on `sys:status` as `PLANT_STATE` / `CONFLATION_FLOOR_MS`
   * — a wire message, never a silent slow-down. The transition is edge-triggered: each crossing is
   * announced once, and the floor is lifted the same way when the lag recovers.
   */
  function checkOverload(): void {
    if (lagProbe === undefined) return;
    let lagMs: number;
    try {
      lagMs = lagProbe();
    } catch (err) {
      app.log.warn({ err: String(err) }, 'ws gateway: lag probe failed');
      return;
    }
    const over = Number.isFinite(lagMs) && lagMs > OVERLOAD_LAG_MS;
    if (over === degraded) return;
    degraded = over;
    const floorMs = over ? OVERLOAD_FLOOR_MS : 0;
    for (const session of sessions) session.applyOverloadFloor(floorMs);
    const now = clock.now();
    try {
      plant.publish(
        'sys:status',
        { PLANT_STATE: over ? 'degraded' : 'ok', CONFLATION_FLOOR_MS: floorMs },
        { ts: { src: null, cap: now, pub: now } },
      );
    } catch (err) {
      app.log.warn({ err: String(err) }, 'ws gateway: sys:status publish failed');
    }
    if (!over) return;
    void raisePlantDegraded({
      subject: 'sys:status',
      reason: 'event_loop_lag',
      details: { lagMs, floorMs, sessions: sessions.size },
    }).catch((err: unknown) => {
      app.log.warn({ err: String(err) }, 'ws gateway: plant_degraded dq row failed');
    });
  }

  /** One sweep for the whole plant; every session hears only about the subjects it holds. */
  function runSweep(): void {
    let transitions: { subject: string; to: ValueState; at: number }[];
    try {
      transitions = plant.sweep(clock.now());
    } catch (err) {
      app.log.warn({ err: String(err) }, 'ws gateway: staleness sweep failed');
      return;
    }
    if (transitions.length === 0) return;
    for (const session of sessions) {
      for (const t of transitions) session.onStalenessTransition(t.subject, t.to, t.at);
    }
  }

  function onConnection(socket: WebSocket, principal: WsPrincipal | null): void {
    const session = new WsSession({
      socket,
      clock,
      plant,
      timers,
      limits,
      entitlements,
      principal,
      authenticate: (token: string) => auth.authenticate({ bearerToken: token }),
      ...(wsQuotas === undefined ? {} : { quotas: wsQuotas }),
      ...(thresholds === undefined ? {} : { thresholds }),
      ...(db === undefined ? {} : { db }),
      ...(hotset === undefined ? {} : { hotset }),
      onAuthenticated: (s: WsSession): void => {
        const id = s.principal?.sessionId;
        if (id === undefined) return;
        const previous = bySessionId.get(id);
        if (previous !== undefined && previous !== s) {
          previous.close(WS_CLOSE.SESSION_SUPERSEDED, 'ws-replaced');
        }
        bySessionId.set(id, s);
      },
      onClosed: (s: WsSession): void => {
        sessions.delete(s);
        const id = s.principal?.sessionId;
        if (id !== undefined && bySessionId.get(id) === s) bySessionId.delete(id);
        const settled = s.settle();
        retiring.add(settled);
        void settled.then(
          () => retiring.delete(settled),
          () => retiring.delete(settled),
        );
      },
      log: {
        warn: (o: unknown, m: string) => {
          app.log.warn(o as object, m);
        },
        error: (o: unknown, m: string) => {
          app.log.error(o as object, m);
        },
      },
    });
    sessions.add(session);
    armSweep();

    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        session.close(WS_CLOSE.PROTOCOL_ERROR, 'PROTOCOL_ERROR');
        return;
      }
      session.handleRaw(String(data));
    });
    socket.on('close', () => {
      session.onSocketClosed();
    });
    socket.on('error', () => {
      session.onSocketClosed();
    });
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path !== WS_PATH || closing) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const cookieHeader = req.headers.cookie;
    const raw = readCookie(cookieHeader, SESSION_COOKIE);
    const bearer = readBearer(req.headers.authorization);
    const unsigned = raw === undefined ? undefined : app.unsignCookie(raw);
    const cookieToken = unsigned?.valid === true ? (unsigned.value ?? undefined) : undefined;

    const input: { cookieToken?: string; bearerToken?: string } = {};
    if (cookieToken !== undefined) input.cookieToken = cookieToken;
    if (bearer !== undefined) input.bearerToken = bearer;

    const resolve: Promise<WsPrincipal | null> =
      cookieToken === undefined && bearer === undefined
        ? Promise.resolve(null)
        : auth.authenticate(input).catch((err: unknown) => {
            app.log.error({ err: String(err) }, 'ws gateway: upgrade authentication failed');
            return null;
          });

    void resolve.then((principal) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        onConnection(ws, principal);
      });
    });
  };

  app.server.on('upgrade', onUpgrade);

  return {
    sessionCount(): number {
      return sessions.size;
    },
    async close(): Promise<void> {
      closing = true;
      app.server.removeListener('upgrade', onUpgrade);
      if (sweepTimer !== null) {
        timers.clearTimeout(sweepTimer);
        sweepTimer = null;
      }
      const live = [...sessions];
      for (const session of live) session.close(WS_CLOSE.SERVER_SHUTDOWN, 'server shutdown');
      await Promise.all(live.map((session) => session.flushUsage()));
      await Promise.all(live.map((session) => session.settle()));
      // A socket that closed earlier may still owe a write; nothing may outlive `close()`.
      await Promise.all([...retiring]);
      retiring.clear();
      sessions.clear();
      bySessionId.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
    sendToUser(userId: number, msg: ServerMsg): number {
      let sent = 0;
      for (const session of sessions) {
        if (session.principal?.userId !== userId) continue;
        session.push(msg);
        sent += 1;
      }
      return sent;
    },
    sendToRoom(roomId: string, msg: ServerMsg): number {
      const subject = `room:${roomId}`;
      let sent = 0;
      for (const session of sessions) {
        if (!session.holds(subject)) continue;
        session.push(msg);
        sent += 1;
      }
      return sent;
    },
    forceResync(subjects?: string[]): void {
      for (const session of sessions) session.resyncFromServer(subjects);
    },
    revalidateEntitlements(userId?: number): void {
      for (const session of sessions) {
        if (userId !== undefined && session.principal?.userId !== userId) continue;
        void session.revalidate().catch((err: unknown) => {
          app.log.error({ err: String(err) }, 'ws gateway: entitlement revalidation failed');
        });
      }
    },
  };
}
