// packages/core/test/command/rank.test.ts — WP-03 (WORKPLAN L611).
//
// The binding acceptance row is "R0-R3 scoring terms, tie-breaks, the `W`/`CF`/`GP` cases"
// (WORKPLAN L611, FUNCTIONS.md §8 L1325), against `rank()` as FUNCTIONS.md §3.3 L918-962 specifies
// it.
//
// Every score in this file is written out as a sum of the named §3.3 terms rather than as a magic
// number, e.g. `MATCH_TICKER_EXACT + POPULARITY(2.0) + SECTOR_DEFAULT.Equity`. A test that asserted
// `109` would pass for the wrong reasons the day one term changed and another compensated; a test
// that asserts the sum fails on the term that moved, which is the point of pinning the algorithm.
//
// The fixture is hand written: what has to be pinned is the *arithmetic*, and a hand-built
// snapshot states the inputs of each term (weight, tier, status, sector) explicitly where 36 k real
// rows would only obscure them. The 45 k-row behaviour is `command.bench.ts`'s job.

import { describe, expect, it } from 'vitest';

import type { AnyFunctionManifest } from '../../src/functions/manifest.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import { UniverseIndex } from '../../src/command/index.js';
import {
  CONTEXT_SAME_ISSUER,
  CONTEXT_WATCHLIST,
  KIND_PRIOR_FUNCTION_APPLICABLE,
  KIND_PRIOR_FUNCTION_NEEDS_SECURITY,
  KIND_PRIOR_FUNCTION_WRONG_CLASS,
  KIND_PRIOR_PERSON,
  KIND_PRIOR_TOPIC,
  MATCH_ALIAS_EXACT,
  MATCH_CODE_EXACT,
  MATCH_CODE_PREFIX_BASE,
  MATCH_CODE_PREFIX_DECAY,
  MATCH_CODE_PREFIX_FLOOR,
  MATCH_NAME_FIRST_WORD,
  MATCH_NAME_OTHER_WORD,
  MATCH_PERSON_NAME_WORD,
  MATCH_TICKER_EXACT,
  MATCH_TICKER_PREFIX_BASE,
  MATCH_TICKER_PREFIX_DECAY,
  MATCH_TICKER_PREFIX_FLOOR,
  MATCH_TOPIC_CODE_PREFIX,
  MATCH_TOPIC_NAME_WORD,
  LOCAL_HIT_MATCH_FLOOR,
  MATCH_TRIGRAM_FACTOR,
  MAX_PER_KIND,
  MAX_RESULTS,
  PENALTY_INACTIVE,
  POPULARITY_FUNCTION_BY_TIER,
  SECTOR_DEFAULT_BONUS,
  clampYahooBelowLocal,
  compareCandidates,
  rank,
} from '../../src/command/rank.js';
import type {
  Candidate,
  CandidateKind,
  MruRank,
  RankContext,
  UniverseFunctionTuple,
  UniverseInstrumentTuple,
  UniversePersonTuple,
  UniverseSnapshot,
  UniverseTopicTuple,
} from '../../src/search/types.js';
import type { AssetClass, MarketSector } from '../../src/types/instrument.js';

/* ── fixture ───────────────────────────────────────────────────────────────────────────────── */

// [instrumentId, ticker, marketSector, exchCode, name, assetClass, searchWeight, status]
const INSTRUMENTS: UniverseInstrumentTuple[] = [
  [1, 'W', 'Equity', 'US', 'Wayfair Inc', 'equity', 1, 1],
  [2, 'CF', 'Equity', 'US', 'CF Industries Holdings Inc', 'equity', 1, 1],
  [3, 'GPC', 'Equity', 'US', 'Genuine Parts Co', 'equity', 1, 1],
  [4, 'AAPL', 'Equity', 'US', 'Apple Inc', 'equity', 2, 1],
  [5, 'APLE', 'Equity', 'US', 'Apple Hospitality REIT Inc', 'equity', 1, 1],
  [6, 'ZTS', 'Equity', 'US', 'Zoetis Inc', 'equity', 1, 0], // delisted: the −30 penalty
  [7, 'SPX', 'Index', 'INDEX', 'S&P 500 Index', 'index', 2, 1],
  [8, 'EURUSD', 'Curncy', 'FX', 'Euro-US Dollar', 'fx', 2, 1],
  [9, 'BRK/A', 'Equity', 'US', 'Berkshire Hathaway Inc', 'equity', 2, 1],
  [10, 'BRK/B', 'Equity', 'US', 'Berkshire Hathaway Inc', 'equity', 2, 1],
  [11, 'MSFT', 'Equity', 'US', 'Microsoft Corporation', 'equity', 2, 1],
  [12, '912797VE4', 'Govt', 'GOVT', 'US Treasury Bill', 'govt', 1, 1],
  [13, 'BTC', 'Crypto', 'CRYPTO', 'Bitcoin', 'crypto', 1, 1],
  [14, 'CAPX', 'Equity', 'US', 'Cap Test Corp', 'equity', 3, 1], // popularity cap: 5·3 > 10
  [15, 'HALF', 'Equity', 'US', 'Half Weight Corp', 'equity', 0.5, 1], // Cboe-only weight
  // An index proxy: the ETF ↔ index pairing §3.3 L952 names under "same issuer".
  [16, 'SPXL', 'Equity', 'US', 'Direxion Daily S&P 500 Bull 3X Shares', 'etf', 1, 1],
];

// [code, name, aliases, tier]
const FUNCTIONS: UniverseFunctionTuple[] = [
  ['W', 'Watchlists', [], 1],
  ['CF', 'Company Filings', ['FILINGS'], 2],
  ['GP', 'Price graph', [], 1],
  ['MSG', 'Messages', ['IB'], 2],
  ['CRVF', 'Curve Finder', ['ICVS'], 2],
  ['DES', 'Security Description', [], 1],
  ['SECF', 'Security Finder', ['SF', 'FIND'], 1],
  ['N', 'News', [], 2],
  ['SRCH', 'Search', [], 3],
];

