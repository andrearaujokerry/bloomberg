/**
 * WP-15 acceptance row — "row counts per table match the DATA_MODEL §18 table within tolerance",
 * for **every one of §18's thirteen rows**.
 *
 * It covered rows 2-5 only (`seed/universe.ts`) and said so in this sentence, and nothing else picked
 * up the rest. Grepping the seeded counts against the whole of `test/integration/seed/` and
 * `test/unit/seed/` found seven tables with no assertion anywhere: `xbrl_facts` (25,116 rows, the
 * largest table in the seed), `econ_observations` (16,987), `fin_statements`, `bars_daily`,
 * `bars_intraday`, `news_entity_links` and `people`. A seed that wrote 8,000 `xbrl_facts` instead of
 * 25,116 — a truncated capture, a unit filter widened by accident, a transaction that rolled back
 * half way — shipped green. Two of the unasserted counts were already wrong against §18 by a wide
 * margin, and one of them was wrong because an artefact was missing entirely: `fin_statements` held
 * no `period_type = 'TTM'` row at all, which is why that row is asserted GROUPED by `period_type`
 * below rather than as a total. A total would have hidden it, and did.
 *
 * The seed runs once per vitest invocation, in `test/globalSetup.ts` (TESTING §4.2 step 5); this
 * file only counts what it left, in the same style as `seed/licences.test.ts`.
 *
 * ## Why every count is scoped, not a bare `count(*)`
 *
 * The runner executes all thirteen §18 modules, and eight of them write the same tables: module 6
 * adds 20 government and rate instruments, module 9 adds 3,510 option contracts, module 10 adds
 * filings and listings, module 11 adds econ series. A bare `count(*) FROM instruments` therefore
 * measures the whole seed and this file would go red every time a sibling module landed — which
 * teaches the next person to widen the tolerance rather than to look.
 *
 * So each row is scoped to what one module owns, by the keys that make the ownership decidable:
 * the `asset_class` (modules 2-5 write `equity`, `etf`, `future`, `index`, `fx` and `crypto`; the
 * others write `govt`, `rate`, `option` and `econ`), the `provenance.source_id` of the capture the row
 * came from, and — for the rows added for modules 6-13 — the capture's own key (a CIK, a frame, a
 * feed, a curve id). A count that changes when a sibling lands is a count that was measuring the
 * wrong thing.
 *
 * ## What "within tolerance" means here, and why it is not just a percentage
 *
 * §18's volumes were written before the code that produces them existed, and four of them cannot be
 * reproduced from the committed fixtures at all. A test that asserted §18's figure with a tolerance
 * wide enough to swallow those four would be wide enough to swallow a real regression as well — a
 * seed that wrote 30,000 instruments instead of 37,410 would still pass at ±25 %.
 *
 * So each row carries **both** numbers: `dataModel` is what §18 says and is only ever printed, and
 * `expected` is the count the current fixtures and the current code actually produce, which is what
 * the assertion polices, with the tightest tolerance that count allows. Where the two differ, `note`
 * says why — and that note is the reviewable artefact. Changing a `note` to "because the test
 * failed" is the failure mode this shape exists to make obvious.
 *
 * Every failure message names the table, both numbers and the accepted window, because
 * "expected 401 to be close to 35618" with no table name is a bad afternoon.
 */

import { describe, expect, it } from 'vitest';

import { withTxDb } from '../../../src/test/db.js';

/** One asserted volume. */
interface Volume {
  /** The table, plus the scope, spelled the way the failure message should read. */
  readonly label: string;
  /** Counting SQL returning one column `n`. */
  readonly sql: string;
  /** The count the committed fixtures and `seed/universe.ts` produce today. Asserted. */
  readonly expected: number;
  /** Fractional tolerance on `expected`. `0` means exact. */
  readonly tolerance: number;
  /** DATA_MODEL §18's own figure. Printed, never asserted. */
  readonly dataModel: number;
  /** Why the two differ, when they do. */
  readonly note?: string;
}

/** Current, currently-believed versions of a bitemporal table. */
const CURRENT = `tx_to = 'infinity' AND valid_to = 'infinity'`;

/**
 * The asset classes modules 2-5 write. Modules 6-11 write `govt`, `rate`, `option` and `econ`, so
 * this predicate is what separates this file's rows from theirs without naming a row count.
 */
const OWN_CLASSES = `asset_class IN ('equity', 'etf', 'future', 'index', 'fx', 'crypto')`;

/** `exch_code` of module 5's 44 reference instruments. Modules 6-11 use `GOVT`, `RATE` and `ECON`. */
const REFERENCE_EXCH = `exch_code IN ('INDEX', 'FX', 'CRYPTO')`;

/**
 * The 44 reference instruments as a **materialised** CTE.
 *
 * `AS MATERIALIZED` is load-bearing, not decoration. Written as
 * `entity_id IN (SELECT instrument_id FROM instruments WHERE …)` the planner inlines the subquery
 * and picks a sequential scan of `identifiers` (81 k rows) against a sequential scan of
 * `instruments` (37 k versions) — measured at over three minutes, which reads as a hung test rather
 * than a slow one. Materialising the 44-row side first turns it into 44 index probes on
 * `identifiers_entity_idx`.
 */
const REFERENCE_INSTRUMENTS = `WITH ref AS MATERIALIZED (
            SELECT instrument_id FROM instruments WHERE ${CURRENT} AND ${REFERENCE_EXCH}
          )`;

/**
 * DATA_MODEL §18 rows 2-5, transcribed, with the measured count beside each figure.
 *
 * Measured against a database seeded with modules 1-5 from the committed fixtures on 2026-09-26:
 * 35,618 Cboe symbols, 10,422 SEC ticker entries over 8,022 CIKs, 275 OpenFIGI records for AAPL,
 * 504 N-PORT holdings, 505 SSGA holdings, 503 Wikipedia constituents.
 */
