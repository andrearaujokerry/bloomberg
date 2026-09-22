/**
 * QA-02 for `frankfurter` — WORKPLAN WP-05 L838, PROVIDERS.md §5.7.
 *
 * The capture is one ECB fixing for 2026-09-15, base USD, 29 currencies. What is pinned here is
 * not only the golden but the *arithmetic*: `EURUSD = 1 / rates.EUR = 1 / 0.86663 = 1.15389497`
 * (rounded once at `numeric(18,8)`) while `USDJPY = rates.JPY = 155` unchanged, and the inversion
 * is chosen by the pair the md line names, never by a hard-coded list of inverted majors.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AssetClass } from '@terminal/core';

import {
  frankfurterAdapter,
  frankfurterUrl,
  pairForLine,
  registerFrankfurterAdapter,
} from '../../../src/providers/frankfurter/adapter.js';
import {
  crossRate,
  parseFrankfurter,
  roundRate,
} from '../../../src/providers/frankfurter/parse.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore } from '../../../src/providers/replayStore.js';
import type { NormaliseContext, NormaliseLine } from '../../../src/providers/types.js';

const store = openReplayStore();
const raw = store.replay({ providerId: 'frankfurter', url: frankfurterUrl() });
const parsed = parseFrankfurter({ body: raw.body, url: raw.url });
const golden = readFileSync(join(store.dir, 'normalised', 'frankfurter.json'), 'utf8');

function line(overrides: Partial<NormaliseLine> = {}): NormaliseLine {
  return {
    mdLineId: 10,
    instrumentId: 100,
    assetClass: 'fx',
    tier: 'eod',
    intrinsicDelayMin: 0,
    expectedIntervalMs: 86_400_000,
    priority: 30,
    ...overrides,
  };
}

describe('frankfurter replay', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(frankfurterUrl()).toBe('https://api.frankfurter.dev/v1/latest?base=USD');
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    // The manifest carries the ECB date as the capture's source timestamp.
    expect(raw.sourceTs?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('builds the history URL for the seed backfill', () => {
    expect(frankfurterUrl({ from: '2026-01-01', to: '2026-01-31' })).toBe(
      'https://api.frankfurter.dev/v1/2026-01-01..2026-01-31?base=USD',
    );
    expect(frankfurterUrl({ symbols: ['EUR', 'JPY'] })).toBe(
      'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR%2CJPY',
    );
  });

  it('equals the committed golden byte for byte', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(golden);
  });

  it('carries 29 currencies for 2026-09-15 and publishes at 14:15:00Z', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.base).toBe('USD');
    expect(parsed.amount).toBe(1);
    expect(parsed.date).toBe('2026-09-15');
    expect(parsed.rates).toHaveLength(29);
    expect(parsed.problems).toEqual([]);
    expect(new Date(parsed.sourceTsMs).toISOString()).toBe('2026-09-15T14:15:00.000Z');

    // Sorted by code, whatever order the payload listed them in.
    expect(parsed.rates.map((rate) => rate.currency).slice(0, 5)).toEqual([
      'AUD',
      'BRL',
      'CAD',
      'CHF',
      'CNY',
    ]);
    expect(parsed.rates.every((rate) => rate.quotePerUsd > 0 && rate.usdPerQuote > 0)).toBe(true);
    expect(parsed.rates.find((rate) => rate.currency === 'EUR')).toEqual({
      currency: 'EUR',
      quotePerUsd: 0.86663,
      usdPerQuote: 1.15389497,
    });
    expect(parsed.rates.find((rate) => rate.currency === 'JPY')).toEqual({
      currency: 'JPY',
      quotePerUsd: 155,
      usdPerQuote: 0.00645161,
    });
  });

  it('inverts by the pair, not by a list of majors', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(crossRate(parsed, 'EUR', 'USD')).toBe(1.15389497);
    expect(crossRate(parsed, 'USD', 'JPY')).toBe(155);
    expect(crossRate(parsed, 'GBP', 'USD')).toBe(roundRate(1 / 0.74166));
    // A cross neither leg of which is USD still falls out of the same fixing.
    expect(crossRate(parsed, 'EUR', 'GBP')).toBe(roundRate(0.74166 / 0.86663));
    expect(crossRate(parsed, 'USD', 'USD')).toBe(1);
    expect(crossRate(parsed, 'USD', 'XAU')).toBeNull();
  });

  it('rejects a payload whose base or amount is not what the arithmetic assumes', () => {
    const wrongBase = parseFrankfurter({
      body: '{"amount":1,"base":"EUR","date":"2026-09-15","rates":{"USD":1.15}}',
    });
    expect(wrongBase.ok).toBe(false);
    if (!wrongBase.ok) expect(wrongBase.problems[0]?.detail).toContain("'USD'");

    const wrongAmount = parseFrankfurter({
      body: '{"amount":100,"base":"USD","date":"2026-09-15","rates":{"EUR":86.6}}',
    });
    expect(wrongAmount.ok).toBe(false);
    if (!wrongAmount.ok) expect(wrongAmount.problems[0]?.detail).toContain('amount');
  });

  it('drops an unusable rate rather than the whole fixing, and never throws', () => {
    const result = parseFrankfurter({
      body: '{"amount":1,"base":"USD","date":"2026-09-15","rates":{"EUR":0.86663,"XXX":0,"ZZ":1,"YEN":null}}',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rates.map((rate) => rate.currency)).toEqual(['EUR']);
    expect(result.problems.map((problem) => problem.kind).sort()).toEqual([
      'field_dropped',
      'field_dropped',
      'out_of_range',
    ]);

    for (const body of ['', '{', '[]', 'null', '{"amount":1,"base":"USD","date":"x","rates":{}}']) {
      const bad = parseFrankfurter({ body });
      if (!bad.ok) expect(bad.problems.length).toBeGreaterThan(0);
    }
  });
});

describe('frankfurterAdapter.normalise', () => {
  const ctx = (lines: Record<string, NormaliseLine>): NormaliseContext => ({
    provenanceId: 7,
    capturedAt: raw.capturedAt,
    lines: new Map(Object.entries(lines)),
  });

  it('writes both directions of every rate into fx_rates', () => {
    const result = frankfurterAdapter.normalise(raw, ctx({}));
    expect(result.rows.fxRates).toHaveLength(58);
    expect(result.rows.fxRates.filter((row) => row.baseCcy === 'USD')).toHaveLength(29);
    expect(result.rows.fxRates.filter((row) => row.quoteCcy === 'USD')).toHaveLength(29);
    expect(result.rows.fxRates.every((row) => row.rateDate === '2026-09-15')).toBe(true);
    expect(result.rows.fxRates.every((row) => row.sourceId === 'frankfurter')).toBe(true);
    expect(result.rows.fxRates.find((row) => row.quoteCcy === 'EUR')).toEqual({
      baseCcy: 'USD',
      quoteCcy: 'EUR',
      rateDate: '2026-09-15',
      rate: 0.86663,
      sourceId: 'frankfurter',
    });
    expect(result.rows.fxRates.find((row) => row.baseCcy === 'EUR')).toEqual({
      baseCcy: 'EUR',
      quoteCcy: 'USD',
      rateDate: '2026-09-15',
      rate: 1.15389497,
      sourceId: 'frankfurter',
    });
    expect(result.sourceTs?.toISOString()).toBe('2026-09-15T14:15:00.000Z');
  });

  it('gives a pair line PX_OFFICIAL_CLOSE and a close-only daily bar', () => {
    const result = frankfurterAdapter.normalise(
      raw,
      ctx({
        EURUSD: line({ mdLineId: 11, instrumentId: 101 }),
        USDJPY: line({ mdLineId: 12, instrumentId: 102 }),
        USD: line({ mdLineId: 13, instrumentId: 103, assetClass: 'fx' as AssetClass }),
      }),
    );

    const eur = result.updates.find((update) => update.subject === 'q:101');
    expect(eur?.fields).toEqual({ PX_OFFICIAL_CLOSE: 1.15389497 });
    expect(eur?.ts).toEqual({
      src: Date.parse('2026-09-15T14:15:00Z'),
      cap: raw.capturedAt,
      pub: raw.capturedAt,
    });
    expect(result.updates.find((update) => update.subject === 'q:102')?.fields).toEqual({
      PX_OFFICIAL_CLOSE: 155,
    });
    // The reference line ticks with no fields at all: it exists so a missed fixing is measurable.
    expect(result.updates.find((update) => update.subject === 'q:103')?.fields).toEqual({});

    // open/high/low/volume stay NULL — the ECB publishes a fixing, not a bar (§5.7).
    expect(result.rows.barsDaily).toHaveLength(2);
    expect(result.rows.barsDaily[0]).toEqual({
      instrumentId: 101,
      sessionDate: '2026-09-15',
      mdLineId: 11,
      open: null,
      high: null,
      low: null,
      close: 1.15389497,
      volume: null,
      sourceTs: '2026-09-15T14:15:00.000Z',
      captureTs: new Date(raw.capturedAt).toISOString(),
    });
  });

  it('flags a line the fixing cannot price', () => {
    const result = frankfurterAdapter.normalise(raw, ctx({ XAUUSD: line(), NOTAPAIR: line() }));
    expect(result.updates).toEqual([]);
    expect(result.rows.barsDaily).toEqual([]);
    expect(result.problems.map((problem) => problem.kind).sort()).toEqual([
      'field_dropped',
      'unknown_symbol',
    ]);
  });

  it('reads a pair out of either spelling of a provider symbol', () => {
    expect(pairForLine('EURUSD')).toEqual({ base: 'EUR', quote: 'USD' });
    expect(pairForLine('EURUSD=X')).toEqual({ base: 'EUR', quote: 'USD' });
    expect(pairForLine('USD')).toBeNull();
  });

  it('is registered under its licence_registry source id', () => {
    const registry = registerFrankfurterAdapter(new ProviderRegistry());
    expect(registry.ids()).toEqual(['frankfurter']);
    expect(registry.require('frankfurter').adapterVersion).toBe('frankfurter/1.0.0');
  });
});
