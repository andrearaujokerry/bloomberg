/**
 * `entitlements/quotas.ts` — API-06, API.md §8, ARCHITECTURE §10 rule 8.
 *
 * Three ceilings, one module:
 *
 *  | quota                    | default (api)        | store                              |
 *  | ------------------------ | -------------------- | ---------------------------------- |
 *  | daily unique instruments | 500 / user / UTC day | `quota_instruments_seen`           |
 *  | monthly data points      | 2 000 000 / user     | `quota_counters(window_kind='month')` |
 *  | concurrent subscriptions | 2 000 / api session  | in memory (the plant counts, we cap) |
 *
 * **Enforced only for `clientKind: 'api'`** (bearer sessions). A web session is counted and
 * reported so the status bar can show the numbers, but `check()` never blocks it (API.md §8 L1131).
 *
 * **`check()` runs before any provider fetch**, so an over-quota request costs nothing upstream. It
 * is therefore kept to two `SELECT`s at worst: one aggregate over `quota_instruments_seen` that
 * returns both the day's total and how many of the requested instruments are already in it, and one
 * point read of the month's `quota_counters` row. `record()` is the write half and belongs on the
 * batch path (API.md §8 L1159: counters move with the access-log batch, never on the response path).
 *
 * **Boundary semantics, identical for all three:** a request is rejected when it would take the
 * counter *above* the limit. At `limit` the request is allowed; the one that would make `limit + 1`
 * is refused. `used` in the rejection is the counter as it stands now — what the caller has already
 * consumed — and `limit` and `resetsAt` say when it frees up.
 *
 * Limits resolve `quota_limits` user row → firm row → defaults. The row is taken whole: its three
 * columns are `NOT NULL` with the documented defaults, so a user row that exists answers all three.
 * The one asymmetry is the web concurrency ceiling (10 000, BUS-08): it applies only when nobody
 * wrote a row, since an explicit row is an explicit decision for that subject.
 *
 * Every instant comes from the injected clock: the UTC day and the calendar month are computed from
 * `clock.now()`, never from `Date.now()`, so a virtual clock can walk a test across midnight.
 */

import { sql } from 'drizzle-orm';

import type { Clock } from '@terminal/core';

import type { Db, Tx } from '../db/client.js';
import { AppError } from '../http/errors.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Which ceiling a check refers to. The names are the wire names of API.md §8. */
export type QuotaName = 'dailyUniqueInstruments' | 'monthlyDataPoints' | 'concurrentSubscriptions';

/** One counter as `Rest.Auth.QuotaUsage` describes it. `resetsAt` is ISO 8601 UTC. */
export interface QuotaSnapshot {
  used: number;
  limit: number;
  resetsAt: string;
}

/** The body of `GET /usage/quota` (`Rest.Usage.QuotaResponse`) and of `SessionInfo.quotas`. */
export interface QuotaState {
  dailyUniqueInstruments: QuotaSnapshot;
  monthlyDataPoints: QuotaSnapshot;
  concurrentSubscriptions: QuotaSnapshot;
  /** `true` for `api` sessions; API-06 is advisory for the web client. */
  enforced: boolean;
}

/** The answer of {@link Quotas.check}. On `ok: false` every field is present. */
export interface QuotaCheck {
  ok: boolean;
  quota?: QuotaName;
  used?: number;
  limit?: number;
  resetsAt?: string;
}

export interface QuotaLimits {
  dailyUniqueInstruments: number;
  monthlyDataPoints: number;
  concurrentSubscriptions: number;
}

export interface QuotaCheckContext {
  userId: number;
  firmId: number;
  clientKind: 'web' | 'api';
  /** The instruments this request would touch; duplicates and already-seen ids cost nothing. */
  instrumentIds?: readonly number[];
  /** Data points this request would deliver (API.md §8 counting rules). */
  dataPoints?: number;
  /** Subscriptions that would be live *including* this request. */
  concurrentSubs?: number;
}

export interface QuotaRecordContext {
  userId: number;
  firmId: number;
  instrumentIds?: readonly number[];
  dataPoints?: number;
}

