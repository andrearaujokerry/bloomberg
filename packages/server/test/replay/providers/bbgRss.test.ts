/**
 * QA-02 — `bbg.rss` over the five recorded feed captures. WORKPLAN WP-05, PROVIDERS.b §11.1.
 *
 * Five of the six feeds have a capture (`wealth` does not, which is §11.1's own "addition
 * required"). Each is pinned to its own golden, and the request key is derived from
 * `bbgFeedUrl(feed)` — the **post-redirect** `www.bloomberg.com` form, which is the whole point of
 * §11.1's redirect note: asking for `feeds.bloomberg.com` would key on the wrong URL and miss
 * every capture.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BBG_RSS_ADAPTER_VERSION,
  bbgFeedRedirectUrl,
  bbgFeedUrl,
  bbgRssAdapter,
} from '../../../src/providers/bbgRss/adapter.js';
import {
  CORRECTION_RE,
  cleanText,
  dedupeByGuid,
  feedFromUrl,
  normaliseBbgRss,
  parseBbgRss,
  parseRfc822Date,
} from '../../../src/providers/bbgRss/parse.js';
import type { BbgFeed } from '../../../src/providers/bbgRss/parse.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import type { NormaliseContext, RawRecord } from '../../../src/providers/types.js';

const store = openReplayStore();

function goldenText(name: string): string {
  return readFileSync(join(store.dir, 'normalised', name), 'utf8');
}

function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ctxOf(raw: RawRecord): NormaliseContext {
  return { provenanceId: 0, capturedAt: raw.capturedAt, lines: new Map() };
}

/** feed, golden file, byte length, videos, authored items, distinct reporters, lastBuildDate. */
const CAPTURES: {
  feed: BbgFeed;
  golden: string;
  bytes: number;
  videos: number;
  authored: number;
  people: number;
  lastBuild: string;
  first: string;
  last: string;
}[] = [
  {
    feed: 'markets',
    golden: 'bbg-rss-markets.json',
    bytes: 15_173,
    videos: 3,
    authored: 17,
    people: 16,
    lastBuild: '2026-09-15T18:40:06Z',
    first: '2026-09-14T22:04:31Z',
    last: '2026-09-15T17:39:10Z',
  },
  {
    feed: 'economics',
    golden: 'bbg-rss-econ.json',
    bytes: 15_108,
    videos: 2,
    authored: 18,
    people: 16,
    lastBuild: '2026-09-15T18:39:00Z',
    first: '2026-09-14T07:58:52Z',
    last: '2026-09-15T16:23:25Z',
  },
  {
    feed: 'politics',
    golden: 'bbg-rss-politics.json',
    bytes: 15_252,
    videos: 7,
    authored: 13,
    people: 11,
    lastBuild: '2026-09-15T18:40:42Z',
    first: '2026-09-15T10:32:49Z',
    last: '2026-09-15T18:25:22Z',
  },
  {
    feed: 'technology',
    golden: 'bbg-rss-tech.json',
    bytes: 16_056,
    videos: 8,
    authored: 12,
    people: 12,
    lastBuild: '2026-09-15T18:39:00Z',
    first: '2026-09-14T19:35:09Z',
    last: '2026-09-15T17:00:14Z',
  },
  {
    feed: 'industries',
    golden: 'bbg-rss-industries.json',
    bytes: 15_060,
    videos: 0,
    authored: 20,
    people: 19,
    lastBuild: '2026-09-15T18:40:34Z',
    first: '2026-09-15T02:47:47Z',
    last: '2026-09-15T14:24:15Z',
  },
];

