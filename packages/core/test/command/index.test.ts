// packages/core/test/command/index.test.ts — WP-03 (WORKPLAN L596-597, L612).
//
// The binding acceptance row is "prefix bounds, word index, trigram fallback thresholds"
// (WORKPLAN L612), against `UniverseIndex` as FUNCTIONS.md §3.1 L881-893 specifies it.
//
//   * prefix bounds — a prefix query returns exactly the entries carrying that prefix, including
//     the two cases a binary search gets wrong: a prefix whose block starts at index 0 and one
//     whose block runs to the end of the array. A seeded random corpus cross-checks every prefix
//     against a brute-force filter, which is the only way to be sure of the bounds.
//   * word index — a query matching a *non-leading* name word finds the entry ('HOSP' →
//     Apple Hospitality REIT, FUNCTIONS.md §3.1 L888).
//   * trigram fallback — a typo inside the 0.4 Jaccard floor of §3.3 L946 matches, one outside it
//     does not, and the floor itself is what decides (the same query with a lower floor matches).
//
// The fixture below is a hand-written snapshot rather than a recorded capture: the identifier
// corpora (`sec-company-tickers.json`, `openfigi-map`, `cboe-options`) belong to the `ids` tests,
// while what this file has to pin is the *shape* of the index — ties, boundaries, the notable
// subset — which a fixture states explicitly and 36 k real rows do not.

import { describe, expect, it } from 'vitest';

import { makePrng } from '../../src/analytics/prng.js';
import {
  MRU_RANKED,
  MRU_RECENCY_MAX,
  TRIGRAM_MIN_SCORE,
  UniverseIndex,
  jaccard,
  normalizeWords,
  trigramsOf,
} from '../../src/command/index.js';
import type {
  MruRecord,
  UniverseFunctionTuple,
  UniverseInstrumentTuple,
  UniversePersonTuple,
  UniverseSnapshot,
  UniverseTopicTuple,
} from '../../src/search/types.js';

// ── fixture snapshot ──────────────────────────────────────────────────────────────────────────

// [instrumentId, ticker, marketSector, exchCode, name, assetClass, searchWeight, status]
const INSTRUMENTS: UniverseInstrumentTuple[] = [
  [1, 'A', 'Equity', 'US', 'Agilent Technologies Inc', 'equity', 2, 1],
  [2, 'AA', 'Equity', 'US', 'Alcoa Corp', 'equity', 1, 1],
  [3, 'AAL', 'Equity', 'US', 'American Airlines Group Inc', 'equity', 1, 1],
  [4, 'AAP', 'Equity', 'US', 'Advance Auto Parts Inc', 'equity', 1, 1],
  [5, 'AAPL', 'Equity', 'US', 'Apple Inc', 'equity', 2, 1],
  // A second listing of the same ticker: `tickerExact` must return both, `tickerPrefix` must not
  // lose either, and the two must sort together inside the prefix block.
  [6, 'AAPL', 'Equity', 'UQ', 'Apple Inc', 'equity', 1, 1],
  [7, 'APLE', 'Equity', 'US', 'Apple Hospitality REIT Inc', 'equity', 1, 1],
  [8, 'MCHP', 'Equity', 'US', 'Microchip Technology Inc', 'equity', 1, 1],
  [9, 'MSFT', 'Equity', 'US', 'Microsoft Corporation', 'equity', 2, 1],
  [10, 'W', 'Equity', 'US', 'Wayfair Inc', 'equity', 1, 1],
  [11, 'ZTS', 'Equity', 'US', 'Zoetis Inc', 'equity', 2, 0],
  [12, 'SPX', 'Index', 'INDEX', 'S&P 500 Index', 'index', 2, 1],
  [13, 'EURUSD', 'Curncy', 'FX', 'Euro-US Dollar', 'fx', 2, 1],
];

// [code, name, aliases, tier]
const FUNCTIONS: UniverseFunctionTuple[] = [
  ['GP', 'Price graph', [], 1],
  ['DES', 'Security description', [], 1],
  ['MSG', 'Messages', ['IB'], 2],
  ['SRCH', 'Search', [], 3],
  ['W', 'Watchlists', [], 1],
];

