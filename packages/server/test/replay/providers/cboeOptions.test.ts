/**
 * `cboe.options` over `cboe-options` — QA-02, PROVIDERS.a §5.2.
 *
 * One 1.5 MB fetch yields three things, and all three are pinned here: the underlying quote (the
 * §5.1 shape, on the `cboe.options` md line so BUS-05 can compare it against the `cboe.quotes`
 * line), the terms of 3,510 contracts, and 3,510 contract quotes with Cboe's own greeks. The
 * fan-out rule is the fourth: a 1.5 MB payload must not become 3,510 plant updates every 60
 * seconds, so only the ±10 strikes of the money on the front three expiries are published.
 */

import { describe, expect, it } from 'vitest';

import { cboeOptionsAdapter, cboeOptionsUrl } from '../../../src/providers/cboe/adapter.js';
import { isThirdFriday, normaliseChain } from '../../../src/providers/cboe/parse.js';
import type { RawRecord } from '../../../src/providers/types.js';
import {
  CAPTURES,
  capture,
  goldenOf,
  keyFor,
  optionContext,
  readGolden,
  serialiseGolden,
} from './cboeFixtures.js';

const spec = CAPTURES.options;
const raw = capture(spec.providerId, spec.url);
const result = normaliseChain(raw, optionContext(raw), { sourceId: 'cboe.options' });

describe('cboe.options — the recorded capture', () => {
  it('reads 1,562,495 bytes through the replay store', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.byteLength).toBe(1_562_495);
    expect(raw.requestKey).toBe(keyFor(spec.providerId, spec.url));
    expect(cboeOptionsUrl('AAPL')).toBe(
      'https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json',
    );
    expect(cboeOptionsAdapter.sourceId).toBe('cboe.options');
  });

  it('parse.ts over the capture equals the committed golden', () => {
    expect(serialiseGolden(result)).toBe(readGolden(spec.golden));
    expect(goldenOf(result)).toEqual(JSON.parse(readGolden(spec.golden)));
  });
});

describe('cboe.options — the underlying block (§5.2 step 1)', () => {
  it('is the §5.1 shape on the cboe.options md line', () => {
    expect(result.rows.quoteTicks).toHaveLength(1);
    const row = result.rows.quoteTicks[0]!;
    expect(row.mdLineId).toBe(5201);
    expect(row.instrumentId).toBe(101);
    expect(row.price).toBe(330.3);
    expect(row.bid).toBe(330.27);
    expect(row.bidSize).toBe(440);
    expect(row.volume).toBe(16_557_466);
    // Its own line, its own instant: 14:25:27 ET on this payload against 14:26:26 on the
    // `cboe.quotes` capture — the divergence BUS-05 exists to show.
    expect(row.sourceTs).toBe('2026-09-15T18:25:27.000Z');
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T18:40:39.000Z');
    expect(result.updates[0]!.subject).toBe('q:101');
  });
});

describe('cboe.options — contract terms (§5.2 step 2)', () => {
  it('parses all 3,510 OCC symbols with no unparseable contract', () => {
    expect(result.rows.contracts).toHaveLength(3510);
    expect(result.rows.optionQuotes).toHaveLength(3510);
    expect(result.problems.filter((p) => p.kind === 'parse_error')).toEqual([]);
  });

  it('carries the fixed terms of §5.2 and splits weeklies from monthlies', () => {
    const first = result.rows.contracts[0]!;
    expect(first).toMatchObject({
      occSymbol: 'AAPL260916C00245000',
      root: 'AAPL',
      expiry: '2026-09-16',
      putCall: 'C',
      strike: 245,
      multiplier: 100,
      exerciseStyle: 'american',
      settlement: 'physical',
      amPmSettlement: 'pm',
      tickSize: 0.01,
      lastTradeDate: '2026-09-16',
      assetClass: 'option',
      marketSector: 'Equity',
      exchCode: 'US',
      currency: 'USD',
    });
    // 2026-09-16 is a Wednesday: a weekly. 2026-09-18 is the third Friday: a monthly.
    expect(first.isWeekly).toBe(true);
    expect(isThirdFriday('2026-09-18')).toBe(true);
    expect(isThirdFriday('2026-09-16')).toBe(false);
    const weeklies = result.rows.contracts.filter((c) => c.isWeekly).length;
    expect(weeklies).toBe(1252);
    expect(result.rows.contracts.length - weeklies).toBe(2258);
  });

  it('spans 25 expiries from the front week to January 2029', () => {
    expect(result.rows.chain.expiries).toHaveLength(25);
    expect(result.rows.chain.frontExpiry).toBe('2026-09-16');
    expect(result.rows.chain.expiries.at(-1)).toBe('2029-01-19');
    // Sorted, deduplicated, and never dependent on the provider's ordering.
    expect([...result.rows.chain.expiries].sort()).toEqual(result.rows.chain.expiries);
  });
});

