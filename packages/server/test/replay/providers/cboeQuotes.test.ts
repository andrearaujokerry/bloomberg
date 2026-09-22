/**
 * `cboe.quotes` over its three recorded captures — QA-02, PROVIDERS.a §5.1.
 *
 * The three captures are the three branches of §5.1 and are chosen to be exactly that: `AAPL` is
 * a stock with a two-sided book and a real volume, `_SPX` is an index that *does* publish a book
 * (`bid 7584.49 / bid_size 1`) and `^VIX` is an index that publishes `0/0`. A parser that drops
 * "index" books wholesale passes on VIX and silently blanks SPX's bid; a parser that keeps zeros
 * renders `0.00` on VIX where a `--` belongs. Both are asserted here.
 */

import { describe, expect, it } from 'vitest';

import {
  cboeQuoteUrl,
  cboeQuotesAdapter,
  registerCboeAdapters,
  CBOE_ADAPTER_VERSION,
} from '../../../src/providers/cboe/adapter.js';
import { DuplicateProviderError, ProviderRegistry } from '../../../src/providers/registry.js';
import {
  normaliseQuote,
  parseCboeEasternMs,
  parseCboeUtcMs,
} from '../../../src/providers/cboe/parse.js';
import type { RawRecord } from '../../../src/providers/types.js';
import {
  CAPTURES,
  capture,
  goldenOf,
  keyFor,
  quoteContext,
  readGolden,
  serialiseGolden,
  store,
} from './cboeFixtures.js';

const CASES = [CAPTURES.aapl, CAPTURES.spx, CAPTURES.vix] as const;

function parsed(spec: (typeof CASES)[number]) {
  const raw = capture(spec.providerId, spec.url);
  return { raw, result: normaliseQuote(raw, quoteContext(raw), { sourceId: 'cboe.quotes' }) };
}

describe('cboe.quotes — the recorded captures', () => {
  it('reads all three through the replay store, never a socket', () => {
    for (const spec of CASES) {
      const raw = capture(spec.providerId, spec.url);
      expect(raw.origin).toBe('replay');
      expect(raw.status).toBe(200);
      expect(raw.providerId).toBe('cboe.quotes');
      // The key the adapter's own URL derives is the key `manifest.json` filed the capture under.
      expect(raw.requestKey).toBe(keyFor(spec.providerId, spec.url));
      expect(store.has(raw.requestKey)).toBe(true);
    }
  });

  it('the adapter builds the URL the manifest recorded', () => {
    expect(cboeQuoteUrl('AAPL')).toBe(
      'https://cdn.cboe.com/api/global/delayed_quotes/quotes/AAPL.json',
    );
    expect(cboeQuoteUrl('_SPX')).toBe(
      'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json',
    );
    expect(store.entry(keyFor('cboe.quotes', cboeQuoteUrl('_VIX')))?.url).toBe(
      cboeQuoteUrl('_VIX'),
    );
    expect(cboeQuotesAdapter.id).toBe('cboe.quotes');
    expect(cboeQuotesAdapter.sourceId).toBe('cboe.quotes');
    expect(cboeQuotesAdapter.adapterVersion).toBe(CBOE_ADAPTER_VERSION);
  });

  it.each(CASES.map((spec) => [spec.golden, spec] as const))(
    'parse.ts over the capture equals the committed golden %s',
    (_name, spec) => {
      const { result } = parsed(spec);
      expect(serialiseGolden(result)).toBe(readGolden(spec.golden));
      expect(goldenOf(result)).toEqual(JSON.parse(readGolden(spec.golden)));
    },
  );
});

