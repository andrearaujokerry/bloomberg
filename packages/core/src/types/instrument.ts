/**
 * Instrument hierarchy (REF-01, REF-02, REF-03) — ARCHITECTURE §4.1.
 *
 * issuer → issue → instrument → listing → md_line. `instrumentId` is the immutable internal key;
 * a ticker is never an identity (REF-01).
 */

export type AssetClass =
  'equity' | 'etf' | 'index' | 'fx' | 'govt' | 'option' | 'future' | 'crypto' | 'rate' | 'econ';

export type MarketSector =
  | 'Equity'
  | 'Index'
  | 'Curncy'
  | 'Govt'
  | 'Corp'
  | 'Comdty'
  | 'Mtge'
  | 'Muni'
  | 'Pfd'
  | 'M-Mkt'
  | 'Crypto';

export type IdScheme =
  | 'FIGI'
  | 'COMPOSITE_FIGI'
  | 'SHARE_CLASS_FIGI'
  | 'ISIN'
  | 'CUSIP'
  | 'SEDOL'
  | 'RIC'
  | 'TICKER_EXCH'
  | 'LEI'
  | 'MIC'
  | 'CIK'
  | 'OCC'
  | 'PROVIDER_SYMBOL'
  | 'SERIES_CODE';

/**
 * Every reference row is a version. Ranges are half-open [from, to). ISO-8601 UTC strings;
 * 'infinity' allowed. (REF-03)
 */
export interface Bitemporal {
  versionId: number;
  validFrom: string;
  validTo: string;
  txFrom: string;
  txTo: string;
  provenanceId: number;
}

export type IssuerEntityType =
  'operating' | 'fund' | 'sovereign' | 'index_provider' | 'central_bank' | 'other';

/** Legal entity that issues securities: Apple Inc., US Treasury, SPDR Trust, an index provider, a central bank. */
export interface Issuer extends Bitemporal {
  issuerId: number;
  name: string;
  legalName?: string;
  lei?: string;
  cik?: string;
  country?: string;
  sic?: string;
  entityType: IssuerEntityType;
  /** 'MMDD' from SEC submissions.fiscalYearEnd */
  fiscalYearEnd?: string;
}

/** A security / share class / bond / index definition — what the issuer issued. One issuer → many issues. */
export interface Issue extends Bitemporal {
  issueId: number;
  issuerId: number;
  assetClass: AssetClass;
  /** OpenFIGI securityType: 'Common Stock','ETP','REIT','Index','Spot','US GOVERNMENT','Equity Option' */
  securityType: string;
  shareClassFigi?: string;
  isin?: string;
  cusip?: string;
  sedol?: string;
  name: string;
  currency: string;
  countryOfIssue?: string;
}

export type InstrumentStatus = 'active' | 'delisted' | 'pending' | 'matured' | 'expired';

/**
 * The thing a user names on the command line: composite level ('AAPL US'). One issue → many
 * instruments (AAPL US, AAPL GR, …). `instrumentId` is the immutable internal key; never a ticker (REF-01).
 */
export interface Instrument extends Bitemporal {
  instrumentId: number;
  issueId: number;
  assetClass: AssetClass;
  marketSector: MarketSector;
  compositeFigi?: string;
  ticker: string;
  /** OpenFIGI composite code 'US'; 'GOVT','FX','INDEX' for non-listed */
  exchCode: string;
  name: string;
  currency: string;
  primaryListingId?: number;
  status: InstrumentStatus;
  /** autocomplete prior (index members > 1) */
  searchWeight: number;
}

export type ListingStatus = 'active' | 'suspended' | 'delisted';

/** One instrument → many listings (venues). OpenFIGI venue FIGIs UN/UW/UA/UP… */
export interface Listing extends Bitemporal {
  listingId: number;
  instrumentId: number;
  figi?: string;
  mic?: string;
  exchCode: string;
  localTicker: string;
  isPrimary: boolean;
  listingStatus: ListingStatus;
}

export type MdLineKind = 'composite' | 'venue' | 'derived' | 'reference';

/** One listing (or the composite) → many market-data lines: a (source, providerSymbol) pair that feeds quotes. */
export interface MdLine extends Bitemporal {
  mdLineId: number;
  instrumentId: number;
  /** undefined = composite line */
  listingId?: number;
  /** licence_registry.source_id: 'cboe.quotes','yahoo.chart','nyfed.rates',… */
  sourceId: string;
  /** cboe 'AAPL' | '_SPX'; yahoo 'AAPL' | '^GSPC' | 'EURUSD=X'; coingecko 'bitcoin' */
  providerSymbol: string;
  lineKind: MdLineKind;
  /** cboe 15, yahoo 15, nyfed 0 */
  intrinsicDelayMin: number;
  /** poll cadence during session; drives staleness */
  expectedIntervalMs: number;
  /** lower wins ties in composite merge */
  priority: number;
}

export type SecurityRefKind = 'ticker' | 'isin' | 'cusip' | 'figi' | 'occ' | 'series';

/** What the command parser produces before resolution. */
export interface SecurityRef {
  kind: SecurityRefKind;
  value: string;
  exchCode?: string;
  sector?: MarketSector;
}

export interface ResolvedRef {
  instrumentId: number;
  assetClass: AssetClass;
  marketSector: MarketSector;
  /** 'AAPL US Equity' */
  display: string;
  name: string;
  currency: string;
  primaryListingId?: number;
  mdLineIds: number[];
}
