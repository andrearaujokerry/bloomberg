/**
 * `http/routes/data.ts` — API.md §5.4 L539-546 (API-02, DATA-07, ANAL-02), WORKPLAN WP-08.
 *
 * `POST /data` is **the** data endpoint. The five convenience GETs below build the same
 * `DataRequest` object and hand it to the same `DataDispatcher`: a caller who prefers a URL to a
 * body gets identical resolution, identical entitlement gating, identical provenance and an
 * identical envelope. That is API-02's "one request model" — two request shapes would become two
 * sets of rules within a release.
 *
 * **The evaluator is passed in, and that is the load-bearing line in this file.**
 * `data/request.ts#gateFields` denies every field when no entitlement port is wired (WP-07 made it
 * fail closed, like `ws/gateway.ts`'s `denyAllEntitlements`). So a forgotten dependency here
 * produces a `403 ENTITLEMENT_DENIED` on every request — loud, immediate and safe — rather than an
 * open data tap. `allowAllEntitlements` exists for tests that are about shaping rather than about
 * who may read what, and it is never reachable from a route.
 *
 * **Per-field denials are a 200, whole-request denials are a 403** (API.md §2 L196, §12.3). The
 * dispatcher owns that distinction: it blanks a denied cell with `r[field] = <reason>` and only
 * raises when *nothing* requested is servable. This module adds no second opinion.
 *
 * Every handler runs inside `withTx`, so `app.user_id` / `app.firm_id` / `app.role` are set and RLS
 * applies (DATA_MODEL §15.1); the readers, the resolver and the provenance collector are all built
 * from that one transaction and one `asOf` pair.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { Clock, EntitlementDecision, EntitlementRequest, UsageType } from '@terminal/core';
import type { DataRequestInput, DataResponse } from '@terminal/sdk/wire/dataRequest';
import {
  HistoryQuery,
  IntradayQuery,
  ReferenceQuery,
  SnapshotQuery,
  TicksQuery,
} from '@terminal/sdk/wire/rest/data';

import {
  buildDataSources,
  createDispatcher,
  dataDeps,
  ProvenanceIndex,
  type DataDispatcher,
  type EntitlementPort,
  type QuotaPort,
} from '../../data/request.js';
import type { AsOf } from '../../db/bitemporal.js';
import { withTx, type Tx } from '../../db/client.js';
import type { Evaluator } from '../../entitlements/evaluator.js';
import { quotaExceededError, type Quotas } from '../../entitlements/quotas.js';
import { AppError } from '../errors.js';
import { requireSession, type Principal } from '../auth/session.js';
import {
  HEAVY_DATA_LIMIT,
  LONG_HISTORY_MS,
  rateLimit,
  rateLimitWhen,
  REST_LIMIT,
} from '../rateLimit.js';
import { ctxOf, hostDepsOf, parse, principalOf, type FunctionHostDeps } from './functions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `'api'` for a bearer session, `'display'` for a cookie one; `'export'` is forced by §9. */
export function usageFor(principal: Principal): UsageType {
  return principal.clientKind === 'api' ? 'api' : 'display';
}

/**
 * API-06 over WP-07's `Quotas` (API.md §8).
 *
 * `reserve` runs before any fetch on the request's *upper bound* (rule 7) and throws the
 * documented `429 QUOTA_EXCEEDED`; `settle` records what was really served and answers how many of
 * the touched instruments were newly counted today. That second number is read rather than
 * guessed: `record()` is an upsert and cannot report how many rows it actually inserted, so the
 * daily counter is read on both sides of it. A `Set.size` here would report every instrument in
 * the request as "new" and quietly inflate `meta.quota` for every repeat read of the same ticker.
 */
export function quotaPort(
  quotas: Quotas,
  principal: Principal,
  /** How many data points the evaluator already charged for this request — see below. */
  alreadyCharged: () => number = () => 0,
): QuotaPort {
  const who = {
    userId: principal.userId,
    firmId: principal.firmId,
    clientKind: principal.clientKind,
  };
  return {
    async reserve(charge): Promise<void> {
      const check = await quotas.check({
        ...who,
        instrumentIds: charge.instrumentIds,
        dataPoints: charge.dataPoints,
      });
      if (!check.ok) throw quotaExceededError(check);
    },
    async settle(charge): Promise<number> {
      const before = await quotas.state(principal.userId, principal.firmId, principal.clientKind);
      // Charge only what nobody has charged yet. `meta.quota.dataPointsCharged` — the cell count
      // the dispatcher computed — stays the number the counter moves by, which is the only way
      // `GET /usage/quota` and the payload a client just received can be reconciled.
      const dataPoints = Math.max(0, charge.dataPoints - alreadyCharged());
      await quotas.record({
        userId: principal.userId,
        firmId: principal.firmId,
        // Instruments are insert-if-absent per `(user, day, instrument)` and therefore
        // idempotent: recording the full list twice cannot double-count a day.
        instrumentIds: charge.instrumentIds,
        dataPoints,
      });
      const after = await quotas.state(principal.userId, principal.firmId, principal.clientKind);
      return Math.max(0, after.dailyUniqueInstruments.used - before.dailyUniqueInstruments.used);
    },
  };
}

