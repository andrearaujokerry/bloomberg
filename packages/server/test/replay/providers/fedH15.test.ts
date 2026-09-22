/**
 * `fed.h15` — QA-02: `parse.ts` over `raw/fed-h15.csv` equals the committed golden
 * `fixtures/providers/normalised/fed-h15.csv.json`, byte for byte.
 *
 * Measured from the capture:
 *
 *  - **a six-line header block** — `Series Description`, `Unit:`, `Multiplier:`, `Currency:`,
 *    `Unique Identifier: ` (with its trailing space) and `Time Period` — in front of **five** data
 *    rows, 2026-09-07 … 2026-09-11;
 *  - **11 CMT series × 5 dates = 55 observations**, of which **11 are missing**: the whole
 *    2026-09-07 row is `ND`, because it is a Sunday. That date is reported in `allMissingDates`
 *    for the `missing_close` monitor, and it produces **no curve point at all**, which is why
 *    there are 44 `UST_CMT` points over four dates rather than 55 over five;
 *  - **columns are bound by series code**, from the `Time Period` row: every column's
 *    `Unique Identifier` ends in its own column name, and every `Multiplier` is `1`. The two
 *    mutation tests below drop a column rather than mis-scale or mis-attribute it;
 *  - **the description has its runs of spaces collapsed**: the file writes
 *    `"at 1-month   constant maturity"` with three spaces, and `econ_series.name` gets one.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import {
  H15_CMT_SERIES_TOKEN,
  H15_DOWNLOAD_URL,
  fedH15Adapter,
  h15Url,
  registerFedH15Adapters,
} from '../../../src/providers/fedH15/adapter.js';
import { CMT_SERIES, parseH15 } from '../../../src/providers/fedH15/parse.js';
import { readGolden, serialiseGolden, toGolden } from './golden.js';
import type { NormaliseContext } from '../../../src/providers/types.js';

const store = openReplayStore();

const URL = h15Url();
const raw = store.replay({ providerId: 'fed.h15', url: URL });
const ctx: NormaliseContext = { provenanceId: 1, capturedAt: raw.capturedAt, lines: new Map() };

const parsed = parseH15(raw, ctx);
const { series, observations, curvePoints, allMissingDates } = parsed.rows;

describe('fed.h15 replay', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.providerId).toBe('fed.h15');
    expect(raw.status).toBe(200);
    expect(raw.requestKey).toBe(requestKey('fed.h15', 'GET', URL));
    expect(raw.sha256).toBe('d69d5e6256c73b88f9f1883dea6be5179d57a1c1df1ea34b32217217aa227423');
    expect(raw.body.byteLength).toBe(2_306);
  });

  it('builds the URL the capture was recorded under, empty parameters included', () => {
    expect(URL).toBe(
      `${H15_DOWNLOAD_URL}?filetype=csv&from=&label=include&lastobs=&layout=seriescolumn&rel=H15&series=${H15_CMT_SERIES_TOKEN}&to=`,
    );
    // `label=include` is what puts the six-line header block in front of the data, and
    // `layout=seriescolumn` is what puts one series in each column: both are load-bearing.
    expect(URL).toContain('label=include');
    expect(URL).toContain('layout=seriescolumn');
  });

  it('matches the committed golden exactly', () => {
    const golden = serialiseGolden(
      toGolden(
        'fed-h15.csv',
        fedH15Adapter.id,
        raw.requestKey,
        fedH15Adapter.adapterVersion,
        parsed,
      ),
    );
    expect(golden).toBe(readGolden('fed-h15.csv.json'));
  });

  it('reads eleven CMT series out of the header block', () => {
    expect(parsed.problems).toEqual([]);
    expect(series).toHaveLength(11);
    expect(series.map((s) => s.providerCode)).toEqual(CMT_SERIES.map((s) => s.providerCode));
    expect(series.map((s) => s.tenor)).toEqual([
      '1M',
      '3M',
      '6M',
      '1Y',
      '2Y',
      '3Y',
      '5Y',
      '7Y',
      '10Y',
      '20Y',
      '30Y',
    ]);
    expect(series[0]).toEqual({
      providerCode: 'RIFLGFCM01_N.B',
      name: 'Market yield on U.S. Treasury securities at 1-month constant maturity, quoted on investment basis',
      units: 'Percent',
      uniqueIdentifier: 'H15/H15/RIFLGFCM01_N.B',
      tenor: '1M',
      tenorDays: 30,
    });
    // The three-space run in the file is collapsed to one.
    expect(raw.body.toString('utf8')).toContain('at 1-month   constant maturity');
    expect(series[0]?.name).toContain('at 1-month constant maturity');
    expect(series.every((s) => s.units === 'Percent')).toBe(true);
    expect(series.every((s) => s.uniqueIdentifier.endsWith(s.providerCode))).toBe(true);
  });

  it('parses 55 observations over five dates, 11 of them missing', () => {
    expect(observations).toHaveLength(55);
    const dates = [...new Set(observations.map((o) => o.obsDate))];
    expect(dates).toEqual(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
    const missing = observations.filter((o) => o.status === 'missing');
    expect(missing).toHaveLength(11);
    expect(new Set(missing.map((o) => o.obsDate))).toEqual(new Set(['2026-09-07']));
    expect(missing.every((o) => o.value === null)).toBe(true);
    expect(allMissingDates).toEqual(['2026-09-07']);
    const tenYear = observations.filter((o) => o.providerCode === 'RIFLGFCY10_N.B');
    expect(tenYear.map((o) => o.value)).toEqual([null, 4.8, 4.83, 4.95, 4.96]);
  });

  it('publishes 44 UST_CMT points and never one for an ND row', () => {
    expect(curvePoints).toHaveLength(44);
    expect(new Set(curvePoints.map((p) => p.curveDate))).toEqual(
      new Set(['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']),
    );
    expect(curvePoints.every((p) => p.curveId === 'UST_CMT')).toBe(true);
    expect(curvePoints.every((p) => p.quoteType === 'cmt_yield')).toBe(true);
    expect(curvePoints[0]).toEqual({
      curveId: 'UST_CMT',
      curveDate: '2026-09-08',
      tenor: '1M',
      quoteType: 'cmt_yield',
      vintageAt: new Date(raw.capturedAt).toISOString(),
      tenorDays: 30,
      value: 3.81,
      instrumentId: null,
      maturityDate: null,
    });
    // The 10Y point is the one `reconcile.ts` checks against the Treasury par curve (§10.3).
    const tenYear = curvePoints.filter((p) => p.tenor === '10Y');
    expect(tenYear.map((p) => p.value)).toEqual([4.8, 4.83, 4.95, 4.96]);
    // No plant update: `e:<seriesCode>` and `c:UST_CMT` are the job's to publish.
    expect(parsed.updates).toEqual([]);
    expect(parsed.sourceTs).toBeNull();
  });

  it('drops a column whose multiplier is not 1 rather than scaling it', () => {
    const scaled = {
      ...raw,
      body: Buffer.from(
        raw.body.toString('utf8').replace('"Multiplier:","1","1"', '"Multiplier:","100","1"'),
      ),
    };
    const result = parseH15(scaled, ctx);
    expect(result.rows.series).toHaveLength(10);
    expect(result.rows.series.some((s) => s.providerCode === 'RIFLGFCM01_N.B')).toBe(false);
    expect(result.rows.observations).toHaveLength(50);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe('schema_drift');
    expect(result.problems[0]?.detail).toMatch(/Multiplier 100, not 1/);
  });

  it('drops a column whose unique identifier and column name disagree', () => {
    const mismatched = {
      ...raw,
      body: Buffer.from(
        raw.body.toString('utf8').replace('"H15/H15/RIFLGFCY10_N.B"', '"H15/H15/RIFLGFCY09_N.B"'),
      ),
    };
    const result = parseH15(mismatched, ctx);
    expect(result.rows.series).toHaveLength(10);
    expect(result.rows.series.some((s) => s.providerCode === 'RIFLGFCY10_N.B')).toBe(false);
    expect(result.rows.curvePoints).toHaveLength(40);
    expect(result.problems[0]?.detail).toMatch(/last segment is 'RIFLGFCY09_N.B'/);
  });

  it('never throws on a truncated or corrupted body', () => {
    for (const cut of [0, 1, 500, 1_500, 2_000, raw.body.byteLength - 1]) {
      const broken = { ...raw, body: raw.body.subarray(0, cut) };
      expect(() => parseH15(broken, ctx)).not.toThrow();
    }
    const headerOnly = {
      ...raw,
      body: Buffer.from(raw.body.toString('utf8').split('\n').slice(0, 6).join('\n')),
    };
    const result = parseH15(headerOnly, ctx);
    expect(result.rows.observations).toEqual([]);
    expect(result.problems[0]?.kind).toBe('schema_drift');
    const html = { ...raw, body: Buffer.from('<html><body>Output.aspx</body></html>') };
    expect(parseH15(html, ctx).problems[0]?.detail).toMatch(/HTML, not CSV/);
  });

  it('registers under its own licence row', () => {
    const registry = registerFedH15Adapters(new ProviderRegistry());
    expect(registry.has('fed.h15')).toBe(true);
    expect(fedH15Adapter.sourceId).toBe('fed.h15');
    expect(fedH15Adapter.adapterVersion).toBe('fedH15/1.0.0');
  });
});