// [personId, name, roleFirm]
const PEOPLE: UniversePersonTuple[] = [[1, 'Jane Doe', 'CFO · Demo Capital']];

// [code, name]
const TOPICS: UniverseTopicTuple[] = [
  ['FED', 'Federal Reserve'],
  ['CPI', 'Consumer Prices'],
];

const SNAPSHOT: UniverseSnapshot = {
  version: 'v1-test',
  generatedAt: '2026-09-17T00:00:00.000Z',
  instruments: INSTRUMENTS,
  functions: FUNCTIONS,
  people: PEOPLE,
  topics: TOPICS,
};

const index = UniverseIndex.build(SNAPSHOT);

/** Entry indexes → `primary` strings, which is what an expectation can be read in. */
const primaries = (hits: Uint32Array | readonly number[]): string[] =>
  [...hits].map((i) => index.entryAt(i)!.primary);

const tickersOf = (hits: Uint32Array): string[] =>
  [...hits].map((i) => index.entryAt(i)!.upperTicker);

// ── build ─────────────────────────────────────────────────────────────────────────────────────

describe('UniverseIndex.build', () => {
  it('indexes every row of the snapshot', () => {
    expect(index.size).toBe(INSTRUMENTS.length + FUNCTIONS.length + PEOPLE.length + TOPICS.length);
    expect(index.version).toBe('v1-test');
    expect(index.generatedAt).toBe('2026-09-17T00:00:00.000Z');
  });

  it('renders the display forms of FUNCTIONS.md §3.2 L901-902', () => {
    const aapl = index.entryAt(index.entryOfInstrument(5))!;
    expect(aapl.primary).toBe('AAPL US Equity');
    expect(aapl.secondary).toBe('Apple Inc · Common Stock · US');

    // A pseudo exchange code is never rendered: 'SPX Index', not 'SPX INDEX Index'.
    expect(index.entryAt(index.entryOfInstrument(12))!.primary).toBe('SPX Index');
    expect(index.entryAt(index.entryOfInstrument(13))!.primary).toBe('EURUSD Curncy');

    // 'Jane Doe (Demo Capital)' / 'CFO · Demo Capital' (§3.2 L901-902).
    const person = index.entries.find((e) => e.kind === 'person')!;
    expect(person.primary).toBe('Jane Doe (Demo Capital)');
    expect(person.secondary).toBe('CFO · Demo Capital');

    const gp = index.entryAt(index.entryOfCode('GP'))!;
    expect(gp.primary).toBe('GP');
    expect(gp.secondary).toBe('Price graph');
    expect(gp.tier).toBe(1);

    expect(index.entryAt(index.entryOfCode('FED'))!.kind).toBe('topic');
    expect(index.entryAt(index.entryOfInstrument(11))!.status).toBe(0);
  });

  it('is empty, and answers every query, before a snapshot arrives', () => {
    const empty = UniverseIndex.empty();
    expect(empty.size).toBe(0);
    expect(empty.tickerPrefix('AAPL')).toHaveLength(0);
    expect(empty.codePrefix('GP')).toEqual([]);
    expect(empty.wordPrefix('APPLE')).toHaveLength(0);
    expect(empty.trigramSearch('APPLE')).toEqual([]);
    expect(empty.lookupTicker(['AAPL'])).toEqual([]);
    expect(empty.entryOfInstrument(5)).toBe(-1);
  });

  it('skips malformed rows instead of throwing', () => {
    const dirty = UniverseIndex.build({
      version: 'dirty',
      generatedAt: '',
      instruments: [
        [Number.NaN, 'X', 'Equity', 'US', 'Broken', 'equity', 1, 1],
        [99, '', 'Equity', 'US', 'No ticker', 'equity', 1, 1],
        [100, 'OK', 'Equity', 'US', 'Fine Inc', 'equity', 1, 1],
      ] as UniverseInstrumentTuple[],
      functions: [['', 'no code', [], 1]] as UniverseFunctionTuple[],
      people: [],
      topics: [],
    });
    expect(dirty.size).toBe(1);
    expect([...dirty.tickerPrefix('O')].map((i) => dirty.entryAt(i)!.upperTicker)).toEqual(['OK']);
  });
});

