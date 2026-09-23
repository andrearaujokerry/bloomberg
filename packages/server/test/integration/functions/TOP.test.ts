/**
 * `test/integration/functions/TOP.test.ts` — the ranked front page (FUNCTIONS_TIER1.md §TOP).
 *
 * The claims worth proving about TOP are not "it returns headlines". They are the three that make
 * the screen trustworthy:
 *
 *  - **the published rank explains the order.** `rows` is sorted by `rank` desc, and every row
 *    carries the four `rankParts` the score was made of, so the order can be checked against the
 *    numbers rather than taken on faith;
 *  - **absence is counted and explained.** A `kinds` filter and a missing source licence each
 *    remove rows, and the two counts are separate. A second firm, licensed for the public feeds
 *    only, sees the Bloomberg rows *suppressed with a reason* rather than silently missing;
 *  - **feed health is a value (TERM-12).** Each `(source, feed)` line carries when it was last
 *    captured and whether that is current, and a line that names a capture cites it.
 *
 * WP-15 owns the seed, so every firm, user, grant, topic and headline here is created inside this
 * file's own transaction and nothing depends on a literal id.
 */

import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expectGolden } from './golden.js';

import { FunctionRegistry } from '@terminal/core';
import { TOP } from '@terminal/core/functions/manifests/TOP';
import type { TopPayload } from '@terminal/core/functions/manifests/TOP';

import { getConfig } from '../../../src/config.js';
import type { FunctionServerModule } from '../../../src/functions/context.js';
import { ResultCache } from '../../../src/functions/resultCache.js';
import * as TOPModule from '../../../src/functions/TOP/resolve.js';
import { seedLicences } from '../../../src/seed/licences.js';
import { createTestApp, type TestApp } from '../../../src/test/app.js';
import { testClock, type VirtualClock } from '../../../src/test/clock.js';
import { withTxDb, type TestDb } from '../../../src/test/db.js';
import { bootstrapProvenance, GOLDEN_CAPTURE_MS, seedQuoteInstrument } from '../ws/helpers.js';

const API = '/api/v1';
const GOLDEN_ISO = new Date(GOLDEN_CAPTURE_MS).toISOString();
const GRANT_FROM = '2020-01-01T00:00:00.000Z';
const GOLDEN_NAME = 'TOP.default.json';

const REGISTRY = new FunctionRegistry([TOP]);
 
const MODULES: Record<string, FunctionServerModule<any, any>> = { TOP: TOPModule };

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

interface Env {
  harness: TestApp;
  app: FastifyInstance;
  clock: VirtualClock;
  cookie: string;
  narrowCookie: string;
  knownAt: string;
  newsIds: Map<string, number>;
  topicIds: Map<string, number>;
  aapl: number;
}

let env: Env;

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
    [firmId, `top-${randomUUID()}@demo.invalid`, label],
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

beforeEach(async () => {
  await ensureLicences();

  const main = await createFirmUser('TOP Firm', ['bbg.rss', 'sec.atom', 'fed.rss', 'cboe.quotes']);
  const narrow = await createFirmUser('TOP Narrow Firm', ['sec.atom', 'fed.rss', 'cboe.quotes']);

  const { newsIds, topicIds } = await seedCorpus(t, STORIES);
  const aapl = await seedQuoteInstrument(t, { ticker: 'AAPL', name: 'Apple Inc' });
  // One instrument link, so `SCOPE=INSTRUMENT` has something to rank.
  await t.client.query(
    `INSERT INTO news_entity_links (news_id, entity_kind, entity_id, confidence, method)
     VALUES ($1, 'instrument', $2, 1.0, 'ticker_exact')`,
    [newsIds.get('TLEUW0KGZAKZ02')!, aapl.instrumentId],
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
    narrowCookie: narrow.cookie,
    knownAt,
    newsIds,
    topicIds,
    aapl: aapl.instrumentId,
  };
});

afterEach(async () => {
  await env.harness.close();
});

interface Run {
  data: TopPayload;
  meta: {
    provenance: { sourceId: string; provenanceId: number }[];
    unavailable: { field: string; reason: string; detail: string }[];
    entitlement: { decision: string }[];
  };
}

