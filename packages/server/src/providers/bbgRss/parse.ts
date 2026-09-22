/**
 * `bbg.rss` — the pure half. PROVIDERS.b §11.1, WORKPLAN WP-05.
 *
 * Six Bloomberg feeds, one `source_id`, RSS 2.0 with the `dc`, `content`, `atom` and `media`
 * namespaces declared and only `dc:creator` actually used. Every text node is `<![CDATA[…]]>`.
 *
 * Four rules from §11.1 that a naive reader gets wrong:
 *
 *  1. **`pubDate` is RFC 822 and is parsed with explicit month and zone tables**, never with
 *     `new Date(string)`. `Date.parse` of an RFC 822 string is implementation-defined; a golden
 *     that depends on it is a golden that depends on the V8 version.
 *  2. **`guid` is the dedupe key**, with `source_id`. It is not the link: `isPermaLink="false"`,
 *     and the value (`TLEXF6KK3NYB00`) is Bloomberg's own story id, which is stable across a
 *     re-titled story while the link is not.
 *  3. **A `pubDate` more than 24 hours after the capture is dropped** (`out_of_range`). A bad
 *     timestamp is not a cosmetic problem: `n:` subjects are ordered by `published_at`, so one
 *     future item pins itself to the top of every stream forever.
 *  4. **The feed name comes from the payload**, not from the caller — `atom:link rel="self"`
 *     carries the post-redirect URL (`https://www.bloomberg.com/feeds/economics/news.rss`), which
 *     is the same URL the manifest records (§11.1: `feeds.bloomberg.com` 301s to `www.`, and
 *     `RawRecord.url` is the post-redirect form). Parsing it here keeps `parse.ts` a function of
 *     the bytes alone, which is what the golden needs.
 *
 * `headline` is taken as the XML layer produced it: a CDATA body is character data, so it was
 * never entity-decoded, and a plain body was decoded exactly once — "entities decoded once" in
 * both cases. `summary` goes through the HTML stripper, because an RSS `description` is HTML by
 * contract and the Fed's copy of the same shape really does carry `&#39;` inside its CDATA.
 * The **article body is never fetched or stored** (feed terms, DATA_MODEL L1569).
 */

import { stripTags } from '../html.js';
import type { NormaliseContext, NormaliseProblem, Normalised, RawRecord } from '../types.js';
import { child, childText, childrenNamed, parseXmlBuffer, textOf as xmlTextOf } from '../xml.js';
import type { XmlElement } from '../xml.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The six feeds of §11.1. `wealth` has no recorded capture; the parser still knows the name. */
export const BBG_FEEDS = [
  'markets',
  'economics',
  'politics',
  'technology',
  'wealth',
  'industries',
] as const;

export type BbgFeed = (typeof BBG_FEEDS)[number];

const BBG_FEED_SET: ReadonlySet<string> = new Set<string>(BBG_FEEDS);

/** §11.1: an item published more than this far after the capture is a bad timestamp. */
export const MAX_FUTURE_PUBLISH_MS = 24 * 60 * 60 * 1000;

/** §11.1: `'video'` when the link path names a video. */
const VIDEO_PATH = '/news/videos/';

/**
 * §11.1: the correction marker, on the headline or the summary.
 *
 * The spec anchors the marker to the start of the string, but Bloomberg puts it at the END of the
 * body: the recorded `bbg-rss-markets` capture carries `... amid concerns over AI safety. Correct:
 * George Noble said ... Fixes headline (Source: Bloomberg)`. A start anchor misses every real
 * correction, so the marker is required to sit at a sentence boundary instead of at offset zero.
 */
export const CORRECTION_RE = /(^|[.\n]\s*)(correct|corrects|correction|fixes headline)\b/i;

