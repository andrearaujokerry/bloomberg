/**
 * WORKPLAN WP-08 acceptance row — `test/integration/observability/trace.test.ts`: "OPS-07: one
 * `x-trace-id` threads through `access_log`, `usage_events` and `provenance`, and
 * `/admin/trace/:traceId` returns all three".
 *
 * One uuid is minted by this file, put on the `x-trace-id` header of a real login and a real
 * telemetry post, and carried by hand into the writers the data path uses. At the end,
 * `GET /api/v1/admin/trace/:traceId` is asked for it, as an admin of the firm that produced it and
 * as an admin of a firm that did not.
 *
 * What is genuinely end to end here, and what is not:
 *
 *  - **The login is real.** `POST /auth/login` with a password set by `http/auth/password.ts`,
 *    against the shipped route. It proves `http/trace.ts` adopts a caller-supplied uuid and echoes
 *    it on the response of an unauthenticated route.
 *  - **The `usage_events` row is real.** `POST /usage/events` is WP-07's client batch route and it
 *    stamps `request.traceId` on every row it writes (`usage.ts` L192). This is the same row a
 *    function launch produces, written by the same table's only writer.
 *  - **The `access_log` rows are real.** They are produced by `entitlements/evaluator.ts` deciding
 *    a `PX_LAST` read against the shipped `licence_registry` (`seed/licences.ts` runs inside this
 *    transaction), with the batching `accessLog` writer attached — exactly the pair a data read
 *    wires. They are *not* produced by an HTTP call to `POST /data`, because `src/test/app.ts`
 *    deliberately attaches no `AccessLog` to the app's evaluator ("a test that asserts on
 *    `access_log` builds its own writer"), so the route could not write one.
 *  - **The `provenance` row is real**: `providers/provenance.ts#insertProvenance`, the only writer
 *    of that table, given the request's trace id as a read-through fetch gives it.
 *  - **The `ingest_runs` row** is inserted directly; the scheduler is not running in a test app.
 *
 * The isolation assertion is the point of the file. `access_log` and `usage_events` have a
 * `firm_id` column and **no RLS policy** (migration 0015 grants SELECT/INSERT and stops), so the
 * scoping lives in `observability/traceQuery.ts`'s SQL. An admin of another firm must get nothing
 * — and must not be able to tell a foreign trace from one that never existed.
 *
 * Self-sufficient (TESTING §4.3): two firms, three users, the licence tables, an instrument and a
 * grant, all created inside this file's own `withTxDb()` transaction, which is also the app's
 * database handle.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FieldId } from '@terminal/core';

import { getConfig } from '../../../src/config.js';
import { accessLog, type AccessLog } from '../../../src/entitlements/accessLog.js';
import { evaluator } from '../../../src/entitlements/evaluator.js';
import { licenceRegistry } from '../../../src/entitlements/licenceRegistry.js';
import { setPassword } from '../../../src/http/auth/password.js';
import { insertProvenance } from '../../../src/providers/provenance.js';
import type { RawRecord } from '../../../src/providers/types.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, TEST_NOW, TEST_NOW_ISO } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { seedQuoteInstrument } from '../ws/helpers.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t: TestDb = withTxDb();
const clock = testClock();

let harness: TestApp;
let app: FastifyInstance;

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
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;
});

afterEach(async () => {
  await harness.close();
});

/** Well before `TEST_NOW`, so a grant written with it is live on the virtual clock. */
const GRANT_FROM = '2026-01-01T00:00:00.000Z';

const PASSWORD = 'correct-horse-battery-staple';

interface Actor {
  userId: number;
  firmId: number;
  email: string;
  /** `Cookie:` header value — the signed `tsid` a browser would present. */
  cookie: string;
}

async function newFirm(label: string): Promise<number> {
  const res = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name, seat_count) VALUES ($1, 5) RETURNING firm_id`,
    [`Trace ${label} ${randomUUID().slice(0, 8)}`],
  );
  return Number(res.rows[0]!.firm_id);
}

async function newUser(firmId: number, role: string): Promise<{ userId: number; email: string }> {
  const email = `trace-${randomUUID()}@demo.invalid`;
  const res = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING user_id`,
    [firmId, email, `Trace ${role}`, role],
  );
  return { userId: Number(res.rows[0]!.user_id), email };
}

/** A live web session for `userId`, plus the signed cookie header for it. */
async function newSession(userId: number): Promise<string> {
  const token = `sess-${randomUUID()}`;
  const hash = createHash('sha256').update(token, 'utf8').digest();
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, hash],
  );
  const signed = cookie.sign(token, getConfig().SESSION_SECRET);
  return `tsid=${encodeURIComponent(signed)}`;
}

/**
 * A user of `firmId`, with a password set. `session: false` leaves them without one — which is
 * what the home user needs, because minting a session and then logging in would supersede the
 * first and write a second, unrelated `access_log` row on the login's own trace
 * (`http/auth/session.ts` L199-216).
 */
