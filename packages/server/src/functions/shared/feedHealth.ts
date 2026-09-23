/**
 * `functions/shared/feedHealth.ts` — what every news resolver needs before it shows a headline
 * (FUNCTIONS_TIER1.md §TOP steps 2-7, §N step 7, §NI step 6; TERM-12, ENTL-05, DATA-10, NEWS-08).
 *
 * §N step 7 names this file ("shared helper `packages/server/src/functions/shared/feedHealth.ts`")
 * for the feed-health block. It holds two more helpers beside it, for one reason: TOP, N and NI
 * each perform the same three steps over the same corpus — report how fresh each feed is, drop the
 * headlines the caller's firm is not licensed to see, and project a stored row into the one
 * `NewsRow` shape every news screen renders. Three copies of that would be three chances for two
 * screens to disagree about the same headline, which is precisely what §0.2 exists to prevent.
 *
 * ## Feed health is a value, not a decoration (TERM-12)
 *
 * A news screen has two failure modes that look identical: the world is quiet, and our capture of
 * the world has stopped. `feedHealth` distinguishes them by reporting, per `(source, feed)`, when
 * we last captured anything and whether that is within the cadence we expect. A feed past three
 * expected intervals is `'stale'`, one we have never captured is `'blank'`, and neither is ever
 * rendered as an empty list with no explanation.
 *
 * The cadence is the **ingest job's** (`ingest/jobs/newsRss.ts#NEWS_RSS_SCHEDULE`, one minute for
 * all three sources), not `licence_registry`'s: §TOP step 2 says to join the registry "for the
 * expected cadence", and the registry carries no cadence column — `rate_limit` is a documentation
 * string about how fast we may poll, which is not the same claim. Taking the number from the job
 * that actually polls is the honest source, and `fed.rss` is given the 5-minute window §TOP's own
 * read-through table assigns it.
 *
 * ## The licence filter is per source (ENTL-05)
 *
 * News is `field_class:'news'` and its sources are licensed separately — `bbg.rss` is display-only
 * with no export and no API, the two public feeds are unrestricted. `ctx.entitle` cannot express
 * this: it resolves a *field* to one source through `field_licence`, and all three news sources
 * back the same handful of subject fields, so asking about `HEADLINE` answers for one of them at
 * best. {@link newsSourceAccess} therefore asks the question the way the evaluator asks it —
 * licence terms for the usage (rule 3), then a firm grant **and** a user grant covering the source
 * and field class (rules 4-5) — over the request's own transaction, and returns a reason code per
 * source so a dropped headline can say why it was dropped.
 */

import { sql } from 'drizzle-orm';

import type { NewsRow, NewsSourceId } from '@terminal/core/functions/shared/news';
import type { ReasonCode, UsageType } from '@terminal/core';

import type { NewsItem } from '../../data/news.js';
import type { ResolveContext } from '../context.js';

/** The three feeds v1 ingests, in the order a health strip lists them. */
export const NEWS_SOURCE_IDS: readonly NewsSourceId[] = Object.freeze([
  'bbg.rss',
  'sec.atom',
  'fed.rss',
]);

/**
 * The feed a source is reported under when nothing has ever been captured from it.
 *
 * A blank line still needs a feed name, because the screen renders one chip per `(source, feed)`
 * and "nothing from the 8-K feed" is a more useful statement than "nothing from sec.atom".
 */
const DEFAULT_FEED: Readonly<Record<NewsSourceId, string>> = Object.freeze({
  'bbg.rss': 'markets',
  'sec.atom': '8-K',
  'fed.rss': 'press_all',
});

/**
 * Expected capture cadence per source, in ms.
 *
 * `newsRss` polls every 60 s (`NEWS_RSS_SCHEDULE.everyMs`). The Fed feed publishes in bursts and
 * §TOP's read-through table gives it a five-minute freshness window, so holding it to the poll
 * interval would mark a healthy feed stale between releases.
 */
const EXPECTED_INTERVAL_MS: Readonly<Record<NewsSourceId, number>> = Object.freeze({
  'bbg.rss': 60_000,
  'sec.atom': 60_000,
  'fed.rss': 300_000,
});

/** ARCHITECTURE §4.2's staleness rule applied to a feed: three missed intervals is stale. */
export const STALE_AFTER_INTERVALS = 3;

/** One line of the health strip (TOP/N/NI share the shape — `TopFeedHealth` in core). */
export interface FeedHealthLine {
  sourceId: NewsSourceId;
  feed: string;
  lastCapturedAt: string | null;
  expectedIntervalMs: number;
  st: 'live' | 'stale' | 'blank';
  provIdx: number;
}

interface CaptureRow extends Record<string, unknown> {
  source_id: string;
  feed: string;
  captured_at: string;
  provenance_id: string;
  source_ts: string | null;
}

/**
 * The latest capture per `(source, feed)`, as-of `ctx.asOf.knownAt`, plus a `'blank'` line for
 * every source nothing has been captured from.
 *
 * Every line that names a capture cites it (`ctx.prov.add`), so `Ctrl+I` on a health chip reaches
 * the request that produced it (DATA-10). A `'blank'` line cites nothing and carries `provIdx: -1`
 * — the documented "no provenance" value — because a citation of a capture that never happened is
 * the one thing an audit trail must not contain.
 */
