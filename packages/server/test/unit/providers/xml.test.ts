/**
 * `providers/xml.ts` against the recorded captures — WP-05, QA-05.
 *
 * Every assertion here is measured from the bytes in `fixtures/providers/raw/`, reached through
 * the replay store exactly as an adapter reaches them. Nothing opens a socket and nothing touches
 * the database: the reader is pure.
 *
 * The counts come from FIXTURES.md's own tag histograms (504 `<invstOrSec>` in the N-PORT filing,
 * 9 `<entry>` in each Treasury feed), so a regression in the scanner shows up as a number that
 * disagrees with the committed digest rather than as a vague shape failure.
 */

import { describe, expect, it } from 'vitest';

import { openReplayStore, readManifest } from '../../../src/providers/replayStore.js';
import {
  attrOf,
  child,
  childText,
  childrenNamed,
  decodeXmlBuffer,
  decodeXmlEntities,
  deepTextOf,
  descendants,
  findAllPath,
  findPath,
  MAX_XML_DEPTH,
  numberOf,
  parseXml,
  parseXmlBuffer,
  parseXmlStrict,
  tagHistogram,
  textOf,
} from '../../../src/providers/xml.js';

import type { RawRecord } from '../../../src/providers/types.js';

const store = openReplayStore();
const manifest = readManifest('../../fixtures/providers');

/** The recorded exchange whose capture is `raw/<file>` — the replay store, never `fs`. */
function capture(file: string): RawRecord {
  const wanted = `raw/${file}`;
  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.captures.some((c) => c.file === wanted)) continue;
    const record = store.lookup(key);
    if (record !== null) return record;
  }
  throw new Error(`no manifest entry for ${wanted}`);
}

function textOfCapture(file: string): string {
  return decodeXmlBuffer(capture(file).body).text;
}

const NPORT_NS = 'http://www.sec.gov/edgar/nport';
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const ODATA_NS = 'http://schemas.microsoft.com/ado/2007/08/dataservices';

describe('decodeXmlEntities', () => {
  it('decodes the five predefined entities and numeric references', () => {
    expect(
      decodeXmlEntities('S&amp;P 500&#174; &#x2014; &lt;b&gt; &quot;x&quot; &apos;y&apos;'),
    ).toBe('S&P 500® — <b> "x" \'y\'');
  });

  it('leaves an undeclared entity exactly as written rather than dropping it', () => {
    // Dropping five characters silently is how a CUSIP becomes wrong.
    expect(decodeXmlEntities('A&nbsp;B &notanentity; C')).toBe('A&nbsp;B &notanentity; C');
  });

  it('refuses a surrogate half and an out-of-range code point', () => {
    expect(decodeXmlEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
  });
});

describe('sec-nport-SPY-primary_doc.xml (sec.archives, 444 KB)', () => {
  const xml = textOfCapture('sec-nport-SPY-primary_doc.xml');
  const result = parseXml(xml);

  it('parses cleanly — no recovered damage in a real filing', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);
    expect(result.root.local).toBe('edgarSubmission');
    expect(result.root.uri).toBe(NPORT_NS);
  });

  it('reproduces the FIXTURES.md tag histogram: 504 holdings, 504 cusips', () => {
    if (!result.ok) throw new Error('parse failed');
    const holdings = descendants(result.root, 'invstOrSec');
    expect(holdings.length).toBe(504);
    // FIXTURES.md's histogram: `cusip:505  identifiers:505  isin:505  invstOrSec:504` — one more
    // identifier block than holdings, because the securities-lending section carries one too.
    expect(descendants(result.root, 'cusip').length).toBe(505);
    expect(descendants(result.root, 'identifiers').length).toBe(505);
    expect(result.elementCount).toBeGreaterThan(9_000);

    const histogram = tagHistogram(result.root);
    expect(histogram.get('invstOrSec')).toBe(504);
    expect(histogram.get('pctVal')).toBe(504);
  });

  it('reads the first holding by path, by child and by attribute', () => {
    if (!result.ok) throw new Error('parse failed');
    const first = descendants(result.root, 'invstOrSec')[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(childText(first, 'name')).toBe('Aflac Inc');
    expect(childText(first, 'cusip')).toBe('001055102');
    expect(childText(first, 'curCd')).toBe('USD');
    expect(numberOf(child(first, 'valUSD'))).toBeCloseTo(650_898_953.25, 2);
    expect(numberOf(child(first, 'pctVal'))).toBeCloseTo(0.083_321_585_405, 12);

    // The ISIN is an ATTRIBUTE, not text: `<isin value="US0010551028"/>`.
    const isin = findPath(first, 'identifiers/isin');
    expect(isin).not.toBeNull();
    expect(isin === null ? null : attrOf(isin, 'value')).toBe('US0010551028');
  });

  it('resolves the default namespace onto every element and the path helpers agree', () => {
    if (!result.ok) throw new Error('parse failed');
    const genInfo = findPath(result.root, 'formData/genInfo');
    expect(genInfo).not.toBeNull();
    if (genInfo === null) return;
    expect(genInfo.uri).toBe(NPORT_NS);
    // The registrant name carries a newline and an entity in the source.
    expect(textOf(child(genInfo, 'regName'))).toContain('S&P 500');
    expect(childText(result.root, 'formData', NPORT_NS)).toBeDefined();
    expect(findAllPath(result.root, 'formData/invstOrSecs/invstOrSec').length).toBe(504);
    expect(childrenNamed(result.root, 'headerData', 'http://wrong.example').length).toBe(0);
  });
});