// [personId, name, roleFirm]
const PEOPLE: UniversePersonTuple[] = [[1, 'Jane Doe', 'CFO · Demo Capital']];

// [code, name]
const TOPICS: UniverseTopicTuple[] = [
  ['FED', 'Federal Reserve'],
  ['CPI', 'Consumer Prices'],
];

const SNAPSHOT: UniverseSnapshot = {
  version: 'rank-test-1',
  generatedAt: '2026-01-02T00:00:00.000Z',
  instruments: INSTRUMENTS,
  functions: FUNCTIONS,
  people: PEOPLE,
  topics: TOPICS,
};

const INDEX = UniverseIndex.build(SNAPSHOT);

/** The equity classes `CF` (Company Filings) applies to, per FUNCTIONS.md §6 L1096. */
const EQUITY_CLASSES: AssetClass[] = ['equity', 'etf'];
const PRICEABLE_CLASSES: AssetClass[] = [
  'equity',
  'etf',
  'index',
  'fx',
  'govt',
  'crypto',
  'rate',
  'econ',
];

/**
 * A manifest is a large object with a zod schema, a CSV spec and a help spec; `rank()` reads five
 * of its fields (`code`, `name`, `aliases`, `tier`, `assetClasses`, `requiresSecurity`). Building a
 * complete one here would test the fixture rather than the ranker — the same reasoning as
 * `test/functions/csv.test.ts` L127.
 */
function manifest(
  code: string,
  name: string,
  aliases: readonly string[],
  tier: 1 | 2 | 3,
  assetClasses: readonly AssetClass[] | 'any' | 'none',
  requiresSecurity: boolean,
): AnyFunctionManifest {
  return {
    code,
    name,
    aliases,
    tier,
    assetClasses,
    requiresSecurity,
    payloadVersion: 1,
  } as unknown as AnyFunctionManifest;
}

const REGISTRY = new FunctionRegistry([
  manifest('W', 'Watchlists', [], 1, 'none', false),
  manifest('CF', 'Company Filings', ['FILINGS'], 2, EQUITY_CLASSES, true),
  manifest('GP', 'Price graph', [], 1, PRICEABLE_CLASSES, true),
  manifest('MSG', 'Messages', ['IB'], 2, 'none', false),
  // CRVF's alias carries `aliasParams { curveId: 'SOFR_OIS' }` (§2.7 L853), which is why the alias
  // and its canonical code are different COMMANDS, not two spellings of one.
  manifest('CRVF', 'Curve Finder', ['ICVS'], 2, 'none', false),
  manifest('DES', 'Security Description', [], 1, PRICEABLE_CLASSES, true),
  manifest('SECF', 'Security Finder', ['SF', 'FIND'], 1, 'none', false),
  manifest('N', 'News', [], 2, 'any', false),
  manifest('SRCH', 'Search', [], 3, 'none', false),
]);

/* ── context helpers ───────────────────────────────────────────────────────────────────────── */

interface CtxOptions {
  panelSecurity?: {
    instrumentId: number;
    assetClass: AssetClass;
    marketSector: MarketSector;
    display: string;
  };
  panelFn?: string;
  watchlistIds?: number[];
  mru?: Record<string, MruRank>;
  sectorGiven?: MarketSector;
  kinds?: CandidateKind[];
}

function ctxOf(options: CtxOptions = {}): RankContext {
  const security = options.panelSecurity ?? null;
  const ctx: RankContext = {
    panel: { security, fn: options.panelFn ?? null, params: {} },
    hasPanelSecurity: security !== null,
    watchlistIds: new Set(options.watchlistIds ?? []),
    mru: new Map(Object.entries(options.mru ?? {})),
  };
  if (options.sectorGiven !== undefined) ctx.sectorGiven = options.sectorGiven;
  if (options.kinds !== undefined) ctx.kinds = options.kinds;
  return ctx;
}

const AAPL_PANEL = {
  instrumentId: 4,
  assetClass: 'equity' as AssetClass,
  marketSector: 'Equity' as MarketSector,
  display: 'AAPL US Equity',
};
const EURUSD_PANEL = {
  instrumentId: 8,
  assetClass: 'fx' as AssetClass,
  marketSector: 'Curncy' as MarketSector,
  display: 'EURUSD Curncy',
};

function run(query: string, options: CtxOptions = {}): Candidate[] {
  return rank(query, INDEX, ctxOf(options), REGISTRY);
}

function row(rows: readonly Candidate[], kind: CandidateKind, id: string): Candidate {
  const found = rows.find((c) => c.kind === kind && c.id === id);
  if (found === undefined) {
    throw new Error(
      `no ${kind}:${id} in [${rows.map((c) => `${c.kind}:${c.id}@${c.score}`).join(', ')}]`,
    );
  }
  return found;
}

function has(rows: readonly Candidate[], kind: CandidateKind, id: string): boolean {
  return rows.some((c) => c.kind === kind && c.id === id);
}

/** Ticker/code prefix decay with its floor, exactly as §3.3 L941-943 writes it. */
const tickerPrefixScore = (keyLength: number, queryLength: number): number =>
  Math.max(
    MATCH_TICKER_PREFIX_FLOOR,
    MATCH_TICKER_PREFIX_BASE - MATCH_TICKER_PREFIX_DECAY * (keyLength - queryLength),
  );
const codePrefixScore = (keyLength: number, queryLength: number): number =>
  Math.max(
    MATCH_CODE_PREFIX_FLOOR,
    MATCH_CODE_PREFIX_BASE - MATCH_CODE_PREFIX_DECAY * (keyLength - queryLength),
  );
/** `popularity` for an instrument: `min(10, 5·searchWeight)` (§3.3 L949). */
const instrumentPopularity = (weight: number): number => Math.min(10, 5 * weight);

