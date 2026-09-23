/**
 * `http/routes/news.ts` — API.md §5.6 L567-595 (NEWS-01, NEWS-02, NEWS-07, NEWS-08), WP-09.
 *
 *   GET /news          full-text + filter search over `news_items`, newest first (function N)
 *   GET /news/top      the ranked front page for a scope (function TOP)
 *   GET /news/:newsId  one story with every resolved entity link (function NI)
 *   GET /topics        the topic tree the ranker and the saved searches name
 *
 * Four decisions, in the order they matter:
 *
 *  1. **The reader is WP-04's `data/news.ts`, not SQL written here.** `searchNews` owns the
 *     `websearch_to_tsquery` → trigram fallback, the keyset cursor and the bitemporal display
 *     join for links; a second copy in this file would be a second set of search semantics within
 *     a release. `GET /news/:newsId` is the one exception — the service has no by-id reader and
 *     this route is its only caller — so it selects the same `ITEM_COLUMNS` the service does and
 *     builds a `NewsItem` the same way.
 *  2. **Every story cites its provenance (DATA-10).** `news_items.provenance_id` is `NOT NULL`,
 *     so `provIdx` is never a guess: one `ProvenanceIndex` per request collects the cited rows,
 *     `withAttribution` puts the licence text on them, and each item's `provIdx` is that row's
 *     index in `meta.provenance`. A story is a stored fact, so it is cited with `st: 'closed'` —
 *     §0.4 rule 3, the same verdict a bar or a fixing carries.
 *  3. **NEWS-08 is served, not asserted.** `machineGenerated` is read from the column and always
 *     false in v1. The client renders a true in a separate hierarchy; nothing here hides the flag
 *     or defaults it, because the render rule is only enforceable if the value travels.
 *  4. **A bad cursor is a 400, not a 500.** `NewsQueryError` is the service's way of saying the
 *     caller handed back a cursor this module did not mint.
 *
 * Bodies are never stored or served for the Bloomberg RSS feed (link-out only, DATA_MODEL §10);
 * `summary` is the feed description with HTML already stripped by `news/ingest.ts`.
 *
 * `/saved-searches` lives in `alerts.ts`, where API.md §5.11 and `wire/rest/alerts.ts` put it: one
 * Fastify instance cannot register the same path twice, and the alert conditions that reference
 * `savedSearchId` are the other half of that file.
 */

import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';

import type { Clock } from '@terminal/core';
import type { Meta } from '@terminal/sdk/wire/envelope';
import {
  NewsItemParams,
  NewsQuery,
  TopNewsQuery,
  type NewsItem as WireNewsItem,
  type NewsItemResponse,
  type NewsLink as WireNewsLink,
  type NewsListResponse,
  type TopNewsResponse,
  type TopicListResponse,
} from '@terminal/sdk/wire/rest/news';

import {
  NewsQueryError,
  newsService,
  type NewsItem as ServiceNewsItem,
  type NewsKind,
  type EntityKind,
  type LinkMethod,
} from '../../data/news.js';
import { ProvenanceIndex, citeProvenance } from '../../data/reference.js';
import { withAttribution } from '../../data/request.js';
import type { AsOf } from '../../db/bitemporal.js';
import { withTx, type Tx } from '../../db/client.js';
import { requireSession } from '../auth/session.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { rateLimit, REST_LIMIT } from '../rateLimit.js';
import { ctxOf, parse, principalOf } from './functions.js';
import { asOfFrom } from './reference.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Query coercion
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * URL query values arrive as strings; `NewsQuery` and `TopNewsQuery` are the normative schemas
 * and declare numbers and arrays. Rather than restate either schema with `z.coerce` — two
 * schemas for one contract is how a limit of `'500'` ends up accepted on one route and refused on
 * the other — the few typed keys are converted here and the wire schema does the validating.
 *
 * A value that does not look like a number is passed through untouched, so `limit=abc` fails as
 * the documented `400 VALIDATION_FAILED` on `limit` instead of arriving as `NaN`.
 */