async function runTop(params: Record<string, unknown> = {}, which = 'main'): Promise<Run> {
  const res = await env.app.inject({
    method: 'POST',
    url: `${API}/functions/TOP/run`,
    headers: {
      cookie: which === 'main' ? env.cookie : env.narrowCookie,
      'x-requested-with': 'terminal',
    },
    payload: { params, asOf: { validAt: GOLDEN_ISO, knownAt: env.knownAt } },
  });
  expect(res.statusCode, res.payload).toBe(200);
  return res.json<Run>();
}

/** Sequence values are tokenised; everything else in the golden is asserted literally. */
function normalise(payload: TopPayload): unknown {
  const tokens = new Map<number, string>([[env.aapl, '<AAPL>']]);
  let n = 0;
  for (const id of env.newsIds.values()) tokens.set(id, `<NEWS${String((n += 1))}>`);
  let k = 0;
  for (const id of env.topicIds.values()) tokens.set(id, `<TOPIC${String((k += 1))}>`);
  return JSON.parse(
    JSON.stringify(payload, (_key, value: unknown) => {
      if (typeof value === 'number' && tokens.has(value)) return tokens.get(value);
      if (typeof value === 'string') {
        // Whole numbers only. A bare `split(String(id))` also rewrites a digit run *inside* another
        // number — a topic id of 390026 turns an EDGAR accession path into
        // `.../000121<TOPIC6>26100070/index.htm` — so which ids the sequence happened to hand out
        // decided what the golden said. A subject (`n:topic:12`) is a whole number in its string;
        // an accession number is not.
        let out = value;
        for (const [id, token] of tokens) {
          out = out.replace(new RegExp(`(?<!\\d)${String(id)}(?!\\d)`, 'g'), token);
        }
        return out;
      }
      return value;
    }),
  );
}

