/**
 * WORKPLAN WP-07 acceptance row — `test/integration/entitlements/quotas.test.ts`: "daily unique
 * instrument cap, monthly data-point cap, concurrent-subscription cap; 429 envelope shape from
 * API.md §8".
 *
 * Every cap is asserted at three points — `limit - 1`, `limit` and `limit + 1` — because an
 * off-by-one here either sells a customer one request less than they paid for or gives away an
 * unbounded one. The ceilings are lowered to single digits through `quota_limits` so the boundary
 * is reachable in a test; the code path is the production one.
 *
 * Self-sufficient: the firm, the user and their `quota_limits` rows are created inside this file's
 * own `withTxDb()` transaction, which is also the `Quotas` handle, so every counter written here
 * rolls back with it. Instrument ids are plain integers — `quota_instruments_seen` deliberately
 * carries no foreign key (migration 0011 L172), since it counts what a user looked at, not what
 * still exists.
 *
 * Time is the virtual clock's, which is what makes the UTC-day boundary assertable: the last test
 * walks the clock past midnight and watches the daily counter start again while the monthly one
 * does not.
 */

import { randomUUID } from 'node:crypto';

import { ErrorEnvelope } from '@terminal/sdk/wire/envelope';
import { QuotaResponse } from '@terminal/sdk/wire/rest/usage';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  quotaExceededError,
  quotas,
  DEFAULT_CONCURRENT_SUBSCRIPTIONS_API,
  DEFAULT_CONCURRENT_SUBSCRIPTIONS_WEB,
  DEFAULT_DAILY_UNIQUE_INSTRUMENTS,
  DEFAULT_MONTHLY_DATA_POINTS,
  type Quotas,
} from '../../../src/entitlements/quotas.js';
import { registerErrorHandling } from '../../../src/http/errors.js';
import { registerTrace } from '../../../src/http/trace.js';
import { testClock, TEST_NOW, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t: TestDb = withTxDb();

interface Principal {
  userId: number;
  firmId: number;
}

/** A firm and one user of it. `quota_counters` has a foreign key to `users`, so both are real. */
async function seedPrincipal(): Promise<Principal> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Quota Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Quota User', 'user') RETURNING user_id`,
    [firmId, `quota-${randomUUID()}@demo.invalid`],
  );
  return { userId: Number(user.rows[0]!.user_id), firmId };
}

async function setLimits(
  subject: 'user' | 'firm',
  subjectId: number,
  limits: { daily?: number; monthly?: number; concurrent?: number } = {},
): Promise<void> {
  await t.client.query(
    `INSERT INTO quota_limits (subject_kind, subject_id, daily_unique_instruments,
                               monthly_data_points, concurrent_subscriptions)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subject_kind, subject_id) DO UPDATE
        SET daily_unique_instruments = EXCLUDED.daily_unique_instruments,
            monthly_data_points      = EXCLUDED.monthly_data_points,
            concurrent_subscriptions = EXCLUDED.concurrent_subscriptions`,
    [
      subject,
      subjectId,
      limits.daily ?? DEFAULT_DAILY_UNIQUE_INSTRUMENTS,
      limits.monthly ?? DEFAULT_MONTHLY_DATA_POINTS,
      limits.concurrent ?? DEFAULT_CONCURRENT_SUBSCRIPTIONS_API,
    ],
  );
}

function build(clock: VirtualClock = testClock()): { q: Quotas; clock: VirtualClock } {
  return { q: quotas({ db: t.db, clock }), clock };
}

