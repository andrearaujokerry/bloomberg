/**
 * `wire/rest/news.ts` — `Rest.News.*`: the 4 news and topic routes.
 *
 * Schemas and routes transcribed from API.md §5.6 L567-595 (NEWS-01, NEWS-02, NEWS-07, NEWS-08).
 * Owned by WP-01 now, by WP-09 (`server/src/http/routes/news.ts`) afterwards.
 *
 * Route descriptor shape used by every `wire/rest/*` group (consumed by `client/rest.ts`):
 *   { method, path, params?, query?, body?, response, status, format? }
 */
import { z } from 'zod';

import { Meta } from '../envelope.js';

/* ------------------------------------------------------------------ schemas */

/** `news_items.kind` (DATA_MODEL §10). */
export const NewsKind = z.enum(['story', 'video', 'filing', 'press_release', 'fed_release']);
export type NewsKind = z.infer<typeof NewsKind>;

/** `topics.kind`. */
export const TopicKind = z.enum(['feed', 'sector', 'theme', 'region', 'event', 'release']);
export type TopicKind = z.infer<typeof TopicKind>;

/** How a news item was linked to an entity. */
export const NewsLinkMethod = z.enum([
  'cik',
  'ticker_exact',
  'name_exact',
  'name_alias',
  'feed_topic',
  'keyword',
  'manual',
]);
export type NewsLinkMethod = z.infer<typeof NewsLinkMethod>;

export const NewsLink = z.object({
  entityKind: z.enum(['instrument', 'issuer', 'person', 'topic']),
  entityId: z.number().int(),
  display: z.string(),
  confidence: z.number(),
  method: NewsLinkMethod,
});
export type NewsLink = z.infer<typeof NewsLink>;

/** API.md §5.6 L577-581, verbatim. */
export const NewsQuery = z.object({
  q: z.string().max(200).optional(),
  instrumentId: z.number().int().optional(),
  issuerId: z.number().int().optional(),
  topic: z.string().optional(),
  feed: z.string().optional(),
  kinds: z.array(NewsKind).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type NewsQuery = z.infer<typeof NewsQuery>;

/**
 * API.md §5.6 L582-591, verbatim. Bodies are never stored or served for the Bloomberg RSS feed
 * (link-out only, DATA_MODEL §10); `summary` is the feed description with HTML stripped.
 */
export const NewsItem = z.object({
  newsId: z.number().int(),
  sourceId: z.string(),
  feed: z.string(),
  kind: NewsKind,
  headline: z.string(),
  summary: z.string().nullable(),
  url: z.string(),
  author: z.string().nullable(),
  category: z.string().nullable(),
  cik: z.string().nullable(),
  items8k: z.array(z.string()).nullable(),
  lang: z.string(),
  publishedAt: z.iso.datetime(),
  capturedAt: z.iso.datetime(),
  isCorrection: z.boolean(),
  /** NEWS-08: always false in v1; the client renders true in a separate hierarchy. */
  machineGenerated: z.boolean(),
  provIdx: z.number().int(),
  links: z.array(NewsLink).optional(),
});
export type NewsItem = z.infer<typeof NewsItem>;

/**
 * `GET /news` response. `q` uses `websearch_to_tsquery` on `news_items.tsv` with a trigram
 * fallback on `headline`; newest first (function N).
 */
export const NewsListResponse = z.object({
  meta: Meta,
  items: z.array(NewsItem),
  nextCursor: z.string().nullable(),
});
export type NewsListResponse = z.infer<typeof NewsListResponse>;

export const TopNewsScope = z.enum(['all', 'instrument', 'topic', 'feed']);
export type TopNewsScope = z.infer<typeof TopNewsScope>;

export const TopNewsQuery = z.object({
  scope: TopNewsScope,
  /** instrumentId, topic code or feed name, depending on `scope`; absent for `all` */
  id: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type TopNewsQuery = z.infer<typeof TopNewsQuery>;

/** Ranked by `news/ranker.ts` (recency × feed weight × link confidence × click-through). */
export const TopNewsResponse = z.object({
  meta: Meta,
  items: z.array(NewsItem),
});
export type TopNewsResponse = z.infer<typeof TopNewsResponse>;

export const NewsItemParams = z.object({ newsId: z.number().int().positive() });
export type NewsItemParams = z.infer<typeof NewsItemParams>;

/** `GET /news/:newsId` — `NewsItem & { links: NewsLink[] }`. */
export const NewsItemResponse = NewsItem.extend({ links: z.array(NewsLink) });
export type NewsItemResponse = z.infer<typeof NewsItemResponse>;

export const Topic = z.object({
  topicId: z.number().int(),
  code: z.string(),
  name: z.string(),
  kind: TopicKind,
  parentCode: z.string().nullable(),
});
export type Topic = z.infer<typeof Topic>;

export const TopicListResponse = z.object({ topics: z.array(Topic) });
export type TopicListResponse = z.infer<typeof TopicListResponse>;

/* ------------------------------------------------------------------- routes */

/** The 4 routes of API.md §5.6 (`http/routes/news.ts`). */
export const News = {
  /** Full-text + filter search over `news_items`, newest first (function N). */
  List: {
    method: 'GET',
    path: '/news',
    query: NewsQuery,
    response: NewsListResponse,
    status: 200,
  },
  /** Function TOP: the ranked front page for a scope. */
  Top: {
    method: 'GET',
    path: '/news/top',
    query: TopNewsQuery,
    response: TopNewsResponse,
    status: 200,
  },
  /** One story with its resolved entity links. */
  Get: {
    method: 'GET',
    path: '/news/:newsId',
    params: NewsItemParams,
    response: NewsItemResponse,
    status: 200,
  },
  /** The topic tree (feeds, sectors, themes, regions, events, releases). */
  Topics: {
    method: 'GET',
    path: '/topics',
    response: TopicListResponse,
    status: 200,
  },
} as const;