const VOLUMES: readonly Volume[] = [
  // ── module 2, calendars and exchanges ───────────────────────────────────────────────────────
  {
    label: 'calendars',
    sql: 'SELECT count(*)::int AS n FROM calendars',
    expected: 9,
    tolerance: 0,
    dataModel: 9,
  },
  {
    label: 'calendar_sessions',
    sql: 'SELECT count(*)::int AS n FROM calendar_sessions',
    expected: 40,
    tolerance: 0,
    dataModel: 40,
    note:
      'five weekdays for each of the eight calendars that open, and none for WEEKEND — §18 gives ' +
      'no figure, so this one is measured only',
  },
  {
    label: 'calendar_holidays (1990-2040, all nine calendars)',
    sql: 'SELECT count(*)::int AS n FROM calendar_holidays',
    expected: 4_386,
    tolerance: 0,
    dataModel: 1_300,
    note:
      "§18's ≈1,300 is one calendar's worth of 51 years; the seed materialises all nine, and the " +
      'generators emit early closes as rows as well as full closures',
  },
  {
    label: 'exchanges',
    sql: 'SELECT count(*)::int AS n FROM exchanges',
    expected: 14,
    tolerance: 0,
    dataModel: 14,
  },

  // ── module 3, the US listed universe ────────────────────────────────────────────────────────
  {
    label: 'issuers citing sec-company-tickers.json (one per CIK)',
    sql: `SELECT count(*)::int AS n FROM issuers x JOIN provenance p USING (provenance_id)
           WHERE x.${CURRENT} AND p.source_id = 'sec.tickers'`,
    expected: 8_022,
    tolerance: 0,
    dataModel: 10_500,
    note:
      "§18's 10.5k is the file's 10,422 ENTRY count; those entries carry 8,022 distinct CIKs " +
      'because a multi-class issuer repeats (GOOG/GOOGL), and `issuers` is keyed by the legal entity',
  },
  {
    label: 'issuers citing cboe-symbol-book.json (one per company_name no CIK claims)',
    sql: `SELECT count(*)::int AS n FROM issuers x JOIN provenance p USING (provenance_id)
           WHERE x.${CURRENT} AND p.source_id = 'cboe.symbolBook'`,
    expected: 25_024,
    tolerance: 0.01,
    dataModel: 0,
    note:
      '§18 budgets no issuer for these; a symbol Cboe quotes and the SEC does not file for still ' +
      'needs an issuing entity, and the Cboe `company_name` is that entity, from a capture',
  },
  {
    label: "issuers entity_type='index_provider' (module 5's curated table)",
    sql: `SELECT count(*)::int AS n FROM issuers WHERE ${CURRENT} AND entity_type = 'index_provider'`,
    expected: 18,
    tolerance: 0,
    dataModel: 0,
    note: 'the distinct index providers behind the 31 seeded indices',
  },
  {
    label: 'issues in the asset classes modules 2-5 own',
    sql: `SELECT count(DISTINCT issue_id)::int AS n FROM issues WHERE ${CURRENT} AND ${OWN_CLASSES}`,
    expected: 37_410,
    tolerance: 0.01,
    dataModel: 35_600,
    note: 'one issue per instrument; see the instruments row',
  },
  {
    label: 'instruments in the asset classes modules 2-5 own',
    sql: `SELECT count(DISTINCT instrument_id)::int AS n FROM instruments
           WHERE ${CURRENT} AND ${OWN_CLASSES}`,
    expected: 37_410,
    tolerance: 0.01,
    dataModel: 35_600,
    note:
      "§18's ≈35.6k is the symbol book's own 35,618. The universe is the book UNION the SEC ticker " +
      'file, and the SEC file names 1,748 listed companies Cboe does not quote (SECF must still ' +
      "resolve them), plus module 5's 44 indices, pairs and crypto assets",
  },
  {
    label: "instruments asset_class='equity'",
    sql: `SELECT count(*)::int AS n FROM instruments WHERE ${CURRENT} AND asset_class = 'equity'`,
    expected: 30_359,
    tolerance: 0.01,
    dataModel: 30_000,
  },
  {
    label: "instruments asset_class='etf'",
    sql: `SELECT count(*)::int AS n FROM instruments WHERE ${CURRENT} AND asset_class = 'etf'`,
    expected: 6_889,
    tolerance: 0.01,
    dataModel: 4_000,
    note:
      "refdata/universe.ts#classifyCboeSymbol's ETF_MARKERS matches TRUST / SHARES / PORTFOLIO as " +
      'well as ETF / ETN, so the equity/ETF split lands further towards ETF than §18 estimated',
  },
  {
    label: "instruments asset_class='future' status='pending'",
    sql: `SELECT count(*)::int AS n FROM instruments
           WHERE ${CURRENT} AND asset_class = 'future' AND status = 'pending'`,
    expected: 118,
    tolerance: 0,
    dataModel: 1_600,
    note:
      'classifyCboeSymbol calls a symbol a futures root only when its name matches the month-code ' +
      'shape AND its description says Futures: 118 entries in the recorded book. The other ~1,900 ' +
      '§18 had in mind are the ^-prefixed Cboe index roots, which that function does not recognise ' +
      "(it tests startsWith('_')) and which therefore land as 'other'-shaped US equities",
  },
  {
    label: 'listings citing openfigi-map or wiki-sp500.html',
    sql: `SELECT count(DISTINCT listing_id)::int AS n FROM listings x JOIN provenance p USING (provenance_id)
           WHERE x.${CURRENT} AND p.source_id IN ('openfigi.mapping', 'wiki.sp500')`,
    expected: 523,
    tolerance: 0,
    dataModel: 780,
    note:
      "§18's 780 is 275 + 503, where 275 is every record in the AAPL OpenFIGI answer. 20 of those " +
      'are composite (country) lines for other countries and 255 are venue lines beneath all 98 ' +
      'composites; only the 20 venues of the US composite belong to an instrument this seed ' +
      'creates, so 20 + 503 composite listings for the S&P names = 523',
  },
  {
    label: "md_lines source_id='cboe.quotes' derived from the symbol book",
    sql: `SELECT count(*)::int AS n FROM md_lines x JOIN provenance p USING (provenance_id)
           WHERE x.${CURRENT} AND x.source_id = 'cboe.quotes' AND p.source_id = 'cboe.symbolBook'`,
    expected: 35_616,
    tolerance: 0,
    dataModel: 36_000,
    note:
      'one composite line per symbol-book entry, exactly, less the two (`_SPX`, `_VIX`) that belong ' +
      "to module 5's index instruments because those two have a recorded quote of their own",
  },
  {
    label: "md_lines source_id='yahoo.chart' for the S&P 500 constituents",
    sql: `SELECT count(*)::int AS n FROM md_lines x JOIN provenance p USING (provenance_id)
           WHERE x.${CURRENT} AND x.source_id = 'yahoo.chart' AND p.source_id = 'wiki.sp500'`,
    expected: 503,
    tolerance: 0,
    dataModel: 503,
  },
  {
    label: 'identifiers citing the four listed-universe captures',
    sql: `SELECT count(*)::int AS n FROM identifiers x JOIN provenance p USING (provenance_id)
           WHERE x.tx_to = 'infinity' AND x.valid_to = 'infinity'
             AND p.source_id IN ('cboe.symbolBook', 'sec.tickers', 'openfigi.mapping', 'wiki.sp500')`,
    expected: 81_547,
    tolerance: 0.01,
    dataModel: 90_000,
    note:
      'TICKER_EXCH per instrument + PROVIDER_SYMBOL per Cboe and Yahoo line + CIK per issuer + ' +
      "AAPL's 20 venue FIGIs and their venue tickers. §18's ≈90k also budgeted the " +
      'ISIN/CUSIP/SEDOL of the 503 constituents, which this seed carries on `etf_holdings` from ' +
      'N-PORT and SSGA; attaching them to the issues belongs to module 10, where the SEC ' +
      'submissions capture is read',
  },

  // ── module 5, indices, FX and crypto ────────────────────────────────────────────────────────
  {
    label: "instruments asset_class='index'",
    sql: `SELECT count(*)::int AS n FROM instruments WHERE ${CURRENT} AND asset_class = 'index'`,
    expected: 31,
    tolerance: 0,
    dataModel: 31,
  },
  {
    label: "instruments asset_class='fx'",
    sql: `SELECT count(*)::int AS n FROM instruments WHERE ${CURRENT} AND asset_class = 'fx'`,
    expected: 9,
    tolerance: 0,
    dataModel: 9,
  },
  {
    label: "instruments asset_class='crypto'",
    sql: `SELECT count(*)::int AS n FROM instruments WHERE ${CURRENT} AND asset_class = 'crypto'`,
    expected: 4,
    tolerance: 0,
    dataModel: 4,
  },
  {
    label: 'md_lines on the 44 index / FX / crypto instruments',
    sql: `${REFERENCE_INSTRUMENTS}
          SELECT count(*)::int AS n FROM md_lines m JOIN ref ON ref.instrument_id = m.instrument_id
           WHERE m.${CURRENT}`,
    expected: 55,
    tolerance: 0,
    dataModel: 60,
    note:
      'measured by source: yahoo.chart 39 (30 index symbols + nine G10 pairs) + frankfurter 9 + ' +
      'coingecko.simple 4 + cboe.quotes 2 (`_SPX`, `_VIX`) + cboe.euIndices 1 (BUK100P, which is ' +
      "Cboe-only). §18's ≈60 was an estimate over these same 44 instruments, so 55 sits inside it. " +
      'This row first asserted 46, counting ONE line per instrument and so missing that the nine ' +
      'G10 pairs carry two: a market-data line is per (instrument, source), and both Yahoo and the ' +
      'ECB fixing quote EURUSD. Two sources for one pair is the case `fx_rates` exists to hold, ' +
      'not a double-write',
  },
  {
    label: 'identifiers on the 44 index / FX / crypto instruments',
    sql: `${REFERENCE_INSTRUMENTS}
          SELECT count(*)::int AS n FROM identifiers x JOIN ref ON ref.instrument_id = x.entity_id
           WHERE x.tx_to = 'infinity' AND x.valid_to = 'infinity' AND x.entity_kind = 'instrument'`,
    expected: 91,
    tolerance: 0,
    dataModel: 0,
    note:
      'one TICKER_EXCH per instrument (44) plus 47 PROVIDER_SYMBOL, measured by qualifier: ' +
      'yahoo.chart 39 + coingecko.simple 4 + cboe.euIndices 2 + cboe.quotes 2. NOT one per line: ' +
      'the nine frankfurter lines carry no provider symbol (the ECB publishes the pair code ' +
      'itself), and the one cboe.euIndices line carries two, which is 55 − 9 + 1',
  },
  {
    label: 'index_terms (current)',
    sql: `SELECT count(*)::int AS n FROM index_terms WHERE ${CURRENT}`,
    expected: 31,
    tolerance: 0,
    dataModel: 31,
  },
  {
    label: 'fx_terms (current)',
    sql: `SELECT count(*)::int AS n FROM fx_terms WHERE ${CURRENT}`,
    expected: 9,
    tolerance: 0,
    dataModel: 9,
  },

  // ── module 4, the S&P 500 ───────────────────────────────────────────────────────────────────
  {
    label: 'indices',
    sql: 'SELECT count(*)::int AS n FROM indices',
    expected: 31,
    tolerance: 0,
    dataModel: 31,
  },
  {
    label: 'index_members (current versions, both as-of dates)',
    sql: `SELECT count(*)::int AS n FROM index_members WHERE tx_to = 'infinity'`,
    expected: 998,
    tolerance: 0,
    dataModel: 1_006,
    note:
      "§18's 503 × 2. The 2026-09-14 SSGA snapshot resolves all 503; the 2026-06-30 N-PORT filing " +
      'resolves 495 of its 504 holdings, because N-PORT carries no ticker and nine ' +
      'foreign-domiciled constituents (Accenture PLC, Aon PLC, …) have neither a CUSIP in the ' +
      'filing nor a name that folds onto the SSGA or Wikipedia spelling',
  },
  {
    label: 'etf_holdings',
    sql: 'SELECT count(*)::int AS n FROM etf_holdings',
    expected: 1_009,
    tolerance: 0,
    dataModel: 1_007,
    note:
      "§18's 504 + 503. The SSGA file carries 505 rows: 503 equities, a US DOLLAR cash line and a " +
      'CONTRA line for a pending corporate action. Both are written — an unresolved holding is a ' +
      'row with `holding_instrument_id` NULL, which is what that column is for',
  },
  {
    label: 'entity_classifications (GICS, current)',
    sql: `SELECT count(*)::int AS n FROM entity_classifications
           WHERE ${CURRENT} AND scheme = 'GICS'`,
    expected: 500,
    tolerance: 0,
    dataModel: 503,
    note:
      "§18's 503 counts constituents; `entity_classifications_bt_excl` is keyed " +
      '(entity_kind, entity_id, scheme) and the classification is written on the ISSUER, and three ' +
      'issuers in the index carry two share classes each (GOOGL/GOOG, FOXA/FOX, NWSA/NWS)',
  },
  {
    label: "classification_codes scheme='GICS'",
    sql: `SELECT count(*)::int AS n FROM classification_codes WHERE scheme = 'GICS'`,
    expected: 232,
    tolerance: 0,
    dataModel: 180,
    note:
      'refdata/classifications.ts#GICS_NODES is the full taxonomy: 11 sectors, 25 industry groups, ' +
      '69 industries and 127 sub-industries',
  },
  {
    label: 'fund_terms (current)',
    sql: `SELECT count(*)::int AS n FROM fund_terms WHERE ${CURRENT}`,
    expected: 1,
    tolerance: 0,
    dataModel: 1,
  },
  {
    label: 'entity_relations (current)',
    sql: `SELECT count(*)::int AS n FROM entity_relations WHERE ${CURRENT}`,
    expected: 504,
    tolerance: 0,
    dataModel: 504,
    note: 'SPY holds 503 constituents, and SPY tracks SPX',
  },
];

