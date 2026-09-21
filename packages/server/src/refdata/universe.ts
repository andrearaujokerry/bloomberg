/**
 * The search universe — seeded master rows ∪ the Cboe symbol book ∪ the SEC ticker file.
 * WORKPLAN §WP-04 L705 and L714-722, DATA_MODEL §3.1 L556-560, PROVIDERS §5.3 L795-812.
 *
 * Two halves, deliberately separated:
 *
 *  * `loadMasterUniverse()` reads what the master already says, as of `(validAt, knownAt)`, with
 *    the two flags the weight rules need: is this instrument a member of an index, and does it
 *    carry a `cboe.quotes` market-data line (i.e. did it come from the symbol book at all).
 *  * `mergeUniverse()` is **pure**. Given those rows, today's symbol book and today's SEC ticker
 *    file it returns one entry per `(ticker, exch_code)` with the name, status and
 *    `search_weight` the master should hold, and an `action` saying whether that is a new row, a
 *    refresh of an existing one, a delisting, or nothing at all.
 *
 * The purity matters because of the one-writer rule (WORKPLAN L714-722): the ≈36 k master rows
 * are written once by WP-15's `seed/universe.ts`, and `ingest/jobs/universeSymbolBook.ts` only
 * **refreshes** them through `upsertVersion`. If both created rows they would collide on
 * `md_lines_symbol_excl` and `identifiers_bt_excl`. Having the decision in a pure function means
 * the seed and the job take exactly the same decisions from the same inputs, and the difference
 * between them is only which actions they are allowed to apply.
 *
 * ## The `search_weight` rules
 *
 * `instruments.search_weight` is the autocomplete prior: `rank()` scores popularity as
 * `min(10, 5 × searchWeight)` (FUNCTIONS.md L947). DATA_MODEL L449 fixes the direction — "index
 * members > 1; Cboe-only symbols < 1" — and PROVIDERS L809 the reason: a symbol that exists only
 * in the symbol book, with no CIK and no FIGI, must be findable but must never outrank a real
 * security (TERM-02). WORKPLAN §17.9 records that no formula was written down and that one had to
 * be fixed; this is it, and it is deterministic:
 *
 * | Rule | Weight | Popularity in `rank()` |
 * | --- | --- | --- |
 * | member of an index we track | 2.0 | 10 |
 * | known to the SEC (has a CIK) | 1.0 | 5 |
 * | in the symbol book only, equity/ETF shape | 0.5 | 2.5 |
 * | any other symbol-book shape | 0.25 | 1.25 |
 * | a futures root (`A2RZ1`) | 0.1 | 0.5 |
 *
 * Highest applicable rule wins, and a weight already above the computed one is never lowered by
 * this merge: `seed/universe.ts` and `refdata/indexMembership.ts` may have raised it for reasons
 * the symbol book cannot see.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { AssetClass, InstrumentStatus, MarketSector } from '@terminal/core';

import { asOf, type AsOf } from '../db/bitemporal.js';
import type { Tx } from '../db/client.js';
import { instruments } from '../db/schema/index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One `data[]` entry of `cboe-symbol-book.json` (PROVIDERS §5.3: `{name, company_name}`). */
export interface CboeSymbolBookEntry {
  /** The Cboe symbol: 'AAPL', '_SPX', 'A2RZ1'. */
  name: string;
  /** The Cboe description: 'Apple Inc.', 'S&P 500 Index', 'Cboe futures'. */
  companyName: string;
}

/** One entry of SEC `company_tickers.json` (`{cik_str, ticker, title}`), CIK already padded. */
export interface SecTickerEntry {
  /** Zero-padded to 10 (`core/ids/cik.ts#padCik`). */
  cik: string;
  ticker: string;
  title: string;
}

/** A master row as the merge needs to see it. `loadMasterUniverse()` produces these. */
export interface MasterUniverseRow {
  instrumentId: number;
  ticker: string;
  exchCode: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  name: string;
  currency: string;
  status: InstrumentStatus;
  searchWeight: number;
  /** Member of at least one index we track, as of the read (weight rule 1). */
  isIndexMember: boolean;
  /** Carries a `cboe.quotes` md-line: it came from the symbol book and can leave it again. */
  hasCboeLine: boolean;
}

