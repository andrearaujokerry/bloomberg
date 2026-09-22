/**
 * `sec.archives` — QA-02 over `sec-nport-SPY-primary_doc.xml`, SPY's Form N-PORT (REF-07).
 *
 * The one defect this parser exists to avoid is worth stating again: the document holds **504
 * `<invstOrSec>` blocks but 505 `<cusip>` and 505 `<isin>` tags**, because holding 220 — the
 * `CONTRA HOLOGIC INCORPO` contra-rights line, `assetCat DE` — nests a *reference* instrument's
 * identifiers inside `derivativeInfo`. A document-wide `getElementsByTagName('cusip')` therefore
 * shifts every identifier from that point on by one, and the S&P 500 silently becomes a list of
 * 504 companies attached to the wrong 504 securities. The test below asserts the count inside the
 * scoped traversal **and** the identifiers of the holdings on either side of the derivative, which
 * is where a one-off shift shows first.
 *
 * Everything else measured from the capture: **29 placeholder CUSIPs** (`000000000`, foreign
 * domiciles identified only by ISIN), **503 index-eligible holdings**, `repPdDate 2026-06-30`
 * against `repPdEnd 2026-09-30`, **Σ pctVal 99.980263850115** and **Σ valUSD 781,034,695,502.07**
 * against `netAssets 781,188,872,106.76` — 0.02 % apart.
 */

import { describe, expect, it } from 'vitest';

import { nportUrl, secArchivesAdapter } from '../../../src/providers/sec/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { corruptions, readGolden, replayContext, serialiseGolden, toGolden } from './golden.js';

const CAPTURE = 'sec-nport-SPY-primary_doc.xml';
const store = openReplayStore();
const url = nportUrl('0000884394', '0001410368-26-089410');
if (url === null) throw new Error('nportUrl returned null for a valid filing');
const raw = store.replay({ providerId: 'sec.archives', url });
const normalised = secArchivesAdapter.normalise(raw, replayContext(raw));
const rows = normalised.rows;