/**
 * DATA_MODEL §18 rows 6-13, transcribed, with the measured count beside each figure.
 *
 * Measured on a database freshly created, migrated and seeded three times over with the committed
 * fixtures on 2026-09-26 (the second and third runs write nothing — `idempotent.test.ts` is the
 * assertion for that). Every `note` explains a disagreement with §18 **in terms of the fixture**,
 * which is the only explanation worth having: §18's volumes were written before the code, and a
 * number that differs because the recorded capture is smaller than the estimate is a different fact
 * from a number that differs because a leg silently failed.
 */
const LATE_VOLUMES: readonly Volume[] = [
  // ── module 6, Treasuries and reference rates (§18 row 6) ────────────────────────────────────
  {
    label: 'govt_terms (current) — 7 recorded bills + 7 curated notes/bonds',
    sql: `SELECT count(*)::int AS n FROM govt_terms WHERE ${CURRENT}`,
    expected: 25,
    tolerance: 0,
    dataModel: 14,
    note:
      "§18's 14 is 7 bills + 7 curated notes. `treasury-bills.xml` carries 18 distinct CUSIPs over " +
      'the nine recorded sessions of 202609, not the 7 §18 names, and every one of them gets terms ' +
      'because a bill quoted in the file is a bill the desk can ask for; 18 + 7 = 25',
  },
  {
    label: 'rate_terms (current) — the six NY Fed reference rates',
    sql: `SELECT count(*)::int AS n FROM rate_terms WHERE ${CURRENT}`,
    expected: 6,
    tolerance: 0,
    dataModel: 6,
  },
  {
    label: "rate_fixings citing nyfed.rates",
    sql: `SELECT count(*)::int AS n FROM rate_fixings x JOIN provenance p USING (provenance_id)
           WHERE p.source_id = 'nyfed.rates'`,
    expected: 19,
    tolerance: 0,
    dataModel: 30,
    note:
      "§18's ≈30 budgeted the SOFR 5-day and EFFR 10-day back-fill windows in full (6 + 5 + 10 = " +
      '21) plus revisions. The three captures overlap: `/all/latest.json` publishes the same ' +
      'observation the window endpoints do, and a fixing is keyed (rate_code, effective_date), so ' +
      'the union is 19 distinct fixings rather than the sum of the three payloads',
  },
  {
    label: "econ_series for the rate sources (nyfed.rates + fed.h15)",
    sql: `SELECT count(*)::int AS n FROM econ_series WHERE source_id IN ('nyfed.rates', 'fed.h15')`,
    expected: 17,
    tolerance: 0,
    dataModel: 17,
    note: "§18 row 6's 6 rates + 11 H.15 constant-maturity tenors, exactly",
  },
  {
    label: 'econ_observations for the rate sources',
    sql: `SELECT count(*)::int AS n FROM econ_observations x JOIN provenance p USING (provenance_id)
           WHERE p.source_id IN ('nyfed.rates', 'fed.h15')`,
    expected: 73,
    tolerance: 0,
    dataModel: 100,
    note:
      "§18's ≈100 over 6 rate series and 11 H.15 series. Measured by source: nyfed.rates 18 (the " +
      'headline observation of each rate on each distinct date the three captures publish) + ' +
      'fed.h15 55 (11 tenors × the five business days `fed-h15.csv` carries)',
  },

  // ── module 7, the curves (§18 row 7) ────────────────────────────────────────────────────────
  {
    label: 'curves',
    sql: 'SELECT count(*)::int AS n FROM curves',
    expected: 5,
    tolerance: 0,
    dataModel: 5,
  },
  {
    label: 'curve_points (all five curves)',
    sql: 'SELECT count(*)::int AS n FROM curve_points',
    expected: 313,
    tolerance: 0,
    dataModel: 300,
    note:
      'measured per curve: UST_PAR 126 and UST_BILL 126 (nine recorded sessions × 14 par tenors / ' +
      '7 bills × 2 quote types), UST_CMT 44 (11 tenors × 4 of the five H.15 days that carry a full ' +
      "row), SOFR_FIX 5, SOFR_OIS 12. §18's ≈300 is these same five curves",
  },
  {
    label: 'curve_builds (SOFR_OIS, latest date)',
    sql: 'SELECT count(*)::int AS n FROM curve_builds',
    expected: 1,
    tolerance: 0,
    dataModel: 1,
  },

  // ── module 8, bars, FX and corporate actions (§18 row 8) ────────────────────────────────────
  {
    label: 'bars_daily',
    sql: 'SELECT count(*)::int AS n FROM bars_daily',
    expected: 1_264,
    tolerance: 0,
    dataModel: 1_450,
    note:
      'measured by capture: 1,255 from `yahoo-chart-events` (AAPL 1d/5y) + 9 daily FX closes from ' +
      "the frankfurter fixing. §18's ≈1,450 also credited the 169 quarterly rows of " +
      '`yahoo-chart-AAPL-max-1d.json`, and NO `bars_daily` row cites that capture: its five ' +
      '`corporate_actions` rows are its whole contribution, which is what its own entry in ' +
      "`seed/bars.ts#CHART_BACKFILL` says it was taken for ('taken for its five splits')",
  },
  {
    label: 'bars_intraday',
    sql: 'SELECT count(*)::int AS n FROM bars_intraday',
    expected: 1_033,
    tolerance: 0,
    dataModel: 1_110,
    note:
      'measured by capture: ^FTSE 5m/1d 103 + ^GSPC 5m/5d 376 + AAPL 1m/1d 317 (the two polls four ' +
      'minutes apart, merged on the primary key) + EURUSD=X 5m/1d 237. The difference from §18’s ' +
      "≈1,110 is ^TNX's 75 bars: `yahoo-bond` is recorded, but `seed/universe.ts` mints no " +
      '`yahoo.chart` md line for ^TNX, so the leg reports "fetched 1" for two symbols and the ' +
      'capture is never read. 1,033 + 75 = 1,108',
  },
  {
    label: 'fx_rates citing the frankfurter fixing',
    sql: `SELECT count(*)::int AS n FROM fx_rates x JOIN provenance p USING (provenance_id)
           WHERE p.source_id = 'frankfurter'`,
    expected: 58,
    tolerance: 0,
    dataModel: 29,
    note:
      "§18's 29 is the number of rates the capture publishes against base USD. Each is stored in " +
      'both directions — USD→XXX and XXX→USD, 58 distinct (base, quote) pairs — because a screen ' +
      'asks for the pair the market quotes and inverting at read time is how a rate acquires a ' +
      'rounding error nobody can trace',
  },
  {
    label: 'corporate_actions (current) — AAPL dividends and splits',
    sql: `SELECT count(*)::int AS n FROM corporate_actions WHERE ${CURRENT}`,
    expected: 25,
    tolerance: 0,
    dataModel: 24,
    note:
      '20 dividends from the 5y events capture + 5 splits from the max capture (2014-06-09 7:1, ' +
      "2020-08-31 4:1 and three older 2:1s). §18's ≈24 counted four splits",
  },

  // ── module 9, options and top-of-book quotes (§18 row 9) ────────────────────────────────────
  {
    label: 'option_terms (current) — the AAPL chain',
    sql: `SELECT count(*)::int AS n FROM option_terms WHERE ${CURRENT}`,
    expected: 3_510,
    tolerance: 0,
    dataModel: 3_510,
  },
  {
    label: 'option_quotes',
    sql: 'SELECT count(*)::int AS n FROM option_quotes',
    expected: 3_510,
    tolerance: 0,
    dataModel: 3_510,
  },
  {
    label: 'quote_ticks',
    sql: 'SELECT count(*)::int AS n FROM quote_ticks',
    expected: 5,
    tolerance: 0,
    dataModel: 4,
    note:
      'measured by source: cboe.quotes 3 (AAPL, _SPX, _VIX) + cboe.euIndices 1 (BUK100P) + ' +
      "cboe.options 1 — the chain capture carries the underlying's top of book and the normaliser " +
      "records it like any other tick. §18's 4 counted the four polled subjects",
  },
  {
    label: 'quote_snapshots (the plant warm start)',
    sql: 'SELECT count(*)::int AS n FROM quote_snapshots',
    expected: 4,
    tolerance: 0,
    dataModel: 4,
  },
  {
    label: 'eod_snapshots',
    sql: 'SELECT count(*)::int AS n FROM eod_snapshots',
    expected: 4,
    tolerance: 0,
    dataModel: 4,
  },

  // ── module 10, fundamentals (§18 row 10) ────────────────────────────────────────────────────
  {
    label: "xbrl_facts for the one recorded CIK (0000320193)",
    sql: `SELECT count(*)::int AS n FROM xbrl_facts WHERE cik = '0000320193'`,
    expected: 25_116,
    tolerance: 0,
    dataModel: 40_000,
    note:
      "§18's ≈40k is the estimate for 503 us-gaap + 2 dei concepts; the recorded 3.7 MB capture " +
      'normalises to exactly 25,116 facts, which is the number `test/replay/fundamentals/' +
      'companyfacts.test.ts` measures from the same bytes. The largest table in the seed, and until ' +
      'this row it was asserted nowhere',
  },
  {
    label: 'filings for the two recorded filers',
    sql: `SELECT count(*)::int AS n FROM filings WHERE cik IN ('0000320193', '0000884394')`,
    expected: 1_275,
    tolerance: 0,
    dataModel: 1_275,
    note: '1,000 AAPL + 275 SPY, the exact sizes of the two submissions captures',
  },
  {
    label: 'xbrl_frames (Assets CY2024Q4I)',
    sql: `SELECT count(*)::int AS n FROM xbrl_frames
           WHERE taxonomy = 'us-gaap' AND concept = 'Assets' AND unit = 'USD' AND frame = 'CY2024Q4I'`,
    expected: 6_264,
    tolerance: 0,
    dataModel: 6_264,
  },
  {
    label: 'xbrl_concept_map (std-map/2026.09)',
    sql: `SELECT count(*)::int AS n FROM xbrl_concept_map WHERE mapping_version = 'std-map/2026.09'`,
    expected: 40,
    tolerance: 0,
    dataModel: 90,
    note:
      "§18's ≈90 counted concept rungs; `fixtures/seed/concept-map.json` maps 40 (standard item, " +
      'concept) pairs, which is `providers/sec/parse.ts#XBRL_CONCEPT_MAP`',
  },
  {
    label: "fin_statements period_type='FY'",
    sql: `SELECT count(*)::int AS n FROM fin_statements WHERE period_type = 'FY'`,
    expected: 72,
    tolerance: 0,
    dataModel: 0,
    note: 'one per (fiscal year, filing) the capture supports; see the TTM row for why §18 is split',
  },
  {
    label: "fin_statements period_type='Q'",
    sql: `SELECT count(*)::int AS n FROM fin_statements WHERE period_type = 'Q'`,
    expected: 285,
    tolerance: 0,
    dataModel: 0,
    note: 'reported quarters plus the derived Q4 of each fiscal year, one per (period, filing)',
  },
  {
    label: "fin_statements period_type='TTM' (the row that was zero)",
    sql: `SELECT count(*)::int AS n FROM fin_statements WHERE period_type = 'TTM'`,
    expected: 260,
    tolerance: 0,
    dataModel: 0,
    note:
      'ASSERTED BECAUSE IT WAS ZERO. §18 row 10 asks for `AAPL Q/FY/TTM` and the table held no TTM ' +
      'row through WP-10 to WP-14, so `DES` blanked epsTtmDil/revenueTtm/netIncomeTtm/peTtm and ' +
      'reported NO_SOURCE on an issuer with 25,116 facts stored. One roll-up per quarter anchor ' +
      'that has three trailing quarters at or before its own filing date ' +
      '(`ingest/jobs/secCompanyFacts.ts#deriveTtm`); the identity is asserted in ' +
      'test/replay/fundamentals/companyfacts.test.ts',
  },
  {
    label: 'fin_statements (std-map/2026.09, all period types)',
    sql: `SELECT count(*)::int AS n FROM fin_statements WHERE mapping_version = 'std-map/2026.09'`,
    expected: 617,
    tolerance: 0,
    dataModel: 120,
    note:
      "§18's ≈120 counts PERIODS; the table is keyed (issuer, period_end, period_type, filed_at, " +
      'mapping_version) because a statement is point-in-time, so a period restated by a later ' +
      'filing exists once per filing. 628 (period, filing) rows are built from the capture — 363 ' +
      'reported plus 265 TTM roll-ups — and eleven collide on the primary key (two filings of the ' +
      'same date reporting the same period), leaving 617',
  },
  {
    label: 'issuer_aliases (SEC formerNames)',
    sql: `SELECT count(*)::int AS n FROM issuer_aliases`,
    expected: 4,
    tolerance: 0,
    dataModel: 0,
    note:
      '§18 gives no figure. The two submissions captures carry four `formerNames` entries between ' +
      'them; a fifth would mean the parser widened',
  },
  {
    label: 'short_interest (the one FINRA settlement date)',
    sql: `SELECT count(*)::int AS n FROM short_interest WHERE settlement_date = '2020-04-15'`,
    expected: 1,
    tolerance: 0,
    dataModel: 1,
  },

  // ── module 11, news, people and econ (§18 row 11) ───────────────────────────────────────────
  {
    label: 'topics (the thirteen v1 codes)',
    sql: 'SELECT count(*)::int AS n FROM topics',
    expected: 13,
    tolerance: 0,
    dataModel: 13,
  },
  {
    label: 'news_items from the three recorded feed families',
    sql: `SELECT count(*)::int AS n FROM news_items
           WHERE source_id IN ('bbg.rss', 'sec.atom', 'fed.rss')`,
    expected: 160,
    tolerance: 0,
    dataModel: 160,
    note: '5 Bloomberg feeds × 20 + 40 SEC 8-K entries + 20 Fed press releases, exactly',
  },
  {
    label: 'news_entity_links',
    sql: 'SELECT count(*)::int AS n FROM news_entity_links',
    expected: 223,
    tolerance: 0,
    dataModel: 200,
    note:
      "§18's ≈200. The seed log reports 223 links over 160 stories with 0 unlinked; the number is " +
      'the resolver, so it moves when a ticker or an issuer name stops resolving — which is exactly ' +
      'the regression this row exists to catch, and it had no assertion at all',
  },
  {
    label: 'people (bylines from the recorded feeds)',
    sql: `SELECT count(*)::int AS n FROM people x JOIN provenance p USING (provenance_id)
           WHERE p.source_id = 'bbg.rss'`,
    expected: 102,
    tolerance: 0,
    dataModel: 60,
    note:
      "§18's ≈60 was an estimate of distinct authors. All 102 come from `bbg.rss`: the 100 " +
      'Bloomberg stories name 102 distinct bylines because a story is often co-written and the SEC ' +
      'and Fed feeds carry no author at all. A count far above this would mean the byline parser ' +
      'stopped folding "A and B" into two people',
  },
  {
    label: 'econ_series (every source)',
    sql: 'SELECT count(*)::int AS n FROM econ_series',
    expected: 26,
    tolerance: 0,
    dataModel: 70,
    note:
      'measured by source: nyfed.rates 6 + fed.h15 11 + fred.csv 1 (DGS10) + bls.timeseries 1 ' +
      "(CPI) + imf.datamapper 6 + worldbank 1. §18 row 11's ≈70 budgeted the full IMF WEO and " +
      'World Bank indicator sets; the seed log says "imf: 6 indicator(s) have no recorded capture", ' +
      'and a series with no observations is a series this seed must not invent (FEED-08)',
  },
  {
    label: 'econ_observations (every source)',
    sql: 'SELECT count(*)::int AS n FROM econ_observations',
    expected: 16_987,
    tolerance: 0,
    dataModel: 17_000,
    note:
      'measured by source: fred.csv 16,879 (the DGS10 history) + fed.h15 55 + bls.timeseries 32 + ' +
      "nyfed.rates 18 + worldbank 3. §18's ≈17k, and the second-largest table in the seed — " +
      'asserted nowhere before this row',
  },
  {
    label: 'econ_releases',
    sql: 'SELECT count(*)::int AS n FROM econ_releases',
    expected: 49,
    tolerance: 0,
    dataModel: 40,
    note: "the releases named by `fred-releases.html` and `bls-schedule.html`; §18's ≈40",
  },
  {
    label: 'econ_release_events',
    sql: 'SELECT count(*)::int AS n FROM econ_release_events',
    expected: 50,
    tolerance: 0,
    dataModel: 60,
    note:
      "§18's ≈60 over the recorded calendar window; the two calendar captures schedule 50 events, " +
      'and `fixtures/seed/fomc-2026.json` supplies the eight FOMC meetings separately',
  },
  {
    label: 'fomc_meetings (2026)',
    sql: `SELECT count(*)::int AS n FROM fomc_meetings
           WHERE meeting_date >= '2026-01-01' AND meeting_date < '2027-01-01'`,
    expected: 8,
    tolerance: 0,
    dataModel: 8,
  },

  // ── module 12, the desk (§18 row 12) ────────────────────────────────────────────────────────
  {
    label: 'firms',
    sql: `SELECT count(*)::int AS n FROM firms WHERE name IN ('Demo Capital', 'Other Desk')`,
    expected: 2,
    tolerance: 0,
    dataModel: 2,
  },
  {
    label: 'users',
    sql: `SELECT count(*)::int AS n FROM users WHERE email LIKE '%@demo.terminal' OR email LIKE '%@newsco.terminal'`,
    expected: 7,
    tolerance: 0,
    dataModel: 7,
  },
  {
    label: 'entitlement_grants (current)',
    sql: `SELECT count(*)::int AS n FROM entitlement_grants WHERE valid_to = 'infinity'`,
    expected: 8,
    tolerance: 0,
    dataModel: 8,
    note: 'two firm grants and six user grants; `compliance@demo` deliberately holds none',
  },
  {
    label: 'quota_limits',
    sql: 'SELECT count(*)::int AS n FROM quota_limits',
    expected: 2,
    tolerance: 0,
    dataModel: 2,
  },
  {
    label: 'surveillance_lexicon (global)',
    sql: 'SELECT count(*)::int AS n FROM surveillance_lexicon WHERE firm_id IS NULL AND active',
    expected: 12,
    tolerance: 0,
    dataModel: 12,
  },
  {
    label: 'rooms',
    sql: 'SELECT count(*)::int AS n FROM rooms',
    expected: 2,
    tolerance: 0,
    dataModel: 2,
  },
  {
    label: 'messages',
    sql: 'SELECT count(*)::int AS n FROM messages',
    expected: 6,
    tolerance: 0,
    dataModel: 6,
  },

  // ── module 13, workspaces, watchlists and portfolios (§18 row 13) ───────────────────────────
  {
    label: 'workspaces (one default per seeded user)',
    sql: 'SELECT count(*)::int AS n FROM workspaces',
    expected: 7,
    tolerance: 0,
    dataModel: 7,
  },
  {
    label: 'watchlists',
    sql: 'SELECT count(*)::int AS n FROM watchlists',
    expected: 3,
    tolerance: 0,
    dataModel: 3,
    note: "'MAG7', 'S&P 500 Top 25' and 'Core'",
  },
  {
    label: 'watchlist_items',
    sql: 'SELECT count(*)::int AS n FROM watchlist_items',
    expected: 37,
    tolerance: 0,
    dataModel: 0,
    note: '§18 gives no figure: 7 + 25 + 5, and every one resolved to an instrument',
  },
  {
    label: 'portfolios',
    sql: 'SELECT count(*)::int AS n FROM portfolios',
    expected: 1,
    tolerance: 0,
    dataModel: 1,
  },
  {
    label: 'lots',
    sql: 'SELECT count(*)::int AS n FROM lots',
    expected: 12,
    tolerance: 0,
    dataModel: 12,
  },
  {
    label: 'positions',
    sql: 'SELECT count(*)::int AS n FROM positions',
    expected: 12,
    tolerance: 0,
    dataModel: 12,
  },
];