const EQUITY_DEFAULT = SECTOR_DEFAULT_BONUS.Equity ?? 0;

/* ── R0: the exact applicable function code wins ───────────────────────────────────────────── */

describe('R0 — an exact, applicable function code is row 0', () => {
  it('ranks the W function above Wayfair even when Wayfair scores higher', () => {
    // Wayfair is the most recently used row (+15 recency), which lifts its score above the
    // function's. R0 is a HARD rule: it reorders without touching either score.
    const rows = run('W', { mru: { 'instrument:1': { rank: 0, count: 0 } } });

    expect(rows[0]?.kind).toBe('function');
    expect(rows[0]?.id).toBe('W');
    expect(rows[0]?.insertText).toBe('W');

    const wayfair = row(rows, 'instrument', '1');
    expect(wayfair.primary).toBe('W US Equity');
    expect(wayfair.score).toBeGreaterThan(rows[0]!.score);
    // …and Wayfair is the very next row: "W US Equity (Wayfair) as row 2" (§2.7 L831).
    expect(rows[1]?.id).toBe('1');
  });

  it('keeps the W function first with no MRU at all (score alone already wins)', () => {
    const rows = run('W');
    expect(rows[0]?.kind).toBe('function');
    expect(rows[0]?.id).toBe('W');
    expect(rows[0]?.score).toBe(
      MATCH_CODE_EXACT + KIND_PRIOR_FUNCTION_APPLICABLE + POPULARITY_FUNCTION_BY_TIER[1],
    );
  });

  it('CF on an equity panel is Company Filings, above CF Industries (§2.7 L833)', () => {
    const rows = run('CF', { panelSecurity: AAPL_PANEL });

    expect(rows[0]?.kind).toBe('function');
    expect(rows[0]?.id).toBe('CF');
    expect(rows[0]?.applicable).toBe(true);
    expect(rows[0]?.score).toBe(
      MATCH_CODE_EXACT + KIND_PRIOR_FUNCTION_APPLICABLE + POPULARITY_FUNCTION_BY_TIER[2],
    );
    expect(row(rows, 'instrument', '2').primary).toBe('CF US Equity');
  });

  it('CF on an fx panel falls below CF Industries and is marked inapplicable (§2.7 L834)', () => {
    const rows = run('CF', { panelSecurity: EURUSD_PANEL });

    expect(rows[0]?.kind).toBe('instrument');
    expect(rows[0]?.primary).toBe('CF US Equity');

    const fn = row(rows, 'function', 'CF');
    expect(fn.applicable).toBe(false);
    expect(fn.score).toBe(
      MATCH_CODE_EXACT + KIND_PRIOR_FUNCTION_WRONG_CLASS + POPULARITY_FUNCTION_BY_TIER[2],
    );
    expect(rows[0]!.score).toBeGreaterThan(fn.score);
  });

  it('GP on a loaded panel is the price graph, with GPC US Equity below it (§2.7 L828)', () => {
    const rows = run('GP', { panelSecurity: AAPL_PANEL });

    expect(rows[0]?.kind).toBe('function');
    expect(rows[0]?.id).toBe('GP');
    expect(rows[0]?.matchedOn).toBe('code');
    expect(row(rows, 'instrument', '3').primary).toBe('GPC US Equity');
  });

  it('GP on an empty panel still leads, scored with the −4 needs-a-security prior (§2.7 L829)', () => {
    const rows = run('GP');

    const fn = row(rows, 'function', 'GP');
    expect(fn.applicable).toBe(false);
    expect(fn.score).toBe(
      MATCH_CODE_EXACT + KIND_PRIOR_FUNCTION_NEEDS_SECURITY + POPULARITY_FUNCTION_BY_TIER[1],
    );
    // R0 does not fire (GP is not applicable), yet the score alone keeps it above GPC.
    expect(rows[0]).toBe(fn);
    expect(fn.score).toBeGreaterThan(row(rows, 'instrument', '3').score);
  });

  it('resolves an alias exactly: IB is row 0 as MSG, scored 92 (§2.7 L852)', () => {
    const rows = run('IB');

    expect(rows[0]?.kind).toBe('function');
    expect(rows[0]?.id).toBe('MSG');
    expect(rows[0]?.matchedOn).toBe('alias');
    // The row IS MSG, but what GO executes is the alias the user typed — see the ICVS case below.
    expect(rows[0]?.insertText).toBe('IB');
    expect(rows[0]?.score).toBe(
      MATCH_ALIAS_EXACT + KIND_PRIOR_FUNCTION_APPLICABLE + POPULARITY_FUNCTION_BY_TIER[2],
    );
  });

  it('an alias-matched row inserts the ALIAS, because the alias carries aliasParams', () => {
    // §3.3's result assembly: row 0 is exactly `parse(text)[0]`'s leading candidate, "so GO never
    // executes something other than row 0". `parse('ICVS')[0]` is `{ code:'CRVF', alias:'ICVS' }`
    // and `toRunRequest` reads `aliasParams { curveId:'SOFR_OIS' }` off the alias, so a row whose
    // insertText said `CRVF` would launch the same screen with `params {}` — a blank curve instead
    // of SOFR OIS. The parser side of this pair is pinned in parser.test.ts ("'ICVS' — the alias of
    // CRVF, carrying aliasParams"), which asserts the same string from `insertTextFor`.
    const rows = run('ICVS');

    expect(rows[0]?.kind).toBe('function');
    expect(rows[0]?.id).toBe('CRVF');
    expect(rows[0]?.primary).toBe('CRVF');
    expect(rows[0]?.matchedOn).toBe('alias');
    expect(rows[0]?.insertText).toBe('ICVS');
    expect(REGISTRY.canonical('ICVS')).toBe('CRVF');
    // Lower case in, canonical alias spelling out: the command line is case-insensitive.
    expect(run('icvs')[0]?.insertText).toBe('ICVS');
    // A prefix of the alias still inserts the alias, not the code: `ICV` completes to `ICVS`.
    expect(row(run('ICV'), 'function', 'CRVF').insertText).toBe('ICVS');
    // A row matched on its own code is unaffected.
    expect(row(run('GP'), 'function', 'GP').insertText).toBe('GP');
  });
});

