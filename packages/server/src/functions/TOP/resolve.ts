/**
 * `functions/TOP/resolve.ts` — the ranked front page (FUNCTIONS_TIER1.md §TOP L1119-1236).
 *
 * TOP is a list, and the three things that make it a *function* are the three things this file
 * spends its length on.
 *
 *  1. **The rank is published, not just applied.** `news/ranker.ts` produces the score and its four
 *     named parts, and both travel in the payload. "Why is this at the top" therefore has an answer
 *     with numbers in it, and the answer is the same one the ordering used — the rows are sorted by
 *     `rankStories`, not re-sorted here.
 *  2. **Feed health is a value (TERM-12).** A quiet market and a stopped capture look identical on a
 *     news screen. `feedHealth` distinguishes them, and a line that is not `live` is refreshed
 *     through `ctx.providers.ensure` where a read-through exists — with the two cases where it does
 *     not stated rather than hidden: an open circuit (`PROVIDER_DOWN`) and `sec.atom`, which has no
 *     `ReadThroughKind` at all (`NO_READ_THROUGH_SEC_ATOM`).
 *  3. **What was dropped is counted.** A `kinds` filter and a missing source licence both remove
 *     headlines. `suppressed` carries both counts, so the screen can say "3 hidden" instead of
 *     silently showing a shorter list.
 *
 * The ordering of the two filters matters and is not arbitrary: `kinds` is the user's own choice
 * and is counted first, the licence filter is the firm's contract and is counted second, so the two
 * numbers on screen mean exactly what they say.
 *
 * Click-through is the one rank part that can be *absent* rather than zero. An empty
 * `clickThroughByNewsId` map means the 7-day window holds no impressions at all — nothing was
 * measured — and that is recorded as `NO_CLICKTHROUGH_HISTORY` rather than published as a measured
 * zero (§TOP step 6).
 */

import { sql } from 'drizzle-orm';

import type { NewsSourceId } from '@terminal/core/functions/shared/news';
import type {
  TopFeedHealth,
  TopParams,
  TopPayload,
  TopRow,
  TopScope,
} from '@terminal/core/functions/manifests/TOP';

import type { NewsItem, NewsKind } from '../../data/news.js';
import { clickThroughByNewsId, rankStories } from '../../news/ranker.js';
import { ProviderUnavailableError, type ResolveContext } from '../context.js';
import {
  feedHealth,
  filterByLicence,
  newsSourceAccess,
  toNewsRow,
} from '../shared/feedHealth.js';
import { rowMeta } from '../QM/resolve.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scope (§TOP resolver step 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Resolved {
  scope: TopScope;
  id: string | null;
  label: string;
  liveSubject: string;
}

const ALL: Resolved = { scope: 'all', id: null, label: 'All news', liveSubject: 'n:all' };