describe('seed — DATA_MODEL §18 volumes for modules 2-5 (seed/universe.ts)', () => {
  const t = withTxDb();

  async function count(sql: string): Promise<number> {
    const res = await t.client.query<{ n: number }>(sql);
    return res.rows[0]?.n ?? -1;
  }

  it('ran at all — the universe pass wrote instruments', async () => {
    const n = await count(
      `SELECT count(*)::int AS n FROM instruments WHERE ${CURRENT} AND ${OWN_CLASSES}`,
    );
    expect(
      n,
      'no instrument in the asset classes modules 2-5 own: seed/universe.ts did not run, so every ' +
        'volume below would fail for one reason rather than for its own. Run `npm run db:seed` ' +
        '(globalSetup does it for the test database).',
    ).toBeGreaterThan(0);
  });

  for (const volume of VOLUMES) {
    it(`${volume.label} ≈ ${String(volume.expected)}`, async () => {
      const actual = await count(volume.sql);
      const low = Math.floor(volume.expected * (1 - volume.tolerance));
      const high = Math.ceil(volume.expected * (1 + volume.tolerance));
      const message =
        `${volume.label}: seeded ${String(actual)}, expected ${String(volume.expected)} ` +
        `(accepted ${String(low)}–${String(high)}, tolerance ±${String(volume.tolerance * 100)}%); ` +
        `DATA_MODEL §18 says ${volume.dataModel === 0 ? 'nothing about this row' : `≈${String(volume.dataModel)}`}` +
        (volume.note === undefined ? '' : ` — ${volume.note}`);
      expect(actual, message).toBeGreaterThanOrEqual(low);
      expect(actual, message).toBeLessThanOrEqual(high);
    });
  }

  /**
   * §18 row 4 budgets ≈440 `SIC` codes and no recorded capture carries a SIC code *list*.
   * `sec-submissions-*.json` carries one `sic` per filer, so module 10 may legitimately add a
   * handful; a taxonomy-sized table would mean somebody typed 440 code/name pairs in, which is
   * exactly the "plausible number with no provenance" DATA-10 forbids. The bound is what is
   * assertable: few is evidence, 440 is invention.
   */
  it('has no invented SIC taxonomy', async () => {
    const actual = await count(
      `SELECT count(*)::int AS n FROM classification_codes WHERE scheme = 'SIC'`,
    );
    expect(
      actual,
      `classification_codes scheme='SIC': ${String(actual)} rows. DATA_MODEL §18 row 4 budgets ` +
        '≈440, and nothing in fixtures/providers/raw carries a SIC code list — only one `sic` per ' +
        'filer in sec-submissions-*.json, which module 10 reads. A count in the hundreds means the ' +
        'taxonomy was typed in rather than sourced.',
    ).toBeLessThan(50);
  });
});

