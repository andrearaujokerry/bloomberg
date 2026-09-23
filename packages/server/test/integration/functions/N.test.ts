/**
 * `test/integration/functions/N.test.ts` — the chronological reader (FUNCTIONS_TIER1.md §N).
 *
 * N is TOP's corpus read a different way, and the four properties that make it a *reader* rather
 * than a second ranked list are what this file proves:
 *
 *  - **chronological, never re-ranked.** Rows are strictly descending by `(publishedAt, newsId)`,
 *    which is the only ordering under which keyset paging can promise each row exactly once;
 *  - **it says how it matched.** `matcher` is `tsquery` when the stemmed query hit, `trigram` when
 *    it fell back, `none` when there was no query — and the fallback carries `TRIGRAM_FALLBACK`
 *    in `meta.unavailable` rather than presenting near-misses as hits;
 *  - **paging moves backwards in time and never overlaps.** PAGE FWD returns strictly older rows,
 *    `total` does not move, and the cursor decodes to the keyset of the last row of the page;
 *  - **every degradation is named.** A security scope with no security, an unknown topic or feed,
 *    a saved search belonging to somebody else: each one continues with a reason instead of
 *    failing or silently ignoring the input.
 *
 * WP-15 owns the seed, so every firm, user, grant, topic and headline is created here.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden, subjectToken } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { N } from '@terminal/core/functions/manifests/N';
import type { NPayload } from '@terminal/core/functions/manifests/N';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as NModule from '../../../src/functions/N/resolve.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const GOLDEN_NAME = 'N.default.json';

const REGISTRY = new FunctionRegistry([N]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  N: NModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

/** The five named headlines plus the paging filler. */
const CORPUS = 30;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The corpus
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The thirteen v1 topic codes, plus one child so `NI`-style rolling has something to roll. */
const TOPICS: readonly { code: string; name: string; kind: string; keywords: string[] }[] = [
  { code: 'MARKETS', name: 'Markets', kind: 'feed', keywords: [] },
  { code: 'ECO', name: 'Economics', kind: 'feed', keywords: [] },
  { code: 'POLITICS', name: 'Politics', kind: 'feed', keywords: [] },
  { code: 'TECH', name: 'Technology', kind: 'feed', keywords: [] },
  { code: 'WEALTH', name: 'Wealth', kind: 'feed', keywords: [] },
  { code: 'INDUSTRIES', name: 'Industries', kind: 'feed', keywords: [] },
  { code: 'FED', name: 'Federal Reserve', kind: 'release', keywords: [] },
  { code: 'FILINGS', name: 'Filings', kind: 'release', keywords: [] },
  { code: 'EARNINGS', name: 'Earnings', kind: 'event', keywords: [] },
  { code: 'CA', name: 'Corporate actions', kind: 'event', keywords: [] },
  { code: 'RATES', name: 'Rates', kind: 'theme', keywords: ['rate cut', 'rates'] },
  { code: 'FX', name: 'Foreign exchange', kind: 'theme', keywords: ['dollar'] },
  { code: 'AI', name: 'Artificial intelligence', kind: 'theme', keywords: ['ai'] },
];

interface StorySpec {
  sourceId: 'bbg.rss' | 'sec.atom' | 'fed.rss';
  feed: string;
  guid: string;
  kind: string;
  headline: string;
  summary: string | null;
  url: string;
  publishedAt: string;
  capturedAt: string;
  isCorrection?: boolean;
  cik?: string | null;
  items8k?: string[] | null;
  topics?: { code: string; method: string; confidence: number }[];
}

