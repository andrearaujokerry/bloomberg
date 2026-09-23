/**
 * `functions/N/resolve.ts` — the chronological reader (FUNCTIONS_TIER1.md §N L1237-1369).
 *
 * N searches the same corpus TOP ranks and differs from it in two ways that the payload has to
 * make visible, because both are invisible on screen otherwise.
 *
 * **It never re-ranks.** Rows come back `published_at desc, news_id desc` and stay that way. That
 * is what makes paging honest: PAGE FWD is *older*, the cursor is a keyset over
 * `(published_at, news_id)`, and a headline arriving mid-paging can neither duplicate a row nor
 * push one past the reader unseen. `total` is the count at `asOf` and does not move between pages.
 *
 * **It says how it matched.** `matcher` and the echoed `tsquery` are payload. WP-04's
 * `searchNews` falls back from `websearch_to_tsquery` to a headline match when the stemmed query
 * hits nothing, which is the right behaviour and the wrong thing to do silently: nine near-misses
 * presented as hits is a worse answer than "no exact match". The fallback is therefore detected and
 * reported, with `TRIGRAM_FALLBACK` in `meta.unavailable`.
 *
 * How the matcher is detected is worth stating, because it is deliberately *not* a second copy of
 * the service's branch condition. The service chooses one branch for the whole query: when the
 * stemmed query matches at least one row, every row it returns matches it; when it matches none,
 * no returned row can. So asking the database whether the returned page satisfies the tsquery
 * answers exactly which branch ran, with no duplicated filter logic to drift.
 *
 * The cursor is minted here rather than passed through. The service's cursor carries the keyset and
 * nothing else; `meta.page.index` needs the page number too, and a resolver that guessed it would
 * report page 2 forever. So N's cursor is the §N shape — `{ publishedAt, newsId }` — plus the index,
 * and it is translated to the service's form on the way in. One cursor, both facts, no state.
 */

import { sql } from 'drizzle-orm';

import type { NewsKind } from '@terminal/core/functions/shared/news';
import type { NParams, NPayload, NQuery } from '@terminal/core/functions/manifests/N';
import { N_TOTAL_CAP } from '@terminal/core/functions/manifests/N';

import type { NewsQuery } from '../../data/news.js';
import type { ResolveContext } from '../context.js';
import { displayOf } from '../shared/instrumentSummary.js';
import {
  feedHealth,
  filterByLicence,
  newsSourceAccess,
  toNewsRow,
} from '../shared/feedHealth.js';
import { feedsOf } from '../TOP/resolve.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The cursor (§N resolver step 9)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** §N's cursor content, plus the page index `meta.page` needs and nothing else carries. */
interface NCursor {
  publishedAt: string;
  newsId: number;
  index: number;
}

export function encodeNCursor(cursor: NCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** A cursor this resolver did not mint is treated as page 1, never as a 500. */
export function decodeNCursor(raw: string | null): NCursor | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const c = parsed as { publishedAt?: unknown; newsId?: unknown; index?: unknown };
    if (typeof c.publishedAt !== 'string' || typeof c.newsId !== 'number') return null;
    return {
      publishedAt: c.publishedAt,
      newsId: c.newsId,
      index: typeof c.index === 'number' && c.index >= 0 ? c.index : 0,
    };
  } catch {
    return null;
  }
}

/** The keyset as `data/news.ts` encodes it: `{ p, n }`, base64url of canonical JSON. */
function toServiceCursor(cursor: NCursor): string {
  return Buffer.from(
    JSON.stringify({ p: cursor.publishedAt, n: cursor.newsId }),
    'utf8',
  ).toString('base64url');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Saved searches (§N resolver step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface SavedSql extends Record<string, unknown> {
  search_id: string;
  owner_user_id: string;
  name: string;
  query: unknown;
}

/** The subset of a stored `saved_searches.query` N understands. Anything else is ignored. */
interface SavedQuery {
  q?: string;
  feeds?: string[];
  topics?: string[];
  kinds?: NewsKind[];
  from?: string;
  to?: string;
}

const KINDS: readonly NewsKind[] = ['story', 'video', 'filing', 'press_release', 'fed_release'];

function strings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === 'string');
  return out.length === 0 ? undefined : out;
}

function savedQueryOf(raw: unknown): SavedQuery {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  const out: SavedQuery = {};
  // `text` is the column comment's name for it; `q` is what the function's own params call it.
  const text = typeof row.q === 'string' ? row.q : typeof row.text === 'string' ? row.text : null;
  if (text !== null && text.trim() !== '') out.q = text;
  const feeds = strings(row.feeds);
  if (feeds !== undefined) out.feeds = feeds;
  const topics = strings(row.topics);
  if (topics !== undefined) out.topics = topics;
  const kinds = strings(row.kinds)?.filter((k): k is NewsKind => KINDS.includes(k as NewsKind));
  if (kinds !== undefined && kinds.length > 0) out.kinds = kinds;
  if (typeof row.from === 'string') out.from = row.from;
  if (typeof row.to === 'string') out.to = row.to;
  return out;
}

