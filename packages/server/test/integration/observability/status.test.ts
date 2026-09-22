/**
 * `test/integration/observability/status.test.ts` — `GET /status` and `GET /health` (API.md §5.15
 * L816-838, OPS-03 / OPS-04), WP-08.
 *
 * The assertion that matters is the first one: the body is parsed with the normative
 * `Rest.Status.StatusResponse` schema, so a field this server renames, drops or types differently
 * fails here rather than on somebody's screen. After that the file proves the numbers come from
 * somewhere real — an incident row, a dq row, a failed ingest run and a `usage_events` duration
 * are written into this test's own transaction and then looked for in the response.
 *
 * `/health` is asked twice: at the root (the liveness alias `app.ts` registers for probes that
 * cannot know the API prefix) and under `/api/v1` (the documented path, served by the generated
 * barrel). Both must answer, and a process that has not reached startup step 8 must say `503
 * STARTING` while still reporting *why*.
 *
 * Self-sufficient: firm, user and session are created inside this file's `withTxDb()`
 * transaction, which is also the app's handle. Time is the virtual clock at `TEST_NOW`.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FIELD_DICTIONARY_VERSION, registry } from '@terminal/core';
import { HealthResponse, StatusResponse } from '@terminal/sdk/wire/rest/status';

import { getConfig } from '../../../src/config.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, TEST_NOW_ISO } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

const t: TestDb = withTxDb();
const clock = testClock();

let harness: TestApp;
let app: FastifyInstance;
let sessionCookie: string;

beforeEach(async () => {
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;

  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`Status Firm ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, 'Status User', 'user') RETURNING user_id`,
    [firmId, `status-${randomUUID()}@demo.invalid`],
  );
  const userId = Number(user.rows[0]!.user_id);

  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  sessionCookie = `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`;
});

afterEach(async () => {
  await harness.close();
});

async function status(): Promise<{ statusCode: number; body: StatusResponse; payload: string }> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/status',
    headers: { cookie: sessionCookie },
  });
  return {
    statusCode: res.statusCode,
    payload: res.payload,
    body: res.statusCode === 200 ? StatusResponse.parse(JSON.parse(res.payload)) : ({} as never),
  };
}

describe('GET /status (OPS-04)', () => {
  it('returns exactly the documented StatusResponse', async () => {
    const res = await status();
    expect(res.statusCode, res.payload).toBe(200);

    // Identity comes from the running binary, not from a literal.
    expect(res.body.serverTime).toBe(TEST_NOW_ISO);
    expect(res.body.dictionaryVersion).toBe(FIELD_DICTIONARY_VERSION);
    expect(res.body.registryVersion).toBe(registry.version);
    expect(res.body.protocol).toEqual([1]);
    expect(res.body.providerMode).toBe(getConfig().PROVIDER_MODE);

    // The three calendars §5.15 names, each with a state the plant would agree with.
    expect(res.body.sessions.map((s) => s.calendarId)).toEqual(['NYSE', 'SIFMA', 'FX']);
    for (const session of res.body.sessions) {
      expect(session.nextChangeAt === null || session.nextChangeAt > res.body.serverTime).toBe(true);
    }

    // The conflation floor is lifted exactly when the plant says it is degraded.
    expect(res.body.plant.conflationFloorMs).toBe(res.body.plant.state === 'degraded' ? 1_000 : 0);
    expect(res.body.ws.sessions).toBe(0);
  });

  it('counts open dq events by kind', async () => {
    await t.client.query(
      `INSERT INTO dq_events (ts, kind, severity, subject)
       VALUES (now(), 'stale_tick', 'warn', $1),
              (now(), 'stale_tick', 'warn', $2),
              (now(), 'missing_close', 'error', $3),
              (now(), 'parse_error', 'error', $4)`,
      [`q:${randomUUID()}`, `q:${randomUUID()}`, `q:${randomUUID()}`, `q:${randomUUID()}`],
    );
    // A resolved event is not open and must not be counted.
    await t.client.query(
      `INSERT INTO dq_events (ts, kind, severity, subject, resolved_at)
       VALUES (now(), 'poll_anomaly', 'info', $1, now())`,
      [`q:${randomUUID()}`],
    );

    const res = await status();
    const byKind: Record<string, number> = res.body.dq.byKind;
    expect(byKind.stale_tick ?? 0).toBeGreaterThanOrEqual(2);
    expect(byKind.missing_close ?? 0).toBeGreaterThanOrEqual(1);
    expect(res.body.dq.open).toBe(
      Object.values(byKind).reduce((sum, n) => sum + n, 0),
    );
  });

  it('reports open incidents and the last scheduler failures', async () => {
    const title = `Trace incident ${randomUUID().slice(0, 8)}`;
    await t.client.query(
      `INSERT INTO status_incidents (opened_at, component, severity, title, updates)
       VALUES (now(), 'provider:cboe.quotes', 'degraded', $1, $2::jsonb)`,
      [title, JSON.stringify([{ ts: TEST_NOW_ISO, text: 'Investigating.' }])],
    );
    // A closed incident is history, not status.
    await t.client.query(
      `INSERT INTO status_incidents (opened_at, closed_at, component, severity, title)
       VALUES (now(), now(), 'plant', 'outage', $1)`,
      [`closed ${randomUUID().slice(0, 8)}`],
    );

    const jobId = `statusJob${randomUUID().slice(0, 6)}`;
    await t.client.query(
      `INSERT INTO ingest_runs (job_id, source_id, started_at, finished_at, status, errors)
       VALUES ($1, 'cboe.quotes', now(), now(), 'failed', $2::jsonb)`,
      [jobId, JSON.stringify([{ code: 'HTTP_503', message: 'upstream down' }])],
    );

    const res = await status();
    const incident = res.body.incidents.find((i) => i.title === title);
    expect(incident, 'the open incident is missing').toBeDefined();
    expect(incident!.severity).toBe('degraded');
    expect(incident!.updates).toEqual([{ ts: TEST_NOW_ISO, text: 'Investigating.' }]);
    expect(res.body.incidents.some((i) => i.title.startsWith('closed '))).toBe(false);

    const failure = res.body.scheduler.lastFailures.find((f) => f.jobId === jobId);
    expect(failure, 'the failed run is missing').toBeDefined();
    expect(failure!.code).toBe('HTTP_503');
  });

  it('reports fnLaunchP95Ms from the durations usage_events recorded', async () => {
    const firm = await t.client.query<{ firm_id: string }>(
      `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
      [`Timing Firm ${randomUUID().slice(0, 8)}`],
    );
    const firmId = Number(firm.rows[0]!.firm_id);
    const user = await t.client.query<{ user_id: string }>(
      `INSERT INTO users (firm_id, email, display_name, role)
       VALUES ($1, $2, 'Timing', 'user') RETURNING user_id`,
      [firmId, `timing-${randomUUID()}@demo.invalid`],
    );
    const code = `Z${randomUUID().slice(0, 3).toUpperCase()}`;
    await t.client.query(
      `INSERT INTO usage_events (ts, user_id, firm_id, kind, code, duration_ms)
       VALUES (now(), $1, $2, 'fn.launch', $3, 42)`,
      [Number(user.rows[0]!.user_id), firmId, code],
    );

    const res = await status();
    expect(res.body.timings.fnLaunchP95Ms[code]).toBe(42);
  });

  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(res.statusCode).toBe(401);
    expect((JSON.parse(res.payload) as { error: { code: string } }).error.code).toBe(
      'AUTH_REQUIRED',
    );
  });
});

describe('GET /health (OPS-03)', () => {
  it('answers the documented shape at the root and under /api/v1', async () => {
    for (const url of ['/health', '/api/v1/health']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url}: ${res.payload}`).toBe(200);
      const body = HealthResponse.parse(JSON.parse(res.payload));
      expect(body.db).toBe(true);
      expect(body.scheduler).toBe(true);
      expect(body.migrationsPending).toBe(0);
      // The documented verdict is the conjunction, not a constant: a test app builds its plant
      // but never calls `start()`, so `plant` is false and the honest answer is `degraded`.
      expect(body.plant).toBe(false);
      expect(body.status).toBe(
        body.db && body.plant && body.scheduler && body.migrationsPending === 0 ? 'ok' : 'degraded',
      );
      expect(body.uptimeS).toBeGreaterThanOrEqual(0);
      // Public: no session, and no trace header requirement.
      expect(res.headers['x-trace-id']).toBeDefined();
    }
  });

  it('is 503 STARTING until startup step 8, and still says why', async () => {
    const starting = await createTestApp({ db: t.db, clock, state: { phase: 'starting' } });
    try {
      const res = await starting.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('2');
      const body = HealthResponse.parse(JSON.parse(res.payload));
      expect(body.status).toBe('starting');
      expect(body.db).toBe(true);
    } finally {
      await starting.close();
    }
  });
});