/** `'markets'` → `'Markets'`, `'press_all'` → `'Press All'`. The feed's own name, title-cased. */
function feedLabel(feed: string): string {
  return feed
    .split(/[_\s-]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface FeedSql extends Record<string, unknown> {
  feed: string;
}

/** The distinct feeds the corpus actually holds, as-of `knownAt`. One query, used by `auto`. */
export async function feedsOf(ctx: ResolveContext): Promise<string[]> {
  const res = await ctx.db.execute<FeedSql>(sql`
    SELECT DISTINCT feed FROM news_items
     WHERE captured_at <= ${ctx.asOf.knownAt.toISOString()}::timestamptz
     ORDER BY feed`);
  return res.rows.map((row) => row.feed);
}

/**
 * `(scope, id)` → the block the payload echoes, or `all` with a reason.
 *
 * NEWS-01's rule is that the screen always shows *something*: an id that names nothing is a
 * degradation to the full front page with `UNKNOWN_SCOPE` in `meta.unavailable`, never a 404. The
 * same treatment is given to an explicit `SCOPE=TOPIC` with an unknown code — the user's typo is
 * not a reason to show them an empty screen.
 */
async function resolveScope(ctx: ResolveContext, params: TopParams): Promise<Resolved> {
  const id = params.id?.trim();
  if (params.scope === 'all' || id === undefined || id === '') {
    if (params.scope !== 'all' && params.scope !== 'auto') {
      ctx.unavailable.add({
        field: 'scope',
        reason: 'NOT_APPLICABLE',
        detail: `NO_SCOPE_ID: scope '${params.scope}' needs an id; showing all news`,
      });
    }
    return ALL;
  }

  const topics = await ctx.data.news.topics();
  const topic = topics.find((t) => t.code === id.toUpperCase());
  if ((params.scope === 'auto' || params.scope === 'topic') && topic !== undefined) {
    return {
      scope: 'topic',
      id: topic.code,
      label: topic.name,
      liveSubject: `n:topic:${topic.code}`,
    };
  }

  const feeds = await feedsOf(ctx);
  const feed = feeds.find((f) => f === id.toLowerCase());
  if ((params.scope === 'auto' || params.scope === 'feed') && feed !== undefined) {
    return { scope: 'feed', id: feed, label: feedLabel(feed), liveSubject: `n:feed:${feed}` };
  }

  if ((params.scope === 'auto' || params.scope === 'instrument') && /^\d+$/.test(id)) {
    const instrumentId = Number(id);
    const meta = await rowMeta(ctx, [instrumentId]);
    const known = meta.get(instrumentId);
    if (known !== undefined) {
      return {
        scope: 'instrument',
        id,
        label: known.key,
        liveSubject: `n:inst:${String(instrumentId)}`,
      };
    }
  }

  ctx.unavailable.add({
    field: 'scope',
    reason: 'NOT_APPLICABLE',
    detail: `UNKNOWN_SCOPE: '${id}' is neither a topic code, a feed nor an instrument id`,
  });
  return ALL;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Read-through (§TOP resolver step 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The one key each source refreshes under; `sec.atom` has no read-through kind at all. */
function refreshKindOf(line: TopFeedHealth): { kind: 'bbg.rss' | 'fed.rss'; maxAgeMs: number } | null {
  if (line.sourceId === 'bbg.rss') return { kind: 'bbg.rss', maxAgeMs: 60_000 };
  if (line.sourceId === 'fed.rss') return { kind: 'fed.rss', maxAgeMs: 300_000 };
  return null;
}

/**
 * Refresh every line that is not `live`, and say so when a line cannot be refreshed.
 *
 * A `ProviderUnavailableError` is caught rather than rethrown: TOP's job is to show the stored
 * headlines, and a dead upstream is a fact about freshness, not a reason to show nothing (TERM-12).
 * Exports never refresh — an export re-runs at a cached `asOf` and a mid-export fetch would make
 * the CSV disagree with the JSON it claims to be.
 */
export async function refreshFeeds(ctx: ResolveContext, lines: readonly TopFeedHealth[]): Promise<void> {
  const reported = new Set<string>();
  for (const line of lines) {
    if (line.sourceId === 'sec.atom' && line.st !== 'live') {
      ctx.unavailable.add({
        field: 'feedHealth.sec.atom',
        reason: 'NO_SOURCE',
        detail: 'NO_READ_THROUGH_SEC_ATOM: 8-K headlines refresh only on the scheduler tick',
      });
      continue;
    }
    if (line.st === 'live' || ctx.usage === 'export') continue;
    const route = refreshKindOf(line);
    if (route === null) continue;
    const key = line.sourceId === 'fed.rss' ? 'press_all' : line.feed;
    try {
      await ctx.providers.ensure(route.kind, key, { maxAgeMs: route.maxAgeMs });
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError)) throw err;
      if (reported.has(line.sourceId)) continue;
      reported.add(line.sourceId);
      ctx.unavailable.add({
        field: `feedHealth.${line.sourceId}`,
        reason: 'NO_SOURCE',
        detail: 'PROVIDER_DOWN: serving stored headlines',
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The resolver
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `data.news.top` caps its own `limit` at 50, so the over-fetch is asked for honestly. */
const TOP_SERVICE_CAP = 50;

export async function resolve(ctx: ResolveContext, params: TopParams): Promise<TopPayload> {
  const resolved = await resolveScope(ctx, params);

  // 2-3 — freshness first: what the rows are worth depends on when they were captured.
  const health = await feedHealth(ctx);
  await refreshFeeds(ctx, health);

  // 4 — the ranker over-fetches so the `kinds` filter does not shorten the page.
  const wanted = Math.min(params.limit + 20, TOP_SERVICE_CAP);
  const items = await ctx.data.news.top(
    resolved.scope,
    resolved.id ?? undefined,
    wanted,
  );

  // 5 — the user's filter, then the firm's licence. Counted separately: they mean different things.
  const kinds = new Set<NewsKind>(params.kinds);
  const byKind: NewsItem[] = [];
  let kindFilter = 0;
  for (const item of items) {
    if (kinds.has(item.kind)) byKind.push(item);
    else kindFilter += 1;
  }

  const access = await newsSourceAccess(ctx);
  const { kept, suppressed: entitlement } = filterByLicence(ctx, byKind, access, 'TOP');

  // 6 — rank, then truncate, then project. Ranking before projection keeps `ctx.prov` free of
  // citations for rows nobody will see: a provenance list is a record of what was served.
  const clickThrough = await clickThroughByNewsId(ctx.db, { asOfMs: ctx.asOf.validAt.getTime() });
  if (clickThrough.size === 0) {
    ctx.unavailable.add({
      field: 'rows[].rankParts.clickThrough',
      reason: 'NO_SOURCE',
      detail: 'NO_CLICKTHROUGH_HISTORY: fewer than 7 days of usage events',
    });
  }
  const ranked = rankStories(kept, {
    asOfMs: ctx.asOf.validAt.getTime(),
    clickThrough,
  }).slice(0, params.limit);

  const rows: TopRow[] = ranked.map((entry) => ({
    ...toNewsRow(ctx, entry.row),
    rank: entry.rank,
    rankParts: entry.rankParts,
  }));

  // The body licence is a property of the source, not of any one row: stated once, for the footer.
  if (rows.some((row) => row.sourceId === ('bbg.rss' satisfies NewsSourceId))) {
    ctx.unavailable.add({
      field: 'rows[].summary',
      reason: 'NOT_LICENSED',
      detail:
        'NO_BODY_LICENCE: headline, summary and link only — the article body is never stored',
    });
  }

  return {
    variant: 'default',
    resolved: { scope: resolved.scope, id: resolved.id, label: resolved.label },
    rows,
    liveSubject: resolved.liveSubject,
    feedHealth: health,
    suppressed: { entitlement, kindFilter },
    asOf: ctx.asOf.validAt.toISOString(),
  };
}