describe.each(CAPTURES)('bbg.rss — $feed (§11.1)', (capture) => {
  const url = bbgFeedUrl(capture.feed);
  const raw = store.replay({ providerId: 'bbg.rss', url });

  it('keys on the post-redirect URL and reads the capture from the store', () => {
    expect(url).toBe(`https://www.bloomberg.com/feeds/${capture.feed}/news.rss`);
    expect(bbgFeedRedirectUrl(capture.feed)).toBe(
      `https://feeds.bloomberg.com/${capture.feed}/news.rss`,
    );
    expect(store.has(requestKey('bbg.rss', 'GET', url))).toBe(true);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(capture.bytes);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseBbgRss(raw, ctxOf(raw)))).toBe(goldenText(capture.golden));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseBbgRss(raw, ctxOf(raw));
    expect(out.problems).toHaveLength(0);
    expect(out.updates).toHaveLength(0);

    // The feed name comes from the payload's own atom:link, not from the request.
    expect(out.rows.feed).toBe(capture.feed);
    expect(out.rows.lang).toBe('en');
    expect(out.rows.lastBuildDate).toBe(capture.lastBuild);
    expect(out.sourceTs?.toISOString()).toBe(new Date(capture.lastBuild).toISOString());

    // Twenty items, every one with a guid, a headline, a link and a published instant.
    expect(out.rows.items).toHaveLength(20);
    expect(new Set(out.rows.items.map((i) => i.providerGuid)).size).toBe(20);
    expect(out.rows.items.every((i) => i.headline !== '')).toBe(true);
    expect(out.rows.items.every((i) => i.url !== null)).toBe(true);
    expect(out.rows.items.every((i) => i.summary !== null)).toBe(true);
    expect(out.rows.items.every((i) => i.lang === 'en')).toBe(true);
    expect(out.rows.items.every((i) => i.feed === capture.feed)).toBe(true);
    expect(out.rows.items.every((i) => i.machineGenerated === false)).toBe(true);
    expect(out.rows.items.every((i) => i.category === null && i.cik === null)).toBe(true);

    // Ascending by published_at, which is the order `n:` subjects are fanned out in.
    expect(out.rows.items.map((i) => i.publishedAt)).toEqual(
      [...out.rows.items.map((i) => i.publishedAt)].sort(),
    );
    expect(out.rows.items[0]?.publishedAt).toBe(capture.first);
    expect(out.rows.items.at(-1)?.publishedAt).toBe(capture.last);

    // Field coverage the feed does not fill uniformly: videos and bylines.
    expect(out.rows.items.filter((i) => i.kind === 'video')).toHaveLength(capture.videos);
    expect(out.rows.items.filter((i) => i.kind === 'story')).toHaveLength(20 - capture.videos);
    expect(
      out.rows.items.every((i) => (i.kind === 'video') === i.url!.includes('/news/videos/')),
    ).toBe(true);
    expect(out.rows.items.filter((i) => i.author !== null)).toHaveLength(capture.authored);
    expect(out.rows.people).toHaveLength(capture.people);
    expect(out.rows.people.every((p) => p.role === 'Reporter' && p.sourceId === 'bbg.rss')).toBe(
      true,
    );
  });
});