/* ── R1/R2/R3 ──────────────────────────────────────────────────────────────────────────────── */

describe('R1 — a typed sector narrows to that sector’s wedge', () => {
  it('excludes functions and returns W US Equity for W Equity', () => {
    const rows = run('W', { sectorGiven: 'Equity' });
    expect(rows.every((c) => c.kind === 'instrument')).toBe(true);
    expect(has(rows, 'function', 'W')).toBe(false);
    expect(rows[0]?.primary).toBe('W US Equity');
  });

  it('drops the sector-default bonus once a sector has been typed', () => {
    const withSector = row(run('W', { sectorGiven: 'Equity' }), 'instrument', '1');
    const without = row(run('W'), 'instrument', '1');
    expect(withSector.score).toBe(MATCH_TICKER_EXACT + instrumentPopularity(1));
    expect(without.score - withSector.score).toBe(EQUITY_DEFAULT);
  });

  it('filters on the asset classes of the sector, not on the sector label', () => {
    expect(run('SPX', { sectorGiven: 'Index' }).map((c) => c.id)).toEqual(['7']);
    expect(run('SPX', { sectorGiven: 'Curncy' })).toEqual([]);
    expect(run('EURUSD', { sectorGiven: 'Curncy' }).map((c) => c.id)).toEqual(['8']);
  });
});

describe('R2 — ctx.kinds restricts the kinds (SECF passes [instrument])', () => {
  it('returns instruments only, R0 notwithstanding', () => {
    const rows = run('W', { kinds: ['instrument'] });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((c) => c.kind === 'instrument')).toBe(true);
  });

  it('can restrict to functions', () => {
    const rows = run('W', { kinds: ['function'] });
    expect(rows.every((c) => c.kind === 'function')).toBe(true);
    expect(rows[0]?.id).toBe('W');
  });
});

describe('R3 — query length gates people, topics and the whole list', () => {
  it('returns nothing for an empty or whitespace query', () => {
    expect(run('')).toEqual([]);
    expect(run('   ')).toEqual([]);
  });

  it('excludes topics and people below two characters', () => {
    const one = run('F');
    expect(one.some((c) => c.kind === 'topic' || c.kind === 'person')).toBe(false);

    const two = run('FE');
    expect(has(two, 'topic', 'FED')).toBe(true);
  });

  it('admits a person at two characters', () => {
    expect(has(run('J'), 'person', '1')).toBe(false);
    expect(has(run('JA'), 'person', '1')).toBe(true);
  });
});

/* ── the match term ────────────────────────────────────────────────────────────────────────── */

