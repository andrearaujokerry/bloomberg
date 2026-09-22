/**
 * `test/integration/entitlements/routes.test.ts` — the `usage.ts` and `admin.ts` route groups
 * (API.md §5.13 L766-785 and §5.14 L786-838), WP-07.
 *
 * What this file is for, in order of how much it would hurt to get wrong:
 *
 *  1. **The role matrix.** §5.14 gives every admin route a role column. A route that forgets its
 *     guard hands a trader the compliance archive, and nothing else in the suite would notice, so
 *     every route is asked by every one of the six roles and the answer is checked both ways: the
 *     roles the table excludes get `403 FORBIDDEN`, the roles it names get anything but a 403.
 *  2. **Cursor pagination over `access_log`.** Keyset, on the `(ts, log_id)` primary key: the pages
 *     must partition the result exactly — no row seen twice, none skipped — because the batched
 *     writer keeps appending while a compliance officer reads.
 *  3. **The CSV export shape** (ARCHITECTURE §5.2: RFC 4180 quoting, CRLF, no BOM).
 *  4. **REG-04 erasure**: the person disappears, the audit trail does not.
 *  5. **The licence PUT** bumping `config_versions('entitlements')` — the mechanism by which a
 *     *running* evaluator learns its terms changed. The assertion is made against a real
 *     `licenceRegistry`, not against the table.
 *
 * Self-sufficient (TESTING §4.3): every firm, user, session, grant, licence, access-log row and
 * usage event is created inside this file's own `withTxDb()` transaction, which is also the app's
 * database handle, so the routes read exactly these rows and the whole lot rolls back.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getConfig } from '../../../src/config.js';
import { licenceRegistry } from '../../../src/entitlements/licenceRegistry.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, TEST_NOW_ISO } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────────────────────

const t: TestDb = withTxDb();
const clock = testClock();

let harness: TestApp;
let app: FastifyInstance;

beforeEach(async () => {
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;
});

afterEach(async () => {
  await harness.close();
});

const ROLES = ['user', 'admin', 'compliance', 'dataops', 'helpdesk', 'newsroom'] as const;
type TestRole = (typeof ROLES)[number];

interface Actor {
  userId: number;
  firmId: number;
  sessionId: string;
  /** `Cookie:` header value — the signed `tsid` a browser would present. */
  cookie: string;
}

async function newFirm(name = `Routes Firm ${randomUUID().slice(0, 8)}`): Promise<number> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name, seat_count) VALUES ($1, 5) RETURNING firm_id`,
    [name],
  );
  return Number(firm.rows[0]!.firm_id);
}

async function newUser(firmId: number, role: string): Promise<number> {
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING user_id`,
    [firmId, `wp07-${randomUUID()}@demo.invalid`, `WP07 ${role}`, role],
  );
  return Number(user.rows[0]!.user_id);
}

