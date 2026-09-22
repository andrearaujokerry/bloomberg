/**
 * `fred.csv` — QA-02: `parse.ts` over `raw/fred-DGS10.csv` equals the committed golden
 * `fixtures/providers/normalised/fred-DGS10.csv.json`, byte for byte.
 *
 * Measured from the capture:
 *
 *  - **16,879 observations**, 1962-01-02 … 2026-09-11 — the whole history of the 10-year
 *    constant-maturity yield, keyless, in 262 KB. (FIXTURES.md says "16,881 rows"; the file holds
 *    16,879 data lines plus the header, and 16,879 is what the parse produces. The measured number
 *    is the one pinned here.)
 *  - **720 missing observations** — FRED's empty field, on market holidays: 1962-02-12 is the
 *    first, 2026-09-07 (Labor Day) the last. They are stored as `value: null, status: 'missing'`,
 *    never as `0`, which is the whole point of the marker.
 *  - **the series code comes from column 2's header**, and is compared with the `id` of the
 *    request that produced the body. The mismatch path is exercised directly: FRED substitutes a
 *    series when an id is retired, and the substituted file is perfectly well-formed.
 *  - **an HTML body with status 200** — FRED's error page — is detected by its leading `<` and
 *    yields no observations.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import {
  FRED_CSV_URL,
  fredCsvAdapter,
  fredCsvUrl,
  registerFredAdapters,
} from '../../../src/providers/fred/adapter.js';
import { parseFredCsv, requestedSeriesId } from '../../../src/providers/fred/parse.js';
import { readGolden, serialiseGolden, toGolden } from './golden.js';
import type { NormaliseContext } from '../../../src/providers/types.js';

const store = openReplayStore();

const URL = fredCsvUrl('DGS10');
const raw = store.replay({ providerId: 'fred.csv', url: URL });

/** A macro series has no md line of its own until WP-15 seeds one; the parse needs none. */
const ctx: NormaliseContext = { provenanceId: 1, capturedAt: raw.capturedAt, lines: new Map() };

const parsed = parseFredCsv(raw, ctx);
const observations = parsed.rows.observations;

describe('fred.csv replay', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.providerId).toBe('fred.csv');
    expect(raw.status).toBe(200);
    expect(URL).toBe(`${FRED_CSV_URL}?id=DGS10`);
    expect(raw.requestKey).toBe(requestKey('fred.csv', 'GET', URL));
    expect(raw.sha256).toBe('94c1e5b98460d7de645be32f3211853c3d749724ecb12cac33bc84623ea759b4');
    expect(raw.body.byteLength).toBe(268_695);
    expect(requestedSeriesId(raw.url)).toBe('DGS10');
  });

  it('matches the committed golden exactly', () => {
    const golden = serialiseGolden(
      toGolden(
        'fred-DGS10.csv',
        fredCsvAdapter.id,
        raw.requestKey,
        fredCsvAdapter.adapterVersion,
        parsed,
      ),
    );
    expect(golden).toBe(readGolden('fred-DGS10.csv.json'));
  });

  it('parses 16,879 observations over 64 years', () => {
    expect(parsed.problems).toEqual([]);
    expect(observations).toHaveLength(16_879);
    expect(parsed.rows.series).toEqual({
      providerCode: 'DGS10',
      requestedCode: 'DGS10',
      firstObsDate: '1962-01-02',
      lastObsDate: '2026-09-11',
      observationCount: 16_879,
      missingCount: 720,
    });
    expect(observations[0]).toEqual({
      providerCode: 'DGS10',
      obsDate: '1962-01-02',
      value: 4.06,
      status: 'final',
    });
    expect(observations[observations.length - 1]).toEqual({
      providerCode: 'DGS10',
      obsDate: '2026-09-11',
      value: 4.96,
      status: 'final',
    });
    // Ascending, unique, and every date an ISO date.
    const dates = observations.map((o) => o.obsDate);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });

  it('stores a missing observation as null, never as zero', () => {
    const missing = observations.filter((o) => o.status === 'missing');
    expect(missing).toHaveLength(720);
    expect(missing.every((o) => o.value === null)).toBe(true);
    expect(missing[0]?.obsDate).toBe('1962-02-12');
    expect(missing[missing.length - 1]?.obsDate).toBe('2026-09-07');
    expect(observations.filter((o) => o.status === 'final').every((o) => o.value !== null)).toBe(
      true,
    );
  });

  it('writes nothing when FRED substitutes a different series', () => {
    const substituted = {
      ...raw,
      url: `${FRED_CSV_URL}?id=DGS30`,
      body: Buffer.from('observation_date,DGS10\n2026-09-11,4.96\n'),
    };
    const result = parseFredCsv(substituted, ctx);
    expect(result.rows.observations).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe('schema_drift');
    expect(result.problems[0]?.detail).toMatch(/requested id 'DGS30' but the file is for 'DGS10'/);
    // The comparison is case-sensitive: 'dgs10' is not 'DGS10'.
    const cased = {
      ...raw,
      url: `${FRED_CSV_URL}?id=dgs10`,
      body: Buffer.from('observation_date,DGS10\n2026-09-11,4.96\n'),
    };
    expect(parseFredCsv(cased, ctx).rows.observations).toEqual([]);
  });

  it('detects the HTML error page served with status 200', () => {
    const html = {
      ...raw,
      body: Buffer.from('<!DOCTYPE html>\n<html><body>Not found</body></html>'),
    };
    const result = parseFredCsv(html, ctx);
    expect(result.rows.observations).toEqual([]);
    expect(result.problems[0]?.kind).toBe('parse_error');
    expect(result.problems[0]?.detail).toMatch(/HTML, not CSV/);
  });

  it('never throws on a truncated or corrupted body', () => {
    for (const cut of [0, 1, 22, 100, 100_000, raw.body.byteLength - 1]) {
      const broken = { ...raw, body: raw.body.subarray(0, cut) };
      expect(() => parseFredCsv(broken, ctx)).not.toThrow();
    }
    const junk = {
      ...raw,
      body: Buffer.from('observation_date,DGS10\n1962-01-02,not-a-number\nnope,4.0\n'),
    };
    const result = parseFredCsv(junk, ctx);
    expect(result.rows.observations).toEqual([
      { providerCode: 'DGS10', obsDate: '1962-01-02', value: null, status: 'missing' },
    ]);
    expect(result.problems.map((p) => p.kind)).toEqual(['field_dropped', 'parse_error']);
  });

  it('registers under its own licence row', () => {
    const registry = registerFredAdapters(new ProviderRegistry());
    expect(registry.has('fred.csv')).toBe(true);
    expect(registry.isSchedulerOnly('fred.csv')).toBe(false);
    expect(fredCsvAdapter.sourceId).toBe('fred.csv');
    expect(fredCsvAdapter.adapterVersion).toBe('fred/1.0.0');
    expect(() => fredCsvUrl('DGS10&id=DGS30')).toThrow(/not a FRED series id/);
  });
});
