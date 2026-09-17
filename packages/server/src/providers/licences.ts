// packages/server/src/providers/licences.ts
//
// The licence registry (DATA-09) as typed data: the 33 `licence_registry` rows of PROVIDERS §15
// (L2859-2917) plus the `field_licence` matrix that maps every (field, asset class) pair to the
// source that supplies it (evaluator rule 1, ARCHITECTURE §10).
//
// Nothing in this system may store a value whose `source_id` is absent from here: every write to
// `provenance`, `field_licence` and every value-bearing table is gated by the `assert_source_known`
// trigger (DATA_MODEL §2), which reads `licence_registry`. That is why the registry is scaffold data
// (WP-01) rather than provider data (WP-05) — a source has to exist before an adapter can write.
//
// `seed/licences.ts` is the only writer. Terms change over time, so `licence_registry` is bitemporal;
// these rows are the bootstrap version (`provenance_id NULL`, the only rows allowed to have it).

import type { AssetClass, FieldClass, FieldDef, Tier } from '@terminal/core';
// Subpath without a `.js` suffix: @terminal/core maps `"./*"` to `"./dist/*.js"`, so the extension
// is supplied by the exports pattern (the .js rule applies to relative ESM imports, not to these).
// The dictionary is deliberately not re-exported from the core barrel, so this is the only way in.
import { fieldDefs } from '@terminal/core/fields/dictionary';

/** `licence_registry.licence_kind` — mirrors the CHECK constraint in migration 0002. */
export type LicenceKind =
  | 'public_domain'
  | 'open_data'
  | 'exchange_delayed'
  | 'unofficial'
  | 'cc_by_sa'
  | 'vendor_terms'
  | 'internal';

/**
 * One current `licence_registry` version. Optional columns are `| null` rather than optional
 * properties: the row is written to SQL column by column, so "absent" and "NULL" are the same thing
 * and `exactOptionalPropertyTypes` would otherwise make every call site handle both.
 */
export interface LicenceRow {
  /** `'cboe.quotes'` — the logical key of the registry, cited by every provenance row. */
  readonly sourceId: string;
  readonly sourceName: string;
  readonly publisher: string;
  readonly termsUrl: string | null;
  /** DATA-01: signed agreement reference; NULL for every v1 public source. */
  readonly contractRef: string | null;
  readonly licenceKind: LicenceKind;
  readonly display: boolean;
  /** DATA-01 distinction: programmatic / non-display use. */
  readonly nonDisplay: boolean;
  readonly derived: boolean;
  readonly redistribution: boolean;
  readonly exportAllowed: boolean;
  readonly apiAllowed: boolean;
  /** Ceiling any entitlement grant can reach for this source (evaluator rule 3). */
  readonly maxTier: Tier;
  readonly intrinsicDelayMin: number;
  /** NULL = unlimited. The ONLY input to partition drops and `retentionPurge` (STOR-07). */
  readonly retentionDays: number | null;
  /** Screen footers and the `#` header line of every CSV export. */
  readonly attribution: string;
  /** Documentation only; the token buckets live in `providers/http.ts`. */
  readonly rateLimit: string;
  readonly requiresUserAgent: boolean;
  readonly apiKeyEnv: string | null;
  readonly auditObligation: string | null;
  readonly notes: string | null;
}

const SEC_TERMS = 'https://www.sec.gov/os/webmaster-faq#developers';
const SEC_AUDIT =
  'SEC fair-access policy: descriptive User-Agent with a contact email on every request.';
const FED_TERMS = 'https://www.federalreserve.gov/data.htm';
const FED_PUBLISHER = 'Board of Governors of the Federal Reserve System';
const CBOE_TERMS = 'https://www.cboe.com/us/equities/market_statistics/';
const CBOE_AUDIT = 'Monthly display-user count per ENTL-06 declaration query';
const TREASURY_TERMS =
  'https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics';

/**
 * The whole registry, in the order of PROVIDERS §15.
 *
 * `retention_days` carries a number on exactly three rows — `cboe.quotes` 30 (governs `quote_ticks`),
 * `cboe.options` 10 (`option_quotes`), `yahoo.chart` 400 (`bars_intraday`) — one per partitioned
 * market-data table. Every other row is NULL = unlimited: a number anywhere else would be inert,
 * because nothing else is dropped by partition maintenance (PROVIDERS §15, DATA_MODEL §7.1 rule 5).
 */
