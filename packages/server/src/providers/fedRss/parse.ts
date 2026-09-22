/**
 * `fed.rss` — the pure half. PROVIDERS.b §11.2, WORKPLAN WP-05.
 *
 * The Federal Reserve press feed: RSS 2.0 with no namespaces, twenty items, and three differences
 * from §11.1 that are exactly why it is a separate adapter rather than a parameter:
 *
 *  1. **The file starts with a UTF-8 BOM before `<?xml`.** `providers/xml.ts#decodeXmlBuffer`
 *     strips a leading `EF BB BF`; a BOM left in place makes most XML parsers reject the
 *     declaration, and the failure looks like "the Fed published nothing today".
 *  2. **`<guid>` is the article URL** with no `isPermaLink` attribute. It is still the dedupe key
 *     and it is stable, so no special case is needed beyond not assuming an opaque id.
 *  3. **`<pubDate>` is CDATA with trailing whitespace** (`"Fri, 11 Sep 2026 14:00:00 GMT"    `),
 *     which is trimmed before parsing. So is every other field.
 *
 * `item/description` equals `item/title` on every recorded row and is stored anyway, so a future
 * divergence is visible rather than invented. Unlike §11.1's feed, the descriptions really do
 * carry HTML entities inside their CDATA (`&#39;`, `&quot;`), which is why the summary goes
 * through the HTML stripper and the title does not.
 *
 * The RFC 822 date reader is imported from `providers/bbgRss/parse.ts`: both feeds are RSS 2.0 and
 * a second implementation of the same month and zone tables is a second thing to get wrong.
 */

import { parseRfc822Date, cleanText, summaryText } from '../bbgRss/parse.js';
import type { NormaliseContext, NormaliseProblem, Normalised, RawRecord } from '../types.js';
import { child, childText, childrenNamed, parseXmlBuffer } from '../xml.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `news_items.feed` for this source — one feed, named for the endpoint (§11.2). */
export const FED_FEED = 'press_all';

/** §11.2: the topic every Fed release is linked to. */
export const FED_TOPIC = 'FED';

/** §11.2: the additional topic when `category` names monetary policy. */
export const FED_RATES_TOPIC = 'RATES';

/** §11.2: the category that may carry a target-range decision. */
export const MONETARY_POLICY_CATEGORY = 'Monetary Policy';

/** Same guard as §11.1: a timestamp far in the future is a bad timestamp. */
export const MAX_FUTURE_PUBLISH_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `news_items` row (CONTRACTS §1.2), entity ids excluded. */
export interface FedNewsItemRow {
  sourceId: 'fed.rss';
  feed: typeof FED_FEED;
  /** The article URL — stable, and the dedupe key with `source_id` (§11.2). */
  providerGuid: string;
  kind: 'fed_release';
  headline: string;
  summary: string | null;
  url: string | null;
  /** The feed publishes no byline. */
  author: null;
  /** `'Enforcement Actions'`, `'Monetary Policy'`, … */
  category: string | null;
  cik: null;
  lang: string | null;
  /** FEED-05 `src`, ISO-8601 UTC. */
  publishedAt: string;
  isCorrection: boolean;
  machineGenerated: false;
}

/** A `news_entity_links` row for a topic (§11.2), the news id excluded. */
export interface FedTopicLinkRow {
  providerGuid: string;
  entityKind: 'topic';
  /** `topics.code`. */
  code: string;
  confidence: 1;
  method: 'feed_topic';
}

/**
 * A target range a `Monetary Policy` release named, for `fomc_meetings.decision_bp` (§11.2).
 *
 * `decisionBp` is **`null` unless the headline states both ends of a new range**: the feed's
 * headline is usually `'Federal Reserve issues FOMC statement'`, which names no numbers at all,
 * and a guessed basis-point move on a rates screen is worse than an empty cell.
 */
export interface FedPolicyRow {
  providerGuid: string;
  publishedAt: string;
  headline: string;
  targetFromPct: number | null;
  targetToPct: number | null;
}

