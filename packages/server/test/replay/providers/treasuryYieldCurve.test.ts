/**
 * `treasury.yieldcurve` — QA-02: `parse.ts` over `raw/treasury-xml2` equals the committed golden
 * `fixtures/providers/normalised/treasury-xml2.json`, byte for byte.
 *
 * Everything asserted below was measured from the capture, not copied from the plan:
 *
 *  - **9 entries × 14 tenors = 126 `curve_points`**, business days 2026-09-01 … 2026-09-14
 *    (2026-09-07 is Labor Day and is simply not published — the feed has no gap row);
 *  - **no absent tenor and no problem**: every one of the fourteen `BC_*` elements is present on
 *    every one of the nine days, which is what makes the `field_population` monitor meaningful
 *    when it one day is not;
 *  - **`BC_30YEARDISPLAY` is dropped**, so a day has fourteen points and not fifteen, and its
 *    agreement with `BC_30YEAR` is recorded as zero cross-check mismatches;
 *  - **`d:NEW_DATE` is taken as a naive date**: `2026-09-01T00:00:00` → `'2026-09-01'`, never
 *    shifted by a timezone — a UTC parse of that string would still say `2026-09-01`, but a local
 *    parse west of Greenwich would say `2026-08-31`, and that is the bug this pins;
 *  - the values span 3.79 %–5.39 %, inside the 0–25 % band, and no adjacent pair inverts by 200 bp,
 *    so nothing is dropped.
 *
 * The bytes come from the replay store — `origin: 'replay'` — never from a socket.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import {
  TREASURY_XML_URL,
  YIELD_CURVE_DATASET,
  monthOfIsoDate,
  registerTreasuryAdapters,
  treasuryUrl,
  treasuryYieldCurveAdapter,
} from '../../../src/providers/treasury/adapter.js';
import { PAR_TENORS, parseYieldCurve } from '../../../src/providers/treasury/parse.js';
import { readGolden, serialiseGolden, toGolden } from './golden.js';
import type { NormaliseContext } from '../../../src/providers/types.js';

const store = openReplayStore();

/** The recorded request: September 2026, the month the capture was taken in. */
const URL = treasuryUrl(YIELD_CURVE_DATASET, '202609');
const raw = store.replay({ providerId: 'treasury.yieldcurve', url: URL });

/** The canonical context: a curve has no md lines, so the parse sees nothing but the bytes. */
const ctx: NormaliseContext = {
  provenanceId: 1,
  capturedAt: raw.capturedAt,
  lines: new Map(),
};

const parsed = parseYieldCurve(raw, ctx);
const points = parsed.rows.curvePoints;