export const licenceRows: readonly LicenceRow[] = [
  {
    sourceId: 'cboe.quotes',
    sourceName: 'Cboe Delayed Quotes',
    publisher: 'Cboe Global Markets',
    termsUrl: CBOE_TERMS,
    contractRef: null,
    licenceKind: 'exchange_delayed',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'delayed',
    intrinsicDelayMin: 15,
    retentionDays: 30,
    attribution: 'Quotes delayed at least 15 minutes. Source: Cboe Global Markets.',
    rateLimit: '4/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: CBOE_AUDIT,
    notes: null,
  },
  {
    sourceId: 'cboe.options',
    sourceName: 'Cboe Delayed Option Chains',
    publisher: 'Cboe Global Markets',
    termsUrl: CBOE_TERMS,
    contractRef: null,
    licenceKind: 'exchange_delayed',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'delayed',
    intrinsicDelayMin: 15,
    retentionDays: 10,
    attribution:
      'Option quotes and greeks delayed at least 15 minutes. Source: Cboe Global Markets.',
    rateLimit: '4/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: CBOE_AUDIT,
    notes:
      'derived=true because the greeks are Cboe model output; OVML/OMON re-derive their own from vol_surfaces rather than restating Cboe’s as ours.',
  },
  {
    sourceId: 'cboe.symbolBook',
    sourceName: 'Cboe Symbol Book',
    publisher: 'Cboe Global Markets',
    termsUrl: CBOE_TERMS,
    contractRef: null,
    licenceKind: 'exchange_delayed',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Symbol universe: Cboe Global Markets symbol book.',
    rateLimit: '4/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: 'Reference data is not aged out, so retention_days stays NULL.',
  },
  {
    sourceId: 'cboe.euIndices',
    sourceName: 'Cboe Europe Index Quotes',
    publisher: 'Cboe Europe',
    termsUrl: CBOE_TERMS,
    contractRef: null,
    licenceKind: 'exchange_delayed',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'delayed',
    intrinsicDelayMin: 15,
    retentionDays: null,
    attribution: 'European index values delayed at least 15 minutes. Source: Cboe Europe.',
    rateLimit: '4/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: CBOE_AUDIT,
    notes:
      'Observations land in tables governed by cboe.quotes, so retention_days is NULL here (PROVIDERS §15).',
  },
  {
    sourceId: 'yahoo.chart',
    sourceName: 'Yahoo Finance chart v8',
    publisher: 'Yahoo',
    termsUrl: null,
    contractRef: null,
    licenceKind: 'unofficial',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: false,
    maxTier: 'delayed',
    intrinsicDelayMin: 15,
    retentionDays: 400,
    attribution: 'Historical and intraday bars: Yahoo Finance (unofficial endpoint, delayed).',
    rateLimit: '2/s (self-imposed)',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'Undocumented endpoint; no contract. Requires a browser-like User-Agent. v7/quote and quoteSummary need a crumb and are not used. The one source whose data does not leave through the public API (api_allowed=false → SOURCE_TIER_CAP).',
  },
  {
    sourceId: 'yahoo.search',
    sourceName: 'Yahoo Finance search v1',
    publisher: 'Yahoo',
    termsUrl: null,
    contractRef: null,
    licenceKind: 'unofficial',
    display: true,
    nonDisplay: false,
    derived: false,
    redistribution: false,
    exportAllowed: false,
    apiAllowed: false,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Symbol lookup: Yahoo Finance.',
    rateLimit: '2/s (shared with yahoo.chart)',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: null,
    notes: null,
  },
  {
    sourceId: 'openfigi.mapping',
    sourceName: 'OpenFIGI mapping and search',
    publisher: 'Bloomberg Finance L.P. (OpenFIGI)',
    termsUrl: 'https://www.openfigi.com/about/terms',
    contractRef: null,
    licenceKind: 'open_data',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Identifiers: OpenFIGI, Bloomberg Finance L.P.',
    rateLimit: '25/min, 10 jobs/request (keyless)',
    requiresUserAgent: false,
    apiKeyEnv: 'OPENFIGI_API_KEY',
    auditObligation: null,
    notes:
      'One row for both /v3/mapping and /v3/search (PROVIDERS §6.2). FIGI is an open symbology standard; identifiers are redistributable with attribution. Job arrays are chunked at 10 and sorted so the request body — and therefore the replay key — is deterministic.',
  },
  {
    sourceId: 'sec.tickers',
    sourceName: 'SEC company tickers',
    publisher: 'U.S. Securities and Exchange Commission',
    termsUrl: SEC_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Company identifiers: SEC EDGAR.',
    rateLimit: '10/s',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: SEC_AUDIT,
    notes: null,
  },
  {
    sourceId: 'sec.submissions',
    sourceName: 'SEC submissions index',
    publisher: 'U.S. Securities and Exchange Commission',
    termsUrl: SEC_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Filings: SEC EDGAR.',
    rateLimit: '10/s',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: SEC_AUDIT,
    notes: null,
  },
  {
    sourceId: 'sec.companyfacts',
    sourceName: 'SEC XBRL company facts',
    publisher: 'U.S. Securities and Exchange Commission',
    termsUrl: SEC_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Fundamentals: SEC XBRL company facts.',
    rateLimit: '10/s',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: SEC_AUDIT,
    notes:
      'fin_statements is our standardisation of this data and is stamped internal.derived, carrying these provenance ids in provenance_ids[].',
  },
  {
    sourceId: 'sec.frames',
    sourceName: 'SEC XBRL frames',
    publisher: 'U.S. Securities and Exchange Commission',
    termsUrl: SEC_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Cross-sectional fundamentals: SEC XBRL frames.',
    rateLimit: '10/s',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: SEC_AUDIT,
    notes: null,
  },
  {
    sourceId: 'sec.atom',
    sourceName: 'SEC current filings (8-K atom)',
    publisher: 'U.S. Securities and Exchange Commission',
    termsUrl: SEC_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Filing alerts: SEC EDGAR.',
    rateLimit: '10/s',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: SEC_AUDIT,
    notes: null,
  },
  {
    sourceId: 'sec.archives',
    sourceName: 'SEC EDGAR Archives (N-PORT)',
    publisher: 'U.S. Securities and Exchange Commission',
    termsUrl: SEC_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution:
      'Index membership and weights: SEC Form N-PORT filings of the SPDR S&P 500 ETF Trust.',
    rateLimit: '10/s',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: SEC_AUDIT,
    notes:
      'Official regulatory filing; quarterly portfolio date, filed up to 60 days later. Daily membership comes from ssga.holdings.',
  },
  {
    sourceId: 'ssga.holdings',
    sourceName: 'SPDR S&P 500 ETF daily holdings',
    publisher: 'State Street Global Advisors',
    termsUrl: 'https://www.ssga.com/us/en/intermediary/general-terms-and-conditions',
    contractRef: null,
    licenceKind: 'vendor_terms',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: false,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Daily holdings: State Street Global Advisors (SPDR S&P 500 ETF Trust).',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'Issuer publication, not a regulatory filing. Index membership is the ETF’s portfolio, not S&P’s index — the distinction is stated on MEMB. S&P 500 is a trademark of S&P Dow Jones Indices; no index licence is held (DATA-01 gap).',
  },
  {
    sourceId: 'treasury.yieldcurve',
    sourceName: 'US Treasury daily par yield curve',
    publisher: 'U.S. Department of the Treasury',
    termsUrl: TREASURY_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Treasury par yields: U.S. Department of the Treasury.',
    rateLimit: '1/min (self-imposed; ~18 s responses)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: 'Scheduler-only: the read-through never fetches this source (PROVIDERS §2.6).',
  },
  {
    sourceId: 'treasury.bills',
    sourceName: 'US Treasury daily bill rates',
    publisher: 'U.S. Department of the Treasury',
    termsUrl: TREASURY_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Treasury bill rates: U.S. Department of the Treasury.',
    rateLimit: '1/min (self-imposed; ~18 s responses)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: 'Also the source of on-the-run bill CUSIPs and govt_terms rows.',
  },
  {
    sourceId: 'fred.csv',
    sourceName: 'FRED series (CSV)',
    publisher: 'Federal Reserve Bank of St. Louis',
    termsUrl: 'https://fred.stlouisfed.org/legal/',
    contractRef: null,
    licenceKind: 'open_data',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Macro series: FRED, Federal Reserve Bank of St. Louis.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: 'FRED_API_KEY',
    auditObligation: null,
    notes:
      'FRED aggregates series whose copyright belongs to the originating agency; bulk redistribution is not permitted, hence redistribution=false. FRED_API_KEY is unused in v1 — the CSV path is keyless.',
  },
  {
    sourceId: 'fred.calendar',
    sourceName: 'FRED release calendar',
    publisher: 'Federal Reserve Bank of St. Louis',
    termsUrl: 'https://fred.stlouisfed.org/legal/',
    contractRef: null,
    licenceKind: 'open_data',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Release calendar: FRED, Federal Reserve Bank of St. Louis.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'HTML with no contract: the parse fails closed and leaves the previous calendar in place.',
  },
  {
    sourceId: 'fed.h15',
    sourceName: 'Federal Reserve H.15 selected interest rates',
    publisher: FED_PUBLISHER,
    termsUrl: FED_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Constant-maturity Treasury yields: Federal Reserve H.15.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: null,
  },
  {
    sourceId: 'fed.rss',
    sourceName: 'Federal Reserve press releases',
    publisher: FED_PUBLISHER,
    termsUrl: FED_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Fed communications: Federal Reserve Board.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: null,
  },
  {
    sourceId: 'fed.fomc',
    sourceName: 'FOMC meeting calendar',
    publisher: FED_PUBLISHER,
    termsUrl: FED_TERMS,
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'FOMC calendar: Federal Reserve Board.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'Same terms as fed.rss; a separate source_id so the calendar page has its own provenance.',
  },
  {
    sourceId: 'nyfed.rates',
    sourceName: 'NY Fed reference rates',
    publisher: 'Federal Reserve Bank of New York',
    termsUrl: 'https://www.newyorkfed.org/markets/reference-rates/terms-of-use-for-market-data',
    contractRef: null,
    licenceKind: 'open_data',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'realtime',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Reference rates: Federal Reserve Bank of New York.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation:
      'NY Fed Terms of Use: attribution required; using SOFR as a benchmark in a financial product requires a separate licence, which we do not hold — the terminal displays and analyses the rate only.',
    notes:
      'The only source whose max_tier is realtime: a published fixing is not a delayed quote (PROVIDERS §15).',
  },
  {
    sourceId: 'bls.timeseries',
    sourceName: 'BLS public data API v2',
    publisher: 'U.S. Bureau of Labor Statistics',
    termsUrl: 'https://www.bls.gov/developers/',
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Labour statistics: U.S. Bureau of Labor Statistics.',
    rateLimit: '25 queries/day (keyless)',
    requiresUserAgent: false,
    apiKeyEnv: 'BLS_API_KEY',
    auditObligation: null,
    notes:
      'Daily quota persisted in schema_meta; never on the interactive path. BLS_API_KEY is unused in v1.',
  },
  {
    sourceId: 'bls.schedule',
    sourceName: 'BLS release schedule',
    publisher: 'U.S. Bureau of Labor Statistics',
    termsUrl: 'https://www.bls.gov/developers/',
    contractRef: null,
    licenceKind: 'public_domain',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Release schedule: U.S. Bureau of Labor Statistics.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: 'HTML schedule; fails closed like fred.calendar.',
  },
  {
    sourceId: 'worldbank',
    sourceName: 'World Bank open data',
    publisher: 'World Bank',
    termsUrl: 'https://datacatalog.worldbank.org/public-licenses',
    contractRef: null,
    licenceKind: 'open_data',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Global indicators: World Bank Open Data (CC BY 4.0).',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: null,
  },
  {
    sourceId: 'imf.datamapper',
    sourceName: 'IMF DataMapper',
    publisher: 'International Monetary Fund',
    termsUrl: 'https://www.imf.org/external/terms.htm',
    contractRef: null,
    licenceKind: 'vendor_terms',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: false,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Forecasts and annual macro: IMF World Economic Outlook.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'WEO values beyond the current year are forecasts and are stored with status=preliminary.',
  },
  {
    sourceId: 'frankfurter',
    sourceName: 'frankfurter.dev (ECB reference rates)',
    publisher: 'European Central Bank (via frankfurter.dev)',
    termsUrl: 'https://frankfurter.dev/',
    contractRef: null,
    licenceKind: 'open_data',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Exchange rates: European Central Bank reference rates via frankfurter.dev.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'ecb.europa.eu is not reachable from this network; frankfurter.dev mirrors the ECB daily fixing.',
  },
  {
    sourceId: 'finra.shortInterest',
    sourceName: 'FINRA consolidated short interest',
    publisher: 'FINRA',
    termsUrl: 'https://www.finra.org/finra-data/browse-catalog/short-interest',
    contractRef: null,
    licenceKind: 'vendor_terms',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: false,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Short interest: FINRA.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: false,
    apiKeyEnv: 'FINRA_API_KEY',
    auditObligation: null,
    notes:
      'Semi-monthly settlement dates published ~8 business days in arrears; the age is always displayed with the value. FINRA_API_KEY is unused — the keyless tier is sufficient.',
  },
  {
    sourceId: 'bbg.rss',
    sourceName: 'Bloomberg RSS news feeds',
    publisher: 'Bloomberg L.P.',
    termsUrl: 'https://www.bloomberg.com/notices/tos/',
    contractRef: null,
    licenceKind: 'vendor_terms',
    display: true,
    nonDisplay: false,
    derived: false,
    redistribution: false,
    exportAllowed: false,
    apiAllowed: false,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Headlines: Bloomberg. Copyright 2026 BLOOMBERG L.P. All rights reserved.',
    rateLimit: '1/s (self-imposed)',
    requiresUserAgent: true,
    apiKeyEnv: null,
    auditObligation:
      'Headline, summary and link only; no body text is stored or served. Display-only: export and API are denied by the evaluator with SOURCE_TIER_CAP.',
    notes: null,
  },
  {
    sourceId: 'coingecko.simple',
    sourceName: 'CoinGecko simple price',
    publisher: 'CoinGecko',
    termsUrl: 'https://www.coingecko.com/en/terms',
    contractRef: null,
    licenceKind: 'unofficial',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: false,
    exportAllowed: true,
    apiAllowed: false,
    maxTier: 'delayed',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Crypto prices: CoinGecko.',
    rateLimit: '1/s (keyless demo tier)',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'Context only (BRIEF §1 non-goal). No source timestamp in the payload; usd_24h_change is a rolling 24h move, not a session change. retention_days is NULL: its observations land in tables governed by cboe.quotes.',
  },
  {
    sourceId: 'wiki.sp500',
    sourceName: 'Wikipedia S&P 500 component list',
    publisher: 'Wikipedia contributors',
    termsUrl: 'https://en.wikipedia.org/wiki/Wikipedia:Copyrights',
    contractRef: null,
    licenceKind: 'cc_by_sa',
    display: true,
    nonDisplay: false,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'eod',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Constituent list and GICS sectors: Wikipedia contributors (CC BY-SA 4.0).',
    rateLimit: 'on demand',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes: 'Seeds the GICS classification_codes table; no HTTP adapter runs on a schedule.',
  },
  {
    sourceId: 'internal.derived',
    sourceName: 'Terminal-derived values',
    publisher: 'This platform',
    termsUrl: null,
    contractRef: null,
    licenceKind: 'internal',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'realtime',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Derived by this terminal from the sources cited on the screen.',
    rateLimit: '—',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'No HTTP adapter and no ProviderId. Curves, statistics, standardised statements and the simulated feed carry provenance under this source so that assert_source_known is satisfied.',
  },
  {
    sourceId: 'internal.user',
    sourceName: 'Terminal user input',
    publisher: 'This platform',
    termsUrl: null,
    contractRef: null,
    licenceKind: 'internal',
    display: true,
    nonDisplay: true,
    derived: true,
    redistribution: true,
    exportAllowed: true,
    apiAllowed: true,
    maxTier: 'realtime',
    intrinsicDelayMin: 0,
    retentionDays: null,
    attribution: 'Entered in this terminal.',
    rateLimit: '—',
    requiresUserAgent: false,
    apiKeyEnv: null,
    auditObligation: null,
    notes:
      'No HTTP adapter and no ProviderId. Uploads, data-ops edits and seed data carry provenance under this source.',
  },
];