describe('match — §3.3 L941-946', () => {
  it('function code exact scores 100 and alias exact 92', () => {
    expect(row(run('SRCH'), 'function', 'SRCH').score).toBe(
      MATCH_CODE_EXACT + KIND_PRIOR_FUNCTION_APPLICABLE + POPULARITY_FUNCTION_BY_TIER[3],
    );
    expect(row(run('IB'), 'function', 'MSG').score).toBe(
      MATCH_ALIAS_EXACT + KIND_PRIOR_FUNCTION_APPLICABLE + POPULARITY_FUNCTION_BY_TIER[2],
    );
  });

  it('code prefix decays by 2 per unmatched character', () => {
    const des = row(run('D', { panelSecurity: AAPL_PANEL }), 'function', 'DES');
    expect(des.matchedOn).toBe('code');
    expect(des.score).toBe(
      codePrefixScore('DES'.length, 1) +
        KIND_PRIOR_FUNCTION_APPLICABLE +
        POPULARITY_FUNCTION_BY_TIER[1],
    );
    expect(codePrefixScore(3, 1)).toBe(MATCH_CODE_PREFIX_BASE - MATCH_CODE_PREFIX_DECAY * 2);
  });

  it('an alias prefix is scored on the alias, and the best of code/alias wins', () => {
    // 'SF' (alias, 2 chars) beats 'SECF' (code, 4 chars) for the query 'S': 78 vs 74.
    const secf = row(run('S'), 'function', 'SECF');
    expect(secf.matchedOn).toBe('alias');
    expect(secf.score).toBe(
      codePrefixScore('SF'.length, 1) +
        KIND_PRIOR_FUNCTION_APPLICABLE +
        POPULARITY_FUNCTION_BY_TIER[1],
    );
  });

  it('floors the code/alias prefix at 62', () => {
    const index = UniverseIndex.build({
      version: 'floor',
      generatedAt: '2026-01-02T00:00:00.000Z',
      instruments: [],
      functions: [['XY', 'Long alias', ['FILINGSARCHIVE'], 3]],
      people: [],
      topics: [],
    });
    const registry = new FunctionRegistry([
      manifest('XY', 'Long alias', ['FILINGSARCHIVE'], 3, 'none', false),
    ]);
    const rows = rank('F', index, ctxOf(), registry);
    expect(codePrefixScore('FILINGSARCHIVE'.length, 1)).toBe(MATCH_CODE_PREFIX_FLOOR);
    expect(row(rows, 'function', 'XY').score).toBe(
      MATCH_CODE_PREFIX_FLOOR + KIND_PRIOR_FUNCTION_APPLICABLE + POPULARITY_FUNCTION_BY_TIER[3],
    );
  });

  it('ticker exact scores 100 and a ticker prefix decays by 2, floored at 60', () => {
    const msft = row(run('MSFT'), 'instrument', '11');
    expect(msft.matchedOn).toBe('ticker');
    expect(msft.score).toBe(MATCH_TICKER_EXACT + instrumentPopularity(2) + EQUITY_DEFAULT);

    const aapl = row(run('AAP'), 'instrument', '4');
    expect(aapl.score).toBe(
      tickerPrefixScore('AAPL'.length, 3) + instrumentPopularity(2) + EQUITY_DEFAULT,
    );

    const index = UniverseIndex.build({
      version: 'floor',
      generatedAt: '2026-01-02T00:00:00.000Z',
      instruments: [[1, 'ABCDEFGHIJKLM', 'Equity', 'US', 'Long Ticker Corp', 'equity', 1, 1]],
      functions: [],
      people: [],
      topics: [],
    });
    expect(tickerPrefixScore('ABCDEFGHIJKLM'.length, 1)).toBe(MATCH_TICKER_PREFIX_FLOOR);
    const rows = rank('A', index, ctxOf(), REGISTRY);
    expect(row(rows, 'instrument', '1').score).toBe(
      MATCH_TICKER_PREFIX_FLOOR + instrumentPopularity(1) + EQUITY_DEFAULT,
    );
  });

  it('scores a first name word 60 and a later name word 50', () => {
    const first = row(run('APPLE'), 'instrument', '4');
    expect(first.matchedOn).toBe('name');
    expect(first.score).toBe(MATCH_NAME_FIRST_WORD + instrumentPopularity(2));

    // 'Apple Hospitality REIT Inc' — 'HOSP' is the second word (FUNCTIONS.md §3.1 L888).
    const later = row(run('HOSP'), 'instrument', '5');
    expect(later.matchedOn).toBe('name');
    expect(later.score).toBe(MATCH_NAME_OTHER_WORD + instrumentPopularity(1));
  });

  it('scores a person name word 50 and a topic code prefix 60 / topic name word 45', () => {
    expect(row(run('JANE'), 'person', '1').score).toBe(MATCH_PERSON_NAME_WORD + KIND_PRIOR_PERSON);
    expect(row(run('DOE'), 'person', '1').score).toBe(MATCH_PERSON_NAME_WORD + KIND_PRIOR_PERSON);
    expect(row(run('FED'), 'topic', 'FED').score).toBe(MATCH_TOPIC_CODE_PREFIX + KIND_PRIOR_TOPIC);
    expect(row(run('RESERVE'), 'topic', 'FED').score).toBe(
      MATCH_TOPIC_NAME_WORD + KIND_PRIOR_TOPIC,
    );
  });

  it('falls back to trigrams only under the §3.1 thresholds, scoring 40·Jaccard', () => {
    // A typo with no prefix hits at all: 'MCROSOFT' finds nothing by ticker, code or word.
    const hits = INDEX.trigramSearch('MCROSOFT');
    const msftHit = hits.find((h) => INDEX.entryAt(h.entry)?.id === '11');
    expect(msftHit).toBeDefined();

    const rows = run('MCROSOFT');
    const msft = row(rows, 'instrument', '11');
    expect(msft.matchedOn).toBe('trigram');
    expect(msft.score).toBeCloseTo(
      MATCH_TRIGRAM_FACTOR * msftHit!.score + instrumentPopularity(2),
      10,
    );
    // No sector default: it is a trigram match, not a ticker match (§3.3 L953).
    expect(msft.score).toBeLessThan(MATCH_TRIGRAM_FACTOR + instrumentPopularity(2) + 1);
  });

  it('excludes a query that matches nothing', () => {
    expect(run('QQQQZZ')).toEqual([]);
  });
});

/* ── kindPrior, popularity, recency, context, penalties ────────────────────────────────────── */

describe('kindPrior — §3.3 L947-948', () => {
  it('gives +12 to an applicable function, −20 to the wrong class, −4 to an empty panel', () => {
    const applicable = row(run('CF', { panelSecurity: AAPL_PANEL }), 'function', 'CF');
    const wrongClass = row(run('CF', { panelSecurity: EURUSD_PANEL }), 'function', 'CF');
    const emptyPanel = row(run('CF'), 'function', 'CF');

    expect(applicable.score - wrongClass.score).toBe(
      KIND_PRIOR_FUNCTION_APPLICABLE - KIND_PRIOR_FUNCTION_WRONG_CLASS,
    );
    expect(applicable.score - emptyPanel.score).toBe(
      KIND_PRIOR_FUNCTION_APPLICABLE - KIND_PRIOR_FUNCTION_NEEDS_SECURITY,
    );
  });

  it("treats assetClasses 'any' and 'none' as always applicable", () => {
    expect(row(run('N', { panelSecurity: EURUSD_PANEL }), 'function', 'N').applicable).toBe(true);
    expect(row(run('W', { panelSecurity: EURUSD_PANEL }), 'function', 'W').applicable).toBe(true);
  });

  it('gives an instrument 0, a person −8 and a topic −6', () => {
    expect(row(run('MSFT'), 'instrument', '11').score).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(2) + EQUITY_DEFAULT,
    );
    expect(row(run('JANE'), 'person', '1').score).toBe(MATCH_PERSON_NAME_WORD + KIND_PRIOR_PERSON);
    expect(row(run('CPI'), 'topic', 'CPI').score).toBe(MATCH_TOPIC_CODE_PREFIX + KIND_PRIOR_TOPIC);
  });
});

