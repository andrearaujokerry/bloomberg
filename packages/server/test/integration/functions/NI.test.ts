/**
 * `test/integration/functions/NI.test.ts` — the topic browser (FUNCTIONS_TIER1.md §NI).
 *
 * NI's hard claim is not about headlines, it is about **absence**. Headlines reach a topic two
 * ways in v1 — a feed mapping and a narrow whole-word keyword match — and two of the seeded topics
 * have neither. This file proves that those nodes are listed, greyed and carry the reason, and
 * that they are distinguishable from a topic that has a source and simply received nothing in the
 * window: `TOPIC_NO_SOURCE` and `NO_HEADLINES_IN_CORPUS` are different sentences because they are
 * different facts, and a screen that showed both as an empty list would be lying by omission.
 *
 * The other two claims are structural: `includeChildren` rolls descendants into the list (and the
 * roll is visible in `rolledCodes`, not just in the rows), and a selection with no headlines still
 * returns its `liveSubject`, because a future source would stream into it.
 *
 * WP-15 owns the seed, so every firm, user, grant, topic and headline is created here.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { NI } from '@terminal/core/functions/manifests/NI';
import type { NiPayload } from '@terminal/core/functions/manifests/NI';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as NIModule from '../../../src/functions/NI/resolve.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const GOLDEN_NAME = 'NI.default.json';

const REGISTRY = new FunctionRegistry([NI]);
const MODULES: Record<string, FunctionServerModule<never, never>> = {
  NI: NIModule as unknown as FunctionServerModule<never, never>,
};

const t: TestDb = withTxDb();

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
    url: 'https://www.bloomberg.com/news/videos/2026-09-15/ai-misallocationi-video',
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
    guid: 'urn:tag:sec.gov,2008:accessioni-number=0001213900-26-100070',
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
    [firmId, `ni-${randomUUID()}@demo.invalid`, label],
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

/** A child of FED, so `includeChildren` has a descendant to roll (and one headline to find). */
const FOMC: StorySpec = {
  sourceId: 'fed.rss',
  feed: 'press_all',
  guid: 'https://www.federalreserve.gov/monetarypolicy/fomcminutes20260826.htm',
  kind: 'press_release',
  headline: 'Minutes of the Federal Open Market Committee, August 2026',
  summary: 'The Committee reviewed the outlook.',
  url: 'https://www.federalreserve.gov/monetarypolicy/fomcminutes20260826.htm',
  publishedAt: '2026-09-15T11:30:00.000Z',
  capturedAt: '2026-09-15T18:39:40.000Z',
  topics: [{ code: 'FOMC', method: 'feed_topic', confidence: 1 }],
};

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  narrowCookie: string;
  knownAt: string;
  newsIds: Map<string, number>;
  topicIds: Map<string, number>;
}

let env: Env;

