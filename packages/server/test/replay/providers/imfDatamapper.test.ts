/**
 * QA-02 — `imf.datamapper` over `imf-weo.json`. WORKPLAN WP-05, PROVIDERS.b §10.8.
 *
 * The recorded capture is the **indicator catalogue**, not observations: the 48 captures contain
 * no `values` payload, so the `values.*` path has no golden and is asserted here against synthetic
 * input instead. That gap is §10.8's own "addition required" and is reported to the integrator
 * rather than papered over with a fabricated fixture.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  IMF_ADAPTER_VERSION,
  IMF_INDICATORS_URL,
  imfAdapter,
  imfUrl,
} from '../../../src/providers/imf/adapter.js';
import {
  imfInstant,
  normaliseImf,
  parseImfIndicators,
  parseImfValues,
} from '../../../src/providers/imf/parse.js';
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

const url = imfUrl({ kind: 'catalogue' });
const raw = store.replay({ providerId: 'imf.datamapper', url });

describe('imf.datamapper replay (§10.8)', () => {
  it('the adapter URL derives the recorded request key', () => {
    expect(url).toBe(IMF_INDICATORS_URL);
    expect(store.has(requestKey('imf.datamapper', 'GET', url))).toBe(true);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(48_340);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseImf(raw, ctxOf(raw)))).toBe(goldenText('imf-weo.json'));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseImf(raw, ctxOf(raw));
    expect(out.rows.kind).toBe('catalogue');
    expect(out.rows.observations).toHaveLength(0);
    expect(out.problems).toHaveLength(0);

    // 132 indicators across 13 IMF datasets, 15 of them the WEO series this system reads.
    expect(out.rows.indicators).toHaveLength(132);
    expect(new Set(out.rows.indicators.map((i) => i.dataset)).size).toBe(13);
    expect(out.rows.indicators.filter((i) => i.dataset === 'WEO')).toHaveLength(15);

    // Field coverage: every indicator carries a label and a `last-modified`; two publish no unit.
    expect(out.rows.indicators.every((i) => i.name !== '')).toBe(true);
    expect(out.rows.indicators.every((i) => i.lastUpdatedAt !== null)).toBe(true);
    expect(out.rows.indicators.filter((i) => i.units === null)).toHaveLength(2);

    // Sorted by indicator id, so the golden does not depend on JSON key insertion order.
    expect(out.rows.indicators.map((i) => i.providerCode)).toEqual(
      [...out.rows.indicators.map((i) => i.providerCode)].sort(),
    );

    const growth = out.rows.indicators.find((i) => i.providerCode === 'NGDP_RPCH');
    expect(growth).toEqual({
      providerCode: 'NGDP_RPCH',
      name: 'Real GDP growth',
      units: 'Annual percent change',
      dataset: 'WEO',
      source: 'World Economic Outlook (April 2026)',
      lastUpdatedAt: '2026-04-08T16:07:34Z',
    });

    // A label published with an embedded newline is collapsed, not carried into `econ_series.name`.
    const perCapita = out.rows.indicators.find((i) => i.providerCode === 'NGDPDPC');
    expect(perCapita?.name).toBe('GDP per capita, current prices');

    // `sourceTs` is the newest `last-modified` across the catalogue.
    expect(out.sourceTs?.toISOString()).toBe('2026-05-18T13:09:46.000Z');
  });

  it('reads the hyphenated last-modified key as a UTC instant', () => {
    expect(imfInstant('2026-04-08 16:07:34')).toBe('2026-04-08T16:07:34Z');
    expect(imfInstant('2026-04-08T16:07:34')).toBe('2026-04-08T16:07:34Z');
    expect(imfInstant('April 2026')).toBeNull();
    expect(imfInstant(undefined)).toBeNull();
  });

  it('stores WEO years beyond the capture year as preliminary, never as actuals', () => {
    const payload = JSON.stringify({
      values: { NGDP_RPCH: { USA: { '2024': 2.8, '2026': 2.1, '2028': 2.0, '2030': null } } },
    });
    const { observations, problems } = parseImfValues(payload, 2026);
    expect(observations).toEqual([
      {
        providerCode: 'NGDP_RPCH',
        area: 'USA',
        obsDate: '2024-01-01',
        value: 2.8,
        status: 'final',
      },
      {
        providerCode: 'NGDP_RPCH',
        area: 'USA',
        obsDate: '2026-01-01',
        value: 2.1,
        status: 'final',
      },
      {
        providerCode: 'NGDP_RPCH',
        area: 'USA',
        obsDate: '2028-01-01',
        value: 2,
        status: 'preliminary',
      },
      {
        providerCode: 'NGDP_RPCH',
        area: 'USA',
        obsDate: '2030-01-01',
        value: null,
        status: 'missing',
      },
    ]);
    expect(problems).toHaveLength(0);
  });

  it('dispatches on the payload key and says so when it is neither', () => {
    const values = JSON.stringify({ values: { X: { USA: { '2025': 1 } } } });
    const out = normaliseImf({ ...raw, body: Buffer.from(values, 'utf8') }, ctxOf(raw));
    expect(out.rows.kind).toBe('values');
    expect(out.rows.observations).toHaveLength(1);

    const neither = normaliseImf({ ...raw, body: Buffer.from('{"api":{}}', 'utf8') }, ctxOf(raw));
    expect(neither.rows.kind).toBe('unknown');
    expect(neither.problems[0]?.kind).toBe('schema_drift');
  });

  it('builds the observations URL §10.8 names', () => {
    expect(imfUrl({ kind: 'values', indicator: 'NGDP_RPCH', area: 'USA' })).toBe(
      'https://www.imf.org/external/datamapper/api/v1/NGDP_RPCH/USA',
    );
  });

  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([imfAdapter]);
    expect(registry.ids()).toEqual(['imf.datamapper']);
    expect(imfAdapter.adapterVersion).toBe(IMF_ADAPTER_VERSION);
    expect(imfAdapter.sourceId).toBe('imf.datamapper');
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = raw.body.toString('utf8');
    for (const candidate of [
      '',
      '{',
      '{"indicators":[]}',
      'null',
      text.slice(0, 5_000),
      text.slice(600),
    ]) {
      expect(() => parseImfIndicators(candidate)).not.toThrow();
      expect(() => parseImfValues(candidate, 2026)).not.toThrow();
    }
  });
});
