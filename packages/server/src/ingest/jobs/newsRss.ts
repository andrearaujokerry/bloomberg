/**
 * `ingest/jobs/newsRss.ts` — the news poll (PROVIDERS §13, WORKPLAN §WP-09 L1174).
 *
 * One scheduler row drives all three news sources, because they are one product: the desk reads a
 * single ranked stream in which a Bloomberg markets story, an 8-K and a Fed press release sit
 * beside each other. Splitting the poll into three jobs would build the dictionary three times a
 * minute, link a story against a different security master than the story above it, and give
 * `TOP`'s health chips three unrelated `ingest_runs` histories to reconcile.
 *
 * The run, in order:
 *
 *  1. **fetch and store**, per source, each with its own `provenance` row — five Bloomberg feeds,
 *     the SEC 8-K current-filings atom and the Fed press-release feed. `news/ingest.ts` upserts on
 *     `(source_id, provider_guid)` and reports per row whether it inserted, changed or left alone.
 *  2. **link once**, over everything the run touched, against **one** dictionary snapshot
 *     (PROVIDERS.b §11.3.1). Building it once per run is not an optimisation: it is what makes the
 *     run reproducible from its `(validAt, knownAt)` pair, and what stops two stories in the same
 *     poll being linked against two different worlds.
 *  3. **fan out** the inserted-and-changed stories onto their `n:` subjects, oldest first. News is
 *     queued rather than conflated (NEWS-01), so a later headline never overwrites an earlier one.
 *
 * **Idempotent by construction.** A second execution over the same captures upserts the same rows,
 * finds nothing changed, writes no `news_entity_links` row it has not already written and publishes
 * nothing — `news_items` does not grow and no duplicate headline reaches a screen. `provenance`
 * *does* grow, one row per exchange, which is the honest record of how often we asked
 * (PROVIDERS.a §1.3).
 *
 * **Replay is a wall.** With no `HttpClient` wired the job reads the recorded captures through the
 * replay store, and a key the store does not hold throws rather than opening a socket. One feed the
 * recording does not cover (`wealth` has no capture) is counted in `skipped` and logged, not turned
 * into an error: in replay the honest reading of a missing capture is "that feed did not answer
 * this tick", and a run that failed because a fixture is absent would hide the runs that failed
 * because a parser broke.
 */

import { buildNewsDict } from '../../refdata/newsDict.js';
import { linkNewsItems, loadTopicIds } from '../../news/entityLink.js';
import { publishNews, upsertNewsItems } from '../../news/ingest.js';
import {
  BBG_RSS_ADAPTER_VERSION,
  bbgFeedUrl,
  bbgRssAdapter,
  BBG_FEEDS,
} from '../../providers/bbgRss/adapter.js';
import {
  FED_PRESS_FEED_URL,
  FED_RSS_ADAPTER_VERSION,
  fedRssAdapter,
} from '../../providers/fedRss/adapter.js';
import { atomUrl, secAtomAdapter } from '../../providers/sec/adapter.js';
import { SEC_ADAPTER_VERSION } from '../../providers/sec/parse.js';
import { ReplayMissError } from '../../providers/replayStore.js';
import {
  emptyResult,
  fetchError,
  fetchThrough,
  normaliseWithProvenance,
  withIngestRun,
} from './cboeQuotes.js';

import type { BbgFeed } from '../../providers/bbgRss/adapter.js';
import type { LinkCandidate } from '../../news/entityLink.js';
import type { NewsItem } from '../../data/news.js';
import type { NewsItemInput, NewsSourceId, UpsertedNewsItem } from '../../news/ingest.js';
import type { MarketJobContext, MarketJobResult } from './cboeQuotes.js';
import type { NormaliseLine, ProviderId, RawRecord } from '../../providers/types.js';

/** §13 `newsRss`: a minute, which is both feeds' own cadence. */
export const NEWS_RSS_SCHEDULE = { everyMs: 60_000 } as const;

/** The three sources one run writes. */
export const NEWS_PROVIDERS: readonly ProviderId[] = Object.freeze([
  'bbg.rss',
  'sec.atom',
  'fed.rss',
] as ProviderId[]);

/** The 8-K current-filings feed this job polls. */
export const SEC_ATOM_TYPE = '8-K';
export const SEC_ATOM_COUNT = 40;

/** News carries no `md_lines`; the normalisers take the empty map. */
const NO_LINES: ReadonlyMap<string, NormaliseLine> = new Map();