beforeEach(async () => {
  await ensureLicences();

  const main = await createFirmUser('NI Firm', ['bbg.rss', 'sec.atom', 'fed.rss']);
  const narrow = await createFirmUser('NI Narrow Firm', ['sec.atom', 'fed.rss']);

  const { newsIds, topicIds } = await seedCorpus(t, [...STORIES, FOMC], [
    { code: 'FOMC', name: 'FOMC', kind: 'event', parent: 'FED' },
  ]);

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
    narrowCookie: narrow.cookie,
    knownAt,
    newsIds,
    topicIds,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: NiPayload;
  meta: {
    provenance: { sourceId: string; provenanceId: number }[];
    unavailable: { field: string; reason: string; detail: string }[];
  };
}

async function runNi(params: Record<string, unknown> = {}, which = 'main'): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/NI/run`,
    headers: {
      cookie: which === 'main' ? env.cookie : env.narrowCookie,
      'x-requested-with': 'terminal',
    },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

function normalise(payload: NiPayload): unknown {
  const tokens = new Map<number, string>();
  let n = 0;
  for (const id of env.newsIds.values()) tokens.set(id, `<NEWS${String((n += 1))}>`);
  let k = 0;
  for (const id of env.topicIds.values()) tokens.set(id, `<TOPIC${String((k += 1))}>`);
  return JSON.parse(
    JSON.stringify(payload, (_key, value: unknown) => {
      if (typeof value === 'number' && tokens.has(value)) return tokens.get(value);
      if (typeof value === 'string') {
        let out = value;
        for (const [id, token] of tokens) out = out.split(String(id)).join(token);
        return out;
      }
      return value;
    }),
  );
}

describe('NI — news by topic', () => {
  it('browses the whole tree with no selection', async () => {
    const { data } = await runNi();

    expect(data.selected).toBeNull();
    expect(data.rows).toEqual([]);
    expect(data.liveSubject).toBeNull();
    expect(data.rolledCodes).toEqual([]);
    expect(data.topics).toHaveLength(14);
    // Parents before children: the one child node sorts after every root.
    const codes = data.topics.map((node) => node.code);
    expect(codes.indexOf('FOMC')).toBe(codes.length - 1);
    expect(data.topics.find((node) => node.code === 'FED')!.childCodes).toEqual(['FOMC']);
  });

  it('lists a sourceless topic greyed, with the reason, and never as an empty list', async () => {
    const { data, meta } = await runNi();

    for (const code of ['EARNINGS', 'CA']) {
      const node = data.topics.find((n) => n.code === code)!;
      expect(node.linkMethods).toEqual([]);
      expect(node.reason).toBe('TOPIC_NO_SOURCE');
      expect(node.count24h).toBe(0);
      expect(node.count7d).toBe(0);
      expect(node.lastPublishedAt).toBeNull();
      expect(meta.unavailable).toContainEqual({
        field: `topics.${code}`,
        reason: 'NO_SOURCE',
        detail: 'TOPIC_NO_SOURCE: no feed and no keyword set maps to this topic in v1',
      });
    }

    // A topic WITH a source and no captured headline is a different statement.
    const politics = data.topics.find((n) => n.code === 'POLITICS')!;
    expect(politics.linkMethods).toEqual(['feed_topic']);
    expect(politics.reason).toBeNull();
    expect(politics.count7d).toBe(0);
  });

  it('counts both windows per topic and names how headlines reach it', async () => {
    const { data } = await runNi();

    const markets = data.topics.find((n) => n.code === 'MARKETS')!;
    expect(markets.linkMethods).toEqual(['feed_topic']);
    expect(markets.count24h).toBe(2);
    expect(markets.count7d).toBe(2);
    expect(markets.lastPublishedAt).toBe('2026-09-15T15:04:08.000Z');

    // A curated keyword set is a source in its own right, at the 0.9 floor.
    const rates = data.topics.find((n) => n.code === 'RATES')!;
    expect(rates.linkMethods).toEqual(['keyword']);
    expect(rates.count24h).toBe(1);
  });

  it('rolls child topics into the list, and stops when asked to', async () => {
    const rolled = await runNi({ topic: 'fed' });
    expect(rolled.data.selected?.code).toBe('FED');
    expect(rolled.data.selected?.linkMethods).toEqual(['feed_topic']);
    expect(rolled.data.rolledCodes).toEqual(['FED', 'FOMC']);
    expect(rolled.data.rows.map((r) => r.headline)).toEqual([
      'Federal Reserve Board announces termination of enforcement action',
      'Minutes of the Federal Open Market Committee, August 2026',
    ]);
    expect(rolled.data.liveSubject).toBe('n:topic:FED');
    for (const row of rolled.data.rows) expect(row.sourceId).toBe('fed.rss');

    const alone = await runNi({ topic: 'FED', includeChildren: false });
    expect(alone.data.rolledCodes).toEqual(['FED']);
    expect(alone.data.rows).toHaveLength(1);
  });

  it('keeps the live subject for a sourceless selection and shows the reason instead of rows', async () => {
    const { data, meta } = await runNi({ topic: 'CA' });

    expect(data.selected?.code).toBe('CA');
    expect(data.selected?.reason).toBe('TOPIC_NO_SOURCE');
    expect(data.rows).toEqual([]);
    // A future source would stream into it, so the subject stays.
    expect(data.liveSubject).toBe('n:topic:CA');
    expect(meta.unavailable).toContainEqual({
      field: 'topics.CA',
      reason: 'NO_SOURCE',
      detail: 'TOPIC_NO_SOURCE: no feed and no keyword set maps to this topic in v1',
    });
  });

  it('says when a topic has a source but no captured headline', async () => {
    const { data, meta } = await runNi({ topic: 'POLITICS' });

    expect(data.selected?.code).toBe('POLITICS');
    expect(data.selected?.reason).toBeNull();
    expect(data.rows).toEqual([]);
    expect(meta.unavailable).toContainEqual({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: 'NO_HEADLINES_IN_CORPUS: POLITICS has a source but no captured headline in the window',
    });
  });

  it('renders the tree with a notice for an unknown topic code', async () => {
    const { data, meta } = await runNi({ topic: 'ZZZ' });

    expect(data.selected).toBeNull();
    expect(data.topics).toHaveLength(14);
    expect(meta.unavailable).toContainEqual({
      field: 'topic',
      reason: 'NOT_APPLICABLE',
      detail: 'UNKNOWN_TOPIC: ZZZ',
    });
  });

  it('applies the kind filter and the source licence separately', async () => {
    const filtered = await runNi({ topic: 'MARKETS', kinds: ['video'] });
    expect(filtered.data.rows.map((r) => r.kind)).toEqual(['video']);
    expect(filtered.data.suppressed.kindFilter).toBe(1);
    expect(filtered.data.suppressed.entitlement).toBe(0);

    const narrow = await runNi({ topic: 'MARKETS' }, 'narrow');
    expect(narrow.data.rows).toEqual([]);
    expect(narrow.data.suppressed.entitlement).toBe(2);
    expect(narrow.meta.unavailable).toContainEqual(
      expect.objectContaining({ field: 'rows', reason: 'NOT_LICENSED' }),
    );
  });

  it('cites every headline and reports feed health (DATA-10, TERM-12)', async () => {
    const { data, meta } = await runNi({ topic: 'FED' });
    expect(data.feedHealth).toHaveLength(4);
    for (const line of data.feedHealth) expect(line.st).toBe('live');
    for (const row of data.rows) {
      expect(meta.provenance[row.provIdx]?.sourceId).toBe(row.sourceId);
    }
  });

  it('subscribes to the selected topic only', async () => {
    const browse = await runNi();
    expect(NI.live!({ limit: 40, kinds: [], includeChildren: true }, browse.data)).toBeNull();

    const selected = await runNi({ topic: 'FED' });
    const live = NI.live!({ limit: 40, kinds: [], includeChildren: true }, selected.data)!;
    expect(live.subjects).toEqual(['n:topic:FED']);
    expect(live.fields).toEqual([]);
    expect(live.essential).toEqual(['n:topic:FED']);
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runNi({ topic: 'FED' });
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
