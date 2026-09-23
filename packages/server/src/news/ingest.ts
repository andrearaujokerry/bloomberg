/**
 * `news/ingest.ts` — RSS and Atom into `news_items` (NEWS-01, NEWS-08; WORKPLAN §WP-09 L1165-1167,
 * PROVIDERS.b §11.1-§11.2).
 *
 * The three adapters of WP-05 already turn bytes into rows: `providers/bbgRss/parse.ts`,
 * `providers/fedRss/parse.ts` and `providers/sec/parse.ts#normaliseAtom` each hand back a list of
 * `news_items`-shaped objects. This module is the half they deliberately stop short of — the
 * **persistence and fan-out** half:
 *
 *  1. {@link toNewsItemInput} normalises whatever an adapter produced into the one shape the table
 *     accepts, re-applying the two rules that must hold for every source rather than per adapter:
 *     HTML is stripped out of the summary, and the correction marker is detected wherever the
 *     publisher put it.
 *  2. {@link upsertNewsItems} writes them keyed on `(source_id, provider_guid)` — the unique
 *     constraint the table declares — and reports, per row, whether it **inserted**, **changed** or
 *     **left alone** an existing story. That distinction is the whole reason the parsers do not
 *     emit plant updates themselves: a 60-second poll re-delivers the same twenty items every tick,
 *     and fanning them out again would put twenty duplicate headlines on `n:all` every minute.
 *  3. {@link publishNews} fans exactly the inserted-or-changed rows onto the `n:` subjects —
 *     `n:all`, `n:feed:<feed>`, and one `n:topic:<code>` / `n:inst:<id>` per link the linker wrote.
 *     News is **queued, not conflated** (NEWS-01): `Plant.publish` keeps every publication to an
 *     `n:` subject, so a later headline never overwrites an earlier one.
 *
 * ## Corrections
 *
 * `is_correction` is not decoration: a corrected story is rendered in place of the original and
 * badged, so a missed marker leaves a wrong headline on the screen. WP-05 found that the spec's
 * "description starts with 'Correct:'" does not describe the real bytes — Bloomberg puts the marker
 * at the **end** of the body:
 *
 * ```
 *   … discusses artificial intelligence bear cases amid concerns over AI safety.
 *   Correct:   George Noble said AI will be the 'biggest misallocation in history.'
 *   Fixes headline (Source: Bloomberg)
 * ```
 *
 * so {@link CORRECTION_RE} anchors the marker to a **sentence boundary** instead of to offset zero,
 * and {@link detectCorrection} runs it over the headline and the summary. That single regex, shared
 * with the Bloomberg parser rather than re-derived here, is what makes the recorded correction
 * detectable from either end.
 *
 * ## NEWS-08
 *
 * `machine_generated` is `false` on every row this module writes, and there is no code path that
 * sets it true. The column exists so the render rule ("machine-generated content is shown in a
 * separate, labelled block") is *enforceable* the day a generated source is added — v1 has none,
 * and the screens assert it.
 */

import { sql } from 'drizzle-orm';

import { CORRECTION_RE } from '../providers/bbgRss/parse.js';
import { stripTags } from '../providers/html.js';
import { formatSubject } from '../plant/subjects.js';

import type { FieldId, FieldValue, Timestamps3 } from '@terminal/core';
import type { Tx } from '../db/client.js';
import type { LinkCandidate } from './entityLink.js';

export { CORRECTION_RE };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type NewsSourceId = 'bbg.rss' | 'sec.atom' | 'fed.rss';
export type NewsKind = 'story' | 'video' | 'filing' | 'press_release' | 'fed_release';

/** The three sources `news_items.source_id` may name (CONTRACTS §1.2 L227). */
export const NEWS_SOURCE_IDS: readonly NewsSourceId[] = Object.freeze([
  'bbg.rss',
  'sec.atom',
  'fed.rss',
]);

