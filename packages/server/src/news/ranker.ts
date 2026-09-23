/**
 * `news/ranker.ts` — the TOP ranking (WORKPLAN §WP-09 L1173, FUNCTIONS_TIER1 §TOP step 6).
 *
 * `data/news.ts#topNews` already orders the corpus in SQL, with a 12-hour half-life and a feed
 * weight, because a screen needs *some* order before this module exists and because the database is
 * the only place that can rank 40 000 stories without reading them all. This module is the part
 * that has to be explainable to the desk: the score is published as four named parts on every row,
 * so "why is this story at the top" has an answer with numbers in it, and `Ctrl+I` on a headline is
 * about provenance rather than about ranking magic.
 *
 * ```
 *   rank = recency × sourceWeight × entitySalience × (1 + clickThrough)
 *
 *   recency        exp(−ageMinutes / 180)   — an hour-old story keeps 72 %, a day-old one 0.03 %
 *   sourceWeight   bbg.rss markets 1.00 · other Bloomberg feeds 0.80 · fed.rss 0.90 · sec.atom 0.60
 *   entitySalience max(links[].confidence), or 0.50 when the story earned no link
 *   clickThrough   7-day usage_events selects ÷ impressions, 0 before any history
 * ```
 *
 * Four properties this shape buys, all of them asserted:
 *
 *  - **monotone in each part.** Raising any one part with the others fixed raises the rank, so a
 *    desk can reason about the parts one at a time.
 *  - **unlinked stories are not buried.** `entitySalience` floors at 0.50 rather than 0, because a
 *    precision-first linker leaves plenty of real markets stories unlinked (§11.3) and a ranking
 *    that punished them would turn a linking policy into an editorial one.
 *  - **click-through can only promote.** It enters as `1 + ct`, never as a multiplier that can zero
 *    a story: a feature with no history yet (`ct = 0`) leaves the rank exactly as the other three
 *    parts computed it, so the first week of the system ranks the same way as the second.
 *  - **deterministic.** No clock is read here; `asOfMs` is passed in, which is what lets a golden
 *    payload at the frozen clock reproduce byte for byte.
 *
 * The second half of the module is the **live prepend** (NEWS-01, §TOP "Live"): `n:` subjects are
 * queued, not conflated, so a headline that arrives over the WebSocket is placed at the head of the
 * list with a rank above the current leader and the tail is dropped. It is not re-ranked in place —
 * a list that reshuffled under the cursor while somebody was reading it would be worse than one
 * that is briefly out of order, and the next `launchKind:'refresh'` recomputes everything.
 */

import { sql } from 'drizzle-orm';

import type { Tx } from '../db/client.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants (FUNCTIONS_TIER1 §TOP step 6)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Recency e-folding time, in minutes: a three-hour-old story keeps 1/e of its recency. */
export const RECENCY_TAU_MINUTES = 180;

/** §TOP step 6: the source weights, by `(sourceId, feed)`. */
export const SOURCE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  'bbg.rss': 0.8,
  'bbg.rss/markets': 1.0,
  'fed.rss': 0.9,
  'sec.atom': 0.6,
});

/** The weight of a source this table does not name — below every named one, never above. */
export const DEFAULT_SOURCE_WEIGHT = 0.6;

/** §TOP step 6: the salience of a story the precision-first linker left unlinked. */
export const UNLINKED_SALIENCE = 0.5;

/** Click-through is read over this window of `usage_events`. */
export const CLICKTHROUGH_WINDOW_DAYS = 7;

/** The four named parts of a rank, published on every TOP row. */
export interface RankParts {
  recency: number;
  feedWeight: number;
  linkConfidence: number;
  clickThrough: number;
}

/** The minimum a story must carry to be ranked. */
export interface RankableStory {
  newsId: number;
  sourceId: string;
  feed: string;
  /** ISO-8601. */
  publishedAt: string;
  links: readonly { confidence: number }[];
}

