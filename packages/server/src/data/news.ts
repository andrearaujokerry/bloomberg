/**
 * `data/news.ts` — the news reader surface (WORKPLAN §WP-04 L706-709, FUNCTIONS.md §1.4.2 L305,
 * API.md §5.6 L565-595). NEWS-01, NEWS-02, NEWS-08.
 *
 * Three reads:
 *
 *  - `search(q)` — `websearch_to_tsquery('english', q)` over the stored `news_items.tsv` (headline
 *    weighted `A`, summary `B`), with a **trigram fallback on the headline** when the tsquery
 *    matches nothing: `websearch_to_tsquery` stems, so `"Nvidia"` finds `NVIDIA`, but a partial
 *    word (`"Nvid"`) or a ticker fragment only ever matches through `news_items_headline_trgm`.
 *    Filters on instrument/issuer/topic (through `news_entity_links`), feed, kinds and a
 *    published-at window. Newest first, keyset-paged.
 *  - `top(scope, id?, limit?)` — the same corpus ranked rather than ordered: recency (a 12-hour
 *    half-life) × feed weight × link confidence. WP-09 owns `news/ranker.ts` and the click-through
 *    term that belongs to it; this is the deterministic SQL ranking underneath, and it is the one
 *    the `TOP` screen reads until that lands.
 *  - `topics()` — the topic tree with each node's parent **code** (the API shape), not its id.
 *
 * Entity links are returned with every item (`links`), each carrying its `confidence` and `method`
 * so the screen can render a precision-first attribution; links below 0.9 are never written by the
 * linker, so nothing is filtered here.
 *
 * Provenance: `news_items.provenance_id` is on every item, together with the provenance row's
 * `capturedAt`/`sourceTs`. The runner turns `provenanceId` into the `provIdx` of API.md's
 * `NewsItem`; a data service does not know the payload's provenance array.
 *
 * Bodies are never read or served (DATA_MODEL §10): `summary` is the feed description with HTML
 * already stripped by the ingest normaliser, and `url` is the link out.
 */

import { sql } from 'drizzle-orm';

