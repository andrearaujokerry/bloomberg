// packages/server/src/seed/universe.ts
//
// Seed modules 2-5 of DATA_MODEL §18 (L2561-2564), in one file because they are one graph: every
// row below either *is* an instrument or points at one.
//
//   module 2  calendars & exchanges     9 calendars, their weekly sessions, 1990-2040 holidays,
//                                       the 14 named venues
//   module 3  the US listed universe    issuers, issues, instruments, md_lines, identifiers from
//                                       `cboe-symbol-book.json` ∪ `sec-company-tickers.json`,
//                                       enriched for AAPL from `openfigi-map`
//   module 5  indices, FX, crypto       the 31 index instruments, 9 G10 pairs, 4 crypto
//   module 4  the S&P 500               indices, index_members × 2 as-of dates, etf_holdings,
//                                       GICS classifications, fund_terms, index_terms,
//                                       entity_relations
//
// ## Why 5 runs before 4
//
// `indices.instrument_id` is `NOT NULL UNIQUE` and names the index's own instrument (`SPX Index`),
// and `index_terms.proxy_fund_instrument_id` names SPY. So the 31 index instruments of §18 row 5
// must exist before a single `indices` row of §18 row 4 can be written. §18's numbering is a
// reading order, not an execution order; the execution order is the dependency order, and this file
// states it once here rather than leaving it implicit in four call sites.
//
// ## Offline, deterministic, idempotent
//
// Every value comes from `fixtures/providers/raw/*` through the replay store — never a socket — and
// carries a `provenance` row naming the capture it came from (DATA-10). The one exception is stated
// and bounded: module 5's reference table of 31 indices, 9 currency pairs and 4 crypto assets is the
// seed's own curated input (no capture names the FTSE MIB's currency), and it is written under
// `licence_registry.source_id = 'internal.user'`, which the registry defines as "uploads, and the
// seed itself". Its provenance row hashes the serialised table, so a `Ctrl+I` on a cell sourced
// from it reaches bytes that pin the exact list that produced the row — the same guarantee a
// recorded capture gives, over a different set of bytes. Module 1 has the same shape: the 33
// `licence_registry` rows come from `providers/licences.ts`, not from a fixture.
//
// Running twice writes **zero** rows the second time, and that is designed in rather than bolted on:
//
//   * `provenance` is *found* before it is inserted, keyed on
//     `(source_id, request_key, response_sha256, adapter_version)`. The table has no unique index
//     (it is an append-only log of exchanges), so a naive seed would add 9 rows per run and every
//     acceptance count would drift.
//   * the bitemporal master goes through `refdata/universe.ts#mergeUniverse`, whose `action` per
//     `(ticker, exch_code)` is `'unchanged'` on the second run — the same decision function
//     `ingest/jobs/universeSymbolBook.ts` uses, because the one-writer rule of WORKPLAN L714-722
//     says the seed and that job must decide identically and differ only in which actions they
//     apply. The seed applies `'create'` and `'refresh'`; it never applies `'delist'`.
//   * `calendar_holidays`, `exchanges`, `classification_codes` and `etf_holdings` are plain keyed
//     tables and are upserted with a `WHERE` on the DO UPDATE, so an identical row is not rewritten
//     (`ON CONFLICT DO UPDATE` without one writes a new tuple every run and shows up as bloat and
//     as a bumped `config_version`).
//   * `index_members` goes through `refdata/indexMembership.ts#recordSnapshot`, which already
//     no-ops on a repeated snapshot.
//
// ## Bulk inserts, and the line this file does not cross
//
// The listed universe is ~37 k instruments, ~37 k issues, ~33 k issuers, ~36 k market-data lines and
// ~84 k identifiers. `db/bitemporal.ts#writeVersion` costs three round trips per row — a
// `clock_timestamp()` read, an overlap SELECT and the INSERT — which is ~700 k round trips and turns
// `npm run db:seed` into a twenty-minute job. So the **first** version of a key, and only that, is
// written by a chunked multi-row INSERT through {@link bulkInsertVersions}.
//
// That is sound precisely because it is the degenerate case: for a key with no current version there
// is nothing to close and no remainder to re-insert, so `writeVersion`'s three steps collapse to its
// step 3. Which keys have no current version is not guessed — `mergeUniverse` is handed the master
// rows and says so. Every other write on this file's path goes through `bitemporal.ts` or a
// `refdata/*` repository that does: `'refresh'` entries through `InstrumentRepository.upsert`,
// classifications through `ClassificationRepository`, terms through `TermsRepository`, memberships
// through `recordSnapshot`. The version close is never hand-rolled here, which is the rule
// bitemporal.ts's header sets out.
//
// The knowledge instant is handed out by {@link KnowledgeClock} rather than read per statement. A
// capture's `captured_at` is the floor ("we could not have known it before we fetched it"), but the
// two membership snapshots were captured in the *opposite* order to their report dates — SSGA
// (as-of 2026-09-14) at 18:45:45, N-PORT (as-of 2026-06-30) at 18:47:33 — and applying them in
// report-date order with their own capture instants would set a `tx_to` earlier than the `tx_from`
// it closes, which `bt_guard_update` rejects by design. So transaction time is monotone in
// application order, never backwards, and still deterministic.
//
// ## Two things this file cannot fix from here
//
//  1. `refdata/universe.ts#mergeUniverse` marks a master row `'delist'` when the row carries a
//     `cboe.quotes` line and today's symbol book does not mention it. The rule has no asset-class
//     guard, and module 5's `SPX Index` and `VIX Index` instruments legitimately carry
//     `cboe.quotes/_SPX` and `cboe.quotes/_VIX` while the book spells its index roots `^SPX` and
//     `^VIX` under `exch_code = 'US'`. So a second `db:seed` reports `2 delist` (measured), and
//     `ingest/jobs/universeSymbolBook.ts`, which *applies* delistings, would delist both on its
//     first run. The seed never applies a delist, so the seed itself stays idempotent; the fix is a
//     guard in that merge (only rows whose `exch_code` the symbol book enumerates can leave it) and
//     it belongs to the file that owns the rule.
//  2. The committed integration suite writes its own `md_lines (cboe.quotes, 'AAPL')`,
//     `(cboe.quotes, '_SPX')`, `(yahoo.chart, 'EURUSD=X')` and a dozen more keys that §18 requires
//     this seed to own, and `md_lines_symbol_excl` allows exactly one current version per
//     `(source_id, provider_symbol)` — correctly: a provider symbol feeds one line. Once the seed
//     has run into the test database those files abort with 23P01 (measured: `ws/handshake` 4/4 and
//     `functions/DES` 16/16 pass against a licences-only database and fail against a seeded one).
//     No choice of `valid_from` avoids it, because both claims run to `'infinity'`. The remedy is
//     the harness change `vitest.config.ts` already assigns to WP-15 — one seeding helper the
//     integration files share, which reuses the seeded line instead of inserting a second one — and
//     it spans files this module does not own.
//
// ## Where this file's counts differ from §18, and why
//
// §18's volumes were written before `refdata/universe.ts` existed and four of them cannot be
// reproduced from the committed fixtures. `test/integration/seed/volumes.test.ts` asserts the real
// number against the §18 target and names both, so the difference is visible rather than absorbed:
//
//   * `issuers` — §18 says "≈ 10.5k (CIK)". 10,422 is the *entry* count of
//     `sec-company-tickers.json`; those entries carry 8,022 distinct CIKs, because a multi-class
//     issuer repeats (GOOG/GOOGL). `issuers` is keyed by the legal entity, so the CIK-keyed count is
//     8,022, plus one issuer per distinct Cboe `company_name` that no CIK claims.
//   * `instruments` — §18 says "≈ 35.6k", which is the symbol book's own 35,618. The merge is the
//     book ∪ the SEC ticker file, and the SEC file names 1,748 listed companies Cboe does not quote
//     (they must still be findable — SECF has to resolve them): 37,366, plus module 5's 44 indices,
//     currency pairs and crypto assets = 37,410.
//   * the equity/ETF split — §18 says equity ≈ 30k, etf ≈ 4k. `classifyCboeSymbol`'s `ETF_MARKERS`
//     matches TRUST/SHARES/PORTFOLIO as well as ETF/ETN, so the split lands at 30,359 / 6,889.
//   * `classification_codes` GICS — §18 says ≈ 180; the taxonomy in `refdata/classifications.ts` has
//     232 nodes (11 sectors, 25 groups, 69 industries, 127 sub-industries).
//
// Two §18 items this module deliberately does **not** write, because nothing on disk supports them:
//
//   * `classification_codes` SIC ≈ 440. No recorded capture carries a SIC code *list*.
//     `sec-submissions-*.json` carries one `sic` per issuer, which is two codes across the two
//     captured filers and belongs to module 10 (`seed/fundamentals.ts`) where those captures are
//     read. Inventing 440 code/name pairs would be exactly the "plausible number with no
//     provenance" DATA-10 exists to forbid.
//   * `data_exceptions` for the 1,907 `^`-prefixed Cboe index roots. DATA_MODEL §21.1.1 records
//     them as an open symbology question, and `ingest/jobs/symbologyRefresh.ts` owns the second
//     pass that resolves them. `data_exceptions` has no natural key, so writing them here would add
//     1,907 rows per run and break the idempotency acceptance row.

import { CALENDAR_SEED_YEARS, type Calendar } from '@terminal/core/calendars/calendar';
import { FX_USD } from '@terminal/core/calendars/fx';
import { XCBO, XNAS, XNYS } from '@terminal/core/calendars/nyse';
import { SIFMA } from '@terminal/core/calendars/sifma';
import { TARGET2, XLON } from '@terminal/core/calendars/target2';
import { USGOVT } from '@terminal/core/calendars/usgovt';
import { WEEKEND } from '@terminal/core/calendars/weekend';

import { sha256Hex, type AssetClass, type IdScheme, type MarketSector } from '@terminal/core';

import type { Tx } from '../db/client.js';
import { insertProvenance } from '../providers/provenance.js';
import {
  canonicalUrl,
  openReplayStore,
  requestHash,
  requestKey,
  type ReplayStore,
} from '../providers/replayStore.js';
import type { CaptureSourceId, NormaliseContext, RawRecord } from '../providers/types.js';
import { normaliseSymbolBook } from '../providers/cboe/parse.js';
import { normaliseOpenFigiMapping, parseOpenFigiJobs } from '../providers/openfigi/parse.js';
import { normaliseNport, normaliseTickers } from '../providers/sec/parse.js';
import { normaliseSsgaHoldings } from '../providers/ssga/parse.js';
import {
  ClassificationRepository,
  GICS,
  WIKI_SP500_URL,
  foldClassificationName,
  gicsCodes,
  parseWikiSp500,
  upsertGicsTaxonomy,
} from '../refdata/classifications.js';
import { CALENDAR_SOURCE_ID, calendarRows, materialiseCalendar } from '../refdata/calendars.js';
import { normaliseIdentifier } from '../refdata/identifiers.js';
import { recordSnapshot, upsertIndex } from '../refdata/indexMembership.js';
import { MasterRepositories, toInstrumentInput } from '../refdata/master.js';
import { TermsRepository } from '../refdata/terms.js';
import { loadMasterUniverse, mergeUniverse, type UniverseEntry } from '../refdata/universe.js';

import type { SeedContext } from './index.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `valid_from` of every reference version this module opens, and the same instant
 * `seed/licences.ts` uses for `licence_registry`. Fixed rather than `now()` so that re-seeding a
 * database produces byte-identical valid ranges: the history then reads as "this security existed
 * from the start of the system", which is the only honest claim a seed can make about a universe
 * snapshot taken on one day.
 *
 * Deliberately *not* the capture's `source_ts`: the Cboe symbol book of 2026-09-15 is evidence
 * that AAPL exists, not evidence that it started existing at 18:00:09 that afternoon.
 */
export const UNIVERSE_VALID_FROM = new Date('2026-01-01T00:00:00.000Z');

/** How many rows one multi-row INSERT carries. 2,000 × 12 arrays is comfortably inside PG 14's
 *  65,535-parameter limit while keeping the 37 k-row tables at ~19 statements. */
const INSERT_CHUNK = 2_000;

/** The nine calendars of `CALENDAR_IDS`, rule-generated by WP-02 (`core/calendars`). */
const SEEDED_CALENDARS: readonly Calendar[] = [
  XNYS,
  XNAS,
  XCBO,
  SIFMA,
  USGOVT,
  FX_USD,
  TARGET2,
  XLON,
  WEEKEND,
];

/** One `exchanges` row. */
interface ExchangeSeed {
  readonly mic: string;
  readonly operatingMic: string;
  readonly name: string;
  readonly country: string;
  readonly tz: string;
  readonly calendarId: string;
  /**
   * OpenFIGI venue code. Only the five DATA_MODEL §5 L812-819 spells out are set: `'UN'`→XNYS,
   * `'UW'`→XNAS, `'UP'`→ARCX, `'UF'`→BATS, `'LN'`→XLON. `exchanges_bbg_code_idx` is unique over
   * the non-null values, so guessing one wrong would permanently mis-file a venue's listings, and
   * the AAPL capture's twenty venue codes (UA, UC, UB, UM, UX, UD, VY…) are not documented anywhere
   * in this repository. Absent beats invented.
   */
  readonly bbgExchCode?: string;
  readonly compositeCode?: string;
  /** Cboe `exchange_id`, taken from the recorded quote payloads: `cboe-quote-AAPL.json` carries
   *  `exchange_id: 2` for a Nasdaq-listed stock, `cboe-spx` carries `5` for a Cboe index and
   *  `cboe-eu-indices` carries `115` for Cboe Europe. Nothing else is claimed. */
  readonly cboeExchangeId?: number;
}

/**
 * The 14 venues DATA_MODEL §18 row 2 names, in its order.
 *
 * `calendar_id` is `NOT NULL REFERENCES calendars`, and only nine calendars exist. The four US
 * equity venues share `XNYS` (one holiday rule, ARCX and BATS included); the two Cboe venues share
 * `XCBO` (09:30-16:15 ET, index options); `XLON` is its own. The seven remaining non-US venues get
 * `WEEKEND`, which asserts exactly what this system knows about them — Saturdays and Sundays are
 * shut — and nothing it does not. Pointing XETR at TARGET2 would look tidier and would be a claim
 * about German market holidays that no rule in `core/calendars` makes; FUNCTIONS_TIER1 §WEI L1986
 * says outright that XETR, XPAR, XTKS, XHKG and XASX have no seeded calendar, and a `WEEKEND` row
 * keeps that true while satisfying the foreign key.
 */
const SEEDED_EXCHANGES: readonly ExchangeSeed[] = [
  {
    mic: 'XNYS',
    operatingMic: 'XNYS',
    name: 'New York Stock Exchange',
    country: 'US',
    tz: 'America/New_York',
    calendarId: 'XNYS',
    bbgExchCode: 'UN',
    compositeCode: 'US',
  },
  {
    mic: 'XNAS',
    operatingMic: 'XNAS',
    name: 'Nasdaq Stock Market',
    country: 'US',
    tz: 'America/New_York',
    calendarId: 'XNAS',
    bbgExchCode: 'UW',
    compositeCode: 'US',
    cboeExchangeId: 2,
  },
  {
    mic: 'ARCX',
    operatingMic: 'XNYS',
    name: 'NYSE Arca',
    country: 'US',
    tz: 'America/New_York',
    calendarId: 'XNYS',
    bbgExchCode: 'UP',
    compositeCode: 'US',
  },
  {
    mic: 'BATS',
    operatingMic: 'BATS',
    name: 'Cboe BZX Exchange',
    country: 'US',
    tz: 'America/New_York',
    calendarId: 'XNYS',
    bbgExchCode: 'UF',
    compositeCode: 'US',
  },
  {
    mic: 'XCBO',
    operatingMic: 'XCBO',
    name: 'Cboe Options Exchange',
    country: 'US',
    tz: 'America/Chicago',
    calendarId: 'XCBO',
    compositeCode: 'US',
    cboeExchangeId: 5,
  },
  {
    mic: 'XCBF',
    operatingMic: 'XCBO',
    name: 'Cboe Futures Exchange',
    country: 'US',
    tz: 'America/Chicago',
    calendarId: 'XCBO',
    compositeCode: 'US',
  },
  {
    mic: 'XLON',
    operatingMic: 'XLON',
    name: 'London Stock Exchange',
    country: 'GB',
    tz: 'Europe/London',
    calendarId: 'XLON',
    bbgExchCode: 'LN',
    cboeExchangeId: 115,
  },
  {
    mic: 'XETR',
    operatingMic: 'XETR',
    name: 'Xetra',
    country: 'DE',
    tz: 'Europe/Berlin',
    calendarId: 'WEEKEND',
  },
  {
    mic: 'XPAR',
    operatingMic: 'XPAR',
    name: 'Euronext Paris',
    country: 'FR',
    tz: 'Europe/Paris',
    calendarId: 'WEEKEND',
  },
  {
    mic: 'XAMS',
    operatingMic: 'XAMS',
    name: 'Euronext Amsterdam',
    country: 'NL',
    tz: 'Europe/Amsterdam',
    calendarId: 'WEEKEND',
  },
  {
    mic: 'XSWX',
    operatingMic: 'XSWX',
    name: 'SIX Swiss Exchange',
    country: 'CH',
    tz: 'Europe/Zurich',
    calendarId: 'WEEKEND',
  },
  {
    mic: 'XTKS',
    operatingMic: 'XTKS',
    name: 'Tokyo Stock Exchange',
    country: 'JP',
    tz: 'Asia/Tokyo',
    calendarId: 'WEEKEND',
  },
  {
    mic: 'XHKG',
    operatingMic: 'XHKG',
    name: 'Hong Kong Stock Exchange',
    country: 'HK',
    tz: 'Asia/Hong_Kong',
    calendarId: 'WEEKEND',
  },
  {
    mic: 'XASX',
    operatingMic: 'XASX',
    name: 'Australian Securities Exchange',
    country: 'AU',
    tz: 'Australia/Sydney',
    calendarId: 'WEEKEND',
  },
];