/**
 * The same assertion shape over §18 rows 6-13.
 *
 * A separate `describe` rather than more entries in `VOLUMES` because the guard test differs: this
 * half is meaningless unless modules 6-13 ran, and "seed/universe.ts did not run" is a different
 * diagnosis from "seed/fundamentals.ts did not run". Reporting the wrong one is how a reader spends
 * twenty minutes on the wrong module.
 */
describe('seed — DATA_MODEL §18 volumes for modules 6-13', () => {
  const t = withTxDb();

  async function count(sql: string): Promise<number> {
    const res = await t.client.query<{ n: number }>(sql);
    return res.rows[0]?.n ?? -1;
  }

  it('ran at all — the fundamentals pass wrote facts', async () => {
    const n = await count(`SELECT count(*)::int AS n FROM xbrl_facts WHERE cik = '0000320193'`);
    expect(
      n,
      'no xbrl_facts row for the one recorded CIK: seed/fundamentals.ts did not run, so every ' +
        'volume below would fail for one reason rather than for its own. Run `npm run db:seed` ' +
        '(globalSetup does it for the seed test database when SEED_TEST_DB is set).',
    ).toBeGreaterThan(0);
  });

  for (const volume of LATE_VOLUMES) {
    it(`${volume.label} ≈ ${String(volume.expected)}`, async () => {
      const actual = await count(volume.sql);
      const low = Math.floor(volume.expected * (1 - volume.tolerance));
      const high = Math.ceil(volume.expected * (1 + volume.tolerance));
      const message =
        `${volume.label}: seeded ${String(actual)}, expected ${String(volume.expected)} ` +
        `(accepted ${String(low)}–${String(high)}, tolerance ±${String(volume.tolerance * 100)}%); ` +
        `DATA_MODEL §18 says ${volume.dataModel === 0 ? 'nothing about this row' : `≈${String(volume.dataModel)}`}` +
        (volume.note === undefined ? '' : ` — ${volume.note}`);
      expect(actual, message).toBeGreaterThanOrEqual(low);
      expect(actual, message).toBeLessThanOrEqual(high);
    });
  }

  /**
   * The TTM third, stated as a property rather than as one more count.
   *
   * §18 row 10 asks for `Q/FY/TTM` and the table held 72 FY, 285 Q and **zero** TTM, which is the
   * defect the grouped rows above now make visible as a number. This is the assertion that keeps it
   * visible if somebody widens a tolerance: all three types must be present, and the TTM third must
   * be within a factor of two of the quarterly count, because a TTM row exists for every quarter
   * anchor that has three trailing quarters behind it and that is most of them.
   */
  it('has all three period types, not two (DATA_MODEL §18 row 10)', async () => {
    const res = await t.client.query<{ period_type: string; n: number }>(
      `SELECT period_type, count(*)::int AS n FROM fin_statements GROUP BY 1 ORDER BY 1`,
    );
    const byType = new Map(res.rows.map((r) => [r.period_type, r.n]));
    expect(
      [...byType.keys()].sort(),
      'fin_statements is missing a period type §18 row 10 names. A zero here is not a small gap: ' +
        'DES asks for `{ periodType: "TTM", periods: 1 }` and reports NO_SOURCE when it finds ' +
        'nothing, which is a lie about a database holding 25,116 facts for that CIK.',
    ).toEqual(['FY', 'Q', 'TTM']);
    const q = byType.get('Q') ?? 0;
    const ttm = byType.get('TTM') ?? 0;
    expect(ttm, `TTM ${String(ttm)} against Q ${String(q)}`).toBeGreaterThan(q / 2);
  });
});

