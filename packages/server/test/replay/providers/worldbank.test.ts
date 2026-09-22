/**
 * QA-02 — `worldbank` over the recorded `worldbank` capture. WORKPLAN WP-05, PROVIDERS.b §10.7.
 *
 * The capture was taken with `per_page=3`, so it is also the smallest possible test of the paging
 * contract: `meta.pages` is 22 and `meta.total` is 66, which is what tells `worldMacro.ts` there
 * is more to fetch.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore, canonicalUrl, requestKey } from '../../../src/providers/replayStore.js';
import type { NormaliseContext, RawRecord } from '../../../src/providers/types.js';
import {
  WORLDBANK_ADAPTER_VERSION,
  worldBankAdapter,
  worldBankUrl,
} from '../../../src/providers/worldbank/adapter.js';
import {
  normaliseWorldBank,
  parseWorldBank,
  worldBankPayloadOk,
} from '../../../src/providers/worldbank/parse.js';

const store = openReplayStore();

function goldenText(name: string): string {
  return readFileSync(join(store.dir, 'normalised', name), 'utf8');
}

function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ctxOf(raw: RawRecord, lines: NormaliseContext['lines'] = new Map()): NormaliseContext {
  return { provenanceId: 11, capturedAt: raw.capturedAt, lines };
}

const url = worldBankUrl({ country: 'US', indicator: 'NY.GDP.MKTP.CD', page: 1, perPage: 3 });
const raw = store.replay({ providerId: 'worldbank', url });

describe('worldbank replay (§10.7)', () => {
  it('the adapter URL derives the recorded request key', () => {
    expect(url).toBe(
      'https://api.worldbank.org/v2/country/US/indicator/NY.GDP.MKTP.CD?format=json&page=1&per_page=3',
    );
    expect(canonicalUrl(url)).toBe(store.entry(requestKey('worldbank', 'GET', url))?.url);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(724);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseWorldBank(raw, ctxOf(raw)))).toBe(goldenText('worldbank.json'));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseWorldBank(raw, ctxOf(raw));
    expect(worldBankPayloadOk(out.rows)).toBe(true);
    expect(out.problems).toHaveLength(0);

    // The paging block, which is the only thing that says there are 22 more pages.
    expect(out.rows.meta).toEqual({
      page: 1,
      pages: 22,
      perPage: 3,
      total: 66,
      sourceId: '2',
      lastUpdated: '2026-07-13',
    });

    // One series, three annual observations, all stamped at the period start and all populated.
    expect(out.rows.series).toEqual([
      {
        providerCode: 'NY.GDP.MKTP.CD',
        name: 'GDP (current US$)',
        country: 'US',
        countryName: 'United States',
        countryIso3: 'USA',
        units: null,
        decimals: 0,
        lastUpdatedAt: '2026-07-13T00:00:00Z',
      },
    ]);
    expect(out.rows.observations.map((o) => [o.obsDate, o.value, o.status])).toEqual([
      ['2023-01-01', 27_811_517_000_000, 'final'],
      ['2024-01-01', 29_298_013_000_000, 'final'],
      ['2025-01-01', 30_769_700_000_000, 'final'],
    ]);

    // `lastupdated` is the vintage, and it is what lands on `provenance.source_ts` — not the
    // capture instant and not the newest observation's year.
    expect(out.sourceTs?.toISOString()).toBe('2026-07-13T00:00:00.000Z');
  });

  it('emits a plant update for a series with an md_lines row', () => {
    expect(normaliseWorldBank(raw, ctxOf(raw)).updates).toHaveLength(0);
    const lines: NormaliseContext['lines'] = new Map([
      [
        'NY.GDP.MKTP.CD',
        {
          mdLineId: 5,
          instrumentId: 900,
          assetClass: 'econ' as const,
          tier: 'eod' as const,
          intrinsicDelayMin: 0,
          expectedIntervalMs: 31_536_000_000,
          priority: 30,
        },
      ],
    ]);
    const out = normaliseWorldBank(raw, ctxOf(raw, lines));
    expect(out.updates).toEqual([
      {
        subject: 'e:NY.GDP.MKTP.CD',
        instrumentId: 900,
        mdLineId: 5,
        assetClass: 'econ',
        tier: 'eod',
        fields: { PX_LAST: 30_769_700_000_000 },
        ts: {
          src: Date.parse('2026-07-13T00:00:00Z'),
          cap: raw.capturedAt,
          pub: raw.capturedAt,
        },
        prov: { sourceId: 'worldbank', provenanceId: 11 },
      },
    ]);
  });

  it('refuses the HTTP-200 error shape instead of reporting no observations', () => {
    const payload = JSON.stringify([
      {
        message: [
          { id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' },
        ],
      },
    ]);
    const { rows, problems } = parseWorldBank(payload);
    expect(worldBankPayloadOk(rows)).toBe(false);
    expect(rows.observations).toHaveLength(0);
    expect(problems[0]?.kind).toBe('schema_drift');
    expect(problems[0]?.detail).toContain('The provided parameter value is not valid');
  });

  it('keeps a null value as a missing observation, not as a zero', () => {
    const payload = JSON.stringify([
      { page: 1, pages: 1, per_page: 1, total: 1, sourceid: '2', lastupdated: '2026-07-13' },
      [
        {
          indicator: { id: 'NY.GDP.MKTP.CD', value: 'GDP (current US$)' },
          country: { id: 'US', value: 'United States' },
          countryiso3code: 'USA',
          date: '2026',
          value: null,
          unit: '',
          obs_status: '',
          decimal: 0,
        },
      ],
    ]);
    const { rows } = parseWorldBank(payload);
    expect(rows.observations).toEqual([
      {
        providerCode: 'NY.GDP.MKTP.CD',
        country: 'US',
        obsDate: '2026-01-01',
        value: null,
        status: 'missing',
      },
    ]);
  });

  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([worldBankAdapter]);
    expect(registry.ids()).toEqual(['worldbank']);
    expect(worldBankAdapter.adapterVersion).toBe(WORLDBANK_ADAPTER_VERSION);
    expect(worldBankAdapter.sourceId).toBe('worldbank');
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = raw.body.toString('utf8');
    for (const candidate of [
      '',
      '[',
      '[{}]',
      '[{},{}]',
      'null',
      text.slice(0, 200),
      text.slice(40),
    ]) {
      expect(() => parseWorldBank(candidate)).not.toThrow();
    }
  });
});