describe('sec.archives — SPY N-PORT', () => {
  it('unpads the CIK and strips the dashes and the xsl viewer from the path', () => {
    expect(url).toBe(
      'https://www.sec.gov/Archives/edgar/data/884394/000141036826089410/primary_doc.xml',
    );
    expect(
      nportUrl('0000884394', '0001410368-26-089410', 'xslFormNPORT-P_X01/primary_doc.xml'),
    ).toBe(url);
    expect(requestKey('sec.archives', 'GET', url)).toBe(raw.requestKey);
    expect(raw.body.length).toBe(454_892);
  });

  it('parses 504 holdings with no problems', () => {
    expect(rows.holdingCount).toBe(504);
    expect(rows.holdings).toHaveLength(504);
    expect(rows.outsideCountBand).toBe(false);
    expect(normalised.problems).toEqual([]);
    expect(normalised.updates).toEqual([]);
  });

  it('reads the header the portfolio date comes from', () => {
    expect(rows.header).toEqual({
      submissionType: 'NPORT-P',
      regName: 'State Street(R) SPDR(R) S&P 500(R) ETF Trust',
      regCik: '0000884394',
      regLei: '549300NZAMSJ8FXPQQ63',
      seriesName: 'N/A',
      seriesLei: '549300NZAMSJ8FXPQQ63',
      // The PORTFOLIO date — index_members.as_of_date — not the filing date and not repPdEnd.
      repPdDate: '2026-06-30',
      repPdEnd: '2026-09-30',
      totAssets: '783339902049.69',
      totLiabs: '2151029942.93',
      netAssets: '781188872106.76',
    });
  });

  it('sees 504 cusips in the scoped traversal, not the 505 the document contains', () => {
    expect(rows.cusipCount).toBe(504);
    expect(rows.cusipCount).toBe(rows.holdingCount);
  });

  it('keeps each holding`s identifiers its own, across the derivative at line 220', () => {
    const derivative = rows.holdings[219];
    expect(derivative?.lineNo).toBe(220);
    expect(derivative?.name).toBe('CONTRA HOLOGIC INCORPO');
    expect(derivative?.assetCat).toBe('DE');
    // Its OWN identifiers — not the nested reference instrument's 436440101 / US4364401012.
    expect(derivative?.cusip).toBe('436CVR021');
    expect(derivative?.isin).toBe('US436CVR0216');
    expect(derivative?.indexEligible).toBe(false);

    // The holding after it is where a one-off shift would first be visible.
    const after = rows.holdings[220];
    expect(after?.name).toBe('Home Depot Inc/The');
    expect(after?.cusip).toBe('437076102');
    expect(after?.isin).toBe('US4370761029');
  });

  it('treats the all-zero CUSIP as absent — 29 foreign domiciles identified only by ISIN', () => {
    expect(rows.placeholderCusipCount).toBe(29);
    // Not one row carries the placeholder: a CUSIP-first resolver would map all 29 onto one
    // entity, and the second `identifiers(CUSIP, '000000000')` write raises identifiers_bt_excl.
    expect(rows.holdings.some((holding) => holding.cusip === '000000000')).toBe(false);
    const placeholders = rows.holdings.filter(
      (holding) => holding.cusip === null && holding.isin !== null,
    );
    expect(placeholders).toHaveLength(29);
  });

  it('reads the ISIN from an attribute, not from element text', () => {
    // `<identifiers><isin value="US0010551028"/></identifiers>` — the element has no text at all.
    expect(rows.holdings[0]).toEqual({
      lineNo: 1,
      name: 'Aflac Inc',
      lei: '549300N0B7DOGLXWPP39',
      cusip: '001055102',
      isin: 'US0010551028',
      shares: '5551377',
      units: 'NS',
      curCd: 'USD',
      marketValue: '650898953.25',
      weight: '0.00083321585405',
      pctVal: '0.083321585405',
      payoffProfile: 'Long',
      assetCat: 'EC',
      issuerCat: 'CORP',
      country: 'US',
      indexEligible: true,
    });
  });

  it('converts the published percent to a fraction by shifting the decimal string', () => {
    // 0.083321585405 % -> 0.00083321585405. Through a float this is 0.0008332158540500001.
    for (const holding of rows.holdings) {
      if (holding.pctVal === null) continue;
      expect(holding.weight).not.toBeNull();
      expect(Number(holding.weight)).toBeCloseTo(Number(holding.pctVal) / 100, 15);
    }
    expect(rows.pctValSum).toBe('99.980263850115');
  });

  it('counts 503 index-eligible holdings — EC, Long, NS, USD', () => {
    expect(rows.eligibleCount).toBe(503);
    const ineligible = rows.holdings.filter((holding) => !holding.indexEligible);
    expect(ineligible).toHaveLength(1);
    expect(ineligible[0]?.name).toBe('CONTRA HOLOGIC INCORPO');
    // A PA (principal amount) row would be debt and would carry no share count.
    expect(rows.holdings.every((holding) => holding.units === 'NS')).toBe(true);
  });

  it('sums valUSD to within 0.02 % of the filing`s own netAssets', () => {
    expect(rows.valUsdSum).toBe('781034695502.07');
    const drift = Math.abs(Number(rows.valUsdSum) / Number(rows.header.netAssets) - 1);
    expect(drift).toBeLessThan(0.01);
  });

  it('issuerCat is NULL on the rows that publish issuerConditional instead — no problem raised', () => {
    expect(rows.holdings.filter((holding) => holding.issuerCat === null)).toHaveLength(30);
  });

  it('never throws on a truncated, reordered or corrupted body (QA-05)', () => {
    for (const body of corruptions(raw.body, 6)) {
      const out = secArchivesAdapter.normalise({ ...raw, body }, replayContext(raw));
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
        secArchivesAdapter.id,
        raw.requestKey,
        secArchivesAdapter.adapterVersion,
        normalised,
      ),
    );
    expect(golden).toBe(readGolden(`${CAPTURE}.json`));
  });
});
