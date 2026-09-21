/**
 * QA-02 / PROVIDERS.a §3.2-§3.6 — the request key, the canonical URL and the replay wall.
 *
 * The committed `fixtures/providers/manifest.json` is the oracle: 47 keys were computed by
 * `scripts/fixtures-import.ts` from the recorded URLs, and every one of them must fall out of
 * `requestKey()` again. If this file goes red, every replay test in the suite is looking up the
 * wrong bytes — which is exactly the failure mode the key exists to prevent.
 *
 * Nothing here opens a socket or a database connection.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DuplicateProviderError,
  ProviderRegistry,
  UnknownProviderError,
} from '../../../src/providers/registry.js';
import {
  canonicalUrl,
  extensionForContentType,
  manifestPath,
  openReplayStore,
  readManifest,
  ReplayMissError,
  requestHash,
  requestKey,
  serialiseManifest,
} from '../../../src/providers/replayStore.js';
import {
  assertProviderIdsMatchLicences,
  isProviderId,
  NON_ADAPTER_SOURCE_IDS,
  PROVIDER_IDS,
  type HttpClient,
  type Normalised,
  type ProviderAdapter,
  type RawRecord,
} from '../../../src/providers/types.js';
import { licenceSourceIds } from '../../../src/providers/licences.js';

/** The default `REPLAY_DIR` — `config.ts` resolves it relative to the server package. */
const store = openReplayStore();
const manifest = readManifest('../../fixtures/providers');

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('requestKey (PROVIDERS.a §3.2)', () => {
  it('reproduces every key in the committed manifest', () => {
    const entries = Object.entries(manifest);
    expect(entries.length).toBe(47);

    for (const [key, entry] of entries) {
      expect(requestKey(entry.providerId, entry.method, entry.url, entry.body)).toBe(key);
    }
  });

  it('is the documented composition of sha256 over provider, method, canonical URL and body', () => {
    const url = 'https://api.frankfurter.dev/v1/latest?base=USD';
    expect(requestKey('frankfurter', 'GET', url)).toBe(
      sha256(`frankfurter|GET|${url}|${sha256('')}`),
    );
  });

  it('is stable under query reordering, host case, a default port and a fragment', () => {
    const recorded =
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?events=div%7Csplit&interval=1d&range=max';
    const key = requestKey('yahoo.chart', 'GET', recorded);

    // Same request, spelled by four different callers.
    const spellings = [
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=max&interval=1d&events=div%7Csplit',
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&events=div|split&range=max',
      'https://QUERY1.Finance.Yahoo.COM:443/v8/finance/chart/AAPL?range=max&events=div%7Csplit&interval=1d',
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?events=div%7Csplit&interval=1d&range=max#chart',
    ];
    for (const spelling of spellings) {
      expect(canonicalUrl(spelling)).toBe(recorded);
      expect(requestKey('yahoo.chart', 'GET', spelling)).toBe(key);
    }

    // …and it is the key the manifest already holds.
    expect(store.has(key)).toBe(true);
  });

  it('differs on a body change, including a reordering of the same JSON', () => {
    const url = 'https://api.openfigi.com/v3/mapping';
    const recorded =
      '[{"idType":"TICKER","idValue":"AAPL","exchCode":"US"},{"idType":"TICKER","idValue":"AAPL"}]';
    const reordered =
      '[{"idValue":"AAPL","idType":"TICKER","exchCode":"US"},{"idType":"TICKER","idValue":"AAPL"}]';
    const changed =
      '[{"idType":"TICKER","idValue":"MSFT","exchCode":"US"},{"idType":"TICKER","idValue":"AAPL"}]';

    const key = requestKey('openfigi.mapping', 'POST', url, recorded);
    expect(store.has(key)).toBe(true);
    expect(requestKey('openfigi.mapping', 'POST', url, reordered)).not.toBe(key);
    expect(requestKey('openfigi.mapping', 'POST', url, changed)).not.toBe(key);
    // The body is part of the key, so the same URL with no body is a different request.
    expect(requestKey('openfigi.mapping', 'POST', url)).not.toBe(key);
  });

  it('separates method and provider', () => {
    const url = 'https://api.openfigi.com/v3/search';
    expect(requestKey('openfigi.mapping', 'GET', url)).not.toBe(
      requestKey('openfigi.mapping', 'POST', url),
    );
    expect(requestKey('yahoo.chart', 'GET', url)).not.toBe(requestKey('yahoo.search', 'GET', url));
  });

  it('derives request_hash as sha256(method + url + body)', () => {
    const url = 'https://api.frankfurter.dev/v1/latest?base=USD';
    expect(requestHash('GET', url)).toBe(sha256(`GET${url}`));
    expect(requestHash('POST', url, '{"a":1}')).toBe(sha256(`POST${url}{"a":1}`));
  });
});

