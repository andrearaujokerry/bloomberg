/**
 * `http/routes/alerts.ts` — API.md §5.11 L732-756 (NEWS-07), WP-09.
 *
 *   GET / POST            /alerts                     the caller's triggers
 *   GET / PUT / DELETE    /alerts/:alertId            owner only; DELETE is `status='deleted'`
 *   GET                   /alerts/events              the in-app delivery record
 *   POST                  /alerts/events/:eventId/ack acknowledge one firing
 *   GET / POST            /saved-searches             news / eqs / srch definitions
 *   GET / DELETE          /saved-searches/:searchId
 *
 * Four rules:
 *
 *  1. **`alerts.kind` and `alerts.instrument_id` are derived, never trusted.** The CHECK on
 *     `kind` and the partial index `alerts_armed_price_idx (instrument_id) WHERE status='armed'
 *     AND kind='price'` are what let `alerts/engine.ts` evaluate a plant delta against the armed
 *     set with one index probe instead of a full scan. Both are projected here from the parsed
 *     `AlertCondition`, so a client cannot arm a price alert the engine will never look at.
 *  2. **A price alert's security is resolved on the way in.** The condition is stored with
 *     `security: { id }` — the engine sees plant subjects, which are instrument ids, and a
 *     condition that still said `'AAPL US Equity'` would have to re-resolve a ticker on every
 *     tick (and would silently follow the ticker if it were ever reassigned).
 *  3. **Ownership is in the SQL and a miss is a 404.** `alerts_owner` and `saved_searches_owner`
 *     (migration 0015) say `owner_user_id = app_user_id()`; every statement restates it, because
 *     RLS does not apply to the role that owns the tables. Zero rows is `404`, never `403`
 *     (API.md L186).
 *  4. **Deleting an alert keeps its firings.** `status='deleted'` rather than a `DELETE`:
 *     `alert_events` is the record that a user was told something, `alerts` carries the condition
 *     that told them, and a row removed here would orphan the explanation of an event the user
 *     can still see in their inbox.
 *
 * Fired alerts reach the client on the WS `alerts:me` subject (API.md §6.9); this file is the
 * durable half of that — the engine writes `alert_events`, these routes read them back.
 *
 * `/saved-searches` lives here rather than in `news.ts` because API.md §5.11 and
 * `wire/rest/alerts.ts` put it here: a `kind:'news'` alert names a `savedSearchId`, so the two
 * are one surface, and one Fastify instance cannot register a path twice.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import type { Clock } from '@terminal/core';
import {
  AlertEventQuery,
  CreateAlertRequest,
  CreateSavedSearchRequest,
  SavedSearchQuery,
  UpdateAlertRequest,
  type Alert,
  type AlertCondition,
  type AlertEvent,
  type AlertEventListResponse,
  type AlertListResponse,
  type SavedSearch,
  type SavedSearchListResponse,
} from '@terminal/sdk/wire/rest/alerts';

import { toInstrumentSummary } from '../../data/request.js';
import type { AsOf } from '../../db/bitemporal.js';
import { withTx, type Tx } from '../../db/client.js';
import { SecurityResolver } from '../../refdata/resolve.js';
import { requireSession, type Principal } from '../auth/session.js';
import { AppError, ConflictError, NotFoundError, ValidationFailedError } from '../errors.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { asOfOfRequest } from './data.js';
import { ctxOf, parse, principalOf } from './functions.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

function idParam(raw: unknown, key: string): number {
  const source = (raw ?? {}) as Record<string, unknown>;
  const value = source[key];
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationFailedError('params', [
      { code: 'invalid_type', path: [key], message: `${key} must be a positive integer` },
    ]);
  }
  return n;
}

function coerceNumbers(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...((raw ?? {}) as Record<string, unknown>) };
  for (const key of keys) {
    const value = out[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor !== undefined && depth < 5; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null) return false;
    if ((cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

function ownedBy(principal: Principal): SQL {
  return sql`owner_user_id = ${String(principal.userId)}::bigint`;
}

function nowIso(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conditions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The condition as it is stored: a price alert's security resolved to `{ id }`, everything else
 * byte-for-byte what the caller sent.
 *
 * @throws AppError `SECURITY_NOT_FOUND` / `AMBIGUOUS_SECURITY` — an alert that can never fire is
 *         refused at the door rather than armed against a reference nothing matches.
 */
