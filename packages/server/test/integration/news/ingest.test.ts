/**
 * `news/ingest.ts` and `ingest/jobs/newsRss.ts` end to end, driven from the recorded captures
 * (WORKPLAN §WP-09 acceptance row: "dedupe on `(source_id, provider_guid)`, correction detection,
 * `tsv` search returns the expected story").
 *
 * Three properties, each measured the way it would fail in production rather than the way the code
 * reports itself:
 *
 *  1. **dedupe** is proved by a `SELECT count(*)` taken before and after a *second* execution over
 *     the same bytes, not by trusting the job's own `inserted: 0`. A job that reported zero while
 *     quietly doubling `news_items` would pass a boolean assertion and fail this one. The count is
 *     scoped to the `provenance` rows these two runs wrote, because `bloomberg_test` is shared and
 *     an unscoped `count(*)` over `news_items` asserts on other people's rows — a test that passes
 *     on an empty database and fails on a real one is worse than no test.
 *  2. **correction detection** is asserted on the real corrected item WP-05 identified in
 *     `bbg-rss-markets`: guid `TLEUW0KGZAKZ00`, whose marker sits at the **end** of the body
 *     (`… amid concerns over AI safety. Correct: George Noble said … Fixes headline`). A
 *     start-anchored rule — which is what the design document literally says — marks it `false`,
 *     leaves the superseded headline on the screen unbadged, and passes any test that only checks
 *     that *some* row is a correction. So the guid is named.
 *  3. **`tsv`** is queried through `websearch_to_tsquery` exactly as `data/news.ts#search` does, and
 *     must return that same story. The column is `GENERATED … STORED`, so this also proves the
 *     summary reaching it is prose: if HTML survived the ingest, the SEC rows would index `b`,
 *     `br` and `AccNo` as words.
 *
 * Everything runs inside one rolled-back transaction with no `HttpClient` wired, so the job reads
 * the replay store and a capture it does not hold throws rather than opening a socket. WP-15 owns
 * the seed and it does not exist: this file creates what it needs and depends on no literal id.
 */

import { describe, expect, it } from 'vitest';

import { runNewsRss } from '../../../src/ingest/jobs/newsRss.js';
import { detectCorrection, cleanSummary } from '../../../src/news/ingest.js';
import { clickThroughByNewsId, prependLive, rankStories } from '../../../src/news/ranker.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import { frozenClock, TEST_NOW } from '../../../src/test/clock.js';
import { withTxDb } from '../../../src/test/db.js';

import type { NewsJobContext } from '../../../src/ingest/jobs/newsRss.js';
import type { TestDb } from '../../../src/test/db.js';

const store = openReplayStore();
const clock = frozenClock(TEST_NOW);

/** The corrected Bloomberg item of `bbg-rss-markets`, by its guid (WP-05, PROVIDERS.b §11.1). */
const CORRECTED_GUID = 'TLEUW0KGZAKZ00';
const CORRECTED_HEADLINE = "AI Will Be Biggest 'Misallocation' of Capital, Says Noble";

function context(t: TestDb): NewsJobContext {
  return { tx: t.db, clock, replay: store, log: {} };
}

/** Rows written by *these* runs, named by the provenance ids they reported. */
function byProvenance(ids: readonly number[]): string {
  return ids.length === 0 ? 'FALSE' : `provenance_id IN (${ids.map(String).join(', ')})`;
}

async function count(t: TestDb, table: string, where: string): Promise<number> {
  const res = await t.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
  );
  return Number(res.rows[0]!.n);
}

