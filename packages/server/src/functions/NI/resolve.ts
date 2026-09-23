/**
 * `functions/NI/resolve.ts` — the topic browser (FUNCTIONS_TIER1.md §NI L1370-1512).
 *
 * NI answers a question TOP and N cannot: *what does this platform have topics for at all*, and
 * how much arrived under each of them. The tree is the screen; the headline list is what the
 * selected node contains.
 *
 * The design decision worth stating is the one about topics with no source. Headlines reach a
 * topic exactly two ways in v1 — a feed mapping, where every item from a publisher feed belongs to
 * the topic, and a narrow whole-word keyword match on the headline (NEWS-02 is precision-first, so
 * the keyword sets are deliberately small). Two seeded topics have neither. Those nodes are
 * **listed, greyed, and carry `reason: 'TOPIC_NO_SOURCE'`**, with a matching `meta.unavailable`
 * entry, rather than rendering as an empty list: a topic that silently shows no stories is
 * indistinguishable from a quiet day, and the difference is exactly what a user needs to know
 * before they conclude nothing happened.
 *
 * `linkMethods` is therefore derived from two things at once: the **mapping** (which says a topic
 * *can* receive headlines even before one has) and the methods actually **observed** in
 * `news_entity_links` (which catches a `manual` link data ops filed by hand). A topic with a feed
 * behind it and no captured headline is not sourceless — it is empty, and says `NO_HEADLINES_IN_CORPUS`.
 *
 * `data.news.search` filters on one topic, so rolling child topics in is k searches merged. The
 * merge is exact rather than approximate: each search returns its own `published_at desc` page of
 * at least `limit` rows, so the first `limit` rows of the merged, de-duplicated stream are the
 * first `limit` rows the union would have produced.
 */

import { sql } from 'drizzle-orm';

import type {
  NiLinkMethod,
  NiParams,
  NiPayload,
  NiTopicNode,
} from '@terminal/core/functions/manifests/NI';
import { NI_MAX_DEPTH } from '@terminal/core/functions/manifests/NI';

import type { NewsItem, NewsKind, Topic } from '../../data/news.js';
import { FEED_TOPIC_CODE, LINK_THRESHOLD_STORED } from '../../news/entityLink.js';
import type { ResolveContext } from '../context.js';
import {
  feedHealth,
  filterByLicence,
  newsSourceAccess,
  toNewsRow,
} from '../shared/feedHealth.js';
import { refreshFeeds } from '../TOP/resolve.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The tree (§NI resolver steps 1-2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `topics.code` → the Bloomberg/Fed feed behind it, for the mapping half of `linkMethods`. */
const TOPIC_FEED: ReadonlyMap<string, string> = new Map(
  [...FEED_TOPIC_CODE.entries()].map(([feed, code]) => [code, feed]),
);

const LINK_METHOD_ORDER: readonly NiLinkMethod[] = ['feed_topic', 'keyword', 'manual'];

interface CountSql extends Record<string, unknown> {
  code: string;
  c24: string;
  c7: string;
  last_published_at: string | null;
  methods: string[] | null;
}

interface TopicStats {
  count24h: number;
  count7d: number;
  lastPublishedAt: string | null;
  methods: NiLinkMethod[];
}

/**
 * One grouped query for both windows, the last publication and the methods actually observed.
 *
 * `confidence >= 0.9` is not a tuning knob: NEWS-02 says nothing below it is ever written, and
 * repeating the threshold on the read side means a row that somehow slipped under it cannot reach
 * a count either. The constant is `LINK_THRESHOLD_STORED`, not `0.9`: the column is `real`, and a
 * link written at exactly the floor reads back as 0.8999999761581421 — comparing it against the
 * decimal would silently drop every link at the threshold, which is most of the keyword links.
 */