/** PROVIDERS §5.1: Cboe delayed quotes are 15 minutes behind and polled every 10 s. */
const CBOE_QUOTES_DELAY_MIN = 15;
const CBOE_QUOTES_INTERVAL_MS = 10_000;
/** PROVIDERS §5.1/§5.4 — lower wins the composite merge; Cboe beats Yahoo on a US name. */
const CBOE_PRIORITY = 10;
/** PROVIDERS §5.6: the Yahoo chart is 15 minutes behind; the intraday job polls every 60 s. */
const YAHOO_DELAY_MIN = 15;
const YAHOO_INTERVAL_MS = 60_000;
const YAHOO_PRIORITY = 20;
/** PROVIDERS §11: CoinGecko's free tier is real-time and rate-limited to ~30/min. */
const COINGECKO_DELAY_MIN = 0;
const COINGECKO_INTERVAL_MS = 60_000;
const COINGECKO_PRIORITY = 30;

/** Every fixture this module reads, by the URL that produced its request key. */
const CAPTURES = {
  symbolBook: {
    sourceId: 'cboe.symbolBook',
    url: 'https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/symbol-book.json',
    adapterVersion: 'cboe/1.0.0',
  },
  secTickers: {
    sourceId: 'sec.tickers',
    url: 'https://www.sec.gov/files/company_tickers.json',
    adapterVersion: 'sec/1.0.0',
  },
  openFigiMapping: {
    sourceId: 'openfigi.mapping',
    url: 'https://api.openfigi.com/v3/mapping',
    adapterVersion: 'openfigi/1.0.0',
    method: 'POST' as const,
  },
  nport: {
    sourceId: 'sec.archives',
    url: 'https://www.sec.gov/Archives/edgar/data/884394/000141036826089410/primary_doc.xml',
    adapterVersion: 'sec/1.0.0',
  },
  ssga: {
    sourceId: 'ssga.holdings',
    url: 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx',
    adapterVersion: 'ssga/1.0.0',
  },
  wiki: {
    sourceId: 'wiki.sp500',
    url: WIKI_SP500_URL,
    adapterVersion: 'wiki/1.0.0',
  },
  cboeSpx: {
    sourceId: 'cboe.quotes',
    url: 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json',
    adapterVersion: 'cboe/1.0.0',
  },
  cboeVix: {
    sourceId: 'cboe.quotes',
    url: 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json',
    adapterVersion: 'cboe/1.0.0',
  },
  cboeEuIndices: {
    sourceId: 'cboe.euIndices',
    url: 'https://cdn.cboe.com/api/global/european_indices/index_quotes/BUK100P.json',
    adapterVersion: 'cboe/1.0.0',
  },
  yahooSpx: {
    sourceId: 'yahoo.chart',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=5m&range=5d',
    adapterVersion: 'yahoo/1.0.0',
  },
  yahooFtse: {
    sourceId: 'yahoo.chart',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?interval=5m&range=1d',
    adapterVersion: 'yahoo/1.0.0',
  },
  yahooFx: {
    sourceId: 'yahoo.chart',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX?interval=5m&range=1d',
    adapterVersion: 'yahoo/1.0.0',
  },
  coingecko: {
    sourceId: 'coingecko.simple',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum&include_24hr_change=true&vs_currencies=usd',
    adapterVersion: 'coingecko/1.0.0',
  },
} as const satisfies Record<
  string,
  { sourceId: CaptureSourceId; url: string; adapterVersion: string; method?: 'POST' }
>;

type CaptureName = keyof typeof CAPTURES;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module 5's curated reference table
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One seeded index. */
interface IndexSeed {
  /**
   * `indices.code` and `instruments.ticker`.
   *
   * Thirteen of the 31 are named by FUNCTIONS_TIER1 §WEI L1966-1978 (`SPX`, `VIX`, `NDX`, `INDU`,
   * `RTY`, `UKX`, `BUK100P`, `DAX`, `CAC`, `SX5E`, `NKY`, `HSI`, `AS51`) and those spellings are
   * used verbatim. For the other eighteen no document in this repository gives a code, so the rule
   * is mechanical and reversible: the Yahoo symbol with a leading `^` removed. `^GSPTSE` → `GSPTSE`,
   * `FTSEMIB.MI` → `FTSEMIB.MI`. A Bloomberg-style code (`SPTSX`, `FTSEMIB`) would read better and
   * would be invented.
   */
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  /** `index_terms.region`, bucketed by WEI step 2 into Americas / EMEA / APAC. */
  readonly region: 'Americas' | 'EMEA' | 'APAC';
  readonly provider: string;
  readonly methodology:
    | 'cap_weighted'
    | 'float_cap_weighted'
    | 'price_weighted'
    | 'equal_weighted'
    | 'volatility'
    | 'other';
  /** `md_lines.provider_symbol` for `yahoo.chart`; absent for the Cboe-only European index. */
  readonly yahooSymbol?: string;
  /** `md_lines.provider_symbol` for `cboe.quotes` — only `_SPX` and `_VIX` are recorded. */
  readonly cboeSymbol?: string;
  /** `md_lines.provider_symbol` for `cboe.euIndices`. */
  readonly cboeEuSymbol?: string;
}

/**
 * The 31 indices of DATA_MODEL §18 row 5, in the order §18 lists their Yahoo symbols.
 *
 * This table and the two below it are the seed's own curated input, written under
 * `internal.user` provenance whose bytes are the serialised table (see the module header). The
 * Yahoo and Cboe symbols are the only fields a capture could supply, and where one does — `^GSPC`,
 * `^FTSE`, `_SPX`, `_VIX`, `BUK100P` — that capture's provenance is what the `md_lines` row carries.
 */
const SEEDED_INDICES: readonly IndexSeed[] = [
  {
    code: 'SPX',
    name: 'S&P 500',
    currency: 'USD',
    region: 'Americas',
    provider: 'S&P Dow Jones Indices',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^GSPC',
    cboeSymbol: '_SPX',
  },
  {
    code: 'INDU',
    name: 'Dow Jones Industrial Average',
    currency: 'USD',
    region: 'Americas',
    provider: 'S&P Dow Jones Indices',
    methodology: 'price_weighted',
    yahooSymbol: '^DJI',
  },
  {
    code: 'IXIC',
    name: 'Nasdaq Composite',
    currency: 'USD',
    region: 'Americas',
    provider: 'Nasdaq',
    methodology: 'cap_weighted',
    yahooSymbol: '^IXIC',
  },
  {
    code: 'NDX',
    name: 'Nasdaq 100',
    currency: 'USD',
    region: 'Americas',
    provider: 'Nasdaq',
    methodology: 'cap_weighted',
    yahooSymbol: '^NDX',
  },
  {
    code: 'RTY',
    name: 'Russell 2000',
    currency: 'USD',
    region: 'Americas',
    provider: 'FTSE Russell',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^RUT',
  },
  {
    code: 'VIX',
    name: 'Cboe Volatility Index',
    currency: 'USD',
    region: 'Americas',
    provider: 'Cboe',
    methodology: 'volatility',
    yahooSymbol: '^VIX',
    cboeSymbol: '_VIX',
  },
  {
    code: 'GSPTSE',
    name: 'S&P/TSX Composite',
    currency: 'CAD',
    region: 'Americas',
    provider: 'S&P Dow Jones Indices',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^GSPTSE',
  },
  {
    code: 'MXX',
    name: 'S&P/BMV IPC',
    currency: 'MXN',
    region: 'Americas',
    provider: 'S&P Dow Jones Indices',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^MXX',
  },
  {
    code: 'BVSP',
    name: 'Ibovespa',
    currency: 'BRL',
    region: 'Americas',
    provider: 'B3',
    methodology: 'other',
    yahooSymbol: '^BVSP',
  },
  {
    code: 'UKX',
    name: 'FTSE 100',
    currency: 'GBP',
    region: 'EMEA',
    provider: 'FTSE Russell',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^FTSE',
  },
  {
    code: 'DAX',
    name: 'DAX',
    currency: 'EUR',
    region: 'EMEA',
    provider: 'Deutsche Boerse',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^GDAXI',
  },
  {
    code: 'CAC',
    name: 'CAC 40',
    currency: 'EUR',
    region: 'EMEA',
    provider: 'Euronext',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^FCHI',
  },
  {
    code: 'SX5E',
    name: 'EURO STOXX 50',
    currency: 'EUR',
    region: 'EMEA',
    provider: 'STOXX',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^STOXX50E',
  },
  {
    code: 'IBEX',
    name: 'IBEX 35',
    currency: 'EUR',
    region: 'EMEA',
    provider: 'BME',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^IBEX',
  },
  {
    code: 'FTSEMIB.MI',
    name: 'FTSE MIB',
    currency: 'EUR',
    region: 'EMEA',
    provider: 'FTSE Russell',
    methodology: 'float_cap_weighted',
    yahooSymbol: 'FTSEMIB.MI',
  },
  {
    code: 'AEX',
    name: 'AEX',
    currency: 'EUR',
    region: 'EMEA',
    provider: 'Euronext',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^AEX',
  },
  {
    code: 'SSMI',
    name: 'Swiss Market Index',
    currency: 'CHF',
    region: 'EMEA',
    provider: 'SIX',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^SSMI',
  },
  {
    code: 'OMX',
    name: 'OMX Stockholm 30',
    currency: 'SEK',
    region: 'EMEA',
    provider: 'Nasdaq',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^OMX',
  },
  {
    code: 'N225',
    name: 'Nikkei 225',
    currency: 'JPY',
    region: 'APAC',
    provider: 'Nikkei',
    methodology: 'price_weighted',
    yahooSymbol: '^N225',
  },
  {
    code: 'HSI',
    name: 'Hang Seng',
    currency: 'HKD',
    region: 'APAC',
    provider: 'Hang Seng Indexes',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^HSI',
  },
  {
    code: '000001.SS',
    name: 'SSE Composite',
    currency: 'CNY',
    region: 'APAC',
    provider: 'Shanghai Stock Exchange',
    methodology: 'cap_weighted',
    yahooSymbol: '000001.SS',
  },
  {
    code: 'STI',
    name: 'Straits Times Index',
    currency: 'SGD',
    region: 'APAC',
    provider: 'FTSE Russell',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^STI',
  },
  {
    code: 'AS51',
    name: 'S&P/ASX 200',
    currency: 'AUD',
    region: 'APAC',
    provider: 'S&P Dow Jones Indices',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^AXJO',
  },
  {
    code: 'BSESN',
    name: 'BSE SENSEX',
    currency: 'INR',
    region: 'APAC',
    provider: 'BSE',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^BSESN',
  },
  {
    code: 'KS11',
    name: 'KOSPI Composite',
    currency: 'KRW',
    region: 'APAC',
    provider: 'Korea Exchange',
    methodology: 'cap_weighted',
    yahooSymbol: '^KS11',
  },
  {
    code: 'TWII',
    name: 'TAIEX',
    currency: 'TWD',
    region: 'APAC',
    provider: 'Taiwan Stock Exchange',
    methodology: 'cap_weighted',
    yahooSymbol: '^TWII',
  },
  {
    code: 'JKSE',
    name: 'Jakarta Composite',
    currency: 'IDR',
    region: 'APAC',
    provider: 'Indonesia Stock Exchange',
    methodology: 'cap_weighted',
    yahooSymbol: '^JKSE',
  },
  {
    code: 'NZ50',
    name: 'S&P/NZX 50',
    currency: 'NZD',
    region: 'APAC',
    provider: 'S&P Dow Jones Indices',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^NZ50',
  },
  {
    code: 'TA125.TA',
    name: 'TA-125',
    currency: 'ILS',
    region: 'EMEA',
    provider: 'Tel Aviv Stock Exchange',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^TA125.TA',
  },
  {
    code: 'J203.JO',
    name: 'FTSE/JSE All Share',
    currency: 'ZAR',
    region: 'EMEA',
    provider: 'FTSE Russell',
    methodology: 'float_cap_weighted',
    yahooSymbol: '^J203.JO',
  },
  {
    code: 'BUK100P',
    name: 'Cboe UK 100',
    currency: 'GBP',
    region: 'EMEA',
    provider: 'Cboe',
    methodology: 'float_cap_weighted',
    cboeEuSymbol: 'BUK100P',
  },
];

/** One seeded currency pair. */
interface FxSeed {
  readonly pair: string;
  readonly base: string;
  readonly quote: string;
  readonly name: string;
  /** `fx_terms.pip_size` — 0.0001 on a four-decimal pair, 0.01 where the quote currency is JPY. */
  readonly pipSize: string;
  /** `fx_terms.spot_lag` — T+2 everywhere except USDCAD, which is T+1. */
  readonly spotLag: number;
}

/**
 * The nine G10 pairs of DATA_MODEL §18 row 5. The Yahoo symbol is `<PAIR>=X` for all nine, which is
 * what `ingest/hotset.ts#ALWAYS_ON_SEED_KEYS` resolves against — §18's shorthand `JPY=X` is the
 * Yahoo alias for the same series, and seeding it instead would leave the always-on set unresolved
 * and FX quietly unpolled.
 */
const SEEDED_FX: readonly FxSeed[] = [
  {
    pair: 'EURUSD',
    base: 'EUR',
    quote: 'USD',
    name: 'Euro / US Dollar',
    pipSize: '0.00010000',
    spotLag: 2,
  },
  {
    pair: 'GBPUSD',
    base: 'GBP',
    quote: 'USD',
    name: 'British Pound / US Dollar',
    pipSize: '0.00010000',
    spotLag: 2,
  },
  {
    pair: 'USDJPY',
    base: 'USD',
    quote: 'JPY',
    name: 'US Dollar / Japanese Yen',
    pipSize: '0.01000000',
    spotLag: 2,
  },
  {
    pair: 'USDCHF',
    base: 'USD',
    quote: 'CHF',
    name: 'US Dollar / Swiss Franc',
    pipSize: '0.00010000',
    spotLag: 2,
  },
  {
    pair: 'USDCAD',
    base: 'USD',
    quote: 'CAD',
    name: 'US Dollar / Canadian Dollar',
    pipSize: '0.00010000',
    spotLag: 1,
  },
  {
    pair: 'AUDUSD',
    base: 'AUD',
    quote: 'USD',
    name: 'Australian Dollar / US Dollar',
    pipSize: '0.00010000',
    spotLag: 2,
  },
  {
    pair: 'NZDUSD',
    base: 'NZD',
    quote: 'USD',
    name: 'New Zealand Dollar / US Dollar',
    pipSize: '0.00010000',
    spotLag: 2,
  },
  {
    pair: 'USDSEK',
    base: 'USD',
    quote: 'SEK',
    name: 'US Dollar / Swedish Krona',
    pipSize: '0.00010000',
    spotLag: 2,
  },
  {
    pair: 'USDNOK',
    base: 'USD',
    quote: 'NOK',
    name: 'US Dollar / Norwegian Krone',
    pipSize: '0.00010000',
    spotLag: 2,
  },
];

/** One seeded crypto asset. `coingeckoId` is `md_lines.provider_symbol` for `coingecko.simple`. */
interface CryptoSeed {
  readonly ticker: string;
  readonly name: string;
  readonly coingeckoId: string;
}

