/**
 * API.md §8 on the WP-08 route groups: the per-session rate limits (L1165-1176), the three quota
 * headers (L1160-1162), and the API-key scopes that decide who may read the instrument master at
 * all (API-01).
 *
 * Each case here exists because an adversarial audit drove the real app and found the rule absent:
 *
 *  - **Rate limits.** 120 consecutive `GET /search`, 120 `GET /fields` and 20 `POST /data/csv` all
 *    returned `200`. The only token bucket in the tree was WP-07's `/auth/login` one, so a single
 *    API key could drive the search fallback, the tick reader and the CSV exporter as fast as it
 *    could issue requests. The buckets are keyed on `request.principal.sessionId` — never on a
 *    header the caller writes — and refill on the injected clock, which is why these tests advance
 *    a `VirtualClock` instead of sleeping.
 *  - **Quota headers.** `x-quota-daily-instruments`, `x-quota-monthly-datapoints` and
 *    `x-quota-concurrent-subs` were absent from every data-bearing response, so the status bar had
 *    no way to warn a user before the request that exceeds a ceiling fails.
 *  - **Double charging.** One bearer `POST /data` for 1 security × 1 field moved
 *    `quota_counters.data_points` by 2 while that response's `meta.quota.dataPointsCharged` said 1
 *    — the evaluator's rule 8 and the dispatcher's quota port each charged the same cells. An API
 *    key therefore tripped its ceiling at half the documented allowance.
 *  - **Scopes.** A key minted with an EMPTY scope list still read `GET /universe/snapshot` (the
 *    whole instrument universe) and `GET /search`, and still performed workspace writes.
 *
 * Self-sufficient (TESTING §4.3): firm, users, sessions, API keys, grants and the instrument are
 * written inside this file's own `withTxDb()` transaction, which is also the app's handle.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FieldId } from '@terminal/core';

import { getConfig } from '../../../src/config.js';
import { QUOTA_HEADERS } from '../../../src/http/routes/data.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, TEST_NOW, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';

/** `NAME` resolves here in `field_licence`; the fixture firm holds a grant for it. */
const DERIVED_SOURCE = 'internal.derived';

/** Well before `TEST_NOW`, so a grant written with it is live on the virtual clock. */
const GRANT_FROM = '2026-01-01T00:00:00.000Z';

const t: TestDb = withTxDb();

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  /** A bearer key carrying the three scopes WP-07 mints. */
  bearer: string;
  /** A bearer key carrying NO scopes at all. */
  scopeless: string;
  userId: number;
  firmId: number;
  instrumentId: number;
  display: string;
}

let env: Env;

/**
 * The shipped licence terms, seeded only when they are missing.
 *
 * `seedLicences` is idempotent but not *silent*: on a database `test/globalSetup.ts` already
 * seeded, it still issues its inserts and updates against `licence_registry`, `field_licence` and
 * `config_versions` — rows every other integration file is also writing from its own open
 * transaction, in its own fork. Two transactions holding one of those keys and waiting for the
 * other is a deadlock, and which files a run happens to schedule together then decides whether it
 * is green. (`vitest.config.ts` records the same hazard for the replay project and solves it by
 * serialising.) A read first means the common case takes no locks at all, while a database with
 * no seed still gets one.
 */
async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