describe('cboe.options — contract quotes (§5.2 step 3)', () => {
  const quotes = result.rows.optionQuotes;

  it('carries Cboe’s greeks as published, with full delta and OI coverage', () => {
    expect(quotes[0]).toEqual({
      captureTs: '2026-09-15T18:40:39.000Z',
      occSymbol: 'AAPL260916C00245000',
      instrumentId: 700_001,
      underlyingInstrumentId: 101,
      mdLineId: 5201,
      bid: 84.15,
      ask: 86.7,
      bidSize: 125,
      askSize: 27,
      last: 84.84,
      lastTs: '2026-09-15T14:40:48.000Z',
      prevClose: 89.8250007629394,
      volume: 4,
      openInterest: 1,
      iv: 2.3515,
      delta: 0.9999,
      gamma: 0,
      vega: 0.0001,
      theta: 0,
      rho: 0.0067,
      theo: 85.3062,
      underlyingPx: 330.3,
      provenanceId: 900_201,
    });
    expect(quotes.filter((q) => q.delta !== null)).toHaveLength(3510);
    expect(quotes.filter((q) => q.openInterest !== null)).toHaveLength(3510);
    expect(quotes.filter((q) => q.bid !== null && q.ask !== null)).toHaveLength(3060);
  });

  it('leaves OPT_IV absent where Cboe published iv 0, and says so', () => {
    const zeroIv = quotes.filter((q) => q.iv === null);
    expect(zeroIv).toHaveLength(178);
    expect(quotes.filter((q) => q.iv !== null)).toHaveLength(3332);
    // §5.2: `iv = 0` on a contract with a bid is a model gap, reported per contract.
    const dropped = result.problems.filter((p) => p.kind === 'field_dropped');
    expect(dropped).toHaveLength(178);
    expect(dropped[0]).toEqual({
      kind: 'field_dropped',
      detail: 'iv is 0 on AAPL260916C00250000 with a bid of 79.15',
      path: '/data/options/2/iv',
    });
  });

  it('converts each contract’s naive ET last trade to UTC', () => {
    const traded = quotes.filter((q) => q.lastTs !== null);
    expect(traded).toHaveLength(2842);
    const stamps = traded.map((q) => q.lastTs!);
    // The oldest print in the chain is from January 2025 — an illiquid deep strike, and exactly
    // why `last_trade_time` is not allowed to become the line's freshness.
    expect(stamps.reduce((a, b) => (a < b ? a : b))).toBe('2025-01-03T15:21:54.000Z');
    expect(stamps.reduce((a, b) => (a > b ? a : b))).toBe('2026-09-15T18:25:37.000Z');
    // A contract that has never traded publishes `last_trade_time: null` and keeps no last.
    const never = quotes.find((q) => q.lastTs === null)!;
    expect(never.last).toBeNull();
  });

  it('holds no crossed market in this capture', () => {
    expect(result.rows.chain.crossedCount).toBe(0);
    expect(quotes.every((q) => q.bid === null || q.ask === null || q.bid <= q.ask)).toBe(true);
  });
});