// ── prefix bounds ─────────────────────────────────────────────────────────────────────────────

describe('prefix bounds', () => {
  it('returns exactly the entries carrying the prefix', () => {
    expect(tickersOf(index.tickerPrefix('AA'))).toEqual(['AA', 'AAL', 'AAP', 'AAPL', 'AAPL']);
    expect(tickersOf(index.tickerPrefix('AAP'))).toEqual(['AAP', 'AAPL', 'AAPL']);
    expect(tickersOf(index.tickerPrefix('AAPL'))).toEqual(['AAPL', 'AAPL']);
    expect(tickersOf(index.tickerPrefix('MS'))).toEqual(['MSFT']);
  });

  it('handles the block at the very start of the array', () => {
    // 'A' is the first key in the sorted array: the lower bound is 0.
    expect(tickersOf(index.tickerPrefix('A'))).toEqual([
      'A',
      'AA',
      'AAL',
      'AAP',
      'AAPL',
      'AAPL',
      'APLE',
    ]);
  });

  it('handles the block that runs to the end of the array', () => {
    // 'ZTS' is the last key: the upper bound is `keys.length`, the classic off-by-one.
    expect(tickersOf(index.tickerPrefix('Z'))).toEqual(['ZTS']);
    expect(tickersOf(index.tickerPrefix('ZTS'))).toEqual(['ZTS']);
  });

  it('returns nothing for a prefix that falls in a gap, past the end, or below the start', () => {
    expect(tickersOf(index.tickerPrefix('B'))).toEqual([]); // between AAPL… and EURUSD
    expect(tickersOf(index.tickerPrefix('ZZZZ'))).toEqual([]); // past the last key
    expect(tickersOf(index.tickerPrefix('0'))).toEqual([]); // below the first key
    expect(tickersOf(index.tickerPrefix('AAPLX'))).toEqual([]); // longer than the key
    expect(tickersOf(index.tickerPrefix(''))).toEqual([]);
    expect(tickersOf(index.tickerPrefix('   '))).toEqual([]);
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(tickersOf(index.tickerPrefix('aapl'))).toEqual(['AAPL', 'AAPL']);
    expect(tickersOf(index.tickerPrefix(' aaPL '))).toEqual(['AAPL', 'AAPL']);
  });

  it('honours a limit without moving the lower bound', () => {
    expect(tickersOf(index.tickerPrefix('AA', 2))).toEqual(['AA', 'AAL']);
    expect(tickersOf(index.tickerPrefix('AA', 0))).toEqual([]);
  });

  it('matches a brute-force filter on every prefix of a seeded random corpus', () => {
    // 400 random tickers over a four-letter alphabet: every prefix of length 1-3 has a block
    // somewhere, many blocks are adjacent, and some prefixes are absent — exactly the cases a
    // hand-written fixture cannot enumerate.
    const prng = makePrng('universe-index-prefix-bounds');
    const alphabet = 'ABCD';
    const tickers: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const len = 1 + prng.nextInt(5);
      let t = '';
      for (let k = 0; k < len; k += 1) t += alphabet[prng.nextInt(alphabet.length)]!;
      tickers.push(t);
    }
    const corpus = UniverseIndex.build({
      version: 'fuzz',
      generatedAt: '',
      instruments: tickers.map((t, i): UniverseInstrumentTuple => [
        i + 1,
        t,
        'Equity',
        'US',
        `${t} Corp`,
        'equity',
        1,
        1,
      ]),
      functions: [],
      people: [],
      topics: [],
    });
    const corpusTickers = (hits: Uint32Array): string[] =>
      [...hits].map((i) => corpus.entryAt(i)!.upperTicker);

    const allPrefixes: string[] = [''];
    for (const a of alphabet) {
      allPrefixes.push(a);
      for (const b of alphabet) {
        allPrefixes.push(a + b);
        for (const c of alphabet) allPrefixes.push(a + b + c);
      }
    }
    // 'E' is in no ticker, so every prefix containing it must come back empty.
    allPrefixes.push('E', 'AE', 'ABE');

    for (const prefix of allPrefixes) {
      const got = corpusTickers(corpus.tickerPrefix(prefix)).slice().sort();
      const want =
        prefix.length === 0
          ? []
          : tickers
              .filter((t) => t.startsWith(prefix))
              .slice()
              .sort();
      expect(got, `prefix ${JSON.stringify(prefix)}`).toEqual(want);
    }
  });

  it('returns ties in a stable, ascending order', () => {
    const hits = index.tickerPrefix('AAPL');
    expect(tickersOf(hits)).toEqual(['AAPL', 'AAPL']);
    // Same key: the heavier row (searchWeight 2) leads.
    expect(primaries(hits)).toEqual(['AAPL US Equity', 'AAPL UQ Equity']);
  });

  it('separates an exact ticker from its prefix block', () => {
    expect(tickersOf(index.tickerExact('AA'))).toEqual(['AA']);
    expect(tickersOf(index.tickerExact('AAPL'))).toEqual(['AAPL', 'AAPL']);
    expect(tickersOf(index.tickerExact('AAP'))).toEqual(['AAP']);
    expect(tickersOf(index.tickerExact('QQQ'))).toEqual([]);
  });
});

