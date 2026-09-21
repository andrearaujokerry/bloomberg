/**
 * `wiki-sp500.html` → GICS, through the replay store — WORKPLAN WP-04 L695-699, QA-02.
 *
 * This capture is the only source of GICS sector and sub-industry names for S&P 500 issuers
 * (`source_id 'wiki.sp500'`, `licence_kind cc_by_sa`), so the parse is pinned here as a golden:
 * MEMB's sector subtotals and SECF's `gicsSector` are both downstream of these 503 rows, and a
 * silent drop to 480 would show up as missing sectors on a screen, not as a failure.
 *
 * Four things are asserted, in this order:
 *
 *  1. the bytes come from the manifest, not from a socket — `origin: 'replay'`;
 *  2. the row count and a byte-for-byte golden sample, entity decoding included (`S&P Global`,
 *     not `S&amp;P Global`);
 *  3. every published sub-industry resolves to a GICS code whose level-1 ancestor is the code of
 *     the *published sector* — 503 independent cross-checks of the embedded GICS 2023 tree
 *     against Wikipedia's own sector column, which is what would catch a mistyped code;
 *  4. malformed HTML never throws.
 *
 * No database: the parse is pure, so this runs in `server-unit` and stays fast.
 */

import { describe, expect, it } from 'vitest';

import {
  GICS_NODES,
  WIKI_SP500_SOURCE_ID,
  WIKI_SP500_URL,
  decodeEntities,
  gicsAssignments,
  gicsCodes,
  gicsSectorCode,
  gicsSubIndustryCode,
  loadWikiSp500,
  parseWikiSp500,
  type WikiSp500Row,
} from '../../../src/refdata/classifications.js';
import { openReplayStore, requestKey } from '../../../src/providers/replayStore.js';

const store = openReplayStore();
const capture = loadWikiSp500(store);

/** The sector subtotals the capture publishes — MEMB's `sectorWeights` buckets. */
const EXPECTED_SECTOR_COUNTS: Readonly<Record<string, number>> = {
  Industrials: 83,
  Financials: 76,
  'Information Technology': 73,
  'Health Care': 59,
  'Consumer Discretionary': 47,
  'Consumer Staples': 34,
  Utilities: 31,
  'Real Estate': 30,
  Materials: 25,
  'Communication Services': 24,
  Energy: 21,
};

describe('wiki.sp500 replay', () => {
  it('reads the recorded capture, never a socket', () => {
    expect(capture.raw.origin).toBe('replay');
    expect(capture.raw.status).toBe(200);
    expect(capture.raw.providerId).toBe(WIKI_SP500_SOURCE_ID);
    expect(capture.raw.requestKey).toBe(requestKey(WIKI_SP500_SOURCE_ID, 'GET', WIKI_SP500_URL));
    // `provenance.response_sha256` — the digest a value written from this capture would carry.
    expect(capture.raw.sha256).toBe(
      '716d98832531f5f97bd0753bf7b23970112f57ed3a09d615b7b12189b9ec91e4',
    );
    expect(capture.raw.body.byteLength).toBe(568_880);
  });
});