describe('bbg.rss cross-cutting rules', () => {
  const raw = store.replay({ providerId: 'bbg.rss', url: bbgFeedUrl('economics') });

  it('preserves typographic punctuation exactly as published', () => {
    const out = normaliseBbgRss(raw, ctxOf(raw));
    const bessent = out.rows.items.find((i) => i.providerGuid === 'TLEXF6KK3NYB00');
    expect(bessent?.headline).toBe(
      'Bessent Says US Yen Intervention Was ‘Nominal,’ Backs US Exports',
    );
    expect(bessent?.author).toBe('Yash Roy');
    expect(bessent?.summary).toContain('“nominal”');
    expect(bessent?.publishedAt).toBe('2026-09-15T16:23:25Z');
  });

  it('parses RFC 822 dates with explicit tables, not Date.parse', () => {
    expect(parseRfc822Date('Tue, 15 Sep 2026 16:23:25 GMT')).toBe(
      Date.parse('2026-09-15T16:23:25Z'),
    );
    expect(parseRfc822Date('15 Sep 2026 16:23:25 -0400')).toBe(Date.parse('2026-09-15T20:23:25Z'));
    expect(parseRfc822Date('Fri, 11 Sep 26 14:00:00 EDT')).toBe(Date.parse('2026-09-11T18:00:00Z'));
    expect(parseRfc822Date('Fri, 11 Sep 2026 14:00:00')).toBe(Date.parse('2026-09-11T14:00:00Z'));
    expect(parseRfc822Date('not a date')).toBeNull();
    expect(parseRfc822Date('Tue, 32 Sep 2026 16:23:25 GMT')).toBeNull();
  });

  it('drops an item published more than 24 hours after the capture', () => {
    const feed =
      '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" ' +
      'xmlns:atom="http://www.w3.org/2005/Atom"><channel>' +
      '<atom:link href="https://www.bloomberg.com/feeds/markets/news.rss" rel="self"/>' +
      '<language>en</language>' +
      '<lastBuildDate>Tue, 15 Sep 2026 18:40:06 GMT</lastBuildDate>' +
      '<item><title>Now</title><link>https://www.bloomberg.com/news/articles/a</link>' +
      '<guid isPermaLink="false">AAA</guid>' +
      '<pubDate>Tue, 15 Sep 2026 17:00:00 GMT</pubDate></item>' +
      '<item><title>Later</title><link>https://www.bloomberg.com/news/articles/b</link>' +
      '<guid isPermaLink="false">BBB</guid>' +
      '<pubDate>Fri, 18 Sep 2026 17:00:00 GMT</pubDate></item>' +
      '</channel></rss>';
    const { rows, problems } = parseBbgRss(feed, Date.parse('2026-09-15T18:44:51Z'));
    expect(rows.items.map((i) => i.providerGuid)).toEqual(['AAA']);
    expect(problems.map((p) => p.kind)).toEqual(['out_of_range']);
  });

  it('drops a duplicate guid inside one payload and across feeds', () => {
    const items = [
      { providerGuid: 'A', feed: 'markets' },
      { providerGuid: 'A', feed: 'economics' },
      { providerGuid: 'B', feed: 'economics' },
    ] as Parameters<typeof dedupeByGuid>[0];
    // First feed polled owns the `feed` column — one story, one row (§11.1).
    expect(dedupeByGuid(items).map((i) => [i.providerGuid, i.feed])).toEqual([
      ['A', 'markets'],
      ['B', 'economics'],
    ]);
  });

  it('marks a correction from the headline or the summary', () => {
    expect(CORRECTION_RE.test('CORRECT: Apple Earnings Were Not Reported Twice')).toBe(true);
    expect(CORRECTION_RE.test('Fixes headline to say September')).toBe(true);
    expect(CORRECTION_RE.test('Corrective Action Taken by Regulator')).toBe(false);
  });

  it('derives the feed name from a URL and cleans control characters', () => {
    expect(feedFromUrl('https://www.bloomberg.com/feeds/technology/news.rss')).toBe('technology');
    expect(feedFromUrl('http://bloomberg.com/markets/')).toBe('markets');
    expect(feedFromUrl('https://example.com/news.rss')).toBeNull();
    expect(feedFromUrl('not a url')).toBeNull();
    expect(cleanText('a b  c\n d')).toBe('ab c d');
  });

  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([bbgRssAdapter]);
    expect(registry.ids()).toEqual(['bbg.rss']);
    expect(bbgRssAdapter.adapterVersion).toBe(BBG_RSS_ADAPTER_VERSION);
    expect(bbgRssAdapter.sourceId).toBe('bbg.rss');
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = raw.body.toString('utf8');
    for (const candidate of [
      '',
      '<rss>',
      '<rss><channel></channel></rss>',
      '<rss><channel><item></item></channel></rss>',
      text.slice(0, 4_000),
      text.slice(300),
    ]) {
      expect(() => parseBbgRss(candidate, raw.capturedAt)).not.toThrow();
    }
  });
});