// ── code array ────────────────────────────────────────────────────────────────────────────────

describe('code lookups', () => {
  it('finds a function by its canonical code and by an alias, and says which', () => {
    const gp = index.codeExact('gp');
    expect(gp).toHaveLength(1);
    expect(gp[0]!.alias).toBe(false);
    expect(index.entryAt(gp[0]!.entry)!.primary).toBe('GP');

    const ib = index.codeExact('IB');
    expect(ib).toHaveLength(1);
    expect(ib[0]!.alias).toBe(true);
    expect(index.entryAt(ib[0]!.entry)!.primary).toBe('MSG');
  });

  it('keeps a function code and an instrument ticker apart (the W case, §3.3 L923-924)', () => {
    // 'W' is both the Watchlists function and Wayfair's ticker: each structure answers its own
    // question, and R0 is what prefers the function.
    expect(index.entryAt(index.codeExact('W')[0]!.entry)!.kind).toBe('function');
    expect(index.entryAt(index.tickerExact('W')[0]!)!.kind).toBe('instrument');
  });

  it('prefixes over codes, aliases and topic codes', () => {
    expect(index.codePrefix('S').map((h) => h.key)).toEqual(['SRCH']);
    expect(index.codePrefix('C').map((h) => h.key)).toEqual(['CPI']);
    expect(index.codePrefix('F').map((h) => h.key)).toEqual(['FED']);
    expect(index.codePrefix('M').map((h) => h.key)).toEqual(['MSG']);
    expect(index.codePrefix('')).toEqual([]);
    expect(index.codePrefix('ZZ')).toEqual([]);
  });
});

// ── word index ────────────────────────────────────────────────────────────────────────────────