describe('cboe.options — the chain aggregate', () => {
  it('computes ATM IV from the nearest-strike pair on the front expiry', () => {
    const chain = result.rows.chain;
    expect(chain.contractCount).toBe(3510);
    expect(chain.atmStrike).toBe(330);
    // The 2026-09-16 330 call and put: (0.2809 + 0.2787) / 2.
    const pair = result.rows.optionQuotes.filter(
      (q) => q.occSymbol === 'AAPL260916C00330000' || q.occSymbol === 'AAPL260916P00330000',
    );
    expect(pair).toHaveLength(2);
    expect(chain.atmIv).toBeCloseTo((pair[0]!.iv! + pair[1]!.iv!) / 2, 12);
    expect(chain.atmIv).toBeCloseTo(0.2798, 6);
  });

  it('computes the put/call ratio from volume, and never divides by zero', () => {
    const chain = result.rows.chain;
    expect(chain.callVolume).toBe(366_950);
    expect(chain.putVolume).toBe(258_826);
    expect(chain.putCallRatio).toBeCloseTo(258_826 / 366_950, 12);
    expect(chain.putCallRatio).toBeCloseTo(0.7053, 4);
  });

  it('fans out only the ATM window of the front three expiries', () => {
    // 3 expiries × 21 strikes (±10 around the money) × 2 rights = 126 contracts, plus the
    // underlying line: 127 updates for a payload of 3,510 contracts.
    expect(result.rows.chain.plantContractCount).toBe(126);
    expect(result.updates).toHaveLength(127);
    const fanned = result.updates.slice(1);
    expect(new Set(fanned.map((u) => u.assetClass))).toEqual(new Set(['option']));
    expect(fanned.every((u) => u.mdLineId === 5201)).toBe(true);
    const contracts = new Map(result.rows.contracts.map((c) => [c.instrumentId, c]));
    const expiries = new Set(fanned.map((u) => contracts.get(u.instrumentId)!.expiry));
    expect([...expiries].sort()).toEqual(['2026-09-16', '2026-09-18', '2026-09-21']);
    for (const update of fanned) {
      const strike = contracts.get(update.instrumentId)!.strike;
      expect(Math.abs(strike - 330.3)).toBeLessThan(60);
    }
  });

  it('publishes the option field block for a fanned-out contract', () => {
    const contracts = new Map(result.rows.contracts.map((c) => [c.instrumentId, c]));
    const atmCall = result.updates
      .slice(1)
      .find(
        (u) =>
          contracts.get(u.instrumentId)!.strike === 330 &&
          contracts.get(u.instrumentId)!.putCall === 'C' &&
          contracts.get(u.instrumentId)!.expiry === '2026-09-16',
      )!;
    expect(atmCall.subject).toBe(`q:${String(atmCall.instrumentId)}`);
    expect(Object.keys(atmCall.fields).sort()).toEqual(
      [
        'ASK_SIZE',
        'BID_SIZE',
        'LAST_TRADE_TIME',
        'OPT_DELTA',
        'OPT_GAMMA',
        'OPT_IV',
        'OPT_OI',
        'OPT_RHO',
        'OPT_THEO',
        'OPT_THETA',
        'OPT_VEGA',
        'PX_ASK',
        'PX_BID',
        'PX_CLOSE_1D',
        'PX_LAST',
        'PX_VOLUME',
      ].sort(),
    );
  });

  it('fans out nothing before the contracts have instrument rows', () => {
    const blind = normaliseChain(raw, optionContext(raw, false), { sourceId: 'cboe.options' });
    // Every contract is new: the job mints `instruments` + `identifiers` from `rows.contracts`
    // and the next poll resolves them. Only the underlying ticks in the meantime.
    expect(blind.rows.chain.unresolvedCount).toBe(3510);
    expect(blind.rows.chain.plantContractCount).toBe(0);
    expect(blind.updates).toHaveLength(1);
    expect(blind.rows.optionQuotes).toHaveLength(3510);
    expect(blind.rows.optionQuotes.every((q) => q.instrumentId === null)).toBe(true);
  });

  it('honours an explicit subscription outside the ATM window', () => {
    const deep = result.rows.contracts.at(-1)!;
    const subscribed = normaliseChain(raw, optionContext(raw), {
      sourceId: 'cboe.options',
      subscribedOcc: new Set([deep.occSymbol]),
    });
    expect(subscribed.rows.chain.plantContractCount).toBe(127);
    expect(subscribed.updates.some((u) => u.instrumentId === deep.instrumentId)).toBe(true);
  });
});