/** Distinct instrument ids that cannot collide with another test's. */
function instrumentIds(base: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => base + i);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Limit resolution
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('limit resolution', () => {
  it('falls back to the documented defaults when neither subject has a row', async () => {
    const { userId, firmId } = await seedPrincipal();
    const { q } = build();
    expect(await q.limitsFor(userId, firmId)).toEqual({
      dailyUniqueInstruments: 500,
      monthlyDataPoints: 2_000_000,
      concurrentSubscriptions: 2_000,
    });
  });

  it('prefers the user row over the firm row', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('firm', firmId, { daily: 50, monthly: 5_000, concurrent: 25 });
    const { q } = build();
    expect(await q.limitsFor(userId, firmId)).toMatchObject({ dailyUniqueInstruments: 50 });

    await setLimits('user', userId, { daily: 7, monthly: 70, concurrent: 3 });
    expect(await q.limitsFor(userId, firmId)).toEqual({
      dailyUniqueInstruments: 7,
      monthlyDataPoints: 70,
      concurrentSubscriptions: 3,
    });
  });

  it('gives a web session the 10 000 concurrency ceiling only when nobody wrote a row', async () => {
    const { userId, firmId } = await seedPrincipal();
    const { q } = build();

    const web = await q.state(userId, firmId, 'web', 0);
    expect(web.concurrentSubscriptions.limit).toBe(DEFAULT_CONCURRENT_SUBSCRIPTIONS_WEB);
    const api = await q.state(userId, firmId, 'api', 0);
    expect(api.concurrentSubscriptions.limit).toBe(DEFAULT_CONCURRENT_SUBSCRIPTIONS_API);

    // An explicit row is an explicit decision and is honoured for both kinds.
    await setLimits('user', userId, { concurrent: 11 });
    expect((await q.state(userId, firmId, 'web', 0)).concurrentSubscriptions.limit).toBe(11);
    expect((await q.state(userId, firmId, 'api', 0)).concurrentSubscriptions.limit).toBe(11);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Daily unique instruments
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('daily unique instruments', () => {
  const LIMIT = 3;

  it('fires at the boundary: limit-1 passes, limit passes, limit+1 is refused', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { daily: LIMIT });
    const { q } = build();
    const ids = instrumentIds(910_000, 4);

    // limit - 1: two fresh instruments take the day to 2 of 3.
    const below = await q.check({
      userId,
      firmId,
      clientKind: 'api',
      instrumentIds: ids.slice(0, 2),
    });
    expect(below).toEqual({ ok: true });
    await q.record({ userId, firmId, instrumentIds: ids.slice(0, 2) });

    // limit: the third fresh instrument is the last one that fits.
    const at = await q.check({ userId, firmId, clientKind: 'api', instrumentIds: [ids[2]!] });
    expect(at).toEqual({ ok: true });
    await q.record({ userId, firmId, instrumentIds: [ids[2]!] });

    // limit + 1: the fourth is refused, and the rejection says exactly where the caller stands.
    const over = await q.check({ userId, firmId, clientKind: 'api', instrumentIds: [ids[3]!] });
    expect(over).toEqual({
      ok: false,
      quota: 'dailyUniqueInstruments',
      used: LIMIT,
      limit: LIMIT,
      resetsAt: '2026-09-18T00:00:00.000Z',
    });

    // It really is the DAY's distinct count: nothing was written by the refused check.
    const state = await q.state(userId, firmId, 'api');
    expect(state.dailyUniqueInstruments.used).toBe(LIMIT);
  });

  it('charges nothing for an instrument already seen today, even at the cap', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { daily: LIMIT });
    const { q } = build();
    const ids = instrumentIds(920_000, 3);

    await q.record({ userId, firmId, instrumentIds: ids });
    expect((await q.state(userId, firmId, 'api')).dailyUniqueInstruments.used).toBe(LIMIT);

    // At the cap, re-reading a known instrument still works — the quota is on distinct names.
    expect(await q.check({ userId, firmId, clientKind: 'api', instrumentIds: [ids[0]!] })).toEqual({
      ok: true,
    });
    // …and a new one does not.
    expect(
      await q.check({ userId, firmId, clientKind: 'api', instrumentIds: [999_999] }),
    ).toMatchObject({ ok: false, quota: 'dailyUniqueInstruments' });
  });

  it('counts a repeated instrument once: record() is insert-if-absent', async () => {
    const { userId, firmId } = await seedPrincipal();
    const { q } = build();
    const id = 930_001;

    await q.record({ userId, firmId, instrumentIds: [id, id, id] });
    await q.record({ userId, firmId, instrumentIds: [id] });

    const seen = await t.client.query<{ n: string }>(
      `SELECT count(*) AS n FROM quota_instruments_seen WHERE user_id = $1`,
      [userId],
    );
    expect(Number(seen.rows[0]!.n)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Monthly data points
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('monthly data points', () => {
  const LIMIT = 1_000;

  it('fires at the boundary: limit-1 passes, limit passes, limit+1 is refused', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { monthly: LIMIT });
    const { q } = build();

    expect(await q.check({ userId, firmId, clientKind: 'api', dataPoints: LIMIT - 1 })).toEqual({
      ok: true,
    });
    await q.record({ userId, firmId, dataPoints: LIMIT - 1 });

    // Exactly the last point that fits.
    expect(await q.check({ userId, firmId, clientKind: 'api', dataPoints: 1 })).toEqual({
      ok: true,
    });
    await q.record({ userId, firmId, dataPoints: 1 });

    expect(await q.check({ userId, firmId, clientKind: 'api', dataPoints: 1 })).toEqual({
      ok: false,
      quota: 'monthlyDataPoints',
      used: LIMIT,
      limit: LIMIT,
      resetsAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('refuses a single request that would blow through the ceiling on its own', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { monthly: LIMIT });
    const { q } = build();
    expect(
      await q.check({ userId, firmId, clientKind: 'api', dataPoints: LIMIT + 1 }),
    ).toMatchObject({ ok: false, quota: 'monthlyDataPoints', used: 0, limit: LIMIT });
  });

  it('accumulates into one row per calendar month', async () => {
    const { userId, firmId } = await seedPrincipal();
    const { q } = build();
    await q.record({ userId, firmId, dataPoints: 40 });
    await q.record({ userId, firmId, dataPoints: 2 });

    const rows = await t.client.query<{
      window_kind: string;
      window_start: string;
      data_points: string;
    }>(
      `SELECT window_kind, window_start::text AS window_start, data_points::text AS data_points
         FROM quota_counters WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows).toEqual([
      { window_kind: 'month', window_start: '2026-09-01', data_points: '42' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Concurrent subscriptions
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('concurrent subscriptions', () => {
  const LIMIT = 5;

  it('fires at the boundary: limit-1 passes, limit passes, limit+1 is refused', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { concurrent: LIMIT });
    const { q } = build();
    const ctx = { userId, firmId, clientKind: 'api' as const };

    expect(await q.check({ ...ctx, concurrentSubs: LIMIT - 1 })).toEqual({ ok: true });
    expect(await q.check({ ...ctx, concurrentSubs: LIMIT })).toEqual({ ok: true });
    expect(await q.check({ ...ctx, concurrentSubs: LIMIT + 1 })).toEqual({
      ok: false,
      quota: 'concurrentSubscriptions',
      used: LIMIT + 1,
      limit: LIMIT,
      resetsAt: '2026-09-18T00:00:00.000Z',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// web vs api (API.md §8 L1131)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('web sessions are counted but never blocked', () => {
  it('passes a web check that an api check on the same state refuses', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { daily: 1, monthly: 1, concurrent: 1 });
    const { q } = build();
    const ids = instrumentIds(940_000, 2);

    await q.record({ userId, firmId, instrumentIds: [ids[0]!], dataPoints: 1 });

    const over = {
      userId,
      firmId,
      instrumentIds: [ids[1]!],
      dataPoints: 5,
      concurrentSubs: 9,
    };
    expect(await q.check({ ...over, clientKind: 'api' })).toMatchObject({ ok: false });
    expect(await q.check({ ...over, clientKind: 'web' })).toEqual({ ok: true });
  });

  it('still counts a web session and reports it with enforced: false', async () => {
    const { userId, firmId } = await seedPrincipal();
    const { q } = build();
    await q.record({ userId, firmId, instrumentIds: instrumentIds(950_000, 4), dataPoints: 17 });

    const state = await q.state(userId, firmId, 'web', 6);
    expect(state.enforced).toBe(false);
    expect(state.dailyUniqueInstruments.used).toBe(4);
    expect(state.monthlyDataPoints.used).toBe(17);
    expect(state.concurrentSubscriptions.used).toBe(6);

    // The api session reports the same counters and enforces them.
    expect((await q.state(userId, firmId, 'api', 6)).enforced).toBe(true);
  });

  it('serves exactly `Rest.Usage.QuotaResponse`', async () => {
    const { userId, firmId } = await seedPrincipal();
    const { q } = build();
    const state = await q.state(userId, firmId, 'api', 3);
    expect(QuotaResponse.parse(state)).toEqual(state);
    expect(state.dailyUniqueInstruments.resetsAt).toBe('2026-09-18T00:00:00.000Z');
    expect(state.monthlyDataPoints.resetsAt).toBe('2026-10-01T00:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The UTC windows
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('windows', () => {
  it('starts the daily count again after UTC midnight and leaves the month alone', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { daily: 2 });
    const clock = testClock(TEST_NOW); // 2026-09-17T13:30Z
    const q = quotas({ db: t.db, clock });
    const ids = instrumentIds(960_000, 3);

    await q.record({ userId, firmId, instrumentIds: ids.slice(0, 2), dataPoints: 10 });
    expect(
      await q.check({ userId, firmId, clientKind: 'api', instrumentIds: [ids[2]!] }),
    ).toMatchObject({ ok: false, quota: 'dailyUniqueInstruments' });

    // 11 hours later it is 2026-09-18T00:30Z: a new day, the same month.
    clock.advance(11 * 60 * 60 * 1_000);
    expect(await q.check({ userId, firmId, clientKind: 'api', instrumentIds: [ids[2]!] })).toEqual({
      ok: true,
    });

    const state = await q.state(userId, firmId, 'api');
    expect(state.dailyUniqueInstruments.used).toBe(0);
    expect(state.dailyUniqueInstruments.resetsAt).toBe('2026-09-19T00:00:00.000Z');
    expect(state.monthlyDataPoints.used).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The 429 envelope (API.md §8, §2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the 429 envelope', () => {
  it('is the documented body: QUOTA_EXCEEDED with { quota, used, limit, resetsAt }', async () => {
    const { userId, firmId } = await seedPrincipal();
    await setLimits('user', userId, { daily: 1 });
    const { q } = build();
    await q.record({ userId, firmId, instrumentIds: [970_001] });

    // A route as a route will write it: check before any provider fetch, throw on a rejection,
    // and let `registerErrorHandling` turn it into the envelope of API.md §2.
    const app = Fastify({ logger: false });
    registerTrace(app);
    registerErrorHandling(app);
    app.get('/quota-probe', async () => {
      const check = await q.check({
        userId,
        firmId,
        clientKind: 'api',
        instrumentIds: [970_002],
      });
      if (!check.ok) throw quotaExceededError(check);
      return { ok: true };
    });
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: '/quota-probe' });
      expect(res.statusCode).toBe(429);

      const body: unknown = res.json();
      const envelope = ErrorEnvelope.parse(body);
      expect(envelope.error.code).toBe('QUOTA_EXCEEDED');
      expect(envelope.error.retryable).toBe(true);
      expect(envelope.error.traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(envelope.error.details).toEqual({
        quota: 'dailyUniqueInstruments',
        used: 1,
        limit: 1,
        resetsAt: '2026-09-18T00:00:00.000Z',
      });
    } finally {
      await app.close();
    }
  });

  it('refuses to build a 429 for a check that passed', () => {
    expect(() => quotaExceededError({ ok: true })).toThrow(/the check passed/);
  });
});