/** Five headlines at the frozen clock: one of each source, and one of each behaviour under test. */
const STORIES: readonly StorySpec[] = [
  {
    sourceId: 'bbg.rss',
    feed: 'markets',
    guid: 'TLEUW0KGZAKZ00',
    kind: 'video',
    headline: "AI Will Be Biggest 'Misallocation' of Capital, Says Noble",
    summary: 'Correct: the capital reallocation thesis, restated.',
    url: 'https://www.bloomberg.com/news/videos/2026-09-15/ai-misallocation-video',
    publishedAt: '2026-09-15T15:04:08.000Z',
    capturedAt: '2026-09-15T18:40:06.000Z',
    isCorrection: true,
    topics: [
      { code: 'MARKETS', method: 'feed_topic', confidence: 1 },
      { code: 'AI', method: 'keyword', confidence: 0.9 },
    ],
  },
  {
    sourceId: 'sec.atom',
    feed: '8-K',
    guid: 'urn:tag:sec.gov,2008:accession-number=0001213900-26-100070',
    kind: 'filing',
    headline: '8-K · Aerkomm Inc · Item 5.02 Departure of Directors',
    summary: null,
    url: 'https://www.sec.gov/Archives/edgar/data/1590496/000121390026100070/index.htm',
    publishedAt: '2026-09-15T18:21:20.000Z',
    capturedAt: '2026-09-15T18:41:00.000Z',
    cik: '0001590496',
    items8k: ['5.02'],
    topics: [{ code: 'FILINGS', method: 'feed_topic', confidence: 1 }],
  },
  {
    sourceId: 'fed.rss',
    feed: 'press_all',
    guid: 'https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260915a.htm',
    kind: 'fed_release',
    headline: 'Federal Reserve Board announces termination of enforcement action',
    summary: 'The Board announced the termination of an enforcement action.',
    url: 'https://www.federalreserve.gov/newsevents/pressreleases/bcreg20260915a.htm',
    publishedAt: '2026-09-15T13:55:00.000Z',
    capturedAt: '2026-09-15T18:39:40.000Z',
    topics: [{ code: 'FED', method: 'feed_topic', confidence: 1 }],
  },
  {
    sourceId: 'bbg.rss',
    feed: 'economics',
    guid: 'TLEUW0KGZAKZ01',
    kind: 'story',
    headline: 'Traders Trim Bets on an October Rate Cut',
    summary: 'Swaps now imply a lower chance of a cut at the October meeting.',
    url: 'https://www.bloomberg.com/news/articles/2026-09-15/traders-trim-bets',
    publishedAt: '2026-09-15T11:02:00.000Z',
    capturedAt: '2026-09-15T18:40:06.000Z',
    topics: [
      { code: 'ECO', method: 'feed_topic', confidence: 1 },
      { code: 'RATES', method: 'keyword', confidence: 0.9 },
    ],
  },
  {
    sourceId: 'bbg.rss',
    feed: 'markets',
    guid: 'TLEUW0KGZAKZ02',
    kind: 'story',
    headline: 'Apple Shares Rise on Capital Return Plan',
    summary: 'The board approved a larger buyback.',
    url: 'https://www.bloomberg.com/news/articles/2026-09-15/apple-capital-return',
    publishedAt: '2026-09-15T09:30:00.000Z',
    capturedAt: '2026-09-15T18:40:06.000Z',
    topics: [{ code: 'MARKETS', method: 'feed_topic', confidence: 1 }],
  },
];

async function ensureLicences(): Promise<void> {
  const present = await t.client.query(
    `SELECT 1 FROM licence_registry WHERE tx_to = 'infinity' LIMIT 1`,
  );
  if (present.rowCount === 0) await seedLicences(t.client);
}

/** A firm+user pair granted exactly the named sources, for `display`, `export` and `api`. */
async function grantSources(
  firmId: number,
  userId: number,
  sources: readonly string[],
): Promise<void> {
  await t.client.query(
    `INSERT INTO entitlement_grants
       (subject_kind, subject_id, source_id, asset_class, field_class, max_tier,
        usage_display, usage_export, usage_api, valid_from, valid_to)
     SELECT k.kind, k.id, s.source_id, NULL, NULL, 'realtime'::tier, true, true, true,
            $3::timestamptz, 'infinity'::timestamptz
       FROM unnest($4::text[]) AS s(source_id)
       CROSS JOIN (VALUES ('firm', $1::bigint), ('user', $2::bigint)) AS k(kind, id)`,
    [firmId, userId, GRANT_FROM, [...sources]],
  );
}

