/**
 * `http/routes/status.ts` — `GET /api/v1/status` (API.md §5.15 L822, `StatusResponse` L825-836),
 * OPS-03 / OPS-04. WP-08.
 *
 * The operator's one screen: who this process is, what the plant is doing, how the providers are
 * behaving, which markets are open, whether the scheduler is running, and what is broken.
 *
 * **Every number here is read from something that measured it.** The rule this file follows,
 * because a status page that guesses is worse than no status page: a subsystem that cannot report
 * a figure reports the figure it has, and where the wire schema demands a number that nothing in
 * this process measures yet, the field is `0` **and named here**, in this header, so that nobody
 * reads it as a healthy measurement:
 *
 *  - `plant.applyP99Ms` — `PlantStats` keeps one latency, `pub − cap` (tickerPlant.ts L24), which
 *    is reported as `publishP99Ms`. The apply half is not timed separately. **Not measured: 0.**
 *  - `ws.slowSessions` — `WsGateway` exposes `sessionCount()` and nothing else; the per-session
 *    backpressure verdict lives inside `ws/session.ts`. **Not measured: 0.**
 *  - `timings.autocompleteP95Ms`, `timings.historyP95Ms` — no client or server timer writes either
 *    one anywhere. **Not measured: 0.** (`fnLaunchP95Ms` IS measured: it is `percentile_cont(0.95)`
 *    over `usage_events.duration_ms` for `kind='fn.launch'` in the last hour, per code.)
 *  - `providers[].p95Ms` — the wire allows `null` there, and `null` is what an unmeasured provider
 *    latency gets. Nothing is rounded up to a plausible millisecond count.
 *
 * `ws.subscriptions` is real when a hot set is wired: every WS `sub` holds a subject in it and
 * every `unsub` releases it (`ws/session.ts` L892, L958), so the sum of `HotSetEntry.subscribers`
 * is the live subscription count. With no hot set on `deps` it is 0, which then means "nothing is
 * tracking subscriptions", not "nobody is subscribed".
 *
 * **Role.** API.md gives this row "any (*public* summary when `PUBLIC_STATUS=1`)". `Config` has no
 * `PUBLIC_STATUS` key and `config.ts` is not this package's file, so the public summary is not
 * offered and the route requires a session — the fail-closed half of the documented behaviour.
 */

import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  FIELD_DICTIONARY_VERSION,
  localClock,
  registry as functionRegistry,
  sessionCalendar,
  sessionState,
  type Clock,
  type SessionCalendar,
  type SessionState,
} from '@terminal/core';
import { FX_USD } from '@terminal/core/calendars/fx';
import { XNYS } from '@terminal/core/calendars/nyse';
import { SIFMA } from '@terminal/core/calendars/sifma';
import type { StatusResponse } from '@terminal/sdk/wire/rest/status';

import type { ServerState } from '../../app.js';
import type { Config } from '../../config.js';
import { withTx, type Db, type RequestCtx, type Tx } from '../../db/client.js';
import type { HotSet } from '../../ingest/hotset.js';
import type { Plant } from '../../plant/tickerPlant.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { HttpClient } from '../../providers/types.js';
import { OVERLOAD_FLOOR_MS, WS_PROTOCOL_VERSION } from '../../ws/gateway.js';
import { requireSession, type Principal } from '../auth/session.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { AuthRequiredError } from '../errors.js';
import { MIN_CLIENT_VERSION, SERVER_VERSION } from './auth.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Injected state this route reads (optional additions to `AppDeps`, per app.ts L60-64)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What `/status` needs from a running scheduler. Structural on purpose: `ingest/scheduler.ts`'s
 * `Scheduler` satisfies it as it is, and nothing here can start, stop or perturb a job.
 */
export interface SchedulerStatusSource {
  readonly isLeader: boolean;
  readonly jobs: readonly { readonly id: string }[];
  state(jobId: string): { readonly running: boolean; readonly nextEligibleAt: number } | undefined;
  /**
   * Not read here. It is part of this type because `http/routes/admin.ts` already requires
   * `AppDeps.scheduler` to carry `runNow` (`POST /admin/ingest/runs/:jobId`), and one field cannot
   * have two types: the declaration merged into `AppDeps` must satisfy both readers.
   */
  runNow(jobId: string): Promise<string | null>;
}

declare module '../../app.js' {
  // Optional additions only (app.ts L60-64). `providers` and `http` carry the same names and
  // types the WP-08 shared contract gives `BuildContextDeps`, so the declarations merge.
  interface AppDeps {
    providers?: ProviderRegistry;
    http?: HttpClient;
    scheduler?: SchedulerStatusSource;
  }
}

