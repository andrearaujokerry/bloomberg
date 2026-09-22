/**
 * `ssga.holdings` — QA-02 over `ssga-spy-holdings.xlsx`, the issuer's daily S&P 500 file (§8.1).
 *
 * Measured from the 2026-09-15 capture: **505 published rows**, `Holdings: As of 14-Sep-2026`,
 * **Σ Weight 99.951255**, every row `USD`.
 *
 * Four properties are pinned because each is a way for this file to go wrong without anyone
 * noticing until a weight is on screen:
 *
 *  1. **the table is found by header text.** The metadata block above it is four rows today and
 *     has been five and six; `Name` is the anchor, never row 6.
 *  2. **`-` means "none".** The `US DOLLAR` line publishes `-` for both Ticker and SEDOL, and
 *     *every* row publishes `-` for Sector — so this capture yields no GICS join at all, which is
 *     a fact about the file and not a bug to paper over.
 *  3. **Weight is a percent and `index_members.weight` is a fraction**, converted by shifting the
 *     decimal string: `7.777528` → `0.07777528`, exactly.
 *  4. **`provenance.source_ts` is the close the file describes** — 16:00 America/New_York on the
 *     as-of date, `2026-09-14T20:00:00Z` — not the instant we fetched it.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { SSGA_SPY_URL, ssgaHoldingsAdapter } from '../../../src/providers/ssga/adapter.js';
import { parseSsgaDate } from '../../../src/providers/ssga/parse.js';
import { createProviderRegistry } from '../../../src/providers/registry.js';
import { corruptions, readGolden, replayContext, serialiseGolden, toGolden } from './golden.js';

const CAPTURE = 'ssga-spy-holdings.xlsx';
const store = openReplayStore();
const raw = store.replay({ providerId: 'ssga.holdings', url: SSGA_SPY_URL });
const normalised = ssgaHoldingsAdapter.normalise(raw, replayContext(raw));
const rows = normalised.rows;

describe('ssga.holdings — the SPDR daily file', () => {
  it('registers with its licence row and a well-formed adapter_version', () => {
    const registry = createProviderRegistry([ssgaHoldingsAdapter]);
    expect(registry.ids()).toEqual(['ssga.holdings']);
    expect(ssgaHoldingsAdapter.sourceId).toBe('ssga.holdings');
    expect(ssgaHoldingsAdapter.adapterVersion).toBe('ssga/1.0.0');
  });

  it('builds the URL the capture was recorded under', () => {
    expect(SSGA_SPY_URL).toBe(
      'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/' +
        'holdings-daily-us-en-spy.xlsx',
    );
    expect(requestKey('ssga.holdings', 'GET', SSGA_SPY_URL)).toBe(raw.requestKey);
    expect(raw.body.length).toBe(54_431);
    // The bytes are a ZIP, not the HTML page the CDN serves an unfamiliar agent.
    expect(raw.body.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('parses 505 rows with no problems', () => {
    expect(rows.rowCount).toBe(505);
    expect(rows.holdings).toHaveLength(505);
    expect(rows.outsideBands).toBe(false);
    expect(normalised.problems).toEqual([]);
    expect(normalised.updates).toEqual([]);
  });

  it('finds the table by its header text, not by a row number', () => {
    expect(rows.header).toEqual({
      fundName: 'State Street® SPDR® S&P 500® ETF Trust',
      ticker: 'SPY',
      asOfDate: '2026-09-14',
      headerRow: 5,
    });
  });

  it('parses the date with a month table, in every spelling SSGA has used', () => {
    expect(parseSsgaDate('As of 14-Sep-2026')).toBe('2026-09-14');
    expect(parseSsgaDate('Sep 14, 2026')).toBe('2026-09-14');
    expect(parseSsgaDate('2026-09-14')).toBe('2026-09-14');
    // Not a date, and never `Date.parse`'s guess at one.
    expect(parseSsgaDate('14/09/2026')).toBeNull();
    expect(parseSsgaDate('As of 31-Feb-2026')).toBeNull();
  });

  it('stamps source_ts at the close the file describes, 16:00 ET', () => {
    expect(normalised.sourceTs?.toISOString()).toBe('2026-09-14T20:00:00.000Z');
  });

  it('reads `-` as "none" rather than as a value', () => {
    const cash = rows.holdings.find((holding) => holding.name === 'US DOLLAR');
    expect(cash?.lineNo).toBe(93);
    expect(cash?.ticker).toBeNull();
    expect(cash?.sedol).toBeNull();
    expect(cash?.cusip).toBe('999USDZ92');
    // Sector is `-` on every row of this capture: SSGA published no sector names at all, so the
    // GICS join has nothing to match and the parser says so instead of inventing a code.
    expect(rows.holdings.every((holding) => holding.sector === null)).toBe(true);
  });

  it('addresses cells by their `r` reference, so a blank never shifts a column', () => {
    // If columns were counted rather than addressed, the `-` cells on the cash line would pull
    // Weight into Sector; both the cash line and its neighbours keep their own numbers.
    expect(rows.holdings[0]).toEqual({
      lineNo: 1,
      name: 'NVIDIA CORP',
      ticker: 'NVDA',
      cusip: '67066G104',
      sedol: '2379504',
      weightPercent: '7.777528',
      weight: '0.07777528',
      sector: null,
      shares: '295150616',
      currency: 'USD',
      marketValue: null,
    });
    const cash = rows.holdings.find((holding) => holding.name === 'US DOLLAR');
    expect(cash?.weightPercent).toBe('0.19449');
    expect(cash?.shares).toBe('1557039045.89');
  });

  it('reads a stored number literal rather than a locale rendering', () => {
    // The cell holds `2.95150616E8`; nothing downstream may ever see that string.
    expect(
      rows.holdings.every((holding) => holding.shares === null || !/[eE]/.test(holding.shares)),
    ).toBe(true);
    const contra = rows.holdings[504];
    expect(contra?.name).toBe('CONTRA HOLOGIC INCORPO');
    expect(contra?.weightPercent).toBe('0.000003');
    expect(contra?.weight).toBe('0.00000003');
  });

  it('converts percent to fraction exactly, and sums to the file`s own total', () => {
    expect(rows.weightSum).toBe('99.951255');
    for (const holding of rows.holdings) {
      if (holding.weightPercent === null) continue;
      expect(Number(holding.weight)).toBeCloseTo(Number(holding.weightPercent) / 100, 15);
    }
  });

  it('never invents a market value the file does not publish', () => {
    expect(rows.holdings.every((holding) => holding.marketValue === null)).toBe(true);
  });

  it('counts the USD rows without claiming an index eligibility the sheet does not state', () => {
    expect(rows.usdRowCount).toBe(505);
    expect(rows.holdings.every((holding) => holding.currency === 'USD')).toBe(true);
    // The sheet states no eligibility, so no row carries a flag that MEMB could join against
    // SPY's N-PORT — which marks CONTRA HOLOGIC (436CVR021) ineligible and would otherwise show
    // REF-07 a phantom add/drop for a holding both sources list.
    expect(rows.holdings.some((holding) => 'indexEligible' in holding)).toBe(false);
    expect(rows.holdings[504]?.cusip).toBe('436CVR021');
  });

  it('never throws on a truncated, reordered or corrupted body (QA-05)', () => {
    for (const body of corruptions(raw.body, 8)) {
      const out = ssgaHoldingsAdapter.normalise({ ...raw, body }, replayContext(raw));
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
        ssgaHoldingsAdapter.id,
        raw.requestKey,
        ssgaHoldingsAdapter.adapterVersion,
        normalised,
      ),
    );
    expect(golden).toBe(readGolden(`${CAPTURE}.json`));
  });
});