describe('canonicalUrl (PROVIDERS.a §3.2 steps 1-5)', () => {
  it('is idempotent over every URL the manifest holds', () => {
    for (const entry of Object.values(manifest)) {
      expect(canonicalUrl(entry.url)).toBe(entry.url);
    }
  });

  it('percent-encodes path segments, once', () => {
    expect(canonicalUrl('https://query1.finance.yahoo.com/v8/finance/chart/^GSPC')).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC',
    );
    expect(canonicalUrl('https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC')).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC',
    );
    expect(canonicalUrl('https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X')).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX',
    );
    expect(canonicalUrl('https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json')).toBe(
      'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json',
    );
    // A trailing slash is a different path and is preserved (the BLS POST endpoint has one).
    expect(canonicalUrl('https://api.bls.gov/publicAPI/v2/timeseries/data/')).toBe(
      'https://api.bls.gov/publicAPI/v2/timeseries/data/',
    );
  });

  it('drops an empty parameter name, keeps an empty value, and emits ? only when needed', () => {
    expect(canonicalUrl('https://example.test/p?=orphan&b=2&a=')).toBe(
      'https://example.test/p?a=&b=2',
    );
    expect(canonicalUrl('https://example.test/p?')).toBe('https://example.test/p');
    expect(canonicalUrl('https://example.test/p?#frag')).toBe('https://example.test/p');
  });

  it('sorts by name then by value', () => {
    expect(canonicalUrl('https://example.test/p?a=2&a=1&b=0')).toBe(
      'https://example.test/p?a=1&a=2&b=0',
    );
  });

  it('refuses a relative URL rather than guessing a host', () => {
    expect(() => canonicalUrl('/v8/finance/chart/AAPL')).toThrow(/not an absolute URL/);
  });
});