/** Every registered `source_id`, in registry order. */
export const licenceSourceIds: readonly string[] = licenceRows.map((row) => row.sourceId);

const bySourceId: ReadonlyMap<string, LicenceRow> = new Map(
  licenceRows.map((row) => [row.sourceId, row]),
);

export function getLicence(sourceId: string): LicenceRow | undefined {
  return bySourceId.get(sourceId);
}

/** True for a `source_id` the `assert_source_known` trigger will accept once the seed has run. */
export function isKnownSourceId(sourceId: string): boolean {
  return bySourceId.has(sourceId);
}

/** The three rows STOR-07 acts on, as `{ [sourceId]: days }`; every other source is unlimited. */
export const retentionDaysBySource: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    licenceRows
      .filter((row): row is LicenceRow & { retentionDays: number } => row.retentionDays !== null)
      .map((row) => [row.sourceId, row.retentionDays]),
  ),
);

/** One `field_licence` row: (field, asset class) → the source that supplies it, plus its class. */
export interface FieldLicenceRow {
  readonly fieldId: string;
  readonly assetClass: AssetClass;
  readonly sourceId: string;
  readonly fieldClass: FieldClass;
}

/**
 * The `field_licence` matrix, derived from the field dictionary rather than transcribed beside it.
 *
 * API.md §7 makes the dictionary normative: "`field_licence` must contain a row for every
 * `(id, assetClass)` pair in `sources`", and startup validates every `field_licence.field_id` against
 * the dictionary (ARCHITECTURE §12.1 step 3). Two hand-maintained copies of the same 400-odd rows
 * would diverge on the first field added, and the divergence would be a startup failure.
 *
 * Expansion rules:
 *  - `assetClass: '*'` in a `FieldSource` means "wherever the field is meaningful", so it expands to
 *    the field's own `assetClasses`. The `asset_class` column is a NOT NULL enum with no `'*'` member.
 *  - A field with no `assetClasses` is subject-only (`n:`, `c:`, `e:`, `sys:` — e.g. `NEWS_ID`) and
 *    therefore contributes no rows: it is never entitlement-checked per asset class.
 *  - The PK is `(field_id, asset_class)`, so when several sources supply the same pair the **first**
 *    source listed on the field wins. Dictionary order is primary-source order (`cboe.quotes` before
 *    `yahoo.chart`, `fred.csv` before `bls.timeseries`), which is the precedence the evaluator wants.
 */