export interface UniverseMergeInput {
  master: readonly MasterUniverseRow[];
  symbolBook: readonly CboeSymbolBookEntry[];
  secTickers: readonly SecTickerEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type UniverseSource = 'master' | 'cboe.symbolBook' | 'sec.tickers';

/**
 * What the merge decided for one `(ticker, exchCode)`.
 *
 * * `create` — not in the master; WP-15's seed writes it, the refresh job does not (one writer).
 * * `refresh` — in the master and something the symbol book or the SEC file says differs.
 * * `delist` — in the master with a `cboe.quotes` line, and gone from today's book.
 * * `unchanged` — the master already says exactly this; `upsertVersion` would return `null`.
 */
export type UniverseAction = 'create' | 'refresh' | 'delist' | 'unchanged';

export interface UniverseEntry {
  /** `'AAPL|US'` — `(ticker, exchCode)`, the composite key of the search universe. */
  key: string;
  ticker: string;
  exchCode: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  name: string;
  currency: string;
  status: InstrumentStatus;
  searchWeight: number;
  /** `null` until the row exists in the master. */
  instrumentId: number | null;
  /** Padded CIK when the SEC ticker file knows this symbol. */
  cik: string | null;
  /** The `cboe.quotes` provider symbol ('AAPL', '_SPX'), when the book carries it. */
  providerSymbol: string | null;
  sources: readonly UniverseSource[];
  action: UniverseAction;
}

export type UniverseProblemKind =
  'duplicate_symbol' | 'duplicate_ticker' | 'symbol_book_short' | 'symbol_book_shrunk';

export interface UniverseProblem {
  kind: UniverseProblemKind;
  detail: string;
}

export interface UniverseMergeResult {
  entries: UniverseEntry[];
  problems: UniverseProblem[];
  counts: {
    master: number;
    symbolBook: number;
    secTickers: number;
    create: number;
    refresh: number;
    delist: number;
    unchanged: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Weights and shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The five weights, highest rule first. See the table in the module comment. */
export const SEARCH_WEIGHT = {
  indexMember: 2,
  secKnown: 1,
  cboeEquity: 0.5,
  cboeOther: 0.25,
  futuresRoot: 0.1,
} as const;

/** PROVIDERS §5.3 rejects a payload with fewer entries than this outright. */
export const MIN_SYMBOL_BOOK_ENTRIES = 30_000;

/** The recorded fixture's entry count, used as the `poll_anomaly` expectation. */
export const EXPECTED_SYMBOL_BOOK_ENTRIES = 35_618;

/** A drop larger than this day-over-day opens `data_exceptions kind 'source_conflict'`. */
export const SYMBOL_BOOK_SHRINK_LIMIT = 0.02;

export type CboeSymbolShape = 'equity' | 'etf' | 'index' | 'future' | 'other';

export interface CboeClassification {
  shape: CboeSymbolShape;
  /** The ticker the master carries: '_SPX' is the *provider* symbol for ticker 'SPX'. */
  ticker: string;
  assetClass: AssetClass;
  marketSector: MarketSector;
  exchCode: string;
  status: InstrumentStatus;
  searchWeight: number;
}

/** 1-5 letters, possibly with a class suffix Cboe writes with a dot or a slash: 'BRK.B', 'BF/B'. */
const EQUITY_SHAPE = /^[A-Z]{1,5}(?:[./][A-Z])?$/;

/** PROVIDERS §5.3: a futures root — month code + year digit, described as 'Futures'. */
const FUTURES_SHAPE = /^[A-Z0-9]{2,6}[FGHJKMNQUVXZ]\d$/;

/** Fund markers in the Cboe description. The SEC file cannot tell an ETF from an operating co. */
const ETF_MARKERS =
  /\b(ETF|ETN|FUND|TRUST|SHARES|PORTFOLIO|INDEX FUND|SPDR|ISHARES|VANGUARD|INVESCO|PROSHARES|WISDOMTREE|DIREXION)\b/;

/**
 * Classify one symbol-book entry by shape alone — the classification PROVIDERS §5.3 performs
 * "before anything is written". No IO, no master lookup: the SEC join happens in `mergeUniverse`.
 */
export function classifyCboeSymbol(entry: CboeSymbolBookEntry): CboeClassification {
  const name = entry.name.trim().toUpperCase();
  const description = entry.companyName.trim();
  const upperDescription = description.toUpperCase();

  if (name.startsWith('_')) {
    return {
      shape: 'index',
      ticker: name.slice(1),
      assetClass: 'index',
      marketSector: 'Index',
      exchCode: 'INDEX',
      status: 'active',
      searchWeight: SEARCH_WEIGHT.cboeOther,
    };
  }

  if (FUTURES_SHAPE.test(name) && upperDescription.includes('FUTURES')) {
    return {
      shape: 'future',
      ticker: name,
      assetClass: 'future',
      marketSector: 'Comdty',
      exchCode: 'US',
      // Not tradable through this terminal and not in the equity universe: findable, last.
      status: 'pending',
      searchWeight: SEARCH_WEIGHT.futuresRoot,
    };
  }

  if (EQUITY_SHAPE.test(name)) {
    const isFund = ETF_MARKERS.test(upperDescription);
    return {
      shape: isFund ? 'etf' : 'equity',
      ticker: name,
      assetClass: isFund ? 'etf' : 'equity',
      marketSector: 'Equity',
      exchCode: 'US',
      status: 'active',
      searchWeight: SEARCH_WEIGHT.cboeEquity,
    };
  }

  return {
    shape: 'other',
    ticker: name,
    assetClass: 'equity',
    marketSector: 'Equity',
    exchCode: 'US',
    status: 'active',
    searchWeight: SEARCH_WEIGHT.cboeOther,
  };
}

/**
 * The weight the rules give a symbol. `current` is the weight the master already holds: the merge
 * never lowers a weight it did not raise, because membership and the seed know things the symbol
 * book does not.
 */
export function searchWeightFor(
  flags: { isIndexMember: boolean; hasCik: boolean; shape?: CboeSymbolShape },
  current?: number,
): number {
  let weight: number;
  if (flags.isIndexMember) weight = SEARCH_WEIGHT.indexMember;
  else if (flags.hasCik) weight = SEARCH_WEIGHT.secKnown;
  else if (flags.shape === 'future') weight = SEARCH_WEIGHT.futuresRoot;
  else if (flags.shape === 'equity' || flags.shape === 'etf') weight = SEARCH_WEIGHT.cboeEquity;
  else if (flags.shape === undefined) weight = SEARCH_WEIGHT.secKnown;
  else weight = SEARCH_WEIGHT.cboeOther;
  return current === undefined ? weight : Math.max(weight, current);
}

/** `(ticker, exchCode)` — the merge key. Upper-cased so 'aapl' and 'AAPL' are one symbol. */
export function universeKey(ticker: string, exchCode: string): string {
  return `${ticker.trim().toUpperCase()}|${exchCode.trim().toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The merge
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Merge the three universes. Pure, total and order-independent: the symbol book is re-sorted by
 * symbol so the output does not depend on the provider's ordering (PROVIDERS §5.3), and a
 * duplicate symbol keeps the first entry and raises a `duplicate_symbol` problem.
 */
export function mergeUniverse(input: UniverseMergeInput): UniverseMergeResult {
  const problems: UniverseProblem[] = [];

  // SEC tickers, by upper-cased ticker. A ticker claimed by two CIKs is dropped from the join —
  // attaching the wrong CIK to an issuer is worse than attaching none (REF-02).
  const secByTicker = new Map<string, SecTickerEntry>();
  const secAmbiguous = new Set<string>();
  for (const row of input.secTickers) {
    const ticker = row.ticker.trim().toUpperCase();
    if (ticker.length === 0) continue;
    const seen = secByTicker.get(ticker);
    if (seen === undefined) {
      secByTicker.set(ticker, { ...row, ticker });
      continue;
    }
    if (seen.cik !== row.cik) secAmbiguous.add(ticker);
  }
  for (const ticker of [...secAmbiguous].sort()) {
    secByTicker.delete(ticker);
    problems.push({
      kind: 'duplicate_ticker',
      detail: `SEC ticker file maps ${ticker} to more than one CIK; no CIK attached`,
    });
  }

  // The symbol book, classified, de-duplicated, sorted by symbol.
  const book = new Map<string, { entry: CboeSymbolBookEntry; shape: CboeClassification }>();
  const sortedBook = [...input.symbolBook].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of sortedBook) {
    const symbol = entry.name.trim().toUpperCase();
    if (symbol.length === 0) continue;
    if (book.has(symbol)) {
      problems.push({ kind: 'duplicate_symbol', detail: `duplicate symbol-book entry ${symbol}` });
      continue;
    }
    book.set(symbol, { entry, shape: classifyCboeSymbol(entry) });
  }

  if (input.symbolBook.length > 0 && input.symbolBook.length < MIN_SYMBOL_BOOK_ENTRIES) {
    problems.push({
      kind: 'symbol_book_short',
      detail:
        `symbol book has ${String(input.symbolBook.length)} entries, ` +
        `expected about ${String(EXPECTED_SYMBOL_BOOK_ENTRIES)}`,
    });
  }

  const masterByKey = new Map<string, MasterUniverseRow>();
  for (const row of input.master) masterByKey.set(universeKey(row.ticker, row.exchCode), row);

  const entries = new Map<string, UniverseEntry>();

  // 1. Every symbol in today's book, joined to the SEC file and to the master.
  for (const [symbol, { entry, shape }] of book) {
    const key = universeKey(shape.ticker, shape.exchCode);
    const master = masterByKey.get(key);
    const sec = secByTicker.get(shape.ticker);
    const isIndexMember = master?.isIndexMember ?? false;
    const name =
      entry.companyName.trim().length > 0
        ? entry.companyName.trim()
        : (sec?.title ?? master?.name ?? shape.ticker);
    const weight = searchWeightFor(
      { isIndexMember, hasCik: sec !== undefined, shape: shape.shape },
      master?.searchWeight,
    );
    const sources: UniverseSource[] = ['cboe.symbolBook'];
    if (sec !== undefined) sources.push('sec.tickers');
    if (master !== undefined) sources.unshift('master');

    const status: InstrumentStatus =
      master !== undefined && master.status !== 'active' && shape.status === 'active'
        ? // The book listing it again is a relisting: the symbol trades today.
          'active'
        : shape.status;

    entries.set(key, {
      key,
      ticker: shape.ticker,
      exchCode: shape.exchCode,
      assetClass: master?.assetClass ?? shape.assetClass,
      marketSector: master?.marketSector ?? shape.marketSector,
      name,
      currency: master?.currency ?? 'USD',
      status,
      searchWeight: weight,
      instrumentId: master?.instrumentId ?? null,
      cik: sec?.cik ?? null,
      providerSymbol: symbol,
      sources,
      action:
        master === undefined
          ? 'create'
          : differs(master, { name, status, searchWeight: weight })
            ? 'refresh'
            : 'unchanged',
    });
  }

  // 2. Every master row the book did not mention. A row that came from the book and is no longer
  //    in it is delisted; a row that never came from the book (govt, fx, index, rate, econ) is
  //    left alone — the symbol book has no opinion about it.
  for (const [key, master] of masterByKey) {
    if (entries.has(key)) continue;
    const sec = secByTicker.get(master.ticker.trim().toUpperCase());
    const weight = searchWeightFor(
      { isIndexMember: master.isIndexMember, hasCik: sec !== undefined },
      master.searchWeight,
    );
    const gone = master.hasCboeLine && book.size > 0 && master.status === 'active';
    const status: InstrumentStatus = gone ? 'delisted' : master.status;
    const sources: UniverseSource[] = ['master'];
    if (sec !== undefined) sources.push('sec.tickers');

    entries.set(key, {
      key,
      ticker: master.ticker,
      exchCode: master.exchCode,
      assetClass: master.assetClass,
      marketSector: master.marketSector,
      name: master.name,
      currency: master.currency,
      status,
      searchWeight: weight,
      instrumentId: master.instrumentId,
      cik: sec?.cik ?? null,
      providerSymbol: null,
      sources,
      action: gone
        ? 'delist'
        : differs(master, { name: master.name, status, searchWeight: weight })
          ? 'refresh'
          : 'unchanged',
    });
  }

  // 3. SEC tickers nobody else mentioned: a listed company Cboe does not quote. It belongs in the
  //    universe (SECF must find it) with the SEC weight, and no market-data line.
  for (const [ticker, sec] of secByTicker) {
    const key = universeKey(ticker, 'US');
    if (entries.has(key)) continue;
    entries.set(key, {
      key,
      ticker,
      exchCode: 'US',
      assetClass: 'equity',
      marketSector: 'Equity',
      name: sec.title,
      currency: 'USD',
      status: 'active',
      searchWeight: SEARCH_WEIGHT.secKnown,
      instrumentId: null,
      cik: sec.cik,
      providerSymbol: null,
      sources: ['sec.tickers'],
      action: 'create',
    });
  }

  const ordered = [...entries.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const counts = {
    master: input.master.length,
    symbolBook: input.symbolBook.length,
    secTickers: input.secTickers.length,
    create: ordered.filter((e) => e.action === 'create').length,
    refresh: ordered.filter((e) => e.action === 'refresh').length,
    delist: ordered.filter((e) => e.action === 'delist').length,
    unchanged: ordered.filter((e) => e.action === 'unchanged').length,
  };

  return { entries: ordered, problems, counts };
}

function differs(
  master: MasterUniverseRow,
  next: { name: string; status: InstrumentStatus; searchWeight: number },
): boolean {
  return (
    master.name !== next.name ||
    master.status !== next.status ||
    !nearlyEqual(master.searchWeight, next.searchWeight)
  );
}

/** `search_weight` is `real`: Postgres returns 0.5 exactly, but 0.1 round-trips as 0.10000000149. */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

/**
 * Day-over-day guard (PROVIDERS §5.3): a book more than 2 % smaller than yesterday's is a
 * `source_conflict` for data ops, not a reason to delist five hundred symbols silently.
 */
export function symbolBookShrink(today: number, yesterday: number | null): UniverseProblem | null {
  if (yesterday === null || yesterday === 0) return null;
  const drop = (yesterday - today) / yesterday;
  if (drop <= SYMBOL_BOOK_SHRINK_LIMIT) return null;
  return {
    kind: 'symbol_book_shrunk',
    detail: `symbol book shrank ${(drop * 100).toFixed(1)}% day-over-day (${String(yesterday)} → ${String(today)})`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The master side
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface LoadMasterUniverseOptions {
  /** Restrict to these asset classes; omitted = every class. */
  assetClasses?: readonly AssetClass[];
  /** Cap the number of rows (autocomplete snapshots are bounded). */
  limit?: number;
}

/**
 * Every instrument the master holds as of `(validAt, knownAt)`, with the two flags the weight
 * rules need. One query: the flags are `EXISTS` sub-selects against `index_members` and
 * `md_lines`, both as-of on the same instants, so the merge sees one consistent world.
 */
export async function loadMasterUniverse(
  tx: Tx,
  at: AsOf,
  options: LoadMasterUniverseOptions = {},
): Promise<MasterUniverseRow[]> {
  const classFilter =
    options.assetClasses === undefined || options.assetClasses.length === 0
      ? sql`true`
      : sql`${instruments.assetClass} IN (${sql.join(
          options.assetClasses.map((c) => sql`${c}`),
          sql`, `,
        )})`;

  const rows = await tx.execute<{
    instrument_id: string;
    ticker: string;
    exch_code: string;
    asset_class: AssetClass;
    market_sector: MarketSector;
    name: string;
    currency: string;
    status: string;
    search_weight: number;
    is_index_member: boolean;
    has_cboe_line: boolean;
  }>(sql`
    SELECT i.instrument_id,
           i.ticker,
           i.exch_code,
           i.asset_class,
           i.market_sector,
           i.name,
           i.currency,
           i.status,
           i.search_weight,
           EXISTS (SELECT 1
                     FROM index_members m
                    WHERE m.instrument_id = i.instrument_id
                      AND bt_as_of(m.valid_from, m.valid_to, m.tx_from, m.tx_to,
                                   ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz))
             AS is_index_member,
           EXISTS (SELECT 1
                     FROM md_lines l
                    WHERE l.instrument_id = i.instrument_id
                      AND l.source_id = 'cboe.quotes'
                      AND bt_as_of(l.valid_from, l.valid_to, l.tx_from, l.tx_to,
                                   ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz))
             AS has_cboe_line
      FROM instruments i
     WHERE bt_as_of(i.valid_from, i.valid_to, i.tx_from, i.tx_to,
                    ${at.validAt}::timestamptz, ${at.knownAt}::timestamptz)
       AND ${classFilter}
     ORDER BY i.search_weight DESC, i.instrument_id
     ${options.limit === undefined ? sql`` : sql`LIMIT ${options.limit}`}`);

  return rows.rows.map((row) => ({
    instrumentId: Number(row.instrument_id),
    ticker: row.ticker,
    exchCode: row.exch_code,
    assetClass: row.asset_class,
    marketSector: row.market_sector,
    name: row.name,
    currency: row.currency.trim(),
    status: row.status as InstrumentStatus,
    searchWeight: row.search_weight,
    isIndexMember: row.is_index_member,
    hasCboeLine: row.has_cboe_line,
  }));
}

/** The instrument ids of the merged universe that already exist, for a caller that wants them. */
export async function masterInstrumentId(
  tx: Tx,
  ticker: string,
  exchCode: string,
  at: AsOf,
): Promise<number | null> {
  const rows = await tx
    .select({ instrumentId: instruments.instrumentId })
    .from(instruments)
    .where(
      and(
        asOf(instruments, at),
        sql`upper(${instruments.ticker}) = ${ticker.trim().toUpperCase()}`,
        eq(instruments.exchCode, exchCode),
      ),
    )
    .limit(2);
  if (rows.length !== 1) return null;
  return rows[0]?.instrumentId ?? null;
}