export interface RankedStory<T extends RankableStory> {
  row: T;
  rank: number;
  rankParts: RankParts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The parts
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Round to six decimals — finer than anything rendered, coarser than binary noise. */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Round to nine **significant** digits, not to nine decimals.
 *
 * `Math.exp` is not required to be correctly rounded, so two hosts can disagree in the last bit and
 * a golden payload would move; rounding pins the value. But the recency term spans six orders of
 * magnitude — a two-day-old story scores 6e-8 — and rounding *decimally* would flatten every story
 * older than a day to exactly zero, collapsing the whole tail into one tie and making the rank
 * non-monotone in age. Significant digits keep the resolution where the values actually live.
 */
function round9sig(x: number): number {
  if (!Number.isFinite(x) || x === 0) return 0;
  return Number(x.toPrecision(9));
}

/** `exp(−ageMinutes / 180)`, clamped at 1 for a story stamped in the future. */
export function recencyOf(publishedAtMs: number, asOfMs: number): number {
  const ageMinutes = (asOfMs - publishedAtMs) / 60_000;
  if (!Number.isFinite(ageMinutes)) return 0;
  if (ageMinutes <= 0) return 1;
  return round9sig(Math.exp(-ageMinutes / RECENCY_TAU_MINUTES));
}

/** The source weight, most specific first: `sourceId/feed`, then `sourceId`, then the default. */
export function sourceWeightOf(sourceId: string, feed: string): number {
  return SOURCE_WEIGHTS[`${sourceId}/${feed}`] ?? SOURCE_WEIGHTS[sourceId] ?? DEFAULT_SOURCE_WEIGHT;
}

/**
 * The strongest link the story carries, or {@link UNLINKED_SALIENCE}.
 *
 * `max` rather than a sum: a story about one company with one 1.0 CIK link is exactly as salient
 * as that link says, and summing would make a round-up of eight weak links outrank it.
 */
export function entitySalienceOf(links: readonly { confidence: number }[]): number {
  let best = 0;
  for (const link of links) if (link.confidence > best) best = link.confidence;
  return best === 0 ? UNLINKED_SALIENCE : round6(Math.min(1, best));
}

export interface RankOptions {
  asOfMs: number;
  /** `newsId → 7-day click-through in [0,1]`. Absent ids score 0. */
  clickThrough?: ReadonlyMap<number, number>;
}

/** The four parts of one story's rank. */
export function rankParts(story: RankableStory, options: RankOptions): RankParts {
  const publishedAtMs = Date.parse(story.publishedAt);
  return {
    recency: Number.isNaN(publishedAtMs) ? 0 : recencyOf(publishedAtMs, options.asOfMs),
    feedWeight: sourceWeightOf(story.sourceId, story.feed),
    linkConfidence: entitySalienceOf(story.links),
    clickThrough: clamp01(options.clickThrough?.get(story.newsId) ?? 0),
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x) || x < 0) return 0;
  return x > 1 ? 1 : round6(x);
}

/** `recency × sourceWeight × entitySalience × (1 + clickThrough)`. */
export function rankOf(parts: RankParts): number {
  return round9sig(
    parts.recency * parts.feedWeight * parts.linkConfidence * (1 + parts.clickThrough),
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Rank a page of stories, highest first.
 *
 * Ties break on `publishedAt` descending and then on `newsId` descending — the same tiebreak the
 * SQL ordering uses, so the in-memory ranking of a page never disagrees with the page the database
 * chose. Total order, no `localeCompare`, no dependence on the input order.
 */
export function rankStories<T extends RankableStory>(
  stories: readonly T[],
  options: RankOptions,
): RankedStory<T>[] {
  const ranked = stories.map((row) => {
    const parts = rankParts(row, options);
    return { row, rank: rankOf(parts), rankParts: parts };
  });
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    if (a.row.publishedAt !== b.row.publishedAt) {
      return a.row.publishedAt < b.row.publishedAt ? 1 : -1;
    }
    return b.row.newsId - a.row.newsId;
  });
  return ranked;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Live prepend (NEWS-01)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Place a headline that arrived over an `n:` subject at the head of a ranked list.
 *
 * The new row's rank is `head.rank + 1`, which is above every rank the scorer can produce (the
 * score is bounded by `1 × 1 × 1 × 2 = 2`, and the leader is already the largest of them), so the
 * list stays sorted by `rank` without re-ranking anything the reader is looking at. The tail is
 * dropped at `limit`, and a story already in the list is replaced in place rather than duplicated —
 * `n:` delivers a *correction* of a story as a second publication of the same `newsId`.
 */