describe('newsRss stores every recorded headline once', () => {
  const t = withTxDb();

  it('dedupes on (source_id, provider_guid): a second run over the same captures adds no row', async () => {
    const first = await runNewsRss(context(t));
    expect(first.errors).toEqual([]);
    expect(first.inserted).toBeGreaterThan(100);

    const afterFirst = await count(t, 'news_items', byProvenance(first.provenanceIds));
    expect(afterFirst).toBe(first.inserted);

    const second = await runNewsRss(context(t));
    expect(second.errors).toEqual([]);
    // Nothing new: every story matched an existing row on the unique key and nothing the publisher
    // sent had changed, so the guarded DO UPDATE wrote nothing at all.
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);

    const all = [...first.provenanceIds, ...second.provenanceIds];
    expect(await count(t, 'news_items', byProvenance(all))).toBe(afterFirst);

    // `provenance` does grow, one row per exchange: "where did this headline come from" and "how
    // often did we ask" are different questions (PROVIDERS.a §1.3).
    expect(second.provenanceIds.length).toBe(first.provenanceIds.length);
    expect(new Set(all).size).toBe(all.length);
  });

  it('stores all three sources, strips HTML from the summary and never marks a row machine-generated', async () => {
    const run = await runNewsRss(context(t));
    expect(run.errors).toEqual([]);
    const mine = byProvenance(run.provenanceIds);

    const sources = await t.client.query<{ source_id: string; n: string }>(
      `SELECT source_id, count(*)::text AS n FROM news_items WHERE ${mine} GROUP BY 1 ORDER BY 1`,
    );
    expect(sources.rows.map((r) => r.source_id)).toEqual(['bbg.rss', 'fed.rss', 'sec.atom']);
    for (const row of sources.rows) expect(Number(row.n)).toBeGreaterThan(0);

    // The SEC atom's summary arrives as escaped HTML inside the XML: `<b>Filed:</b> 2026-09-15
    // <b>AccNo:</b> …`. What is stored is prose, or the `tsv` index below indexes tag names.
    const tagged = await count(
      t,
      'news_items',
      `${mine} AND (summary LIKE '%<%' OR summary LIKE '%&lt;%' OR headline LIKE '%<%')`,
    );
    expect(tagged).toBe(0);

    const secSummary = await t.client.query<{ summary: string | null; headline: string }>(
      `SELECT summary, headline FROM news_items
        WHERE source_id = 'sec.atom' AND provider_guid = $1`,
      ['urn:tag:sec.gov,2008:accession-number=0001213900-26-100070'],
    );
    expect(secSummary.rows[0]?.summary).toBe(
      'Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain ' +
        'Officers: Compensatory Arrangements of Certain Officers',
    );
    expect(secSummary.rows[0]?.headline).toContain('Aerkomm');

    // NEWS-08: the column exists so the render rule is enforceable; v1 never writes true.
    expect(await count(t, 'news_items', `${mine} AND machine_generated`)).toBe(0);
    expect(await count(t, 'news_items', `${mine} AND NOT machine_generated`)).toBe(
      await count(t, 'news_items', mine),
    );
  });
});

describe('correction detection finds the marker wherever the publisher put it', () => {
  const t = withTxDb();

  it('flags the recorded corrected story, whose marker is at the end of the body', async () => {
    const run = await runNewsRss(context(t));
    expect(run.errors).toEqual([]);

    const row = await t.client.query<{
      headline: string;
      is_correction: boolean;
      summary: string;
      kind: string;
    }>(
      `SELECT headline, is_correction, summary, kind
         FROM news_items
        WHERE source_id = 'bbg.rss' AND provider_guid = $1`,
      [CORRECTED_GUID],
    );
    const item = row.rows[0];
    expect(item).toBeDefined();
    expect(item!.headline).toBe(CORRECTED_HEADLINE);
    expect(item!.is_correction).toBe(true);
    expect(item!.kind).toBe('video');
    // The evidence: the marker is not at offset zero, which is what the design document says.
    expect(item!.summary.startsWith('Correct:')).toBe(false);
    expect(item!.summary).toContain('Correct:');
    expect(item!.summary).toContain('Fixes headline');

    // It is not the case that everything is a correction.
    const corrections = await count(
      t,
      'news_items',
      `${byProvenance(run.provenanceIds)} AND is_correction`,
    );
    const total = await count(t, 'news_items', byProvenance(run.provenanceIds));
    expect(corrections).toBeGreaterThanOrEqual(1);
    expect(corrections).toBeLessThan(total);
  });

  it('detects the marker at either end and nowhere else', () => {
    expect(detectCorrection('Correct: Apple raises guidance', null)).toBe(true);
    expect(detectCorrection('Apple raises guidance', 'Body text. Fixes headline (Source: X)')).toBe(
      true,
    );
    expect(
      detectCorrection('Apple raises guidance', 'Body text.\nCorrection: the figure was 3%'),
    ).toBe(true);
    // Not a correction: the word appears mid-sentence, not at a sentence boundary.
    expect(detectCorrection('Regulators move to correct market structure', null)).toBe(false);
    expect(
      detectCorrection('Apple raises guidance', 'Analysts expect a correction in equities'),
    ).toBe(false);
  });

  it('strips markup out of a summary without eating the text', () => {
    expect(cleanSummary('<b>Filed:</b> 2026-09-15<br>Item 5.02: Departure')).toBe(
      'Filed: 2026-09-15 Item 5.02: Departure',
    );
    expect(cleanSummary('   ')).toBeNull();
    expect(cleanSummary(null)).toBeNull();
  });
});