/**
 * The four crypto assets of §18 row 5. `coingecko-simple.json` records BTC and ETH only, so SOL and
 * XRP carry the curated provenance on their line as well as on their instrument — §18 says so
 * outright ("quotes recorded for BTC/ETH") and the `md_lines` row is the thing that makes them
 * pollable once a capture exists.
 */
const SEEDED_CRYPTO: readonly CryptoSeed[] = [
  { ticker: 'BTC', name: 'Bitcoin', coingeckoId: 'bitcoin' },
  { ticker: 'ETH', name: 'Ethereum', coingeckoId: 'ethereum' },
  { ticker: 'SOL', name: 'Solana', coingeckoId: 'solana' },
  { ticker: 'XRP', name: 'XRP', coingeckoId: 'ripple' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Rows written per table, for the runner's summary line and for `volumes.test.ts`. */
export interface SeedUniverseResult {
  readonly calendars: number;
  readonly calendarSessions: number;
  readonly calendarHolidays: number;
  readonly exchanges: number;
  readonly issuers: number;
  readonly issues: number;
  readonly instruments: number;
  readonly instrumentsRefreshed: number;
  readonly listings: number;
  readonly mdLines: number;
  readonly identifiers: number;
  readonly indices: number;
  readonly indexMembers: number;
  readonly etfHoldings: number;
  readonly entityClassifications: number;
  readonly classificationCodes: number;
  readonly fundTerms: number;
  readonly indexTerms: number;
  readonly fxTerms: number;
  readonly entityRelations: number;
  readonly provenance: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Knowledge instants
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Hands out `tx_from` values that never go backwards.
 *
 * A capture's `captured_at` is the honest floor for "when did we learn this", and it is
 * deterministic, which is why it is preferred to `clock_timestamp()`. But two facts written in one
 * transaction must have non-decreasing knowledge instants when the second closes the first
 * (`bt_guard_update`: "tx_to must be after tx_from"), and the committed fixtures do not cooperate:
 * the SSGA holdings file (as-of 2026-09-14) was captured at 18:45:45 and the N-PORT filing (as-of
 * 2026-06-30) at 18:47:33, so applying them in report-date order with their own capture instants
 * would try to close a version at an instant before it was opened.
 *
 * So each request returns `max(floor, last + 1 ms)`: the floor when it is safe, one millisecond
 * later than the previous instant when it is not. Deterministic, ordered, and never in the future —
 * the fixtures were captured in 2026-09 and {@link knowledgeInstant} rejects a future instant.
 */
class KnowledgeClock {
  #last = 0;

  /** The next knowledge instant at or after `floor`. */
  at(floor: Date): Date {
    const next = Math.max(floor.getTime(), this.#last + 1);
    this.#last = next;
    return new Date(next);
  }

  /**
   * Raise the floor to `instant` — the latest `tx_from` a table this run will close already holds.
   *
   * Without it the clock restarts at the capture instants on every run, and a second run that had
   * anything left to close would try to set a `tx_to` earlier than the `tx_from` it is closing.
   * `bt_guard_update` catches that loudly, which is right, but a seed should not need to be caught.
   */
  notBefore(instant: Date | null): void {
    if (instant === null) return;
    this.#last = Math.max(this.#last, instant.getTime());
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One column of a bulk insert: the database column name and the array type it is unnested as. */
interface BulkColumn {
  readonly name: string;
  readonly type: string;
}

/** The four columns `db/bitemporal.ts` owns, appended to every bulk version insert. */
const BT_COLUMNS: readonly BulkColumn[] = [
  { name: 'valid_from', type: 'timestamptz' },
  { name: 'valid_to', type: 'timestamptz' },
  { name: 'tx_from', type: 'timestamptz' },
  { name: 'provenance_id', type: 'bigint' },
];

/**
 * Everything the four modules share: the transaction, the replay store, the knowledge clock, the
 * provenance cache and the running row counts.
 *
 * A class rather than a bag of parameters because the provenance cache and the knowledge clock are
 * both *stateful per run* and both must be shared across the four modules: the S&P 500 module cites
 * the same `wiki.sp500` capture as the classification module, and a second `provenance` row for it
 * would double-count DATA-10's audit trail and break the volume assertions.
 */
class UniverseSeedRun {
  readonly tx: Tx;
  readonly store: ReplayStore;
  readonly clock = new KnowledgeClock();
  readonly repos: MasterRepositories;
  readonly terms: TermsRepository;
  readonly classifications: ClassificationRepository;

  /** `source_id|request_key|sha256|adapter_version` → `provenance_id`, within this run. */
  readonly #provenance = new Map<string, number>();
  #provenanceWritten = 0;

  constructor(readonly ctx: SeedContext) {
    // `SeedContext.db` is a drizzle handle bound to the connection the runner already opened a
    // transaction on (`seed/index.ts`: `client.query('BEGIN')` then `drizzle(client)`), and every
    // callee below uses only the query-builder surface `Db` and `Tx` share — `execute`, `select`,
    // `insert`, `delete`. Calling `db.transaction()` to obtain a real `Tx` would emit a nested
    // `BEGIN` on a connection that is already in a transaction and its `COMMIT` would commit the
    // runner's, destroying the one-transaction-per-module guarantee of DATA_MODEL §18. Same cast
    // and same reason as `ingest/scheduler.ts` L982 and `functions/context.ts` L858.
    this.tx = ctx.db as unknown as Tx;
    this.store = openReplayStore();
    this.repos = new MasterRepositories(this.tx);
    this.terms = new TermsRepository(this.tx);
    this.classifications = new ClassificationRepository(this.tx);
  }

  get provenanceWritten(): number {
    return this.#provenanceWritten;
  }

  log(message: string): void {
    this.ctx.log(message);
  }

  /** The recorded bytes for one of {@link CAPTURES}. Throws `ReplayMissError` on a miss (FEED-08). */
  capture(name: CaptureName): RawRecord {
    const spec = CAPTURES[name];
    const method = 'method' in spec ? spec.method : 'GET';
    // The OpenFIGI mapping is a POST whose body participates in the request key byte for byte
    // (PROVIDERS §3.2), and the body that was recorded is on the manifest entry — re-serialising
    // the job array here would produce a different key and a guaranteed miss.
    const body =
      method === 'POST' ? this.#recordedBody(spec.sourceId, spec.url, method) : undefined;
    return this.store.replay({
      providerId: spec.sourceId,
      method,
      url: spec.url,
      ...(body === undefined ? {} : { body }),
    });
  }

  #recordedBody(sourceId: CaptureSourceId, url: string, method: 'GET' | 'POST'): string {
    const canonical = canonicalUrl(url);
    for (const entry of Object.values(this.store.manifest)) {
      if (entry.providerId !== sourceId || entry.method !== method) continue;
      if (entry.url !== canonical) continue;
      if (entry.body !== undefined) return entry.body;
    }
    throw new Error(
      `seed/universe: manifest.json holds no recorded request body for ${sourceId} ${method} ` +
        `${canonical}; the request key cannot be reproduced without it (PROVIDERS §3.2)`,
    );
  }

  /**
   * The `provenance_id` for one capture, written once per database and once per run.
   *
   * `provenance` is an append-only log with no unique index, so a bare INSERT would add one row per
   * capture per `db:seed` — nine rows a run, each of which some seeded value then points at. The
   * find-first keeps the "second run writes zero rows" acceptance row true and keeps `Ctrl+I` on a
   * cell pointing at one row rather than at whichever of five identical rows was current.
   */
  async provenanceFor(name: CaptureName): Promise<{ provenanceId: number; raw: RawRecord }> {
    const spec = CAPTURES[name];
    const raw = this.capture(name);
    const provenanceId = await this.#findOrInsertProvenance(raw, spec.adapterVersion);
    return { provenanceId, raw };
  }

  /**
   * The `provenance_id` for a curated reference table (module 5's indices, currency pairs and
   * crypto assets).
   *
   * The bytes are the serialised table, so `response_sha256` changes the moment the table changes
   * and the audit trail names the exact list a row came from. `source_id` is `internal.user`, which
   * `licence_registry` defines as "uploads, seed" — DATA-09's registration requirement is met and
   * `assert_source_known` passes. `captured_at` is {@link UNIVERSE_VALID_FROM} rather than a wall
   * clock so the row is byte-identical across runs and machines.
   */
  async curatedProvenance(name: string, payload: unknown): Promise<number> {
    const body = Buffer.from(`${JSON.stringify(payload, null, 0)}\n`, 'utf8');
    const url = `seed://universe/${name}`;
    const raw: RawRecord = {
      providerId: 'internal.user',
      method: 'GET',
      url: canonicalUrl(url),
      requestKey: requestKey('internal.user', 'GET', url),
      requestHash: requestHash('GET', canonicalUrl(url)),
      status: 200,
      headers: { 'content-type': 'application/json' },
      body,
      capturedAt: UNIVERSE_VALID_FROM.getTime(),
      sha256: sha256Hex(body),
      sourceTs: null,
      origin: 'replay',
    };
    return this.#findOrInsertProvenance(raw, 'seed/1.0.0');
  }

  async #findOrInsertProvenance(raw: RawRecord, adapterVersion: string): Promise<number> {
    const key = `${raw.providerId}|${raw.requestKey}|${raw.sha256}|${adapterVersion}`;
    const cached = this.#provenance.get(key);
    if (cached !== undefined) return cached;

    const found = await this.ctx.query(
      `SELECT provenance_id FROM provenance
        WHERE source_id = $1 AND request_key = $2
          AND response_sha256 = decode($3, 'hex') AND adapter_version = $4
        ORDER BY provenance_id
        LIMIT 1`,
      [raw.providerId, raw.requestKey, raw.sha256, adapterVersion],
    );
    const row = found.rows[0] as { provenance_id: string } | undefined;
    if (row !== undefined) {
      const id = Number(row.provenance_id);
      this.#provenance.set(key, id);
      return id;
    }

    const id = await insertProvenance(this.tx, raw, { adapterVersion });
    this.#provenanceWritten += 1;
    this.#provenance.set(key, id);
    return id;
  }

  /**
   * `n` fresh entity ids from `sequence`, in one round trip.
   *
   * Sequences are not transactional and never reused, which is the point (`refdata/master.ts`): two
   * writers creating the same issuer get two ids and one of them loses the `<table>_bt_excl` race on
   * the identifier rather than silently sharing a key. Never assert a literal id anywhere.
   */
  async nextIds(sequence: string, n: number): Promise<number[]> {
    if (n === 0) return [];
    const res = await this.ctx.query(
      `SELECT nextval($1::regclass)::bigint AS id FROM generate_series(1, $2)`,
      [sequence, n],
    );
    return (res.rows as { id: string }[]).map((r) => Number(r.id));
  }

  /**
   * Insert the **first** version of many keys in one chunked multi-row statement.
   *
   * Only legal when no current version of any of these keys exists: then `writeVersion`'s step 1
   * (close the overlapping current versions) and step 2 (re-insert their remainders) find nothing,
   * and its step 3 is exactly this INSERT. The caller establishes the precondition by reading the
   * master first — `mergeUniverse`'s `action === 'create'` is that read's answer — and every write
   * that is *not* a first version goes through `bitemporal.ts` instead. See the module header.
   *
   * `tx_to` is left to its `'infinity'` default; the other four bitemporal columns are appended
   * here so no caller can forget one.
   */
  async bulkInsertVersions(
    table: string,
    columns: readonly BulkColumn[],
    rows: readonly (readonly unknown[])[],
    bt: { validFrom: Date; validTo?: Date; txFrom: Date; provenanceId: number },
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const validFrom = bt.validFrom.toISOString();
    const validTo = bt.validTo === undefined ? 'infinity' : bt.validTo.toISOString();
    const txFrom = bt.txFrom.toISOString();
    const withBt = rows.map((row) => [...row, validFrom, validTo, txFrom, bt.provenanceId]);
    return this.bulkInsert(table, [...columns, ...BT_COLUMNS], withBt);
  }

  /** The same chunked multi-row INSERT for a non-bitemporal table. */
  async bulkInsert(
    table: string,
    columns: readonly BulkColumn[],
    rows: readonly (readonly unknown[])[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const names = columns.map((c) => `"${c.name}"`).join(', ');
    const unnest = columns.map((c, i) => `$${String(i + 1)}::${c.type}[]`).join(', ');
    const alias = columns.map((c) => `"${c.name}"`).join(', ');
    const text = `INSERT INTO ${table} (${names})
      SELECT ${alias} FROM unnest(${unnest}) AS s(${alias})`;

    let written = 0;
    for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
      const chunk = rows.slice(start, start + INSERT_CHUNK);
      const params = columns.map((_, col) => chunk.map((row) => row[col] ?? null));
      await this.ctx.query(text, params);
      written += chunk.length;
    }
    return written;
  }

  /** One `identifiers` row, validated by the same gate `refdata/identifiers.ts` uses. */
  identifierRow(
    entityKind: 'issuer' | 'issue' | 'instrument' | 'listing',
    entityId: number,
    scheme: IdScheme,
    value: string,
    qualifier = '',
    isPrimary = false,
  ): readonly unknown[] | null {
    const check = normaliseIdentifier(scheme, value, qualifier);
    // A rejected value is dropped rather than thrown: the symbol book carries warrant and preferred
    // tickers (`ACEL.WS`, `ABR.PR.A`) whose shape the `TICKER_EXCH` codec accepts and CUSIPs the
    // N-PORT filing writes as `000000000`, and a seed that aborted on the first placeholder would
    // never finish. The caller counts what survived.
    if (!check.ok) return null;
    return [
      entityKind,
      entityId,
      check.key.scheme,
      check.key.value,
      check.key.qualifier,
      isPrimary,
    ];
  }
}

/** Column spec for `identifiers`, matching {@link UniverseSeedRun.identifierRow}'s tuple order. */
const IDENTIFIER_COLUMNS: readonly BulkColumn[] = [
  { name: 'entity_kind', type: 'entity_kind' },
  { name: 'entity_id', type: 'bigint' },
  { name: 'scheme', type: 'id_scheme' },
  { name: 'value', type: 'text' },
  { name: 'qualifier', type: 'text' },
  { name: 'is_primary', type: 'boolean' },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module 2 — calendars and exchanges (DATA_MODEL §18 row 2)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The nine rule calendars, their weekly session templates and their 1990-2040 holidays, plus the 14
 * venues.
 *
 * This is the one module of the whole seed whose source is a **rule** rather than a capture (§18
 * row 2: "`core/calendars` rule generators"), and the three calendar tables and `exchanges` are the
 * only value-bearing tables in the schema with no `provenance_id` column — they carry a `source_id`
 * instead, `'internal.derived'`, which is what `calendars_source_known` checks. So there is no
 * DATA-10 provenance row to write here and nothing is missing.
 *
 * `materialiseCalendar` is already idempotent by primary key and already refuses to delete a holiday
 * the rules did not produce (an ad-hoc closure data ops added by hand has no marker distinguishing
 * it from a rule day). It is called rather than re-implemented so that a calendar read back from the
 * database and a calendar computed from the rule are the same object — the round trip
 * `refdata/calendars.ts#diffCalendars` exists to police.
 */
async function seedCalendarsAndExchanges(run: UniverseSeedRun): Promise<{
  calendars: number;
  calendarSessions: number;
  calendarHolidays: number;
  exchanges: number;
}> {
  let written = 0;
  let sessions = 0;
  let holidays = 0;
  for (const calendar of SEEDED_CALENDARS) {
    // Skipped when the three tables already hold exactly what the rule produces.
    // `materialiseCalendar` upserts with an unconditional `ON CONFLICT DO UPDATE`, so calling it on
    // every run rewrites all 4,386 holiday tuples — and `calendar_holidays_bump` fires on each
    // write, which bumps `config_versions('calendars')` and makes every connected client re-fetch
    // its calendars after a no-op seed. Row counts would not have shown it.
    if (await calendarUpToDate(run, calendar)) continue;
    const result = await materialiseCalendar(run.tx, calendar, {
      fromYear: CALENDAR_SEED_YEARS.from,
      toYear: CALENDAR_SEED_YEARS.to,
      sourceId: CALENDAR_SOURCE_ID,
    });
    written += 1;
    sessions += result.sessions;
    holidays += result.holidays;
  }
  run.log(
    `${String(written)} of ${String(SEEDED_CALENDARS.length)} calendars materialised: ` +
      `${String(sessions)} sessions, ${String(holidays)} holidays ` +
      `${String(CALENDAR_SEED_YEARS.from)}-${String(CALENDAR_SEED_YEARS.to)}`,
  );

  // `DO UPDATE … WHERE` rather than a bare `DO UPDATE`: an unchanged venue must not be rewritten, or
  // every `db:seed` would write 14 new tuples and the idempotency acceptance row would count them.
  let venuesWritten = 0;
  for (const venue of SEEDED_EXCHANGES) {
    // `RETURNING mic` makes the skip visible: an unchanged venue matches the `WHERE` of the
    // `DO UPDATE`, nothing is written, and the statement returns no row.
    const result = await run.ctx.query(
      `INSERT INTO exchanges (mic, operating_mic, name, country, tz, calendar_id,
                              bbg_exch_code, composite_code, cboe_exchange_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (mic) DO UPDATE SET
         operating_mic = excluded.operating_mic, name = excluded.name, country = excluded.country,
         tz = excluded.tz, calendar_id = excluded.calendar_id,
         bbg_exch_code = excluded.bbg_exch_code, composite_code = excluded.composite_code,
         cboe_exchange_id = excluded.cboe_exchange_id
       WHERE (exchanges.operating_mic, exchanges.name, exchanges.country, exchanges.tz,
              exchanges.calendar_id, exchanges.bbg_exch_code, exchanges.composite_code,
              exchanges.cboe_exchange_id)
         IS DISTINCT FROM
             (excluded.operating_mic, excluded.name, excluded.country, excluded.tz,
              excluded.calendar_id, excluded.bbg_exch_code, excluded.composite_code,
              excluded.cboe_exchange_id)
       RETURNING mic`,
      [
        venue.mic,
        venue.operatingMic,
        venue.name,
        venue.country,
        venue.tz,
        venue.calendarId,
        venue.bbgExchCode ?? null,
        venue.compositeCode ?? null,
        venue.cboeExchangeId ?? null,
      ],
    );
    venuesWritten += result.rows.length;
  }

  return {
    calendars: written,
    calendarSessions: sessions,
    calendarHolidays: holidays,
    exchanges: venuesWritten,
  };
}

/**
 * Do `calendars`, `calendar_sessions` and `calendar_holidays` already say exactly what
 * `calendarRows(cal, 1990, 2040)` says?
 *
 * Three `EXCEPT` pairs in one query. The holiday comparison is the one that matters — 4,386 rows
 * across the nine calendars — and it compares `close_time` as text because Postgres reads a `time`
 * back as `HH:MM:SS` while core writes `HH:MM` (`refdata/calendars.ts#toLocalTime` normalises the
 * same difference on the read path).
 *
 * A calendar this returns `false` for is re-materialised in full, which also repairs a partially
 * written one. It deliberately does **not** treat an extra holiday row as a reason to rewrite the
 * rule days: an ad-hoc closure data ops added by hand is an extra row with no marker, and
 * `materialiseCalendar` is explicitly documented never to delete one. So only *missing* or
 * *differing* rule rows count.
 */
async function calendarUpToDate(run: UniverseSeedRun, cal: Calendar): Promise<boolean> {
  const rows = calendarRows(
    cal,
    CALENDAR_SEED_YEARS.from,
    CALENDAR_SEED_YEARS.to,
    CALENDAR_SOURCE_ID,
  );
  const res = await run.ctx.query(
    `WITH header AS (
       SELECT count(*)::int AS n FROM calendars
        WHERE calendar_id = $1 AND name = $2 AND tz = $3 AND kind = $4 AND source_id = $5
     ), want_sessions(weekday, pre_open, open_time, close_time, post_close) AS (
       SELECT * FROM unnest($6::smallint[], $7::text[], $8::text[], $9::text[], $10::text[])
     ), held_sessions AS (
       SELECT weekday, pre_open::text, open_time::text, close_time::text, post_close::text
         FROM calendar_sessions WHERE calendar_id = $1
     ), want_holidays(day, name, kind, close_time) AS (
       SELECT * FROM unnest($11::date[], $12::text[], $13::text[], $14::text[])
     ), held_holidays AS (
       SELECT day, name, kind, close_time::text FROM calendar_holidays WHERE calendar_id = $1
     )
     SELECT (SELECT n FROM header) AS header,
            (SELECT count(*) FROM (
               SELECT weekday, pre_open::text, open_time::text, close_time::text, post_close::text
                 FROM want_sessions
               EXCEPT SELECT * FROM held_sessions) d)::int AS missing_sessions,
            (SELECT count(*) FROM (
               SELECT * FROM held_sessions
               EXCEPT SELECT weekday, pre_open::text, open_time::text, close_time::text,
                             post_close::text FROM want_sessions) d)::int AS extra_sessions,
            (SELECT count(*) FROM (
               SELECT day, name, kind, close_time::text FROM want_holidays
               EXCEPT SELECT * FROM held_holidays) d)::int AS missing_holidays`,
    [
      rows.calendarId,
      rows.name,
      rows.tz,
      rows.kind,
      rows.sourceId,
      rows.sessions.map((session) => session.weekday),
      rows.sessions.map((session) => sqlTime(session.preOpen)),
      rows.sessions.map((session) => sqlTime(session.openTime)),
      rows.sessions.map((session) => sqlTime(session.closeTime)),
      rows.sessions.map((session) => sqlTime(session.postClose)),
      rows.holidays.map((holiday) => holiday.day),
      rows.holidays.map((holiday) => holiday.name),
      rows.holidays.map((holiday) => holiday.kind),
      rows.holidays.map((holiday) => sqlTime(holiday.closeTime ?? null)),
    ],
  );
  const row = res.rows[0] as
    | { header: number; missing_sessions: number; extra_sessions: number; missing_holidays: number }
    | undefined;
  if (row === undefined) return false;
  return (
    row.header === 1 &&
    row.missing_sessions === 0 &&
    row.extra_sessions === 0 &&
    row.missing_holidays === 0
  );
}

/** `'13:00'` → `'13:00:00'`, so a `time` read back as `HH:MM:SS` compares equal as text. */
function sqlTime(value: string | null): string | null {
  if (value === null) return null;
  const parts = value.split(':');
  const hour = parts[0] ?? '00';
  const minute = parts[1] ?? '00';
  const second = parts[2] ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module 3 — the US listed universe (DATA_MODEL §18 row 3)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Cboe quotes endpoint's spelling of a symbol the symbol book spells differently.
 *
 * The book prefixes an index root with `^` (`^SPX`, `^VIX`, `^A1DOW`); the quotes endpoint prefixes
 * it with `_` — `cboe-spx` is the answer to `/quotes/_SPX.json` and its payload carries
 * `data.symbol = "^SPX"` beside a top-level `symbol = "_SPX"`, which is the recorded evidence for
 * the transform and the reason it is not a guess. Everything else is quoted under its own name.
 *
 * `refdata/universe.ts#classifyCboeSymbol` tests `name.startsWith('_')`, which no entry in the
 * recorded book satisfies, so all 1,907 index roots are classified as `'other'`-shaped US equities.
 * This module writes them the way the merge decided anyway: the one-writer rule (WORKPLAN L714-722)
 * requires the seed and `ingest/jobs/universeSymbolBook.ts` to take the *same* decision from the
 * same inputs, and a seed that wrote `SPX`/`INDEX` where the merge says `^SPX`/`US` would leave the
 * job unable to find its own row — it would see a master row the book does not mention, carrying a
 * `cboe.quotes` line, and delist all 1,907 on its first run.
 */
function cboeQuoteSymbol(bookSymbol: string): string {
  return bookSymbol.startsWith('^') ? `_${bookSymbol.slice(1)}` : bookSymbol;
}

/** `_SPX` and `_VIX` belong to module 5's index instruments, which have the recorded quotes. */
const INDEX_OWNED_CBOE_SYMBOLS: ReadonlySet<string> = new Set(
  SEEDED_INDICES.flatMap((index) => (index.cboeSymbol === undefined ? [] : [index.cboeSymbol])),
);

/** OpenFIGI `securityType` for an asset class the Cboe book classified (`refdata/universe.ts`). */
function securityTypeFor(assetClass: AssetClass): string {
  switch (assetClass) {
    case 'etf':
      return 'ETP';
    case 'future':
      return 'Future';
    case 'index':
      return 'Index';
    case 'fx':
      return 'Spot';
    case 'crypto':
      return 'Crypto';
    default:
      return 'Common Stock';
  }
}

interface ListedUniverseCounts {
  issuers: number;
  issues: number;
  instruments: number;
  instrumentsRefreshed: number;
  mdLines: number;
  identifiers: number;
}

async function seedListedUniverse(run: UniverseSeedRun): Promise<ListedUniverseCounts> {
  const counts: ListedUniverseCounts = {
    issuers: 0,
    issues: 0,
    instruments: 0,
    instrumentsRefreshed: 0,
    mdLines: 0,
    identifiers: 0,
  };

  const book = await run.provenanceFor('symbolBook');
  const tickers = await run.provenanceFor('secTickers');
  const normaliseCtx = (raw: RawRecord, provenanceId: number): NormaliseContext => ({
    provenanceId,
    capturedAt: raw.capturedAt,
    lines: new Map(),
  });

  const bookRows = normaliseSymbolBook(book.raw, normaliseCtx(book.raw, book.provenanceId));
  const tickerRows = normaliseTickers(tickers.raw, normaliseCtx(tickers.raw, tickers.provenanceId));

  // PROVIDERS §5.3 / §7.1: a short payload is rejected outright rather than half-seeded. In replay
  // mode this can only mean the committed fixture was truncated, which must fail loudly — a seed
  // that silently wrote 400 instruments instead of 35,618 has not failed, it has lied.
  if (bookRows.rows.summary.belowMinimum) {
    throw new Error(
      `seed/universe: cboe-symbol-book.json holds ${String(bookRows.rows.summary.entryCount)} ` +
        'entries, below the 30,000 floor of PROVIDERS §5.3 — nothing was written',
    );
  }
  if (tickerRows.rows.belowMinimum) {
    throw new Error(
      `seed/universe: sec-company-tickers.json holds ${String(tickerRows.rows.entryCount)} ` +
        'entries, below the 8,000 floor of PROVIDERS §7.1 — nothing was written',
    );
  }

  // `mergeUniverse` is handed the master as it stands, so its `action` per `(ticker, exch_code)` is
  // the precondition of the bulk insert below: `'create'` means no current version of that key
  // exists. On a second run every entry is `'unchanged'` and this module writes nothing at all.
  const at = { validAt: new Date(run.ctx.clock.now()), knownAt: new Date(run.ctx.clock.now()) };
  const master = await loadMasterUniverse(run.tx, at);
  const merged = mergeUniverse({
    master,
    symbolBook: bookRows.rows.entries.map((entry) => ({
      name: entry.name,
      companyName: entry.companyName,
    })),
    secTickers: tickerRows.rows.issuers.flatMap((issuer) =>
      issuer.tickers.map((ticker) => ({ cik: issuer.cik, ticker, title: issuer.name })),
    ),
  });
  run.log(
    `merge: ${String(merged.counts.create)} create, ${String(merged.counts.refresh)} refresh, ` +
      `${String(merged.counts.unchanged)} unchanged, ${String(merged.counts.delist)} delist ` +
      "(the seed never applies a delist — that is the daily job's action)",
  );

  const creates = merged.entries.filter((entry) => entry.action === 'create');
  const refreshes = merged.entries.filter((entry) => entry.action === 'refresh');

  if (creates.length > 0) {
    await createListedEntries(run, creates, book, tickers, counts);
  }

  // A `'refresh'` is a real change to a key that already exists, so it goes through the bitemporal
  // writer: `upsert` closes the current version at the knowledge instant and opens the new one.
  // Only the three fields the merge owns move — name, status and search_weight — and everything else
  // is read back and written unchanged, so this module and `symbologyRefresh` never fight over a
  // column (`ingest/jobs/universeSymbolBook.ts` header).
  for (const entry of refreshes) {
    if (entry.instrumentId === null) continue;
    const current = await run.repos.instruments.get(entry.instrumentId, at);
    if (current === null) continue;
    const written = await run.repos.instruments.upsert(
      entry.instrumentId,
      {
        ...toInstrumentInput(current),
        name: entry.name,
        status: entry.status,
        searchWeight: entry.searchWeight,
      },
      {
        validFrom: UNIVERSE_VALID_FROM,
        provenanceId: book.provenanceId,
        knownAt: run.clock.at(new Date(book.raw.capturedAt)),
        reason: 'change',
      },
    );
    if (written !== null) counts.instrumentsRefreshed += 1;
  }

  return counts;
}

/**
 * Write the first version of every `'create'` entry: its issuer, its issue, the instrument itself,
 * its `cboe.quotes` line and its identifiers.
 *
 * Five bulk statements per 2,000 rows rather than ~700 k round trips — see the module header for why
 * that is the degenerate case of `writeVersion` rather than a shortcut around it.
 */
async function createListedEntries(
  run: UniverseSeedRun,
  creates: readonly UniverseEntry[],
  book: { provenanceId: number; raw: RawRecord },
  tickers: { provenanceId: number; raw: RawRecord },
  counts: ListedUniverseCounts,
): Promise<void> {
  const bookKnownAt = run.clock.at(new Date(book.raw.capturedAt));

  // ── issuers ──────────────────────────────────────────────────────────────────────────────────
  //
  // One issuer per legal entity we can name. A CIK is the strong key and comes from the SEC file; a
  // symbol the SEC does not know is keyed on its Cboe `company_name`, which groups a company's share
  // classes, preferreds and warrants (`ABR.PR.A`…`ABR.PR.E` are all Arbor Realty Trust). Both keys
  // are values from a recorded capture, and neither is derived from the other, so an issuer that
  // later gains a CIK gains it as a correction rather than as a duplicate.
  const existing = await run.ctx.query(
    `SELECT issuer_id, cik, name FROM issuers WHERE tx_to = 'infinity' AND valid_to = 'infinity'`,
  );
  const issuerByKey = new Map<string, number>();
  for (const row of existing.rows as { issuer_id: string; cik: string | null; name: string }[]) {
    const id = Number(row.issuer_id);
    const cik = row.cik?.trim();
    if (cik !== undefined && cik !== '') issuerByKey.set(`cik:${cik}`, id);
    issuerByKey.set(`name:${foldClassificationName(row.name)}`, id);
  }

  const issuerKeyOf = (entry: UniverseEntry): string =>
    entry.cik === null ? `name:${foldClassificationName(entry.name)}` : `cik:${entry.cik}`;

  interface NewIssuer {
    key: string;
    cik: string | null;
    name: string;
    entityType: string;
    /** Which capture named this entity: the SEC ticker file when a CIK keys it, else the book. */
    provenanceId: number;
  }
  const newIssuers: NewIssuer[] = [];
  const seenIssuerKey = new Set<string>();
  for (const entry of creates) {
    const key = issuerKeyOf(entry);
    if (issuerByKey.has(key) || seenIssuerKey.has(key)) continue;
    seenIssuerKey.add(key);
    newIssuers.push({
      key,
      cik: entry.cik,
      name: entry.name,
      // DATA_MODEL §3 `entity_type`: a fund share class is issued by a trust, not by an operating
      // company, and `classifyCboeSymbol` is the only thing on this path that can tell them apart.
      entityType: entry.assetClass === 'etf' ? 'fund' : 'operating',
      provenanceId: entry.cik === null ? book.provenanceId : tickers.provenanceId,
    });
  }

  const issuerIds = await run.nextIds('issuer_id_seq', newIssuers.length);
  // Grouped by provenance because `bulkInsertVersions` writes one `provenance_id` per statement: the
  // two groups cite different captures and merging them would attribute a Cboe-only issuer to the
  // SEC file.
  for (const provenanceId of [tickers.provenanceId, book.provenanceId]) {
    const rows: unknown[][] = [];
    newIssuers.forEach((issuer, i) => {
      if (issuer.provenanceId !== provenanceId) return;
      const id = issuerIds[i];
      if (id === undefined) return;
      issuerByKey.set(issuer.key, id);
      rows.push([id, issuer.name, issuer.cik, issuer.entityType]);
    });
    counts.issuers += await run.bulkInsertVersions(
      'issuers',
      [
        { name: 'issuer_id', type: 'bigint' },
        { name: 'name', type: 'text' },
        { name: 'cik', type: 'text' },
        { name: 'entity_type', type: 'text' },
      ],
      rows,
      { validFrom: UNIVERSE_VALID_FROM, txFrom: bookKnownAt, provenanceId },
    );
  }
  // The ids must be in the map before the issues below are built, which the loop above does for the
  // rows it wrote; an id whose group was empty is still mapped, so assert the invariant rather than
  // silently pointing an issue at issuer 0.
  newIssuers.forEach((issuer, i) => {
    const id = issuerIds[i];
    if (id !== undefined) issuerByKey.set(issuer.key, id);
  });

  // ── issues, instruments, md_lines, identifiers ────────────────────────────────────────────────
  const issueIds = await run.nextIds('issue_id_seq', creates.length);
  const instrumentIds = await run.nextIds('instrument_id_seq', creates.length);

  // Rows are bucketed by the capture that named the entry, because `bulkInsertVersions` stamps one
  // `provenance_id` per statement and DATA-10 is only worth anything if it is precise: a listed
  // company the SEC ticker file names and the Cboe book never mentions must not cite the Cboe book.
  // `providerSymbol === null` is exactly that test — `mergeUniverse` sets it from the book.
  const issueRows = new Map<number, unknown[][]>();
  const instrumentRows = new Map<number, unknown[][]>();
  const identifierRows = new Map<number, (readonly unknown[])[]>();
  const mdLineSymbols: { instrumentId: number; symbol: string }[] = [];
  const push = <T>(into: Map<number, T[]>, provenanceId: number, row: T): void => {
    const bucket = into.get(provenanceId);
    if (bucket === undefined) into.set(provenanceId, [row]);
    else bucket.push(row);
  };

  creates.forEach((entry, i) => {
    const issueId = issueIds[i];
    const instrumentId = instrumentIds[i];
    if (issueId === undefined || instrumentId === undefined) return;
    const issuerId = issuerByKey.get(issuerKeyOf(entry));
    if (issuerId === undefined) {
      throw new Error(
        `seed/universe: no issuer allocated for ${entry.key} (${issuerKeyOf(entry)}) — the issuer ` +
          'pass and the issue pass disagree, which would file the issue under the wrong entity',
      );
    }
    const namedBy = entry.providerSymbol === null ? tickers.provenanceId : book.provenanceId;
    push(issueRows, namedBy, [
      issueId,
      issuerId,
      entry.assetClass,
      securityTypeFor(entry.assetClass),
      entry.name,
      entry.currency,
    ]);
    push(instrumentRows, namedBy, [
      instrumentId,
      issueId,
      entry.assetClass,
      entry.marketSector,
      entry.ticker,
      entry.exchCode,
      entry.name,
      entry.currency,
      entry.status,
      entry.searchWeight,
    ]);

    const tickerId = run.identifierRow(
      'instrument',
      instrumentId,
      'TICKER_EXCH',
      entry.ticker,
      entry.exchCode,
      true,
    );
    if (tickerId !== null) push(identifierRows, namedBy, tickerId);

    if (entry.providerSymbol !== null) {
      const symbol = cboeQuoteSymbol(entry.providerSymbol);
      if (!INDEX_OWNED_CBOE_SYMBOLS.has(symbol)) {
        mdLineSymbols.push({ instrumentId, symbol });
        const symbolId = run.identifierRow(
          'instrument',
          instrumentId,
          'PROVIDER_SYMBOL',
          symbol,
          'cboe.quotes',
        );
        if (symbolId !== null) push(identifierRows, book.provenanceId, symbolId);
      }
    }
  });

  for (const issuer of newIssuers) {
    if (issuer.cik === null) continue;
    const issuerId = issuerByKey.get(issuer.key);
    if (issuerId === undefined) continue;
    // A CIK comes from the SEC ticker file and from nowhere else.
    const row = run.identifierRow('issuer', issuerId, 'CIK', issuer.cik, '', true);
    if (row !== null) push(identifierRows, tickers.provenanceId, row);
  }

  for (const [provenanceId, rows] of issueRows) {
    counts.issues += await run.bulkInsertVersions(
      'issues',
      [
        { name: 'issue_id', type: 'bigint' },
        { name: 'issuer_id', type: 'bigint' },
        { name: 'asset_class', type: 'asset_class' },
        { name: 'security_type', type: 'text' },
        { name: 'name', type: 'text' },
        { name: 'currency', type: 'text' },
      ],
      rows,
      { validFrom: UNIVERSE_VALID_FROM, txFrom: bookKnownAt, provenanceId },
    );
  }

  for (const [provenanceId, rows] of instrumentRows) {
    counts.instruments += await run.bulkInsertVersions(
      'instruments',
      [
        { name: 'instrument_id', type: 'bigint' },
        { name: 'issue_id', type: 'bigint' },
        { name: 'asset_class', type: 'asset_class' },
        { name: 'market_sector', type: 'market_sector' },
        { name: 'ticker', type: 'text' },
        { name: 'exch_code', type: 'text' },
        { name: 'name', type: 'text' },
        { name: 'currency', type: 'text' },
        { name: 'status', type: 'text' },
        { name: 'search_weight', type: 'real' },
      ],
      rows,
      { validFrom: UNIVERSE_VALID_FROM, txFrom: bookKnownAt, provenanceId },
    );
  }

  const mdLineIds = await run.nextIds('md_line_id_seq', mdLineSymbols.length);
  counts.mdLines += await run.bulkInsertVersions(
    'md_lines',
    [
      { name: 'md_line_id', type: 'bigint' },
      { name: 'instrument_id', type: 'bigint' },
      { name: 'source_id', type: 'text' },
      { name: 'provider_symbol', type: 'text' },
      { name: 'line_kind', type: 'text' },
      { name: 'intrinsic_delay_min', type: 'int' },
      { name: 'expected_interval_ms', type: 'int' },
      { name: 'priority', type: 'smallint' },
    ],
    mdLineSymbols.map((line, i) => [
      mdLineIds[i],
      line.instrumentId,
      'cboe.quotes',
      line.symbol,
      'composite',
      CBOE_QUOTES_DELAY_MIN,
      CBOE_QUOTES_INTERVAL_MS,
      CBOE_PRIORITY,
    ]),
    { validFrom: UNIVERSE_VALID_FROM, txFrom: bookKnownAt, provenanceId: book.provenanceId },
  );

  for (const [provenanceId, rows] of identifierRows) {
    counts.identifiers += await run.bulkInsertVersions('identifiers', IDENTIFIER_COLUMNS, rows, {
      validFrom: UNIVERSE_VALID_FROM,
      txFrom: bookKnownAt,
      provenanceId,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module 3b — the AAPL symbology capture (DATA_MODEL §18 row 3, `openfigi-map`)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** OpenFIGI venue code → MIC, for the five codes DATA_MODEL §5 L819 documents. */
const MIC_BY_BBG_CODE: ReadonlyMap<string, string> = new Map(
  SEEDED_EXCHANGES.flatMap((venue) =>
    venue.bbgExchCode === undefined ? [] : [[venue.bbgExchCode, venue.mic] as const],
  ),
);

/**
 * Enrich the one instrument the OpenFIGI capture covers: AAPL's composite FIGI, its share class
 * FIGI on the issue, its twenty venue `listings` and the FIGI / TICKER_EXCH identifiers for each.
 *
 * The capture answers two jobs — `TICKER AAPL exchCode US` and `TICKER AAPL` — and the second
 * returns 275 records: 20 composite lines (one per country where the share class trades) and 255
 * venue lines beneath them. Only the `US` composite is enriched here. The other 97 composites are
 * real (`APC GR` is Apple on Xetra) and are deliberately **not** created: §18 budgets no non-US
 * listed equity instruments, no `md_lines` source in this system quotes them, and 78 of the 98 are
 * named only by their venue lines, so `instruments.exch_code` would have to take a venue code —
 * which `providers/openfigi/parse.ts` warns is "filing a Nasdaq listing as a country line".
 *
 * `listings.is_primary` stays false and `instruments.primary_listing_id` stays unset: OpenFIGI
 * returns the twenty venues as equals and nothing in this capture says which one is AAPL's primary
 * market. The composite listing module 4 writes for every S&P constituent is the primary one, and
 * that is a fact about the *composite* level, not a guess about a venue.
 */
async function seedAaplSymbology(
  run: UniverseSeedRun,
  counts: ListedUniverseCounts,
): Promise<{ listings: number }> {
  const figi = await run.provenanceFor('openFigiMapping');
  const body = run.capture('openFigiMapping');
  const parsed = normaliseOpenFigiMapping(
    figi.raw,
    { provenanceId: figi.provenanceId, capturedAt: figi.raw.capturedAt, lines: new Map() },
    parseOpenFigiJobs(body.body.toString('utf8')) ?? null,
  );

  const composite = parsed.rows.composites.find(
    (row) => row.ticker === 'AAPL' && row.compositeExchCode === 'US',
  );
  if (composite === undefined) {
    throw new Error(
      'seed/universe: openfigi-map holds no AAPL composite with exchCode US — the capture changed ' +
        'shape and the symbology enrichment cannot be attributed to an instrument',
    );
  }

  const at = { validAt: new Date(run.ctx.clock.now()), knownAt: new Date(run.ctx.clock.now()) };
  const found = await run.ctx.query(
    `SELECT instrument_id FROM instruments
      WHERE tx_to = 'infinity' AND valid_to = 'infinity'
        AND upper(ticker) = 'AAPL' AND exch_code = 'US'
      ORDER BY instrument_id
      LIMIT 1`,
  );
  const row = found.rows[0] as { instrument_id: string } | undefined;
  if (row === undefined) {
    // Not a silent skip: AAPL is in the symbol book and in the SEC ticker file, so its absence means
    // the universe pass did not run or did not write, and everything downstream of it is wrong.
    throw new Error('seed/universe: AAPL US is not in the master after the universe pass');
  }
  const instrumentId = Number(row.instrument_id);
  const knownAt = run.clock.at(new Date(figi.raw.capturedAt));
  const options = {
    validFrom: UNIVERSE_VALID_FROM,
    provenanceId: figi.provenanceId,
    knownAt,
    reason: 'change' as const,
  };

  const instrument = await run.repos.instruments.get(instrumentId, at);
  if (instrument === null) throw new Error('seed/universe: AAPL US vanished between two reads');
  if (
    await run.repos.instruments.upsert(
      instrumentId,
      { ...toInstrumentInput(instrument), compositeFigi: composite.compositeFigi },
      options,
    )
  ) {
    counts.instruments += 1;
  }

  const issue = await run.repos.issues.get(instrument.issueId, at);
  if (issue !== null && composite.shareClassFigi !== null) {
    const written = await run.repos.issues.upsert(
      instrument.issueId,
      {
        issuerId: issue.issuerId,
        assetClass: issue.assetClass,
        securityType: composite.securityType,
        name: issue.name,
        currency: issue.currency,
        shareClassFigi: composite.shareClassFigi,
        ...(composite.securityType2 === null ? {} : { securityType2: composite.securityType2 }),
      },
      options,
    );
    if (written !== null) counts.issues += 1;
  }

  // The venue listings of the US composite. A second run finds them already there, which is what the
  // `existing` read below establishes — `listings` has no natural key, so the FIGI is the key here.
  const venues = parsed.rows.listings.filter(
    (listing) => listing.compositeFigi === composite.compositeFigi,
  );
  const held = await run.ctx.query(
    `SELECT figi FROM listings WHERE tx_to = 'infinity' AND instrument_id = $1 AND figi IS NOT NULL`,
    [instrumentId],
  );
  const heldFigis = new Set((held.rows as { figi: string }[]).map((r) => r.figi.trim()));
  const toWrite = venues.filter((listing) => !heldFigis.has(listing.figi));

  const listingIds = await run.nextIds('listing_id_seq', toWrite.length);
  const identifierRows: (readonly unknown[])[] = [];
  const listingRows = toWrite.map((listing, i) => {
    const listingId = listingIds[i];
    if (listingId !== undefined) {
      const figiRow = run.identifierRow('listing', listingId, 'FIGI', listing.figi, '', true);
      if (figiRow !== null) identifierRows.push(figiRow);
      const tickerRow = run.identifierRow(
        'listing',
        listingId,
        'TICKER_EXCH',
        listing.localTicker,
        listing.exchCode,
      );
      if (tickerRow !== null) identifierRows.push(tickerRow);
    }
    return [
      listingId,
      instrumentId,
      listing.figi,
      MIC_BY_BBG_CODE.get(listing.exchCode) ?? null,
      listing.exchCode,
      listing.localTicker,
      false,
      'active',
    ];
  });

  const written = await run.bulkInsertVersions(
    'listings',
    [
      { name: 'listing_id', type: 'bigint' },
      { name: 'instrument_id', type: 'bigint' },
      { name: 'figi', type: 'text' },
      { name: 'mic', type: 'text' },
      { name: 'exch_code', type: 'text' },
      { name: 'local_ticker', type: 'text' },
      { name: 'is_primary', type: 'boolean' },
      { name: 'listing_status', type: 'text' },
    ],
    listingRows,
    { validFrom: UNIVERSE_VALID_FROM, txFrom: knownAt, provenanceId: figi.provenanceId },
  );

  counts.identifiers += await run.bulkInsertVersions(
    'identifiers',
    IDENTIFIER_COLUMNS,
    identifierRows,
    { validFrom: UNIVERSE_VALID_FROM, txFrom: knownAt, provenanceId: figi.provenanceId },
  );

  return { listings: written };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module 5 — indices, FX and crypto (DATA_MODEL §18 row 5)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `instruments.search_weight` for a seeded index, currency pair or crypto asset.
 *
 * DATA_MODEL L449 fixes the direction ("index members > 1; Cboe-only symbols < 1") and
 * `refdata/universe.ts#SEARCH_WEIGHT` fixes the members' value at 2.0. An index, a G10 pair and BTC
 * are what a user types most and they must outrank their own constituents, so they sit above that at
 * 3.0. The merge never lowers a weight it did not raise (`searchWeightFor`'s `current` argument), so
 * this survives every run of `universeSymbolBook` — which is the whole reason that argument exists.
 */
const REFERENCE_SEARCH_WEIGHT = 3;

/** One `md_lines` row module 5 wants, with the capture that justifies it. */
interface ReferenceLine {
  instrumentId: number;
  sourceId: string;
  providerSymbol: string;
  intrinsicDelayMin: number;
  expectedIntervalMs: number;
  priority: number;
  /** The capture whose bytes are the evidence this symbol is quoted; `null` = the curated table. */
  capture: CaptureName | null;
}

/** One instrument module 5 wants, whatever family it comes from. */
interface ReferenceInstrumentSpec {
  readonly ticker: string;
  readonly exchCode: string;
  readonly name: string;
  readonly currency: string;
  readonly assetClass: AssetClass;
  readonly marketSector: MarketSector;
  readonly issuerId: number;
  readonly priceDecimals: number;
}

interface ReferenceCounts {
  issuers: number;
  issues: number;
  instruments: number;
  mdLines: number;
  identifiers: number;
  indexTerms: number;
  fxTerms: number;
}

/**
 * Look up an issuer by **exact** name, inserting it when absent.
 *
 * Exact, not folded, and not a `LIKE`. The first draft of this matched
 * `lower(regexp_replace(name, '[^a-zA-Z0-9]+', ' '))` against `foldClassificationName(name)` in the
 * hope of reusing a Cboe-derived row for the same company, and the two normalisers disagree on `&`:
 * the JS fold writes `s and p dow jones indices`, the SQL one writes `s p dow jones indices`, so
 * "S&P Dow Jones Indices" was never found and a second `db:seed` inserted it again. A loose match is
 * also the wrong tool here — it would happily attach the SPX issue to whichever listed company
 * happens to contain the provider's name.
 *
 * The consequence is deliberate: `'Nasdaq'` the index provider and `'Nasdaq Inc'` the listed company
 * become two `issuers` rows. They are the same entity in the world, and nothing on disk says so —
 * no capture links an index provider to its own CIK — so the seed declines to infer it. A later
 * symbology pass with a LEI or a CIK for both can merge them as a correction.
 */
async function ensureIssuer(
  run: UniverseSeedRun,
  issuer: { name: string; entityType: 'operating' | 'fund' | 'index_provider' | 'other' },
  options: { provenanceId: number; knownAt: Date },
): Promise<{ issuerId: number; created: boolean }> {
  const found = await run.ctx.query(
    `SELECT issuer_id FROM issuers
      WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND name = $1 AND entity_type = $2
      ORDER BY issuer_id
      LIMIT 1`,
    [issuer.name, issuer.entityType],
  );
  const row = found.rows[0] as { issuer_id: string } | undefined;
  if (row !== undefined) return { issuerId: Number(row.issuer_id), created: false };

  const issuerId = await run.repos.issuers.insert(
    { name: issuer.name, entityType: issuer.entityType },
    {
      validFrom: UNIVERSE_VALID_FROM,
      provenanceId: options.provenanceId,
      knownAt: options.knownAt,
      reason: 'initial',
    },
  );
  return { issuerId, created: true };
}

async function seedReferenceInstruments(run: UniverseSeedRun): Promise<ReferenceCounts> {
  const counts: ReferenceCounts = {
    issuers: 0,
    issues: 0,
    instruments: 0,
    mdLines: 0,
    identifiers: 0,
    indexTerms: 0,
    fxTerms: 0,
  };

  const curated = await run.curatedProvenance('reference', {
    indices: SEEDED_INDICES,
    fx: SEEDED_FX,
    crypto: SEEDED_CRYPTO,
  });
  const knownAt = run.clock.at(UNIVERSE_VALID_FROM);

  // ── issuers ──────────────────────────────────────────────────────────────────────────────────
  //
  // An index has a real issuing entity — the index provider — and the curated table names it. A
  // currency pair and a crypto token do not: nobody issues EURUSD. `issues.issuer_id` is NOT NULL,
  // so each of those two families gets ONE plainly-labelled non-entity rather than nine and four
  // invented companies, and `entity_type` is `'other'` so nothing downstream mistakes it for a filer.
  const issuerIdByProvider = new Map<string, number>();
  for (const provider of [...new Set(SEEDED_INDICES.map((index) => index.provider))].sort()) {
    const result = await ensureIssuer(
      run,
      { name: provider, entityType: 'index_provider' },
      { provenanceId: curated, knownAt },
    );
    issuerIdByProvider.set(provider, result.issuerId);
    if (result.created) counts.issuers += 1;
  }
  const fxIssuer = await ensureIssuer(
    run,
    { name: 'Foreign exchange spot (no issuing entity)', entityType: 'other' },
    { provenanceId: curated, knownAt },
  );
  if (fxIssuer.created) counts.issuers += 1;
  const cryptoIssuer = await ensureIssuer(
    run,
    { name: 'Digital assets (no issuing entity)', entityType: 'other' },
    { provenanceId: curated, knownAt },
  );
  if (cryptoIssuer.created) counts.issuers += 1;

  // ── which of the 44 instruments already exist ──────────────────────────────────────────────────
  const wanted: ReferenceInstrumentSpec[] = [
    ...SEEDED_INDICES.map((index): ReferenceInstrumentSpec => ({
      ticker: index.code,
      exchCode: 'INDEX',
      name: index.name,
      currency: index.currency,
      assetClass: 'index',
      marketSector: 'Index',
      issuerId: issuerIdByProvider.get(index.provider) ?? 0,
      priceDecimals: 2,
    })),
    ...SEEDED_FX.map((pair): ReferenceInstrumentSpec => ({
      ticker: pair.pair,
      exchCode: 'FX',
      name: pair.name,
      currency: pair.quote,
      assetClass: 'fx',
      marketSector: 'Curncy',
      issuerId: fxIssuer.issuerId,
      // PROVIDERS §5.5: a G10 pair quotes to four decimals, a JPY cross to two. `pip_size` on
      // `fx_terms` carries the same fact for the analytics; this one is the display hint.
      priceDecimals: pair.quote === 'JPY' ? 2 : 4,
    })),
    ...SEEDED_CRYPTO.map((asset): ReferenceInstrumentSpec => ({
      ticker: asset.ticker,
      exchCode: 'CRYPTO',
      name: asset.name,
      currency: 'USD',
      assetClass: 'crypto',
      marketSector: 'Crypto',
      issuerId: cryptoIssuer.issuerId,
      priceDecimals: 2,
    })),
  ];

  const existing = await run.ctx.query(
    `SELECT instrument_id, upper(ticker) AS ticker, exch_code
       FROM instruments
      WHERE tx_to = 'infinity' AND valid_to = 'infinity'
        AND exch_code = ANY($1::text[])`,
    [['INDEX', 'FX', 'CRYPTO']],
  );
  const instrumentIdByKey = new Map<string, number>();
  for (const row of existing.rows as {
    instrument_id: string;
    ticker: string;
    exch_code: string;
  }[]) {
    instrumentIdByKey.set(`${row.ticker}|${row.exch_code}`, Number(row.instrument_id));
  }

  const missing = wanted.filter(
    (spec) => !instrumentIdByKey.has(`${spec.ticker.toUpperCase()}|${spec.exchCode}`),
  );
  const issueIds = await run.nextIds('issue_id_seq', missing.length);
  const instrumentIds = await run.nextIds('instrument_id_seq', missing.length);
  const issueRows: unknown[][] = [];
  const instrumentRows: unknown[][] = [];
  const identifierRows: (readonly unknown[])[] = [];

  missing.forEach((spec, i) => {
    const issueId = issueIds[i];
    const instrumentId = instrumentIds[i];
    if (issueId === undefined || instrumentId === undefined) return;
    instrumentIdByKey.set(`${spec.ticker.toUpperCase()}|${spec.exchCode}`, instrumentId);
    issueRows.push([
      issueId,
      spec.issuerId,
      spec.assetClass,
      securityTypeFor(spec.assetClass),
      spec.name,
      spec.currency,
    ]);
    instrumentRows.push([
      instrumentId,
      issueId,
      spec.assetClass,
      spec.marketSector,
      spec.ticker,
      spec.exchCode,
      spec.name,
      spec.currency,
      'active',
      REFERENCE_SEARCH_WEIGHT,
      spec.priceDecimals,
    ]);
    const row = run.identifierRow(
      'instrument',
      instrumentId,
      'TICKER_EXCH',
      spec.ticker,
      spec.exchCode,
      true,
    );
    if (row !== null) identifierRows.push(row);
  });

  counts.issues += await run.bulkInsertVersions(
    'issues',
    [
      { name: 'issue_id', type: 'bigint' },
      { name: 'issuer_id', type: 'bigint' },
      { name: 'asset_class', type: 'asset_class' },
      { name: 'security_type', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'currency', type: 'text' },
    ],
    issueRows,
    { validFrom: UNIVERSE_VALID_FROM, txFrom: knownAt, provenanceId: curated },
  );
  counts.instruments += await run.bulkInsertVersions(
    'instruments',
    [
      { name: 'instrument_id', type: 'bigint' },
      { name: 'issue_id', type: 'bigint' },
      { name: 'asset_class', type: 'asset_class' },
      { name: 'market_sector', type: 'market_sector' },
      { name: 'ticker', type: 'text' },
      { name: 'exch_code', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'currency', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'search_weight', type: 'real' },
      { name: 'price_decimals', type: 'smallint' },
    ],
    instrumentRows,
    { validFrom: UNIVERSE_VALID_FROM, txFrom: knownAt, provenanceId: curated },
  );
  counts.identifiers += await run.bulkInsertVersions(
    'identifiers',
    IDENTIFIER_COLUMNS,
    identifierRows,
    { validFrom: UNIVERSE_VALID_FROM, txFrom: knownAt, provenanceId: curated },
  );

  const idOf = (ticker: string, exchCode: string): number => {
    const id = instrumentIdByKey.get(`${ticker.toUpperCase()}|${exchCode}`);
    if (id === undefined) {
      throw new Error(
        `seed/universe: no instrument for ${ticker} ${exchCode} after the reference pass`,
      );
    }
    return id;
  };

  // ── market-data lines ─────────────────────────────────────────────────────────────────────────
  const lines: ReferenceLine[] = [];
  for (const index of SEEDED_INDICES) {
    const instrumentId = idOf(index.code, 'INDEX');
    if (index.yahooSymbol !== undefined) {
      lines.push({
        instrumentId,
        sourceId: 'yahoo.chart',
        providerSymbol: index.yahooSymbol,
        intrinsicDelayMin: YAHOO_DELAY_MIN,
        expectedIntervalMs: YAHOO_INTERVAL_MS,
        priority: YAHOO_PRIORITY,
        capture:
          index.yahooSymbol === '^GSPC'
            ? 'yahooSpx'
            : index.yahooSymbol === '^FTSE'
              ? 'yahooFtse'
              : null,
      });
    }
    if (index.cboeSymbol !== undefined) {
      lines.push({
        instrumentId,
        sourceId: 'cboe.quotes',
        providerSymbol: index.cboeSymbol,
        intrinsicDelayMin: CBOE_QUOTES_DELAY_MIN,
        expectedIntervalMs: CBOE_QUOTES_INTERVAL_MS,
        priority: CBOE_PRIORITY,
        capture: index.cboeSymbol === '_SPX' ? 'cboeSpx' : 'cboeVix',
      });
    }
    if (index.cboeEuSymbol !== undefined) {
      lines.push({
        instrumentId,
        sourceId: 'cboe.euIndices',
        providerSymbol: index.cboeEuSymbol,
        intrinsicDelayMin: CBOE_QUOTES_DELAY_MIN,
        expectedIntervalMs: CBOE_QUOTES_INTERVAL_MS,
        priority: CBOE_PRIORITY,
        capture: 'cboeEuIndices',
      });
    }
  }
  for (const pair of SEEDED_FX) {
    lines.push({
      instrumentId: idOf(pair.pair, 'FX'),
      sourceId: 'yahoo.chart',
      providerSymbol: `${pair.pair}=X`,
      intrinsicDelayMin: YAHOO_DELAY_MIN,
      expectedIntervalMs: YAHOO_INTERVAL_MS,
      priority: YAHOO_PRIORITY,
      capture: pair.pair === 'EURUSD' ? 'yahooFx' : null,
    });
  }
  for (const asset of SEEDED_CRYPTO) {
    lines.push({
      instrumentId: idOf(asset.ticker, 'CRYPTO'),
      sourceId: 'coingecko.simple',
      providerSymbol: asset.coingeckoId,
      intrinsicDelayMin: COINGECKO_DELAY_MIN,
      expectedIntervalMs: COINGECKO_INTERVAL_MS,
      priority: COINGECKO_PRIORITY,
      capture:
        asset.coingeckoId === 'bitcoin' || asset.coingeckoId === 'ethereum' ? 'coingecko' : null,
    });
  }

  const written = await writeReferenceLines(run, lines, curated, knownAt);
  counts.mdLines += written.mdLines;
  counts.identifiers += written.identifiers;

  // ── index_terms and fx_terms ──────────────────────────────────────────────────────────────────
  //
  // Written here rather than with the `indices` rows of §18 row 4 because they are *terms of the
  // instrument*, keyed on the instrument this pass just created, and `TermsRepository.upsert`
  // no-ops on a repeated run. `proxy_fund_instrument_id` points at SPY, which the listed-universe
  // pass created from the symbol book — the one cross-module reference in this direction.
  const spy = await run.ctx.query(
    `SELECT instrument_id FROM instruments
      WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND upper(ticker) = 'SPY' AND exch_code = 'US'
      ORDER BY instrument_id LIMIT 1`,
  );
  const spyRow = spy.rows[0] as { instrument_id: string } | undefined;
  const spyInstrumentId = spyRow === undefined ? null : Number(spyRow.instrument_id);

  for (const index of SEEDED_INDICES) {
    const instrumentId = idOf(index.code, 'INDEX');
    const versionId = await run.terms.upsert('index', {
      instrumentId,
      data: {
        provider: index.provider,
        methodology: index.methodology,
        calcCurrency: index.currency,
        region: index.region,
        baseDate: null,
        baseValue: null,
        constituentCount: null,
        proxyFundInstrumentId: index.code === 'SPX' ? spyInstrumentId : null,
      },
      validFrom: UNIVERSE_VALID_FROM,
      provenanceId: curated,
      reason: 'initial',
      txFrom: knownAt,
    });
    if (versionId !== null) counts.indexTerms += 1;
  }

  for (const pair of SEEDED_FX) {
    const versionId = await run.terms.upsert('fx', {
      instrumentId: idOf(pair.pair, 'FX'),
      data: {
        baseCcy: pair.base,
        quoteCcy: pair.quote,
        spotLag: pair.spotLag,
        calendarId: 'FX_USD',
        pipSize: pair.pipSize,
        quoteConvention: 'quote_per_base',
      },
      validFrom: UNIVERSE_VALID_FROM,
      provenanceId: curated,
      reason: 'initial',
      txFrom: knownAt,
    });
    if (versionId !== null) counts.fxTerms += 1;
  }

  return counts;
}

/**
 * Write the reference `md_lines` and their `PROVIDER_SYMBOL` identifiers, grouped by the capture
 * that justifies each line.
 *
 * Grouped because `bulkInsertVersions` stamps one `provenance_id` per statement and the whole point
 * of DATA-10 here is that `^GSPC`'s line cites the `^GSPC` capture rather than "the seed": a line
 * whose symbol was recorded being answered is a different quality of claim from one taken from the
 * curated table, and `Ctrl+I` must be able to tell them apart.
 *
 * `md_lines_symbol_excl` makes `(source_id, provider_symbol)` unique among current versions, so a
 * symbol already carried by a line — `_SPX` is the case, if a partial run wrote it — is skipped
 * rather than inserted a second time and aborted with 23P01.
 */
async function writeReferenceLines(
  run: UniverseSeedRun,
  lines: readonly ReferenceLine[],
  curatedProvenanceId: number,
  curatedKnownAt: Date,
): Promise<{ mdLines: number; identifiers: number }> {
  const held = await run.ctx.query(
    `SELECT source_id, provider_symbol FROM md_lines
      WHERE tx_to = 'infinity' AND valid_to = 'infinity'
        AND (source_id, provider_symbol) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [lines.map((line) => line.sourceId), lines.map((line) => line.providerSymbol)],
  );
  const heldKeys = new Set(
    (held.rows as { source_id: string; provider_symbol: string }[]).map(
      (row) => `${row.source_id}|${row.provider_symbol}`,
    ),
  );

  const byCapture = new Map<CaptureName | null, ReferenceLine[]>();
  for (const line of lines) {
    if (heldKeys.has(`${line.sourceId}|${line.providerSymbol}`)) continue;
    const bucket = byCapture.get(line.capture);
    if (bucket === undefined) byCapture.set(line.capture, [line]);
    else bucket.push(line);
  }

  let mdLines = 0;
  let identifiers = 0;
  for (const [capture, bucket] of byCapture) {
    const provenanceId =
      capture === null ? curatedProvenanceId : (await run.provenanceFor(capture)).provenanceId;
    const knownAt =
      capture === null ? curatedKnownAt : run.clock.at(new Date(run.capture(capture).capturedAt));
    const ids = await run.nextIds('md_line_id_seq', bucket.length);
    mdLines += await run.bulkInsertVersions(
      'md_lines',
      [
        { name: 'md_line_id', type: 'bigint' },
        { name: 'instrument_id', type: 'bigint' },
        { name: 'source_id', type: 'text' },
        { name: 'provider_symbol', type: 'text' },
        { name: 'line_kind', type: 'text' },
        { name: 'intrinsic_delay_min', type: 'int' },
        { name: 'expected_interval_ms', type: 'int' },
        { name: 'priority', type: 'smallint' },
      ],
      bucket.map((line, i) => [
        ids[i],
        line.instrumentId,
        line.sourceId,
        line.providerSymbol,
        'composite',
        line.intrinsicDelayMin,
        line.expectedIntervalMs,
        line.priority,
      ]),
      { validFrom: UNIVERSE_VALID_FROM, txFrom: knownAt, provenanceId },
    );

    const identifierRows = bucket.flatMap((line) => {
      const row = run.identifierRow(
        'instrument',
        line.instrumentId,
        'PROVIDER_SYMBOL',
        line.providerSymbol,
        line.sourceId,
      );
      return row === null ? [] : [row];
    });
    identifiers += await run.bulkInsertVersions('identifiers', IDENTIFIER_COLUMNS, identifierRows, {
      validFrom: UNIVERSE_VALID_FROM,
      txFrom: knownAt,
      provenanceId,
    });
  }

  return { mdLines, identifiers };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module 4 — the S&P 500 (DATA_MODEL §18 row 4)
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Sp500Counts {
  listings: number;
  instrumentsRefreshed: number;
  mdLines: number;
  identifiers: number;
  indices: number;
  indexMembers: number;
  etfHoldings: number;
  entityClassifications: number;
  classificationCodes: number;
  fundTerms: number;
  entityRelations: number;
}

/** SPY's N-PORT filer CIK, from `sec-nport-SPY-primary_doc.xml`'s own `regCik`. */
const SPY_NPORT_CIK = '0000884394';

/**
 * Is the GICS tree already exactly what `refdata/classifications.ts` would write?
 *
 * `upsertCodes` is an unconditional `ON CONFLICT DO UPDATE`, so calling it on every run writes 232
 * new tuples whether or not anything changed — invisible in a row count and visible in bloat, in the
 * `classification_codes` write-ahead log and in any future trigger on that table. This check is one
 * query and makes the second run genuinely write-free without touching WP-04's file.
 */
async function gicsTaxonomyMatches(run: UniverseSeedRun): Promise<boolean> {
  // `gicsCodes()` is the taxonomy `upsertGicsTaxonomy` writes; re-listing its 232 nodes here would
  // be a second source of truth and the two would drift on the first GICS revision.
  const desired = gicsCodes();
  const res = await run.ctx.query(
    `WITH want(code, name, parent_code, level) AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::smallint[])
     ), held AS (
       SELECT code, name, parent_code, level FROM classification_codes WHERE scheme = 'GICS'
     )
     SELECT (SELECT count(*) FROM (SELECT * FROM want EXCEPT SELECT * FROM held) d)::int AS missing,
            (SELECT count(*) FROM (SELECT * FROM held EXCEPT SELECT * FROM want) d)::int AS extra`,
    [
      desired.map((row) => row.code),
      desired.map((row) => row.name),
      desired.map((row) => row.parentCode),
      desired.map((row) => row.level),
    ],
  );
  const row = res.rows[0] as { missing: number; extra: number } | undefined;
  if (row === undefined) return false;
  return row.missing === 0 && row.extra === 0;
}

async function seedSp500(run: UniverseSeedRun): Promise<Sp500Counts> {
  const counts: Sp500Counts = {
    listings: 0,
    instrumentsRefreshed: 0,
    mdLines: 0,
    identifiers: 0,
    indices: 0,
    indexMembers: 0,
    etfHoldings: 0,
    entityClassifications: 0,
    classificationCodes: 0,
    fundTerms: 0,
    entityRelations: 0,
  };

  const wiki = await run.provenanceFor('wiki');
  const nport = await run.provenanceFor('nport');
  const ssga = await run.provenanceFor('ssga');

  const wikiParse = parseWikiSp500(wiki.raw.body.toString('utf8'));
  if (wikiParse.rows.length === 0) {
    throw new Error('seed/universe: wiki-sp500.html yielded no constituents — nothing was written');
  }
  const nportRows = normaliseNport(nport.raw, {
    provenanceId: nport.provenanceId,
    capturedAt: nport.raw.capturedAt,
    lines: new Map(),
  });
  const ssgaRows = normaliseSsgaHoldings(ssga.raw, {
    provenanceId: ssga.provenanceId,
    capturedAt: ssga.raw.capturedAt,
    lines: new Map(),
  });

  const at = { validAt: new Date(run.ctx.clock.now()), knownAt: new Date(run.ctx.clock.now()) };

  // ── the GICS taxonomy ─────────────────────────────────────────────────────────────────────────
  if (!(await gicsTaxonomyMatches(run))) {
    counts.classificationCodes += await upsertGicsTaxonomy(run.tx);
  }

  // ── resolve the 503 constituents ──────────────────────────────────────────────────────────────
  //
  // The Wikipedia list is the constituent roster: it is the only capture that carries a *ticker* for
  // every name, and the ticker is what joins to the universe the symbol book wrote. N-PORT carries
  // CUSIP/ISIN/LEI and no ticker; SSGA carries ticker, CUSIP and SEDOL. So the join order is
  // wiki → universe by ticker, and N-PORT → SSGA by CUSIP and then by folded name, which is a
  // same-fund, adjacent-date match rather than a fuzzy one.
  const tickers = wikiParse.rows.map((row) => row.symbol.trim().toUpperCase());
  const resolved = await run.ctx.query(
    `SELECT instrument_id, upper(ticker) AS ticker, issue_id
       FROM instruments
      WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND exch_code = 'US'
        AND upper(ticker) = ANY($1::text[])`,
    [tickers],
  );
  const instrumentByTicker = new Map<string, { instrumentId: number; issueId: number }>();
  for (const row of resolved.rows as {
    instrument_id: string;
    ticker: string;
    issue_id: string;
  }[]) {
    if (!instrumentByTicker.has(row.ticker)) {
      instrumentByTicker.set(row.ticker, {
        instrumentId: Number(row.instrument_id),
        issueId: Number(row.issue_id),
      });
    }
  }
  const unresolvedTickers = tickers.filter((ticker) => !instrumentByTicker.has(ticker));
  if (unresolvedTickers.length > 0) {
    run.log(
      `${String(unresolvedTickers.length)} S&P 500 tickers are not in the master ` +
        `(${unresolvedTickers.slice(0, 8).join(', ')}) — their memberships are skipped`,
    );
  }

  const issuerCiks = wikiParse.rows
    .map((row) => row.cik)
    .filter((cik): cik is string => cik !== null);
  const issuerRows = await run.ctx.query(
    `SELECT issuer_id, cik FROM issuers
      WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND cik = ANY($1::text[])`,
    [issuerCiks],
  );
  const issuerByCik = new Map<string, number>();
  for (const row of issuerRows.rows as { issuer_id: string; cik: string }[]) {
    const cik = row.cik.trim();
    if (!issuerByCik.has(cik)) issuerByCik.set(cik, Number(row.issuer_id));
  }

  // SPY is looked up on its own rather than through `instrumentByTicker`: the fund is not a member of
  // the index it tracks, so it is not in the Wikipedia roster the map above was built from.
  const spyFound = await run.ctx.query(
    `SELECT instrument_id, issue_id FROM instruments
      WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND upper(ticker) = 'SPY' AND exch_code = 'US'
      ORDER BY instrument_id LIMIT 1`,
  );
  const spyRow = spyFound.rows[0] as { instrument_id: string; issue_id: string } | undefined;
  if (spyRow === undefined) {
    throw new Error(
      'seed/universe: SPY is not in the master — the S&P 500 pass has no fund to hang holdings, ' +
        'fund terms or the SPX proxy on',
    );
  }
  const spy = { instrumentId: Number(spyRow.instrument_id), issueId: Number(spyRow.issue_id) };
  const spxFound = await run.ctx.query(
    `SELECT instrument_id FROM instruments
      WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND ticker = 'SPX' AND exch_code = 'INDEX'
      ORDER BY instrument_id LIMIT 1`,
  );
  const spxRow = spxFound.rows[0] as { instrument_id: string } | undefined;
  if (spxRow === undefined) {
    throw new Error('seed/universe: the SPX index instrument is missing — module 5 must run first');
  }
  const spxInstrumentId = Number(spxRow.instrument_id);

  // ── composite listings, the Yahoo line and the member search weight ───────────────────────────
  //
  // One composite listing per constituent (§18 row 4's "one composite listing per S&P name"):
  // `exch_code = 'US'`, no MIC. The MIC is deliberately absent — nothing captured here names each
  // constituent's primary venue (OpenFIGI was recorded for AAPL only), and a guessed `XNYS` would
  // put a Nasdaq name on the wrong calendar. `is_primary` is true because the composite line is the
  // only listing these instruments have, which is a fact about this seed, not a claim about a venue.
  const wikiKnownAt = run.clock.at(new Date(wiki.raw.capturedAt));
  const constituents = wikiParse.rows.flatMap((row) => {
    const ticker = row.symbol.trim().toUpperCase();
    const master = instrumentByTicker.get(ticker);
    return master === undefined ? [] : [{ row, ticker, ...master }];
  });

  const heldListings = await run.ctx.query(
    `SELECT instrument_id FROM listings
      WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND figi IS NULL AND exch_code = 'US'
        AND instrument_id = ANY($1::bigint[])`,
    [constituents.map((c) => c.instrumentId)],
  );
  const hasComposite = new Set(
    (heldListings.rows as { instrument_id: string }[]).map((row) => Number(row.instrument_id)),
  );
  const needListing = constituents.filter((c) => !hasComposite.has(c.instrumentId));
  const listingIds = await run.nextIds('listing_id_seq', needListing.length);
  const listingIdByInstrument = new Map<number, number>();
  counts.listings += await run.bulkInsertVersions(
    'listings',
    [
      { name: 'listing_id', type: 'bigint' },
      { name: 'instrument_id', type: 'bigint' },
      { name: 'exch_code', type: 'text' },
      { name: 'local_ticker', type: 'text' },
      { name: 'is_primary', type: 'boolean' },
      { name: 'listing_status', type: 'text' },
    ],
    needListing.map((c, i) => {
      const listingId = listingIds[i];
      if (listingId !== undefined) listingIdByInstrument.set(c.instrumentId, listingId);
      return [listingId, c.instrumentId, 'US', c.ticker, true, 'active'];
    }),
    { validFrom: UNIVERSE_VALID_FROM, txFrom: wikiKnownAt, provenanceId: wiki.provenanceId },
  );

  // `yahoo.chart` quotes a US equity under its plain ticker (PROVIDERS §5.6) — a documented provider
  // convention, not a value, so the line's provenance is the capture that supplies the *ticker*.
  const yahooLines = constituents.map((c) => ({
    instrumentId: c.instrumentId,
    sourceId: 'yahoo.chart',
    providerSymbol: c.ticker,
    intrinsicDelayMin: YAHOO_DELAY_MIN,
    expectedIntervalMs: YAHOO_INTERVAL_MS,
    priority: YAHOO_PRIORITY,
    capture: null as CaptureName | null,
  }));
  const lineResult = await writeReferenceLines(run, yahooLines, wiki.provenanceId, wikiKnownAt);
  counts.mdLines += lineResult.mdLines;
  counts.identifiers += lineResult.identifiers;

  // The member's `search_weight` and its `primary_listing_id`, in ONE version rather than two.
  //
  // The weight matters for idempotency, not for tidiness: `refdata/universe.ts#searchWeightFor`
  // gives an index member 2.0, and module 3 wrote 1.0 because no `index_members` row existed yet.
  // Leaving it at 1.0 would make the *next* `db:seed` see `action: 'refresh'` for all 503 and write
  // 503 versions — a seed that is idempotent only from the third run onwards.
  for (const c of constituents) {
    const current = await run.repos.instruments.get(c.instrumentId, at);
    if (current === null) continue;
    const listingId = listingIdByInstrument.get(c.instrumentId) ?? current.primaryListingId;
    const written = await run.repos.instruments.upsert(
      c.instrumentId,
      {
        ...toInstrumentInput(current),
        searchWeight: Math.max(current.searchWeight, 2),
        ...(listingId === undefined ? {} : { primaryListingId: listingId }),
      },
      {
        validFrom: UNIVERSE_VALID_FROM,
        provenanceId: wiki.provenanceId,
        knownAt: wikiKnownAt,
        reason: 'change',
      },
    );
    if (written !== null) counts.instrumentsRefreshed += 1;
  }

  // ── GICS classifications, issuer level ────────────────────────────────────────────────────────
  //
  // One row per issuer, carrying the **sub-industry** code: `entity_classifications_bt_excl` is keyed
  // `(entity_kind, entity_id, scheme)` so exactly one GICS code per issuer is storable, and the
  // level-4 code is the one the other three are reachable from (`ClassificationRepository` walks
  // `parent_code` in memory). Writing the sector instead would lose three levels of the tree.
  const classifications = wikiParse.rows.flatMap((row) => {
    if (row.cik === null || row.subIndustryCode === null) return [];
    const issuerId = issuerByCik.get(row.cik);
    if (issuerId === undefined) return [];
    return [
      {
        entityKind: 'issuer' as const,
        entityId: issuerId,
        scheme: GICS,
        code: row.subIndustryCode,
        validFrom: UNIVERSE_VALID_FROM,
        provenanceId: wiki.provenanceId,
        reason: 'initial' as const,
        txFrom: wikiKnownAt,
      },
    ];
  });
  counts.entityClassifications += await run.classifications.upsertClassifications(classifications);

  // ── indices ───────────────────────────────────────────────────────────────────────────────────
  //
  // `upsertIndex` is a plain keyed upsert (the table is configuration, not a bitemporal fact). Only
  // SPX has a membership feed: SPY files N-PORT and publishes a daily holdings file, and no capture
  // on disk names the constituents of the other thirty.
  //
  // `upsertIndex` is an unconditional `ON CONFLICT DO UPDATE`, so the current row is read first and
  // only a genuinely different one is written; otherwise every `db:seed` rewrites all 31 tuples and
  // the count in the run summary says 31 when nothing happened.
  const heldIndices = await run.ctx.query(
    `SELECT index_id, code, instrument_id, proxy_fund_instrument_id, membership_source_id, provider
       FROM indices WHERE code = ANY($1::text[])`,
    [SEEDED_INDICES.map((index) => index.code)],
  );
  const heldByCode = new Map(
    (
      heldIndices.rows as {
        index_id: string;
        code: string;
        instrument_id: string;
        proxy_fund_instrument_id: string | null;
        membership_source_id: string | null;
        provider: string;
      }[]
    ).map((row) => [row.code, row]),
  );

  const indexIdByCode = new Map<string, number>();
  for (const index of SEEDED_INDICES) {
    const instrument = await run.ctx.query(
      `SELECT instrument_id FROM instruments
        WHERE tx_to = 'infinity' AND valid_to = 'infinity' AND ticker = $1 AND exch_code = 'INDEX'
        ORDER BY instrument_id LIMIT 1`,
      [index.code],
    );
    const instrumentRow = instrument.rows[0] as { instrument_id: string } | undefined;
    if (instrumentRow === undefined) continue;
    const wanted = {
      code: index.code,
      instrumentId: Number(instrumentRow.instrument_id),
      proxyFundInstrumentId: index.code === 'SPX' ? spy.instrumentId : null,
      membershipSourceId: index.code === 'SPX' ? 'sec.archives' : null,
      provider: index.provider,
    };
    const held = heldByCode.get(index.code);
    if (
      held !== undefined &&
      Number(held.instrument_id) === wanted.instrumentId &&
      numberOrNull(held.proxy_fund_instrument_id) === wanted.proxyFundInstrumentId &&
      held.membership_source_id === wanted.membershipSourceId &&
      held.provider === wanted.provider
    ) {
      indexIdByCode.set(index.code, Number(held.index_id));
      continue;
    }
    const record = await upsertIndex(run.tx, wanted);
    indexIdByCode.set(index.code, record.indexId);
    counts.indices += 1;
  }
  const spxIndexId = indexIdByCode.get('SPX');
  if (spxIndexId === undefined) {
    throw new Error('seed/universe: no `indices` row for SPX after the index pass');
  }

  // ── etf_holdings and the two membership snapshots ─────────────────────────────────────────────
  const ssgaByCusip = new Map<string, string>();
  const ssgaByName = new Map<string, string>();
  for (const holding of ssgaRows.rows.holdings) {
    if (holding.ticker === null) continue;
    const ticker = holding.ticker.trim().toUpperCase();
    if (holding.cusip !== null) ssgaByCusip.set(holding.cusip, ticker);
    ssgaByName.set(foldClassificationName(holding.name), ticker);
  }
  const wikiByName = new Map<string, string>();
  for (const row of wikiParse.rows) {
    wikiByName.set(foldClassificationName(row.security), row.symbol.trim().toUpperCase());
  }

  /** N-PORT has no ticker: CUSIP against the same fund's SSGA file, then folded name, then wiki. */
  const tickerForNport = (holding: { cusip: string | null; name: string }): string | null => {
    if (holding.cusip !== null) {
      const byCusip = ssgaByCusip.get(holding.cusip);
      if (byCusip !== undefined) return byCusip;
    }
    const folded = foldClassificationName(holding.name);
    return ssgaByName.get(folded) ?? wikiByName.get(folded) ?? null;
  };

  const nportAsOf = nportRows.rows.header.repPdDate;
  if (nportAsOf === null) {
    throw new Error(
      'seed/universe: the SPY N-PORT filing carries no repPdDate to date its holdings',
    );
  }
  const ssgaAsOf = ssgaRows.rows.header.asOfDate;
  if (ssgaAsOf === null) {
    throw new Error('seed/universe: the SSGA holdings file carries no as-of date');
  }

  counts.etfHoldings += await writeEtfHoldings(
    run,
    spy.instrumentId,
    nportAsOf,
    'sec.archives',
    nport.provenanceId,
    nportRows.rows.holdings.map((holding) => {
      const ticker = tickerForNport(holding);
      const master = ticker === null ? undefined : instrumentByTicker.get(ticker);
      return {
        lineNo: holding.lineNo,
        holdingInstrumentId: master?.instrumentId ?? null,
        name: holding.name,
        cusip: holding.cusip,
        isin: holding.isin,
        lei: holding.lei,
        sedol: null,
        ticker,
        shares: holding.shares,
        marketValue: holding.marketValue,
        weight: holding.weight,
        assetCat: holding.assetCat,
        issuerCat: holding.issuerCat,
        country: holding.country,
      };
    }),
  );

  counts.etfHoldings += await writeEtfHoldings(
    run,
    spy.instrumentId,
    ssgaAsOf,
    'ssga.holdings',
    ssga.provenanceId,
    ssgaRows.rows.holdings.map((holding) => {
      const ticker = holding.ticker === null ? null : holding.ticker.trim().toUpperCase();
      const master = ticker === null ? undefined : instrumentByTicker.get(ticker);
      return {
        lineNo: holding.lineNo,
        holdingInstrumentId: master?.instrumentId ?? null,
        name: holding.name,
        cusip: holding.cusip,
        isin: null,
        lei: null,
        sedol: holding.sedol,
        ticker,
        shares: holding.shares,
        marketValue: holding.marketValue,
        weight: holding.weight,
        assetCat: null,
        issuerCat: null,
        country: null,
      };
    }),
  );

  // The two snapshots, oldest report date first. `recordSnapshot` reads the pre-snapshot roster at
  // `(as_of_date, txFrom)` before writing anything, so the second snapshot's diff is taken against
  // what the first one left — which is how a constituent that left the index between 2026-06-30 and
  // 2026-09-14 ends up with `valid_to = 2026-09-14` rather than being deleted.
  const nportMembers = dedupeMembers(
    nportRows.rows.holdings.flatMap((holding) => {
      if (holding.assetCat !== 'EC') return [];
      const ticker = tickerForNport(holding);
      const master = ticker === null ? undefined : instrumentByTicker.get(ticker);
      if (master === undefined) return [];
      return [
        {
          instrumentId: master.instrumentId,
          weight: holding.weight,
          shares: holding.shares,
          marketValue: holding.marketValue,
        },
      ];
    }),
  );
  // Transaction time must not go backwards across runs either: the heads the SSGA snapshot left
  // behind carry run 1's `tx_from`, and re-applying anything over them at a capture instant from
  // 2026-09 would close a version before it was opened.
  run.clock.notBefore(await maxMemberTxFrom(run, spxIndexId));

  const nportSnapshot = await applySnapshotOnce(run, {
    indexId: spxIndexId,
    asOfDate: nportAsOf,
    sourceId: 'sec.archives',
    provenanceId: nport.provenanceId,
    members: nportMembers,
    txFrom: run.clock.at(new Date(nport.raw.capturedAt)),
  });
  counts.indexMembers += nportSnapshot.written;

  const ssgaMembers = dedupeMembers(
    ssgaRows.rows.holdings.flatMap((holding) => {
      const ticker = holding.ticker === null ? null : holding.ticker.trim().toUpperCase();
      const master = ticker === null ? undefined : instrumentByTicker.get(ticker);
      if (master === undefined) return [];
      return [
        {
          instrumentId: master.instrumentId,
          weight: holding.weight,
          shares: holding.shares,
          marketValue: holding.marketValue,
        },
      ];
    }),
  );
  const ssgaSnapshot = await applySnapshotOnce(run, {
    indexId: spxIndexId,
    asOfDate: ssgaAsOf,
    sourceId: 'ssga.holdings',
    provenanceId: ssga.provenanceId,
    members: ssgaMembers,
    txFrom: run.clock.at(new Date(ssga.raw.capturedAt)),
  });
  counts.indexMembers += ssgaSnapshot.written;
  run.log(
    `index_members: ${String(nportSnapshot.written)} at ${nportAsOf} (N-PORT), ` +
      `${String(ssgaSnapshot.written)} at ${ssgaAsOf} (SSGA), ` +
      `${String(ssgaSnapshot.retired)} retired between them`,
  );

  // ── fund_terms and entity_relations ───────────────────────────────────────────────────────────
  const fundTerms = await run.terms.upsert('fund', {
    instrumentId: spy.instrumentId,
    data: {
      fundType: 'etf',
      trackedIndexInstrumentId: spxInstrumentId,
      sponsor: ssgaRows.rows.header.fundName,
      cik: SPY_NPORT_CIK,
      seriesId: null,
      expenseRatio: null,
      inceptionDate: null,
      distributionFreq: null,
    },
    validFrom: UNIVERSE_VALID_FROM,
    provenanceId: nport.provenanceId,
    reason: 'initial',
    txFrom: run.clock.at(new Date(nport.raw.capturedAt)),
  });
  if (fundTerms !== null) counts.fundTerms += 1;

  counts.entityRelations += await writeEntityRelations(
    run,
    spy.instrumentId,
    spxInstrumentId,
    ssgaMembers,
    ssga.provenanceId,
    run.clock.at(new Date(ssga.raw.capturedAt)),
  );

  return counts;
}

/** A `bigint` column node-postgres hands back as text, or `null`. */
function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * The latest `tx_from` any current `index_members` version of this index holds, or `null` when the
 * index has no membership yet.
 */
async function maxMemberTxFrom(run: UniverseSeedRun, indexId: number): Promise<Date | null> {
  const res = await run.ctx.query(
    `SELECT max(tx_from) AS at FROM index_members WHERE index_id = $1 AND tx_to = 'infinity'`,
    [indexId],
  );
  const at = (res.rows[0] as { at: Date | string | null } | undefined)?.at ?? null;
  if (at === null) return null;
  // node-postgres maps OID 1184 to a `Date`, but a driver-level type parser can hand back the text;
  // this is on the write path of a bitemporal close, so both are handled.
  return at instanceof Date ? at : new Date(at);
}

/**
 * Apply one weights snapshot, unless `index_members` already holds that exact
 * `(index_id, as_of_date, source_id)` — in which case this snapshot has already been recorded and
 * there is nothing to say.
 *
 * The guard is here rather than in `recordSnapshot` because of a limitation in
 * `refdata/indexMembership.ts#upsertMember` that only the seed meets: its "already says exactly
 * this" test requires `valid_to = 'infinity'`, so a member whose range a *later* snapshot has since
 * narrowed is never recognised as unchanged. The seed is the one caller that applies two snapshots
 * with different report dates, oldest first, so on a second run the older snapshot's members all
 * carry `valid_to = 2026-09-14` and every one of them would be rewritten — 495 rows per run, for
 * ever, and the version the write closes was opened at a later knowledge instant than the older
 * capture's, so the first one aborts with `bt_guard_update`'s "tx_to must be after tx_from".
 *
 * `as_of_date` is exactly the snapshot's identity (`index_members.as_of_date` = `valid_from::date`)
 * and it survives the narrowing: `insertRemainder` copies the old row and overrides only `valid_to`
 * and the transaction-time columns. So "has this file already been applied" is a one-row read, not
 * an inference.
 */
async function applySnapshotOnce(
  run: UniverseSeedRun,
  snapshot: Parameters<typeof recordSnapshot>[1],
): Promise<{ written: number; unchanged: number; retired: number }> {
  const held = await run.ctx.query(
    `SELECT 1 FROM index_members
      WHERE index_id = $1 AND as_of_date = $2::date AND source_id = $3 AND tx_to = 'infinity'
      LIMIT 1`,
    [snapshot.indexId, snapshot.asOfDate, snapshot.sourceId],
  );
  if (held.rows.length > 0) {
    return { written: 0, unchanged: snapshot.members.length, retired: 0 };
  }
  const result = await recordSnapshot(run.tx, snapshot);
  return { written: result.written, unchanged: result.unchanged, retired: result.retired };
}

/**
 * Drop a repeated instrument from a snapshot.
 *
 * `recordSnapshot` throws on a duplicate instrument — the placeholder-identifier trap of WORKPLAN
 * L730-741 — and the SPY N-PORT filing genuinely contains two lines for one issuer when a
 * corporate action is in flight (a `CONTRA` line beside the ordinary holding). The first line wins,
 * which is the same rule `mergeUniverse` applies to a duplicate symbol.
 */
function dedupeMembers<T extends { instrumentId: number }>(members: readonly T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const member of members) {
    if (seen.has(member.instrumentId)) continue;
    seen.add(member.instrumentId);
    out.push(member);
  }
  return out;
}

/** One `etf_holdings` row, before the fund and as-of columns are attached. */
interface EtfHoldingRow {
  lineNo: number;
  holdingInstrumentId: number | null;
  name: string;
  cusip: string | null;
  isin: string | null;
  lei: string | null;
  sedol: string | null;
  ticker: string | null;
  shares: string | null;
  marketValue: string | null;
  weight: string | null;
  assetCat: string | null;
  issuerCat: string | null;
  country: string | null;
}

/**
 * `etf_holdings` for one file. Not bitemporal: the primary key
 * `(etf_instrument_id, as_of_date, source_id, line_no)` already carries the file's identity, and a
 * holdings file is re-published rather than corrected.
 *
 * `DO UPDATE … WHERE` so that a re-run of the same file writes no tuple at all. A bare
 * `DO UPDATE` here would rewrite 1,009 rows per `db:seed`.
 */
async function writeEtfHoldings(
  run: UniverseSeedRun,
  etfInstrumentId: number,
  asOfDate: string,
  sourceId: string,
  provenanceId: number,
  rows: readonly EtfHoldingRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const before = await countEtfHoldings(run, etfInstrumentId, asOfDate, sourceId);
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK);
    await run.ctx.query(
      `INSERT INTO etf_holdings (etf_instrument_id, as_of_date, source_id, line_no,
                                 holding_instrument_id, name, cusip, isin, lei, sedol, ticker,
                                 shares, market_value, weight, asset_cat, issuer_cat, country,
                                 provenance_id)
       SELECT $1, $2::date, $3, line_no, holding_instrument_id, name, cusip, isin, lei, sedol,
              ticker, shares, market_value, weight, asset_cat, issuer_cat, country, $4
         FROM unnest($5::int[], $6::bigint[], $7::text[], $8::text[], $9::text[], $10::text[],
                     $11::text[], $12::text[], $13::numeric[], $14::numeric[], $15::numeric[],
                     $16::text[], $17::text[], $18::text[])
           AS s(line_no, holding_instrument_id, name, cusip, isin, lei, sedol, ticker, shares,
                market_value, weight, asset_cat, issuer_cat, country)
       ON CONFLICT (etf_instrument_id, as_of_date, source_id, line_no) DO UPDATE SET
              holding_instrument_id = excluded.holding_instrument_id, name = excluded.name,
              cusip = excluded.cusip, isin = excluded.isin, lei = excluded.lei,
              sedol = excluded.sedol, ticker = excluded.ticker, shares = excluded.shares,
              market_value = excluded.market_value, weight = excluded.weight,
              asset_cat = excluded.asset_cat, issuer_cat = excluded.issuer_cat,
              country = excluded.country, provenance_id = excluded.provenance_id
        WHERE (etf_holdings.holding_instrument_id, etf_holdings.name, etf_holdings.cusip,
               etf_holdings.isin, etf_holdings.lei, etf_holdings.sedol, etf_holdings.ticker,
               etf_holdings.shares, etf_holdings.market_value, etf_holdings.weight,
               etf_holdings.asset_cat, etf_holdings.issuer_cat, etf_holdings.country,
               etf_holdings.provenance_id)
          IS DISTINCT FROM
              (excluded.holding_instrument_id, excluded.name, excluded.cusip, excluded.isin,
               excluded.lei, excluded.sedol, excluded.ticker, excluded.shares,
               excluded.market_value, excluded.weight, excluded.asset_cat, excluded.issuer_cat,
               excluded.country, excluded.provenance_id)`,
      [
        etfInstrumentId,
        asOfDate,
        sourceId,
        provenanceId,
        chunk.map((row) => row.lineNo),
        chunk.map((row) => row.holdingInstrumentId),
        chunk.map((row) => row.name),
        chunk.map((row) => row.cusip),
        chunk.map((row) => row.isin),
        chunk.map((row) => row.lei),
        chunk.map((row) => row.sedol),
        chunk.map((row) => row.ticker),
        chunk.map((row) => row.shares),
        chunk.map((row) => row.marketValue),
        chunk.map((row) => row.weight),
        chunk.map((row) => row.assetCat),
        chunk.map((row) => row.issuerCat),
        chunk.map((row) => row.country),
      ],
    );
  }
  const after = await countEtfHoldings(run, etfInstrumentId, asOfDate, sourceId);
  return after - before;
}

async function countEtfHoldings(
  run: UniverseSeedRun,
  etfInstrumentId: number,
  asOfDate: string,
  sourceId: string,
): Promise<number> {
  const res = await run.ctx.query(
    `SELECT count(*)::int AS n FROM etf_holdings
      WHERE etf_instrument_id = $1 AND as_of_date = $2::date AND source_id = $3`,
    [etfInstrumentId, asOfDate, sourceId],
  );
  return (res.rows[0] as { n: number } | undefined)?.n ?? 0;
}

/**
 * `entity_relations`: SPY **holds** each constituent, and SPY **tracks** SPX (§18 row 4, REF-08).
 *
 * `entity_relations_bt_excl` is keyed on the whole five-tuple, so "does this row already exist" is a
 * read of the current versions rather than a guess, and only the missing ones are written.
 */
async function writeEntityRelations(
  run: UniverseSeedRun,
  spyInstrumentId: number,
  spxInstrumentId: number,
  members: readonly { instrumentId: number; weight: string | null }[],
  provenanceId: number,
  knownAt: Date,
): Promise<number> {
  const wanted: { toId: number; relation: 'holds' | 'tracks'; weight: string | null }[] = [
    ...members.map((member) => ({
      toId: member.instrumentId,
      relation: 'holds' as const,
      weight: member.weight,
    })),
    { toId: spxInstrumentId, relation: 'tracks' as const, weight: null },
  ];

  const held = await run.ctx.query(
    `SELECT to_id, relation FROM entity_relations
      WHERE tx_to = 'infinity' AND valid_to = 'infinity'
        AND from_kind = 'instrument' AND from_id = $1 AND to_kind = 'instrument'`,
    [spyInstrumentId],
  );
  const heldKeys = new Set(
    (held.rows as { to_id: string; relation: string }[]).map(
      (row) => `${row.to_id}|${row.relation}`,
    ),
  );
  const missing = wanted.filter((row) => !heldKeys.has(`${String(row.toId)}|${row.relation}`));

  return run.bulkInsertVersions(
    'entity_relations',
    [
      { name: 'from_kind', type: 'entity_kind' },
      { name: 'from_id', type: 'bigint' },
      { name: 'to_kind', type: 'entity_kind' },
      { name: 'to_id', type: 'bigint' },
      { name: 'relation', type: 'text' },
      { name: 'weight', type: 'numeric' },
      { name: 'source_id', type: 'text' },
    ],
    missing.map((row) => [
      'instrument',
      spyInstrumentId,
      'instrument',
      row.toId,
      row.relation,
      row.weight,
      'ssga.holdings',
    ]),
    { validFrom: UNIVERSE_VALID_FROM, txFrom: knownAt, provenanceId },
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Modules 2-5 of DATA_MODEL §18, in dependency order. The caller owns the transaction
 * (`seed/index.ts` opens one per module), so a failure anywhere below leaves the database exactly as
 * it was and the run can simply be repeated.
 */
export async function seedUniverse(ctx: SeedContext): Promise<SeedUniverseResult> {
  const run = new UniverseSeedRun(ctx);

  const calendars = await seedCalendarsAndExchanges(run);
  const listed = await seedListedUniverse(run);
  const aapl = await seedAaplSymbology(run, listed);
  const reference = await seedReferenceInstruments(run);
  const sp500 = await seedSp500(run);

  return {
    calendars: calendars.calendars,
    calendarSessions: calendars.calendarSessions,
    calendarHolidays: calendars.calendarHolidays,
    exchanges: calendars.exchanges,
    issuers: listed.issuers + reference.issuers,
    issues: listed.issues + reference.issues,
    instruments: listed.instruments + reference.instruments,
    instrumentsRefreshed: listed.instrumentsRefreshed + sp500.instrumentsRefreshed,
    listings: aapl.listings + sp500.listings,
    mdLines: listed.mdLines + reference.mdLines + sp500.mdLines,
    identifiers: listed.identifiers + reference.identifiers + sp500.identifiers,
    indices: sp500.indices,
    indexMembers: sp500.indexMembers,
    etfHoldings: sp500.etfHoldings,
    entityClassifications: sp500.entityClassifications,
    classificationCodes: sp500.classificationCodes,
    fundTerms: sp500.fundTerms,
    indexTerms: reference.indexTerms,
    fxTerms: reference.fxTerms,
    entityRelations: sp500.entityRelations,
    provenance: run.provenanceWritten,
  };
}

/** Modules 2-5 of the ordered seed runner (`seed/index.ts`). */
export const universeSeedModule = {
  order: 2,
  name: 'universe',
  run: seedUniverse,
} as const;