describe('popularity — §3.3 L949-950', () => {
  it('scores an instrument min(10, 5·searchWeight)', () => {
    expect(row(run('HALF'), 'instrument', '15').score).toBeCloseTo(
      MATCH_TICKER_EXACT + 2.5 + EQUITY_DEFAULT,
      10,
    );
    expect(row(run('W'), 'instrument', '1').score).toBe(
      MATCH_TICKER_EXACT + 5 + EQUITY_DEFAULT,
    );
    expect(row(run('AAPL'), 'instrument', '4').score).toBe(
      MATCH_TICKER_EXACT + 10 + EQUITY_DEFAULT,
    );
    // searchWeight 3.0 would score 15; the term is capped at 10.
    expect(row(run('CAPX'), 'instrument', '14').score).toBe(
      MATCH_TICKER_EXACT + 10 + EQUITY_DEFAULT,
    );
  });

  it('scores a function by tier: 6 / 3 / 0', () => {
    const tier1 = row(run('W'), 'function', 'W').score;
    const tier2 = row(run('MSG'), 'function', 'MSG').score;
    const tier3 = row(run('SRCH'), 'function', 'SRCH').score;
    const base = MATCH_CODE_EXACT + KIND_PRIOR_FUNCTION_APPLICABLE;
    expect(tier1).toBe(base + POPULARITY_FUNCTION_BY_TIER[1]);
    expect(tier2).toBe(base + POPULARITY_FUNCTION_BY_TIER[2]);
    expect(tier3).toBe(base + POPULARITY_FUNCTION_BY_TIER[3]);
  });

  it('scores people and topics 0 for popularity', () => {
    expect(row(run('JANE'), 'person', '1').score).toBe(MATCH_PERSON_NAME_WORD + KIND_PRIOR_PERSON);
  });
});

describe('recency — §3.3 L951', () => {
  const base = MATCH_TICKER_EXACT + instrumentPopularity(2) + EQUITY_DEFAULT;

  it('adds 15·(1 − rank/20) for the twenty most recent rows', () => {
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 0, count: 0 } } }), 'instrument', '11').score).toBe(
      base + 15,
    );
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 10, count: 0 } } }), 'instrument', '11').score).toBe(
      base + 7.5,
    );
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 19, count: 0 } } }), 'instrument', '11').score).toBeCloseTo(
      base + 0.75,
      10,
    );
  });

  it('adds nothing beyond the twentieth row', () => {
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 20, count: 0 } } }), 'instrument', '11').score).toBe(
      base,
    );
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 99, count: 0 } } }), 'instrument', '11').score).toBe(
      base,
    );
  });

  it('adds +1 per ten uses, capped at +5', () => {
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 20, count: 9 } } }), 'instrument', '11').score).toBe(
      base,
    );
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 20, count: 25 } } }), 'instrument', '11').score).toBe(
      base + 2,
    );
    expect(row(run('MSFT', { mru: { 'instrument:11': { rank: 20, count: 1000 } } }), 'instrument', '11').score).toBe(
      base + 5,
    );
  });

  it('keys the MRU on kind:id, so a function and an instrument do not share a boost', () => {
    const rows = run('W', { mru: { 'function:W': { rank: 0, count: 0 } } });
    expect(row(rows, 'function', 'W').score).toBe(
      MATCH_CODE_EXACT + KIND_PRIOR_FUNCTION_APPLICABLE + POPULARITY_FUNCTION_BY_TIER[1] + 15,
    );
    expect(row(rows, 'instrument', '1').score).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(1) + EQUITY_DEFAULT,
    );
  });
});

describe('context — §3.3 L952-953', () => {
  it('adds +8 for an instrument in the panel’s watchlist', () => {
    const without = row(run('MSFT'), 'instrument', '11').score;
    const within = row(run('MSFT', { watchlistIds: [11] }), 'instrument', '11').score;
    expect(within - without).toBe(CONTEXT_WATCHLIST);
  });

  it('adds +4 for another share class of the panel security, not for the panel security itself', () => {
    const rows = run('BRK', {
      panelSecurity: {
        instrumentId: 9,
        assetClass: 'equity',
        marketSector: 'Equity',
        display: 'BRK/A US Equity',
      },
    });
    const classA = row(rows, 'instrument', '9');
    const classB = row(rows, 'instrument', '10');
    expect(classB.score - classA.score).toBe(CONTEXT_SAME_ISSUER);
    expect(classA.score).toBe(
      tickerPrefixScore('BRK/A'.length, 3) + instrumentPopularity(2) + EQUITY_DEFAULT,
    );
    expect(rows[0]).toBe(classB);
  });

  it('the +4 same-issuer term does NOT reach the ETF ↔ index proxy pairing (known gap)', () => {
    // §3.3 L952 names three cases for `+4 same issuer as the panel security`: an ETF ↔ index proxy,
    // and share classes. The client-side snapshot (`UniverseInstrumentTuple`, API.md §5.2) carries
    // no issuer column, so `isSameIssuer` recognises only what the tuple expresses — a shared ticker
    // root — and the proxy case scores zero here. It is applied server-side, where `issuer_aliases`
    // is available. This test pins the gap so it is visible rather than implied: when an issuer or
    // proxy column is added to the snapshot (WP-08 owns it), this assertion is what should flip.
    const panelOnProxy = row(
      run('SPX', {
        panelSecurity: {
          instrumentId: 16,
          assetClass: 'etf',
          marketSector: 'Equity',
          display: 'SPXL US Equity',
        },
      }),
      'instrument',
      '7',
    ).score;
    const panelElsewhere = row(run('SPX', { panelSecurity: AAPL_PANEL }), 'instrument', '7').score;
    expect(panelOnProxy).toBe(panelElsewhere);
    expect(panelOnProxy).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(2) + (SECTOR_DEFAULT_BONUS.Index ?? 0),
    );
    // The gap is symmetric: with the panel on the index, the leveraged ETF does not score either.
    // `tickerRoot` cuts at `/`, `.`, `-` and space, so `SPXL` and `SPX` are unrelated roots — only
    // a share-class suffix (`BRK/A` ↔ `BRK/B`, asserted above) is recognisable from the ticker.
    const proxy = row(
      run('SPX', {
        panelSecurity: {
          instrumentId: 7,
          assetClass: 'index',
          marketSector: 'Index',
          display: 'SPX Index',
        },
      }),
      'instrument',
      '16',
    ).score;
    const proxyElsewhere = row(run('SPX', { panelSecurity: AAPL_PANEL }), 'instrument', '16').score;
    expect(proxy).toBe(proxyElsewhere);
  });

  it('applies the sector default only to a ticker match, by sector', () => {
    expect(row(run('W'), 'instrument', '1').score).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(1) + (SECTOR_DEFAULT_BONUS.Equity ?? 0),
    );
    expect(row(run('SPX'), 'instrument', '7').score).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(2) + (SECTOR_DEFAULT_BONUS.Index ?? 0),
    );
    expect(row(run('EURUSD'), 'instrument', '8').score).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(2) + (SECTOR_DEFAULT_BONUS.Curncy ?? 0),
    );
    expect(row(run('912'), 'instrument', '12').score).toBe(
      tickerPrefixScore('912797VE4'.length, 3) +
        instrumentPopularity(1) +
        (SECTOR_DEFAULT_BONUS.Govt ?? 0),
    );
    expect(row(run('BTC'), 'instrument', '13').score).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(1) + (SECTOR_DEFAULT_BONUS.Crypto ?? 0),
    );
    // A name match gets no sector default at all.
    expect(row(run('APPLE'), 'instrument', '4').score).toBe(
      MATCH_NAME_FIRST_WORD + instrumentPopularity(2),
    );
  });
});