describe('the replay store', () => {
  it('serves recorded bytes whose sha256 matches the manifest', () => {
    const [key, entry] = Object.entries(manifest).find(
      ([, e]) => e.providerId === 'cboe.quotes' && e.url.endsWith('AAPL.json'),
    )!;
    const raw = store.lookup(key);
    expect(raw).not.toBeNull();
    expect(raw!.providerId).toBe('cboe.quotes');
    expect(raw!.origin).toBe('replay');
    expect(raw!.status).toBe(200);
    expect(raw!.url).toBe(entry.url);
    expect(raw!.requestKey).toBe(key);
    expect(raw!.sha256).toBe(entry.captures[0]!.sha256);
    expect(raw!.body.length).toBe(entry.captures[0]!.bytes);
    expect(raw!.capturedAt).toBe(Date.parse(entry.captures[0]!.capturedAt));
    expect(raw!.headers['content-type']).toBe('application/json');
  });

  it('keeps both captures of a request that was recorded twice (§3.3 captures[])', () => {
    const key = requestKey(
      'yahoo.chart',
      'GET',
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1m',
    );
    expect(store.captureCount(key)).toBe(2);
    const first = store.lookup(key, 0)!;
    const second = store.lookup(key, 1)!;
    expect(second.capturedAt).toBeGreaterThan(first.capturedAt);
    expect(second.sha256).not.toBe(first.sha256);
    // Walking off the end is a miss, not a wrap-around.
    expect(store.lookup(key, 2)).toBeNull();
  });

  it('is a wall: a miss throws ReplayMissError with nearest-URL diagnostics', () => {
    const url = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/MSFT.json';
    let thrown: unknown;
    try {
      store.replay({ providerId: 'cboe.quotes', url });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReplayMissError);
    const miss = thrown as ReplayMissError;
    expect(miss.providerId).toBe('cboe.quotes');
    expect(miss.requestKey).toBe(requestKey('cboe.quotes', 'GET', url));
    expect(miss.nearest).not.toBeNull();
    expect(miss.nearest!.url).toMatch(/delayed_quotes\/quotes\/(AAPL|_SPX|_VIX)\.json$/);
    expect(miss.message).toContain('no capture for cboe.quotes GET');
    expect(miss.message).toContain('npm run fixtures:import');
  });

  it('replays a recorded request by URL', () => {
    const raw = store.replay({
      providerId: 'frankfurter',
      url: 'https://api.frankfurter.dev/v1/latest?base=USD',
    });
    expect(raw.origin).toBe('replay');
    expect(raw.body.length).toBeGreaterThan(0);
    expect(raw.sourceTs).toBeInstanceOf(Date);
  });

  it('serialises the manifest byte-identically to the committed file', () => {
    const onDisk = readFileSync(manifestPath('../../fixtures/providers'), 'utf8');
    expect(serialiseManifest(manifest)).toBe(onDisk);
  });

  it('maps content types to the recorded-file extensions of §3.5', () => {
    expect(extensionForContentType('application/json; charset=utf-8')).toBe('json');
    expect(extensionForContentType('text/csv')).toBe('csv');
    expect(extensionForContentType('application/xml')).toBe('xml');
    expect(extensionForContentType('text/html; charset=utf-8')).toBe('html');
    expect(
      extensionForContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe('xlsx');
    expect(extensionForContentType(undefined)).toBe('bin');
  });
});

describe('ProviderId and the licence registry (DATA-09)', () => {
  it('is exactly licence_registry minus the three non-adapter sources', () => {
    expect(() => {
      assertProviderIdsMatchLicences();
    }).not.toThrow();
    expect(PROVIDER_IDS.length).toBe(30);
    expect(new Set([...PROVIDER_IDS, ...NON_ADAPTER_SOURCE_IDS])).toEqual(
      new Set(licenceSourceIds),
    );
    expect(isProviderId('wiki.sp500')).toBe(false);
    expect(isProviderId('cboe.quotes')).toBe(true);
  });

  it('covers every provider the manifest records', () => {
    for (const entry of Object.values(manifest)) {
      expect(licenceSourceIds).toContain(entry.providerId);
    }
  });
});

describe('ProviderRegistry', () => {
  function stubAdapter(
    id: (typeof PROVIDER_IDS)[number],
    adapterVersion = 'stub/1.0.0',
  ): ProviderAdapter<{ symbol: string }, Record<string, never>> {
    return {
      id,
      sourceId: id,
      adapterVersion,
      fetch(_http: HttpClient, _req: { symbol: string }): Promise<RawRecord> {
        return Promise.reject(new Error('stub adapter never fetches'));
      },
      normalise(): Normalised<Record<string, never>> {
        return { updates: [], rows: {}, sourceTs: null, problems: [] };
      },
    };
  }

  it('registers, looks up and reports what is missing', () => {
    const registry = new ProviderRegistry();
    registry.register(stubAdapter('cboe.quotes'));
    registry.register(stubAdapter('yahoo.chart'), { schedulerOnly: true });

    expect(registry.size).toBe(2);
    expect(registry.ids()).toEqual(['cboe.quotes', 'yahoo.chart']);
    expect(registry.get('cboe.quotes')?.id).toBe('cboe.quotes');
    expect(registry.require('yahoo.chart').adapterVersion).toBe('stub/1.0.0');
    expect(registry.isSchedulerOnly('yahoo.chart')).toBe(true);
    expect(registry.isSchedulerOnly('cboe.quotes')).toBe(false);
    expect(registry.has('sec.tickers')).toBe(false);
    expect(registry.missing()).toContain('sec.tickers');
  });

  it('refuses a duplicate id', () => {
    const registry = new ProviderRegistry();
    registry.register(stubAdapter('cboe.quotes'));
    expect(() => registry.register(stubAdapter('cboe.quotes'))).toThrow(DuplicateProviderError);
    expect(registry.size).toBe(1);
  });

  it('throws UnknownProviderError for an unregistered id', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.require('fed.h15')).toThrow(UnknownProviderError);
    expect(registry.get('fed.h15')).toBeUndefined();
  });

  it('refuses an unlicensed source or a malformed adapter_version', () => {
    const registry = new ProviderRegistry();
    const unlicensed = { ...stubAdapter('cboe.quotes'), sourceId: 'cboe.made-up' };
    expect(() => registry.register(unlicensed)).toThrow(/licence registry/);
    expect(() => registry.register(stubAdapter('cboe.quotes', '1.0.0'))).toThrow(/adapter_version/);
  });
});