async function createSession(userId: number): Promise<string> {
  const token = `sess-${randomUUID()}`;
  await t.client.query(
    `INSERT INTO sessions (user_id, token_hash, client_kind, expires_at, mfa_verified)
     VALUES ($1, $2, 'web', now() + interval '1 day', true)`,
    [userId, createHash('sha256').update(token, 'utf8').digest()],
  );
  return `tsid=${encodeURIComponent(cookie.sign(token, getConfig().SESSION_SECRET))}`;
}

async function createFirmUser(
  label: string,
  sources: readonly string[],
): Promise<{ firmId: number; userId: number; cookie: string }> {
  const firm = await t.client.query<{ firm_id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING firm_id`,
    [`${label} ${randomUUID().slice(0, 8)}`],
  );
  const firmId = Number(firm.rows[0]!.firm_id);
  const user = await t.client.query<{ user_id: string }>(
    `INSERT INTO users (firm_id, email, display_name, role)
     VALUES ($1, $2, $3, 'user') RETURNING user_id`,
    [firmId, `n-${randomUUID()}@demo.invalid`, label],
  );
  const userId = Number(user.rows[0]!.user_id);
  await grantSources(firmId, userId, sources);
  return { firmId, userId, cookie: await createSession(userId) };
}

async function seedCorpus(
  db: TestDb,
  stories: readonly StorySpec[],
  extraTopics: readonly { code: string; name: string; kind: string; parent?: string }[] = [],
): Promise<{ newsIds: Map<string, number>; topicIds: Map<string, number> }> {
  const topicIds = new Map<string, number>();
  for (const topic of TOPICS) {
    const res = await db.client.query<{ topic_id: string }>(
      `INSERT INTO topics (code, name, kind, keywords) VALUES ($1, $2, $3, $4)
       RETURNING topic_id`,
      [topic.code, topic.name, topic.kind, topic.keywords],
    );
    topicIds.set(topic.code, Number(res.rows[0]!.topic_id));
  }
  for (const topic of extraTopics) {
    const res = await db.client.query<{ topic_id: string }>(
      `INSERT INTO topics (code, name, kind, parent_topic_id) VALUES ($1, $2, $3, $4)
       RETURNING topic_id`,
      [topic.code, topic.name, topic.kind, topic.parent === undefined ? null : topicIds.get(topic.parent)],
    );
    topicIds.set(topic.code, Number(res.rows[0]!.topic_id));
  }

  const provenance = new Map<string, number>();
  for (const sourceId of ['bbg.rss', 'sec.atom', 'fed.rss']) {
    provenance.set(sourceId, await bootstrapProvenance(db, sourceId, `news-${sourceId}`));
  }

  const newsIds = new Map<string, number>();
  for (const story of stories) {
    const res = await db.client.query<{ news_id: string }>(
      `INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url,
                               cik, items_8k, published_at, captured_at, is_correction,
                               provenance_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING news_id`,
      [
        story.sourceId,
        story.feed,
        story.guid,
        story.kind,
        story.headline,
        story.summary,
        story.url,
        story.cik ?? null,
        story.items8k ?? null,
        story.publishedAt,
        story.capturedAt,
        story.isCorrection ?? false,
        provenance.get(story.sourceId)!,
      ],
    );
    const newsId = Number(res.rows[0]!.news_id);
    newsIds.set(story.guid, newsId);
    for (const link of story.topics ?? []) {
      await db.client.query(
        `INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
         VALUES ($1, 'topic', $2, $3, $4)`,
        [newsId, topicIds.get(link.code)!, link.confidence, link.method],
      );
    }
  }
  return { newsIds, topicIds };
}

/**
 * Twenty-five more headlines, so `pageSize` (minimum 10) has three pages to walk.
 *
 * None of them contains the word the golden searches for, so the corpus grows without the golden
 * moving: a paging fixture and a search fixture in one file only stay independent if they are
 * disjoint on purpose.
 */
const FILLER: readonly StorySpec[] = Array.from({ length: 25 }, (_unused, i) => ({
  sourceId: 'bbg.rss' as const,
  feed: 'markets',
  guid: `FILLER${String(i).padStart(2, '0')}`,
  kind: 'story',
  headline: `Session wrap ${String(i + 1)}: equities drift into the close`,
  summary: null,
  url: `https://www.bloomberg.com/news/articles/2026-09-14/wrap-${String(i)}`,
  // Descending by an hour each, all strictly older than the five named stories.
  publishedAt: new Date(Date.parse('2026-09-14T23:00:00.000Z') - i * 3_600_000).toISOString(),
  capturedAt: '2026-09-15T18:40:06.000Z',
  topics: [{ code: 'MARKETS', method: 'feed_topic', confidence: 1 }],
}));

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  otherCookie: string;
  knownAt: string;
  newsIds: Map<string, number>;
  topicIds: Map<string, number>;
  aapl: number;
  savedId: number;
  foreignSavedId: number;
}