/** Byte-for-byte against the golden, reporting the first differing line rather than 40 KB. */
describe('treasury.yieldcurve replay', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(raw.origin).toBe('replay');
    expect(raw.providerId).toBe('treasury.yieldcurve');
    expect(raw.status).toBe(200);
    expect(raw.requestKey).toBe(requestKey('treasury.yieldcurve', 'GET', URL));
    expect(raw.sha256).toBe('d838ffce6b394db8f1a6bd007421cee53ce679123a4c81aaf4781c10f86e45c0');
    expect(raw.body.byteLength).toBe(14_578);
  });

  it('builds the URL the capture was recorded under', () => {
    expect(URL).toBe(
      `${TREASURY_XML_URL}?data=daily_treasury_yield_curve&field_tdr_date_value_month=202609`,
    );
    expect(monthOfIsoDate('2026-09-01')).toBe('202609');
    expect(() => treasuryUrl(YIELD_CURVE_DATASET, 'September')).toThrow(/YYYYMM/);
  });

  it('matches the committed golden exactly', () => {
    const golden = serialiseGolden(
      toGolden(
        'treasury-xml2',
        treasuryYieldCurveAdapter.id,
        raw.requestKey,
        treasuryYieldCurveAdapter.adapterVersion,
        parsed,
      ),
    );
    expect(golden).toBe(readGolden('treasury-xml2.json'));
  });

  it('publishes 126 par points over nine business days, with no problem', () => {
    expect(parsed.problems).toEqual([]);
    expect(points).toHaveLength(126);
    const dates = [...new Set(points.map((p) => p.curveDate))];
    expect(dates).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-14',
    ]);
    // Labor Day 2026 is 2026-09-07: the feed publishes no entry for it at all.
    expect(dates).not.toContain('2026-09-07');
  });

  it('covers all fourteen tenors on every day, in ascending tenor_days', () => {
    expect(parsed.rows.absentTenors).toEqual([]);
    const expectedTenors = PAR_TENORS.map((t) => t.tenor);
    expect(expectedTenors).toHaveLength(14);
    for (const date of new Set(points.map((p) => p.curveDate))) {
      const day = points.filter((p) => p.curveDate === date);
      expect(day.map((p) => p.tenor)).toEqual(expectedTenors);
      expect(day.map((p) => p.tenorDays)).toEqual(PAR_TENORS.map((t) => t.tenorDays));
      const ascending = [...day].sort((a, b) => a.tenorDays - b.tenorDays);
      expect(day).toEqual(ascending);
    }
    // `BC_30YEARDISPLAY` is dropped, not published as a fifteenth tenor.
    expect(new Set(points.map((p) => p.tenor)).size).toBe(14);
    expect(parsed.rows.crossChecks).toEqual([]);
  });

  it('carries the feed instant, the naive curve date and the capture vintage', () => {
    expect(parsed.sourceTs?.toISOString()).toBe('2026-09-15T02:01:24.000Z');
    const first = points[0];
    expect(first).toMatchObject({
      curveId: 'UST_PAR',
      curveDate: '2026-09-01',
      tenor: '1M',
      quoteType: 'par_yield',
      tenorDays: 30,
      value: 3.85,
      instrumentId: null,
      maturityDate: null,
    });
    expect(first?.vintageAt).toBe(new Date(raw.capturedAt).toISOString());
    expect(points[13]).toMatchObject({ tenor: '30Y', tenorDays: 10_958, value: 5.27 });
    const last = points.filter((p) => p.curveDate === '2026-09-14');
    expect(last.map((p) => p.value)).toEqual([
      3.94, 4, 4.06, 4.11, 4.18, 4.18, 4.37, 4.65, 4.73, 4.8, 4.88, 4.97, 5.37, 5.34,
    ]);
  });

  it('keeps every value inside the published band', () => {
    const values = points.map((p) => p.value);
    expect(Math.min(...values)).toBe(3.79);
    expect(Math.max(...values)).toBe(5.39);
    for (const value of values) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of values) expect(value).toBeLessThanOrEqual(25);
  });

  it('never throws on a truncated or corrupted body', () => {
    for (const cut of [0, 1, 200, 1000, 7000, raw.body.byteLength - 1]) {
      const broken = { ...raw, body: raw.body.subarray(0, cut) };
      const result = parseYieldCurve(broken, { ...ctx, capturedAt: broken.capturedAt });
      expect(result.rows.curvePoints.length).toBeGreaterThanOrEqual(0);
      if (result.rows.curvePoints.length === 0) expect(result.problems.length).toBeGreaterThan(0);
    }
    const garbage = { ...raw, body: Buffer.from('<feed><entry>not xml at all') };
    expect(() => parseYieldCurve(garbage, ctx)).not.toThrow();
  });

  it('registers scheduler-only, under its own licence row', () => {
    const registry = registerTreasuryAdapters(new ProviderRegistry());
    expect(registry.has('treasury.yieldcurve')).toBe(true);
    expect(registry.isSchedulerOnly('treasury.yieldcurve')).toBe(true);
    expect(treasuryYieldCurveAdapter.sourceId).toBe('treasury.yieldcurve');
    expect(treasuryYieldCurveAdapter.adapterVersion).toBe('treasury/1.0.0');
  });
});