describe('cboe.quotes — §5.1 parse rules', () => {
  it('AAPL: the full stock line, with the naive ET last trade converted to UTC', () => {
    const { raw, result } = parsed(CAPTURES.aapl);
    expect(result.problems).toEqual([]);
    expect(result.updates).toHaveLength(1);
    const update = result.updates[0]!;

    expect(update.subject).toBe('q:101');
    expect(update.mdLineId).toBe(5101);
    expect(update.fields).toEqual({
      PX_LAST: 330.27,
      LAST_TRADE_TIME: Date.parse('2026-09-15T18:26:26Z'),
      PX_BID: 330.25,
      PX_ASK: 330.28,
      BID_SIZE: 40,
      ASK_SIZE: 120,
      PX_OPEN: 330.24,
      PX_HIGH: 331.59,
      PX_LOW: 328.35,
      PX_CLOSE_1D: 333.08,
      PX_VOLUME: 16_591_786,
      IVOL_30D: 24.427,
    });

    // FEED-05: `src` is the provider instant, `cap` the fetch completion. 14:26:26 EDT is
    // 18:26:26Z — the four-hour error a naive `Date.parse` would make is the whole point.
    expect(update.ts.src).toBe(Date.parse('2026-09-15T18:26:26Z'));
    expect(update.ts.cap).toBe(raw.capturedAt);
    expect(update.prov).toEqual({
      sourceId: 'cboe.quotes',
      provenanceId: 900_101,
      srcSeq: 15_972_883_317,
    });

    // The top-level timestamp is UTC and becomes `provenance.source_ts` — a different instant
    // from `last_trade_time`, 15 minutes later, which is the delay this licence carries.
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T18:41:28.000Z');
  });

  it('_SPX: an index that publishes a book keeps it; its zero volume is dropped', () => {
    const { result } = parsed(CAPTURES.spx);
    const fields = result.updates[0]!.fields;
    expect(fields.PX_BID).toBe(7584.4902);
    expect(fields.BID_SIZE).toBe(1);
    expect(fields.PX_ASK).toBe(7587.2002);
    // `volume 0` on an index is "not applicable", not zero (§5 preamble rule 2).
    expect(fields.PX_VOLUME).toBeUndefined();
    expect(result.rows.quoteTicks[0]!.volume).toBeNull();
  });

  it('^VIX: a 0/0 book is absent, not zero', () => {
    const { result } = parsed(CAPTURES.vix);
    const fields = result.updates[0]!.fields;
    expect(fields.PX_BID).toBeUndefined();
    expect(fields.PX_ASK).toBeUndefined();
    expect(fields.BID_SIZE).toBeUndefined();
    expect(fields.ASK_SIZE).toBeUndefined();
    expect(fields.PX_LAST).toBe(17.5);
    const row = result.rows.quoteTicks[0]!;
    expect([row.bid, row.ask, row.bidSize, row.askSize]).toEqual([null, null, null, null]);
  });

  it('never publishes the provider’s derived fields, but carries them for QA-03', () => {
    const { result } = parsed(CAPTURES.aapl);
    const fields = result.updates[0]!.fields as Record<string, unknown>;
    expect(fields.CHG_NET_1D).toBeUndefined();
    expect(fields.CHG_PCT_1D).toBeUndefined();
    expect(fields.TICK_DIR).toBeUndefined();
    expect(result.rows.quoteTicks[0]!.tickDir).toBeNull();
    expect(result.rows.crossChecks).toEqual([
      {
        providerSymbol: 'AAPL',
        securityType: 'stock',
        exchangeId: 2,
        currentPrice: 330.27,
        prevDayClose: 333.08,
        priceChange: -2.81,
        priceChangePercent: -0.8436,
        tick: 'down',
      },
    ]);
  });

  it('publishes PX_OFFICIAL_CLOSE only once the session is stated closed', () => {
    const raw = capture(CAPTURES.aapl.providerId, CAPTURES.aapl.url);
    // Intra-session Cboe sets `close = current_price` (330.27 both): publishing that would be a
    // fake official close, so the zero-knowledge path publishes none.
    const blind = normaliseQuote(raw, quoteContext(raw));
    expect(blind.updates[0]!.fields.PX_OFFICIAL_CLOSE).toBeUndefined();

    const closed = normaliseQuote(raw, quoteContext(raw), { session: 'closed' });
    expect(closed.updates[0]!.fields.PX_OFFICIAL_CLOSE).toBe(330.27);
    expect(closed.updates[0]!.session).toBe('closed');
    expect(closed.rows.quoteTicks[0]!.sessionState).toBe('closed');

    const open = normaliseQuote(raw, quoteContext(raw), { session: 'open' });
    expect(open.updates[0]!.fields.PX_OFFICIAL_CLOSE).toBeUndefined();
  });

  it('drops a print outside the sanity band instead of publishing it', () => {
    const raw = capture(CAPTURES.aapl.providerId, CAPTURES.aapl.url);
    const body = raw.body
      .toString('utf8')
      .replace('"current_price": 330.27', '"current_price": 3.3');
    const result = normaliseQuote({ ...raw, body: Buffer.from(body, 'utf8') }, quoteContext(raw));
    expect(result.updates).toEqual([]);
    expect(result.rows.quoteTicks).toEqual([]);
    expect(result.problems.map((p) => p.kind)).toEqual(['out_of_range']);
    expect(result.problems[0]!.detail).toContain('3.3');
    expect(result.problems[0]!.detail).toContain('333.08');
  });

  it('reports an unknown provider symbol rather than guessing an instrument', () => {
    const raw = capture(CAPTURES.aapl.providerId, CAPTURES.aapl.url);
    const result = normaliseQuote(raw, { ...quoteContext(raw), lines: new Map() });
    expect(result.updates).toEqual([]);
    expect(result.problems.map((p) => p.kind)).toEqual(['unknown_symbol']);
    // The payload instant is still known, so the provenance row is still stampable.
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T18:41:28.000Z');
  });
});