async function actor(firmId: number, role: string, session = true): Promise<Actor> {
  const { userId, email } = await newUser(firmId, role);
  await setPassword(t.db, userId, PASSWORD);
  return { userId, firmId, email, cookie: session ? await newSession(userId) : '' };
}

function headersFor(a: Actor, traceId: string): Record<string, string> {
  return { cookie: a.cookie, 'x-requested-with': 'terminal', 'x-trace-id': traceId };
}

async function insertGrant(subjectKind: 'user' | 'firm', subjectId: number): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     VALUES ($1, $2, NULL, NULL, NULL, 'realtime'::tier, true, true, true,
             $3::timestamptz, 'infinity'::timestamptz)`,
    [subjectKind, subjectId, GRANT_FROM],
  );
}

/** A 64-character lower-case hex digest, which is what `insertProvenance` insists on. */
function digest(of: string): string {
  return createHash('sha256').update(of, 'utf8').digest('hex');
}

/** One recorded provider exchange, as the read-through hands it to `insertProvenance`. */
function rawRecord(key: string): RawRecord {
  const body = Buffer.from('{"symbol":"TRACE","last":101.25}', 'utf8');
  return {
    providerId: 'cboe.quotes',
    method: 'GET',
    url: `https://cdn.cboe.com/api/global/delayed_quotes/quotes/TRACE.json?key=${key}`,
    requestKey: key,
    requestHash: digest(`request:${key}`),
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
    capturedAt: TEST_NOW,
    sha256: createHash('sha256').update(body).digest('hex'),
    sourceTs: null,
    origin: 'replay',
  };
}

interface TraceBody {
  traceId: string;
  requests: unknown[];
  accessLog: { fieldId: string | null; traceId: string | null; firmId: number; purpose: string }[];
  usageEvents: { kind: string; code?: string; traceId?: string }[];
  provenance: { sourceId: string; requestUrl: string; httpStatus: number; attribution: string }[];
  ingestRuns: { jobId: string; traceId: string | null }[];
  messages: unknown[];
  tickets: unknown[];
}

