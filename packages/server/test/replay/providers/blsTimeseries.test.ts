/**
 * QA-02 — `bls.timeseries` over `bls-cpi.json`. WORKPLAN WP-05, PROVIDERS.b §10.5.
 *
 * The capture is one POST carrying one series id, which is the shape §10.5 forces: 25 queries a
 * day means every headline series travels in a single `seriesid` array. The request key is derived
 * from the adapter's own body, so a change to `blsTimeseriesBody` misses the capture instead of
 * silently parsing it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BLS_ADAPTER_VERSION,
  BLS_TIMESERIES_URL,
  blsTimeseriesAdapter,
  blsTimeseriesBody,
} from '../../../src/providers/bls/adapter.js';
import {
  BLS_STATUS_SUCCEEDED,
  blsPeriodStart,
  blsRequestSucceeded,
  normaliseBlsTimeseries,
  parseBlsTimeseries,
} from '../../../src/providers/bls/parse.js';
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

function ctxOf(raw: RawRecord, lines: NormaliseContext['lines'] = new Map()): NormaliseContext {
  return { provenanceId: 7, capturedAt: raw.capturedAt, lines };
}

const body = blsTimeseriesBody({
  seriesIds: ['CUUR0000SA0'],
  startYear: 2024,
  endYear: 2026,
});

const raw = store.replay({
  providerId: 'bls.timeseries',
  method: 'POST',
  url: BLS_TIMESERIES_URL,
  body,
});

describe('bls.timeseries replay (§10.5)', () => {
  it('the adapter body derives the recorded request key', () => {
    expect(body).toBe('{"seriesid":["CUUR0000SA0"],"startyear":"2024","endyear":"2026"}');
    const key = requestKey('bls.timeseries', 'POST', BLS_TIMESERIES_URL, body);
    expect(store.has(key)).toBe(true);
    expect(raw.requestKey).toBe(key);
    expect(raw.origin).toBe('replay');
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(3_023);
  });

  it('parse.ts equals the committed golden, byte for byte', () => {
    expect(serialise(normaliseBlsTimeseries(raw, ctxOf(raw)))).toBe(goldenText('bls-cpi.json'));
  });

  it('measures what the capture actually contains', () => {
    const out = normaliseBlsTimeseries(raw, ctxOf(raw));
    expect(out.rows.status).toBe(BLS_STATUS_SUCCEEDED);
    expect(blsRequestSucceeded(out.rows)).toBe(true);
    expect(out.rows.messages).toEqual([]);
    expect(out.problems).toHaveLength(0);

    // One series, 32 monthly observations, January 2024 through August 2026 with no gaps.
    expect(out.rows.series).toEqual([
      {
        providerCode: 'CUUR0000SA0',
        frequency: 'M',
        observationCount: 32,
        firstObsDate: '2024-01-01',
        lastObsDate: '2026-08-01',
        latestValue: 334.98,
        latestObsDate: '2026-08-01',
      },
    ]);
    expect(out.rows.observations).toHaveLength(32);
    expect(out.rows.observations.map((o) => o.obsDate)).toEqual(
      [...out.rows.observations.map((o) => o.obsDate)].sort(),
    );
    expect(out.rows.observations.every((o) => o.obsDate.endsWith('-01'))).toBe(true);

    // Field coverage: 31 of the 32 carry a value; the one that does not is the October 2025
    // shutdown row, which is `missing` and keeps BLS's own footnote.
    expect(out.rows.observations.filter((o) => o.value !== null)).toHaveLength(31);
    expect(out.rows.observations.filter((o) => o.status === 'missing')).toEqual([
      {
        providerCode: 'CUUR0000SA0',
        obsDate: '2025-10-01',
        period: 'M10',
        periodName: 'October',
        value: null,
        status: 'missing',
        footnote: 'Data unavailable due to the 2025 lapse in appropriations',
      },
    ]);
    expect(out.rows.observations.filter((o) => o.footnote !== null)).toHaveLength(1);
    expect(out.rows.observations[0]?.value).toBe(308.417);
    expect(out.rows.observations.at(-1)?.value).toBe(334.98);
  });

  it('emits no plant update without an md_lines row, and one with it', () => {
    expect(normaliseBlsTimeseries(raw, ctxOf(raw)).updates).toHaveLength(0);

    const lines: NormaliseContext['lines'] = new Map([
      [
        'CUUR0000SA0',
        {
          mdLineId: 91,
          instrumentId: 4_242,
          assetClass: 'econ' as const,
          tier: 'eod' as const,
          intrinsicDelayMin: 0,
          expectedIntervalMs: 2_678_400_000,
          priority: 30,
        },
      ],
    ]);
    const out = normaliseBlsTimeseries(raw, ctxOf(raw, lines));
    expect(out.updates).toEqual([
      {
        subject: 'e:CUUR0000SA0',
        instrumentId: 4_242,
        mdLineId: 91,
        assetClass: 'econ',
        tier: 'eod',
        fields: { PX_LAST: 334.98 },
        ts: { src: null, cap: raw.capturedAt, pub: raw.capturedAt },
        prov: { sourceId: 'bls.timeseries', provenanceId: 7 },
      },
    ]);
  });

  it('skips M13, the annual average, rather than charting a thirteenth month', () => {
    expect(blsPeriodStart(2026, 'M13')).toBeNull();
    expect(blsPeriodStart(2026, 'M08')?.obsDate).toBe('2026-08-01');
    expect(blsPeriodStart(2026, 'Q02')?.obsDate).toBe('2026-04-01');
    expect(blsPeriodStart(2026, 'A01')?.obsDate).toBe('2026-01-01');

    const payload = JSON.stringify({
      status: BLS_STATUS_SUCCEEDED,
      message: [],
      Results: {
        series: [
          {
            seriesID: 'CUUR0000SA0',
            data: [
              {
                year: '2025',
                period: 'M13',
                periodName: 'Annual',
                value: '319.086',
                footnotes: [{}],
              },
              {
                year: '2025',
                period: 'M12',
                periodName: 'December',
                value: '324.054',
                footnotes: [{}],
              },
            ],
          },
        ],
      },
    });
    const { rows, problems } = parseBlsTimeseries(payload);
    expect(rows.observations.map((o) => o.period)).toEqual(['M12']);
    expect(problems.map((p) => p.kind)).toEqual(['field_dropped']);
    expect(problems[0]?.detail).toContain('M13');
  });

  it('treats a non-succeeded status as a gate, not as an empty result', () => {
    const payload = JSON.stringify({
      status: 'REQUEST_NOT_PROCESSED',
      message: ['Daily threshold reached'],
      Results: {},
    });
    const { rows, problems } = parseBlsTimeseries(payload);
    expect(blsRequestSucceeded(rows)).toBe(false);
    expect(rows.messages).toEqual(['Daily threshold reached']);
    expect(rows.observations).toHaveLength(0);
    expect(problems[0]?.kind).toBe('schema_drift');
    expect(problems[0]?.detail).toContain('REQUEST_NOT_PROCESSED');
  });

  it('cross-checks periodName against the period code', () => {
    const payload = JSON.stringify({
      status: BLS_STATUS_SUCCEEDED,
      message: [],
      Results: {
        series: [
          {
            seriesID: 'X',
            data: [
              { year: '2026', period: 'M08', periodName: 'July', value: '1.0', footnotes: [{}] },
            ],
          },
        ],
      },
    });
    const { rows, problems } = parseBlsTimeseries(payload);
    expect(rows.observations).toHaveLength(1);
    expect(problems[0]?.kind).toBe('schema_drift');
    expect(problems[0]?.detail).toContain("expected 'August'");
  });

  it('registers under its licensed source id', () => {
    const registry = createProviderRegistry([blsTimeseriesAdapter]);
    expect(registry.ids()).toEqual(['bls.timeseries']);
    expect(blsTimeseriesAdapter.adapterVersion).toBe(BLS_ADAPTER_VERSION);
    expect(blsTimeseriesAdapter.sourceId).toBe('bls.timeseries');
  });

  it('never throws on truncated or corrupted input (QA-05 smoke)', () => {
    const text = raw.body.toString('utf8');
    for (const candidate of [
      '',
      '{',
      'null',
      '[]',
      '{"Results":3}',
      text.slice(0, 900),
      text.slice(50),
    ]) {
      expect(() => parseBlsTimeseries(candidate)).not.toThrow();
    }
  });
});