describe('word index', () => {
  it('finds an entry by a non-leading word', () => {
    // 'HOSP' is the second word of 'Apple Hospitality REIT Inc' — the §3.1 L888 case.
    expect(primaries(index.wordPrefix('HOSP'))).toEqual(['APLE US Equity']);
    // …and by the last word.
    expect(primaries(index.wordPrefix('REIT'))).toEqual(['APLE US Equity']);
  });

  it('finds every entry with a leading word match, best first', () => {
    // 'APPLE' leads two names and is the first word of the REIT; the heavier row leads.
    expect(primaries(index.wordPrefix('APPLE'))).toEqual([
      'AAPL US Equity',
      'AAPL UQ Equity',
      'APLE US Equity',
    ]);
    expect(index.matchesFirstWord(index.entryOfInstrument(5), 'APPLE')).toBe(true);
    expect(index.matchesFirstWord(index.entryOfInstrument(7), 'HOSP')).toBe(false);
  });

  it('filters the 3-character bucket down to the full query', () => {
    // 'MIC' is the bucket shared by Microsoft and Microchip; the longer query separates them.
    expect(primaries(index.wordPrefix('MIC')).slice().sort()).toEqual([
      'MCHP US Equity',
      'MSFT US Equity',
    ]);
    expect(primaries(index.wordPrefix('MICROS'))).toEqual(['MSFT US Equity']);
    expect(primaries(index.wordPrefix('MICROC'))).toEqual(['MCHP US Equity']);
    expect(primaries(index.wordPrefix('MICROX'))).toEqual([]);
  });

  it('matches words inside a punctuated name', () => {
    // 'Euro-US Dollar' → ['EURO', 'US', 'DOLLAR'].
    expect(primaries(index.wordPrefix('DOLLAR'))).toEqual(['EURUSD Curncy']);
    expect(normalizeWords('Euro-US Dollar')).toEqual(['EURO', 'US', 'DOLLAR']);
    expect(normalizeWords('S&P 500 Index')).toEqual(['S', 'P', '500', 'INDEX']);
  });

  it('answers a 1- or 2-character query over the notable subset only', () => {
    // Under three characters the short index is consulted: notable rows (weight ≥ 2 or a
    // non-instrument kind) are there, an ordinary weight-1 instrument is not.
    expect(primaries(index.wordPrefix('EU'))).toEqual(['EURUSD Curncy']);
    // 'WA' finds the Watchlists function ('Watchlists' is a notable name) but not Wayfair Inc,
    // whose weight is 1 and which is therefore outside the short-prefix structure.
    expect(primaries(index.wordPrefix('WA'))).toEqual(['W']);
    expect(primaries(index.wordPrefix('WA'))).not.toContain('W US Equity');
    // Three characters up, the full word index answers and Wayfair is found.
    expect(primaries(index.wordPrefix('WAY'))).toEqual(['W US Equity']);
    expect(primaries(index.wordPrefix('FEDE'))).toEqual(['FED']); // topics are always notable
  });

  it('honours a limit and an empty query', () => {
    expect(index.wordPrefix('APPLE', 1)).toHaveLength(1);
    expect(index.wordPrefix('APPLE', 0)).toHaveLength(0);
    expect(index.wordPrefix('')).toHaveLength(0);
  });
});

// ── trigram fallback ──────────────────────────────────────────────────────────────────────────