export interface Quotas {
  /** `quota_limits` user row → firm row → defaults. */
  limitsFor(userId: number, firmId: number): Promise<QuotaLimits>;
  /**
   * The EXPLICIT concurrent-subscription ceiling of this subject — the `quota_limits` user row,
   * else the firm row — or `null` when neither exists.
   *
   * `limitsFor` cannot answer this on its own: its fallback is the api default (2 000), which a web
   * session would wrongly adopt, and it cannot say whether a 2 000 it returned was a real row or
   * the default. `ws/session.ts` needs exactly this distinction, because with no row the ceiling is
   * the host's own `WsLimits` (10 000 web / 2 000 api, BUS-08) and a test's injected limit must
   * survive.
   */
  concurrencyCeiling(userId: number, firmId: number): Promise<number | null>;
  /** The gate. Never blocks a `web` client; first failing quota wins for an `api` client. */
  check(ctx: QuotaCheckContext): Promise<QuotaCheck>;
  /** The counting half: insert-if-absent instruments, add data points to the month. */
  record(ctx: QuotaRecordContext): Promise<void>;
  /** The live counters, for `GET /usage/quota`, `SessionInfo.quotas` and the status bar. */
  state(
    userId: number,
    firmId: number,
    clientKind: 'web' | 'api',
    concurrentSubs?: number,
  ): Promise<QuotaState>;
}

