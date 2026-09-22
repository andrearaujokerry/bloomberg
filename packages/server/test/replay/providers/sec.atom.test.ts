/**
 * `sec.atom` — QA-02 over `sec-8k-atom.xml`, the 8-K current-filings feed (NEWS-04).
 *
 * The capture declares `encoding="ISO-8859-1"`, carries its `<summary>` as **escaped HTML inside
 * the XML**, puts the issuer's identity in a free-text `<title>`, and stamps `<updated>` with a
 * `-04:00` offset that no other SEC timestamp has. All four are asserted here, on the recorded
 * bytes, because each of them fails silently: the wrong decoding mangles an accented name into
 * replacement characters, a second entity decode eats a literal `&amp;`, a guessed title invents
 * an issuer, and a mis-parsed offset moves every headline four hours.
 *
 * Measured: **40 entries, 40 news items, 40 filings, zero problems.**
 */

import { describe, expect, it } from 'vitest';

import { atomUrl, secAtomAdapter } from '../../../src/providers/sec/adapter.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';
import { corruptions, readGolden, replayContext, serialiseGolden, toGolden } from './golden.js';

const CAPTURE = 'sec-8k-atom.xml';
const store = openReplayStore();
const url = atomUrl();
const raw = store.replay({ providerId: 'sec.atom', url });
const normalised = secAtomAdapter.normalise(raw, replayContext(raw));
const rows = normalised.rows;

describe('sec.atom — the 8-K current-filings feed', () => {
  it('builds the URL the capture was recorded under', () => {
    expect(url).toBe(
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=40&output=atom',
    );
    // The recorded key is over the *canonical* URL, whose query is sorted.
    expect(requestKey('sec.atom', 'GET', url)).toBe(raw.requestKey);
    expect(raw.headers['content-type']).toBe('application/atom+xml');
    expect(raw.body.length).toBe(28_829);
  });

  it('reads the declared ISO-8859-1 encoding rather than assuming UTF-8', () => {
    expect(raw.body.subarray(0, 64).toString('latin1')).toContain('encoding="ISO-8859-1"');
    // Nothing in the parsed output carries U+FFFD, which is what a UTF-8 read of these bytes makes.
    expect(rows.newsItems.some((item) => item.headline.includes('�'))).toBe(false);
  });

  it('parses all 40 entries with no problems', () => {
    expect(rows.entryCount).toBe(40);
    expect(rows.newsItems).toHaveLength(40);
    expect(rows.filings).toHaveLength(40);
    expect(normalised.problems).toEqual([]);
    expect(normalised.updates).toEqual([]);
  });

  it('parses the offset-bearing <updated> into UTC', () => {
    // Feed level: `2026-09-15T14:44:53-04:00`.
    expect(rows.feedUpdated).toBe('2026-09-15T18:44:53Z');
    expect(normalised.sourceTs?.toISOString()).toBe('2026-09-15T18:44:53.000Z');
    // Entry level: `2026-09-15T14:21:20-04:00`.
    expect(rows.newsItems[0]?.publishedAt).toBe('2026-09-15T18:21:20Z');
    expect(rows.newsItems.every((item) => item.publishedAt.endsWith('Z'))).toBe(true);
  });

  it('takes the identity from <title> and never guesses at one', () => {
    expect(rows.newsItems[0]).toEqual({
      sourceId: 'sec.atom',
      feed: '8-K',
      providerGuid: 'urn:tag:sec.gov,2008:accession-number=0001213900-26-100070',
      kind: 'filing',
      headline:
        '8-K: Aerkomm Inc. — Departure of Directors or Certain Officers; Election of Directors; ' +
        'Appointment of Certain Officers: Compensatory Arrangements of Certain Officers',
      summary:
        'Departure of Directors or Certain Officers; Election of Directors; Appointment of ' +
        'Certain Officers: Compensatory Arrangements of Certain Officers',
      url: 'https://www.sec.gov/Archives/edgar/data/1590496/000121390026100070/0001213900-26-100070-index.htm',
      category: '8-K',
      cik: '0001590496',
      items8k: ['5.02'],
      publishedAt: '2026-09-15T18:21:20Z',
      isCorrection: false,
      machineGenerated: false,
      lang: 'en',
    });
    expect(rows.newsItems.every((item) => /^\d{10}$/.test(item.cik))).toBe(true);
  });

  it('decodes the escaped-HTML summary exactly once', () => {
    // A second decode would turn `&amp;` into `&` inside an issuer name; a missing one would leave
    // `&lt;b&gt;` in the headline. Neither marker may survive.
    expect(rows.newsItems.some((item) => (item.summary ?? '').includes('&lt;'))).toBe(false);
    expect(rows.newsItems.some((item) => (item.summary ?? '').includes('<b>'))).toBe(false);
    const multiItem = rows.newsItems.find((item) =>
      item.providerGuid.endsWith('0001140361-26-036625'),
    );
    expect(multiItem?.items8k).toEqual(['8.01', '9.01']);
  });

  it('turns the summary`s KB/MB size into bytes and the accession into a filings row', () => {
    expect(rows.filings[0]).toEqual({
      accessionNo: '0001213900-26-100070',
      cik: '0001590496',
      form: '8-K',
      filedDate: '2026-09-15',
      // `<updated>` is EDGAR's acceptance instant, offset and all, so §7.3.2's PIT tie-break is
      // filled the moment the atom entry lands rather than an hour later by the submissions poll.
      acceptedAt: '2026-09-15T18:21:20Z',
      reportDate: null,
      items: ['5.02'],
      primaryDoc: null,
      primaryDocDesc: null,
      isXbrl: false,
      isInlineXbrl: false,
      sizeBytes: 190_464,
      url: 'https://www.sec.gov/Archives/edgar/data/1590496/000121390026100070/0001213900-26-100070-index.htm',
    });
    expect(rows.filings.every((filing) => /^\d{10}-\d{2}-\d{6}$/.test(filing.accessionNo))).toBe(
      true,
    );
  });

  it('dedupes on (source_id, provider_guid), so the guid must be unique in a page', () => {
    expect(new Set(rows.newsItems.map((item) => item.providerGuid)).size).toBe(40);
  });

  it('never throws on a truncated, reordered or corrupted body (QA-05)', () => {
    for (const body of corruptions(raw.body, 12)) {
      const out = secAtomAdapter.normalise({ ...raw, body }, replayContext(raw));
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
        secAtomAdapter.id,
        raw.requestKey,
        secAtomAdapter.adapterVersion,
        normalised,
      ),
    );
    expect(golden).toBe(readGolden(`${CAPTURE}.json`));
  });
});