let env: Env;

beforeEach(async () => {
  await ensureLicences();

  const main = await createFirmUser('N Firm', ['bbg.rss', 'sec.atom', 'fed.rss', 'cboe.quotes']);
  const other = await createFirmUser('N Other Firm', ['bbg.rss', 'sec.atom', 'fed.rss']);

  const { newsIds, topicIds } = await seedCorpus(t, [...STORIES, ...FILLER]);
  const aapl = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });
  await t.client.query(
    `INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
     VALUES ($1, 'instrument', $2, 1.0, 'ticker_exact')`,
    [newsIds.get('TLEUW0KGZAKZ02')!, aapl.instrumentId],
  );

  // Two saved searches: the caller's own, and one belonging to another firm's user.
  const mine = await t.client.query<{ search_id: string }>(
    `INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
     VALUES ($1, $2, 'news', 'Fed watch', $3::jsonb) RETURNING search_id`,
    [main.userId, main.firmId, JSON.stringify({ q: 'federal', kinds: ['fed_release'] })],
  );
  const foreign = await t.client.query<{ search_id: string }>(
    `INSERT INTO saved_searches (owner_user_id, firm_id, kind, name, query)
     VALUES ($1, $2, 'news', 'Not yours', '{}'::jsonb) RETURNING search_id`,
    [other.userId, other.firmId],
  );

  const wrote = await t.client.query<{ at: string }>(`SELECT clock_timestamp() AS at`);
  const knownAt = new Date(Date.parse(wrote.rows[0]!.at) + 1_000).toISOString();

  const clock = testClock(GOLDEN_CAPTURE_MS);
  const harness = await createTestApp({ db: t.db, clock });
  harness.deps.functions = {
    registry: REGISTRY,
    modules: MODULES,
    resultCache: new ResultCache({ clock }),
  };

  env = {
    harness,
    app: harness.app,
    clock,
    cookie: main.cookie,
    otherCookie: other.cookie,
    knownAt,
    newsIds,
    topicIds,
    aapl: aapl.instrumentId,
    savedId: Number(mine.rows[0]!.search_id),
    foreignSavedId: Number(foreign.rows[0]!.search_id),
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: NPayload;
  meta: {
    provenance: { sourceId: string; provenanceId: number }[];
    unavailable: { field: string; reason: string; detail: string }[];
    page?: { index: number; count: number; cursor: string | null };
    resultId: string;
  };
}

async function runN(
  params: Record<string, unknown> = {},
  security?: Record<string, unknown>,
): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/N/run`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: {
      params,
      ...(security === undefined ? {} : { security }),
      asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt },
    },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

async function pageN(resultId: string, direction: 'fwd' | 'back'): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/N/page`,
    headers: { cookie: env.cookie, 'x-requested-with': 'terminal' },
    payload: { resultId, direction },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

/** The keyset a cursor carries, as `N/resolve.ts` mints it. */
function decode(cursor: string): { publishedAt: string; newsId: number; index: number } {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    publishedAt: string;
    newsId: number;
    index: number;
  };
}