async function storedCondition(
  tx: Tx,
  at: AsOf,
  condition: AlertCondition,
): Promise<{ condition: AlertCondition; instrumentId: number | null }> {
  if (condition.kind !== 'price') return { condition, instrumentId: null };

  const ref = condition.security;
  if ('formula' in ref) {
    throw new ValidationFailedError('body', [
      {
        code: 'custom',
        path: ['condition', 'security'],
        message: 'a price alert needs a security, not a computed series',
      },
    ]);
  }
  const outcome = await new SecurityResolver(tx).resolve(
    'id' in ref ? { id: ref.id } : ref.ref,
    at,
  );
  if (!outcome.ok) {
    const code = outcome.code === 'AMBIGUOUS_SECURITY' ? 'AMBIGUOUS_SECURITY' : 'SECURITY_NOT_FOUND';
    throw new AppError(code, outcome.message, {
      details: { candidates: outcome.candidates.map(toInstrumentSummary) },
    });
  }
  const instrumentId = outcome.instrument.instrumentId;
  return {
    condition: { ...condition, security: { id: instrumentId } },
    instrumentId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ALERT_COLUMNS: SQL = sql`
  alert_id::text AS alert_id, condition, delivery, status, one_shot,
  to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
  to_char(last_fired_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS last_fired_at`;

type AlertSqlRow = {
  alert_id: string;
  condition: unknown;
  delivery: readonly string[] | null;
  status: Alert['status'];
  one_shot: boolean;
  created_at: string;
  last_fired_at: string | null;
};

function toAlert(row: AlertSqlRow): Alert {
  return {
    alertId: Number(row.alert_id),
    // Stored as written and returned as stored: it was parsed by `AlertCondition` on the way in.
    condition: row.condition as AlertCondition,
    delivery: (row.delivery ?? []) as Alert['delivery'],
    status: row.status,
    oneShot: row.one_shot,
    createdAt: row.created_at,
    lastFiredAt: row.last_fired_at,
  };
}

const EVENT_COLUMNS: SQL = sql`
  e.event_id::text AS event_id, e.alert_id::text AS alert_id,
  to_char(e.fired_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS fired_at,
  e.payload, e.delivered,
  to_char(e.acknowledged_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS acknowledged_at`;

type EventSqlRow = {
  event_id: string;
  alert_id: string;
  fired_at: string;
  payload: unknown;
  delivered: unknown;
  acknowledged_at: string | null;
};

function toEvent(row: EventSqlRow): AlertEvent {
  return {
    eventId: Number(row.event_id),
    alertId: Number(row.alert_id),
    firedAt: row.fired_at,
    payload: (row.payload ?? { summary: '' }) as AlertEvent['payload'],
    delivered: (row.delivered ?? {}) as AlertEvent['delivered'],
    acknowledgedAt: row.acknowledged_at,
  };
}

const SEARCH_COLUMNS: SQL = sql`
  search_id::text AS search_id, owner_user_id::text AS owner_user_id, kind, name, query,
  to_char(created_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', ${sql.raw(ISO_UTC)}) AS updated_at`;

type SearchSqlRow = {
  search_id: string;
  owner_user_id: string;
  kind: SavedSearch['kind'];
  name: string;
  query: unknown;
  created_at: string;
  updated_at: string;
};

function toSavedSearch(row: SearchSqlRow): SavedSearch {
  return {
    searchId: Number(row.search_id),
    ownerUserId: Number(row.owner_user_id),
    kind: row.kind,
    name: row.name,
    query: (row.query ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const alertsRoutes: FastifyPluginAsync = async (app) => {
  // API.md §5.11's Role column is "any" on every row; ownership decides what a request touches.
  const guard = { preHandler: [requireSession(), rateLimit(REST_LIMIT)] };

  const asOfOf = (request: { query?: unknown }): AsOf =>
    asOfOfRequest(request.query ?? {}, app.deps.clock);

  // ── GET /alerts ────────────────────────────────────────────────────────────────────────────
  app.get('/alerts', guard, async (request): Promise<AlertListResponse> => {
    const principal = principalOf(request);
    return withTx(ctxOf(principal), async (tx) => {
      const res = await tx.execute<AlertSqlRow>(sql`
        SELECT ${ALERT_COLUMNS} FROM alerts
         WHERE ${ownedBy(principal)} AND status <> 'deleted'
         ORDER BY alert_id`);
      return { items: res.rows.map(toAlert) };
    });
  });

  // ── POST /alerts ───────────────────────────────────────────────────────────────────────────
  app.post('/alerts', guard, async (request, reply): Promise<Alert> => {
    const principal = principalOf(request);
    const body = parse(CreateAlertRequest, request.body, 'body');
    const at = asOfOf(request);

    const created = await withTx(ctxOf(principal), async (tx) => {
      const { condition, instrumentId } = await storedCondition(tx, at, body.condition);
      const res = await tx.execute<AlertSqlRow>(sql`
        INSERT INTO alerts (owner_user_id, firm_id, kind, instrument_id, condition, delivery,
                            status, one_shot)
        VALUES (${String(principal.userId)}::bigint, ${String(principal.firmId)}::bigint,
                ${condition.kind},
                ${instrumentId === null ? sql`NULL::bigint` : sql`${String(instrumentId)}::bigint`},
                ${JSON.stringify(condition)}::jsonb,
                ${sql`ARRAY[${sql.join(
                  body.delivery.map((d) => sql`${d}`),
                  sql`, `,
                )}]::text[]`},
                'armed', ${body.oneShot})
        RETURNING ${ALERT_COLUMNS}`);
      const row = res.rows[0];
      if (row === undefined) throw new NotFoundError('The alert was not written.');
      return toAlert(row);
    });

    void reply.status(201);
    return created;
  });

  // ── GET /alerts/events ─────────────────────────────────────────────────────────────────────
  //
  // Before `/alerts/:alertId` in the file for readability; Fastify's radix router prefers the
  // static segment whatever the order, so `events` can never be read as an id.
  app.get('/alerts/events', guard, async (request): Promise<AlertEventListResponse> => {
    const principal = principalOf(request);
    const query = parse(AlertEventQuery, coerceNumbers(request.query, ['limit']), 'query');

    return withTx(ctxOf(principal), async (tx) => {
      const since =
        query.since === undefined
          ? sql``
          : sql` AND e.fired_at >= ${query.since}::timestamptz`;
      const res = await tx.execute<EventSqlRow>(sql`
        SELECT ${EVENT_COLUMNS}
          FROM alert_events e
          JOIN alerts a ON a.alert_id = e.alert_id
         WHERE a.owner_user_id = ${String(principal.userId)}::bigint${since}
         ORDER BY e.fired_at DESC, e.event_id DESC
         LIMIT ${query.limit}`);
      return { items: res.rows.map(toEvent) };
    });
  });

  // ── POST /alerts/events/:eventId/ack ───────────────────────────────────────────────────────
  app.post('/alerts/events/:eventId/ack', guard, async (request, reply: FastifyReply) => {
    const principal = principalOf(request);
    const eventId = idParam(request.params, 'eventId');

    await withTx(ctxOf(principal), async (tx) => {
      // The owner predicate is on `alerts`, not on `alert_events`: the event carries `firm_id`,
      // and a colleague of the same firm must not acknowledge somebody else's alert.
      const res = await tx.execute<{ event_id: string }>(sql`
        UPDATE alert_events e
           SET acknowledged_at = ${nowIso(app.deps.clock)}::timestamptz
          FROM alerts a
         WHERE a.alert_id = e.alert_id
           AND e.event_id = ${String(eventId)}::bigint
           AND a.owner_user_id = ${String(principal.userId)}::bigint
        RETURNING e.event_id::text AS event_id`);
      if (res.rows.length === 0) throw new NotFoundError('No such alert event.');
    });

    void reply.status(204);
    return null;
  });

  // ── GET /alerts/:alertId ───────────────────────────────────────────────────────────────────
  app.get('/alerts/:alertId', guard, async (request): Promise<Alert> => {
    const principal = principalOf(request);
    const alertId = idParam(request.params, 'alertId');
    return withTx(ctxOf(principal), async (tx) => {
      const res = await tx.execute<AlertSqlRow>(sql`
        SELECT ${ALERT_COLUMNS} FROM alerts
         WHERE alert_id = ${String(alertId)}::bigint AND ${ownedBy(principal)}
           AND status <> 'deleted'`);
      const row = res.rows[0];
      if (row === undefined) throw new NotFoundError('No such alert.');
      return toAlert(row);
    });
  });

  // ── PUT /alerts/:alertId ───────────────────────────────────────────────────────────────────
  app.put('/alerts/:alertId', guard, async (request): Promise<Alert> => {
    const principal = principalOf(request);
    const alertId = idParam(request.params, 'alertId');
    const body = parse(UpdateAlertRequest, request.body, 'body');
    const at = asOfOf(request);

    return withTx(ctxOf(principal), async (tx) => {
      const assignments: SQL[] = [];
      if (body.condition !== undefined) {
        const { condition, instrumentId } = await storedCondition(tx, at, body.condition);
        assignments.push(sql`condition = ${JSON.stringify(condition)}::jsonb`);
        assignments.push(sql`kind = ${condition.kind}`);
        assignments.push(
          sql`instrument_id = ${
            instrumentId === null ? sql`NULL::bigint` : sql`${String(instrumentId)}::bigint`
          }`,
        );
      }
      if (body.delivery !== undefined) {
        assignments.push(
          sql`delivery = ${sql`ARRAY[${sql.join(
            body.delivery.map((d) => sql`${d}`),
            sql`, `,
          )}]::text[]`}`,
        );
      }
      // `status` takes only `armed` or `paused` here (the wire schema says so): `fired` is the
      // engine's to write and `deleted` is the DELETE route's.
      if (body.status !== undefined) assignments.push(sql`status = ${body.status}`);
      if (assignments.length === 0) assignments.push(sql`condition = condition`);

      const res = await tx.execute<AlertSqlRow>(sql`
        UPDATE alerts SET ${sql.join(assignments, sql`, `)}
         WHERE alert_id = ${String(alertId)}::bigint AND ${ownedBy(principal)}
           AND status <> 'deleted'
        RETURNING ${ALERT_COLUMNS}`);
      const row = res.rows[0];
      if (row === undefined) throw new NotFoundError('No such alert.');
      return toAlert(row);
    });
  });

  // ── DELETE /alerts/:alertId ────────────────────────────────────────────────────────────────
  app.delete('/alerts/:alertId', guard, async (request, reply: FastifyReply) => {
    const principal = principalOf(request);
    const alertId = idParam(request.params, 'alertId');

    await withTx(ctxOf(principal), async (tx) => {
      const res = await tx.execute<{ alert_id: string }>(sql`
        UPDATE alerts SET status = 'deleted'
         WHERE alert_id = ${String(alertId)}::bigint AND ${ownedBy(principal)}
           AND status <> 'deleted'
        RETURNING alert_id::text AS alert_id`);
      if (res.rows.length === 0) throw new NotFoundError('No such alert.');
    });

    void reply.status(204);
    return null;
  });

  // ── GET /saved-searches ────────────────────────────────────────────────────────────────────
  app.get('/saved-searches', guard, async (request): Promise<SavedSearchListResponse> => {
    const principal = principalOf(request);
    const query = parse(SavedSearchQuery, request.query ?? {}, 'query');
    return withTx(ctxOf(principal), async (tx) => {
      const kind = query.kind === undefined ? sql`` : sql` AND kind = ${query.kind}`;
      const res = await tx.execute<SearchSqlRow>(sql`
        SELECT ${SEARCH_COLUMNS} FROM saved_searches
         WHERE ${ownedBy(principal)}${kind}
         ORDER BY kind, name`);
      return { items: res.rows.map(toSavedSearch) };
    });
  });

  // ── POST /saved-searches ───────────────────────────────────────────────────────────────────
  app.post('/saved-searches', guard, async (request, reply): Promise<SavedSearch> => {
    const principal = principalOf(request);
    const body = parse(CreateSavedSearchRequest, request.body, 'body');

    const created = await withTx(ctxOf(principal), async (tx) => {
      try {
        const res = await tx.execute<SearchSqlRow>(sql`
          INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
          VALUES (${String(principal.userId)}::bigint, ${String(principal.firmId)}::bigint,
                  ${body.kind}, ${body.name}, ${JSON.stringify(body.query)}::jsonb)
          RETURNING ${SEARCH_COLUMNS}`);
        const row = res.rows[0];
        if (row === undefined) throw new NotFoundError('The saved search was not written.');
        return toSavedSearch(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(
            'DUPLICATE_NAME',
            `A ${body.kind} search named "${body.name}" exists.`,
          );
        }
        throw err;
      }
    });

    void reply.status(201);
    return created;
  });

  // ── GET /saved-searches/:searchId ──────────────────────────────────────────────────────────
  app.get('/saved-searches/:searchId', guard, async (request): Promise<SavedSearch> => {
    const principal = principalOf(request);
    const searchId = idParam(request.params, 'searchId');
    return withTx(ctxOf(principal), async (tx) => {
      const res = await tx.execute<SearchSqlRow>(sql`
        SELECT ${SEARCH_COLUMNS} FROM saved_searches
         WHERE search_id = ${String(searchId)}::bigint AND ${ownedBy(principal)}`);
      const row = res.rows[0];
      if (row === undefined) throw new NotFoundError('No such saved search.');
      return toSavedSearch(row);
    });
  });

  // ── DELETE /saved-searches/:searchId ───────────────────────────────────────────────────────
  app.delete('/saved-searches/:searchId', guard, async (request, reply: FastifyReply) => {
    const principal = principalOf(request);
    const searchId = idParam(request.params, 'searchId');

    await withTx(ctxOf(principal), async (tx) => {
      const res = await tx.execute<{ search_id: string }>(sql`
        DELETE FROM saved_searches
         WHERE search_id = ${String(searchId)}::bigint AND ${ownedBy(principal)}
        RETURNING search_id::text AS search_id`);
      if (res.rows.length === 0) throw new NotFoundError('No such saved search.');
    });

    void reply.status(204);
    return null;
  });

  await Promise.resolve();
};

export default alertsRoutes;
