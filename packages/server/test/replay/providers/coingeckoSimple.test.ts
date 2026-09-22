/**
 * QA-02 for `coingecko.simple` — WORKPLAN WP-05 L838, PROVIDERS.md §5.8.
 *
 * The capture is 124 bytes: two coins, a USD price each and a rolling 24-hour percent move. The
 * interesting assertion is the reconstruction, because it is the one place this adapter computes
 * rather than copies:
 *
 *   `PX_CLOSE_1D = usd / (1 + usd_24h_change / 100)` = `75828 / (1 - 0.04217368765220806)`
 *                = `79166.75395368178`
 *
 * That number is a **rolling** 24-hour reference, not a session close. It is published as
 * `PX_CLOSE_1D` so that `core/quote/derive.ts` produces `CHG_NET_1D`/`CHG_PCT_1D` the same way for
 * crypto as for every other asset class, and every row says so through
 * `impliedPrevCloseIsRolling` — the flag CRYP's footnote is driven from.
 *
 * The payload carries no timestamp at all, so `ts.src` and `provenance.source_ts` are `NULL` and
 * staleness rests entirely on `ts.cap`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  coingeckoAdapter,
  registerCoingeckoAdapter,
  simplePriceUrl,
  type CoingeckoRequest,
  type CoingeckoRows,
} from '../../../src/providers/coingecko/adapter.js';
import { impliedPrevClose, parseCoingeckoSimple } from '../../../src/providers/coingecko/parse.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import type { NormaliseContext, NormaliseLine } from '../../../src/providers/types.js';

const store = openReplayStore();
const request: CoingeckoRequest = { ids: ['bitcoin', 'ethereum'] };
const raw = store.replay({ providerId: 'coingecko.simple', url: simplePriceUrl(request) });
const parsed = parseCoingeckoSimple({ body: raw.body, url: raw.url });
const golden = readFileSync(join(store.dir, 'normalised', 'coingecko-simple.json'), 'utf8');

function line(overrides: Partial<NormaliseLine> = {}): NormaliseLine {
  return {
    mdLineId: 20,
    instrumentId: 200,
    assetClass: 'crypto',
    tier: 'delayed',
    intrinsicDelayMin: 0,
    expectedIntervalMs: 60_000,
    priority: 20,
    ...overrides,
  };
}

const ctx = (lines: Record<string, NormaliseLine>): NormaliseContext => ({
  provenanceId: 11,
  capturedAt: raw.capturedAt,
  lines: new Map(Object.entries(lines)),
});

describe('coingecko.simple replay', () => {
  it('builds the URL the capture was recorded against', () => {
    expect(simplePriceUrl(request)).toBe(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum&vs_currencies=usd&include_24hr_change=true',
    );
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(124);
    // §5.8: no source timestamp anywhere in this exchange.
    expect(raw.sourceTs).toBeNull();
  });

  it('equals the committed golden byte for byte', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(golden);
  });

  it('reconstructs the 24-hour-ago price for both coins', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.requestedIds).toEqual(['bitcoin', 'ethereum']);
    expect(parsed.unknownIds).toEqual([]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sourceTsMs).toBeNull();

    expect(parsed.quotes).toEqual([
      {
        id: 'bitcoin',
        usd: 75_828,
        change24hPct: -4.217368765220806,
        impliedPrevClose: 79_166.75395368178,
        impliedPrevCloseIsRolling: true,
      },
      {
        id: 'ethereum',
        usd: 2386.91,
        change24hPct: -6.001270999715535,
        impliedPrevClose: 2539.300292020732,
        impliedPrevCloseIsRolling: true,
      },
    ]);

    // The reconstruction round-trips: applying the reported move to the implied price returns the
    // published one, to floating-point tolerance.
    for (const quote of parsed.quotes) {
      const back = quote.impliedPrevClose! * (1 + quote.change24hPct! / 100);
      expect(back).toBeCloseTo(quote.usd, 9);
    }
  });

  it('never publishes a nonsensical previous close', () => {
    expect(impliedPrevClose(100, -100)).toBeNull();
    expect(impliedPrevClose(100, -150)).toBeNull();
    expect(impliedPrevClose(100, 0)).toBe(100);
    expect(impliedPrevClose(100, 100)).toBe(50);

    const result = parseCoingeckoSimple({
      body: '{"a":{"usd":10,"usd_24h_change":-100},"b":{"usd":5}}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quotes[0]).toEqual({
      id: 'a',
      usd: 10,
      change24hPct: -100,
      impliedPrevClose: null,
      impliedPrevCloseIsRolling: false,
    });
    // `b` simply has no change field: a price with no reference, which is still a usable price.
    expect(result.quotes[1]).toMatchObject({ id: 'b', usd: 5, change24hPct: null });
    expect(result.problems.map((problem) => problem.kind)).toEqual(['out_of_range']);
  });

  it('reports an id CoinGecko does not know, and does not confuse it with a bad price', () => {
    const result = parseCoingeckoSimple({
      body: '{"bitcoin":{"usd":75828},"dogecoin":{}}',
      url: simplePriceUrl({ ids: ['bitcoin', 'dogecoin', 'nosuchcoin'] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.unknownIds).toEqual(['nosuchcoin']);
    expect(result.quotes.map((quote) => quote.id)).toEqual(['bitcoin']);
    // `dogecoin` was answered but carried no price: a dropped field, not an unknown symbol.
    expect(result.problems).toEqual([
      {
        kind: 'field_dropped',
        detail: "'dogecoin' has no usable usd price",
        path: '/dogecoin/usd',
      },
      {
        kind: 'unknown_symbol',
        detail: "CoinGecko returned no entry for id 'nosuchcoin'",
        path: '/nosuchcoin',
      },
    ]);
  });

  it('never throws on malformed input', () => {
    for (const body of ['', '{', '[]', 'null', '{"bitcoin":5}', '{"bitcoin":{"usd":"75828"}}']) {
      const result = parseCoingeckoSimple({ body });
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
    }
  });
});

describe('coingeckoAdapter.normalise', () => {
  it('ticks q: lines with a null source timestamp and an always-open session', () => {
    const result = coingeckoAdapter.normalise(
      raw,
      ctx({ bitcoin: line(), ethereum: line({ mdLineId: 21, instrumentId: 201 }) }),
    );

    expect(result.sourceTs).toBeNull();
    expect(result.problems).toEqual([]);
    expect(result.updates).toHaveLength(2);

    const bitcoin = result.updates[0]!;
    expect(bitcoin.subject).toBe('q:200');
    expect(bitcoin.fields).toEqual({
      PX_LAST: 75_828,
      SESSION_STATE: 'open',
      PX_CLOSE_1D: 79_166.75395368178,
    });
    expect(bitcoin.ts).toEqual({ src: null, cap: raw.capturedAt, pub: raw.capturedAt });
    expect(bitcoin.session).toBe('open');
    expect(bitcoin.prov).toEqual({ sourceId: 'coingecko.simple', provenanceId: 11 });

    expect(result.rows.quoteTicks).toHaveLength(2);
    expect(result.rows.quoteTicks[0]).toEqual({
      captureTs: new Date(raw.capturedAt).toISOString(),
      instrumentId: 200,
      mdLineId: 20,
      kind: 'summary',
      sourceTs: null,
      publishTs: new Date(raw.capturedAt).toISOString(),
      price: 75_828,
      prevClose: 79_166.75395368178,
      sessionState: 'open',
      conditions: ['delayed'],
    });
  });

  it('skips a coin with no md line and says so', () => {
    const result = coingeckoAdapter.normalise(raw, ctx({ bitcoin: line() }));
    expect(result.updates).toHaveLength(1);
    expect(result.rows.quoteTicks).toHaveLength(1);
    expect(result.problems).toEqual([
      {
        kind: 'unknown_symbol',
        detail: "no md_lines row with provider_symbol 'ethereum' for source 'coingecko.simple'",
        path: '/ethereum',
      },
    ]);
  });

  it('is registered under its licence_registry source id', () => {
    const registry = registerCoingeckoAdapter(new ProviderRegistry());
    expect(registry.ids()).toEqual(['coingecko.simple']);
    expect(
      registry.require<CoingeckoRequest, CoingeckoRows>('coingecko.simple').adapterVersion,
    ).toBe('coingecko/1.0.0');
  });
});
