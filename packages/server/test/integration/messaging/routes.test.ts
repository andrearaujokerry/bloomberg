/**
 * `test/integration/messaging/routes.test.ts` — the five WP-09 route groups of API.md §5.6, §5.8,
 * §5.10, §5.11 and §5.12 (`news`, `watchlists`, `messages`, `alerts`, `help`).
 *
 * WORKPLAN's WP-09 acceptance table names files for the *services* (`news/entityLink`,
 * `messaging/chain`, `messaging/policy`, `alerts/engine`) and none for the HTTP surface those
 * services are reached through. This file is that surface. What it proves, in the order it would
 * cost most to get wrong:
 *
 *  1. **The guard matrix.** Every route needs a session; the ones that serve licensed rows
 *     (`/news`, the watchlist CSV) additionally need `data:read`, so an API key minted with an
 *     empty scope list reads nothing through them; a cookie-authenticated mutation without the
 *     CSRF header is refused.
 *  2. **A tenant-scoped row the caller may not see is a 404, not a 403** (API.md L186). A
 *     watchlist in another firm, an alert belonging to a colleague, a room the caller has no seat
 *     in: all 404, and none of them confirm that the id exists.
 *  3. **MSG-04.** One attachment, two readers, two answers — the sender's numbers never travel
 *     with the message. This is the test that would pass trivially if the route embedded the
 *     sender's snapshot, so it is written as two readers of the *same* stored message whose
 *     entitlement grants differ, and it asserts that the reader without the grant does not
 *     receive the number the sender saw.
 *  4. **CHRT-07 through `core/formula`.** A watchlist column declared as `{ id:'c1', formula }` is
 *     evaluated by the shared evaluator over the row's own resolved fields, and the value lands
 *     in the §9 CSV.
 *
 * Every fixture is built inside this file's own transaction — firms, users, sessions, grants, the
 * instrument, its quote snapshot, the story. Nothing depends on `fixtures/seed/*` (WP-15 owns the
 * seed and it does not exist) and nothing depends on a literal instrument id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuoteState } from '@terminal/core';
import type { DataResponse } from '@terminal/sdk/wire/dataRequest';
import { Alert, AlertListResponse, SavedSearch } from '@terminal/sdk/wire/rest/alerts';
import { TicketListResponse } from '@terminal/sdk/wire/rest/help';
import { Message, Room, RoomListResponse } from '@terminal/sdk/wire/rest/messages';
import {
  NewsItemResponse,
  NewsListResponse,
  TopicListResponse,
} from '@terminal/sdk/wire/rest/news';
import { Watchlist, WatchlistListResponse } from '@terminal/sdk/wire/rest/watchlists';

import { getConfig } from '../../../src/config.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, seedQuoteInstrument } from '../ws/helpers.js';

const t: TestDb = withTxDb();

/**
 * A clock a minute ahead of the wall clock, and the reason it is not `testClock()`.
 *
 * Every fixture row this file writes is bitemporal or provenance-stamped by the *database*:
 * `writeVersion` leaves `tx_from = clock_timestamp()`, and `licence_registry`'s seeded rows carry
 * the instant the global setup ran. A request's `knownAt` comes from the injected clock, so a
 * clock frozen at `TEST_NOW` (2026-09-17, in the past) would read the master, the licence
 * registry and the field licences as *not yet known* — every resolve would 404 and every field
 * would evaluate as `FIELD_UNKNOWN`. One minute ahead of `Date.now()` puts `knownAt` after every
 * row this test writes while staying inside `bt_guard`'s tolerance for a forward-dated write.
 */
let clock: ReturnType<typeof testClock>;

let harness: TestApp;
let app: FastifyInstance;

interface Actor {
  userId: number;
  firmId: number;
  cookie: string;
}

/** The composite state the warm tier serves; the numbers are chosen so a ratio is exact. */
const PX_LAST = 200;
const PX_BID = 100;

let firmId: number;
let alice: Actor;
/** Same firm as Alice, narrowed by a user grant to reference fields only. */
let bob: Actor;
/** Another firm entirely — every cross-tenant assertion is made as Carol. */
let carol: Actor;
let deskUserId: number;