describe('trigram fallback thresholds', () => {
  const msft = index.entryOfInstrument(9);

  it('scores Jaccard over padded trigrams', () => {
    expect(trigramsOf('GE')).toEqual(['  G', ' GE', 'GE ']);
    expect(jaccard(trigramsOf('MICROSOFT'), trigramsOf('MICROSOFT'))).toBe(1);
    expect(jaccard(trigramsOf(''), trigramsOf('MICROSOFT'))).toBe(0);
    // 7 shared trigrams of 12 in the union — a single dropped letter.
    expect(jaccard(trigramsOf('MICROSFT'), trigramsOf('MICROSOFT'))).toBeCloseTo(7 / 12, 12);
    // 5 shared of 15 — a different word that merely starts the same way.
    expect(jaccard(trigramsOf('MICROCHIP'), trigramsOf('MICROSOFT'))).toBeCloseTo(5 / 15, 12);
  });

  it('matches a typo inside the threshold', () => {
    const hits = index.trigramSearch('MICROSFT');
    expect(hits.map((h) => index.entryAt(h.entry)!.primary)).toContain('MSFT US Equity');
    const hit = hits.find((h) => h.entry === msft)!;
    expect(hit.score).toBeCloseTo(7 / 12, 12); // 0.583 ≥ 0.4
    expect(hit.score).toBeGreaterThanOrEqual(TRIGRAM_MIN_SCORE);
  });

  it('rejects a near-miss beyond the threshold', () => {
    // 0.333 < 0.4: 'MICROCHIP' must not drag Microsoft in, and Microchip itself is weight 1 and so
    // is not in the trigram structure at all (§3.1 L889).
    expect(jaccard(trigramsOf('MICROCHIP'), trigramsOf('MICROSOFT'))).toBeLessThan(
      TRIGRAM_MIN_SCORE,
    );
    expect(index.trigramSearch('MICROCHIP')).toEqual([]);
  });

  it('is the threshold, and nothing else, that rejects it', () => {
    const relaxed = index.trigramSearch('MICROCHIP', { minScore: 0.3 });
    expect(relaxed.map((h) => h.entry)).toContain(msft);
    expect(relaxed.find((h) => h.entry === msft)!.score).toBeCloseTo(5 / 15, 12);
  });

  it('includes a hit exactly at the threshold and excludes one just below it', () => {
    const score = index
      .trigramSearch('MICROSFT', { minScore: 0 })
      .find((h) => h.entry === msft)!.score;
    expect(index.trigramSearch('MICROSFT', { minScore: score }).map((h) => h.entry)).toContain(
      msft,
    );
    expect(
      index.trigramSearch('MICROSFT', { minScore: score + 1e-9 }).map((h) => h.entry),
    ).not.toContain(msft);
  });

  it('holds only the notable subset', () => {
    // Wayfair (weight 1) is not indexed, so a typo on it finds nothing however close it is…
    expect(jaccard(trigramsOf('WAYFAIER'), trigramsOf('WAYFAIR'))).toBeGreaterThan(
      TRIGRAM_MIN_SCORE,
    );
    expect(index.trigramSearch('WAYFAIER')).toEqual([]);
    // …while functions, topics and people are always indexed.
    expect(index.trigramSearch('SERCH').map((h) => index.entryAt(h.entry)!.primary)).toContain(
      'SRCH',
    );
    expect(
      index.trigramSearch('FEDERAL RESERV').map((h) => index.entryAt(h.entry)!.primary),
    ).toContain('FED');
  });

  it('scores an entry on its best field, not on its whole text', () => {
    // 'MSFT' matches the ticker unit perfectly even though the name unit barely overlaps.
    const hit = index.trigramSearch('MSFT').find((h) => h.entry === msft)!;
    expect(hit.score).toBe(1);
  });

  it('returns nothing for a query with no trigram in common', () => {
    expect(index.trigramSearch('QQQQQQQ')).toEqual([]);
    expect(index.trigramSearch('')).toEqual([]);
  });

  it('caps the result and orders it best first', () => {
    const hits = index.trigramSearch('APPLE INC', { minScore: 0, limit: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
    expect(index.trigramSearch('APPLE', { limit: 0 })).toEqual([]);
  });

  it('gates the fallback on query length and prefix-hit count (§3.1 L889)', () => {
    expect(index.shouldUseTrigrams('MIC', 0)).toBe(true);
    expect(index.shouldUseTrigrams('MIC', 4)).toBe(true);
    expect(index.shouldUseTrigrams('MIC', 5)).toBe(false);
    expect(index.shouldUseTrigrams('MI', 0)).toBe(false);
    expect(index.shouldUseTrigrams('', 0)).toBe(false);
  });
});

// ── MRU ───────────────────────────────────────────────────────────────────────────────────────

describe('MRU boost', () => {
  const records: MruRecord[] = [
    { kind: 'instrument', id: '5', lastUsed: 300, count: 25 },
    { kind: 'function', id: 'GP', lastUsed: 200, count: 3 },
    { kind: 'topic', id: 'FED', lastUsed: 100, count: 1 },
  ];

  it('ranks by recency and scores §3.3 L951', () => {
    const withMru = UniverseIndex.build(SNAPSHOT, { mru: records });
    expect(withMru.mruOf('instrument', '5')).toEqual({ rank: 0, count: 25 });
    expect(withMru.mruOf('function', 'GP')).toEqual({ rank: 1, count: 3 });
    // rank 0 → +15, plus +2 for 25 uses (one per ten, capped at five).
    expect(withMru.mruBoost('instrument', '5')).toBeCloseTo(MRU_RECENCY_MAX + 2, 12);
    // rank 1 → 15·(1 − 1/20) = 14.25, no use bonus below ten uses.
    expect(withMru.mruBoost('function', 'GP')).toBeCloseTo(
      MRU_RECENCY_MAX * (1 - 1 / MRU_RANKED),
      12,
    );
    expect(withMru.mruBoost('instrument', '999')).toBe(0);
    expect(withMru.mru.size).toBe(3);
  });

  it('keeps at most 50 rows, most recent first', () => {
    const many: MruRecord[] = [];
    for (let i = 0; i < 80; i += 1) {
      many.push({ kind: 'instrument', id: String(i), lastUsed: i, count: 0 });
    }
    const withMru = UniverseIndex.build(SNAPSHOT, { mru: many });
    expect(withMru.mru.size).toBe(50);
    expect(withMru.mruOf('instrument', '79')).toEqual({ rank: 0, count: 0 });
    expect(withMru.mruOf('instrument', '30')).toEqual({ rank: 49, count: 0 });
    expect(withMru.mruOf('instrument', '29')).toBeUndefined();
    // Beyond the twentieth row the recency term is zero (§3.3 L951).
    expect(withMru.mruBoost('instrument', '30')).toBe(0);
  });

  it('promotes on use, with the timestamp the caller supplies', () => {
    const withMru = UniverseIndex.build(SNAPSHOT, { mru: records });
    withMru.noteUse('topic', 'FED', 400);
    expect(withMru.mruOf('topic', 'FED')).toEqual({ rank: 0, count: 2 });
    expect(withMru.mruOf('instrument', '5')!.rank).toBe(1);
    withMru.noteUse('function', 'DES', 500);
    expect(withMru.mruOf('function', 'DES')).toEqual({ rank: 0, count: 1 });
    expect(withMru.mruRecords).toHaveLength(4);
  });
});

// ── ParseEnv.lookupTicker ─────────────────────────────────────────────────────────────────────

describe('lookupTicker', () => {
  it('returns every listing of an exact ticker', () => {
    expect(index.lookupTicker(['AAPL'])).toEqual([
      { instrumentId: 5, assetClass: 'equity', marketSector: 'Equity', display: 'AAPL US Equity' },
      { instrumentId: 6, assetClass: 'equity', marketSector: 'Equity', display: 'AAPL UQ Equity' },
    ]);
  });

  it('narrows by exchange code and by sector', () => {
    expect(index.lookupTicker(['aapl'], { exchCode: 'uq' })).toEqual([
      { instrumentId: 6, assetClass: 'equity', marketSector: 'Equity', display: 'AAPL UQ Equity' },
    ]);
    expect(index.lookupTicker(['AAPL'], { sector: 'Index' })).toEqual([]);
    expect(index.lookupTicker(['SPX'], { sector: 'Index' })).toEqual([
      { instrumentId: 12, assetClass: 'index', marketSector: 'Index', display: 'SPX Index' },
    ]);
  });

  it('is empty for an unknown or empty ticker', () => {
    expect(index.lookupTicker(['XYZQ'])).toEqual([]);
    expect(index.lookupTicker([])).toEqual([]);
    expect(index.lookupTicker([''])).toEqual([]);
  });
});

// ── QA-05: never throws ───────────────────────────────────────────────────────────────────────

describe('robustness (QA-05)', () => {
  it('never throws on arbitrary input', () => {
    const prng = makePrng('universe-index-fuzz');
    const alphabet = [
      ...'ABCXYZ0189 /<>="&.-',
      "'",
      '\t',
      'é',
      '中',
      '🚀',
      '\ud800', // a lone high surrogate
      ' ',
    ];
    for (let i = 0; i < 3_000; i += 1) {
      const len = prng.nextInt(12);
      let q = '';
      for (let k = 0; k < len; k += 1) q += alphabet[prng.nextInt(alphabet.length)]!;
      expect(() => {
        index.tickerPrefix(q);
        index.tickerExact(q);
        index.codePrefix(q);
        index.codeExact(q);
        index.wordPrefix(q);
        index.trigramSearch(q);
        index.shouldUseTrigrams(q, 0);
        index.lookupTicker([q, q]);
        normalizeWords(q);
        trigramsOf(q);
      }).not.toThrow();
    }
  });
});
