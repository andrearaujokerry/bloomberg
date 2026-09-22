/**
 * `sec.tickers` — QA-02: `providers/sec/parse.ts#normaliseTickers` over the recorded
 * `sec-company-tickers.json` equals `fixtures/providers/normalised/sec-company-tickers.json`.
 *
 * Every number asserted below was measured from the 2026-09-15 capture, not taken from the plan:
 * **10,422 entries, 8,022 distinct CIKs, 1,435 multi-class issuers, 0 ticker conflicts.**
 *
 * The capture is read through the replay store, never with `node:fs`: the store verifies the
 * fixture's sha256 against `manifest.json` on every load, so a test that passes is a test that
 * parsed the bytes SEC actually served.
 */

import { describe, expect, it } from 'vitest';

import { secAdapters, secTickersAdapter, tickersUrl } from '../../../src/providers/sec/adapter.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { corruptions, readGolden, replayContext, serialiseGolden, toGolden } from './golden.js';

import type { SecTickersRows } from '../../../src/providers/sec/parse.js';
import type { Normalised } from '../../../src/providers/types.js';

const CAPTURE = 'sec-company-tickers.json';
const store = openReplayStore();
const url = tickersUrl();
const raw = store.replay({ providerId: 'sec.tickers', url });
const normalised: Normalised<SecTickersRows> = secTickersAdapter.normalise(raw, replayContext(raw));
const rows = normalised.rows;

describe('sec.tickers — company_tickers.json', () => {
  it('registers all six SEC adapters, each against its own licence row', () => {
    // `register()` refuses an id with no `licence_registry` row (DATA-09) and an `adapter_version`
    // that is not `<family>/<semver>` (§1.4), so building the registry *is* the assertion.
    const registry = createProviderRegistry([...secAdapters]);
    expect(registry.ids()).toEqual([
      'sec.tickers',
      'sec.submissions',
      'sec.companyfacts',
      'sec.frames',
      'sec.atom',
      'sec.archives',
    ]);
    for (const adapter of secAdapters) {
      // The adapter's id IS its licence_registry.source_id (DATA-09).
      expect(adapter.sourceId).toBe(adapter.id);
      expect(adapter.adapterVersion).toBe('sec/1.0.0');
    }
    expect(registry.require('sec.tickers').adapterVersion).toBe('sec/1.0.0');
  });

  it('builds the URL the capture was recorded under', () => {
    expect(url).toBe('https://www.sec.gov/files/company_tickers.json');
    expect(requestKey('sec.tickers', 'GET', url)).toBe(raw.requestKey);
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBe(797_759);
  });

  it('parses without a single problem', () => {
    expect(normalised.problems).toEqual([]);
    expect(normalised.updates).toEqual([]);
    // No published instant: the file carries none, so provenance.source_ts is NULL.
    expect(normalised.sourceTs).toBeNull();
  });

  it('measures 10,422 entries grouped into 8,022 issuers, 1,435 of them multi-class', () => {
    expect(rows.entryCount).toBe(10_422);
    expect(rows.issuerCount).toBe(8_022);
    expect(rows.issuers).toHaveLength(8_022);
    expect(rows.issuers.filter((issuer) => issuer.tickers.length > 1)).toHaveLength(1_435);
    expect(rows.belowMinimum).toBe(false);
    expect(rows.conflicts).toEqual([]);
  });

  it('sorts the object keys numerically, not lexically', () => {
    // Keys "0", "1", "2" are NVDA, AAPL and GOOGL. Under string ordering "10" sorts before "9",
    // which would shuffle the whole output and silently rewrite the golden.
    expect(rows.issuers.slice(0, 3).map((issuer) => issuer.cik)).toEqual([
      '0001045810',
      '0000320193',
      '0001652044',
    ]);
    expect(rows.issuers[0]).toEqual({
      cik: '0001045810',
      name: 'NVIDIA CORP',
      entityType: 'company',
      tickers: ['NVDA'],
    });
  });

  it('groups a multi-class issuer into one row with several tickers', () => {
    const alphabet = rows.issuers.find((issuer) => issuer.cik === '0001652044');
    expect(alphabet?.tickers).toEqual(['GOOGL', 'GOOG', 'GOOGM', 'GOOGN']);
  });

  it('keeps the SEC hyphen in a class ticker rather than rewriting it', () => {
    const berkshire = rows.issuers.find((issuer) => issuer.cik === '0001067983');
    expect(berkshire?.tickers).toEqual(['BRK-B', 'BRK-A']);
  });

  it('zero-pads every CIK to ten characters', () => {
    expect(rows.issuers.every((issuer) => /^\d{10}$/.test(issuer.cik))).toBe(true);
  });

  it('never throws on a truncated, reordered or corrupted body (QA-05)', () => {
    for (const body of corruptions(raw.body, 3)) {
      const out = secTickersAdapter.normalise({ ...raw, body }, replayContext(raw));
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
        secTickersAdapter.id,
        raw.requestKey,
        secTickersAdapter.adapterVersion,
        normalised,
      ),
    );
    expect(golden).toBe(readGolden(CAPTURE));
  });
});
