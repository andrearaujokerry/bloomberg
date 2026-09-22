/**
 * QA-02 — `fed.rss` over `fed-press-rss.xml`. WORKPLAN WP-05, PROVIDERS.b §11.2.
 *
 * Three things this capture exists to prove, all of which would silently produce "the Fed
 * published nothing" if they were wrong: the UTF-8 BOM before `<?xml>` is stripped, `<guid>` is
 * the article URL and is still the dedupe key, and `<pubDate>` is CDATA with trailing whitespace.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FED_PRESS_FEED_URL,
  FED_RSS_ADAPTER_VERSION,
  fedRssAdapter,
} from '../../../src/providers/fedRss/adapter.js';
import {
  FED_FEED,
  FED_RATES_TOPIC,
  FED_TOPIC,
  normaliseFedRss,
  parseFedRss,
  parseTargetRange,
} from '../../../src/providers/fedRss/parse.js';
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

const raw = store.replay({ providerId: 'fed.rss', url: FED_PRESS_FEED_URL });

describe('fed.rss replay (§11.2)', () => {
  it('the adapter URL derives the recorded request key', () => {
    expect(FED_PRESS_FEED_URL).toBe('https://www.federalreserve.gov/feeds/press_all.xml');
    expect(store.has(requestKey('fed.rss', 'GET', FED_PRESS_FEED_URL))).toBe(true);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(14_620);
    // The capture really does start with a BOM — the reason §11.2 names it.
    expect([raw.body[0], raw.body[1], raw.body[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseFedRss(raw, ctxOf(raw)))).toBe(goldenText('fed-press-rss.xml.json'));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseFedRss(raw, ctxOf(raw));
    expect(out.problems).toHaveLength(0);
    expect(out.updates).toHaveLength(0);
    expect(out.rows.lang).toBe('en');

    // Twenty press releases, 16 July to 11 September 2026, ascending.
    expect(out.rows.items).toHaveLength(20);
    expect(out.rows.items.map((i) => i.publishedAt)).toEqual(
      [...out.rows.items.map((i) => i.publishedAt)].sort(),
    );
    expect(out.rows.items[0]?.publishedAt).toBe('2026-07-16T15:00:00Z');
    expect(out.rows.items.at(-1)?.publishedAt).toBe('2026-09-11T14:00:00Z');
    expect(out.sourceTs?.toISOString()).toBe('2026-09-11T14:00:00.000Z');

    // Every row: feed, kind, guid = url, no byline, never machine-generated.
    expect(out.rows.items.every((i) => i.feed === FED_FEED)).toBe(true);
    expect(out.rows.items.every((i) => i.kind === 'fed_release')).toBe(true);
    expect(out.rows.items.every((i) => i.author === null && i.cik === null)).toBe(true);
    expect(out.rows.items.every((i) => i.machineGenerated === false)).toBe(true);
    expect(
      out.rows.items.every((i) =>
        i.providerGuid.startsWith('https://www.federalreserve.gov/newsevents/'),
      ),
    ).toBe(true);
    expect(out.rows.items.every((i) => i.providerGuid === i.url)).toBe(true);
    expect(new Set(out.rows.items.map((i) => i.providerGuid)).size).toBe(20);

    // Field coverage: headline, summary and category on all twenty.
    expect(out.rows.items.every((i) => i.headline !== '')).toBe(true);
    expect(out.rows.items.every((i) => i.summary !== null)).toBe(true);
    expect(out.rows.items.every((i) => i.category !== null)).toBe(true);
    const categories = new Map<string, number>();
    for (const item of out.rows.items) {
      categories.set(item.category!, (categories.get(item.category!) ?? 0) + 1);
    }
    expect(Object.fromEntries(categories)).toEqual({
      'Enforcement Actions': 8,
      'Banking and Consumer Regulatory Policy': 5,
      'Orders on Banking Applications': 4,
      'Monetary Policy': 3,
    });

    // Topic links: FED on every item, RATES additionally on the three Monetary Policy ones.
    expect(out.rows.topicLinks).toHaveLength(23);
    expect(out.rows.topicLinks.filter((l) => l.code === FED_TOPIC)).toHaveLength(20);
    expect(out.rows.topicLinks.filter((l) => l.code === FED_RATES_TOPIC)).toHaveLength(3);
    expect(out.rows.topicLinks.every((l) => l.confidence === 1 && l.method === 'feed_topic')).toBe(
      true,
    );

    // Three policy candidates, none of which states a target range in its headline — so none
    // carries a decision, rather than one carrying a guess.
    expect(out.rows.policy).toHaveLength(3);
    expect(out.rows.policy.every((p) => p.targetFromPct === null && p.targetToPct === null)).toBe(
      true,
    );
    expect(out.rows.policy.map((p) => p.headline)).toEqual([
      'Federal Reserve issues FOMC statement',
      'Minutes of the Federal Open Market Committee, July 28–29, 2026',
      "Minutes of the Board's discount rate meetings on July 20 and July 29, 2026",
    ]);
  });

  it('decodes the HTML entities the Fed escapes inside its CDATA', () => {
    const out = normaliseFedRss(raw, ctxOf(raw));
    const minutes = out.rows.items.find((i) => i.headline.startsWith("Minutes of the Board's"));
    expect(minutes?.summary).toContain("Board's");
    expect(minutes?.summary).not.toContain('&#39;');
    const insiders = out.rows.items.find((i) => (i.summary ?? '').includes('insiders'));
    expect(insiders?.summary).toContain('"insiders"');
    expect(insiders?.summary).not.toContain('&quot;');
  });

  it('reads a target range only when the text states one', () => {
    expect(parseTargetRange('lowering the target range to 3.5 to 3.75 percent')).toEqual({
      from: 3.5,
      to: 3.75,
    });
    expect(parseTargetRange('target range of 4 - 4.25 percent')).toEqual({ from: 4, to: 4.25 });
    expect(parseTargetRange('Federal Reserve issues FOMC statement')).toBeNull();
    expect(parseTargetRange('3-1/2 to 3-3/4 percent')).toBeNull();
    expect(parseTargetRange('99 to 100 percent')).toBeNull();
  });

  it('still parses when the BOM is absent', () => {
    const withoutBom = raw.body.subarray(3);
    const { rows, problems } = parseFedRss(withoutBom, raw.capturedAt);
    expect(rows.items).toHaveLength(20);
    expect(problems).toHaveLength(0);
  });

  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([fedRssAdapter]);
    expect(registry.ids()).toEqual(['fed.rss']);
    expect(fedRssAdapter.adapterVersion).toBe(FED_RSS_ADAPTER_VERSION);
    expect(fedRssAdapter.sourceId).toBe('fed.rss');
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = raw.body.toString('utf8');
    for (const candidate of [
      '',
      '﻿',
      '<rss><channel></channel></rss>',
      '<rss><channel><item><guid>x</guid></item></channel></rss>',
      text.slice(0, 3_000),
      text.slice(400),
    ]) {
      expect(() => parseFedRss(candidate, raw.capturedAt)).not.toThrow();
    }
  });
});