import type { SQL } from 'drizzle-orm';
import type { AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes (API.md §5.6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type NewsKind = 'story' | 'video' | 'filing' | 'press_release' | 'fed_release';
export type EntityKind = 'instrument' | 'issuer' | 'person' | 'topic';
export type LinkMethod =
  'cik' | 'ticker_exact' | 'name_exact' | 'name_alias' | 'feed_topic' | 'keyword' | 'manual';

/** One `news_entity_links` row, with the entity's display name when it has one. */
export interface NewsLink {
  entityKind: EntityKind;
  entityId: number;
  /** `instruments.name`, `issuers.name`, `people.name`, `topics.name`, or `''`. */
  display: string;
  confidence: number;
  method: LinkMethod;
}

/** One story. `provenanceId` is the runner's input for `provIdx`. */
export interface NewsItem {
  newsId: number;
  sourceId: string;
  feed: string;
  kind: NewsKind;
  headline: string;
  summary: string | null;
  url: string;
  author: string | null;
  category: string | null;
  cik: string | null;
  items8k: string[] | null;
  lang: string;
  publishedAt: string;
  capturedAt: string;
  isCorrection: boolean;
  /** NEWS-08: always false in v1. The column exists so the render rule is enforceable. */
  machineGenerated: boolean;
  provenanceId: number;
  /** The provenance row's `source_ts` — the publisher's own instant when it gave one. */
  sourceTs: string | null;
  links: NewsLink[];
}

/** `NewsQuery` of API.md §5.6. `limit` defaults to 50 and is capped at 200. */
export interface NewsQuery {
  q?: string;
  instrumentId?: number;
  issuerId?: number;
  topic?: string;
  feed?: string;
  kinds?: readonly NewsKind[];
  /** ISO 8601. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** A topic node. `parentCode` rather than `parentTopicId`, as the API renders it. */
export interface Topic {
  topicId: number;
  code: string;
  name: string;
  kind: 'feed' | 'sector' | 'theme' | 'region' | 'event' | 'release';
  parentCode: string | null;
  keywords: string[];
}

/** The service as `DataServices.news` declares it. */
export interface NewsService {
  search(q: NewsQuery): Promise<{ items: NewsItem[]; nextCursor: string | null; total: number }>;
  top(
    scope: 'all' | 'instrument' | 'topic' | 'feed',
    id?: string,
    limit?: number,
  ): Promise<NewsItem[]>;
  topics(): Promise<Topic[]>;
}

/** Raised on a cursor that did not come from this module. */
export class NewsQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewsQueryError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Conversions
// ─────────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TOP_LIMIT = 50;

function limitOf(value: number | undefined, max: number): number {
  if (value === undefined) return Math.min(DEFAULT_LIMIT, max);
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`data/news: limit must be a positive integer, got ${String(value)}`);
  }
  return Math.min(value, max);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function reqIso(value: Date | string, what: string): string {
  const s = iso(value);
  if (s === null) throw new TypeError(`data/news: ${what} is null`);
  return s;
}

const NEWS_KINDS: readonly NewsKind[] = [
  'story',
  'video',
  'filing',
  'press_release',
  'fed_release',
];

function kindOf(value: string): NewsKind {
  const hit = NEWS_KINDS.find((k) => k === value);
  if (hit === undefined) throw new TypeError(`data/news: unknown kind '${value}'`);
  return hit;
}

/** The keyset cursor: the last row's `(published_at, news_id)`, base64url of canonical JSON. */
interface Cursor {
  p: string;
  n: number;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new NewsQueryError(`data/news: cursor ${JSON.stringify(value)} is not decodable`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new NewsQueryError(`data/news: cursor ${JSON.stringify(value)} is not an object`);
  }
  const c = parsed as { p?: unknown; n?: unknown };
  if (typeof c.p !== 'string' || typeof c.n !== 'number') {
    throw new NewsQueryError(`data/news: cursor ${JSON.stringify(value)} is missing p/n`);
  }
  return { p: c.p, n: c.n };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rows
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
  published_at: Date;
  captured_at: Date;
  is_correction: boolean;
  machine_generated: boolean;
  provenance_id: string;
  source_ts: Date | null;
};

const ITEM_COLUMNS = sql`
  n.news_id::text AS news_id, n.source_id, n.feed, n.kind, n.headline, n.summary, n.url,
  n.author, n.category, n.cik, n.items_8k, n.lang, n.published_at, n.captured_at,
  n.is_correction, n.machine_generated, n.provenance_id::text AS provenance_id, p.source_ts`;

function toItem(row: ItemRow, links: NewsLink[]): NewsItem {
  return {
    newsId: Number(row.news_id),
    sourceId: row.source_id,
    feed: row.feed,
    kind: kindOf(row.kind),
    headline: row.headline,
    summary: row.summary,
    url: row.url,
    author: row.author,
    category: row.category,
    cik: row.cik,
    items8k: row.items_8k,
    lang: row.lang,
    publishedAt: reqIso(row.published_at, 'published_at'),
    capturedAt: reqIso(row.captured_at, 'captured_at'),
    isCorrection: row.is_correction,
    machineGenerated: row.machine_generated,
    provenanceId: Number(row.provenance_id),
    sourceTs: iso(row.source_ts),
    links,
  };
}

type LinkRow = {
  news_id: string;
  entity_kind: string;
  entity_id: string;
  confidence: number;
  method: string;
  display: string | null;
};

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

/**
 * The links of a page of items, with a display name resolved per entity kind. The joins are all
 * `LEFT`: a link to an instrument whose version has since been narrowed still renders, with an
 * empty display rather than a dropped row.
 */
async function linksFor(
  tx: Tx,
  at: AsOf,
  newsIds: readonly number[],
): Promise<Map<number, NewsLink[]>> {
  const out = new Map<number, NewsLink[]>();
  if (newsIds.length === 0) return out;
  const res = await tx.execute<LinkRow>(sql`
    SELECT l.news_id::text AS news_id, l.entity_kind::text AS entity_kind,
           l.entity_id::text AS entity_id, l.confidence, l.method,
           coalesce(i.name, s.name, pe.name, t.name) AS display
      FROM news_entity_links l
      LEFT JOIN instruments i
             ON l.entity_kind = 'instrument' AND i.instrument_id = l.entity_id
            AND bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                         ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
      LEFT JOIN issuers s
             ON l.entity_kind = 'issuer' AND s.issuer_id = l.entity_id
            AND bt_as_of(s.valid_from, s.valid_to, s.tx_from, s.tx_to,
                         ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
      LEFT JOIN people pe
             ON l.entity_kind = 'person' AND pe.person_id = l.entity_id
            AND bt_as_of(pe.valid_from, pe.valid_to, pe.tx_from, pe.tx_to,
                         ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
      LEFT JOIN topics t ON l.entity_kind = 'topic' AND t.topic_id = l.entity_id
     WHERE l.news_id = ANY(${sql.raw(`ARRAY[${newsIds.join(',')}]::bigint[]`)})
     ORDER BY l.news_id, l.confidence DESC, l.entity_kind, l.entity_id`);
  for (const row of res.rows) {
    const kind = ENTITY_KINDS.find((k) => k === row.entity_kind);
    const method = LINK_METHODS.find((m) => m === row.method);
    if (kind === undefined || method === undefined) continue;
    const newsId = Number(row.news_id);
    const list = out.get(newsId) ?? [];
    list.push({
      entityKind: kind,
      entityId: Number(row.entity_id),
      display: row.display ?? '',
      confidence: row.confidence,
      method,
    });
    out.set(newsId, list);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The non-text filters, shared by `search` and `top`. */
function filtersOf(q: NewsQuery, at: AsOf): SQL[] {
  const parts: SQL[] = [
    // Never serve a story we had not captured yet at `knownAt` (DATA-10, REF-03).
    sql`n.captured_at <= ${at.knownAt}::timestamptz`,
    sql`n.published_at <= ${at.validAt}::timestamptz`,
  ];
  if (q.feed !== undefined) parts.push(sql`n.feed = ${q.feed}`);
  if (q.kinds !== undefined && q.kinds.length > 0) {
    // Re-validated against the closed set before it reaches SQL: `kinds` arrives from JSON and a
    // raw array literal is the one place in this module a string would be interpolated unquoted.
    const kinds = q.kinds.map((kind) => kindOf(kind));
    parts.push(
      sql`n.kind = ANY(${sql.raw(`ARRAY[${kinds.map((k) => `'${k}'`).join(',')}]::text[]`)})`,
    );
  }
  if (q.from !== undefined) parts.push(sql`n.published_at >= ${q.from}::timestamptz`);
  if (q.to !== undefined) parts.push(sql`n.published_at <= ${q.to}::timestamptz`);
  if (q.instrumentId !== undefined) {
    parts.push(sql`EXISTS (SELECT 1 FROM news_entity_links l
                            WHERE l.news_id = n.news_id AND l.entity_kind = 'instrument'
                              AND l.entity_id = ${q.instrumentId}::bigint)`);
  }
  if (q.issuerId !== undefined) {
    parts.push(sql`EXISTS (SELECT 1 FROM news_entity_links l
                            WHERE l.news_id = n.news_id AND l.entity_kind = 'issuer'
                              AND l.entity_id = ${q.issuerId}::bigint)`);
  }
  if (q.topic !== undefined) {
    parts.push(sql`EXISTS (SELECT 1 FROM news_entity_links l
                             JOIN topics t ON t.topic_id = l.entity_id
                            WHERE l.news_id = n.news_id AND l.entity_kind = 'topic'
                              AND t.code = ${q.topic})`);
  }
  return parts;
}

function allOf(parts: readonly SQL[]): SQL {
  return sql.join([...parts], sql` AND `);
}

/**
 * `DataServices.news.search`.
 *
 * `total` is the unpaged match count — the screen prints it and the pager sizes itself on it, so it
 * is counted rather than inferred from the page.
 */
export async function searchNews(
  tx: Tx,
  at: AsOf,
  query: NewsQuery,
): Promise<{ items: NewsItem[]; nextCursor: string | null; total: number }> {
  const limit = limitOf(query.limit, MAX_LIMIT);
  const filters = filtersOf(query, at);

  let text: SQL | null = null;
  if (query.q !== undefined && query.q.trim() !== '') {
    const term = query.q.trim();
    // Does the stemmed query match anything at all? If not, fall back to the trigram index so a
    // partial word still finds its story instead of returning an empty screen.
    const probe = await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
        FROM news_items n
       WHERE ${allOf(filters)}
         AND n.tsv @@ websearch_to_tsquery('english', ${term})`);
    const hits = Number(probe.rows[0]?.n ?? '0');
    text =
      hits > 0
        ? sql`n.tsv @@ websearch_to_tsquery('english', ${term})`
        : sql`n.headline ILIKE ${'%' + term + '%'}`;
  }
  const where = text === null ? allOf(filters) : allOf([...filters, text]);

  const totalRes = await tx.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM news_items n WHERE ${where}`);
  const total = Number(totalRes.rows[0]?.n ?? '0');

  const keyset =
    query.cursor === undefined
      ? sql``
      : (() => {
          const cursor = decodeCursor(query.cursor);
          return sql` AND (n.published_at, n.news_id) < (${cursor.p}::timestamptz, ${cursor.n}::bigint)`;
        })();

  const res = await tx.execute<ItemRow>(sql`
    SELECT ${ITEM_COLUMNS}
      FROM news_items n
      JOIN provenance p ON p.provenance_id = n.provenance_id
     WHERE ${where}${keyset}
     ORDER BY n.published_at DESC, n.news_id DESC
     LIMIT ${limit + 1}`);

  const page = res.rows.slice(0, limit);
  const links = await linksFor(
    tx,
    at,
    page.map((row) => Number(row.news_id)),
  );
  const items = page.map((row) => toItem(row, links.get(Number(row.news_id)) ?? []));
  const last = items[items.length - 1];
  const nextCursor =
    res.rows.length > limit && last !== undefined
      ? encodeCursor({ p: last.publishedAt, n: last.newsId })
      : null;
  return { items, nextCursor, total };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Top (ranked)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Feed weights for the ranking. A press release out of the SEC Atom feed is not as "top" as a
 * markets story, and a Fed release outranks both on the day it lands.
 */
const FEED_WEIGHT: ReadonlyMap<string, number> = new Map([
  ['markets', 1],
  ['economics', 1],
  ['politics', 0.8],
  ['technology', 0.8],
  ['industries', 0.8],
  ['wealth', 0.6],
  ['press_all', 0.7],
  ['8-K', 0.6],
]);
const DEFAULT_FEED_WEIGHT = 0.7;

/** Half-life of the recency term, in hours. */
const HALF_LIFE_HOURS = 12;

/**
 * `DataServices.news.top` — the same corpus, ranked.
 *
 * score = `2^(−age_hours / 12)` × feed weight × best link confidence (1.0 when the story has no
 * link, so an unlinked markets story is not pushed below a weak keyword link). Deterministic in
 * `(validAt, knownAt)`: no clock is read here, the age is measured against `at.validAt`.
 */
export async function topNews(
  tx: Tx,
  at: AsOf,
  scope: 'all' | 'instrument' | 'topic' | 'feed',
  id?: string,
  limit?: number,
): Promise<NewsItem[]> {
  const take = limitOf(limit, MAX_TOP_LIMIT);
  const query: NewsQuery = { limit: take };
  if (scope !== 'all') {
    if (id === undefined || id === '') {
      throw new NewsQueryError(`data/news: top(scope='${scope}') needs an id`);
    }
    if (scope === 'instrument') {
      const instrumentId = Number(id);
      if (!Number.isInteger(instrumentId)) {
        throw new NewsQueryError(`data/news: top(scope='instrument') id must be an instrument id`);
      }
      query.instrumentId = instrumentId;
    } else if (scope === 'topic') {
      query.topic = id;
    } else {
      query.feed = id;
    }
  }
  const filters = filtersOf(query, at);

  const weights = sql.join(
    [...FEED_WEIGHT.entries()].map(([feed, weight]) => sql`WHEN ${feed} THEN ${weight}::real`),
    sql` `,
  );

  const res = await tx.execute<ItemRow>(sql`
    SELECT ${ITEM_COLUMNS}
      FROM news_items n
      JOIN provenance p ON p.provenance_id = n.provenance_id
     WHERE ${allOf(filters)}
     ORDER BY (
                power(2, -1 * extract(epoch FROM (${at.validAt}::timestamptz - n.published_at))
                          / ${HALF_LIFE_HOURS * 3600}::double precision)
                * (CASE n.feed ${weights} ELSE ${DEFAULT_FEED_WEIGHT}::real END)
                * coalesce((SELECT max(l.confidence) FROM news_entity_links l
                             WHERE l.news_id = n.news_id), 1.0)
              ) DESC,
              n.published_at DESC, n.news_id DESC
     LIMIT ${take}`);

  const links = await linksFor(
    tx,
    at,
    res.rows.map((row) => Number(row.news_id)),
  );
  return res.rows.map((row) => toItem(row, links.get(Number(row.news_id)) ?? []));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Topics
// ─────────────────────────────────────────────────────────────────────────────────────────────

type TopicRow = {
  topic_id: string;
  code: string;
  name: string;
  kind: string;
  parent_code: string | null;
  keywords: string[] | null;
};

const TOPIC_KINDS: readonly Topic['kind'][] = [
  'feed',
  'sector',
  'theme',
  'region',
  'event',
  'release',
];

/** `DataServices.news.topics` — the whole tree, parents before children, then by code. */
export async function listTopics(tx: Tx): Promise<Topic[]> {
  const res = await tx.execute<TopicRow>(sql`
    SELECT t.topic_id::text AS topic_id, t.code, t.name, t.kind, parent.code AS parent_code,
           t.keywords
      FROM topics t
      LEFT JOIN topics parent ON parent.topic_id = t.parent_topic_id
     ORDER BY (t.parent_topic_id IS NOT NULL), t.code`);
  return res.rows.map((row) => {
    const kind = TOPIC_KINDS.find((k) => k === row.kind);
    if (kind === undefined) throw new TypeError(`data/news: unknown topic kind '${row.kind}'`);
    return {
      topicId: Number(row.topic_id),
      code: row.code,
      name: row.name,
      kind,
      parentCode: row.parent_code,
      keywords: row.keywords ?? [],
    };
  });
}

/** `DataServices.news`, bound to one transaction and one `(validAt, knownAt)` pair. */
export function newsService(tx: Tx, at: AsOf): NewsService {
  return {
    search: (q) => searchNews(tx, at, q),
    top: (scope, id, limit) => topNews(tx, at, scope, id, limit),
    topics: () => listTopics(tx),
  };
}