function coerceQuery(
  raw: unknown,
  spec: { numbers: readonly string[]; arrays: readonly string[] },
): Record<string, unknown> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of spec.numbers) {
    const value = out[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  for (const key of spec.arrays) {
    const value = out[key];
    if (value === undefined) continue;
    // `?kinds=story&kinds=video` (Fastify gives an array) and `?kinds=story,video` both work.
    if (Array.isArray(value)) continue;
    if (typeof value !== 'string') continue;
    out[key] = value.split(',').map((part) => part.trim());
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-request context
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface NewsRequest {
  tx: Tx;
  at: AsOf;
  prov: ProvenanceIndex;
  traceId: string;
  clock: Clock;
}

/**
 * `meta` for a news response.
 *
 * `entitlement` and `unavailable` are empty by construction: headlines are not a licensed field
 * surface — every story the reader returned is one the caller may read, a story that is not there
 * is a 404 rather than a null, and no engine runs. `tier` and `staleness` are whatever the cited
 * `provenance` rows implied, which for stored stories is `eod`/`closed`.
 */
async function metaOf(ctx: NewsRequest): Promise<Meta> {
  return {
    traceId: ctx.traceId,
    asOf: { validAt: ctx.at.validAt.toISOString(), knownAt: ctx.at.knownAt.toISOString() },
    tier: ctx.prov.lowestTier(),
    staleness: ctx.prov.worstState(),
    provenance: await withAttribution(ctx.tx, ctx.at, ctx.prov.list()),
    entitlement: [],
    unavailable: [],
    engines: [],
    servedAt: new Date(ctx.clock.now()).toISOString(),
  };
}

/**
 * Cite every story's `provenance_id` on the request's collector and project the service's rows
 * onto the wire shape, `provIdx` and all.
 *
 * One `citeProvenance` call for the whole page: the ids are deduplicated there, so a feed poll
 * that wrote fifty stories under one provenance row produces one `meta.provenance` entry that
 * fifty items cite.
 */
async function toWireItems(
  ctx: NewsRequest,
  items: readonly ServiceNewsItem[],
): Promise<WireNewsItem[]> {
  if (items.length === 0) return [];
  const { provIdxOf } = await citeProvenance(
    ctx.tx,
    ctx.prov,
    items.map((item) => item.provenanceId),
    { st: 'closed' },
  );
  return items.map((item) => {
    const provIdx = provIdxOf[item.provenanceId];
    if (provIdx === undefined) {
      // `citeProvenance` throws `MissingProvenanceError` on an id with no row, so this is
      // unreachable; it is a type narrowing, not a fallback that would put `-1` on the wire.
      throw new NotFoundError(`news ${String(item.newsId)} has no provenance row`);
    }
    return toWireItem(item, provIdx);
  });
}

function toWireItem(item: ServiceNewsItem, provIdx: number): WireNewsItem {
  return {
    newsId: item.newsId,
    sourceId: item.sourceId,
    feed: item.feed,
    kind: item.kind,
    headline: item.headline,
    summary: item.summary,
    url: item.url,
    author: item.author,
    category: item.category,
    cik: item.cik,
    items8k: item.items8k,
    lang: item.lang,
    publishedAt: item.publishedAt,
    capturedAt: item.capturedAt,
    isCorrection: item.isCorrection,
    // NEWS-08: the column, not a constant. v1 writes false everywhere and the client renders a
    // true in a separate hierarchy — a hard-coded `false` here would make that unenforceable.
    machineGenerated: item.machineGenerated,
    provIdx,
    links: item.links.map(
      (link): WireNewsLink => ({
        entityKind: link.entityKind,
        entityId: link.entityId,
        display: link.display,
        confidence: link.confidence,
        method: link.method,
      }),
    ),
  };
}

/** A `NewsQueryError` (a cursor this module did not mint) is the caller's fault, not a 500. */
function rethrow(err: unknown): never {
  if (err instanceof NewsQueryError) throw new BadRequestError(err.message);
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// One story (function NI)
// ─────────────────────────────────────────────────────────────────────────────────────────────

type ItemRow = {
  news_id: string;
  source_id: string;
  feed: string;
  kind: string;
  headline: string;
  summary: string | null;
  url: string;
  author: string | null;
  category: string | null;
  cik: string | null;
  items_8k: string[] | null;
  lang: string;
  published_at: Date | string;
  captured_at: Date | string;
  is_correction: boolean;
  machine_generated: boolean;
  provenance_id: string;
};

type LinkRow = {
  entity_kind: string;
  entity_id: string;
  confidence: number;
  method: string;
  display: string | null;
};

const NEWS_KINDS: readonly NewsKind[] = ['story', 'video', 'filing', 'press_release', 'fed_release'];
const ENTITY_KINDS: readonly EntityKind[] = ['instrument', 'issuer', 'person', 'topic'];
const LINK_METHODS: readonly LinkMethod[] = [
  'cik',
  'ticker_exact',
  'name_exact',
  'name_alias',
  'feed_topic',
  'keyword',
  'manual',
];

/** `timestamptz` comes back as a `Date` from the driver and as a string through some pools. */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function oneOf<T extends string>(values: readonly T[], raw: string, what: string): T {
  const hit = values.find((value) => value === raw);
  if (hit === undefined) throw new TypeError(`routes/news: unknown ${what} '${raw}'`);
  return hit;
}

/**
 * One story by id, with every link.
 *
 * `data/news.ts` has no by-id reader — nothing else needs one — so the query lives here, over the
 * same columns and the same bitemporal display join the service uses, and produces the same
 * `NewsItem` shape. A story that is not there is a 404, which is also what a caller who guessed
 * an id sees.
 */
async function oneStory(ctx: NewsRequest, newsId: number): Promise<ServiceNewsItem> {
  const found = await ctx.tx.execute<ItemRow>(sql`
    SELECT n.news_id::text AS news_id, n.source_id, n.feed, n.kind, n.headline, n.summary, n.url,
           n.author, n.category, n.cik, n.items_8k, n.lang, n.published_at, n.captured_at,
           n.is_correction, n.machine_generated, n.provenance_id::text AS provenance_id
      FROM news_items n
     WHERE n.news_id = ${String(newsId)}::bigint`);
  const row = found.rows[0];
  if (row === undefined) throw new NotFoundError(`no news item ${String(newsId)}`);

  const linked = await ctx.tx.execute<LinkRow>(sql`
    SELECT l.entity_kind::text AS entity_kind, l.entity_id::text AS entity_id,
           l.confidence, l.method,
           coalesce(i.name, s.name, pe.name, t.name) AS display
      FROM news_entity_links l
      LEFT JOIN instruments i
             ON l.entity_kind = 'instrument' AND i.instrument_id = l.entity_id
            AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                         ${ctx.at.validAt}::timestamptz, ${ctx.at.knownAt}::timestamptz)
      LEFT JOIN issuers s
             ON l.entity_kind = 'issuer' AND s.issuer_id = l.entity_id
            AND bt_as_of(s.valid_from, s.valid_to, s.tx_from, s.tx_to,
                         ${ctx.at.validAt}::timestamptz, ${ctx.at.knownAt}::timestamptz)
      LEFT JOIN people pe
             ON l.entity_kind = 'person' AND pe.person_id = l.entity_id
            AND bt_as_of(pe.valid_from, pe.valid_to, pe.tx_from, pe.tx_to,
                         ${ctx.at.validAt}::timestamptz, ${ctx.at.knownAt}::timestamptz)
      LEFT JOIN topics t ON l.entity_kind = 'topic' AND t.topic_id = l.entity_id
     WHERE l.news_id = ${String(newsId)}::bigint
     ORDER BY l.confidence DESC, l.entity_kind, l.entity_id`);

  return {
    newsId: Number(row.news_id),
    sourceId: row.source_id,
    feed: row.feed,
    kind: oneOf(NEWS_KINDS, row.kind, 'kind'),
    headline: row.headline,
    summary: row.summary,
    url: row.url,
    author: row.author,
    category: row.category,
    cik: row.cik,
    items8k: row.items_8k,
    lang: row.lang,
    publishedAt: iso(row.published_at),
    capturedAt: iso(row.captured_at),
    isCorrection: row.is_correction,
    machineGenerated: row.machine_generated,
    provenanceId: Number(row.provenance_id),
    sourceTs: null,
    links: linked.rows.map((link) => ({
      entityKind: oneOf(ENTITY_KINDS, link.entity_kind, 'entity kind'),
      entityId: Number(link.entity_id),
      display: link.display ?? '',
      confidence: link.confidence,
      method: oneOf(LINK_METHODS, link.method, 'link method'),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const newsRoutes: FastifyPluginAsync = async (app) => {
  // `data:read`, for the reason `/search` and `/universe/snapshot` carry it: a headline and its
  // resolved entity links are licensed source material (`licence_registry` knows `bbg.rss`), and
  // an API key minted with an empty scope list must not read it in bulk here when it cannot read
  // it through `/data`. Every row is firm-independent, so no role is narrowed: API.md's Role
  // column says "any" on all four routes.
  const read = { preHandler: [requireSession({ scopes: ['data:read'] }), rateLimit(REST_LIMIT)] };

  /** Open the request transaction, build one provenance collector, and run `fn`. */
  const withNews = async <T>(
    request: Parameters<typeof principalOf>[0],
    fn: (ctx: NewsRequest) => Promise<T>,
  ): Promise<T> => {
    const principal = principalOf(request);
    const { clock } = app.deps;
    const at = asOfFrom(request.query ?? {}, clock);
    return withTx(ctxOf(principal), async (tx) =>
      fn({ tx, at, prov: new ProvenanceIndex(), traceId: request.traceId, clock }),
    );
  };

  // ── GET /news (function N) ─────────────────────────────────────────────────────────────────
  app.get('/news', read, async (request): Promise<NewsListResponse> => {
    const query = parse(
      NewsQuery,
      coerceQuery(request.query, {
        numbers: ['instrumentId', 'issuerId', 'limit'],
        arrays: ['kinds'],
      }),
      'query',
    );

    return withNews(request, async (ctx) => {
      const page = await newsService(ctx.tx, ctx.at)
        .search({
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.instrumentId === undefined ? {} : { instrumentId: query.instrumentId }),
          ...(query.issuerId === undefined ? {} : { issuerId: query.issuerId }),
          ...(query.topic === undefined ? {} : { topic: query.topic }),
          ...(query.feed === undefined ? {} : { feed: query.feed }),
          ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
          ...(query.from === undefined ? {} : { from: query.from }),
          ...(query.to === undefined ? {} : { to: query.to }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          limit: query.limit,
        })
        .catch(rethrow);

      const items = await toWireItems(ctx, page.items);
      return { meta: await metaOf(ctx), items, nextCursor: page.nextCursor };
    });
  });

  // ── GET /news/top (function TOP) ───────────────────────────────────────────────────────────
  app.get('/news/top', read, async (request): Promise<TopNewsResponse> => {
    const query = parse(
      TopNewsQuery,
      coerceQuery(request.query, { numbers: ['limit'], arrays: [] }),
      'query',
    );

    return withNews(request, async (ctx) => {
      const ranked = await newsService(ctx.tx, ctx.at)
        .top(query.scope, query.id, query.limit)
        .catch(rethrow);
      return { meta: await metaOf(ctx), items: await toWireItems(ctx, ranked) };
    });
  });

  // ── GET /news/:newsId (function NI) ────────────────────────────────────────────────────────
  //
  // Registered after `/news/top`: Fastify's radix router prefers the static segment, so the two
  // cannot shadow each other, and the order is kept only because a reader should not have to know
  // that to be sure.
  app.get('/news/:newsId', read, async (request): Promise<NewsItemResponse> => {
    const params = parse(
      NewsItemParams,
      coerceQuery(request.params, { numbers: ['newsId'], arrays: [] }),
      'params',
    );

    return withNews(request, async (ctx) => {
      const story = await oneStory(ctx, params.newsId);
      const [item] = await toWireItems(ctx, [story]);
      if (item === undefined) throw new NotFoundError(`no news item ${String(params.newsId)}`);
      // `NewsItemResponse` makes `links` required where `NewsItem` leaves it optional: the
      // single-story route always resolves them.
      return { ...item, links: item.links ?? [] };
    });
  });

  // ── GET /topics ────────────────────────────────────────────────────────────────────────────
  app.get('/topics', read, async (request): Promise<TopicListResponse> => {
    return withNews(request, async (ctx) => {
      const topics = await newsService(ctx.tx, ctx.at).topics();
      return {
        topics: topics.map((topic) => ({
          topicId: topic.topicId,
          code: topic.code,
          name: topic.name,
          kind: topic.kind,
          parentCode: topic.parentCode,
        })),
      };
    });
  });

  await Promise.resolve();
};

export default newsRoutes;