/** One fetched, parsed and stored capture. */
interface Batch {
  sourceId: NewsSourceId;
  provenanceId: number;
  capturedAt: number;
  items: UpsertedNewsItem[];
  extraLinks: Map<number, LinkCandidate[]>;
}

export interface NewsRssResult extends MarketJobResult {
  /** Stories seen this run, stored or already stored. */
  stories: number;
  /** `news_entity_links` rows written or strengthened. */
  linked: number;
  /** Stories that earned no link — the precision-first outcome (NEWS-02), not a failure. */
  unlinked: number;
  /** `n:` publications handed to the plant. */
  published: number;
}

function emptyNewsResult(): NewsRssResult {
  return { ...emptyResult(), stories: 0, linked: 0, unlinked: 0 };
}

/** `true` for the one error a replay-mode run treats as "this feed did not answer". */
function isReplayMiss(err: unknown): boolean {
  return err instanceof ReplayMissError || (err as { name?: string })?.name === 'ReplayMissError';
}

/**
 * The OPS-07 fields a news request carries through to `provenance`.
 *
 * Not `cboeQuotes#requestEnvelope`: that one also sets `budgetShare`, which the two RSS request
 * types do not declare, and a request object is built once and passed by reference here rather
 * than being spread into a call argument, so an excess property would be a type error at the call
 * site of a module this job does not own.
 */