/** One `news_items` row as this module accepts it, before defaults and cleaning. */
export interface NewsItemInput {
  sourceId: NewsSourceId;
  feed: string;
  providerGuid: string;
  kind: NewsKind;
  headline: string;
  summary: string | null;
  url: string | null;
  author?: string | null;
  category?: string | null;
  cik?: string | null;
  items8k?: readonly string[] | null;
  lang?: string | null;
  /** ISO-8601 instant (FEED-05 `src`). */
  publishedAt: string;
  /** The publisher's own marker, when the adapter already found one. Re-checked here either way. */
  isCorrection?: boolean;
}

/** The cleaned row, exactly as it is written. */
export interface NewsItemRow {
  sourceId: NewsSourceId;
  feed: string;
  providerGuid: string;
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
  isCorrection: boolean;
  /** NEWS-08: always false in v1. */
  machineGenerated: false;
}

/** What became of one input row. */
export interface UpsertedNewsItem extends NewsItemRow {
  newsId: number;
  /** The row did not exist before this run. */
  inserted: boolean;
  /** The row existed and the publisher changed something worth re-publishing. */
  changed: boolean;
}

export interface NewsIngestProblem {
  providerGuid: string;
  sourceId: string;
  reason: string;
}

export interface NewsIngestResult {
  inserted: number;
  updated: number;
  /** Rows already stored, unchanged — the ordinary outcome of a 60-second re-poll. */
  unchanged: number;
  /** Rows the table could not accept, with why. Never silently dropped. */
  problems: NewsIngestProblem[];
  items: UpsertedNewsItem[];
}