describe('penalties — §3.3 L954-955', () => {
  it('takes 30 off an instrument that is not active', () => {
    const zts = row(run('ZTS'), 'instrument', '6');
    expect(zts.score).toBe(
      MATCH_TICKER_EXACT + instrumentPopularity(1) + EQUITY_DEFAULT + PENALTY_INACTIVE,
    );
  });
});

/* ── tie-breaks and assembly ───────────────────────────────────────────────────────────────── */

describe('tie-breaks — §3.3 L957', () => {
  const candidate = (
    score: number,
    primary: string,
    kind: CandidateKind,
    id: string,
  ): Pick<Candidate, 'score' | 'primary' | 'kind' | 'id'> => ({ score, primary, kind, id });

  it('orders by score first', () => {
    expect(
      compareCandidates(
        candidate(10, 'AAA', 'instrument', '1'),
        candidate(11, 'AAA', 'instrument', '2'),
      ),
    ).toBeGreaterThan(0);
  });

  it('breaks an equal score on the shorter primary', () => {
    expect(
      compareCandidates(
        candidate(10, 'AA', 'instrument', '1'),
        candidate(10, 'AAA', 'instrument', '2'),
      ),
    ).toBeLessThan(0);
  });

  it('then alphabetically on primary', () => {
    expect(
      compareCandidates(
        candidate(10, 'AAB', 'instrument', '1'),
        candidate(10, 'AAA', 'instrument', '2'),
      ),
    ).toBeGreaterThan(0);
  });

  it('then by kind: instrument < function < topic < person', () => {
    const order: CandidateKind[] = ['instrument', 'function', 'topic', 'person'];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(
        compareCandidates(
          candidate(10, 'XX', order[i]!, 'a'),
          candidate(10, 'XX', order[i + 1]!, 'a'),
        ),
      ).toBeLessThan(0);
    }
  });

  it('is a total order, so the sort is reproducible on the client and the server', () => {
    expect(
      compareCandidates(
        candidate(10, 'XX', 'instrument', '1'),
        candidate(10, 'XX', 'instrument', '1'),
      ),
    ).toBe(0);
    expect(
      compareCandidates(
        candidate(10, 'XX', 'instrument', '1'),
        candidate(10, 'XX', 'instrument', '2'),
      ),
    ).toBeLessThan(0);
  });

  it('applies the tie-break end to end: two equal-scoring instruments sort by primary', () => {
    const index = UniverseIndex.build({
      version: 'tie',
      generatedAt: '2026-01-02T00:00:00.000Z',
      instruments: [
        [1, 'TIEB', 'Equity', 'US', 'Bravo Corp', 'equity', 1, 1],
        [2, 'TIEA', 'Equity', 'US', 'Alpha Corp', 'equity', 1, 1],
      ],
      functions: [],
      people: [],
      topics: [],
    });
    const rows = rank('TIE', index, ctxOf(), REGISTRY);
    expect(rows.map((c) => c.primary)).toEqual(['TIEA US Equity', 'TIEB US Equity']);
    expect(rows[0]!.score).toBe(rows[1]!.score);
  });
});