describe('cboe.options — QA-05: parse never throws', () => {
  const text = raw.body.toString('utf8');
  const mutate = (body: string): RawRecord => ({ ...raw, body: Buffer.from(body, 'utf8') });

  it.each([
    ['truncated at 1 KB', text.slice(0, 1024)],
    ['truncated mid-chain', text.slice(0, 700_000)],
    [
      'options is an object',
      '{"timestamp":"2026-09-15 18:40:39","data":{"options":{}},"symbol":"AAPL"}',
    ],
    [
      'a contract with a junk symbol',
      '{"timestamp":"2026-09-15 18:40:39","data":{"options":[{"option":"NOT-AN-OCC","bid":1}],' +
        '"symbol":"AAPL","current_price":330.3},"symbol":"AAPL"}',
    ],
    ['empty', ''],
  ])('returns a parse-error result on %s', (_name, body) => {
    const parsedResult = normaliseChain(mutate(body), optionContext(raw));
    expect(Array.isArray(parsedResult.updates)).toBe(true);
    expect(Array.isArray(parsedResult.rows.contracts)).toBe(true);
  });

  it('names the bad contract and keeps the rest of the chain', () => {
    const body =
      '{"timestamp":"2026-09-15 18:40:39","data":{"symbol":"AAPL","current_price":330.3,' +
      '"options":[{"option":"NOT-AN-OCC"},{"option":"AAPL260916C00330000","bid":1,"ask":2}]},' +
      '"symbol":"AAPL"}';
    const partial = normaliseChain(mutate(body), optionContext(raw));
    expect(partial.rows.contracts).toHaveLength(1);
    expect(
      partial.problems.some(
        (p) => p.kind === 'parse_error' && p.path?.startsWith('/data/options/0') === true,
      ),
    ).toBe(true);
  });

  it('drops an out-of-range greek per field, not per contract', () => {
    const body =
      '{"timestamp":"2026-09-15 18:40:39","data":{"symbol":"AAPL","current_price":330.3,' +
      '"options":[{"option":"AAPL260916C00330000","bid":1,"ask":2,"delta":4,"gamma":-1,' +
      '"vega":0.5,"theta":-0.2,"iv":0.3}]},"symbol":"AAPL"}';
    const ranged = normaliseChain(mutate(body), optionContext(raw));
    const quote = ranged.rows.optionQuotes[0]!;
    expect(quote.delta).toBeNull();
    expect(quote.gamma).toBeNull();
    expect(quote.vega).toBe(0.5);
    expect(quote.theta).toBe(-0.2);
    expect(quote.iv).toBe(0.3);
    expect(ranged.problems.filter((p) => p.kind === 'out_of_range')).toHaveLength(2);
  });

  it('suppresses a crossed market from the plant but keeps the row', () => {
    const body =
      '{"timestamp":"2026-09-15 18:40:39","data":{"symbol":"AAPL","current_price":330.3,' +
      '"options":[{"option":"AAPL260916C00330000","bid":9,"ask":2,"iv":0.3}]},"symbol":"AAPL"}';
    const crossed = normaliseChain(mutate(body), optionContext(raw));
    expect(crossed.rows.chain.crossedCount).toBe(1);
    expect(crossed.rows.optionQuotes).toHaveLength(1);
    expect(crossed.updates.filter((u) => u.assetClass === 'option')).toEqual([]);
    expect(crossed.problems.some((p) => p.detail.includes('crossed market'))).toBe(true);
  });
});
