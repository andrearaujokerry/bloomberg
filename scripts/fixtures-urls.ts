/**
 * `scripts/fixtures-urls.ts` — the hand-maintained map from a recorded fixture file to the exact
 * request it was captured from (PROVIDERS §3.4, §16.9-16.10; WORKPLAN §1.10, §18.10).
 *
 * The 48 files in `fixtures/providers/raw/` were captured by hand on 2026-09-15 and named for
 * humans (`yahoo-fx`, `cboe-spx`, `frankfurter`); several have no extension and none encode the
 * host or the query string. The replay store keys captures by
 * `sha256(providerId|METHOD|canonicalUrl|sha256(body))`, so the request has to be reconstructed
 * from this table — `scripts/fixtures-import.ts` treats an unmapped file as a hard error, so a
 * fixture added without a URL cannot go unnoticed.
 *
 * Two rules matter more than they look:
 *
 * 1. **Bloomberg entries record the post-redirect URL.** `feeds.bloomberg.com/<feed>/news.rss`
 *    301s to `www.bloomberg.com/feeds/<feed>/news.rss`, and `RawRecord.url` is the post-redirect
 *    canonical URL (PROVIDERS §1.1, §11.1), so the key is computed on the `www.bloomberg.com` form.
 *    Recording the `feeds.` form here would make every Bloomberg capture miss.
 * 2. **`body` is the exact bytes sent**, not a re-serialised object: two orderings of the same JSON
 *    are two different keys, deliberately (PROVIDERS §3.2). OpenFIGI's job array is the only body.
 *
 * `sourceTsPath` / `capturedAtPath` are JSON pointers into the payload; only the providers whose
 * payload carries a published instant have one (PROVIDERS §3.4 step 3-4). Everything else falls
 * back to the file's recorded mtime for `capturedAt` and to `null` for `sourceTs`.
 */

/**
 * The provider ids of PROVIDERS §15. Mirrors `server/src/providers/types.ts#ProviderId` (WP-05);
 * it is restated here because the scripts run before that module exists and must not import from
 * a package's `src/` to get a string union.
 */
export type ProviderId =
  | 'cboe.quotes'
  | 'cboe.options'
  | 'cboe.symbolBook'
  | 'cboe.euIndices'
  | 'yahoo.chart'
  | 'yahoo.search'
  | 'openfigi.mapping'
  | 'sec.tickers'
  | 'sec.submissions'
  | 'sec.companyfacts'
  | 'sec.frames'
  | 'sec.atom'
  | 'sec.archives'
  | 'ssga.holdings'
  | 'treasury.yieldcurve'
  | 'treasury.bills'
  | 'fred.csv'
  | 'fred.calendar'
  | 'fed.h15'
  | 'fed.rss'
  | 'fed.fomc'
  | 'nyfed.rates'
  | 'bls.timeseries'
  | 'bls.schedule'
  | 'worldbank'
  | 'imf.datamapper'
  | 'frankfurter'
  | 'finra.shortInterest'
  | 'bbg.rss'
  | 'coingecko.simple'
  | 'wiki.sp500';

export interface FixtureUrl {
  readonly providerId: ProviderId;
  readonly method: 'GET' | 'POST';
  /** The post-redirect URL, exactly as the client would spell it before canonicalisation. */
  readonly url: string;
  /** The exact request body string; part of the key. */
  readonly body?: string;
  /** JSON pointer to the provider-published instant → `capture.sourceTs`. */
  readonly sourceTsPath?: string;
  /** JSON pointer to the instant the payload was produced → `capture.capturedAt`. */
  readonly capturedAtPath?: string;
}

const CBOE_QUOTES = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TREASURY_XML =
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml';
const NYFED = 'https://markets.newyorkfed.org/api/rates';
const BBG_FEED = 'https://www.bloomberg.com/feeds';

/**
 * One entry per file in `fixtures/providers/raw/` (48 on disk — BRIEF §2's "50" is corrected in
 * WORKPLAN §18.14). Keys are the file names exactly as recorded.
 */