export async function feedHealth(ctx: ResolveContext): Promise<FeedHealthLine[]> {
  const knownAt = ctx.asOf.knownAt.toISOString();
  const res = await ctx.db.execute<CaptureRow>(sql`
    SELECT DISTINCT ON (n.source_id, n.feed)
           n.source_id,
           n.feed,
           to_char(n.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           n.provenance_id::text AS provenance_id,
           to_char(p.source_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_ts
      FROM news_items n
      JOIN provenance p ON p.provenance_id = n.provenance_id
     WHERE n.captured_at <= ${knownAt}::timestamptz
     ORDER BY n.source_id, n.feed, n.captured_at DESC, n.news_id DESC`);

  const nowMs = ctx.asOf.validAt.getTime();
  const lines: FeedHealthLine[] = [];
  const seenSources = new Set<string>();

  for (const row of res.rows) {
    const sourceId = NEWS_SOURCE_IDS.find((id) => id === row.source_id);
    if (sourceId === undefined) continue; // a source outside the three is not a news feed
    seenSources.add(sourceId);
    const capturedAt = new Date(row.captured_at);
    const expectedIntervalMs = EXPECTED_INTERVAL_MS[sourceId];
    const ageMs = nowMs - capturedAt.getTime();
    const st: FeedHealthLine['st'] =
      ageMs <= STALE_AFTER_INTERVALS * expectedIntervalMs ? 'live' : 'stale';
    lines.push({
      sourceId,
      feed: row.feed,
      lastCapturedAt: row.captured_at,
      expectedIntervalMs,
      st,
      provIdx: ctx.prov.add({
        sourceId,
        provenanceId: Number(row.provenance_id),
        capturedAt,
        sourceTs: row.source_ts === null ? null : new Date(row.source_ts),
        st,
        tier: 'delayed',
      }),
    });
  }

  for (const sourceId of NEWS_SOURCE_IDS) {
    if (seenSources.has(sourceId)) continue;
    lines.push({
      sourceId,
      feed: DEFAULT_FEED[sourceId],
      lastCapturedAt: null,
      expectedIntervalMs: EXPECTED_INTERVAL_MS[sourceId],
      st: 'blank',
      provIdx: -1,
    });
  }

  lines.sort((a, b) =>
    a.sourceId === b.sourceId
      ? a.feed < b.feed
        ? -1
        : a.feed > b.feed
          ? 1
          : 0
      : a.sourceId < b.sourceId
        ? -1
        : 1,
  );
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-source licence (ENTL-05, evaluator rules 3-5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface NewsSourceVerdict {
  allowed: boolean;
  /** `'OK'` when allowed; otherwise what the screen shows beside the suppressed count. */
  reason: ReasonCode;
}

interface LicenceRow extends Record<string, unknown> {
  source_id: string;
  display: boolean;
  export_allowed: boolean;
  api_allowed: boolean;
}

interface GrantRow extends Record<string, unknown> {
  subject_kind: string;
  source_id: string | null;
  usage_display: boolean;
  usage_export: boolean;
  usage_api: boolean;
}

/**
 * May this caller see headlines from each of the three news sources, for this usage?
 *
 * The rules, in the evaluator's own order:
 *
 *  3. the source's current `licence_registry` terms must permit the usage (`display`,
 *     `export_allowed`, `api_allowed`) — `bbg.rss` permits display only, which is why a TOP export
 *     drops its rows and says so;
 *  4-5. a **firm** grant and a **user** grant must both cover the source (`source_id` null = every
 *     source) and the field class (`field_class` null = every class) with that usage flag set.
 *
 * A source with no licence row at all is refused with `FIELD_UNKNOWN`: an unknown source is not an
 * implicit permission.
 */
export async function newsSourceAccess(
  ctx: ResolveContext,
  usage: UsageType = ctx.usage,
): Promise<Map<NewsSourceId, NewsSourceVerdict>> {
  const at = new Date(ctx.clock.now()).toISOString();
  const sources = [...NEWS_SOURCE_IDS];

  const licences = await ctx.db.execute<LicenceRow>(sql`
    SELECT source_id, display, export_allowed, api_allowed
      FROM licence_registry
     WHERE tx_to = 'infinity'
       AND valid_from <= ${at}::timestamptz
       AND valid_to   >  ${at}::timestamptz
       AND source_id = ANY(${sql.param(sources)}::text[])`);

  const grants = await ctx.db.execute<GrantRow>(sql`
    SELECT subject_kind::text AS subject_kind, source_id,
           usage_display, usage_export, usage_api
      FROM entitlement_grants
     WHERE ((subject_kind = 'firm' AND subject_id = ${ctx.user.firmId}::bigint)
            OR (subject_kind = 'user' AND subject_id = ${ctx.user.userId}::bigint))
       AND (source_id IS NULL OR source_id = ANY(${sql.param(sources)}::text[]))
       AND (field_class IS NULL OR field_class = 'news')
       AND valid_from <= ${at}::timestamptz
       AND valid_to   >  ${at}::timestamptz`);

  const usageOfGrant = (row: GrantRow): boolean =>
    usage === 'display' ? row.usage_display : usage === 'export' ? row.usage_export : row.usage_api;

  const out = new Map<NewsSourceId, NewsSourceVerdict>();
  for (const sourceId of NEWS_SOURCE_IDS) {
    const licence = licences.rows.find((row) => row.source_id === sourceId);
    if (licence === undefined) {
      out.set(sourceId, { allowed: false, reason: 'FIELD_UNKNOWN' });
      continue;
    }
    const licensed =
      usage === 'display'
        ? licence.display
        : usage === 'export'
          ? licence.export_allowed
          : licence.api_allowed;
    if (!licensed) {
      out.set(sourceId, { allowed: false, reason: 'LICENCE_FORBIDS_USAGE' });
      continue;
    }
    const covering = grants.rows.filter(
      (row) => (row.source_id === null || row.source_id === sourceId) && usageOfGrant(row),
    );
    if (!covering.some((row) => row.subject_kind === 'firm')) {
      out.set(sourceId, { allowed: false, reason: 'NO_FIRM_ENTITLEMENT' });
      continue;
    }
    if (!covering.some((row) => row.subject_kind === 'user')) {
      out.set(sourceId, { allowed: false, reason: 'NO_USER_ENTITLEMENT' });
      continue;
    }
    out.set(sourceId, { allowed: true, reason: 'OK' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// NewsItem → NewsRow (§0.2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * WP-04's stored row as every news screen renders it, citing the capture it came from.
 *
 * `machineGenerated` is hard-coded `false` and the stored column is *asserted* rather than copied:
 * NEWS-08 says v1 never publishes machine-generated news, the ingest never writes `true`, and a
 * row that somehow carried it must not reach a screen that renders it as ordinary copy. The
 * payload type admits `false` alone, so this is the one place the claim is checked.
 *
 * `st: 'closed'` on the citation (§0.4 rule 3): a headline is an immutable stored record, not a
 * live cell — it does not go stale, it was published once.
 */
export function toNewsRow(ctx: ResolveContext, item: NewsItem): NewsRow {
  const sourceId = NEWS_SOURCE_IDS.find((id) => id === item.sourceId);
  if (sourceId === undefined) {
    throw new TypeError(`news: '${item.sourceId}' is not one of the three v1 news sources`);
  }
  if (item.machineGenerated) {
    throw new TypeError(
      `news: news_id ${String(item.newsId)} is marked machine_generated; v1 never publishes one ` +
        '(NEWS-08)',
    );
  }
  return {
    newsId: item.newsId,
    headline: item.headline,
    summary: item.summary,
    sourceId,
    feed: item.feed,
    kind: item.kind,
    author: item.author,
    category: item.category,
    cik: item.cik,
    items8k: item.items8k,
    publishedAt: item.publishedAt,
    capturedAt: item.capturedAt,
    url: item.url,
    isCorrection: item.isCorrection,
    machineGenerated: false,
    links: item.links.map((link) => ({
      entityKind: link.entityKind,
      entityId: link.entityId,
      display: link.display,
      confidence: link.confidence,
      method: link.method,
    })),
    provIdx: ctx.prov.add({
      sourceId,
      provenanceId: item.provenanceId,
      capturedAt: new Date(item.capturedAt),
      sourceTs: new Date(item.publishedAt),
      st: 'closed',
      tier: 'delayed',
    }),
  };
}

/**
 * Drop the rows this caller may not see, counting them, and record the reason once per source.
 *
 * ENTL-05's shape for a *row* rather than a cell: a headline from an unlicensed source is not
 * blanked, it is absent — there is no partial view of a headline — so the count is what the screen
 * shows ("3 hidden by entitlement") and `meta.unavailable` carries the reason per source.
 */
export function filterByLicence(
  ctx: ResolveContext,
  items: readonly NewsItem[],
  access: ReadonlyMap<NewsSourceId, NewsSourceVerdict>,
  purpose: string,
): { kept: NewsItem[]; suppressed: number } {
  const kept: NewsItem[] = [];
  let suppressed = 0;
  const reported = new Set<string>();

  for (const item of items) {
    const sourceId = NEWS_SOURCE_IDS.find((id) => id === item.sourceId);
    const verdict = sourceId === undefined ? undefined : access.get(sourceId);
    if (verdict?.allowed === true) {
      kept.push(item);
      continue;
    }
    suppressed += 1;
    const reason = verdict?.reason ?? 'FIELD_UNKNOWN';
    const key = `${item.sourceId}:${reason}`;
    if (reported.has(key)) continue;
    reported.add(key);
    ctx.unavailable.add({
      field: 'rows',
      reason: 'NOT_LICENSED',
      detail: `${reason}: ${purpose} may not show ${item.sourceId} headlines to this firm`,
    });
  }
  return { kept, suppressed };
}