describe('the generated tsv column answers a full-text query', () => {
  const t = withTxDb();

  it('returns the expected story for a websearch_to_tsquery, the way data/news.ts searches', async () => {
    const run = await runNewsRss(context(t));
    expect(run.errors).toEqual([]);
    const mine = byProvenance(run.provenanceIds);

    const hit = await t.client.query<{ headline: string; provider_guid: string }>(
      `SELECT headline, provider_guid
         FROM news_items
        WHERE ${mine}
          AND tsv @@ websearch_to_tsquery('english', $1)
        ORDER BY published_at DESC`,
      ['misallocation capital'],
    );
    expect(hit.rows.map((r) => r.provider_guid)).toContain(CORRECTED_GUID);
    expect(hit.rows.find((r) => r.provider_guid === CORRECTED_GUID)?.headline).toBe(
      CORRECTED_HEADLINE,
    );

    // The summary is indexed at weight B, so a word that appears only in the body is findable.
    const summaryOnly = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM news_items
        WHERE ${mine} AND tsv @@ websearch_to_tsquery('english', $1)`,
      ['Fidelity'],
    );
    expect(Number(summaryOnly.rows[0]!.n)).toBeGreaterThan(0);

    // A query nobody published matches nothing — the index is a search, not a fallback.
    const miss = await t.client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM news_items
        WHERE ${mine} AND tsv @@ websearch_to_tsquery('english', $1)`,
      ['zzzqqxnothinglikethis'],
    );
    expect(Number(miss.rows[0]!.n)).toBe(0);
  });
});

/**
 * `news/ranker.ts` over the same corpus.
 *
 * The ranker has no acceptance row of its own in WP-09's table, but it is the module that decides
 * what the desk reads first, and shipping it with no execution over real rows would leave its two
 * failure modes — a part that is not monotone, and a tiebreak that is not a total order — to be
 * found on a screen. Both are asserted here against the stories the run actually stored.
 */
describe('the TOP ranker orders the stored corpus', () => {
  const t = withTxDb();

  it('is monotone in each part, breaks ties totally, and reports no click-through without history', async () => {
    const run = await runNewsRss(context(t));
    expect(run.errors).toEqual([]);
    const mine = byProvenance(run.provenanceIds);

    const rows = await t.client.query<{
      news_id: string;
      source_id: string;
      feed: string;
      published_at: Date;
      confidence: number | null;
    }>(
      `SELECT n.news_id::text AS news_id, n.source_id, n.feed, n.published_at,
              (SELECT max(l.confidence) FROM news_entity_links l WHERE l.news_id = n.news_id) AS confidence
         FROM news_items n
        WHERE ${mine}`,
    );
    const stories = rows.rows.map((r) => ({
      newsId: Number(r.news_id),
      sourceId: r.source_id,
      feed: r.feed,
      publishedAt: r.published_at.toISOString(),
      links: r.confidence === null ? [] : [{ confidence: r.confidence }],
    }));
    expect(stories.length).toBeGreaterThan(100);

    // No usage history exists in this transaction, so the click-through map is empty — which is how
    // the TOP resolver knows to say NO_CLICKTHROUGH_HISTORY instead of publishing a measured zero.
    const ct = await clickThroughByNewsId(t.db, { asOfMs: TEST_NOW });
    expect(ct.size).toBe(0);

    const ranked = rankStories(stories, { asOfMs: TEST_NOW });
    expect(ranked.length).toBe(stories.length);
    for (let i = 1; i < ranked.length; i += 1) {
      const prev = ranked[i - 1]!;
      const cur = ranked[i]!;
      expect(prev.rank).toBeGreaterThanOrEqual(cur.rank);
      if (prev.rank === cur.rank) {
        // Total order: equal ranks fall back to publishedAt desc, then newsId desc.
        const older = prev.row.publishedAt > cur.row.publishedAt;
        const same = prev.row.publishedAt === cur.row.publishedAt;
        expect(older || (same && prev.row.newsId > cur.row.newsId)).toBe(true);
      }
      expect(cur.rankParts.clickThrough).toBe(0);
      expect(cur.rankParts.linkConfidence).toBeGreaterThan(0);
    }

    // Monotone in recency with the other parts held fixed: the same story published later ranks
    // above itself published earlier.
    const sample = ranked[0]!.row;
    const older = { ...sample, newsId: sample.newsId, publishedAt: '2026-09-10T00:00:00.000Z' };
    const newer = { ...sample, newsId: sample.newsId, publishedAt: '2026-09-15T18:00:00.000Z' };
    const pair = rankStories([older, newer], { asOfMs: TEST_NOW });
    expect(pair[0]!.row.publishedAt).toBe(newer.publishedAt);
    expect(pair[0]!.rank).toBeGreaterThan(pair[1]!.rank);

    // A live headline is prepended above the leader and the list stays at its limit (NEWS-01).
    const head = ranked.slice(0, 30);
    const incoming = { ...sample, newsId: -1, publishedAt: '2026-09-15T18:41:00.000Z' };
    const withLive = prependLive(head, incoming, { limit: 30, asOfMs: TEST_NOW });
    expect(withLive.length).toBe(30);
    expect(withLive[0]!.row.newsId).toBe(-1);
    expect(withLive[0]!.rank).toBeGreaterThan(head[0]!.rank);
    // A second publication of the same story replaces it rather than duplicating it.
    const again = prependLive(withLive, incoming, { limit: 30, asOfMs: TEST_NOW });
    expect(again.filter((r) => r.row.newsId === -1).length).toBe(1);
  });
});