/**
 * Code-unit ordering. `String.prototype.localeCompare` is locale- and ICU-dependent, and a golden
 * file may not depend on which collation the host happens to ship.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RFC 822 dates (§11.1) — pure, explicit, and shared with `providers/fedRss/parse.ts`
// ─────────────────────────────────────────────────────────────────────────────────────────────

const RFC822_MONTHS: ReadonlyMap<string, number> = new Map([
  ['jan', 0],
  ['feb', 1],
  ['mar', 2],
  ['apr', 3],
  ['may', 4],
  ['jun', 5],
  ['jul', 6],
  ['aug', 7],
  ['sep', 8],
  ['oct', 9],
  ['nov', 10],
  ['dec', 11],
]);

/** Minutes east of UTC for the named zones RFC 822 allows. */
const RFC822_ZONES: ReadonlyMap<string, number> = new Map([
  ['ut', 0],
  ['utc', 0],
  ['gmt', 0],
  ['z', 0],
  ['est', -300],
  ['edt', -240],
  ['cst', -360],
  ['cdt', -300],
  ['mst', -420],
  ['mdt', -360],
  ['pst', -480],
  ['pdt', -420],
]);

const RFC822_RE =
  /^(?:[A-Za-z]{3,9},\s*)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([A-Za-z]{1,5}|[+-]\d{4})?$/;

/**
 * An RFC 822 / RFC 2822 date → epoch ms UTC, or `null`.
 *
 * Explicit tables, no `Date.parse` of the whole string, and three deliberate readings:
 *
 *  - a two-digit year is 2000-2049 / 1950-1999, the RFC 2822 rule;
 *  - an absent or unrecognised zone is read as UTC (RFC 2822's `-0000`, "unknown local offset"),
 *    because dropping the item would lose a real headline over a formatting detail;
 *  - the trailing zone is optional, so `"Fri, 11 Sep 2026 14:00:00"` parses.
 */