export interface UpsertNewsOptions {
  /** The `provenance` row this capture wrote. Required: `news_items.provenance_id` is NOT NULL. */
  provenanceId: number;
  /** Our receipt of the bytes (FEED-05 `cap`), epoch ms or a Date. */
  capturedAt: number | Date;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Cleaning
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The summary as it is stored: tags removed, entities decoded, whitespace collapsed, empty → NULL.
 *
 * Run over every source, not only the ones known to carry markup. The SEC atom wraps its summary in
 * escaped `<b>`/`<br>`, the Fed feed wraps its own in CDATA that sometimes carries an anchor, and a
 * Bloomberg description occasionally carries a `<p>`. One rule for all three means the `tsv` column
 * indexes prose rather than tag soup, and the `N` reader never has to decide whether to trust its
 * input.
 */
export function cleanSummary(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = stripTags(raw).trim();
  return text === '' ? null : text;
}

/**
 * `true` when the publisher marked this story as a correction, from either end of the text.
 *
 * {@link CORRECTION_RE} is the Bloomberg parser's, shared rather than copied: "the same marker"
 * has to mean one thing across the three sources or the `[CORRECTION]` badge becomes a per-feed
 * accident.
 */
export function detectCorrection(headline: string, summary: string | null): boolean {
  CORRECTION_RE.lastIndex = 0;
  if (CORRECTION_RE.test(headline)) return true;
  if (summary === null) return false;
  CORRECTION_RE.lastIndex = 0;
  return CORRECTION_RE.test(summary);
}

/** The two-letter language tag, or `'en'`. The column is `char(2)`. */
function lang(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return 'en';
  const code = raw.trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : 'en';
}

/** Normalise an adapter's row into the one shape the table accepts. */
export function toNewsItemInput(input: NewsItemInput): NewsItemRow | NewsIngestProblem {
  const headline = input.headline.trim();
  const url = input.url === null ? '' : input.url.trim();
  const guid = input.providerGuid.trim();

  if (guid === '') {
    return { providerGuid: input.providerGuid, sourceId: input.sourceId, reason: 'empty guid' };
  }
  if (headline === '') {
    return { providerGuid: guid, sourceId: input.sourceId, reason: 'empty headline' };
  }
  // `news_items.url` is NOT NULL and the terminal stores no bodies: without a link there is nothing
  // for `Enter` to open, and a headline nobody can read in full is not worth a row.
  if (url === '') {
    return { providerGuid: guid, sourceId: input.sourceId, reason: 'no url' };
  }
  const publishedAt = new Date(input.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) {
    return {
      providerGuid: guid,
      sourceId: input.sourceId,
      reason: `unparseable published_at '${input.publishedAt}'`,
    };
  }

  const summary = cleanSummary(input.summary);
  const items8k = input.items8k === null || input.items8k === undefined ? null : [...input.items8k];

  return {
    sourceId: input.sourceId,
    feed: input.feed,
    providerGuid: guid,
    kind: input.kind,
    headline,
    summary,
    url,
    author: input.author ?? null,
    category: input.category ?? null,
    cik: input.cik ?? null,
    items8k: items8k !== null && items8k.length === 0 ? null : items8k,
    lang: lang(input.lang),
    publishedAt: publishedAt.toISOString(),
    isCorrection: (input.isCorrection ?? false) || detectCorrection(headline, summary),
    machineGenerated: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Upsert
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The columns a re-poll may legitimately change, and the only ones whose change re-publishes the
 * story. `captured_at` and `provenance_id` move on every poll by construction and are excluded on
 * purpose: "we asked again" is not news.
 */
const MUTABLE_COLUMNS = [
  'feed',
  'kind',
  'headline',
  'summary',
  'url',
  'author',
  'category',
  'cik',
  'items_8k',
  'lang',
  'published_at',
  'is_correction',
] as const;

interface UpsertRow extends Record<string, unknown> {
  news_id: string;
  provider_guid: string;
  source_id: string;
  inserted: boolean;
}

/**
 * Write a batch of stories, keyed on `(source_id, provider_guid)`.
 *
 * Idempotent by construction: the second run over the same capture matches every row on the unique
 * key, finds nothing in {@link MUTABLE_COLUMNS} different, and the guarded `DO UPDATE` writes
 * nothing — so `news_items` does not grow and no `n:` subject is re-published. (`provenance` does
 * grow, and should: "where did this headline come from" and "how often did we ask" are different
 * questions, PROVIDERS.a §1.3.)
 *
 * `xmax = 0` on the returned row is Postgres' own answer to "was this an INSERT or an UPDATE": the
 * tuple's `xmax` is zero exactly when no prior version was locked by this statement. Counting
 * inserts any other way — a pre-SELECT, or trusting the adapter — races with a concurrent poll.
 */
export async function upsertNewsItems(
  tx: Tx,
  inputs: readonly NewsItemInput[],
  options: UpsertNewsOptions,
): Promise<NewsIngestResult> {
  const result: NewsIngestResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    problems: [],
    items: [],
  };

  const rows: NewsItemRow[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const cleaned = toNewsItemInput(input);
    if ('reason' in cleaned) {
      result.problems.push(cleaned);
      continue;
    }
    // One story, one row, one `news_id` (§11.1): all six Bloomberg feeds share `source_id`, and a
    // story carried by two of them must not be offered to `ON CONFLICT` twice in one statement.
    const key = `${cleaned.sourceId}|${cleaned.providerGuid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(cleaned);
  }
  if (rows.length === 0) return result;

  const capturedAt = new Date(
    typeof options.capturedAt === 'number' ? options.capturedAt : options.capturedAt.getTime(),
  );

  const values = sql.join(
    rows.map(
      (r) => sql`(${r.sourceId}::text, ${r.feed}::text, ${r.providerGuid}::text, ${r.kind}::text,
                  ${r.headline}::text, ${r.summary}::text, ${r.url}::text, ${r.author}::text,
                  ${r.category}::text, ${r.cik}::char(10), ${sql.param(r.items8k)}::text[],
                  ${r.lang}::char(2),
                  ${r.publishedAt}::timestamptz, ${capturedAt.toISOString()}::timestamptz,
                  ${r.isCorrection}::boolean, false::boolean, ${options.provenanceId}::bigint)`,
    ),
    sql`, `,
  );

  const distinct = sql.join(
    MUTABLE_COLUMNS.map(
      (c) => sql`news_items.${sql.raw(c)} IS DISTINCT FROM EXCLUDED.${sql.raw(c)}`,
    ),
    sql` OR `,
  );

  const res = await tx.execute<UpsertRow>(sql`
    INSERT INTO news_items (source_id, feed, provider_guid, kind, headline, summary, url, author,
                            category, cik, items_8k, lang, published_at, captured_at, is_correction,
                            machine_generated, provenance_id)
    SELECT * FROM (VALUES ${values}) AS v(source_id, feed, provider_guid, kind, headline, summary,
                                          url, author, category, cik, items_8k, lang, published_at,
                                          captured_at, is_correction, machine_generated,
                                          provenance_id)
        ON CONFLICT (source_id, provider_guid) DO UPDATE
       SET feed = EXCLUDED.feed, kind = EXCLUDED.kind, headline = EXCLUDED.headline,
           summary = EXCLUDED.summary, url = EXCLUDED.url, author = EXCLUDED.author,
           category = EXCLUDED.category, cik = EXCLUDED.cik, items_8k = EXCLUDED.items_8k,
           lang = EXCLUDED.lang, published_at = EXCLUDED.published_at,
           is_correction = EXCLUDED.is_correction, captured_at = EXCLUDED.captured_at,
           provenance_id = EXCLUDED.provenance_id
     WHERE ${distinct}
     RETURNING news_id::text AS news_id, provider_guid, source_id, (xmax = 0) AS inserted`);

  const touched = new Map<string, UpsertRow>();
  for (const row of res.rows) touched.set(`${row.source_id}|${row.provider_guid}`, row);

  // Rows the guarded DO UPDATE declined to touch still need their `news_id` for the fan-out and for
  // the linker, so they are read back by key.
  const missing = rows.filter((r) => !touched.has(`${r.sourceId}|${r.providerGuid}`));
  const existing = new Map<string, number>();
  if (missing.length > 0) {
    const keys = sql.join(
      missing.map((r) => sql`(${r.sourceId}::text, ${r.providerGuid}::text)`),
      sql`, `,
    );
    const back = await tx.execute<{
      news_id: string;
      source_id: string;
      provider_guid: string;
    }>(sql`
      SELECT news_id::text AS news_id, source_id, provider_guid
        FROM news_items
       WHERE (source_id, provider_guid) IN (${keys})`);
    for (const row of back.rows) {
      existing.set(`${row.source_id}|${row.provider_guid}`, Number(row.news_id));
    }
  }

  for (const row of rows) {
    const key = `${row.sourceId}|${row.providerGuid}`;
    const hit = touched.get(key);
    if (hit !== undefined) {
      if (hit.inserted) result.inserted += 1;
      else result.updated += 1;
      result.items.push({
        ...row,
        newsId: Number(hit.news_id),
        inserted: hit.inserted,
        changed: !hit.inserted,
      });
      continue;
    }
    const newsId = existing.get(key);
    if (newsId === undefined) {
      result.problems.push({
        providerGuid: row.providerGuid,
        sourceId: row.sourceId,
        reason: 'row neither written nor found after upsert',
      });
      continue;
    }
    result.unchanged += 1;
    result.items.push({ ...row, newsId, inserted: false, changed: false });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fan-out (NEWS-01)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The narrow slice of WP-06's `Plant` this module publishes through. */
export interface NewsPlant {
  publish(
    subject: string,
    fields: Record<FieldId, FieldValue>,
    meta: { ts: Timestamps3; prov?: { sourceId: string; provenanceId: number }; queued?: boolean },
  ): void;
}

/** `ctx.plant` is `unknown` to the ingest jobs; narrow it rather than cast it. */
export function newsPlantSink(plant: unknown): NewsPlant | null {
  if (plant === null || typeof plant !== 'object') return null;
  const publish = (plant as { publish?: unknown }).publish;
  return typeof publish === 'function' ? (plant as NewsPlant) : null;
}

/**
 * Every `n:` subject one story belongs on: the firehose, its feed, and one subject per link.
 *
 * A story with no link reaches `n:all` and `n:feed:<feed>` and nothing else — which is the correct
 * outcome of a precision-first linker, not a gap: the desk finds it through `TOP` and `N`, and no
 * issuer's screen claims a story that is not about it.
 */
export function newsSubjects(
  item: { feed: string },
  links: readonly LinkCandidate[],
  topicCodeById?: ReadonlyMap<number, string>,
): string[] {
  const subjects = [
    'n:all',
    formatSubject({ family: 'n', scope: { kind: 'feed', name: item.feed } }),
  ];
  for (const link of links) {
    if (link.entityKind === 'instrument') {
      subjects.push(
        formatSubject({ family: 'n', scope: { kind: 'inst', instrumentId: link.entityId } }),
      );
      continue;
    }
    if (link.entityKind === 'topic') {
      const code = topicCodeById?.get(link.entityId);
      if (code !== undefined) {
        subjects.push(formatSubject({ family: 'n', scope: { kind: 'topic', code } }));
      }
    }
  }
  return [...new Set(subjects)];
}

/** The seven `field_class:'news'` fields an `n:` subject carries (API.md §6.1, TIER1 §TOP). */
export function newsFieldsOf(item: UpsertedNewsItem): Record<FieldId, FieldValue> {
  return {
    NEWS_ID: `${item.sourceId}:${item.providerGuid}`,
    HEADLINE: item.headline,
    PUBLISHED_AT: item.publishedAt,
    SOURCE_ID: item.sourceId,
    LINK: item.url,
    KIND: item.kind,
    IS_CORRECTION: item.isCorrection,
  };
}

export interface PublishNewsOptions {
  capturedAt: number;
  publishedAtMs?: (item: UpsertedNewsItem) => number;
  provenanceId: number;
  topicCodeById?: ReadonlyMap<number, string>;
}

/**
 * Publish the inserted-and-changed stories onto their `n:` subjects, oldest first.
 *
 * Oldest first because `n:` is queued rather than conflated (NEWS-01, API.md §6.1): the client
 * receives one `delta` per headline in publication order, and a subscriber that joins mid-stream
 * replays the queue in the same order. A later headline never overwrites an earlier one, so the
 * order this loop publishes in is the order the screen shows.
 *
 * A story that was merely re-delivered by the feed is **not** published: that is the entire reason
 * {@link upsertNewsItems} reports `inserted`/`changed` per row.
 */
export function publishNews(
  plant: unknown,
  items: readonly UpsertedNewsItem[],
  linksByNewsId: ReadonlyMap<number, readonly LinkCandidate[]>,
  options: PublishNewsOptions,
): number {
  const sink = newsPlantSink(plant);
  if (sink === null) return 0;

  const fresh = items
    .filter((i) => i.inserted || i.changed)
    .sort((a, b) =>
      a.publishedAt === b.publishedAt
        ? a.providerGuid < b.providerGuid
          ? -1
          : a.providerGuid > b.providerGuid
            ? 1
            : 0
        : a.publishedAt < b.publishedAt
          ? -1
          : 1,
    );

  let published = 0;
  for (const item of fresh) {
    const fields = newsFieldsOf(item);
    const src = options.publishedAtMs?.(item) ?? Date.parse(item.publishedAt);
    const ts: Timestamps3 = {
      src: Number.isNaN(src) ? null : src,
      cap: options.capturedAt,
      pub: options.capturedAt,
    };
    const links = linksByNewsId.get(item.newsId) ?? [];
    for (const subject of newsSubjects(item, links, options.topicCodeById)) {
      sink.publish(subject, fields, {
        ts,
        prov: { sourceId: item.sourceId, provenanceId: options.provenanceId },
        queued: true,
      });
      published += 1;
    }
  }
  return published;
}