describe('TOP — the ranked front page', () => {
  it('publishes the rank and its four parts, in rank order', async () => {
    const { data } = await runTop();

    expect(data.variant).toBe('default');
    expect(data.resolved).toEqual({ scope: 'all', id: null, label: 'All news' });
    expect(data.rows).toHaveLength(STORIES.length);

    for (let i = 1; i < data.rows.length; i += 1) {
      expect(data.rows[i - 1]!.rank).toBeGreaterThanOrEqual(data.rows[i]!.rank);
    }
    // The rank is the product of its published parts — the order can be checked, not trusted.
    for (const row of data.rows) {
      const p = row.rankParts;
      expect(row.rank).toBeCloseTo(p.recency * p.feedWeight * p.linkConfidence * (1 + p.clickThrough), 9);
      expect(row.machineGenerated).toBe(false);
    }
    // The newest story of the strongest feed leads: the 8-K is 20 minutes old, the video 3½ hours.
    expect(data.rows[0]!.headline).toBe('8-K · Aerkomm Inc · Item 5.02 Departure of Directors');
    expect(data.rows[0]!.kind).toBe('filing');
    expect(data.rows[0]!.cik).toBe('0001590496');
    expect(data.rows[0]!.items8k).toEqual(['5.02']);
  });

  it('carries every headline as a cited, immutable record (DATA-10)', async () => {
    const { data, meta } = await runTop();

    expect(meta.provenance.length).toBeGreaterThan(0);
    for (const row of data.rows) {
      expect(row.provIdx).toBeGreaterThanOrEqual(0);
      expect(meta.provenance[row.provIdx]).toBeDefined();
      expect(meta.provenance[row.provIdx]!.sourceId).toBe(row.sourceId);
    }
    // Click-through has no 7-day history in a fresh transaction, and says so rather than
    // publishing a measured-looking zero.
    expect(meta.unavailable.map((u) => u.detail)).toContainEqual(
      expect.stringContaining('NO_CLICKTHROUGH_HISTORY'),
    );
    for (const row of data.rows) expect(row.rankParts.clickThrough).toBe(0);
  });

  it('reports one health line per (source, feed), each citing its capture (TERM-12)', async () => {
    const { data, meta } = await runTop();

    expect(data.feedHealth.map((f) => `${f.sourceId}/${f.feed}`).sort()).toEqual([
      'bbg.rss/economics',
      'bbg.rss/markets',
      'fed.rss/press_all',
      'sec.atom/8-K',
    ]);
    for (const line of data.feedHealth) {
      expect(line.st).toBe('live');
      expect(line.provIdx).toBeGreaterThanOrEqual(0);
      expect(meta.provenance[line.provIdx]).toBeDefined();
    }
    expect(data.feedHealth.find((f) => f.sourceId === 'fed.rss')!.expectedIntervalMs).toBe(300_000);
  });

  it('resolves auto scope to a topic, a feed, an instrument, or all with a reason', async () => {
    const topic = await runTop({ id: 'FED' });
    expect(topic.data.resolved).toEqual({ scope: 'topic', id: 'FED', label: 'Federal Reserve' });
    expect(topic.data.liveSubject).toBe('n:topic:FED');
    expect(topic.data.rows.map((r) => r.sourceId)).toEqual(['fed.rss']);

    // `markets` is BOTH a feed and a topic code, and §TOP step 1 tries topics first, so the
    // feed branch is proved with a feed no topic shadows.
    const shadowed = await runTop({ id: 'markets' });
    expect(shadowed.data.resolved).toEqual({ scope: 'topic', id: 'MARKETS', label: 'Markets' });

    const feed = await runTop({ id: 'economics' });
    expect(feed.data.resolved).toEqual({ scope: 'feed', id: 'economics', label: 'Economics' });
    expect(feed.data.liveSubject).toBe('n:feed:economics');
    expect(feed.data.rows.every((r) => r.feed === 'economics')).toBe(true);

    const instrument = await runTop({ id: String(env.aapl) });
    expect(instrument.data.resolved.scope).toBe('instrument');
    expect(instrument.data.resolved.label).toBe('AAPL US Equity');
    expect(instrument.data.liveSubject).toBe(`n:inst:${String(env.aapl)}`);
    expect(instrument.data.rows).toHaveLength(1);

    const unknown = await runTop({ id: 'zzz' });
    expect(unknown.data.resolved).toEqual({ scope: 'all', id: null, label: 'All news' });
    expect(unknown.meta.unavailable).toContainEqual({
      field: 'scope',
      reason: 'NOT_APPLICABLE',
      detail: "UNKNOWN_SCOPE: 'zzz' is neither a topic code, a feed nor an instrument id",
    });
    // NEWS-01: the screen still shows something.
    expect(unknown.data.rows.length).toBe(STORIES.length);
  });

  it('counts the rows a kind filter removed', async () => {
    const { data } = await runTop({ kinds: ['filing'] });
    expect(data.rows.map((r) => r.kind)).toEqual(['filing']);
    expect(data.suppressed.kindFilter).toBe(STORIES.length - 1);
    expect(data.suppressed.entitlement).toBe(0);
  });

  it('suppresses a source the firm is not licensed for, and says why (ENTL-05)', async () => {
    const licensed = await runTop({}, 'main');
    expect(licensed.data.rows.some((r) => r.sourceId === 'bbg.rss')).toBe(true);

    const narrow = await runTop({}, 'narrow');
    expect(narrow.data.rows.some((r) => r.sourceId === 'bbg.rss')).toBe(false);
    expect(narrow.data.suppressed.entitlement).toBe(3);
    expect(narrow.meta.unavailable).toContainEqual(
      expect.objectContaining({
        field: 'rows',
        reason: 'NOT_LICENSED',
        detail: expect.stringContaining('bbg.rss') as unknown as string,
      }),
    );
    // A dropped headline is absent, not blanked: there is no partial view of a headline.
    expect(narrow.data.rows).toHaveLength(STORIES.length - 3);
  });

  it('states the body licence once, for the footer', async () => {
    const { meta } = await runTop();
    expect(meta.unavailable).toContainEqual({
      field: 'rows[].summary',
      reason: 'NOT_LICENSED',
      detail: 'NO_BODY_LICENCE: headline, summary and link only — the article body is never stored',
    });
  });

  it('subscribes to exactly one uncontrolled n: subject, with no fields', async () => {
    const { data } = await runTop();
    const live = TOP.live!({ scope: 'auto', limit: 30, kinds: [] }, data)!;

    expect(live.subjects).toEqual(['n:all']);
    expect(live.fields).toEqual([]);
    expect(live.essential).toEqual(['n:all']);
    // `n:` is not conflated: one delta per headline (API.md §6.1).
    expect(live.conflationMs).toBeUndefined();
  });

  it('deep-equals the committed golden at the frozen clock', async () => {
    const { data } = await runTop();
    expectGolden(GOLDEN_NAME, normalise(data));
  });
});
