/**
 * `sec.submissions` — QA-02 over **two** recorded captures, because the two answer different
 * questions: `sec-submissions-AAPL.json` (an operating company, 1,000 filings) and
 * `sec-spy-submissions.json` (a fund, 275 filings, and the XSL trap).
 *
 * Measured from the 2026-09-15 captures, not assumed:
 *
 *  1. **1,000 and 275 filings**, from sixteen parallel arrays of equal length. A length mismatch
 *     drops the whole payload, because a short array shifts every later filing's form by one.
 *  2. **SPY's issuer becomes a `fund`**: `entityType 'other'` + tickers + an `NPORT-P` history is
 *     the §7.2 rule, and this capture is the only place it fires.
 *  3. **The XSL trap.** 41 of SPY's filings publish `primaryDocument` as
 *     `xslFormNPORT-P_X01/primary_doc.xml` — the styled viewer, which returns HTML.
 *     `filings.primary_doc` keeps it verbatim and `filings.url` strips it, and the URL that comes
 *     out is byte-for-byte the one the `sec.archives` capture was recorded under.
 *  4. **49 of Apple's filings were accepted before their filing date** and 7 after it, both of
 *     them ordinary EDGAR behaviour rather than errors — see `parse.ts` for why the literal
 *     reading of PROVIDERS §7.2 would have thrown away the 2024-08-01 10-Q.
 */

import { describe, expect, it } from 'vitest';

import {
  nportUrl,
  secSubmissionsAdapter,
  submissionsUrl,
} from '../../../src/providers/sec/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { corruptions, readGolden, replayContext, serialiseGolden, toGolden } from './golden.js';

import type { SecSubmissionsRows } from '../../../src/providers/sec/parse.js';
import type { Normalised, RawRecord } from '../../../src/providers/types.js';

const store = openReplayStore();

function run(cik: string): {
  url: string;
  raw: RawRecord;
  normalised: Normalised<SecSubmissionsRows>;
} {
  const url = submissionsUrl(cik);
  if (url === null) throw new Error(`no submissions URL for ${cik}`);
  const raw = store.replay({ providerId: 'sec.submissions', url });
  return {
    url,
    raw,
    normalised: secSubmissionsAdapter.normalise(raw, replayContext(raw)),
  };
}

const apple = run('0000320193');
const spy = run('0000884394');

describe('sec.submissions — Apple (sec-submissions-AAPL.json)', () => {
  it('builds the padded-CIK URL the capture was recorded under', () => {
    expect(apple.url).toBe('https://data.sec.gov/submissions/CIK0000320193.json');
    expect(requestKey('sec.submissions', 'GET', apple.url)).toBe(apple.raw.requestKey);
    expect(apple.raw.body.length).toBe(164_091);
  });

  it('parses 1,000 filings with no problems', () => {
    expect(apple.normalised.problems).toEqual([]);
    expect(apple.normalised.rows.filings).toHaveLength(1_000);
  });

  it('reads the issuer header the FA and DES screens depend on', () => {
    expect(apple.normalised.rows.issuer).toEqual({
      cik: '0000320193',
      name: 'Apple Inc.',
      sic: '3571',
      sicDescription: 'Electronic Computers',
      fiscalYearEnd: '0926',
      stateOfInc: 'CA',
      filerCategory: 'Large accelerated filer',
      entityType: 'operating',
      website: null,
      formerNames: [
        { name: 'APPLE INC', from: '2007-01-10T05:00:00Z', to: '2019-08-05T04:00:00Z' },
        { name: 'APPLE COMPUTER INC', from: '1994-01-26T05:00:00Z', to: '2007-01-04T05:00:00Z' },
        {
          name: 'APPLE COMPUTER INC/ FA',
          from: '1997-07-28T04:00:00Z',
          to: '1997-07-28T04:00:00Z',
        },
      ],
    });
  });

  it('maps the exchange name to a MIC by a literal table, never by a guess', () => {
    expect(apple.normalised.rows.listings).toEqual([
      { ticker: 'AAPL', exchange: 'Nasdaq', mic: 'XNAS' },
    ]);
    expect(apple.normalised.rows.identifiers).toEqual([
      { scheme: 'TICKER_EXCH', value: 'AAPL', qualifier: 'US' },
    ]);
    // `lei` is null on both captures, so no LEI identifier may be minted.
    expect(apple.normalised.rows.identifiers.some((id) => id.scheme === 'LEI')).toBe(false);
  });

  it('opens an issuer_aliases row per former name and a SIC classification', () => {
    expect(apple.normalised.rows.aliases).toHaveLength(3);
    expect(apple.normalised.rows.aliases[0]?.kind).toBe('former_name');
    expect(apple.normalised.rows.classifications).toEqual([{ scheme: 'SIC', code: '3571' }]);
  });

  it('counts the two ordinary acceptance orderings instead of dropping 56 real filings', () => {
    expect(apple.normalised.rows.acceptedBeforeFiledDate).toBe(49);
    expect(apple.normalised.rows.acceptedAfterFiledDate).toBe(7);
    // The 2024-08-01 10-Q: accepted at 18:03 ET the evening before the date EDGAR stamped it.
    const tenQ = apple.normalised.rows.filings.find(
      (filing) => filing.accessionNo === '0000320193-24-000081',
    );
    expect(tenQ?.form).toBe('10-Q');
    expect(tenQ?.filedDate).toBe('2024-08-02');
    expect(tenQ?.acceptedAt).toBe('2024-08-01T22:03:34Z');
  });

  it('publishes the newest acceptance as provenance.source_ts', () => {
    expect(apple.normalised.rows.newestFilingDate).toBe('2026-09-10');
    expect(apple.normalised.sourceTs?.toISOString()).toBe('2026-09-10T22:30:31.000Z');
  });

  it('records the overflow index without following it', () => {
    expect(apple.normalised.rows.overflowFiles).toEqual([
      {
        name: 'CIK0000320193-submissions-001.json',
        filingCount: 1_247,
        filingFrom: '1994-01-26',
        filingTo: '2015-07-22',
      },
    ]);
  });

  it('never throws on a truncated, reordered or corrupted body (QA-05)', () => {
    for (const body of corruptions(apple.raw.body, 6)) {
      const out = secSubmissionsAdapter.normalise({ ...apple.raw, body }, replayContext(apple.raw));
      // A parse error is a *result*, never an exception: the fuzzer's whole point.
      expect(Array.isArray(out.problems)).toBe(true);
      expect(out.updates).toEqual([]);
      expect(() => JSON.stringify(out.rows)).not.toThrow();
    }
  });

  it('equals the committed golden', () => {
    const golden = serialiseGolden(
      toGolden(
        'sec-submissions-AAPL.json',
        secSubmissionsAdapter.id,
        apple.raw.requestKey,
        secSubmissionsAdapter.adapterVersion,
        apple.normalised,
      ),
    );
    expect(golden).toBe(readGolden('sec-submissions-AAPL.json'));
  });
});