beforeEach(async () => {
  await ensureLicences();

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Limits Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);

  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Limits User', 'user') RETURNING user_id`,
    [firmId, `limits-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);

  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );

  const bearer = await insertApiSession(userId, ['data:read', 'fn:run', 'ws:subscribe']);
  const scopeless = await insertApiSession(userId, []);

  await grantSource(firmId, userId, DERIVED_SOURCE);

  const seeded = await seedQuoteInstrument(t, {
    ticker: `LM${randomUUID().slice(0, 3).toUpperCase()}`,
    name: 'Limits Fixture Inc',
  });
  const tickerRow = await t.client.query<{ ticker: string }>(
    `SELECT ticker FROM instruments WHERE instrument_id = $1 AND tx_to = 'infinity' LIMIT 1`,
    [seeded.instrumentId],
  );
  const display = `${tickerRow.rows[0]!.ticker} US Equity`;

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const clock = testClock(Math.max(TEST_NOW, Date.parse(wrote.rows[0]!.at) + 1_000));
  const harness = await createTestApp({ db: t.db, clock });

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
    bearer,
    scopeless,
    userId,
    firmId,
    instrumentId: seeded.instrumentId,
    display,
  };
});

afterEach(async () => {
  await env.harness.close();
});

/** A `client_kind='api'` session behind a key carrying exactly `scopes`; returns the raw token. */
async function insertApiSession(userId: number, scopes: readonly string[]): Promise<string> {
  const token = `tok-${randomUUID()}`;
  const key = await t.client.query<{ api_key_id: string }>(
    `INSERT INTO api_keys (user_id, key_hash, label, scopes)
     VALUES ($1, $2, 'limits test key', $3) RETURNING api_key_id`,
    [userId, createHash('sha256').update(`key-${token}`, 'utf8').digest(), [...scopes]],
  );
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, api_key_id, expires_at, mfa_verified)
     VALUES ($1, $2, 'api', $3, now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest(), Number(key.rows[0]!.api_key_id)],
  );
  return token;
}

/** One grant for the firm and one for the user: the evaluator (rules 4-5) requires both. */
async function grantSource(firmId: number, userId: number, sourceId: string): Promise<void> {
  for (const [kind, id] of [
    ['firm', firmId],
    ['user', userId],
  ] as const) {
    await t.client.query(
      `INSERT INTO entitlement_grants
         (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
          usage_display, usage_export, usage_api, valid_from, valid_to)
       VALUES ($1, $2, $3, NULL, NULL, 'realtime'::tier, true, true, true,
               $4::timestamptz, 'infinity'::timestamptz)`,
      [kind, id, sourceId, GRANT_FROM],
    );
  }
}

function webHeaders(): Record<string, string> {
  return { cookie: env.cookie, 'x-requested-with': 'terminal' };
}

function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function inject(options: InjectOptions): ReturnType<FastifyInstance['inject']> {
  return env.app.inject(options);
}

/** Fire `n` identical requests in order and return the status codes. */
async function repeat(n: number, options: InjectOptions): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i += 1) codes.push((await inject(options)).statusCode);
  return codes;
}

/** `sum(quota_counters.data_points)` for this user, across both windows. */
async function chargedPoints(userId: number): Promise<number> {
  const res = await t.client.query<{ total: string | null }>(
    `SELECT sum(data_points)::text AS total FROM quota_counters WHERE user_id = $1`,
    [userId],
  );
  return Number(res.rows[0]?.total ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rate limits (API.md §8 L1165-1176)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('route rate limits', () => {
  it('REST is 20 req/s with a burst of 60, per session, and then 429 RATE_LIMITED', async () => {
    const options: InjectOptions = { method: 'GET', url: `${API}/functions`, headers: webHeaders() };

    // The burst, all on the same virtual instant: the bucket cannot refill.
    const burst = await repeat(60, options);
    expect(burst.every((code) => code === 200)).toBe(true);

    const over = await inject(options);
    expect(over.statusCode).toBe(429);
    const body = over.json<{ error: { code: string; retryable: boolean; retryAfterMs: number } }>();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    // API.md §2 L189: `retryAfterMs` is also the `Retry-After` header, in seconds.
    expect(over.headers['retry-after']).toBeDefined();

    // One second of refill buys 20 more requests, and the 21st is refused again.
    env.clock.advance(1_000);
    const refilled = await repeat(20, options);
    expect(refilled.every((code) => code === 200)).toBe(true);
    expect((await inject(options)).statusCode).toBe(429);
  });

  it('is keyed on the SESSION, so a second session has its own budget', async () => {
    const options: InjectOptions = { method: 'GET', url: `${API}/functions`, headers: webHeaders() };
    await repeat(60, options);
    expect((await inject(options)).statusCode).toBe(429);

    // Same user, different session: an exhausted cookie session must not lock the key out, and an
    // exhausted key must not lock the human out.
    const other = await inject({
      method: 'GET',
      url: `${API}/functions`,
      headers: bearerHeaders(env.bearer),
    });
    expect(other.statusCode).toBe(200);
  });

  it('cannot be evaded by varying X-Forwarded-For (the key is not a header)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      const res = await inject({
        method: 'GET',
        url: `${API}/functions`,
        headers: { ...webHeaders(), 'x-forwarded-for': `203.0.113.${String(i)}` },
      });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
  });

  it('/search has its own 30 req/s bucket, separate from the REST one', async () => {
    const search: InjectOptions = {
      method: 'GET',
      url: `${API}/search?q=lim`,
      headers: webHeaders(),
    };

    // Spending the REST budget does not touch the search budget…
    await repeat(60, { method: 'GET', url: `${API}/functions`, headers: webHeaders() });
    expect((await inject(search)).statusCode).toBe(200);

    // …and /search has a burst of 60 of its own.
    const burst = await repeat(59, search);
    expect(burst.every((code) => code === 200)).toBe(true);
    expect((await inject(search)).statusCode).toBe(429);
  });

  it('the export routes are 2 req/s (API.md §8 gives §9 its own, much tighter row)', async () => {
    const csv: InjectOptions = {
      method: 'POST',
      url: `${API}/data/csv`,
      headers: webHeaders(),
      payload: {
        kind: 'reference',
        securities: [{ ref: env.display }],
        fields: ['NAME'] satisfies FieldId[],
      },
    };

    const first = await inject(csv);
    expect(first.statusCode, first.payload).toBe(200);
    // §8's headers are on an export too: a file that left the building was charged like any read.
    expect(String(first.headers[QUOTA_HEADERS.monthly])).toMatch(/^\d+\/\d+$/);

    expect((await inject(csv)).statusCode).toBe(200);
    const third = await inject(csv);
    expect(third.statusCode).toBe(429);
    expect(third.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
  });

  it('a ten-year history is a heavy read too, and a one-year history is not', async () => {
    const history = (start: string): InjectOptions => ({
      method: 'POST',
      url: `${API}/data`,
      headers: webHeaders(),
      payload: {
        kind: 'historical',
        securities: [{ ref: env.display }],
        fields: ['PX_LAST'] satisfies FieldId[],
        start,
        end: '2026-09-15',
      },
    });

    // §8 rates the span, not the route: five over a decade, then refused.
    const long = await repeat(5, history('2010-01-01'));
    expect(long.every((code) => code !== 429)).toBe(true);
    expect((await inject(history('2010-01-01'))).statusCode).toBe(429);

    // A one-year read on the same session is still served — it never touched that bucket.
    const short = await inject(history('2025-09-15'));
    expect(short.statusCode).not.toBe(429);
  });

  it('a tick read spends a heavy-read token as well as a REST one (5 req/s)', async () => {
    const ticks: InjectOptions = {
      method: 'POST',
      url: `${API}/data`,
      headers: webHeaders(),
      payload: {
        kind: 'tick',
        securities: [{ ref: env.display }],
        start: '2026-09-15T13:30:00.000Z',
        end: '2026-09-15T20:00:00.000Z',
      },
    };

    // Five go through on the heavy bucket; the sixth is refused even though the REST bucket
    // (burst 60) still has plenty left.
    const first = await repeat(5, ticks);
    expect(first.every((code) => code < 429)).toBe(true);
    const sixth = await inject(ticks);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json<{ error: { details?: { scope?: string } } }>().error.details?.scope).toBe(
      'data.heavy',
    );

    // …and an ordinary reference read on the same session is still served.
    const light = await inject({
      method: 'GET',
      url: `${API}/data/reference?securities=${encodeURIComponent(env.display)}&fields=NAME`,
      headers: webHeaders(),
    });
    expect(light.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Quota headers and the charge (API.md §8 L1160-1162)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('quota accounting', () => {
  it('stamps the three §8 headers on every data-bearing response', async () => {
    const pair = /^\d+\/\d+$/;

    for (const options of [
      {
        method: 'POST' as const,
        url: `${API}/data`,
        headers: webHeaders(),
        payload: {
          kind: 'reference',
          securities: [{ ref: env.display }],
          fields: ['NAME'] satisfies FieldId[],
        },
      },
      {
        method: 'GET' as const,
        url: `${API}/data/reference?securities=${encodeURIComponent(env.display)}&fields=NAME`,
        headers: webHeaders(),
      },
    ]) {
      const res = await inject(options);
      expect(res.statusCode, res.payload).toBe(200);
      expect(String(res.headers[QUOTA_HEADERS.daily])).toMatch(pair);
      expect(String(res.headers[QUOTA_HEADERS.monthly])).toMatch(pair);
      expect(String(res.headers[QUOTA_HEADERS.subs])).toMatch(pair);
    }
  });

  it('charges a bearer read EXACTLY meta.quota.dataPointsCharged, not twice', async () => {
    const before = await chargedPoints(env.userId);

    const res = await inject({
      method: 'POST',
      url: `${API}/data`,
      headers: bearerHeaders(env.bearer),
      payload: {
        kind: 'reference',
        securities: [{ ref: env.display }],
        fields: ['NAME'] satisfies FieldId[],
      },
    });
    expect(res.statusCode, res.payload).toBe(200);
    const charged = res.json<{ meta: { quota: { dataPointsCharged: number } } }>().meta.quota
      .dataPointsCharged;
    expect(charged).toBeGreaterThan(0);

    const after = await chargedPoints(env.userId);
    // The counter and the payload say the same number. Before the fix this was 2 against a
    // reported 1: evaluator rule 8 and the dispatcher's quota port each charged the same cells,
    // so an api key tripped `429 QUOTA_EXCEEDED` at half its documented allowance.
    expect(after - before).toBe(charged);
  });

  it('charges a cookie read the same way — one charge, reported', async () => {
    const before = await chargedPoints(env.userId);
    const res = await inject({
      method: 'GET',
      url: `${API}/data/reference?securities=${encodeURIComponent(env.display)}&fields=NAME`,
      headers: webHeaders(),
    });
    expect(res.statusCode, res.payload).toBe(200);
    const charged = res.json<{ meta: { quota: { dataPointsCharged: number } } }>().meta.quota
      .dataPointsCharged;
    expect(await chargedPoints(env.userId)).toBe(before + charged);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// API-key scopes (API-01)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('api key scopes on the instrument master', () => {
  const requiresDataRead = [
    () => `${API}/universe/snapshot`,
    () => `${API}/search?q=lim`,
    () => `${API}/ref/${String(env.instrumentId)}`,
  ];

  it('refuses a scopeless key everything that serves instrument master rows', async () => {
    for (const url of requiresDataRead) {
      const res = await inject({
        method: 'GET',
        url: url(),
        headers: bearerHeaders(env.scopeless),
      });
      expect(res.statusCode, `${url()}: ${res.body}`).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    }
  });

  it('serves the same routes to a key that holds data:read', async () => {
    for (const url of requiresDataRead) {
      const res = await inject({ method: 'GET', url: url(), headers: bearerHeaders(env.bearer) });
      expect(res.statusCode, `${url()}: ${res.body}`).toBe(200);
    }
  });

  it('lets a programmatic session READ a workspace and refuses it every write', async () => {
    const read = await inject({
      method: 'GET',
      url: `${API}/workspace`,
      headers: bearerHeaders(env.bearer),
    });
    expect(read.statusCode, read.body).toBe(200);
    const current = read.json<{ version: number; layout: unknown }>();

    const write = await inject({
      method: 'PUT',
      url: `${API}/workspace`,
      headers: bearerHeaders(env.bearer),
      payload: { version: current.version, layout: current.layout },
    });
    expect(write.statusCode, write.body).toBe(403);
    expect(write.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

    const created = await inject({
      method: 'POST',
      url: `${API}/workspaces`,
      headers: bearerHeaders(env.bearer),
      payload: { name: `from a key ${randomUUID().slice(0, 6)}`, layout: current.layout },
    });
    expect(created.statusCode, created.body).toBe(403);

    // The human whose panels they are is unaffected.
    const human = await inject({
      method: 'PUT',
      url: `${API}/workspace`,
      headers: webHeaders(),
      payload: { version: current.version, layout: current.layout },
    });
    expect(human.statusCode, human.body).toBe(200);
  });
});
