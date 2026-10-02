/**
 * `http/routes/usage.ts` — API.md §5.13 L766-785 (FUNC-04, API-06, ENTL-05), WORKPLAN WP-07.
 *
 * Four routes, all session-bound:
 *
 *  - `POST /usage/events`   — the client's batched telemetry (≤ 100 per call) into `usage_events`.
 *  - `GET  /usage/quota`    — the live API-06 counters, `enforced` only for an `api` session.
 *  - `GET  /usage/entitlements` — what the evaluator WILL decide, so a screen can pre-label a
 *    denied field before it asks for it (ENTL-05).
 *  - `GET  /usage/functions` — the roadmap query (ARCHITECTURE §11); `admin` and `dataops` only.
 *
 * The request schemas come from `@terminal/sdk/wire/rest/usage` and are normative: this module
 * parses with them rather than restating them, so a change there is a compile-or-400 here and
 * never a silently different server.
 *
 * Every handler runs inside `withTx(ctx, …)` so `app.user_id` / `app.firm_id` / `app.role` are set
 * for the statement and RLS applies (DATA_MODEL §15.1). The services (`quotas`) are built from
 * that transaction rather than from a module singleton, which is what lets the integration tests
 * hand the app their own rolled-back transaction and still exercise the shipped handler.
 *
 * `usage_events` is WORM (migration 0015): `terminal_app` holds SELECT and INSERT and nothing else,
 * so a client cannot rewrite its own telemetry. A client that posts a *server-originated* kind is
 * accepted and flagged `details.clientReported = true` (API.md L783-784) rather than rejected — the
 * event is real, it just may not be trusted for billing.
 *
 * "Not trusted for billing" is enforced, once, in `GET /usage/functions`: the roadmap counts exclude
 * the flagged rows, because FUNCTIONS.md §588 makes the server runner the authoritative writer of
 * `fn.launch` and the client's copy a *second* row about the same GO. See the comment on that query.
 *
 * **One place still pools them**, and it is recorded here rather than changed: `routes/status.ts`
 * computes `timings.fnLaunchP95Ms` as `percentile_cont(0.95)` over `usage_events.duration_ms` for
 * `kind = 'fn.launch'` with no such predicate, so it now mixes two quantities — the client's
 * GO → first paint (hundreds of ms) and the runner's own duration (single-digit ms for a cached
 * screen). The direction is unchanged, since the upper tail is still the client's numbers, but the
 * figure is no longer a percentile of anything in particular.
 *
 * **What that leaves behind, stated exactly, because an earlier version of this paragraph understated
 * it.** It said `packages/e2e`'s `command-line.spec.ts` "asserts only that the figure is above zero".
 * That is half the spec. `command-line.spec.ts` L504-506 asserts `> 0` per launched code — which both
 * quantities satisfy together and only one of them satisfies alone, since a sub-millisecond runner
 * duration rounds to 0 — and then L527-530 asserts that **every non-`WEI` code's p95 is `<= 500 ms`**.
 * That second assertion is a budget over a figure whose mix varies per run, and it is the one that
 * goes red. Four runs of that spec on one machine, as the spec's own `console.log` prints them:
 *
 *     DES  90.3  GP 127.5  W 207.0     passed
 *     DES 106.3  GP 121.6  W 236.4     passed  (slot 6, with this paragraph being written)
 *     DES  94.3  GP 343.5  W 403.0     passed
 *     DES 576.5  GP 593.8  W 739.2     FAILED
 *
 * A better-than-fivefold swing on `W` with no change to the server, because the proportion of client
 * rows to runner rows in the window is not a property of the build. So the pooling does not merely blur
 * a status figure; it is a live source of false failures in the e2e gate, and the gate's own headroom is
 * thin for the same reason the last row is possible at all — `WEI` read 496.4 ms on the slot-6 run, four
 * milliseconds inside a budget it is deliberately exempt from here.
 *
 * Which of the two OPS-03's status page should report is still a decision about that page, not about
 * this route: the client's number is the quantity REQUIREMENTS L306 budgets and is not trusted for
 * billing, the runner's is the one the plant measures and would round to 0 on a cached screen,
 * breaking the `> 0` assertion above. Deferred deliberately, and `BUILD_STATUS.md` carries it under
 * the status route rather than only this comment, so the open item is findable from the file that
 * lists what is open.
 */

import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { Clock, Tier } from '@terminal/core';
import { FunctionUsageQuery, UsageEventsRequest } from '@terminal/sdk/wire/rest/usage';

import { withTx, type Db, type RequestCtx, type Tx } from '../../db/client.js';
import { usageEvents } from '../../db/schema/index.js';
import { DEFAULT_TIER, minTier } from '../../entitlements/evaluator.js';
import { quotas } from '../../entitlements/quotas.js';
import { AuthRequiredError, ValidationFailedError } from '../errors.js';
import { requireSession, type Principal } from '../auth/session.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `to_char(… )` mask for a timestamptz rendered as the `z.iso.datetime()` the wire expects.
 * Quoted here because it is interpolated with `sql.raw`, never with a parameter.
 */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * `valid_to = 'infinity'` on the wire. `Rest.Usage.EntitlementSummaryGrant.validTo` is a
 * non-nullable `z.iso.datetime()`, and `Infinity` has no ISO 8601 spelling, so the open end is sent
 * as the largest timestamp the format can carry. Nothing reads it back as a date; it sorts last.
 */