describe('parseWikiSp500', () => {
  it('parses 503 S&P 500 constituents with no problems', () => {
    expect(capture.parse.problems).toEqual([]);
    expect(capture.parse.rows).toHaveLength(503);
    expect(new Set(capture.parse.rows.map((r) => r.symbol)).size).toBe(503);
  });

  it('matches the golden sample, entities decoded', () => {
    const bySymbol = new Map(capture.parse.rows.map((r) => [r.symbol, r]));

    const mmm: WikiSp500Row = {
      symbol: 'MMM',
      security: '3M',
      gicsSector: 'Industrials',
      gicsSubIndustry: 'Industrial Conglomerates',
      headquarters: 'Saint Paul, Minnesota',
      dateAdded: '1957-03-04',
      cik: '0000066740',
      founded: '1902',
      sectorCode: '20',
      subIndustryCode: '20105010',
    };
    expect(bySymbol.get('MMM')).toEqual(mmm);

    expect(bySymbol.get('AAPL')).toEqual({
      symbol: 'AAPL',
      security: 'Apple Inc.',
      gicsSector: 'Information Technology',
      gicsSubIndustry: 'Technology Hardware, Storage & Peripherals',
      headquarters: 'Cupertino, California',
      dateAdded: '1982-11-30',
      cik: '0000320193',
      founded: '1977',
      sectorCode: '45',
      subIndustryCode: '45202030',
    });

    // `S&amp;P Global` decoded, and a `Financials` name whose sub-industry is four levels deep.
    expect(bySymbol.get('SPGI')).toEqual({
      symbol: 'SPGI',
      security: 'S&P Global',
      gicsSector: 'Financials',
      gicsSubIndustry: 'Financial Exchanges & Data',
      headquarters: 'New York City, New York',
      dateAdded: '1957-03-04',
      cik: '0000064040',
      founded: '1917',
      sectorCode: '40',
      subIndustryCode: '40203040',
    });

    // A dotted share-class ticker survives verbatim; symbology (`BRK/B`, `BRK B`) is REF-01's job.
    expect(bySymbol.get('BRK.B')?.security).toBe('Berkshire Hathaway');
    expect(bySymbol.get('BRK.B')?.subIndustryCode).toBe('40201030');

    // The last body row, so a truncated table cannot pass the count assertion by accident.
    expect(capture.parse.rows.at(-1)).toEqual({
      symbol: 'ZTS',
      security: 'Zoetis',
      gicsSector: 'Health Care',
      gicsSubIndustry: 'Pharmaceuticals',
      headquarters: 'Parsippany, New Jersey',
      dateAdded: '2013-06-21',
      cik: '0001555280',
      founded: '1952',
      sectorCode: '35',
      subIndustryCode: '35202010',
    });
  });

  it('gives every row a ten-digit CIK and an ISO date added', () => {
    for (const row of capture.parse.rows) {
      expect(row.cik, row.symbol).toMatch(/^\d{10}$/);
      expect(row.dateAdded, row.symbol).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('reproduces the published sector subtotals', () => {
    const counts: Record<string, number> = {};
    for (const row of capture.parse.rows) {
      counts[row.gicsSector] = (counts[row.gicsSector] ?? 0) + 1;
    }
    expect(counts).toEqual(EXPECTED_SECTOR_COUNTS);
    const total = Object.values(EXPECTED_SECTOR_COUNTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(503);
  });
});

describe('the GICS tree behind the names', () => {
  it('resolves every published sub-industry into the published sector', () => {
    const tree = new Map(gicsCodes().map((node) => [node.code, node]));
    for (const row of capture.parse.rows) {
      const sub = row.subIndustryCode;
      expect(sub, `${row.symbol}: ${row.gicsSubIndustry}`).not.toBeNull();
      // Walk parent_code up to level 1 and insist it is the sector the capture published.
      let node = tree.get(sub ?? '');
      while (node !== undefined && node.level > 1) {
        node = node.parentCode === null ? undefined : tree.get(node.parentCode);
      }
      expect(node?.code, `${row.symbol}: ${row.gicsSubIndustry} → ${row.gicsSector}`).toBe(
        row.sectorCode,
      );
      expect(node?.name).toBe(row.gicsSector);
    }
  });

  it('is a complete tree: 127 sub-industries, every parent present, no duplicate code', () => {
    const nodes = gicsCodes();
    expect(nodes).toHaveLength(GICS_NODES.length);
    expect(new Set(nodes.map((n) => n.code)).size).toBe(nodes.length);

    const byCode = new Map(nodes.map((n) => [n.code, n]));
    for (const node of nodes) {
      expect(node.level).toBe(node.code.length / 2);
      if (node.parentCode === null) expect(node.level).toBe(1);
      else expect(byCode.has(node.parentCode), `${node.code} → ${node.parentCode}`).toBe(true);
    }

    const byLevel = (level: number): number => nodes.filter((n) => n.level === level).length;
    expect(byLevel(1)).toBe(11);
    expect(byLevel(2)).toBe(25);
    expect(byLevel(3)).toBe(69);
    expect(byLevel(4)).toBe(127);
    expect(nodes).toHaveLength(232);

    // Every level-4 code in the tree is used by the capture, and vice versa: no dead branch, and
    // nothing published that the tree does not carry.
    const used = new Set(capture.parse.rows.map((r) => r.subIndustryCode));
    expect(used.size).toBe(127);
    for (const node of nodes.filter((n) => n.level === 4)) {
      expect(used.has(node.code), `${node.code} ${node.name} is in the tree but unused`).toBe(true);
    }
  });

  it('looks a name up by level, folding punctuation and case', () => {
    expect(gicsSectorCode('Information Technology')).toBe('45');
    expect(gicsSectorCode('information  technology')).toBe('45');
    expect(gicsSubIndustryCode('Soft Drinks & Non-alcoholic Beverages')).toBe('30201030');
    expect(gicsSubIndustryCode('Soft Drinks and Non-Alcoholic Beverages')).toBe('30201030');
    // A name that exists at another level does not leak across levels.
    expect(gicsSectorCode('Systems Software')).toBeNull();
    expect(gicsSubIndustryCode('Information Technology')).toBeNull();
    // Unknown names are `null`, never a nearest neighbour (PROVIDERS L1775).
    expect(gicsSubIndustryCode('Quantum Widgets')).toBeNull();
  });

  it('turns the parse into one assignment per listed share class', () => {
    const assignments = gicsAssignments(capture.parse);
    expect(assignments).toHaveLength(503);
    expect(assignments[0]).toEqual({ symbol: 'MMM', cik: '0000066740', code: '20105010' });

    // 503 rows, 500 CIKs: three issuers are in the index twice, once per share class
    // (GOOGL/GOOG, FOXA/FOX, NWSA/NWS). `entity_classifications` is keyed
    // `(entity_kind, entity_id, scheme)`, so the second row of a pair upserts the same issuer's
    // same code and writes nothing — which is why the caller classifies the *issuer*, not the
    // symbol, and why the pair must agree on its sub-industry.
    const byCik = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (a.cik === null) continue;
      const codes = byCik.get(a.cik) ?? new Set<string>();
      codes.add(a.code);
      byCik.set(a.cik, codes);
    }
    expect(byCik.size).toBe(500);
    for (const [cik, codes] of byCik) expect(codes.size, cik).toBe(1);
    expect(
      assignments.filter((a) => ['GOOGL', 'GOOG', 'FOXA', 'FOX', 'NWSA', 'NWS'].includes(a.symbol))
        .length,
    ).toBe(6);
  });
});

describe('malformed HTML', () => {
  const html = capture.raw.body.toString('utf8');

  it('never throws, whatever it is handed', () => {
    const inputs: [string, string][] = [
      ['empty', ''],
      ['not html', 'nothing to see here'],
      ['table with no rows', '<table id="constituents"></table>'],
      ['unclosed table', html.slice(0, html.indexOf('id="constituents"') + 4000)],
      ['unclosed tag soup', '<table id="constituents"><tr><td>AAA<td>B</table'],
      [
        'nested tables',
        '<table id="constituents"><tr><td><table><tr><td>x</table><td>y</tr></table>',
      ],
      ['null bytes', `<table id="constituents"><tr><td>A A</td></tr></table>`],
      [
        'huge attribute',
        `<table id="constituents" data-x="${'x'.repeat(50_000)}"><tr></tr></table>`,
      ],
    ];
    for (const [label, input] of inputs) {
      expect(() => parseWikiSp500(input), label).not.toThrow();
    }
  });

  it('reports a missing table instead of returning an empty success', () => {
    const parsed = parseWikiSp500('<p>no table here</p>');
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems).toEqual([
      {
        kind: 'no_table',
        row: null,
        detail: 'no <table id="constituents"> and no table whose header names a GICS Sector column',
      },
    ]);
  });

  it('reports a short row rather than shifting every column', () => {
    const parsed = parseWikiSp500(
      '<table id="constituents"><tr><th>Symbol</th></tr>' +
        '<tr><td>AAA</td><td>Alpha</td></tr>' +
        '<tr><td>BBB</td><td>Beta</td><td>Energy</td><td>Quantum Widgets</td></tr></table>',
    );
    expect(parsed.rows.map((r) => r.symbol)).toEqual(['BBB']);
    expect(parsed.problems).toEqual([
      {
        kind: 'short_row',
        row: 1,
        detail: '2 cells, need at least 4 (symbol, security, sector, sub-industry)',
      },
      {
        kind: 'unknown_sub_industry',
        row: 2,
        detail: "BBB: GICS sub-industry 'Quantum Widgets' is not in the seeded tree",
      },
    ]);
    // The sector resolved and the sub-industry did not: the row keeps what it could resolve and
    // carries `null` for the rest — never a nearest-neighbour guess.
    expect(parsed.rows[0]?.sectorCode).toBe('10');
    expect(parsed.rows[0]?.subIndustryCode).toBeNull();
  });

  it('decodes the entities a MediaWiki page emits', () => {
    expect(decodeEntities('S&amp;P')).toBe('S&P');
    expect(decodeEntities('Brown&ndash;Forman')).toBe('Brown–Forman');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
    // An entity that is not one is left exactly as written.
    expect(decodeEntities('R&D and &notanentity;')).toBe('R&D and &notanentity;');
  });
});