function normalise(payload: NPayload): unknown {
  const tokens = new Map<number, string>([[env.aapl, '<AAPL>']]);
  let n = 0;
  for (const id of env.newsIds.values()) tokens.set(id, `<NEWS${String((n += 1))}>`);
  let k = 0;
  for (const id of env.topicIds.values()) tokens.set(id, `<TOPIC${String((k += 1))}>`);
  return JSON.parse(
    JSON.stringify(payload, (key, value: unknown) => {
      // The cursor embeds a news id, which is a sequence value: tokenised whole.
      if (key === 'nextCursor') return value === null ? null : '<CURSOR>';
      if (typeof value === 'number' && tokens.has(value)) return tokens.get(value);
      // Only a subject string carries an id (`subjectToken`); substituting anywhere in any string
      // made the golden a function of the sequence values this run drew.
      if (typeof value === 'string') return subjectToken(value, tokens);
      return value;
    }),
  );
}

describe('N — news search', () => {
  it('returns the corpus chronologically, newest first, with no matcher', async () => {
    const { data } = await runN();

    expect(data.variant).toBe('default');
    expect(data.matcher).toBe('none');
    expect(data.tsquery).toBeNull();
    expect(data.rows).toHaveLength(Math.min(50, CORPUS));
    expect(data.total).toBe(CORPUS);
    expect(data.totalIsCapped).toBe(false);

    for (let i = 1; i < data.rows.length; i += 1) {
      const prev = data.rows[i - 1]!;
      const row = data.rows[i]!;
      const older =
        prev.publishedAt > row.publishedAt ||
        (prev.publishedAt === row.publishedAt && prev.newsId > row.newsId);
      expect(older, `${prev.publishedAt} then ${row.publishedAt}`).toBe(true);
    }
    for (const row of data.rows) expect(row.machineGenerated).toBe(false);
  });

  it('echoes the stemmed query it actually searched for', async () => {
    const { data } = await runN({ q: 'capital' });

    expect(data.matcher).toBe('tsquery');
    expect(data.tsquery).toBe("'capit'");
    expect(data.rows.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      expect(`${row.headline} ${row.summary ?? ''}`.toLowerCase()).toContain('capital');
    }
    expect(data.query.q).toBe('capital');
  });

  it('falls back to approximate headline matching and says so', async () => {
    // `misallo` stems to itself and matches no lexeme; the fallback finds it as a substring.
    const { data, meta } = await runN({ q: 'Misallo' });

    expect(data.matcher).toBe('trigram');
    expect(data.rows.length).toBeGreaterThanOrEqual(1);
    expect(data.rows[0]!.headline).toContain("Misallocation");
    expect(meta.unavailable).toContainEqual({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: 'TRIGRAM_FALLBACK: no exact match for the query; showing approximate headline matches',
    });
  });

  it('pages backwards in time with a keyset cursor and no overlap', async () => {
    const first = await runN({ pageSize: 10 });
    expect(first.meta.page).toEqual({
      index: 0,
      count: Math.ceil(CORPUS / 10),
      cursor: first.data.nextCursor,
    });
    const cursor = decode(first.data.nextCursor!);
    expect(cursor.publishedAt).toBe(first.data.rows[9]!.publishedAt);
    expect(cursor.newsId).toBe(first.data.rows[9]!.newsId);

    const second = await pageN(first.meta.resultId, 'fwd');
    expect(second.meta.page?.index).toBe(1);
    expect(second.data.total).toBe(first.data.total);
    // Strictly older, and no row repeated.
    expect(second.data.rows[0]!.publishedAt < first.data.rows[9]!.publishedAt).toBe(true);
    const seen = new Set(first.data.rows.map((r) => r.newsId));
    for (const row of second.data.rows) expect(seen.has(row.newsId)).toBe(false);

    const third = await pageN(second.meta.resultId, 'fwd');
    expect(third.meta.page?.index).toBe(2);
    expect(third.data.rows).toHaveLength(CORPUS - 20);
    expect(third.data.nextCursor).toBeNull();
    expect(third.data.total).toBe(first.data.total);
  });

  it('pins the query to the panel security, and degrades with a reason without one', async () => {
    const pinned = await runN({ scope: 'security' }, { id: env.aapl });
    expect(pinned.data.query.instrumentId).toBe(env.aapl);
    expect(pinned.data.query.instrumentDisplay).toBe('AAPL US Equity');
    expect(pinned.data.rows).toHaveLength(1);
    expect(pinned.data.rows[0]!.headline).toBe('Apple Shares Rise on Capital Return Plan');
    // NEWS-02: only links at or above the precision floor reach a screen.
    for (const row of pinned.data.rows) {
      for (const link of row.links) expect(link.confidence).toBeGreaterThanOrEqual(0.9);
    }

    const loose = await runN({ scope: 'security' });
    expect(loose.data.query.instrumentId).toBeNull();
    expect(loose.meta.unavailable).toContainEqual({
      field: 'query.instrumentId',
      reason: 'NOT_APPLICABLE',
      detail: 'NO_SECURITY_LOADED: N SCOPE=SECURITY needs a security in the panel',
    });
    expect(loose.data.rows).toHaveLength(Math.min(50, CORPUS));
  });

  it('drops an unknown topic and an unknown feed, naming each', async () => {
    const { data, meta } = await runN({ topics: ['FED', 'NOPE'], feeds: ['nowhere'] });

    expect(data.query.topics).toEqual(['FED']);
    expect(data.query.feeds).toEqual([]);
    expect(meta.unavailable).toContainEqual({
      field: 'query.topics',
      reason: 'NOT_APPLICABLE',
      detail: 'UNKNOWN_TOPIC: NOPE',
    });
    expect(meta.unavailable).toContainEqual({
      field: 'query.feeds',
      reason: 'NOT_APPLICABLE',
      detail: 'UNKNOWN_FEED: nowhere',
    });
    expect(data.rows.map((r) => r.sourceId)).toEqual(['fed.rss']);
  });

  it('merges a saved search under the explicit params, and refuses another user’s', async () => {
    const loaded = await runN({ savedSearchId: env.savedId });
    expect(loaded.data.savedSearch).toEqual({ searchId: env.savedId, name: 'Fed watch' });
    expect(loaded.data.query.q).toBe('federal');
    expect(loaded.data.query.kinds).toEqual(['fed_release']);

    // Explicit params win field by field; the saved `kinds` still applies.
    const overridden = await runN({ savedSearchId: env.savedId, q: 'capital' });
    expect(overridden.data.query.q).toBe('capital');
    expect(overridden.data.query.kinds).toEqual(['fed_release']);

    const foreign = await runN({ savedSearchId: env.foreignSavedId });
    expect(foreign.data.savedSearch).toBeNull();
    expect(foreign.meta.unavailable).toContainEqual({
      field: 'savedSearch',
      reason: 'NOT_APPLICABLE',
      detail: 'SAVED_SEARCH_NOT_YOURS',
    });
  });

  it('offers a live subject only when the query can be evaluated on the wire', async () => {
    const text = await runN({ q: 'capital' });
    expect(N.live!({ ...text.data.query } as never, text.data)).toBeNull();
    expect(text.meta.unavailable).toContainEqual({
      field: 'live',
      reason: 'NOT_APPLICABLE',
      detail: 'NO_LIVE_FOR_TEXT_QUERY: text queries cannot be evaluated on the wire',
    });

    const topic = await runN({ topics: ['FED'] });
    const live = N.live!({ ...topic.data.query } as never, topic.data)!;
    expect(live.subjects).toEqual(['n:topic:FED']);
    expect(live.fields).toEqual([]);

    const pinned = await runN({ scope: 'security' }, { id: env.aapl });
    expect(N.live!({ ...pinned.data.query } as never, pinned.data)!.subjects).toEqual([
      `n:inst:${String(env.aapl)}`,
    ]);
  });

  it('cites every headline and reports feed health (DATA-10, TERM-12)', async () => {
    const { data, meta } = await runN();
    expect(data.feedHealth).toHaveLength(4);
    for (const row of data.rows) {
      expect(meta.provenance[row.provIdx]?.sourceId).toBe(row.sourceId);
    }
    expect(data.suppressed.entitlement).toBe(0);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runN({ q: 'capital' });
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