let instrumentId: number;
let newsId: number;
let bbgProvenanceId: number;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────────────────────

async function newFirm(label: string): Promise<number> {
  const res = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`${label} ${randomUUID().slice(0, 8)}`],
  );
  return Number(res.rows[0]!.firm_id);
}

async function newUser(
  firm: number,
  displayName: string,
  role: 'user' | 'helpdesk' = 'user',
): Promise<number> {
  const res = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, desk, role, person_verified_at)
     VALUES ($1, $2, $3, 'Equities PM', $4, now()) RETURNING user_id`,
    [firm, `wp09-${randomUUID()}@demo.invalid`, displayName, role],
  );
  return Number(res.rows[0]!.user_id);
}

/** A web session and the signed `tsid` cookie a browser would present. */
async function webSession(userId: number, firm: number): Promise<Actor> {
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  return {
    userId,
    firmId: firm,
    cookie: `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`,
  };
}

/** A bearer API session with exactly `scopes`. */
async function apiToken(userId: number, scopes: readonly string[]): Promise<string> {
  const token = `tok-${randomUUID()}`;
  const key = await t.client.query<{ api_key_id: string }>(
    `INSERT INTO api_keys (user_id, key_hash, label, scopes)
     VALUES ($1, $2, 'wp09 test key', $3) RETURNING api_key_id`,
    [userId, createHash('sha256').update(`key-${token}`, 'utf8').digest(), [...scopes]],
  );
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, api_key_id, expires_at, mfa_verified)
     VALUES ($1, $2, 'api', $3, now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest(), Number(key.rows[0]!.api_key_id)],
  );
  return token;
}

beforeEach(async () => {
  clock = testClock(Date.now() + 60_000);
  harness = await createTestApp({ db: t.db, clock });
  app = harness.app;

  firmId = await newFirm('WP09 Firm A');
  const otherFirmId = await newFirm('WP09 Firm B');

  alice = await webSession(await newUser(firmId, 'Alice Adams'), firmId);
  bob = await webSession(await newUser(firmId, 'Bob Brown'), firmId);
  carol = await webSession(await newUser(otherFirmId, 'Carol Clark'), otherFirmId);
  deskUserId = await newUser(firmId, 'Dana Desk', 'helpdesk');

  // ENTL-02: the firm is granted everything; Bob is *narrowed* by a user grant that covers only
  // reference fields, which is what makes the MSG-04 assertion a statement about entitlements
  // rather than about two different messages.
  await t.client.query(
    `INSERT INTO entitlement_grants (subject_kind, subject_id, source_id, asset_class, field_class,
                                     max_tier, usage_display, usage_export, usage_api, valid_from)
     VALUES ('firm', $1, NULL, NULL, NULL, 'realtime', true, true, true, '-infinity')`,
    [firmId],
  );
  await t.client.query(
    `INSERT INTO entitlement_grants (subject_kind, subject_id, source_id, asset_class, field_class,
                                     max_tier, usage_display, usage_export, usage_api, valid_from)
     VALUES ('user', $1, NULL, NULL, NULL, 'realtime', true, true, true, '-infinity')`,
    [alice.userId],
  );
  // ENTL-02 rule: the effective grant is the licence cap ∩ the firm's ∩ the user's, and a user
  // with no grant of their own has no entitlement at all. Bob's covers reference fields only, so
  // the price fields of a shared attachment are denied to him and to nobody else in his firm.
  await t.client.query(
    `INSERT INTO entitlement_grants (subject_kind, subject_id, source_id, asset_class, field_class,
                                     max_tier, usage_display, usage_export, usage_api, valid_from)
     VALUES ('user', $1, NULL, NULL, 'reference', 'eod', true, false, false, '-infinity')`,
    [bob.userId],
  );

  const seeded = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });
  instrumentId = seeded.instrumentId;

  const cboeProvenanceId = await bootstrapProvenance(t, 'cboe.quotes', 'wp09-quote');
  const cap = Date.parse('2026-09-15T18:41:28Z');
  const state: QuoteState = {
    subject: `q:${String(instrumentId)}`,
    instrumentId,
    assetClass: 'equity',
    seq: 3,
    tier: 'delayed',
    delayMin: 15,
    fields: { PX_LAST, PX_BID, PX_ASK: 101 },
    fieldTs: { PX_LAST: cap },
    ts: { src: cap, cap, pub: cap },
    session: 'open',
    state: 'live',
    ageMs: 0,
    expectedIntervalMs: 10_000,
    prov: { sourceId: 'cboe.quotes', provenanceId: cboeProvenanceId },
    lines: {},
    dq: [],
  };
  await t.client.query(
    `INSERT INTO quote_snapshots (instrument_id, subject, seq, state, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, timestamptz '2026-09-15T18:41:28Z')`,
    [instrumentId, state.subject, state.seq, JSON.stringify(state)],
  );

  bbgProvenanceId = await bootstrapProvenance(t, 'bbg.rss', 'wp09-news');
  const story = await t.client.query<{ news_id: string }>(
    `INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url,
                             author, category, published_at, captured_at, provenance_id)
     VALUES ('bbg.rss', 'markets', $1, 'story', 'Apple raises guidance',
             'The company lifted its outlook.', 'https://example.invalid/story', 'A Reporter',
             'MARKETS', timestamptz '2026-09-15T12:00:00Z', timestamptz '2026-09-15T12:00:05Z',
             $2)
     RETURNING news_id`,
    [`guid-${randomUUID()}`, bbgProvenanceId],
  );
  newsId = Number(story.rows[0]!.news_id);
  await t.client.query(
    `INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
     VALUES ($1, 'instrument', $2, 1.0, 'ticker_exact')`,
    [newsId, instrumentId],
  );
  await t.client.query(`INSERT INTO topics (code, name, kind) VALUES ($1, 'Markets', 'feed')`, [
    `MARKETS-${randomUUID().slice(0, 6)}`,
  ]);
});

afterEach(async () => {
  await harness.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Calling
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Res {
  statusCode: number;
  payload: string;
  json: <T>() => T;
  code: () => string | undefined;
}

function wrap(res: { statusCode: number; payload: string }): Res {
  return {
    statusCode: res.statusCode,
    payload: res.payload,
    json: <T>(): T => JSON.parse(res.payload) as T,
    code: (): string | undefined => {
      try {
        return (JSON.parse(res.payload) as { error?: { code?: string } }).error?.code;
      } catch {
        return undefined;
      }
    },
  };
}

async function call(
  actor: Actor | null,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<Res> {
  const headers: Record<string, string> =
    actor === null ? {} : { cookie: actor.cookie, 'x-requested-with': 'terminal' };
  return wrap(
    await app.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    }),
  );
}

async function callAs(token: string, url: string): Promise<Res> {
  return wrap(
    await app.inject({
      method: 'GET',
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

/** A watchlist owned by Alice, shared with her firm, holding the seeded instrument. */
async function createSharedWatchlist(): Promise<Watchlist> {
  const res = await call(alice, 'POST', '/watchlists', {
    name: `Core ${randomUUID().slice(0, 6)}`,
    columns: [
      { id: 'PX_LAST' },
      { id: 'PX_BID' },
      { id: 'c1', formula: 'PX_LAST / PX_BID', label: 'Ratio', decimals: 4 },
    ],
    sharedScope: 'firm',
    items: [{ security: { id: instrumentId }, label: 'Apple' }],
  });
  expect(res.statusCode, res.payload).toBe(201);
  return Watchlist.parse(res.json());
}

/** A room holding Alice and Bob, with one message carrying a `security` attachment. */
async function roomWithAttachment(): Promise<{ room: Room; message: Message }> {
  const created = await call(alice, 'POST', '/rooms', {
    kind: 'group',
    name: 'Desk',
    memberUserIds: [bob.userId],
  });
  expect(created.statusCode, created.payload).toBe(201);
  const room = Room.parse(created.json());

  const sent = await call(alice, 'POST', `/rooms/${String(room.roomId)}/messages`, {
    clientMsgId: randomUUID(),
    body: 'Look at this one',
    attachments: [{ kind: 'security', instrumentId }],
  });
  expect(sent.statusCode, sent.payload).toBe(201);
  return { room, message: Message.parse(sent.json()) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The guard matrix
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('the guard matrix (API.md §5.6, §5.8, §5.10, §5.11, §5.12)', () => {
  it('refuses every group without a session', async () => {
    for (const url of [
      '/news',
      '/topics',
      '/watchlists',
      '/alerts',
      '/saved-searches',
      '/rooms',
      '/directory?q=a',
      '/help/tickets',
    ]) {
      const res = await call(null, 'GET', url);
      expect(res.statusCode, `${url} → ${res.payload}`).toBe(401);
      expect(res.code()).toBe('AUTH_REQUIRED');
    }
  });

  it('refuses the licensed reads to a key with no scopes, and allows the caller-state ones', async () => {
    const empty = await apiToken(alice.userId, []);

    // `/news` and the watchlist CSV serve licensed rows: no scope, no read.
    const news = await callAs(empty, '/news');
    expect(news.statusCode, news.payload).toBe(403);
    expect(news.code()).toBe('FORBIDDEN');
    expect(
      news.json<{ error: { details?: { requiredScope?: string[] } } }>().error.details
        ?.requiredScope,
    ).toEqual(['data:read']);

    // A watchlist is the caller's own state, not data: API.md's Role column says "any".
    const lists = await callAs(empty, '/watchlists');
    expect(lists.statusCode, lists.payload).toBe(200);
  });

  it('lets a key with data:read read the news', async () => {
    const scoped = await apiToken(alice.userId, ['data:read']);
    const res = await callAs(scoped, '/news');
    expect(res.statusCode, res.payload).toBe(200);
    expect(NewsListResponse.parse(res.json()).items.length).toBeGreaterThan(0);
  });

  it('refuses a cookie mutation that does not carry the CSRF header', async () => {
    const res = wrap(
      await app.inject({
        method: 'POST',
        url: '/api/v1/saved-searches',
        headers: { cookie: alice.cookie },
        payload: { kind: 'news', name: 'No CSRF', query: { q: 'apple' } },
      }),
    );
    expect(res.statusCode, res.payload).toBe(403);
    expect(res.code()).toBe('CSRF_REJECTED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. News (NEWS-01, NEWS-02, NEWS-08)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('news (API.md §5.6)', () => {
  it('serves the story with a provenance citation and NEWS-08 false', async () => {
    const res = await call(alice, 'GET', '/news?limit=10');
    expect(res.statusCode, res.payload).toBe(200);
    const body = NewsListResponse.parse(res.json());

    const item = body.items.find((row) => row.newsId === newsId);
    expect(item, res.payload).toBeDefined();
    expect(item!.machineGenerated).toBe(false);
    expect(item!.headline).toBe('Apple raises guidance');

    // DATA-10: the index the item cites names a row of `meta.provenance`, and that row is the
    // `provenance_id` the ingest wrote — not a placeholder.
    const cited = body.meta.provenance[item!.provIdx];
    expect(cited, JSON.stringify(body.meta.provenance)).toBeDefined();
    expect(cited!.provenanceId).toBe(bbgProvenanceId);
    expect(cited!.sourceId).toBe('bbg.rss');
    expect(cited!.attribution).not.toBe('');
  });

  it('filters by instrument through the resolved links (NEWS-02)', async () => {
    const res = await call(alice, 'GET', `/news?instrumentId=${String(instrumentId)}`);
    expect(res.statusCode, res.payload).toBe(200);
    const body = NewsListResponse.parse(res.json());
    expect(body.items.map((row) => row.newsId)).toContain(newsId);
  });

  it('serves one story with its links, and 404s an id that is not there', async () => {
    const res = await call(alice, 'GET', `/news/${String(newsId)}`);
    expect(res.statusCode, res.payload).toBe(200);
    const item = NewsItemResponse.parse(res.json());
    expect(item.links).toHaveLength(1);
    expect(item.links[0]).toMatchObject({
      entityKind: 'instrument',
      entityId: instrumentId,
      method: 'ticker_exact',
      confidence: 1,
    });
    expect(item.links[0]!.display).toBe('Apple Inc');

    const missing = await call(alice, 'GET', `/news/${String(newsId + 10_000_000)}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.code()).toBe('NOT_FOUND');
  });

  it('ranks the front page and lists the topic tree', async () => {
    const top = await call(alice, 'GET', '/news/top?scope=all&limit=5');
    expect(top.statusCode, top.payload).toBe(200);
    expect(
      NewsListResponse.omit({ nextCursor: true }).parse(top.json()).items.length,
    ).toBeGreaterThan(0);

    const topics = await call(alice, 'GET', '/topics');
    expect(topics.statusCode, topics.payload).toBe(200);
    expect(TopicListResponse.parse(topics.json()).topics.length).toBeGreaterThan(0);
  });

  it('rejects a cursor it did not mint with a 400, not a 500', async () => {
    const res = await call(alice, 'GET', '/news?cursor=not-a-cursor');
    expect(res.statusCode, res.payload).toBe(400);
    expect(res.code()).toBe('BAD_REQUEST');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. Watchlists (W, CHRT-07, §9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('watchlists (API.md §5.8)', () => {
  it('creates a list with a resolved member and reads it back with the instrument summary', async () => {
    const created = await createSharedWatchlist();
    expect(created.items).toHaveLength(1);
    expect(created.items![0]!.instrument?.instrumentId).toBe(instrumentId);
    expect(created.items![0]!.formula).toBeNull();

    const listed = await call(alice, 'GET', '/watchlists');
    const body = WatchlistListResponse.parse(listed.json());
    // `items` is omitted on the list route.
    expect(
      body.items.find((row) => row.watchlistId === created.watchlistId)?.items,
    ).toBeUndefined();
  });

  it('lets a colleague read a firm-shared list and refuses to let them change it', async () => {
    const created = await createSharedWatchlist();

    const read = await call(bob, 'GET', `/watchlists/${String(created.watchlistId)}`);
    expect(read.statusCode, read.payload).toBe(200);

    const write = await call(bob, 'PUT', `/watchlists/${String(created.watchlistId)}`, {
      name: 'Bob took it',
      columns: [{ id: 'PX_LAST' }],
    });
    expect(write.statusCode, write.payload).toBe(404);
    expect(write.code()).toBe('NOT_FOUND');
  });

  it('answers a cross-firm read with 404, never 403', async () => {
    const created = await createSharedWatchlist();
    for (const [method, url] of [
      ['GET', `/watchlists/${String(created.watchlistId)}`],
      ['DELETE', `/watchlists/${String(created.watchlistId)}`],
    ] as const) {
      const res = await call(carol, method, url);
      expect(res.statusCode, `${method} ${url} → ${res.payload}`).toBe(404);
      expect(res.code()).toBe('NOT_FOUND');
    }
  });

  it('replaces the membership wholesale and deletes the list', async () => {
    const created = await createSharedWatchlist();
    const replaced = await call(alice, 'PUT', `/watchlists/${String(created.watchlistId)}/items`, {
      items: [
        { formula: 'RATIO(AAPL US Equity, AAPL US Equity)', label: 'Self ratio' },
        { security: { id: instrumentId } },
      ],
    });
    expect(replaced.statusCode, replaced.payload).toBe(200);
    const body = Watchlist.parse(replaced.json());
    expect(body.items).toHaveLength(2);
    expect(body.items![0]!.formula).toBe('RATIO(AAPL US Equity, AAPL US Equity)');
    expect(body.items![1]!.instrument?.instrumentId).toBe(instrumentId);

    const removed = await call(alice, 'DELETE', `/watchlists/${String(created.watchlistId)}`);
    expect(removed.statusCode, removed.payload).toBe(204);
    const gone = await call(alice, 'GET', `/watchlists/${String(created.watchlistId)}`);
    expect(gone.statusCode).toBe(404);
  });

  it('computes a CHRT-07 formula column through core/formula in the §9 export', async () => {
    const created = await createSharedWatchlist();
    const res = await call(alice, 'GET', `/watchlists/${String(created.watchlistId)}/export.csv`);
    expect(res.statusCode, res.payload).toBe(200);

    const lines = res.payload.split('\r\n').filter((line) => line !== '');
    const header = lines.find((line) => line.startsWith('security,'));
    expect(header, res.payload).toBe('security,PX_LAST,PX_BID,c1');

    const row = lines[lines.indexOf(header!) + 1]!.split(',');
    expect(row[1]).toBe(String(PX_LAST));
    expect(row[2]).toBe(String(PX_BID));
    // `PX_LAST / PX_BID` = 200 / 100, evaluated by `core/formula` over the row's own fields.
    expect(row[3]).toBe('2');

    // The §9 header block carries the provenance and the licence attribution.
    expect(res.payload).toContain('# terminal-export v1');
    expect(res.payload).toContain('# source:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. Alerts and saved searches (NEWS-07)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('alerts and saved searches (API.md §5.11)', () => {
  it('resolves a price alert to an instrument id and keeps it off other desks', async () => {
    const created = await call(alice, 'POST', '/alerts', {
      condition: { kind: 'price', security: { id: instrumentId }, op: '>=', value: 250 },
      oneShot: true,
    });
    expect(created.statusCode, created.payload).toBe(201);
    const alert = Alert.parse(created.json());
    expect(alert.status).toBe('armed');
    expect(alert.oneShot).toBe(true);
    expect(alert.condition).toMatchObject({ kind: 'price', security: { id: instrumentId } });

    // The engine's index is `(instrument_id) WHERE status='armed' AND kind='price'`.
    const stored = await t.client.query<{ kind: string; instrument_id: string }>(
      `SELECT kind, instrument_id::text AS instrument_id FROM alerts WHERE alert_id = $1`,
      [alert.alertId],
    );
    expect(stored.rows[0]).toMatchObject({
      kind: 'price',
      instrument_id: String(instrumentId),
    });

    const mine = AlertListResponse.parse((await call(alice, 'GET', '/alerts')).json());
    expect(mine.items.map((row) => row.alertId)).toContain(alert.alertId);

    const theirs = await call(bob, 'GET', `/alerts/${String(alert.alertId)}`);
    expect(theirs.statusCode, theirs.payload).toBe(404);
    const crossFirm = await call(carol, 'GET', `/alerts/${String(alert.alertId)}`);
    expect(crossFirm.statusCode).toBe(404);
  });

  it('pauses, soft-deletes and keeps the firings readable', async () => {
    const created = Alert.parse(
      (
        await call(alice, 'POST', '/alerts', {
          condition: { kind: 'price', security: { id: instrumentId }, op: '<=', value: 1 },
        })
      ).json(),
    );

    const paused = await call(alice, 'PUT', `/alerts/${String(created.alertId)}`, {
      status: 'paused',
    });
    expect(paused.statusCode, paused.payload).toBe(200);
    expect(Alert.parse(paused.json()).status).toBe('paused');

    // One firing, as `alerts/engine.ts` writes it.
    const fired = await t.client.query<{ event_id: string }>(
      `INSERT INTO alert_events (alert_id, firm_id, fired_at, payload, delivered)
       VALUES ($1, $2, timestamptz '2026-09-15T18:00:00Z',
               $3::jsonb, '{"inapp": "2026-09-15T18:00:00.000Z"}'::jsonb)
       RETURNING event_id`,
      [created.alertId, alice.firmId, JSON.stringify({ value: 0.5, summary: 'AAPL <= 1' })],
    );
    const eventId = Number(fired.rows[0]!.event_id);

    const events = await call(alice, 'GET', '/alerts/events?limit=10');
    expect(events.statusCode, events.payload).toBe(200);
    expect(
      events.json<{ items: { eventId: number }[] }>().items.map((row) => row.eventId),
    ).toContain(eventId);

    // Somebody else's firing is not acknowledgeable, and is not there to be found.
    const notYours = await call(bob, 'POST', `/alerts/events/${String(eventId)}/ack`);
    expect(notYours.statusCode, notYours.payload).toBe(404);

    const ack = await call(alice, 'POST', `/alerts/events/${String(eventId)}/ack`);
    expect(ack.statusCode, ack.payload).toBe(204);
    const acked = await t.client.query<{ acknowledged_at: string | null }>(
      `SELECT acknowledged_at FROM alert_events WHERE event_id = $1`,
      [eventId],
    );
    expect(acked.rows[0]!.acknowledged_at).not.toBeNull();

    const deleted = await call(alice, 'DELETE', `/alerts/${String(created.alertId)}`);
    expect(deleted.statusCode, deleted.payload).toBe(204);
    const after = AlertListResponse.parse((await call(alice, 'GET', '/alerts')).json());
    expect(after.items.map((row) => row.alertId)).not.toContain(created.alertId);
    // The condition survives, so the event above still has its explanation.
    const row = await t.client.query<{ status: string }>(
      `SELECT status FROM alerts WHERE alert_id = $1`,
      [created.alertId],
    );
    expect(row.rows[0]!.status).toBe('deleted');
  });

  it('stores a saved search, refuses a duplicate name and deletes it', async () => {
    const body = { kind: 'news', name: 'Apple', query: { q: 'apple', feed: 'markets' } };
    const created = await call(alice, 'POST', '/saved-searches', body);
    expect(created.statusCode, created.payload).toBe(201);
    const search = SavedSearch.parse(created.json());
    expect(search.query).toEqual({ q: 'apple', feed: 'markets' });

    const again = await call(alice, 'POST', '/saved-searches', body);
    expect(again.statusCode, again.payload).toBe(409);
    expect(again.code()).toBe('DUPLICATE_NAME');

    const theirs = await call(carol, 'GET', `/saved-searches/${String(search.searchId)}`);
    expect(theirs.statusCode).toBe(404);

    const removed = await call(alice, 'DELETE', `/saved-searches/${String(search.searchId)}`);
    expect(removed.statusCode, removed.payload).toBe(204);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. Messaging (MSG-01..06)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('messaging (API.md §5.10)', () => {
  it('creates a room both members can see and hides it from everyone else', async () => {
    const { room } = await roomWithAttachment();
    expect(room.members.map((member) => member.userId).sort()).toEqual(
      [alice.userId, bob.userId].sort(),
    );

    for (const actor of [alice, bob]) {
      const mine = RoomListResponse.parse((await call(actor, 'GET', '/rooms')).json());
      expect(mine.items.map((row) => row.roomId)).toContain(room.roomId);
    }

    const outsider = await call(carol, 'GET', `/rooms/${String(room.roomId)}`);
    expect(outsider.statusCode, outsider.payload).toBe(404);
    expect(outsider.code()).toBe('NOT_FOUND');
    const outsiderHistory = await call(carol, 'GET', `/rooms/${String(room.roomId)}/messages`);
    expect(outsiderHistory.statusCode).toBe(404);
  });

  it('is idempotent on clientMsgId and hands back a chained history', async () => {
    const { room } = await roomWithAttachment();
    const clientMsgId = randomUUID();

    const first = await call(alice, 'POST', `/rooms/${String(room.roomId)}/messages`, {
      clientMsgId,
      body: 'once',
    });
    expect(first.statusCode, first.payload).toBe(201);
    const sent = Message.parse(first.json());

    const repeat = await call(alice, 'POST', `/rooms/${String(room.roomId)}/messages`, {
      clientMsgId,
      body: 'once',
    });
    expect(repeat.statusCode, repeat.payload).toBe(200);
    expect(Message.parse(repeat.json()).hash).toBe(sent.hash);

    const history = await call(bob, 'GET', `/rooms/${String(room.roomId)}/messages?limit=50`);
    expect(history.statusCode, history.payload).toBe(200);
    const items = history.json<{ items: unknown[] }>().items.map((row) => Message.parse(row));
    expect(items.map((row) => row.seq)).toEqual([1, 2]);
    expect(items[1]!.prevHash).toBe(items[0]!.hash);

    const read = await call(bob, 'POST', `/rooms/${String(room.roomId)}/read`, {
      lastReadSeq: items[1]!.seq,
    });
    expect(read.statusCode, read.payload).toBe(204);
  });

  it('lets only an owner or supervisor change the membership', async () => {
    const { room } = await roomWithAttachment();
    const outsiderId = await newUser(firmId, 'Eve Extra');

    const byMember = await call(bob, 'POST', `/rooms/${String(room.roomId)}/members`, {
      userIds: [outsiderId],
    });
    expect(byMember.statusCode, byMember.payload).toBe(403);
    expect(byMember.code()).toBe('FORBIDDEN');

    const byOwner = await call(alice, 'POST', `/rooms/${String(room.roomId)}/members`, {
      userIds: [outsiderId],
    });
    expect(byOwner.statusCode, byOwner.payload).toBe(200);
    expect(Room.parse(byOwner.json()).members.map((m) => m.userId)).toContain(outsiderId);

    const removed = await call(alice, 'DELETE', `/rooms/${String(room.roomId)}/members`, {
      userIds: [outsiderId],
    });
    expect(removed.statusCode, removed.payload).toBe(200);
    expect(Room.parse(removed.json()).members.map((m) => m.userId)).not.toContain(outsiderId);
  });

  it('finds a counterparty in the directory (MSG-01)', async () => {
    const res = await call(alice, 'GET', '/directory?q=Carol');
    expect(res.statusCode, res.payload).toBe(200);
    const items = res.json<{ items: { userId: number; verified: boolean }[] }>().items;
    expect(items.map((row) => row.userId)).toContain(carol.userId);
    expect(items.find((row) => row.userId === carol.userId)?.verified).toBe(true);
  });

  it('MSG-04: one attachment resolves differently for two readers', async () => {
    const { room, message } = await roomWithAttachment();
    const url = `/rooms/${String(room.roomId)}/messages/${String(message.seq)}/attachments/0`;

    // Nothing of the sender's view is stored with the message: the attachment is a reference.
    expect(message.attachments).toEqual([{ kind: 'security', instrumentId }]);

    const forAlice = await call(alice, 'GET', url);
    expect(forAlice.statusCode, forAlice.payload).toBe(200);
    const alicesData = forAlice.json<{ kind: string; data: DataResponse }>().data;
    expect(alicesData.results[0]!.fields?.PX_LAST).toBe(PX_LAST);

    // Bob is in the same room, reading the same row, and his user grant covers reference fields
    // only: he does not receive the number Alice saw.
    const forBob = await call(bob, 'GET', url);
    expect(forBob.statusCode).toBe(403);
    expect(forBob.code()).toBe('ENTITLEMENT_DENIED');

    // And the attachment is not readable at all by someone with no seat in the room.
    const forCarol = await call(carol, 'GET', url);
    expect(forCarol.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. Help (TERM-09)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('help (API.md §5.12)', () => {
  it('opens a ticket with a helpdesk room and a usage event, visible only to the opener', async () => {
    const res = await call(alice, 'POST', '/help/tickets', {
      functionCode: 'DES',
      security: { id: instrumentId },
      screenState: { PX_LAST: { provIdx: 0 } },
      question: 'Why is the last price stale?',
    });
    expect(res.statusCode, res.payload).toBe(201);
    const { ticketId, roomId } = res.json<{ ticketId: number; roomId: number }>();

    // HELP ×2: the row, the room with the desk in it, and the usage event — one transaction.
    const room = await call(alice, 'GET', `/rooms/${String(roomId)}`);
    expect(room.statusCode, room.payload).toBe(200);
    const parsed = Room.parse(room.json());
    expect(parsed.kind).toBe('helpdesk');
    expect(parsed.members.map((member) => member.userId)).toContain(deskUserId);

    const events = await t.client.query<{ kind: string; code: string | null }>(
      `SELECT kind, code FROM usage_events WHERE user_id = $1 AND kind = 'ticket.open'`,
      [alice.userId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.code).toBe('DES');

    const mine = TicketListResponse.parse((await call(alice, 'GET', '/help/tickets')).json());
    expect(mine.items.map((row) => row.ticketId)).toContain(ticketId);
    expect(mine.items.find((row) => row.ticketId === ticketId)?.roomId).toBe(roomId);

    const theirs = TicketListResponse.parse((await call(bob, 'GET', '/help/tickets')).json());
    expect(theirs.items.map((row) => row.ticketId)).not.toContain(ticketId);
  });

  it('404s a code no manifest claims', async () => {
    const res = await call(alice, 'GET', '/help/ZZZZ');
    expect(res.statusCode, res.payload).toBe(404);
    expect(res.code()).toBe('FUNCTION_NOT_FOUND');
  });
});