describe('sec.submissions — SPY (sec-spy-submissions.json)', () => {
  it('parses 275 filings with no problems', () => {
    expect(spy.normalised.problems).toEqual([]);
    expect(spy.normalised.rows.filings).toHaveLength(275);
    expect(spy.raw.body.length).toBe(49_210);
  });

  it("types the trust as a fund — 'other' + tickers + an NPORT-P history (§7.2)", () => {
    expect(spy.normalised.rows.issuer?.entityType).toBe('fund');
    expect(spy.normalised.rows.issuer?.name).toBe('SPDR S&P 500 ETF TRUST');
    expect(spy.normalised.rows.issuer?.fiscalYearEnd).toBe('0930');
    expect(spy.normalised.rows.listings).toEqual([
      { ticker: 'SPY', exchange: 'NYSE', mic: 'XNYS' },
    ]);
    expect(spy.normalised.rows.filings.filter((filing) => filing.form === 'NPORT-P')).toHaveLength(
      28,
    );
  });

  it('keeps primary_doc verbatim and strips the xsl viewer from the URL', () => {
    const xsl = spy.normalised.rows.filings.filter((filing) =>
      filing.primaryDoc?.startsWith('xsl'),
    );
    expect(xsl).toHaveLength(41);

    const latest = spy.normalised.rows.filings.find(
      (filing) => filing.accessionNo === '0001410368-26-089410',
    );
    expect(latest?.primaryDoc).toBe('xslFormNPORT-P_X01/primary_doc.xml');
    expect(latest?.reportDate).toBe('2026-06-30');
    // §7.6's two-step, closed: the URL this filing yields is the one the sec.archives capture
    // was recorded under, so the N-PORT job follows the submissions index without a literal.
    expect(latest?.url).toBe(nportUrl('0000884394', '0001410368-26-089410'));
    expect(latest?.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/884394/000141036826089410/primary_doc.xml',
    );
    expect(store.has(requestKey('sec.archives', 'GET', latest!.url))).toBe(true);
  });

  it('equals the committed golden', () => {
    const golden = serialiseGolden(
      toGolden(
        'sec-spy-submissions.json',
        secSubmissionsAdapter.id,
        spy.raw.requestKey,
        secSubmissionsAdapter.adapterVersion,
        spy.normalised,
      ),
    );
    expect(golden).toBe(readGolden('sec-spy-submissions.json'));
  });
});