export interface FedRssRows {
  lang: string | null;
  items: FedNewsItemRow[];
  topicLinks: FedTopicLinkRow[];
  policy: FedPolicyRow[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Target range
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Code-unit ordering. `String.prototype.localeCompare` is locale- and ICU-dependent, and a golden
 * file may not depend on which collation the host happens to ship.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const TARGET_RANGE_RE = /(\d+(?:[.,]\d+)?)\s*(?:to|-|–|—|and)\s*(\d+(?:[.,]\d+)?)\s*percent/i;

/**
 * `'… to 3-1/2 to 3-3/4 percent'` → `{from, to}` when the text states a percentage range, else
 * `null`. Decimal forms only: the Fed publishes fractions (`3-1/4`) in the statement body, which
 * this feed never carries, and inventing a reading of `3-1/4` from a headline that does not
 * contain it would be a fabricated rate.
 */

export function parseTargetRange(text: string): { from: number; to: number } | null {
  const match = TARGET_RANGE_RE.exec(text);
  if (match === null) return null;
  const from = Number((match[1] ?? '').replace(',', '.'));
  const to = Number((match[2] ?? '').replace(',', '.'));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from < 0 || to < 0 || from > 25 || to > 25 || to < from) return null;
  return { from, to };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────────────────────

function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** §11.1's correction marker applies here too. */
const CORRECTION_RE = /^(correct|corrects|correction|fixes headline)\b/i;

/**
 * The Fed press feed → `news_items` + topic links.
 *
 * Items come back ascending by `published_at` (ties broken by guid), for the same reason as
 * §11.1: `n:` subjects are never conflated. The payload publishes them newest-first.
 *
 * @param capturedAt `RawRecord.capturedAt` — the only clock this parser sees.
 */
export function parseFedRss(
  body: Buffer | string,
  capturedAt: number,
): { rows: FedRssRows; problems: NormaliseProblem[] } {
  const empty: FedRssRows = { lang: null, items: [], topicLinks: [], policy: [] };
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const parsed = parseXmlBuffer(buffer);
  if (!parsed.ok) return { rows: empty, problems: [...parsed.problems] };

  const problems: NormaliseProblem[] = [...parsed.problems];
  const channel = child(parsed.root, 'channel');
  if (channel === null) {
    problems.push({ kind: 'schema_drift', detail: 'fed rss payload has no channel element' });
    return { rows: empty, problems };
  }

  const lang = cleanText(childText(channel, 'language'));
  const elements = childrenNamed(channel, 'item');
  if (elements.length === 0) {
    problems.push({
      kind: 'schema_drift',
      detail: 'fed rss feed carries zero item elements',
      path: '/rss/channel',
    });
  }

  const items: FedNewsItemRow[] = [];
  const topicLinks: FedTopicLinkRow[] = [];
  const policy: FedPolicyRow[] = [];
  const seenGuids = new Set<string>();

  elements.forEach((item, index) => {
    const path = `/rss/channel/item[${String(index)}]`;
    const link = cleanText(childText(item, 'link'));
    const guidText = cleanText(childText(item, 'guid'));
    const providerGuid = guidText === '' ? link : guidText;
    if (providerGuid === '') {
      problems.push({ kind: 'schema_drift', detail: 'fed rss item carries no guid or link', path });
      return;
    }
    if (seenGuids.has(providerGuid)) {
      problems.push({
        kind: 'field_dropped',
        detail: `fed rss item guid ${providerGuid} appears twice in one payload`,
        path,
      });
      return;
    }

    const pubDateRaw = childText(item, 'pubDate').trim();
    const publishedMs = pubDateRaw === '' ? null : parseRfc822Date(pubDateRaw);
    if (publishedMs === null) {
      problems.push({
        kind: 'schema_drift',
        detail: `fed rss item ${providerGuid} has no usable pubDate ('${pubDateRaw}')`,
        path: `${path}/pubDate`,
      });
      return;
    }
    if (publishedMs > capturedAt + MAX_FUTURE_PUBLISH_MS) {
      problems.push({
        kind: 'out_of_range',
        detail:
          `fed rss item ${providerGuid} is published ${isoSeconds(publishedMs)}, more than 24 h ` +
          'after the capture; dropped',
        path: `${path}/pubDate`,
      });
      return;
    }

    const headline = cleanText(childText(item, 'title'));
    if (headline === '') {
      problems.push({
        kind: 'field_dropped',
        detail: `fed rss item ${providerGuid} carries no title`,
        path: `${path}/title`,
      });
    }
    const summaryRaw = childText(item, 'description');
    const summary = summaryRaw.trim() === '' ? null : summaryText(summaryRaw);
    const categoryText = cleanText(childText(item, 'category'));
    const category = categoryText === '' ? null : categoryText;
    const publishedAt = isoSeconds(publishedMs);

    seenGuids.add(providerGuid);
    items.push({
      sourceId: 'fed.rss',
      feed: FED_FEED,
      providerGuid,
      kind: 'fed_release',
      headline,
      summary,
      url: link === '' ? (guidText === '' ? null : guidText) : link,
      author: null,
      category,
      cik: null,
      lang: lang === '' ? null : lang,
      publishedAt,
      isCorrection: CORRECTION_RE.test(headline) || CORRECTION_RE.test(summary ?? ''),
      machineGenerated: false,
    });

    topicLinks.push({
      providerGuid,
      entityKind: 'topic',
      code: FED_TOPIC,
      confidence: 1,
      method: 'feed_topic',
    });
    if (category?.includes(MONETARY_POLICY_CATEGORY) === true) {
      topicLinks.push({
        providerGuid,
        entityKind: 'topic',
        code: FED_RATES_TOPIC,
        confidence: 1,
        method: 'feed_topic',
      });
      const range = parseTargetRange(headline);
      policy.push({
        providerGuid,
        publishedAt,
        headline,
        targetFromPct: range?.from ?? null,
        targetToPct: range?.to ?? null,
      });
    }
  });

  const byPublished = (a: { publishedAt: string }, b: { publishedAt: string }): number =>
    a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : 0;

  items.sort((a, b) => byPublished(a, b) || cmp(a.providerGuid, b.providerGuid));
  policy.sort((a, b) => byPublished(a, b) || cmp(a.providerGuid, b.providerGuid));
  topicLinks.sort((a, b) => cmp(a.providerGuid, b.providerGuid) || cmp(a.code, b.code));

  return { rows: { lang: lang === '' ? null : lang, items, topicLinks, policy }, problems };
}

/**
 * `fed.rss` → rows.
 *
 * `sourceTs` is the newest `published_at` in the payload: the feed carries no `lastBuildDate`, and
 * the instant the Fed last published something is the honest answer to "how current is this".
 * No `NormalisedUpdate` — there is no plant subject, and the Fed can legitimately publish nothing
 * for days (§11.2: no staleness tier).
 */
export function normaliseFedRss(raw: RawRecord, ctx: NormaliseContext): Normalised<FedRssRows> {
  const { rows, problems } = parseFedRss(raw.body, ctx.capturedAt);
  const newest = rows.items[rows.items.length - 1]?.publishedAt ?? null;
  return {
    updates: [],
    rows,
    sourceTs: newest === null ? raw.sourceTs : new Date(newest),
    problems,
  };
}