export function prependLive<T extends RankableStory>(
  current: readonly RankedStory<T>[],
  incoming: T,
  options: { limit: number; asOfMs: number; clickThrough?: ReadonlyMap<number, number> },
): RankedStory<T>[] {
  const rest = current.filter((r) => r.row.newsId !== incoming.newsId);
  const head = rest[0];
  const parts = rankParts(incoming, {
    asOfMs: options.asOfMs,
    ...(options.clickThrough === undefined ? {} : { clickThrough: options.clickThrough }),
  });
  const rank = head === undefined ? rankOf(parts) : round9sig(head.rank + 1);
  return [{ row: incoming, rank, rankParts: parts }, ...rest].slice(0, Math.max(0, options.limit));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Click-through
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The function codes whose launches and pages count as one impression of a news list. */
export const IMPRESSION_CODES: readonly string[] = Object.freeze(['TOP', 'N', 'NI', 'CN']);

/**
 * The 7-day click-through per story: `search.select` events over the number of times a news list
 * was shown.
 *
 * `usage_events` records a `newsId` only on the select (§TOP keyboard: `Enter` emits
 * `search.select { newsId, rank }`); nothing stamps a per-story impression, and inventing one would
 * be inventing data. The denominator is therefore what *is* recorded — `fn.launch` and `fn.page`
 * events for the news functions in the same window, which is the number of times a desk was shown a
 * ranked list at all.
 *
 * Returns an **empty map** when the window holds no impressions, which is how the TOP resolver
 * knows to record `NO_CLICKTHROUGH_HISTORY` rather than publish a fabricated zero as though it had
 * been measured. A story with impressions and no selects legitimately scores 0 and is absent from
 * the map, which {@link rankParts} reads as 0 — the same number, arrived at honestly.
 */
export async function clickThroughByNewsId(
  tx: Tx,
  at: { asOfMs: number },
  windowDays: number = CLICKTHROUGH_WINDOW_DAYS,
): Promise<Map<number, number>> {
  const from = new Date(at.asOfMs - windowDays * 86_400_000).toISOString();
  const to = new Date(at.asOfMs).toISOString();
  const codes = sql.join(
    IMPRESSION_CODES.map((c) => sql`${c}`),
    sql`, `,
  );

  const res = await tx.execute<{
    news_id: string | null;
    selects: string;
    impressions: string;
  }>(sql`
    WITH window_events AS (
      SELECT kind, code, details->>'newsId' AS news_id
        FROM usage_events
       WHERE ts >= ${from}::timestamptz
         AND ts <  ${to}::timestamptz
    ),
    impressions AS (
      SELECT count(*)::text AS n
        FROM window_events
       WHERE kind IN ('fn.launch', 'fn.page')
         AND code IN (${codes})
    )
    SELECT w.news_id, count(*)::text AS selects, (SELECT n FROM impressions) AS impressions
      FROM window_events w
     WHERE w.kind = 'search.select'
       AND w.news_id IS NOT NULL
     GROUP BY w.news_id`);

  const out = new Map<number, number>();
  for (const row of res.rows) {
    if (row.news_id === null) continue;
    const newsId = Number(row.news_id);
    const impressions = Number(row.impressions);
    if (!Number.isInteger(newsId) || !Number.isFinite(impressions) || impressions <= 0) continue;
    out.set(newsId, clamp01(Number(row.selects) / impressions));
  }
  return out;
}