describe('treasury-xml2 / treasury-bills.xml (Atom + two prefixed namespaces)', () => {
  it('reads the yield curve entries and distinguishes d: from Atom', () => {
    const result = parseXml(textOfCapture('treasury-xml2'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);

    expect(result.root.local).toBe('feed');
    expect(result.root.uri).toBe(ATOM_NS);
    expect(textOf(child(result.root, 'title'))).toBe('DailyTreasuryYieldCurveRateData');

    const entries = childrenNamed(result.root, 'entry', ATOM_NS);
    expect(entries.length).toBe(9);

    const first = entries[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const properties = findPath(first, 'content/properties');
    expect(properties).not.toBeNull();
    if (properties === null) return;
    expect(properties.prefix).toBe('m');
    expect(properties.uri).toBe('http://schemas.microsoft.com/ado/2007/08/dataservices/metadata');

    const newDate = child(properties, 'NEW_DATE', ODATA_NS);
    expect(textOf(newDate)).toBe('2026-09-01T00:00:00');
    expect(newDate?.prefix).toBe('d');
    expect(numberOf(child(properties, 'BC_10YEAR', ODATA_NS))).toBe(4.79);
    expect(numberOf(child(properties, 'BC_1MONTH', ODATA_NS))).toBe(3.85);
    expect(attrOf(child(properties, 'BC_10YEAR', ODATA_NS) ?? properties, 'type')).toBe(
      'Edm.Double',
    );

    // Every entry carries the full tenor set.
    const tenYears = entries
      .map((e) => numberOf(findPath(e, 'content/properties/BC_10YEAR')))
      .filter((v): v is number => v !== null);
    expect(tenYears.length).toBe(9);
    expect(Math.min(...tenYears)).toBeGreaterThan(3);
    expect(Math.max(...tenYears)).toBeLessThan(7);
  });

  it('reads the bill feed, whose payload elements differ entirely', () => {
    const result = parseXml(textOfCapture('treasury-bills.xml'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = childrenNamed(result.root, 'entry', ATOM_NS);
    expect(entries.length).toBe(9);
    expect(textOf(child(result.root, 'title'))).toBe('DailyTreasuryBillRateData');
    const properties = findPath(entries[0] ?? result.root, 'content/properties');
    expect(properties).not.toBeNull();
    if (properties === null) return;
    expect(textOf(child(properties, 'INDEX_DATE', ODATA_NS))).toMatch(/^2026-09-\d{2}T00:00:00$/);
    expect(numberOf(child(properties, 'ROUND_B1_YIELD_4WK_2', ODATA_NS))).not.toBeNull();
  });
});

describe('sec-8k-atom.xml (sec.atom, declared ISO-8859-1)', () => {
  it('honours the declared encoding from the bytes', () => {
    const decoded = decodeXmlBuffer(capture('sec-8k-atom.xml').body);
    expect(decoded.encoding).toBe('iso-8859-1');
  });

  it('reads 40 filing entries with their links and categories', () => {
    const result = parseXmlBuffer(capture('sec-8k-atom.xml').body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);

    const entries = childrenNamed(result.root, 'entry', ATOM_NS);
    expect(entries.length).toBe(40);

    const first = entries[0];
    if (first === undefined) throw new Error('no entries');
    expect(textOf(child(first, 'title'))).toContain('8-K');
    const link = child(first, 'link');
    expect(link).not.toBeNull();
    expect(link === null ? '' : attrOf(link, 'href')).toContain('https://www.sec.gov/Archives/');
    expect(textOf(child(first, 'updated'))).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('fed-press-rss.xml and bbg-rss-markets (RSS 2.0, CDATA, BOM)', () => {
  it('reads 20 Fed press items through a UTF-8 BOM and CDATA links', () => {
    const raw = capture('fed-press-rss.xml');
    expect(raw.body[0]).toBe(0xef); // the BOM really is in the recorded bytes
    const result = parseXmlBuffer(raw.body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems).toEqual([]);

    expect(result.root.local).toBe('rss');
    const channel = child(result.root, 'channel');
    expect(channel).not.toBeNull();
    if (channel === null) return;
    expect(textOf(child(channel, 'title'))).toBe('FRB: Press Release - All Releases');

    const items = childrenNamed(channel, 'item');
    expect(items.length).toBe(20);
    const first = items[0];
    if (first === undefined) return;
    // The link is a CDATA section: its content must arrive undecoded and unescaped.
    expect(childText(first, 'link')).toMatch(/^https:\/\/www\.federalreserve\.gov\//);
    expect(childText(first, 'title').length).toBeGreaterThan(10);
  });

  it('reads 20 Bloomberg items and their dc:/media: extensions by namespace', () => {
    const result = parseXmlBuffer(capture('bbg-rss-markets').body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const channel = child(result.root, 'channel');
    if (channel === null) throw new Error('no channel');
    expect(textOf(child(channel, 'title'))).toBe('Bloomberg Markets');

    const items = childrenNamed(channel, 'item');
    expect(items.length).toBe(20);
    const first = items[0];
    if (first === undefined) return;
    // The payload elements are in NO namespace; only the extension elements are in one. The
    // channel carries both spellings of <link>, and only the namespace tells them apart.
    expect(child(first, 'title')?.uri).toBe('');
    expect(child(first, 'link')?.uri).toBe('');
    expect(childText(channel, 'link')).toBe('http://bloomberg.com/markets/');
    const atomLinks = childrenNamed(channel, 'link', ATOM_NS);
    expect(atomLinks.length).toBe(1);
    expect(atomLinks[0] === undefined ? null : attrOf(atomLinks[0], 'href')).toBe(
      'https://www.bloomberg.com/feeds/markets/news.rss',
    );
    expect(result.root.attrs['xmlns:dc']).toBe('http://purl.org/dc/elements/1.1/');
    expect(result.root.attrs['xmlns:media']).toBe('http://search.yahoo.com/mrss/');
    expect(childText(first, 'pubDate')).not.toBe('');
    expect(childText(first, 'description').length).toBeGreaterThan(100);
  });
});

describe('robustness — QA-05: never throws, reports instead (truncated, reordered, corrupted)', () => {
  const sources: Record<string, string> = {
    nport: textOfCapture('sec-nport-SPY-primary_doc.xml').slice(0, 40_000),
    treasury: textOfCapture('treasury-xml2'),
    rss: textOfCapture('fed-press-rss.xml'),
  };

  it('recovers a tree from a document truncated mid-element and says it is damaged', () => {
    const truncated = sources.treasury?.slice(0, 4_000) ?? '';
    const result = parseXml(truncated);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((p) => p.kind === 'parse_error')).toBe(true);
    // The strict reader turns that into a refusal, which is what a normaliser wants.
    expect(parseXmlStrict(truncated).ok).toBe(false);
  });

  it('never throws on 600 truncations of three real documents', () => {
    for (const [name, text] of Object.entries(sources)) {
      for (let cut = 0; cut < 200; cut += 1) {
        const at = Math.floor((text.length * cut) / 200);
        const result = parseXml(text.slice(0, at));
        expect(result.ok === true || result.problem.kind === 'parse_error').toBe(true);
        void name;
      }
    }
  });

  it('never throws on reordered, deleted or corrupted bytes', () => {
    const base = sources.treasury ?? '';
    // A deterministic scramble: no clock, no Math.random, so a failure is reproducible.
    let state = 12_345;
    const next = (): number => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 4_294_967_296;
    };
    for (let trial = 0; trial < 400; trial += 1) {
      const chars = [...base.slice(0, 3_000)];
      const edits = 1 + Math.floor(next() * 12);
      for (let e = 0; e < edits; e += 1) {
        const at = Math.floor(next() * chars.length);
        const mode = Math.floor(next() * 3);
        if (mode === 0) chars.splice(at, 1);
        else if (mode === 1) chars.splice(at, 0, '<>&"\'/ \n'[Math.floor(next() * 8)] ?? '<');
        else {
          const other = Math.floor(next() * chars.length);
          const a = chars[at];
          const b = chars[other];
          if (a !== undefined && b !== undefined) {
            chars[at] = b;
            chars[other] = a;
          }
        }
      }
      const result = parseXml(chars.join(''));
      // Whatever it is, it is a value, not an exception.
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) expect(result.problem.kind).toBe('parse_error');
    }
  });

  it('returns a parse-error result for input that is not XML at all', () => {
    for (const input of [
      '',
      '   ',
      'not xml',
      '<!-- only a comment -->',
      '<?xml version="1.0"?>',
      '&amp;',
    ]) {
      const result = parseXml(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem.kind).toBe('parse_error');
    }
    expect(parseXmlBuffer(Buffer.alloc(0)).ok).toBe(false);
  });

  it('bounds nesting rather than overflowing the stack', () => {
    const deep = '<a>'.repeat(MAX_XML_DEPTH + 10) + '</a>'.repeat(MAX_XML_DEPTH + 10);
    const result = parseXml(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.detail).toContain('nesting deeper than');
  });

  it('recovers from an unmatched end tag and a second root', () => {
    const mismatched = parseXml('<a><b>1</c></b></a>');
    expect(mismatched.ok).toBe(true);
    if (mismatched.ok) {
      expect(mismatched.problems.some((p) => p.detail.includes('matches no open element'))).toBe(
        true,
      );
      expect(childText(mismatched.root, 'b')).toBe('1');
    }

    const twoRoots = parseXml('<a>1</a><b>2</b>');
    expect(twoRoots.ok).toBe(true);
    if (twoRoots.ok) {
      expect(twoRoots.root.local).toBe('a');
      expect(twoRoots.problems.some((p) => p.detail.includes('second root'))).toBe(true);
    }
  });

  it('keeps text and structure a hand-written document would expect', () => {
    const result = parseXml(
      '<r xmlns="urn:x" xmlns:p="urn:p"><p:a x="1">hi <b>there</b> you</p:a><![CDATA[<raw>]]></r>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.root.uri).toBe('urn:x');
    const a = child(result.root, 'a', 'urn:p');
    expect(a).not.toBeNull();
    if (a === null) return;
    expect(a.prefix).toBe('p');
    expect(attrOf(a, 'x')).toBe('1');
    // Text directly inside the element, and text of the whole subtree.
    expect(textOf(a)).toBe('hi  you');
    expect(deepTextOf(a)).toBe('hi there you');
    // CDATA is character data of the root, never markup.
    expect(result.root.text).toContain('<raw>');
    expect(childrenNamed(result.root, 'raw').length).toBe(0);
  });
});