/**
 * Load the saved search, or say why it was not used.
 *
 * RLS scopes `saved_searches` to its owner already; the explicit owner check is here so that a
 * search belonging to somebody else produces the stated `SAVED_SEARCH_NOT_YOURS` degradation
 * rather than an indistinguishable "not found" — the user asked for a specific id and deserves to
 * know which of the two happened.
 */
async function loadSaved(
  ctx: ResolveContext,
  searchId: number,
): Promise<{ searchId: number; name: string; query: SavedQuery } | null> {
  const res = await ctx.db.execute<SavedSql>(sql`
    SELECT search_id::text AS search_id, owner_user_id::text AS owner_user_id, name, query
      FROM saved_searches
     WHERE search_id = ${searchId} AND kind = 'news'`);
  const row = res.rows[0];
  if (row === undefined || Number(row.owner_user_id) !== ctx.user.userId) {
    ctx.unavailable.add({
      field: 'savedSearch',
      reason: 'NOT_APPLICABLE',
      detail: 'SAVED_SEARCH_NOT_YOURS',
    });
    return null;
  }
  return { searchId: Number(row.search_id), name: row.name, query: savedQueryOf(row.query) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Matcher detection (§N resolver step 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface MatcherSql extends Record<string, unknown> {
  tsq: string;
  matched: string;
  total: string;
}

/**
 * The stemmed query as text, and whether the returned page satisfies it.
 *
 * One query, two answers: `tsquery` is echoed so a reader can see what was actually searched for
 * ("rate cut" → `'rate' & 'cut'`), and `matched === total` decides the branch. An empty page with a
 * query set can only have come from the fallback — the tsquery branch would have returned rows if
 * it had any — so it reports `trigram`.
 */
async function matcherFor(
  ctx: ResolveContext,
  q: string,
  newsIds: readonly number[],
): Promise<{ matcher: 'tsquery' | 'trigram'; tsquery: string }> {
  const ids = newsIds.length === 0 ? [0] : [...newsIds];
  const res = await ctx.db.execute<MatcherSql>(sql`
    SELECT websearch_to_tsquery('english', ${q})::text AS tsq,
           count(*) FILTER (WHERE n.tsv @@ websearch_to_tsquery('english', ${q}))::text AS matched,
           count(*)::text AS total
      FROM news_items n
     WHERE n.news_id = ANY(${sql.param(ids.map((id) => String(id)))}::bigint[])`);
  const row = res.rows[0];
  const tsquery = row?.tsq ?? '';
  const matched = Number(row?.matched ?? '0');
  const total = Number(row?.total ?? '0');
  return { matcher: total > 0 && matched === total ? 'tsquery' : 'trigram', tsquery };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

export async function resolve(ctx: ResolveContext, params: NParams): Promise<NPayload> {
  // 1 — merge the saved search UNDER the explicit params, field by field.
  const saved =
    params.savedSearchId === undefined ? null : await loadSaved(ctx, params.savedSearchId);
  const s = saved?.query ?? {};
  const q = (params.q ?? s.q ?? '').trim() === '' ? null : ((params.q ?? s.q)!).trim();
  const kinds = params.kinds.length > 0 ? params.kinds : (s.kinds ?? []);
  const from = params.from ?? s.from ?? null;
  const to = params.to ?? s.to ?? null;
  let feeds = params.feeds.length > 0 ? params.feeds : (s.feeds ?? []);
  let topics = params.topics.length > 0 ? params.topics : (s.topics ?? []);

  // 2 — the panel's security, when the scope asks for one (TERM-03).
  let instrumentId: number | null = null;
  let instrumentDisplay: string | null = null;
  if (params.scope === 'security') {
    if (ctx.instrument === null) {
      ctx.unavailable.add({
        field: 'query.instrumentId',
        reason: 'NOT_APPLICABLE',
        detail: 'NO_SECURITY_LOADED: N SCOPE=SECURITY needs a security in the panel',
      });
    } else {
      instrumentId = ctx.instrument.instrumentId;
      instrumentDisplay = displayOf(
        ctx.instrument.ticker,
        ctx.instrument.exchCode,
        ctx.instrument.marketSector,
      );
    }
  }

  // 3 — every topic and feed the corpus does not know is dropped, and named.
  const known = await ctx.data.news.topics();
  const codes = new Set(known.map((t) => t.code));
  const keptTopics: string[] = [];
  for (const raw of topics) {
    const code = raw.trim().toUpperCase();
    if (codes.has(code)) keptTopics.push(code);
    else {
      ctx.unavailable.add({
        field: 'query.topics',
        reason: 'NOT_APPLICABLE',
        detail: `UNKNOWN_TOPIC: ${raw}`,
      });
    }
  }
  topics = keptTopics;

  const corpusFeeds = new Set(await feedsOf(ctx));
  const keptFeeds: string[] = [];
  for (const raw of feeds) {
    const feed = raw.trim().toLowerCase();
    if (corpusFeeds.has(feed)) keptFeeds.push(feed);
    else {
      ctx.unavailable.add({
        field: 'query.feeds',
        reason: 'NOT_APPLICABLE',
        detail: `UNKNOWN_FEED: ${raw}`,
      });
    }
  }
  feeds = keptFeeds;

  // `data.news.search` filters on one feed and one topic (its `NewsQuery` is single-valued, and so
  // is `GET /news`). A second value is therefore not applied, and not applied *silently* would be
  // a query that says it filtered on two things and filtered on one.
  if (feeds.length > 1) {
    ctx.unavailable.add({
      field: 'query.feeds',
      reason: 'NOT_APPLICABLE',
      detail: `MULTI_FEED_NARROWED: only '${String(feeds[0])}' was applied; one feed per search`,
    });
    feeds = [feeds[0]!];
  }
  if (topics.length > 1) {
    ctx.unavailable.add({
      field: 'query.topics',
      reason: 'NOT_APPLICABLE',
      detail: `MULTI_TOPIC_NARROWED: only '${String(topics[0])}' was applied; one topic per search`,
    });
    topics = [topics[0]!];
  }

  const query: NQuery = {
    q,
    instrumentId,
    instrumentDisplay,
    feeds,
    topics,
    kinds,
    from,
    to,
  };

  // 4 — the search itself, one round trip, over the stored corpus only (no read-through: a search
  // must be reproducible, and refetching a feed mid-page would reorder the results).
  const cursor = decodeNCursor(ctx.page?.cursor ?? null);
  const request: NewsQuery = { limit: params.pageSize };
  if (q !== null) request.q = q;
  if (instrumentId !== null) request.instrumentId = instrumentId;
  if (topics[0] !== undefined) request.topic = topics[0];
  if (feeds[0] !== undefined) request.feed = feeds[0];
  if (kinds.length > 0) request.kinds = kinds;
  if (from !== null) request.from = from;
  if (to !== null) request.to = to;
  if (cursor !== null) request.cursor = toServiceCursor(cursor);

  const found = await ctx.data.news.search(request);

  // 5 — STOR-04: the corpus is unbounded and the count is not worth a full scan.
  const totalIsCapped = found.total > N_TOTAL_CAP;
  const total = totalIsCapped ? N_TOTAL_CAP : found.total;
  if (totalIsCapped) {
    ctx.unavailable.add({
      field: 'total',
      reason: 'NOT_APPLICABLE',
      detail: 'TOTAL_CAPPED_1000: more than 1000 matches; narrow the query',
    });
  }

  // 6 — the firm's licence, per source, with the drops counted.
  const access = await newsSourceAccess(ctx);
  const { kept, suppressed: entitlement } = filterByLicence(ctx, found.items, access, 'N');

  // 7 — freshness is reported, never fetched (see the module note).
  const health = await feedHealth(ctx);

  // 8 — projection. `matcher` is asked of the rows the service actually returned.
  const rows = kept.map((item) => toNewsRow(ctx, item));
  let matcher: NPayload['matcher'] = 'none';
  let tsquery: string | null = null;
  if (q !== null) {
    const verdict = await matcherFor(
      ctx,
      q,
      found.items.map((item) => item.newsId),
    );
    matcher = verdict.matcher;
    tsquery = verdict.tsquery;
    if (matcher === 'trigram') {
      ctx.unavailable.add({
        field: 'rows',
        reason: 'NO_SOURCE',
        detail:
          'TRIGRAM_FALLBACK: no exact match for the query; showing approximate headline matches',
      });
    }
  }
  if (rows.some((row) => row.sourceId === 'bbg.rss')) {
    ctx.unavailable.add({
      field: 'rows[].summary',
      reason: 'NOT_LICENSED',
      detail: 'NO_BODY_LICENCE: headline, summary and link only',
    });
  }

  // 9 — paging. PAGE FWD is older, because the sort is `published_at desc`.
  const index = cursor?.index ?? 0;
  const last = found.items[found.items.length - 1];
  const nextCursor =
    found.nextCursor === null || last === undefined
      ? null
      : encodeNCursor({ publishedAt: last.publishedAt, newsId: last.newsId, index: index + 1 });
  ctx.page?.set({
    index,
    count: Math.max(1, Math.ceil(total / params.pageSize)),
    cursor: nextCursor,
  });

  // A text query cannot be evaluated on the wire; the screen says so rather than subscribing to a
  // subject that would prepend headlines the query does not match.
  const hasLiveSubject =
    instrumentId !== null ||
    (q === null && topics.length === 1 && feeds.length === 0) ||
    (q === null && feeds.length === 1 && topics.length === 0);
  if (!hasLiveSubject) {
    ctx.unavailable.add({
      field: 'live',
      reason: 'NOT_APPLICABLE',
      detail: 'NO_LIVE_FOR_TEXT_QUERY: text queries cannot be evaluated on the wire',
    });
  }

  return {
    variant: 'default',
    query,
    matcher,
    tsquery,
    rows,
    total,
    totalIsCapped,
    nextCursor,
    savedSearch: saved === null ? null : { searchId: saved.searchId, name: saved.name },
    feedHealth: health,
    suppressed: { entitlement },
    asOf: ctx.asOf.validAt.toISOString(),
  };
}