export function buildFieldLicenceRows(defs: readonly FieldDef[]): readonly FieldLicenceRow[] {
  const rows = new Map<string, FieldLicenceRow>();
  for (const def of defs) {
    for (const source of def.sources) {
      if (!bySourceId.has(source.sourceId)) {
        throw new Error(
          `field '${def.id}' cites source_id '${source.sourceId}', which is not in the licence ` +
            `registry (packages/server/src/providers/licences.ts) — assert_source_known would reject it`,
        );
      }
      const classes: readonly AssetClass[] =
        source.assetClass === '*' ? def.assetClasses : [source.assetClass];
      for (const assetClass of classes) {
        const key = `${def.id} ${assetClass}`;
        if (rows.has(key)) continue; // first source listed wins
        rows.set(key, {
          fieldId: def.id,
          assetClass,
          sourceId: source.sourceId,
          fieldClass: def.fieldClass,
        });
      }
    }
  }
  return [...rows.values()].sort((a, b) =>
    a.fieldId < b.fieldId
      ? -1
      : a.fieldId > b.fieldId
        ? 1
        : a.assetClass < b.assetClass
          ? -1
          : a.assetClass > b.assetClass
            ? 1
            : 0,
  );
}

/** The matrix for the shipped dictionary — what `seed/licences.ts` writes. */
export const fieldLicenceRows: readonly FieldLicenceRow[] = buildFieldLicenceRows(fieldDefs);