/**
 * The evaluator, wrapped so the route can see what evaluator **rule 8** already charged.
 *
 * WP-07's `evaluator()` charges the monthly datapoint counter itself for every `usage:'api'`
 * request it decides — `served.length`, the fields it did not deny — because the function runner
 * and the WebSocket gateway have no dispatcher to do it for them. `data/request.ts` *also* charges,
 * through {@link quotaPort}, with the accurate `securities × fields` cell count of API.md §8. Both
 * are right about their own path and together they charged a bearer `POST /data` of one security
 * and one field **twice**, while that same response's `meta.quota.dataPointsCharged` said one: a
 * client could not reconcile `GET /usage/quota` with the payloads it had received, and an API key
 * tripped `429 QUOTA_EXCEEDED` at half of the documented 2 000 000.
 *
 * So the dispatcher keeps the counter — its count is the documented one — and subtracts what rule
 * 8 already took. The subtraction is observed, not assumed: it counts the non-denied fields of the
 * decisions this very request produced, so it cannot drift if rule 8's arithmetic changes. Rule 8
 * is skipped entirely unless the usage is `'api'`, which is why a cookie session subtracts nothing.
 */
export function meteredEvaluator(
  evaluator: Evaluator,
  usage: UsageType,
): { port: EntitlementPort; charged(): number } {
  if (usage !== 'api') return { port: evaluator, charged: () => 0 };
  let charged = 0;
  return {
    port: {
      async evaluate(req: EntitlementRequest): Promise<EntitlementDecision> {
        const decision = await evaluator.evaluate(req);
        charged += decision.fields.filter((f) => f.decision !== 'deny').length;
        return decision;
      },
    },
    charged: () => charged,
  };
}

export interface DispatcherOptions {
  tx: Tx;
  clock: Clock;
  traceId: string;
  principal: Principal;
  entitlements: Evaluator;
  quotas?: Quotas | undefined;
  /** `'export'` for the §9 routes; otherwise derived from the session. */
  usage?: UsageType;
  at: AsOf;
}

/** One dispatcher for one request: one transaction, one `asOf`, one provenance collector. */
export function dispatcherFor(options: DispatcherOptions): DataDispatcher {
  const prov = new ProvenanceIndex();
  const deps = dataDeps(options.tx, options.at, prov);
  const usage = options.usage ?? usageFor(options.principal);
  const metered = meteredEvaluator(options.entitlements, usage);
  return createDispatcher({
    tx: options.tx,
    clock: options.clock,
    traceId: options.traceId,
    prov,
    sources: buildDataSources(deps),
    caller: {
      userId: options.principal.userId,
      firmId: options.principal.firmId,
      sessionId: options.principal.sessionId,
      usage,
    },
    // The REAL evaluator. Omitting it denies every field (`gateFields`, WP-07).
    entitlement: metered.port,
    ...(options.quotas === undefined
      ? {}
      : {
          quota: quotaPort(options.quotas, options.principal, () => metered.charged()),
        }),
  });
}

/**
 * `asOf` for a request, before the dispatcher computes its own.
 *
 * The readers are bound to an `asOf` at construction, so the route has to know it first. It is the
 * same rule the dispatcher applies (`data/request.ts#effectiveAsOf`): a supplied instant wins,
 * otherwise `clock.now()` on both axes.
 */
export function asOfOfRequest(
  asOf: { validAt?: string | undefined; knownAt?: string | undefined } | undefined,
  clock: Clock,
): AsOf {
  const now = new Date(clock.now());
  return {
    validAt: asOf?.validAt === undefined ? now : new Date(asOf.validAt),
    knownAt: asOf?.knownAt === undefined ? now : new Date(asOf.knownAt),
  };
}