async function getTrace(a: Actor, traceId: string): Promise<{ status: number; body: TraceBody }> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/trace/${traceId}`,
    headers: { cookie: a.cookie },
  });
  return { status: res.statusCode, body: JSON.parse(res.payload) as TraceBody };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The thread
// ─────────────────────────────────────────────────────────────────────────────────────────────

const FIELDS: FieldId[] = ['PX_LAST', 'PX_BID'];

interface Threaded {
  traceId: string;
  home: Actor;
  homeAdmin: Actor;
  otherAdmin: Actor;
  log: AccessLog;
}

/**
 * Run one request's worth of work under a single trace id: a login, a telemetry post, an
 * entitlement decision on two fields, a provider fetch and a scheduler run.
 */
async function thread(): Promise<Threaded> {
  await ensureLicences();

  const homeFirm = await newFirm('Home');
  const otherFirm = await newFirm('Other');
  const home = await actor(homeFirm, 'user', false);
  const homeAdmin = await actor(homeFirm, 'admin');
  const otherAdmin = await actor(otherFirm, 'admin');
  await insertGrant('firm', homeFirm);
  await insertGrant('user', home.userId);

  const { instrumentId } = await seedQuoteInstrument(t, {
    ticker: `TR${randomUUID().slice(0, 4).toUpperCase()}`,
  });

  const traceId = randomUUID();

  // 1. The login, on the trace the client chose.
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-trace-id': traceId, 'x-requested-with': 'terminal' },
    payload: { email: home.email, password: PASSWORD, deviceId: `dev-${randomUUID()}` },
  });
  expect(login.statusCode, login.payload).toBe(200);
  expect(login.headers['x-trace-id']).toBe(traceId);

  // The home user had no session before this; the cookie the login set is the one they present
  // for the rest of the thread.
  const setCookie = login.headers['set-cookie'];
  const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie]).map(String);
  const tsid = cookies.find((value) => value.startsWith('tsid='));
  expect(tsid, 'login set no tsid cookie').toBeDefined();
  home.cookie = tsid!.split(';')[0]!;

  // 2. The launch telemetry a panel posts, on the same trace.
  const usage = await app.inject({
    method: 'POST',
    url: '/api/v1/usage/events',
    headers: headersFor(home, traceId),
    payload: {
      events: [
        {
          ts: TEST_NOW_ISO,
          kind: 'fn.launch',
          code: 'DES',
          instrumentId,
          durationMs: 42,
          details: {},
        },
      ],
    },
  });
  expect(usage.statusCode, usage.payload).toBeLessThan(300);

  // 3. The data read's entitlement decision — one `access_log` row per field (ENTL-04 rule 9).
  const registry = licenceRegistry({ db: t.db, clock });
  await registry.reload();
  const log = accessLog({ db: t.db, clock });
  const ev = evaluator({ db: t.db, clock, registry, log });
  const decision = await ev.evaluate({
    userId: home.userId,
    firmId: homeFirm,
    sessionId: randomUUID(),
    instrumentId,
    assetClass: 'equity',
    fieldIds: FIELDS,
    tier: 'delayed',
    usage: 'display',
    purpose: 'DES',
    traceId,
  });
  expect(decision.fields).toHaveLength(FIELDS.length);
  expect(await log.flush()).toBe(FIELDS.length);

  // 4. The provider fetch that read did, and 5. a scheduler run on the same trace.
  await insertProvenance(t.db, rawRecord(`trace-${randomUUID()}`), {
    adapterVersion: 'cboe/1.0.0',
    traceId,
  });
  await t.client.query(
    `INSERT INTO ingest_runs (job_id, source_id, started_at, finished_at, status, fetched, trace_id)
     VALUES ('cboeQuotes', 'cboe.quotes', $1::timestamptz, $1::timestamptz, 'ok', 1, $2::uuid)`,
    [TEST_NOW_ISO, traceId],
  );

  return { traceId, home, homeAdmin, otherAdmin, log };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('OPS-07 — one trace id, one string back to the raw response', () => {
  it('threads x-trace-id through access_log, usage_events and provenance', async () => {
    const { traceId, home, homeAdmin } = await thread();

    // The three tables hold it, before anything is asked of the route.
    const counts = await t.client.query<{ source: string; n: string }>(
      `SELECT 'access_log' AS source, count(*)::text AS n FROM access_log   WHERE trace_id = $1::uuid
       UNION ALL
       SELECT 'usage_events',          count(*)::text      FROM usage_events WHERE trace_id = $1::uuid
       UNION ALL
       SELECT 'provenance',            count(*)::text      FROM provenance   WHERE trace_id = $1::uuid
       UNION ALL
       SELECT 'ingest_runs',           count(*)::text      FROM ingest_runs  WHERE trace_id = $1::uuid`,
      [traceId],
    );
    const byTable = new Map(counts.rows.map((r) => [r.source, Number(r.n)]));
    expect(byTable.get('access_log')).toBe(FIELDS.length);
    expect(byTable.get('usage_events')).toBe(1);
    expect(byTable.get('provenance')).toBe(1);
    expect(byTable.get('ingest_runs')).toBe(1);

    // And the route returns all of them to an admin of the firm that produced them.
    const { status, body } = await getTrace(homeAdmin, traceId);
    expect(status).toBe(200);
    expect(body.traceId).toBe(traceId);

    expect(body.accessLog).toHaveLength(FIELDS.length);
    expect(body.accessLog.map((row) => row.fieldId).sort()).toEqual([...FIELDS].sort());
    for (const row of body.accessLog) {
      expect(row.traceId).toBe(traceId);
      expect(row.firmId).toBe(home.firmId);
      expect(row.purpose).toBe('DES');
    }

    expect(body.usageEvents).toHaveLength(1);
    expect(body.usageEvents[0]?.kind).toBe('fn.launch');
    expect(body.usageEvents[0]?.code).toBe('DES');
    expect(body.usageEvents[0]?.traceId).toBe(traceId);

    expect(body.provenance).toHaveLength(1);
    expect(body.provenance[0]?.sourceId).toBe('cboe.quotes');
    expect(body.provenance[0]?.httpStatus).toBe(200);
    expect(body.provenance[0]?.requestUrl).toContain('cboe.com');
    // From the shipped licence registry, not from a literal in this file.
    const attribution = await t.client.query<{ attribution: string }>(
      `SELECT attribution FROM licence_registry
        WHERE source_id = 'cboe.quotes' AND tx_to = 'infinity'
        ORDER BY valid_from DESC LIMIT 1`,
    );
    expect(body.provenance[0]?.attribution).toBe(attribution.rows[0]!.attribution);

    expect(body.ingestRuns).toHaveLength(1);
    expect(body.ingestRuns[0]?.jobId).toBe('cboeQuotes');

    // Nothing in this process records per-request rows; the key is present and honestly empty.
    expect(body.requests).toEqual([]);
  });

  it('gives an admin of another firm none of it, and no way to tell it exists', async () => {
    const { traceId, otherAdmin } = await thread();

    const foreign = await getTrace(otherAdmin, traceId);
    expect(foreign.status).toBe(200);
    expect(foreign.body.accessLog).toEqual([]);
    expect(foreign.body.usageEvents).toEqual([]);
    expect(foreign.body.provenance).toEqual([]);
    expect(foreign.body.ingestRuns).toEqual([]);
    expect(foreign.body.messages).toEqual([]);
    expect(foreign.body.tickets).toEqual([]);

    // A trace that never existed answers identically: the body is not an existence oracle.
    const unknown = randomUUID();
    const missing = await getTrace(otherAdmin, unknown);
    expect(missing.status).toBe(200);
    expect({ ...missing.body, traceId: '' }).toEqual({ ...foreign.body, traceId: '' });
  });

  it('refuses a caller whose role is not on the API.md §5.14 row', async () => {
    const { traceId, home } = await thread();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/trace/${traceId}`,
      headers: { cookie: home.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect((JSON.parse(res.payload) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('rejects a traceId that is not a uuid with the documented 400', async () => {
    const { homeAdmin } = await thread();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/trace/not-a-uuid',
      headers: { cookie: homeAdmin.cookie },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