export function parseRfc822Date(value: string): number | null {
  const text = value.trim().replace(/\s+/g, ' ');
  const match = RFC822_RE.exec(text);
  if (match === null) return null;

  const day = Number(match[1]);
  const month = RFC822_MONTHS.get((match[2] ?? '').slice(0, 3).toLowerCase());
  if (month === undefined) return null;
  let year = Number(match[3]);
  if ((match[3] ?? '').length === 2) year += year < 50 ? 2000 : 1900;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;

  let offsetMinutes = 0;
  const zone = match[7];
  if (zone !== undefined) {
    const signed = /^([+-])(\d{2})(\d{2})$/.exec(zone);
    if (signed !== null) {
      const magnitude = Number(signed[2]) * 60 + Number(signed[3]);
      offsetMinutes = signed[1] === '-' ? -magnitude : magnitude;
    } else {
      offsetMinutes = RFC822_ZONES.get(zone.toLowerCase()) ?? 0;
    }
  }

  const ms = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60_000;
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch ms → `YYYY-MM-DDTHH:MM:SSZ`. */
function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Text hygiene (§11.1)
// ─────────────────────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- C0 controls are exactly what this strips.
const C0_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Strip C0 control characters and collapse whitespace, preserving typographic quotes and em
 * dashes exactly as published — the headline on the screen is the headline Bloomberg wrote.
 */
export function cleanText(value: string): string {
  return value.replace(C0_CONTROLS, '').replace(/\s+/g, ' ').trim();
}

/** An RSS `description` (HTML by contract) → plain text. */
export function summaryText(value: string): string {
  return cleanText(stripTags(value));
}

/** `'https://www.bloomberg.com/feeds/economics/news.rss'` → `'economics'`; else `null`. */
export function feedFromUrl(url: string): BbgFeed | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  for (const segment of path.split('/')) {
    if (BBG_FEED_SET.has(segment)) return segment as BbgFeed;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Row shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `news_items` row (CONTRACTS §1.2), entity ids excluded. */
export interface BbgNewsItemRow {
  sourceId: 'bbg.rss';
  feed: string;
  /** `news_items.provider_guid` — the dedupe key with `source_id`. */
  providerGuid: string;
  kind: 'story' | 'video';
  headline: string;
  summary: string | null;
  url: string | null;
  author: string | null;
  /** NULL for this source (§11.1). */
  category: null;
  /** NULL for this source (§11.1). */
  cik: null;
  lang: string | null;
  /** FEED-05 `src`, ISO-8601 UTC. */
  publishedAt: string;
  isCorrection: boolean;
  /** NEWS-08: always `false` in v1; the column exists so the render rule is enforceable later. */
  machineGenerated: false;
}

/** A `people` candidate minted from `dc:creator` (§11.1). */
export interface BbgPersonCandidateRow {
  name: string;
  role: 'Reporter';
  sourceId: 'bbg.rss';
}

export interface BbgRssRows {
  /** The feed the payload names, `null` when it names none this parser recognises. */
  feed: string | null;
  lang: string | null;
  /** `channel/lastBuildDate` as an instant. */
  lastBuildDate: string | null;
  items: BbgNewsItemRow[];
  people: BbgPersonCandidateRow[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The `atom:link rel="self"` href, or the channel link, whichever names a known feed. */
function feedOfChannel(channel: XmlElement): string | null {
  for (const link of childrenNamed(channel, 'link', ATOM_NAMESPACE)) {
    const href = link.attrs.href;
    if (href === undefined) continue;
    const feed = feedFromUrl(href);
    if (feed !== null) return feed;
  }
  for (const link of childrenNamed(channel, 'link')) {
    const feed = feedFromUrl(xmlTextOf(link).trim());
    if (feed !== null) return feed;
  }
  return null;
}

/**
 * A Bloomberg RSS feed → `news_items` rows.
 *
 * Items come back **ascending by `published_at`** (ties broken by guid): `n:` subjects are never
 * conflated, headlines arrive in publication order and a later headline never overwrites an
 * earlier one (§11.1, API §6.1). The payload publishes them newest-first.
 *
 * @param capturedAt `RawRecord.capturedAt` — the only clock this parser sees, used for the
 *   24-hour future-timestamp guard.
 * @param feedOverride the feed name when the caller knows it and the payload does not say.
 */
export function parseBbgRss(
  body: Buffer | string,
  capturedAt: number,
  feedOverride?: string,
): { rows: BbgRssRows; problems: NormaliseProblem[] } {
  const empty: BbgRssRows = {
    feed: feedOverride ?? null,
    lang: null,
    lastBuildDate: null,
    items: [],
    people: [],
  };
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const parsed = parseXmlBuffer(buffer);
  if (!parsed.ok) return { rows: empty, problems: [...parsed.problems] };

  const problems: NormaliseProblem[] = [...parsed.problems];
  const channel = child(parsed.root, 'channel');
  if (channel === null) {
    problems.push({ kind: 'schema_drift', detail: 'bbg rss payload has no channel element' });
    return { rows: empty, problems };
  }

  const feed = feedOverride ?? feedOfChannel(channel);
  if (feed === null) {
    problems.push({
      kind: 'schema_drift',
      detail: 'bbg rss payload names no recognised feed in atom:link or channel/link',
      path: '/rss/channel/link',
    });
  }
  const lang = cleanText(childText(channel, 'language'));
  const lastBuildRaw = childText(channel, 'lastBuildDate').trim();
  const lastBuildMs = lastBuildRaw === '' ? null : parseRfc822Date(lastBuildRaw);
  if (lastBuildRaw !== '' && lastBuildMs === null) {
    problems.push({
      kind: 'schema_drift',
      detail: `bbg rss lastBuildDate '${lastBuildRaw}' is not an RFC 822 date`,
      path: '/rss/channel/lastBuildDate',
    });
  }

  const elements = childrenNamed(channel, 'item');
  if (elements.length === 0) {
    problems.push({
      kind: 'schema_drift',
      detail: 'bbg rss feed carries zero item elements',
      path: '/rss/channel',
    });
  }

  const items: BbgNewsItemRow[] = [];
  const seenGuids = new Set<string>();
  const people: BbgPersonCandidateRow[] = [];
  const seenPeople = new Set<string>();

  elements.forEach((item, index) => {
    const path = `/rss/channel/item[${String(index)}]`;
    const providerGuid = cleanText(childText(item, 'guid'));
    if (providerGuid === '') {
      problems.push({ kind: 'schema_drift', detail: 'bbg rss item carries no guid', path });
      return;
    }
    if (seenGuids.has(providerGuid)) {
      problems.push({
        kind: 'field_dropped',
        detail: `bbg rss item guid ${providerGuid} appears twice in one payload`,
        path,
      });
      return;
    }

    const pubDateRaw = childText(item, 'pubDate').trim();
    const publishedMs = pubDateRaw === '' ? null : parseRfc822Date(pubDateRaw);
    if (publishedMs === null) {
      problems.push({
        kind: 'schema_drift',
        detail: `bbg rss item ${providerGuid} has no usable pubDate ('${pubDateRaw}')`,
        path: `${path}/pubDate`,
      });
      return;
    }
    if (publishedMs > capturedAt + MAX_FUTURE_PUBLISH_MS) {
      problems.push({
        kind: 'out_of_range',
        detail:
          `bbg rss item ${providerGuid} is published ${isoSeconds(publishedMs)}, more than 24 h ` +
          'after the capture; dropped so it cannot pin itself to the top of the stream',
        path: `${path}/pubDate`,
      });
      return;
    }

    const headline = cleanText(childText(item, 'title'));
    if (headline === '') {
      problems.push({
        kind: 'field_dropped',
        detail: `bbg rss item ${providerGuid} carries no title`,
        path: `${path}/title`,
      });
    }
    const summaryRaw = childText(item, 'description');
    const summary = summaryRaw.trim() === '' ? null : summaryText(summaryRaw);
    const url = cleanText(childText(item, 'link'));
    const authorRaw = cleanText(xmlTextOf(child(item, 'creator', DC_NAMESPACE)));
    const author = authorRaw === '' ? null : authorRaw;

    seenGuids.add(providerGuid);
    items.push({
      sourceId: 'bbg.rss',
      feed: feed ?? '',
      providerGuid,
      kind: url.includes(VIDEO_PATH) ? 'video' : 'story',
      headline,
      summary,
      url: url === '' ? null : url,
      author,
      category: null,
      cik: null,
      lang: lang === '' ? null : lang,
      publishedAt: isoSeconds(publishedMs),
      isCorrection: CORRECTION_RE.test(headline) || CORRECTION_RE.test(summary ?? ''),
      machineGenerated: false,
    });

    if (author !== null && !seenPeople.has(author)) {
      seenPeople.add(author);
      people.push({ name: author, role: 'Reporter', sourceId: 'bbg.rss' });
    }
  });

  items.sort(
    (a, b) =>
      (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : 0) ||
      cmp(a.providerGuid, b.providerGuid),
  );
  people.sort((a, b) => cmp(a.name, b.name));

  return {
    rows: {
      feed,
      lang: lang === '' ? null : lang,
      lastBuildDate: lastBuildMs === null ? null : isoSeconds(lastBuildMs),
      items,
      people,
    },
    problems,
  };
}

/**
 * Cross-feed deduplication (§11.1). All six feeds share `source_id 'bbg.rss'` and `feed` is **not**
 * part of the unique key, so a story in both `markets` and `economics` is one row and the first
 * feed polled owns the `feed` column. First wins, deliberately: one story, one row, one `news_id`
 * for every link and alert. Topic completeness is restored at the link layer, not here.
 */
export function dedupeByGuid(items: readonly BbgNewsItemRow[]): BbgNewsItemRow[] {
  const seen = new Set<string>();
  const out: BbgNewsItemRow[] = [];
  for (const item of items) {
    if (seen.has(item.providerGuid)) continue;
    seen.add(item.providerGuid);
    out.push(item);
  }
  return out;
}

/**
 * `bbg.rss` → rows. No `NormalisedUpdate`: news `n:` subjects are fanned out by `news/ingest.ts`
 * **after** the upsert tells it whether the row was inserted or the headline actually changed
 * (§11.1) — emitting a delta here would re-fan every one of the 20 items every 60 seconds.
 */
export function normaliseBbgRss(raw: RawRecord, ctx: NormaliseContext): Normalised<BbgRssRows> {
  const { rows, problems } = parseBbgRss(raw.body, ctx.capturedAt);
  return {
    updates: [],
    rows,
    sourceTs: rows.lastBuildDate === null ? raw.sourceTs : new Date(rows.lastBuildDate),
    problems,
  };
}
