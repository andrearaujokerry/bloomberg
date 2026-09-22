/**
 * `sec.frames` — QA-02 over `sec-frames-assets.json`, the `us-gaap/Assets/USD/CY2024Q4I` frame.
 *
 * Measured: **6,264 points**, `pts` agreeing with `data.length` exactly, period ends spread over
 * **2024-11-22 → 2025-02-04** (24 distinct dates — a "Q4 instant" frame is a *fiscal* quarter end,
 * so it is not one date, and EQS screening on it has to know that).
 *
 * `filed_at` is deliberately **not** on these rows: a frame carries no filed date, which is why a
 * frame is never the point-in-time source (§7.4). `issuer_id` resolution and the `filed_at`
 * back-fill from `xbrl_facts` are the job's work, not the parser's.
 */

import { describe, expect, it } from 'vitest';

import { framesUrl, secFramesAdapter } from '../../../src/providers/sec/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { corruptions, readGolden, replayContext, serialiseGolden, toGolden } from './golden.js';

const CAPTURE = 'sec-frames-assets.json';
const store = openReplayStore();
const url = framesUrl('Assets', 'USD', 'CY2024Q4I');
if (url === null) throw new Error('framesUrl returned null for a valid frame');
const raw = store.replay({ providerId: 'sec.frames', url });
const normalised = secFramesAdapter.normalise(raw, replayContext(raw));
const rows = normalised.rows;

describe('sec.frames — us-gaap/Assets/USD/CY2024Q4I', () => {
  it('builds the URL the capture was recorded under', () => {
    expect(url).toBe('https://data.sec.gov/api/xbrl/frames/us-gaap/Assets/USD/CY2024Q4I.json');
    expect(requestKey('sec.frames', 'GET', url)).toBe(raw.requestKey);
    expect(raw.body.length).toBe(834_782);
  });

  it("spells a per-share unit SEC's way, in a path segment", () => {
    expect(framesUrl('EarningsPerShareDiluted', 'USD/shares', 'CY2024Q4')).toBe(
      'https://data.sec.gov/api/xbrl/frames/us-gaap/EarningsPerShareDiluted/USD-per-shares/CY2024Q4.json',
    );
    // A frame label that is not a frame never becomes a request.
    expect(framesUrl('Assets', 'USD', 'LAST_QUARTER')).toBeNull();
  });

  it('parses 6,264 points with pts agreeing exactly', () => {
    expect(rows.pts).toBe(6_264);
    expect(rows.frames).toHaveLength(6_264);
    expect(normalised.problems).toEqual([]);
    expect(normalised.updates).toEqual([]);
    expect(normalised.sourceTs).toBeNull();
  });

  it('carries the frame header onto every row', () => {
    expect([rows.taxonomy, rows.concept, rows.unit, rows.frame]).toEqual([
      'us-gaap',
      'Assets',
      'USD',
      'CY2024Q4I',
    ]);
    expect(rows.frames.every((row) => row.frame === 'CY2024Q4I' && row.concept === 'Assets')).toBe(
      true,
    );
  });

  it('zero-pads the integer CIK the payload publishes', () => {
    expect(rows.frames[0]).toEqual({
      taxonomy: 'us-gaap',
      concept: 'Assets',
      unit: 'USD',
      frame: 'CY2024Q4I',
      cik: '0000001750',
      accessionNo: '0001410578-25-000003',
      periodEnd: '2024-11-30',
      value: '2849300000',
      entityName: 'AAR CORP',
    });
    expect(rows.frames.every((row) => /^\d{10}$/.test(row.cik))).toBe(true);
  });

  it('measures a fiscal-quarter spread of period ends, not one date', () => {
    expect(rows.periodEndFrom).toBe('2024-11-22');
    expect(rows.periodEndTo).toBe('2025-02-04');
    expect(new Set(rows.frames.map((row) => row.periodEnd)).size).toBe(24);
  });

  it('never throws on a truncated, reordered or corrupted body (QA-05)', () => {
    for (const body of corruptions(raw.body, 4)) {
      const out = secFramesAdapter.normalise({ ...raw, body }, replayContext(raw));
      // A parse error is a *result*, never an exception: the fuzzer's whole point.
      expect(Array.isArray(out.problems)).toBe(true);
      expect(out.updates).toEqual([]);
      expect(() => JSON.stringify(out.rows)).not.toThrow();
    }
  });

  it('equals the committed golden', () => {
    const golden = serialiseGolden(
      toGolden(
        CAPTURE,
        secFramesAdapter.id,
        raw.requestKey,
        secFramesAdapter.adapterVersion,
        normalised,
      ),
    );
    expect(golden).toBe(readGolden(CAPTURE));
  });
});