function newsEnvelope(ctx: NewsJobContext): { traceId?: string; runId?: number } {
  const env: { traceId?: string; runId?: number } = {};
  if (ctx.traceId !== undefined) env.traceId = ctx.traceId;
  if (ctx.runId !== undefined) env.runId = ctx.runId;
  return env;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface NewsJobContext extends MarketJobContext {
  /** The Bloomberg feeds to poll. Defaults to all six of §11.1. */
  feeds?: readonly BbgFeed[];
  /**
   * NEWS-07. The alert engine's news entry point (`alerts/engine.ts#attachAlertEngine`), offered
   * every story the run stored, after its links are written — a news alert names instruments and
   * topics, so it can only be evaluated once linking has happened.
   *
   * Optional, and a throw from it never fails the run: a saved-search alert that cannot be
   * evaluated must not lose the story that was already ingested.
   */
  alerts?: { onNews(item: NewsItem): Promise<void> };
}

export async function runNewsRss(ctx: NewsJobContext): Promise<NewsRssResult> {
  // The run row is opened around the whole poll and the result object is this function's, not the
  // callback's: `withIngestRun` is typed to the shared `MarketJobResult`, and the four news counters
  // are additions it does not know about. Mutating one object and returning it from both levels
  // keeps the `ingest_runs` bookkeeping exactly as every other job writes it.
  const result = emptyNewsResult();
  await withIngestRun(ctx, { id: 'newsRss', sourceId: null }, async () => {
    const batches: Batch[] = [];

    // ── 1 · Bloomberg, one capture per feed ──────────────────────────────────────────────────
    //
    // §11.1: all six feeds share `source_id 'bbg.rss'` and `feed` is not part of the unique key, so
    // a story carried by two of them is one row and the **first feed polled owns it**. The guard is
    // a run-level guid set rather than a per-capture one, because the alternative — letting each
    // feed's own INSERT win in turn — would rewrite `feed` twice per run and report an update on
    // every re-poll of an unchanged story.
    const bbgSeen = new Set<string>();
    for (const feed of ctx.feeds ?? BBG_FEEDS) {
      const url = bbgFeedUrl(feed);
      const request = { feed, ...newsEnvelope(ctx) };
      let raw: RawRecord;
      try {
        raw = await fetchThrough(ctx, bbgRssAdapter, request, url);
      } catch (err) {
        if (isReplayMiss(err)) {
          result.skipped += 1;
          ctx.log?.info?.('newsRss.feed_unavailable', { sourceId: 'bbg.rss', feed });
          continue;
        }
        result.errors.push(fetchError(err, url));
        continue;
      }
      if (raw.status === 304) {
        result.skipped += 1;
        continue;
      }
      result.fetched += 1;

      const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
        raw,
        adapterVersion: BBG_RSS_ADAPTER_VERSION,
        lines: NO_LINES,
        normalise: (r, nctx) => bbgRssAdapter.normalise(r, nctx),
      });
      result.provenanceIds.push(provenanceId);
      result.problems.push(...norm.problems);

      const fresh = norm.rows.items.filter((item) => !bbgSeen.has(item.providerGuid));
      for (const item of fresh) bbgSeen.add(item.providerGuid);
      result.skipped += norm.rows.items.length - fresh.length;

      const inputs: NewsItemInput[] = fresh.map((item) => ({
        sourceId: 'bbg.rss',
        feed: item.feed === '' ? feed : item.feed,
        providerGuid: item.providerGuid,
        kind: item.kind,
        headline: item.headline,
        summary: item.summary,
        url: item.url,
        author: item.author,
        category: item.category,
        cik: item.cik,
        items8k: null,
        lang: item.lang,
        publishedAt: item.publishedAt,
        isCorrection: item.isCorrection,
      }));
      batches.push(await store(ctx, result, { sourceId: 'bbg.rss', provenanceId, raw, inputs }));
    }

    // ── 2 · SEC 8-K current filings ──────────────────────────────────────────────────────────
    {
      const url = atomUrl(SEC_ATOM_TYPE, SEC_ATOM_COUNT);
      const request = { type: SEC_ATOM_TYPE, count: SEC_ATOM_COUNT, ...newsEnvelope(ctx) };
      const raw = await tryFetch(ctx, result, () =>
        fetchThrough(ctx, secAtomAdapter, request, url),
      );
      if (raw !== null && raw.status !== 304) {
        result.fetched += 1;
        const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
          raw,
          adapterVersion: SEC_ADAPTER_VERSION,
          lines: NO_LINES,
          normalise: (r, nctx) => secAtomAdapter.normalise(r, nctx),
        });
        result.provenanceIds.push(provenanceId);
        result.problems.push(...norm.problems);

        const inputs: NewsItemInput[] = norm.rows.newsItems.map((item) => ({
          sourceId: 'sec.atom',
          feed: item.feed,
          providerGuid: item.providerGuid,
          kind: item.kind,
          headline: item.headline,
          summary: item.summary,
          url: item.url,
          author: null,
          category: item.category,
          cik: item.cik,
          items8k: item.items8k,
          lang: item.lang,
          publishedAt: item.publishedAt,
          isCorrection: item.isCorrection,
        }));
        batches.push(await store(ctx, result, { sourceId: 'sec.atom', provenanceId, raw, inputs }));
      } else if (raw !== null) {
        result.skipped += 1;
      }
    }

    // ── 3 · Federal Reserve press releases ───────────────────────────────────────────────────
    {
      const request = newsEnvelope(ctx);
      const raw = await tryFetch(ctx, result, () =>
        fetchThrough(ctx, fedRssAdapter, request, FED_PRESS_FEED_URL),
      );
      if (raw !== null && raw.status !== 304) {
        result.fetched += 1;
        const { provenanceId, norm } = await normaliseWithProvenance(ctx, {
          raw,
          adapterVersion: FED_RSS_ADAPTER_VERSION,
          lines: NO_LINES,
          normalise: (r, nctx) => fedRssAdapter.normalise(r, nctx),
        });
        result.provenanceIds.push(provenanceId);
        result.problems.push(...norm.problems);

        const inputs: NewsItemInput[] = norm.rows.items.map((item) => ({
          sourceId: 'fed.rss',
          feed: item.feed,
          providerGuid: item.providerGuid,
          kind: item.kind,
          headline: item.headline,
          summary: item.summary,
          url: item.url,
          author: item.author,
          category: item.category,
          cik: item.cik,
          items8k: null,
          lang: item.lang,
          publishedAt: item.publishedAt,
          isCorrection: item.isCorrection,
        }));
        const batch = await store(ctx, result, {
          sourceId: 'fed.rss',
          provenanceId,
          raw,
          inputs,
        });

        // §11.2: the Fed feed states its own topic in `<category>`. That is a structural claim by
        // the publisher, not a guess about the text, so it is carried through as a `feed_topic`
        // link at 1.0 rather than re-derived from prose.
        const topicIds = await loadTopicIds(ctx.tx);
        const byGuid = new Map(batch.items.map((i) => [i.providerGuid, i.newsId]));
        for (const link of norm.rows.topicLinks) {
          const newsId = byGuid.get(link.providerGuid);
          const topicId = topicIds.get(link.code.toUpperCase());
          if (newsId === undefined || topicId === undefined) continue;
          const list = batch.extraLinks.get(newsId) ?? [];
          list.push({
            entityKind: 'topic',
            entityId: topicId,
            confidence: link.confidence,
            method: link.method,
            display: link.code,
          });
          batch.extraLinks.set(newsId, list);
        }
        batches.push(batch);
      } else if (raw !== null) {
        result.skipped += 1;
      }
    }

    if (batches.length === 0) return result;

    // ── 4 · one dictionary, one linking pass ─────────────────────────────────────────────────
    const now = new Date(ctx.clock.now());
    const dict = await buildNewsDict(ctx.tx, { validAt: now, knownAt: now });
    const topicIds = await loadTopicIds(ctx.tx);

    const linkable = batches.flatMap((b) =>
      b.items.map((item) => ({
        newsId: item.newsId,
        headline: item.headline,
        summary: item.summary,
        cik: item.cik,
        items8k: item.items8k,
        feed: item.feed,
        sourceId: item.sourceId,
      })),
    );
    const extraLinks = new Map<number, readonly LinkCandidate[]>();
    for (const b of batches) for (const [id, links] of b.extraLinks) extraLinks.set(id, links);

    const links = await linkNewsItems(ctx.tx, linkable, dict, { topicIds, extraLinks });
    result.linked = links.written;
    result.unlinked = links.unlinked;
    result.stories = linkable.length;

    // ── 5 · fan-out ──────────────────────────────────────────────────────────────────────────
    const topicCodeById = new Map<number, string>();
    for (const [code, id] of topicIds) topicCodeById.set(id, code);

    for (const batch of batches) {
      result.published += publishNews(ctx.plant, batch.items, links.byNewsId, {
        capturedAt: batch.capturedAt,
        provenanceId: batch.provenanceId,
        topicCodeById,
      });
    }

    // ── 6 · NEWS-07 ──────────────────────────────────────────────────────────────────────────
    //
    // Only stories this run actually stored or changed are offered: a re-poll that found the same
    // forty headlines must not re-notify, and `inserted`/`changed` is the same test the plant
    // fan-out above uses for the same reason. The `NewsItem` is assembled from what the run
    // already holds rather than read back, so the engine sees exactly the row that was written.
    const alerts = ctx.alerts;
    if (alerts !== undefined) {
      for (const batch of batches) {
        for (const item of batch.items) {
          if (!item.inserted && !item.changed) continue;
          try {
            await alerts.onNews({
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
              capturedAt: new Date(batch.capturedAt).toISOString(),
              isCorrection: item.isCorrection,
              machineGenerated: item.machineGenerated,
              provenanceId: batch.provenanceId,
              sourceTs: null,
              links: (links.byNewsId.get(item.newsId) ?? []).map((l) => ({
                entityKind: l.entityKind,
                entityId: l.entityId,
                confidence: l.confidence,
                method: l.method,
                display: l.display,
              })),
            });
          } catch (err) {
            ctx.log?.warn?.('newsRss.alerts', {
              newsId: item.newsId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    ctx.log?.info?.('newsRss.done', {
      stories: result.stories,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.skipped,
      linked: result.linked,
      published: result.published,
    });
    return result;
  });
  return result;
}

/** Fetch, turning a replay miss into a skip and any other failure into a recorded `JobError`. */
async function tryFetch(
  ctx: NewsJobContext,
  result: NewsRssResult,
  fetch: () => Promise<RawRecord>,
): Promise<RawRecord | null> {
  try {
    return await fetch();
  } catch (err) {
    if (isReplayMiss(err)) {
      result.skipped += 1;
      ctx.log?.info?.('newsRss.feed_unavailable', { error: String(err) });
      return null;
    }
    result.errors.push(fetchError(err, 'news'));
    return null;
  }
}

/** Upsert one capture's stories and fold its counts into the run's. */
async function store(
  ctx: NewsJobContext,
  result: NewsRssResult,
  args: {
    sourceId: NewsSourceId;
    provenanceId: number;
    raw: RawRecord;
    inputs: readonly NewsItemInput[];
  },
): Promise<Batch> {
  const upserted = await upsertNewsItems(ctx.tx, args.inputs, {
    provenanceId: args.provenanceId,
    capturedAt: args.raw.capturedAt,
  });
  result.inserted += upserted.inserted;
  result.updated += upserted.updated;
  result.skipped += upserted.unchanged;
  for (const problem of upserted.problems) {
    ctx.log?.warn?.('newsRss.row_rejected', { ...problem });
  }
  return {
    sourceId: args.sourceId,
    provenanceId: args.provenanceId,
    capturedAt: args.raw.capturedAt,
    items: upserted.items,
    extraLinks: new Map<number, LinkCandidate[]>(),
  };
}

/** The scheduler row (PROVIDERS §13); `IngestJob.id` is this module's basename. */
export const job = {
  id: 'newsRss',
  schedule: NEWS_RSS_SCHEDULE,
  provider: NEWS_PROVIDERS,
  priority: 1 as const,
  timeoutMs: 30_000,
  run: (ctx: NewsJobContext): Promise<NewsRssResult> => runNewsRss(ctx),
};