/** A live web session for `userId`, plus the signed cookie header for it. */
async function newSession(userId: number, firmId: number): Promise<Actor> {
  const token = `sess-${randomUUID()}`;
  const hash = createHash('sha256').update(token, 'utf8').digest();
  const row = await t.client.query<{ session_id: string }>(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true) RETURNING session_id`,
    [userId, hash],
  );
  const signed = cookie.sign(token, getConfig().SESSION_SECRET);
  return {
    userId,
    firmId,
    sessionId: row.rows[0]!.session_id,
    cookie: `tsid=${encodeURIComponent(signed)}`,
  };
}

async function actorFor(role: string, firmId?: number): Promise<Actor> {
  const firm = firmId ?? (await newFirm());
  const userId = await newUser(firm, role);
  return newSession(userId, firm);
}

/** Every mutation from a cookie session carries the CSRF header (API.md §1.1). */
function headersFor(actor: Actor): Record<string, string> {
  return { cookie: actor.cookie, 'x-requested-with': 'terminal' };
}

interface Envelope {
  error?: { code: string; message: string };
}

function errorCode(payload: string): string | undefined {
  return (JSON.parse(payload) as Envelope).error?.code;
}

const API = '/api/v1';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The role matrix — API.md §5.14's role column, route by route
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  roles: readonly TestRole[];
  body?: unknown;
}

/** An id no fixture uses, so a matrix probe of a destructive route cannot destroy anything. */
const MISSING = 2_147_483_600;

const WINDOW = `from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-30T00%3A00%3A00.000Z`;

const ROUTE_MATRIX: readonly RouteSpec[] = [
  { method: 'GET', url: '/admin/declarations?month=2026-09', roles: ['admin', 'compliance'] },
  {
    method: 'POST',
    url: '/admin/declarations/generate',
    roles: ['admin'],
    body: { month: '2026-09' },
  },
  {
    method: 'POST',
    url: `/admin/declarations/${String(MISSING)}/reconcile`,
    roles: ['admin', 'compliance'],
    body: { billingRef: 'INV-1' },
  },
  { method: 'GET', url: '/admin/licences', roles: ['admin', 'dataops', 'compliance'] },
  { method: 'PUT', url: '/admin/licences/nope.source', roles: ['admin'], body: {} },
  { method: 'GET', url: '/admin/entitlements', roles: ['admin'] },
  { method: 'POST', url: '/admin/entitlements', roles: ['admin'], body: {} },
  { method: 'DELETE', url: `/admin/entitlements/${String(MISSING)}`, roles: ['admin'] },
  { method: 'GET', url: `/admin/access-log?${WINDOW}`, roles: ['admin', 'compliance'] },
  { method: 'GET', url: `/admin/access-log/export.csv?${WINDOW}`, roles: ['admin', 'compliance'] },
  { method: 'GET', url: '/admin/exceptions', roles: ['admin', 'dataops'] },
  {
    method: 'POST',
    url: `/admin/exceptions/${String(MISSING)}/resolve`,
    roles: ['dataops'],
    body: { note: 'n', action: 'reject' },
  },
  { method: 'GET', url: '/admin/ca-queue', roles: ['dataops'] },
  {
    method: 'POST',
    url: `/admin/ca-queue/${String(MISSING)}/review`,
    roles: ['dataops'],
    body: { decision: 'reviewed' },
  },
  { method: 'GET', url: '/admin/dq', roles: ['admin', 'dataops'] },
  { method: 'POST', url: `/admin/dq/${String(MISSING)}/resolve`, roles: ['dataops'] },
  { method: 'GET', url: '/admin/ingest/runs', roles: ['admin', 'dataops'] },
  { method: 'POST', url: '/admin/ingest/run/symbologyRefresh', roles: ['admin', 'dataops'] },
  { method: 'GET', url: '/admin/compliance/reviews', roles: ['compliance'] },
  {
    method: 'POST',
    url: `/admin/compliance/reviews/${String(MISSING)}`,
    roles: ['compliance'],
    body: { status: 'reviewed', note: 'n' },
  },
  { method: 'GET', url: '/admin/compliance/holds', roles: ['compliance'] },
  {
    method: 'POST',
    url: '/admin/compliance/holds',
    roles: ['compliance'],
    body: { scope: {}, reason: 'litigation' },
  },
  {
    method: 'DELETE',
    url: `/admin/compliance/holds/${String(MISSING)}`,
    roles: ['compliance'],
  },
  { method: 'GET', url: `/admin/export/messages?${WINDOW}`, roles: ['compliance'] },
  { method: 'GET', url: '/admin/users', roles: ['admin'] },
  { method: 'POST', url: '/admin/users', roles: ['admin'], body: {} },
  { method: 'PUT', url: `/admin/users/${String(MISSING)}`, roles: ['admin'], body: {} },
  { method: 'POST', url: `/admin/users/${String(MISSING)}/verify`, roles: ['admin'] },
  { method: 'DELETE', url: `/admin/users/${String(MISSING)}`, roles: ['admin'] },
  { method: 'GET', url: '/admin/incidents', roles: ['admin'] },
  { method: 'POST', url: '/admin/incidents', roles: ['admin'], body: {} },
  {
    method: 'POST',
    url: `/admin/incidents/${String(MISSING)}/updates`,
    roles: ['admin'],
    body: { text: 'x' },
  },
  { method: 'GET', url: '/usage/functions', roles: ['admin', 'dataops'] },
];

describe('the §5.14 role matrix', () => {
  it('refuses every role the table excludes, and admits every role it names', async () => {
    const firmId = await newFirm();
    const actors = new Map<TestRole, Actor>();
    for (const role of ROLES) actors.set(role, await actorFor(role, firmId));

    const refusals: string[] = [];
    const admissions: string[] = [];

    for (const spec of ROUTE_MATRIX) {
      for (const role of ROLES) {
        const actor = actors.get(role)!;
        const response = await app.inject({
          method: spec.method,
          url: `${API}${spec.url}`,
          headers: headersFor(actor),
          payload: spec.body ?? '',
        });
        const allowed = spec.roles.includes(role);
        const where = `${spec.method} ${spec.url} as ${role}`;

        if (allowed) {
          if (response.statusCode === 403 || response.statusCode === 401) {
            admissions.push(`${where} → ${String(response.statusCode)} ${response.payload}`);
          }
        } else if (response.statusCode !== 403 || errorCode(response.body) !== 'FORBIDDEN') {
          refusals.push(`${where} → ${String(response.statusCode)} ${response.payload}`);
        }
      }
    }

    expect(refusals, 'roles the table excludes must get 403 FORBIDDEN').toEqual([]);
    expect(admissions, 'roles the table names must not be refused').toEqual([]);
  });

  it('refuses every admin route outright without a session', async () => {
    for (const spec of ROUTE_MATRIX.slice(0, 6)) {
      const response = await app.inject({
        method: spec.method,
        url: `${API}${spec.url}`,
        headers: { 'x-requested-with': 'terminal' },
        ...(spec.body === undefined ? {} : { payload: spec.body }),
      });
      expect(response.statusCode, `${spec.method} ${spec.url}`).toBe(401);
      expect(errorCode(response.body)).toBe('AUTH_REQUIRED');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2 & 3. The access log: cursor pagination and the CSV export
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Six `access_log` rows one minute apart, inside the September 2026 partition. */
async function seedAccessLog(userId: number, firmId: number, sessionId: string): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const ts = new Date(Date.parse(TEST_NOW_ISO) + i * 60_000).toISOString();
    const row = await t.client.query<{ log_id: string }>(
      `INSERT INTO access_log (ts, user_id, firm_id, session_id, instrument_id, field_id,
                               field_class, source_id, requested_tier, tier, usage, purpose,
                               decision, reason, trace_id, details)
       VALUES ($1::timestamptz, $2, $3, $4::uuid, $5, $6, 'price', 'cboe.quotes', 'realtime',
               'delayed', 'display', $7, 'downgrade', 'SOURCE_TIER_CAP', $8::uuid, $9::jsonb)
       RETURNING log_id::text AS log_id`,
      [
        ts,
        userId,
        firmId,
        sessionId,
        100 + i,
        'PX_LAST',
        `fn:DES:${String(i)}`,
        randomUUID(),
        JSON.stringify({ seq: i }),
      ],
    );
    ids.push(Number(row.rows[0]!.log_id));
  }
  return ids;
}

describe('GET /admin/access-log', () => {
  it('pages with a keyset cursor that partitions the result exactly', async () => {
    const firmId = await newFirm();
    const admin = await actorFor('admin', firmId);
    const subject = await actorFor('user', firmId);
    const expected = await seedAccessLog(subject.userId, firmId, subject.sessionId);

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url =
        `${API}/admin/access-log?${WINDOW}&userId=${String(subject.userId)}&limit=2` +
        (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const response = await app.inject({ method: 'GET', url, headers: headersFor(admin) });
      expect(response.statusCode, response.body).toBe(200);
      const page = JSON.parse(response.body) as {
        items: { logId: number; ts: string; userId: number; decision: string; details: unknown }[];
        nextCursor: string | null;
      };
      pages += 1;
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) {
        expect(item.userId).toBe(subject.userId);
        expect(item.decision).toBe('downgrade');
        seen.push(item.logId);
      }
      cursor = page.nextCursor;
    } while (cursor !== null && pages < 10);

    // Three full pages of two, then a fourth that is empty and ends the walk: the page that
    // returns `limit` rows cannot know it was the last one.
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(6);
    expect(pages).toBeLessThanOrEqual(4);
  });

  it('filters on decision and rejects a cursor it did not issue', async () => {
    const firmId = await newFirm();
    const admin = await actorFor('admin', firmId);
    const subject = await actorFor('user', firmId);
    await seedAccessLog(subject.userId, firmId, subject.sessionId);

    const denied = await app.inject({
      method: 'GET',
      url: `${API}/admin/access-log?${WINDOW}&userId=${String(subject.userId)}&decision=deny`,
      headers: headersFor(admin),
    });
    expect(denied.statusCode).toBe(200);
    expect((JSON.parse(denied.body) as { items: unknown[] }).items).toEqual([]);

    const bad = await app.inject({
      method: 'GET',
      url: `${API}/admin/access-log?${WINDOW}&cursor=not-a-cursor`,
      headers: headersFor(admin),
    });
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad.body)).toBe('BAD_REQUEST');
  });

  it('exports the same rows as RFC 4180 CSV', async () => {
    const firmId = await newFirm();
    const compliance = await actorFor('compliance', firmId);
    const subject = await actorFor('user', firmId);
    const expected = await seedAccessLog(subject.userId, firmId, subject.sessionId);

    const response = await app.inject({
      method: 'GET',
      url: `${API}/admin/access-log/export.csv?${WINDOW}&userId=${String(subject.userId)}`,
      headers: headersFor(compliance),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body.startsWith('﻿'), 'no BOM').toBe(false);

    const lines = response.body.split('\r\n');
    expect(lines[0]).toBe(
      'logId,ts,userId,firmId,sessionId,instrumentId,fieldId,fieldClass,sourceId,' +
        'requestedTier,tier,usage,purpose,decision,reason,traceId,details',
    );
    // 1 header + 6 rows + the trailing CRLF's empty tail.
    expect(lines.length).toBe(8);
    expect(lines[7]).toBe('');

    const first = lines[1]!.split(',');
    expect(Number(first[0])).toBe(expected[0]);
    expect(first[1]).toBe(TEST_NOW_ISO);
    // The details object carries quotes, so RFC 4180 wraps it and doubles them.
    expect(lines[1]).toContain('"{""seq"":0}"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The declarations group — the route is glue over `entitlements/declarations.ts` (ENTL-06)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('/admin/declarations', () => {
  it('generates, lists, exports and reconciles a month', async () => {
    const firmId = await newFirm();
    const admin = await actorFor('admin', firmId);
    const subject = await actorFor('user', firmId);
    await seedAccessLog(subject.userId, firmId, subject.sessionId);

    const generated = await app.inject({
      method: 'POST',
      url: `${API}/admin/declarations/generate`,
      headers: headersFor(admin),
      payload: { month: '2026-09' },
    });
    expect(generated.statusCode, generated.body).toBe(202);
    const { runId } = JSON.parse(generated.body) as { runId: number };
    expect(runId).toBeGreaterThan(0);

    // The run is recorded like any other ingest run, so `/admin/ingest/runs` can show it.
    const runs = await app.inject({
      method: 'GET',
      url: `${API}/admin/ingest/runs?job=usageDeclarations&limit=5`,
      headers: headersFor(admin),
    });
    const run = (JSON.parse(runs.body) as { items: { runId: number; status: string }[] }).items.find(
      (r) => r.runId === runId,
    );
    expect(run?.status).toBe('ok');

    const listed = await app.inject({
      method: 'GET',
      url: `${API}/admin/declarations?month=2026-09&firmId=${String(firmId)}`,
      headers: headersFor(admin),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const items = (
      JSON.parse(listed.body) as {
        items: {
          declarationId: number;
          sourceId: string;
          firmId: number;
          fieldClass: string;
          tier: string;
          displayUsers: number;
          distinctUsers: number;
          instrumentCount: number;
          dataPoints: number;
          seatCount: number;
          reconciledAt: string | null;
          billingRef: string | null;
        }[];
      }
    ).items;
    expect(items).toHaveLength(1);
    const row = items[0]!;
    expect(row.sourceId).toBe('cboe.quotes');
    expect(row.firmId).toBe(firmId);
    expect(row.fieldClass).toBe('price');
    expect(row.tier).toBe('delayed');
    expect(row.displayUsers).toBe(1);
    expect(row.distinctUsers).toBe(1);
    expect(row.instrumentCount).toBe(6);
    expect(row.dataPoints).toBe(6);
    expect(row.seatCount).toBe(5);
    expect(row.reconciledAt).toBeNull();
    // `query_sql_hash` is stored but is not part of the wire row (API.md §5.14).
    expect(Object.keys(row)).not.toContain('querySqlHash');

    const csv = await app.inject({
      method: 'GET',
      url: `${API}/admin/declarations?month=2026-09&firmId=${String(firmId)}&format=csv`,
      headers: headersFor(admin),
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.split('\r\n');
    expect(lines[0]).toBe(
      'declarationId,month,sourceId,firmId,fieldClass,tier,displayUsers,exportUsers,apiUsers,' +
        'distinctUsers,instrumentCount,dataPoints,seatCount,generatedAt,reconciledAt,billingRef',
    );
    expect(lines).toHaveLength(3);

    const reconciled = await app.inject({
      method: 'POST',
      url: `${API}/admin/declarations/${String(row.declarationId)}/reconcile`,
      headers: headersFor(admin),
      payload: { billingRef: 'CBOE-2026-09' },
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    const after = JSON.parse(reconciled.body) as {
      billingRef: string;
      reconciledAt: string | null;
    };
    expect(after.billingRef).toBe('CBOE-2026-09');
    expect(after.reconciledAt).toBe(TEST_NOW_ISO);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. REG-04 — the person is erased, the audit trail is not
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('DELETE /admin/users/:userId (REG-04)', () => {
  it('anonymises the user, revokes their sessions and keys, and keeps every access_log row', async () => {
    const firmId = await newFirm();
    const admin = await actorFor('admin', firmId);
    const subject = await actorFor('user', firmId);
    await seedAccessLog(subject.userId, firmId, subject.sessionId);

    const keyHash = createHash('sha256').update(`tk_${randomUUID()}`, 'utf8').digest();
    await t.client.query(
      `INSERT INTO api_keys (user_id, key_hash, label) VALUES ($1, $2, 'desk')`,
      [subject.userId, keyHash],
    );

    const before = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM access_log WHERE user_id = $1`,
      [subject.userId],
    );
    expect(Number(before.rows[0]!.n)).toBe(6);

    const response = await app.inject({
      method: 'DELETE',
      url: `${API}/admin/users/${String(subject.userId)}`,
      headers: headersFor(admin),
    });
    expect(response.statusCode, response.body).toBe(204);

    const user = await t.client.query<{
      email: string;
      display_name: string;
      desk: string | null;
      status: string;
      anonymised_at: string | null;
    }>(
      `SELECT email, display_name, desk, status, anonymised_at::text AS anonymised_at
         FROM users WHERE user_id = $1`,
      [subject.userId],
    );
    const handle = `user-${String(subject.userId)}`;
    expect(user.rows[0]!.display_name).toBe(handle);
    expect(user.rows[0]!.email).toBe(`${handle}@anonymised.invalid`);
    expect(user.rows[0]!.status).toBe('deprovisioned');
    expect(user.rows[0]!.anonymised_at).not.toBeNull();

    const sessions = await t.client.query<{ revoke_reason: string | null }>(
      `SELECT revoke_reason FROM sessions WHERE user_id = $1`,
      [subject.userId],
    );
    expect(sessions.rows.map((r) => r.revoke_reason)).toEqual(['deprovisioned']);

    const keys = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`,
      [subject.userId],
    );
    expect(Number(keys.rows[0]!.n)).toBe(0);

    // The point of the requirement: the log survives, still attributed to the same user id.
    const after = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM access_log WHERE user_id = $1`,
      [subject.userId],
    );
    expect(Number(after.rows[0]!.n)).toBe(6);

    // The revoked session no longer authenticates.
    const replay = await app.inject({
      method: 'GET',
      url: `${API}/usage/quota`,
      headers: { cookie: subject.cookie },
    });
    expect(replay.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. The licence PUT — a running evaluator picks the change up
// ─────────────────────────────────────────────────────────────────────────────────────────────

const LICENCE_BODY = {
  sourceName: 'Test Feed',
  publisher: 'Test Publisher',
  termsUrl: null,
  contractRef: null,
  licenceKind: 'vendor_terms',
  display: true,
  nonDisplay: false,
  derived: true,
  redistribution: false,
  exportAllowed: true,
  apiAllowed: true,
  maxTier: 'realtime',
  intrinsicDelayMin: 0,
  retentionDays: null,
  attribution: 'Test Feed',
  rateLimit: '1/s',
  requiresUserAgent: false,
  apiKeyEnv: null,
  auditObligation: null,
  notes: null,
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: '9999-12-31T23:59:59.999Z',
};

describe('PUT /admin/licences/:sourceId', () => {
  it('writes a new bitemporal version and bumps config_versions so a live registry reloads', async () => {
    const sourceId = `test.${randomUUID().slice(0, 8)}`;
    await t.client.query(
      `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, max_tier,
                                     intrinsic_delay_min, attribution, rate_limit, valid_from)
       VALUES ($1, 'Test Feed', 'Test Publisher', 'vendor_terms', 'delayed', 15, 'Test Feed',
               '1/s', '2020-01-01T00:00:00Z')`,
      [sourceId],
    );

    // A registry that has already loaded — the thing a bump has to reach.
    const registry = licenceRegistry({ db: t.db, clock });
    await registry.reload();
    expect(registry.licence(sourceId)?.maxTier).toBe('delayed');
    const versionBefore = registry.version();

    const admin = await actorFor('admin');
    const response = await app.inject({
      method: 'PUT',
      url: `${API}/admin/licences/${sourceId}`,
      headers: headersFor(admin),
      payload: LICENCE_BODY,
    });
    expect(response.statusCode, response.body).toBe(200);
    const written = JSON.parse(response.body) as { maxTier: string; validTo: string };
    expect(written.maxTier).toBe('realtime');
    expect(written.validTo).toBe('9999-12-31T23:59:59.999Z');

    // The bitemporal shape: one current version from 2026-09-01 on, and the head remainder that
    // preserves what the terms were before it.
    const versions = await t.client.query<{ max_tier: string; valid_from: string }>(
      `SELECT max_tier::text AS max_tier, to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD') AS valid_from
         FROM licence_registry WHERE source_id = $1 AND tx_to = 'infinity' ORDER BY valid_from`,
      [sourceId],
    );
    expect(versions.rows).toEqual([
      { max_tier: 'delayed', valid_from: '2020-01-01' },
      { max_tier: 'realtime', valid_from: '2026-09-01' },
    ]);

    // …and the running registry sees it, because the INSERT moved config_versions('entitlements').
    await registry.refreshIfStale();
    expect(registry.version()).toBeGreaterThan(versionBefore);
    expect(registry.licence(sourceId)?.maxTier).toBe('realtime');
    expect(registry.licence(sourceId)?.intrinsicDelayMin).toBe(0);
  });

  it('404s for a source the registry has never heard of', async () => {
    const admin = await actorFor('admin');
    const response = await app.inject({
      method: 'PUT',
      url: `${API}/admin/licences/never.registered`,
      headers: headersFor(admin),
      payload: LICENCE_BODY,
    });
    expect(response.statusCode).toBe(404);
    expect(errorCode(response.body)).toBe('NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entitlement grants — the other half of what the evaluator reads
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('/admin/entitlements', () => {
  it('creates, lists and revokes a grant', async () => {
    const admin = await actorFor('admin');

    const created = await app.inject({
      method: 'POST',
      url: `${API}/admin/entitlements`,
      headers: headersFor(admin),
      payload: {
        subjectKind: 'firm',
        subjectId: admin.firmId,
        sourceId: 'cboe.quotes',
        maxTier: 'realtime',
        usageDisplay: true,
        usageExport: true,
        contractRef: 'CTR-1',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const grant = JSON.parse(created.body) as { grantId: number; grantedBy: number; validTo: string };
    expect(grant.grantedBy).toBe(admin.userId);
    expect(grant.validTo).toBe('9999-12-31T23:59:59.999Z');

    const listed = await app.inject({
      method: 'GET',
      url: `${API}/admin/entitlements?subjectKind=firm&subjectId=${String(admin.firmId)}`,
      headers: headersFor(admin),
    });
    expect((JSON.parse(listed.body) as { items: { grantId: number }[] }).items).toHaveLength(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${API}/admin/entitlements/${String(grant.grantId)}`,
      headers: headersFor(admin),
    });
    expect(deleted.statusCode, deleted.body).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: `${API}/admin/entitlements?subjectKind=firm&subjectId=${String(admin.firmId)}`,
      headers: headersFor(admin),
    });
    expect((JSON.parse(after.body) as { items: unknown[] }).items).toEqual([]);

    // The row is gone, and the DELETE moved `config_versions('entitlements')` — which is how a
    // running evaluator stops honouring it.
    const rows = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entitlement_grants WHERE grant_id = $1`,
      [grant.grantId],
    );
    expect(Number(rows.rows[0]!.n)).toBe(0);

    const missing = await app.inject({
      method: 'DELETE',
      url: `${API}/admin/entitlements/${String(grant.grantId)}`,
      headers: headersFor(admin),
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The usage group (API.md §5.13)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the /usage group', () => {
  it('accepts a batch of events and flags the server-originated ones', async () => {
    const actor = await actorFor('user');

    const response = await app.inject({
      method: 'POST',
      url: `${API}/usage/events`,
      headers: headersFor(actor),
      payload: {
        events: [
          { ts: TEST_NOW_ISO, kind: 'panel.switch', panelId: 'p1', details: { to: 'DES' } },
          { ts: TEST_NOW_ISO, kind: 'fn.launch', code: 'DES', details: {} },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(202);

    const rows = await t.client.query<{ kind: string; details: Record<string, unknown> }>(
      `SELECT kind, details FROM usage_events WHERE user_id = $1 ORDER BY kind`,
      [actor.userId],
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(['fn.launch', 'panel.switch']);
    // API.md L783: a client posting a server-originated kind is accepted and flagged.
    expect(rows.rows[0]!.details.clientReported).toBe(true);
    expect(rows.rows[1]!.details.clientReported).toBeUndefined();
    expect(rows.rows[1]!.details.to).toBe('DES');
  });

  it('reports the live quota counters, unenforced for a web session', async () => {
    const actor = await actorFor('user');
    const response = await app.inject({
      method: 'GET',
      url: `${API}/usage/quota`,
      headers: { cookie: actor.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      dailyUniqueInstruments: { used: number; limit: number; resetsAt: string };
      monthlyDataPoints: { used: number; limit: number };
      concurrentSubscriptions: { limit: number };
      enforced: boolean;
    };
    expect(body.enforced).toBe(false);
    expect(body.dailyUniqueInstruments).toEqual({
      used: 0,
      limit: 500,
      resetsAt: '2026-09-18T00:00:00.000Z',
    });
    expect(body.monthlyDataPoints.limit).toBe(2_000_000);
    expect(body.concurrentSubscriptions.limit).toBe(10_000);
  });

  it('pre-labels what the evaluator will decide', async () => {
    const actor = await actorFor('user');
    const sourceId = `test.${randomUUID().slice(0, 8)}`;
    await t.client.query(
      `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, max_tier,
                                     intrinsic_delay_min, attribution, rate_limit, valid_from)
       VALUES ($1, 'Test Feed', 'Test Publisher', 'vendor_terms', 'delayed', 15, 'Test Feed',
               '1/s', '2020-01-01T00:00:00Z')`,
      [sourceId],
    );
    await t.client.query(
      `INSERT INTO entitlement_grants (subject_kind, subject_id, source_id, max_tier,
                                       usage_display, usage_export, usage_api, valid_from)
       VALUES ('firm', $1, $2, 'realtime', true, true, false, '2020-01-01T00:00:00Z')`,
      [actor.firmId, sourceId],
    );
    await t.client.query(
      `INSERT INTO entitlement_grants (subject_kind, subject_id, source_id, max_tier,
                                       usage_display, usage_export, usage_api, valid_from)
       VALUES ('user', $1, $2, 'eod', true, false, false, '2020-01-01T00:00:00Z')`,
      [actor.userId, sourceId],
    );

    const response = await app.inject({
      method: 'GET',
      url: `${API}/usage/entitlements`,
      headers: { cookie: actor.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      defaultTier: string;
      grants: { subjectKind: string; maxTier: string; validTo: string }[];
      licences: { sourceId: string; maxTier: string }[];
    };

    // The minimum over the subject's grants (API.md §1.2): the user's own `eod` cap wins.
    expect(body.defaultTier).toBe('eod');
    expect(body.grants.map((g) => `${g.subjectKind}:${g.maxTier}`).sort()).toEqual([
      'firm:realtime',
      'user:eod',
    ]);
    expect(body.grants[0]!.validTo).toBe('9999-12-31T23:59:59.999Z');
    expect(body.licences.some((l) => l.sourceId === sourceId && l.maxTier === 'delayed')).toBe(true);
  });

  it('counts function launches, distinct users and exports for the roadmap query', async () => {
    const firmId = await newFirm();
    const dataops = await actorFor('dataops', firmId);
    const one = await actorFor('user', firmId);
    const two = await actorFor('user', firmId);

    const event = async (userId: number, kind: string, code: string): Promise<void> => {
      await t.client.query(
        `INSERT INTO usage_events (ts, user_id, firm_id, kind, code)
         VALUES ($1::timestamptz, $2, $3, $4, $5)`,
        [TEST_NOW_ISO, userId, firmId, kind, code],
      );
    };
    await event(one.userId, 'fn.launch', 'DES');
    await event(one.userId, 'fn.launch', 'DES');
    await event(two.userId, 'fn.launch', 'DES');
    await event(two.userId, 'fn.export', 'DES');
    await event(one.userId, 'fn.launch', 'GP');

    const response = await app.inject({
      method: 'GET',
      url: `${API}/usage/functions?days=30`,
      headers: { cookie: dataops.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const items = (
      JSON.parse(response.body) as {
        items: { code: string; launches: number; users: number; exports: number }[];
      }
    ).items;
    const des = items.find((i) => i.code === 'DES');
    expect(des).toEqual({ code: 'DES', launches: 3, users: 2, exports: 1 });
    expect(items.find((i) => i.code === 'GP')).toEqual({
      code: 'GP',
      launches: 1,
      users: 1,
      exports: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// REG-01 — the message production and its hash-chain verdict
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A licence row for `sourceId`, so `assert_source_known` lets a `provenance` row exist. */
async function seedSource(sourceId: string): Promise<void> {
  await t.client.query(
    `INSERT INTO licence_registry (source_id, source_name, publisher, licence_kind, max_tier,
                                   intrinsic_delay_min, attribution, rate_limit, valid_from)
     VALUES ($1, 'Test Feed', 'Test Publisher', 'vendor_terms', 'delayed', 15, 'Test Feed',
             '1/s', '2020-01-01T00:00:00Z')`,
    [sourceId],
  );
}

describe('GET /admin/export/messages', () => {
  it('produces the room in seq order and verifies the chain it produced', async () => {
    const firmId = await newFirm();
    const compliance = await actorFor('compliance', firmId);
    const sender = await actorFor('user', firmId);

    const room = await t.client.query<{ room_id: string }>(
      `INSERT INTO rooms (kind, name, firm_id, created_by) VALUES ('firm', 'Desk', $1, $2)
       RETURNING room_id`,
      [firmId, sender.userId],
    );
    const roomId = Number(room.rows[0]!.room_id);
    await t.client.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [roomId, sender.userId, compliance.userId],
    );

    // `seq`, `prev_hash` and `hash` are assigned by `messages_chain()` — the columns are NOT NULL,
    // so a placeholder goes in and the trigger overwrites it.
    for (const [i, body] of ['first', 'second'].entries()) {
      await t.client.query(
        `INSERT INTO messages (room_id, seq, sender_user_id, sender_firm_id, sent_at, body,
                               client_msg_id, hash)
         VALUES ($1, 0, $2, $3, $4::timestamptz, $5, gen_random_uuid(), '\\x'::bytea)`,
        [roomId, sender.userId, firmId, new Date(Date.parse(TEST_NOW_ISO) + i * 60_000).toISOString(), body],
      );
    }

    const url = `${API}/admin/export/messages?${WINDOW}&room=${String(roomId)}`;
    const exported = await app.inject({ method: 'GET', url, headers: headersFor(compliance) });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');

    const lines = exported.body.trim().split('\n');
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]!) as {
      seq: number;
      body: string;
      senderDisplay: string;
      prevHash: string | null;
      hash: string;
    };
    const second = JSON.parse(lines[1]!) as { seq: number; body: string; prevHash: string | null };
    expect(first.seq).toBe(1);
    expect(first.body).toBe('first');
    expect(first.senderDisplay).toBe('WP07 user');
    expect(first.prevHash).toBeNull();
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(JSON.parse(lines[2]!)).toEqual({ chain: 'ok' });

    // Tamper with the body behind the WORM trigger's back. The production must notice: the whole
    // point of REG-01 is that the verdict is recomputed, not copied out of the row.
    await t.client.query('ALTER TABLE messages DISABLE TRIGGER messages_worm');
    await t.client.query(`UPDATE messages SET body = 'tampered' WHERE room_id = $1 AND seq = 1`, [
      roomId,
    ]);
    await t.client.query('ALTER TABLE messages ENABLE TRIGGER messages_worm');

    const broken = await app.inject({ method: 'GET', url, headers: headersFor(compliance) });
    const brokenLines = broken.body.trim().split('\n');
    expect(JSON.parse(brokenLines[brokenLines.length - 1]!)).toEqual({
      chain: 'broken',
      firstBadSeq: 1,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DATA-08 — the corporate-action review desk
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('/admin/ca-queue', () => {
  it('reviews a queued action as a new bitemporal version, keeping the old one', async () => {
    const dataops = await actorFor('dataops');
    const sourceId = `test.${randomUUID().slice(0, 8)}`;
    await seedSource(sourceId);

    const prov = await t.client.query<{ provenance_id: string }>(
      `INSERT INTO provenance (source_id, request_key, request_url, request_hash, response_sha256,
                               http_status, bytes, captured_at, adapter_version)
       VALUES ($1, 'k', 'https://example.invalid/ca', '\\x00'::bytea, '\\x00'::bytea, 200, 10,
               $2::timestamptz, 'test/1.0.0')
       RETURNING provenance_id::text AS provenance_id`,
      [sourceId, TEST_NOW_ISO],
    );
    const provenanceId = Number(prov.rows[0]!.provenance_id);

    const ca = await t.client.query<{ ca_id: string }>(
      `INSERT INTO corporate_actions (instrument_id, ca_type, status, ex_date, amount, currency,
                                      source_id, review_state, valid_from, provenance_id)
       VALUES (987654, 'cash_dividend', 'announced', '2026-09-24', 0.25, 'USD', $1, 'queued',
               '2026-09-01T00:00:00Z', $2)
       RETURNING ca_id::text AS ca_id`,
      [sourceId, provenanceId],
    );
    const caId = Number(ca.rows[0]!.ca_id);

    const queue = await app.inject({
      method: 'GET',
      url: `${API}/admin/ca-queue`,
      headers: headersFor(dataops),
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const queued = (
      JSON.parse(queue.body) as { items: { caId: number; amount: number; exDate: string }[] }
    ).items.find((i) => i.caId === caId);
    expect(queued?.amount).toBe(0.25);
    expect(queued?.exDate).toBe('2026-09-24');

    const reviewed = await app.inject({
      method: 'POST',
      url: `${API}/admin/ca-queue/${String(caId)}/review`,
      headers: headersFor(dataops),
      payload: { decision: 'reviewed', note: 'matches the 8-K' },
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const after = JSON.parse(reviewed.body) as { reviewState: string; amount: number };
    expect(after.reviewState).toBe('reviewed');
    expect(after.amount).toBe(0.25);

    // One current version, and the queued one preserved as a closed version (DATA_MODEL §1.3).
    const versions = await t.client.query<{
      review_state: string;
      reviewed_by: string | null;
      open: boolean;
    }>(
      `SELECT review_state, reviewed_by::text AS reviewed_by, (tx_to = 'infinity') AS open
         FROM corporate_actions WHERE ca_id = $1 ORDER BY version_id`,
      [caId],
    );
    expect(versions.rows).toEqual([
      { review_state: 'queued', reviewed_by: null, open: false },
      { review_state: 'reviewed', reviewed_by: String(dataops.userId), open: true },
    ]);

    // It has left the queue, and a second review of the same row is refused.
    const emptied = await app.inject({
      method: 'GET',
      url: `${API}/admin/ca-queue`,
      headers: headersFor(dataops),
    });
    expect(
      (JSON.parse(emptied.body) as { items: { caId: number }[] }).items.some((i) => i.caId === caId),
    ).toBe(false);

    const again = await app.inject({
      method: 'POST',
      url: `${API}/admin/ca-queue/${String(caId)}/review`,
      headers: headersFor(dataops),
      payload: { decision: 'reviewed' },
    });
    expect(again.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The queues that had no rows until this test wrote one
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the dataops and compliance queues', () => {
  it('lists and resolves a data exception', async () => {
    const dataops = await actorFor('dataops');
    const inserted = await t.client.query<{ exception_id: string }>(
      `INSERT INTO data_exceptions (kind, entity_kind, entity_id, field, candidates, status, sla_due_at)
       VALUES ('source_conflict', 'instrument', 42, 'name',
               '[{"sourceId":"sec.tickers","provenanceId":1,"value":"A"}]'::jsonb, 'open',
               now() + interval '1 day')
       RETURNING exception_id::text AS exception_id`,
    );
    const exceptionId = Number(inserted.rows[0]!.exception_id);

    const listed = await app.inject({
      method: 'GET',
      url: `${API}/admin/exceptions?status=open`,
      headers: headersFor(dataops),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const items = (JSON.parse(listed.body) as { items: { exceptionId: number }[] }).items;
    expect(items.some((i) => i.exceptionId === exceptionId)).toBe(true);

    const resolved = await app.inject({
      method: 'POST',
      url: `${API}/admin/exceptions/${String(exceptionId)}/resolve`,
      headers: headersFor(dataops),
      payload: { action: 'accept', note: 'SEC wins', chosenProvenanceId: 1 },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    const after = JSON.parse(resolved.body) as {
      status: string;
      resolvedBy: number;
      resolution: { note: string; chosenProvenanceId: number };
    };
    expect(after.status).toBe('resolved');
    expect(after.resolvedBy).toBe(dataops.userId);
    expect(after.resolution.note).toBe('SEC wins');
    expect(after.resolution.chosenProvenanceId).toBe(1);

    // Resolving twice is a mistake, not a no-op.
    const again = await app.inject({
      method: 'POST',
      url: `${API}/admin/exceptions/${String(exceptionId)}/resolve`,
      headers: headersFor(dataops),
      payload: { action: 'accept', note: 'again' },
    });
    expect(again.statusCode).toBe(400);
  });

  it('opens, updates and closes an incident', async () => {
    const admin = await actorFor('admin');

    const opened = await app.inject({
      method: 'POST',
      url: `${API}/admin/incidents`,
      headers: headersFor(admin),
      payload: { component: 'provider:cboe.quotes', severity: 'degraded', title: 'Feed lagging' },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const incident = JSON.parse(opened.body) as { incidentId: number; updates: unknown[] };
    expect(incident.updates).toEqual([]);

    const updated = await app.inject({
      method: 'POST',
      url: `${API}/admin/incidents/${String(incident.incidentId)}/updates`,
      headers: headersFor(admin),
      payload: { text: 'Recovered', close: true },
    });
    expect(updated.statusCode, updated.body).toBe(201);
    const closed = JSON.parse(updated.body) as {
      closedAt: string | null;
      updates: { ts: string; text: string }[];
    };
    expect(closed.updates).toEqual([{ ts: TEST_NOW_ISO, text: 'Recovered' }]);
    expect(closed.closedAt).toBe(TEST_NOW_ISO);

    const open = await app.inject({
      method: 'GET',
      url: `${API}/admin/incidents?open=true`,
      headers: headersFor(admin),
    });
    const items = (JSON.parse(open.body) as { items: { incidentId: number }[] }).items;
    expect(items.some((i) => i.incidentId === incident.incidentId)).toBe(false);
  });

  it('holds and releases a legal hold, and exports messages with a chain verdict', async () => {
    const compliance = await actorFor('compliance');

    const created = await app.inject({
      method: 'POST',
      url: `${API}/admin/compliance/holds`,
      headers: headersFor(compliance),
      payload: { scope: { userIds: [compliance.userId] }, reason: 'SEC request 2026-14' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const hold = JSON.parse(created.body) as { holdId: number; firmId: number; createdBy: number };
    expect(hold.firmId).toBe(compliance.firmId);
    expect(hold.createdBy).toBe(compliance.userId);

    const released = await app.inject({
      method: 'DELETE',
      url: `${API}/admin/compliance/holds/${String(hold.holdId)}`,
      headers: headersFor(compliance),
    });
    expect(released.statusCode, released.body).toBe(200);
    expect((JSON.parse(released.body) as { releasedAt: string | null }).releasedAt).toBe(
      TEST_NOW_ISO,
    );

    // An empty production still says whether the chain it covered is intact.
    const exported = await app.inject({
      method: 'GET',
      url: `${API}/admin/export/messages?${WINDOW}`,
      headers: headersFor(compliance),
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    const lines = exported.body.trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ chain: 'ok' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. Tenant isolation on the two tables RLS does not cover — `access_log` and `users`
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('cross-firm isolation of /admin/access-log', () => {
  it('shows a compliance officer their own firm and no other', async () => {
    const mine = await newFirm('Isolation Firm A');
    const theirs = await newFirm('Isolation Firm B');
    const officer = await actorFor('compliance', mine);
    const ourUser = await actorFor('user', mine);
    const theirUser = await actorFor('user', theirs);

    await seedAccessLog(ourUser.userId, mine, ourUser.sessionId);
    await seedAccessLog(theirUser.userId, theirs, theirUser.sessionId);

    // `access_log` gets the WORM trigger in migration 0015 and no RLS policy, so the firm
    // predicate lives in the route or nowhere: the unfiltered query used to return every firm's
    // rows — who read which field of which instrument, at which tier, for what purpose.
    const listed = await app.inject({
      method: 'GET',
      url: `${API}/admin/access-log?${WINDOW}&limit=1000`,
      headers: { cookie: officer.cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const items = (JSON.parse(listed.body) as { items: { userId: number }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((row) => row.userId === ourUser.userId)).toBe(true);

    // Naming the other firm's user directly is a 404, not a filtered 200: the caller must not
    // learn that the id exists.
    const probed = await app.inject({
      method: 'GET',
      url: `${API}/admin/access-log?${WINDOW}&userId=${String(theirUser.userId)}`,
      headers: { cookie: officer.cookie },
    });
    expect(probed.statusCode).toBe(404);

    const exported = await app.inject({
      method: 'GET',
      url: `${API}/admin/access-log/export.csv?${WINDOW}`,
      headers: { cookie: officer.cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(String(theirUser.userId));
  });
});

describe('cross-firm isolation of /admin/users', () => {
  it('cannot read, create, rewrite, verify or erase another firm\'s account', async () => {
    const mine = await newFirm('Users Firm A');
    const theirs = await newFirm('Users Firm B');
    const admin = await actorFor('admin', mine);
    const victim = await actorFor('user', theirs);

    const listed = await app.inject({
      method: 'GET',
      url: `${API}/admin/users`,
      headers: { cookie: admin.cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const ids = (JSON.parse(listed.body) as { items: { userId: number }[] }).items.map(
      (u) => u.userId,
    );
    expect(ids).toContain(admin.userId);
    expect(ids).not.toContain(victim.userId);

    // `?firmId=` may only ever name the caller's own firm.
    const otherFirm = await app.inject({
      method: 'GET',
      url: `${API}/admin/users?firmId=${String(theirs)}`,
      headers: { cookie: admin.cookie },
    });
    expect(otherFirm.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: `${API}/admin/users`,
      headers: headersFor(admin),
      payload: {
        email: `planted-${randomUUID()}@demo.invalid`,
        displayName: 'Planted',
        firmId: theirs,
        role: 'admin',
      },
    });
    expect(created.statusCode, created.body).toBe(403);

    // The one that mattered: `password` goes straight to `setPassword`, so an unscoped PUT was a
    // one-request account takeover in any firm on the platform.
    const takeover = await app.inject({
      method: 'PUT',
      url: `${API}/admin/users/${String(victim.userId)}`,
      headers: headersFor(admin),
      payload: { password: 'attacker chosen password' },
    });
    expect(takeover.statusCode, takeover.body).toBe(404);

    const credentials = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_credentials WHERE user_id = $1`,
      [victim.userId],
    );
    expect(credentials.rows[0]!.n).toBe('0');

    const promoted = await app.inject({
      method: 'PUT',
      url: `${API}/admin/users/${String(victim.userId)}`,
      headers: headersFor(admin),
      payload: { role: 'admin' },
    });
    expect(promoted.statusCode).toBe(404);

    const verified = await app.inject({
      method: 'POST',
      url: `${API}/admin/users/${String(victim.userId)}/verify`,
      headers: headersFor(admin),
    });
    expect(verified.statusCode).toBe(404);

    const erased = await app.inject({
      method: 'DELETE',
      url: `${API}/admin/users/${String(victim.userId)}`,
      headers: headersFor(admin),
    });
    expect(erased.statusCode).toBe(404);

    const intact = await t.client.query<{ role: string; anonymised_at: string | null }>(
      `SELECT role, anonymised_at::text AS anonymised_at FROM users WHERE user_id = $1`,
      [victim.userId],
    );
    expect(intact.rows[0]!.role).toBe('user');
    expect(intact.rows[0]!.anonymised_at).toBeNull();
  });

  it('writes an access_log row for a password or role change inside the firm', async () => {
    const firmId = await newFirm('Audited Firm');
    const admin = await actorFor('admin', firmId);
    const subject = await actorFor('user', firmId);

    const changed = await app.inject({
      method: 'PUT',
      url: `${API}/admin/users/${String(subject.userId)}`,
      headers: headersFor(admin),
      payload: { password: 'a brand new password', role: 'dataops' },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    // Attributed to the ACTING admin, with the subject in `details`, on the WORM table nobody can
    // edit afterwards. `tier` is NULL so the row can never reach a vendor declaration.
    const audit = await t.client.query<{
      purpose: string;
      details: { subjectUserId: number; passwordChanged: boolean; role?: string };
      tier: string | null;
    }>(
      `SELECT purpose, details, tier::text AS tier FROM access_log
        WHERE user_id = $1 AND purpose = 'admin.user.update'`,
      [admin.userId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.details.subjectUserId).toBe(subject.userId);
    expect(audit.rows[0]!.details.passwordChanged).toBe(true);
    expect(audit.rows[0]!.details.role).toBe('dataops');
    expect(audit.rows[0]!.tier).toBeNull();
  });
});