const FOREVER = '9999-12-31T23:59:59.999Z';

/** The kinds the server writes itself (API.md L783): a client posting one is flagged, not refused. */
const SERVER_ORIGINATED: ReadonlySet<string> = new Set([
  'fn.launch',
  'fn.param',
  'fn.page',
  'fn.export',
  'ws.subscribe',
  'ws.slow',
  'ws.resync',
]);

/** The principal the guard decorated, or 401 — a route reached without its guard is a bug. */
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

/** Parse with a normative wire schema; a failure is the documented `400 VALIDATION_FAILED`. */
function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  location: 'body' | 'query' | 'params',
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationFailedError(location, result.error.issues);
  return result.data;
}

/** Query strings arrive as strings; the wire schema wants numbers. Coerce the named keys only. */
function coerceNumbers(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return out;
}

interface UsageDeps {
  db: Db | Tx;
  clock: Clock;
}

function depsOf(request: FastifyRequest): UsageDeps {
  const deps = request.server.deps as unknown as UsageDeps;
  return { db: deps.db, clock: deps.clock };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes (`db.execute` returns snake_case, bigint as string)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface GrantSqlRow {
  subject_kind: 'user' | 'firm';
  source_id: string | null;
  asset_class: string | null;
  field_class: string | null;
  max_tier: Tier;
  usage_display: boolean;
  usage_export: boolean;
  usage_api: boolean;
  valid_from: string | null;
  valid_to: string | null;
}

interface LicenceSqlRow {
  source_id: string;
  source_name: string;
  publisher: string;
  licence_kind: string;
  attribution: string;
  display: boolean;
  export_allowed: boolean;
  api_allowed: boolean;
  redistribution: boolean;
  max_tier: Tier;
  intrinsic_delay_min: number | string;
  retention_days: number | string | null;
  terms_url: string | null;
}

interface FunctionUsageSqlRow {
  code: string;
  launches: string;
  users: string;
  exports: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const usageRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /usage/events ──────────────────────────────────────────────────────────────────────
  app.post(
    '/usage/events',
    { preHandler: requireSession() },
    async (request, reply): Promise<void> => {
      const principal = principalOf(request);
      const body = parse(UsageEventsRequest, request.body, 'body');

      if (body.events.length === 0) {
        void reply.status(202);
        return;
      }

      const rows = body.events.map((event) => {
        const details: Record<string, unknown> = { ...event.details };
        if (SERVER_ORIGINATED.has(event.kind)) details.clientReported = true;
        return {
          ts: new Date(event.ts),
          userId: principal.userId,
          firmId: principal.firmId,
          sessionId: principal.sessionId,
          panelId: event.panelId ?? null,
          kind: event.kind,
          code: event.code ?? null,
          paramsHash: event.paramsHash ?? null,
          instrumentId: event.instrumentId ?? null,
          durationMs: event.durationMs ?? null,
          traceId: event.traceId ?? request.traceId,
          details,
        };
      });

      await withTx(ctxOf(principal), async (tx) => {
        await tx.insert(usageEvents).values(rows);
      });

      void reply.status(202);
    },
  );

  // ── GET /usage/quota ────────────────────────────────────────────────────────────────────────
  // API-01: these are data reads, so they ask for the `data:read` scope. A web session carries it
  // by definition; a bearer key minted without it is refused here rather than nowhere.
  app.get(
    '/usage/quota',
    { preHandler: requireSession({ scopes: ['data:read'] }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      // The concurrency counter is the plant's, not the database's (see `WsGateway.subscriptionCount`
      // and `entitlements/quotas.ts#state`), so it is read here and passed in. Without it this route
      // answered `"concurrentSubscriptions":{"used":0}` with any number of subjects live, and the
      // e2e reconciliation of the strip against this endpoint compared two constants (API-06).
      const liveSubs = request.server.wsGateway?.subscriptionCount(principal.userId) ?? 0;
      return withTx(ctxOf(principal), async (tx) => {
        const service = quotas({ db: tx, clock });
        return service.state(principal.userId, principal.firmId, principal.clientKind, liveSubs);
      });
    },
  );

  // ── GET /usage/entitlements ─────────────────────────────────────────────────────────────────
  app.get(
    '/usage/entitlements',
    { preHandler: requireSession({ scopes: ['data:read'] }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const nowIso = new Date(clock.now()).toISOString();

      return withTx(ctxOf(principal), async (tx) => {
        const grantResult = await tx.execute(sql`
        SELECT subject_kind, source_id, asset_class, field_class, max_tier,
               usage_display, usage_export, usage_api,
               CASE WHEN valid_from = '-infinity' THEN NULL
                    ELSE to_char(valid_from AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_from,
               CASE WHEN valid_to = 'infinity' THEN NULL
                    ELSE to_char(valid_to AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) END AS valid_to
          FROM entitlement_grants
         WHERE ((subject_kind = 'user' AND subject_id = ${principal.userId})
             OR (subject_kind = 'firm' AND subject_id = ${principal.firmId}))
           AND valid_from <= ${nowIso}::timestamptz
           AND valid_to   >  ${nowIso}::timestamptz
         ORDER BY subject_kind DESC, grant_id`);
        const grantRows = grantResult.rows as unknown as GrantSqlRow[];

        const licenceResult = await tx.execute(sql`
        SELECT source_id, source_name, publisher, licence_kind, attribution, display,
               export_allowed, api_allowed, redistribution, max_tier, intrinsic_delay_min,
               retention_days, terms_url
          FROM licence_registry
         WHERE tx_to = 'infinity'
           AND valid_from <= ${nowIso}::timestamptz
           AND valid_to   >  ${nowIso}::timestamptz
         ORDER BY source_id`);
        const licenceRows = licenceResult.rows as unknown as LicenceSqlRow[];

        // API.md §1.2: the minimum over the subject's grants — a user with one `eod` grant is an
        // `eod` user for the label, whatever else they hold. No grant at all is BRIEF §5.6's default.
        let defaultTier: Tier | null = null;
        for (const row of grantRows) {
          defaultTier = defaultTier === null ? row.max_tier : minTier(defaultTier, row.max_tier);
        }

        return {
          defaultTier: defaultTier ?? DEFAULT_TIER,
          grants: grantRows.map((row) => ({
            subjectKind: row.subject_kind,
            sourceId: row.source_id,
            assetClass: row.asset_class,
            fieldClass: row.field_class,
            maxTier: row.max_tier,
            usageDisplay: row.usage_display,
            usageExport: row.usage_export,
            usageApi: row.usage_api,
            validFrom: row.valid_from ?? '0001-01-01T00:00:00.000Z',
            validTo: row.valid_to ?? FOREVER,
          })),
          licences: licenceRows.map((row) => ({
            sourceId: row.source_id,
            sourceName: row.source_name,
            publisher: row.publisher,
            licenceKind: row.licence_kind,
            attribution: row.attribution,
            display: row.display,
            exportAllowed: row.export_allowed,
            apiAllowed: row.api_allowed,
            redistribution: row.redistribution,
            maxTier: row.max_tier,
            intrinsicDelayMin: Number(row.intrinsic_delay_min),
            retentionDays: row.retention_days === null ? null : Number(row.retention_days),
            termsUrl: row.terms_url,
          })),
        };
      });
    },
  );

  // ── GET /usage/functions ────────────────────────────────────────────────────────────────────
  app.get(
    '/usage/functions',
    { preHandler: requireSession({ roles: ['admin', 'dataops'] }) },
    async (request) => {
      const principal = principalOf(request);
      const { clock } = depsOf(request);
      const query = parse(FunctionUsageQuery, coerceNumbers(request.query, ['days']), 'query');
      const since = new Date(clock.now() - query.days * 24 * 60 * 60 * 1_000).toISOString();

      return withTx(ctxOf(principal), async (tx) => {
        // `details.clientReported` rows are excluded, and that predicate is the whole correctness
        // of this query. FUNCTIONS.md §588 names the **server runner** the authoritative writer of
        // `fn.launch` and gives the client's copy a different job — it carries `durationMs` as
        // GO → first paint — and API.md L785 keeps that copy rather than refusing it. So a launch
        // made from the web shell produces two rows, one per writer, and counting both would report
        // twice the launches that happened. This was invisible for as long as startup step 9 was
        // skipped and the authoritative writer therefore wrote nothing: every `fn.launch` row in a
        // running deployment was the client's, and counting all of them happened to be right.
        const result = await tx.execute(sql`
          SELECT code,
                 count(*) FILTER (WHERE kind = 'fn.launch')          AS launches,
                 count(DISTINCT user_id)                             AS users,
                 count(*) FILTER (WHERE kind = 'fn.export')          AS exports
            FROM usage_events
           WHERE ts >= ${since}::timestamptz
             AND code IS NOT NULL
             AND kind IN ('fn.launch', 'fn.export')
             AND details->>'clientReported' IS DISTINCT FROM 'true'
           GROUP BY code
           ORDER BY count(*) FILTER (WHERE kind = 'fn.launch') DESC, code`);
        const rows = result.rows as unknown as FunctionUsageSqlRow[];
        return {
          items: rows.map((row) => ({
            code: row.code,
            launches: Number(row.launches),
            users: Number(row.users),
            exports: Number(row.exports),
          })),
        };
      });
    },
  );

  await Promise.resolve();
};

export default usageRoutes;