export const FIXTURE_URLS: Record<string, FixtureUrl> = {
  /* ---------------------------------------------------------------- Cboe (PROVIDERS §5.1-5.4) */
  'cboe-quote-AAPL.json': {
    providerId: 'cboe.quotes',
    method: 'GET',
    url: `${CBOE_QUOTES}/AAPL.json`,
    sourceTsPath: '/timestamp',
  },
  'cboe-spx': {
    providerId: 'cboe.quotes',
    method: 'GET',
    url: `${CBOE_QUOTES}/_SPX.json`,
    sourceTsPath: '/timestamp',
  },
  'cboe-vix': {
    providerId: 'cboe.quotes',
    method: 'GET',
    url: `${CBOE_QUOTES}/_VIX.json`,
    sourceTsPath: '/timestamp',
  },
  'cboe-options': {
    providerId: 'cboe.options',
    method: 'GET',
    url: 'https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json',
    sourceTsPath: '/timestamp',
  },
  'cboe-symbol-book.json': {
    providerId: 'cboe.symbolBook',
    method: 'GET',
    url: 'https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/symbol-book.json',
    sourceTsPath: '/timestamp',
  },
  // The European payload's `timestamp` is a bare time-of-day ("16:59:53"), not an instant, so it
  // carries no sourceTsPath (PROVIDERS §5.4).
  'cboe-eu-indices': {
    providerId: 'cboe.euIndices',
    method: 'GET',
    url: 'https://cdn.cboe.com/api/global/european_indices/index_quotes/BUK100P.json',
  },

  /* --------------------------------------------------------------- Yahoo (PROVIDERS §5.5-5.6) */
  // yahoo-chart-1m and yahoo-chart-AAPL-1d-1m.json are the SAME request four minutes apart and
  // therefore collide on one requestKey — the reason manifest entries carry `captures[]`
  // (PROVIDERS §3.3, "Addition required").
  'yahoo-chart-1m': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/AAPL?range=1d&interval=1m`,
    capturedAtPath: '/chart/result/0/meta/regularMarketTime',
  },
  'yahoo-chart-AAPL-1d-1m.json': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/AAPL?range=1d&interval=1m`,
    capturedAtPath: '/chart/result/0/meta/regularMarketTime',
  },
  'yahoo-chart-AAPL-max-1d.json': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/AAPL?range=max&interval=1d&events=div%7Csplit`,
  },
  'yahoo-chart-events': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/AAPL?range=5y&interval=1d&events=div%7Csplit`,
  },
  'yahoo-chart-SPX-5d-5m.json': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/%5EGSPC?range=5d&interval=5m`,
  },
  'yahoo-ftse': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/%5EFTSE?range=1d&interval=5m`,
  },
  'yahoo-fx': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/EURUSD%3DX?range=1d&interval=5m`,
  },
  'yahoo-bond': {
    providerId: 'yahoo.chart',
    method: 'GET',
    url: `${YAHOO_CHART}/%5ETNX?range=1d&interval=5m`,
  },
  'yahoo-search': {
    providerId: 'yahoo.search',
    method: 'GET',
    url: 'https://query2.finance.yahoo.com/v1/finance/search?newsCount=0&q=apple&quotesCount=8',
  },

  /* ------------------------------------------------------------------ FX, crypto (§5.7, §5.8) */
  frankfurter: {
    providerId: 'frankfurter',
    method: 'GET',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD',
    sourceTsPath: '/date',
  },
  'coingecko-simple.json': {
    providerId: 'coingecko.simple',
    method: 'GET',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum&include_24hr_change=true&vs_currencies=usd',
  },

  /* ----------------------------------------------------------------- OpenFIGI (PROVIDERS §6) */
  // Two jobs, in this order: the response array is positionally parallel to the request array, and
  // the recorded payload answers job 0 with the single US composite and job 1 with all 275 venues
  // of the unqualified ticker.
  'openfigi-map': {
    providerId: 'openfigi.mapping',
    method: 'POST',
    url: 'https://api.openfigi.com/v3/mapping',
    body: '[{"idType":"TICKER","idValue":"AAPL","exchCode":"US"},{"idType":"TICKER","idValue":"AAPL"}]',
  },
  'openfigi-search': {
    providerId: 'openfigi.mapping',
    method: 'POST',
    url: 'https://api.openfigi.com/v3/search',
    body: '{"query":"apple","exchCode":"US"}',
  },

  /* --------------------------------------------------------------- SEC EDGAR (PROVIDERS §7-8) */
  'sec-company-tickers.json': {
    providerId: 'sec.tickers',
    method: 'GET',
    url: 'https://www.sec.gov/files/company_tickers.json',
  },
  'sec-submissions-AAPL.json': {
    providerId: 'sec.submissions',
    method: 'GET',
    url: 'https://data.sec.gov/submissions/CIK0000320193.json',
  },
  'sec-spy-submissions.json': {
    providerId: 'sec.submissions',
    method: 'GET',
    url: 'https://data.sec.gov/submissions/CIK0000884394.json',
  },
  'sec-companyfacts-AAPL.json': {
    providerId: 'sec.companyfacts',
    method: 'GET',
    url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',
  },
  'sec-frames-assets.json': {
    providerId: 'sec.frames',
    method: 'GET',
    url: 'https://data.sec.gov/api/xbrl/frames/us-gaap/Assets/USD/CY2024Q4I.json',
  },
  'sec-8k-atom.xml': {
    providerId: 'sec.atom',
    method: 'GET',
    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&count=40&output=atom&type=8-K',
  },
  'sec-nport-SPY-primary_doc.xml': {
    providerId: 'sec.archives',
    method: 'GET',
    url: 'https://www.sec.gov/Archives/edgar/data/884394/000141036826089410/primary_doc.xml',
  },
  'ssga-spy-holdings.xlsx': {
    providerId: 'ssga.holdings',
    method: 'GET',
    url: 'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx',
  },
  'wiki-sp500.html': {
    providerId: 'wiki.sp500',
    method: 'GET',
    url: 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies',
  },

  /* ---------------------------------------------------------------- Treasury (PROVIDERS §9) */
  // Both feeds are the September 2026 month file: nine business days, 2026-09-01 … 2026-09-15.
  'treasury-xml2': {
    providerId: 'treasury.yieldcurve',
    method: 'GET',
    url: `${TREASURY_XML}?data=daily_treasury_yield_curve&field_tdr_date_value_month=202609`,
  },
  'treasury-bills.xml': {
    providerId: 'treasury.bills',
    method: 'GET',
    url: `${TREASURY_XML}?data=daily_treasury_bill_rates&field_tdr_date_value_month=202609`,
  },

  /* ------------------------------------------------- Macro, rates and calendars (§10, §12) */
  'fred-DGS10.csv': {
    providerId: 'fred.csv',
    method: 'GET',
    url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10',
  },
  'fred-cal': {
    providerId: 'fred.calendar',
    method: 'GET',
    url: 'https://fred.stlouisfed.org/releases/calendar',
  },
  'fred-releases.html': {
    providerId: 'fred.calendar',
    method: 'GET',
    url: 'https://fred.stlouisfed.org/releases',
  },
  // `series` is the H.15 download package for the eleven nominal constant-maturity series the
  // recorded CSV carries (RIFLGFCM01_N.B … RIFLGFCY30_N.B), in the Board's `seriescolumn` layout.
  'fed-h15.csv': {
    providerId: 'fed.h15',
    method: 'GET',
    url: 'https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series=bf17364827e38702b42a58cf8eaa3f78&lastobs=&from=&to=&filetype=csv&label=include&layout=seriescolumn',
  },
  'nyfed-all': {
    providerId: 'nyfed.rates',
    method: 'GET',
    url: `${NYFED}/all/latest.json`,
  },
  'nyfed-sofr': {
    providerId: 'nyfed.rates',
    method: 'GET',
    url: `${NYFED}/secured/sofr/last/5.json`,
  },
  'nyfed-effr.json': {
    providerId: 'nyfed.rates',
    method: 'GET',
    url: `${NYFED}/unsecured/effr/last/10.json`,
  },
  // One POST per day carries every headline series id; the recorded capture is the CPI series over
  // the ten-year window the keyless v2 tier allows (PROVIDERS §10.5).
  'bls-cpi.json': {
    providerId: 'bls.timeseries',
    method: 'POST',
    url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/',
    body: '{"seriesid":["CUUR0000SA0"],"startyear":"2024","endyear":"2026"}',
  },
  'bls-schedule.html': {
    providerId: 'bls.schedule',
    method: 'GET',
    url: 'https://www.bls.gov/schedule/news_release/september26.htm',
  },
  worldbank: {
    providerId: 'worldbank',
    method: 'GET',
    url: 'https://api.worldbank.org/v2/country/US/indicator/NY.GDP.MKTP.CD?format=json&page=1&per_page=3',
  },
  // The catalogue endpoint, not the observations one — the observations capture is one of the four
  // missing fixtures (WORKPLAN §18.14, a WP-05 task).
  'imf-weo.json': {
    providerId: 'imf.datamapper',
    method: 'GET',
    url: 'https://www.imf.org/external/datamapper/api/v1/indicators',
  },
  'finra-trace': {
    providerId: 'finra.shortInterest',
    method: 'GET',
    url: 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest?limit=1000&offset=0',
  },

  /* ---------------------------------------------------------------------- News (PROVIDERS §11) */
  // Post-redirect form (§11.1): feeds.bloomberg.com/<feed>/news.rss → www.bloomberg.com/feeds/…
  // The sixth feed, `wealth`, has no recorded capture.
  'bbg-rss-markets': { providerId: 'bbg.rss', method: 'GET', url: `${BBG_FEED}/markets/news.rss` },
  'bbg-rss-econ': { providerId: 'bbg.rss', method: 'GET', url: `${BBG_FEED}/economics/news.rss` },
  'bbg-rss-politics': {
    providerId: 'bbg.rss',
    method: 'GET',
    url: `${BBG_FEED}/politics/news.rss`,
  },
  'bbg-rss-tech': { providerId: 'bbg.rss', method: 'GET', url: `${BBG_FEED}/technology/news.rss` },
  'bbg-rss-industries': {
    providerId: 'bbg.rss',
    method: 'GET',
    url: `${BBG_FEED}/industries/news.rss`,
  },
  'fed-press-rss.xml': {
    providerId: 'fed.rss',
    method: 'GET',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
  },
};

/** Every mapped file name, sorted — the importer's expectation of what `raw/` holds. */
export const FIXTURE_FILES: readonly string[] = Object.keys(FIXTURE_URLS).sort((a, b) =>
  a < b ? -1 : a > b ? 1 : 0,
);