async function topicStats(ctx: ResolveContext): Promise<Map<string, TopicStats>> {
  const validAt = ctx.asOf.validAt.toISOString();
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<CountSql>(sql`
    SELECT t.code,
           count(*) FILTER (
             WHERE n.published_at > ${validAt}::timestamptz - interval '24 hours')::text AS c24,
           count(*) FILTER (
             WHERE n.published_at > ${validAt}::timestamptz - interval '7 days')::text AS c7,
           to_char(max(n.published_at) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_published_at,
           array_agg(DISTINCT l.method) AS methods
      FROM news_entity_links l
      JOIN topics t ON t.topic_id = l.entity_id
      JOIN news_items n ON n.news_id = l.news_id
     WHERE l.entity_kind = 'topic'
       AND l.confidence >= ${LINK_THRESHOLD_STORED}
       AND n.captured_at <= ${knownAt}::timestamptz
       AND n.published_at <= ${validAt}::timestamptz
     GROUP BY t.code`);

  const out = new Map<string, TopicStats>();
  for (const row of res.rows) {
    out.set(row.code, {
      count24h: Number(row.c24),
      count7d: Number(row.c7),
      lastPublishedAt: row.last_published_at,
      methods: (row.methods ?? []).filter((m): m is NiLinkMethod =>
        LINK_METHOD_ORDER.includes(m as NiLinkMethod),
      ),
    });
  }
  return out;
}

/** The mapping half: what *can* reach this topic, whether or not anything has. */
function mappedMethods(topic: Topic): NiLinkMethod[] {
  const out: NiLinkMethod[] = [];
  if (TOPIC_FEED.has(topic.code)) out.push('feed_topic');
  if (topic.keywords.length > 0) out.push('keyword');
  return out;
}

function buildTree(ctx: ResolveContext, topics: readonly Topic[], stats: Map<string, TopicStats>): NiTopicNode[] {
  const children = new Map<string, string[]>();
  for (const topic of topics) {
    if (topic.parentCode === null) continue;
    const list = children.get(topic.parentCode) ?? [];
    list.push(topic.code);
    children.set(topic.parentCode, list);
  }

  return topics.map((topic) => {
    const observed = stats.get(topic.code);
    const methods = new Set<NiLinkMethod>([
      ...mappedMethods(topic),
      ...(observed?.methods ?? []),
    ]);
    const linkMethods = LINK_METHOD_ORDER.filter((m) => methods.has(m));
    const sourceless = linkMethods.length === 0;
    if (sourceless) {
      ctx.unavailable.add({
        field: `topics.${topic.code}`,
        reason: 'NO_SOURCE',
        detail: 'TOPIC_NO_SOURCE: no feed and no keyword set maps to this topic in v1',
      });
    }
    return {
      topicId: topic.topicId,
      code: topic.code,
      name: topic.name,
      kind: topic.kind,
      parentCode: topic.parentCode,
      childCodes: (children.get(topic.code) ?? []).slice().sort(),
      linkMethods,
      // A sourceless node's counts are zero *by construction*, not measured: nothing can link to it.
      count24h: sourceless ? 0 : (observed?.count24h ?? 0),
      count7d: sourceless ? 0 : (observed?.count7d ?? 0),
      lastPublishedAt: sourceless ? null : (observed?.lastPublishedAt ?? null),
      reason: sourceless ? 'TOPIC_NO_SOURCE' : null,
    };
  });
}