describe('assembly — §3.3 L958-962', () => {
  const manyInstruments = (n: number): UniverseInstrumentTuple[] =>
    Array.from({ length: n }, (_, i): UniverseInstrumentTuple => {
      const suffix = String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
      return [i + 1, `Z${suffix}`, 'Equity', 'US', `Zed ${suffix} Corp`, 'equity', 1, 1];
    });

  it('returns at most twelve rows', () => {
    const index = UniverseIndex.build({
      version: 'cap',
      generatedAt: '2026-01-02T00:00:00.000Z',
      instruments: manyInstruments(40),
      functions: [],
      people: [],
      topics: [],
    });
    const rows = rank('Z', index, ctxOf(), REGISTRY);
    expect(rows).toHaveLength(MAX_RESULTS);
  });

  it('caps one kind at eight when another kind is present', () => {
    const index = UniverseIndex.build({
      version: 'cap2',
      generatedAt: '2026-01-02T00:00:00.000Z',
      instruments: manyInstruments(40),
      functions: [['ZW', 'Zed Watch', [], 1]],
      people: [],
      topics: [],
    });
    const registry = new FunctionRegistry([manifest('ZW', 'Zed Watch', [], 1, 'none', false)]);
    const rows = rank('Z', index, ctxOf(), registry);
    expect(rows.filter((c) => c.kind === 'instrument')).toHaveLength(MAX_PER_KIND);
    expect(rows.filter((c) => c.kind === 'function')).toHaveLength(1);
  });

  it('lifts the cap to twelve when only one kind matches at all', () => {
    const index = UniverseIndex.build({
      version: 'cap3',
      generatedAt: '2026-01-02T00:00:00.000Z',
      instruments: manyInstruments(40),
      functions: [],
      people: [],
      topics: [],
    });
    const rows = rank('Z', index, ctxOf(), REGISTRY);
    expect(rows.filter((c) => c.kind === 'instrument')).toHaveLength(MAX_RESULTS);
  });

  it('is sorted best first and each row carries its rendering fields', () => {
    const rows = run('AAPL');
    for (let i = 1; i < rows.length; i += 1) {
      expect(compareCandidates(rows[i - 1]!, rows[i]!)).toBeLessThanOrEqual(0);
    }
    const aapl = row(rows, 'instrument', '4');
    expect(aapl.primary).toBe('AAPL US Equity');
    expect(aapl.secondary).toBe('Apple Inc · Common Stock · US');
    expect(aapl.insertText).toBe('AAPL US Equity');
    expect(aapl.matched).toEqual([[0, 4]]);
    expect(aapl.source).toBe('local');
    expect(aapl.assetClass).toBe('equity');
    expect(aapl.marketSector).toBe('Equity');
    expect(aapl.applicable).toBeUndefined();
  });

  it('builds the insertText of every kind (§3.2 L909)', () => {
    expect(row(run('GP', { panelSecurity: AAPL_PANEL }), 'function', 'GP').insertText).toBe('GP');
    expect(row(run('JANE'), 'person', '1').insertText).toBe('MSG jane.doe');
    expect(row(run('FED'), 'topic', 'FED').insertText).toBe('NI FED');
    expect(row(run('JANE'), 'person', '1').primary).toBe('Jane Doe (Demo Capital)');
  });

  it('highlights the matched range of primary, and nothing when the match is elsewhere', () => {
    expect(row(run('AAP'), 'instrument', '4').matched).toEqual([[0, 3]]);
    // 'HOSP' matched the name; the primary ('APLE US Equity') does not contain it.
    expect(row(run('HOSP'), 'instrument', '5').matched).toEqual([]);
  });
});

describe('robustness — rank() is called on every keystroke and never throws', () => {
  it('survives arbitrary queries, an empty index and a malformed context', () => {
    const junk = ['<', '/', '=', ' ', '😀', 'ÅÄÖ', '   ', 'AAPL US Equity', 'a'.repeat(400)];
    for (const q of junk) {
      expect(() => run(q)).not.toThrow();
      expect(() => rank(q, UniverseIndex.empty(), ctxOf(), REGISTRY)).not.toThrow();
    }
    const broken = { panel: null, hasPanelSecurity: true } as unknown as RankContext;
    expect(() => rank('AAPL', INDEX, broken, REGISTRY)).not.toThrow();
    expect(rank('AAPL', INDEX, broken, REGISTRY).length).toBeGreaterThan(0);
    expect(() => rank('AAPL', INDEX, ctxOf(), undefined as unknown as FunctionRegistry)).not.toThrow();
  });

  it('returns an empty list for an index that is not a UniverseIndex', () => {
    expect(rank('AAPL', {} as unknown as UniverseIndex, ctxOf(), REGISTRY)).toEqual([]);
  });
});

describe('§3.3 penalties — a yahoo hit never sits above a local hit', () => {
  const candidate = (
    id: string,
    score: number,
    source: 'local' | 'yahoo',
    matchedOn: Candidate['matchedOn'] = 'ticker',
  ): Candidate => ({
    kind: 'instrument',
    id,
    primary: `${id} US Equity`,
    secondary: id,
    score,
    matchedOn,
    matched: [],
    insertText: `${id} US Equity`,
    source,
  });

  it('orders the local hit first AND leaves its score above the yahoo row', () => {
    // The spec is "source 'yahoo' −25 (and never above a local hit with match ≥ 60)". Order alone
    // is not enough: these rows travel to the client as `SearchHit` carrying `score`, so anything
    // that re-sorts by that field (a server merge, a UI stitching two responses together) would
    // otherwise float the yahoo row straight back above the local hit.
    const out = clampYahooBelowLocal([candidate('YHO', 95, 'yahoo'), candidate('LOC', 70, 'local')]);
    expect(out.map((c) => c.id)).toEqual(['LOC', 'YHO']);
    expect(out[0]!.score).toBe(70);
    expect(out[1]!.score).toBeLessThan(out[0]!.score);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.score).toBeLessThanOrEqual(out[i - 1]!.score);
    }
  });

  it('shifts the whole yahoo block by one delta, keeping its internal order', () => {
    const out = clampYahooBelowLocal([
      candidate('Y1', 95, 'yahoo'),
      candidate('Y2', 90, 'yahoo'),
      candidate('L1', 80, 'local'),
      candidate('L2', 70, 'local'),
    ]);
    expect(out.map((c) => c.id)).toEqual(['L1', 'L2', 'Y1', 'Y2']);
    const [, , y1, y2] = out;
    expect(y1!.score).toBeLessThan(70);
    expect(y1!.score - y2!.score).toBe(5);
  });

  it('leaves the scores alone when no local hit is strong enough to clamp against', () => {
    const weak = LOCAL_HIT_MATCH_FLOOR - 1;
    const out = clampYahooBelowLocal([
      candidate('YHO', 95, 'yahoo'),
      candidate('LOC', weak, 'local'),
    ]);
    expect(out.map((c) => c.id)).toEqual(['YHO', 'LOC']);
    expect(out[0]!.score).toBe(95);
    expect(out[1]!.score).toBe(weak);
  });

  it('is a no-op on a list with no yahoo rows', () => {
    const rows = [candidate('A', 90, 'local'), candidate('B', 80, 'local')];
    expect(clampYahooBelowLocal(rows)).toEqual(rows);
  });
});