interface StatusDeps {
  config: Config;
  clock: Clock;
  db: Db | Tx;
  plant: Plant;
  state: ServerState;
  hotset?: HotSet;
  providers?: ProviderRegistry;
  http?: HttpClient;
  scheduler?: SchedulerStatusSource;
}

function depsOf(request: FastifyRequest): StatusDeps {
  return request.server.deps;
}

function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) throw new AuthRequiredError();
  return principal;
}

function ctxOf(principal: Principal): RequestCtx {
  return {
    userId: principal.userId,
    firmId: principal.firmId,
    role: principal.role,
    sessionId: principal.sessionId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Market sessions (API.md: 'NYSE', 'SIFMA', 'FX')
// ─────────────────────────────────────────────────────────────────────────────────────────────

const NYSE_SESSION: SessionCalendar = sessionCalendar(XNYS);
const SIFMA_SESSION: SessionCalendar = sessionCalendar(SIFMA);

/**
 * FX has no exchange calendar: `open` on a USD settlement business day, `closed` at the weekend.
 * The same answer `plant/tickerPlant.ts#constantSession` gives an `fx` subject — a 24×5 market
 * has no opening auction to report and this does not invent one.
 */
function fxState(nowMs: number): SessionState {
  const local = localClock('UTC', nowMs);
  if (local === undefined) return 'unknown';
  return FX_USD.isBusinessDay(local.date) ? 'open' : 'closed';
}

/** Minutes are the finest granularity any of these calendars changes on. */
const MINUTE_MS = 60_000;

/** A week plus a day: longer than any holiday run these calendars contain. */
const NEXT_CHANGE_HORIZON_MS = 8 * 24 * 60 * 60 * 1_000;

/**
 * The next instant `stateAt` reports something different, or `null` when it reports the same
 * thing for the whole horizon. Walked minute by minute from the next minute boundary: a session
 * boundary is always on one, and the alternative — re-deriving each calendar's own transition
 * table here — would be a second opinion about when NYSE opens.
 */
function nextChangeAt(stateAt: (ms: number) => SessionState, nowMs: number): string | null {
  const current = stateAt(nowMs);
  const start = Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS;
  for (let t = start; t <= nowMs + NEXT_CHANGE_HORIZON_MS; t += MINUTE_MS) {
    if (stateAt(t) !== current) return new Date(t).toISOString();
  }
  return null;
}

function marketSessions(nowMs: number): StatusResponse['sessions'] {
  const nyse = (ms: number): SessionState => sessionState(NYSE_SESSION, ms, true);
  const sifma = (ms: number): SessionState => sessionState(SIFMA_SESSION, ms, false);
  return [
    { calendarId: 'NYSE', state: nyse(nowMs), nextChangeAt: nextChangeAt(nyse, nowMs) },
    { calendarId: 'SIFMA', state: sifma(nowMs), nextChangeAt: nextChangeAt(sifma, nowMs) },
    { calendarId: 'FX', state: fxState(nowMs), nextChangeAt: nextChangeAt(fxState, nowMs) },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Database-backed sections
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `to_char` mask rendering a timestamptz as the `z.iso.datetime()` the wire expects. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** How far back `timings.fnLaunchP95Ms` looks. A status page reports now, not last quarter. */
const TIMINGS_WINDOW_MS = 60 * 60 * 1_000;

/** How many failed runs `scheduler.lastFailures` carries. */
const LAST_FAILURES_LIMIT = 10;

interface DqSqlRow {
  kind: string;
  n: string;
}

interface IncidentSqlRow {
  incident_id: string;
  component: string;
  severity: 'info' | 'degraded' | 'outage';
  title: string;
  opened_at: string;
  updates: unknown;
}

interface FailureSqlRow {
  job_id: string;
  at: string;
  errors: unknown;
}

interface ProviderTimeSqlRow {
  source_id: string;
  last_ok_at: string | null;
  last_error_at: string | null;
}

interface LaunchP95SqlRow {
  code: string;
  p95: number | string | null;
}

/** `ingest_runs.errors` is `JobError[]`; a failed run with an empty array reports no code. */
function firstErrorCode(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return 'UNSPECIFIED';
  const first: unknown = errors[0];
  if (typeof first === 'object' && first !== null && 'code' in first) {
    const { code } = first;
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'UNSPECIFIED';
}

function incidentUpdates(value: unknown): StatusResponse['incidents'][number]['updates'] {
  if (!Array.isArray(value)) return [];
  const out: { ts: string; text: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { ts, text } = entry as { ts?: unknown; text?: unknown };
    if (typeof ts === 'string' && typeof text === 'string') out.push({ ts, text });
  }
  return out;
}

interface DbSections {
  dq: StatusResponse['dq'];
  incidents: StatusResponse['incidents'];
  lastFailures: StatusResponse['scheduler']['lastFailures'];
  providerTimes: Map<string, { lastOkAt: string | null; lastErrorAt: string | null }>;
  fnLaunchP95Ms: Record<string, number>;
}

/**
 * The five sections that come out of Postgres. One transaction, so an operator refreshing the
 * page during an incident does not open five.
 */
async function readDb(tx: Tx, nowMs: number): Promise<DbSections> {
  const since = new Date(nowMs - TIMINGS_WINDOW_MS).toISOString();

  const dqResult = await tx.execute(sql`
    SELECT kind, count(*)::text AS n
      FROM dq_events
     WHERE resolved_at IS NULL
     GROUP BY kind
     ORDER BY kind`);
  const byKind: Record<string, number> = {};
  let open = 0;
  for (const row of dqResult.rows as unknown as DqSqlRow[]) {
    const n = Number(row.n);
    byKind[row.kind] = n;
    open += n;
  }

  const incidentResult = await tx.execute(sql`
    SELECT incident_id::text AS incident_id, component, severity, title,
           to_char(opened_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS opened_at, updates
      FROM status_incidents
     WHERE closed_at IS NULL
     ORDER BY opened_at DESC, incident_id DESC`);

  const failureResult = await tx.execute(sql`
    SELECT job_id,
           to_char(coalesce(finished_at, started_at) AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS at,
           errors
      FROM ingest_runs
     WHERE status = 'failed'
     ORDER BY coalesce(finished_at, started_at) DESC, run_id DESC
     LIMIT ${LAST_FAILURES_LIMIT}`);

  // `lastOkAt` is the newest recorded exchange for the source: `provenance` holds one row per
  // successful fetch and nothing else (a 304 and a failure write none), so its `max(captured_at)`
  // is exactly "the last time this provider answered". `lastErrorAt` is the newest failed
  // scheduler run for the same source — the only place a provider failure is currently durable.
  const providerTimeResult = await tx.execute(sql`
    SELECT s.source_id,
           CASE WHEN p.captured_at IS NULL THEN NULL
                ELSE to_char(p.captured_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS last_ok_at,
           CASE WHEN r.at IS NULL THEN NULL
                ELSE to_char(r.at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS last_error_at
      FROM (SELECT source_id FROM provenance
             UNION
            SELECT source_id FROM ingest_runs WHERE source_id IS NOT NULL) s
      LEFT JOIN LATERAL (SELECT max(captured_at) AS captured_at
                           FROM provenance pp WHERE pp.source_id = s.source_id) p ON true
      LEFT JOIN LATERAL (SELECT max(coalesce(finished_at, started_at)) AS at
                           FROM ingest_runs rr
                          WHERE rr.source_id = s.source_id AND rr.status = 'failed') r ON true`);

  const launchResult = await tx.execute(sql`
    SELECT code,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95
      FROM usage_events
     WHERE kind = 'fn.launch'
       AND code IS NOT NULL
       AND duration_ms IS NOT NULL
       AND ts >= ${since}::timestamptz
     GROUP BY code
     ORDER BY code`);

  const providerTimes = new Map<string, { lastOkAt: string | null; lastErrorAt: string | null }>();
  for (const row of providerTimeResult.rows as unknown as ProviderTimeSqlRow[]) {
    providerTimes.set(row.source_id, {
      lastOkAt: row.last_ok_at,
      lastErrorAt: row.last_error_at,
    });
  }

  const fnLaunchP95Ms: Record<string, number> = {};
  for (const row of launchResult.rows as unknown as LaunchP95SqlRow[]) {
    if (row.p95 === null) continue;
    fnLaunchP95Ms[row.code] = Number(row.p95);
  }

  return {
    dq: { open, byKind },
    incidents: (incidentResult.rows as unknown as IncidentSqlRow[]).map((row) => ({
      incidentId: Number(row.incident_id),
      component: row.component,
      severity: row.severity,
      title: row.title,
      openedAt: row.opened_at,
      updates: incidentUpdates(row.updates),
    })),
    lastFailures: (failureResult.rows as unknown as FailureSqlRow[]).map((row) => ({
      jobId: row.job_id,
      at: row.at,
      code: firstErrorCode(row.errors),
    })),
    providerTimes,
    fnLaunchP95Ms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// In-process sections
// ─────────────────────────────────────────────────────────────────────────────────────────────

function providerSection(
  deps: StatusDeps,
  times: DbSections['providerTimes'],
): StatusResponse['providers'] {
  const { providers, http } = deps;
  if (providers === undefined) return [];
  return providers.all().map((adapter) => {
    const breaker = http?.breaker(adapter.id);
    const bucket = http?.tokens(adapter.id);
    const seen = times.get(adapter.sourceId);
    return {
      sourceId: adapter.sourceId,
      circuit: breaker?.state ?? 'closed',
      lastOkAt: seen?.lastOkAt ?? null,
      lastErrorAt: seen?.lastErrorAt ?? null,
      // Nothing times a provider call durably yet; the wire allows null and null is the truth.
      p95Ms: null,
      bucketRemaining: bucket?.available ?? 0,
    };
  });
}

function schedulerSection(
  deps: StatusDeps,
  nowMs: number,
  lastFailures: StatusResponse['scheduler']['lastFailures'],
): StatusResponse['scheduler'] {
  const scheduler = deps.scheduler;
  if (scheduler === undefined) {
    // No scheduler object on `deps`: the startup flag is all this process knows about itself.
    return { leader: deps.state.scheduler, lagMs: 0, running: [], lastFailures };
  }
  const running: string[] = [];
  let lagMs = 0;
  for (const job of scheduler.jobs) {
    const state = scheduler.state(job.id);
    if (state === undefined) continue;
    if (state.running) {
      running.push(job.id);
      continue;
    }
    // Lag is how long the most overdue job has been waiting past the instant it became eligible
    // to run again. A job that is not yet due contributes nothing.
    lagMs = Math.max(lagMs, nowMs - state.nextEligibleAt);
  }
  return { leader: scheduler.isLeader, lagMs: Math.max(0, lagMs), running, lastFailures };
}

function wsSection(deps: StatusDeps, sessions: number): StatusResponse['ws'] {
  let subscriptions = 0;
  const hotset = deps.hotset;
  if (hotset !== undefined) {
    for (const entry of hotset.entries()) subscriptions += entry.subscribers;
  }
  // See the header: the gateway does not expose a slow-session count.
  return { sessions, subscriptions, slowSessions: 0 };
}

function plantSection(deps: StatusDeps): StatusResponse['plant'] {
  const stats = deps.plant.stats();
  return {
    state: deps.plant.state,
    subjects: stats.subjects,
    hotSet: deps.hotset?.size ?? 0,
    // See the header: the plant times `pub − cap` only.
    applyP99Ms: 0,
    publishP99Ms: stats.publishLatencyP99Ms,
    // The gateway floors every session's conflation while the process is overloaded
    // (`ws/gateway.ts` L231); it decides that from event-loop lag, which it does not expose, so
    // the plant's own verdict is what this reports.
    conflationFloorMs: deps.plant.state === 'degraded' ? OVERLOAD_FLOOR_MS : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The route
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const statusRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/status',
    { preHandler: [requireSession(), rateLimit(REST_LIMIT)] },
    async (request): Promise<StatusResponse> => {
      const principal = principalOf(request);
      const deps = depsOf(request);
      const nowMs = deps.clock.now();

      const db = await withTx(ctxOf(principal), (tx) => readDb(tx, nowMs));

      return {
        serverTime: new Date(nowMs).toISOString(),
        serverVersion: SERVER_VERSION,
        minClientVersion: MIN_CLIENT_VERSION,
        protocol: [WS_PROTOCOL_VERSION],
        dictionaryVersion: FIELD_DICTIONARY_VERSION,
        registryVersion: functionRegistry.version,
        providerMode: deps.config.PROVIDER_MODE,
        plant: plantSection(deps),
        ws: wsSection(deps, request.server.wsGateway.sessionCount()),
        providers: providerSection(deps, db.providerTimes),
        sessions: marketSessions(nowMs),
        scheduler: schedulerSection(deps, nowMs, db.lastFailures),
        dq: db.dq,
        incidents: db.incidents,
        timings: {
          // See the header: neither of these is measured anywhere yet.
          autocompleteP95Ms: 0,
          fnLaunchP95Ms: db.fnLaunchP95Ms,
          historyP95Ms: 0,
        },
      };
    },
  );

  await Promise.resolve();
};

export default statusRoutes;
