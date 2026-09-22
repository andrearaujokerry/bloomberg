/**
 * QA-02 for `yahoo.search` — WORKPLAN WP-05 L838, PROVIDERS.md §5.6.
 *
 * The capture is `yahoo-search` (`q=apple`, `quotesCount=8`, `newsCount=0`): seven `quotes[]`
 * elements, read through the replay store and compared against the committed golden.
 *
 * This adapter writes nothing — it is the fallback block behind `GET /api/v1/search` — so the
 * assertions are about what survives the filter and what is deliberately thrown away.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  searchUrl,
  yahooSearchAdapter,
  type YahooSearchRequest,
  type YahooSearchRows,
} from '../../../src/providers/yahoo/adapter.js';
import { QUOTE_TYPE_ASSET_CLASS, parseYahooSearch } from '../../../src/providers/yahoo/parse.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import type { NormaliseContext } from '../../../src/providers/types.js';

const store = openReplayStore();
const request: YahooSearchRequest = { query: 'apple' };
const raw = store.replay({ providerId: 'yahoo.search', url: searchUrl(request) });
const parsed = parseYahooSearch({ body: raw.body, url: raw.url });

const golden = readFileSync(join(store.dir, 'normalised', 'yahoo-search.json'), 'utf8');

const ctx: NormaliseContext = { provenanceId: 5, capturedAt: raw.capturedAt, lines: new Map() };

describe('yahoo.search replay', () => {
  it('builds the URL the capture was recorded against — query2, not query1', () => {
    expect(searchUrl(request)).toBe(
      'https://query2.finance.yahoo.com/v1/finance/search?q=apple&quotesCount=8&newsCount=0',
    );
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.providerId).toBe('yahoo.search');
  });

  it('equals the committed golden byte for byte', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(golden);
  });

  it('keeps all seven quotes and maps every quoteType to an asset class', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.query).toBe('apple');
    expect(parsed.reportedCount).toBe(7);
    expect(parsed.quotes).toHaveLength(7);
    expect(parsed.problems).toEqual([]);

    expect(parsed.quotes.map((quote) => quote.symbol)).toEqual([
      'AAPL',
      'SAAPL=F',
      'XAAPL=F',
      'APLE',
      'AAPL.TO',
      'AAPX',
      'APC.DE',
    ]);
    expect(parsed.quotes.map((quote) => quote.assetClass)).toEqual([
      'equity',
      'future',
      'future',
      'equity',
      'equity',
      'etf',
      'equity',
    ]);
    expect(parsed.quotes[0]).toEqual({
      symbol: 'AAPL',
      shortName: 'Apple Inc.',
      longName: 'Apple Inc.',
      exchange: 'NMS',
      exchDisp: 'NASDAQ',
      quoteType: 'EQUITY',
      typeDisp: 'Equity',
      assetClass: 'equity',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      score: 377_681,
    });
    // Yahoo's order is its own relevance order and is preserved; the score rides along but is
    // never merged into our ranking (§5.6).
    const scores = parsed.quotes.map((quote) => quote.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('ignores news, nav, lists, researchReports and every timeTakenFor* field', () => {
    const document = JSON.parse(raw.body.toString('utf8')) as Record<string, unknown>;
    // The capture really does carry those keys — the parser's silence about them is a choice.
    for (const key of ['news', 'nav', 'lists', 'researchReports', 'screenerFieldResults']) {
      expect(document[key]).toBeDefined();
    }
    expect(Object.keys(document).some((key) => key.startsWith('timeTakenFor'))).toBe(true);
    expect(`${JSON.stringify(parsed)}`).not.toContain('timeTakenFor');
  });

  it('skips an element with no symbol, discards an unmappable quoteType, flags a mutual fund', () => {
    const result = parseYahooSearch({
      body: JSON.stringify({
        count: 4,
        quotes: [
          { symbol: 'VFIAX', quoteType: 'MUTUALFUND', shortname: 'Vanguard 500' },
          { quoteType: 'EQUITY', shortname: 'nameless' },
          { symbol: 'XYZ', quoteType: 'ECNQUOTE' },
          { symbol: 'BTC-USD', quoteType: 'CRYPTOCURRENCY' },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.quotes.map((quote) => quote.symbol)).toEqual(['VFIAX', 'BTC-USD']);
    expect(result.quotes[0]?.assetClass).toBe('etf');
    expect(result.quotes[1]?.assetClass).toBe('crypto');
    expect(result.problems.map((problem) => problem.kind)).toEqual([
      'field_dropped',
      'field_dropped',
      'field_dropped',
    ]);
    expect(result.problems[0]?.detail).toContain('MUTUALFUND');
    expect(result.problems[1]?.detail).toContain('no symbol');
    expect(result.problems[2]?.detail).toContain('ECNQUOTE');
    expect(QUOTE_TYPE_ASSET_CLASS.ECNQUOTE).toBeUndefined();
  });

  it('never throws on malformed input', () => {
    for (const body of [
      '',
      '{',
      '[]',
      'null',
      '{"quotes":{}}',
      raw.body.toString('utf8').slice(0, 300),
    ]) {
      const result = parseYahooSearch({ body });
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
    }
  });
});

describe('yahooSearchAdapter.normalise', () => {
  it('produces no updates and no stored value — the rows are the fallback block', () => {
    const result = yahooSearchAdapter.normalise(raw, ctx);
    expect(result.updates).toEqual([]);
    expect(result.sourceTs).toBeNull();
    expect(result.rows.quotes).toHaveLength(7);
    expect(result.rows.quotes[0]?.symbol).toBe('AAPL');
  });

  it('is registered under its own licence_registry source id', () => {
    const registry = new ProviderRegistry();
    registry.register(yahooSearchAdapter);
    expect(registry.require<YahooSearchRequest, YahooSearchRows>('yahoo.search').sourceId).toBe(
      'yahoo.search',
    );
  });
});