export interface QuotasDeps {
  db: Db | Tx;
  clock: Clock;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Defaults (API.md §8, migration 0011 `quota_limits` column defaults)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_DAILY_UNIQUE_INSTRUMENTS = 500;
export const DEFAULT_MONTHLY_DATA_POINTS = 2_000_000;
/** Per api session. */
export const DEFAULT_CONCURRENT_SUBSCRIPTIONS_API = 2_000;
/** Per web session (BUS-08) — the ceiling, not an entitlement. */
export const DEFAULT_CONCURRENT_SUBSCRIPTIONS_WEB = 10_000;

const DEFAULT_LIMITS: QuotaLimits = {
  dailyUniqueInstruments: DEFAULT_DAILY_UNIQUE_INSTRUMENTS,
  monthlyDataPoints: DEFAULT_MONTHLY_DATA_POINTS,
  concurrentSubscriptions: DEFAULT_CONCURRENT_SUBSCRIPTIONS_API,
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Calendar helpers — all UTC, all from the injected clock
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` of the UTC day containing `nowMs`. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** `YYYY-MM-01` of the UTC calendar month containing `nowMs`. */
export function utcMonthStart(nowMs: number): string {
  return `${new Date(nowMs).toISOString().slice(0, 7)}-01`;
}

/** The next UTC midnight after `nowMs`, as an ISO 8601 instant. */
export function nextUtcMidnight(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0),
  ).toISOString();
}

/** The first instant of the next UTC calendar month after `nowMs`, as an ISO 8601 instant. */
export function nextUtcMonthStart(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The 429 (API.md §8) — one place builds the envelope the routes and the WS `subAck` share
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `429 QUOTA_EXCEEDED` of API.md §8: `details` is exactly
 * `{ quota, used, limit, resetsAt }`. Pass a rejected {@link QuotaCheck}; a check that passed is a
 * programming error and throws.
 */
export function quotaExceededError(check: QuotaCheck): AppError {
  if (check.ok || check.quota === undefined) {
    throw new Error('quotaExceededError: the check passed — there is no 429 to send');
  }
  return new AppError('QUOTA_EXCEEDED', `Quota exceeded: ${check.quota}.`, {
    details: {
      quota: check.quota,
      used: check.used ?? 0,
      limit: check.limit ?? 0,
      resetsAt: check.resetsAt ?? '',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface LimitsSqlRow {
  subject_kind: string;
  daily_unique_instruments: number;
  monthly_data_points: string;
  concurrent_subscriptions: number;
}

interface SeenSqlRow {
  used: number;
  already: number;
}

interface CounterSqlRow {
  data_points: string;
}

/** Limits plus where they came from — the web concurrency ceiling depends on that. */
interface ResolvedLimits {
  limits: QuotaLimits;
  source: 'user' | 'firm' | 'default';
}

/**
 * A Postgres `bigint[]` literal for `ids`. Drizzle expands a JS array into one bind parameter per
 * element (`($1, $2)`), which is a record, not an array; a single literal parameter cast to
 * `bigint[]` is what `= ANY(…)` and `unnest(…)` need. The ids are integers by
 * {@link normaliseIds}, so the literal cannot carry anything but digits.
 */
function bigintArrayLiteral(ids: readonly number[]): string {
  return `{${ids.join(',')}}`;
}

/** Distinct, finite, positive instrument ids. Anything else is not an instrument. */
function normaliseIds(ids: readonly number[] | undefined): number[] {
  if (ids === undefined || ids.length === 0) return [];
  const out = new Set<number>();
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0) out.add(id);
  }
  return [...out];
}

function rejection(quota: QuotaName, used: number, limit: number, resetsAt: string): QuotaCheck {
  return { ok: false, quota, used, limit, resetsAt };
}

export function quotas(deps: QuotasDeps): Quotas {
  const { db, clock } = deps;

  async function rows<R>(query: ReturnType<typeof sql>): Promise<R[]> {
    const result = await db.execute(query);
    return result.rows as unknown as R[];
  }

  async function resolve(userId: number, firmId: number): Promise<ResolvedLimits> {
    const found = await rows<LimitsSqlRow>(sql`
      SELECT subject_kind,
             daily_unique_instruments,
             monthly_data_points::text AS monthly_data_points,
             concurrent_subscriptions
        FROM quota_limits
       WHERE (subject_kind = 'user' AND subject_id = ${userId})
          OR (subject_kind = 'firm' AND subject_id = ${firmId})`);

    const row =
      found.find((r) => r.subject_kind === 'user') ?? found.find((r) => r.subject_kind === 'firm');
    if (row === undefined) return { limits: { ...DEFAULT_LIMITS }, source: 'default' };
    return {
      limits: {
        dailyUniqueInstruments: Number(row.daily_unique_instruments),
        monthlyDataPoints: Number(row.monthly_data_points),
        concurrentSubscriptions: Number(row.concurrent_subscriptions),
      },
      source: row.subject_kind === 'user' ? 'user' : 'firm',
    };
  }

  /**
   * The concurrency ceiling for this client kind. An explicit `quota_limits` row is an explicit
   * decision and is honoured for both kinds; only the fallback differs (2 000 api / 10 000 web).
   */
  function concurrencyLimit(resolved: ResolvedLimits, clientKind: 'web' | 'api'): number {
    if (resolved.source !== 'default') return resolved.limits.concurrentSubscriptions;
    return clientKind === 'api'
      ? DEFAULT_CONCURRENT_SUBSCRIPTIONS_API
      : DEFAULT_CONCURRENT_SUBSCRIPTIONS_WEB;
  }

  /** The day's instrument count, and how many of `ids` it already contains. One query. */
  async function instrumentCounts(
    userId: number,
    day: string,
    ids: readonly number[],
  ): Promise<SeenSqlRow> {
    const idList = bigintArrayLiteral(ids);
    const found = await rows<SeenSqlRow>(sql`
      SELECT count(*)::int AS used,
             count(*) FILTER (WHERE instrument_id = ANY(${idList}::bigint[]))::int AS already
        FROM quota_instruments_seen
       WHERE user_id = ${userId} AND day = ${day}::date`);
    return found[0] ?? { used: 0, already: 0 };
  }

  async function monthlyUsed(userId: number, monthStart: string): Promise<number> {
    const found = await rows<CounterSqlRow>(sql`
      SELECT data_points::text AS data_points
        FROM quota_counters
       WHERE user_id = ${userId} AND window_kind = 'month' AND window_start = ${monthStart}::date`);
    return found.length === 0 ? 0 : Number(found[0]?.data_points ?? 0);
  }

  return {
    async limitsFor(userId: number, firmId: number): Promise<QuotaLimits> {
      return (await resolve(userId, firmId)).limits;
    },

    async concurrencyCeiling(userId: number, firmId: number): Promise<number | null> {
      const resolved = await resolve(userId, firmId);
      return resolved.source === 'default' ? null : resolved.limits.concurrentSubscriptions;
    },

    async check(ctx: QuotaCheckContext): Promise<QuotaCheck> {
      // API.md §8 L1131: counted for web, enforced for api. A web caller never pays for a SELECT
      // it cannot fail.
      if (ctx.clientKind !== 'api') return { ok: true };

      const now = clock.now();
      const resolved = await resolve(ctx.userId, ctx.firmId);
      const limits = resolved.limits;

      // 1 — daily unique instruments.
      const ids = normaliseIds(ctx.instrumentIds);
      const day = utcDay(now);
      const counts = await instrumentCounts(ctx.userId, day, ids);
      const fresh = ids.length - counts.already;
      if (counts.used + fresh > limits.dailyUniqueInstruments) {
        return rejection(
          'dailyUniqueInstruments',
          counts.used,
          limits.dailyUniqueInstruments,
          nextUtcMidnight(now),
        );
      }

      // 2 — monthly data points.
      const monthStart = utcMonthStart(now);
      const points = ctx.dataPoints ?? 0;
      if (points > 0 || limits.monthlyDataPoints <= 0) {
        const used = await monthlyUsed(ctx.userId, monthStart);
        if (used + points > limits.monthlyDataPoints) {
          return rejection(
            'monthlyDataPoints',
            used,
            limits.monthlyDataPoints,
            nextUtcMonthStart(now),
          );
        }
      }

      // 3 — concurrent subscriptions. The caller reports the count that would be live; the plant
      // holds it in memory, so there is nothing to read here.
      const subs = ctx.concurrentSubs;
      if (subs !== undefined) {
        const limit = concurrencyLimit(resolved, ctx.clientKind);
        if (subs > limit) {
          return rejection('concurrentSubscriptions', subs, limit, nextUtcMidnight(now));
        }
      }

      return { ok: true };
    },

    async record(ctx: QuotaRecordContext): Promise<void> {
      const now = clock.now();
      const ids = normaliseIds(ctx.instrumentIds);
      if (ids.length > 0) {
        await db.execute(sql`
          INSERT INTO quota_instruments_seen (user_id, day, instrument_id)
          SELECT ${ctx.userId}, ${utcDay(now)}::date, x
            FROM unnest(${bigintArrayLiteral(ids)}::bigint[]) AS x
          ON CONFLICT (user_id, day, instrument_id) DO NOTHING`);
      }

      const points = ctx.dataPoints ?? 0;
      if (points > 0) {
        await db.execute(sql`
          INSERT INTO quota_counters (user_id, window_kind, window_start, data_points)
          VALUES (${ctx.userId}, 'month', ${utcMonthStart(now)}::date, ${points})
          ON CONFLICT (user_id, window_kind, window_start)
          DO UPDATE SET data_points = quota_counters.data_points + EXCLUDED.data_points`);
      }
    },

    async state(
      userId: number,
      firmId: number,
      clientKind: 'web' | 'api',
      concurrentSubs?: number,
    ): Promise<QuotaState> {
      const now = clock.now();
      const resolved = await resolve(userId, firmId);
      const counts = await instrumentCounts(userId, utcDay(now), []);
      const used = await monthlyUsed(userId, utcMonthStart(now));
      return {
        dailyUniqueInstruments: {
          used: counts.used,
          limit: resolved.limits.dailyUniqueInstruments,
          resetsAt: nextUtcMidnight(now),
        },
        monthlyDataPoints: {
          used,
          limit: resolved.limits.monthlyDataPoints,
          resetsAt: nextUtcMonthStart(now),
        },
        concurrentSubscriptions: {
          used: concurrentSubs ?? 0,
          limit: concurrencyLimit(resolved, clientKind),
          // A live gauge has no scheduled reset; the daily boundary is the honest horizon to
          // report, and `Rest.Auth.QuotaUsage.resetsAt` is a required ISO instant.
          resetsAt: nextUtcMidnight(now),
        },
        enforced: clientKind === 'api',
      };
    },
  };
}