/** The one path every route in this file takes: open a transaction, dispatch, return. */
export function dispatchRequest(
  request: FastifyRequest,
  input: DataRequestInput,
  options: { usage?: UsageType } = {},
): Promise<DataResponse> {
  const principal = principalOf(request);
  const deps = hostDepsOf(request);
  const entitlements = deps.entitlements;
  if (entitlements === undefined) {
    // Fail closed and say so, rather than serving a request nobody authorised.
    throw new AppError('ENTITLEMENT_DENIED', 'No entitlement evaluator is wired.', {
      details: { reasons: [] },
    });
  }
  const at = asOfOfRequest(asOfOf(input), deps.clock);

  return withTx(ctxOf(principal), async (tx) =>
    dispatcherFor({
      tx,
      clock: deps.clock,
      traceId: request.traceId,
      principal,
      entitlements,
      quotas: quotasOf(deps),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      at,
    }).dispatch(input),
  );
}

/** `input.asOf` without asserting the union — every `DataRequest` member carries the same key. */
function asOfOf(
  input: DataRequestInput,
): { validAt?: string | undefined; knownAt?: string | undefined } | undefined {
  const asOf = (input as { asOf?: { validAt?: string; knownAt?: string } }).asOf;
  return asOf;
}

export function quotasOf(deps: FunctionHostDeps): Quotas | undefined {
  return deps.functions?.quotas ?? deps.quotas;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// API.md §8 — the quota headers on every data-bearing response
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `x-quota-daily-instruments`, `x-quota-monthly-datapoints`, `x-quota-concurrent-subs`. */
export const QUOTA_HEADERS = {
  daily: 'x-quota-daily-instruments',
  monthly: 'x-quota-monthly-datapoints',
  subs: 'x-quota-concurrent-subs',
} as const;

/**
 * The `onSend` hook API.md §8 L1160-1162 asks for: `<used>/<limit>` on every data-bearing
 * response, so the terminal's status bar can show a user they are approaching a ceiling *before*
 * the request that exceeds it fails.
 *
 * The numbers come from `Quotas.state` — the same call `GET /usage/quota` and `SessionInfo.quotas`
 * answer from — so the header, `meta.quota` and the usage route cannot disagree about the same
 * counters. Registered inside a route plugin, a Fastify hook is encapsulated to that plugin's own
 * routes, which is why `data.ts` and `export.ts` each register it rather than `app.ts` adding a
 * global hook over routes that serve no data.
 *
 * Only successful responses are stamped: an error carries no data, and §8's promise is about what
 * a served payload cost.
 */
export function quotaHeaderHook(): (
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
) => Promise<unknown> {
  return async (request, reply, payload) => {
    if (reply.statusCode >= 400) return payload;
    const principal = request.principal;
    if (principal === undefined) return payload;
    const quotas = quotasOf(hostDepsOf(request));
    if (quotas === undefined) return payload;

    try {
      const state = await quotas.state(principal.userId, principal.firmId, principal.clientKind);
      const pair = (used: number, limit: number): string => `${String(used)}/${String(limit)}`;
      void reply.header(
        QUOTA_HEADERS.daily,
        pair(state.dailyUniqueInstruments.used, state.dailyUniqueInstruments.limit),
      );
      void reply.header(
        QUOTA_HEADERS.monthly,
        pair(state.monthlyDataPoints.used, state.monthlyDataPoints.limit),
      );
      void reply.header(
        QUOTA_HEADERS.subs,
        pair(state.concurrentSubscriptions.used, state.concurrentSubscriptions.limit),
      );
    } catch {
      // A counter that cannot be read is not a reason to withhold data the caller is entitled to.
      // The header is advisory; the enforcement happened before the fetch.
    }
    return payload;
  };
}

/**
 * API.md §8: "`/data` with `kind:'tick'` or `historical` over 10 years — 5 req/s".
 *
 * Reads the body of `POST /data` and the query of the convenience GETs, because one route serves
 * six kinds and only two of them are the expensive ones.
 */
export function isHeavyRead(request: FastifyRequest): boolean {
  const url = request.url.split('?')[0] ?? '';
  if (url.endsWith('/data/ticks')) return true;
  if (url.endsWith('/data/history')) {
    const q = request.query as { start?: unknown; end?: unknown } | undefined;
    return isLongSpan(q?.start, q?.end, request.server.deps.clock);
  }
  if (!url.endsWith('/data')) return false;

  const body = request.body as
    | { kind?: unknown; start?: unknown; end?: unknown }
    | undefined;
  if (body === undefined || body === null) return false;
  if (body.kind === 'tick') return true;
  if (body.kind !== 'historical') return false;
  return isLongSpan(body.start, body.end, request.server.deps.clock);
}

/** True when `[start, end]` spans ten years or more; `end` defaults to now (API.md §5.4). */
function isLongSpan(start: unknown, end: unknown, clock: Clock): boolean {
  if (typeof start !== 'string') return false;
  const from = Date.parse(start);
  if (Number.isNaN(from)) return false;
  const to = typeof end === 'string' ? Date.parse(end) : clock.now();
  if (Number.isNaN(to)) return false;
  return to - from >= LONG_HISTORY_MS;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every read on this surface needs the `data:read` scope (API-01 key scopes), one REST token
 * (20 req/s, burst 60) and, when the request is a tick read or a historical span of ten years or
 * more, one heavy-read token as well (5 req/s) — API.md §8 L1165-1172.
 */
const readGuard = {
  preHandler: [
    requireSession({ scopes: ['data:read'] }),
    rateLimit(REST_LIMIT),
    rateLimitWhen(HEAVY_DATA_LIMIT, isHeavyRead),
  ],
};

export const dataRoutes: FastifyPluginAsync = async (app) => {
  // §8: the three quota headers on every data-bearing response this plugin serves.
  app.addHook('onSend', quotaHeaderHook());

  // ── POST /data — the one request model (API-02) ─────────────────────────────────────────────
  app.post('/data', readGuard, async (request) =>
    // The body is NOT parsed here: `DataDispatcher.dispatch` parses it with the normative
    // `DataRequest` schema and raises the documented `400 VALIDATION_FAILED` with
    // `details.location='body'`. A second parse would be a second definition of the request.
    dispatchRequest(request, request.body as DataRequestInput),
  );

  // ── GET /data/reference ─────────────────────────────────────────────────────────────────────
  app.get('/data/reference', readGuard, async (request) => {
    const q = parse(ReferenceQuery, request.query ?? {}, 'query');
    return dispatchRequest(request, {
      kind: 'reference',
      securities: q.securities.map((ref) => ({ ref })),
      fields: q.fields,
      ...asOfIn(q),
    });
  });

  // ── GET /data/history ───────────────────────────────────────────────────────────────────────
  app.get('/data/history', readGuard, async (request) => {
    const q = parse(HistoryQuery, request.query ?? {}, 'query');
    return dispatchRequest(request, {
      kind: 'historical',
      securities: [{ ref: q.security }],
      ...(q.fields === undefined ? {} : { fields: q.fields }),
      start: q.start,
      ...(q.end === undefined ? {} : { end: q.end }),
      ...(q.periodicity === undefined ? {} : { periodicity: q.periodicity }),
      ...(q.adjust === undefined ? {} : { adjust: q.adjust }),
      ...(q.currency === undefined ? {} : { currency: q.currency }),
      ...(q.fill === undefined ? {} : { fill: q.fill }),
      ...asOfIn(q),
    });
  });

  // ── GET /data/intraday ──────────────────────────────────────────────────────────────────────
  app.get('/data/intraday', readGuard, async (request) => {
    const q = parse(IntradayQuery, request.query ?? {}, 'query');
    return dispatchRequest(request, {
      kind: 'intraday',
      securities: [{ ref: q.security }],
      ...(q.fields === undefined ? {} : { fields: q.fields }),
      start: q.start,
      ...(q.end === undefined ? {} : { end: q.end }),
      ...(q.interval === undefined ? {} : { interval: q.interval }),
      ...(q.session === undefined ? {} : { session: q.session }),
    });
  });

  // ── GET /data/ticks ─────────────────────────────────────────────────────────────────────────
  app.get('/data/ticks', readGuard, async (request) => {
    const q = parse(TicksQuery, request.query ?? {}, 'query');
    return dispatchRequest(request, {
      kind: 'tick',
      securities: [{ ref: q.security }],
      start: q.start,
      end: q.end,
      ...(q.kinds === undefined ? {} : { kinds: q.kinds }),
      ...(q.limit === undefined ? {} : { limit: q.limit }),
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
    });
  });

  // ── GET /data/snapshot ──────────────────────────────────────────────────────────────────────
  app.get('/data/snapshot', readGuard, async (request) => {
    const q = parse(SnapshotQuery, request.query ?? {}, 'query');
    return dispatchRequest(request, {
      kind: 'realtime',
      securities: q.securities.map((ref) => ({ ref })),
      fields: q.fields,
      ...(q.tier === undefined ? {} : { tier: q.tier }),
    });
  });

  await Promise.resolve();
};

/** `validAt`/`knownAt` of a convenience GET, only when the caller sent one. */
function asOfIn(q: { validAt?: string | undefined; knownAt?: string | undefined }): {
  asOf?: { validAt?: string; knownAt?: string };
} {
  if (q.validAt === undefined && q.knownAt === undefined) return {};
  return {
    asOf: {
      ...(q.validAt === undefined ? {} : { validAt: q.validAt }),
      ...(q.knownAt === undefined ? {} : { knownAt: q.knownAt }),
    },
  };
}