/** `code` plus its descendants, to `NI_MAX_DEPTH` and no further (§NI step 5). */
export function rollCodes(nodes: readonly NiTopicNode[], code: string): string[] {
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const out = [code];
  let frontier = [code];
  for (let depth = 1; depth <= NI_MAX_DEPTH; depth += 1) {
    const next: string[] = [];
    for (const parent of frontier) {
      for (const child of byCode.get(parent)?.childCodes ?? []) {
        if (out.includes(child)) continue;
        out.push(child);
        next.push(child);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `data.news.search` caps `limit` at 200; the over-fetch per rolled code stays under it. */
const SEARCH_CAP = 200;

export async function resolve(ctx: ResolveContext, params: NiParams): Promise<NiPayload> {
  // 1-2 — the tree and its counts.
  const topics = await ctx.data.news.topics();
  const stats = await topicStats(ctx);
  const tree = buildTree(ctx, topics, stats);

  // 3-4 — the selection. An unknown code renders the browser with a notice, never an error.
  let selected: NiTopicNode | null = null;
  const wanted = params.topic?.trim().toUpperCase();
  if (wanted !== undefined && wanted !== '') {
    selected = tree.find((node) => node.code === wanted) ?? null;
    if (selected === null) {
      ctx.unavailable.add({
        field: 'topic',
        reason: 'NOT_APPLICABLE',
        detail: `UNKNOWN_TOPIC: ${wanted}`,
      });
    }
  }

  // 6 — freshness, and a refresh of the feed behind the selection where one exists.
  const health = await feedHealth(ctx);
  const feed = selected === null ? undefined : TOPIC_FEED.get(selected.code);
  const sourceId =
    feed === undefined ? null : feed === 'press_all' ? 'fed.rss' : feed === '8-K' ? 'sec.atom' : 'bbg.rss';
  await refreshFeeds(
    ctx,
    health.filter((line) => sourceId !== null && line.sourceId === sourceId && (line.feed === feed || sourceId !== 'bbg.rss')),
  );

  if (selected === null) {
    return {
      variant: 'default',
      topics: tree,
      selected: null,
      rolledCodes: [],
      rows: [],
      liveSubject: null,
      feedHealth: health,
      suppressed: { entitlement: 0, kindFilter: 0 },
      asOf: ctx.asOf.validAt.toISOString(),
    };
  }

  const rolledCodes = params.includeChildren ? rollCodes(tree, selected.code) : [selected.code];
  const liveSubject = `n:topic:${selected.code}`;

  // A sourceless topic keeps its subject — a future source would stream into it — and shows the
  // reason instead of an empty list (§NI step 4).
  if (selected.reason === 'TOPIC_NO_SOURCE') {
    return {
      variant: 'default',
      topics: tree,
      selected,
      rolledCodes,
      rows: [],
      liveSubject,
      feedHealth: health,
      suppressed: { entitlement: 0, kindFilter: 0 },
      asOf: ctx.asOf.validAt.toISOString(),
    };
  }

  // 7 — one search per rolled code, merged. `published_at desc, news_id desc` throughout.
  const want = Math.min(params.limit + 20, SEARCH_CAP);
  const merged = new Map<number, NewsItem>();
  for (const code of rolledCodes) {
    const page = await ctx.data.news.search({ topic: code, limit: want });
    for (const item of page.items) merged.set(item.newsId, item);
  }
  const ordered = [...merged.values()].sort((a, b) =>
    a.publishedAt === b.publishedAt ? b.newsId - a.newsId : a.publishedAt < b.publishedAt ? 1 : -1,
  );

  const wantedKinds = new Set<NewsKind>(params.kinds);
  const byKind: NewsItem[] = [];
  let kindFilter = 0;
  for (const item of ordered) {
    if (wantedKinds.size === 0 || wantedKinds.has(item.kind)) byKind.push(item);
    else kindFilter += 1;
  }

  const access = await newsSourceAccess(ctx);
  const { kept, suppressed: entitlement } = filterByLicence(ctx, byKind, access, 'NI');
  const rows = kept.slice(0, params.limit).map((item) => toNewsRow(ctx, item));

  if (rows.length === 0) {
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NO_SOURCE',
      detail: `NO_HEADLINES_IN_CORPUS: ${selected.code} has a source but no captured headline in the window`,
    });
  }
  if (rows.some((row) => row.sourceId === 'bbg.rss')) {
    ctx.unavailable.add({
      field: 'rows[].summary',
      reason: 'NOT_LICENSED',
      detail: 'NO_BODY_LICENCE: headline, summary and link only',
    });
  }

  return {
    variant: 'default',
    topics: tree,
    selected,
    rolledCodes,
    rows,
    liveSubject,
    feedHealth: health,
    suppressed: { entitlement, kindFilter },
    asOf: ctx.asOf.validAt.toISOString(),
  };
}