describe('cboe.quotes — the timestamp conventions of §5', () => {
  it('reads the top-level timestamp as UTC and last_trade_time as naive ET', () => {
    expect(parseCboeUtcMs('2026-09-15 18:41:28')).toBe(Date.parse('2026-09-15T18:41:28Z'));
    // September is EDT (UTC−4)…
    expect(parseCboeEasternMs('2026-09-15T14:26:26')).toBe(Date.parse('2026-09-15T18:26:26Z'));
    // …January is EST (UTC−5). The offset is read from the date, never assumed.
    expect(parseCboeEasternMs('2026-01-15T14:26:26')).toBe(Date.parse('2026-01-15T19:26:26Z'));
    // The 2026 transitions: 8 March and 1 November, at 02:00 local.
    expect(parseCboeEasternMs('2026-03-08T01:59:59')).toBe(Date.parse('2026-03-08T06:59:59Z'));
    expect(parseCboeEasternMs('2026-03-08T03:00:00')).toBe(Date.parse('2026-03-08T07:00:00Z'));
    // The ambiguous hour of the fall-back resolves to its first occurrence, EDT.
    expect(parseCboeEasternMs('2026-11-01T01:59:59')).toBe(Date.parse('2026-11-01T05:59:59Z'));
    expect(parseCboeEasternMs('2026-11-01T02:00:00')).toBe(Date.parse('2026-11-01T07:00:00Z'));
  });

  it('rejects malformed instants instead of inventing one', () => {
    expect(parseCboeUtcMs('2026-02-30 10:00:00')).toBeNull();
    expect(parseCboeUtcMs('2026-09-15T18:41:28Z')).toBeNull();
    expect(parseCboeEasternMs(null)).toBeNull();
    expect(parseCboeEasternMs('yesterday')).toBeNull();
  });
});

describe('cboe.quotes — QA-05: parse never throws', () => {
  const raw = capture(CAPTURES.aapl.providerId, CAPTURES.aapl.url);
  const text = raw.body.toString('utf8');
  const mutate = (body: string): RawRecord => ({ ...raw, body: Buffer.from(body, 'utf8') });

  const corruptions: [string, string][] = [
    ['truncated at 40 bytes', text.slice(0, 40)],
    ['truncated mid-number', text.slice(0, text.indexOf('330.27') + 3)],
    ['empty', ''],
    ['not JSON', '<html>503</html>'],
    ['a JSON array', '[1,2,3]'],
    ['data is a string', '{"timestamp":"2026-09-15 18:41:28","data":"nope","symbol":"AAPL"}'],
    ['no symbol', '{"timestamp":"2026-09-15 18:41:28","data":{}}'],
    ['nulls everywhere', text.replace(/: -?\d+(\.\d+)?/g, ': null')],
    ['strings for numbers', text.replace(/: (-?\d+\.\d+)/g, ': "$1"')],
  ];

  it.each(corruptions)('returns a parse-error result on %s', (_name, body) => {
    const result = normaliseQuote(mutate(body), quoteContext(raw));
    expect(Array.isArray(result.updates)).toBe(true);
    expect(Array.isArray(result.problems)).toBe(true);
  });

  it('survives every single-byte truncation of the capture', () => {
    for (let i = 0; i <= text.length; i++) {
      const result = normaliseQuote(mutate(text.slice(0, i)), quoteContext(raw));
      expect(result).toBeDefined();
    }
  });

  it('tolerates numbers that arrive as strings', () => {
    const result = normaliseQuote(
      mutate(text.replace(/: (-?\d+\.\d+)/g, ': "$1"')),
      quoteContext(raw),
    );
    expect(result.updates[0]!.fields.PX_LAST).toBe(330.27);
  });
});

describe('the Cboe family in the ProviderRegistry', () => {
  it('registers all four under their licence_registry source ids', () => {
    const registry = registerCboeAdapters(new ProviderRegistry());
    expect(registry.ids()).toEqual([
      'cboe.quotes',
      'cboe.options',
      'cboe.symbolBook',
      'cboe.euIndices',
    ]);
    for (const adapter of registry.all()) {
      // DATA-09: an adapter's ProviderId IS its `licence_registry.source_id`, and §1.4 fixes the
      // `<family>/<semver>` shape of what goes into `provenance.adapter_version`.
      expect(adapter.sourceId).toBe(adapter.id);
      expect(adapter.adapterVersion).toBe('cboe/1.0.0');
    }
    // §2.6: the 2.2 MB daily universe file is never fetched by the interactive read-through.
    expect(registry.isSchedulerOnly('cboe.symbolBook')).toBe(true);
    expect(registry.isSchedulerOnly('cboe.quotes')).toBe(false);
    // One adapter per id (§1.1): a second registration is a startup failure, not a replacement.
    expect(() => registerCboeAdapters(registry)).toThrow(DuplicateProviderError);
  });

  it('refuses a symbol that would change the request key', () => {
    expect(() => cboeQuoteUrl('../../secrets')).toThrow();
    expect(() => cboeQuoteUrl('')).toThrow();
    expect(() => cboeQuoteUrl('AAPL?x=1')).toThrow();
  });
});