describe('seed — DATA-10 for the tables modules 2-5 write', () => {
  const t = withTxDb();

  /** Every value-bearing table modules 2-5 write. */
  const TABLES: readonly string[] = [
    'issuers',
    'issues',
    'instruments',
    'listings',
    'md_lines',
    'identifiers',
    'index_members',
    'etf_holdings',
    'entity_classifications',
    'entity_relations',
    'index_terms',
    'fx_terms',
    'fund_terms',
  ];

  it('every row carries a provenance_id that resolves to a provenance row', async () => {
    for (const table of TABLES) {
      const res = await t.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} x
          WHERE NOT EXISTS (SELECT 1 FROM provenance p WHERE p.provenance_id = x.provenance_id)`,
      );
      expect(res.rows[0]?.n, `${table} has rows whose provenance_id resolves to nothing`).toBe(0);
    }
  });

  it('cites every fixture DATA_MODEL §18 rows 2-5 names', async () => {
    const union = TABLES.map((table) => `SELECT provenance_id FROM ${table}`).join(' UNION ');
    const res = await t.client.query<{ source_id: string }>(
      `SELECT DISTINCT source_id FROM provenance WHERE provenance_id IN (${union}) ORDER BY source_id`,
    );
    const cited = new Set(res.rows.map((row) => row.source_id));

    // §18 rows 2-5's fixture column, by `licence_registry.source_id`. A missing one means a capture
    // §18 names went unread and whatever it was meant to supply is silently absent from the seed.
    // (`internal.derived` is not here: the calendar tables carry a `source_id` and no
    // `provenance_id`, so they are not part of this join — see the module header of seed/universe.ts.)
    for (const required of [
      'cboe.symbolBook',
      'sec.tickers',
      'openfigi.mapping',
      'sec.archives',
      'ssga.holdings',
      'wiki.sp500',
      'cboe.quotes',
      'cboe.euIndices',
      'yahoo.chart',
      'coingecko.simple',
    ]) {
      expect(
        [...cited].sort(),
        `no seeded value cites ${required}, which DATA_MODEL §18 rows 2-5 name as a fixture`,
      ).toContain(required);
    }
  });

  it('keeps the one curated-input exception to exactly one hash-pinned row', async () => {
    // `licence_registry` defines `internal.user` as "uploads, seed", and module 5's reference table
    // of 31 indices, 9 currency pairs and 4 crypto assets is the one place this seed is its own
    // source (no capture names the FTSE MIB's currency). Its provenance bytes ARE that table, so the
    // `request_key` pins the exact list. One row, one url: if the escape hatch ever spreads to a
    // second shape, that is the thing to notice.
    const res = await t.client.query<{ request_url: string; bytes: number }>(
      `SELECT request_url, bytes FROM provenance
        WHERE source_id = 'internal.user' AND request_url LIKE 'seed://universe/%'
        ORDER BY request_url`,
    );
    expect(
      res.rows.map((row) => row.request_url),
      'seed/universe.ts should cite exactly one curated input, the module 5 reference table',
    ).toEqual(['seed://universe/reference']);
    expect(
      res.rows[0]?.bytes,
      'the curated provenance must carry the serialised table',
    ).toBeGreaterThan(1_000);
  });

  it('every provenance row those tables cite has bytes behind it', async () => {
    const union = TABLES.map((table) => `SELECT provenance_id FROM ${table}`).join(' UNION ');
    const res = await t.client.query<{
      source_id: string;
      request_url: string;
      bytes: number;
      response_sha256: Buffer;
    }>(
      `SELECT p.source_id, p.request_url, p.bytes, p.response_sha256
         FROM provenance p WHERE p.provenance_id IN (${union})`,
    );
    expect(res.rows.length, 'the seeded tables cite no provenance at all').toBeGreaterThan(0);

    // Not "is this key in the manifest": a sibling seed module may legitimately cite a
    // `fixtures/seed/*.json` curated input under its own `seed:` url. What every row must have is a
    // non-empty body and a digest of it, which is what makes `Ctrl+I` able to show anything at all.
    const empty = res.rows.filter((row) => row.bytes <= 0 || row.response_sha256.length !== 32);
    expect(
      empty.map((row) => `${row.source_id} ${row.request_url} bytes=${String(row.bytes)}`),
      'these provenance rows have no bytes or no digest — a seeded value with nothing reachable ' +
        'behind it (DATA-10)',
    ).toEqual([]);
  });
});
